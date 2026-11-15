'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { collectUsageOnce, configFingerprint, startCollector, watchIgnoreMatcher, watchAttributionRootsForClients } = require('../../src/shared/collector');
const { tokscaleExtraDirsEnv } = require('../../src/shared/customScanPaths');
const { collectPagekinRows } = require('../../src/shared/providers/pagekin/usage');

const generation = 'f886eb24-e01b-4bab-8a74-8b45b458fb8c';
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const model = 'deepseek-ai/DeepSeek-V4.1-Flash';
const now = new Date(2026, 10, 15, 18);
const today = new Date(2026, 10, 15, 14).getTime();
const yesterday = new Date(2026, 10, 14, 14).getTime();
const october = new Date(2026, 9, 9, 14).getTime();

function createProject(directory) {
  const project = path.join(directory, '.ai-novel');
  fs.mkdirSync(project, { recursive: true });
  const db = new DatabaseSync(path.join(project, 'project.db'));
  db.exec(`
    CREATE TABLE generation_runs (run_id TEXT PRIMARY KEY, binding_json TEXT);
    CREATE TABLE generation_attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT, usage_receipt_json TEXT);
    CREATE TABLE llm_calls (total_tokens INTEGER);
    INSERT INTO llm_calls VALUES (999999);
  `);
  db.prepare('INSERT INTO generation_runs VALUES (?, ?)').run('run', JSON.stringify({
    sourceManifest: { modelReceipt: { modelName: model } }
  }));
  return db;
}

function insert(db, n, startedAt, totalTokens, trusted = true, reasoning = 0) {
  db.prepare('INSERT INTO generation_attempts VALUES (?, ?, ?)').run(id(n), 'run', JSON.stringify({
    result: {
      usage: { trusted, actualTokens: totalTokens, inputTokens: totalTokens - 10, completionTokens: 10 - reasoning, reasoningTokens: reasoning },
      diagnostics: { startedAt }
    }
  }));
}

function fixture(t) {
  const cacheDir = path.resolve(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(cacheDir, 'pagekin-test-'));
  const env = { AI_NOVEL_APP_DATA_HOME: root };
  const put = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  put(path.join(root, '.migration', 'receipt.json'), { version: 1, generation, completed: true });
  const native = path.join(root, 'native');
  const copy = path.join(root, 'copy');
  put(path.join(root, 'generations', generation, 'recent-projects.json'), [{ path: native }, { path: copy }]);
  const nativeDb = createProject(native);
  const copyDb = createProject(copy);
  insert(nativeDb, 1, today, 100);
  insert(nativeDb, 2, yesterday, 120, true, 2);
  insert(nativeDb, 3, october, 200);
  insert(nativeDb, 4, today, 900, false);
  insert(copyDb, 1, today, 100);
  insert(copyDb, 5, today, 800);
  put(path.join(copy, '.ai-novel', 'portable-runtime-freeze.json'), {
    version: 1, nonReplayable: true, requiresRuntimeFreezeGuard: true,
    records: [{ table: 'generation_attempts', recordId: id(5) }]
  });
  copyDb.close();
  t.after(() => {
    nativeDb.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(cacheDir));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { env, native, nativeDb, root, copy };
}

test('Pagekin contributes one native receipt per attempt and uses one source for periods and graph', async (t) => {
  const { env, root, native } = fixture(t);
  const additional = path.join(root, 'additional, local');
  const additionalDb = createProject(additional);
  insert(additionalDb, 6, october, 40);
  additionalDb.close();
  const options = {
    clients: 'pagekin,claude', now, allTimeSince: '2026-10-01', env,
    customScanPaths: { pagekin: [native, additional] },
    includeHistory: true, wslScanEnabled: false,
    runTokscale: async ({ clients, flags }) => {
      assert.equal(clients, 'claude');
      return { entries: [{ client: 'claude', model, input: flags.includes('--today') ? 7 : 17 }] };
    },
    runGraph: async () => ({ contributions: [] })
  };
  assert.equal(tokscaleExtraDirsEnv(options.customScanPaths), '');
  const summary = await collectUsageOnce(options);
  for (const [period, usage, claude] of [['today', 100, 7], ['month', 220, 17], ['allTime', 460, 17]]) {
    assert.equal(summary[period].totalTokens, usage + claude);
    assert.deepEqual(summary[period].clients, { pagekin: usage, claude });
    assert.equal(summary[period].clientModels.pagekin[model.toLowerCase()], usage);
  }
  assert.deepEqual(summary.history.daily.map((day) => [day.date, day.perClient.pagekin.tokens]),
    [['2026-10-09', 240], ['2026-11-14', 120], ['2026-11-15', 100]]);
  assert.equal(Object.keys(summary.allTime.sessions).length, 4);
  assert.equal(summary.clientHealth.clients.pagekin.overall, 'healthy');
});

test('Pagekin watch reads replace today and invalidates the anchor for a newly indexed old receipt', async (t) => {
  const { env, nativeDb } = fixture(t);
  let anchor;
  let capture;
  const options = {
    clients: 'pagekin', now, allTimeSince: '2026-10-01', env, wslScanEnabled: false,
    onAnchorComputed: (result) => { capture = result; }
  };
  const previous = await collectUsageOnce(options);
  anchor = { ...capture.windowsPeriods, dateKey: '2026-11-15', todayPartitions: capture.todayPartitions, pagekinRevision: capture.pagekinRevision };
  insert(nativeDb, 8, today, 70);
  const live = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['pagekin'] });
  assert.equal(capture.fullScan, false);
  assert.equal(live.today.totalTokens, previous.today.totalTokens + 70);
  assert.equal(live.month.totalTokens, previous.month.totalTokens + 70);
  assert.equal(live.allTime.totalTokens, previous.allTime.totalTokens + 70);
  insert(nativeDb, 9, october, 90);
  const recovered = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: ['pagekin'] });
  assert.equal(capture.fullScan, true);
  assert.equal(recovered.today.totalTokens, live.today.totalTokens);
  assert.equal(recovered.month.totalTokens, live.month.totalTokens);
  assert.equal(recovered.allTime.totalTokens, live.allTime.totalTokens + 90);
});

