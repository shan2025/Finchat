// services/UserKeys.js — the BYOK harness: whose key pays, and who may spend ours.
//
// This is the piece that turns FinChat into a harness other people can bring
// their own AI to. The tools, knowledge, agents and missions are ours; a user
// connects a provider API key in Settings and every one of those runs on THEIR
// key instead of our shared pool.
//
// It answers one question for the inference path — "for this user, which
// provider keys are theirs, and are they still allowed to touch the shared
// pool?" — and it answers it from a short-lived in-memory cache so the reasoning
// loop, which calls runInference several times per turn, does not pay a database
// read on every call. The same lazy-`require('../database')` rule as
// QuotaManager.js applies: importing this file must not open a Postgres pool.
//
// Access tiers are DERIVED, never stored (see migration 041):
//   • byok     — has ≥1 active key → runs on their own key; no shared fallback.
//   • referred — joined via a referral code → shared pool up to a daily cap.
//   • free     — default → a small lifetime trial on the shared pool, then BYOK.

const { seal, open } = require('./secretBox');

// Providers a user may bring a key for. `test` is the minimal ping used to
// validate a pasted key; the endpoints live in inference.js, this only names
// them and carries display metadata for the Settings UI.
const PROVIDER_META = {
  groq:       { label: 'Groq',       hint: 'gsk_…',  docs: 'https://console.groq.com/keys' },
  gemini:     { label: 'Google Gemini', hint: 'AIza… or AQ.…', docs: 'https://aistudio.google.com/apikey' },
  deepseek:   { label: 'DeepSeek',   hint: 'sk-…',   docs: 'https://platform.deepseek.com/api_keys' },
  mistral:    { label: 'Mistral',    hint: '…',      docs: 'https://console.mistral.ai/api-keys' },
  cerebras:   { label: 'Cerebras',   hint: 'csk-…',  docs: 'https://cloud.cerebras.ai' },
  openrouter: { label: 'OpenRouter', hint: 'sk-or-…', docs: 'https://openrouter.ai/keys' }
};
const PROVIDERS = Object.keys(PROVIDER_META);

// A key can be pointed at a kind of work. `everything` is the default and the
// fallback for any task no key was assigned to.
const ROLES = {
  everything: { label: 'Everything / General', agents: [] },
  markets:    { label: 'Markets & trading',    agents: ['aurelius', 'atlas'] },
  jobs:       { label: 'Jobs & hiring',        agents: ['rasha'] },
  research:   { label: 'Research & tech',      agents: ['nova'] }
};
const ROLE_KEYS = Object.keys(ROLES);
// agentId → the role whose key should serve it. Anything unlisted (plato, chat,
// briefings, missions) uses the `everything` key.
const AGENT_ROLE = {};
for (const [role, def] of Object.entries(ROLES)) for (const a of def.agents) AGENT_ROLE[a] = role;
function roleForAgent(agentId) { return AGENT_ROLE[String(agentId || '').toLowerCase()] || 'everything'; }

// Shared-pool caps. Deliberately env-overridable — these are product levers, not
// constants of nature, and the right number depends on how expensive the shared
// keys turn out to be in practice.
const FREE_TRIAL_SHARED_CALLS = Number(process.env.FREE_TRIAL_SHARED_CALLS || 25);   // lifetime
const REFERRED_DAILY_SHARED_CALLS = Number(process.env.REFERRED_DAILY_SHARED_CALLS || 250); // per UTC day

// ── Resolution cache ─────────────────────────────────────────────
// userId → { value, at }. 60s is long enough to cover a whole reasoning loop
// (which is where the read-amplification is) and short enough that connecting a
// key or spending the trial is reflected within a minute. Writes invalidate the
// entry outright so the Settings flow feels immediate.
const _cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function invalidate(userId) { if (userId) _cache.delete(String(userId)); }

/** last-4 for display, tolerant of short/opaque keys. */
function _last4(key) { return String(key || '').replace(/\s+/g, '').slice(-4) || '????'; }

/**
 * Guess which provider(s) a pasted key belongs to, best-first, from its prefix.
 * Most providers stamp a recognisable prefix; where two share one (or there is
 * none, like Mistral) this returns several candidates and the caller validates
 * each with a live ping, keeping whichever actually authenticates. So detection
 * is never a guess the user has to trust — a wrong guess simply fails to
 * validate and the next candidate is tried.
 */
