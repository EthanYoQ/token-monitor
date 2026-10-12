'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeHistory, mergeHistories, coerceHistory, dayKeyAddDays } = require('../../src/shared/history');
const { emptyPeriod } = require('../../src/shared/usage');
const accountApi = require('../../src/shared/providers/codex/accountActivity');
const home = require('../../src/electron/renderer/homeOverview');
const fixed = require('../../src/electron/renderer/fixedPeriodRanges');

const today = '2026-10-11';
const nowMs = new Date(2026, 9, 11, 12).getTime();
function account(buckets, summary = {}) {
  return accountApi.normalizeAccountActivity({ codexAccountActivity: {
    status: 'available', source: 'codex-app-server', fetchedAt: new Date(nowMs).toISOString(),
    lifetimeTokens: buckets.reduce((sum, row) => sum + row.tokens, 0),
    dailyUsageBuckets: buckets.map(({ date, tokens }) => ({ startDate: date, tokens })), ...summary
  } }, 'account-a');
}
function localStats(tokens = 100) {
  const period = { ...emptyPeriod(), totalTokens: tokens, clients: { codex: tokens } };
  return { periods: { today: period, month: period, allTime: period }, historyRevision: 'unchanged' };
}
function day(date, tokens, client = 'claude') {
  return { date, tokens, cost: 1, activeTimeMs: 1000, perClient: { [client]: { tokens, cost: 1 } }, perModel: { local: { tokens, cost: 1 } } };
}
function present(localHistory, snapshot, stats = localStats()) {
  const shown = accountApi.applyAccountActivityToStats(stats, snapshot, '2020-01-01', '', true, nowMs, localHistory);
  return { stats: shown, history: accountApi.projectAccountActivityToHistory(localHistory, snapshot, shown, { nowMs }) };
}

test('official summary preserves zero, missing values and source numbers', () => {
  const snapshot = account([{ date: today, tokens: 100 }], {
    peakDailyTokens: 3491112225, longestRunningTurnSec: 93962, currentStreakDays: 0, longestStreakDays: 100
  });
  assert.deepEqual(snapshot.summary, { peakDailyTokens: 3491112225, longestRunningTurnSec: 93962,
    currentStreakDays: 0, longestStreakDays: 100 });
  const missing = account([{ date: today, tokens: 100 }]);
  assert.deepEqual(missing.summary, { peakDailyTokens: null, longestRunningTurnSec: null,
    currentStreakDays: null, longestStreakDays: null });
  const shown = accountApi.applyAccountActivityToStats(localStats(), snapshot, '2020-01-01', '', true, nowMs + 7200000);
  assert.equal(shown.codexAccountActivity.status, 'stale');
  assert.deepEqual(shown.codexAccountActivity.summary, snapshot.summary);
});

test('rejected account projection retains the latest failed read for refresh feedback', () => {
  const snapshot = { ...account([{ date: today, tokens: 100 }]), readStatus: 'failed', lastAttemptAt: new Date(nowMs).toISOString() };
  const cases = [
    { singleAccount: false, expected: 'scope-unverified' },
    { allTimeSince: '2026-10-12', expected: 'range-unverified' },
    { localStats: { ...localStats(), devices: [{ deviceId: 'remote', periods: localStats().periods }] }, expected: 'scope-unverified' },
    { localStats: { periods: { allTime: { ...emptyPeriod(), totalTokens: 10, clients: { codex: 20 } } } }, expected: 'conflict' }
  ];
  for (const { expected, ...overrides } of cases) {
    const shown = accountApi.presentUsage({ localStats: localStats(), account: snapshot, allTimeSince: '2020-01-01', nowMs, ...overrides });
    assert.equal(shown.stats.codexAccountActivity.status, expected);
    assert.equal(shown.stats.codexAccountActivity.readStatus, 'failed');
    assert.equal(shown.stats.codexAccountActivity.lastAttemptAt, snapshot.lastAttemptAt);
  }
});

test('official projection cannot turn missing device history into a complete fixed range', () => {
  const history = { daily: [day(today, 100)], codexAccountActivity: { status: 'applied' } };
  const shown = fixed.fixedPeriodSnapshotForPresentation('last7', [
    { deviceId: 'remote', historyAvailable: false, periods: { allTime: { totalTokens: 200, clients: { claude: 200 } } } }
  ], history, { todayKey: today, historyEnabled: true, historyAvailable: true });
  assert.equal(shown.status, 'unavailable');
  assert.equal(shown.reason, 'historyUnavailable');
  assert.equal(shown.period, null);
});

