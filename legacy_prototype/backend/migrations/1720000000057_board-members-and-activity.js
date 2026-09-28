/* eslint-disable camelcase */

// Boards become shared workspaces.
//
// 1. MEMBERS. The owner can give other FinChat users edit access — by email or
//    username, or by an edit link they open while signed in. Editors change
//    cards, columns and files like the owner; only the owner deletes the board
//    or manages who has access. `role` is kept as a column (not a boolean) so a
//    later "commenter" or "viewer" role is a value, not a migration.
//
// 2. ACTIVITY. Every change is one row: who, what, when, plus the before/after
//    in `details`. It is what the History panel reads ("Shadin moved 'Hire 2
//    baristas' from To do to Doing"). user_id is SET NULL on delete so a
//    departed user's history stays readable.
//
// 3. LINK ROLE. A share link is 'view' (anyone, no login — as before) or
//    'edit' (a signed-in FinChat user who opens it joins as an editor).
//
// RLS on, no policies, as for every table since 056.

exports.up = async (pgm) => {
  pgm.createTable('board_members', {
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    user_id: { type: 'text', notNull: true, references: '"users"', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true, default: 'editor' },
    added_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('board_members', 'board_members_pkey', { primaryKey: ['board_id', 'user_id'] });
  pgm.addConstraint('board_members', 'board_members_role_check', { check: "role IN ('editor')" });
  pgm.createIndex('board_members', ['user_id']);

  pgm.createTable('board_activity', {
    activity_id: { type: 'text', primaryKey: true },
    board_id: { type: 'text', notNull: true, references: '"boards"', onDelete: 'CASCADE' },
    user_id: { type: 'text', references: '"users"', onDelete: 'SET NULL' },
    action: { type: 'text', notNull: true },
    summary: { type: 'text', notNull: true, default: '' },
    details: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('board_activity', ['board_id', { name: 'created_at', sort: 'DESC' }]);

  pgm.addColumns('board_shares', {
    role: { type: 'text', notNull: true, default: 'view' }
  });
  pgm.addConstraint('board_shares', 'board_shares_role_check', { check: "role IN ('view', 'edit')" });

  for (const t of ['board_members', 'board_activity']) {
    pgm.sql(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }
};

exports.down = async (pgm) => {
  pgm.dropConstraint('board_shares', 'board_shares_role_check');
  pgm.dropColumns('board_shares', ['role']);
  pgm.dropTable('board_activity');
  pgm.dropTable('board_members');
};
