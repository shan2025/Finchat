// services/queue/WorkerPool.js — BullMQ Background Workers for Cognitive Core
// Fix 3: Redis resilience — retryStrategy, reconnectOnError, startup retry.
const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');
const { chatWithPersona } = require('../aiChat');
const { eventBus } = require('../cognitive/EventBus');

const QUEUE_NAME = 'cognitive-executions';

/**
 * Build connection URL from environment variables.
 * Automatically converts Upstash REST credentials to TCP rediss:// URL if no local REDIS_URL exists.
 */
function getRedisConnectionConfig() {
  if (process.env.QUEUE_REDIS_URL) return process.env.QUEUE_REDIS_URL;
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const host = process.env.UPSTASH_REDIS_REST_URL.replace(/https?:\/\//, '').replace(/\/$/, '');
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    return `rediss://default:${token}@${host}:6379`;
  }

  return 'redis://127.0.0.1:6379';
}

function getConnectionOptions(url) {
  const isTls = typeof url === 'string' && url.startsWith('rediss://');
  return {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    tls: isTls ? { rejectUnauthorized: false } : undefined,
    // ── Fix 3: Reconnect with exponential backoff ────────────────
    retryStrategy(times) {
      if (times > 20) {
        console.error(`❌ Redis: giving up after ${times} retries`);
        return null; // stop retrying
      }
      const delay = Math.min(times * 1000, 30_000); // cap at 30s
      console.warn(`🔄 Redis: reconnecting in ${delay}ms (attempt ${times})`);
      return delay;
    },
    reconnectOnError(err) {
      const msg = (err.message || '').toLowerCase();
      // Force reconnect on DNS and connection errors instead of dying
      if (msg.includes('enotfound') || msg.includes('econnreset') ||
          msg.includes('econnrefused') || msg.includes('etimedout')) {
        console.warn(`🔄 Redis: reconnectOnError triggered — ${err.message}`);
        return true; // reconnect
      }
      return false;
    }
  };
}

let queue = null;
let worker = null;
let queueEvents = null;
let connection = null;

/**
 * Attach event listeners to an ioredis connection for visibility.
 */
function _attachRedisListeners(conn, label) {
  conn.on('connect', () => console.log(`🟢 Redis [${label}]: connected`));
  conn.on('ready', () => console.log(`🟢 Redis [${label}]: ready`));
  conn.on('error', (err) => console.warn(`🔴 Redis [${label}] error: ${err.message}`));
  conn.on('reconnecting', (ms) => console.warn(`🔄 Redis [${label}]: reconnecting in ${ms || '?'}ms`));
  conn.on('close', () => console.warn(`⚪ Redis [${label}]: connection closed`));
}

/**
 * Get or initialize the BullMQ Queue instance.
 */
function getQueue() {
  if (!queue) {
    const redisUrl = getRedisConnectionConfig();
    connection = new Redis(redisUrl, getConnectionOptions(redisUrl));
    _attachRedisListeners(connection, 'queue');
    queue = new Queue(QUEUE_NAME, { connection });
    queueEvents = new QueueEvents(QUEUE_NAME, { connection });

    queueEvents.on('completed', ({ jobId, returnvalue }) => {
      eventBus.emit('worker:job_completed', { jobId, returnvalue, timestamp: new Date().toISOString() });
    });

    queueEvents.on('failed', ({ jobId, failedReason }) => {
      eventBus.emit('worker:job_failed', { jobId, failedReason, timestamp: new Date().toISOString() });
    });
  }
  return queue;
}

/**
 * Enqueue a cognitive execution request into BullMQ.
 */
