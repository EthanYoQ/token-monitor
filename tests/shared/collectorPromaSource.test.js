'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startCollector, collectUsageOnce } = require('../../src/shared/collector');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-proma-'));
  const root = path.join(homeDir, '.proma', 'agent-sessions');
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const archivePath = path.join(homeDir, 'daily-history.json');
  return { homeDir, file, archivePath };
}

function row(id, timestamp, input) {
  return JSON.stringify({ type: 'assistant', timestamp, message: { id, model: 'fixture-proma', usage: { input_tokens: input } } }) + '\n';
}

test('Proma failures retain complete periods, report failure and resume after repair', async (t) => {
  const f = fixture(t);
  let now = new Date(2026, 9, 13, 12);
  const date = '2026-10-13';
  const good = row('old', new Date(2026, 9, 12, 12).toISOString(), 10) + row('today', now.toISOString(), 123);
  fs.writeFileSync(f.file, good);
  const updates = [], errors = [];
  let claudeTokens = 5;
  const runtime = startCollector({
    homeDir: f.homeDir, now: () => now, clients: 'claude,proma', allTimeSince: '2026-01-01', deviceId: 'proma-failure',
    platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false, projectsEnabled: false,
    anchorPersistenceEnabled: false, dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: f.archivePath },
    lookupModelPricing: async () => ({}),
    runTokscale: async () => ({ entries: [{ client: 'claude', input: claudeTokens }] }),
    runGraph: async () => ({ contributions: [] }),
    onUpdate: (summary) => updates.push(summary), onError: (error) => errors.push(error)
  });
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].clients.proma), [123, 133, 133]);
  const oldObservation = Object.values(JSON.parse(fs.readFileSync(f.archivePath, 'utf8')).liveDays[date].observations).find(({ client }) => client === 'proma');
  fs.appendFileSync(f.file, row('partial', now.toISOString(), 999) + '{bad json}\n');
  assert.equal(await runtime.refreshClient('proma'), true);
  for (const full of [false, true]) {
    claudeTokens = 20;
    assert.equal(await runtime.tick(full ? 'manual' : 'watch:change', { todayOnly: !full, forceHistory: true }), true);
    const summary = updates.at(-1);
    assert.deepEqual(['today', 'month', 'allTime'].map((period) => summary[period].clients.proma), [123, 133, 133]);
    assert.equal(summary.today.clients.claude, 20);
    assert.equal(summary.clientHealth.clients.proma.collection.state, 'failed');
    assert.equal(summary.clientHealth.clients.proma.overall, 'attention');
    const archive = JSON.parse(fs.readFileSync(f.archivePath, 'utf8'));
    assert.deepEqual(Object.values(archive.liveDays[date].observations).find(({ client }) => client === 'proma'), oldObservation);
  }
  now = new Date(2026, 10, 1, 12);
  assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].clients.proma || 0), [0, 0, 133]);
  fs.writeFileSync(f.file, good + row('repaired', now.toISOString(), 7));
  assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].clients.proma), [7, 7, 140]);
  assert.equal(updates.at(-1).clientHealth.clients.proma.collection.state, 'direct');
  assert.deepEqual(errors, []);
});

test('initial Proma failure excludes partial usage while healthy clients archive normally', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, row('partial', new Date(2026, 9, 13, 12).toISOString(), 999) + '{bad json}\n');
  const statuses = [];
  const summary = await collectUsageOnce({
    homeDir: f.homeDir, now: new Date(2026, 9, 13, 12), clients: 'claude,proma', allTimeSince: '2026-01-01',
    platform: 'linux', env: {}, wslScanEnabled: false, projectsEnabled: false, includeHistory: true,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: f.archivePath },
    lookupModelPricing: async () => ({}),
    runTokscale: async () => ({ entries: [{ client: 'claude', input: 10 }] }),
    runGraph: async () => ({ contributions: [] }), onHistoryStatus: (status) => statuses.push(status)
  });
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => summary[period].totalTokens), [10, 10, 10]);
  assert.equal(summary.clientHealth.clients.proma.collection.state, 'failed');
  assert.equal(statuses.at(-1).failureCode, 'proma-history-unavailable');
  const archive = JSON.parse(fs.readFileSync(f.archivePath, 'utf8'));
  assert.deepEqual(Object.values(archive.liveDays['2026-10-13'].observations).map(({ client, tokens }) => [client, tokens]), [['claude', 10]]);
});
