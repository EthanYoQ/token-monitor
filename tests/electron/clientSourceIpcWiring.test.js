'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createClientSourceIpcHandlers } = require('../../src/electron/clientSourceIpc');
const { clientDiagnosticRoots, visibleDiagnosticRoots } = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

test('Electron source inspection and Reveal use the current effective usage configuration', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-source-ipc-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const dbPath = path.join(homeDir, '.cc-switch', 'cc-switch.db');
  fs.mkdirSync(path.dirname(dbPath));
  fs.writeFileSync(dbPath, 'fixture');
  const customDir = path.join(homeDir, 'custom-codex');
  fs.mkdirSync(customDir);
  const settings = { clients: 'claude,codex', customScanPaths: {} };
  let ccSwitchClaudeEnabled = true;
  const revealed = [];
  const sourceOptions = { homeDir, platform: 'win32', env: {} };
  const context = vm.createContext({
    createClientSourceIpcHandlers, KNOWN_CLIENTS: ['claude', 'codex'], settings,
    trackedClientSet: (clients) => new Set(clients.split(',')), clientsCsvForSetting: (clients) => clients,
    electronUsageConfig: () => ({ ccSwitchClaudeEnabled, customScanPaths: settings.customScanPaths }),
    visibleDiagnosticRoots: (clients, options) => visibleDiagnosticRoots(clients, { ...sourceOptions, ...options }),
    clientDiagnosticRoots: (clients, options) => clientDiagnosticRoots(clients, { ...sourceOptions, ...options }),
    shell: { showItemInFolder: (target) => revealed.push(target), openPath: () => { throw new Error('expected file reveal'); } }
  });
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const registration = main.match(/const clientSourceIpcHandlers = createClientSourceIpcHandlers\(\{[^]*?\n {2}\}\);/);
  assert.ok(registration, 'the Electron IPC caller is present');
  vm.runInContext(registration[0], context);
  const handlers = vm.runInContext('clientSourceIpcHandlers', context);

  assert.deepEqual(handlers.clientSources('claude').sources.find(({ id }) => id === 'claude-cc-switch-db'), {
    id: 'claude-cc-switch-db', dir: dbPath, exists: true
  });
  assert.equal(await handlers.revealClientSource('claude'), true);
  assert.deepEqual(revealed, [dbPath]);

  ccSwitchClaudeEnabled = false;
  assert.equal(handlers.clientSources('claude').sources.some(({ id }) => id === 'claude-cc-switch-db'), false);
  assert.equal(await handlers.revealClientSource('claude'), false);
  assert.deepEqual(revealed, [dbPath]);
  settings.customScanPaths = { codex: [customDir] };
  assert.ok(handlers.clientSources('codex').sources.some(({ dir, custom }) => dir === customDir && custom === true));
});
