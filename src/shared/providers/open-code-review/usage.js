'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { throwIfAborted } = require('../../abortSignal');
const { sharedDataDir } = require('../../config');
const { localDayKey } = require('../../history');

const CLIENT = 'open-code-review';
const CACHE_VERSION = 3;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_ROWS = 200_000;
const MAX_TOTAL_ROWS = 500_000;
const MAX_FILES = 10_000;
const MAX_FIELD_BYTES = 64 * 1024;
const FIELDS = new Set(['type', 'uuid', 'sessionId', 'timestamp', 'model', 'usage']);

function readError(message, code = 'OPEN_CODE_REVIEW_INVALID_USAGE') {
  return Object.assign(new Error(`open-code-review: ${message}`), { code });
}

function budgetError(kind) {
  return readError(`${kind} exceeds read budget`, 'OPEN_CODE_REVIEW_READ_BUDGET_EXCEEDED');
}

function openCodeReviewSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.opencodereview', 'sessions');
}

// OCR's Go encoder puts type/usage after content and native_payload. Project
// only top-level metadata while traversing JSON strings/containers; a request
// can contain hundreds of megabytes without becoming a buffered JS string.
class MetadataLine {
  constructor() {
    this.phase = 'start';
    this.fields = {};
    this.key = '';
    this.parts = [];
    this.fieldBytes = 0;
    this.depth = 0;
    this.inString = false;
    this.trailingSlashes = 0;
    this.invalid = false;
  }

  append(buffer) {
    if (!this.capture || buffer.length === 0) return;
    this.fieldBytes += buffer.length;
    if (this.fieldBytes > MAX_FIELD_BYTES) throw budgetError('metadata field');
    this.parts.push(Buffer.from(buffer));
  }

  consume(buffer) {
    let i = 0;
    let captureStart = this.phase === 'value' ? 0 : -1;
    while (i < buffer.length && !this.invalid) {
      const byte = buffer[i];
      if (this.phase === 'value') {
        if (this.inString) {
          const quote = buffer.indexOf(34, i);
          const end = quote === -1 ? buffer.length : quote;
          let slash = end - 1;
          while (slash >= i && buffer[slash] === 92) slash -= 1;
          const count = end - 1 - slash + (slash < i ? this.trailingSlashes : 0);
          this.trailingSlashes = quote === -1 ? count : 0;
          i = quote === -1 ? buffer.length : quote + 1;
          if (quote !== -1 && count % 2 === 0) this.inString = false;
          continue;
        }
        if (this.depth === 0 && (byte === 44 || byte === 125)) {
          this.append(buffer.subarray(captureStart, i));
          if (this.capture) {
            try { this.fields[this.key] = JSON.parse(Buffer.concat(this.parts).toString('utf8')); }
            catch (_) { this.invalid = true; }
          }
          this.parts = [];
          this.phase = 'after';
          captureStart = -1;
          continue;
        }
        if (byte === 34) this.inString = true;
        else if (byte === 123 || byte === 91) this.depth += 1;
        else if (byte === 125 || byte === 93) this.depth -= 1;
        if (this.depth < 0) this.invalid = true;
        i += 1;
        continue;
      }
      if (byte === 32 || byte === 9 || byte === 13) { i += 1; continue; }
      if (this.phase === 'start' && byte === 123) this.phase = 'key';
      else if (this.phase === 'key' && byte === 34) {
        this.phase = 'keyText';
        this.key = '';
      } else if (this.phase === 'keyText') {
        if (byte === 34) this.phase = 'colon';
        else if (this.key.length >= 256 || byte === 92 || byte < 32) this.invalid = true;
        else this.key += String.fromCharCode(byte);
      } else if (this.phase === 'colon' && byte === 58) this.phase = 'beforeValue';
      else if (this.phase === 'beforeValue') {
        this.phase = 'value';
        this.capture = FIELDS.has(this.key);
        this.fieldBytes = 0;
        this.depth = 0;
        captureStart = i;
        continue;
      } else if (this.phase === 'after' && byte === 44) this.phase = 'key';
      else if ((this.phase === 'after' || this.phase === 'key') && byte === 125) this.phase = 'done';
      else this.invalid = true;
      i += 1;
    }
    if (captureStart >= 0 && !this.invalid) this.append(buffer.subarray(captureStart, i));
  }
}

