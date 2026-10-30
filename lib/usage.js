'use strict';
// Token usage and usage-limit detection from Claude Code's local session logs (projects/**/*.jsonl).
// The transcript format is internal to Claude Code and changes between versions
// (https://code.claude.com/docs/en/sessions), so every field is read defensively.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Claude Code stores sessions in projects/<cwd with every non-alphanumeric char replaced by "-">.
// Long names are truncated and hashed, so callers must not rely on this alone.
/** @param {string} cwd */
const encodeProjectDir = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** @param {any} o */
function entryText(o) {
  const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
  return content.map((/** @type {any} */ c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
}

// Messages from https://code.claude.com/docs/en/errors plus the older "Claude AI usage limit reached|<epoch>".
const LIMIT_TEXT =
  /hit your (session|weekly|opus|sonnet|monthly spend|usage) limit|usage limit reached|rate limit reached|request rejected \(429\)/i;

// Returns { kind, resetAt } when the entry reports that the account hit a usage limit, otherwise null.
// kind: 'session' | 'weekly' | 'model' | 'spend' | 'unknown'; resetAt: epoch ms or null.
/** @param {any} o */
function limitInfo(o) {
  if (!o || typeof o !== 'object') return null;
  const text = entryText(o);
  const legacy = /^Claude AI usage limit reached(?:\|(\d{9,13}))?/i.exec(text.trim());
  let hit = !!legacy;
  if (!hit && o.isApiErrorMessage === true) {
    const status = String(o.apiErrorStatus ?? '');
    const code = `${o.error ?? ''} ${o.apiErrorCode ?? ''}`;
    hit = status === '429' || /rate_limit|usage_limit|overage|spend_limit/i.test(code) || LIMIT_TEXT.test(text);
  }
  if (!hit) return null;
  let kind = 'unknown';
  if (/weekly/i.test(text)) kind = 'weekly';
  else if (/opus|sonnet/i.test(text)) kind = 'model';
  else if (/spend/i.test(text)) kind = 'spend';
  else if (/session|usage limit reached/i.test(text)) kind = 'session';
  let resetAt = null;
  if (legacy && legacy[1]) {
    const n = Number(legacy[1]);
    resetAt = n < 1e12 ? n * 1000 : n;
  }
  return { kind, resetAt };
}

/** @param {any} o */
const isRateLimitEntry = (o) => limitInfo(o) !== null;

/** @param {string} dir @param {number} since */
async function listJsonl(dir, since) {
  /** @type {{ file: string, mtimeMs: number, size: number }[]} */
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...(await listJsonl(p, since)));
    else if (e.name.endsWith('.jsonl') && st.mtimeMs >= since) out.push({ file: p, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

const emptyTotals = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
/** @typedef {ReturnType<typeof emptyTotals>} Totals */
/** @param {Totals} t @param {{ input: number, output: number, cacheWrite: number, cacheRead: number }} u */
function addUsage(t, u) {
  t.input += u.input;
  t.output += u.output;
  t.cacheWrite += u.cacheWrite;
  t.cacheRead += u.cacheRead;
  t.messages++;
}
/** @param {Totals} t */
const totalTokens = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

/** @param {string} file @param {number} since */
async function readUsageRecords(file, since) {
  const records = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o && o.type === 'assistant' && o.message && o.message.usage;
      if (!u) continue;
      const ts = Date.parse(o.timestamp);
      if (!(ts >= since)) continue;
      records.push({
        key: o.message.id ? `${o.message.id}:${o.requestId || ''}` : null,
        ts,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      });
    }
  } catch {
    /* file removed or unreadable while reading: keep what was read */
  } finally {
    stream.destroy();
  }
  return records;
}

// Keeps parsed records per file and re-reads only files whose size or mtime changed.
class UsageIndex {
  constructor() {
    /** @type {Map<string, { mtimeMs: number, size: number, since: number, records: any[] }>} */
    this.files = new Map();
  }

  /** @param {string} projectsDir @param {number} [now] */
  async summarize(projectsDir, now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const todayStart = start.getTime();
    const weekStart = now - 7 * 864e5;
    const result = { today: emptyTotals(), week: emptyTotals() };
    const seen = new Set();
    const present = new Set();
    for (const f of await listJsonl(projectsDir, weekStart)) {
      present.add(f.file);
      let cached = this.files.get(f.file);
      if (!cached || cached.mtimeMs !== f.mtimeMs || cached.size !== f.size || cached.since > weekStart) {
        cached = { mtimeMs: f.mtimeMs, size: f.size, since: weekStart, records: await readUsageRecords(f.file, weekStart) };
        this.files.set(f.file, cached);
      }
      for (const r of cached.records) {
        if (r.ts < weekStart) continue;
        if (r.key) {
          if (seen.has(r.key)) continue; // the same response can be logged more than once
          seen.add(r.key);
        }
        addUsage(result.week, r);
        if (r.ts >= todayStart) addUsage(result.today, r);
      }
    }
    for (const k of [...this.files.keys()]) if (!present.has(k)) this.files.delete(k);
    return result;
  }
}

/** @param {string} projectsDir @param {number} [now] */
const summarizeUsage = (projectsDir, now = Date.now()) => new UsageIndex().summarize(projectsDir, now);

/** @param {number} n */
function formatTokens(n) {
  if (n >= 999.95e6) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 999.5e3) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// Reads only what was appended to each file since the last call. A file seen for the first time is
// read from its last `initialWindow` bytes, so a watcher can start without listing every file.
class TailReader {
  constructor(maxBytes = 4 * 1024 * 1024, initialWindow = 256 * 1024) {
    /** @type {Map<string, number>} */
    this.offsets = new Map();
    this.maxBytes = maxBytes;
    this.initialWindow = initialWindow;
  }

  /** @param {string} file */
  async prime(file) {
    try {
      this.offsets.set(file, (await fs.promises.stat(file)).size);
    } catch {
      /* ignore */
    }
  }

  /** @param {string} file */
  async readNew(file) {
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return [];
    }
    try {
      return await this.readFrom(fh, file);
    } finally {
      await fh.close();
    }
  }

  /** @param {import('fs').promises.FileHandle} fh @param {string} file */
  async readFrom(fh, file) {
    const size = (await fh.stat()).size;
    const prev = this.offsets.get(file);
    let startAt = prev !== undefined ? prev : Math.max(0, size - this.initialWindow);
    if (size < startAt) startAt = 0; // truncated or replaced
    if (size === startAt) return [];
    if (size - startAt > this.maxBytes) startAt = size - this.maxBytes;
    // Recorded offsets always follow a newline; any other start may cut a line in half.
    const aligned = startAt === 0 || startAt === prev;
    const buf = Buffer.alloc(size - startAt);
    await fh.read(buf, 0, buf.length, startAt);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return []; // incomplete line; wait for more
    this.offsets.set(file, startAt + lastNl + 1);
    let body = buf.subarray(0, lastNl).toString('utf8');
    if (!aligned) {
      const before = Buffer.alloc(1);
      await fh.read(before, 0, 1, startAt - 1);
      if (before[0] !== 0x0a) body = body.slice(body.indexOf('\n') + 1);
    }
    const out = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial or invalid */
      }
    }
    return out;
  }
}

module.exports = {
  encodeProjectDir,
  isRateLimitEntry,
  limitInfo,
  summarizeUsage,
  UsageIndex,
  formatTokens,
  totalTokens,
  TailReader,
  listJsonl,
};