test('500-day local history retains lifetime dates and old peak through cache and merge', () => {
  const rows = Array.from({ length: 500 }, (_, index) => day(dayKeyAddDays(today, index - 499), index === 0 ? 9999 : 1));
  const normalized = normalizeHistory({ contributions: rows }, { todayKey: today });
  const restored = coerceHistory(JSON.parse(JSON.stringify(normalized)));
  const merged = mergeHistories([restored], { todayKey: today });
  assert.equal(merged.daily.length, 370);
  assert.equal(merged.summary.activeDays, 500);
  assert.equal(merged.summary.peakDayTokens, 9999);
  const shown = present(merged, account([{ date: today, tokens: 10 }]), {
    ...localStats(), periods: { allTime: { ...emptyPeriod(), totalTokens: 10498, clients: { claude: 10498 } } }
  });
  assert.equal(shown.history.summary.activeDays, 500);
  assert.equal(shown.history.summary.peakDayTokens, 9999);
  assert.equal(shown.history.summary.longestStreak, 500);
  assert.equal(shown.stats.historyPreview.summary.activeDays, 500);
  assert.equal(shown.history.tokenDays, undefined, 'complete date evidence stays out of presentation payloads');
});

test('official zero breaks a local streak while the account summary remains authoritative', () => {
  const history = normalizeHistory({ contributions: [day('2026-10-09', 10, 'codex'), day('2026-10-10', 10, 'codex'), day(today, 10, 'codex')] }, { todayKey: today });
  const snapshot = account([{ date: '2026-10-09', tokens: 10 }, { date: '2026-10-10', tokens: 0 }, { date: today, tokens: 10 }], { currentStreakDays: 100, longestStreakDays: 100 });
  const shown = present(history, snapshot);
  assert.equal(shown.history.summary.longestStreak, 1);
  assert.equal(shown.stats.codexAccountActivity.summary.currentStreakDays, 100);
  assert.equal(home.activityStatsForPeriod({ period: 'allTime', historySummary: shown.history.summary,
    codexAccountActivity: shown.stats.codexAccountActivity }).currentStreak, 1);
});

test('account-only refresh changes history revision and preview, with fixed totals from the same dates', () => {
  const history = normalizeHistory({ contributions: [day(today, 10, 'codex')] }, { todayKey: today });
  const first = present(history, account([{ date: today, tokens: 50 }]));
  const second = present(history, account([{ date: '2026-10-10', tokens: 40 }, { date: today, tokens: 60 }]));
  assert.notEqual(first.stats.historyRevision, second.stats.historyRevision);
  assert.equal(home.shouldFetchHomeHistory({ requested: true, lastSignature: home.homeHistorySignature(first.stats), stats: second.stats }), true);
  assert.deepEqual(second.stats.historyPreview.daily.map(row => row.tokens), [40, 60]);
  const selected = fixed.fixedPeriodSnapshot('last7', { daily: second.history.daily, historyAvailable: true, todayKey: today });
  assert.equal(selected.period.totalTokens, 100);
  assert.equal(second.stats.periods.allTime.totalTokens, 100);
});

test('mixed legacy history labels daily metrics as retained-window evidence', () => {
  const complete = normalizeHistory({ contributions: [day(today, 5)] }, { todayKey: today });
  const legacy = { daily: [day('2026-10-10', 10)], monthly: [], summary: { activeDays: 500 } };
  const merged = mergeHistories([complete, legacy], { todayKey: today });
  assert.equal(merged.summary.dateMetricsScope, 'retained');
  assert.equal(merged.summary.activeDays, 2);
});

test('model shares use all local model rows even when official headline is smaller and list is capped', () => {
  const rows = [{ key: 'a', value: 120 }, { key: 'b', value: 80 }];
  const shown = home.homeModelRows(rows, 1);
  assert.equal(shown[0].value, 120);
  assert.equal(shown[0].share, 0.6);
});



