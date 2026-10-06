'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { emptyPeriod } = require('../../src/shared/usage');
const { createCodexAccountActivity } = require('../../src/electron/codexAccountActivity');
const {
  normalizeAccountActivity,
  selectAccountActivity,
  applyAccountActivityToStats: applyAccountActivityToStatsRaw,
  projectAccountActivityToHistory
} = require('../../src/shared/providers/codex/accountActivity');
const { localDayKey } = require('../../src/shared/history');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');

function applyAccountActivityToStats(stats, snapshot, since, deviceId = '', singleAccount = true, nowMs = Date.parse('2026-09-27T04:10:00Z')) {
  return applyAccountActivityToStatsRaw(stats, snapshot, since, deviceId, singleAccount, nowMs);
}

function activity(total = 67_570, date = '2026-02-22') {
  return { codexAccountActivity: {
    status: 'available', source: 'codex-app-server',
    fetchedAt: '2026-09-27T04:00:00Z', lifetimeTokens: total,
    dailyUsageBuckets: [{ startDate: date, tokens: total }]
  } };
}

function stats() {
  const allTime = emptyPeriod();
  allTime.totalTokens = 31_930;
  allTime.clients = { codex: 29_930, claude: 2_000 };
  allTime.cacheReadTokens = 20_000;
  allTime.clientCacheReads = { codex: 20_000 };
  allTime.unclassifiedTokens = 11_930;
  allTime.clientUnclassifiedTokens = { codex: 9_930, claude: 2_000 };
  const today = emptyPeriod();
  today.totalTokens = 100;
  today.clients = { codex: 100 };
  return { periods: { allTime, today, month: today } };
}

