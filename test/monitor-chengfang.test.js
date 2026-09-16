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
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs, shanghaiWall } = require('../src/lib/time');
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
    try { monitorRef.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' }); } catch (_) {}
    try { monitorRef.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');

  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: Object.assign({ realMode: true, dryRun: false, readbackTimeoutMs: 3000, readbackIntervalMs: 500 }, execution),
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
  return { monitor, controller, reader, track, dataDir, cookieDir, cfgResult };
}

const pauseClicks = (log) => (log || []).filter((c) => c.type === 'pause');
const enableClicks = (log) => (log || []).filter((c) => c.type === 'enable');
const deleteClicks = (log) => (log || []).filter((c) => c.type === 'delete');
const switchClicks = (log) => (log || []).filter((c) => c.type === 'switch');

const TUOGUAN_CLOSED = { ...TUOGUAN_PLAN, checked: false };
const ZIXUAN_CLOSED = (n) => ZIXUAN_PLANS(n).map((p) => ({ ...p, checked: false }));

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

// ═══════════════════════════════════════════════════════════════════
// 每日 07:00 自动开启相位（monitor._intervalLoop 调度）
// 门禁 = realMode + enableEnabled + 上海 [enableHour, dailyStartHour) 窗口
// + 监控已启动（未启动绝不执行开启）；当天一次、跨日重置；不依赖费用/订单阈值。
// ═══════════════════════════════════════════════════════════════════

/** 启动监控循环并推进到"开启相位已执行 / 已挂起等待"的状态。 */
async function startLoopAndSettle(monitor, clock) {
  monitor.start();
  // _intervalLoop 是异步循环：等待首个 delayFn 门挂起（意味着窗口判断已完成）。
  // 07:00 开启相位会先执行真实/演练批次（本地 fixture 数秒）后才挂起等待，
  // 故超时必须覆盖相位耗时（60s），否则会误判"循环未挂起"。
  await waitFor(() => clock.pending() >= 1, 60000, '循环挂起');
}

/** 最近一次批次的 outcome（持久化批次记录顶层无 outcome，须取 runs 末条）。 */
const lastRunOutcome = (monitor, shopId, date) => {
  const rec = monitor.batches[shopId] && monitor.batches[shopId][date];
  return rec && rec.runs.length ? rec.runs[rec.runs.length - 1].outcome : undefined;
};

test('自动开启调度：07:00 前（06:00）启动 → 等待开启窗口，零开启动作、零页面会话', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await startLoopAndSettle(monitor, clock);
  assert.strictEqual(monitor.schedule.phase, 'waiting_window', '等待开启窗口');
  assert.strictEqual(clock.pending(), 1, '循环挂起等待 07:00');
  assert.strictEqual(track.sessions, 0, '未到开启窗口不打开乘方页');
  assert.strictEqual(monitor.triggers.length, 0);
  assert.strictEqual(monitor.actions.length, 0);
  monitor.stop();
});

test('自动开启调度：07:00 整 → 执行每日开启（真实 all_enabled_confirmed，只走全店托管+商品自选）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const switchViews = [];
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(5) } },
    controllerWrap: async (ctrl) => {
      const orig = ctrl.switchView.bind(ctrl);
      ctrl.switchView = async (p) => {
        switchViews.push(p.tab);
        return orig(p);
      };
      return ctrl;
    },
  });
  await startLoopAndSettle(monitor, clock);
  await waitFor(() => !!monitor.batches['shop-001'] && !!monitor.batches['shop-001']['2026-09-12'], 8000, '开启批次落库');
  const batch = monitor.batches['shop-001']['2026-09-12'];
  assert.strictEqual(lastRunOutcome(monitor, 'shop-001', '2026-09-12'), 'all_enabled_confirmed', batch.reason);
  assert.strictEqual(batch.allEnabledConfirmed, true);
  assert.strictEqual(track.sessions, 1, '开启相位打开一次乘方页');
  // 操作阶段 + 全量回读阶段各切换两个子标签，共 4 次；关键不变量是绝不触碰标准/全域/品牌
  assert.strictEqual(switchViews.length, 4, `开启相位切换标签次数（操作2 + 回读2）：${switchViews.join(',')}`);
  assert.ok(switchViews.every((v) => v === '全店托管' || v === '商品自选'), `不触碰标准/全域/品牌：${switchViews.join(',')}`);
  assert.strictEqual(switchClicks(track.clickLog).length, 1, '全店托管行开关点击一次');
  assert.strictEqual(enableClicks(track.clickLog).length, 1, '商品自选批量开启一次');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0, '删除始终零点击');
  assert.strictEqual(monitor.actions.length, 1, '开启动作已记录');
  monitor.stop();
});

