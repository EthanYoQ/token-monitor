'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.runtime/.cache/auto-hide-color'));

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, output], {
    env, windowsHide: true, stdio: 'inherit', timeout: 60000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const { THEME_PRESETS, themeCssVarEntries } = require('../src/electron/renderer/themePresets');
const width = 360;
const height = 600;
const edges = {
  left: { x: width - 8, y: 0, width: 8, height },
  right: { x: 0, y: 0, width: 8, height },
  top: { x: 0, y: height - 8, width, height: 8 },
  bottom: { x: 0, y: 0, width, height: 8 },
};
const themes = [
  { id: 'default', colors: {} },
  { id: 'custom', colors: { accent: '#e63fb6', bg: '#23344a', text: '#eef5fb', muted: '#a3adbb' } },
  { id: 'paper', colors: THEME_PRESETS.find((theme) => theme.id === 'porcelain').colors },
];
const materials = [
  { id: 'windows-glass', classes: 'is-windows' },
  { id: 'glass-disabled', classes: 'is-windows system-glass-disabled' },
  { id: 'opaque', classes: 'is-windows native-material-opaque' },
];

fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

function changedPixels(first, second) {
  const a = first.toBitmap();
  const b = second.toBitmap();
  assert.equal(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (!a.subarray(i, i + 4).equals(b.subarray(i, i + 4))) changed += 1;
  }
  return changed;
}

async function verify() {
  await app.whenReady();
  const renderer = path.join(root, 'src/electron/renderer');
  const source = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(`${renderer}${path.sep}`).href}">`);
  const fixturePath = path.join(output, 'fixture.html');
  fs.writeFileSync(fixturePath, fixture);
  const win = new BrowserWindow({
    width, height, show: false, frame: false, transparent: true,
    skipTaskbar: true, focusable: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await win.loadFile(fixturePath);
  const results = [];

  async function render(theme, material, side, colors = theme.colors) {
    const state = { entries: themeCssVarEntries(colors), classes: material.classes, side };
    const computed = await win.webContents.executeJavaScript(`(async () => {
      const state = ${JSON.stringify(state)};
      document.documentElement.className = state.classes;
      document.documentElement.removeAttribute('style');
      for (const entry of state.entries) {
        if (entry.value !== null) document.documentElement.style.setProperty(entry.name, entry.value);
      }
      document.body.className = state.side ? 'main-auto-hide-hidden auto-hide-' + state.side : '';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const grip = document.getElementById('mainWindowAutoHideGrip');
      const css = getComputedStyle(grip);
      const rect = grip.getBoundingClientRect();
      return {
        display: css.display, background: css.backgroundColor, shadow: css.boxShadow,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        shellBackground: getComputedStyle(document.querySelector('.shell')).background,
      };
    })()`);
    const image = await win.webContents.capturePage();
    assert.deepEqual(image.getSize(), { width, height });
    return { computed, image };
  }

  try {
    for (const theme of themes) {
      for (const material of materials) {
        const base = await render(theme, material, null);
        assert.equal(base.computed.display, 'none', 'revealed window hides the grip');
        for (const [side, rect] of Object.entries(edges)) {
          const name = `${theme.id}-${material.id}-${side}`;
          const hidden = await render(theme, material, side);
          const alternateAccent = await render(theme, material, side, { ...theme.colors, accent: '#ff6200' });
          const alternateBg = await render(theme, material, side, { ...theme.colors, bg: '#8d294c' });
          const strip = hidden.image.crop(rect);
          const panelDiff = changedPixels(strip, base.image.crop(rect));
          const accentDiff = changedPixels(strip, alternateAccent.image.crop(rect));
          const backgroundDiff = changedPixels(strip, alternateBg.image.crop(rect));
          const geometryMatches = JSON.stringify(hidden.computed.rect) === JSON.stringify(rect);
          const passed = panelDiff === 0 && accentDiff === 0 && backgroundDiff > 0 && geometryMatches;
          results.push({ name, passed, panelDiff, accentDiff, backgroundDiff, geometryMatches, computed: hidden.computed });
          fs.writeFileSync(path.join(output, `${name}-hidden.png`), hidden.image.toPNG());
          if (side === 'right') fs.writeFileSync(path.join(output, `${theme.id}-${material.id}-panel.png`), base.image.toPNG());
        }
      }
    }
    const failures = results.filter((result) => !result.passed);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({
      electron: process.versions.electron, chrome: process.versions.chrome,
      platform: process.platform, visible: win.isVisible(), dimensions: { width, height },
      scope: 'Actual index.html markup and CSS with application scripts disabled. Offscreen Chromium rendering does not verify native Acrylic compositing.',
      passed: results.length - failures.length, failed: failures.length, results,
    }, null, 2));
    console.log(JSON.stringify({ output, cases: results.length, passed: results.length - failures.length, failed: failures.length }));
    assert.equal(failures.length, 0, failures.map(({ name, panelDiff, accentDiff, backgroundDiff }) =>
      `${name}: ${panelDiff} panel mismatches, ${accentDiff} accent-dependent pixels, ${backgroundDiff} background-dependent pixels`).join('\n'));
  } finally {
    win.destroy();
  }
}

verify().then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
