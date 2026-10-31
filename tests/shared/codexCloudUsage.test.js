'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCloudUsageNotification, normalizeCloudUsageState, reduceCloudUsage, projectCloudUsage } = require('../../src/shared/providers/codex/cloudUsage');

const time = (day, hour = 12) => new Date(2026, 9, day, hour).getTime();
const event = (totalTokens, threadId = 'thread-1') => ({ threadId, totalTokens });
const apply = (state, totalTokens, receivedAt = time(20), continuous = true) =>
  reduceCloudUsage(state, event(totalTokens), { receivedAt, continuous }).state;

test('cloud events accept official safe totals and discard unrelated content', () => {
  const message = { method: 'thread/tokenUsage/updated', params: {
    threadId: 'thread-1', turnId: 'turn-1', content: 'private text',
    tokenUsage: { total: { totalTokens: 200, inputTokens: 180, outputTokens: 20,
      cachedInputTokens: 150, reasoningOutputTokens: 10 }, last: { totalTokens: 30 } }
  } };
  assert.deepEqual(normalizeCloudUsageNotification(message), event(200));
  assert.equal(normalizeCloudUsageNotification({ ...message, id: 5 }), null);
  for (const totalTokens of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '200', null]) {
    assert.equal(normalizeCloudUsageNotification({ ...message, params: {
      ...message.params, tokenUsage: { total: { totalTokens } }
    } }), null);
  }
  assert.equal(normalizeCloudUsageNotification({ method: 'item/output', params: message.params }), null);
});

test('first cumulative is only a baseline, repeated totals cannot inflate observed usage', () => {
  let state = apply({ threads: {} }, 100);
  assert.equal(projectCloudUsage(state).threads[0].periods.allTime.tokens, null);
  for (const total of [160, 160, 180]) state = apply(state, total);
  const result = projectCloudUsage(state, { nowMs: time(20) });
  assert.equal(result.threads[0].reportedTotalTokens, 180);
  for (const period of Object.values(result.threads[0].periods)) assert.equal(period.tokens, 80);
  assert.equal(result.threads[0].undatedTokens, 0);
  assert.equal(result.periods, undefined);
});

test('real cumulative sample differences count once without adding cache, reasoning or last', () => {
  let state = apply({ threads: {} }, 24_468_861);
  state = apply(state, 25_074_607);
  assert.equal(state.threads['thread-1'].observedTokens, 605_746);
  state = apply(normalizeCloudUsageState(state), 25_074_607, time(20), false);
  assert.equal(state.threads['thread-1'].observedTokens, 605_746);
});

test('disconnected intervals are undated even within one day', () => {
  let state = apply({ threads: {} }, 100);
  state = apply(state, 150, time(20), false);
  let thread = projectCloudUsage(state, { nowMs: time(20) }).threads[0];
  assert.deepEqual(thread.periods, { today: { tokens: null }, month: { tokens: null }, allTime: { tokens: 50 } });
  assert.equal(thread.undatedTokens, 50);
  state = apply(state, 175);
  thread = projectCloudUsage(state, { nowMs: time(20) }).threads[0];
  assert.equal(thread.periods.today.tokens, 25);
  assert.equal(thread.periods.month.tokens, 25);
  assert.equal(thread.periods.allTime.tokens, 75);
});

test('continuous cross-day increments retain known month but do not invent a day', () => {
  let state = apply({ threads: {} }, 100, time(20, 23));
  state = apply(state, 150, time(21, 1));
  const thread = projectCloudUsage(state, { nowMs: time(21) }).threads[0];
  assert.equal(thread.periods.today.tokens, null);
  assert.equal(thread.periods.month.tokens, 50);
  assert.equal(thread.undatedTokens, 50);
  state = apply(state, 200, new Date(2026, 10, 1).getTime());
  assert.equal(projectCloudUsage(state, { nowMs: new Date(2026, 10, 1).getTime() }).threads[0].periods.month.tokens, null);
});

test('counter rollback and clock rollback do not reset a high-water baseline', () => {
  const state = apply({ threads: {} }, 100);
  for (const [totalTokens, receivedAt] of [[80, time(20)], [120, time(19)]]) {
    const result = reduceCloudUsage(state, event(totalTokens), { receivedAt, continuous: true });
    assert.equal(result.anomaly, true);
    assert.equal(result.state, state);
  }
});

test('timezone changes and unobserved dates remain unknown', () => {
  let state = apply({ threads: {} }, 100);
  state.threads['thread-1'].lastOffset += 60;
  state = apply(state, 120);
  const thread = projectCloudUsage(state, { nowMs: time(21) }).threads[0];
  assert.equal(thread.periods.today.tokens, null);
  assert.equal(thread.periods.month.tokens, null);
  assert.equal(thread.undatedTokens, 20);
});

test('persisted state only keeps numeric counters, IDs and times, with separate thread records', () => {
  let state = apply({ threads: {} }, 100);
  state = reduceCloudUsage(state, event(100, 'thread-2'), { receivedAt: time(20) }).state;
  state.threads['thread-1'].prompt = 'private text';
  state.threads['thread-1'].accessToken = 'secret';
  const cleaned = normalizeCloudUsageState(state);
  assert.equal(JSON.stringify(cleaned).includes('private text'), false);
  assert.equal(JSON.stringify(cleaned).includes('secret'), false);
  const result = projectCloudUsage(cleaned, { nowMs: time(20), watchedThreadIds: ['thread-3'] });
  assert.equal(result.threads.length, 3);
  assert.equal(result.threads[2].reportedTotalTokens, null);
  assert.equal(result.threads[2].periods.allTime.tokens, null);
  assert.equal(result.baselinedThreads, 2);
});
