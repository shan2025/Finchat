// services/briefing.js — the morning executive briefing.
//
// This used to be a BullMQ job processor living in the worker pool. Nothing
// about producing a briefing needed a queue: it is one agent run, started by
// something external (the cron trigger at /api/cron/briefing, or a button on
// the dashboard), and the only thing the queue contributed was a Redis
// dependency that could take the whole server down when it ran out of quota.
// The schedule lives in the external cron service; this module just runs one.
const { eventBus } = require('./cognitive/EventBus');

// completion_reason values that mean the run produced no real briefing. Same
// set runMission gates on — see MissionScheduler.js, which learned this the
// hard way and was fixed while this file was left behind.
const FAILED_REASONS = new Set(['error', 'budget_exceeded', 'failed', 'timeout']);

// How long a delivered briefing suppresses the next one, and how long a FAILED
// attempt does.
//
// /api/cron/briefing deliberately has no due-check — the comment there says the
// external cron's own schedule is the schedule. That holds right up until the
// external schedule is wrong: a trigger left on a 15-minute interval produced
// 96 briefings a day, each one a chat session in the sidebar and a bell
// notification, and between them they ate the Groq daily allowance that the
// briefing itself needs — so the flood was also the reason the briefings that
// did run came back "AI Inference unavailable across providers."
//
// A run this expensive should not depend on an external config being right, so
// the floor lives here too. Two windows rather than one: a success suppresses
// the next scheduled slot, while a failure may retry within the hour instead of
// leaving the user with no briefing until the next one is due.
//
// 6 hours, not 20: the schedule is three briefings a day (08:00/14:00/20:00
// IST), i.e. one every 8 hours. A 20-hour floor would have delivered the
// morning brief and then silently swallowed midday and evening — the guard
// against a runaway cron must sit comfortably below the real interval, not
// above it. 6h still collapses a 15-minute trigger to at most 4 runs a day.
const MIN_INTERVAL_HOURS = Number(process.env.BRIEFING_MIN_INTERVAL_HOURS) || 6;
const RETRY_INTERVAL_MINUTES = Number(process.env.BRIEFING_RETRY_MINUTES) || 60;

// Timezone that decides which calendar day a briefing belongs to, so all of a
// day's runs land in one chat. The schedule is set in IST, so the UTC date
// would split an evening brief into the wrong day the moment the times move.
const BRIEFING_TZ = process.env.BRIEFING_TIMEZONE || 'Asia/Kolkata';

/** Calendar date in BRIEFING_TZ as YYYY-MM-DD. 'en-CA' formats in that order. */
function briefingDayKey(when = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIEFING_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(when);
}

/**
 * The session all of one day's briefings share. Deterministic rather than
 * random: every run on the same day resolves to the same id, so the second and
 * third briefings append to the morning's chat instead of opening a new one.
 * That is the whole fix for a sidebar with 96 "Daily News" entries in it.
 */
function briefingSessionId(userId, when = new Date()) {
  return `briefing_${userId}_${briefingDayKey(when)}`;
}

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
  const day = when.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: BRIEFING_TZ
  });
  return `📰 Daily News — ${day}`;
}

/**
 * Which of the day's three slots this run belongs to, by local hour in
 * BRIEFING_TZ. Boundaries are wide because a run starts when the cron fires and
 * finishes minutes later, and because a retry can land well outside its slot.
 */
function briefingSlotLabel(when = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: BRIEFING_TZ, hour: '2-digit', hour12: false
  }).format(when));
  if (hour < 12) return '🌅 Morning';
  if (hour < 18) return '☀️ Midday';
  return '🌙 Evening';
}

/**
 * Has this user had a briefing (or a briefing attempt) too recently to start
 * another? Returns a reason string to skip on, or null to proceed.
 *
 * Deliveries are counted from the notification, attempts from the execution
 * row, because a failed run now leaves no notification behind — counting only
 * deliveries would let a broken briefing retry on every single cron call, which
 * is precisely the loop that spent the token allowance.
 */
