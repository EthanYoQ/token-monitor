'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  dockTarget,
  hiddenTarget,
  createMainWindowAutoHide
} = require('../../src/electron/mainWindowAutoHide');

const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const displayWithoutReservedArea = { ...display, bounds: display.workArea };

function mainFunctions(names, context) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const functions = names.map((name) => source.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0]);
  return vm.runInNewContext(`${functions.join('\n')}\n({ ${names.join(', ')} });`, context);
}

test('all four exposed work-area edges retain a reachable strip', () => {
  const cases = [
    [{ x: 3, y: 150, width: 360, height: 600 }, 'left', { x: -352, y: 150 }],
    [{ x: 1557, y: 150, width: 360, height: 600 }, 'right', { x: 1912, y: 150 }],
    [{ x: 400, y: 4, width: 360, height: 600 }, 'top', { x: 400, y: -592 }],
    [{ x: 400, y: 437, width: 360, height: 600 }, 'bottom', { x: 400, y: 1032 }]
  ];
  for (const [bounds, side, hidden] of cases) {
    const dock = dockTarget(bounds, [displayWithoutReservedArea]);
    assert.equal(dock.side, side);
    assert.deepEqual({ x: hiddenTarget(dock.bounds, display.workArea, side).x, y: hiddenTarget(dock.bounds, display.workArea, side).y }, hidden);
  }
});

test('reserved work-area edges cannot dock', () => {
  const cases = [
    ['left', { x: 40, y: 0, width: 1880, height: 1080 }, { x: 43, y: 150, width: 360, height: 600 }],
    ['right', { x: 0, y: 0, width: 1880, height: 1080 }, { x: 1517, y: 150, width: 360, height: 600 }],
    ['top', { x: 0, y: 40, width: 1920, height: 1040 }, { x: 400, y: 43, width: 360, height: 600 }],
    ['bottom', display.workArea, { x: 400, y: 437, width: 360, height: 600 }]
  ];
  for (const [side, workArea, bounds] of cases) {
    assert.equal(dockTarget(bounds, [{ ...display, workArea }]), null, side);
  }
});

test('shared monitor seams are not docking edges', () => {
  const second = { id: 2, bounds: { x: 1920, y: -100, width: 1600, height: 1000 }, workArea: { x: 1920, y: -100, width: 1600, height: 960 } };
  assert.equal(dockTarget({ x: 1559, y: 100, width: 360, height: 600 }, [display, second]), null);
  assert.equal(dockTarget({ x: 1922, y: 100, width: 360, height: 600 }, [display, second]), null);
  assert.equal(dockTarget({ x: 3, y: 100, width: 360, height: 600 }, [display, second]).side, 'left');
});

function fixture(initial = {}) {
  const win = new EventEmitter();
  let bounds = initial.bounds || { x: 500, y: 100, width: 360, height: 600 };
  let cursor = { x: 600, y: 400 };
  let fullScreen = false;
  let maximized = false;
  let minimized = false;
  const settings = { mainWindowAutoHideEnabled: true, windowBehavior: 'floating', ...initial.settings };
  const calls = [];
  const pendingMoves = [];
  let saves = 0;
  win.isDestroyed = () => false;
  win.isVisible = () => initial.visible !== false;
  win.isMinimized = () => minimized;
  win.restore = () => {
    minimized = false;
    if (initial.restoreBounds) { bounds = { ...initial.restoreBounds }; win.emit('moved'); }
    win.emit('restore');
  };
  win.isMaximized = () => maximized;
  win.isFullScreen = () => false;
  win.getBounds = () => ({ ...bounds });
  win.setBounds = (next) => {
    bounds = { ...next };
    calls.push(next);
    if (initial.deferredMoves) pendingMoves.push(() => win.emit('moved'));
    else win.emit('moved');
  };
  const screen = new EventEmitter();
  let displays = initial.displays || [display];
  screen.getAllDisplays = () => displays;
  screen.getCursorScreenPoint = () => cursor;
  const controller = createMainWindowAutoHide({ window: win, screen, getSettings: () => settings, save: () => { saves += 1; initial.onSave?.({ ...settings.windowBounds }); }, platform: 'win32', animationMs: initial.animationMs ?? 0, reducedMotion: () => initial.reducedMotion === true, setInterval: () => 1, clearInterval: () => {}, isForegroundFullscreen: () => fullScreen });
  win.on('moved', () => controller.onMoved());
  return { controller, settings, win, screen, calls, flushMoved: () => { while (pendingMoves.length) pendingMoves.shift()(); }, saves: () => saves, setCursor: (point) => { cursor = point; }, setFullscreen: (value) => { fullScreen = value; }, setMaximized: (value) => { maximized = value; }, setMinimized: (value) => { minimized = value; }, resize: (next) => { bounds = next; controller.onResized(); }, setDisplays: (next) => { displays = next; screen.emit('display-removed'); }, bounds: () => bounds };
}

