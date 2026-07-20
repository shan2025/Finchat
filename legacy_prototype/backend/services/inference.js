// services/inference.js — Multi-Provider AI Inference Engine
const axios = require('axios');
require('dotenv').config();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
    try {
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
      console.log(`⚡ Groq Cloud Inference Successful [Model: ${model || 'llama-3.3-70b-versatile'}]`);
      const gUsage = response.data.usage || {};
      const gModel = model || 'llama-3.3-70b-versatile';
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
      console.warn('⚠️ Groq API call failed, falling back to local Ollama:', err.message);
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
