'use strict';

/**
 * 独立每日计划 runner 离线测试（R4；本轮只交付源文件，由主脑执行）。
 *
 * 独立命名用例（node:test）：一处失败不再吞掉后续场景。
 * 真实注入：真实 createScheduler（../bill-manager/promo-plan-scheduler.js）+
 * 假 clock + 临时独立根 + 合成 runPlan/readDaySuccess/discoverAccount/openShop spy。
 * 只允许合成 Cookie 哨兵，绝不接触生产/只读 Cookie，不启动浏览器、不联网。
 *
 * 运行：node --test daily-plan-runner.test.cjs   （或 node daily-plan-runner.test.cjs）
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNNER = require('./daily-plan-runner.cjs');
const WORK = path.join(__dirname, '..');
const SCHEDULER_PATH = path.join(WORK, 'bill-manager', 'promo-plan-scheduler.js');
const realScheduler = require(SCHEDULER_PATH);
assert.strictEqual(typeof realScheduler.createScheduler, 'function', '真实 createScheduler 必须可用');

// ── 工具 ─────────────────────────────────────────────────────────────────────
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'daily-plan-r4-')); }
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

// 上海 2026-10-25 09:00 = UTC 01:00（已过 08:00，到点可派发）
const T0 = Date.UTC(2026, 9, 25, 1, 0, 0);
const DATE = '2026-10-25';

const SHOPS = [
  { id: 'jin', name: '瑾漂亮潮流服饰', cookieFile: '瑾漂亮潮流服饰', accountId: null },        // 未配 ROI → 默认 15；accountId 空 → 走 discover
  { id: 'min', name: '敏敏高定私服', cookieFile: '敏敏高定私服', accountId: null, targetRoi: 13 }, // 敏 ROI 13
  { id: 'jianshang', name: '简尚衣橱优品店', cookieFile: '简尚衣橱优品店', accountId: '980001' }, // 已配账号，不 discover；未配 ROI → 默认 15
];

function makeEnv(shops, extra) {
  const root = tmpRoot();
  const cookieWorkDir = path.join(root, 'cookies-work');
  const cfgFile = path.join(root, 'daily-plan-config.json');
  const writeCfg = (over) => writeJson(cfgFile, Object.assign({
    enabled: true, autoConfirm: true, time: '08:00', timezone: 'Asia/Shanghai',
    plansPerShopPerDay: 3, dailyBudget: 300,
    adapterRoot: WORK,
    shops: shops || SHOPS,
    login: { cookieWorkDir, cookieSourceDir: cookieWorkDir },
  }, extra || {}, over || {}));
  return { root, cfgFile, writeCfg, cookieWorkDir, dataDir: path.join(root, 'daily-plan-data') };
}

// 值守侧哨兵：guard 配置（enabled:false）、值守工作 Cookie、两份只读 Cookie 档案。
// 全程必须字节不变——runner 不得读写任何一处（合计 4 份合成 Cookie 哨兵之一）。
function makeWatchSentinels(root) {
  const guardConfig = path.join(root, 'guard', 'config.json');
  writeJson(guardConfig, { planPublishing: { enabled: false, autoConfirm: false }, sentinel: 'guard-config-untouched' });
  const watchCookie = path.join(root, 'guard', 'cookies', 'watch-cookie.json');
  writeJson(watchCookie, { sentinel: 'watch-cookie-untouched', value: 'SYNTHETIC-WATCH-COOKIE' });
  const ro1 = path.join(root, 'raw-archive-1', 'cookies.json');
  writeJson(ro1, { sentinel: 'readonly-1-untouched' });
  const ro2 = path.join(root, 'cookie-recovery', 'cookies.json');
  writeJson(ro2, { sentinel: 'readonly-2-untouched' });
  const files = [guardConfig, watchCookie, ro1, ro2];
  const before = files.map((f) => fs.readFileSync(f, 'utf8'));
  return { files, assertUntouched: () => files.forEach((f, i) => assert.strictEqual(fs.readFileSync(f, 'utf8'), before[i], '值守/只读哨兵被改动: ' + f)) };
}

// 断言本轮进程从未加载值守服务/Monitor 模块。
function assertNoMonitorLoaded() {
  const loaded = Object.keys(require.cache).filter((k) => /watch-drill|ui[\\/]server|Monitor/i.test(k));
  assert.deepStrictEqual(loaded, [], '不应加载 watch-drill/server/Monitor 模块: ' + loaded.join(','));
}

// 递归列出根下全部相对路径（用于"未写值守目录"断言）。
function listTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name), r = rel ? rel + '/' + name : name;
      out.push(r);
      if (fs.statSync(p).isDirectory()) walk(p, r);
    }
  };
  walk(root, '');
  return out.sort();
}

// ── spy 依赖（合成，绝不触网/浏览器/生产 Cookie） ─────────────────────────────
function makeSpyDeps(daySuccessMap, opts = {}) {
  const calls = { runPlan: [], discover: [], readDaySuccess: [] };
  const deps = {
    // 与 run-plans.cjs runScheduledPlan 相同的调用形状：runPlan(business, planOpts)
    runPlan: async (business, planOpts) => {
      calls.runPlan.push({
        shop: business.shop, accountId: business.accountId, roi: business.roi,
        dailyBudget: planOpts.dailyBudget, plansPerShopPerDay: planOpts.plansPerShopPerDay,
        autoConfirm: planOpts.autoConfirm,
        hasOpenShop: typeof planOpts.openShop === 'function',
        hasLoadConfig: typeof planOpts.loadConfig === 'function',
        openShopIsRunnerOpenShop: planOpts.openShop === opts.runnerOpenShop,
        projectRoot: planOpts.projectRoot,
      });
      if (typeof opts.onRunPlanCall === 'function') opts.onRunPlanCall(calls.runPlan.length);
      if (opts.failShop === business.shop) return { status: 'failed', reason: 'simulated-single-shop-failure' };
      return { status: 'success', planId: 'synthetic-' + business.shop + '-' + planOpts.planNumber };
    },
    readDaySuccess: (shopLike, businessDate) => {
      calls.readDaySuccess.push({ shop: shopLike.shop, accountId: shopLike.accountId, businessDate });
      const n = (daySuccessMap || {})[shopLike.shop];
      if (n === undefined) return 0;
      if (n instanceof Error) throw n;
      return n;
    },
    discoverAccount: async (shopCfg, business, discoverOpts) => {
      assert.strictEqual(typeof discoverOpts.loadConfig, 'function', 'discover 注入必须携带独立 loadConfig 视图');
      calls.discover.push({
        shop: shopCfg && shopCfg.name, accountId: business && business.accountId,
        projectRoot: discoverOpts.projectRoot,
        hasOpenShop: typeof discoverOpts.openShop === 'function',
      });
      if (opts.discoverError) return { error: opts.discoverError };
      return '123456789';
    },
  };
  return { deps, calls };
}

function makeRunner(env, spy, clock, over = {}) {
  const runner = RUNNER.createDailyRunner({
    configFile: env.cfgFile,
    dataDir: over.dataDir || env.dataDir,
    stateRoot: path.join(over.dataDir || env.dataDir, 'publisher-state'), // 测试隔离：不写 publisher 原状态目录
    schedulerPath: SCHEDULER_PATH,
    deps: spy.deps,
    nowMs: () => clock.ms,
    onLog: () => {},
    ...(over.readers ? { readers: over.readers } : {}),
  });
  return runner;
}

const byShop = (spy, name) => spy.calls.runPlan.filter((c) => c.shop === name);

// ── 用例 ─────────────────────────────────────────────────────────────────────

test('导入零动作 + 配置校验：未配置 adapterRoot/login 必须被拒绝（不回落值守）', () => {
  assert.strictEqual(typeof RUNNER.createDailyRunner, 'function');
  assert.strictEqual(fs.existsSync(path.join(__dirname, 'daily-plan-data')), false, '导入不得创建默认数据目录');
  const bad = RUNNER.validateDailyConfig({
    enabled: true, autoConfirm: true, shops: SHOPS,
    adapterRoot: '', login: { cookieWorkDir: '', cookieSourceDir: '' },
  });
  assert.strictEqual(bad.ok, false, '空 adapterRoot/login 不得通过');
  assert.ok(bad.reasons.some((r) => r.includes('adapterRoot')), '应报 adapterRoot 未配置: ' + bad.reasons.join(';'));
  assert.ok(bad.reasons.some((r) => r.includes('cookieWorkDir')), '应报 cookieWorkDir 未配置');
  const relBad = RUNNER.validateDailyConfig({
    shops: SHOPS, adapterRoot: 'work/douyin-promo-guard',
    login: { cookieWorkDir: 'relative/cookies', cookieSourceDir: 'relative/cookies' },
  });
  assert.strictEqual(relBad.ok, false, '相对路径不得通过');
  const okEnv = makeEnv();
  const good = RUNNER.validateDailyConfig({
    shops: SHOPS, adapterRoot: WORK,
    login: { cookieWorkDir: okEnv.cookieWorkDir, cookieSourceDir: okEnv.cookieWorkDir },
  });
  assert.strictEqual(good.ok, true, '绝对路径配置应通过: ' + good.reasons.join(';'));
});

test('主场景：旧成功2补1、新店3份、unknown(seed min)不重放、ROI 默认15/敏13、discover/openShop 接线', async () => {
  const env = makeEnv();
  const sentinels = makeWatchSentinels(env.root);
  env.writeCfg();
  writeJson(path.join(env.root, 'synthetic-cookie-sentinel.json'), { v: 'SYNTHETIC-ONLY' });
  writeJson(path.join(env.dataDir, 'ledger.json'), {
    version: 1,
    days: {
      [DATE]: { shops: {
        // 敏（shop.id='min'）：预置 unknown 终态 → 本日零派发、零重放。
        'min': { status: 'unknown', plans: 0, lastAt: 'keep', error: 'seed-unknown-no-replay', entries: { 1: { planNumber: 1, status: 'unknown', reason: 'seed' } } },
      } },
    },
  });
  const spy = makeSpyDeps({ '瑾漂亮潮流服饰': 2 });
  const clock = { ms: T0 };
  const runner = makeRunner(env, { deps: spy.deps, calls: spy.calls }, clock);
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  // 瑾：外部 2 + 补 1 = 3；简尚：全新 3；敏：unknown 零派发。
  assert.strictEqual(byShop(spy, '瑾漂亮潮流服饰').length, 1, '旧成功 2 只补 1');
  assert.strictEqual(byShop(spy, '简尚衣橱优品店').length, 3, '简尚新店 3 份');
  assert.strictEqual(byShop(spy, '敏敏高定私服').length, 0, 'unknown 店不重放');
  // 瑾 accountId 空 → discover 一次（真实适配签名）；简尚/敏已配或未达 discover。
  assert.strictEqual(spy.calls.discover.filter((d) => d.shop === '瑾漂亮潮流服饰').length, 1);
  assert.strictEqual(spy.calls.discover.filter((d) => d.shop === '简尚衣橱优品店').length, 0);
  assert.strictEqual(spy.calls.discover.filter((d) => d.shop === '敏敏高定私服').length, 0);
  // ROI：瑾/简尚未配置 → 排程器默认 15；预算/份数原样进入发布参数。
  for (const c of byShop(spy, '瑾漂亮潮流服饰').concat(byShop(spy, '简尚衣橱优品店'))) {
    assert.strictEqual(c.roi, 15, '未配置 ROI 必须走默认 15（不得误配 13）');
    assert.strictEqual(c.dailyBudget, 300);
    assert.strictEqual(c.plansPerShopPerDay, 3);
    assert.strictEqual(c.autoConfirm, true);
  }
  // discover 后 accountId 已填入 business。
  assert.strictEqual(byShop(spy, '瑾漂亮潮流服饰')[0].accountId, '123456789');
  assert.strictEqual(byShop(spy, '简尚衣橱优品店')[0].accountId, '980001');
  // R4 接线：runPlan/discover 注入均携带独立 loadConfig 视图、projectRoot 与 openShop 包装。
  for (const c of spy.calls.runPlan) {
    assert.strictEqual(c.hasOpenShop, true, 'runPlan 注入必须携带 openShop DI');
    assert.strictEqual(c.hasLoadConfig, true);
    assert.strictEqual(c.projectRoot, WORK);
  }
  for (const d of spy.calls.discover) {
    assert.strictEqual(d.hasOpenShop, true, 'discover 注入必须携带 openShop DI');
    assert.strictEqual(d.projectRoot, WORK);
  }
  // 值守 enabled:false 哨兵全程存在，本轮照常派发（独立开关）且哨兵字节不变。
  sentinels.assertUntouched();
});

test('同日重跑零重复；账本断言用真实 shop.id（jin/min/jianshang）', async () => {
  const env = makeEnv();
  env.writeCfg();
  writeJson(path.join(env.dataDir, 'ledger.json'), {
    version: 1,
    days: { [DATE]: { shops: {
      'min': { status: 'unknown', plans: 0, lastAt: 'keep', error: 'seed-unknown-no-replay', entries: { 1: { planNumber: 1, status: 'unknown', reason: 'seed' } } },
    } } },
  });
  const spy = makeSpyDeps({ '瑾漂亮潮流服饰': 2 });
  const clock = { ms: T0 };
  const runner = makeRunner(env, spy, clock);
  await runner.tick();
  const countAfterFirst = spy.calls.runPlan.length;
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(spy.calls.runPlan.length, countAfterFirst, '同日重跑零重复派发');
  const led = readJson(path.join(env.dataDir, 'ledger.json'));
  assert.strictEqual(led.days[DATE].shops['jin'].plans, 3, '账本键必须是真实 shop.id（jin）');
  assert.strictEqual(led.days[DATE].shops['jianshang'].plans, 3);
  assert.strictEqual(led.days[DATE].shops['min'].status, 'unknown', 'unknown 保持终态，不清零不重放');
});

test('fresh 停用（tick 前写入 own config）：零派发', async () => {
  const env = makeEnv();
  env.writeCfg({ enabled: false });
  const spy = makeSpyDeps({});
  const clock = { ms: T0 };
  const runner = makeRunner(env, spy, clock);
  const res = await runner.tick();
  assert.strictEqual(res.skipped, 'not-authorized');
  assert.strictEqual(spy.calls.runPlan.length, 0, 'fresh 停用后零派发');
});

test('单批中途停用：第一单成功后停用 → 底层 runPlan 仅 1 次，后续店/份零新会话', async () => {
  const env = makeEnv();
  env.writeCfg();
  const clock = { ms: T0 };
  let envRef = null;
  const opts = {
    onRunPlanCall: () => { envRef.writeCfg({ enabled: false }); }, // 第一份真实发单成功路径内停用 own config
  };
  const spy = makeSpyDeps({}, opts);
  envRef = env;
  const runner = makeRunner(env, spy, clock);
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(spy.calls.runPlan.length, 1, '底层 runPlan 只能被调用 1 次（wrapper fresh 门生效）');
  assert.strictEqual(spy.calls.discover.length, 1, 'discover 新会话只允许发生在停用前（瑾第一店）');
  assert.strictEqual(spy.calls.discover[0].shop, '瑾漂亮潮流服饰');
  const led = readJson(path.join(env.dataDir, 'ledger.json')).days[DATE].shops;
  assert.strictEqual(led.jin.status, 'unknown');
  assert.ok(String(led.jin.error || '').includes('daily-plan-fresh-disabled-no-dispatch'), '停用后的份必须诚实 unknown：' + led.jin.error);
  assert.strictEqual(led.min.status, 'blocked');
  assert.ok(String(led.min.error || '').includes('daily-plan-fresh-disabled-no-discovery'), '停用后不得再 discover：' + led.min.error);
  assert.strictEqual(led.jianshang.status, 'unknown', '已配账号店同样不再发单');
});

test('单店失败继续其它店 + 跨日恢复；敏 ROI 13 / 瑾默认 15 原样进入参数', async () => {
  const env = makeEnv();
  env.writeCfg();
  const clock = { ms: Date.UTC(2026, 9, 26, 1, 0, 0) }; // 次日 09:00 上海
  const spy = makeSpyDeps({}, { failShop: '简尚衣橱优品店' });
  const dataDir = path.join(env.root, 'daily-plan-data-fail');
  const runner = makeRunner(env, spy, clock, { dataDir });
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(byShop(spy, '简尚衣橱优品店').length, 1, '失败店只试 1 份即停');
  assert.strictEqual(byShop(spy, '瑾漂亮潮流服饰').length, 3, '其它店不受影响继续 3 份');
  assert.strictEqual(byShop(spy, '敏敏高定私服').length, 3, '敏在新账本根正常 3 份（unknown 只封当日，不跨日封店）');
  for (const c of byShop(spy, '敏敏高定私服')) assert.strictEqual(c.roi, 13, '敏 ROI 13');
  for (const c of byShop(spy, '瑾漂亮潮流服饰')) assert.strictEqual(c.roi, 15, '瑾未配置默认 15');
  const led = readJson(path.join(dataDir, 'ledger.json'));
  assert.strictEqual(led.days['2026-10-26'].shops['jianshang'].status, 'failed');
  assert.strictEqual(led.days['2026-10-26'].shops['min'].plans, 3);
});

test('越界检查：全部产物只落在独立目录；值守/只读 4 份合成 Cookie 哨兵字节不变；未加载 Monitor', async () => {
  const env = makeEnv();
  const sentinels = makeWatchSentinels(env.root);
  env.writeCfg();
  const spy = makeSpyDeps({});
  const clock = { ms: T0 };
  const runner = makeRunner(env, spy, clock);
  const beforeTree = new Set(listTree(env.root));
  await runner.tick();
  const tree = listTree(env.root);
  for (const rel of tree) {
    assert.ok(beforeTree.has(rel) || /^daily-plan-data(?:[\\/]|$)/.test(rel),
      '越界写入: ' + rel);
  }
  assert.ok(tree.some((r) => r.startsWith('guard/')), '哨兵前置失败');
  sentinels.assertUntouched();
  assertNoMonitorLoaded();
});

test('--check：已配置通过、未配置准确报错、零写入、输出无 Cookie 值', () => {
  const env = makeEnv();
  env.writeCfg();
  const dataDirBefore = fs.existsSync(env.dataDir) ? listTree(env.dataDir).join('|') : '';
  const check = RUNNER.runCheck({ configFile: env.cfgFile, schedulerPath: SCHEDULER_PATH });
  assert.strictEqual(check.ok, true, '已配置 check 应通过: ' + JSON.stringify(check.reasons));
  assert.strictEqual(check.adapterRootConfigured, true);
  assert.strictEqual(check.loginConfigured, true);
  assert.strictEqual(check.schedulerExportsOk, true);
  assert.strictEqual(check.publisherExportsOk, true);
  const dataDirAfter = fs.existsSync(env.dataDir) ? listTree(env.dataDir).join('|') : '';
  assert.strictEqual(dataDirAfter, dataDirBefore, '--check 零写入');
  assert.strictEqual(check.config.enabled, true);
  assert.ok(JSON.stringify(check).indexOf('SYNTHETIC') === -1 && JSON.stringify(check).indexOf('Cookie') === -1, 'check 输出不得含 Cookie 值');
  // 未配置（空占位）必须准确报错，不得 ok:true。
  const bare = makeEnv();
  bare.writeCfg({ adapterRoot: '', login: { cookieWorkDir: '', cookieSourceDir: '' } });
  const bareCheck = RUNNER.runCheck({ configFile: bare.cfgFile, schedulerPath: SCHEDULER_PATH });
  assert.strictEqual(bareCheck.ok, false, '空占位配置 check 必须失败');
  assert.strictEqual(bareCheck.adapterRootConfigured, false);
  assert.strictEqual(bareCheck.loginConfigured, false);
  const joined = bareCheck.reasons.join(';');
  assert.ok(joined.includes('adapterRoot'), 'reasons 应指出 adapterRoot 未配置: ' + joined);
  assert.ok(joined.includes('cookieWorkDir'), 'reasons 应指出 cookieWorkDir 未配置: ' + joined);
});

test('openShop 包装：保留 login/shop/headless 实参并追加 readOnlyStatus:true，返回原生 opened', async () => {
  const env = makeEnv();
  env.writeCfg();
  let seen = null;
  const fakeReaders = {
    openChengfangShop: async (a) => { seen = a; return { nativeOpened: true, target: {}, context: {} }; },
  };
  const clock = { ms: T0 };
  const runner = makeRunner(env, makeSpyDeps({}), clock, { readers: fakeReaders });
  const args = { loginCfg: { cookieWorkDir: env.cookieWorkDir, cookieSourceDir: env.cookieWorkDir }, shopCfg: { name: '简尚衣橱优品店', cookieFile: '简尚衣橱优品店' }, headless: true };
  const opened = await runner.openShop(args);
  assert.strictEqual(opened.nativeOpened, true, '常规店必须返回原生 opened 对象');
  assert.strictEqual(seen.readOnlyStatus, true, '必须以 readOnlyStatus:true 包装首次使用页面');
  assert.strictEqual(seen.headless, true);
  assert.strictEqual(seen.loginCfg.cookieWorkDir, env.cookieWorkDir);
  assert.strictEqual(seen.shopCfg.name, '简尚衣橱优品店');
  assert.strictEqual(typeof seen.loginCfg, 'object');
});

test('脚本契约：PS 变量大小写冲突为零、注册对象仅 Register 分支构造；VBS 真实等待退出码', () => {
  const vbs = fs.readFileSync(path.join(__dirname, 'daily-plan-hidden.vbs'), 'utf8');
  const ps1 = fs.readFileSync(path.join(__dirname, 'daily-plan-task.ps1'), 'utf8')
    .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  for (const text of [vbs, ps1]) {
    assert.ok(!/taskkill|Stop-Process|treekill/i.test(text), '不得树杀进程');
    assert.ok(!/cmd(\.exe)?\s*\/c/i.test(text), '不得使用可见 cmd');
  }
  // PS：param 名与局部赋值变量不得大小写不敏感同名（R4 实证冲突源）。
  // 解析必须容忍多行 [Parameter(...)]/[ValidateSet(...)] 属性（注释行已剥离），
  // 且按括号配平取块，不能靠"第一个 \n)"这种会被属性括号干扰的写法。
  const paramStart = ps1.indexOf('param(');
  assert.ok(paramStart !== -1, 'ps1 必须有 param 块');
  let depth = 0, paramEnd = -1;
  for (let i = ps1.indexOf('(', paramStart); i < ps1.length; i++) {
    if (ps1[i] === '(') depth++;
    else if (ps1[i] === ')') { depth--; if (depth === 0) { paramEnd = i; break; } }
  }
  assert.ok(paramEnd > paramStart, 'ps1 的 param 块必须括号闭合');
  const paramBlock = ps1.slice(paramStart, paramEnd + 1);
  const paramNames = [...paramBlock.matchAll(/^\s*(?:\[[^\]]*\]\s*)*\$([A-Za-z_]\w*)/gm)].map((m) => m[1].toLowerCase());
  assert.deepStrictEqual([...new Set(paramNames)].sort(), ['action', 'executenow', 'taskname'], 'param 名解析必须对应当前脚本: ' + paramNames.join(','));
  const body = ps1.slice(0, paramStart) + ps1.slice(paramEnd + 1);
  const assigned = [...body.matchAll(/\$([A-Za-z_]\w*)\s*=/g)].map((m) => m[1].toLowerCase());
  const collisions = assigned.filter((n) => paramNames.includes(n));
  assert.deepStrictEqual([...new Set(collisions)], [], 'param 名被局部变量大小写不敏感覆盖: ' + collisions.join(','));
  // PS：注册对象只在 Register 分支内构造；Show 等只读动作零构造。
  assert.ok(ps1.indexOf('New-ScheduledTaskAction') > ps1.indexOf("'Register' {"), 'New-ScheduledTaskAction 必须只在 Register 分支');
  assert.ok(ps1.indexOf('New-ScheduledTaskSettingsSet') > ps1.indexOf("'Register' {"));
  // patrol-plan-refill（2026-10-26）：全天值守周期按需触发，注册不含任何固定时间触发器。
  assert.equal(ps1.indexOf('New-ScheduledTaskTrigger'), -1, '必须零触发器构造（不再有 08:00/每日时间触发器）');
  assert.ok(ps1.includes('//B //Nologo'), 'ps1 必须用 wscript //B //Nologo');
  assert.ok(ps1.includes('Register-ScheduledTask') && !/-Trigger\b/.test(ps1), 'ps1 注册独立按需任务且不传 -Trigger');
  assert.ok(ps1.includes('ExecuteNow'), '默认注册不立即执行（仅显式 -ExecuteNow 触发）');
  // VBS：等待 node 真正结束并传回真实退出码；仍隐藏窗口。
  assert.ok(vbs.includes(', 0, True'), 'vbs 必须以等待模式（True）隐藏启动');
  assert.ok(!vbs.includes(', 0, False'), 'vbs 不得提前返回（False 假完成）');
  assert.ok(/WScript\.Quit\(\s*code\s*\)/.test(vbs), 'vbs 必须 WScript.Quit 传真实退出码');
});

test('R5 脚本契约：显式当前用户 Interactive/Limited Principal；注册为按需任务（无固定时间触发器）', () => {
  const ps1 = fs.readFileSync(path.join(__dirname, 'daily-plan-task.ps1'), 'utf8')
    .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  // Principal：显式当前用户 + Interactive + Limited，并传给 Register-ScheduledTask。
  assert.ok(ps1.indexOf('New-ScheduledTaskPrincipal') > ps1.indexOf("'Register' {"), 'Principal 只在 Register 分支构造');
  assert.ok(/\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/.test(ps1), 'UserId 必须取当前身份');
  assert.ok(ps1.includes('-LogonType Interactive'));
  assert.ok(ps1.includes('-RunLevel Limited'));
  assert.ok(ps1.includes('-Principal $taskPrincipal'), 'Register 必须显式传 -Principal');
  // 不提权、不绕过、不改 DACL、不创建 SYSTEM 任务。
  assert.ok(!/RunLevel\s+(Highest|SYSTEM)/i.test(ps1), '不得请求 Highest/SYSTEM');
  assert.ok(!/schtasks/i.test(ps1), '不得用 schtasks 绕过');
  assert.ok(!/RunAs|SetAccessControl|DACL/i.test(ps1), '不得 RunAs/改 DACL');
  // patrol-plan-refill（2026-10-26 用户要求）：补发改为全天值守巡查周期按需触发，
  // 因此注册里不得再出现任何固定时间触发器 / 固定每日时刻。
  assert.equal(ps1.indexOf('New-ScheduledTaskTrigger'), -1, '必须零触发器构造（不再要求旧每日调度模式）');
  assert.ok(!/-Daily\b/.test(ps1), '不得使用 -Daily 每日触发器');
  assert.ok(!/-At\b/.test(ps1), '不得使用 -At 固定时刻');
  assert.ok(!/\$firstAt/.test(ps1), '不得构造固定首次触发 DateTime');
  // 默认注册不立即执行：只有显式 -ExecuteNow 才允许 Start-ScheduledTask。
  assert.ok(/\$ExecuteNow\s*\)\s*\{\s*Start-ScheduledTask/.test(ps1), 'Start-ScheduledTask 必须由 -ExecuteNow 显式门控');
  assert.ok(ps1.includes('无固定时间触发器'), '注册提示必须如实说明按需任务语义');
});