async function _recentlyRun(dbQuery, userId) {
  const delivered = await dbQuery(`
    SELECT created_at FROM notifications
    WHERE user_id = $1 AND type = 'briefing'
      AND created_at > now() - ($2 || ' hours')::interval
    ORDER BY created_at DESC LIMIT 1
  `, [userId, String(MIN_INTERVAL_HOURS)]);
  if (delivered.rows.length) {
    return `a briefing was already delivered at ${delivered.rows[0].created_at.toISOString()} ` +
      `(minimum ${MIN_INTERVAL_HOURS}h between briefings)`;
  }

  const attempted = await dbQuery(`
    SELECT created_at FROM executions
    WHERE conversation_id = $1
      AND created_at > now() - ($2 || ' minutes')::interval
    ORDER BY created_at DESC LIMIT 1
  `, [`briefing_${userId}`, String(RETRY_INTERVAL_MINUTES)]);
  if (attempted.rows.length) {
    return `a briefing was attempted at ${attempted.rows[0].created_at.toISOString()} and failed ` +
      `(waiting ${RETRY_INTERVAL_MINUTES}m before retrying)`;
  }

  return null;
}

/**
 * Produce one morning executive briefing for a user: run the agents, store the
 * result as a chat session, and notify. Routes through PlatoOrchestrator which
 * delegates to specialist agents with their tools.
 *
 * Skips quietly (rather than throwing) when one has run too recently — see
 * MIN_INTERVAL_HOURS. Pass `force: true` for the dashboard's "run one now"
 * button, where a person is explicitly asking for it.
 *
 * Throws on failure, including when the agents come back with placeholder prose
 * instead of a brief. Callers that fire-and-forget must catch — there is no
 * queue retrying behind this any more, so a failure is final until the next
 * scheduled trigger.
 */
