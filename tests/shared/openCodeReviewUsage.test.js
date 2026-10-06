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
