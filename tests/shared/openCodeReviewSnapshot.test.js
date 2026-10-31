'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { compactOpenCodeReviewRows, buildOpenCodeReviewPeriods,
  buildOpenCodeReviewHistoryGraph } = require('../../src/shared/providers/open-code-review/usage');

function row(sessionId, model, createdAt, tokens = {}) {
  const values = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, ...tokens };
  return { uuid: `${sessionId}-${model}-${createdAt}`, sessionId, model, createdAt,
    ...values, prompt: values.input + values.cacheRead + values.cacheWrite };
}

function assertProjections(rows, options) {
  const snapshot = compactOpenCodeReviewRows(rows);
  const periods = buildOpenCodeReviewPeriods({ ...options, rows: snapshot });
  const graph = buildOpenCodeReviewHistoryGraph({ rows: snapshot });
  assert.deepEqual(periods, buildOpenCodeReviewPeriods({ ...options, rows }));
  assert.deepEqual(graph, buildOpenCodeReviewHistoryGraph({ rows }));
  return { periods, graph, snapshot };
}

test('compact OCR projections preserve qualifying row order, session groups, and message counts', () => {
  const old = new Date(2026, 9, 31, 10).getTime();
  const today = new Date(2026, 10, 1, 10).getTime();
  const rows = [row('alpha', 'two', old), row('beta', 'one', today), row('alpha', 'two', today),
    row('gamma', 'one', today), row('alpha', 'one', today), row('beta', 'one', today + 1),
    row('gamma', 'one', old)];
  const options = { now: new Date(2026, 10, 1, 12), allTimeSince: '2026-01-01' };
  const { periods, graph, snapshot } = assertProjections(rows, options);
  const keys = (period) => period.entries.map(({ sessionId, model, messageCount }) => [sessionId, model, messageCount]);
  assert.deepEqual(keys(periods.today), [['open-code-review:beta', 'one', 2], ['open-code-review:alpha', 'two', 1],
    ['open-code-review:gamma', 'one', 1], ['open-code-review:alpha', 'one', 1]]);
  assert.deepEqual(keys(periods.allTime), [['open-code-review:alpha', 'two', 2], ['open-code-review:beta', 'one', 2],
    ['open-code-review:gamma', 'one', 2], ['open-code-review:alpha', 'one', 1]]);
  assert.deepEqual(graph.contributions.map(({ date, clients }) => [date, clients.map(({ modelId, messages }) => [modelId, messages])]),
    [['2026-10-31', [['two', 1], ['one', 1]]], ['2026-11-01', [['one', 2], ['two', 1], ['one', 1], ['one', 1]]]]);
  rows[0].input = 1000;
  rows[0].sessionId = 'changed';
  rows.length = 0;
  assert.deepEqual(buildOpenCodeReviewPeriods({ ...options, rows: snapshot }), periods);
  assert.deepEqual(buildOpenCodeReviewHistoryGraph({ rows: snapshot }), graph);
});

test('compact OCR periods retain exact inclusive timestamp boundaries and numeric since values', () => {
  const now = new Date(2026, 10, 2, 12).getTime();
  const today = new Date(2026, 10, 2).getTime();
  const month = new Date(2026, 10, 1).getTime();
  const times = [month - 1, month, month + 1, today - 1, today, today + 1, now - 1, now, now + 1];
  const rows = times.map((time, i) => row(String(i), 'model', time));
  for (const [allTimeSince, expected] of [[today + 1, 3], ['2026-11-02', 4], [now + 1, 0], [0, 8]]) {
    const { periods, graph } = assertProjections(rows, { now, allTimeSince });
    assert.equal(periods.today.entries.length, 4);
    assert.equal(periods.month.entries.length, 7);
    assert.equal(periods.allTime.entries.length, expected);
    assert.equal(graph.contributions.reduce((n, day) => n + day.clients.length, 0), rows.length,
      'history must keep future events even when live periods exclude them');
  }
  assertProjections([], { now, allTimeSince: today });
});

test('compact OCR token columns preserve values above 32 bits and Number addition order', () => {
  const now = new Date(2026, 9, 6, 12);
  const at = now.getTime() - 1;
  const values = [Number.MAX_SAFE_INTEGER, 2, 1];
  const rows = values.map((output, i) => row('session', 'model', at - i,
    { input: 2 ** 32 + i, output, cacheRead: 2 ** 33 + i, cacheWrite: 2 ** 34 + i }));
  const { periods, graph } = assertProjections(rows, { now });
  const entry = periods.today.entries[0];
  assert.deepEqual([entry.input, entry.output, entry.cacheRead, entry.cacheWrite, entry.messageCount],
    [3 * 2 ** 32 + 3, 2 ** 53, 3 * 2 ** 33 + 3, 3 * 2 ** 34 + 3, 3]);
  assert.equal(graph.contributions[0].clients[0].tokens.output, 2 ** 53);
});

test('compact OCR snapshots compute calendar days in the timezone used at projection time', (t) => {
  const oldTimezone = process.env.TZ;
  t.after(() => {
    if (oldTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = oldTimezone;
  });
  process.env.TZ = 'UTC';
  const rows = [row('session', 'model', Date.parse('2026-11-01T00:30:00Z'))];
  const snapshot = compactOpenCodeReviewRows(rows);
  assert.equal(buildOpenCodeReviewHistoryGraph({ rows: snapshot }).contributions[0].date, '2026-11-01');
  process.env.TZ = 'America/Los_Angeles';
  assert.deepEqual(buildOpenCodeReviewHistoryGraph({ rows: snapshot }), buildOpenCodeReviewHistoryGraph({ rows }));
  assert.equal(buildOpenCodeReviewHistoryGraph({ rows: snapshot }).contributions[0].date, '2026-10-31');
  const options = { now: new Date('2026-11-01T12:00:00Z'), allTimeSince: '2026-11-01' };
  const periods = buildOpenCodeReviewPeriods({ ...options, rows: snapshot });
  assert.deepEqual(periods, buildOpenCodeReviewPeriods({ ...options, rows }));
  assert.deepEqual(periods, { today: { entries: [] }, month: { entries: [] }, allTime: { entries: [] } });
});
