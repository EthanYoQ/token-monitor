'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  createAllTimeSessionsLoader,
  withAllTimeSessions
} = require('../../src/electron/renderer/allTimeSessions');
const { createRendererSnapshots } = require('../../src/electron/statsPublisher');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  const calls = [];
  const loaded = [];
  const errors = [];
  let needed = options.needed ?? true;
  const state = { stats: stats() };
  const loader = createAllTimeSessionsLoader({
    fetchSessions: (id) => new Promise((resolve, reject) => calls.push({ id, resolve, reject })),
    currentSnapshot: () => state.stats?.snapshot,
    needed: () => needed,
    onLoaded: () => {
      state.stats = loader.reconcile(state.stats);
      loaded.push(state.stats);
    },
    onError: (error) => errors.push(error)
  });
  return {
    loader,
    calls,
    loaded,
    errors,
    state,
    reconcile: () => { state.stats = loader.reconcile(state.stats); },
    setNeeded: (value) => { needed = value; },
    adopt: (snapshot) => {
      loader.invalidate();
      state.stats = loader.reconcile(stats(snapshot));
    }
  };
}

function stats(snapshot = { id: 1, source: 0 }) {
  return { periods: { today: { sessions: {} }, allTime: { totalTokens: 9 } }, limits: {}, snapshot };
}

test('attaching copies the pulled list onto new stats without touching them', () => {
  const input = stats();
  assert.equal(withAllTimeSessions(input, null), input, 'nothing pulled yet');
  const sessions = { 'claude:a': { totalTokens: 9 } };
  const result = withAllTimeSessions(input, sessions);
  assert.equal(result.periods.allTime.sessions, sessions);
  assert.equal(result.periods.allTime.totalTokens, 9);
  assert.equal(result.periods.today, input.periods.today);
  assert.equal(result.limits, input.limits);
  assert.equal(Object.hasOwn(input.periods.allTime, 'sessions'), false);
  const noAllTime = { periods: { today: {} } };
  assert.equal(withAllTimeSessions(noAllTime, sessions), noAllTime);
  assert.equal(withAllTimeSessions(null, sessions), null);
});

test('a cached session list cannot restore suppressed account-conflict details', () => {
  const input = { ...stats(), codexAccountActivity: { detailsSuppressed: true } };
  const result = withAllTimeSessions(input, { 'codex:old': { totalTokens: 20 } });
  assert.equal(result, input);
  assert.equal(Object.hasOwn(result.periods.allTime, 'sessions'), false);
});

test('a pull starts only when the list is stale and something shows it', async () => {
  const { loader, calls, loaded, setNeeded, adopt } = harness({ needed: false });
  loader.ensure();
  await settle();
  assert.equal(calls.length, 0, 'not needed');

  setNeeded(true);
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1);
  calls[0].resolve({ 'claude:a': { totalTokens: 9 } });
  await settle();
  assert.equal(loaded.length, 1);
  assert.equal(loader.loaded(), true);
  assert.deepEqual(loaded[0].periods.allTime.sessions, { 'claude:a': { totalTokens: 9 } });

  loader.ensure();
  await settle();
  assert.equal(calls.length, 1, 'fresh until new stats arrive');
  adopt({ id: 2, source: 0 });
  loader.ensure();
  await settle();
  assert.deepEqual(calls.map((call) => call.id), [1, 2], 'each pull names the snapshot on screen');
});

test('stats that arrive during a pull are read by one more pull, not by parallel ones', async () => {
  const { loader, calls, adopt } = harness();
  loader.ensure();
  await settle();
  adopt({ id: 2, source: 0 });
  loader.ensure();
  adopt({ id: 3, source: 0 });
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1, 'one pull in flight');

  calls[0].resolve({ old: {} });
  await settle();
  assert.equal(calls.length, 2, 'the newer stats are pulled once');
  assert.equal(calls[1].id, 3);
  calls[1].resolve({ fresh: {} });
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(loader.attach(stats({ id: 3, source: 0 })).periods.allTime.sessions), ['fresh']);
});

