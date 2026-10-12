'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { emptyPeriod } = require('../../src/shared/usage');
const { localDayKey, historyRevision } = require('../../src/shared/history');
const accountActivity = require('../../src/shared/providers/codex/accountActivity');
const aliases = require('../../src/electron/modelAliasPresentation');
const { projectLimitStatsForDisplay } = require('../../src/electron/limits/statsPresentation');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');
const { createMacWidgetSnapshotController } = require('../../src/electron/macWidget/snapshotController');
const { resolveMacWidgetHistory, macWidgetHistorySourceKey } = require('../../src/electron/macWidget/history');
const { buildMacWidgetSnapshot } = require('../../src/shared/macWidgetSnapshot');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const nowMs = new Date(2026, 9, 13, 12).getTime();
let fixtureId = 0;

function harness(options = {}) {
  const period = { ...emptyPeriod(), totalTokens: 100, costUsd: 1, clients: { codex: 100 },
    clientCosts: { codex: 1 }, models: { 'gpt-5': 100 }, modelCosts: { 'gpt-5': 1 } };
  const raw = { historyRevision: 'raw', periods: { today: period, month: period, allTime: period } };
  const row = { tokens: 100, cost: 1, perClient: { codex: { tokens: 100, cost: 1 } }, perModel: { 'gpt-5': { tokens: 100, cost: 1 } } };
  const history = { daily: [{ date: '2026-10-13', ...row }], monthly: [{ month: '2026-10', ...row }], summary: {} };
  const snapshot = { source: 'codex-app-server', accountKey: 'fixture', dailyCoverageComplete: true,
    fetchedAt: new Date(nowMs).toISOString(), lifetimeTokens: 200, dailyUsageBuckets: [{ date: '2026-10-13', tokens: 200 }] };
  const settings = { clients: 'codex', codexAccountActivityEnabled: true, allTimeSince: '2024-01-01', deviceId: 'local', ...options.settings };
  const saved = [];
  const published = [];
  const presented = [];
  const errors = [];
  const hubUrl = `https://fixture-${++fixtureId}.invalid`;
  class ClockDate extends Date { static now() { return nowMs; } }
  const context = vm.createContext({
    ...accountActivity, ...aliases, settings, latestStats: raw, Date: ClockDate,
    localDayKey, historyRevision, createStatsPresentationCache, createMacWidgetSnapshotController,
    resolveMacWidgetHistory, macWidgetHistorySourceKey, projectLimitStatsForDisplay,
    presentationCache: createStatsPresentationCache(),
    codexAccountActivity: { snapshot: () => options.noAccount ? null : snapshot,
      multipleAccounts: () => options.multipleAccounts === true, readState: () => options.readState || null },
    syncProvenanceActive: () => true, presentationHistoryForStats: () => history,
    macWidgetRuntimeSupported: () => true, macWidgetSnapshotController: null, macWidgetPublicationReady: true,
    macWidgetDemand: null, macWidgetConfiguration: () => ({ snapshotPath: '/fixture/snapshot.json', widgetKind: 'fixture' }),
    historyResolverOptions: () => ({ hubMode: 'client', historyEnabled: true, hubUrl }),
    completeHistorySource: () => 'remote', resolveCompleteHistory: () => options.resolveHistory?.(history) || history,
    app: { getPath: () => '/fixture' }, macWidgetHistoryCachePath: () => '/fixture/history.json',
    readMacWidgetHistoryCache: async () => null,
    writeMacWidgetHistoryCache: async (_path, _key, value) => saved.push(structuredClone(value)),
    macWidgetActiveCodexAccount: () => null, macWidgetPresentation: () => ({}),
    prepareMacWidgetSnapshotUpdate(stats, value) {
      presented.push(stats);
      return { ok: true, changed: true, prepared: buildMacWidgetSnapshot(stats, { now: nowMs, ...value.snapshotOptions }) };
    },
    commitMacWidgetSnapshot(value, guard) {
      if (!guard.isCurrent()) return { ok: false };
      published.push(value);
      return { ok: true, changed: true };
    },
    syncMacWidgetSnapshotDirectory: async () => {}, discardMacWidgetSnapshot: async () => {},
    requestMacWidgetReload: () => {}, console: { warn: (message) => errors.push(message) }
  });
  for (const name of ['captureAccountUsagePresentation', 'electronPresentationStats', 'captureMacWidgetWork',
    'ensureMacWidgetSnapshotController', 'captureMacWidgetProducerOwner', 'advanceMacWidgetSourceEpoch',
    'refreshMacWidgetHistorySource', 'scheduleMacWidgetSnapshot']) {
    const source = main.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
    if (source) vm.runInContext(source, context);
  }
  return { raw, history, settings, saved, published, presented, errors, context,
    start() { vm.runInContext('refreshMacWidgetHistorySource()', context); },
    idle() { return vm.runInContext('ensureMacWidgetSnapshotController().whenIdle()', context); } };
}

