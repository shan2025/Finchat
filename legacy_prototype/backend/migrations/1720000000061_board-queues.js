/* eslint-disable camelcase */

// Queues: a board whose columns are people and whose card ORDER is the order
// of work — the first card in a lane is what that person does now, the second
// is next, and so on.
//
// 1. KIND. boards.kind says how a board is drawn and what its order means:
//    'kanban' (columns are stages, as before) or 'queue' (columns are lanes,
//    one per person or team, read front to back). Everything around the
//    content — members, History, files, share links, Ask AI — is the board's
//    and works unchanged for both.
//
// 2. DONE. A queue pops its front task when it is finished. done_at keeps the
//    card (and its files) rather than deleting it, so the lane's Done list can
//    put it back and History can still open it. NULL = still queued. Kanban
//    boards never set it (services/boards.js refuses).

exports.up = async (pgm) => {
  pgm.addColumns('boards', {
    kind: { type: 'text', notNull: true, default: 'kanban' }
  });
  pgm.addConstraint('boards', 'boards_kind_check', { check: "kind IN ('kanban', 'queue')" });
  pgm.addColumns('board_cards', {
    done_at: { type: 'timestamptz' }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('board_cards', ['done_at']);
  pgm.dropConstraint('boards', 'boards_kind_check');
  pgm.dropColumns('boards', ['kind']);
};
