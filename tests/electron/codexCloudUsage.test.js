'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCodexCloudUsage } = require('../../src/electron/codexCloudUsage');
const { codexAuthIdentity } = require('../../src/shared/providers/codex/auth');

function auth(account = 'workspace-1') {
  const payload = Buffer.from(JSON.stringify({ email: 'test@example.invalid' })).toString('base64url');
  return { auth_mode: 'chatgpt', tokens: { account_id: account, access_token: 'test-access-token', id_token: `x.${payload}.x` } };
}

function fixture(t, options = {}) {
  const cache = path.resolve(__dirname, '../../.runtime/.cache');
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, 'cloud-usage-test-'));
  const filePath = path.join(dir, 'ledger.json');
  const sockets = [];
  const requests = [];
  const notices = [];
  const timers = new Map();
  let liveAuth = auth();
  let tick = new Date(2026, 9, 31, 12).getTime();
  let timerId = 0;
  class Socket {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => { if (!this.closed) this.emit('open'); });
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) || [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    emit(name, event = {}) { for (const listener of this.listeners.get(name) || []) listener(event); }
    send(raw) {
      const request = JSON.parse(raw);
      requests.push(request);
      if (request.id == null) return;
      const result = options.reply ? options.reply(request) : request.method === 'thread/list'
        ? { data: [{ id: 'thread-1', status: { type: 'active' } }], nextCursor: null } : {};
      if (result === undefined) return;
      queueMicrotask(() => this.message({ id: request.id, result }));
    }
    message(value) { this.emit('message', { data: JSON.stringify(value) }); }
    usage(totalTokens, threadId = 'thread-1') {
      this.message({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { total: { totalTokens } }, text: 'private body' } });
    }
    close() { this.closed = true; this.emit('close'); }
  }
  const observer = createCodexCloudUsage({
    filePath, readIdentity: () => codexAuthIdentity(liveAuth), readAuth: () => liveAuth,
    createSocket: (url, init) => new Socket(url, init), now: () => tick,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), onChange: (notice) => notices.push(notice),
    ...options.observer
  });
  t.after(() => { observer.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { observer, sockets, requests, notices, timers, filePath,
    advance: (ms) => { tick += ms; }, changeAuth: (value) => { liveAuth = value; },
    fire: (delay) => {
      const match = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(match, `missing timer ${delay}`);
      timers.delete(match[0]); match[1].fn();
    },
    start: async () => { observer.configure({ enabled: true, selected: true }); await observer.refresh(); }
  };
}

test('one official socket initializes, follows empty cursor pages and subscribes only to active threads', async (t) => {
  const f = fixture(t, { reply: (request) => {
    if (request.method !== 'thread/list') return {};
    if (request.params.cursor === null) return { data: [], nextCursor: 'page-2' };
    return { data: [{ id: 'thread-1', status: { type: 'active' } }, { id: 'idle-thread', status: { type: 'idle' } }], nextCursor: null };
  } });
  await f.start();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'wss://codex-cloud-backend.chatgpt.com/');
  assert.deepEqual(f.sockets[0].init.protocols, ['codex-app-server', 'codex-client.desktop', 'openai-bearer.test-access-token']);
  assert.equal(f.sockets[0].init.headers['X-OpenAI-Product-Sku'], 'codex');
  assert.deepEqual(f.requests.map((r) => r.method), ['initialize', 'initialized', 'thread/list', 'thread/list', 'thread/resume']);
  assert.deepEqual(f.requests.at(-1).params, { threadId: 'thread-1', excludeTurns: true });
  assert.equal(f.observer.snapshot().discoveryComplete, true);
  const p1 = f.observer.refresh();
  assert.equal(p1, f.observer.refresh());
  await p1;
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.filter((r) => r.method === 'thread/resume').length, 1);
});

test('events persist before publication and only expose per-thread numeric metadata', async (t) => {
  const f = fixture(t);
  await f.start();
  assert.equal(f.observer.snapshot().threads[0].reportedTotalTokens, null);
  f.sockets[0].usage(100);
  f.advance(1000);
  f.sockets[0].usage(160);
  f.sockets[0].usage(160);
  f.sockets[0].usage(180);
  f.sockets[0].usage(500, 'unsubscribed-thread');
  f.sockets[0].message({ id: 999, method: 'item/tool/call', params: { body: 'private body' } });
  const snapshot = f.observer.snapshot();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].periods.today.tokens, 80);
  const saved = fs.readFileSync(f.filePath, 'utf8');
  for (const secret of ['private body', 'test-access-token', 'test@example.invalid', 'workspace-1']) assert.equal(saved.includes(secret), false);
  assert.equal(JSON.parse(saved).accounts[codexAuthIdentity(auth()).accountKey].threads['thread-1'].observedTokens, 80);
  assert.ok(f.notices.every((notice) => Object.keys(notice).sort().join() === 'revision,status'));
  assert.equal(f.requests.some((r) => r.id === 999), false);
});

