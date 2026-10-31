'use strict';

const THREAD_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => isCount(value) && value <= 8.64e15;

function normalizeCloudUsageNotification(message) {
  if (message?.method !== 'thread/tokenUsage/updated' || message.id != null) return null;
  const { threadId, tokenUsage } = message.params || {};
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) return null;
  const total = tokenUsage?.total;
  if (!total || !isCount(total.totalTokens)) return null;
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens']) {
    if (total[key] != null && !isCount(total[key])) return null;
  }
  return { threadId, totalTokens: total.totalTokens };
}

function dateKeys(time) {
  const date = new Date(time);
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return { day: `${month}-${String(date.getDate()).padStart(2, '0')}`, month, offset: date.getTimezoneOffset() };
}

function normalizeCloudUsageState(value) {
  const threads = Object.create(null);
  for (const [id, entry] of Object.entries(value?.threads || {})) {
    if (!THREAD_ID.test(id) || !entry || !isCount(entry.reportedTotalTokens)
      || !(entry.observedTokens === null || isCount(entry.observedTokens))
      || !isCount(entry.undatedTokens) || !isTime(entry.observedSince) || !isTime(entry.lastEventAt)
      || !Number.isInteger(entry.lastOffset) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.lastDay || '')) continue;
    const buckets = (source, pattern) => Object.fromEntries(Object.entries(source || {}).filter(([key, count]) => pattern.test(key) && isCount(count)));
    threads[id] = {
      reportedTotalTokens: entry.reportedTotalTokens,
      observedTokens: entry.observedTokens,
      undatedTokens: entry.undatedTokens,
      observedSince: entry.observedSince,
      lastEventAt: entry.lastEventAt,
      lastDay: entry.lastDay,
      lastOffset: entry.lastOffset,
      days: buckets(entry.days, /^\d{4}-\d{2}-\d{2}$/),
      months: buckets(entry.months, /^\d{4}-\d{2}$/)
    };
  }
  return { threads };
}

function reduceCloudUsage(state, event, { receivedAt, continuous = false }) {
  const previous = Object.hasOwn(state.threads, event.threadId) ? state.threads[event.threadId] : null;
  if (!isTime(receivedAt) || !isCount(event.totalTokens)) return { state, changed: false, anomaly: true };
  if (previous && (event.totalTokens < previous.reportedTotalTokens || receivedAt < previous.lastEventAt)) {
    return { state, changed: false, anomaly: true };
  }
  const to = dateKeys(receivedAt);
  const next = previous ? { ...previous, days: { ...previous.days }, months: { ...previous.months } } : {
    reportedTotalTokens: event.totalTokens, observedTokens: null, undatedTokens: 0,
    observedSince: receivedAt, lastEventAt: receivedAt, lastDay: to.day, lastOffset: to.offset, days: {}, months: {}
  };
  if (previous) {
    const delta = event.totalTokens - previous.reportedTotalTokens;
    const uninterrupted = continuous && previous.lastOffset === to.offset;
    next.observedTokens = (previous.observedTokens ?? 0) + delta;
    if (uninterrupted && previous.lastDay === to.day) next.days[to.day] = (next.days[to.day] || 0) + delta;
    else next.undatedTokens += delta;
    if (uninterrupted && previous.lastDay.slice(0, 7) === to.month) next.months[to.month] = (next.months[to.month] || 0) + delta;
    if (![next.observedTokens, next.undatedTokens, ...Object.values(next.days), ...Object.values(next.months)].every(isCount)) {
      return { state, changed: false, anomaly: true };
    }
    next.reportedTotalTokens = event.totalTokens;
    next.lastEventAt = receivedAt;
    next.lastDay = to.day;
    next.lastOffset = to.offset;
  }
  return { state: { threads: { ...state.threads, [event.threadId]: next } }, changed: true, anomaly: false };
}

function projectCloudUsage(state, { nowMs = Date.now(), watchedThreadIds = [] } = {}) {
  const { day, month } = dateKeys(nowMs);
  const ids = [...new Set([...Object.keys(state.threads), ...watchedThreadIds])].sort();
  const threads = ids.map((threadId) => {
    const entry = Object.hasOwn(state.threads, threadId) ? state.threads[threadId] : null;
    return {
      threadId,
      reportedTotalTokens: entry?.reportedTotalTokens ?? null,
      periods: {
        today: { tokens: entry?.days[day] ?? null },
        month: { tokens: entry?.months[month] ?? null },
        allTime: { tokens: entry?.observedTokens ?? null }
      },
      undatedTokens: entry?.undatedTokens ?? 0,
      observedSince: entry ? new Date(entry.observedSince).toISOString() : null,
      lastEventAt: entry ? new Date(entry.lastEventAt).toISOString() : null
    };
  });
  const baselines = Object.values(state.threads);
  return {
    threads,
    baselinedThreads: baselines.length,
    observedSince: baselines.length ? new Date(Math.min(...baselines.map((entry) => entry.observedSince))).toISOString() : null,
    lastEventAt: baselines.length ? new Date(Math.max(...baselines.map((entry) => entry.lastEventAt))).toISOString() : null
  };
}

module.exports = { normalizeCloudUsageNotification, normalizeCloudUsageState, reduceCloudUsage, projectCloudUsage };
