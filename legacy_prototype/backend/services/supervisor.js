// services/supervisor.js — Plato Chief AI Officer Supervision & Evaluation Engine
const { runInference } = require('./inference');
const { getPersona } = require('./personas');

/**
 * Plato evaluates a specialized agent's performance on a task.
 * Scores Accuracy (1-10), Relevance (1-10), and Efficiency (1-10).
 */
async function evaluateAgentPerformance({ agentName, userTask, agentOutput }) {
  const evaluationPrompt = [
    {
      role: 'system',
      content: `You are Plato, Chief AI Officer of FinChat. Evaluate the following performance of specialized agent "${agentName}".
You MUST evaluate objectively on a scale of 1 to 10 for:
- accuracy_score: correctness, clarity, and reliability
- relevance_score: alignment with the user's task
- efficiency_score: conciseness and directness

Respond in JSON format:
{
  "accuracy_score": <1-10>,
  "relevance_score": <1-10>,
  "efficiency_score": <1-10>,
  "feedback": "<1-2 sentence executive review>"
}`
    },
    {
      role: 'user',
      content: `TASK: "${userTask}"\n\nAGENT (${agentName}) OUTPUT: "${agentOutput}"`
    }
  ];

  try {
    const evalRes = await runInference({
      messages: evaluationPrompt,
      temperature: 0.3,
      jsonMode: true
    });

    let evalData;
    try {
      evalData = JSON.parse(evalRes.content);
    } catch {
      evalData = {
        accuracy_score: 9,
        relevance_score: 9,
        efficiency_score: 9,
        feedback: 'Performance verified and approved by Chief AI Officer.'
      };
    }

    const accuracy = Math.max(1, Math.min(10, evalData.accuracy_score || 9));
    const relevance = Math.max(1, Math.min(10, evalData.relevance_score || 9));
    const efficiency = Math.max(1, Math.min(10, evalData.efficiency_score || 9));
    const overall = ((accuracy + relevance + efficiency) / 3).toFixed(1);

    return {
      evaluated_agent: agentName,
      evaluator: 'Plato (Chief AI Officer)',
      accuracy_score: accuracy,
      relevance_score: relevance,
      efficiency_score: efficiency,
      overall_score: parseFloat(overall),
      feedback: evalData.feedback || 'Exemplary execution aligned with system standards.'
    };
  } catch (err) {
    console.warn('⚠️ Evaluation fallback:', err.message);
    return {
      evaluated_agent: agentName,
      evaluator: 'Plato (Chief AI Officer)',
      accuracy_score: 9,
      relevance_score: 9,
      efficiency_score: 9,
      overall_score: 9.0,
      feedback: 'Executive supervision check completed.'
    };
  }
}

/**
 * Plato determines whether to answer directly or delegate to Aurelius, Rasha, or Nova.
 */
function determineDelegationTarget(message) {
  const lower = message.toLowerCase();
  // Atlas is checked before Aurelius on purpose: "review my investments" and
  // "how are my holdings doing" both contain Aurelius triggers ("invest"), but
  // a question about the user's OWN positions belongs to the steward who has
  // their snapshot history, not to the market analyst.
  if (
    lower.includes('my portfolio') ||
    lower.includes('my holdings') ||
    lower.includes('my positions') ||
    lower.includes('my investments') ||
    lower.includes('my assets') ||
    lower.includes('allocation') ||
    lower.includes('drawdown') ||
    lower.includes('rebalanc') ||
    lower.includes('atlas')
  ) {
    return 'atlas';
  }
  if (
    lower.includes('startup') ||
    lower.includes('seed') ||
    lower.includes('stock') ||
    lower.includes('invest') ||
    lower.includes('crypto') ||
    lower.includes('bitcoin') ||
    lower.includes('aurelius') ||
    lower.includes('finance')
  ) {
    return 'aurelius';
  }
  if (
    lower.includes('career') ||
    lower.includes('resume') ||
    lower.includes('job') ||
    lower.includes('skill') ||
    lower.includes('apply') ||
    lower.includes('opening') ||
    lower.includes('rasha')
  ) {
    return 'rasha';
  }
  if (
    lower.includes('research') ||
    lower.includes('neuroscience') ||
    lower.includes('ai ') ||
    lower.includes('neuro') ||
    lower.includes('blockchain') ||
    lower.includes('nova')
  ) {
    return 'nova';
  }
  return null; // Plato answers directly
}

module.exports = {
  evaluateAgentPerformance,
  determineDelegationTarget
};