function detectCandidates(rawKey) {
  const k = String(rawKey || '').trim();
  if (k.startsWith('sk-or-')) return ['openrouter'];
  if (k.startsWith('gsk_')) return ['groq'];
  if (k.startsWith('csk-')) return ['cerebras'];
  if (/^AIza/.test(k) || k.startsWith('AQ.')) return ['gemini'];
  // `sk-` is the OpenAI shape; on our bench that means DeepSeek, with OpenRouter
  // as the other sk- issuer worth trying.
  if (k.startsWith('sk-')) return ['deepseek', 'openrouter'];
  // No recognisable prefix (Mistral, or an unusual key) — try everyone, cheap
  // ones first, and let validation decide.
  return ['mistral', 'groq', 'deepseek', 'cerebras', 'openrouter', 'gemini'];
}

// ── The inference-path answer ────────────────────────────────────

/**
 * For a real user: their provider keys (decrypted) and whether the shared pool
 * is still open to them. Cached. `system` and blank ids never reach here.
 *
 * @returns {Promise<{keys: Object<string,string>, allowSystem: boolean,
 *                     tier: 'byok'|'referred'|'free', used: number, cap: number}>}
 */
async function resolveForUser(userId) {
  const id = String(userId);
  const hit = _cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const { query } = require('../database');
  const value = await _resolve(id, query);
  _cache.set(id, { value, at: Date.now() });
  return value;
}

async function _resolve(id, query) {
  // 1. Their own keys, plus which provider they pointed at each role.
  const keys = {};
  const roleProviders = {};             // role → provider (first key wins)
  try {
    const r = await query(
      `SELECT provider, key_enc, role FROM user_provider_keys WHERE user_id = $1 AND is_active = true`, [id]);
    for (const row of r.rows) {
      const k = open(row.key_enc);        // null if unreadable (rotated master key etc.)
      if (!k) continue;
      keys[row.provider] = k;
      const role = ROLE_KEYS.includes(row.role) ? row.role : 'everything';
      if (!roleProviders[role]) roleProviders[role] = row.provider;
    }
  } catch (err) {
    console.warn(`UserKeys: could not read keys for ${id}: ${err.message}`);
  }

  // A user on their own key uses their own key, full stop. No silent fallback to
  // the shared pool — that would spend our quota the moment their key hiccuped,
  // which is exactly the cost BYOK exists to remove.
  if (Object.keys(keys).length > 0) {
    return { keys, roleProviders, allowSystem: false, tier: 'byok', used: 0, cap: 0 };
  }

  // 2. No key of their own → shared pool, gated by tier.
  let referred = false;
  try {
    const u = await query(`SELECT referred_by FROM users WHERE user_id = $1`, [id]);
    referred = !!(u.rows[0] && u.rows[0].referred_by);
  } catch (err) {
    console.warn(`UserKeys: could not read tier for ${id}: ${err.message}`);
  }

  // Count only matters for a user with no key of their own, so every row here is
  // a shared-pool call by construction — no need to tag credential source.
  const cap = referred ? REFERRED_DAILY_SHARED_CALLS : FREE_TRIAL_SHARED_CALLS;
  let used = 0;
  try {
    const sql = referred
      ? `SELECT count(*)::int AS n FROM inference_metrics
           WHERE user_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`
      : `SELECT count(*)::int AS n FROM inference_metrics WHERE user_id = $1`;
    const c = await query(sql, [id]);
    used = (c.rows[0] && c.rows[0].n) || 0;
  } catch (err) {
    // If we cannot count, fail OPEN for referred users (they were vouched for)
    // and CLOSED-ish is unnecessary — default to allowing, the cap is a soft
    // guard against runaway cost, not a security control.
    console.warn(`UserKeys: could not count usage for ${id}: ${err.message}`);
  }

  return { keys: {}, roleProviders: {}, allowSystem: used < cap, tier: referred ? 'referred' : 'free', used, cap };
}

// ── Settings CRUD (called from routes/settings.js) ───────────────

/** Masked list for the Settings page — never returns a key, only its shape. */
async function listKeys(userId) {
  const { query } = require('../database');
  const r = await query(
    `SELECT provider, label, key_last4, is_active, role, last_ok_at, last_error, updated_at
       FROM user_provider_keys WHERE user_id = $1 ORDER BY provider`, [userId]);
  return r.rows.map(row => ({
    provider: row.provider,
    providerLabel: (PROVIDER_META[row.provider] || {}).label || row.provider,
    label: row.label,
    last4: row.key_last4,
    isActive: row.is_active,
    role: ROLE_KEYS.includes(row.role) ? row.role : 'everything',
    lastOkAt: row.last_ok_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  }));
}

