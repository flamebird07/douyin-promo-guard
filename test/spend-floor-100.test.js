'use strict';

/**
 * 50 元保护（客户 2026-10-17；2026-10-18 保护线 100→50，文件名 100 为历史命名）：公共库最小移植验收。
 *
 * 语义边界（只新增保护，不改变公共库既有方向语义）：
 * - 当天消耗 <= 5000 分（50.00 元）：任何方向都不得自动暂停（spend_protected），
 *   但原始 over 语义（cost > orders×threshold）必须保持不变；
 * - 当天消耗 > 5000 分且严格超标：pauseEligible / roiTooLow 成立，允许暂停并提示 ROI 过低；
 * - 低于阈值正常开启；等于阈值 on/off/mixed 仍 equal_no_action（公共库既有语义）；
 * - 执行前新鲜重读覆盖 coordinator / runner：重读后 <=50 元必须取消暂停（零请求）。
 *
 * 全部离线：mock 读取器/控制器 + 临时目录 + 注入时钟；不启动服务、不打开浏览器、不访问网络。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { evaluateWholeShopCostPerOrder, SPEND_FLOOR_CENTS } = require('../src/engine/rules');
const { decideAdSwitchAction, DECISION, METRIC } = require('../src/engine/ad-switch-decision');
const { WholeShopCloseCoordinator } = require('../src/engine/close-coordinator');
const { ChengfangRunner } = require('../src/engine/chengfang-runner');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const NOW = shanghaiMs('2026-10-17', '12:00');
const NEXT_DAY = shanghaiMs('2026-10-18', '12:00');
const IDENTITY = { id: 'shop-001', name: '测试店铺一' };
const ADS = [
  { adId: 'ad-1001', name: '广告甲', status: '投放中' },
  { adId: 'ad-1002', name: '广告乙', status: '投放中' },
  { adId: 'ad-1003', name: '广告丙', status: '投放中' },
  { adId: 'ad-1004', name: '已暂停广告', status: '已暂停' },
];

// ── 规则层：整数边界 + 原始 over 不被保护改写 ─────────────────────

test('规则：50.00 元保护线与 50.01 元暂停资格的整数边界', () => {
  assert.strictEqual(SPEND_FLOOR_CENTS, 5000);

  const atFloor = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 1, thresholdCents: 100 });
  assert.strictEqual(atFloor.over, true, '50.00 元 / 1 单：费比超标原始语义仍为 true');
  assert.strictEqual(atFloor.spendProtected, true);
  assert.strictEqual(atFloor.pauseEligible, false);
  assert.strictEqual(atFloor.roiTooLow, false);
  assert.match(atFloor.reason, /50 元保护/);

  const justOver = evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 1, thresholdCents: 100 });
  assert.strictEqual(justOver.over, true);
  assert.strictEqual(justOver.spendProtected, false);
  assert.strictEqual(justOver.pauseEligible, true);
  assert.strictEqual(justOver.roiTooLow, true);
  assert.match(justOver.reason, /暂停资格成立/);

  const equalAtFloor = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 50, thresholdCents: 100 });
  assert.strictEqual(equalAtFloor.over, false, '恰好等于阈值仍不超标');
  assert.strictEqual(equalAtFloor.pauseEligible, false);

  const below = evaluateWholeShopCostPerOrder({ costCents: 4999, orders: 100, thresholdCents: 100 });
  assert.strictEqual(below.over, false);
  assert.strictEqual(below.spendProtected, true);
  assert.strictEqual(below.roiTooLow, false);
});

test('规则：订单为 0 与正单同一公式（2026-10-27 修正），5001 分零单过线即暂停资格', () => {
  const r = evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 0, thresholdCents: 100 });
  assert.strictEqual(r.blocked, undefined, '零订单不再是 blocked');
  assert.strictEqual(r.over, true, '5001 分 > 0×100=0 分');
  assert.strictEqual(r.spendProtected, false);
  assert.strictEqual(r.pauseEligible, true);
  assert.strictEqual(r.roiTooLow, true);
});

// ── 决策层：保护区零动作，但公共库既有方向语义不变 ────────────────

function dec(over) {
  return decideAdSwitchAction({
    costCents: 5000,
    orders: 1,
    thresholdCents: 100,
    currentAdState: 'on',
    identityOk: true,
    ...over,
  });
}

test('决策：<=50 元且费比超标 → spend_protected 零动作（on/mixed 均不暂停）', () => {
  for (const st of ['on', 'mixed']) {
    const r = dec({ currentAdState: st });
    assert.strictEqual(r.metric, METRIC.ABOVE);
    assert.strictEqual(r.decision, DECISION.SPEND_PROTECTED);
    assert.strictEqual(r.spendProtected, true);
    assert.strictEqual(r.pauseEligible, false);
    assert.strictEqual(r.roiTooLow, false);
    assert.strictEqual(r.action, null);
    assert.strictEqual(r.zeroClick, true);
    assert.strictEqual(r.targetState, st, '保护区不强制切换方向');
    assert.match(r.reason, /50 元保护/);
  }
});

test('决策：>50 元且严格超标 → should_pause，roiTooLow 成立', () => {
  const r = dec({ costCents: 5001 });
  assert.strictEqual(r.metric, METRIC.ABOVE);
  assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(r.spendProtected, false);
  assert.strictEqual(r.pauseEligible, true);
  assert.strictEqual(r.roiTooLow, true);
  assert.strictEqual(r.action, 'pause');
});

test('决策：等于阈值（on/off/mixed）仍 equal_no_action；低于阈值仍可开启', () => {
  for (const st of ['on', 'off', 'mixed']) {
    const r = dec({ costCents: 5000, orders: 50, currentAdState: st });
    assert.strictEqual(r.metric, METRIC.EQUAL);
    assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION, `equal + ${st} 不得改为暂停或保护`);
    assert.strictEqual(r.zeroClick, true);
    assert.strictEqual(r.roiTooLow, false, '等于阈值不产生 ROI 过低提示');
  }
  const enable = dec({ costCents: 5000, orders: 100, currentAdState: 'off' });
  assert.strictEqual(enable.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(enable.spendProtected, true);
  assert.strictEqual(enable.roiTooLow, false);
});

test('决策：unknown 状态即使 >50 也不保留 ROI 提示；身份失败不产生保护投影', () => {
  const unknown = dec({ costCents: 5001, currentAdState: 'unknown' });
  assert.strictEqual(unknown.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(unknown.pauseEligible, false);
  assert.strictEqual(unknown.roiTooLow, false);

  const badIdentity = dec({ identityOk: false });
  assert.strictEqual(badIdentity.decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(badIdentity.spendProtected, null);
  assert.strictEqual(badIdentity.roiTooLow, false);
});

// ── 执行前新鲜重读：coordinator / runner 必须拦截 <=50 的暂停 ────────

function setupCoordinator(t, { costCents, orders = 1, nowFn = () => NOW }) {
  const cookieDir = makeTempDir('sf-coord-ck-');
  const dataDir = makeTempDir('sf-coord-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    execution: { realMode: true, dryRun: false, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    schedule: { dailyStartHour: 8 },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: ADS });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page' }, nowFn);
  const coord = new WholeShopCloseCoordinator({
    reader, controller, config: cfgResult.config, now: nowFn, audit: () => {},
  });
  return { coord, controller };
}

test('coordinator：操作前重读为 50.00 元 → 按 50 元保护取消，零关闭', async (t) => {
  const { coord, controller } = setupCoordinator(t, { costCents: 5000, orders: 1 });
  const r = await coord.executeWholeShopCloseBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
  });
  assert.strictEqual(r.outcome, 'cancelled');
  assert.strictEqual(r.counts.cancelled, 1);
  assert.match(r.reason, /50 元保护/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('coordinator：操作前重读为低费比 → 取消；>50 且严格超标 → 仍正常关闭（不误拦）', async (t) => {
  const low = setupCoordinator(t, { costCents: 5000, orders: 100 });
  const r1 = await low.coord.executeWholeShopCloseBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
  });
  assert.strictEqual(r1.outcome, 'cancelled');
  assert.match(r1.reason, /50 元保护|已不超标/);
  assert.strictEqual(low.controller.state.closeCalls.length, 0);

  const over = setupCoordinator(t, { costCents: 5001, orders: 1 });
  const r2 = await over.coord.executeWholeShopCloseBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
  });
  assert.strictEqual(r2.outcome, 'all_closed_confirmed');
  assert.strictEqual(r2.counts.confirmed, 3);
});

function makeRunner(fresh) {
  let reads = 0;
  const runner = new ChengfangRunner({
    coordinator: {
      async readAndEvaluate() {
        reads += 1;
        return fresh;
      },
    },
    config: {
      execution: { realMode: true, dryRun: false },
      monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
      schedule: { dailyStartHour: 8 },
    },
    now: () => NOW,
    audit: () => {},
  });
  return { runner, readCount: () => reads };
}

function freshData({ costCents, orders }) {
  return {
    ok: true,
    cost: { valueCents: costCents, businessDate: '2026-10-17' },
    orders: { valueCount: orders },
    evaluation: evaluateWholeShopCostPerOrder({ costCents, orders, thresholdCents: 100 }),
  };
}

test('runner：操作前重读为 50.00 元 → 取消暂停、零请求、不打开页面', async () => {
  const { runner } = makeRunner(freshData({ costCents: 5000, orders: 1 }));
  let opened = 0;
  const r = await runner.executeChengfangBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
    trigger: { reason: 'test' },
    pageOpener: async () => { opened += 1; throw new Error('不得打开页面'); },
    loginCfg: {},
  });
  assert.strictEqual(r.outcome, 'cancelled');
  assert.strictEqual(r.counts.cancelled, 1);
  assert.match(r.reason, /50 元保护/);
  assert.strictEqual(opened, 0);
});

test('runner：操作前重读为低费比 → 取消；>50 且严格超标 → 进入执行会话（不误拦）', async () => {
  const low = makeRunner(freshData({ costCents: 5000, orders: 100 }));
  let lowOpened = 0;
  const r1 = await low.runner.executeChengfangBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
    trigger: { reason: 'test' },
    pageOpener: async () => { lowOpened += 1; throw new Error('不得打开页面'); },
    loginCfg: {},
  });
  assert.strictEqual(r1.outcome, 'cancelled');
  assert.match(r1.reason, /50 元保护|已不超标/);
  assert.strictEqual(lowOpened, 0);

  const high = makeRunner(freshData({ costCents: 5001, orders: 1 }));
  let highOpened = 0;
  const r2 = await high.runner.executeChengfangBatch({
    shopCfg: { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' },
    cycleToken: { aborted: false },
    trigger: { reason: 'test' },
    pageOpener: async () => { highOpened += 1; throw new Error('模拟会话打开后中止'); },
    loginCfg: {},
  });
  assert.strictEqual(highOpened, 1, '>50 且严格超标必须进入执行会话（由 runner/executor 门槛继续把关）');
  assert.strictEqual(r2.outcome, 'partial');
});

// ── Monitor：投影、日志字段、跨日与坏数据清理 ──────────────────────

function setupMonitor(t, { costCents, orders = 1 }) {
  const cookieDir = makeTempDir('sf-mon-ck-');
  const dataDir = makeTempDir('sf-mon-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    execution: { realMode: false, dryRun: true, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    schedule: { dailyStartHour: 8 },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: ADS });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page' }, () => NOW);
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: () => NOW });
  t.after(() => { try { monitor.stop(); } catch (_) { /* 已停止 */ } });
  return { monitor, controller };
}