async function runMorningBriefing({ userId = 'system', requestedAt = null, force = false } = {}) {
  console.log(`\n🌅 [MorningBriefing] Starting executive briefing for user "${userId}" (requested: ${requestedAt || 'scheduled'})...`);

  const start = Date.now();

  try {
    // Lazy-load to avoid circular dependency issues at startup
    const { route } = require('./agents/PlatoOrchestrator');
    const { query: dbQuery } = require('../database');

    if (!force) {
      const skip = await _recentlyRun(dbQuery, userId);
      if (skip) {
        console.log(`🌅 [MorningBriefing] Skipped for "${userId}": ${skip}`);
        return { success: true, skipped: true, reason: skip, userId };
      }
    }

    const result = await route({
      goal: BRIEFING_GOAL,
      userId,
      // Tag the execution so attempts are findable by _recentlyRun above, the
      // way mission runs are tagged `mission_<id>`. Without this the briefing's
      // executions land with a null conversation_id and a failed attempt is
      // indistinguishable from every other untagged run in the table.
      conversationId: `briefing_${userId}`,
      targetAgentId: 'plato', // Force Plato to orchestrate
      // The briefing goal requires 4+ tool calls across 3 domains (crypto,
      // stocks, search, paper) plus planning/synthesis reasoning turns — the
      // CognitiveCore default budget (60s / 5 tool calls / 8 iterations) is
      // sized for a single interactive chat turn and was reliably tripping
      // "Budget exceeded during plan execution" before the plan finished.
      // This runs in the background with no one waiting on a spinner, so a
      // larger budget is safe here without loosening the interactive default.
      //
      // The token ceiling was 15000 and that was not enough for this goal.
      // Missions run the same shape of work — research across several tools,
      // then synthesise — and MissionScheduler puts a 40000 FLOOR under them
      // precisely because the runs that succeed land at 25k–54k: every
      // reasoning turn re-sends the accumulated tool output, so the cost is
      // well past 15k before any prose is written. Briefings were breaching
      // mid-research and delivering "Budget exceeded during plan execution."
      // Matching the mission floor costs nothing now that the runaway schedule
      // is capped — one honest 40k run a day is far cheaper than the 96 doomed
      // ones it replaces.
      budget: { maxRuntimeSeconds: 420, maxToolCalls: 15, maxIterations: 14, maxTokens: 40000 }
    });

    const durationMs = Date.now() - start;
    const rawBriefing = result.cleanResponse || result.response || '';
    const briefingText = (typeof rawBriefing === 'string' ? rawBriefing : String(rawBriefing)).trim();

    // Did this run actually produce a briefing? Ask the execution row rather
    // than trusting the response string. CognitiveCore substitutes placeholder
    // prose on failure — "Budget exceeded during plan execution.", or the
    // "I am currently experiencing temporary high traffic…" inference apology —
    // and this function used to treat any string as the day's brief. That is
    // how the sidebar filled with "📰 Daily News" sessions whose entire content
    // was an apology, each one also ringing the notification bell.
    //
    // Fail loudly instead: no session, no title, no notification. The caller
    // logs it, the attempt is on the execution row, and the retry window above
    // keeps it from hammering the provider.
    let completionReason = null;
    if (result.executionId) {
      const execRow = await dbQuery(
        'SELECT completion_reason FROM executions WHERE execution_id = $1', [result.executionId]);
      completionReason = execRow.rows[0] && execRow.rows[0].completion_reason;
    }
    if (completionReason && FAILED_REASONS.has(completionReason)) {
      throw new Error(
        completionReason === 'budget_exceeded'
          ? 'ran out of tool-call/token budget before writing the briefing'
          : `the agent could not complete the briefing (${completionReason})`);
    }
    if (!briefingText) {
      throw new Error('the run finished but produced no briefing text');
    }

    console.log(`🌅 [MorningBriefing] Completed in ${durationMs}ms (${briefingText.length} chars)`);

    // Store briefing as a Plato turn in ai_conversations — this is the table
    // the Chat page actually reads (via /api/ai-chat/sessions + /history), not
    // the channel-based `messages` table. A prior version wrote to `messages`
    // with a `receiver_id` column that table doesn't have, so every briefing
    // insert silently failed and the bell notification always linked to a page
    // with nothing to show.
    // One session per day, shared by all of that day's runs — see
    // briefingSessionId. The conversation_id stays unique per turn; it is the
    // session_id that groups them into a single chat in the sidebar.
    const sessionId = briefingSessionId(userId);
    try {
      await dbQuery(`
        INSERT INTO ai_conversations (conversation_id, session_id, user_id, persona, role, content)
        VALUES ($1, $2, $3, $4, 'assistant', $5)
      `, [`conv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, sessionId, userId, 'plato', briefingText]);
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
      `, [sessionId, userId, briefingSessionTitle()]);
    } catch (titleErr) {
      // A missing title is cosmetic — never lose the briefing over it.
      console.warn(`⚠️ [MorningBriefing] Could not title briefing session: ${titleErr.message}`);
    }

    // Store notification so it shows on the notification bell (live via notification:new)
    // Full report as content: the bell preview truncates it for display, while
    // external channels (Telegram/email) deliver the whole briefing. Link deep-
    // links straight into the session created above so the briefing is visible
    // immediately instead of landing on Plato's default empty chat.
    // Title by slot rather than always "Morning": three of these land per day
    // now, and three identically-titled bell entries are as unreadable as the
    // three identically-titled sessions this change just merged.
    const { createNotification } = require('./notifications');
    await createNotification({
      userId,
      type: 'briefing',
      title: `${briefingSlotLabel()} Intelligence Brief`,
      content: briefingText,
      link: `finchat_chat.html?session=${sessionId}`
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
      sessionId,
      durationMs,
      executionId: result.executionId
    };

  } catch (err) {
    console.error(`❌ [MorningBriefing] Failed for user "${userId}":`, err.message);
    throw err;
  }
}

module.exports = {
  runMorningBriefing, briefingSessionTitle, briefingSlotLabel,
  briefingSessionId, briefingDayKey, BRIEFING_GOAL
};