test('自动开启调度：当天只执行一次（同一天重启监控不重复开启）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await startLoopAndSettle(monitor, clock);
  await waitFor(() => !!monitor.batches['shop-001'] && !!monitor.batches['shop-001']['2026-09-12'], 8000, '第一次开启批次落库');
  assert.strictEqual(track.sessions, 1);
  monitor.stop();
  // 同一天重启：_lastEnableDate 仍为 2026-09-12 → 不重复开启，直接等待 08:00
  await startLoopAndSettle(monitor, clock);
  assert.strictEqual(track.sessions, 1, '同一天重启不重复开启');
  assert.strictEqual(lastRunOutcome(monitor, 'shop-001', '2026-09-12'), 'all_enabled_confirmed');
  monitor.stop();
});

test('自动开启调度：跨日重置 → 次日 07:00 允许再次执行', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    costCents: 10000, // 恰好不超标：避免 08:00 暂停巡查再开页面，隔离开启相位计数
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await startLoopAndSettle(monitor, clock);
  await waitFor(() => !!monitor.batches['shop-001'] && !!monitor.batches['shop-001']['2026-09-12'], 20000, '第一天开启批次落库（含真实开启+落地轮询耗时）');
  assert.strictEqual(track.sessions, 1);
  // 释放到 08:00 → 暂停巡查（不超标，零会话）→ 挂起 30 分钟间隔
  clock.releaseOne();
  await waitFor(() => clock.pending() >= 1, 5000, '08:00 后挂起');
  assert.strictEqual(track.sessions, 1, '08:00 暂停巡查不打开页面（费用恰好不超标）');
  // 直接推进虚拟时钟到次日 07:00，释放当前 30 分钟门 → 次日 07:30（仍在开启窗口）
  clock.advance(23 * 3600 * 1000);
  clock.releaseOne();
  await waitFor(() => !!monitor.batches['shop-001'] && !!monitor.batches['shop-001']['2026-09-13'], 20000, '次日开启批次落库（含真实开启+落地轮询耗时）');
  assert.strictEqual(track.sessions, 2, '跨日重置后次日再次执行开启');
  assert.strictEqual(lastRunOutcome(monitor, 'shop-001', '2026-09-13'), 'all_enabled_confirmed');
  monitor.stop();
});

test('自动开启调度：监控未启动 → 手动 pollOnce（07:00）也不触发开启（window_blocked，零会话）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  // 不调用 monitor.start()：调度循环不存在，开启相位（仅由 _intervalLoop 驱动）不可能被触发
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'window_blocked', '07:00 未到暂停窗口，暂停路径被窗口阻止');
  assert.strictEqual(track.sessions, 0, '零页面会话');
  assert.strictEqual(monitor.actions.length, 0, '零开启/暂停动作');
  assert.strictEqual(monitor.batches['shop-001'], undefined, '无开启批次');
  // 手动 pollOnce 只走暂停路径并因未到 08:00 被窗口阻止：允许存在 window_blocked 命中记录，
  // 但绝不允许任何执行动作（开启/暂停均未发出）
  assert.ok(monitor.triggers.length >= 1, '暂停路径窗口阻止命中记录');
  assert.ok(monitor.triggers.every((t) => t.blocked === 'window' && t.mode === 'real'), '仅窗口阻止记录，无任何执行');
  // 第三轮回归：真实 trigger 必须带显式动作标签（值守侧 describeTrigger 只认 targetAction，不猜）
  assert.ok(monitor.triggers.every((t) => t.targetAction === 'pause'),
    `真实暂停 trigger 必须带 targetAction='pause'，实际：${JSON.stringify(monitor.triggers.map((t) => t.targetAction))}`);
});

