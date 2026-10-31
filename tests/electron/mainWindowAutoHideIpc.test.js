'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainPath = path.join(__dirname, '../../src/electron/main.js');
const main = fs.readFileSync(mainPath, 'utf8');
const start = main.indexOf("  ipcMain.on('window:autoHideInteraction',");
assert.ok(start >= 0, 'main process registers auto-hide interaction');
const end = main.indexOf('\n  });', start);
assert.ok(end > start, 'auto-hide registration has an end');
const registration = main.slice(start, end + '\n  });'.length);

function loadHandler(mainWindow, mainWindowAutoHide) {
  let handler;
  vm.runInNewContext(registration, {
    mainWindow,
    mainWindowAutoHide,
    ipcMain: { on(channel, callback) {
      assert.equal(channel, 'window:autoHideInteraction');
      handler = callback;
    } }
  }, { filename: mainPath });
  return handler;
}

test('late interaction after destruction does not access the destroyed window', () => {
  const handler = loadHandler({
    isDestroyed: () => true,
    get webContents() { throw new TypeError('Object has been destroyed'); }
  }, { setInteracting() { assert.fail('destroyed window cannot interact'); } });
  assert.doesNotThrow(() => handler({ sender: {} }, false));
});

test('interaction before a main window exists is ignored', () => {
  const handler = loadHandler(null, { setInteracting() { assert.fail('missing window cannot interact'); } });
  assert.doesNotThrow(() => handler({ sender: {} }, true));
});

test('only the current main renderer can change auto-hide interaction', () => {
  const sender = {};
  const values = [];
  const handler = loadHandler({ isDestroyed: () => false, webContents: sender }, {
    setInteracting: value => values.push(value)
  });
  handler({ sender: {} }, true);
  assert.deepEqual(values, []);
  handler({ sender }, true);
  handler({ sender }, false);
  handler({ sender }, 'true');
  assert.deepEqual(values, [true, false, false]);
});

test('interaction after controller disposal is ignored', () => {
  const sender = {};
  const handler = loadHandler({ isDestroyed: () => false, webContents: sender }, null);
  assert.doesNotThrow(() => handler({ sender }, false));
});
