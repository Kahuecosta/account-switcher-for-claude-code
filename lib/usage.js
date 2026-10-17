'use strict';
// Token usage and rate-limit detection from Claude Code's local session logs (projects/**/*.jsonl).
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Claude Code stores sessions in projects/<cwd with every non-alphanumeric char replaced by "-">.
const encodeProjectDir = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

function isRateLimitEntry(o) {
  if (!o || typeof o !== 'object') return false;
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  const text = content.map((c) => (c && c.text) || '').join(' ');
  if (/^Claude AI usage limit reached/i.test(text)) return true; // older format
  if (o.isApiErrorMessage !== true) return false;
  if (/rate_limit|usage_limit|429/i.test(String(o.error || '') + ' ' + String(o.apiErrorStatus || ''))) return true;
  return /limit (reached|hit)|usage limit|hit your limit/i.test(text);
}

async function listJsonl(dir, since) {
  const out = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (st.isDirectory()) out.push(...(await listJsonl(p, since)));
    else if (e.name.endsWith('.jsonl') && st.mtimeMs >= since) out.push(p);
  }
  return out;
}

const emptyTotals = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheWrite += u.cache_creation_input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  t.messages++;
}
const totalTokens = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

async function summarizeUsage(projectsDir, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const todayStart = start.getTime();
  const weekStart = now - 7 * 864e5;
  const result = { today: emptyTotals(), week: emptyTotals() };
  const seen = new Set();
  for (const file of await listJsonl(projectsDir, weekStart)) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const u = o && o.type === 'assistant' && o.message && o.message.usage;
        if (!u) continue;
        const ts = Date.parse(o.timestamp);
        if (!(ts >= weekStart)) continue;
        if (o.message.id) {
          const key = `${o.message.id}:${o.requestId || ''}`;
          if (seen.has(key)) continue; // the same response can be logged more than once
          seen.add(key);
        }
        addUsage(result.week, u);
        if (ts >= todayStart) addUsage(result.today, u);
      }
    } catch { /* file removed or unreadable while reading: skip it */ } finally {
      stream.destroy();
    }
  }
  return result;
}

function formatTokens(n) {
  if (n >= 999.95e6) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 999.5e3) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// Reads only what was appended to each file since the last call.
class TailReader {
  constructor(maxBytes = 4 * 1024 * 1024) {
    this.offsets = new Map();
    this.maxBytes = maxBytes;
  }

  async prime(file) {
    try { this.offsets.set(file, (await fs.promises.stat(file)).size); } catch { /* ignore */ }
  }

  async readNew(file) {
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch { return []; }
    let startAt = this.offsets.has(file) ? this.offsets.get(file) : 0;
    if (size < startAt) startAt = 0; // truncated or replaced
    if (size === startAt) return [];
    if (size - startAt > this.maxBytes) startAt = size - this.maxBytes;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - startAt);
      await fh.read(buf, 0, buf.length, startAt);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl < 0) return []; // incomplete line; wait for more
      this.offsets.set(file, startAt + lastNl + 1);
      const out = [];
      for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* partial or invalid */ }
      }
      return out;
    } finally {
      await fh.close();
    }
  }
}

module.exports = { encodeProjectDir, isRateLimitEntry, summarizeUsage, formatTokens, totalTokens, TailReader, listJsonl };
