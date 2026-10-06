'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { collectOpenCodeReviewRows, buildOpenCodeReviewPeriods, buildOpenCodeReviewHistoryGraph } = require('../../src/shared/providers/open-code-review/usage');
const { extractUsageFromTokscale } = require('../../src/shared/usage');

function fixture(t) {
  const root = path.resolve(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(root, { recursive: true });
  const homeDir = fs.mkdtempSync(path.join(root, 'ocr-usage-test-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const dir = path.join(homeDir, '.opencodereview/sessions/2026-10-06');
  fs.mkdirSync(dir, { recursive: true });
  return { homeDir, cacheDir: path.join(homeDir, 'numeric-cache'), file: path.join(dir, 'one.jsonl') };
}

function event(uuid, timestamp = '2026-10-06T10:00:00+08:00', overrides = {}) {
  return { content: 'response content must not be cached', native_payload: { secret: 'private response' },
    model: 'zai-org/GLM-5.3', sessionId: 'review-session', timestamp, type: 'llm_response',
    usage: { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 70, cache_write_tokens: 10 }, uuid, ...overrides };
}
const line = (e) => `${JSON.stringify(e)}\n`;
const total = (rows) => rows.reduce((sum, row) => sum + row.prompt + row.output, 0);

test('OCR counts cached prompt tokens once, deduplicates copies, and persists numeric metadata only', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, line(event('a')) + line({ type: 'llm_request', content: 'ignored' }));
  fs.copyFileSync(f.file, path.join(path.dirname(f.file), 'copy.jsonl'));
  const rows = await collectOpenCodeReviewRows({ ...f, chunkBytes: 17 });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].input, rows[0].output, rows[0].cacheRead, rows[0].cacheWrite], [20, 20, 70, 10]);
  assert.equal(total(rows), 120);
  const cache = fs.readdirSync(f.cacheDir).map((name) => fs.readFileSync(path.join(f.cacheDir, name), 'utf8')).join('');
  assert.ok(!cache.includes('private response'));
  assert.ok(!cache.includes('response content'));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 120);
});

test('OCR checkpoints complete lines and reads an appended partial event exactly once after restart', async (t) => {
  const f = fixture(t);
  const second = line(event('b'));
  fs.writeFileSync(f.file, line(event('a')) + second.slice(0, -8));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 120);
  fs.appendFileSync(f.file, second.slice(-8));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 240);
  assert.equal(total(await collectOpenCodeReviewRows(f)), 240);
});

test('OCR rebuilds corrupted numeric caches from unchanged sources and then reuses the repaired cache', async (t) => {
  for (const [name, corrupt] of [
    ['changed token count', (cache) => { cache.rows[0].output += 1; }],
    ['dropped row', (cache) => { cache.rows.pop(); }],
    ['changed complete-line offset', (cache) => { cache.offset -= 1; }],
    ['legacy cache version', (cache) => { cache.version = 2; delete cache.checksum; }]
  ]) await t.test(name, async (t) => {
    const f = fixture(t);
    const source = ['a', 'b', 'c'].map((uuid) => line(event(uuid))).join('');
    fs.writeFileSync(f.file, source);
    assert.equal(total(await collectOpenCodeReviewRows(f)), 360);
    const cachePath = path.join(f.cacheDir, fs.readdirSync(f.cacheDir)[0]);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    corrupt(cache);
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    const originalOpen = fs.promises.open;
    let sourceBytes = 0;
    fs.promises.open = async (filePath, ...args) => {
      const handle = await originalOpen(filePath, ...args);
      if (filePath === f.file) {
        const createStream = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => {
          const stream = createStream(options);
          stream.on('data', (chunk) => { sourceBytes += chunk.length; });
          return stream;
        };
      }
      return handle;
    };
    t.after(() => { fs.promises.open = originalOpen; });
    const recovered = await collectOpenCodeReviewRows(f);
    assert.equal(total(recovered), 360);
    assert.deepEqual(recovered.map((row) => row.uuid), ['a', 'b', 'c']);
    assert.equal(sourceBytes, Buffer.byteLength(source), 'a corrupt cache must rebuild from its complete source');
    sourceBytes = 0;
    assert.deepEqual(await collectOpenCodeReviewRows(f), recovered);
    assert.equal(sourceBytes, 0, 'the repaired cache must retain the unchanged-source fast path');
  });
});

