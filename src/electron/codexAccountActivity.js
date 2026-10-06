'use strict';

const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('../shared/config');
const { readCodexAccountActivity } = require('../shared/collector');
const { readLiveCodexIdentity } = require('../shared/providers/codex/limits');
const { normalizeAccountActivity, selectAccountActivity } = require('../shared/providers/codex/accountActivity');

const REFRESH_MS = 15 * 60 * 1000;

function createCodexAccountActivity(options = {}) {
  const filePath = options.filePath || path.join(sharedDataDir(), 'codex-account-activity.json');
  const readIdentity = options.readIdentity || readLiveCodexIdentity;
  const readActivity = options.readActivity || readCodexAccountActivity;
  const notify = options.onChange || (() => {});
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const stored = readJson(filePath, { version: 1, accounts: {} });
  const accounts = stored?.version === 1 && stored.accounts && typeof stored.accounts === 'object'
    ? { ...stored.accounts } : {};
  const observedKeys = new Set([
    ...Object.keys(accounts),
    ...(Array.isArray(stored?.observedAccountKeys) ? stored.observedAccountKeys.filter((key) => typeof key === 'string' && key) : [])
  ]);
  const attempts = new Map();
  let pendingAccountRead = null;
  let controller = null;
  let timer = null;
  let lifecycle = 'manual';
  let generation = 0;
  let scopePersistenceFailed = false;

  function reportError(error) {
    try { options.onError?.(error); } catch (_) {}
  }

  function clearScheduledRefresh() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function scheduleRefresh(delay = REFRESH_MS) {
    clearScheduledRefresh();
    if (lifecycle !== 'enabled') return;
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, delay);
    timer?.unref?.();
  }

  function persist() {
    try {
      writeJsonAtomic(filePath, { version: 1, accounts, observedAccountKeys: [...observedKeys] });
      scopePersistenceFailed = false;
    } catch (error) {
      scopePersistenceFailed = true;
      throw error;
    }
  }

  function liveKey() {
    const key = readIdentity().accountKey;
    if (key && !observedKeys.has(key)) {
      observedKeys.add(key);
      try { persist(); } catch (error) {
        scopePersistenceFailed = true;
        reportError(error);
      }
    }
    return key;
  }

  function snapshot() {
    let key;
    try { key = liveKey(); } catch (error) {
      reportError(error);
      return null;
    }
    const saved = key && accounts[key];
    if (!saved) return null;
    if (saved.dailyUsageBuckets != null && !Array.isArray(saved.dailyUsageBuckets)) return null;
    return normalizeAccountActivity({ codexAccountActivity: {
      status: 'available',
      source: saved.source,
      fetchedAt: saved.fetchedAt,
      lifetimeTokens: saved.lifetimeTokens,
      dailyUsageBuckets: saved.dailyUsageBuckets?.map((bucket) => ({ startDate: bucket?.date, tokens: bucket?.tokens }))
    } }, key);
  }

  function refresh({ force = false } = {}) {
    if (lifecycle === 'disabled' || lifecycle === 'disposed') return Promise.resolve(null);
    if (pendingAccountRead) return pendingAccountRead;
    clearScheduledRefresh();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    const isCurrent = () => generation === requestGeneration && !requestController.signal.aborted;
    let notifyAfterReadAttempt = false;
    let nextDelay = REFRESH_MS;
    const deferredAccountRead = Promise.resolve().then(async () => {
      try {
        if (!isCurrent()) return null;
        notifyAfterReadAttempt = true;
        const key = liveKey();
        if (!key) return null;
        const elapsed = now() - (attempts.get(key) ?? -Infinity);
        if (!force && elapsed < REFRESH_MS) {
          notifyAfterReadAttempt = false;
          nextDelay = REFRESH_MS - elapsed;
          return snapshot();
        }
        attempts.set(key, now());
        const raw = await readActivity({ signal: requestController.signal });
        if (!isCurrent() || liveKey() !== key) return null;
        let incoming = normalizeAccountActivity(raw, key);
        if (!incoming) return snapshot();
        const current = snapshot();
        let correctionConfirmed = false;
        if (current && incoming.lifetimeTokens < current.lifetimeTokens) {
          const confirmation = normalizeAccountActivity(await readActivity({ signal: requestController.signal }), key);
          if (!isCurrent() || liveKey() !== key) return null;
          correctionConfirmed = Boolean(incoming.dailyCoverageComplete && confirmation
            && confirmation.lifetimeTokens === incoming.lifetimeTokens
            && confirmation.dailyCoverageComplete
            && JSON.stringify(confirmation.dailyUsageBuckets) === JSON.stringify(incoming.dailyUsageBuckets));
          if (correctionConfirmed) incoming = confirmation;
        }
        const { snapshot: selected, conflict } = selectAccountActivity(current, incoming, { correctionConfirmed });
        if (conflict) {
          options.onConflict?.({ accountKey: key, existing: selected.lifetimeTokens, incoming: incoming.lifetimeTokens });
          return selected;
        }
        if (!isCurrent() || liveKey() !== key) return null;
        accounts[key] = selected;
        persist();
        return selected;
      } catch (error) {
        if (!isCurrent()) return null;
        reportError(error);
        return snapshot();
      } finally {
        if (pendingAccountRead === deferredAccountRead) {
          pendingAccountRead = null;
          controller = null;
          if (isCurrent()) {
            if (notifyAfterReadAttempt) {
              try { notify(snapshot()); } catch (error) { reportError(error); }
            }
            if (!pendingAccountRead) scheduleRefresh(nextDelay);
          } else if (lifecycle === 'enabled') {
            void refresh({ force: true });
          }
        }
      }
    });
    pendingAccountRead = deferredAccountRead;
    return pendingAccountRead;
  }

  function configure({ enabled, selected }) {
    if (lifecycle === 'disposed') return;
    const next = enabled && selected ? 'enabled' : 'disabled';
    if (lifecycle === next) return;
    lifecycle = next;
    generation += 1;
    clearScheduledRefresh();
    if (next === 'enabled') void refresh();
    else controller?.abort();
  }

  function dispose() {
    lifecycle = 'disposed';
    generation += 1;
    clearScheduledRefresh();
    controller?.abort();
  }

  return { snapshot, refresh, configure, dispose, observe: liveKey, multipleAccounts: () => observedKeys.size > 1 || scopePersistenceFailed };
}

module.exports = { createCodexAccountActivity };
