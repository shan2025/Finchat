/* eslint-disable camelcase */
const embeddingsConfig = require('../config/embeddings');

exports.up = (pgm) => {
  // memories table (Episodic / semantic / procedural memory)
  pgm.createTable('memories', {
    memory_id: { type: 'text', primaryKey: true },
    user_id: { type: 'text', notNull: true, references: '"users"' },
    memory_type: { type: 'text', notNull: true }, // episodic | semantic | procedural
    content: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
    importance: { type: 'integer', notNull: true, default: 5 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // knowledge table
  pgm.createTable('knowledge', {
    knowledge_id: { type: 'text', primaryKey: true },
    title: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    source: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // knowledge_embeddings table (Decision #9: reads vector dimension from config/embeddings.js -> 768)
  const dim = embeddingsConfig.dimension || 768;
  pgm.createTable('knowledge_embeddings', {
    embedding_id: { type: 'text', primaryKey: true },
    knowledge_id: { type: 'text', notNull: true, references: '"knowledge"', onDelete: 'CASCADE' },
    embedding: { type: `vector(${dim})` },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // reflections table (Decision #6: async best-effort learnings stored here)
  pgm.createTable('reflections', {
    reflection_id: { type: 'text', primaryKey: true },
    execution_id: { type: 'text', notNull: true, references: '"executions"', onDelete: 'CASCADE' },
    summary: { type: 'text', notNull: true },
    learnings: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = (pgm) => {
  pgm.dropTable('reflections');
  pgm.dropTable('knowledge_embeddings');
  pgm.dropTable('knowledge');
  pgm.dropTable('memories');
};
