/* eslint-disable camelcase */

// Sprint Z · Track B — Study Mode persistence
//
// The composer's STUDY toggle is a per-conversation property, not a per-browser
// one: reopening a study chat on another device should still come back as cards.
// ai_session_meta already carries the per-session user-owned extras (custom
// title, soft-delete), so the flag belongs there rather than in a new table.
//
// Note on numbering: Track B ships before the Mind Map Studio, so it takes 022
// and the mind_maps migration becomes 023.

exports.up = async (pgm) => {
  pgm.addColumns('ai_session_meta', {
    study_mode: { type: 'boolean', notNull: true, default: false }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('ai_session_meta', ['study_mode']);
};
