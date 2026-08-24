/* eslint-disable camelcase */

// RLS on the three tables migration 037 added.
//
// Same posture as migrations 023 and 024: row level security ON with NO
// policies. That denies Supabase's anon/authenticated roles outright — and
// PostgREST exposes every table in `public` to them by default — while the
// backend connects as the owner, bypasses RLS, and enforces ownership in the
// route and tool layer, which is where it already lives.
//
// This belongs with 037 and is separate only because 037 is already applied.
// These three carry the most sensitive data in the schema: a resume, a record
// of every job the user is chasing, and the size of their positions.

const TABLES = ['user_resumes', 'job_applications', 'portfolio_holdings'];

exports.up = async (pgm) => {
  for (const t of TABLES) {
    pgm.sql(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  }
};

exports.down = async (pgm) => {
  for (const t of TABLES) {
    pgm.sql(`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`);
  }
};