test('第三轮：真实开启路径被窗口拦下 → trigger 带 targetAction=enable（动作标签不得缺失）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  // 直接驱动 Monitor 的单店铺开启相位（08:30 已过开启窗口 [07:00,08:00)）→
  // runner 集中门槛拦截 → blocked_window trigger（真实代码路径，非手工塞事件）
  await monitor._runShopEnablePhase(monitor.config.shops[0], { aborted: false });
  const tr = monitor.triggers.find((x) => x.mode === 'real' && x.blocked === 'window');
  assert.ok(tr, `必须产生真实 blocked_window trigger，实际：${JSON.stringify(monitor.triggers)}`);
  assert.strictEqual(tr.targetAction, 'enable', '真实开启 trigger 必须带 targetAction=enable');
  assert.match(tr.reason || '', /时段|窗口|08:00|07:00/);
  assert.strictEqual(track.sessions, 0, '窗口拦截零页面会话');
  assert.strictEqual(monitor.actions.length, 0, '零动作');
});

test('自动开启调度：enableEnabled=false → 07:00 相位 blocked，零页面会话、零动作', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { pauseEnabled: true, enableEnabled: false },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await startLoopAndSettle(monitor, clock);
  assert.strictEqual(track.sessions, 0, 'enableEnabled=false 不打开乘方页');
  assert.strictEqual(monitor.actions.length, 0, '零开启动作');
  assert.strictEqual(monitor.batches['shop-001'], undefined, '无开启批次');
  assert.ok(monitor.recentErrors.some((e) => /开启/.test(e.error)), '门槛原因进入错误记录');
  monitor.stop();
});

test('自动开启调度：realMode=false → 开启相位为演练（枚举目标，零业务点击）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { pauseEnabled: true, enableEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(5) } },
  });
  await startLoopAndSettle(monitor, clock);
  await waitFor(() => monitor.triggers.length >= 1, 8000, '开启演练 trigger 记录');
  const tr = monitor.triggers[0];
  assert.strictEqual(tr.mode, 'dry', '演练模式');
  assert.strictEqual(tr.targetCount, 6, '枚举 1 托管 + 5 商品自选');
  assert.match(tr.reason, /每日 7:00 自动开启/);
  assert.strictEqual((track.clickLog || []).length, 0, '演练零业务点击（开关/开启/删除均不点）');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0);
  assert.strictEqual(monitor.actions.length, 0, '演练不产生真实动作记录');
  monitor.stop();
});

// ══════════════════════════════════════════════════════════════
// 上线（2026-09-15）：独立每日开启调度器——生命周期与"启动值守"完全分离
// ══════════════════════════════════════════════════════════════

test('上线：未启动值守也到 07:00 自动开启（独立调度器驱动，演练零点击）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:30'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { enableSchedulerEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(5) } },
  });
  const r = monitor.startEnableScheduler({ reason: 'test' });
  assert.strictEqual(r.ok, true, `调度器应登记成功：${r.reason || ''}`);
  assert.strictEqual(monitor.running, false, '值守（暂停巡查）必须仍未启动');
  assert.strictEqual(monitor.enableRunning, true);
  assert.ok(monitor.getStatus().monitor.enableScheduler.nextRunAt, '必须立即登记下次开启时间');
  await waitFor(() => clock.pending() >= 1, 8000, '调度器挂起等待 07:00');
  clock.releaseAll(); // 06:30 → 07:00
  await waitFor(() => monitor.triggers.length >= 1, 15000, '开启演练 trigger');
  const tr = monitor.triggers[0];
  assert.strictEqual(tr.mode, 'dry');
  assert.strictEqual(tr.targetAction, 'enable', '开启 trigger 必须带显式动作标签');
  assert.strictEqual(tr.targetCount, 6, '枚举 1 托管 + 5 商品自选');
  assert.strictEqual(monitor.running, false, '全程值守仍未启动');
  assert.strictEqual((track.clickLog || []).length, 0, '演练零业务点击');
  assert.strictEqual(deleteClicks(track.clickLog).length, 0, '删除零点击');
});

