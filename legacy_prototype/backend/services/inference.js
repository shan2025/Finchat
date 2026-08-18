// services/inference.js — Multi-Provider AI Inference Engine
// Fix 1: Token-bucket rate limiter for Groq (28 RPM) + retry-with-backoff on 429.
const axios = require('axios');
require('dotenv').config();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Groq enforces its free-tier token allowance PER MODEL PER DAY, so when the
// primary model is exhausted the answer is a different model, not a longer
// wait. These are tried in order before giving up on Groq entirely. That last
// part matters in production: the Ollama fallback further down points at
// localhost, which does not exist on a cloud host, so Groq running out used to
// mean no inference at all.
//
// llama-3.3-70b-versatile was the primary until Groq announced its
// decommission (notice dated 2026-08-15). gpt-oss-120b replaces it: verified
// against the real agent prompt in JSON mode and the strongest model this key
// still serves. Note it is a reasoning model and bills its reasoning tokens —
// the same turn cost 511 tokens against 70B's 209 — so runs burn roughly twice
// the budget for the same work.
//
// This chain used to end in llama-3.1-8b-instant, for cross-family redundancy
// against a per-model quota. Groq has since decommissioned that too — a live
// catalog read on 2026-08-17 returned only gpt-oss (120b/20b/safeguard),
// qwen3.6-27b, compound, allam and the whisper/prompt-guard utility models, so
// there is no second family left to fall back to. Listing it cost a wasted
// round-trip and a 404 on every fresh process before _deadModels retired it.
// Cross-family redundancy now comes from the PROVIDER chain below (Gemini,
// DeepSeek) rather than from within Groq.
//
// qwen/qwen3.6-27b is available on the key and deliberately NOT listed: it
// emits a <think> preamble, fails Groq's own json_object validation, and never
// parses into an action. Do not add it.
const GROQ_PRIMARY_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ||
  'openai/gpt-oss-20b')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Cross-provider fallback chain ────────────────────────────────
// Groq's allowance is per model per DAY, so once the key's models are spent
// there is no Groq answer until midnight UTC — every model in the chain above
// is exhausted at roughly the same time because they share one key and one
// day. Below Groq there was only Ollama on localhost, which does not exist on
// a cloud host, so "Groq is out" meant a hard failure: the user got
// "AI Inference unavailable across providers" as their morning news.
//
// These providers are separate companies on separate infrastructure with
// separate quotas, so a spent Groq day (or a Groq incident) is survivable.
// Both speak the OpenAI /chat/completions shape, which is why they slot into
// the same call path — Gemini via its OpenAI-compatibility endpoint.
//
// A provider with no key configured is skipped silently, so this file works
// unchanged whether one key is set or all three.
const PROVIDERS = [
  {
    name: 'groq',
    style: 'openai',
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    models: [GROQ_PRIMARY_MODEL, ...GROQ_FALLBACK_MODELS],
    // Only Groq gets the local token bucket — the others have their own
    // server-side limits and no bucket here to respect.
    rateLimited: true,
    // An explicit `model` argument names a GROQ model, so it applies here and
    // nowhere else; passing it to Gemini or DeepSeek would 400 every candidate.
    acceptsModelOverride: true
  },
  {
    name: 'gemini',
    // `style: 'gemini'` because Google's OpenAI-compatibility endpoint is not
    // usable with every Google credential. It demands an `Authorization:
    // Bearer` header and rejects a plain API key there with "Expected OAuth 2
    // access token" — the newer `AQ.`-prefixed keys authenticate only as
    // `x-goog-api-key` against the NATIVE endpoint. Talking native works for
    // both key formats, so it is the one that always works.
    style: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    baseUrl: process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/models',
    // gemini-flash-latest leads on measured availability, not on version
    // number. Probed repeatedly on 2026-08-17 while Groq's daily allowance was
    // spent: gemini-3.5-flash answered 429 "You exceeded your current quota"
    // almost every time, while gemini-flash-latest served a full 15k-token
    // synthesis payload in the same minute. Trying the throttled one first cost
    // 50s of backoff before reaching the one that works.
    //
    // gemini-2.5-flash is deliberately absent: Google now answers 404 for it on
    // new keys ("no longer available to new users").
    models: (process.env.GEMINI_MODELS || 'gemini-flash-latest,gemini-3.5-flash')
      .split(',').map(s => s.trim()).filter(Boolean)
  },
  {
    name: 'deepseek',
    style: 'openai',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1/chat/completions',
    models: (process.env.DEEPSEEK_MODELS || 'deepseek-chat')
      .split(',').map(s => s.trim()).filter(Boolean)
  },
  {
    // Mistral — free tier, ~1B tokens/month at roughly one request per second.
    // It earns its place by being a different model FAMILY on different
    // infrastructure: Groq and Gemini can both be having a bad day at once (106
    // "unavailable across providers" failures in the 14 days to 2026-08-18),
    // and a fourth name from the same two vendors would not have helped.
    // Verified against json_object mode on 2026-08-18 before being added.
    name: 'mistral',
    style: 'openai',
    apiKey: process.env.MISTRAL_API_KEY,
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1/chat/completions',
    models: (process.env.MISTRAL_MODELS || 'mistral-small-latest')
      .split(',').map(s => s.trim()).filter(Boolean)
  }
];

