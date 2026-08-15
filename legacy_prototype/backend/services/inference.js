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
// mean no inference at all. Deliberately spans three model families, since a
// spent quota is scoped to one model.
//
// llama-3.3-70b-versatile was the primary until Groq announced its
// decommission (notice dated 2026-08-15). gpt-oss-120b replaces it: verified
// against the real agent prompt in JSON mode and the strongest model this key
// still serves. Note it is a reasoning model and bills its reasoning tokens —
// the same turn cost 511 tokens against 70B's 209 — so runs burn roughly twice
// the budget for the same work.
//
// qwen/qwen3.6-27b is available on the key and deliberately NOT listed: it
// emits a <think> preamble, fails Groq's own json_object validation, and never
// parses into an action. Do not add it.
const GROQ_PRIMARY_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ||
  'openai/gpt-oss-20b,llama-3.1-8b-instant')
  .split(',').map(s => s.trim()).filter(Boolean);

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
 * Does this 400 mean "that model does not exist" rather than "that request was
 * bad"? Groq signals the former with code `model_not_found` (or prose naming
 * the model as unknown/decommissioned); the latter covers json_object
 * validation failures and oversized payloads, which say nothing about the
 * model's availability and must NOT retire it.
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
function recordInferenceMetric({ provider, model, feature, promptTokens, completionTokens, latencyMs, agentId, userId }) {
  try {
    const { query } = require('../database');
    query(`
      INSERT INTO inference_metrics
        (provider, model, feature, prompt_tokens, completion_tokens, latency_ms, agent_id, user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [provider, model || '', feature || 'chat', promptTokens || 0, completionTokens || 0,
      latencyMs || 0, agentId || null, userId || null]).catch(() => {});
  } catch (err) { /* metrics are best-effort */ }
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
 * Make one Groq API call. Separated so the retry logic can call it cleanly.
 */
async function _callGroq({ apiKey, model, messages, temperature, jsonMode }) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: model || GROQ_PRIMARY_MODEL,
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
 * Execute AI completion using the requested provider.
 * Supports Groq cloud (fast, default for cloud users), Ollama (local execution), or BYOK.
 *
 * `feature`/`agentId`/`userId` are optional tags for inference metrics only — they do
 * not affect the call, just how it's attributed in the Knowledge Center.
 */
async function runInference({ messages, provider = 'groq', model, temperature = 0.7, jsonMode = false, byokKey, feature = 'chat', agentId = null, userId = null }) {
  const _startedAt = Date.now();
  // Check if we have a valid non-placeholder Groq key or BYOK key
  const hasValidGroqKey = (byokKey && byokKey !== 'YOUR_GROQ_API_KEY_HERE') ||
    (GROQ_API_KEY && GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE' && !GROQ_API_KEY.startsWith('YOUR_'));

  if (provider === 'groq' && hasValidGroqKey) {
    const apiKey = byokKey || GROQ_API_KEY;
    // An explicit `model` argument still wins, but it is only the first thing
    // tried — the rest of the chain covers it running out of daily allowance.
    const candidates = [model || GROQ_PRIMARY_MODEL, ...GROQ_FALLBACK_MODELS]
      .filter((m, i, arr) => m && arr.indexOf(m) === i)
      // A model Groq has retired answers 400 forever, not transiently. Nova sat
      // pinned to deepseek-r1-distill-llama-70b long after it was withdrawn and
      // paid a doomed round-trip on EVERY reasoning turn before falling back —
      // latency and stall time charged to the run for a call that could not
      // succeed. Once a model 400s on a decommission, stop offering it.
      .filter(m => !_deadModels.has(m));

    // Everything retired: fall through to the chain's defaults rather than
    // making no Groq call at all.
    if (candidates.length === 0) {
      candidates.push(...[GROQ_PRIMARY_MODEL, ...GROQ_FALLBACK_MODELS].filter(Boolean));
    }

    // Trimming persists across models: once a payload proves too large for one
    // fallback the next is unlikely to accept it either, so the smaller version
    // carries forward rather than re-failing at full size on every candidate.
    let payload = messages;
    const TRIM_STEPS = [12000, 4000];
    let trimStep = 0;

    for (let mi = 0; mi < candidates.length; mi++) {
      const gModel = candidates[mi];

      // Rate-limit: wait for a token before calling Groq
      const hasToken = await _acquireToken();
      if (!hasToken) {
        // An empty bucket is our own throttle, not this model's quota, so
        // switching models would not help — leave Groq entirely.
        console.warn(`⚠️ Groq rate limit: bucket empty after waiting ${MAX_WAIT_MS}ms, falling back to Ollama [${feature}]`);
        break;
      }

      // Attempt this model with 429-retries
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await _callGroq({ apiKey, model: gModel, messages: payload, temperature, jsonMode });
          console.log(`⚡ Groq Cloud Inference Successful [Model: ${gModel}]` +
            (mi > 0 ? ` (fallback #${mi} — "${candidates[0]}" was unavailable)` : ''));
          const gUsage = response.data.usage || {};
          recordInferenceMetric({
            provider: 'groq', model: gModel, feature,
            promptTokens: gUsage.prompt_tokens || 0, completionTokens: gUsage.completion_tokens || 0,
            latencyMs: Date.now() - _startedAt, agentId, userId
          });
          return {
            content: response.data.choices[0]?.message?.content || '',
            provider: 'groq',
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
            console.warn(`⚠️ Groq 413 on "${gModel}" — payload ${before} → ${after} chars (cap ${TRIM_STEPS[trimStep - 1]}/msg), retrying [${feature}]`);
            if (after < before) continue; // retry same model with the smaller payload
          }
          if (status === 429 && attempt < 3 && !dailyQuotaSpent) {
            const delayMs = Math.min((retryAfterSec || (2 * (attempt + 1))) * 1000, 15_000);
            console.warn(`⚠️ Groq 429 rate-limited on "${gModel}" (attempt ${attempt + 1}/3) — waiting ${delayMs}ms before retry [${feature}]`);
            _bucket.tokens = 0; // Drain bucket so other concurrent calls also wait
            await _sleep(delayMs);
            continue; // retry same model
          }
          // A 400 is only proof the MODEL is gone when Groq says so. It also
          // returns 400 for a request this model could not satisfy — a failed
          // json_object validation, an oversized payload — and blacklisting on
          // those would retire a perfectly healthy model for the whole process
          // over one bad turn. Match the not-found shape specifically.
          if (status === 400 && _isModelNotFound(err)) {
            _deadModels.add(gModel);
            console.warn(`⚠️ Groq model "${gModel}" no longer exists — dropping it for this process`);
          }
          const nextModel = candidates[mi + 1];
          const why = dailyQuotaSpent ? `daily allowance spent (retry-after ${retryAfterSec}s)` : (status || 'network');
          console.warn(`⚠️ Groq model "${gModel}" unavailable (${why}): ${err.message}` +
            (nextModel ? ` — trying "${nextModel}"` : ' — no Groq models left, falling back to Ollama'));
          break; // move to the next candidate model
        }
      }
    }
  }

  // Local Ollama fallback or explicit provider
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
    console.error('❌ All AI inference providers failed:', err.message);
    throw new Error('AI Inference unavailable across providers.');
  }
}

module.exports = { runInference };