async function enqueueExecutionJob(jobData, jobOptions = {}) {
  const q = getQueue();
  const job = await q.add('execute-cognitive-chat', jobData, {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    ...jobOptions
  });

  return {
    jobId: job.id,
    queueName: QUEUE_NAME,
    state: await job.getState(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Check the status and outcome of a queued job.
 */
async function getJobStatus(jobId) {
  const q = getQueue();
  const job = await q.getJob(jobId);
  if (!job) return null;

  const state = await job.getState();
  return {
    jobId: job.id,
    state,
    progress: job.progress,
    result: job.returnvalue || null,
    failedReason: job.failedReason || null,
    attemptsMade: job.attemptsMade,
    createdAt: new Date(job.timestamp).toISOString(),
    processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
  };
}

/**
 * Start the BullMQ Worker pool to process jobs in the background.
 * Handles both cognitive execution jobs and morning briefing jobs.
 */
function startWorkerPool(concurrency = 5) {
  if (worker) return worker;

  const redisUrl = getRedisConnectionConfig();
  const workerConnection = new Redis(redisUrl, getConnectionOptions(redisUrl));
  _attachRedisListeners(workerConnection, 'worker');

  worker = new Worker(QUEUE_NAME, async (job) => {
    // Route to appropriate processor based on job name
    if (job.name === 'morning-executive-briefing') {
      return await processMorningBriefing(job);
    }

    if (job.name === 'agent-mission') {
      // Sprint 7: scheduled mission run (lazy-load to avoid circular requires)
      const { runMission } = require('../agents/MissionScheduler');
      return await runMission(job.data.missionId);
    }

    // Default: cognitive execution chat
    const { personaId, userMessage, history = [], options = {} } = job.data;
    console.log(`[WorkerPool] Processing job #${job.id} for persona "${personaId}"...`);

    const start = Date.now();
    const result = await chatWithPersona(personaId, userMessage, history, {
      ...options,
      jobId: job.id
    });
    const durationMs = Date.now() - start;

    console.log(`[WorkerPool] Completed job #${job.id} in ${durationMs}ms.`);
    return {
      ...result,
      processedByWorker: true,
      workerDurationMs: durationMs
    };
  }, {
    connection: workerConnection,
    concurrency
  });

  worker.on('failed', (job, err) => {
    console.error(`[WorkerPool] Job #${job?.id} failed:`, err.message);
  });

  return worker;
}

// ─── Morning Executive Briefing System ───

const BRIEFING_GOAL = `You are producing today's **🧠 Frontier Intelligence Brief** — a premium daily executive report.

RESEARCH PHASE — use your tools to gather REAL, CURRENT data across these domains:
- "news" tool: AI industry headlines, earnings, partnerships, funding rounds (Bloomberg, Reuters, CNBC, TechCrunch level)
- "crypto" tool: Bitcoin, Ethereum, Solana current prices and 24h moves
- "stocks" tool: AAPL, TSLA, and any tickers mentioned in today's headlines
- "commodities" tool: Gold and oil as macro sentiment indicators
- "paper" tool: Recent arXiv work on LLMs, agents, neuro-computation, or AI safety
- "search" tool: Fill gaps — VC funding trends, fintech news, career/hiring market shifts
- "fetch" tool: Read the most important article in depth for richer analysis

WRITING PHASE — synthesize everything into this exact structure:

# 🧠 Frontier Intelligence Brief — [Today's Date]

## Executive Summary
3-5 bullet points ranking today's strongest signals by importance. Use emoji indicators (📉📈🧪🖥️🧠💰₿).

## [Themed Sections — 4 to 7 of these, each covering ONE major story]
For each section:
### [Company/Topic Name]
#### [Descriptive one-line subtitle]
1-2 paragraphs of ANALYSIS (not just facts — explain context, implications, competitive dynamics). Reference sources inline as markdown links: ([Source Name][N]).
**Why it matters** — A short paragraph explaining the strategic significance for investors, builders, or researchers.

## 📈 Markets & Funding (if relevant data found)
Synthesize market moves and startup funding into strategic narrative, not raw numbers.

## ₿ Crypto & Blockchain (if relevant data found)
Focus on structural trends (stablecoins, RWAs, DePIN, verifiable AI) not just price ticks.

## 🎯 Key Takeaway
One synthesizing paragraph that connects the dots across all sections — what is the overarching theme today?

[1]: URL "Title"
[2]: URL "Title"
... (numbered reference links at the bottom)

QUALITY RULES:
- NEVER list raw tool output. Every data point must be contextualized with analysis.
- NEVER fabricate URLs, numbers, or quotes. Only report what tools returned.
- ALWAYS include "Why it matters" after each major section.
- Write in a confident, analytical editorial voice — like a senior intelligence analyst, not a news aggregator.
- Cross-reference findings: if a funding round connects to an earnings report or a research paper, SAY SO.
- Minimum 800 words, maximum 2000 words. Quality over quantity.`;

/**
 * Sidebar title for a briefing conversation, e.g. "📰 Daily News — 13 Aug 2026".
 *
 * Dated rather than just "Daily News": several briefings sit in the list at
 * once and the date is the only thing that tells them apart at a glance.
 * Exported so the sessions endpoint can label briefings that predate this.
 */
function briefingSessionTitle(when = new Date()) {
  const day = when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `📰 Daily News — ${day}`;
}

/**
 * Process a morning executive briefing job.
 * Routes through PlatoOrchestrator which delegates to specialist agents with their tools.
 */
async function processMorningBriefing(job) {
  const { userId = 'system', requestedAt } = job.data;
  console.log(`\n🌅 [MorningBriefing] Starting executive briefing for user "${userId}" (requested: ${requestedAt || 'scheduled'})...`);

  const start = Date.now();

  try {
    // Lazy-load to avoid circular dependency issues at startup
    const { route } = require('../agents/PlatoOrchestrator');
    const { query: dbQuery } = require('../../database');

    const result = await route({
      goal: BRIEFING_GOAL,
      userId,
      targetAgentId: 'plato', // Force Plato to orchestrate
      // The briefing goal requires 4+ tool calls across 3 domains (crypto,
      // stocks, search, paper) plus planning/synthesis reasoning turns — the
      // CognitiveCore default budget (60s / 5 tool calls / 8 iterations) is
      // sized for a single interactive chat turn and was reliably tripping
      // "Budget exceeded during plan execution" before the plan finished.
      // This runs as a background job with no one waiting on a spinner, so a
      // larger budget is safe here without loosening the interactive default.
      budget: { maxRuntimeSeconds: 240, maxToolCalls: 15, maxIterations: 14, maxTokens: 15000 }
    });

    const durationMs = Date.now() - start;
    const rawBriefing = result.cleanResponse || result.response || 'Briefing generation failed — no content returned.';
    const briefingText = typeof rawBriefing === 'string' ? rawBriefing : String(rawBriefing);

    console.log(`🌅 [MorningBriefing] Completed in ${durationMs}ms (${briefingText.length} chars)`);

    // Store briefing as a Plato turn in ai_conversations — this is the table
    // the Chat page actually reads (via /api/ai-chat/sessions + /history), not
    // the channel-based `messages` table. A prior version wrote to `messages`
    // with a `receiver_id` column that table doesn't have, so every briefing
    // insert silently failed and the bell notification always linked to a page
    // with nothing to show.
    const briefingSessionId = `briefing_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    try {
      await dbQuery(`
        INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content)
        VALUES ($1, $2, $3, $4, 'assistant', $5)
      `, [`conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, briefingSessionId, userId, 'plato', briefingText]);
    } catch (msgErr) {
      console.warn(`⚠️ [MorningBriefing] Failed to store briefing message: ${msgErr.message}`);
    }

    // Name the conversation. /api/ai-chat/sessions titles a session from its
    // first USER message, and a briefing has none — every one of them showed up
    // in the sidebar as "New conversation", indistinguishable from each other
    // and from a chat you actually started. A stored title also survives the
    // user replying into the session later.
    try {
      await dbQuery(`
        INSERT INTO ai_session_meta (session_id, user_id, title, deleted, updated_at)
        VALUES ($1, $2, $3, false, NOW())
        ON CONFLICT (session_id) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
      `, [briefingSessionId, userId, briefingSessionTitle()]);
    } catch (titleErr) {
      // A missing title is cosmetic — never lose the briefing over it.
      console.warn(`⚠️ [MorningBriefing] Could not title briefing session: ${titleErr.message}`);
    }

    // Store notification so it shows on the notification bell (live via notification:new)
    // Full report as content: the bell preview truncates it for display, while
    // external channels (Telegram/email) deliver the whole briefing. Link deep-
    // links straight into the session created above so the briefing is visible
    // immediately instead of landing on Plato's default empty chat.
    const { createNotification } = require('../notifications');
    await createNotification({
      userId,
      type: 'briefing',
      title: '🌅 Morning Executive Briefing',
      content: briefingText,
      link: `finchat_chat.html?session=${briefingSessionId}`
    });

    eventBus.emit('briefing:completed', {
      userId,
      durationMs,
      contentLength: briefingText.length,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      userId,
      briefing: briefingText,
      durationMs,
      processedByWorker: true,
      executionId: result.executionId
    };

  } catch (err) {
    console.error(`❌ [MorningBriefing] Failed for user "${userId}":`, err.message);
    throw err; // Let BullMQ retry with exponential backoff
  }
}

