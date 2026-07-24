// tools/BashTool.js — Executes shell commands inside the environment
const { exec } = require('child_process');

/**
 * Execute a shell command.
 *
 * @param {string|object} input - the command string, or {command, timeout}
 * @returns {Promise<{ stdout: string, stderr: string, error: string }>}
 */
async function execute(input) {
  let command;
  let timeout = 30000;

  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      command = p.command || input;
      if (p.timeout) timeout = +p.timeout;
    } catch {
      command = input.trim();
    }
  } else {
    command = (input?.command || '').trim();
    if (input?.timeout) timeout = +input.timeout;
  }

  if (!command) return { error: 'No command provided' };

  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : null
      });
    });
  });
}

module.exports = { execute };
