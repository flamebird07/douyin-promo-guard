'use strict';

/**
 * MULTISHOP-ISOLATION-20261027 D16 合成功能回归：每次分析的店铺目标必须由
 * 本次 spawn 的 env 冻结，而不是在子进程启动时读共享可变的 current_shop.txt。
 *
 * 复现的竞态（源码事实，不依赖真实 Cookie/浏览器/网络）：
 *  - server 的 /run-douyin-analyzer 与 /run-douyin-multi 各有独立运行标志，
 *    single + multi 可重叠；
 *  - 两条路径都先写同一个 current_shop.txt，再 spawn 分析器；
 *  - 修复前分析器 main 在启动时读该文件。晚启动的 A 会读到 B 后写入的店名，
 *    从而加载 B 的 Cookie。
 *
 * 本测试用真实 node 子进程（仅解析 helper，不开浏览器、不联网、不读写真实 Cookie）：
 * 先冻结 A 的 env → 共享文件改成 B → 晚启动 A 的子进程，仍必须得到 A；
 * 另覆盖 B/C 交错、显式空串、Unicode、父 env 不变、无 env 的旧 CLI 回退。
 * 末尾的源码接线断言是次要检查，主体是上面的真实 spawn 行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const HELPER = path.join(APP_DIR, 'analyzer-shop-target.js');
const SERVER_SRC = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8');
const ANALYZER_SRC = fs.readFileSync(path.join(APP_DIR, 'douyin-shop-analyzer.js'), 'utf8');

const {
  ANALYZER_SHOP_ENV,
  buildAnalyzerLaunchEnv,
  resolveAnalyzerShopTarget,
} = require('../analyzer-shop-target');

const STRICT_CHILD = `
const { resolveAnalyzerShopTarget } = require(${JSON.stringify(HELPER)});
const r = resolveAnalyzerShopTarget({
  env: process.env,
  legacyShopFile: process.env.D16_LEGACY_FILE,
  readFile: () => { throw new Error('legacy-read-forbidden'); },
  exists: () => { throw new Error('legacy-exists-forbidden'); },
});
process.stdout.write(JSON.stringify(r));
`;

const LEGACY_CHILD = `
const { resolveAnalyzerShopTarget } = require(${JSON.stringify(HELPER)});
const r = resolveAnalyzerShopTarget({
  env: process.env,
  legacyShopFile: process.env.D16_LEGACY_FILE,
});
process.stdout.write(JSON.stringify(r));
`;

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd16-shop-binding-'));
}

function writeLegacy(dir, name) {
  fs.writeFileSync(path.join(dir, 'current_shop.txt'), name, 'utf8');
}

function childEnv(shopName, legacyFile) {
  const env = buildAnalyzerLaunchEnv(process.env, shopName);
  env.D16_LEGACY_FILE = legacyFile;
  return env;
}

function runChild(env, script) {
  const res = spawnSync(process.execPath, ['-e', script], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(res.error, undefined, '子进程不应启动失败: ' + (res.error && res.error.message));
  assert.equal(res.status, 0, '子进程应正常退出: ' + (res.stderr || ''));
  return JSON.parse(res.stdout);
}

test('功能：A 的 env 先冻结，共享文件改成 B/C 后晚启动仍解析为 A', () => {
  const dir = makeWorkspace();
  try {
    const legacy = path.join(dir, 'current_shop.txt');
    writeLegacy(dir, '甲店旗舰店');
    const envA = childEnv('甲店旗舰店', legacy);

    writeLegacy(dir, '乙店企业店');
    const envB = childEnv('乙店企业店', legacy);

    writeLegacy(dir, '丙店专卖店');
    const envC = childEnv('丙店专卖店', legacy);

    // 交错启动：A 在文件已经变成 B、再到 C 之后才启动，仍必须是 A。
    const b = runChild(envB, STRICT_CHILD);
    const a = runChild(envA, STRICT_CHILD);
    const c = runChild(envC, STRICT_CHILD);

    assert.deepEqual(a, { shopName: '甲店旗舰店', source: 'explicit-env' });
    assert.deepEqual(b, { shopName: '乙店企业店', source: 'explicit-env' });
    assert.deepEqual(c, { shopName: '丙店专卖店', source: 'explicit-env' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('功能：显式空串是权威值，绝不回读旧共享文件', () => {
  const dir = makeWorkspace();
  try {
    const legacy = path.join(dir, 'current_shop.txt');
    writeLegacy(dir, '乙店企业店');
    const envEmpty = childEnv('', legacy);

    // STRICT_CHILD 的 readFile/exists 一旦被调用就会抛错：能返回即证明零回退。
    const r = runChild(envEmpty, STRICT_CHILD);
    assert.deepEqual(r, { shopName: '', source: 'explicit-env' });

    const inProc = resolveAnalyzerShopTarget({
      env: { [ANALYZER_SHOP_ENV]: '' },
      legacyShopFile: legacy,
      readFile: () => { throw new Error('legacy-read-forbidden'); },
      exists: () => { throw new Error('legacy-exists-forbidden'); },
    });
    assert.deepEqual(inProc, { shopName: '', source: 'explicit-env' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('功能：构造 launch env 不改父环境，显式店名覆盖继承值', () => {
  const parent = {
    PATH: process.env.PATH,
    [ANALYZER_SHOP_ENV]: '继承店',
    KEEP: '1',
  };
  const before = JSON.stringify(parent);

  const env = buildAnalyzerLaunchEnv(parent, '本次店');
  assert.notEqual(env, parent, '必须返回新对象');
  assert.equal(env[ANALYZER_SHOP_ENV], '本次店', '显式店名覆盖继承值');
  assert.equal(env.KEEP, '1', '父环境其他字段保留');
  assert.equal(parent[ANALYZER_SHOP_ENV], '继承店', '父环境不得被修改');
  assert.equal(JSON.stringify(parent), before, '父环境整体不变');

  const inherited = buildAnalyzerLaunchEnv(parent, undefined);
  assert.equal(inherited[ANALYZER_SHOP_ENV], '继承店', '未提供时保留继承值');
  assert.equal(parent[ANALYZER_SHOP_ENV], '继承店');
});

test('功能：Unicode 店铺名原样冻结（不 trim、不修复）', () => {
  const name = '甲店·旗舰店（抖音）';
  const env = buildAnalyzerLaunchEnv({}, name);
  assert.equal(env[ANALYZER_SHOP_ENV], name);

  const r = resolveAnalyzerShopTarget({
    env,
    legacyShopFile: 'unused.txt',
    readFile: () => { throw new Error('legacy-read-forbidden'); },
    exists: () => { throw new Error('legacy-exists-forbidden'); },
  });
  assert.equal(r.shopName, name);
  assert.equal(r.source, 'explicit-env');
});

test('功能：无显式 env（旧 CLI 直连）仍回退读 current_shop.txt', () => {
  const dir = makeWorkspace();
  try {
    const legacy = path.join(dir, 'current_shop.txt');
    writeLegacy(dir, ' 旧店企业店 \n');
    const env = { ...process.env };
    delete env[ANALYZER_SHOP_ENV];
    env.D16_LEGACY_FILE = legacy;

    const r = runChild(env, LEGACY_CHILD);
    assert.deepEqual(r, {
      shopName: '旧店企业店',
      source: 'legacy-file',
      legacyShopFile: legacy,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('接线（次要）：两个 server spawn 点都传入 helper env，分析器 main 使用 resolver', () => {
  assert.match(SERVER_SRC, /require\(['"]\.\/analyzer-shop-target['"]\)/);
  assert.equal(
    (SERVER_SRC.match(/env:\s*buildAnalyzerLaunchEnv\(/g) || []).length,
    2,
    'single 与 multi 两个真实 spawn 点都必须使用 helper'
  );
  assert.match(
    SERVER_SRC,
    /env:\s*buildAnalyzerLaunchEnv\(\s*\{\s*\.\.\.process\.env,\s*AUTO_RUN_ID:\s*runId,\s*STATE_FILE:\s*stateFile\s*\},\s*shopName\s*\)/
  );
  assert.match(SERVER_SRC, /env:\s*buildAnalyzerLaunchEnv\(process\.env,\s*shopName\)/);

  assert.match(ANALYZER_SRC, /resolveAnalyzerShopTarget\(/);
  assert.doesNotMatch(ANALYZER_SRC, /fs\.readFileSync\(shopNameFile/);
});