test('OCR skips unchanged source bytes, resumes at the checkpoint, and cancels an active stream', async (t) => {
  const f = fixture(t);
  const first = line(event('a'));
  fs.writeFileSync(f.file, first);
  const originalOpen = fs.promises.open;
  const starts = [];
  let cancelRead = null;
  fs.promises.open = async (filePath, ...args) => {
    const handle = await originalOpen(filePath, ...args);
    if (filePath === f.file) {
      const createStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        starts.push(options.start);
        const stream = createStream(options);
        if (cancelRead) stream.once('data', () => cancelRead.abort());
        return stream;
      };
    }
    return handle;
  };
  t.after(() => { fs.promises.open = originalOpen; });
  await collectOpenCodeReviewRows(f);
  await collectOpenCodeReviewRows(f);
  assert.deepEqual(starts, [0], 'an unchanged file must not be streamed again');
  fs.appendFileSync(f.file, line(event('b')));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 240);
  assert.deepEqual(starts, [0, 0, Buffer.byteLength(first)], 'a changed file verifies its committed prefix before parsing the append');
  fs.appendFileSync(f.file, line(event('c', undefined, { content: 'x'.repeat(4096) })));
  cancelRead = new AbortController();
  await assert.rejects(collectOpenCodeReviewRows({ ...f, signal: cancelRead.signal, chunkBytes: 64 }), { name: 'AbortError' });
  cancelRead = null;
  assert.equal(total(await collectOpenCodeReviewRows(f)), 360, 'the cancelled append must be recovered exactly once');
});

test('OCR replaces the file ledger after truncation or replacement without retaining removed events', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, line(event('a')) + line(event('b')));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 240);
  fs.writeFileSync(f.file, line(event('c')));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 120);
  fs.renameSync(f.file, `${f.file}.old`);
  fs.writeFileSync(f.file, line(event('d')) + line(event('e')));
  assert.deepEqual((await collectOpenCodeReviewRows(f)).map((row) => row.uuid), ['d', 'e']);
});

test('OCR detects a middle rewrite followed by append and reconciles historical month/all-time totals', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const now = new Date(2026, 9, 6, 12);
  const yesterday = new Date(2026, 9, 5, 10).toISOString();
  const today = new Date(2026, 9, 6, 10).toISOString();
  const padding = line({ content: 'x'.repeat(512), type: 'llm_request' });
  const original = padding + line(event('a', yesterday)) + line(event('b', today)) + padding;
  fs.writeFileSync(f.file, original);
  const scans = [];
  let captured;
  const options = { homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now, clients: 'claude,open-code-review',
    allTimeSince: '2026-01-01', deviceId: 'ocr-test', platform: 'linux', env: {}, wslScanEnabled: false,
    includeHistory: false, onAnchorComputed: (value) => { captured = value; },
    runTokscale: async ({ clients, flags }) => {
      assert.equal(clients, 'claude');
      scans.push(flags);
      return { entries: [{ client: 'claude', input: flags[0] === '--today' ? 10 : flags[0] === '--month' ? 100 : 1000 }] };
    }
  };
  await collectUsageOnce(options);
  const anchor = { dateKey: localTodayKey(now), ...captured.windowsPeriods, todayPartitions: captured.todayPartitions,
    openCodeReviewHistoryRevision: captured.openCodeReviewHistoryRevision };
  const rewritten = original.replace('"prompt_tokens":100', '"prompt_tokens":900');
  assert.equal(rewritten.slice(0, 128), original.slice(0, 128));
  assert.equal(rewritten.slice(-128), original.slice(-128));
  fs.writeFileSync(f.file, rewritten + line(event('c', today)));
  assert.equal(total(await collectOpenCodeReviewRows(f)), 1160);
  assert.equal(total(await collectOpenCodeReviewRows(f)), 1160);
  scans.length = 0;
  const corrected = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: 'open-code-review' });
  assert.notEqual(captured.openCodeReviewHistoryRevision, anchor.openCodeReviewHistoryRevision);
  assert.deepEqual(scans, [['--today'], ['--month'], ['--since', '2026-01-01']]);
  assert.deepEqual([corrected.today.totalTokens, corrected.month.totalTokens, corrected.allTime.totalTokens], [250, 1260, 2160]);
  assert.equal(captured.fullScan, true);
});

