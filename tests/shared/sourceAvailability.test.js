'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  clientSourceChecks, clientDiagnosticRoots, deriveClientHealth,
  watchPathsForClients, watchIgnoreMatcher, watchAttributionRootsForClients, clientsForWatchPath
} = require('../../src/shared/collector');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-availability-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, env: {}, platform: 'linux' };
}

for (const home of ['.workbuddy', '.workbuddy-ai']) {
  test(`WorkBuddy detects and watches the database-only ${home} source`, (t) => {
    const options = fixture(t);
    const appHome = path.join(options.homeDir, home);
    const dbPath = path.join(appHome, 'workbuddy.db');
    fs.mkdirSync(appHome);
    assert.equal(clientSourceChecks('workbuddy', options).workbuddy.some((check) => check.exists), false);
    fs.writeFileSync(dbPath, 'fixture');
    const sourceChecks = clientSourceChecks('workbuddy', options);
    assert.deepEqual(sourceChecks.workbuddy.find((check) => check.id === 'workbuddy-db'), { id: 'workbuddy-db', exists: true });
    assert.equal(deriveClientHealth('workbuddy', { clients: { workbuddy: 123 } }, { sourceChecks }).clients.workbuddy.overall, 'healthy');
    assert.ok(watchPathsForClients('workbuddy', options).includes(appHome));
    const ignored = watchIgnoreMatcher('workbuddy', options);
    const attribution = watchAttributionRootsForClients('workbuddy', null, options);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(ignored(`${dbPath}${suffix}`), false);
      assert.deepEqual(clientsForWatchPath(`${dbPath}${suffix}`, attribution), ['workbuddy']);
    }
    for (const relative of ['config.json', 'auth', 'node_modules', 'nested/workbuddy.db']) {
      const candidate = path.join(appHome, relative);
      assert.equal(ignored(candidate), true, relative);
      assert.deepEqual(clientsForWatchPath(candidate, attribution), []);
    }
    const projects = path.join(appHome, 'projects');
    fs.mkdirSync(projects);
    assert.equal(watchIgnoreMatcher('workbuddy', options)(path.join(projects, 'workspace', 'session.jsonl')), false);
    assert.deepEqual(clientsForWatchPath(path.join(projects, 'workspace', 'session.jsonl'), watchAttributionRootsForClients('workbuddy', null, options)), ['workbuddy']);
    fs.unlinkSync(dbPath);
    fs.mkdirSync(dbPath);
    assert.equal(clientSourceChecks('workbuddy', options).workbuddy.find((check) => check.id === 'workbuddy-db').exists, false);
  });
}

for (const home of ['.clawdbot', '.moltbot', '.moldbot']) {
  test(`OpenClaw detects and watches a legacy-only ${home} source`, (t) => {
    const options = fixture(t);
    const agents = path.join(options.homeDir, home, 'agents');
    fs.mkdirSync(agents, { recursive: true });
    const sourceChecks = clientSourceChecks('openclaw', options);
    assert.deepEqual(sourceChecks.openclaw, [{ id: 'openclaw-agents', exists: true }]);
    assert.equal(deriveClientHealth('openclaw', { clients: { openclaw: 123 } }, { sourceChecks }).clients.openclaw.overall, 'healthy');
    assert.deepEqual(watchPathsForClients('openclaw', options), [agents]);
    const transcript = path.join(agents, 'main', 'sessions', 'fixture.jsonl');
    assert.equal(watchIgnoreMatcher('openclaw', options)(transcript), false);
    assert.deepEqual(clientsForWatchPath(transcript, watchAttributionRootsForClients('openclaw', null, options)), ['openclaw']);
    assert.equal(watchIgnoreMatcher('openclaw', options)(path.join(agents, 'main', 'node_modules')), true);
  });
}

test('CC-Switch only supplies a Claude source check when enabled on Windows with a real database', (t) => {
  const options = { ...fixture(t), platform: 'win32', ccSwitchClaudeEnabled: true };
  const dbPath = path.join(options.homeDir, '.cc-switch', 'cc-switch.db');
  fs.mkdirSync(path.dirname(dbPath));
  fs.writeFileSync(dbPath, 'fixture');
  const sourceChecks = clientSourceChecks('claude', options);
  assert.deepEqual(sourceChecks.claude.find((check) => check.id === 'claude-cc-switch-db'), { id: 'claude-cc-switch-db', exists: true });
  assert.equal(deriveClientHealth('claude', { clients: { claude: 123 } }, { sourceChecks }).clients.claude.overall, 'healthy');
  assert.ok(clientDiagnosticRoots('claude', options).claude.some((root) => root.sourcePath === dbPath && root.exists));
  for (const disabled of [{ ccSwitchClaudeEnabled: false }, { platform: 'linux' }]) {
    assert.equal(clientSourceChecks('claude', { ...options, ...disabled }).claude.some((check) => check.id === 'claude-cc-switch-db'), false);
  }
  fs.unlinkSync(dbPath);
  fs.mkdirSync(dbPath);
  assert.equal(clientSourceChecks('claude', options).claude.find((check) => check.id === 'claude-cc-switch-db').exists, false);
});
