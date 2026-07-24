// tools/FileEditTool.js — Makes targeted search-and-replace edits to existing files
const fs = require('fs').promises;

/**
 * Replace a string block inside a file.
 *
 * @param {string|object} input - {file_path, old_string, new_string, replace_all}
 * @returns {Promise<{ success: boolean, file: string, action: string }>}
 */
async function execute(input) {
  let file_path, old_string, new_string, replace_all = false;

  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      file_path = p.file_path;
      old_string = p.old_string;
      new_string = p.new_string;
      replace_all = !!p.replace_all;
    } catch {
      return { error: 'Input must be a valid JSON object with file_path, old_string, and new_string' };
    }
  } else {
    file_path = input?.file_path;
    old_string = input?.old_string;
    new_string = input?.new_string;
    replace_all = !!input?.replace_all;
  }

  if (!file_path) return { error: 'No file_path provided' };
  if (typeof old_string !== 'string') return { error: 'old_string is missing or not a string' };
  if (typeof new_string !== 'string') return { error: 'new_string is missing or not a string' };

  try {
    let data = await fs.readFile(file_path, 'utf8');
    
    if (!data.includes(old_string)) {
      return { error: 'old_string not found in file. Ensure exact matching, including whitespace.' };
    }
    
    if (replace_all) {
      data = data.split(old_string).join(new_string);
    } else {
      data = data.replace(old_string, new_string);
    }
    
    await fs.writeFile(file_path, data, 'utf8');
    return { 
      success: true, 
      file: file_path, 
      action: replace_all ? 'replaced_all' : 'replaced_first' 
    };
  } catch (err) {
    return { error: `Failed to edit file: ${err.message}` };
  }
}

module.exports = { execute };
