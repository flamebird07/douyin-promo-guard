'use strict';

/**
 * AD-WATCHDOG-TEST-ISOLATION-20261020：测试隔离边界回归测试。
 *
 * 目标（全部离线：临时目录 + 假 Cookie，无网络/浏览器/服务/真实配置）：
 *  1. temp cookieSourceDir + temp cookieWorkDir：Cookie 导入/发现只落临时目录，
 *     生产项目 cookies/ 不新增、不修改任何文件；
 *  2. 店铺发现只扫描注入的临时工作根与临时来源目录；
 *  3. 测试上下文缺少隔离工作根 → fail-closed 抛错，绝不静默写/扫生产 cookies/；
 *  4. 非测试上下文（生产入口语义）保持原默认 PROJECT_COOKIES_DIR 行为；
 *  5. 显式配置 login.cookieWorkDir 时生产/测试都优先使用隔离根。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const log = require('../src/lib/log');
// 测试专用：抑制日志落盘（log 模块固定写项目 logs/），避免离线测试产生生产侧日志副作用。
log.info = () => {};
log.warn = () => {};
log.error = () => {};

const session = require('../src/login/session');
const { discoverShopsFromCookies } = require('../src/engine/shop-discovery');
const { Monitor } = require('../src/engine/monitor');
const { makeCfgResult, makeTempDir, writeTempCookie } = require('./helpers');

const PROJECT_COOKIES_DIR = session.PROJECT_COOKIES_DIR;
const SESSION_MODULE_PATH = require.resolve('../src/login/session');

const tempDirs = [];
function tmp(prefix) {
  const d = makeTempDir(prefix);
  tempDirs.push(d);
  return d;
}

after(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});

/** 生产 cookies/ 目录条目名快照（只读文件名，不读取任何 Cookie 内容）。 */
function productionEntries() {
  try {
    return fs.readdirSync(PROJECT_COOKIES_DIR).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function uniqueName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

test('R1 临时来源 + 临时工作根：导入与自动发现都不在生产 cookies/ 创建或修改文件', () => {
  const srcDir = tmp('iso-src-');
  const workDir = tmp('iso-work-');
  const name = uniqueName('隔离写入店');
  writeTempCookie(srcDir, name);
  const prodBefore = productionEntries();

  // 1) 真实 resolveCookieFile：来源被复制到注入的临时工作根，不返回/不写生产路径。
  const resolved = session.resolveCookieFile({ cookieSourceDir: srcDir, cookieWorkDir: workDir }, name);
  assert.strictEqual(resolved.path, path.join(workDir, `${name}.json`), '工作副本必须落在注入的临时工作根');
  assert.deepStrictEqual(
    fs.readFileSync(resolved.path),
    fs.readFileSync(path.join(srcDir, `${name}.json`)),
    '临时副本字节与来源一致（证明确实发生了复制写入）'
  );
  assert.strictEqual(fs.existsSync(path.join(PROJECT_COOKIES_DIR, `${name}.json`)), false,
    '生产 cookies/ 不得出现测试 Cookie 文件');

  // 2) 真实 Monitor 自动发现：扫描临时工作根 + 临时来源，只持久化到临时 config.json。
  const cfgFile = path.join(tmp('iso-cfg-'), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [] }, null, 2), 'utf8');
  const cfgResult = makeCfgResult({ cookieDir: srcDir, cookieWorkDir: workDir, shops: [] });
  cfgResult.sourcePath = cfgFile;
  const monitor = new Monitor(cfgResult, null, {
    dataDir: tmp('iso-data-'),
    chengfangOpener: async () => { throw new Error('隔离测试不得打开页面'); },
    readAdState: async () => { throw new Error('隔离测试不得回读'); },
  });
  try {
    assert.ok(monitor.config.shops.some((s) => s.id === name), '自动发现应只基于临时目录发现该店');
    const persisted = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.ok(persisted.shops.some((s) => s.id === name), '发现结果只落临时 config.json');
    assert.strictEqual(fs.existsSync(path.join(PROJECT_COOKIES_DIR, `${name}.json`)), false,
      '自动发现/持久化后生产 cookies/ 仍不得出现测试文件');
    assert.deepStrictEqual(productionEntries(), prodBefore, '生产 cookies/ 条目名全程不变');
  } finally {
    monitor.stop();
  }
});

