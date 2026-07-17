// services/redis.js — Upstash Redis REST integration
const axios = require('axios');
require('dotenv').config();

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(commandArray) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    // Graceful fallback to memory if redis credentials aren't set
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
    return response.data.result;
  } catch (err) {
    console.warn('⚠️ Upstash Redis command failed:', err.message);
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
