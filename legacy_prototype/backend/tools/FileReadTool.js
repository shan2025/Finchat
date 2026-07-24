// tools/FileReadTool.js — Read file contents from the local filesystem
const fs = require('fs').promises;

/**
 * Read file contents with line pagination to avoid blowing up the token context.
 *
 * @param {string|object} input - The file path, or {file_path, offset, limit}
 * @returns {Promise<{ file: string, content: string, startLine: number, totalLines: number }>}
 */
async function execute(input) {
  let file_path;
  let offset = 0;
  let limit = 500; // max lines per read

  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      file_path = p.file_path;
      if (p.offset) offset = +p.offset;
      if (p.limit) limit = +p.limit;
    } catch {
      file_path = input.trim();
    }
  } else {
    file_path = input?.file_path;
    if (input?.offset) offset = +input.offset;
    if (input?.limit) limit = +input.limit;
  }

  if (!file_path) return { error: 'No file_path provided' };

  try {
    const data = await fs.readFile(file_path, 'utf8');
    const lines = data.split('\n');
    
    // Bound the values
    offset = Math.max(0, Math.min(offset, lines.length));
    limit = Math.max(1, Math.min(limit, 1000));
    
    const subset = lines.slice(offset, offset + limit);
    
    return {
      file: file_path,
      content: subset.join('\n'),
      startLine: offset + 1, // 1-indexed for the output
      endLine: offset + subset.length,
      totalLines: lines.length
    };
  } catch (err) {
    return { error: `Failed to read file: ${err.message}` };
  }
}

module.exports = { execute };
