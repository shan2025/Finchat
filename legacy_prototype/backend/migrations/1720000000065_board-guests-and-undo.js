/* eslint-disable camelcase */

// Edit links work without an account, and any change can be undone.
//
// 1. GUESTS. Someone who opens an EDIT link edits straight away, signed in or
//    not. Their browser gets a guest row on that board: a number ("Guest 2"),
//    an optional name they type themselves, and the hash of a random key the
//    browser keeps — so the same person stays the same guest on every visit.
//    The link is still the permission: turn it off and every guest on it is out.
//    `number` stays NULL until their first change, so people who only look
//    do not use up numbers — Guest 1, 2, 3 are the people who edited.
//
// 2. UNDO. Every change records what it replaced in board_activity.undo (the
//    fields before and after, the positions before and after, or a pointer to
//    the trash). Reverting a change puts the "before" back only where the
//    board still shows that change's "after" — whatever someone did since is
//    kept. reverted_at / reverted_by mark a change already undone.
//
// 3. TRASH. A deleted card, lane or file is copied here first (the row as
//    jsonb, files included), so undoing the delete brings it all back.
//
// RLS on, no policies, as for every table since 056.

exports.up = async (pgm) => {
  pgm.createTable('board_guests', {
    guest_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    share_id: { type: 'text', references: '"board_shares"', onDelete: 'SET NULL' },
    number: { type: 'integer' },
    name: { type: 'text', notNull: true, default: '' },
    key_hash: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('board_guests', 'board_guests_number_unique', { unique: ['board_id', 'number'] });

  pgm.addColumns('board_activity', {
    guest_id: { type: 'text', references: '"board_guests"', onDelete: 'SET NULL' },
    undo: { type: 'jsonb' },
    reverted_at: { type: 'timestamptz' },
    reverted_by: { type: 'text' }
  });
  pgm.createIndex('board_activity', ['guest_id']);

  pgm.createTable('board_trash', {
    trash_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    activity_id: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },          // column | card | attachment
    payload: { type: 'jsonb', notNull: true },      // to_jsonb(row)
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('board_trash', 'board_trash_kind_check', { check: "kind IN ('column', 'card', 'attachment')" });
  pgm.createIndex('board_trash', ['activity_id']);

  for (const t of ['board_guests', 'board_trash']) {
    pgm.sql(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }
};

exports.down = async (pgm) => {
  pgm.dropTable('board_trash');
  pgm.dropIndex('board_activity', ['guest_id']);
  pgm.dropColumns('board_activity', ['guest_id', 'undo', 'reverted_at', 'reverted_by']);
  pgm.dropTable('board_guests');
};
