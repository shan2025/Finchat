// tools/AgentReachTool.js — bridge to a self-hosted Agent-Reach worker for the
// authed/social platforms our in-process JS tools can't reach (logged-in Reddit,
// Twitter/X, LinkedIn, Instagram, etc.). Agent-Reach is a Python CLI that needs a
// persistent machine holding browser logins/cookies — which Render's ephemeral
// free container cannot do (same class of block as outbound SMTP). So the CLI runs
// on the user's own always-on box behind a tunnel, exposes a tiny HTTP endpoint,
// and THIS tool just calls it. No Python ever touches the Node process.
//
// Config (backend/.env):
//   AGENT_REACH_URL     e.g. https://reach.example.trycloudflare.com  (the tunnel)
//   AGENT_REACH_SECRET  shared secret sent as the x-reach-secret header
//
// Social platforms are OPINION/UGC, so — like RedditTool — every result is
// verified:false with crossCheckAdvice. When the worker is unreachable (PC off,
// tunnel down) we return searchUnavailable:true so an outage never reads to the
// model as "there is no discussion / this doesn't exist".
const axios = require('axios');

const WORKER_URL = () => (process.env.AGENT_REACH_URL || '').replace(/\/+$/, '');
const SECRET = () => process.env.AGENT_REACH_SECRET || '';

// Platforms the worker is expected to expose. Kept in sync with `agent-reach
// doctor` on the worker; unknown values are passed through so a newly-configured
// backend works without a code change here.
const KNOWN_PLATFORMS = ['reddit', 'twitter', 'x', 'linkedin', 'instagram', 'facebook', 'youtube'];

function parseInput(input) {
  if (input && typeof input === 'object') {
    return {
      platform: String(input.platform || '').trim().toLowerCase(),
      query: String(input.query || input.topic || '').trim(),
      limit: +input.limit || 6
    };
  }
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return { platform: String(o.platform || '').trim().toLowerCase(), query: String(o.query || o.topic || '').trim(), limit: +o.limit || 6 };
    } catch (e) { /* fall through */ }
  }
  return { platform: '', query: s, limit: 6 };
}

async function execute(input) {
  const { platform, query, limit } = parseInput(input);

  if (!WORKER_URL() || !SECRET()) {
    // Not configured — treat as an outage, not "no results", so the model doesn't
    // narrate a factual denial. Setup lives in docs/AGENT_REACH_SETUP.md.
    return {
      platform, query, results: [], source: 'agent-reach', searchUnavailable: true,
      error: 'AGENT-REACH NOT CONFIGURED — AGENT_REACH_URL / AGENT_REACH_SECRET are unset, so the social-platform worker cannot be reached. This is a setup gap, NOT evidence. Do not tell the user the topic has no discussion; say the social lookup is not available.'
    };
  }
  if (!platform) return { platform, query, results: [], source: 'agent-reach', error: 'missing "platform" (e.g. reddit, twitter, linkedin)' };
  if (!query) return { platform, query, results: [], source: 'agent-reach', error: 'empty query' };

  try {
    const res = await axios.post(
      `${WORKER_URL()}/reach`,
      { platform, query, limit: Math.min(limit, 20) },
      { headers: { 'Content-Type': 'application/json', 'x-reach-secret': SECRET() }, timeout: 25000 }
    );

    const data = res.data || {};
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      return { platform, query, source: 'agent-reach', via: data.via || platform, note: data.note || `No ${platform} results for "${query}".` };
    }
    return {
      platform,
      query,
      source: 'agent-reach',
      via: data.via || platform,
      verified: false, // social/UGC — opinion, not fact
      crossCheckAdvice: 'These are unverified posts from a social platform. Confirm any factual claim (price, date, event, spec) with the wikipedia, news, or search tool and cite that source — not the social post alone.',
      results
    };
  } catch (err) {
    const status = err.response?.status;
    // Worker reachable but the specific platform backend is broken/needs re-login.
    if (status === 424 || status === 502) {
      return {
        platform, query, results: [], source: 'agent-reach', searchUnavailable: true,
        error: `AGENT-REACH BACKEND DOWN for "${platform}" (worker returned ${status}) — the backend likely needs re-login on the worker (agent-reach configure ${platform}). This is an outage, NOT evidence; do not claim the topic has no discussion.`
      };
    }
    // Worker unreachable entirely (PC off, tunnel down, timeout).
    return {
      platform, query, results: [], source: 'agent-reach', searchUnavailable: true,
      error: `AGENT-REACH WORKER UNREACHABLE (${err.code || status || err.message}) — the self-hosted worker is offline or the tunnel is down. This is an outage, NOT evidence; say the social lookup is currently unavailable and do not deny the topic exists.`
    };
  }
}

module.exports = { execute, KNOWN_PLATFORMS };