test('上线：停止值守不取消每日开启；值守运行标志与开启调度器标志互不影响', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:30'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { enableSchedulerEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await monitor.startEnableScheduler({ reason: 'test' });
  monitor.start(); // 启动值守（暂停巡查）
  assert.strictEqual(monitor.running, true);
  assert.strictEqual(monitor.enableRunning, true);
  monitor.stop(); // 停止值守 → 只中止 kind!=='enable' 的令牌与暂停循环
  assert.strictEqual(monitor.running, false, '值守已停止');
  assert.strictEqual(monitor.enableRunning, true, '每日开启任务必须仍运行');
  await waitFor(() => clock.pending() >= 1, 8000, '调度器仍挂起等待');
  clock.releaseAll(); // → 07:00
  await waitFor(() => monitor.triggers.length >= 1, 15000, '停止值守后开启仍执行');
  assert.strictEqual(monitor.triggers[0].targetAction, 'enable');
  assert.strictEqual((track.clickLog || []).length, 0);
});

test('上线：独立停用每日开启 → 07:00 零请求；持久化停用标记，恢复后才可运行', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:30'));
  const { monitor, track, dataDir, cfgResult, controller, reader } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { enableSchedulerEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  monitor.stopEnableScheduler({ byUser: true, reason: 'test' });
  assert.strictEqual(monitor.enableRunning, false);
  clock.releaseAll(); // 即便时间推进过 07:00（无挂起门则直接推进）
  clock.advance(60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(track.sessions, 0, '独立停用后零页面会话');
  assert.strictEqual(monitor.triggers.length, 0, '零开启记录');
  assert.strictEqual(monitor.getStatus().monitor.enableScheduler.stoppedByUser, true, '停用标记可见');
  // 重启（新实例，同一状态目录）：停用标记持久化 → 自动恢复被拒；resume 后可运行
  const monitor2 = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn });
  assert.strictEqual(monitor2.startEnableScheduler({ reason: 'boot' }).ok, false, '重启不得复活用户独立停用的任务');
  const rr = monitor2.resumeEnableScheduler({ reason: 'user-resume' });
  assert.strictEqual(rr.ok, true, '恢复后可运行');
  assert.strictEqual(monitor2.enableRunning, true);
  monitor2.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('上线：08:00 后启动调度器 → 记录"错过窗口"原因，不擅自补开，下次=明日 07:00', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:05'));
  const { monitor, track } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { enableSchedulerEnabled: true },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  const r = monitor.startEnableScheduler({ reason: 'test' });
  assert.strictEqual(r.ok, true);
  await waitFor(() => clock.pending() >= 1, 8000, '调度器登记明日窗口');
  const es = monitor.getStatus().monitor.enableScheduler;
  assert.match(es.lastMissedReason || '', /错过|不擅自补开/, '必须记录错过窗口原因');
  assert.strictEqual(track.sessions, 0, '08:00 后零页面会话（不补开）');
  assert.strictEqual(monitor.triggers.length, 0);
  const next = new Date(es.nextRunAt);
  const wall = shanghaiWall(next.getTime());
  assert.strictEqual(wall.hour, 7, '下次开启必须是明日 07:00（上海）');
  assert.strictEqual(wall.date, '2026-09-13');
});