/** A key that is absent, blank, or still the placeholder is not a key. */
function _usableKey(key) {
  return !!key && !key.startsWith('YOUR_') && key !== 'changeme';
}

// ── Per-workload provider routing ────────────────────────────────
// Different workloads competed for one pool and starved each other. Groq's free
// tier is 200,000 tokens per model per DAY; a single research run costs
// 25k–54k, so three briefings plus a digest can consume the entire allowance
// and leave interactive chat answering "AI Inference unavailable" — which is
// exactly what happened on 2026-08-17.
//
// Routing by workload gives each its own pool. Chat leads with Gemini: turns
// are small and latency-tolerant, and Gemini's per-MINUTE limit (~6 requests)
// is a poor fit for a research burst but perfectly adequate for one person
// typing. Scheduled research leads with Groq: it is fast, handles the large
// multi-tool payloads, and its daily budget is better spent on the few runs
// that actually need that capacity than drained by ad-hoc chatter.
//
// These are ORDERS, not exclusives — every route still falls through to the
// others, so a spent Groq day degrades a briefing to Gemini rather than
// failing it. Override any of them from the environment.
//
// DeepSeek now leads every route. It is the only PAID provider on the bench (a
// funded $2 balance as of 2026-08-18), which buys two things the free tiers
// cannot: no daily token cliff, and no shared-quota interference between
// workloads. Groq and Gemini become what they are good at — free capacity to
// fall back on. Chat in particular had been leading with Gemini, which measured
// 16-33s per call against Groq's 6.2s, and that ordering was the single largest
// contributor to "answers take a long time".
//
// The balance is finite where the free tiers are not, so if it starts draining
// faster than expected the lever is INFERENCE_ROUTE_BRIEFING and
// INFERENCE_ROUTE_MISSION in .env: put `groq` first there and the token-hungry
// research runs (25k-54k each) stop spending money while chat keeps the fast path.
//
// The TAILS still diverge, and that is deliberate rather than cosmetic. A shared
// primary is only safe while it is answering; the day the balance runs out, both
// routes fall through at the same moment, and if they fell through to the same
// place they would re-create the exact shared-pool starvation of 2026-08-17
// (three briefings ate 199,393 of Groq's 200,000 daily tokens and chat went
// dark). So chat falls to Groq — fastest, and chat is the impatient workload —
// while scheduled research falls to Gemini, which is slow but holds the large
// multi-source payloads a briefing sends. Each keeps a lane of its own.
const WORKLOAD_ROUTES = {
  chat: (process.env.INFERENCE_ROUTE_CHAT || 'deepseek,groq,gemini,mistral')
    .split(',').map(s => s.trim()).filter(Boolean),
  briefing: (process.env.INFERENCE_ROUTE_BRIEFING || 'deepseek,gemini,groq,mistral')
    .split(',').map(s => s.trim()).filter(Boolean),
  mission: (process.env.INFERENCE_ROUTE_MISSION || 'deepseek,gemini,groq,mistral')
    .split(',').map(s => s.trim()).filter(Boolean),

  // Label-sized jobs that do not need a frontier model. `feature` doubles as the
  // workload when no explicit workload is passed (see runInference), so naming
  // the feature here is enough — no call site has to change.
  //
  // This exists because `community_name` — a task whose entire output is a
  // four-token label — made 177 calls to the 120B REASONING model at 24.4s
  // each, billing ~140 reasoning tokens to produce four. The same job on a
  // small model took 2.9s. Groq's cheap model leads: it is free, fast enough,
  // and keeps these off the paid balance entirely.
  community_name: (process.env.INFERENCE_ROUTE_TRIVIAL || 'groq,mistral,deepseek,gemini')
    .split(',').map(s => s.trim()).filter(Boolean),
  extraction: (process.env.INFERENCE_ROUTE_TRIVIAL || 'groq,mistral,deepseek,gemini')
    .split(',').map(s => s.trim()).filter(Boolean),
  'gap-detection': (process.env.INFERENCE_ROUTE_TRIVIAL || 'groq,mistral,deepseek,gemini')
    .split(',').map(s => s.trim()).filter(Boolean)
};