function normalizedRow(event) {
  if (event.type !== 'llm_response' || event.usage == null) return null;
  const usage = event.usage;
  const prompt = usage.prompt_tokens;
  const output = usage.completion_tokens;
  const cacheRead = usage.cache_read_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  if (![prompt, output, cacheRead, cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0)
    || cacheRead + cacheWrite > prompt || !Number.isSafeInteger(prompt + output)) {
    throw readError('invalid token components');
  }
  const createdAt = Date.parse(event.timestamp);
  if (typeof event.uuid !== 'string' || !event.uuid || !Number.isFinite(createdAt)) {
    throw readError('usage event is missing a valid uuid or timestamp');
  }
  // OCR's native Anthropic/OpenAI resolvers normalize cache-inclusive prompt
  // tokens. Its generic compatibility fallback does not guarantee that format.
  return { uuid: event.uuid, sessionId: String(event.sessionId || event.uuid),
    model: String(event.model || 'unknown'), createdAt, prompt,
    input: prompt - cacheRead - cacheWrite, output, cacheRead, cacheWrite };
}

async function sessionFiles(root) {
  let dates;
  try { dates = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const date of dates) {
    if (!date.isDirectory()) continue;
    const dir = path.join(root, date.name);
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (files.length >= MAX_FILES) throw budgetError('source files');
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files.sort();
}

function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function checkpointHash(file, offset, options) {
  const hash = createHash('sha256');
  let bytes = 0;
  if (offset > 0) {
    const stream = file.createReadStream({ start: 0, end: offset - 1, autoClose: false,
      highWaterMark: options.chunkBytes || 64 * 1024, signal: options.signal });
    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      hash.update(chunk);
      bytes += chunk.length;
    }
  }
  if (bytes !== offset) throw readError('source changed during prefix verification');
  return hash;
}

async function loadCache(cachePath) {
  try {
    const stat = await fs.promises.stat(cachePath);
    if (stat.size > MAX_CACHE_BYTES) throw budgetError('numeric cache');
    const stored = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
    if (stored?.version !== CACHE_VERSION) return null;
    const { checksum, ...value } = stored;
    return checksum === digest(JSON.stringify(value)) && Array.isArray(value.rows) && value.rows.length <= MAX_FILE_ROWS
      && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.rows.every((row) => (
        row && typeof row.uuid === 'string' && row.uuid && typeof row.sessionId === 'string'
        && typeof row.model === 'string' && Number.isFinite(row.createdAt)
        && ['prompt', 'input', 'output', 'cacheRead', 'cacheWrite'].every((key) => Number.isSafeInteger(row[key]) && row[key] >= 0)
        && row.input + row.cacheRead + row.cacheWrite === row.prompt
      )) ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function saveCache(cachePath, value, signal) {
  const json = JSON.stringify({ ...value, checksum: digest(JSON.stringify(value)) });
  if (Buffer.byteLength(json) > MAX_CACHE_BYTES) throw budgetError('numeric cache');
  throwIfAborted(signal);
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, json, { mode: 0o600, signal });
    throwIfAborted(signal);
    await fs.promises.rename(temporary, cachePath);
  } finally { await fs.promises.rm(temporary, { force: true }); }
}