test('enabling does not snap an ordinary window; dragging docks and disabling restores it', () => {
  const f = fixture();
  f.controller.sync();
  assert.equal(f.controller.isDocked(), false);
  assert.equal(f.calls.length, 0);
  f.win.setBounds({ x: 2, y: 100, width: 360, height: 600 });
  f.controller.onMoveFinished();
  assert.equal(f.controller.isDocked(), true);
  f.controller.hide();
  assert.equal(f.bounds().x, -352);
  assert.deepEqual(f.settings.windowBounds, { x: 0, y: 100, width: 360, height: 600 });
  f.settings.mainWindowAutoHideEnabled = false;
  f.controller.sync();
  assert.deepEqual(f.bounds(), f.settings.windowBounds);
  assert.equal(f.controller.isDocked(), false);
  assert.equal(f.settings.mainWindowAutoHideSide, null);
  f.controller.dispose();
});

test('active reveal defeats a queued hide and keeps the window reachable', () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.controller.reveal({ active: true });
  assert.equal(f.bounds().x, 0);
  f.controller.tick();
  assert.equal(f.bounds().x, 0);
  f.controller.dispose();
});

test('a saved reserved edge is released on restore', () => {
  const bounds = { x: 400, y: 440, width: 360, height: 600 };
  const f = fixture({ bounds, settings: { mainWindowAutoHideSide: 'bottom', windowBounds: bounds } });
  f.controller.sync();
  assert.deepEqual(f.controller.state(), { side: null, hidden: false });
  assert.equal(f.settings.mainWindowAutoHideSide, null);
  assert.deepEqual(f.bounds(), bounds);
  f.controller.dispose();
});

test('hidden hover only reveals inside the work-area intersection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bounds = { x: 0, y: 0, width: 360, height: 1080 };
  const f = fixture({ bounds, settings: { mainWindowAutoHideSide: 'left', windowBounds: bounds } });
  t.after(() => f.controller.dispose());
  f.controller.sync();
  f.controller.hide();
  for (const point of [{ x: 3, y: 1050 }, { x: -20, y: 150 }]) {
    f.setCursor(point);
    f.controller.tick();
    t.mock.timers.tick(150);
    assert.deepEqual(f.controller.state(), { side: 'left', hidden: true }, JSON.stringify(point));
  }
  f.setCursor({ x: 3, y: 150 });
  f.controller.tick();
  t.mock.timers.tick(150);
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: false });
});

test('hover delay rechecks the work-area intersection before revealing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bounds = { x: 0, y: 0, width: 360, height: 1080 };
  const f = fixture({ bounds, settings: { mainWindowAutoHideSide: 'left', windowBounds: bounds } });
  t.after(() => f.controller.dispose());
  f.controller.sync();
  f.controller.hide();
  f.setCursor({ x: 3, y: 150 });
  f.controller.tick();
  t.mock.timers.tick(149);
  f.setCursor({ x: 3, y: 1050 });
  t.mock.timers.tick(1);
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: true });
});