test('Pagekin watch paths include SQLite WAL and skip Pagekin-owned non-source files', (t) => {
  const { env, native } = fixture(t);
  const dataDir = path.join(native, '.ai-novel');
  const db = path.join(dataDir, 'project.db');
  const ignore = watchIgnoreMatcher('pagekin', { env });
  assert.equal(ignore(db), false);
  assert.equal(ignore(db + '-wal'), false);
  assert.equal(ignore(db + '-shm'), true);
  assert.equal(ignore(path.join(dataDir, 'chapter.md')), true);
  const paths = watchAttributionRootsForClients('pagekin', null, { env }).pagekin;
  assert.ok(paths.includes(db + '-wal'));
  assert.ok(!paths.includes(db + '-shm'));
});

test('Pagekin accepts an empty migration without an index and rejects a missing required index', (t) => {
  const { env, root } = fixture(t);
  const receiptPath = path.join(root, '.migration', 'receipt.json');
  const indexPath = path.join(root, 'generations', generation, 'recent-projects.json');
  const receipt = { version: 1, generation, completed: true };
  fs.unlinkSync(indexPath);
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, requiredObjects: [] }));
  assert.deepEqual(collectPagekinRows({ env }), []);
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, requiredObjects: ['recent-projects.json'] }));
  assert.throws(() => collectPagekinRows({ env }), /Missing required Pagekin project index/);
  fs.writeFileSync(indexPath, '[]');
  assert.deepEqual(collectPagekinRows({ env }), []);
});

test('Pagekin keeps index and configured database watch paths through a failed index read', async (t) => {
  const { env, root, native } = fixture(t);
  const options = {
    clients: 'pagekin', now, allTimeSince: '2026-10-01', env, pagekinState: {}, wslScanEnabled: false,
    customScanPaths: { pagekin: [native] }
  };
  const indexPath = path.join(root, 'generations', generation, 'recent-projects.json');
  const original = fs.readFileSync(indexPath, 'utf8');
  fs.writeFileSync(path.join(root, '.migration', 'receipt.json'), JSON.stringify({
    version: 1, generation, completed: true, requiredObjects: ['recent-projects.json']
  }));
  const baseline = await collectUsageOnce(options);
  fs.unlinkSync(indexPath);
  const missing = await collectUsageOnce(options);
  assert.equal(missing.clientHealth.clients.pagekin.collection.state, 'failed');
  assert.equal(missing.allTime.totalTokens, baseline.allTime.totalTokens);
  fs.writeFileSync(indexPath, '{');
  const paths = watchAttributionRootsForClients('pagekin', null, options).pagekin;
  assert.ok(paths.includes(indexPath));
  assert.ok(paths.includes(path.join(native, '.ai-novel', 'project.db-wal')));
  fs.writeFileSync(indexPath, original);
  const recovered = await collectUsageOnce(options);
  assert.equal(recovered.clientHealth.clients.pagekin.overall, 'healthy');
  assert.equal(recovered.allTime.totalTokens, baseline.allTime.totalTokens);
});