/** Fallback order for anything not named above (mindmap, report, …). */
const DEFAULT_ROUTE = (process.env.INFERENCE_ROUTE_DEFAULT || 'deepseek,groq,gemini,mistral')
  .split(',').map(s => s.trim()).filter(Boolean);

// Choosing a cheap PROVIDER is only half of the trivial-workload fix: Groq's
// model list leads with the 120B reasoning model, so routing a four-token
// labelling job to Groq still bills reasoning tokens for it. This names the
// model such a job should lead with.
//
// It is applied exactly like an explicit `model` argument — it leads the list
// for providers that accept an override (Groq only) and is withheld from the
// rest, where a Groq model id would 400 every candidate. A caller passing its
// own `model` still wins.
const WORKLOAD_MODEL_HINTS = {
  community_name: process.env.INFERENCE_TRIVIAL_MODEL || 'openai/gpt-oss-20b',
  extraction: process.env.INFERENCE_TRIVIAL_MODEL || 'openai/gpt-oss-20b',
  'gap-detection': process.env.INFERENCE_TRIVIAL_MODEL || 'openai/gpt-oss-20b'
};

// Workloads with a human waiting on the answer. These do NOT wait out a rate
// limit: the 5s/15s/30s ladder that rescues a background research run is a
// minute of dead air in a chat window, and there is another provider one line
// down that can answer immediately. Patience is for work nobody is watching.
const IMPATIENT_WORKLOADS = new Set(
  (process.env.INFERENCE_IMPATIENT_WORKLOADS || 'chat')
    .split(',').map(s => s.trim()).filter(Boolean)
);

/**
 * Providers to try, in order, for a workload. Unknown names in a route are
 * ignored, and any configured provider missing from the route is appended —
 * a typo in an env var should not silently disable a provider that has a key.
 */
function _providersFor(workload) {
  const order = WORKLOAD_ROUTES[workload] || DEFAULT_ROUTE;
  const byName = new Map(PROVIDERS.map(p => [p.name, p]));
  const chosen = order.map(n => byName.get(n)).filter(Boolean);
  for (const p of PROVIDERS) if (!chosen.includes(p)) chosen.push(p);
  return chosen;
}

// ── Token-bucket rate limiter ────────────────────────────────────
// Groq free tier ≈ 30 RPM. We cap at 28 to leave headroom.
const GROQ_RPM = Number(process.env.GROQ_RPM) || 28;
const BUCKET_REFILL_MS = 60_000; // 1 minute window
const MAX_WAIT_MS = 5_000;       // max time to wait for a token before fallback

const _bucket = { tokens: GROQ_RPM, lastRefill: Date.now() };

// Model ids this key has already rejected outright (HTTP 400 — retired or
// misspelled). Process-lifetime only: a restart re-probes, so a model that
// comes back is picked up without a deploy.
const _deadModels = new Set();