test('OCR rejects a same-size source rewrite during a scan without publishing a mixed cache', async (t) => {
  const f = fixture(t);
  const original = line(event('a', undefined, { content: 'x'.repeat(1024) }));
  fs.writeFileSync(f.file, original);
  const originalMtime = fs.statSync(f.file).mtimeMs;
  const originalOpen = fs.promises.open;
  t.after(() => { fs.promises.open = originalOpen; });
  fs.promises.open = async (filePath, ...args) => {
    const handle = await originalOpen(filePath, ...args);
    if (filePath === f.file) {
      const createStream = handle.createReadStream.bind(handle);
      handle.createReadStream = (options) => {
        const stream = createStream(options);
        stream.once('data', () => {
          fs.writeFileSync(f.file, original.replace('"prompt_tokens":100', '"prompt_tokens":900'));
          fs.utimesSync(f.file, new Date(), new Date(originalMtime + 1000));
        });
        return stream;
      };
    }
    return handle;
  };
  await assert.rejects(collectOpenCodeReviewRows({ ...f, chunkBytes: 64 }), /source changed during read/);
  assert.equal(fs.existsSync(f.cacheDir), false);
  fs.promises.open = originalOpen;
  assert.equal(total(await collectOpenCodeReviewRows(f)), 920);
});

test('OCR skips large non-usage content, rejects oversized usage events, and honors cancellation', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, line({ content: '\\"é'.repeat(5000), type: 'llm_request' }) + line(event('a')));
  assert.equal(total(await collectOpenCodeReviewRows({ ...f, maxLineBytes: 1024, chunkBytes: 23 })), 120);
  fs.appendFileSync(f.file, line(event('b', undefined, { content: 'x'.repeat(2000) })));
  await assert.rejects(collectOpenCodeReviewRows({ ...f, maxLineBytes: 1024 }), { code: 'OPEN_CODE_REVIEW_READ_BUDGET_EXCEEDED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectOpenCodeReviewRows({ ...f, signal: controller.signal }), { name: 'AbortError' });
});

test('OCR uses local day/month boundaries and the selected all-time start for periods and history', async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 9, 6, 12);
  const times = [new Date(2026, 8, 30, 23, 59), new Date(2026, 9, 1), new Date(2026, 9, 5, 23, 59), new Date(2026, 9, 6)];
  fs.writeFileSync(f.file, times.map((at, i) => line(event(String(i), at.toISOString()))).join(''));
  const rows = await collectOpenCodeReviewRows(f);
  const periods = buildOpenCodeReviewPeriods({ rows, now, allTimeSince: '2026-09-01' });
  assert.deepEqual(['today', 'month', 'allTime'].map((key) => extractUsageFromTokscale(periods[key]).totalTokens), [120, 360, 480]);
  assert.equal(extractUsageFromTokscale(buildOpenCodeReviewPeriods({ rows, now, allTimeSince: '2026-10-01' }).allTime).totalTokens, 360);
  assert.deepEqual(buildOpenCodeReviewHistoryGraph({ rows }).contributions.map((day) => day.date), ['2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06']);
  assert.ok(periods.today.entries.every((entry) => !('cost' in entry) && !('duration' in entry)));
});

