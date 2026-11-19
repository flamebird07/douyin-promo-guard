'use strict';

/**
 * MAC-1/MAC-2 2026-11-16：浏览器可执行路径可选解析回归（macOS 兼容）。
 * 只测 src/login/browser-launch.js 的纯字符串逻辑，不启动浏览器。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { resolveExecutablePath, launchExecutableOption } = require('../src/login/browser-launch');

const LEGACY_WIN_EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

test('playwright/空串/缺省 → 省略 executablePath（用 Playwright 自带浏览器）', () => {
  for (const v of ['playwright', 'Playwright', '']) {
    assert.strictEqual(resolveExecutablePath({ edgePath: v }), null, `edgePath=${v}`);
    assert.deepStrictEqual(launchExecutableOption({ edgePath: v }), {}, `edgePath=${v}`);
  }
  assert.strictEqual(resolveExecutablePath({}), null);
  assert.strictEqual(resolveExecutablePath({ edgePath: null }), null);
});

test('显式路径原样透传（无论存在与否，由 Playwright 报错）', () => {
  const p = '/Applications/Some Browser.app/Contents/MacOS/typo';
  assert.strictEqual(resolveExecutablePath({ edgePath: p }), p);
  assert.deepStrictEqual(launchExecutableOption({ edgePath: p }), { executablePath: p });
});

test('~/ 前缀按 os.homedir() 展开；仅识别 ~/，不把 ~other 当当前用户', () => {
  const expected = path.join(os.homedir(), 'Applications/Edge');
  assert.strictEqual(resolveExecutablePath({ edgePath: '~/Applications/Edge' }), expected);
  assert.strictEqual(resolveExecutablePath({ edgePath: '~other/Applications/Edge' }), '~other/Applications/Edge');
});

test('仅旧默认 Windows Edge 路径在 darwin 回退 Playwright 自带；其他平台原样透传', () => {
  if (process.platform === 'darwin') {
    assert.strictEqual(resolveExecutablePath({ edgePath: LEGACY_WIN_EDGE }), null);
  } else {
    assert.strictEqual(resolveExecutablePath({ edgePath: LEGACY_WIN_EDGE }), LEGACY_WIN_EDGE);
  }
});

test('输错的 Mac 显式路径不回退：darwin 也原样透传给 Playwright 报错', () => {
  const typo = '/Applications/Microsoft Edge.app/Contents/MacOS/typo';
  assert.strictEqual(resolveExecutablePath({ edgePath: typo }), typo);
});
