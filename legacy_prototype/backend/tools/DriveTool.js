// tools/DriveTool.js — find the user's Google Drive files by NAME and return
// their links. The agent side of services/googleDrive.js.
//
// Names and links only: the grant is drive.metadata.readonly, so there is no
// action here that reads a file's contents, and none could be added without the
// user granting a wider scope first.
const Drive = require('../services/googleDrive');

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
  }
  return s ? { action: 'search', query: s } : { action: 'status' };
}

async function execute(input, context = {}) {
  const { action = 'search', query = '', names, limit } = parseInput(input);
  const userId = context.userId;
  if (!userId || userId === 'system') throw new Error('Drive needs a signed-in user context');

  if (action === 'status') {
    return { connected: await Drive.isConnected(userId), access: 'file names and links only' };
  }

  try {
    if (action === 'find') {
      const list = Array.isArray(names) ? names : String(names || query).split(/\n|;/);
      const results = await Drive.resolveNames(userId, list.map(n => String(n).trim()).filter(Boolean));
      return {
        connected: true,
        results: results.map(r => ({
          name: r.name,
          found: r.match ? { title: r.match.title, url: r.match.url, type: r.match.kindLabel, modified: r.match.modifiedTime } : null,
          alternatives: r.alternatives.map(a => ({ title: a.title, url: a.url, type: a.kindLabel }))
        })),
        note: 'Give the user each link by name. If "found" is null, say so and offer the alternatives — never invent a link.'
      };
    }
    if (action === 'search') {
      const files = await Drive.search(userId, query, { limit: limit || 10 });
      return {
        connected: true,
        count: files.length,
        files: files.map(f => ({ title: f.title, url: f.url, type: f.kindLabel, modified: f.modifiedTime, owner: f.owner }))
      };
    }
  } catch (err) {
    if (err instanceof Drive.DriveError) {
      // A normal outcome to report, not a crash: the agent tells the user.
      return { connected: err.code !== 'not_connected' && err.code !== 'not_configured', error: err.message };
    }
    throw err;
  }
  throw new Error(`Unknown drive action "${action}". Use "search", "find" or "status".`);
}

module.exports = { execute };