/**
 * Does this error mean "that model does not exist" rather than "that request
 * was bad"? Groq signals the former with code `model_not_found` (or prose
 * naming the model as unknown/decommissioned); the latter covers json_object
 * validation failures and oversized payloads, which say nothing about the
 * model's availability and must NOT retire it.
 *
 * Callers must apply this to 404 as well as 400. Observed live 2026-08-17:
 * llama-3.1-8b-instant, which had been answering, began returning
 * 404 "The model `…` does not exist or you do not have access to it" once it
 * was withdrawn from the key — a permanent condition dressed as a status code
 * the retry logic previously treated as ordinary failure, so every run paid a
 * doomed round-trip for it.
 */
function _isModelNotFound(err) {
  const e = err.response?.data?.error || {};
  // Observed live: a withdrawn model answers 400 with code `model_decommissioned`
  // ("The model `…` has been decommissioned…"), while a bad request carries no
  // code at all. The prose test below is the belt-and-braces for other wordings.
  if (e.code === 'model_not_found' || e.code === 'model_decommissioned') return true;
  return /does not exist|not found|decommission|no longer (available|supported)/i.test(e.message || '');
}

function _refillBucket() {
  const now = Date.now();
  const elapsed = now - _bucket.lastRefill;
  if (elapsed >= BUCKET_REFILL_MS) {
    _bucket.tokens = GROQ_RPM;
    _bucket.lastRefill = now;
  } else {
    // Partial refill: add tokens proportional to elapsed time
    const refill = Math.floor((elapsed / BUCKET_REFILL_MS) * GROQ_RPM);
    if (refill > 0) {
      _bucket.tokens = Math.min(GROQ_RPM, _bucket.tokens + refill);
      _bucket.lastRefill = now;
    }
  }
}

/** Try to acquire a token. Returns true immediately if available, or waits up to MAX_WAIT_MS. */
async function _acquireToken() {
  _refillBucket();
  if (_bucket.tokens > 0) { _bucket.tokens--; return true; }

  // Wait for the next partial refill (also stall time, not work time)
  const waitMs = Math.min(MAX_WAIT_MS, Math.ceil(BUCKET_REFILL_MS / GROQ_RPM));
  await _sleep(waitMs);
  _refillBucket();
  if (_bucket.tokens > 0) { _bucket.tokens--; return true; }
  return false; // still empty after waiting — fall to Ollama
}

// Sleeping here is time the caller is rate-limited, not time it is working, so
// it is logged against the current execution's stall ledger and later subtracted
// from the runtime budget. See StallClock.js.
const { recordStall } = require('./cognitive/StallClock');
const _sleep = async (ms) => {
  const started = Date.now();
  await new Promise(r => setTimeout(r, ms));
  recordStall(Date.now() - started);
};

/**
 * Record one inference call for the Knowledge Center's "Inference & Context Reuse"
 * panel. Best-effort and non-blocking — metrics must never break or slow inference,
 * so failures (incl. before migration 020 runs) are swallowed. Loaded lazily to
 * avoid a hard dependency on the DB at module load.
 */