test('OCR registration detects and watches only its source, with stable aliases and opt-in tracking', (t) => {
  const f = fixture(t);
  const { clientWatchCandidates, clientSourceChecks } = require('../../src/shared/collector');
  const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = require('../../src/shared/clientTracking');
  const { normalizeClientName } = require('../../src/shared/usage');
  assert.ok(!DEFAULT_CLIENTS.split(',').includes('open-code-review'));
  assert.ok(KNOWN_CLIENTS.split(',').includes('open-code-review'));
  assert.equal(clientsCsvForSetting('ocr,opencodereview,open-code-review'), 'open-code-review');
  for (const name of ['ocr', 'opencodereview', 'Open Code Review', 'open-code-review']) {
    assert.equal(normalizeClientName(name), 'open-code-review');
  }
  assert.deepEqual(clientWatchCandidates('open-code-review', f)['open-code-review'], [path.dirname(path.dirname(f.file))]);
  assert.deepEqual(clientSourceChecks('open-code-review', f)['open-code-review'], [{ id: 'open-code-review-sessions', exists: true }]);
});

test('collector adds OCR once to all windows and history, then applies an exact targeted today delta', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const now = new Date(2026, 9, 6, 12);
  const yesterday = new Date(2026, 9, 5, 10).toISOString();
  const today = new Date(2026, 9, 6, 10).toISOString();
  fs.writeFileSync(f.file, line(event('old', yesterday)) + line(event('today', today)));
  const scans = [];
  let captured;
  const options = { homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now, clients: 'claude,open-code-review',
    allTimeSince: '2026-01-01', deviceId: 'ocr-test', platform: 'linux', env: {}, wslScanEnabled: false,
    includeHistory: true, onAnchorComputed: (value) => { captured = value; },
    runTokscale: async ({ clients, flags }) => {
      assert.equal(clients, 'claude', 'the native client must never reach tokscale');
      scans.push(flags);
      return { entries: [{ client: 'claude', input: flags[0] === '--today' ? 10 : flags[0] === '--month' ? 100 : 1000 }] };
    },
    runGraph: async ({ clients }) => { assert.equal(clients, 'claude'); return { contributions: [] }; }
  };
  const full = await collectUsageOnce(options);
  assert.deepEqual(scans, [['--today'], ['--month'], ['--since', '2026-01-01']]);
  assert.deepEqual([full.today.totalTokens, full.month.totalTokens, full.allTime.totalTokens], [130, 340, 1240]);
  assert.equal(full.history.summary.totalTokens, 240);
  assert.equal(full.clientHealth.clients['open-code-review'].source.state, 'detected');
  const anchor = { dateKey: localTodayKey(now), ...captured.windowsPeriods, todayPartitions: captured.todayPartitions,
    openCodeReviewHistoryRevision: captured.openCodeReviewHistoryRevision };
  fs.appendFileSync(f.file, line(event('append', today)));
  scans.length = 0;
  const watchOptions = { ...options, includeHistory: false, todayOnlyAnchor: anchor, targetClients: 'open-code-review' };
  const watched = await collectUsageOnce(watchOptions);
  assert.deepEqual(scans, []);
  assert.deepEqual([watched.today.totalTokens, watched.month.totalTokens, watched.allTime.totalTokens], [250, 460, 1360]);
  assert.equal(watched.today.clients.claude, 10);
  const unchanged = await collectUsageOnce(watchOptions);
  assert.deepEqual([unchanged.today.totalTokens, unchanged.month.totalTokens, unchanged.allTime.totalTokens], [250, 460, 1360]);

  fs.appendFileSync(f.file, line(event('history-import', yesterday)));
  const corrected = await collectUsageOnce(watchOptions);
  assert.deepEqual(scans, [['--today'], ['--month'], ['--since', '2026-01-01']]);
  assert.deepEqual([corrected.today.totalTokens, corrected.month.totalTokens, corrected.allTime.totalTokens], [250, 580, 1480]);
  assert.equal(captured.fullScan, true);
});