test('account command tries a working native directory after an unavailable candidate without mutating PATH', async () => {
  const { readCodexAccountActivity } = require('../../src/shared/collector');
  const env = { Path: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\test\\Local' };
  const original = { ...env };
  const calls = [];
  const result = await readCodexAccountActivity({
    env, platform: 'win32', command: { bin: 'tokscale.exe', prefixArgs: [], env },
    existsSync: value => /OpenAI[\\/]Codex[\\/]bin/.test(value),
    readdirSync: value => value.endsWith('bin') ? ['version-a'] : [],
    runCommand: async (_args, timeout, command) => {
      calls.push({ path: command.env.Path, timeout });
      return calls.length === 1 ? { codexAccountActivity: { status: 'unavailable' } }
        : { codexAccountActivity: { status: 'available', lifetimeTokens: 100 } };
    }
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /version-a/);
  assert.equal(result.codexAccountActivity.lifetimeTokens, 100);
  assert.deepEqual(env, original);
});

test('account command stops retries when the overall budget expires or cancellation arrives', async () => {
  const { readCodexAccountActivity } = require('../../src/shared/collector');
  let clock = 0;
  let calls = 0;
  const controller = new AbortController();
  const options = {
    commandTimeoutMs: 10, now: () => clock, signal: controller.signal,
    env: { LOCALAPPDATA: 'C:\\local', Path: '' }, platform: 'win32',
    command: { bin: 'tokscale.exe', prefixArgs: [], env: {} }, existsSync: () => true,
    readdirSync: () => [],
    runCommand: async (_args, timeout) => { calls++; assert.ok(timeout <= 10); clock += 11; return { codexAccountActivity: { status: 'unavailable' } }; }
  };
  await assert.rejects(readCodexAccountActivity(options), /timed out/);
  assert.equal(calls, 1);
  calls = 0; clock = 0;
  options.runCommand = async () => { calls++; controller.abort(); return { codexAccountActivity: { status: 'unavailable' } }; };
  await assert.rejects(readCodexAccountActivity(options), /abort/i);
  assert.equal(calls, 1);
});


test('official cards preserve unknown, zero and seconds while fixed ranges retain local devices', () => {
  const { accountStatsCards } = require('../../src/electron/renderer/usageCharts');
  const cards = accountStatsCards({ status: 'stale', summary: { currentStreakDays: 0, longestRunningTurnSec: 93962 } });
  assert.deepEqual(cards.map(card => card.value), [0, null, null, 93962000]);
  const local = normalizeHistory({ contributions: [day(today, 5, 'codex')] }, { todayKey: today });
  const shown = present(local, account([{ date: today, tokens: 20 }]));
  const sources = [{ deviceId: 'pc', historyAvailable: true, history: local, periodWindows: { today: { key: today, endsAt: '2026-10-12T00:00:00Z' }, timeZone: 'UTC' }, periods: { today: { totalTokens: 5, clients: { codex: 5 } }, allTime: { totalTokens: 5 } } }];
  const selected = fixed.fixedPeriodSnapshotForPresentation('last7', sources, shown.history, { todayKey: today, now: nowMs, historyAvailable: true });
  assert.equal(selected.period.totalTokens, 20);
  assert.equal(selected.daily.at(-1).tokens, 20);
  assert.equal(selected.devices[0].period.totalTokens, 5);
});

test('complete date evidence stays in local cache and out of device uploads', () => {
  const { syncPayload } = require('../../src/shared/syncPayload');
  const history = normalizeHistory({ contributions: [day(today, 10)] }, { todayKey: today });
  const payload = syncPayload({ deviceId: 'pc', historyAvailable: true, history, today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() });
  assert.equal(history.tokenDays.length, 1);
  assert.equal(payload.history.tokenDays, undefined);
  assert.equal(payload.history.coverage, undefined);
  assert.equal(payload.history.daily[0].tokens, 10);
});


test('missing official today keeps newer local Day distinct from the retained chart without adding a lifetime tail', () => {
  const history = normalizeHistory({ contributions: [day(today, 10, 'codex')] }, { todayKey: today });
  const snapshot = account([{ date: '2026-10-10', tokens: 1000 }]);
  const shown = present(history, snapshot, localStats(20));
  assert.equal(shown.stats.periods.today.totalTokens, 20);
  assert.equal(shown.stats.codexAccountActivity.periods.today.headlineSource, 'local');
  assert.equal(shown.history.daily.find(row => row.date === today).tokens, 10);
  assert.equal(shown.stats.historyPreview.daily.find(row => row.date === today).tokens, 10);
  assert.equal(shown.stats.periods.allTime.totalTokens, 1000);
});
