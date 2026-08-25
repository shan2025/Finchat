/* eslint-disable camelcase */

// BYOK key roles — let a user assign each of their keys to a kind of work, so a
// paid key can power trading intelligence while a free one handles everything
// else. The role maps to the agent that does that work (see UserKeys.roleForAgent):
//
//   markets    → Aurelius (crypto / stocks / trading)
//   jobs       → Rasha    (job hunt / hiring)
//   research   → Nova     (papers / tech / frontier research)
//   everything → the default and the fallback for any task no key was assigned to
//
// Routing prefers the role-matched key's PROVIDER for that work and still falls
// back to the user's other keys — assignment is a preference, never a wall.

exports.up = async (pgm) => {
  pgm.addColumns('user_provider_keys', {
    role: { type: 'text', notNull: true, default: 'everything' }
  });
};

exports.down = async (pgm) => {
  pgm.dropColumns('user_provider_keys', ['role']);
};