test('a late duplicate moved event cannot abandon a hidden edge before hover reveal', async () => {
  const f = fixture();
  f.win.setBounds({ x: 1558, y: 100, width: 360, height: 600 });
  f.controller.onMoveFinished();
  f.controller.hide();
  f.win.emit('moved');
  assert.deepEqual(f.controller.state(), { side: 'right', hidden: true });
  f.setCursor({ x: 1916, y: 150 });
  f.controller.tick();
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.deepEqual(f.controller.state(), { side: 'right', hidden: false });
  assert.equal(f.bounds().x, 1560);
  f.controller.dispose();
});

test('moving a hidden dock restores visible bounds before normal persistence', () => {
  const cases = [
    { side: 'left', bounds: { x: 0, y: 100, width: 360, height: 600 }, moved: { x: -352, y: 130, width: 360, height: 600 }, visible: { x: 0, y: 130, width: 360, height: 600 } },
    { side: 'right', bounds: { x: 1560, y: 100, width: 360, height: 600 }, moved: { x: 1912, y: 130, width: 360, height: 600 }, visible: { x: 1560, y: 130, width: 360, height: 600 } },
    { side: 'top', bounds: { x: 400, y: 0, width: 360, height: 600 }, moved: { x: 430, y: -592, width: 360, height: 600 }, visible: { x: 430, y: 0, width: 360, height: 600 } },
    { side: 'bottom', bounds: { x: 400, y: 440, width: 360, height: 600 }, moved: { x: 430, y: 1032, width: 360, height: 600 }, visible: { x: 430, y: 440, width: 360, height: 600 } }
  ];
  for (const { side, bounds, moved, visible, deferredMoves } of cases.flatMap((item) => [item, { ...item, deferredMoves: true }])) {
    let persist;
    const savedBounds = [];
    const f = fixture({ bounds, deferredMoves, displays: [displayWithoutReservedArea], onSave: (saved) => savedBounds.push(saved), settings: { mainWindowAutoHideSide: side, windowBounds: bounds } });
    const { persistBoundsSoon } = mainFunctions(['persistBoundsSoon'], {
      mainWindow: f.win,
      mainWindowAutoHide: f.controller,
      settings: f.settings,
      floatingBubbleState: {},
      shouldPersistWindowBounds: () => true,
      stopPersistBoundsTimer: () => { persist = null; },
      setTimeout: (callback) => { persist = callback; return 1; },
      saveSettings: () => savedBounds.push({ ...f.settings.windowBounds }),
      persistBoundsTimer: null
    });
    f.win.on('moved', persistBoundsSoon);
    f.controller.sync();
    f.controller.hide();
    f.flushMoved();
    assert.equal(persist, undefined);

    f.win.setBounds(moved);
    f.flushMoved();
    assert.deepEqual(f.bounds(), visible, side);
    assert.deepEqual(f.controller.state(), { side: null, hidden: false });
    persist();
    assert.deepEqual(f.settings.windowBounds, visible, side);
    assert.deepEqual(savedBounds, [visible]);
    f.win.emit('moved');
    f.controller.tick();
    assert.deepEqual(f.bounds(), visible);
    assert.equal(f.controller.isDocked(), false);
    f.controller.dispose();
  }
});