function recordInferenceMetric({ provider, model, feature, promptTokens, completionTokens, latencyMs, agentId, userId, cachedTokens }) {
  try {
    const { query } = require('../database');
    query(`
      INSERT INTO inference_metrics
        (provider, model, feature, prompt_tokens, completion_tokens, latency_ms, agent_id, user_id, cached_tokens)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [provider, model || '', feature || 'chat', promptTokens || 0, completionTokens || 0,
      latencyMs || 0, agentId || null, userId || null, cachedTokens || 0]).catch(() => {});
  } catch (err) { /* metrics are best-effort */ }
}

/**
 * How many prompt tokens the provider served from its own prefix cache.
 *
 * DeepSeek reports this three ways depending on which field you read, and it is
 * the whole reason the first system message must stay byte-identical across a
 * run — measured 2026-08-18, a repeated 1,933-token prefix came back with
 * prompt_cache_hit_tokens 1920. Recording it makes that either visibly working
 * or visibly broken, rather than an assumption.
 *
 * Providers that do not cache simply report nothing, which reads as 0.
 */
function _cachedTokensFrom(usage = {}) {
  return usage.prompt_cache_hit_tokens
    || usage.prompt_tokens_details?.cached_tokens
    || usage.cached_tokens
    || 0;
}

/** Rough size of a message list, for logging and trim decisions. */
function _payloadChars(messages) {
  return messages.reduce((n, m) => n + String(m.content || '').length, 0);
}

/**
 * Shrink an oversized message list. Groq answers 413 when the request body
 * exceeds a model's accepted size, which the research path hits easily once web
 * and arXiv results are appended — the primary model tolerates payloads the
 * smaller fallbacks reject, so a spent primary quota turned into a hard failure.
 *
 * Every oversized message is truncated, including the newest one: on the
 * research path the bulk of the payload is exactly there, because the retrieved
 * pages are appended after the question. Truncation keeps the head of each
 * message, which is where the question and the most relevant retrieved text sit,
 * and discards the tail. Exempting the last message (or system messages) would
 * defeat the whole exercise — a single 180k-character message is the common
 * case, and skipping it leaves the payload unchanged.
 */
function _trimMessages(messages, maxCharsPerMessage) {
  const marker = '\n…[truncated to fit the model\'s request limit]';
  return messages.map((m) => {
    const content = String(m.content || '');
    if (content.length <= maxCharsPerMessage) return m;
    return { ...m, content: content.slice(0, maxCharsPerMessage) + marker };
  });
}

/**
 * Make one chat-completions call. Groq, Gemini (via its OpenAI-compatibility
 * endpoint) and DeepSeek all accept this exact request shape, so the retry,
 * trim and fallback logic below is written once and reused for all of them —
 * only the base URL, key and model name differ.
 */
async function _callChatCompletions({ baseUrl, apiKey, model, messages, temperature, jsonMode, style }) {
  if (style === 'gemini') return _callGemini({ baseUrl, apiKey, model, messages, temperature, jsonMode });

  const response = await axios.post(
    baseUrl,
    {
      model,
      messages,
      temperature,
      response_format: jsonMode ? { type: 'json_object' } : undefined
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    }
  );
  return response;
}

/**
 * Call Gemini's native generateContent and reshape the answer to look like an
 * OpenAI response, so everything downstream — the retry loop, the metrics, the
 * return value — stays provider-agnostic.
 *
 * Two shape differences matter. Gemini names the assistant role "model", and it
 * carries system prompts in a separate `systemInstruction` field rather than as
 * a message with role "system"; a system message left in the contents array is
 * rejected. Both are normalised here.
 */
async function _callGemini({ baseUrl, apiKey, model, messages, temperature, jsonMode }) {
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => String(m.content || '')).join('\n\n');

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

  const body = {
    contents,
    generationConfig: {
      temperature,
      // Gemini's equivalent of response_format: { type: 'json_object' }.
      responseMimeType: jsonMode ? 'application/json' : undefined
    }
  };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };

  const response = await axios.post(
    `${baseUrl}/${model}:generateContent`,
    body,
    {
      // Not `Authorization: Bearer` — see the note on the provider config.
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      timeout: 45000
    }
  );

  const usage = response.data.usageMetadata || {};
  const text = (response.data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('');

  // Hand back an OpenAI-shaped object so _runProviderChain needs no special
  // case when reading the result.
  return {
    data: {
      choices: [{ message: { content: text } }],
      usage: {
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      }
    }
  };
}

/**
 * Work through one provider's model list, handling 429 backoff, 413 payload
 * trimming and retired-model blacklisting. Returns a completion, or null when
 * this provider has nothing left to offer and the caller should move on.
 *
 * `rateLimited` applies the Groq token bucket; the other providers have their
 * own server-side limits and no local bucket to respect.
 */
async function _runProviderChain({
  providerName, baseUrl, apiKey, models, messages, temperature, jsonMode,
  feature, agentId, userId, startedAt, rateLimited = false, style = 'openai',
  patient = true
}) {
  const candidates = models
    .filter((m, i, arr) => m && arr.indexOf(m) === i)
    // A model the provider has retired answers 400 forever, not transiently.
    // Nova sat pinned to deepseek-r1-distill-llama-70b long after it was
    // withdrawn and paid a doomed round-trip on EVERY reasoning turn before
    // falling back. Once a model 400s on a decommission, stop offering it.
    .filter(m => !_deadModels.has(`${providerName}:${m}`));

  // Everything retired: fall through to the configured defaults rather than
  // making no call to this provider at all.
  if (candidates.length === 0) candidates.push(...models.filter(Boolean));

  // Trimming persists across models: once a payload proves too large for one
  // fallback the next is unlikely to accept it either, so the smaller version
  // carries forward rather than re-failing at full size on every candidate.
  let payload = messages;
  const TRIM_STEPS = [12000, 4000];
  let trimStep = 0;

  for (let mi = 0; mi < candidates.length; mi++) {
    const gModel = candidates[mi];

    if (rateLimited) {
      const hasToken = await _acquireToken();
      if (!hasToken) {
        // An empty bucket is our own throttle, not this model's quota, so
        // switching models would not help — leave this provider entirely.
        console.warn(`⚠️ ${providerName} rate limit: bucket empty after waiting ${MAX_WAIT_MS}ms, trying next provider [${feature}]`);
        return null;
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await _callChatCompletions({
          baseUrl, apiKey, model: gModel, messages: payload, temperature, jsonMode, style
        });
        const gUsage = response.data.usage || {};
        const cachedTokens = _cachedTokensFrom(gUsage);
        console.log(`⚡ ${providerName} inference successful [Model: ${gModel}]` +
          (mi > 0 ? ` (fallback #${mi} — "${candidates[0]}" was unavailable)` : '') +
          (cachedTokens ? ` (${cachedTokens}/${gUsage.prompt_tokens || 0} prompt tokens from cache)` : ''));
        recordInferenceMetric({
          provider: providerName, model: gModel, feature,
          promptTokens: gUsage.prompt_tokens || 0, completionTokens: gUsage.completion_tokens || 0,
          latencyMs: Date.now() - startedAt, agentId, userId, cachedTokens
        });
        return {
          content: response.data.choices[0]?.message?.content || '',
          provider: providerName,
          model: gModel,
          tokens: gUsage.total_tokens || ((gUsage.prompt_tokens || 0) + (gUsage.completion_tokens || 0)),
          promptTokens: gUsage.prompt_tokens || 0,
          completionTokens: gUsage.completion_tokens || 0
        };
      } catch (err) {
        const status = err.response?.status;
        // A 429 carrying a retry-after under a minute is ordinary per-minute
        // throttling, worth waiting out. A spent DAILY allowance also returns
        // 429 but with a retry-after measured in hours — waiting is useless
        // there, so stop retrying and let the next model take over.
        const retryAfterSec = Number(err.response?.headers?.['retry-after']) || 0;
        const dailyQuotaSpent = status === 429 && retryAfterSec > 120;
        // 413 is the request body being too large for this model, not a
        // transient fault — retrying unchanged always fails. Shrink and retry
        // before writing the model off, otherwise a long research answer can
        // never fall back to a smaller model.
        if (status === 413 && trimStep < TRIM_STEPS.length) {
          const before = _payloadChars(payload);
          payload = _trimMessages(payload, TRIM_STEPS[trimStep]);
          const after = _payloadChars(payload);
          trimStep++;
          console.warn(`⚠️ ${providerName} 413 on "${gModel}" — payload ${before} → ${after} chars (cap ${TRIM_STEPS[trimStep - 1]}/msg), retrying [${feature}]`);
          if (after < before) continue; // retry same model with the smaller payload
        }
        // Someone is waiting: skip straight to the next provider rather than
        // sitting out a rate limit. Whichever answers first wins, and the point
        // of having several providers is that one of them usually can.
        if (status === 429 && !patient) {
          console.warn(`⚠️ ${providerName} 429 on "${gModel}" — not waiting (interactive ${feature}), trying the next provider`);
          break;
        }
        if (status === 429 && attempt < 3 && !dailyQuotaSpent) {
          // A 429 with no retry-after header gives no guidance on how long to
          // wait, and the old ladder (2s/4s/6s — 12s in total) was far too
          // short for the case that actually matters. Gemini's free tier allows
          // roughly six requests per MINUTE and sends no header, so a research
          // run burst through the allowance, exhausted 12s of backoff inside a
          // 60s window, and abandoned the provider as if its whole day were
          // spent — which is how a briefing ended in "unavailable across
          // providers (tried: groq, gemini)" while Gemini was merely throttled.
          //
          // Back off on a minute-shaped ladder instead: 5s, 15s, 30s clears a
          // per-minute window. Sleeping here is charged to StallClock and
          // subtracted from the run's runtime budget, so waiting costs the run
          // no working time.
          const noHeaderBackoff = [5, 15, 30][attempt] || 30;
          const delayMs = Math.min((retryAfterSec || noHeaderBackoff) * 1000, 30_000);
          console.warn(`⚠️ ${providerName} 429 rate-limited on "${gModel}" (attempt ${attempt + 1}/3) — waiting ${delayMs}ms before retry [${feature}]`);
          if (rateLimited) _bucket.tokens = 0; // Drain bucket so concurrent calls also wait
          await _sleep(delayMs);
          continue; // retry same model
        }
        // A 5xx is the provider having a bad moment, not a verdict on the
        // request — retrying the SAME model is the right move, where a 4xx
        // would just fail again. Gemini answers 503 "This model is currently
        // experiencing high demand. Spikes in demand are usually temporary.
        // Please try again later", which is an explicit instruction to retry;
        // giving up on it immediately abandoned a working provider over a
        // wobble that had usually passed within seconds.
        if (status >= 500 && status < 600 && attempt < 3) {
          const delayMs = Math.min((retryAfterSec || [2, 6, 15][attempt] || 15) * 1000, 15_000);
          console.warn(`⚠️ ${providerName} ${status} on "${gModel}" (attempt ${attempt + 1}/3) — provider-side, waiting ${delayMs}ms before retry [${feature}]`);
          await _sleep(delayMs);
          continue; // retry same model
        }
        // A 400 is only proof the MODEL is gone when the provider says so. It
        // also returns 400 for a request this model could not satisfy — a
        // failed json_object validation, an oversized payload — and
        // blacklisting on those would retire a perfectly healthy model for the
        // whole process over one bad turn. Match the not-found shape.
        //
        // 404 is included because that is how a model WITHDRAWN from the key
        // answers: llama-3.1-8b-instant went from serving traffic to
        // 404 "does not exist or you do not have access to it" mid-day. Without
        // this, it stayed in the rotation and cost a wasted call every run.
        if ((status === 400 || status === 404) && _isModelNotFound(err)) {
          _deadModels.add(`${providerName}:${gModel}`);
          console.warn(`⚠️ ${providerName} model "${gModel}" no longer exists — dropping it for this process`);
        }
        const nextModel = candidates[mi + 1];
        const why = dailyQuotaSpent ? `daily allowance spent (retry-after ${retryAfterSec}s)` : (status || 'network');
        console.warn(`⚠️ ${providerName} model "${gModel}" unavailable (${why}): ${err.message}` +
          (nextModel ? ` — trying "${nextModel}"` : ` — no ${providerName} models left`));
        break; // move to the next candidate model
      }
    }
  }
  return null;
}