async function readFileRows(filePath, cacheDir, options) {
  throwIfAborted(options.signal);
  const cachePath = path.join(cacheDir, `${digest(filePath)}.json`);
  let cached = await loadCache(cachePath);
  const file = await fs.promises.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (cached && (cached.identity !== identity(stat) || stat.size < cached.offset)) cached = null;
    if (cached && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) return cached.rows;
    let committedHash = createHash('sha256');
    if (cached) {
      committedHash = await checkpointHash(file, cached.offset, options);
      if (committedHash.copy().digest('hex') !== cached.checkpoint) {
        cached = null;
        committedHash = createHash('sha256');
      }
    }
    const readHash = committedHash.copy();
    const rows = cached ? [...cached.rows] : [];
    const start = cached?.offset || 0;
    let offset = start;
    let bytes = 0;
    let line = new MetadataLine();
    if (stat.size > start) {
      const stream = file.createReadStream({ start, end: stat.size - 1, autoClose: false,
        highWaterMark: options.chunkBytes || 64 * 1024, signal: options.signal });
      for await (const chunk of stream) {
        throwIfAborted(options.signal);
        let pos = 0;
        while (pos < chunk.length) {
          const newline = chunk.indexOf(10, pos);
          const end = newline === -1 ? chunk.length : newline;
          const piece = chunk.subarray(pos, end);
          bytes += piece.length;
          readHash.update(piece);
          line.consume(piece);
          if (newline === -1) break;
          readHash.update(chunk.subarray(newline, newline + 1));
          if (line.invalid || (line.phase !== 'done' && bytes > 0)) throw readError('malformed complete JSONL record');
          if (line.fields.type === 'llm_response' && bytes > (options.maxLineBytes || MAX_LINE_BYTES)) throw budgetError('usage line');
          const row = normalizedRow(line.fields);
          if (row) {
            if (rows.length >= MAX_FILE_ROWS) throw budgetError('numeric rows');
            rows.push(row);
          }
          offset += bytes + 1;
          committedHash = readHash.copy();
          bytes = 0;
          line = new MetadataLine();
          pos = newline + 1;
        }
      }
    }
    throwIfAborted(options.signal);
    const after = await file.stat();
    if (identity(after) !== identity(stat) || after.size < stat.size
      || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) throw readError('source changed during read');
    await saveCache(cachePath, { version: CACHE_VERSION, identity: identity(stat), size: stat.size,
      mtimeMs: stat.mtimeMs, offset, checkpoint: committedHash.digest('hex'), rows }, options.signal);
    return rows;
  } finally { await file.close(); }
}

async function collectOpenCodeReviewRows(options = {}) {
  throwIfAborted(options.signal);
  const root = openCodeReviewSessionsDir(options.homeDir);
  const cacheDir = options.cacheDir || path.join(sharedDataDir(options), 'open-code-review-usage');
  const unique = new Map();
  for (const file of await sessionFiles(root)) {
    for (const row of await readFileRows(file, cacheDir, options)) {
      const previous = unique.get(row.uuid);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw readError('conflicting duplicate event uuid');
      if (!previous) {
        if (unique.size >= MAX_TOTAL_ROWS) throw budgetError('total numeric rows');
        unique.set(row.uuid, row);
      }
    }
  }
  throwIfAborted(options.signal);
  return [...unique.values()];
}

function periodJson(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.sessionId, row.model]);
    let entry = groups.get(key);
    if (!entry) {
      entry = { client: CLIENT, sessionId: `${CLIENT}:${row.sessionId}`, model: row.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messageCount: 0 };
      groups.set(key, entry);
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) entry[field] += row[field];
    entry.messageCount += 1;
  }
  return { entries: [...groups.values()] };
}

function buildOpenCodeReviewPeriods({ rows = [], now = new Date(), allTimeSince } = {}) {
  const at = new Date(now);
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const month = new Date(at.getFullYear(), at.getMonth(), 1).getTime();
  const since = /^\d{4}-\d{2}-\d{2}$/.test(allTimeSince || '')
    ? new Date(`${allTimeSince}T00:00:00`).getTime() : Number(allTimeSince) || 0;
  const build = (start) => periodJson(rows.filter((row) => row.createdAt >= start && row.createdAt <= at.getTime()));
  return { today: build(today), month: build(month), allTime: build(since) };
}

function buildOpenCodeReviewHistoryGraph({ rows = [] } = {}) {
  const days = new Map();
  for (const row of rows) {
    const date = localDayKey(new Date(row.createdAt));
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(row);
  }
  return { contributions: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dayRows]) => ({ date,
    clients: periodJson(dayRows).entries.map((entry) => ({ client: CLIENT, modelId: entry.model,
      tokens: { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite },
      messages: entry.messageCount })) })) };
}

function openCodeReviewHistoryRevision(rows, now) {
  const today = localDayKey(new Date(now));
  const hash = createHash('sha256');
  for (const row of rows.filter((entry) => localDayKey(new Date(entry.createdAt)) !== today)
    .sort((a, b) => a.uuid.localeCompare(b.uuid))) hash.update(JSON.stringify(row));
  return hash.digest('hex');
}

module.exports = { openCodeReviewSessionsDir, collectOpenCodeReviewRows, buildOpenCodeReviewPeriods,
  buildOpenCodeReviewHistoryGraph, openCodeReviewHistoryRevision };