test('collector isolates OCR read failures and retains complete usage while other clients refresh', async (t) => {
  for (const [name, badLine] of [
    ['malformed', '{"private-message":\n'],
    ['invalid tokens', line(event('bad', undefined, { usage: { prompt_tokens: -1, completion_tokens: 1 } }))],
    ['duplicate uuid', line(event('today', undefined, { usage: { prompt_tokens: 200, completion_tokens: 20 } }))],
    ['read budget', line(event('bad', undefined, { model: 'private-model'.repeat(6000) }))]
  ]) await t.test(name, async (t) => {
    const f = fixture(t);
    const { startCollector } = require('../../src/shared/collector');
    let now = new Date(2026, 9, 6, 12);
    const old = new Date(2026, 9, 5, 10).toISOString();
    const today = new Date(2026, 9, 6, 10).toISOString();
    const good = line(event('old', old)) + line(event('today', today));
    fs.writeFileSync(f.file, good);
    const updates = [], scans = [], logs = [], errors = [], previews = [];
    let claudeTokens = 10;
    const runtime = startCollector({
      homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now: () => now,
      clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-failure-test',
      platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false,
      anchorPersistenceEnabled: false, dailyHistoryArchiveEnabled: false, projectsEnabled: false,
      onUpdate: (summary) => { updates.push(summary); }, onPreview: (summary) => { previews.push(summary); },
      onError: (error) => { errors.push(error); }, logger: (message) => { logs.push(message); },
      runTokscale: async ({ flags }) => {
        scans.push(flags);
        return { entries: [{ client: 'claude', input: claudeTokens }] };
      },
      runGraph: async () => ({ contributions: [] })
    });
    t.after(() => runtime.stop());
    await runtime.whenIdle();
    assert.equal(updates.at(-1).allTime.totalTokens, 250);
    fs.appendFileSync(f.file, line(event('append', today)));
    assert.equal(await runtime.refreshClient('open-code-review'), true);
    assert.equal(updates.at(-1).today.totalTokens, 250);
    fs.appendFileSync(f.file, badLine);
    claudeTokens = 20;
    scans.length = 0;
    assert.equal(await runtime.tick('watch:change', { todayOnly: true, forceHistory: true }), true);
    const watched = updates.at(-1);
    assert.deepEqual([watched.today.totalTokens, watched.month.totalTokens, watched.allTime.totalTokens], [260, 380, 380]);
    assert.deepEqual(scans, [['--today']], 'bad OCR input must not trigger a history-revision full scan');
    assert.equal(watched.history.summary.totalTokens, 360, 'history keeps the complete OCR reading');
    assert.deepEqual(errors, []);
    assert.ok(logs.some((message) => message.startsWith('open-code-review parse failed:')));
    assert.ok(logs.every((message) => !message.includes(f.homeDir) && !message.includes('private-')));
    previews.length = 0;
    assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
    assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].totalTokens), [260, 380, 380]);
    assert.ok(previews.every((preview) => preview.today.clients['open-code-review'] === 240));
    now = new Date(2026, 10, 1, 12);
    assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
    assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].totalTokens), [20, 20, 380]);
    fs.writeFileSync(f.file, good + line(event('append', today)) + line(event('import', old)));
    assert.equal(await runtime.refreshClient('open-code-review'), true);
    assert.equal(updates.at(-1).allTime.totalTokens, 500, 'a repaired historical import replaces cached totals');
  });
});

test('an initial OCR failure archives healthy clients without accepting partial OCR history', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce } = require('../../src/shared/collector');
  fs.writeFileSync(f.file, line(event('valid')) + '{"private-message":\n');
  const statuses = [];
  let graphReads = 0;
  const archivePath = path.join(f.homeDir, 'daily-history.json');
  const summary = await collectUsageOnce({
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now: new Date(2026, 9, 6, 12),
    clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-first-failure',
    platform: 'linux', env: {}, wslScanEnabled: false, includeHistory: true,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: archivePath },
    onHistoryStatus: (status) => statuses.push(status),
    logger: () => { throw new Error('logging failed'); },
    runTokscale: async () => ({ entries: [{ client: 'claude', input: 10 }] }),
    runGraph: async () => { graphReads += 1; return { contributions: [] }; }
  });
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => summary[period].totalTokens), [10, 10, 10]);
  assert.equal(summary.history?.summary.totalTokens, 10);
  assert.equal(graphReads, 1);
  assert.equal(statuses.at(-1).failureCode, 'open-code-review-history-unavailable');
  const archived = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.deepEqual(Object.values(archived.liveDays['2026-10-06'].observations).map(({ client, tokens }) => [client, tokens]), [['claude', 10]]);
});

