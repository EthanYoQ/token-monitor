'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function fixture() {
  const reports = [];
  const timers = new Map();
  const frames = [];
  let nextTimer = 0;
  const document = { activeElement: null, listeners: {} };
  document.addEventListener = (name, callback) => { document.listeners[name] = callback; };
  function element() {
    const node = { className: '', dataset: {}, children: [], listeners: {} };
    node.classList = {
      contains: (name) => node.className.split(' ').includes(name),
      toggle(name, enabled) {
        const classes = new Set(node.className.split(' ').filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        node.className = [...classes].join(' ');
      }
    };
    node.append = (...children) => node.children.push(...children);
    node.replaceChildren = (...children) => { node.children = children; };
    node.setAttribute = () => {};
    node.addEventListener = (name, callback) => { node.listeners[name] = callback; };
    node.focus = () => {
      if (document.activeElement === node) return;
      document.activeElement = node;
      document.listeners.focusout();
      document.listeners.focusin();
    };
    node.matches = () => false;
    node.querySelectorAll = (selector) => node.children.flatMap((child) => {
      const matches = selector.startsWith('#') ? child.id === selector.slice(1) : child.classList.contains(selector.slice(1));
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
    return node;
  }
  const root = element();
  document.createElement = element;
  document.querySelector = () => {
    const menu = root.querySelector('#viewSwitcherMenu');
    return menu && !menu.classList.contains('hidden') ? menu : null;
  };
  const state = { breakdown: 'home', viewSwitcherOpen: false, viewSwitcherHasOpened: false };
  const names = ['syncAutoHideInteraction', 'viewSwitcherIcon', 'clearViewSwitcherLongPress', 'clearViewSwitcherHoverClose', 'scheduleViewSwitcherHoverClose', 'updateViewSwitcherOpenState', 'setViewSwitcherOpen', 'renderViewSwitcher'];
  const functions = names.map((name) => source.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0]);
  const focusListeners = source.slice(source.indexOf("document.addEventListener('focusin'"), source.indexOf('if (els.settingsPanel)'));
  const api = vm.runInNewContext(`${functions.join('\n')}\n${focusListeners}\n({ renderViewSwitcher, scheduleViewSwitcherHoverClose, syncAutoHideInteraction });`, {
    document, state,
    els: { viewSwitcher: root },
    window: { tokenMonitor: { setAutoHideInteraction: (value) => reports.push(value) } },
    autoHidePointerDown: false,
    viewSwitcherLongPressTimer: null,
    viewSwitcherLongPressTriggered: false,
    viewSwitcherHoverCloseTimer: null,
    VIEW_SWITCHER_HOVER_CLOSE_MS: 160,
    VIEW_SWITCHER_LONG_PRESS_MS: 420,
    VIEW_ICON_CLASSES: {},
    visibleBreakdownOrder: () => ['home', 'tool'],
    viewLabelById: (id) => id,
    nextBreakdown: (id) => id === 'home' ? 'tool' : 'home',
    renderBreakdownChange: (id) => { state.breakdown = id; },
    t: (key) => key,
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id)
  });
  api.renderViewSwitcher();
  return { ...api, root, reports, document, flushFrames: () => { for (const callback of frames.splice(0)) callback(); }, flushTimers: () => { for (const callback of timers.values()) callback(); timers.clear(); } };
}

test('view menu hover reports interaction without replacing the menu', () => {
  const f = fixture();
  const menu = f.root.querySelector('#viewSwitcherMenu');
  f.root.querySelector('.view-switcher-disclosure').listeners.pointerenter({ pointerType: 'mouse' });
  assert.equal(f.root.querySelector('#viewSwitcherMenu'), menu);
  assert.deepEqual(f.reports, [true]);
});

test('delayed menu close clears the interaction reported before leaving the window', () => {
  const f = fixture();
  f.root.querySelector('.view-switcher-disclosure').listeners.pointerenter({ pointerType: 'mouse' });
  f.syncAutoHideInteraction();
  assert.equal(f.reports.at(-1), true);
  f.reports.length = 0;
  f.scheduleViewSwitcherHoverClose();
  f.flushTimers();
  assert.deepEqual(f.reports, [false]);
});

test('keyboard view menu open and Escape report both interaction transitions', () => {
  const f = fixture();
  const disclosure = f.root.querySelector('.view-switcher-disclosure');
  disclosure.listeners.click({ detail: 0 });
  assert.deepEqual(f.reports, [true]);
  f.flushFrames();
  assert.equal(f.reports.at(-1), true);
  f.reports.length = 0;
  f.root.querySelector('#viewSwitcherMenu').listeners.keydown({ key: 'Escape', preventDefault: () => {} });
  assert.deepEqual(f.reports, [false]);
  f.flushFrames();
  f.flushTimers();
  assert.equal(f.document.activeElement, disclosure);
  assert.equal(f.reports.at(-1), false);
});

test('cycling and selecting a view release the menu interaction', () => {
  for (const selector of ['.view-switcher-current', '.view-switcher-menu-item']) {
    const f = fixture();
    f.root.querySelector('.view-switcher-disclosure').listeners.click({ detail: 0 });
    f.syncAutoHideInteraction();
    f.reports.length = 0;
    f.root.querySelector(selector).listeners.click();
    assert.deepEqual(f.reports, [false], selector);
  }
});

test('closing the menu preserves an active editable input interaction', () => {
  const f = fixture();
  f.root.querySelector('.view-switcher-disclosure').listeners.pointerenter({ pointerType: 'mouse' });
  f.document.activeElement = { matches: () => true };
  f.scheduleViewSwitcherHoverClose();
  f.flushTimers();
  assert.deepEqual(f.reports, [true, true]);
});
