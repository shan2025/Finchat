// services/agents/MemoryAgent.js — Thick Agent for Memory Retrieval & Synthesis
const { BaseAgent } = require('./BaseAgent');
const memoryService = require('../cognitive/MemoryService');

/**
 * MemoryAgent acts as the Librarian and Knowledge Synthesizer of FinChat.
 * It manages Working, Episodic, Long-Term, Procedural, and Semantic memory layers.
 */
class MemoryAgent extends BaseAgent {
  constructor(config) {
    super(config || {
      agentId: 'memory',
      name: 'Memory Agent',
      type: 'specialist',
      systemPrompt: 'You are the Memory Agent, the Librarian and Knowledge Synthesizer of FinChat. You connect dots across time by retrieving episodic histories, semantic vector embeddings, and learned procedural workflows.',
      capabilities: ['memory', 'recall', 'history', 'remember', 'context', 'summarize_past'],
      tools: [],
      isDirectAddressable: true,
      memoryNamespace: 'memory::longterm'
    });
  }

  /**
   * Recall episodic history (past executions and outcomes).
   */
  async recallEpisodic({ userId, agentId, limit = 5 }) {
    return await memoryService.retrieveEpisodicHistory({ userId, agentId, limit });
  }

  /**
   * Recall semantic knowledge by vector similarity.
   */
  async recallSemantic({ queryText, limit = 3 }) {
    return await memoryService.retrieveBySimilarity(queryText, limit);
  }

  /**
   * Recall procedural workflows learned for a specific agent.
   */
  async recallProcedural({ agentId, limit = 5 }) {
    return await memoryService.retrieveProceduralWorkflows({ agentId, limit });
  }

  /**
   * Store a learned procedural workflow into memories table (`memory_type = 'procedural'`).
   */
  async storeProcedural({ agentId, workflowName, steps, importance = 8 }) {
    return await memoryService.store({
      userId: agentId || 'global',
      memoryType: 'procedural',
      content: `Workflow [${workflowName}]: ${Array.isArray(steps) ? steps.join(' -> ') : steps}`,
      metadata: { agentId: agentId || 'global', workflowName, steps },
      importance
    });
  }

  /**
   * Synthesize user history and relevant knowledge for a given goal.
   */
  async synthesizeHistory({ userId, goal, agentName = null }) {
    const episodic = await this.recallEpisodic({ userId, limit: 3 });
    const semantic = await this.recallSemantic({ queryText: goal, limit: 2 });
    const procedural = agentName ? await this.recallProcedural({ agentId: agentName, limit: 2 }) : [];

    return {
      episodicCount: episodic.length,
      semanticCount: semantic.length,
      proceduralCount: procedural.length,
      episodicSummary: episodic.map(e => `[${e.created_at || 'past'}] Goal: ${e.goal} => Result: ${typeof e.result === 'object' ? JSON.stringify(e.result) : e.result}`).join('\n'),
      semanticSummary: semantic.map(s => `[${s.title}]: ${s.content.substring(0, 150)}...`).join('\n'),
      proceduralSummary: procedural.map(p => p.content).join('\n')
    };
  }
}

module.exports = { MemoryAgent };
