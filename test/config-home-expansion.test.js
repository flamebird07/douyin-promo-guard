'use strict';

/**
 * MAC-2 2026-11-16：loadConfigFrom 对 login.cookieSourceDir / cookieWorkDir 的 "~/" 展开回归。
 * README 与 macOS 样例声明支持 ~/，生产此前未展开——本测试锁定该行为。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfigFrom } = require('../src/config');

function loadWithLogin(loginPatch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-home-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ login: loginPatch }));
  try { return loadConfigFrom(cfgPath).config.login; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('~/ 前缀按 os.homedir() 展开（cookieSourceDir 与 cookieWorkDir）', () => {
  const login = loadWithLogin({
    cookieSourceDir: '~/Documents/douyin-promo-guard-cookies',
    cookieWorkDir: '~/Documents/guard-work',
  });
  assert.strictEqual(login.cookieSourceDir, path.join(os.homedir(), 'Documents/douyin-promo-guard-cookies'));
  assert.strictEqual(login.cookieWorkDir, path.join(os.homedir(), 'Documents/guard-work'));
});

test('空值与绝对路径原语义不变；~other 不展开', () => {
  const winPath = 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies';
  const login = loadWithLogin({
    cookieSourceDir: winPath,
    cookieWorkDir: '',
    edgePath: '~other/bin/browser',
  });
  assert.strictEqual(login.cookieSourceDir, winPath);
  assert.strictEqual(login.cookieWorkDir, '');
  assert.strictEqual(login.edgePath, '~other/bin/browser'); // 展开仅限 cookieSourceDir/cookieWorkDir
});

test('macOS 示例可以加载，且默认使用演练模式', () => {
  const { config } = loadConfigFrom(path.join(__dirname, '../config/config.example.macos.json'));
  assert.equal(config.login.edgePath, 'playwright');
  assert.equal(config.execution.realMode, false);
  assert.equal(config.execution.dryRun, true);
  assert.equal(config.monitor.chengfang.pauseEnabled, false);
  assert.equal(config.monitor.chengfang.enableEnabled, false);
});