function lastJudgement(monitor) {
  assert.ok(monitor.judgements.length > 0, '必须有判断日志');
  return monitor.judgements[monitor.judgements.length - 1];
}

test('Monitor：50.00 元高费比 → spend_protected 投影，原始 over 保持 true，页面/日志不出现 ROI 提示', async (t) => {
  const { monitor } = setupMonitor(t, { costCents: 5000, orders: 1 });
  const r = await monitor.pollOnce('test');
  const res = r.results[0];
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.decision, DECISION.SPEND_PROTECTED);
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.spendProtected, true);
  assert.strictEqual(res.pauseEligible, false);
  assert.strictEqual(res.roiTooLow, false);

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-001');
  const row = status.shopRows.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.spendFloorCents, 5000);
  assert.strictEqual(shop.spendProtected, true);
  assert.strictEqual(shop.pauseEligible, false);
  assert.strictEqual(shop.roiTooLow, false);
  assert.strictEqual(shop.today.over, true, '原始 over 语义不得被保护改写');
  assert.strictEqual(row.spendProtected, true);
  assert.strictEqual(row.roiTooLow, false);
  assert.strictEqual(status.triggers.length, 0, '保护区不得产生暂停触发/枚举');

  const j = lastJudgement(monitor);
  assert.strictEqual(j.spendProtected, true);
  assert.strictEqual(j.pauseEligible, false);
  assert.strictEqual(j.roiTooLow, false);
  assert.strictEqual(j.spendFloorCents, 5000);
});