test('collapsing a previously docked maximized window preserves the bubble size', () => {
  const expandedBounds = { x: 0, y: 100, width: 360, height: 600 };
  const collapsedBounds = { x: 0, y: 100, width: 48, height: 48 };
  const f = fixture({ bounds: expandedBounds, settings: { mainWindowAutoHideSide: 'left', windowBounds: expandedBounds } });
  f.controller.sync();
  f.controller.hide();
  f.setMaximized(true);
  f.controller.sync();
  f.settings.floatingBubbleEnabled = true;
  f.controller.sync();
  assert.deepEqual(f.controller.safeBounds(), expandedBounds);
  let created;
  f.win.isFocused = () => false;
  const { collapseFloatingBubble, replaceMainWindow } = mainFunctions(['collapseFloatingBubble', 'replaceMainWindow'], {
    mainWindow: f.win,
    mainWindowAutoHide: f.controller,
    settings: f.settings,
    process: { platform: 'win32' },
    floatingBubbleState: {},
    stopFloatingBubbleAutoCollapseTimer: () => {},
    applyNativeMaterial: () => {},
    persistWindowBounds: (bounds) => { f.settings.windowBounds = bounds; },
    createWindow: (bounds, options) => { created = { bounds, options }; },
    sendFloatingBubbleState: () => {},
    handoffWindow: () => {}
  });

  assert.equal(collapseFloatingBubble({ side: 'left', expandedBounds, collapsedBounds }), true);
  assert.deepEqual(created.bounds, collapsedBounds);
  assert.equal(created.options.collapsedFloatingBubble, true);
  assert.deepEqual(f.settings.windowBounds, expandedBounds);

  replaceMainWindow({ x: -352, y: 100, width: 360, height: 600 });
  assert.deepEqual(created.bounds, expandedBounds);
  assert.equal(created.options.collapsedFloatingBubble, false);
  f.controller.dispose();
});

test('taskbar minimize preserves the hidden edge for hover after restore', async () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.setMinimized(true);
  f.win.emit('moved');
  f.controller.onResized();
  f.controller.tick();
  f.controller.sync();
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: true });
  assert.equal(f.settings.mainWindowAutoHideSide, 'left');
  f.setMinimized(false);
  f.setCursor({ x: 3, y: 150 });
  f.controller.tick();
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: false });
  assert.equal(f.bounds().x, 0);
  f.controller.dispose();
});

test('minimizing a hidden edge restores and reveals the window', async () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.setMinimized(true);
  f.controller.onMinimized();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.win.isMinimized(), false);
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: false });
  assert.equal(f.bounds().x, 0);
  f.controller.dispose();
});

test('restoration moving a hidden window to its dock does not forget the edge', async () => {
  const expanded = { x: 0, y: 100, width: 360, height: 600 };
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: expanded }, bounds: expanded, restoreBounds: expanded });
  f.controller.sync();
  f.controller.hide();
  f.setMinimized(true);
  f.controller.onMinimized();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: false });
  assert.equal(f.settings.mainWindowAutoHideSide, 'left');
  f.controller.dispose();
});