test('persistent cold OCR failure keeps healthy interval scans and daily archives progressing', async (t) => {
  const f = fixture(t);
  const { startCollector } = require('../../src/shared/collector');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 6, 12).getTime() });
  fs.writeFileSync(f.file, line(event('partial', new Date().toISOString())) + '{bad json}\n');
  const archivePath = path.join(f.homeDir, 'daily-history.json');
  const updates = [], scans = [];
  let claudeTokens = 10;
  const runtime = startCollector({
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir,
    clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-persistent-test',
    platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false,
    intervalMs: 1000, historyIntervalMs: 1000, anchorPersistenceEnabled: false,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: archivePath },
    onUpdate: (summary) => updates.push(summary),
    runTokscale: async ({ flags }) => { scans.push(flags); return { entries: [{ client: 'claude', input: claudeTokens }] }; },
    runGraph: async () => ({ contributions: [{ date: '2026-10-05', clients: [
      { client: 'claude', modelId: 'healthy', tokens: { input: claudeTokens, output: 0 } }
    ] }] })
  });
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  const firstTickAt = new Date().toISOString();
  for (const tokens of [20, 30]) {
    claudeTokens = tokens;
    scans.length = 0;
    await new Promise(setImmediate);
    t.mock.timers.tick(1000);
    await runtime.whenIdle();
    assert.deepEqual(scans, [['--today']], 'persistent OCR failure must not repeat healthy full scans each interval');
    assert.equal(runtime.getDiagnostics().lastFullScanAt, firstTickAt);
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    assert.equal(Object.values(archive.liveDays['2026-10-06'].observations).find(({ client }) => client === 'claude').tokens, tokens);
    assert.equal(Object.values(archive.days['2026-10-05'].observations).find(({ client }) => client === 'claude').tokens, tokens);
    assert.equal(updates.at(-1).today.totalTokens, tokens);
    assert.equal(updates.at(-1).clientHealth.clients['open-code-review'].collection.state, 'failed');
    assert.equal(runtime.getDiagnostics().lastHistorySuccessAt, null);
  }
});

test('cold OCR failure preserves archived OCR while healthy live usage grows across rollover and recovery', async (t) => {
  const f = fixture(t);
  const { startCollector } = require('../../src/shared/collector');
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 31, 12).getTime() });
  const archivePath = path.join(f.homeDir, 'daily-history.json');
  const good = line(event('complete', new Date().toISOString()));
  fs.writeFileSync(f.file, good);
  const updates = [];
  let claudeTokens = 15;
  let visibleClaudeTokens = null;
  let transforms = 0;
  const options = {
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir,
    clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-rollover-test',
    platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false, anchorPersistenceEnabled: false,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: archivePath },
    onUpdate: (summary) => {
      updates.push(summary);
      transforms += 1;
      return visibleClaudeTokens === null ? summary : {
        ...summary, today: extractUsageFromTokscale({ entries: [{ client: 'claude', input: visibleClaudeTokens }] })
      };
    },
    runTokscale: async () => ({ entries: [{ client: 'claude', input: claudeTokens }] }),
    runGraph: async () => ({ contributions: [] })
  };
  let runtime = startCollector(options);
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  const initialArchive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const oldOcr = Object.values(initialArchive.liveDays['2026-10-31'].observations).find(({ client }) => client === 'open-code-review');
  runtime.stop();
  fs.appendFileSync(f.file, '{bad json}\n');
  claudeTokens = 30;
  runtime = startCollector(options);
  await runtime.whenIdle();
  for (const tokens of [30, 200]) {
    claudeTokens = tokens;
    assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    const observations = Object.values(archive.liveDays['2026-10-31'].observations);
    assert.equal(observations.find(({ client }) => client === 'claude').tokens, tokens);
    assert.deepEqual(observations.find(({ client }) => client === 'open-code-review'), oldOcr);
    assert.equal(updates.at(-1).today.totalTokens, tokens, 'cold OCR failure must not invent current usage from archive rows');
  }
  const previousTransforms = transforms;
  visibleClaudeTokens = 250;
  assert.equal(await runtime.tick('manual'), true);
  assert.equal(transforms, previousTransforms + 1);
  const visibleArchive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.equal(Object.values(visibleArchive.liveDays['2026-10-31'].observations).find(({ client }) => client === 'claude').tokens, 250);
  visibleClaudeTokens = null;
  t.mock.timers.setTime(new Date(2026, 10, 1, 12).getTime());
  claudeTokens = 40;
  assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
  const rolled = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  assert.equal(Object.values(rolled.liveDays['2026-11-01'].observations).find(({ client }) => client === 'claude').tokens, 40);
  assert.equal(Object.values(rolled.liveDays['2026-11-01'].observations).some(({ client }) => client === 'open-code-review'), false);
  assert.equal(updates.at(-1).history.daily.find(({ date }) => date === '2026-10-31').tokens, 370);
  fs.writeFileSync(f.file, good + line(event('repaired-today', new Date().toISOString())));
  assert.equal(await runtime.refreshClient('open-code-review'), true);
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => updates.at(-1)[period].totalTokens), [160, 160, 280]);
  assert.equal(updates.at(-1).clientHealth.clients['open-code-review'].collection.state, 'direct');
});

