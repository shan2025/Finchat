// tools/GlobTool.js — List files using glob patterns
const { glob } = require('glob');
const path = require('path');

/**
 * Find files using a glob pattern.
 *
 * @param {string|object} input - {pattern, dir}
 * @returns {Promise<{ files: string[], count: number, dir: string }>}
 */
async function execute(input) {
  let pattern, dir = process.cwd();

  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      pattern = p.pattern;
      if (p.dir) dir = p.dir;
    } catch {
      pattern = input.trim();
    }
  } else {
    pattern = input?.pattern;
    if (input?.dir) dir = input.dir;
  }

  if (!pattern) return { error: 'No pattern provided (e.g. "**/*.js")' };

  try {
    const files = await glob(pattern, { cwd: dir, nodir: true });
    // Limit to 200 files to avoid blowing up context
    const limit = 200;
    const isTruncated = files.length > limit;
    
    return { 
      dir: path.resolve(dir),
      count: files.length,
      files: isTruncated ? files.slice(0, limit) : files,
      truncated: isTruncated
    };
  } catch (err) {
    return { error: `Failed to execute glob: ${err.message}` };
  }
}

module.exports = { execute };
