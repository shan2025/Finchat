/* eslint-disable camelcase */

// Give the knowledge graph an owner.
//
// `entities` had no user_id at all, so every account shared one pool (538 rows
// across 27 users in production). That made the neural map identical for every
// user — the thing it derives from was global — and it leaked chat-derived topics
// between accounts via the map, knowledge search and agent memory retrieval.
//
// `entity_edges` and `node_events` already carry user_id, so ownership can be
// recovered for most rows. node_events is by far the better signal here: 3,176
// rows carry a user against 14 usable edges, attributing ~360 of 538 entities.
//
// Rows we cannot attribute keep user_id NULL. NULL means "legacy, owner unknown"
// and readers must treat it as hidden from everyone rather than shared with
// everyone — an unattributable entity is exactly the leak we are closing.

exports.up = async (pgm) => {
  pgm.addColumn('entities', {
    user_id: { type: 'text' } // nullable: NULL = legacy/unattributable, hidden from all users
  });

  // ── backfill: majority owner from node_events, then entity_edges ──────────
  // Only consider user_ids that still exist in `users`, so the FK below holds.
  // NOTE: pgm.sql() queues in order with the other pgm.* operations above.
  // pgm.db.query() would fire immediately, before addColumn has run.
  pgm.sql(`
    WITH event_owner AS (
      SELECT entity_id, user_id,
             ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY COUNT(*) DESC, user_id) AS rn
      FROM node_events
      WHERE user_id IS NOT NULL
        AND user_id IN (SELECT user_id FROM users)
      GROUP BY entity_id, user_id
    )
    UPDATE entities e
    SET user_id = o.user_id
    FROM event_owner o
    WHERE o.entity_id = e.entity_id AND o.rn = 1 AND e.user_id IS NULL
  `);

  pgm.sql(`
    WITH edge_owner AS (
      SELECT ent.entity_id, ee.user_id,
             ROW_NUMBER() OVER (PARTITION BY ent.entity_id ORDER BY COUNT(*) DESC, ee.user_id) AS rn
      FROM entities ent
      JOIN entity_edges ee
        ON ee.from_entity_id = ent.entity_id OR ee.to_entity_id = ent.entity_id
      WHERE ee.user_id IS NOT NULL
        AND ee.user_id IN (SELECT user_id FROM users)
      GROUP BY ent.entity_id, ee.user_id
    )
    UPDATE entities e
    SET user_id = o.user_id
    FROM edge_owner o
    WHERE o.entity_id = e.entity_id AND o.rn = 1 AND e.user_id IS NULL
  `);

  pgm.addConstraint('entities', 'entities_user_id_fkey', {
    foreignKeys: { columns: 'user_id', references: 'users(user_id)', onDelete: 'CASCADE' }
  });
  pgm.createIndex('entities', ['user_id']);

  // ── de-duplication is now per user ───────────────────────────────────────
  // The old global UNIQUE(canonical_name, entity_type) meant two users could not
  // each have their own "Bitcoin" node — the second would collide into the first,
  // which is how the graph became shared in the first place. Postgres treats NULLs
  // as distinct, so legacy rows never collide with owned ones.
  pgm.dropConstraint('entities', 'entities_canonical_type_unique');
  pgm.addConstraint('entities', 'entities_user_canonical_type_unique', {
    unique: ['user_id', 'canonical_name', 'entity_type']
  });
};

exports.down = async (pgm) => {
  pgm.dropConstraint('entities', 'entities_user_canonical_type_unique');
  // Restoring the global unique constraint can fail if per-user duplicates exist
  // by then (two users with the same topic). Collapse them to the oldest row first.
  pgm.sql(`
    DELETE FROM entities a
    USING entities b
    WHERE a.canonical_name = b.canonical_name
      AND a.entity_type = b.entity_type
      AND a.created_at > b.created_at
  `);
  pgm.addConstraint('entities', 'entities_canonical_type_unique', {
    unique: ['canonical_name', 'entity_type']
  });
  pgm.dropIndex('entities', ['user_id']);
  pgm.dropConstraint('entities', 'entities_user_id_fkey');
  pgm.dropColumn('entities', 'user_id');
};