test('Mac controller projects overview, Activity and Trend from one account while retaining local detail and raw history', async () => {
  const h = harness();
  h.start();
  await h.idle();
  assert.deepEqual(h.errors, []);
  const snapshot = h.published[0];
  assert.equal(snapshot.periods.month.overview.totalTokens, 200);
  assert.equal(snapshot.periods.month.activity.days[0].totalTokens, 200);
  assert.equal(snapshot.periods.month.trend.points.at(-1).totalTokens, 200);
  assert.equal(snapshot.periods.total.trend.points[0].totalTokens, 200);
  assert.equal(snapshot.periods.month.models[0].totalTokens, 100);
  assert.equal(snapshot.periods.month.overview.costUsd, 1);
  assert.equal(h.presented[0].codexAccountActivity.localDetailTokens, 100);
  assert.equal(h.raw.periods.allTime.totalTokens, 100);
  assert.equal(h.history.daily[0].tokens, 100);
  assert.equal(h.saved[0].daily[0].tokens, 100);
});

test('Mac controller retains local values for disabled, ambiguous and uncovered account policies', async () => {
  for (const options of [{ settings: { codexAccountActivityEnabled: false } },
    { multipleAccounts: true }, { settings: { allTimeSince: '2026-10-14' } }]) {
    const h = harness(options);
    h.start();
    await h.idle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.published[0].periods.month.overview.totalTokens, 100);
    assert.equal(h.published[0].periods.month.activity.days[0].totalTokens, 100);
  }
});

test('Mac controller captures account policy and raw statistics before waiting for history', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({ resolveHistory: () => wait });
  h.start();
  await new Promise((resolve) => setImmediate(resolve));
  h.settings.codexAccountActivityEnabled = false;
  h.settings.allTimeSince = '2026-10-14';
  h.context.latestStats = { periods: { allTime: { totalTokens: 999 } } };
  release(h.history);
  await h.idle();
  assert.deepEqual(h.errors, []);
  assert.equal(h.published[0].periods.month.overview.totalTokens, 200);
  assert.equal(h.published[0].periods.month.activity.days[0].totalTokens, 200);
  assert.equal(h.presented[0].codexAccountActivity.localDetailTokens, 100);
});

test('Mac controller preserves unavailable account state and captured local quota policy', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({ noAccount: true, readState: { readStatus: 'failed' }, resolveHistory: () => wait });
  h.raw.limits = { providers: [{ provider: 'opencode', source: 'local', sourceDeviceId: 'local',
    status: 'ok', windows: [{ kind: 'session', source: 'local', usedPercent: 25 }] }] };
  h.start();
  await new Promise((resolve) => setImmediate(resolve));
  h.settings.opencodeLocalLimitsEnabled = true;
  release(h.history);
  await h.idle();
  assert.deepEqual(h.errors, []);
  assert.equal(h.presented[0].codexAccountActivity.status, 'unavailable');
  assert.equal(h.presented[0].codexAccountActivity.readStatus, 'failed');
  assert.equal(h.presented[0].limits.providers[0].status, 'disabled');
  assert.deepEqual(h.presented[0].limits.providers[0].windows, []);
  assert.equal(h.raw.limits.providers[0].status, 'ok');
});

test('a source change rejects a delayed account projection before publishing local fallback', async () => {
  let release;
  let reads = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = harness({ resolveHistory: (history) => ++reads === 1 ? wait : history });
  h.start();
  await new Promise((resolve) => setImmediate(resolve));
  h.settings.codexAccountActivityEnabled = false;
  h.start();
  release(h.history);
  await h.idle();
  assert.deepEqual(h.errors, []);
  assert.equal(h.published.length, 1);
  assert.equal(h.published[0].periods.month.overview.totalTokens, 100);
  assert.equal(h.published[0].periods.month.activity.days[0].totalTokens, 100);
});
