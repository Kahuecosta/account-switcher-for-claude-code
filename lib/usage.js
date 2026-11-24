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

// What each kind of token costs relative to an input token, checked against the costs Claude Code 2.1.330
// itself records (cost-state). An estimate: how the plan counts is not public.
const COST = { input: 1, output: 5, cacheRead: 0.05, cacheWrite5m: 1.25, cacheWrite1h: 2 };
const modelScale = (/** @type {unknown} */ model) => (/haiku/i.test(String(model)) ? 0.025 : 1);

/** @param {any} u message.usage */
const contextTokens = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

/** @param {any} u message.usage @param {unknown} model */
function relativeCost(u, model) {
  const written = u.cache_creation_input_tokens || 0;
  const hour = Math.min(written, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  const tokens =
    COST.input * (u.input_tokens || 0) +
    COST.output * (u.output_tokens || 0) +
    COST.cacheRead * (u.cache_read_input_tokens || 0) +
    COST.cacheWrite1h * hour +
    COST.cacheWrite5m * (written - hour);
  return tokens * modelScale(model);
}

// What the latest response of a conversation had to read, from its transcript entry; null for other entries
// (and for subagents, which have a context of their own).
/** @param {any} o @returns {{ session: string, tokens: number, ts: number } | null} */
function contextOf(o) {
  const u = o && o.type === 'assistant' && o.isSidechain !== true && o.message && o.message.usage;
  if (!u || typeof o.sessionId !== 'string') return null;
  const tokens = contextTokens(u);
  const ts = Date.parse(o.timestamp);
  return tokens > 0 && Number.isFinite(ts) ? { session: o.sessionId, tokens, ts } : null;
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
  /** @type {{ cwd: string | null, custom: string | null, ai: string | null, prompt: string | null }} */
  const info = { cwd: null, custom: null, ai: null, prompt: null };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const named = /"type":"(custom-title|ai-title|last-prompt)"/.test(line.slice(0, 200));
      if (!named && !line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (named && o) {
        if (typeof o.customTitle === 'string') info.custom = o.customTitle;
        if (typeof o.aiTitle === 'string') info.ai = o.aiTitle;
        if (typeof o.lastPrompt === 'string') info.prompt = info.prompt || o.lastPrompt; // the first one, like the panel's title
      }
      const u = o && o.type === 'assistant' && o.message && o.message.usage;
      if (!u) continue;
      const ts = Date.parse(o.timestamp);
      if (!(ts >= since)) continue;
      if (typeof o.cwd === 'string') info.cwd = o.cwd;
      records.push({
        key: o.message.id ? `${o.message.id}:${o.requestId || ''}` : null,
        ts,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cost: relativeCost(u, o.message.model),
        context: o.isSidechain === true ? 0 : contextTokens(u),
      });
    }
  } catch {
    /* file removed or unreadable while reading: keep what was read */
  } finally {
    stream.destroy();
  }
  return { records, info };
}

/**
 * @typedef {{ session: string, cwd: string | null, title: string | null, context: number, records: { ts: number, cost: number }[] }} Conversation
 *   context: tokens its latest response had to read
 */

// The conversation a transcript belongs to: <project>/<session>.jsonl, or <project>/<session>/... for subagents.
/** @param {string} projectsDir @param {string} file */
function sessionOf(projectsDir, file) {
  const parts = path.relative(projectsDir, file).split(path.sep);
  return { session: path.basename(parts[1] || parts[0], '.jsonl'), main: parts.length <= 2 };
}

/**
 * The conversations that used up most of a window, as shares of what is known of it.
 * @param {Conversation[]} conversations
 * @param {{ from: number, owner: (session: string, ts: number) => boolean, top?: number }} opts
 *   owner: whether what the conversation used at that time counts
 */
function usedBy(conversations, { from, owner, top = 3 }) {
  const rows = conversations
    .map((c) => ({ c, cost: c.records.reduce((sum, r) => (r.ts >= from && owner(c.session, r.ts) ? sum + r.cost : sum), 0) }))
    .filter((r) => r.cost > 0)
    .sort((x, y) => y.cost - x.cost);
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  return {
    rows: rows
      .slice(0, top)
      .map(({ c, cost }) => ({ session: c.session, cwd: c.cwd, title: c.title, context: c.context, pct: (100 * cost) / total })),
    others: rows.slice(top).reduce((sum, r) => sum + (100 * r.cost) / total, 0),
  };
}

// Keeps parsed records per file and re-reads only files whose size or mtime changed.
class UsageIndex {
  constructor() {
    /** @type {Map<string, { mtimeMs: number, size: number, since: number, records: any[], info: any }>} */
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
        cached = { mtimeMs: f.mtimeMs, size: f.size, since: weekStart, ...(await readUsageRecords(f.file, weekStart)) };
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

  // The conversations of the last 7 days, from what the latest summarize(projectsDir) read.
  /** @param {string} projectsDir @returns {Conversation[]} */
  conversations(projectsDir) {
    /** @type {Map<string, Conversation & { at: number }>} */
    const out = new Map();
    const seen = new Set();
    for (const [file, { records, info }] of this.files) {
      const { session, main } = sessionOf(projectsDir, file);
      const c = out.get(session) || { session, cwd: null, title: null, context: 0, at: 0, records: [] };
      out.set(session, c);
      if (main || !c.cwd) c.cwd = info.cwd || c.cwd;
      if (main) c.title = info.custom || info.ai || info.prompt;
      for (const r of records) {
        if (r.key) {
          if (seen.has(r.key)) continue;
          seen.add(r.key);
        }
        c.records.push({ ts: r.ts, cost: r.cost });
        if (main && r.context > 0 && r.ts >= c.at) {
          c.context = r.context;
          c.at = r.ts;
        }
      }
    }
    return [...out.values()].filter((c) => c.records.length);
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
  contextOf,
  usedBy,
  isRateLimitEntry,
  limitInfo,
  summarizeUsage,
  UsageIndex,
  formatTokens,
  totalTokens,
  TailReader,
  listJsonl,
};
