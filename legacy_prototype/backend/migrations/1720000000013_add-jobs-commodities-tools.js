/* eslint-disable camelcase */

// Wire the new JobsTool and CommoditiesTool into their agents' manifests.
// Rasha (career strategist) gets jobs; Aurelius (finance strategist) gets commodities.

exports.up = async (pgm) => {
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search","crypto","commodities"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","resume","jobs"]'::jsonb WHERE agent_id = 'rasha';`);
};

exports.down = async (pgm) => {
  pgm.sql(`UPDATE agent_configs SET tools = '["stocks","search","crypto"]'::jsonb WHERE agent_id = 'aurelius';`);
  pgm.sql(`UPDATE agent_configs SET tools = '["search","resume"]'::jsonb WHERE agent_id = 'rasha';`);
};