/**
 * Schedule recurring morning executive briefings via BullMQ repeatable jobs.
 *
 * @param {object} options
 * @param {string} options.userId - User to generate the briefing for
 * @param {string} [options.cron='0 8 * * *'] - Cron schedule (default: 8:00 AM daily)
 * @param {boolean} [options.instant=false] - If true, run immediately instead of waiting for cron
 * @returns {Promise<{ jobId, scheduled, cron, nextRun }>}
 */
async function scheduleMorningBriefing({ userId = 'system', cron = '0 8 * * *', instant = false } = {}) {
  const q = getQueue();

  if (instant) {
    // Run immediately as a one-shot job
    const job = await q.add('morning-executive-briefing', {
      userId,
      requestedAt: new Date().toISOString(),
      instant: true
    }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 }
    });

    console.log(`🌅 [MorningBriefing] Instant briefing queued → Job #${job.id}`);
    return {
      jobId: job.id,
      scheduled: false,
      instant: true,
      state: await job.getState(),
      timestamp: new Date().toISOString()
    };
  }

  // Schedule recurring briefing via BullMQ repeatable job
  const job = await q.add('morning-executive-briefing', {
    userId,
    requestedAt: 'scheduled'
  }, {
    repeat: {
      pattern: cron
    },
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 30 }, // Keep last 30 briefings
    removeOnFail: { count: 100 }
  });

  console.log(`🌅 [MorningBriefing] Recurring briefing scheduled → Cron: "${cron}" for user "${userId}"`);
  return {
    jobId: job.id,
    scheduled: true,
    cron,
    userId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Cancel all scheduled morning briefings for a user.
 */
async function cancelMorningBriefings() {
  const q = getQueue();
  const repeatable = await q.getRepeatableJobs();
  let cancelled = 0;

  for (const job of repeatable) {
    if (job.name === 'morning-executive-briefing') {
      await q.removeRepeatableByKey(job.key);
      cancelled++;
    }
  }

  console.log(`🌅 [MorningBriefing] Cancelled ${cancelled} scheduled briefing(s)`);
  return { cancelled };
}

/**
 * Gracefully shut down queue, worker, and Redis connections.
 */
async function shutdownWorkerPool() {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

module.exports = {
  getQueue,
  enqueueExecutionJob,
  getJobStatus,
  startWorkerPool,
  shutdownWorkerPool,
  getRedisConnectionConfig,
  scheduleMorningBriefing,
  cancelMorningBriefings,
  briefingSessionTitle,
  QUEUE_NAME
};