function readerFixture(t, overrides = {}) {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-lifecycle-test-'));
  const filePath = path.join(dir, 'activity.json');
  let nowMs = Date.parse('2026-09-27T04:00:00Z');
  let nextId = 0;
  const timers = new Map();
  const notifications = [];
  const reader = createCodexAccountActivity({
    filePath,
    readIdentity: () => ({ accountKey: 'account-a' }),
    readActivity: () => activity(),
    onChange: (snapshot) => notifications.push({ snapshot, nowMs }),
    now: () => nowMs,
    setTimeout: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, at: nowMs + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    ...overrides
  });
  t.after(() => {
    reader.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    reader, timers, notifications, filePath,
    advance(ms) {
      nowMs += ms;
      for (const [id, timer] of timers) {
        if (timer.at > nowMs) continue;
        timers.delete(id);
        timer.callback();
      }
    }
  };
}

test('enabled account activity refreshes without stats and schedules from completion', async (t) => {
  let reads = 0;
  let finish;
  const { reader, timers, advance } = readerFixture(t, {
    readActivity: () => {
      reads += 1;
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  reader.configure({ enabled: true, selected: true });
  reader.configure({ enabled: true, selected: true });
  const first = reader.refresh({ force: true });
  assert.equal(first, reader.refresh({ force: true }));
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(timers.size, 0);
  advance(5 * 60_000);
  finish(activity());
  await first;
  assert.equal(timers.size, 1);
  advance(15 * 60_000 - 1);
  assert.equal(reads, 1);
  advance(1);
  const second = reader.refresh();
  await Promise.resolve();
  assert.equal(reads, 2);
  finish(activity());
  await second;
  assert.equal(timers.size, 1);
  reader.configure({ enabled: true, selected: false });
  assert.equal(timers.size, 0);
  advance(30 * 60_000);
  await reader.refresh({ force: true });
  assert.equal(reads, 2);
});

test('failed scheduled reads republish stale account data and recover after callback errors', async (t) => {
  let reads = 0;
  const { reader, advance, notifications, timers } = readerFixture(t, {
    readActivity: () => {
      reads += 1;
      if (reads === 1 || reads === 7) return activity();
      if (reads === 2) throw new Error('synchronous failure');
      return Promise.reject(new Error('asynchronous failure'));
    },
    onError: () => { throw new Error('logging failed'); }
  });
  reader.configure({ enabled: true, selected: true });
  await reader.refresh();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    advance(15 * 60_000);
    await reader.refresh();
  }
  assert.equal(reads, 6);
  assert.equal(notifications.length, 6);
  assert.equal(timers.size, 1);
  const last = notifications.at(-1);
  const shown = applyAccountActivityToStats(stats(), last.snapshot, '2024-01-01', '', true, last.nowMs);
  assert.equal(shown.codexAccountActivity.status, 'stale');
  assert.equal(shown.codexAccountActivity.error, undefined);
  assert.equal((await reader.refresh({ force: true })).lifetimeTokens, 67_570);
  assert.equal(reads, 7);
});

test('disable then re-enable waits for the aborted physical request before restarting once', async (t) => {
  let reads = 0;
  let finish;
  let signal;
  const { reader, timers, notifications } = readerFixture(t, {
    readActivity: (options) => {
      reads += 1;
      signal = options.signal;
      if (reads > 1) return activity();
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  reader.configure({ enabled: true, selected: true });
  const first = reader.refresh();
  await Promise.resolve();
  reader.configure({ enabled: false, selected: true });
  assert.equal(signal.aborted, true);
  reader.configure({ enabled: true, selected: true });
  reader.configure({ enabled: true, selected: true });
  assert.equal(reader.refresh({ force: true }), first);
  assert.equal(reads, 1);
  finish(activity(1));
  assert.equal(await first, null);
  await reader.refresh();
  assert.equal(reads, 2);
  assert.equal(notifications.length, 1);
  assert.equal(reader.snapshot().lifetimeTokens, 67_570);
  assert.equal(timers.size, 1);
});

test('disposal aborts and rejects late results without writes, notifications or a timer', async (t) => {
  let finish;
  let signal;
  const { reader, filePath, timers, notifications } = readerFixture(t, {
    readActivity: (options) => {
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  reader.configure({ enabled: true, selected: true });
  const pending = reader.refresh();
  await Promise.resolve();
  const before = fs.readFileSync(filePath, 'utf8');
  reader.dispose();
  assert.equal(signal.aborted, true);
  finish(activity());
  assert.equal(await pending, null);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(notifications.length, 0);
  assert.equal(timers.size, 0);
  reader.configure({ enabled: true, selected: true });
  assert.equal(await reader.refresh({ force: true }), null);
});

test('a changed live identity prevents an in-flight result from entering either account cache', async (t) => {
  let accountKey = 'account-a';
  let finish;
  const { reader } = readerFixture(t, {
    readIdentity: () => ({ accountKey }),
    readActivity: () => new Promise((resolve) => { finish = resolve; })
  });
  const pending = reader.refresh();
  await Promise.resolve();
  accountKey = 'account-b';
  finish(activity());
  assert.equal(await pending, null);
  assert.equal(reader.snapshot(), null);
  accountKey = 'account-a';
  assert.equal(reader.snapshot(), null);
  assert.equal(reader.multipleAccounts(), true);
});

test('identity and notification errors cannot strand the refresh slot or timer', async (t) => {
  let identityReads = 0;
  let reads = 0;
  const { reader, timers } = readerFixture(t, {
    readIdentity: () => {
      identityReads += 1;
      if (identityReads === 1) throw new Error('temporary identity error');
      return { accountKey: 'account-a' };
    },
    readActivity: () => { reads += 1; return activity(); },
    onChange: () => { throw new Error('presentation error'); },
    onError: () => { throw new Error('logging error'); }
  });
  reader.configure({ enabled: true, selected: true });
  assert.equal(await reader.refresh(), null);
  assert.equal((await reader.refresh({ force: true })).lifetimeTokens, 67_570);
  assert.equal((await reader.refresh({ force: true })).lifetimeTokens, 67_570);
  assert.equal(reads, 2);
  assert.equal(timers.size, 1);
});

test('a synchronous account read failure does not prevent the next refresh', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-retry-test-'));
  let reads = 0;
  const reader = createCodexAccountActivity({
    filePath: path.join(dir, 'activity.json'),
    readIdentity: () => ({ accountKey: 'account-a' }),
    readActivity: () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary command resolution failure');
      return activity();
    }
  });
  try {
    assert.equal(await reader.refresh({ force: true }), null);
    const recovered = await reader.refresh({ force: true });
    assert.equal(reads, 2);
    assert.equal(recovered.lifetimeTokens, 67_570);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Home Day and Month replace Codex with the named account date buckets', () => {
  const raw = activity(1_000, '2026-09-26');
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-26', tokens: 700 },
    { startDate: '2026-09-27', tokens: 300 }
  ];
  const original = stats();
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const shown = applyAccountActivityToStats(original, snapshot, '2024-01-01');
  assert.equal(shown.periods.today.clients.codex, 300);
  assert.equal(shown.periods.month.clients.codex, 1_000);
  assert.equal(shown.periods.allTime.clients.codex, 1_000);
  assert.equal(original.periods.today.clients.codex, 100);
});

test('lagging account dates retain local Day but never add it to official Month or Total', () => {
  const original = stats();
  original.periods.today = { ...emptyPeriod(), totalTokens: 225_000_010, clients: { codex: 225_000_000, claude: 10 } };
  original.periods.month = { ...emptyPeriod(), totalTokens: 225_000_020, clients: { codex: 225_000_000, claude: 20 } };
  const raw = activity(83_062_564_566, '2026-09-30');
  raw.codexAccountActivity.fetchedAt = '2026-10-06T03:32:53.294Z';
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-30', tokens: 70_693_165_305 },
    { startDate: '2026-10-05', tokens: 12_369_399_261 }
  ];
  const shown = applyAccountActivityToStats(original, normalizeAccountActivity(raw, 'account-a'),
    '2024-01-01', '', true, new Date(2026, 9, 6, 12).getTime());
  assert.equal(shown.periods.today, original.periods.today);
  assert.equal(shown.periods.month.totalTokens, 12_369_399_281);
  assert.equal(shown.periods.allTime.totalTokens, 83_062_566_566);
  assert.equal(shown.codexAccountActivity.periods.today.headlineSource, 'local');
  assert.equal(shown.codexAccountActivity.periods.month.headlineSource, 'codex-account');
  assert.equal(shown.codexAccountActivity.periods.month.coverageThrough, '2026-10-05');
  assert.equal(shown.codexAccountActivity.periods.month.reportingLag, true);
  assert.equal(shown.codexAccountActivity.periods.month.dateBoundary, 'source-defined');
  assert.equal(original.periods.month.clients.codex, 225_000_000);
});

test('official zero differs from a missing day and all period components preserve other clients', () => {
  const original = stats();
  const period = {
    ...emptyPeriod(), totalTokens: 130, clients: { codex: 100, claude: 30 },
    cacheReadTokens: 25, clientCacheReads: { codex: 20, claude: 5 },
    cacheWriteTokens: 12, clientCacheWrites: { codex: 10, claude: 2 },
    outputTokens: 24, clientOutputs: { codex: 20, claude: 4 },
    unclassifiedTokens: 4, clientUnclassifiedTokens: { codex: 1, claude: 3 },
    costUsd: 9, clientCosts: { codex: 6, claude: 3 }, models: { localModel: 130 }
  };
  original.periods = { today: period, month: period, allTime: period };
  const raw = activity(400, '2026-09-26');
  raw.codexAccountActivity.dailyUsageBuckets.push({ startDate: '2026-09-27', tokens: 0 });
  const shown = applyAccountActivityToStats(original, normalizeAccountActivity(raw, 'account-a'), '2024-01-01');
  for (const [name, official] of [['today', 0], ['month', 400], ['allTime', 400]]) {
    const projected = shown.periods[name];
    assert.equal(projected.totalTokens, 30 + official);
    assert.deepEqual(projected.clients, { codex: official, claude: 30 });
    assert.deepEqual(projected.clientCacheReads, { claude: 5 });
    assert.deepEqual(projected.clientCacheWrites, { claude: 2 });
    assert.deepEqual(projected.clientOutputs, { claude: 4 });
    assert.equal(projected.cacheReadTokens, 5);
    assert.equal(projected.cacheWriteTokens, 2);
    assert.equal(projected.outputTokens, 4);
    assert.equal(projected.unclassifiedTokens, 3 + official);
    assert.deepEqual(projected.clientUnclassifiedTokens, { codex: official, claude: 3 });
    assert.equal(projected.models, period.models);
    assert.equal(projected.costUsd, 9);
    assert.equal(projected.capabilities.tokenComponents, false);
  }
  assert.equal(period.clients.codex, 100);
  assert.equal(shown.codexAccountActivity.periods.today.headlineSource, 'codex-account');
});

test('history preserves missing account dates and replaces an explicit zero', () => {
  const raw = activity(100, '2026-09-26');
  raw.codexAccountActivity.dailyUsageBuckets.push({ startDate: '2026-09-27', tokens: 0 });
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const localRow = (date) => ({ date, tokens: 25, cost: 3,
    perClient: { codex: { tokens: 20, cost: 2 }, claude: { tokens: 5, cost: 1 } } });
  const history = { daily: [localRow('2026-09-27'), localRow('2026-09-28')],
    monthly: [{ month: '2026-09', tokens: 50, perClient: { codex: { tokens: 40 }, claude: { tokens: 10 } } }], summary: {} };
  const presented = applyAccountActivityToStats(stats(), snapshot, '2024-01-01');
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.deepEqual(projected.daily.map((row) => [row.date, row.tokens]), [
    ['2026-09-26', 100], ['2026-09-27', 5], ['2026-09-28', 25]
  ]);
  assert.equal(projected.daily[1].perClient.codex.tokens, 0);
  assert.equal(projected.daily[2].perClient.codex.tokens, 20);
  assert.equal(projected.daily[2].cost, 3);
  assert.equal(projected.monthly[0].tokens, 110);
  assert.equal(projected.summary.totalTokens, presented.periods.allTime.totalTokens);
  assert.deepEqual(projected.codexAccountActivity.supplementaryLocalDates, ['2026-09-28']);
  assert.equal(history.daily[0].tokens, 25);
});

test('Home selects local date names without shifting official buckets and invalidates at month rollover', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'Asia/Singapore';
  try {
    const raw = activity(300, '2026-09-30');
    raw.codexAccountActivity.fetchedAt = '2026-09-30T15:59:00Z';
    raw.codexAccountActivity.dailyUsageBuckets.push({ startDate: '2026-10-01', tokens: 0 });
    const snapshot = normalizeAccountActivity(raw, 'account-a');
    const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
    const body = source.match(/function electronPresentationStats\([^]*?\n\}/)[0];
    let nowMs = Date.parse('2026-09-30T15:59:30Z');
    class ClockDate extends Date { static now() { return nowMs; } }
    const project = vm.runInNewContext(`(${body})`, {
      settings: { clients: 'codex,claude', codexAccountActivityEnabled: true, allTimeSince: '2024-01-01' },
      codexAccountActivity: { snapshot: () => snapshot, multipleAccounts: () => false },
      syncProvenanceActive: () => false,
      localDayKey,
      isAccountActivityStale: () => false,
      applyAccountActivityToStats: applyAccountActivityToStatsRaw,
      projectLimitStatsForDisplay: (value) => value,
      projectModelAliasStats: (value) => value,
      presentationCache: createStatsPresentationCache(),
      Date: ClockDate
    });
    const original = stats();
    const september = project(original);
    assert.equal(september.periods.today.clients.codex, 300);
    assert.equal(project(original), september);
    nowMs = Date.parse('2026-09-30T16:00:00Z');
    const october = project(original);
    assert.notEqual(october, september);
    assert.equal(october.periods.today.clients.codex, 0);
    assert.equal(october.periods.month.clients.codex, 0);
    assert.equal(october.codexAccountActivity.periods.today.selectedDate, '2026-10-01');
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('invalid local totals and foreign Codex usage in any period block replacement', () => {
  const snapshot = normalizeAccountActivity(activity(), 'account-a');
  const invalid = stats();
  invalid.periods.allTime.totalTokens = 1;
  assert.equal(applyAccountActivityToStats(invalid, snapshot, '2024-01-01').periods, invalid.periods);
  const overflow = stats();
  overflow.periods.allTime.totalTokens = Number.MAX_SAFE_INTEGER;
  assert.equal(applyAccountActivityToStats(overflow, snapshot, '2024-01-01').codexAccountActivity.status, 'conflict');
  const foreign = stats();
  foreign.devices = [{ deviceId: 'other', periods: { today: { clients: { codex: 1 } } } }];
  assert.equal(applyAccountActivityToStats(foreign, snapshot, '2024-01-01', 'this').codexAccountActivity.status, 'scope-unverified');
});

test('account total replaces local Codex without summing the two sources or changing local dates', () => {
  const original = stats();
  const snapshot = normalizeAccountActivity(activity(), 'account-a');
  const shown = applyAccountActivityToStats(original, snapshot, '2024-01-01');
  assert.equal(shown.periods.allTime.totalTokens, 69_570);
  assert.equal(shown.periods.allTime.clients.codex, 67_570);
  assert.equal(shown.periods.allTime.clients.claude, 2_000);
  assert.equal(shown.periods.today.totalTokens, 100);
  assert.equal(shown.periods.month.totalTokens, 100);
  assert.equal(original.periods.allTime.totalTokens, 31_930);
  assert.equal(shown.codexAccountActivity.status, 'applied');
  assert.equal(shown.codexAccountActivity.unallocatedTokens, undefined);
});

test('dashboard history uses verified account days once and keeps local-only evidence local', () => {
  const raw = activity(300, '2026-09-26');
  raw.codexAccountActivity.fetchedAt = '2026-09-28T00:00:00Z';
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-26', tokens: 100 },
    { startDate: '2026-09-27', tokens: 100 },
    { startDate: '2026-09-28', tokens: 100 }
  ];
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const history = {
    daily: [
      { date: '2026-09-26', tokens: 50, cost: 2, activeTimeMs: 60_000, perClient: { codex: { tokens: 40, cost: 1 }, claude: { tokens: 10, cost: 1 } }, perModel: { local: { tokens: 50 } } },
      { date: '2026-09-28', tokens: 25, cost: 3, activeTimeMs: 120_000, perClient: { codex: { tokens: 20, cost: 2 }, claude: { tokens: 5, cost: 1 } }, perModel: { local: { tokens: 25 } } }
    ],
    monthly: [{ month: '2026-09', tokens: 75, cost: 5, perClient: { codex: { tokens: 60, cost: 3 }, claude: { tokens: 15, cost: 2 } } }],
    summary: { totalTokens: 75, totalCost: 5, activeDays: 2, currentStreak: 1, peakDayTokens: 50, activeTimeMs: 180_000, favoriteModel: 'local', messages: 4 }
  };
  const presented = { periods: { allTime: { totalTokens: 315 } }, codexAccountActivity: { status: 'applied', source: 'codex-app-server', fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens } };
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.equal(projected.summary.totalTokens, 315);
  assert.equal(projected.summary.activeDays, 3);
  assert.equal(projected.summary.currentStreak, 3);
  assert.equal(projected.summary.longestStreak, 3);
  assert.equal(projected.summary.peakDayTokens, 110);
  assert.equal(projected.summary.activeTimeMs, 180_000);
  assert.equal(projected.summary.totalCost, 5);
  assert.equal(projected.summary.favoriteModel, 'local');
  assert.deepEqual(projected.daily.map((day) => [day.date, day.tokens]), [['2026-09-26', 110], ['2026-09-27', 100], ['2026-09-28', 105]]);
  assert.equal(projected.daily[0].perClient.codex.tokens, 100);
  assert.equal(projected.daily[0].perModel.local.tokens, 50);
  assert.equal(projected.monthly[0].tokens, 315);
  assert.equal(projected.monthly[0].perClient.codex.tokens, 300);
  assert.equal(history.daily[0].tokens, 50);
  assert.equal(projected.codexAccountActivity.status, 'applied');
});

test('dashboard account history leaves unverified scope and ambiguous local days untouched', () => {
  const snapshot = normalizeAccountActivity(activity(100, '2026-09-28'), 'account-a');
  const history = { daily: [{ date: '2026-09-28', tokens: 20 }], monthly: [], summary: { totalTokens: 20 } };
  const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: { status: 'applied', source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens } };
  assert.equal(projectAccountActivityToHistory(history, snapshot, { ...presented, codexAccountActivity: { status: 'scope-unverified' } }), history);
  assert.equal(projectAccountActivityToHistory(history, snapshot, presented), history);
});

test('stale account history preserves the locally verified streaks', () => {
  const raw = activity(100, '2026-09-28');
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-27', tokens: 50 },
    { startDate: '2026-09-28', tokens: 50 }
  ];
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const history = {
    daily: [{ date: '2026-09-28', tokens: 20, perClient: { codex: { tokens: 20 } } }],
    monthly: [{ month: '2026-09', tokens: 20, perClient: { codex: { tokens: 20 } } }],
    summary: { currentStreak: 1, longestStreak: 1 }
  };
  const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: {
    status: 'stale', source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens
  } };
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.equal(projected.summary.currentStreak, 1);
  assert.equal(projected.summary.longestStreak, 1);
});

test('conflicting account history preserves its status and locally verified streaks', () => {
  const raw = activity(100, '2026-09-28');
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-27', tokens: 50 }, { startDate: '2026-09-28', tokens: 50 }
  ];
  const snapshot = normalizeAccountActivity(raw, 'account-a');
  const history = {
    daily: [{ date: '2026-09-28', tokens: 200, perClient: { codex: { tokens: 200 } } }],
    monthly: [], summary: { currentStreak: 1, longestStreak: 1 }
  };
  const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: {
    status: 'conflict', source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens
  } };
  const projected = projectAccountActivityToHistory(history, snapshot, presented, { todayKey: '2026-09-28' });
  assert.equal(projected.codexAccountActivity.status, 'conflict');
  assert.equal(projected.summary.currentStreak, 1);
  assert.equal(projected.summary.longestStreak, 1);
});

test('applied account Dashboard days use the account UTC boundary while stale days stay local', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const nowMs = Date.parse('2026-10-02T00:30:00Z');
    assert.equal(localDayKey(new Date(nowMs)), '2026-10-01');
    const raw = activity(100, '2026-10-01');
    raw.codexAccountActivity.dailyUsageBuckets = [
      { startDate: '2026-10-01', tokens: 50 },
      { startDate: '2026-10-02', tokens: 50 }
    ];
    const snapshot = normalizeAccountActivity(raw, 'account-a');
    const history = {
      daily: [{ date: '2026-10-01', tokens: 10, perClient: { codex: { tokens: 10 } } }],
      monthly: [{ month: '2026-10', tokens: 10, perClient: { codex: { tokens: 10 } } }],
      summary: { currentStreak: 1, longestStreak: 1 }
    };
    const account = { source: snapshot.source, fetchedAt: snapshot.fetchedAt, lifetimeTokens: snapshot.lifetimeTokens };
    const presented = { periods: { allTime: { totalTokens: 100 } }, codexAccountActivity: { ...account, status: 'applied' } };
    const applied = projectAccountActivityToHistory(history, snapshot, presented, { nowMs });
    assert.deepEqual(applied.daily.map((row) => row.date), ['2026-10-01', '2026-10-02']);
    assert.equal(applied.summary.currentStreak, 2);
    const stale = projectAccountActivityToHistory(history, snapshot, {
      ...presented, codexAccountActivity: { ...account, status: 'stale' }
    }, { nowMs });
    assert.deepEqual(stale.daily.map((row) => row.date), ['2026-10-01']);
    const overridden = projectAccountActivityToHistory(history, snapshot, presented, { nowMs, todayKey: '2026-10-01' });
    assert.deepEqual(overridden.daily.map((row) => row.date), ['2026-10-01']);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('account activity exposes a streak through yesterday without changing local history', () => {
  const raw = activity(67_570, '2026-09-25');
  raw.codexAccountActivity.fetchedAt = '2026-09-28T00:00:00Z';
  raw.codexAccountActivity.dailyUsageBuckets = [
    { startDate: '2026-09-25', tokens: 20_000 },
    { startDate: '2026-09-26', tokens: 20_000 },
    { startDate: '2026-09-27', tokens: 27_570 }
  ];
  const shown = applyAccountActivityToStats(stats(), normalizeAccountActivity(raw, 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-28T00:10:00Z'));
  assert.equal(shown.codexAccountActivity.currentStreak, 3);
  assert.equal(shown.historyPreview, undefined);
  raw.codexAccountActivity.dailyUsageBuckets[1].tokens = 0;
  raw.codexAccountActivity.dailyUsageBuckets[2].tokens += 20_000;
  const gap = applyAccountActivityToStats(stats(), normalizeAccountActivity(raw, 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-28T00:10:00Z'));
  assert.equal(gap.codexAccountActivity.currentStreak, 1);
});

test('incomplete daily buckets and a later requested start date cannot be advertised as account-wide', () => {
  const incomplete = activity();
  incomplete.codexAccountActivity.dailyUsageBuckets[0].tokens -= 1;
  const partial = normalizeAccountActivity(incomplete, 'account-a');
  assert.equal(partial.dailyCoverageComplete, false);
  assert.equal(applyAccountActivityToStats(stats(), partial, '2024-01-01').codexAccountActivity.status, 'range-unverified');
  const late = applyAccountActivityToStats(stats(), normalizeAccountActivity(activity(), 'account-a'), '2026-03-01');
  assert.equal(late.periods.allTime.totalTokens, 31_930);
  assert.equal(late.codexAccountActivity.status, 'range-unverified');
});

test('a second device with unverified Codex account prevents overlapping aggregation', () => {
  const aggregate = stats();
  aggregate.devices = [
    { deviceId: 'this-pc', periods: { allTime: { clients: { codex: 29_930 } } } },
    { deviceId: 'other-pc', periods: { allTime: { clients: { codex: 500 } } } }
  ];
  const shown = applyAccountActivityToStats(aggregate, normalizeAccountActivity(activity(), 'account-a'), '2024-01-01', 'this-pc');
  assert.equal(shown.periods.allTime.totalTokens, 31_930);
  assert.equal(shown.codexAccountActivity.status, 'scope-unverified');
});

test('local Codex above account total keeps local details for every tool with explicit attribution', () => {
  const aggregate = stats();
  aggregate.allTimeSessionsView = { 'codex:old': { client: 'codex', totalTokens: 29_930 } };
  aggregate.periods.allTime.models = { 'gpt-old': 29_930, 'claude-model': 2_000 };
  aggregate.periods.allTime.sessions = aggregate.allTimeSessionsView;
  aggregate.periods.allTime.costUsd = 12;
  aggregate.periods.allTime.clientCosts = { codex: 10, claude: 2 };
  const shown = applyAccountActivityToStats(aggregate, normalizeAccountActivity(activity(20_000), 'account-a'), '2024-01-01');
  assert.equal(shown.periods.allTime.clients.codex, 20_000);
  assert.equal(shown.periods.allTime.totalTokens, 22_000);
  assert.equal(shown.codexAccountActivity.status, 'conflict');
  assert.deepEqual(shown.periods.allTime.models, aggregate.periods.allTime.models);
  assert.deepEqual(shown.periods.allTime.sessions, aggregate.periods.allTime.sessions);
  assert.deepEqual(shown.periods.allTime.clientCosts, { codex: 10, claude: 2 });
  assert.equal(shown.periods.allTime.costUsd, 12);
  assert.equal(shown.allTimeSessionsView, aggregate.allTimeSessionsView);
  assert.equal(shown.codexAccountActivity.detailsSuppressed, false);
  assert.equal(shown.codexAccountActivity.periods.allTime.detailSource, 'local');
});

test('renderer retains archived sessions when local Codex detail exceeds the account total', () => {
  const { withAllTimeSessions } = require('../../src/electron/renderer/allTimeSessions');
  const overlay = (value) => withAllTimeSessions(value, value.allTimeSessionsView);
  const original = stats();
  const archivedClaude = { client: 'claude', totalTokens: 2_000, archived: true };
  original.allTimeSessionsView = { 'claude:archived': archivedClaude };
  const shown = applyAccountActivityToStats(original, normalizeAccountActivity(activity(20_000), 'account-a'), '2024-01-01');
  assert.equal(shown.codexAccountActivity.status, 'conflict');
  assert.equal(shown.codexAccountActivity.detailsSuppressed, false);
  assert.equal(overlay(shown).periods.allTime.sessions['claude:archived'], archivedClaude);
  assert.equal(shown.periods.allTime.clients.codex, 20_000);
  assert.equal(original.periods.allTime.sessions['claude:archived'], undefined);

  const legacy = stats();
  legacy.allTimeSessionsView = { 'claude:archived': archivedClaude };
  legacy.codexAccountActivity = { status: 'conflict', detailsSuppressed: true };
  assert.equal(overlay(legacy).periods.allTime.sessions['claude:archived'], undefined);
});

test('an old account reading is visibly stale while remaining the last known total', () => {
  const shown = applyAccountActivityToStats(stats(), normalizeAccountActivity(activity(), 'account-a'),
    '2024-01-01', '', true, Date.parse('2026-09-27T05:10:00Z'));
  assert.equal(shown.periods.allTime.clients.codex, 67_570);
  assert.equal(shown.codexAccountActivity.status, 'stale');
  assert.equal(shown.codexAccountActivity.fetchedAt, '2026-09-27T04:00:00.000Z');
});

test('lower subsequent readings are held until a new verified account total arrives', () => {
  const earlier = normalizeAccountActivity(activity(), 'account-a');
  const lowerRaw = activity(60_000);
  lowerRaw.codexAccountActivity.fetchedAt = '2026-09-27T05:00:00Z';
  const selected = selectAccountActivity(earlier, normalizeAccountActivity(lowerRaw, 'account-a'));
  assert.equal(selected.conflict, true);
  assert.equal(selected.snapshot.lifetimeTokens, 67_570);
  const corrected = selectAccountActivity(earlier, normalizeAccountActivity(lowerRaw, 'account-a'), { correctionConfirmed: true });
  assert.equal(corrected.conflict, false);
  assert.equal(corrected.snapshot.lifetimeTokens, 60_000);
});

test('a repeated lower account reading can correct a persisted total', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let current = activity();
  let reads = 0;
  const options = {
    filePath,
    readIdentity: () => ({ accountKey: 'account-a' }),
    readActivity: async () => { reads += 1; return current; }
  };
  try {
    await createCodexAccountActivity(options).refresh();
    current = activity(60_000);
    current.codexAccountActivity.fetchedAt = '2026-09-27T05:00:00Z';
    const restarted = createCodexAccountActivity(options);
    await restarted.refresh();
    assert.equal(reads, 3);
    assert.equal(restarted.snapshot().lifetimeTokens, 60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('account snapshot persists and is isolated from a later login', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let accountKey = 'account-a';
  const options = { filePath, readIdentity: () => ({ accountKey }), readActivity: async () => activity() };
  try {
    const first = createCodexAccountActivity(options);
    await first.refresh();
    assert.equal(first.snapshot().lifetimeTokens, 67_570);
    const restarted = createCodexAccountActivity(options);
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
    accountKey = 'account-b';
    assert.equal(restarted.snapshot(), null);
    await restarted.refresh();
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
    assert.equal(restarted.multipleAccounts(), true);
    assert.equal(applyAccountActivityToStats(stats(), restarted.snapshot(), '2024-01-01', '', !restarted.multipleAccounts())
      .codexAccountActivity.status, 'scope-unverified');
    accountKey = 'account-a';
    assert.equal(restarted.snapshot().lifetimeTokens, 67_570);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed activity read after account switch still blocks later mixed history', async () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  let accountKey = 'account-a';
  let fail = false;
  const options = {
    filePath,
    readIdentity: () => ({ accountKey }),
    readActivity: async () => { if (fail) throw new Error('offline'); return activity(); }
  };
  try {
    await createCodexAccountActivity(options).refresh();
    accountKey = 'account-b';
    fail = true;
    const switched = createCodexAccountActivity(options);
    await switched.refresh();
    accountKey = 'account-a';
    const restarted = createCodexAccountActivity(options);
    assert.equal(restarted.multipleAccounts(), true);
    assert.equal(applyAccountActivityToStats(stats(), restarted.snapshot(), '2024-01-01', '', !restarted.multipleAccounts())
      .codexAccountActivity.status, 'scope-unverified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persisted bucket cannot crash snapshot reading', () => {
  const root = path.join(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-activity-test-'));
  const filePath = path.join(dir, 'activity.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, accounts: { 'account-a': {
      source: 'codex-app-server', fetchedAt: '2026-09-27T04:00:00Z', lifetimeTokens: 1,
      dailyUsageBuckets: [null]
    } } }));
    const reader = createCodexAccountActivity({ filePath, readIdentity: () => ({ accountKey: 'account-a' }) });
    assert.equal(reader.snapshot(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