test('上线：当日已 success 后窗口内重启 → 不重复开启（真实模式，零新会话）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor, track, dataDir, cfgResult, controller, reader } = await setupChengfangMonitor(t, {
    clock,
    monitorChengfang: { enableSchedulerEnabled: true, enableEnabled: true },
    execution: { realMode: true, dryRun: false, readbackTimeoutMs: 3000, readbackIntervalMs: 500 },
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(3) } },
  });
  await monitor.startEnableScheduler({ reason: 'test' });
  await waitFor(() => clock.pending() >= 1, 20000, '挂起等待（07:00 已在窗口内，应立即处理；含真实开启+落地轮询耗时）');
  // 07:00 在窗口内：循环先处理今日开启再挂起等待 08:00
  await waitFor(() => monitor.actions.length >= 1 && monitor.actions[0].allEnabledConfirmed === true, 20000, "真实开启批次执行");
  await waitFor(() => (monitor.getStatus().shops[0].enablePhase || {}).status === 'success', 15000, '开启成功持久化');
  const sessionsAfterFirst = track.sessions;
  assert.ok(sessionsAfterFirst >= 1, '首轮真实开启应打开页面');
  // 窗口内重启（同一 dataDir）：success 记录 → 不重复
  const monitor2 = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn });
  const sessionsBefore2 = track.sessions;
  await monitor2.startEnableScheduler({ reason: 'restart' });
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(track.sessions, sessionsBefore2, '重启后当日已 success → 零新会话、零重复开启');
  monitor2.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('上线：两相位互斥——暂停周期进行中，开启相位请求被拒（不并发执行）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:00'));
  const { monitor } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(1) } },
  });
  monitor._cycleRunning = true; // 模拟暂停/其他周期占用互斥锁
  const r = await monitor._runEnablePhase(undefined, '2026-09-12');
  assert.strictEqual(r.skipped, true, '互斥期间开启相位必须跳过');
  monitor._cycleRunning = false;
});

test('上线修复（2026-09-16）：调度漂移——定时器额外延迟不累积；休眠时钟跳跃立即返回', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:50'));
  const { monitor } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    monitorChengfang: { enableSchedulerEnabled: true },
    fixture: { plans: { '全店托管': [], '商品自选': [] } },
  });
  // 直接测生产等待方法（不绕过）：_chunkedEnableDelay(ms, gen) 以实际墙钟重算剩余。
  // 场景 A：时钟跳跃（模拟电脑休眠后恢复）→ nowFn 越过目标 → 应立即返回。
  monitor.enableRunning = true;
  const t0 = Date.now();
  const jumpTimer = setTimeout(() => clock.advance(60 * 60 * 1000), 80); // 80ms 后时钟从 06:50 跳到 07:50
  await monitor._chunkedEnableDelay(10000, monitor._enableGen);
  clearTimeout(jumpTimer);
  const elapsedA = Date.now() - t0;
  assert.ok(elapsedA < 3000, `时钟跳跃后应立即返回（旧代码会等满名义 10s），实际 ${elapsedA}ms`);
  // 场景 B：enableRunning=false → 立即返回（停止语义）
  const t1 = Date.now();
  monitor.enableRunning = false;
  await monitor._chunkedEnableDelay(60000, monitor._enableGen);
  assert.ok(Date.now() - t1 < 500, '停止后应立即返回');
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('上线修复（2026-09-16）：暂停巡查延时同样以实际墙钟重算（_chunkedDelay 防漂移）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '06:50'));
  const { monitor } = await setupChengfangMonitor(t, {
    clock,
    execution: { realMode: false, dryRun: true },
    fixture: { plans: { '全店托管': [], '商品自选': [] } },
  });
  monitor.running = true;
  const t0 = Date.now();
  const jumpTimer = setTimeout(() => clock.advance(30 * 60 * 1000), 80);
  await monitor._chunkedDelay(20000, monitor._gen);
  clearTimeout(jumpTimer);
  assert.ok(Date.now() - t0 < 3000, `时钟跳跃后 _chunkedDelay 应立即返回，实际 ${Date.now() - t0}ms`);
  monitor.running = false;
});
