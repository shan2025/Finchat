/* eslint-disable camelcase */

// P0-1 (docs/SECURITY_FOUNDATION_GAP_ANALYSIS.md) — revoke host-access tools
// from every agent except the explicit admin agent.
//
// `bash`, `file_write` and `file_edit` reach the host directly: BashTool calls
// child_process.exec with only a timeout and a buffer cap, and the file tools
// operate on the real filesystem. Any agent holding them effectively holds a
// host shell, so a prompt injection arriving through CrawlTool/FetchTool output
// only has to persuade the model to emit one tool action.
//
// Until now `tool_permissions` was EMPTY. Access was decided solely by a
// hardcoded `agentId !== 'plato'` test in ToolManager.checkPermission(), and
// plato reached the tools through the "no row = allowed" default rather than
// through any recorded grant. Nothing was written down, so nothing could be
// audited or revoked without a code change.
//
// This migration writes the grants down explicitly:
//   plato  -> allowed = 1   (the admin agent)
//   others -> allowed = 0   (explicit denial, not merely an absent row)
//
// The companion change in ToolManager makes these three tools deny-by-default,
// so an agent added *after* this migration gets no host access until somebody
// inserts a row for it on purpose. ADMIN_AGENT_ID there must match the admin
// agent chosen here.
//
// The unique constraint is part of the fix, not housekeeping: checkPermission
// reads `res.rows[0].allowed`, so without it two contradictory rows for the
// same (agent, tool) would make a security decision depend on row order.
//
// Deliberately NOT covered: `file_read` and `glob`. They are read-only, glob is
// in live use, and widening the revocation past the P0-1 scope would break
// working behaviour for no confidentiality gain. Containerisation is a separate
// piece of work — this migration reduces who can reach the host, it does not
// make reaching the host safe.

const HOST_ACCESS_TOOLS = ['bash', 'file_write', 'file_edit'];
const ADMIN_AGENT_ID = 'plato';

exports.up = async (pgm) => {
  // Single-valued permissions, so rows[0] is the only row.
  pgm.addConstraint('tool_permissions', 'tool_permissions_agent_tool_unique', {
    unique: ['agent_id', 'tool_name']
  });

  // Deterministic permission_id keeps this idempotent and makes the row easy to
  // find when revoking by hand later.
  pgm.sql(`
    INSERT INTO tool_permissions (permission_id, agent_id, tool_name, allowed)
    SELECT 'perm_' || a.agent_id || '_' || t.tool_name,
           a.agent_id,
           t.tool_name,
           CASE WHEN a.agent_id = '${ADMIN_AGENT_ID}' THEN 1 ELSE 0 END
      FROM agents a
      CROSS JOIN (VALUES ${HOST_ACCESS_TOOLS.map(t => `('${t}')`).join(', ')}) AS t(tool_name)
    ON CONFLICT (agent_id, tool_name)
    DO UPDATE SET allowed = EXCLUDED.allowed
  `);
};

exports.down = async (pgm) => {
  pgm.sql(`
    DELETE FROM tool_permissions
     WHERE tool_name IN (${HOST_ACCESS_TOOLS.map(t => `'${t}'`).join(', ')})
  `);
  pgm.dropConstraint('tool_permissions', 'tool_permissions_agent_tool_unique');
};