/**
 * Execute AI completion, walking this workload's provider order and returning
 * the first completion.
 *
 * `workload` selects that order — see WORKLOAD_ROUTES. It exists because one
 * shared pool let scheduled research drain the daily allowance that interactive
 * chat needed. It is an ordering, not an exclusive: every route still falls
 * through to the remaining providers.
 *
 * `feature`/`agentId`/`userId` are attribution tags for inference metrics and
 * do not affect routing. `feature` doubles as the workload when no explicit
 * `workload` is given, so callers already tagging their calls get routed
 * sensibly without further changes.
 */
async function runInference({
  messages, provider = 'groq', model, temperature = 0.7, jsonMode = false,
  byokKey, feature = 'chat', workload = null, agentId = null, userId = null
}) {
  const _startedAt = Date.now();

  // Providers are tried in order and the first completion wins. `attempted`
  // exists only so the final error can say WHICH providers were actually
  // reachable — "unavailable across providers" with no list was the single
  // least useful line in the logs while this was failing daily.
  const attempted = [];
  const effectiveWorkload = workload || feature;
  const route = _providersFor(effectiveWorkload);
  const patient = !IMPATIENT_WORKLOADS.has(effectiveWorkload);
  // A caller that named a model always wins; the hint only fills the gap for
  // workloads known not to need a frontier model. See WORKLOAD_MODEL_HINTS.
  const effectiveModel = model || WORKLOAD_MODEL_HINTS[effectiveWorkload] || null;

  for (const cfg of route) {
    // BYOK only ever applies to Groq — it is a Groq key the user supplied.
    const apiKey = (cfg.name === 'groq' && byokKey) ? byokKey : cfg.apiKey;
    if (!_usableKey(apiKey) || cfg.models.length === 0) continue;

    // An explicit `model` argument names a Groq model, so it leads Groq's list
    // and is withheld from the others, where it would 400 every candidate.
    const models = (cfg.acceptsModelOverride && effectiveModel)
      ? [effectiveModel, ...cfg.models]
      : cfg.models;

    attempted.push(cfg.name);
    const result = await _runProviderChain({
      providerName: cfg.name,
      baseUrl: cfg.baseUrl,
      apiKey,
      models,
      style: cfg.style,
      messages, temperature, jsonMode, feature, agentId, userId,
      startedAt: _startedAt,
      rateLimited: !!cfg.rateLimited,
      patient
    });
    if (result) return result;
  }

  // Local Ollama fallback or explicit provider.
  //
  // Worth being blunt about what this is: OLLAMA_URL defaults to localhost, so
  // on a cloud host this points at the app's OWN container, not at any machine
  // running Ollama. It is a real safety net in local development and dead
  // weight in production — which is why "why doesn't it use the local model?"
  // has the unsatisfying answer that from Render's point of view there isn't
  // one. Reaching a desktop Ollama from the cloud needs OLLAMA_URL set to a
  // publicly reachable tunnel, and that desktop to be awake.
  try {
    const response = await axios.post(
      `${OLLAMA_URL}/api/chat`,
      {
        model: model || OLLAMA_MODEL,
        messages,
        stream: false,
        format: jsonMode ? 'json' : undefined,
        options: {
          temperature
        }
      },
      { timeout: 120000 }
    );
    const oPrompt = response.data.prompt_eval_count || 0;
    const oCompletion = response.data.eval_count || 0;
    const oModel = model || OLLAMA_MODEL;
    recordInferenceMetric({
      provider: 'ollama', model: oModel, feature,
      promptTokens: oPrompt, completionTokens: oCompletion,
      latencyMs: Date.now() - _startedAt, agentId, userId
    });
    return {
      content: response.data.message?.content || '',
      provider: 'ollama',
      model: oModel,
      tokens: oPrompt + oCompletion,
      promptTokens: oPrompt,
      completionTokens: oCompletion
    };
  } catch (err) {
    // Name the providers actually tried. The old message claimed "across
    // providers" while Groq was the only one configured, which sent every
    // investigation of this failure off in the wrong direction.
    const tried = attempted.length ? attempted.join(', ') : 'none configured';
    const unconfigured = PROVIDERS.filter(c => !_usableKey(c.apiKey)).map(c => c.name);
    console.error(`❌ All AI inference providers failed (tried: ${tried}; ollama: ${err.message})` +
      (unconfigured.length ? ` — no API key set for: ${unconfigured.join(', ')}` : ''));
    throw new Error(`AI Inference unavailable across providers (tried: ${tried}).`);
  }
}

/**
 * The provider order a workload will use, as names. Exported for tests and for
 * answering "why did this go to Gemini?" without reading the routing table by
 * hand — a question that cost real time while diagnosing quota exhaustion.
 */
function providerOrderFor(workload) {
  return _providersFor(workload).map(p => p.name);
}

module.exports = {
  runInference, providerOrderFor, WORKLOAD_ROUTES, WORKLOAD_MODEL_HINTS, IMPATIENT_WORKLOADS
};