test('Monitor：50.01 元严格超标 → should_pause；judgement 携带 roiTooLow 供日志消费', async (t) => {
  const { monitor } = setupMonitor(t, { costCents: 5001, orders: 1 });
  const r = await monitor.pollOnce('test');
  const res = r.results[0];
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.dryRun, true, '演练模式不执行真实关闭');
  assert.strictEqual(res.decision, DECISION.SHOULD_PAUSE);

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-001');
  const row = status.shopRows.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.spendProtected, false);
  assert.strictEqual(shop.pauseEligible, true);
  assert.strictEqual(shop.roiTooLow, true);
  assert.strictEqual(row.roiTooLow, true);

  const j = lastJudgement(monitor);
  assert.strictEqual(j.status, 'ok');
  assert.strictEqual(j.spendProtected, false);
  assert.strictEqual(j.pauseEligible, true);
  assert.strictEqual(j.roiTooLow, true);
  assert.strictEqual(j.decision, DECISION.SHOULD_PAUSE);
});

test('Monitor：跨日 → 昨日 ROI 提示不得残留（同店同日才投影）', async (t) => {
  const { monitor } = setupMonitor(t, { costCents: 5001, orders: 1 });
  await monitor.pollOnce('test');
  assert.strictEqual(monitor.getStatus().shopRows.find((s) => s.id === 'shop-001').roiTooLow, true);

  monitor.nowFn = () => NEXT_DAY;
  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-001');
  const row = status.shopRows.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.roiTooLow, false);
  assert.strictEqual(shop.pauseEligible, false);
  assert.strictEqual(shop.spendProtected, null, '跨日无同日有效投影');
  assert.strictEqual(row.roiTooLow, false);
  assert.strictEqual(row.pauseEligible, false);
  assert.strictEqual(row.spendProtected, null);
});