test('a missing Pagekin transfer freeze fails closed and keeps the last readable usage', async (t) => {
  const { env, native } = fixture(t);
  const options = { clients: 'pagekin', now, allTimeSince: '2026-10-01', env, pagekinState: {}, wslScanEnabled: false };
  const baseline = await collectUsageOnce(options);
  fs.writeFileSync(path.join(native, '.ai-novel', 'portable-transfer-authority.json'), '{}');
  assert.throws(() => collectPagekinRows({ env }), /Invalid Pagekin transfer history/);
  const retained = await collectUsageOnce(options);
  assert.equal(retained.allTime.totalTokens, baseline.allTime.totalTokens);
  assert.equal(retained.clientHealth.clients.pagekin.collection.state, 'failed');
});

test('Pagekin keeps its three period totals on a failed cold-start read while other clients update', async (t) => {
  const { env, native, nativeDb } = fixture(t);
  let capture;
  let claudeTokens = 7;
  const options = {
    clients: 'pagekin,claude', now, allTimeSince: '2026-10-01', env, wslScanEnabled: false,
    onAnchorComputed: (result) => { capture = result; },
    runTokscale: async () => ({ entries: [{ client: 'claude', model, input: claudeTokens }] })
  };
  await collectUsageOnce(options);
  const anchor = {
    ...capture.windowsPeriods, dateKey: '2026-11-15', pagekinRevision: capture.pagekinRevision, todayPartitions: null
  };
  const authority = path.join(native, '.ai-novel', 'portable-transfer-authority.json');
  fs.writeFileSync(authority, '{}');
  claudeTokens = 17;
  for (const key of ['todayOnlyAnchor', 'pagekinFallbackAnchor']) {
    const failed = await collectUsageOnce({ ...options, [key]: anchor, pagekinState: {} });
    assert.equal(failed.clientHealth.clients.pagekin.collection.state, 'failed');
    for (const [period, pagekin] of [['today', 100], ['month', 220], ['allTime', 420]]) {
      assert.deepEqual(failed[period].clients, { pagekin, claude: 17 }, `${key} ${period}`);
    }
  }
  fs.unlinkSync(authority);
  insert(nativeDb, 6, today, 40);
  const recovered = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, pagekinState: {} });
  assert.equal(recovered.clientHealth.clients.pagekin.overall, 'healthy');
  for (const [period, pagekin] of [['today', 140], ['month', 260], ['allTime', 460]]) {
    assert.deepEqual(recovered[period].clients, { pagekin, claude: 17 });
  }
});

test('Pagekin reuses historical receipts from a persisted snapshot after midnight if the source cannot be read', async (t) => {
  const { env, native, root } = fixture(t);
  const clients = 'pagekin';
  const allTimeSince = '2026-10-01';
  const options = { clients, allTimeSince, env, wslScanEnabled: false, historyEnabled: false, watchEnabled: false, limitsEnabled: false };
  let snapshot;
  await collectUsageOnce({ ...options, now, onAnchorComputed: (result) => { snapshot = result; } });
  fs.writeFileSync(path.join(root, 'collector-anchor.json'), JSON.stringify({
    ...snapshot.windowsPeriods,
    dateKey: '2026-11-15',
    fullScanAt: now.toISOString(),
    configFingerprint: configFingerprint(clients, allTimeSince)
  }));
  fs.writeFileSync(path.join(native, '.ai-novel', 'portable-transfer-authority.json'), '{}');
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 16, 9) });
  const original = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = root;
  t.after(() => {
    if (original === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = original;
  });
  let collector;
  const summary = await new Promise((resolve) => {
    collector = startCollector({ ...options, intervalMs: 60_000, onUpdate: resolve });
    t.after(() => collector.stop());
  });
  assert.equal(summary.clientHealth.clients.pagekin.collection.state, 'failed');
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.month.clients.pagekin, 220);
  assert.equal(summary.allTime.clients.pagekin, 420);
});
