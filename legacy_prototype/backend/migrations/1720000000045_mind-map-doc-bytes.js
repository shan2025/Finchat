/* eslint-disable camelcase */

// Mind-map originals move off the disk and into the row, for the same reason
// chat images did in migration 043: Render's filesystem is ephemeral. Every
// deploy and every cold start wipes backend/uploads/, so "Open original" was a
// button that worked until the next push and then answered 410 forever after —
// while the row it belonged to still sat in the library looking healthy.
//
// The extracted TEXT was never at risk (it has always been a column here), so
// what this recovers is the human's ability to check the AI's reading against
// the source. That is the whole point of showing a source list.
//
// `stored_name` is kept, not dropped: rows written before this migration still
// point at a disk file, and on a machine that has not redeployed those bytes
// are still there. The serving route prefers `data` and falls back to disk, so
// old rows degrade rather than break.
//
// Size is bounded by multer (15MB) and further by MIND_MAP_DOC_DB_MAX_BYTES in
// the route — a document too big for the row keeps its text and loses only its
// original, which is the same deal it had before, not a regression.

exports.up = async (pgm) => {
  pgm.addColumn('mind_map_docs', {
    data: { type: 'bytea' }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumn('mind_map_docs', 'data');
};