test('a startup moved notification before show does not clear its restored side', () => {
  const f = fixture({ visible: false, settings: { mainWindowAutoHideSide: 'right', windowBounds: { x: 1560, y: 100, width: 360, height: 600 } }, bounds: { x: 1560, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.win.emit('moved');
  f.win.setBounds({ x: 1560, y: 101, width: 360, height: 600 });
  assert.deepEqual(f.controller.state(), { side: 'right', hidden: false });
  assert.equal(f.settings.mainWindowAutoHideSide, 'right');
  f.controller.dispose();
});

test('a completed manual move snaps without an extra debounce', () => {
  const f = fixture();
  f.win.setBounds({ x: 2, y: 100, width: 360, height: 600 });
  assert.deepEqual(f.controller.state(), { side: 'left', hidden: false });
  f.controller.dispose();
});

test('reduced motion moves the whole window directly to its target', () => {
  const f = fixture({ animationMs: 170, reducedMotion: true });
  f.win.setBounds({ x: 2, y: 100, width: 360, height: 600 });
  assert.equal(f.bounds().x, 0);
  f.controller.hide();
  assert.equal(f.bounds().x, -352);
  f.controller.dispose();
});

test('removed display first restores a hidden window visibly on a surviving edge', () => {
  const right = { id: 2, bounds: { x: 1920, y: 0, width: 1600, height: 900 }, workArea: { x: 1920, y: 0, width: 1600, height: 860 } };
  const f = fixture({ settings: { mainWindowAutoHideSide: 'right', windowBounds: { x: 3160, y: 100, width: 360, height: 600 } }, bounds: { x: 3160, y: 100, width: 360, height: 600 } });
  f.setDisplays([display, right]);
  f.controller.sync();
  f.controller.hide();
  f.setDisplays([display]);
  assert.equal(f.controller.isDocked(), true);
  assert.deepEqual(f.bounds(), { x: 1560, y: 100, width: 360, height: 600 });
  assert.deepEqual(f.settings.windowBounds, f.bounds());
  assert.equal(f.controller.state().hidden, false);
  f.controller.dispose();
});

test('normal teardown preserves the saved edge and expanded bounds', () => {
  const f = fixture();
  f.win.setBounds({ x: 2, y: 100, width: 360, height: 600 });
  f.controller.onMoveFinished();
  f.controller.hide();
  f.controller.dispose();
  assert.equal(f.settings.mainWindowAutoHideSide, 'left');
  assert.deepEqual(f.settings.windowBounds, { x: 0, y: 100, width: 360, height: 600 });
});

test('resizing a docked window updates the safe expanded size with one settled save', async () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.resize({ x: 0, y: 100, width: 430, height: 650 });
  f.resize({ x: 0, y: 100, width: 440, height: 660 });
  f.resize({ x: 0, y: 100, width: 450, height: 670 });
  f.controller.hide();
  assert.equal(f.bounds().width, 450);
  assert.equal(f.bounds().x, -442);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(f.settings.windowBounds, { x: 0, y: 100, width: 450, height: 670 });
  assert.equal(f.saves(), 1);
  f.controller.dispose();
});

test('a fullscreen app appearing during hover delay prevents reveal', async () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.setCursor({ x: 3, y: 150 });
  f.controller.tick();
  f.setFullscreen(true);
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(f.bounds().x, -352);
  f.controller.dispose();
});

test('restart after resolution shrink restores the saved edge inside the new work area', () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'right', windowBounds: { x: 1560, y: 100, width: 360, height: 600 } }, bounds: { x: 1560, y: 100, width: 360, height: 600 } });
  f.setDisplays([{ id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 }, workArea: { x: 0, y: 0, width: 1600, height: 860 } }]);
  f.controller.sync();
  assert.equal(f.controller.isDocked(), true);
  assert.deepEqual(f.bounds(), { x: 1240, y: 100, width: 360, height: 600 });
  assert.deepEqual(f.settings.windowBounds, f.bounds());
  f.controller.dispose();
});

test('maximization releases docking and restores safe bounds on unmaximize', () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.setMaximized(true);
  f.controller.sync();
  assert.equal(f.controller.isDocked(), false);
  assert.deepEqual(f.controller.safeBounds(), { x: 0, y: 100, width: 360, height: 600 });
  f.setMaximized(false);
  f.controller.sync();
  assert.deepEqual(f.bounds(), { x: 0, y: 100, width: 360, height: 600 });
  f.controller.dispose();
});

test('disabling auto-hide while maximized still restores safe bounds on unmaximize', () => {
  const f = fixture({ settings: { mainWindowAutoHideSide: 'left', windowBounds: { x: 0, y: 100, width: 360, height: 600 } }, bounds: { x: 0, y: 100, width: 360, height: 600 } });
  f.controller.sync();
  f.controller.hide();
  f.setMaximized(true);
  f.controller.sync();
  f.settings.mainWindowAutoHideEnabled = false;
  f.controller.sync();
  f.setMaximized(false);
  f.controller.sync();
  assert.deepEqual(f.bounds(), { x: 0, y: 100, width: 360, height: 600 });
  assert.equal(f.settings.mainWindowAutoHideSide, null);
  f.controller.dispose();
});
