// services/inference.js — Multi-Provider AI Inference Engine
// Fix 1: Token-bucket rate limiter for Groq (28 RPM) + retry-with-backoff on 429.
const axios = require('axios');
require('dotenv').config();

// Owns credential selection and the memory of exhausted allowances. See
// services/QuotaManager.js — this file decides ORDER, the QuotaManager decides
// which key pays and whether an allowance is already gone.
const quota = require('./QuotaManager');

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
// unchanged whether one key is set or all four.
//
// Note there is no `apiKey` here. Credentials are resolved per call by
// QuotaManager.resolveCredentials(), because which key pays depends on the
// agent and the user, not on the provider alone. Reading the env var here as
// well would create a second source of truth that looks authoritative and is
// never consulted.
const PROVIDERS = [
  {
    name: 'groq',
    style: 'openai',
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
      .split(',').map(s => s.trim()).filter(Boolean),
    // Image work leads with the pinned model instead. gemini-flash-latest times
    // out (45s) on an inline image before falling through, and a chat attachment
    // has someone watching it upload — measured 51s vs 6s per description on
    // 2026-08-30.
    visionModels: (process.env.GEMINI_VISION_MODELS || 'gemini-3.5-flash,gemini-flash-latest')
      .split(',').map(s => s.trim()).filter(Boolean)
  },
  {
    name: 'deepseek',
    style: 'openai',
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
    baseUrl: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1/chat/completions',
    models: (process.env.MISTRAL_MODELS || 'mistral-small-latest')
      .split(',').map(s => s.trim()).filter(Boolean)
  },
  {
    // Cerebras — the biggest free daily budget on the bench (1M tokens/day) and
    // very fast, but its free tier caps context at 8,192 tokens. Registered
    // primarily as a BYOK target: a user who brings a Cerebras key gets that 1M
    // for themselves. OpenAI-compatible, so no new call path.
    name: 'cerebras',
    style: 'openai',
    baseUrl: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1/chat/completions',
    models: (process.env.CEREBRAS_MODELS || 'llama-3.3-70b')
      .split(',').map(s => s.trim()).filter(Boolean)
  },
  {
    // OpenRouter — one key, many models. Useful mostly as a BYOK option for a
    // user who already routes everything through it. OpenAI-compatible.
    name: 'openrouter',
    style: 'openai',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions',
    models: (process.env.OPENROUTER_MODELS || 'meta-llama/llama-3.3-70b-instruct:free')
      .split(',').map(s => s.trim()).filter(Boolean)
  }
];

// (Key usability now lives in QuotaManager, which owns credential resolution —
// a provider with nothing usable configured resolves to an empty pool.)

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
    .split(',').map(s => s.trim()).filter(Boolean),

  // Describing an attached image is the one workload where the fallback chain is
  // actively harmful: a text-only model does not reject an image, it answers
  // confidently about a prompt it cannot see. Only providers whose model can
  // actually look at pixels belong here. Gemini leads because it is the one on
  // the bench with a working multimodal model — Groq's key carries no vision
  // model at all since llama-4-scout was decommissioned (probed 2026-08-30), so
  // adding Groq here would only spend calls to 404.
  vision: (process.env.INFERENCE_ROUTE_VISION || 'gemini')
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
/**
 * Message content is usually a string, but a multimodal turn (an image the user
 * pasted into chat) is an OpenAI-style array of parts. `String(content)` on that
 * array yields "[object Object],[object Object]" — which is not an error anyone
 * sees, because the model dutifully answers a question about that literal text.
 * That is exactly what happened to pasted screenshots before these two helpers.
 */
function _plainText(content) {
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  }
  return String(content || '');
}

/** OpenAI-style content → Gemini `parts`, carrying data-URL images as inline_data. */
function _geminiParts(content) {
  if (!Array.isArray(content)) return [{ text: String(content || '') }];
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text') { parts.push({ text: p.text || '' }); continue; }
    const url = p.type === 'image_url' && p.image_url ? p.image_url.url : null;
    const m = url && /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    // A remote image URL is dropped rather than sent: Gemini cannot fetch it,
    // and a silent partial prompt beats a 400 on the whole turn.
  }
  return parts.length ? parts : [{ text: '' }];
}

