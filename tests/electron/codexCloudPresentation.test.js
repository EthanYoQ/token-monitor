'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { MESSAGES, translate } = require('../../src/electron/renderer/i18n');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');

function definition(file, name) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron', file), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function element() {
  return {
    textContent: '', title: '', children: [], hidden: false,
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }
  };
}

test('cloud presentation keeps thread counters separate and preserves unknown versus zero', () => {
  const host = element();
  const thread = (id, today, month) => ({
    threadId: id, reportedTotalTokens: 1000,
    periods: { today: { tokens: today }, month: { tokens: month }, allTime: { tokens: 90 } },
    observedSince: '2026-10-31T00:00:00Z', undatedTokens: 30
  });
  const state = { period: 'today', stats: { codexCloudUsage: {
    connected: true, threads: [thread('thread-11111111', null, 20), thread('thread-22222222', 0, 40)]
  } } };
  const render = vm.runInNewContext(`(${definition('renderer/app.js', 'renderCodexCloudUsage')})`, {
    state, els: { codexCloudUsageNote: host }, document: { createElement: element },
    t: (key, params) => translate('en', key, params), formatNumber: String, currentLocale: () => 'en'
  });
  render();
  assert.match(host.children[2].textContent, /11111111.*Observed today —/);
  assert.match(host.children[3].textContent, /22222222.*Observed today 0/);
  assert.match(host.children[2].title, /Date unknown 30 tokens/);
  state.period = 'month';
  render();
  assert.match(host.children[2].textContent, /Observed this month 20/);
  assert.match(host.children[3].textContent, /Observed this month 40/);
  assert.doesNotMatch(host.children.map(row => row.textContent).join(' '), /\b60\b/);
  state.stats.codexCloudUsage = null;
  render();
  assert.equal(host.children.length, 0);
});

test('cloud presentation revisions update without adding cloud counters to account headlines', () => {
  const stats = { periods: { today: { totalTokens: 10 } } };
  let cloud = { revision: 1, threads: [{ reportedTotalTokens: 500 }] };
  const accountStats = { periods: { today: { totalTokens: 200 } } };
  const present = vm.runInNewContext(`(${definition('main.js', 'electronPresentationStats')})`, {
    settings: { clients: 'codex', codexAccountActivityEnabled: true },
    syncProvenanceActive: () => false,
    codexAccountActivity: { snapshot: () => ({}), multipleAccounts: () => false },
    codexCloudUsage: { snapshot: () => cloud },
    localDayKey: () => '2026-10-31', isAccountActivityStale: () => false,
    presentationCache: createStatsPresentationCache(),
    applyAccountActivityToStats: () => accountStats,
    projectModelAliasStats: value => value, projectLimitStatsForDisplay: value => value
  });
  const first = present(stats);
  assert.equal(first.periods.today.totalTokens, 200);
  assert.equal(first.codexCloudUsage.threads[0].reportedTotalTokens, 500);
  cloud = { revision: 2, threads: [{ reportedTotalTokens: 700 }] };
  const second = present(stats);
  assert.equal(second.periods.today.totalTokens, 200);
  assert.equal(second.codexCloudUsage.threads[0].reportedTotalTokens, 700);
  assert.notEqual(first, second);
});

test('cloud coverage and period wording exists in every supported locale', () => {
  const keys = Object.keys(MESSAGES.en).filter(key => key.startsWith('usage.codexCloud.'));
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    for (const key of keys) assert.equal(typeof messages[key], 'string', `${locale}: ${key}`);
  }
});
