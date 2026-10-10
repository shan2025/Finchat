/* eslint-disable camelcase */

// The RAG store (`knowledge` + `knowledge_embeddings`) becomes per-user.
//
// It was created as a shared library, but its only live writer is
// ReflectionEngine, which stores "Execution Summary: <the user's goal>" plus
// what the run learned. That is one user's data, yet every account counted
// every row on the Knowledge page and similarity recall could hand one user's
// summaries to another.
//
// knowledge.user_id owns the row; knowledge_embeddings stays as it is and is
// scoped through its knowledge row. NULL means "no owner" and is never
// returned to anyone — rows the backfill cannot attribute (test-script
// inserts, runs with no real user behind them) go dark rather than staying
// visible to everybody.
//
// Backfill: ReflectionEngine inserts the reflection, then embeds the summary,
// so each reflection_engine row has a reflection from the same execution a few
// seconds before it, and its title is that execution's goal cut to 100 chars.
// A row is attributed only when every match points at the same real user, so
// two people asking the same question at the same moment leave it unowned
// instead of handing it to the wrong one.
//
// DEPLOY ORDER: run this before pushing the code that uses it. The new code
// writes knowledge.user_id; until the column exists those inserts fail (logged
// by ReflectionEngine, not fatal) and recall returns nothing.

exports.up = async (pgm) => {
  pgm.addColumns('knowledge', {
    user_id: { type: 'text', references: '"users"', onDelete: 'CASCADE' }
  });
  pgm.createIndex('knowledge', ['user_id', 'created_at'], { name: 'knowledge_by_user' });

  pgm.sql(`
    UPDATE knowledge k
       SET user_id = m.user_id
      FROM (
        SELECT k2.knowledge_id, MIN(e.user_id) AS user_id
          FROM knowledge k2
          JOIN executions e
            ON k2.title = 'Execution Summary: ' || LEFT(e.goal, 100)
          JOIN reflections r
            ON r.execution_id = e.execution_id
           AND r.created_at BETWEEN k2.created_at - INTERVAL '5 minutes'
                                AND k2.created_at + INTERVAL '5 seconds'
          JOIN users u ON u.user_id = e.user_id
         WHERE k2.source = 'reflection_engine'
           AND k2.user_id IS NULL
         GROUP BY k2.knowledge_id
        HAVING COUNT(DISTINCT e.user_id) = 1
      ) m
     WHERE k.knowledge_id = m.knowledge_id
  `);
};

exports.down = async (pgm) => {
  pgm.dropIndex('knowledge', [], { name: 'knowledge_by_user' });
  pgm.dropColumns('knowledge', ['user_id']);
};