async function _callGemini({ baseUrl, apiKey, model, messages, temperature, jsonMode }) {
  const systemText = messages
    .filter(m => m.role === 'system')
    .map(m => _plainText(m.content)).join('\n\n');

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: _geminiParts(m.content)
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
  providerName, baseUrl, apiKey, credentialId, models, messages, temperature, jsonMode,
  feature, agentId, userId, startedAt, rateLimited = false, style = 'openai',
  patient = true
}) {
  const distinct = models.filter((m, i, arr) => m && arr.indexOf(m) === i);

  // A model the provider has retired answers 400 forever, not transiently.
  // Nova sat pinned to deepseek-r1-distill-llama-70b long after it was
  // withdrawn and paid a doomed round-trip on EVERY reasoning turn before
  // falling back. Once a model 400s on a decommission, stop offering it.
  const alive = distinct.filter(m => !_deadModels.has(`${providerName}:${m}`));

  // An allowance this credential has already spent today. The 429 that proved
  // it was previously used for one log line and forgotten, so every later call
  // re-tried the exhausted model and paid the round-trip again — on Groq, whose
  // limit is per model per day, that is every request until UTC midnight.
  const usable = alive.filter(m => !quota.isSpent(providerName, m, credentialId));

  // These two exhaustion cases need OPPOSITE handling, which is why they are
  // not one filter with one fallback.
  //
  // Everything RETIRED is our own inference from a 400, and it can be wrong —
  // so fall through to the configured list rather than making no call at all.
  // One wasted request beats refusing a provider we may have no alternative to.
  //
  // Everything SPENT is the provider telling us directly, with a retry-after
  // measured in hours. Retrying is guaranteed to fail, so the right move is to
  // leave this provider to the caller's next one. Falling back here instead
  // would re-offer every exhausted model and undo the entire point of
  // remembering — which is exactly what the first version of this did.
  let candidates;
  if (alive.length === 0) {
    candidates = distinct;
  } else if (usable.length === 0) {
    console.warn(`⚠️ ${providerName} has no model with allowance left on [${credentialId}] — skipping to the next provider [${feature}]`);
    return null;
  } else {
    candidates = usable;
  }

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
        // Record the exhausted allowance BEFORE moving on, so the next call
        // today skips this model instead of rediscovering it.
        if (dailyQuotaSpent) {
          quota.markSpent(providerName, gModel, credentialId, { retryAfterSec });
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
 *
 * `agentId` now also selects an agent-specific credential when one is
 * configured (see QuotaManager.resolveCredentials), so it affects WHICH key
 * pays for the call even though it still does not affect provider order.
 *
 * `byokKey` is a user-supplied key and `byokProvider` says which provider it
 * belongs to. It defaulted to Groq because that was the only provider BYOK ever
 * supported; naming the provider is what lets a user bring a key for any of them.
 */
async function runInference({
  messages, provider = 'groq', model, temperature = 0.7, jsonMode = false,
  byokKey, byokProvider = 'groq', feature = 'chat', workload = null,
  agentId = null, userId = null, onlyProvider = null
}) {
  const _startedAt = Date.now();

  // BYOK harness resolution. A real user's own provider keys, and whether the
  // shared pool is still open to them, are resolved ONCE here from a 60s cache
  // (UserKeys.resolveForUser) rather than threaded through route → think →
  // reason as extra arguments. `system` and background calls skip this entirely
  // and keep the old behaviour: shared keys, no cap.
  //
  // `onlyProvider` is the key-validation path: restrict to one provider and use
  // ONLY the supplied byokKey (no shared fallback), so a bad key fails honestly
  // instead of a system key answering in its place.
  let userKeys = {};
  let allowSystem = true;
  let preferredProvider = null;   // the provider the user assigned to this work
  if (onlyProvider) {
    allowSystem = false;
  } else if (userId && userId !== 'system') {
    try {
      const UserKeys = require('./UserKeys');
      const r = await UserKeys.resolveForUser(userId);
      userKeys = r.keys || {};
      allowSystem = r.allowSystem !== false;
      // Task→key assignment: the key tagged for this agent's kind of work leads,
      // then the `everything` key, then the default route. A preference, not a
      // wall — the rest of the user's keys stay as fallback below.
      const roleProviders = r.roleProviders || {};
      const role = UserKeys.roleForAgent(agentId);
      preferredProvider = roleProviders[role] || roleProviders.everything || null;
    } catch (err) {
      console.warn(`⚠️ UserKeys.resolveForUser(${userId}) failed, using shared pool: ${err.message}`);
    }
  }

  // Providers are tried in order and the first completion wins. `attempted`
  // exists only so the final error can say WHICH providers were actually
  // reachable — "unavailable across providers" with no list was the single
  // least useful line in the logs while this was failing daily.
  const attempted = [];
  const effectiveWorkload = workload || feature;
  let route = _providersFor(effectiveWorkload);
  // Key validation restricts the whole run to the one provider being tested.
  if (onlyProvider) route = route.filter(cfg => cfg.name === onlyProvider);
  // Every other route is an ORDER, not an exclusion — _providersFor appends the
  // remaining providers as a tail so a spent primary still gets an answer. Image
  // work is the exception: a text-only model cannot see the attachment and does
  // not say so, it answers about the serialized payload. Here the tail is a
  // liability, so the route is a hard whitelist of providers that declare a
  // vision model. If none is configured, the caller gets a failure it can be
  // honest about.
  if (effectiveWorkload === 'vision') route = route.filter(cfg => cfg.visionModels);
  // Move the user's role-assigned provider to the front so their chosen key
  // serves this work; everything else keeps its order as fallback.
  if (preferredProvider) {
    const lead = route.filter(cfg => cfg.name === preferredProvider);
    if (lead.length) route = [...lead, ...route.filter(cfg => cfg.name !== preferredProvider)];
  }
  const patient = !IMPATIENT_WORKLOADS.has(effectiveWorkload);
  // A caller that named a model always wins; the hint only fills the gap for
  // workloads known not to need a frontier model. See WORKLOAD_MODEL_HINTS.
  const effectiveModel = model || WORKLOAD_MODEL_HINTS[effectiveWorkload] || null;

  for (const cfg of route) {
    if (cfg.models.length === 0) continue;

    // Credentials are a POOL now, resolved user → agent → system, rather than
    // one env var plus a Groq-shaped BYOK special case. A provider with nothing
    // usable configured resolves to an empty pool and is skipped, which is what
    // the old `_usableKey` guard meant.
    //
    // `byokKey` keeps its name for callers but is no longer Groq-only: a user's
    // key is simply the first credential in that provider's pool.
    // A user's own key for THIS provider comes from the resolved map first, then
    // the legacy single-provider byokKey argument (kept for the validation path
    // and any old caller). `allowSystem` drops the shared key when the user has
    // spent their allowance — see UserKeys / QuotaManager.
    const userKey = userKeys[cfg.name] ||
      ((byokKey && cfg.name === byokProvider) ? byokKey : null);
    const credentials = quota.resolveCredentials(cfg.name, { agentId, userKey, allowSystem });
    if (credentials.length === 0) continue;

    // An explicit `model` argument names a Groq model, so it leads Groq's list
    // and is withheld from the others, where it would 400 every candidate.
    const baseModels = (effectiveWorkload === 'vision' && cfg.visionModels)
      ? cfg.visionModels
      : cfg.models;
    const models = (cfg.acceptsModelOverride && effectiveModel)
      ? [effectiveModel, ...baseModels]
      : baseModels;

    attempted.push(cfg.name);

    // Each credential is a separate allowance, so a spent one is a reason to
    // try the next KEY before giving up on the provider — the whole point of a
    // pool. With a single system key this loop runs once and behaves exactly as
    // it did before.
    for (const cred of credentials) {
      const result = await _runProviderChain({
        providerName: cfg.name,
        baseUrl: cfg.baseUrl,
        apiKey: cred.key,
        credentialId: cred.id,
        models,
        style: cfg.style,
        messages, temperature, jsonMode, feature, agentId, userId,
        startedAt: _startedAt,
        rateLimited: !!cfg.rateLimited,
        patient
      });
      if (result) return result;
    }
  }

  // BYOK gate. A capped user with no key of their own has had every provider
  // skipped above (empty pools), not merely throttled — so the honest answer is
  // "connect your own AI", not "temporary network delay". Thrown with a stable
  // marker the chat layer maps to a Settings deep-link.
  if (!onlyProvider && !allowSystem && Object.keys(userKeys).length === 0 && !byokKey
      && userId && userId !== 'system') {
    const e = new Error('BYOK_REQUIRED: You have used your free allowance. Connect your own AI provider key in Settings to continue.');
    e.code = 'BYOK_REQUIRED';
    throw e;
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
  //
  // Skipped for image work: this posts OpenAI-shaped `messages`, and a local
  // text model would answer about an image it never received. The attachment
  // service has its own Ollama step that speaks the native `images` field.
  if (effectiveWorkload === 'vision') {
    throw new Error('No vision-capable provider available (route: vision)');
  }
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
    const unconfigured = PROVIDERS
      .filter(c => quota.resolveCredentials(c.name, { agentId }).length === 0)
      .map(c => c.name);
    // Naming what is currently rate-limited-out matters as much as what has no
    // key: "tried: groq, gemini" reads like an outage when the real answer is
    // that both allowances are spent until midnight.
    const spent = quota.listSpent();
    console.error(`❌ All AI inference providers failed (tried: ${tried}; ollama: ${err.message})` +
      (unconfigured.length ? ` — no API key set for: ${unconfigured.join(', ')}` : '') +
      (spent.length ? ` — allowance spent: ${spent.map(s => `${s.provider}/${s.model}`).join(', ')}` : ''));
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

/**
 * Which providers this deployment can actually reach, and (optionally) whether
 * their keys still answer.
 *
 * Exists because "is the Gemini key set on Render?" had no answer short of the
 * dashboard: a missing key is silent here by design — the provider resolves to
 * an empty credential pool and is skipped. That is right for serving traffic and
 * useless for operating the thing. `live` spends a handful of tokens per
 * provider to tell a configured key from a working one, and `vision` sends a
 * 1x1 PNG so the image path is proven end to end rather than assumed from the
 * text path working.
 */
async function probeProviders({ live = false, vision = false } = {}) {
  // A 64x64 PNG (black square on white). Deliberately not a 1x1 pixel: Gemini
  // rejects that outright with "Unable to process input image" (400), which
  // would make a healthy key look broken — the canary has to be an image a
  // vision model would actually accept.
  const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEDSURBVHhe7ZAxCgNAEITu/59OelvBEGYFmy1k2PcZ5/Gwxj2AhzXuATyscQ/gYY17AA9r3AN4WOMewMMa9wAe1tAPeO/9VIsucFCtRRc4qNaiCxxUa9EFDqq16AIH1Vp0gYNqLbrAQbUWXeCgWosucFCtRRc4qNaiCxxUa9EFDqq16AIH1Vp0gYNqLbrAQbUWXeCgWosucFCtRRc4qNaiCxxUa9EFDqq16AIH1Vp0gYNqLbrAQbUWXeCgWosucFCtRRc4qNaiCxxUa9EFDqq16AIH1Vp0gYNqLbrAQbUWX/hz7gE8rHEP4GGNewAPa9wDeFjjHsDDGvcAHta4B/CwxvwDvks7zv7mSmbzAAAAAElFTkSuQmCC';
  const out = [];
  for (const cfg of PROVIDERS) {
    const creds = quota.resolveCredentials(cfg.name, { allowSystem: true });
    const row = {
      provider: cfg.name,
      configured: creds.length > 0,
      // Never the key itself — this endpoint is reachable with the cron secret.
      credentials: creds.map(c => c.id),
      models: cfg.models,
      visionModels: cfg.visionModels || null
    };
    if (live && row.configured) {
      const wantsImage = vision && !!cfg.visionModels;
      const content = wantsImage
        ? [{ type: 'text', text: 'Reply with the single word: ok' },
           { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } }]
        : 'Reply with the single word: ok';
      const startedAt = Date.now();
      try {
        const r = await runInference({
          messages: [{ role: 'user', content }],
          workload: wantsImage ? 'vision' : 'probe',
          feature: 'probe',
          onlyProvider: cfg.name,
          byokKey: creds[0].key,       // onlyProvider uses the supplied key alone
          byokProvider: cfg.name,
          temperature: 0
        });
        row.live = { ok: true, model: r.model || null, ms: Date.now() - startedAt, sawImage: wantsImage };
      } catch (err) {
        row.live = { ok: false, error: err.message, ms: Date.now() - startedAt, sawImage: wantsImage };
      }
    }
    out.push(row);
  }
  return out;
}

module.exports = {
  runInference, providerOrderFor, probeProviders,
  WORKLOAD_ROUTES, WORKLOAD_MODEL_HINTS, IMPATIENT_WORKLOADS
};
