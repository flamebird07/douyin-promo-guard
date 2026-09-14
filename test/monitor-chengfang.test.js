'use strict';

/**
 * 主链路联合测试：生产 Monitor（pollOnce/_pollShop/_pollChengfangOver）+ ChengfangRunner
 * + 乘方执行器 + 本地 DOM fixture（隔离浏览器，绝不访问生产页面）。
 *
 * 覆盖用户本轮要求（问题 6 验证真正的主链路）：
 * - 费用 100元/100单（恰好=阈值）不点击；100.01元/100单进入乘方暂停；
 * - 演练或任一执行开关关闭（realMode / pauseEnabled / execution.dryRun）均零真实动作；
 * - 07:59、操作中跨日、选择完成后停止均不发新暂停请求；
 * - 操作前重读后不超标 → 取消（零页面会话）；
 * - 回读前新增/重新开启对象 → 不误报全部暂停；
 * - 弹窗检测失败 / 删除确认弹窗 → 零点击；删除按钮点击数始终为 0；
 * - 托管开关点击结果未知 → 只回读确认，不反复切换（避免反向开启）；
 * - 只控制乘方：配置乘方范围时不进入历史全店覆盖流程。
 *
 * 运行：npm test（node --test）
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { chromium } = require('playwright');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { buildChengfangFixtureHtml } = require('./chengfang-fixture');
const { createChengfangController } = require('../src/adapters/chengfang-reader');
const { ChengfangRunner } = require('../src/engine/chengfang-runner');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ACCOUNT_ID = '1710242295996424';
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: ACCOUNT_ID, enabled: true };

const TUOGUAN_PLAN = { id: '184388555253250562', name: '全店托管 2025-09-21_商品全店托管', checked: true };
const ZIXUAN_PLANS = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `1875859981405339${String(i).padStart(3, '0')}`, name: `千川乘方_计划${i}`, checked: true }));

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1280,900'] });
});
after(async () => {
  await browser.close().catch(() => {});
});

/**
 * 构建 Monitor + 注入 reader/controller/chengfangOpener（本地 DOM fixture）。
 * @returns {{ monitor, controller, reader, track }} track={ sessions, clickLog, listAdPageCalls }
 */