test('a list never crosses to another source, even when it lands after the switch', async () => {
  const { loader, calls, loaded, adopt } = harness();
  loader.ensure();
  await settle();
  calls[0].resolve({ 'hub-a': {} });
  await settle();
  assert.ok(loader.attach(stats({ id: 2, source: 0 })).periods.allTime.sessions, 'same source: kept until the next pull');
  const otherHub = stats({ id: 5, source: 1 });
  assert.equal(loader.attach(otherHub), otherHub, 'another source gets nothing attached');

  adopt({ id: 2, source: 0 });
  loader.ensure();
  await settle();
  adopt({ id: 5, source: 1 });
  calls[1].resolve({ 'hub-a-late': {} });
  await settle();
  assert.equal(loaded.length, 1, 'the late list from the old source is dropped');
  assert.equal(loader.loaded(), false);
  assert.equal(calls.length, 3, 'and the new source is pulled instead');
  assert.equal(calls[2].id, 5);
  calls[2].resolve({ 'hub-b': {} });
  await settle();
  assert.deepEqual(Object.keys(loader.attach(otherHub).periods.allTime.sessions), ['hub-b']);
});

test('nothing is pulled before the renderer holds a stamped snapshot', async () => {
  const calls = [];
  const loader = createAllTimeSessionsLoader({
    fetchSessions: (id) => { calls.push(id); return {}; },
    currentSnapshot: () => undefined,
    needed: () => true,
    onLoaded: () => {}
  });
  loader.ensure();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(loader.loaded(), false);
});

test('a hidden list is only marked stale, and pulled once it shows again', async () => {
  const { loader, calls, setNeeded } = harness();
  loader.ensure();
  await settle();
  calls[0].resolve({});
  await settle();

  setNeeded(false);
  loader.invalidate();
  loader.ensure();
  await settle();
  assert.equal(calls.length, 1);

  setNeeded(true);
  loader.ensure();
  await settle();
  assert.equal(calls.length, 2);
});

test('a failed or empty pull waits for the next stats instead of retrying', async () => {
  const { loader, calls, errors, loaded } = harness();
  loader.ensure();
  await settle();
  calls[0].reject(new Error('main busy'));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(calls.length, 1, 'no retry loop');
  assert.equal(loader.loaded(), false);

  loader.invalidate();
  loader.ensure();
  await settle();
  calls[1].resolve(null);
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(loaded.length, 0, 'main had no stats yet');
  assert.equal(loader.loaded(), false);
});

test('leaving a consumer releases both the cached list and the attached stats without mutating the snapshot', async () => {
  const { loader, calls, state, reconcile, setNeeded } = harness();
  reconcile();
  await settle();
  calls[0].resolve({ archived: { totalTokens: 9 } });
  await settle();
  const displayed = state.stats;
  assert.ok(displayed.periods.allTime.sessions.archived);

  setNeeded(false);
  reconcile();
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  assert.equal(loader.loaded(), false);
  assert.equal(Object.hasOwn(loader.attach(stats()).periods.allTime, 'sessions'), false);
  assert.ok(displayed.periods.allTime.sessions.archived, 'published stats remain immutable');
  assert.equal(state.stats.periods.today, displayed.periods.today);
  assert.equal(state.stats.limits, displayed.limits);
  const released = state.stats;
  reconcile();
  assert.equal(state.stats, released, 'repeated release needs no new copy');

  setNeeded(true);
  reconcile();
  await settle();
  assert.deepEqual(calls.map((call) => call.id), [1, 1], 'reopening reloads without a stats push');
});

test('a late result cannot restore detail after its consumer leaves', async () => {
  const { calls, state, loaded, reconcile, setNeeded } = harness();
  reconcile();
  await settle();
  setNeeded(false);
  reconcile();
  calls[0].resolve({ late: {} });
  await settle();
  assert.equal(loaded.length, 0);
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  assert.equal(calls.length, 1);
});

