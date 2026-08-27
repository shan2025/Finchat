// services/redis.js — Upstash Redis REST integration
const axios = require('axios');
require('dotenv').config();

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Circuit breaker. Working memory is written on every reasoning iteration, so a
// broken or over-quota Upstash (observed: hundreds of `status 400` per minute)
// used to spam the logs AND cost an HTTP round-trip per write while every caller
// silently fell back to memory anyway. After a run of consecutive failures we
// OPEN the circuit: skip the network entirely and return null (the same value a
// caller already treats as "not cached"), for a cooldown window. One probe after
// the cooldown closes it again if Upstash has recovered. The real failure reason
// (status + body) is logged ONCE per open, not once per call.
const BREAKER_THRESHOLD = 5;          // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 5 * 60_000; // stay open this long before a probe
let _consecutiveFailures = 0;
let _circuitOpenUntil = 0;

async function redisCommand(commandArray) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    // Graceful fallback to memory if redis credentials aren't set
    return null;
  }
  // Circuit open: don't touch the network until the cooldown elapses.
  if (_circuitOpenUntil && Date.now() < _circuitOpenUntil) {
    return null;
  }
  try {
    const response = await axios.post(
      UPSTASH_URL,
      commandArray,
      {
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    // Success (including the recovery probe) closes the circuit.
    if (_consecutiveFailures > 0 || _circuitOpenUntil) {
      console.log('✅ Upstash Redis recovered — circuit closed.');
    }
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
    return response.data.result;
  } catch (err) {
    _consecutiveFailures++;
    // Log the real reason ONCE — when the breaker trips — rather than on every
    // failing call. `status 400` almost always means the REST URL/token no longer
    // match a live database (rotated creds, deleted DB, or over-quota).
    if (_consecutiveFailures === BREAKER_THRESHOLD) {
      const status = err.response && err.response.status;
      const body = err.response && err.response.data;
      _circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      console.warn(
        `⚠️ Upstash Redis failing (${_consecutiveFailures}× in a row; ` +
        `${status ? `HTTP ${status}` : err.message}${body ? ` — ${JSON.stringify(body).slice(0, 200)}` : ''}). ` +
        `Circuit OPEN for ${Math.round(BREAKER_COOLDOWN_MS / 60000)}m; using in-memory fallback. ` +
        `Check UPSTASH_REDIS_REST_URL/TOKEN or unset them to silence this.`
      );
    }
    return null;
  }
}

async function getWorkingMemory(executionId) {
  const data = await redisCommand(['GET', `wm:${executionId}`]);
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function setWorkingMemory(executionId, stateObj, ttlSeconds = 86400) {
  await redisCommand(['SET', `wm:${executionId}`, JSON.stringify(stateObj), 'EX', ttlSeconds.toString()]);
}

async function cacheGet(key) {
  const data = await redisCommand(['GET', `cache:${key}`]);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

async function cacheSet(key, value, ttlSeconds = 300) {
  await redisCommand(['SET', `cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds.toString()]);
}

async function cacheDel(key) {
  await redisCommand(['DEL', `cache:${key}`]);
}

module.exports = {
  redisCommand,
  getWorkingMemory,
  setWorkingMemory,
  cacheGet,
  cacheSet,
  cacheDel
};