test('collector OCR fallback stays within its runtime while archives retain earlier complete usage', async (t) => {
  const f = fixture(t);
  const { startCollector } = require('../../src/shared/collector');
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 6, 12).getTime() });
  const archivePath = path.join(f.homeDir, 'daily-history.json');
  const updates = [];
  const options = {
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now: new Date(2026, 9, 6, 12),
    clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-lifecycle-test',
    platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false, anchorPersistenceEnabled: false,
    dailyHistoryArchiveEnabled: true, dailyHistoryArchiveOptions: { path: archivePath },
    onUpdate: (summary) => { updates.push(summary); },
    runTokscale: async () => ({ entries: [{ client: 'claude', input: 10 }] }),
    runGraph: async () => ({ contributions: [] })
  };
  fs.writeFileSync(f.file, line(event('valid', new Date(2026, 9, 6, 10).toISOString())));
  let runtime = startCollector(options);
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  const saved = fs.readFileSync(archivePath, 'utf8');
  const successfulHistoryAt = runtime.getDiagnostics().lastHistorySuccessAt;
  t.mock.timers.setTime(Date.now() + 1000);
  fs.appendFileSync(f.file, '{bad json}\n');
  assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
  assert.equal(updates.at(-1).allTime.totalTokens, 130);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), saved);
  assert.equal(runtime.getDiagnostics().lastHistorySuccessAt, successfulHistoryAt);
  assert.equal(runtime.getDiagnostics().lastFullScanAt, new Date().toISOString());
  assert.equal(runtime.getDiagnostics().lastHistoryFailureCode, 'open-code-review-history-unavailable');
  runtime.stop();
  runtime = startCollector({ ...options, allTimeSince: '2026-10-06' });
  await runtime.whenIdle();
  assert.equal(updates.at(-1).allTime.totalTokens, 10, 'a replacement runtime cannot borrow an old OCR snapshot');
  assert.equal(updates.at(-1).history.summary.totalTokens, 130);
  assert.equal(fs.readFileSync(archivePath, 'utf8'), saved);
  fs.writeFileSync(f.file, '');
  assert.equal(await runtime.tick('manual', { forceHistory: true }), true);
  assert.equal(updates.at(-1).allTime.totalTokens, 10, 'a successful empty source replaces cached usage');
});

