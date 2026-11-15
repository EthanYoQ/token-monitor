'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { localDayKey } = require('../../history');

const CLIENT = 'pagekin';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PROJECT_DB = 'project.db';
const FREEZE = 'portable-runtime-freeze.json';
const AUTHORITY = 'portable-transfer-authority.json';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sourceRoot({ homeDir = os.homedir(), env = process.env, platform = process.platform } = {}) {
  if (env.AI_NOVEL_APP_DATA_HOME) return path.resolve(env.AI_NOVEL_APP_DATA_HOME);
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'ai-novel-writer-data');
  }
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'ai-novel-writer-data');
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'ai-novel-writer-data');
}

function pagekinSources(options = {}) {
  const root = sourceRoot(options);
  const receiptPath = path.join(root, '.migration', 'receipt.json');
  if (options.metadataOnly) return { receiptPath, indexPath: null, databases: [] };
  const receipt = readJson(receiptPath);
  if (receipt !== undefined && (receipt?.version !== 1 || receipt.completed !== true || !UUID.test(receipt.generation || ''))) {
    throw new Error('Invalid Pagekin data receipt');
  }
  const indexPath = receipt ? path.join(root, 'generations', receipt.generation, 'recent-projects.json') : null;
  const projects = (indexPath ? readJson(indexPath) : undefined) ?? [];
  if (!Array.isArray(projects)) throw new Error('Invalid Pagekin project index');
  const paths = [...projects.map((project) => project?.path), ...(options.projectPaths || [])];
  const databases = [...new Set(paths.filter((project) => typeof project === 'string' && path.isAbsolute(project))
    .map((project) => path.join(project, '.ai-novel', PROJECT_DB)))];
  return { receiptPath, indexPath, databases };
}

function portableAttempts(directory) {
  const freeze = readJson(path.join(directory, FREEZE));
  if (freeze === undefined && !fs.existsSync(path.join(directory, AUTHORITY))) return new Set();
  if (freeze?.version !== 1 || freeze.nonReplayable !== true || freeze.requiresRuntimeFreezeGuard !== true
    || !Array.isArray(freeze.records)) throw new Error('Invalid Pagekin transfer history');
  const attempts = new Set();
  for (const record of freeze.records) {
    if (record?.table !== 'generation_attempts') continue;
    if (!UUID.test(record.recordId || '')) throw new Error('Invalid Pagekin transfer attempt');
    attempts.add(record.recordId.toLowerCase());
  }
  return attempts;
}

function numericCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

const ATTEMPT_ROWS = `
  SELECT a.attempt_id AS id,
    json_extract(r.binding_json, '$.sourceManifest.modelReceipt.modelName') AS model,
    json_extract(a.usage_receipt_json, '$.result.diagnostics.startedAt') AS createdAt,
    json_extract(a.usage_receipt_json, '$.result.usage.inputTokens') AS input,
    json_extract(a.usage_receipt_json, '$.result.usage.completionTokens') AS completion,
    json_extract(a.usage_receipt_json, '$.result.usage.reasoningTokens') AS reasoning,
    json_extract(a.usage_receipt_json, '$.result.usage.actualTokens') AS total
  FROM generation_attempts a JOIN generation_runs r ON a.run_id = r.run_id
  WHERE json_type(a.usage_receipt_json, '$.result.usage.trusted') = 'true'
  ORDER BY a.attempt_id
`;

function collectPagekinRows(options) {
  const unique = new Map();
  for (const database of pagekinSources(options).databases) {
    let info;
    try { info = fs.statSync(database); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) continue;
    const frozen = portableAttempts(path.dirname(database));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(database, { readOnly: true, allowExtension: false });
    try {
      const tables = db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type = 'table' AND name IN ('generation_attempts','generation_runs')").get().n;
      if (tables === 0) continue;
      if (tables !== 2) throw new Error('Incomplete Pagekin attempt schema');
      for (const { id, model, createdAt, total, input, completion, reasoning } of db.prepare(ATTEMPT_ROWS).iterate()) {
        if (!UUID.test(id || '') || typeof model !== 'string' || !model.trim() || model.length > 256
          || !numericCount(createdAt) || createdAt === 0 || createdAt > 8.64e15
          || !numericCount(total) || total === 0 || !numericCount(input) || !numericCount(completion)) continue;
        const output = total - input;
        if (output !== completion && !(numericCount(reasoning) && output === completion + reasoning)) continue;
        const identity = id.toLowerCase();
        if (frozen.has(identity)) continue;
        const row = { createdAt, model: model.trim(), totalTokens: total, input, output };
        const previous = unique.get(identity);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting Pagekin attempt receipts');
        unique.set(identity, row);
      }
    } finally {
      db.close();
    }
  }
  return [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([identity, row]) => ({
    ...row, sessionId: createHash('sha256').update(identity).digest('hex')
  }));
}

function pagekinHistoryRevision(rows, todayKey) {
  const hash = createHash('sha256');
  for (const row of rows) {
    if (localDayKey(new Date(row.createdAt)) < todayKey) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

function buildPagekinUsage(rows, now, allTimeSince) {
  const todayKey = localDayKey(now);
  const month = todayKey.slice(0, 7);
  const periods = { today: { entries: [] }, month: { entries: [] }, allTime: { entries: [] } };
  const days = new Map();
  for (const { createdAt, model, totalTokens, input, output, sessionId } of rows) {
    if (createdAt > now.getTime()) continue;
    const date = localDayKey(new Date(createdAt));
    const startedAt = new Date(createdAt).toISOString();
    const row = { client: CLIENT, sessionId, model, totalTokens, input, output, messageCount: 1, startedAt, lastUsedAt: startedAt };
    if (date === todayKey) periods.today.entries.push(row);
    if (date.startsWith(month)) periods.month.entries.push(row);
    if (date < allTimeSince) continue;
    periods.allTime.entries.push(row);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ client: CLIENT, modelId: model, tokens: { input, output }, messages: 1 });
  }
  return { periods, graph: { contributions: [...days].map(([date, clients]) => ({ date, clients })) } };
}

module.exports = { buildPagekinUsage, collectPagekinRows, pagekinHistoryRevision, pagekinSources, PROJECT_DB, FREEZE, AUTHORITY };
