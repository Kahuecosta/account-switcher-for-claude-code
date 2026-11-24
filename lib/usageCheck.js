'use strict';
// Has Claude Code check an account's plan usage now. It starts the claude binary with the account's
// environment and sends the request behind /usage (get_usage), and no message, so none of the plan is
// used. Claude Code makes the request with its own login and saves the answer in the account's
// .claude.json, where lib/quota.js reads it: no token and no figure passes through here. The Claude Code
// panel does the same when it starts. The request is internal to Claude Code and may change.
const { spawn } = require('child_process');

const ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--safe-mode', // no hooks, plugins, MCP servers or CLAUDE.md
  '--strict-mcp-config',
  '--no-chrome',
  '--tools',
  '',
  '--no-session-persistence', // leaves no conversation behind
];
const REQUEST_ID = 'usage';
const REQUESTS = [
  { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } },
  { type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true } },
];

/**
 * Resolves once Claude Code has answered and exited (so the answer is saved), with whether it had plan
 * limits to report. Rejects when it could not be started, did not answer in time or refused the request.
 * @param {string} exe
 * @param {{ env: Record<string, string>, cwd: string, args?: string[], timeoutMs?: number, exitMs?: number }} opts
 * @returns {Promise<boolean>}
 */
function checkUsage(exe, { env, cwd, args = ARGS, timeoutMs = 45e3, exitMs = 5e3 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    /** @type {any} */
    let answer = null;
    let settled = false;
    let buffer = '';
    /** @type {NodeJS.Timeout | undefined} */
    let exitTimer;
    const finish = (/** @type {Error | null} */ error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      child.kill();
      if (answer && answer.subtype === 'success') return resolve(!!(answer.response && answer.response.rate_limits));
      reject(answer ? new Error(String(answer.error || 'get_usage failed')) : error);
    };
    const timer = setTimeout(() => finish(new Error('Claude Code did not answer in time')), timeoutMs);
    child.on('error', finish);
    child.on('close', (code) => finish(new Error(`Claude Code exited (${code}) without an answer`)));
    child.stdin.on('error', () => undefined); // it exited before reading: reported by 'close'
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (answer || !line.includes('control_response')) continue;
        try {
          const o = JSON.parse(line);
          if (o.type === 'control_response' && o.response && o.response.request_id === REQUEST_ID) answer = o.response;
        } catch {
          /* not a message */
        }
        if (!answer) continue;
        child.stdin.end(); // it exits by itself, after saving what it has to save
        exitTimer = setTimeout(() => finish(null), exitMs);
      }
    });
    for (const r of REQUESTS) child.stdin.write(JSON.stringify(r) + '\n');
  });
}

module.exports = { ARGS, checkUsage };
