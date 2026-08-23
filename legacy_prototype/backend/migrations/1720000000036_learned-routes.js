/* eslint-disable camelcase */

// Learned route optimization — the map learns which district-to-district
// transitions reliably co-produce verified answers, and paves a shortcut.
//
// The prior rung (competitive route adaptation) scored districts in isolation:
// "Research yields 82% verified for this task". This table is about the missing
// object — the TRANSITION. `markets -> filings` can be productive as a sequence
// even if `filings` alone looks mediocre, and that ordering is expensive to
// rediscover from scratch, so it is worth persisting.
//
// One directed edge per (task_type, from_district, to_district). `weight` is an
// exponential-moving reinforcement in 0..1, raised when a run that traversed the
// edge verified and decayed over time so unused roads fade rather than staying
// paved forever. `traversals`/`verified` are the raw counters the weight is
// derived from — kept so the whole table can be REBUILT deterministically from
// execution history (it is a cache of a learnable function, never ground truth).
//
// Global only by design (user's call): one shared map, no user_id. The nightly
// cron reinforcement pass (routes/cron.js -> /route-learning) is the only writer.

exports.up = async (pgm) => {
  pgm.createTable('learned_routes', {
    task_type: { type: 'text', notNull: true },
    from_district: { type: 'text', notNull: true },
    to_district: { type: 'text', notNull: true },
    weight: { type: 'real', notNull: true, default: 0 },
    traversals: { type: 'integer', notNull: true, default: 0 },
    verified: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  }, {
    constraints: { primaryKey: ['task_type', 'from_district', 'to_district'] }
  });

  // Routing reads all edges for one task type on a decision; index that lookup.
  pgm.createIndex('learned_routes', ['task_type', 'from_district']);
};

exports.down = async (pgm) => {
  pgm.dropTable('learned_routes');
};