test('R2 店铺发现只扫描注入的临时工作根与来源目录，不扫描生产目录', () => {
  const srcDir = tmp('iso-disc-src-');
  const workDir = tmp('iso-disc-work-');
  const fromSource = uniqueName('来源目录店');
  const fromWork = uniqueName('工作目录店');
  writeTempCookie(srcDir, fromSource);
  writeTempCookie(workDir, fromWork);

  const r = discoverShopsFromCookies({
    loginCfg: { cookieSourceDir: srcDir, cookieWorkDir: workDir },
    shops: [],
    projectCookiesDir: workDir,
  });

  assert.deepStrictEqual(r.scannedDirs, [workDir, srcDir], '只扫描注入的工作根与来源目录（顺序同解析优先级）');
  assert.strictEqual(r.scannedDirs.includes(PROJECT_COOKIES_DIR), false, '绝不扫描生产 cookies/');
  assert.deepStrictEqual(r.added.slice().sort(), [fromSource, fromWork].sort(), '两家临时店均被发现');
  assert.deepStrictEqual(r.skipped, [], '无跳过项');
});

test('R3 测试上下文缺少隔离工作根：Cookie 解析与店铺发现均 fail-closed，不写/不扫生产', () => {
  const srcDir = tmp('iso-fail-src-');
  const name = uniqueName('缺工作根店');
  writeTempCookie(srcDir, name);
  const prodBefore = productionEntries();

  assert.throws(
    () => session.resolveCookieFile({ cookieSourceDir: srcDir }, name),
    (e) => e instanceof Error && /测试上下文|fail-closed|隔离/.test(e.message),
    '缺少隔离工作根必须抛错，不得默认写生产 cookies/'
  );
  assert.throws(
    () => discoverShopsFromCookies({ loginCfg: { cookieSourceDir: srcDir }, shops: [] }),
    (e) => e instanceof Error && /测试上下文|fail-closed|隔离/.test(e.message),
    '缺少隔离项目目录必须抛错，不得默认扫描生产 cookies/'
  );

  // Monitor 装配路径同样必须失败关闭：不把来源店写进内存/临时配置，更不写生产。
  const cfgFile = path.join(tmp('iso-fail-cfg-'), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [] }, null, 2), 'utf8');
  const cfgResult = makeCfgResult({ cookieDir: srcDir, shops: [] });
  delete cfgResult.config.login.cookieWorkDir;
  cfgResult.sourcePath = cfgFile;
  const monitor = new Monitor(cfgResult, null, {
    dataDir: tmp('iso-fail-data-'),
    chengfangOpener: async () => { throw new Error('隔离测试不得打开页面'); },
    readAdState: async () => { throw new Error('隔离测试不得回读'); },
  });
  try {
    assert.deepStrictEqual(monitor.config.shops, [], '发现失败关闭：不得把来源店加入内存配置');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).shops, [], '临时配置保持为空');
  } finally {
    monitor.stop();
  }

  assert.strictEqual(fs.existsSync(path.join(PROJECT_COOKIES_DIR, `${name}.json`)), false,
    '生产 cookies/ 不得出现测试文件');
  assert.deepStrictEqual(productionEntries(), prodBefore, '生产 cookies/ 条目名全程不变');
});

test('R4 非测试上下文保持生产兼容：默认工作根仍为项目 cookies/；显式工作根优先', () => {
  const workDir = tmp('iso-explicit-work-');
  assert.strictEqual(
    session.resolveWorkDir({ cookieWorkDir: workDir }),
    workDir,
    '显式配置的隔离工作根在测试上下文同样生效'
  );

  const script = `
'use strict';
const s = require(${JSON.stringify(SESSION_MODULE_PATH)});
if (s.isTestContext()) { process.stderr.write('unexpected-test-context'); process.exit(2); }
const def = s.resolveWorkDir({});
if (def !== s.PROJECT_COOKIES_DIR) { process.stderr.write('unexpected-default:' + def); process.exit(3); }
const explicit = s.resolveWorkDir({ cookieWorkDir: process.env.ISO_EXPLICIT_WORK_DIR });
if (explicit !== process.env.ISO_EXPLICIT_WORK_DIR) { process.stderr.write('explicit-not-honored'); process.exit(4); }
process.stdout.write('OK');
`;
  const env = { ...process.env, ISO_EXPLICIT_WORK_DIR: workDir };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST;
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
  assert.strictEqual(child.status, 0, `子进程应正常退出：${child.stderr || ''}`);
  assert.strictEqual(child.stdout.trim(), 'OK', '生产上下文默认工作根与显式工作根语义必须保持兼容');
});
