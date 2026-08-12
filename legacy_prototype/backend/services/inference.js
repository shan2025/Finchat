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
const GROQ_PRIMARY_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS ||
  'openai/gpt-oss-120b,llama-3.1-8b-instant')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Token-bucket rate limiter ────────────────────────────────────
// Groq free tier ≈ 30 RPM. We cap at 28 to leave headroom.
const GROQ_RPM = Number(process.env.GROQ_RPM) || 28;
const BUCKET_REFILL_MS = 60_000; // 1 minute window
const MAX_WAIT_MS = 5_000;       // max time to wait for a token before fallback

const _bucket = { tokens: GROQ_RPM, lastRefill: Date.now() };

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

  // Wait for the next partial refill
  const waitMs = Math.min(MAX_WAIT_MS, Math.ceil(BUCKET_REFILL_MS / GROQ_RPM));
  await new Promise(r => setTimeout(r, waitMs));
  _refillBucket();
  if (_bucket.tokens > 0) { _bucket.tokens--; return true; }
  return false; // still empty after waiting — fall to Ollama
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

/**
 * Make one Groq API call. Separated so the retry logic can call it cleanly.
 */
async function _callGroq({ apiKey, model, messages, temperature, jsonMode }) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: model || 'llama-3.3-70b-versatile',
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
      .filter((m, i, arr) => m && arr.indexOf(m) === i);

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
          const response = await _callGroq({ apiKey, model: gModel, messages, temperature, jsonMode });
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
          if (status === 429 && attempt < 3 && !dailyQuotaSpent) {
            const delayMs = Math.min((retryAfterSec || (2 * (attempt + 1))) * 1000, 15_000);
            console.warn(`⚠️ Groq 429 rate-limited on "${gModel}" (attempt ${attempt + 1}/3) — waiting ${delayMs}ms before retry [${feature}]`);
            _bucket.tokens = 0; // Drain bucket so other concurrent calls also wait
            await _sleep(delayMs);
            continue; // retry same model
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
