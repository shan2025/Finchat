// tools/FileWriteTool.js — Writes or overwrites files on the filesystem
const fs = require('fs').promises;
const path = require('path');

/**
 * Write or overwrite a file entirely.
 *
 * @param {string|object} input - {file_path, content}
 * @returns {Promise<{ success: boolean, file: string, bytesWritten: number }>}
 */
async function execute(input) {
  let file_path, content;

  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      file_path = p.file_path;
      content = p.content;
    } catch {
      return { error: 'Input must be a valid JSON object with file_path and content' };
    }
  } else {
    file_path = input?.file_path;
    content = input?.content;
  }

  if (!file_path) return { error: 'No file_path provided' };
  if (typeof content !== 'string') return { error: 'No string content provided' };

  try {
    // Ensure directory exists
    const dir = path.dirname(file_path);
    await fs.mkdir(dir, { recursive: true });
    
    await fs.writeFile(file_path, content, 'utf8');
    return { 
      success: true, 
      file: file_path, 
      bytesWritten: Buffer.byteLength(content, 'utf8') 
    };
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` };
  }
}

module.exports = { execute };
