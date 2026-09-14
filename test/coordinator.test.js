'use strict';

/**
 * 隔离测试：全店关闭协调器（mock 三源读取器 + 有状态控制器，不访问真实页面）。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { WholeShopCloseCoordinator } = require('../src/engine/close-coordinator');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const NOON = () => shanghaiMs('2026-09-12', '09:00');
const IDENTITY = { id: 'shop-001', name: '测试店铺一' };

// 4 个广告（每页 2 条 → 2 页）：3 个投放中（含零消耗广告）、1 个已暂停
const ADS = [
  { adId: 'ad-1001', name: '广告甲', status: '投放中' },
  { adId: 'ad-1002', name: '零消耗广告', status: '投放中' },
  { adId: 'ad-1003', name: '广告丙', status: '投放中' },
  { adId: 'ad-1004', name: '已暂停广告', status: '已暂停' },
];

function setup(t, { costCents = 15001, orders = 100, ads = ADS, readerDef = {}, controllerOpts = {}, execution = {}, schedule = {}, nowFn = NOON } = {}) {
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({ cookieDir, execution: { realMode: true, ...execution }, schedule });
  const controller = makeStatefulController({ identity: IDENTITY, ads, ...controllerOpts });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page', ...readerDef }, nowFn);
  const audits = [];
  const coord = new WholeShopCloseCoordinator({
    reader, controller, config: cfgResult.config, now: nowFn,
    audit: (e) => audits.push(e),
  });
  return { coord, controller, reader, cfgResult, audits };
}

test('100.01 元 / 100 单：关闭全部投放中广告（含零消耗），已暂停的不动，清单分页读全', async (t) => {
  const { coord, controller } = setup(t, { costCents: 10001, orders: 100 });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'all_closed_confirmed', '全部目标回读确认才算全店已关闭');
  assert.strictEqual(r.inventoryPages, 2, '分页读全（每页2条×4广告）');
  assert.strictEqual(r.counts.confirmed, 3, '3 个投放中广告全部关闭');
  assert.deepStrictEqual(controller.state.closeCalls.map((c) => c.adId).sort(), ['ad-1001', 'ad-1002', 'ad-1003'], '零消耗广告也在目标内');
  const paused = await controller.getAd({ adId: 'ad-1004' });
  assert.strictEqual(paused.status, '已暂停', '已暂停广告未被触碰');
  assert.strictEqual(r.finalInventoryPages, 2, '终态回读也完整读取清单');
  assert.deepStrictEqual(r.remaining, { closableAdIds: [], unknownAdIds: [] });
});

// ── 终态回读（第三轮验收问题 3 回归）────────────────────────────
test('终态回读：执行期间新增/恢复投放的广告 → 不能误报"全店广告已关闭"', async (t) => {
  const { coord, controller } = setup(t, { costCents: 10001, orders: 100 });
  const origClose = controller.closeAd.bind(controller);
  let closes = 0;
  controller.closeAd = async (p) => {
    await origClose(p);
    closes += 1;
    if (closes === 2) {
      // 第二个广告关闭后，页面上新增了一个投放中广告（模拟新广告或被恢复投放）
      controller._testAddAd({ adId: 'ad-new-1', name: '新增广告', status: '投放中' });
    }
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.allClosedConfirmed, false, '终态回读发现仍投放中的广告，不得宣称全店已关闭');
  assert.deepStrictEqual(r.remaining.closableAdIds, ["ad-new-1"], "剩余对象已记录");
  assert.match(r.confirmReason, /仍处于投放侧.*ad-new-1/);
});

test('终态回读失败（分页/身份/日期核验不过）→ 不能宣称"全店广告已关闭"', async (t) => {
  const { coord } = setup(t, { costCents: 10001, orders: 100 });
  const origListAll = coord.listAllAds.bind(coord);
  let calls = 0;
  coord.listAllAds = async (...a) => {
    calls += 1;
    if (calls >= 2) throw new (require('../src/lib/errors').DataGuardError)('模拟终态回读分页失败');
    return origListAll(...a);
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.allClosedConfirmed, false);
  assert.match(r.confirmReason, /终态回读失败/);
  assert.strictEqual(r.finalInventoryPages, null);
});

test('100 元 / 100 单：恰好等于阈值 → 操作前重核取消关闭', async (t) => {
  const { coord, controller } = setup(t, { costCents: 10000, orders: 100 });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'cancelled');
  assert.match(r.reason, /不超标|取消/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('触发时超标、操作前重读已恢复到阈值内 → 取消关闭', async (t) => {
  // 首轮触发数据（由 monitor 侧产生）本例直接模拟"协调器重读时已恢复"：
  const { coord, controller, reader } = setup(t, { costCents: 8000, orders: 100 }); // 0.8 元/单
  assert.ok(reader.readCostSummaryCalls >= 0);
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'cancelled');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('全店订单为 0：重读核实仍为 0 → 阻止本轮关闭', async (t) => {
  const { coord, controller, reader } = setup(t, { costCents: 15001, orders: 0, readerDef: { ordersSequence: [0, 0] } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /订单为 0/);
  assert.ok(reader.readOrderSummaryCalls >= 2, '已重新读取核实');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('全店订单为 0：重读后恢复有效数据 → 继续正常判定', async (t) => {
  const { coord, reader } = setup(t, { costCents: 15001, orders: 0, readerDef: { ordersSequence: [0, 80] } });
  const data = await coord.readAndEvaluate({ id: 'shop-001', cookieFile: 'x' });
  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.evaluation.over, true, '15001 分 > 80×100=8000 分');
  assert.ok(reader.readOrderSummaryCalls >= 2);
});

test('跨店数据：费用来源店铺不匹配 → 零关闭', async (t) => {
  const { coord, controller } = setup(t, { readerDef: { costShopId: 'WRONG_SHOP' } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /身份不匹配/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('跨日数据：费用统计日期不是当天 → 不执行关闭', async (t) => {
  const { coord, controller } = setup(t, { readerDef: { costDate: '2026-09-11' } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /统计日期不是当天/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('费用与订单统计日期不一致 → 不执行关闭', async (t) => {
  const { coord, controller } = setup(t, { readerDef: { orderDate: '2026-09-11' } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /统计日期(不是当天|不一致)/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('过期数据：抓取时间超过上限 → 不执行关闭', async (t) => {
  const stale = new Date(NOON() - 60 * 60000).toISOString();
  const { coord, controller } = setup(t, { readerDef: { costFetchedAt: stale } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /已过期/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('清单不完整（超过分页上限仍有下一页）→ 不执行关闭', async (t) => {
  const { coord, controller } = setup(t, { readerDef: { forceHasNext: true }, execution: { maxAdPages: 5 } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /清单不完整|分页上限/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('部分失败：不能误报"全店广告已关闭"', async (t) => {
  const { coord } = setup(t, { controllerOpts: { failCloseFor: new Set(['ad-1002']) } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.counts.confirmed, 2);
  assert.strictEqual(r.counts.failed, 1);
  assert.strictEqual(r.allClosedConfirmed, false);
});

test('未知状态：不能计入成功，不能误报"全店广告已关闭"', async (t) => {
  // 真未知场景：关闭请求发出后回读一直失败（无法核实结果）
  const { coord } = setup(t, {});
  const { controller } = { controller: coord.controller };
  const origGetAd = controller.getAd.bind(controller);
  controller.getAd = async (p) => {
    if (controller.state.closeCalls.length >= 1) throw new Error('mock: 回读网络错误（持续）');
    return origGetAd(p);
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.counts.unknown, 1);
  assert.strictEqual(r.allClosedConfirmed, false);
});

test('显式未知且回读仍投放中：按最新状态判定为未生效并计入失败（不误报）', async (t) => {
  const { coord } = setup(t, { controllerOpts: { stuckFor: new Set(['ad-1003']) } });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.counts.failed, 1);
  assert.strictEqual(r.allClosedConfirmed, false);
});

test('07:59（窗口前）：真实执行被时间窗口阻止', async (t) => {
  const { coord, controller } = setup(t, { nowFn: () => shanghaiMs('2026-09-12', '07:59') });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked_window');
  assert.match(r.reason, /08:00/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('08:00 整：窗口允许执行', async (t) => {
  const { coord } = setup(t, { nowFn: () => shanghaiMs('2026-09-12', '08:00') });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'all_closed_confirmed');
});

test('停止令牌已置位：不执行关闭', async (t) => {
  const { coord, controller } = setup(t);
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: true } });
  assert.strictEqual(r.outcome, 'blocked_stopped');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('批次中途停止：剩余广告不再发出新请求，已完成的不受影响', async (t) => {
  const { coord, controller } = setup(t);
  const token = { aborted: false };
  const origClose = controller.closeAd.bind(controller);
  controller.closeAd = async (p) => {
    await origClose(p);
    token.aborted = true; // 第一个广告关闭后立即停止
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: token });
  assert.strictEqual(controller.state.closeCalls.length, 1, '停止后不再发出新的关闭请求');
  assert.strictEqual(r.counts.confirmed, 1);
  assert.strictEqual(r.counts.skipped, 2);
  assert.strictEqual(r.allClosedConfirmed, false);
  assert.match(r.confirmReason, /跳过未操作/);
});

// ── 跨午夜门槛时机（第三轮验收问题 1 回归）────────────────────────
test('回归：身份复核期间跨日 → 不发出关闭请求，不误报全店关闭', async (t) => {
  // 批次 23:59 开始；closeOneAd 内的身份复核（第二次 verifyIdentity 调用）时时钟跨到次日
  let fake = shanghaiMs('2026-09-12', '23:59');
  const nowFn = () => fake;
  const { coord, controller } = setup(t, { nowFn });
  let identityCalls = 0;
  const origIdentity = controller.verifyIdentity.bind(controller);
  controller.verifyIdentity = async (p) => {
    identityCalls += 1;
    if (identityCalls >= 2) fake += 60 * 1000; // 批次级身份核验后的单广告身份复核时跨日
    return origIdentity(p);
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 0, '跨日后不得发出任何关闭请求');
  assert.strictEqual(r.outcome, 'partial');
  assert.strictEqual(r.allClosedConfirmed, false);
  assert.strictEqual(r.counts.skipped >= 1, true, '目标广告被跳过并记录原因');
  assert.match(r.confirmReason || '', /跳过未操作|跨日/);
});

test('回归：对象读取期间跨日 → 不发出关闭请求（复现原始漏洞场景）', async (t) => {
  // 批次 23:59 开始；closeOneAd 的操作前对象读取（getAd）返回时时间已到次日 00:00
  let fake = shanghaiMs('2026-09-12', '23:59');
  const nowFn = () => fake;
  const { coord, controller } = setup(t, { nowFn });
  let getAdCalls = 0;
  const origGetAd = controller.getAd.bind(controller);
  controller.getAd = async (p) => {
    getAdCalls += 1;
    if (getAdCalls >= 1 && fake < shanghaiMs('2026-09-13', '00:00')) {
      fake = shanghaiMs('2026-09-13', '00:00'); // getAd 返回时模拟时间跨到次日
    }
    return origGetAd(p);
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 0, '原始漏洞场景：跨日后仍发出关闭请求 — 已修复');
  assert.strictEqual(r.allClosedConfirmed, false);
  assert.strictEqual(r.counts.skipped, 3);
  assert.match(r.confirmReason || '', /跨日|跳过/);
});

test('回归：重试等待期间跨日 → 第二次尝试不发新请求', async (t) => {
  // 广告 ad-1002 关闭"未生效"（结果未知但回读仍投放中），进入重试；
  // closeAd 首次调用时把时钟推到次日 → 重试前的门槛检查必须拦截
  let fake = shanghaiMs('2026-09-12', '23:59');
  const nowFn = () => fake;
  const { coord, controller } = setup(t, {
    nowFn,
    ads: [
      { adId: 'ad-1001', name: '广告甲', status: '投放中' },
      { adId: 'ad-1002', name: '广告乙', status: '投放中' },
    ],
    controllerOpts: { stuckFor: new Set(['ad-1001']) },
  });
  const origClose = controller.closeAd.bind(controller);
  let closeAttempts = 0;
  controller.closeAd = async (p) => {
    closeAttempts += 1;
    if (closeAttempts === 1) fake = shanghaiMs('2026-09-13', '00:00'); // 首次请求后跨日
    return origClose(p);
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(closeAttempts, 1, '重试等待期间跨日：不得发出第二个关闭请求');
  assert.strictEqual(r.counts.failed + r.counts.skipped, 2, '未生效的记失败/跳过，剩余跳过');
  assert.strictEqual(r.allClosedConfirmed, false);
});

test('跨日中止：批次执行中跨到次日 → 剩余广告不操作', async (t) => {
  const cookieDir = makeTempDir('pg-cookies-');
  t.after(() => fs.rmSync(cookieDir, { recursive: true, force: true }));
  writeTempCookie(cookieDir, '测试店铺一');
  let fake = shanghaiMs('2026-09-12', '09:00');
  const nowFn = () => fake;
  const controller = makeStatefulController({ identity: IDENTITY, ads: ADS });
  const reader = makeLinkedReader(controller, { costCents: 15001, orders: 100, pageSource: 'promo-page' }, nowFn);
  const coord = new WholeShopCloseCoordinator({
    reader, controller, config: makeCfgResult({ cookieDir, execution: { realMode: true } }).config,
    now: nowFn, audit: () => {},
  });
  let closeCount = 0;
  const origClose = controller.closeAd.bind(controller);
  controller.closeAd = async (p) => {
    await origClose(p);
    closeCount += 1;
    if (closeCount === 1) fake += 16 * 60 * 60 * 1000; // 第一个广告关闭后时钟跳到次日
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 1, '跨日后剩余广告未操作');
  assert.strictEqual(r.counts.skipped, 2);
  assert.strictEqual(r.allClosedConfirmed, false);
});

// ── 第五轮：覆盖表与开关语义 ─────────────────────────────────────
test('覆盖缺口（乘方未接入等）→ 阻止"全店"结论，零关闭', async (t) => {
  const { coord, reader, controller } = setup(t, { costCents: 10001, orders: 100 });
  const origList = reader.listAdPage.bind(reader);
  reader.listAdPage = async (p) => ({
    ...(await origList(p)),
    coverage: [
      { type: 'overall', entry: '乘方', total: null, rowsRead: 0, complete: false, note: '当天消耗14.98但控制对象未定位' },
      { type: 'uni_promotion', entry: '全域投放', total: 2, rowsRead: 2, complete: true },
    ],
    coverageGaps: [{ type: 'overall', reason: '类型「乘方」本次未接入读取：费用分项包含该类型，其开启状态未知' }],
    listComplete: false,
  });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked_coverage', '不得把"全域投放全部计划"当作"账户全部广告"');
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.match(r.reason, /覆盖范围不完整/);
  assert.match(r.reason, /乘方/);
});

test('开关语义：状态词"投放中"但开关未开启 → 已在关闭侧，不进目标；"审核中"但开关开启 → 进目标', async (t) => {
  const { coord, controller } = setup(t, {
    costCents: 10001, orders: 100,
    ads: [
      { adId: 'ad-1', name: '矛盾态（状态投放中但开关关）', status: '投放中', switchChecked: false },
      { adId: 'ad-2', name: '审核中但开关开启', status: '审核中', switchChecked: true },
      { adId: 'ad-3', name: '零消耗但开关开启', status: '投放中', switchChecked: true },
    ],
  });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.deepStrictEqual(controller.state.closeCalls.map((c) => c.adId).sort(), ['ad-2', 'ad-3'], '目标以开关证据为准（含零消耗/审核中）');
  assert.strictEqual(r.targets, 2);
  assert.strictEqual(r.allClosedConfirmed, true);
});

test('开关/状态侧别未知 → 阻止"全店"结论（不得当作已关闭，也不得漏掉）', async (t) => {
  const { coord, controller } = setup(t, {
    costCents: 10001, orders: 100,
    ads: [
      { adId: 'ad-1', name: '神秘对象', status: '神秘状态' },
      { adId: 'ad-2', name: '正常暂停', status: '已暂停', switchChecked: false },
    ],
  });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'blocked_coverage');
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.match(r.reason, /无法确认侧别/);
});

// ── 第六轮：逐页完整性校验与快照语义 ─────────────────────────────
test('后续页完整性声明与首页不一致 → 拒绝（真实源不得默认完整）', async (t) => {
  const { coord, controller, reader } = setup(t, { costCents: 10001, orders: 100 });
  const origList = reader.listAdPage.bind(reader);
  reader.listAdPage = async (p) => {
    const page = await origList(p);
    if (p.pageNo >= 2) return { ...page, listComplete: false, coverageGaps: [{ type: 'x', reason: '后续页缺口' }] };
    return page;
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.strictEqual(r.outcome, 'blocked');
  assert.match(r.reason, /不一致|不完整/);
});

test('后续页缺失完整性声明（真实源）→ 拒绝（不默认视为完整）', async (t) => {
  const { coord, controller, reader } = setup(t, { costCents: 10001, orders: 100 });
  const origList = reader.listAdPage.bind(reader);
  reader.listAdPage = async (p) => {
    const page = await origList(p);
    if (p.pageNo >= 2) return { ...page, listComplete: undefined, coverageGaps: [] };
    return page;
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.match(r.reason, /未显式声明完整性|不完整/);
});

test('清单扫描期间跨日 → 拒绝（快照口径混杂两个日期）', async (t) => {
  const { coord, controller, reader } = setup(t, { costCents: 10001, orders: 100 });
  const origList = reader.listAdPage.bind(reader);
  reader.listAdPage = async (p) => {
    const page = await origList(p);
    return { ...page, crossDayScan: true, scanDates: '2026-09-13 → 2026-09-14' };
  };
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: { id: 'shop-001', cookieFile: 'x' }, cycleToken: { aborted: false } });
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.match(r.reason, /跨日/);
});
