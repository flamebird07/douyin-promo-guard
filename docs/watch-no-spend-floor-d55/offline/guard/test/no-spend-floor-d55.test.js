'use strict';

/**
 * D55（2026-10-30）：取消推广值守 50 元消耗门槛——只要费比严格超标就进入原暂停链。
 *
 * 本文件分两层：
 * 1) 真实 rules + decision 纯断言：1 分 0 单、21 分 1 单阈值 20、5 元内/恰好 50/50.01、
 *    严格等于/低于、0 费用 0 单、非法/错身份/unknown 零动作；
 * 2) 真实 Monitor.pollOnce 主链（假 Cookie 目录 + 假 reader/controller + 假乘方会话 + 假时钟，
 *    复用 D53 假依赖形态）：低消耗严格超标真实打开原暂停会话并点击，零开启，保留每日开启
 *    停用状态；原每日首查门禁与未知动作串行保护不得被放宽。
 *
 * 全部为本地假依赖；不启动服务、不打开浏览器、不访问生产、不发飞书。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { evaluateWholeShopCostPerOrder, SPEND_FLOOR_CENTS } = require('../src/engine/rules.js');
const { decideAdSwitchAction, DECISION, METRIC } = require('../src/engine/ad-switch-decision.js');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController } = require('./helpers.js');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time.js');

// ── 1) 规则/决策层 ────────────────────────────────────────────────

test('D55-rules：无消耗门槛，任意正费用严格超标即 pauseEligible', () => {
  assert.strictEqual(SPEND_FLOOR_CENTS, 0);

  const oneCentZeroOrders = evaluateWholeShopCostPerOrder({ costCents: 1, orders: 0, thresholdCents: 100 });
  assert.strictEqual(oneCentZeroOrders.over, true);
  assert.strictEqual(oneCentZeroOrders.pauseEligible, true);
  assert.strictEqual(oneCentZeroOrders.roiTooLow, true);
  assert.strictEqual(oneCentZeroOrders.spendProtected, false);
  assert.strictEqual(oneCentZeroOrders.spendFloorCents, 0);

  const low = evaluateWholeShopCostPerOrder({ costCents: 21, orders: 1, thresholdCents: 20 });
  assert.strictEqual(low.over, true);
  assert.strictEqual(low.pauseEligible, true);

  const under50 = evaluateWholeShopCostPerOrder({ costCents: 4000, orders: 10, thresholdCents: 100 });
  assert.strictEqual(under50.over, true);
  assert.strictEqual(under50.pauseEligible, true);

  const exactly50 = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 1, thresholdCents: 100 });
  assert.strictEqual(exactly50.over, true);
  assert.strictEqual(exactly50.pauseEligible, true);

  const justOver50 = evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 1, thresholdCents: 100 });
  assert.strictEqual(justOver50.pauseEligible, true);
});

test('D55-rules：严格等于/低于不触发；0 费用 0 单不触发；非法输入抛错', () => {
  const equal = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 50, thresholdCents: 100 });
  assert.strictEqual(equal.over, false);
  assert.strictEqual(equal.pauseEligible, false);

  const below = evaluateWholeShopCostPerOrder({ costCents: 4999, orders: 50, thresholdCents: 100 });
  assert.strictEqual(below.over, false);
  assert.strictEqual(below.pauseEligible, false);

  const zero = evaluateWholeShopCostPerOrder({ costCents: 0, orders: 0, thresholdCents: 100 });
  assert.strictEqual(zero.over, false);
  assert.strictEqual(zero.pauseEligible, false);
  assert.strictEqual(zero.roiTooLow, false);

  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: null, orders: 1, thresholdCents: 100 }));
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 1, orders: -1, thresholdCents: 100 }));
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 1, orders: 1, thresholdCents: 0 }));
});

test('D55-decision：低消耗超标进入 should_pause；等于阈值/低于阈值语义不变', () => {
  const oneCentZeroOrders = decideAdSwitchAction({
    costCents: 1, orders: 0, thresholdCents: 100, currentAdState: 'on', identityOk: true,
  });
  assert.strictEqual(oneCentZeroOrders.metric, METRIC.ABOVE);
  assert.strictEqual(oneCentZeroOrders.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(oneCentZeroOrders.action, 'pause');
  assert.strictEqual(oneCentZeroOrders.zeroClick, false);
  assert.strictEqual(oneCentZeroOrders.pauseEligible, true);
  assert.strictEqual(oneCentZeroOrders.spendProtected, false);

  const low = decideAdSwitchAction({
    costCents: 21, orders: 1, thresholdCents: 20, currentAdState: 'on', identityOk: true,
  });
  assert.strictEqual(low.decision, DECISION.SHOULD_PAUSE);

  const lowOff = decideAdSwitchAction({
    costCents: 21, orders: 1, thresholdCents: 20, currentAdState: 'off', identityOk: true,
  });
  assert.strictEqual(lowOff.decision, DECISION.ALREADY_OFF);
  assert.strictEqual(lowOff.zeroClick, true);

  const equal = decideAdSwitchAction({
    costCents: 5000, orders: 50, thresholdCents: 100, currentAdState: 'on', identityOk: true,
  });
  assert.strictEqual(equal.metric, METRIC.EQUAL);
  assert.strictEqual(equal.decision, DECISION.EQUAL_NO_ACTION);

  const below = decideAdSwitchAction({
    costCents: 4999, orders: 50, thresholdCents: 100, currentAdState: 'off', identityOk: true,
  });
  assert.strictEqual(below.metric, METRIC.BELOW);
  assert.strictEqual(below.decision, DECISION.SHOULD_ENABLE);

  const zero = decideAdSwitchAction({
    costCents: 0, orders: 0, thresholdCents: 100, currentAdState: 'on', identityOk: true,
  });
  assert.strictEqual(zero.metric, METRIC.EQUAL);
  assert.strictEqual(zero.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(zero.zeroClick, true);
});

test('D55-decision：非法/错身份/unknown 仍 fail-closed 零动作', () => {
  const base = { costCents: 1, orders: 0, thresholdCents: 100, currentAdState: 'on', identityOk: true };
  assert.strictEqual(decideAdSwitchAction({ ...base, costCents: null }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(decideAdSwitchAction({ ...base, orders: -1 }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(decideAdSwitchAction({ ...base, dataError: 'parse' }).decision, DECISION.DATA_BLOCKED);
  for (const identityOk of [undefined, null, false, 'true', 1]) {
    const r = decideAdSwitchAction({ ...base, identityOk });
    assert.strictEqual(r.decision, DECISION.DATA_BLOCKED);
    assert.strictEqual(r.zeroClick, true);
  }
  const unknown = decideAdSwitchAction({ ...base, currentAdState: 'unknown' });
  assert.strictEqual(unknown.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(unknown.zeroClick, true);
});

// ── 2) 真实 Monitor.pollOnce 主链（假依赖，复用 D53 形态）───────────

const ACCOUNT_ID = '1710242295996424';
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: ACCOUNT_ID, enabled: true };
const DAY = '2026-10-30';

function makeFakeChengfang(opts = {}) {
  const landingConfirmed = opts.landingConfirmed !== false;
  const plans = {
    '全店托管': [{ id: '184388555253250562', checked: true }],
    '商品自选': [],
  };
  const counters = { sessions: 0, closes: 0, pauseClicks: 0, enableClicks: 0, rowReads: 0 };
  const controller = {
    async verifyIdentity() {
      return { ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID };
    },
    async switchView() { return { clicked: true }; },
    async switchPageSize() { return { clicked: true }; },
    async ensureFirstPage() { return { clicked: false }; },
    async clickNextPage() { return { clicked: false, reason: 'fake: 单页' }; },
    async refreshView() { return { ok: true }; },
    async detectDanger() { return []; },
    async readView({ tab }) {
      const list = plans[tab] || [];
      counters.rowReads += 1;
      return {
        tab,
        rows: { rows: list.map((p) => ({ id: p.id, switchChecked: p.checked === true })), total: list.length },
        pagination: { total: list.length, pageSize: '100条/页', activePage: 1, hasNext: false },
      };
    },
    async selectAllInPage() { return { clicked: true }; },
    async readSelection({ tab }) {
      const list = plans[tab || '商品自选'] || [];
      const selectedIds = list.map((p) => String(p.id));
      return { selectedIds, selectedCount: selectedIds.length };
    },
    async readBatchBar() { return { visible: true, selectedCount: 1, buttons: ['开启', '暂停', '删除'] }; },
    async setRowCheckbox() { return { ok: true }; },
    async clickRowSwitch({ planId, expectAction }) {
      if (expectAction === 'shop_enable') { counters.enableClicks += 1; throw new Error('fake: 暂停巡查不得发出开启'); }
      if (expectAction !== 'shop_disable') throw new Error(`fake: 非预期行内动作 ${expectAction}`);
      counters.pauseClicks += 1;
      const p = plans['全店托管'].find((x) => x.id === planId);
      if (p && landingConfirmed) p.checked = false;
      return { clicked: true };
    },
    async clickBatchPause() {
      counters.pauseClicks += 1;
      if (landingConfirmed) for (const p of plans['商品自选']) p.checked = false;
      return { clicked: true };
    },
    async clickBatchEnable() { counters.enableClicks += 1; throw new Error('fake: 暂停巡查不得发出批量开启'); },
  };
  const page = { url: () => 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=' + ACCOUNT_ID };
  const opener = async () => {
    counters.sessions += 1;
    return { page, controller, close: async () => { counters.closes += 1; } };
  };
  return { opener, controller, plans, counters };
}

function makeClock(startMs) {
  let now = startMs;
  const gates = [];
  return {
    nowFn: () => now,
    delayFn: (ms) => new Promise((res) => gates.push({ ms, res })),
    pending: () => gates.length,
    wake: (advanceMs) => { now += advanceMs; for (const g of gates.splice(0)) g.res(); },
  };
}

async function setup({ clock, costCents, orders, enableSchedulerEnabled = true, chengfang }) {
  const cookieDir = makeTempDir('d55-ck-');
  const dataDir = makeTempDir('d55-data-');
  writeTempCookie(cookieDir, '测试店铺一');

  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    thresholdCents: 100,
    execution: {
      realMode: true, dryRun: false, maxRetries: 1, retryBackoffMs: 1,
      closeTimeoutMs: 200, readbackTimeoutMs: 200, readbackAttempts: 2, readbackIntervalMs: 1,
      zeroOrderRecheck: 1, maxAdPages: 50,
    },
    schedule: { dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' },
    monitor: {
      snapshotMaxAgeMinutes: 30, mockDataSource: false,
      chengfang: {
        scope: ['全店托管', '商品自选'],
        pauseEnabled: true,
        enableEnabled: true,
        enableSchedulerEnabled,
      },
    },
  });

  const controller = makeStatefulController({ identity: { id: SHOP.id, name: SHOP.name, accountId: ACCOUNT_ID }, ads: [] });
  const reader = makeLinkedReader(
    controller,
    { costCents, orders, pageSource: 'promo-page', costAccountId: ACCOUNT_ID },
    clock.nowFn
  );

  const fake = makeFakeChengfang(chengfang);
  const stateCalls = [];
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
    chengfangOpener: fake.opener,
    readAdState: async (shopId) => { stateCalls.push(shopId); return { state: 'on' }; },
  });

  const cleanup = () => {
    try { monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' }); } catch (_) {}
    try { monitor.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { monitor, fake, cleanup, stateCalls };
}

const at0800 = shanghaiMs(DAY, '08:00');

test('D55-monitor：低消耗严格超标真实进入原暂停链（零开启、每日开启停用保持）', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 4000, orders: 10 });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd55-test' });
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '前置：每日开启已独立停用');

    const r = await s.monitor.pollOnce('d55');
    const one = r.results[0];
    assert.equal(one.decision, DECISION.SHOULD_PAUSE, `低消耗超标必须 should_pause，实际 ${JSON.stringify(one)}`);
    assert.equal(one.zeroClick, false, '低消耗超标不得是零动作');
    assert.ok(s.stateCalls.length >= 1, '必须真实回读当前广告状态');
    assert.ok(s.fake.counters.sessions >= 1, '必须打开原乘方暂停会话');
    assert.ok(s.fake.counters.pauseClicks >= 1, '必须发出暂停点击');
    assert.equal(s.fake.counters.enableClicks, 0, '不得发出任何开启');
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '每日开启停用标记必须保持');
    assert.equal(s.monitor.enableRunning, false, '每日开启调度器保持未运行');

    const j = s.monitor.judgements[s.monitor.judgements.length - 1];
    assert.equal(j.spendProtected, false, '兼容字段如实表达无保护');
    assert.equal(j.spendFloorCents, 0);
    assert.equal(j.pauseEligible, true);
    assert.doesNotMatch(String(j.reason || ''), /50\s*元/);
    assert.equal(s.monitor.getStatus().shops[0].roiTooLow, true);
  } finally { s.cleanup(); }
});

test('D55-monitor：原每日首查门禁保留——启用每日开启且当日无首查仍 window_blocked 零动作', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 4000, orders: 10, enableSchedulerEnabled: true });
  try {
    assert.equal(s.monitor.enableSchedulerShouldRun(), true, '前置：每日开启配置为可运行');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY), undefined, '前置：当日无首查记录');
    const r = await s.monitor.pollOnce('d55-gate');
    const one = r.results[0];
    assert.equal(one.status, 'window_blocked', `首查未完成仍必须被门禁拦下，实际 ${JSON.stringify(one)}`);
    assert.match(String(one.reason || ''), /首次开启检查未完成/);
    assert.equal(s.fake.counters.sessions, 0, '门禁零会话');
    assert.equal(s.fake.counters.pauseClicks, 0, '门禁零暂停');
    assert.equal(s.fake.counters.enableClicks, 0, '门禁零开启');
  } finally { s.cleanup(); }
});

test('D55-monitor：未知动作串行保护保留——暂停回读未确认时下一轮不重发', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 4000, orders: 10, chengfang: { landingConfirmed: false } });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd55-test' });
    const r1 = await s.monitor.pollOnce('d55-r1');
    assert.notEqual(r1.results[0].status, 'window_blocked', '首轮应真实执行暂停');
    const clicksAfter1 = s.fake.counters.pauseClicks;
    assert.ok(clicksAfter1 >= 1, '首轮应已发出暂停请求');
    assert.equal(s.monitor._switchOrchestrator.hasUnknownBlock(SHOP.id), true, '前置：回读未确认留下未知动作门');

    const r2 = await s.monitor.pollOnce('d55-r2');
    assert.notEqual(r2.results[0].status, 'window_blocked', '第二轮仍应走费用判定（不被首查门禁拦下）');
    assert.equal(s.monitor._switchOrchestrator.hasUnknownBlock(SHOP.id), true, '未知动作门不得被费用读数清除');
    assert.equal(s.fake.counters.pauseClicks, clicksAfter1, '存在未收口未知动作时不得重发暂停');
    assert.equal(s.fake.counters.enableClicks, 0, '未知动作期间不得反向开启');
  } finally { s.cleanup(); }
});
