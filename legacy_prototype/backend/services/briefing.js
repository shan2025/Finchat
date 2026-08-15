// services/briefing.js — the morning executive briefing.
//
// This used to be a BullMQ job processor living in the worker pool. Nothing
// about producing a briefing needed a queue: it is one agent run, started by
// something external (the cron trigger at /api/cron/briefing, or a button on
// the dashboard), and the only thing the queue contributed was a Redis
// dependency that could take the whole server down when it ran out of quota.
// The schedule lives in the external cron service; this module just runs one.
const { eventBus } = require('./cognitive/EventBus');

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
 * Produce one morning executive briefing for a user: run the agents, store the
 * result as a chat session, and notify. Routes through PlatoOrchestrator which
 * delegates to specialist agents with their tools.
 *
 * Throws on failure. Callers that fire-and-forget must catch — there is no
 * queue retrying behind this any more, so a failure is final until the next
 * scheduled trigger.
 */
async function runMorningBriefing({ userId = 'system', requestedAt = null } = {}) {
  console.log(`\n🌅 [MorningBriefing] Starting executive briefing for user "${userId}" (requested: ${requestedAt || 'scheduled'})...`);

  const start = Date.now();

  try {
    // Lazy-load to avoid circular dependency issues at startup
    const { route } = require('./agents/PlatoOrchestrator');
    const { query: dbQuery } = require('../database');

    const result = await route({
      goal: BRIEFING_GOAL,
      userId,
      targetAgentId: 'plato', // Force Plato to orchestrate
      // The briefing goal requires 4+ tool calls across 3 domains (crypto,
      // stocks, search, paper) plus planning/synthesis reasoning turns — the
      // CognitiveCore default budget (60s / 5 tool calls / 8 iterations) is
      // sized for a single interactive chat turn and was reliably tripping
      // "Budget exceeded during plan execution" before the plan finished.
      // This runs in the background with no one waiting on a spinner, so a
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
    const { createNotification } = require('./notifications');
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
      sessionId: briefingSessionId,
      durationMs,
      executionId: result.executionId
    };

  } catch (err) {
    console.error(`❌ [MorningBriefing] Failed for user "${userId}":`, err.message);
    throw err;
  }
}

module.exports = { runMorningBriefing, briefingSessionTitle, BRIEFING_GOAL };
