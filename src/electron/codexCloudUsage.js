'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('undici');
const { readJson, sharedDataDir, writeJsonAtomic } = require('../shared/config');
const { readLiveCodexIdentity } = require('../shared/providers/codex/limits');
const { codexAuthIdentity } = require('../shared/providers/codex/auth');
const { liveCodexAuthPath } = require('../shared/providers/codex/systemSwitch');
const { normalizeCloudUsageNotification, normalizeCloudUsageState, reduceCloudUsage, projectCloudUsage } = require('../shared/providers/codex/cloudUsage');

const CLOUD_URL = 'wss://codex-cloud-backend.chatgpt.com/';
const ACCOUNT_KEY = /^sha256:[a-f0-9]{64}$/;

function readCloudAuth() {
  try { return JSON.parse(fs.readFileSync(liveCodexAuthPath(), 'utf8')); } catch (_) { return null; }
}

function createCodexCloudUsage(options = {}) {
  const filePath = options.filePath || path.join(sharedDataDir(), 'codex-cloud-usage.json');
  const readIdentity = options.readIdentity || readLiveCodexIdentity;
  const readAuth = options.readAuth || readCloudAuth;
  const createSocket = options.createSocket || ((url, init) => new WebSocket(url, init));
  const writeState = options.writeState || writeJsonAtomic;
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 15_000;
  const discoveryMs = options.discoveryMs ?? 30_000;
  const stored = readJson(filePath, null);
  let accounts = Object.fromEntries(Object.entries(stored?.version === 1 ? stored.accounts || {} : {})
    .filter(([key]) => ACCOUNT_KEY.test(key)).map(([key, value]) => [key, normalizeCloudUsageState(value)]));
  let lifecycle = 'disabled';
  let accountKey = '';
  let generation = 0;
  let revision = 0;
  let connection = null;
  let pendingRefresh = null;
  let scheduled = null;
  let status = 'unavailable';
  let retryMs = options.reconnectMs ?? 2_000;

  function report(code) {
    try { options.onError?.(new Error(`Codex cloud usage: ${code}`)); } catch (_) {}
  }

  function publish(nextStatus = status) {
    status = nextStatus;
    revision += 1;
    try { options.onChange?.({ revision, status }); } catch (_) {}
  }

  function cancelSchedule() {
    if (scheduled !== null) clearTimer(scheduled);
    scheduled = null;
  }

  function schedule(delay) {
    cancelSchedule();
    if (lifecycle !== 'enabled') return;
    scheduled = setTimer(() => { scheduled = null; void refresh(); }, delay);
    scheduled?.unref?.();
  }

  function closeConnection() {
    generation += 1;
    const old = connection;
    connection = null;
    if (!old) return;
    old.cancelOpen?.();
    for (const request of old.pending.values()) request.reject(new Error('connection-closed'));
    old.pending.clear();
    try { old.socket.close(); } catch (_) {}
  }

  function syncIdentity() {
    let key = '';
    try { key = readIdentity()?.accountKey || ''; } catch (_) {}
    if (!ACCOUNT_KEY.test(key)) key = '';
    if (key !== accountKey) {
      cancelSchedule();
      closeConnection();
      accountKey = key;
      publish('unavailable');
      schedule(0);
    }
    return key;
  }

  function current(session) {
    return lifecycle === 'enabled' && connection === session && session.generation === generation
      && syncIdentity() === session.accountKey;
  }

  function snapshot({ nowMs = now() } = {}) {
    if (lifecycle !== 'enabled') return null;
    const key = syncIdentity();
    if (!key) return null;
    const watched = connection?.watched || new Set();
    return {
      version: 1, source: 'codex-cloud-token-usage', status, revision,
      coverage: 'observed-only', coverageComplete: false, dateBoundary: 'device-local-observation',
      connected: Boolean(connection?.ready), watchedThreads: watched.size,
      discoveryComplete: Boolean(connection?.discoveryComplete),
      ...projectCloudUsage(accounts[key] || { threads: {} }, { nowMs, watchedThreadIds: [...watched] })
    };
  }

  function disconnected(session, code) {
    if (!current(session)) return;
    closeConnection();
    report(code);
    publish('reconnecting');
    schedule(retryMs);
    retryMs = Math.min(retryMs * 2, 60_000);
  }

  function request(session, method, params) {
    return new Promise((resolve, reject) => {
      if (!current(session)) { reject(new Error('connection-closed')); return; }
      const id = ++session.nextId;
      const timer = setTimer(() => {
        session.pending.delete(id);
        reject(new Error('rpc-timeout'));
      }, rpcTimeoutMs);
      const finish = (fn, value) => { clearTimer(timer); session.pending.delete(id); fn(value); };
      session.pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error) });
      try { session.socket.send(JSON.stringify({ id, method, params })); } catch (_) {
        session.pending.get(id)?.reject(new Error('send-failed'));
      }
    });
  }

  function receive(session, raw) {
    if (!current(session) || typeof raw !== 'string' || raw.length > 8 * 1024 * 1024) return;
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (message.id != null && !message.method) {
      const pending = session.pending.get(message.id);
      if (message.error) pending?.reject(new Error('rpc-rejected'));
      else pending?.resolve(message.result);
      return;
    }
    const event = normalizeCloudUsageNotification(message);
    if (!event || !session.watched.has(event.threadId)) return;
    const update = reduceCloudUsage(accounts[accountKey] || { threads: {} }, event, {
      receivedAt: now(), continuous: session.continuous.has(event.threadId)
    });
    if (update.anomaly) { session.continuous.delete(event.threadId); return; }
    if (!update.changed) return;
    const nextAccounts = { ...accounts, [accountKey]: update.state };
    try { writeState(filePath, { version: 1, accounts: nextAccounts }); } catch (_) {
      disconnected(session, 'persistence-failed');
      return;
    }
    accounts = nextAccounts;
    session.continuous.add(event.threadId);
    publish();
  }

  async function connect(key, requestGeneration) {
    const auth = await readAuth();
    if (requestGeneration !== generation || lifecycle !== 'enabled' || syncIdentity() !== key) return null;
    const token = auth?.tokens?.access_token;
    const accountId = auth?.tokens?.account_id;
    if (auth?.auth_mode !== 'chatgpt' || typeof token !== 'string' || !token
      || typeof accountId !== 'string' || !accountId || codexAuthIdentity(auth).accountKey !== key) {
      publish('unavailable');
      schedule(discoveryMs);
      return null;
    }
    const socket = createSocket(CLOUD_URL, {
      protocols: ['codex-app-server', 'codex-client.desktop', `openai-bearer.${token}`],
      headers: { 'ChatGPT-Account-Id': accountId, 'X-OpenAI-Product-Sku': 'codex' }
    });
    const session = { socket, accountKey: key, generation, nextId: 0, pending: new Map(),
      watched: new Set(), continuous: new Set(), ready: false, discoveryComplete: false };
    connection = session;
    publish('connecting');
    socket.addEventListener('message', (event) => receive(session, event.data));
    socket.addEventListener('close', () => disconnected(session, 'connection-closed'));
    socket.addEventListener('error', () => disconnected(session, 'connection-failed'));
    await new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(new Error('connect-timeout')), rpcTimeoutMs);
      session.cancelOpen = () => { clearTimer(timer); reject(new Error('connection-closed')); };
      socket.addEventListener('open', () => { clearTimer(timer); session.cancelOpen = null; resolve(); }, { once: true });
    });
    if (!current(session)) return null;
    await request(session, 'initialize', {
      clientInfo: { name: 'token_monitor', version: '1.0.0' }, capabilities: { experimentalApi: true }
    });
    if (!current(session)) return null;
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    session.ready = true;
    retryMs = options.reconnectMs ?? 2_000;
    publish('observing');
    return session;
  }

  async function discover(session) {
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < 100; page += 1) {
      const result = await request(session, 'thread/list', { limit: 100, sortKey: 'updated_at', archived: false, cursor });
      if (!current(session)) return;
      if (!Array.isArray(result?.data)) throw new Error('invalid-list');
      for (const thread of result.data) {
        if (thread?.status?.type !== 'active' || typeof thread.id !== 'string'
          || !/^[a-zA-Z0-9_-]{1,128}$/.test(thread.id) || session.watched.has(thread.id)) continue;
        // Resume only subscribes to the existing thread. No turn or configuration is sent.
        session.watched.add(thread.id);
        try { await request(session, 'thread/resume', { threadId: thread.id, excludeTurns: true }); } catch (error) {
          session.watched.delete(thread.id);
          throw error;
        }
        if (!current(session)) return;
        publish();
      }
      cursor = result.nextCursor;
      if (cursor == null) { session.discoveryComplete = true; publish(); return; }
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('invalid-cursor');
      seen.add(cursor);
    }
    throw new Error('page-limit');
  }

  function refresh() {
    if (lifecycle !== 'enabled') return Promise.resolve(null);
    const key = syncIdentity();
    if (!key) { schedule(discoveryMs); return Promise.resolve(null); }
    if (pendingRefresh?.generation === generation) return pendingRefresh.promise;
    cancelSchedule();
    const work = { generation, promise: null };
    work.promise = Promise.resolve().then(async () => {
      try {
        if (generation !== work.generation || lifecycle !== 'enabled') return null;
        const session = connection || await connect(key, work.generation);
        if (session && current(session)) {
          session.discoveryComplete = false;
          await discover(session);
          if (current(session)) schedule(discoveryMs);
        }
      } catch (_) {
        if (generation === work.generation && lifecycle === 'enabled') {
          if (connection) disconnected(connection, 'request-failed');
          else { publish('unavailable'); report('authentication-unavailable'); schedule(discoveryMs); }
        }
      } finally {
        if (pendingRefresh === work) pendingRefresh = null;
      }
      return snapshot();
    });
    pendingRefresh = work;
    return work.promise;
  }

  function configure({ enabled, selected }) {
    if (lifecycle === 'disposed') return;
    const next = enabled && selected ? 'enabled' : 'disabled';
    if (next === lifecycle) { if (next === 'enabled' && syncIdentity() && !connection) void refresh(); return; }
    lifecycle = next;
    cancelSchedule();
    closeConnection();
    if (next === 'enabled') {
      if (!syncIdentity()) publish('unavailable');
      void refresh();
    } else publish('unavailable');
  }

  function dispose() {
    lifecycle = 'disposed';
    cancelSchedule();
    closeConnection();
  }

  return { configure, refresh, snapshot, dispose };
}

module.exports = { createCodexCloudUsage };
