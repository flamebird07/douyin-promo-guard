'use strict';

/**
 * 消耗门槛专项（文件名 spend-floor-100 为历史命名；D55 2026-10-30 已取消 50 元门槛）。
 *
 * 现行业务合同：
 * - 无最低消耗门槛：只要费比严格超标（费用分 > 订单数×阈值分）即具备暂停资格；
 * - 低消耗（如 1 分/0 单、21 分/1 单阈值 20）与高消耗同一公式；
 * - 费比恰好等于仍不是「超标」，零动作；0 费用 + 0 单不触发；
 * - 0 订单 / null / 坏数据 / 身份未知 / 跨日仍按既有守卫 fail-closed 或走同一公式；
 * - 操作前 fresh recheck 仍需按最新读数重判（费用回落到等于阈值即取消）；
 * - 兼容字段 spendFloorCents=0、spendProtected=false，如实表达无门槛。
 *
 * 边界：全部 mock + 临时目录 + 固定时钟；不启动服务、不打开浏览器、不访问生产、不发飞书。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const {
  evaluateWholeShopCostPerOrder, SPEND_FLOOR_CENTS, perOrderDisplayText,
} = require('../src/engine/rules');
const { decideAdSwitchAction, DECISION, METRIC } = require('../src/engine/ad-switch-decision');
const { WholeShopCloseCoordinator } = require('../src/engine/close-coordinator');
const { ChengfangRunner } = require('../src/engine/chengfang-runner');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController,
} = require('./helpers');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time');

const NOW = shanghaiMs('2026-10-17', '12:00');
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: null, enabled: true };
const IDENTITY = { id: 'shop-001', name: '测试店铺一', accountId: null };

// 三档消耗 × 高/等/低费比的可整除 fixture（全部整数分）
const FIXTURES = [
  { cost: 4999, high: { orders: 1, thr: 100 }, equal: { orders: 1, thr: 4999 }, low: { orders: 1000, thr: 100 } },
  { cost: 5000, high: { orders: 1, thr: 100 }, equal: { orders: 50, thr: 100 }, low: { orders: 1000, thr: 100 } },
  { cost: 5001, high: { orders: 1, thr: 100 }, equal: { orders: 5001, thr: 1 }, low: { orders: 1000, thr: 100 } },
];

// ── 规则层：原始 over 语义 + 50 元门槛 ─────────────────────────────

test('规则：4999/5000/5001 × 高/等/低费比，无消耗门槛且严格超标即可暂停', () => {
  assert.strictEqual(SPEND_FLOOR_CENTS, 0);
  for (const f of FIXTURES) {
    const high = evaluateWholeShopCostPerOrder({ costCents: f.cost, orders: f.high.orders, thresholdCents: f.high.thr });
    const eq = evaluateWholeShopCostPerOrder({ costCents: f.cost, orders: f.equal.orders, thresholdCents: f.equal.thr });
    const low = evaluateWholeShopCostPerOrder({ costCents: f.cost, orders: f.low.orders, thresholdCents: f.low.thr });

    assert.strictEqual(high.over, true, `cost ${f.cost} high`);
    assert.strictEqual(eq.over, false, `cost ${f.cost} equal`);
    assert.strictEqual(low.over, false, `cost ${f.cost} low`);

    for (const r of [high, eq, low]) {
      assert.strictEqual(r.spendProtected, false, `spendProtected cost ${f.cost}`);
      assert.strictEqual(r.spendFloorCents, 0);
    }
    assert.strictEqual(high.pauseEligible, true, `pauseEligible cost ${f.cost}`);
    assert.strictEqual(high.roiTooLow, true, `roiTooLow cost ${f.cost}`);
    assert.strictEqual(eq.pauseEligible, false);
    assert.strictEqual(low.roiTooLow, false);
  }
});

test('规则：0 订单 / null / 坏数据仍 fail-closed，且不产生 ROI 提示', () => {
  const zero = evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 0, thresholdCents: 100 });
  assert.strictEqual(zero.over, false);
  assert.strictEqual(zero.blocked, 'zero_orders');
  assert.strictEqual(zero.roiTooLow, false);
  assert.strictEqual(zero.pauseEligible, false);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: null, orders: 1, thresholdCents: 100 }));
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 5001, orders: null, thresholdCents: 100 }));
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 1, thresholdCents: 0 }));
});

// ── 决策层：3 档消耗 × 3 种费比 × 3 种当前状态 ────────────────────
test('决策矩阵：无消耗门槛——任何消耗严格超标即 pause/warn，等于阈值仍零动作', () => {
  for (const f of FIXTURES) {
    for (const kind of ['high', 'equal', 'low']) {
      const metric = kind === 'high' ? METRIC.ABOVE : (kind === 'equal' ? METRIC.EQUAL : METRIC.BELOW);
      const m = f[kind];
      for (const st of ['on', 'off', 'mixed']) {
        const r = decideAdSwitchAction({
          costCents: f.cost, orders: m.orders, thresholdCents: m.thr,
          currentAdState: st, identityOk: true,
        });
        const tag = `${f.cost}/${kind}/${st}`;
        assert.strictEqual(r.metric, metric, tag);
        assert.strictEqual(r.spendProtected, false, tag);

        if (metric === METRIC.BELOW) {
          const expect = st === 'on' ? DECISION.ALREADY_ON : DECISION.SHOULD_ENABLE;
          assert.strictEqual(r.decision, expect, tag);
          assert.strictEqual(r.roiTooLow, false, tag);
          continue;
        }
        if (metric === METRIC.EQUAL) {
          if (st === 'mixed') {
            // 既有「等费比 mixed 统一暂停」策略保留（不再被消耗门槛阻挡）；严格相等不提示 ROI 过低
            assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE, tag);
            assert.strictEqual(r.zeroClick, false, tag);
            assert.strictEqual(r.action, 'pause', tag);
          } else {
            assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION, tag);
            assert.strictEqual(r.zeroClick, true, tag);
            assert.strictEqual(r.action, null, tag);
          }
          assert.strictEqual(r.pauseEligible, false, tag);
          assert.strictEqual(r.roiTooLow, false, tag);
          continue;
        }
        // above：任何消耗（含 4999/5000）都已具备暂停资格
        assert.strictEqual(r.pauseEligible, true, tag);
        assert.strictEqual(r.roiTooLow, true, tag);
        assert.strictEqual(r.decision, st === 'off' ? DECISION.ALREADY_OFF : DECISION.SHOULD_PAUSE, tag);
        if (st === 'off') {
          assert.strictEqual(r.zeroClick, true, tag);
          assert.strictEqual(r.action, null, tag);
        } else {
          assert.strictEqual(r.zeroClick, false, tag);
          assert.strictEqual(r.action, 'pause', tag);
        }
      }
    }
  }
});

test('决策：任意消耗严格超标即暂停；恰好等于阈值仍非超标', () => {
  const lowOver = decideAdSwitchAction({ costCents: 21, orders: 1, thresholdCents: 20, currentAdState: 'on', identityOk: true });
  assert.strictEqual(lowOver.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(lowOver.roiTooLow, true);

  const midOver = decideAdSwitchAction({ costCents: 5000, orders: 1, thresholdCents: 100, currentAdState: 'on', identityOk: true });
  assert.strictEqual(midOver.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(midOver.roiTooLow, true);

  const justOver = decideAdSwitchAction({ costCents: 5001, orders: 1, thresholdCents: 100, currentAdState: 'on', identityOk: true });
  assert.strictEqual(justOver.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(justOver.roiTooLow, true);

  const equal = decideAdSwitchAction({ costCents: 5000, orders: 50, thresholdCents: 100, currentAdState: 'on', identityOk: true });
  assert.strictEqual(equal.metric, METRIC.EQUAL);
  assert.strictEqual(equal.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(equal.zeroClick, true);
  assert.strictEqual(equal.roiTooLow, false);
});

test('决策：0 订单/null/坏数据/身份未知/跨日口径之外的 fail-closed 均零动作且无提示', () => {
  const base = { costCents: 5001, orders: 50, thresholdCents: 100, currentAdState: 'on', identityOk: true };
  assert.strictEqual(decideAdSwitchAction({ ...base, orders: 0 }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(decideAdSwitchAction({ ...base, costCents: null }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(decideAdSwitchAction({ ...base, orders: null }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(decideAdSwitchAction({ ...base, dataError: 'parse' }).decision, DECISION.DATA_BLOCKED);
  for (const identityOk of [undefined, null, false, 'true', 1]) {
    const r = decideAdSwitchAction({ ...base, identityOk });
    assert.strictEqual(r.decision, DECISION.DATA_BLOCKED);
    assert.strictEqual(r.zeroClick, true);
    assert.strictEqual(r.roiTooLow, false);
  }
  const unknown = decideAdSwitchAction({ ...base, currentAdState: 'unknown' });
  assert.strictEqual(unknown.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(unknown.zeroClick, true);
  assert.strictEqual(unknown.roiTooLow, false);
});

test('决策结果携带费用/订单/阈值/原因，供既有 judgement 日志直接消费', () => {
  const r = decideAdSwitchAction({ costCents: 5001, orders: 50, thresholdCents: 100, currentAdState: 'on', identityOk: true });
  assert.strictEqual(r.costCents, 5001);
  assert.strictEqual(r.orders, 50);
  assert.strictEqual(r.thresholdCents, 100);
  assert.strictEqual(r.expectedCents, 5000);
  assert.strictEqual(r.spendFloorCents, 0);
  assert.match(r.reason, /无消耗门槛|暂停资格/);
  assert.doesNotMatch(r.reason, /50\s*元/);
  assert.match(perOrderDisplayText(5001, 50), /1\.0002/);
});

// ── 操作前 fresh recheck：5001 → 5000 阻止 pause ──────────────────
function setupCoordinator({ costCents = 5001, orders = 50, ads = [] } = {}) {
  const cookieDir = makeTempDir('sf-ck-');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    thresholdCents: 100,
    execution: { realMode: true, dryRun: false },
    schedule: { dailyStartHour: 8 },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true } },
  });
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: ads.length ? ads : [{ adId: 'a1', name: '广告1', status: '投放中', switchChecked: true }],
  });
  const def = { costCents, orders, pageSource: 'promo-page' };
  const reader = makeLinkedReader(controller, def, () => NOW);
  const coord = new WholeShopCloseCoordinator({
    reader, controller, config: cfgResult.config, now: () => NOW, audit: () => {},
  });
  return { coord, controller, reader, def, cfgResult, cookieDir };
}

test('legacy 协调器 fresh recheck：5001 已排队 → 重核回落到等于阈值 5000 必须取消，零 pause', async (t) => {
  const { coord, controller, def, cookieDir } = setupCoordinator({ costCents: 5001, orders: 50 });
  t.after(() => fs.rmSync(cookieDir, { recursive: true, force: true }));

  const first = await coord.readAndEvaluate(SHOP);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.evaluation.over, true);
  assert.strictEqual(first.evaluation.pauseEligible, true);

  def.costCents = 5000; // 真正操作前重核：退回等于阈值（50 单 × 100 分）
  const res = await coord.executeWholeShopCloseBatch({
    shopCfg: SHOP,
    cycleToken: { aborted: false },
    todayStatus: new Map(),
    trigger: { reason: '旧决策已排队（5001）' },
  });
  assert.strictEqual(res.outcome, 'cancelled');
  assert.match(res.reason, /取消|作废/);
  assert.strictEqual(res.counts.cancelled, 1);
  assert.strictEqual(controller.state.closeCalls.length, 0, '退回 50 元必须零关闭');
});

test('乘方 runner fresh recheck：等于阈值时必须取消，连页面都不打开', async (t) => {
  const { coord, cfgResult, cookieDir } = setupCoordinator({ costCents: 5000, orders: 50 });
  t.after(() => fs.rmSync(cookieDir, { recursive: true, force: true }));

  const runner = new ChengfangRunner({
    coordinator: coord, config: cfgResult.config, now: () => NOW, audit: () => {},
  });
  let opened = 0;
  const res = await runner.executeChengfangBatch({
    shopCfg: SHOP,
    cycleToken: { aborted: false },
    trigger: { reason: '旧决策已排队（5001）' },
    pageOpener: async () => { opened += 1; throw new Error('不应打开页面'); },
    loginCfg: {},
  });
  assert.strictEqual(res.outcome, 'cancelled');
  assert.match(res.reason, /取消|作废/);
  assert.strictEqual(res.counts.cancelled, 1);
  assert.strictEqual(opened, 0, '取消必须发生在打开乘方页面之前');
});

// ── Monitor：判定日志、多店隔离、already_off 提示但零额外 pause ──────
function makeMonitorFixture(t, { shops, costByShop, ordersByShop, stateByShop, businessDate = shanghaiDate(NOW) }) {
  const cookieDir = makeTempDir('sf-mon-ck-');
  const dataDir = makeTempDir('sf-mon-data-');
  t.after(() => {
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile);
  const cfgResult = makeCfgResult({
    cookieDir,
    shops,
    thresholdCents: 100,
    execution: { realMode: false, dryRun: true, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    schedule: { dailyStartHour: 8 },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true } },
  });
  const pauseCalls = {};
  for (const s of shops) pauseCalls[s.id] = 0;
  const reader = {
    connected: false,
    async readCostSummary({ shopCfg }) {
      return {
        source: 'promo-page', kind: 'cost', shopId: shopCfg.id, accountId: null,
        businessDate, fetchedAt: new Date(NOW).toISOString(),
        valueCents: costByShop[shopCfg.id],
      };
    },
    async readOrderSummary({ shopCfg }) {
      return {
        source: 'promo-page', kind: 'orders', shopId: shopCfg.id, accountId: null,
        businessDate, fetchedAt: new Date(NOW).toISOString(),
        valueCount: ordersByShop[shopCfg.id],
      };
    },
    async listAdPage() { throw new Error('本专项使用注入 readAdState，不应读取清单'); },
  };
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: () => NOW,
    readAdState: async (shopCfg) => stateByShop[shopCfg.id] || 'on',
  });
  // 隔离：构造器会按临时 Cookie 目录自动发现同名店铺；本专项只验证显式配置的两家店。
  mon.config.shops = shops.slice();
  mon._pollChengfangOver = async (shopCfg) => {
    pauseCalls[shopCfg.id] += 1;
    return {
      status: 'ok', dryRun: true, over: true,
      batch: {
        actionType: 'pause', outcome: 'dry', dryRun: true,
        counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
        targets: [],
      },
    };
  };
  mon._executeEnableBatchFor = async () => ({
    outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, actionType: 'enable',
    counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  });
  return { mon, pauseCalls, cookieDir, dataDir };
}

test('Monitor：低消耗（5000/4999 分）高费比也照常 pause，日志无 50 元保护', async (t) => {
  for (const cost of [5000, 4999]) {
    const shops = [SHOP];
    const { mon, pauseCalls } = makeMonitorFixture(t, {
      shops,
      costByShop: { [SHOP.id]: cost },
      ordersByShop: { [SHOP.id]: 1 },
      stateByShop: { [SHOP.id]: 'on' },
    });
    const r = await mon.pollOnce('interval');
    assert.strictEqual(r.results[0].decision, DECISION.SHOULD_PAUSE, `cost ${cost}`);
    assert.strictEqual(pauseCalls[SHOP.id], 1, `cost ${cost}`);
    const j = mon.judgements[mon.judgements.length - 1];
    assert.strictEqual(j.spendProtected, false, `cost ${cost}`);
    assert.strictEqual(j.spendFloorCents, 0, `cost ${cost}`);
    assert.strictEqual(j.roiTooLow, true, `cost ${cost}`);
    assert.doesNotMatch(j.reason, /50\s*元/, `cost ${cost}`);
    assert.strictEqual(mon.getStatus().shops[0].roiTooLow, true, `cost ${cost}`);
    mon.stop();
  }
});

test('Monitor：同日多周期——等于阈值无提示 → 超标提示/暂停 → 回落等于阈值清除提示', async (t) => {
  const costs = { [SHOP.id]: 5000 };
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops: [SHOP],
    costByShop: costs,
    ordersByShop: { [SHOP.id]: 50 },
    stateByShop: { [SHOP.id]: 'on' },
  });

  const r1 = await mon.pollOnce('interval');
  assert.strictEqual(r1.results[0].decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(r1.results[0].zeroClick, true);
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, false);

  costs[SHOP.id] = 5001;
  const r2 = await mon.pollOnce('interval');
  assert.strictEqual(r2.results[0].decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(pauseCalls[SHOP.id], 1);
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, true);
  assert.strictEqual(mon.judgements[mon.judgements.length - 1].roiTooLow, true);

  costs[SHOP.id] = 5000;
  const r3 = await mon.pollOnce('interval');
  assert.strictEqual(r3.results[0].decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(r3.results[0].zeroClick, true);
  assert.strictEqual(pauseCalls[SHOP.id], 1, '回落到等于阈值后不得新增 pause');
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, false, '条件消失后提示必须清除');
  assert.strictEqual(mon.judgements[mon.judgements.length - 1].roiTooLow, false);
});

test('Monitor：等于阈值回读 mixed → 原「统一暂停」策略保留（无消耗门槛阻挡）', async (t) => {
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops: [SHOP],
    costByShop: { [SHOP.id]: 5000 },
    ordersByShop: { [SHOP.id]: 50 },
    stateByShop: { [SHOP.id]: 'mixed' },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, DECISION.SHOULD_PAUSE, 'equal+mixed 按既有统一暂停收敛');
  assert.strictEqual(r.results[0].action, 'pause');
  assert.strictEqual(pauseCalls[SHOP.id], 1);
  const j = mon.judgements[mon.judgements.length - 1];
  assert.strictEqual(j.roiTooLow, false, '严格等于不是超标，不提示 ROI 过低');
  assert.strictEqual(j.spendProtected, false);
  assert.doesNotMatch(j.reason, /50\s*元/);
});

test('Monitor：严格超标 → pause（演练）并记录可持久化的 ROI 提示字段（无消耗门槛）', async (t) => {
  const shops = [SHOP];
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops,
    costByShop: { [SHOP.id]: 5001 },
    ordersByShop: { [SHOP.id]: 50 },
    stateByShop: { [SHOP.id]: 'on' },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(pauseCalls[SHOP.id], 1, '严格超标沿原 pause 流程');
  const j = mon.judgements[mon.judgements.length - 1];
  assert.strictEqual(j.costCents, 5001);
  assert.strictEqual(j.orders, 50);
  assert.strictEqual(j.thresholdCents, 100);
  assert.strictEqual(j.spendFloorCents, 0);
  assert.strictEqual(j.spendProtected, false);
  assert.strictEqual(j.pauseEligible, true);
  assert.strictEqual(j.roiTooLow, true);
  assert.match(j.reason, /无消耗门槛|暂停资格/);
  assert.doesNotMatch(j.reason, /50\s*元/);
  const shop = mon.getStatus().shops[0];
  assert.strictEqual(shop.roiTooLow, true);
  assert.strictEqual(shop.today.roiTooLow, true);
});

test('Monitor：already_off + 严格超标可展示提示，但不产生额外广告 pause 记录', async (t) => {
  const shops = [SHOP];
  const { mon } = makeMonitorFixture(t, {
    shops,
    costByShop: { [SHOP.id]: 5001 },
    ordersByShop: { [SHOP.id]: 50 },
    stateByShop: { [SHOP.id]: 'off' },
  });
  mon._pollChengfangOver = async () => ({
    status: 'ok', dryRun: true, over: true,
    batch: {
      actionType: 'pause', outcome: 'nothing_to_close', dryRun: true,
      counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      alreadyClosedCount: 0,
    },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, DECISION.ALREADY_OFF);
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(mon.actions.length, 0, '盘点无动作不得记为已执行 pause');
  const j = mon.judgements[mon.judgements.length - 1];
  assert.strictEqual(j.roiTooLow, true, 'already_off 仍可向页面/日志投影 ROI 提示');
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, true);
});

test('Monitor：多店隔离——A 店超标提示/暂停，B 店低于阈值零动作', async (t) => {
  const a = { id: 'shop-a', name: '甲店', cookieFile: '甲店', accountId: null, enabled: true };
  const b = { id: 'shop-b', name: '乙店', cookieFile: '乙店', accountId: null, enabled: true };
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops: [a, b],
    costByShop: { 'shop-a': 5001, 'shop-b': 4999 },
    ordersByShop: { 'shop-a': 50, 'shop-b': 100 },
    stateByShop: { 'shop-a': 'on', 'shop-b': 'on' },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(pauseCalls['shop-a'], 1);
  assert.strictEqual(pauseCalls['shop-b'], 0);
  const byShop = {};
  for (const j of mon.judgements) byShop[j.shopId] = j;
  assert.strictEqual(byShop['shop-a'].roiTooLow, true);
  assert.strictEqual(byShop['shop-b'].roiTooLow, false);
  assert.strictEqual(byShop['shop-b'].spendProtected, false);
  const status = mon.getStatus();
  const rowA = status.shops.find((s) => s.id === 'shop-a');
  const rowB = status.shops.find((s) => s.id === 'shop-b');
  assert.strictEqual(rowA.roiTooLow, true);
  assert.strictEqual(rowB.roiTooLow, false);
  assert.ok(r.results.some((x) => x.shopId === 'shop-b' && x.zeroClick === true));
});

test('Monitor：跨日（昨日费用/订单）→ blocked、零 pause、无 ROI 提示', async (t) => {
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops: [SHOP],
    costByShop: { [SHOP.id]: 5001 },
    ordersByShop: { [SHOP.id]: 50 },
    stateByShop: { [SHOP.id]: 'on' },
    businessDate: '2026-10-16',
  });
  const before = mon.judgements.length;
  const r = await mon.pollOnce('interval');
  assert.notStrictEqual(r.results[0].status, 'ok', '跨日必须 fail-closed，不得当作正常轮次');
  assert.match(r.results[0].reason, /日期/);
  assert.strictEqual(pauseCalls[SHOP.id], 0);
  assert.strictEqual(mon.judgements.length, before, '跨日被拦下不产生有效判定/提示');
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, false);
});

test('Monitor：0 订单/坏数据 → blocked、零 pause、无 ROI 提示（不伪造 0 或 false 成功）', async (t) => {
  const shops = [SHOP];
  const { mon, pauseCalls } = makeMonitorFixture(t, {
    shops,
    costByShop: { [SHOP.id]: 5001 },
    ordersByShop: { [SHOP.id]: 0 },
    stateByShop: { [SHOP.id]: 'on' },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.strictEqual(pauseCalls[SHOP.id], 0);
  const j = mon.judgements[mon.judgements.length - 1];
  assert.strictEqual(j.status, 'blocked');
  assert.strictEqual(j.roiTooLow, false);
  assert.strictEqual(mon.getStatus().shops[0].roiTooLow, false);
});
