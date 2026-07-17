/* eslint-disable camelcase */

exports.up = async (pgm) => {
  // Add new columns to agent_configs per Sprint 2 Phase 1 spec
  pgm.addColumns('agent_configs', {
    tools: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    is_direct_addressable: { type: 'integer', notNull: true, default: 1 },
    memory_namespace: { type: 'text' }
  });

  // Insert base agents if they don't exist
  const agents = [
    { id: 'plato', name: 'Plato', type: 'orchestrator' },
    { id: 'aurelius', name: 'Aurelius', type: 'specialist' },
    { id: 'rasha', name: 'Rasha', type: 'specialist' },
    { id: 'nova', name: 'Nova', type: 'specialist' },
    { id: 'sentinel', name: 'Sentinel', type: 'middleware' },
    { id: 'memory', name: 'Memory Agent', type: 'specialist' }
  ];

  for (const a of agents) {
    pgm.sql(`
      INSERT INTO agents (agent_id, name, type)
      VALUES ('${a.id}', '${a.name}', '${a.type}')
      ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type;
    `);
  }

  // Seed agent_configs with rich capabilities, tool manifests, memory namespaces, and system prompts
  const configs = [
    {
      id: 'plato',
      prompt: 'You are Plato, the Chief AI Officer and Meta-Orchestrator of FinChat. Your job is to understand user intent, delegate specialized domain tasks to Aurelius (Finance), Rasha (Career), or Nova (Research), and synthesize their outputs. You oversee global governance.',
      capabilities: JSON.stringify(['orchestration', 'meta_reasoning', 'delegation', 'general', 'fallback']),
      tools: JSON.stringify(['search']),
      is_direct: 1,
      namespace: 'plato::global'
    },
    {
      id: 'aurelius',
      prompt: 'You are Aurelius, the Finance & Investment Strategist. You specialize in quantitative portfolio analysis, live market ticker evaluation, cryptocurrency and DeFi protocols, and macroeconomic trend forecasting. Always ground your analysis in verified market data when available.',
      capabilities: JSON.stringify(['stock', 'stocks', 'invest', 'investment', 'portfolio', 'crypto', 'bitcoin', 'ethereum', 'defi', 'blockchain', 'startup', 'seed', 'venture', 'ipo', 'market', 'trading', 'finance', 'financial', 'ticker', 'price', 'tsla', 'aapl', 'googl', 'msft', 'amzn']),
      tools: JSON.stringify(['stocks', 'search', 'crypto']),
      is_direct: 1,
      namespace: 'aurelius::finance'
    },
    {
      id: 'rasha',
      prompt: 'You are Rasha, the Executive Career Strategist. You provide honest, data-driven career feedback, resume optimization, salary negotiation tactics, interview prep, and executive branding guidance. Be direct, constructive, and actionable.',
      capabilities: JSON.stringify(['resume', 'cv', 'job', 'jobs', 'career', 'hiring', 'interview', 'cover letter', 'application', 'apply', 'skills', 'salary', 'linkedin', 'recruiter', 'employment', 'work experience', 'portfolio review']),
      tools: JSON.stringify(['search', 'resume']),
      is_direct: 1,
      namespace: 'rasha::career'
    },
    {
      id: 'nova',
      prompt: 'You are Nova, the Frontier Science & Technology Researcher. You specialize in neuroscience, neuromorphic computing, artificial intelligence, cryptographic protocols, and academic paper synthesis. Always cite scientific rigor and structural detail.',
      capabilities: JSON.stringify(['research', 'neuroscience', 'neural', 'brain', 'ai', 'artificial intelligence', 'machine learning', 'neurocomputation', 'neuromorphic', 'cognitive science', 'paper', 'papers', 'scientific', 'study', 'studies', 'fintech', 'protocol', 'cryptography', 'architecture']),
      tools: JSON.stringify(['search', 'paper']),
      is_direct: 1,
      namespace: 'nova::research'
    },
    {
      id: 'sentinel',
      prompt: 'You are Sentinel, the cross-cutting Compliance and Governance Watchdog of FinChat. You monitor all agent executions for security indicators, credential theft, extreme fraud patterns, and token budget ceiling breaches. You anchor auditable proof traces to the blockchain ledger.',
      capabilities: JSON.stringify(['governance', 'audit', 'compliance', 'fraud', 'security', 'ledger']),
      tools: JSON.stringify([]),
      is_direct: 0, // Middleware agent — not directly addressable by users
      namespace: 'sentinel::audit'
    },
    {
      id: 'memory',
      prompt: 'You are the Memory Agent, the Librarian and Knowledge Synthesizer of FinChat. You connect dots across time by retrieving episodic histories, semantic vector embeddings, and learned procedural workflows.',
      capabilities: JSON.stringify(['memory', 'recall', 'history', 'remember', 'context', 'summarize_past']),
      tools: JSON.stringify([]),
      is_direct: 1,
      namespace: 'memory::longterm'
    }
  ];

  for (const c of configs) {
    pgm.sql(`
      INSERT INTO agent_configs (agent_id, system_prompt, capabilities, tools, is_direct_addressable, memory_namespace)
      VALUES ('${c.id}', '${c.prompt.replace(/'/g, "''")}', '${c.capabilities}'::jsonb, '${c.tools}'::jsonb, ${c.is_direct}, '${c.namespace}')
      ON CONFLICT (agent_id) DO UPDATE SET
        system_prompt = EXCLUDED.system_prompt,
        capabilities = EXCLUDED.capabilities,
        tools = EXCLUDED.tools,
        is_direct_addressable = EXCLUDED.is_direct_addressable,
        memory_namespace = EXCLUDED.memory_namespace;
    `);
  }
};

exports.down = async (pgm) => {
  pgm.dropColumns('agent_configs', ['tools', 'is_direct_addressable', 'memory_namespace']);
};