async function setupChengfangMonitor(t, {
  costCents = 10001, orders = 100,
  fixture, execution = {}, monitorChengfang = {},
  clock = null, legacyWholeShop = false, noScope = false,
  controllerWrap = null, readerWrap = null,
} = {}) {
  const cookieDir = makeTempDir('pg-ck-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');

  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: Object.assign({ realMode: true, dryRun: false }, execution),
    monitor: Object.assign(
      {},
      noScope ? {} : { chengfang: Object.assign({ scope: ['全店托管', '商品自选'], pauseEnabled: true }, monitorChengfang) },
      legacyWholeShop ? { legacyWholeShopCloseEnabled: true } : {}
    ),
  });

  const controller = makeStatefulController({ identity: { id: 'shop-001', name: '测试店铺一', accountId: ACCOUNT_ID }, ads: [] });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page', costAccountId: ACCOUNT_ID }, clock ? clock.nowFn : undefined);
  if (readerWrap) readerWrap(reader);
  const track = { sessions: 0, clickLog: null, listAdPageCalls: 0 };
  const origList = reader.listAdPage.bind(reader);
  reader.listAdPage = async (args) => { track.listAdPageCalls += 1; return origList(args); };

  let monitorRef = null;
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock ? clock.nowFn : undefined,
    delayFn: clock ? clock.delayFn : undefined,
    chengfangOpener: async ({ loginCfg, shopCfg }) => {
      track.sessions += 1;
      const page = await browser.newPage();
      const html = buildChengfangFixtureHtml(fixture || { plans: { '全店托管': [], '商品自选': [] } });
      await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto(`https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
      let ctrl = createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 });
      if (controllerWrap) ctrl = await controllerWrap(ctrl, page, monitorRef);
      return {
        page,
        controller: ctrl,
        close: async () => {
          track.clickLog = await page.evaluate(() => window.__CF.clickLog).catch(() => null);
          await page.close().catch(() => {});
        },
      };
    },
  });
  monitorRef = monitor;
  return { monitor, controller, reader, track, dataDir, cookieDir };
}

const pauseClicks = (log) => (log || []).filter((c) => c.type === 'pause');
const deleteClicks = (log) => (log || []).filter((c) => c.type === 'delete');
const switchClicks = (log) => (log || []).filter((c) => c.type === 'switch');

// ── 主链路：阈值判定 ───────────────────────────────────────────────

test('主链路：费用 100.00元/100单 恰好=阈值 → 不进入乘方暂停（零点击、零页面会话）', async (t) => {
  const { monitor, track } = await setupChengfangMonitor(t, { costCents: 10000, orders: 100 });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].over, false, '恰好 1 元/单不触发');
  assert.strictEqual(monitor.triggers.length, 0, '无触发记录');
  assert.strictEqual(track.sessions, 0, '未打开乘方页面');
});

test('主链路：费用 100.01元/100单 → 乘方全店托管+商品自选真实暂停，全部回读确认', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    costCents: 10001, orders: 100, clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(23) } },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].over, true);
  assert.strictEqual(r.results[0].batch.outcome, 'all_paused_confirmed', r.results[0].batch.reason);
  assert.strictEqual(r.results[0].batch.allPausedConfirmed, true);
  assert.strictEqual(track.sessions, 1);
  assert.strictEqual(switchClicks(track.clickLog).length, 1, '全店托管行开关点击一次');
  assert.strictEqual(pauseClicks(track.clickLog).length, 1, '商品自选批量暂停一次');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0, '删除零点击');
  assert.ok(monitor.batches['shop-001']['2026-09-12'], '批次按业务日期持久化');
});

// ── 演练 / 执行开关关闭 → 零真实动作 ────────────────────────────────

test('主链路：演练模式（realMode=false）→ dry 周期零业务点击', async (t) => {
  const { monitor, track } = await setupChengfangMonitor(t, {
    execution: { realMode: false, dryRun: true },
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(5) } },
  });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].dryRun, true);
  assert.strictEqual(r.results[0].chengfang.outcome, 'dry');
  assert.strictEqual(monitor.triggers[0].mode, 'dry');
  assert.strictEqual(monitor.triggers[0].targetCount, 6, '枚举 1 托管 + 5 商品自选');
  assert.strictEqual((track.clickLog || []).length, 0, '演练零业务点击');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('主链路：realMode=true 但 pauseEnabled=false → blocked，零点击、零页面会话', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock, monitorChengfang: { pauseEnabled: false },
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /pauseEnabled/);
  assert.strictEqual(track.sessions, 0, '门槛未过不打开页面');
});

test('主链路：execution.dryRun=true 即使 realMode+pauseEnabled 全开 → blocked，零点击', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock, execution: { realMode: true, dryRun: true },
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /dryRun/);
  assert.strictEqual(track.sessions, 0);
});

// ── 时段 / 跨日 / 停止 → 不发新暂停请求 ────────────────────────────

test('主链路：上海时间 07:59 → window_blocked，零页面会话', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:59'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'window_blocked');
  assert.match(r.results[0].reason, /08:00/);
  assert.ok(monitor.schedule.lastWindowBlockReason, '窗口原因对外可见');
  assert.strictEqual(track.sessions, 0);
});

test('主链路：操作中跨日（第2页处理时跨午夜）→ 不再发新暂停请求', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  let advanced = false;
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) } },
    controllerWrap: async (ctrl) => {
      const orig = ctrl.readBatchBar.bind(ctrl);
      let calls = 0;
      ctrl.readBatchBar = async (p) => {
        calls += 1;
        if (calls === 3 && !advanced) { advanced = true; clock.advance(25 * 3600 * 1000); } // 第2页选择完成后跨日
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason || batch.reason, /跨日/);
  assert.strictEqual(pauseClicks(track.clickLog).length, 1, '仅第1页发出一次暂停，第2页被跨日门槛拦截');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('主链路：选择完成后收到停止信号 → 不发新暂停请求', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  let stopped = false;
  let monitorRef = null;
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(5) } },
    controllerWrap: async (ctrl, page, mon) => {
      monitorRef = mon;
      const orig = ctrl.readBatchBar.bind(ctrl);
      ctrl.readBatchBar = async (p) => {
        if (!stopped) { stopped = true; monitorRef.stop(); } // 选择完成后停止 → 点击前门槛拦截
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.outcome, 'partial');
  assert.match(batch.confirmReason, /停止发出批量暂停请求|停止/);
  assert.strictEqual(pauseClicks(track.clickLog).length, 0);
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

// ── 操作前重读 ─────────────────────────────────────────────────────

test('主链路：操作前重读后已不超标 → 取消（零页面会话）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
    readerWrap: (reader) => {
      const orig = reader.readCostSummary.bind(reader);
      let n = 0;
      reader.readCostSummary = async (args) => {
        n += 1;
        const s = await orig(args);
        if (n >= 2) return { ...s, valueCents: 10000, rawText: '¥100.00（重读注入）' }; // 恰好不超标
        return s;
      };
    },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].batch.outcome, 'cancelled');
  assert.match(r.results[0].batch.reason, /已不超标|取消/);
  assert.strictEqual(track.sessions, 0, '取消后不打开乘方页面');
});

// ── 全量回读：新增/重新开启对象 ─────────────────────────────────────

test('主链路：全量回读前新增开启对象 → 不误报全部暂停', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl, page) => {
      const orig = ctrl.ensureFirstPage.bind(ctrl);
      let injected = false;
      ctrl.ensureFirstPage = async (p) => {
        if (!injected) {
          injected = true;
          await page.evaluate(() => window.__CF.addPlan('商品自选', { id: '199999999999999999', name: '被恢复投放的计划', checked: true }));
        }
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /开启侧/);
  assert.strictEqual(pauseClicks(track.clickLog).length, 1, '暂停已发出但结果以全量回读为准');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

// ── 防误删：弹窗 / 检测失败 ────────────────────────────────────────

test('主链路：删除确认弹窗 → 停止，暂停/开关/删除均零点击', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: {
      plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) },
      dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认删除该计划？删除后不可恢复</span><button>确定</button></div>',
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /非预期弹窗|删除/);
  assert.strictEqual((track.clickLog || []).length, 0, '业务按钮零点击');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('主链路：弹窗检测失败（detectDanger 抛错）→ 零点击停止', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl) => {
      ctrl.detectDanger = async () => { throw new Error('fixture: 弹窗检测失败'); };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /弹窗检测失败/);
  assert.strictEqual((track.clickLog || []).length, 0);
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

// ── 点击结果未知：禁止盲点重试（托管开关是切换动作）─────────────────

test('主链路：托管开关点击结果未知但已生效 → 只回读确认，不重复切换', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  let switchCalls = 0;
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(2) } },
    controllerWrap: async (ctrl) => {
      const orig = ctrl.clickRowSwitch.bind(ctrl);
      ctrl.clickRowSwitch = async (p) => {
        switchCalls += 1;
        if (switchCalls === 1) {
          await orig(p); // 点击已生效（fixture 翻转开关）
          throw new Error('fixture: 点击后连接中断，结果未知');
        }
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.outcome, 'all_paused_confirmed', batch.reason);
  assert.strictEqual(switchCalls, 1, '结果未知只回读确认，绝不盲点重试');
  assert.strictEqual(switchClicks(track.clickLog).length, 1);
});

test('主链路：托管开关点击结果未知且未生效 → 禁止重复切换（避免反向开启），停止', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  let switchCalls = 0;
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(2) } },
    controllerWrap: async (ctrl) => {
      const orig = ctrl.clickRowSwitch.bind(ctrl);
      ctrl.clickRowSwitch = async (p) => {
        switchCalls += 1;
        if (switchCalls === 1) throw new Error('fixture: 点击未生效且结果未知');
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /禁止重复切换|结果未知/);
  assert.strictEqual(switchCalls, 1, '只尝试一次，绝不盲点重试');
  assert.strictEqual(switchClicks(track.clickLog).length, 0, '未发生第二次切换');
});

// ── 只控制乘方：不进入历史全店覆盖流程 ──────────────────────────────

test('主链路：配置乘方范围时即使开启历史路径也不进入（只控制乘方）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, controller, track } = await setupChengfangMonitor(t, {
    clock, legacyWholeShop: true,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
  });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].batch.outcome, 'all_paused_confirmed');
  assert.strictEqual(track.listAdPageCalls, 0, '未读取历史覆盖清单');
  assert.strictEqual(controller.state.closeCalls.length, 0, '未走旧 closeAd 流程');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('主链路：未配置乘方范围且未开启历史路径 → blocked（fail-closed，不执行任何关闭）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, { clock, noScope: true });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /未配置乘方控制范围/);
  assert.strictEqual(track.sessions, 0);
});

// ── 演练入口强制只读（问题一）───────────────────────────────────────

/** 直接构造 Runner 的本地 fixture 会话（不经 Monitor，便于用"允许真实"配置跑演练）。 */
async function makeDryFixture(fixture) {
  const page = await browser.newPage();
  const html = buildChengfangFixtureHtml(fixture);
  await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
  const controller = createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 });
  let clickLog = null;
  const opener = async () => ({
    page,
    controller,
    close: async () => {
      clickLog = await page.evaluate(() => window.__CF.clickLog).catch(() => null);
      await page.close().catch(() => {});
    },
  });
  return { opener, readClickLog: () => clickLog };
}

const BAD_NAV = '首页 乘方 全域投放 品牌投放 伊人美 ID：1999888877776666';

test('演练入口强制只读：realMode+pauseEnabled 全开也走 dryRun，托管/暂停/开启/删除均零点击', async () => {
  const cfg = makeCfgResult({
    shops: [SHOP],
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
  });
  const runner = new ChengfangRunner({ coordinator: {}, config: cfg.config });
  const { opener, readClickLog } = await makeDryFixture({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(5) } });
  const res = await runner.runDryCycle({ shopCfg: SHOP, pageOpener: opener, loginCfg: {} });
  assert.strictEqual(res.outcome, 'dry', res.error);
  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.mode, 'dry-run', '配置允许真实时演练入口仍必须为 dry-run，不得为 execute');
  assert.strictEqual((readClickLog() || []).length, 0, '演练零业务点击');
  assert.strictEqual(deleteClicks(readClickLog()).length, 0);
});

// ── 演练失败透出（问题二）──────────────────────────────────────────

test('演练失败透出（Runner级）：身份核验失败 → dry_failed，不显示正常枚举', async () => {
  const cfg = makeCfgResult({
    shops: [SHOP],
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
  });
  const runner = new ChengfangRunner({ coordinator: {}, config: cfg.config });
  const { opener, readClickLog } = await makeDryFixture({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) }, navText: BAD_NAV });
  const res = await runner.runDryCycle({ shopCfg: SHOP, pageOpener: opener, loginCfg: {} });
  assert.strictEqual(res.outcome, 'dry_failed');
  assert.match(res.error, /身份核验失败/);
  assert.strictEqual(res.targets.length, 0, '失败不得显示为已枚举目标');
  assert.strictEqual((readClickLog() || []).length, 0);
});

test('主链路集成：演练身份核验失败 → trigger 透出 failed，不计为正常枚举', async (t) => {
  const { monitor, track } = await setupChengfangMonitor(t, {
    execution: { realMode: false, dryRun: true },
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) }, navText: BAD_NAV },
  });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].chengfang.outcome, 'dry_failed');
  assert.strictEqual(r.results[0].targetCount, 0, '失败不显示目标数');
  const tr = monitor.triggers[0];
  assert.strictEqual(tr.failed, true, 'trigger 标记失败');
  assert.match(tr.note, /失败/);
  assert.match(monitor.recentErrors[0].error, /乘方演练失败/);
  assert.strictEqual((track.clickLog || []).length, 0);
});

// ── 贴近真正点击的最终检查（问题四）────────────────────────────────

test('贴近点击：弹窗检测期间收到停止 → 不发批量暂停/开关请求', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl, page, mon) => {
      const orig = ctrl.detectDanger.bind(ctrl);
      ctrl.detectDanger = async (p) => {
        const r = await orig(p);
        mon.stop(); // 弹窗检测期间停止 → 点击派发前（beforeDispatch）拦截
        return r;
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /停止|拦截/);
  assert.strictEqual(pauseClicks(track.clickLog).length, 0, '停止后不发新暂停请求');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('贴近点击：最后定位期间跨午夜 → 不发批量暂停请求', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl) => {
      const orig = ctrl.clickBatchPause.bind(ctrl);
      ctrl.clickBatchPause = async (p) => {
        clock.advance(25 * 3600 * 1000); // 请求级门槛已过后再跨午夜 → clickBatchPause 内 beforeDispatch 拦截
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /跨日|最终检查拦截/);
  assert.strictEqual(pauseClicks(track.clickLog).length, 0);
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('贴近点击 + gate 实时：批次中关闭暂停许可 → 已发出托管继续回读，不再发批量暂停', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl, page, mon) => {
      const orig = ctrl.clickBatchPause.bind(ctrl);
      ctrl.clickBatchPause = async (p) => {
        mon.config.monitor.chengfang.pauseEnabled = false; // 点击派发前关闭许可 → beforeDispatch gate 实时拦截
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /最终检查拦截|pauseEnabled/);
  assert.strictEqual(switchClicks(track.clickLog).length, 1, '托管已发出并回读，不再重复切换');
  assert.strictEqual(pauseClicks(track.clickLog).length, 0, '许可关闭后不再发批量暂停');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});

test('贴近点击：页面账户变化 → beforeDispatch 身份复检拦截，零点击停止', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) } },
    controllerWrap: async (ctrl, page) => {
      const orig = ctrl.readBatchBar.bind(ctrl);
      ctrl.readBatchBar = async (p) => {
        await page.evaluate((txt) => {
          const n = document.querySelector('.qc-page-navigator-container');
          if (n) n.textContent = txt;
        }, BAD_NAV); // 账户身份变化 只在 select 完成后、点击派发前生效 → beforeDispatch verifyIdentity 拦截
        return orig(p);
      };
      return ctrl;
    },
  });
  const r = await monitor.pollOnce('interval');
  const batch = r.results[0].batch;
  assert.strictEqual(batch.allPausedConfirmed, false);
  assert.match(batch.confirmReason, /账户|身份变化/);
  assert.strictEqual((track.clickLog || []).length, 0, '账户变化后零点击');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
});