test('account change hides old values and rejects old socket callbacks with increasing revisions', async (t) => {
  const f = fixture(t);
  await f.start();
  const old = f.sockets[0];
  old.usage(100);
  const previousRevision = f.observer.snapshot().revision;
  f.changeAuth(auth('workspace-2'));
  const snapshot = f.observer.snapshot();
  assert.equal(snapshot.threads.length, 0);
  assert.ok(snapshot.revision > previousRevision);
  assert.equal(old.closed, true);
  old.usage(200);
  await f.observer.refresh();
  f.sockets[1].usage(200);
  assert.equal(f.observer.snapshot().threads[0].periods.allTime.tokens, null);
  assert.equal(f.sockets.length, 2);
  assert.ok(f.notices.every((notice, index) => !index || notice.revision > f.notices[index - 1].revision));
});

test('disconnect recovery keeps high water and leaves the missed same-day delta undated', async (t) => {
  const f = fixture(t);
  await f.start();
  f.sockets[0].usage(100);
  f.sockets[0].usage(120);
  f.sockets[0].emit('close');
  assert.equal(f.observer.snapshot().status, 'reconnecting');
  f.fire(2000);
  await f.observer.refresh();
  f.sockets[1].usage(170);
  const thread = f.observer.snapshot().threads[0];
  assert.equal(thread.periods.today.tokens, 20);
  assert.equal(thread.periods.allTime.tokens, 70);
  assert.equal(thread.undatedTokens, 50);
});

test('disable and dispose cancel all timers and ignore late events', async (t) => {
  const f = fixture(t);
  await f.start();
  const socket = f.sockets[0];
  f.observer.configure({ enabled: false, selected: true });
  assert.equal(f.timers.size, 0);
  assert.equal(socket.closed, true);
  socket.usage(100);
  assert.equal(f.observer.snapshot(), null);
  await f.observer.refresh();
  f.observer.dispose();
  f.observer.configure({ enabled: true, selected: true });
  assert.equal(f.sockets.length, 1);
});

test('disabled pending auth cannot create a late socket or leak the old account', async (t) => {
  let resolveAuth;
  const f = fixture(t, { observer: { readAuth: () => new Promise((resolve) => { resolveAuth = resolve; }) } });
  f.observer.configure({ enabled: true, selected: true });
  const pending = f.observer.refresh();
  await Promise.resolve();
  f.observer.configure({ enabled: false, selected: true });
  resolveAuth(auth());
  await pending;
  assert.equal(f.sockets.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.observer.snapshot(), null);
});

test('a fresh observer reloads committed high-water without charging the historical prefix again', async (t) => {
  const first = fixture(t);
  await first.start();
  first.sockets[0].usage(100);
  first.sockets[0].usage(150);
  first.observer.dispose();
  const next = fixture(t, { observer: { filePath: first.filePath } });
  await next.start();
  next.sockets[0].usage(150);
  next.sockets[0].usage(180);
  const thread = next.observer.snapshot().threads[0];
  assert.equal(thread.periods.allTime.tokens, 80);
  assert.equal(thread.periods.today.tokens, 80);
  assert.equal(thread.undatedTokens, 0);
});

test('mismatched auth and identity never send one login under another account key', async (t) => {
  const f = fixture(t, { observer: { readAuth: () => auth('workspace-other') } });
  await f.start();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.observer.snapshot().status, 'unavailable');
});

test('API-key authentication never opens the official cloud connection', async (t) => {
  const f = fixture(t);
  f.changeAuth({ ...auth(), auth_mode: 'apikey', OPENAI_API_KEY: 'third-party-secret' });
  await f.start();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.observer.snapshot().status, 'unavailable');
});

test('persistence failure retains the committed baseline and breaks continuity', async (t) => {
  let fail = false;
  const f = fixture(t, { observer: { writeState: (filePath, value) => {
    if (fail) throw new Error('secret-bearing error must not escape');
    fs.writeFileSync(filePath, JSON.stringify(value));
  } } });
  await f.start();
  f.sockets[0].usage(100);
  fail = true;
  f.sockets[0].usage(150);
  assert.equal(f.observer.snapshot().threads[0].reportedTotalTokens, 100);
  assert.equal(f.observer.snapshot().status, 'reconnecting');
  fail = false;
  await f.observer.refresh();
  f.sockets[1].usage(170);
  assert.equal(f.observer.snapshot().threads[0].periods.allTime.tokens, 70);
  assert.equal(f.observer.snapshot().threads[0].undatedTokens, 70);
});

test('cursor cycles and request deadlines close the socket instead of overlapping retries', async (t) => {
  const f = fixture(t, { reply: (request) => request.method === 'thread/list' ? { data: [], nextCursor: 'same' } : {} });
  await f.start();
  assert.equal(f.observer.snapshot().status, 'reconnecting');
  assert.equal(f.requests.filter((r) => r.method === 'thread/list').length, 2);
  assert.equal(f.sockets[0].closed, true);
  const hanging = fixture(t, { reply: () => undefined });
  hanging.observer.configure({ enabled: true, selected: true });
  const pending = hanging.observer.refresh();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  hanging.fire(15_000);
  await pending;
  assert.equal(hanging.observer.snapshot().status, 'reconnecting');
  assert.equal(hanging.sockets.length, 1);
});