test('collector propagates OCR abort errors and aborted signals with ordinary error reasons', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce } = require('../../src/shared/collector');
  fs.writeFileSync(f.file, line(event('valid')));
  const originalOpen = fs.promises.open;
  t.after(() => { fs.promises.open = originalOpen; });
  for (const kind of ['named', 'coded', 'signal']) {
    const controller = new AbortController();
    const error = new Error('cancelled test read');
    if (kind === 'named') error.name = 'AbortError';
    if (kind === 'coded') error.code = 'ABORT_ERR';
    fs.promises.open = async (filePath, ...args) => {
      if (filePath === f.file) {
        if (kind === 'signal') controller.abort(error);
        throw error;
      }
      return originalOpen(filePath, ...args);
    };
    await assert.rejects(collectUsageOnce({
      homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, clients: 'open-code-review',
      signal: controller.signal, wslScanEnabled: false, historyEnabled: false
    }), (actual) => actual === error);
  }
});

test('a failed OCR read keeps a supplied anchor partition without a runtime row cache', async (t) => {
  const f = fixture(t);
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const now = new Date(2026, 9, 6, 12);
  fs.writeFileSync(f.file, line(event('valid', new Date(2026, 9, 6, 10).toISOString())));
  let captured;
  const options = {
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now,
    clients: 'claude,open-code-review', allTimeSince: '2026-01-01', deviceId: 'ocr-anchor-test',
    platform: 'linux', env: {}, wslScanEnabled: false,
    onAnchorComputed: (value) => { captured = value; },
    runTokscale: async () => ({ entries: [{ client: 'claude', input: 10 }] }),
    runGraph: async () => ({ contributions: [] })
  };
  await collectUsageOnce(options);
  const anchor = { dateKey: localTodayKey(now), ...captured.windowsPeriods,
    todayPartitions: captured.todayPartitions, openCodeReviewHistoryRevision: captured.openCodeReviewHistoryRevision };
  fs.appendFileSync(f.file, '{bad json}\n');
  const summary = await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, targetClients: 'open-code-review', includeHistory: true });
  assert.deepEqual(['today', 'month', 'allTime'].map((period) => summary[period].totalTokens), [130, 130, 130]);
  assert.equal(captured.fullScan, false);
  assert.equal(summary.history, undefined);
  assert.equal(summary.clientHealth.clients['open-code-review'].collection.state, 'failed');
});

test('a restored anchor without OCR partitions cannot certify a failed cold read as zero usage', async (t) => {
  const f = fixture(t);
  const { startCollector } = require('../../src/shared/collector');
  const previousSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = path.join(f.homeDir, 'shared');
  t.after(() => {
    if (previousSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previousSharedDir;
  });
  const now = new Date();
  fs.writeFileSync(f.file, line(event('valid', now.toISOString())));
  const updates = [], scans = [];
  const options = {
    homeDir: f.homeDir, openCodeReviewCacheDir: f.cacheDir, now,
    clients: 'claude,open-code-review', allTimeSince: '2024-01-01', deviceId: 'ocr-cold-test',
    platform: 'linux', env: {}, wslScanEnabled: false, watchEnabled: false,
    onUpdate: (summary) => { updates.push(summary); },
    runTokscale: async ({ flags }) => { scans.push(flags); return { entries: [{ client: 'claude', input: 10 }] }; },
    runGraph: async () => ({ contributions: [] })
  };
  let runtime = startCollector(options);
  t.after(() => runtime.stop());
  await runtime.whenIdle();
  const anchorPath = path.join(process.env.TOKEN_MONITOR_SHARED_DIR, 'collector-anchor.json');
  const saved = fs.readFileSync(anchorPath, 'utf8');
  assert.equal(JSON.parse(saved).todayPartitions, undefined);
  runtime.stop();
  fs.appendFileSync(f.file, '{bad json}\n');
  scans.length = 0;
  runtime = startCollector(options);
  await runtime.whenIdle();
  const summary = updates.at(-1);
  assert.equal(summary.history, undefined);
  assert.equal(summary.clientHealth.clients['open-code-review'].collection.state, 'failed');
  assert.equal(summary.clientHealth.clients['open-code-review'].overall, 'attention');
  assert.ok(!summary.clientHealth.clients['open-code-review'].diagnostics?.some(({ code }) => code === 'no-usage-observed'));
  assert.deepEqual(scans, [['--today'], ['--month'], ['--since', '2024-01-01']]);
  assert.equal(fs.readFileSync(anchorPath, 'utf8'), saved);
});
