/* eslint-disable camelcase */

// Feynman — the Explainer & Tutor.
//
// Every other agent on the roster produces analysis: a brief, a portfolio read,
// a shortlist, a diagnosis. None of them TEACHES. Asked "what is a looped
// transformer?" Nova writes a research brief; asked "what is a Sharpe ratio?"
// Atlas computes one. The user wanted the other thing — the practitioner's
// explainer that takes a hyped claim, shows the plain mechanism underneath,
// puts numbers on the trade-off and names where the idea came from.
//
// The live prompt is personas.js (the roster server.js also seeds the `users`
// identity row from — see migration 049's note). The short prompt below is only
// what the registry row carries.
//
// Tools are the reading set and nothing that touches the user's data or money:
//
//   paper/fetch   — the lesson's numbers come from the actual paper or report,
//                   not from memory. This is the whole credibility of the agent.
//   news/search   — for claims about releases and closed systems, which only
//                   exist as reporting.
//   wikipedia     — a definition cross-check (always available anyway).
//   youtube       — pointing the learner at a good lecture.
//
// Deliberately NOT granted: portfolio, analytics, stocks, crypto, mission. The
// tutor explains concepts; the user's own holdings are Atlas's and live market
// reads are Aurelius's, and the prompt hands those questions over rather than
// half-answering them.

const FEYNMAN_TOOLS = ['paper', 'fetch', 'search', 'news', 'wikipedia', 'youtube'];

// Substring-matched against the user's goal (AgentRegistry.scoreCapabilities),
// one point per match. Overlapping phrases are intentional: "explain it in
// simple terms" hits 'explain', 'simple terms' and 'in simple terms', so a
// question phrased as a request to be TAUGHT outranks Nova's one-word 'ai' and
// 'architecture' matches — and note 'ai' is a substring of 'explain', so every
// explain-question hands Nova a free point that this stacking has to beat.
// Broad openers like 'what is' / 'how does' are left out on purpose: "what is
// the BTC price" is a market question, not a lesson.
const FEYNMAN_CAPABILITIES = [
  'feynman',
  'explain', 'explain like', 'explain simply', 'eli5',
  'teach', 'teach me', 'tutor', 'lesson', 'learn',
  'simple terms', 'in simple terms', 'plain english',
  'help me understand', 'understand how', 'intuition',
  'break it down', 'break down', 'walk me through',
  'debunk', 'hype', 'overhyped', 'is it real',
  'concept', 'how it works'
];

// A lesson is one or two papers found, one or two pages read, then a long-form
// answer. Smaller than a diagnosis (049, 50k) and larger than a chat reply.
const FEYNMAN_BUDGET = {
  maxTokens: 35000, maxToolCalls: 8, maxIterations: 6, maxRuntimeSeconds: 200
};

const FEYNMAN_RUNTIME = {
  budget: FEYNMAN_BUDGET,
  // Low → temperature 0.3. The voice is conversational, but a lesson that gets
  // a parameter count wrong teaches the wrong thing; accuracy wins the knob.
  risk: 'Low',
  formal: 35, brief: 45, serious: 70
};

const FEYNMAN_PROMPT = `You are Feynman, FinChat's Explainer and Tutor for AI/LLM architecture, finance concepts and product management. You take a hyped claim or a hard idea, strip it to the plain mechanism, draw its shape, quantify the trade-off, trace where it came from, and say honestly what is not known. Specific numbers, papers and claims come only from sources read this turn, never from memory, and you never tell the user what to buy or sell.`;

exports.up = async (pgm) => {
  pgm.sql(`
    INSERT INTO agents (agent_id, name, type)
    VALUES ('feynman', 'Feynman', 'specialist')
    ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
  `);

  pgm.sql(`
    INSERT INTO agent_configs (
      agent_id, system_prompt, capabilities, tools,
      is_direct_addressable, memory_namespace, color, runtime_settings)
    VALUES (
      'feynman',
      '${FEYNMAN_PROMPT.replace(/'/g, "''")}',
      '${JSON.stringify(FEYNMAN_CAPABILITIES)}'::jsonb,
      '${JSON.stringify(FEYNMAN_TOOLS)}'::jsonb,
      1,
      'feynman::lessons',
      '#e8b86d',
      '${JSON.stringify(FEYNMAN_RUNTIME)}'::jsonb)
    ON CONFLICT (agent_id) DO UPDATE SET
      system_prompt = EXCLUDED.system_prompt,
      capabilities  = EXCLUDED.capabilities,
      tools         = EXCLUDED.tools,
      is_direct_addressable = EXCLUDED.is_direct_addressable,
      memory_namespace = EXCLUDED.memory_namespace,
      color = EXCLUDED.color,
      runtime_settings = EXCLUDED.runtime_settings;
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`DELETE FROM agent_configs WHERE agent_id = 'feynman'`);
  pgm.sql(`DELETE FROM agents WHERE agent_id = 'feynman'`);
};