/** Seal and store (or replace) one provider key. Invalidates the cache. */
async function saveKey(userId, provider, rawKey, { label = null, lastOkAt = null, lastError = null } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const key = String(rawKey || '').trim();
  if (!key) throw new Error('Empty key');
  const { query } = require('../database');
  await query(`
    INSERT INTO user_provider_keys (user_id, provider, key_enc, key_last4, label, is_active, last_ok_at, last_error, updated_at)
    VALUES ($1, $2, $3, $4, $5, true, $6, $7, now())
    ON CONFLICT (user_id, provider) DO UPDATE
      SET key_enc = EXCLUDED.key_enc, key_last4 = EXCLUDED.key_last4, label = EXCLUDED.label,
          is_active = true, last_ok_at = EXCLUDED.last_ok_at, last_error = EXCLUDED.last_error, updated_at = now()
  `, [userId, provider, seal(key), _last4(key), label, lastOkAt, lastError]);
  invalidate(userId);
}

/** Record the outcome of a live validation without touching the key itself. */
async function markKeyStatus(userId, provider, { ok, error = null } = {}) {
  const { query } = require('../database');
  await query(`
    UPDATE user_provider_keys
       SET last_ok_at = CASE WHEN $3 THEN now() ELSE last_ok_at END,
           last_error = $4, updated_at = now()
     WHERE user_id = $1 AND provider = $2
  `, [userId, provider, !!ok, ok ? null : (error || 'validation failed')]);
  invalidate(userId);
}

/** Point a stored key at a kind of work. Invalidates the cache. */
async function setRole(userId, provider, role) {
  if (!ROLE_KEYS.includes(role)) throw new Error(`Unknown role: ${role}`);
  const { query } = require('../database');
  const r = await query(
    `UPDATE user_provider_keys SET role = $3, updated_at = now() WHERE user_id = $1 AND provider = $2`,
    [userId, provider, role]);
  invalidate(userId);
  return r.rowCount > 0;
}

async function deleteKey(userId, provider) {
  const { query } = require('../database');
  await query(`DELETE FROM user_provider_keys WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  invalidate(userId);
}

// ── Referral ─────────────────────────────────────────────────────

/** Ensure the user has a code and return their referral standing. */
async function getReferral(userId) {
  const { query } = require('../database');
  let r = await query(`SELECT referral_code, referred_by FROM users WHERE user_id = $1`, [userId]);
  let row = r.rows[0] || {};
  if (!row.referral_code) {
    // Backfill lazily for users created before migration 041's backfill ran.
    const code = _genCode(userId);
    await query(`UPDATE users SET referral_code = $2 WHERE user_id = $1 AND referral_code IS NULL`, [userId, code]);
    row.referral_code = code;
  }
  const count = await query(`SELECT count(*)::int AS n FROM users WHERE referred_by = $1`, [userId]);
  return {
    code: row.referral_code,
    referredBy: row.referred_by || null,
    referredCount: (count.rows[0] && count.rows[0].n) || 0
  };
}

/**
 * Redeem someone else's code. Sets referred_by, which lifts this user to the
 * `referred` tier. Guards the obvious abuse: no self-referral, and it does not
 * overwrite an existing referrer (the tier is claimed once).
 */
async function applyReferral(userId, code) {
  const { query } = require('../database');
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) throw new Error('No code given');
  const me = await query(`SELECT referred_by, referral_code FROM users WHERE user_id = $1`, [userId]);
  if (me.rows[0] && me.rows[0].referred_by) throw new Error('You have already used a referral code');
  if (me.rows[0] && me.rows[0].referral_code === clean) throw new Error('You cannot use your own code');
  const owner = await query(`SELECT user_id FROM users WHERE referral_code = $1`, [clean]);
  if (!owner.rows[0]) throw new Error('That referral code is not valid');
  await query(`UPDATE users SET referred_by = $2 WHERE user_id = $1`, [userId, owner.rows[0].user_id]);
  invalidate(userId);
  return { referredBy: owner.rows[0].user_id };
}

function _genCode(seed) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(String(seed) + Date.now() + Math.random())
    .digest('hex').slice(0, 8).toUpperCase();
}

module.exports = {
  PROVIDER_META, PROVIDERS, detectCandidates,
  ROLES, ROLE_KEYS, roleForAgent,
  FREE_TRIAL_SHARED_CALLS, REFERRED_DAILY_SHARED_CALLS,
  resolveForUser, invalidate,
  listKeys, saveKey, markKeyStatus, setRole, deleteKey,
  getReferral, applyReferral
};