test('leave and reenter during a pull discard the old reply and start one replacement after settlement', async () => {
  const { calls, state, loaded, reconcile, setNeeded } = harness();
  reconcile();
  await settle();
  setNeeded(false);
  reconcile();
  setNeeded(true);
  reconcile();
  reconcile();
  await settle();
  assert.equal(calls.length, 1, 'the old request still owns the pending slot');
  calls[0].resolve({ previousVisit: {} });
  await settle();
  assert.equal(loaded.length, 0);
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  assert.deepEqual(calls.map((call) => call.id), [1, 1]);
  calls[1].resolve({ currentVisit: {} });
  await settle();
  assert.deepEqual(Object.keys(state.stats.periods.allTime.sessions), ['currentVisit']);
  assert.equal(calls.length, 2);
});

test('new same-source stats keep displayed detail while a source switch releases it even if loading fails', async () => {
  const { loader, calls, state, reconcile, adopt, loaded } = harness();
  reconcile();
  await settle();
  calls[0].resolve({ original: {} });
  await settle();
  const sessions = state.stats.periods.allTime.sessions;
  adopt({ id: 2, source: 0 });
  assert.equal(state.stats.periods.allTime.sessions, sessions, 'same-source continuity');
  await settle();
  assert.equal(calls[1].id, 2, 'adoption fetches the new stamp, not the previous state.stats');
  adopt({ id: 3, source: 1 });
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  assert.equal(Object.hasOwn(loader.attach(stats()).periods.allTime, 'sessions'), false, 'old cache was released');
  calls[1].resolve({ lateOldSource: {} });
  await settle();
  assert.equal(loaded.length, 1);
  assert.equal(calls[2].id, 3);
  calls[2].reject(new Error('new source unavailable'));
  await settle();
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  assert.equal(calls.length, 3, 'failure does not retry the same stamp');
});

for (const newerArrivesFirst of [true, false]) {
  test(`an evicted detail request recovers when newer stats arrive ${newerArrivesFirst ? 'before' : 'after'} its null result`, async () => {
    const snapshots = createRendererSnapshots({ source: () => 0 });
    const first = snapshots.stamp({ periods: { allTime: { sessions: { old: {} } } } }, {});
    const { loader, calls, state, loaded, adopt, reconcile } = harness();
    reconcile();
    await settle();
    snapshots.stamp({ periods: {} }, {});
    const newest = snapshots.stamp({ periods: { allTime: { sessions: { newest: {} } } } }, {});
    assert.equal(snapshots.get(first.snapshot.id), null);
    if (newerArrivesFirst) adopt(newest.snapshot);
    calls[0].resolve(snapshots.get(first.snapshot.id));
    await settle();
    assert.equal(loaded.length, 0, 'an old id never resolves to latest detail');
    if (!newerArrivesFirst) {
      reconcile();
      await settle();
      assert.equal(calls.length, 1, 'an unavailable unchanged id never spins');
      adopt(newest.snapshot);
      await settle();
    }
    assert.deepEqual(calls.map((call) => call.id), [1, 3]);
    calls[1].resolve(snapshots.get(newest.snapshot.id).periods.allTime.sessions);
    await settle();
    assert.deepEqual(Object.keys(state.stats.periods.allTime.sessions), ['newest']);
    loader.ensure();
    await settle();
    assert.equal(calls.length, 2);
  });
}

test('the renderer requests detail only for a visible Settings or TOTAL session/project consumer', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const definition = app.match(/function allTimeSessionsNeeded\(\) \{[\s\S]*?\n\}/)[0];
  let surface = 'main';
  let settingsOpen = false;
  const state = { period: 'allTime', breakdown: 'home' };
  const needed = vm.runInNewContext(`(${definition})`, {
    visibleStatsSurface: () => surface,
    isSettingsPanelOpen: () => settingsOpen,
    state
  });
  assert.equal(needed(), false, 'Home does not pull on startup');
  settingsOpen = true;
  assert.equal(needed(), true, 'Settings needs its archived session count');
  settingsOpen = false;
  for (const breakdown of ['session', 'project']) {
    state.breakdown = breakdown;
    assert.equal(needed(), true);
    state.period = 'today';
    assert.equal(needed(), false);
    state.period = 'allTime';
    for (const hiddenSurface of [null, 'bubble']) {
      surface = hiddenSurface;
      assert.equal(needed(), false, 'stored TOTAL selection does not make a hidden surface a consumer');
      settingsOpen = true;
      assert.equal(needed(), false, 'hidden Settings is not a consumer');
      settingsOpen = false;
    }
    surface = 'main';
  }
});