test('Monitor：状态回读失败清除陈旧 ROI 提示；恢复后重新投影', async (t) => {
  const { monitor } = setupMonitor(t, { costCents: 5001, orders: 1 });
  await monitor.pollOnce('test');
  assert.strictEqual(monitor.getStatus().shopRows.find((s) => s.id === 'shop-001').roiTooLow, true);

  const origRead = monitor._readCurrentAdState.bind(monitor);
  monitor._readCurrentAdState = async () => ({
    state: 'unknown',
    error: { reason: '模拟清单回读失败', blocked: 'ad_state_read' },
  });
  const blocked = await monitor.pollOnce('test');
  assert.strictEqual(blocked.results[0].status, 'blocked');
  const rowAfterError = monitor.getStatus().shopRows.find((s) => s.id === 'shop-001');
  assert.strictEqual(rowAfterError.roiTooLow, false, '没有可信决策时不得保留上一轮提示');
  assert.strictEqual(rowAfterError.pauseEligible, false);
  const j = lastJudgement(monitor);
  assert.strictEqual(j.status, 'blocked');
  assert.strictEqual(j.roiTooLow, false);

  monitor._readCurrentAdState = origRead;
  const recovered = await monitor.pollOnce('test');
  assert.strictEqual(recovered.results[0].status, 'ok');
  assert.strictEqual(monitor.getStatus().shopRows.find((s) => s.id === 'shop-001').roiTooLow, true);
});
