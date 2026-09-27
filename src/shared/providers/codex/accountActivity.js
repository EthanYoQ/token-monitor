'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FRESHNESS_MS = 60 * 60 * 1000;

function isAccountActivityStale(snapshot, nowMs = Date.now()) {
  if (!snapshot) return false;
  const ageMs = nowMs - Date.parse(snapshot.fetchedAt);
  return !Number.isFinite(ageMs) || ageMs > FRESHNESS_MS || ageMs < -5 * 60 * 1000;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAccountActivity(raw, accountKey) {
  const activity = raw?.codexAccountActivity;
  const lifetimeTokens = tokenCount(activity?.lifetimeTokens);
  if (!accountKey || activity?.status !== 'available' || activity?.source !== 'codex-app-server' || lifetimeTokens === null) return null;
  const fetchedAtMs = Date.parse(activity.fetchedAt || '');
  if (!Number.isFinite(fetchedAtMs)) return null;
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const dailyUsageBuckets = [];
  const seen = new Set();
  if (activity.dailyUsageBuckets != null && !Array.isArray(activity.dailyUsageBuckets)) return null;
  for (const bucket of activity.dailyUsageBuckets || []) {
    const date = bucket?.startDate;
    const tokens = tokenCount(bucket?.tokens);
    if (!DAY_RE.test(date || '') || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || tokens === null || seen.has(date)) return null;
    seen.add(date);
    dailyUsageBuckets.push({ date, tokens });
  }
  dailyUsageBuckets.sort((a, b) => a.date.localeCompare(b.date));
  const sum = dailyUsageBuckets.reduce((total, bucket) => total + bucket.tokens, 0);
  return {
    version: 1,
    accountKey,
    source: 'codex-app-server',
    fetchedAt,
    lifetimeTokens,
    dailyUsageBuckets,
    dailyCoverageComplete: dailyUsageBuckets.length > 0 && Number.isSafeInteger(sum) && sum === lifetimeTokens
  };
}

function selectAccountActivity(current, incoming, { correctionConfirmed = false } = {}) {
  if (!incoming) return { snapshot: current || null, conflict: false };
  if (!current || current.accountKey !== incoming.accountKey) return { snapshot: incoming, conflict: false };
  if (incoming.fetchedAt < current.fetchedAt) return { snapshot: current, conflict: false };
  if (incoming.lifetimeTokens < current.lifetimeTokens && !correctionConfirmed) return { snapshot: current, conflict: true };
  return { snapshot: incoming, conflict: false };
}

function applyAccountActivityToStats(stats, snapshot, allTimeSince, localDeviceId = '', singleAccount = true, nowMs = Date.now()) {
  if (!stats || !snapshot) return stats;
  if (!singleAccount) return { ...stats, codexAccountActivity: { status: 'scope-unverified', fetchedAt: snapshot.fetchedAt } };
  if (stats.codexAccountActivity?.source === snapshot.source && stats.codexAccountActivity?.fetchedAt === snapshot.fetchedAt) return stats;
  const earliest = snapshot.dailyUsageBuckets?.[0]?.date;
  const covered = snapshot.dailyCoverageComplete === true && earliest && allTimeSince <= earliest;
  if (!covered) return { ...stats, codexAccountActivity: { status: 'range-unverified', fetchedAt: snapshot.fetchedAt } };
  if (Array.isArray(stats.devices) && stats.devices.some((device) =>
    device.deviceId !== localDeviceId && Number(device.periods?.allTime?.clients?.codex || 0) > 0)) {
    return { ...stats, codexAccountActivity: { status: 'scope-unverified', fetchedAt: snapshot.fetchedAt } };
  }
  const original = stats.periods?.allTime;
  if (!original) return stats;
  const localTokens = Number(original.clients?.codex || 0);
  const officialTokens = snapshot.lifetimeTokens;
  const stale = isAccountActivityStale(snapshot, nowMs);
  if (!Number.isSafeInteger(localTokens) || localTokens < 0
    || !Number.isSafeInteger(original.totalTokens)
    || !Number.isSafeInteger(original.totalTokens - localTokens + officialTokens)) {
    return { ...stats, codexAccountActivity: { status: 'conflict', fetchedAt: snapshot.fetchedAt } };
  }
  const period = {
    ...original,
    capabilities: { ...original.capabilities, tokenComponents: false },
    clients: { ...original.clients, codex: officialTokens },
    clientCacheReads: { ...original.clientCacheReads },
    clientCacheWrites: { ...original.clientCacheWrites },
    clientOutputs: { ...original.clientOutputs },
    clientUnclassifiedTokens: { ...original.clientUnclassifiedTokens, codex: officialTokens },
    totalTokens: original.totalTokens - localTokens + officialTokens,
    cacheReadTokens: Math.max(0, original.cacheReadTokens - (original.clientCacheReads?.codex || 0)),
    cacheWriteTokens: Math.max(0, original.cacheWriteTokens - (original.clientCacheWrites?.codex || 0)),
    outputTokens: Math.max(0, original.outputTokens - (original.clientOutputs?.codex || 0)),
    unclassifiedTokens: Math.max(0, original.unclassifiedTokens - (original.clientUnclassifiedTokens?.codex || 0)) + officialTokens
  };
  delete period.clientCacheReads.codex;
  delete period.clientCacheWrites.codex;
  delete period.clientOutputs.codex;
  if (localTokens > officialTokens) {
    // A local rollup above the account total cannot be a trustworthy partial
    // breakdown. Suppress the all-time details instead of inventing a split.
    for (const field of ['models', 'modelCosts', 'modelCacheReads', 'modelCacheWrites',
      'modelOutputs', 'modelUnclassifiedTokens', 'projects', 'sessions']) period[field] = {};
    period.clientModels = {};
    period.clientModelCosts = {};
    period.clientCosts = { ...original.clientCosts };
    period.costUsd = Math.max(0, original.costUsd - (period.clientCosts.codex || 0));
    delete period.clientCosts.codex;
    period.capabilities.throughput = false;
    period.timedTokens = 0;
    period.timedOutputTokens = 0;
    period.timedDurationMs = 0;
  }
  let status = 'applied';
  if (stale) status = 'stale';
  else if (localTokens > officialTokens) status = 'conflict';
  const result = {
    ...stats,
    periods: { ...stats.periods, allTime: period },
    codexAccountActivity: {
      status,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      lifetimeTokens: officialTokens,
      localDetailTokens: localTokens,
      detailsSuppressed: localTokens > officialTokens,
      dateBoundary: 'source-defined'
    }
  };
  if (localTokens > officialTokens) delete result.allTimeSessionsView;
  return result;
}

module.exports = { normalizeAccountActivity, selectAccountActivity, applyAccountActivityToStats, isAccountActivityStale };