for (const entryPoint of ['render', 'renderStatsUpdate', 'handleWindowVisibilityChange']) {
  test(`${entryPoint} releases the attached list before its hidden return`, async () => {
    const { loader, calls, state, reconcile, setNeeded } = harness();
    reconcile();
    await settle();
    calls[0].resolve({ archived: {} });
    await settle();
    assert.ok(state.stats.periods.allTime.sessions.archived);
    setNeeded(false);

    const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
    const start = app.indexOf(`function ${entryPoint}()`);
    const definition = app.slice(start, app.indexOf('\n}', start) + 2);
    const run = vm.runInNewContext(`(${definition})`, {
      state,
      allTimeSessions: loader,
      visibleStatsSurface: () => null,
      renderConnectionStatus: () => {},
      statsRenderScheduler: { request() {}, visibilityChanged: () => false }
    });
    run();
    assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
    assert.equal(loader.loaded(), false);
    await settle();
    assert.equal(calls.length, 1);
  });
}

test('closing Settings releases its detail without waiting for a stats push', async () => {
  const { loader, calls, state, reconcile, setNeeded } = harness();
  reconcile();
  await settle();
  calls[0].resolve({ archived: {} });
  await settle();
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const definition = app.match(/els\.settingsButton\.addEventListener\('click', (\(event\) => \{[\s\S]*?\n\})\);/)[1];
  const run = vm.runInNewContext(`(${definition})`, {
    state,
    allTimeSessions: loader,
    els: {
      settingsPanel: { classList: { toggle: () => setNeeded(false) } },
      settingsButton: { blur() {} },
      shell: { classList: { toggle() {} }, style: {} }
    },
    isSettingsPanelOpen: () => false,
    resetSettingsListSearch() {},
    stopWindowShortcutRecording() {},
    requestAnimationFrame: (callback) => callback(),
    ensureServiceStatusTicker() {}
  });
  run({ detail: 0 });
  assert.equal(loader.loaded(), false);
  assert.equal(Object.hasOwn(state.stats.periods.allTime, 'sessions'), false);
  await settle();
  assert.equal(calls.length, 1);
});

test('the renderer reconciles every stats adoption and releases before hidden early returns', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(rendererDir, '..', 'preload.js'), 'utf8');

  assert.ok(html.indexOf('<script src="allTimeSessions.js">') < html.indexOf('<script src="app.js">'));
  assert.match(preload, /getAllTimeSessions: \(snapshotId\) => ipcRenderer\.invoke\('stats:allTimeSessions', snapshotId\)/);
  assert.match(app, /fetchSessions: \(snapshotId\) => window\.tokenMonitor\.getAllTimeSessions\(snapshotId\),\s*currentSnapshot: \(\) => state\.stats\?\.snapshot,/);
  assert.equal((app.match(/allTimeSessions\.invalidate\(\);\s*state\.stats = allTimeSessions\.reconcile\(/g) || []).length, 2, 'push and refresh');
  assert.doesNotMatch(app, /state\.stats = (payload\.data\.stats|nextStats);/);
  for (const name of ['render', 'renderStatsUpdate', 'handleWindowVisibilityChange', 'syncSettingsForm']) {
    assert.match(app, new RegExp(`function ${name}\\(\\) \\{\\s*state\\.stats = allTimeSessions\\.reconcile\\(state\\.stats\\);`));
  }
  assert.match(app, /state\.floatingBubble = \{ collapsed: Boolean\(side\), side \};\s*state\.stats = allTimeSessions\.reconcile\(state\.stats\);/);
});
