'use strict';

/**
 * 独立 runner 值守补发模式（2026-10-26 patrol-plan-refill）离线测试：
 *   - 去掉 08:00 门槛：08:00 前的值守触发照常补发（time 归一 00:00）；
 *   - 每店数量以页面保存值为准：每店 4（全局 3）真实上限 4，不硬编码 3；
 *   - 数量在两次运行之间增/减 → 每次运行 fresh 读最新值；已成功份数绝不重发；
 *   - 跨日（午夜翻日）→ 新业务日重新计数，旧日成功保留；
 *   - 已达上限 → 零执行器调用；部分完成 → 只补缺额；
 *   - unknown / in-progress 终态 → 不重放；
 *   - 已证明从未提交（unsubmitted）→ 后续值守检查**不限次**重试补齐（patrol-plan-refill
 *     返修：删除自造的 48 次/日封顶；runner 显式传 null=Infinity，仅此调用方）；
 *     其它调用方缺省仍为 legacy 3 次封顶（failed-permanent 语义不变）。
 * 真实注入：真实 createScheduler（../bill-manager/promo-plan-scheduler.js）+ 假 clock +
 * 临时独立根 + 合成 runPlan/readDaySuccess spy；不触网、不启动浏览器、不读任何 Cookie。
 *
 * 运行：node --test patrol-refill.test.cjs
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNNER = require('./daily-plan-runner.cjs');
const WORK = path.join(__dirname, '..');
const SCHEDULER_PATH = path.join(WORK, 'integrations', 'bill-manager', 'promo-plan-scheduler.js');
const realScheduler = require(SCHEDULER_PATH);
assert.strictEqual(typeof realScheduler.createScheduler, 'function');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-refill-run-')); }
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

// 上海时区锚点：2026-10-25 06:00（08:00 前）= UTC 2026-10-24 22:00
const T_BEFORE_08 = Date.UTC(2026, 9, 24, 22, 0, 0);
const DATE = '2026-10-25';
// 上海 2026-10-26 00:30（跨日后的第一次值守检查）= UTC 2026-10-25 16:30
const T_NEXT_DAY = Date.UTC(2026, 9, 25, 16, 30, 0);
const DATE2 = '2026-10-26';

const SHOP_MIN = { id: 'min', name: '敏敏高定私服', cookieFile: '敏敏高定私服', accountId: '980001', targetRoi: 12.5 };

function makeEnv(shops) {
  const root = tmpRoot();
  const cookieWorkDir = path.join(root, 'cookies-work');
  const cfgFile = path.join(root, 'daily-plan-config.json');
  const writeCfg = (over) => writeJson(cfgFile, Object.assign({
    enabled: true, autoConfirm: true, time: '08:00', timezone: 'Asia/Shanghai',
    plansPerShopPerDay: 3, dailyBudget: 300,
    adapterRoot: WORK,
    shops: shops || [SHOP_MIN],
    login: { cookieWorkDir, cookieSourceDir: cookieWorkDir },
  }, over || {}));
  return { root, cfgFile, writeCfg, dataDir: path.join(root, 'daily-plan-data') };
}

function makeSpy(daySuccessMap, opts = {}) {
  const calls = { runPlan: [] };
  const deps = {
    runPlan: async (business, planOpts) => {
      calls.runPlan.push({ shop: business.shop, planNumber: planOpts.planNumber, roi: business.roi, plansPerShopPerDay: planOpts.plansPerShopPerDay });
      return { status: 'success', planId: '123456789012' };
    },
    readDaySuccess: (shopLike, businessDate) => {
      const n = (daySuccessMap || {})[shopLike.shop];
      return n === undefined ? 0 : n;
    },
    discoverAccount: async () => '123456789',
  };
  return { deps, calls };
}

function makeRunner(env, spy, clock) {
  return RUNNER.createDailyRunner({
    configFile: env.cfgFile,
    dataDir: env.dataDir,
    stateRoot: path.join(env.dataDir, 'publisher-state'),
    schedulerPath: SCHEDULER_PATH,
    deps: spy.deps,
    nowMs: () => clock.ms,
    onLog: () => {},
  });
}

const ledgerPath = (env) => path.join(env.dataDir, 'ledger.json');

test('08:00 前（上海 06:00）值守触发照常补发：无 before-time 跳过', async () => {
  const env = makeEnv();
  env.writeCfg();
  const spy = makeSpy({});
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  const res = await runner.tick();
  assert.strictEqual(res.ran, true, '去 08:00 门槛后任何时刻都到点：' + JSON.stringify(res.skipped || ''));
  assert.strictEqual(spy.calls.runPlan.length, 3, '全局 3 份照常派发');
  const led = readJson(ledgerPath(env));
  assert.strictEqual(led.days[DATE].shops['min'].plans, 3);
});

test('每店数量 4（页面保存值）真实上限 4，不硬编码全局 3', async () => {
  const env = makeEnv([Object.assign({}, SHOP_MIN)]);
  env.writeCfg(); // 全局 3
  // 页面保存的每店数量写入独立配置（shop/update 同步的结果形状）
  const cfg = readJson(env.cfgFile);
  cfg.shops[0].plansPerShopPerDay = 4;
  writeJson(env.cfgFile, cfg);
  const spy = makeSpy({});
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(spy.calls.runPlan.length, 4, '每店 4 就是 4，不是全局 3');
  for (const c of spy.calls.runPlan) assert.strictEqual(c.plansPerShopPerDay, 4);
  assert.strictEqual(readJson(ledgerPath(env)).days[DATE].shops['min'].plans, 4);
});

test('两次运行之间数量上调/下调：fresh 读最新值，已成功份数绝不重发', async () => {
  const env = makeEnv();
  env.writeCfg();
  const spy = makeSpy({});
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 3, '首轮 3 份');
  // 上调 3 → 5：下一次值守检查只补缺额 2
  const cfg = readJson(env.cfgFile);
  cfg.shops[0].plansPerShopPerDay = 5;
  writeJson(env.cfgFile, cfg);
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 5, '上调后只补 2 份缺额');
  const planNums = spy.calls.runPlan.map((c) => c.planNumber);
  assert.deepStrictEqual(planNums, [1, 2, 3, 4, 5], '份号连续不重不发');
  // 下调 5 → 2：已成功 5 份保持，不再新增
  cfg.shops[0].plansPerShopPerDay = 2;
  writeJson(env.cfgFile, cfg);
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 5, '下调后零新发');
  const led = readJson(ledgerPath(env));
  const rec = led.days[DATE].shops['min'];
  assert.strictEqual(rec.plans, 5, '已成功份数是不可变事实');
  const successEntries = Object.values(rec.entries).filter((e) => e.status === 'success');
  assert.strictEqual(successEntries.length, 5, '成功条目逐份保留');
});

test('午夜翻日：新业务日重新计数，旧日成功原样保留', async () => {
  const env = makeEnv();
  env.writeCfg();
  const spy = makeSpy({});
  const clock = { ms: T_BEFORE_08 };
  const runner = makeRunner(env, spy, clock);
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 3);
  clock.ms = T_NEXT_DAY; // 上海 2026-10-26 00:30 的第一次值守检查
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 6, '新的一天重新 3 份');
  const led = readJson(ledgerPath(env));
  assert.strictEqual(led.days[DATE].shops['min'].plans, 3, '旧日成功保留');
  assert.strictEqual(led.days[DATE2].shops['min'].plans, 3, '新日独立计数');
});

test('已达上限（外部真实成功读数）→ 零执行器调用', async () => {
  const env = makeEnv();
  env.writeCfg();
  const spy = makeSpy({ '敏敏高定私服': 3 });
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(spy.calls.runPlan.length, 0, '上限已满零重做');
});

test('部分完成（外部已 2）→ 只补缺额第 3 份', async () => {
  const env = makeEnv();
  env.writeCfg();
  const spy = makeSpy({ '敏敏高定私服': 2 });
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 1);
  assert.strictEqual(spy.calls.runPlan[0].planNumber, 3, '只补第 3 份，不重发 1/2');
});

test('unknown / in-progress 终态 → 不重放（既有语义不变）', async () => {
  const env = makeEnv();
  env.writeCfg();
  writeJson(ledgerPath(env), {
    version: 1,
    days: { [DATE]: { shops: {
      'min': { status: 'unknown', plans: 0, lastAt: 'keep', error: 'seed-unknown-no-replay', entries: { 1: { planNumber: 1, status: 'unknown', reason: 'seed' } } },
    } } },
    }
  );
  const spy = makeSpy({});
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  await runner.tick();
  assert.strictEqual(spy.calls.runPlan.length, 0, 'unknown 绝不重放');
  assert.strictEqual(readJson(ledgerPath(env)).days[DATE].shops['min'].status, 'unknown');
});

test('已证明从未提交的缺额：旧 3 次封顶耗尽后，后续值守检查仍能补齐（不再永久冻结）', async () => {
  const env = makeEnv();
  env.writeCfg();
  // 模拟旧实现：3 次重试已耗尽但仍带零发布证明的 unsubmitted（plans=0 → 当天缺 3 份）
  writeJson(ledgerPath(env), {
    version: 1,
    days: { [DATE]: { shops: {
      'min': {
        status: 'unsubmitted', plans: 0, lastAt: 'keep', error: 'preparation-stopped',
        retry: { attempts: 3, lastAt: 'keep', nextAt: new Date(T_BEFORE_08 - 60 * 1000).toISOString() },
        entries: { 1: { planNumber: 1, status: 'unsubmitted', reason: 'preparation-stopped', at: 'keep', retryable: true, attempt: 3 } },
      },
    } } },
    }
  );
  const spy = makeSpy({});
  const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
  const res = await runner.tick();
  assert.strictEqual(res.ran, true);
  assert.strictEqual(spy.calls.runPlan.length, 3, 'patrol 模式放宽封顶后，后续检查必须能补齐缺额');
  assert.strictEqual(readJson(ledgerPath(env)).days[DATE].shops['min'].plans, 3);
});

test('patrol 返修：不再有自造封顶——attempts 48/100 仍可补齐（严格证明从未提交的缺额）', async () => {
  for (const attempts of [48, 100]) {
    const env = makeEnv();
    env.writeCfg();
    writeJson(ledgerPath(env), {
      version: 1,
      days: { [DATE]: { shops: {
        'min': {
          status: 'unsubmitted', plans: 0, lastAt: 'keep', error: 'preparation-stopped',
          retry: { attempts, lastAt: 'keep', nextAt: new Date(T_BEFORE_08 - 60 * 1000).toISOString() },
          entries: { 1: { planNumber: 1, status: 'unsubmitted', reason: 'preparation-stopped', at: 'keep', retryable: true, attempt: attempts } },
        },
      } } },
    });
    const spy = makeSpy({});
    const runner = makeRunner(env, spy, { ms: T_BEFORE_08 });
    const res = await runner.tick();
    assert.strictEqual(res.ran, true);
    assert.strictEqual(spy.calls.runPlan.length, 3, `attempts=${attempts} 仍必须能补齐缺额`);
    assert.strictEqual(readJson(ledgerPath(env)).days[DATE].shops['min'].plans, 3);
    assert.notStrictEqual(readJson(ledgerPath(env)).days[DATE].shops['min'].status, 'failed-permanent');
  }
});

test('legacy 默认 3 次封顶保留：不传 maxUnsubmittedRetries 的调用方仍 failed-permanent', async () => {
  const dir = tmpRoot();
  const ledgerFile = path.join(dir, 'ledger.json');
  writeJson(ledgerFile, {
    version: 1,
    days: { [DATE]: { shops: {
      'min': {
        status: 'unsubmitted', plans: 0, lastAt: 'keep', error: 'preparation-stopped',
        retry: { attempts: 3, lastAt: 'keep', nextAt: new Date(T_BEFORE_08 - 60 * 1000).toISOString() },
        entries: { 1: { planNumber: 1, status: 'unsubmitted', reason: 'preparation-stopped', at: 'keep', retryable: true, attempt: 3 } },
      },
    } } },
  });
  let dispatches = 0;
  const sched = realScheduler.createScheduler({
    planPublishing: { enabled: true, autoConfirm: true, time: '00:00', timezone: 'Asia/Shanghai', plansPerShopPerDay: 3, dailyBudget: 300 },
    ledgerFile,
    lockFile: ledgerFile + '.lock',
    nowMs: () => T_BEFORE_08,
    listShops: () => [{ id: 'min', name: '敏敏高定私服', accountId: '980001' }],
    buildBusiness: (s) => ({ shop: s.name, accountId: s.accountId }),
    readDaySuccess: () => 0,
    runPlan: async () => { dispatches += 1; return { status: 'success', planId: '123456789012' }; },
    onLog: () => {},
  });
  await sched.tick();
  assert.strictEqual(dispatches, 0, 'legacy 缺省 3 次封顶后本日不再重试');
  assert.strictEqual(readJson(ledgerFile).days[DATE].shops['min'].status, 'failed-permanent');
});

test('真实 runner 集成：tick 内页面改数量 4→1 → 不发第 2 份；上调 1→4 → 只补 3 份缺额且新 ROI 生效', async () => {
  const env = makeEnv();
  env.writeCfg({
    shops: [Object.assign({}, SHOP_MIN, { plansPerShopPerDay: 4, targetRoi: 12.5 })],
  });
  const seen = [];
  const deps = {
    runPlan: async (business, planOpts) => {
      seen.push({ roi: business.roi, planNumber: planOpts.planNumber, cap: planOpts.plansPerShopPerDay });
      if (seen.length === 1) {
        // 首份成功后页面立即保存：数量 4→1、ROI 12.5→13
        const cfg = readJson(env.cfgFile);
        cfg.shops[0].plansPerShopPerDay = 1;
        cfg.shops[0].targetRoi = 13;
        writeJson(env.cfgFile, cfg);
      }
      return { status: 'success', planId: '123456789012' };
    },
    readDaySuccess: () => 0,
    discoverAccount: async () => '123456789',
  };
  const runner = makeRunner(env, { deps }, { ms: T_BEFORE_08 });
  await runner.tick();
  assert.strictEqual(seen.length, 1, '数量降为 1 后本 tick 不得再派发第 2 份');
  assert.strictEqual(seen[0].roi, 12.5, '首份仍用旧 ROI');
  assert.strictEqual(seen[0].cap, 4);
  const led1 = readJson(ledgerPath(env));
  assert.strictEqual(led1.days[DATE].shops['min'].plans, 1, '已成功 1 份持久');
  // 上调 1→4：后续 3 份缺额补齐，已成功第 1 份不重发，ROI 13 到达后续份
  const cfg = readJson(env.cfgFile);
  cfg.shops[0].plansPerShopPerDay = 4;
  writeJson(env.cfgFile, cfg);
  await runner.tick();
  assert.strictEqual(seen.length, 4, '只补 3 份缺额');
  assert.deepStrictEqual(seen.slice(1).map((s) => s.planNumber), [2, 3, 4], '份号连续、不重发第 1 份');
  assert.deepStrictEqual(seen.slice(1).map((s) => s.roi), [13, 13, 13], '变更后的 ROI 必须到达后续份');
  const led2 = readJson(ledgerPath(env));
  assert.strictEqual(led2.days[DATE].shops['min'].plans, 4);
  const successEntries = Object.values(led2.days[DATE].shops['min'].entries).filter((e) => e.status === 'success');
  assert.strictEqual(successEntries.length, 4, '已成功份数全部保留');
});
