'use strict';

/**
 * MIXED-MINMIN-20261027 D1 聚焦回归（隔离，无浏览器/网络/真实广告）：
 * 1) 停用/只读店回读 mixed 时，收敛视图必须如实显示"未安排收敛"，不得谎称"待收敛"；
 * 2) 最近一次决策为合法零动作（等于阈值保持 / 50 元保护）时同样不得谎称"待收敛"；
 * 3) 真正存在 unknown 阻塞 / 修复在途时，证据必须保留（重新判定 / 重试中）；
 * 4) 敏敏类数据（0 分 / 19 单 / 阈值 100 分，mixed）走真实决策+串行门执行链时，
 *    低于阈值必须 enable，并以本轮全量回读确认 on（不得把动作前 mixed 当完成态）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const {
  AdSwitchOrchestrator, createSwitchSerialGate, DECISION,
} = require('../src/engine/ad-switch-orchestrator');
const { decideAdSwitchAction } = require('../src/engine/ad-switch-decision');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

/**
 * 仅用于投影方法的轻量 Monitor 壳：不装配调度、不读取 Cookie/页面。
 * 投影只依赖 _runtimeMap / _switchOrchestrator / config.shops / adBelief。
 */
function fakeMonitor({
  enabled = true,
  deleted = false,
  lastAdState = 'mixed',
  lastDecision = null,
  inflight = 0,
  unknownBlock = false,
  pending = null,
  running,
} = {}) {
  const m = Object.create(Monitor.prototype);
  m.config = { shops: [{ id: 'min', name: '敏敏高定私服', enabled, deleted }] };
  m.nowFn = () => Date.parse('2026-10-27T10:00:00+08:00');
  if (running !== undefined) m.running = running;
  m._runtimeMap = new Map([['min', { lastAdState, lastDecision }]]);
  m.adBelief = {};
  m._switchOrchestrator = {
    mixedInflightProof: () => ({ inflight }),
    hasUnknownBlock: () => unknownBlock,
    pendingMixedReconcile: () => pending,
  };
  return m;
}

// ── 1) 停用/只读：mixed 不得显示"待收敛" ─────────────────────────
test('停用店（enabled=false）回读 mixed：未安排收敛，不得显示待收敛', () => {
  const v = fakeMonitor({ enabled: false })._mixedReconcileView('min');
  assert.strictEqual(v.observedAdState, 'mixed', '真实 mixed 观测必须保留');
  assert.strictEqual(v.mixedIsCompletion, false, 'mixed 永不是完成态');
  assert.strictEqual(v.completedByObservation, false, '不得假装已收敛 on/off');
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
  assert.match(v.reconcileText, /未安排收敛/);
  assert.notStrictEqual(v.reconcileState, 'pending_recheck', '停用店没有收敛安排，不得谎称待收敛');
  assert.strictEqual(v.noRepairScheduled, true);
});

test('已删除店回读 mixed：同样不得显示待收敛', () => {
  const v = fakeMonitor({ enabled: true, deleted: true })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
  assert.strictEqual(v.mixedIsCompletion, false);
});

test('活动店 mixed 且无任何在途/阻塞信号：仍如实显示待收敛（回归保护）', () => {
  const v = fakeMonitor({ enabled: true })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'pending_recheck');
  assert.strictEqual(v.reconcileText, '待收敛');
});

// ── 2) 合法零动作（等于阈值保持 / 50 元保护）──────────────────────
test('最近一次决策为 equal_no_action：mixed 不显示待收敛', () => {
  const v = fakeMonitor({
    enabled: true,
    lastDecision: { decision: DECISION.EQUAL_NO_ACTION },
  })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
  assert.strictEqual(v.mixedIsCompletion, false);
});

test('最近一次决策为 spend_protected：mixed 不显示待收敛', () => {
  const v = fakeMonitor({
    enabled: true,
    lastDecision: { decision: DECISION.SPEND_PROTECTED },
  })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
});

test('最近一次决策为 should_enable：仍如实显示待收敛（有收敛安排）', () => {
  const v = fakeMonitor({
    enabled: true,
    lastDecision: { decision: DECISION.SHOULD_ENABLE },
  })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'pending_recheck');
});

test('轮询调用方显式声明无收敛安排（opts.noRepairScheduled）：不显示待收敛', () => {
  const v = fakeMonitor({ enabled: true })._mixedReconcileView('min', { noRepairScheduled: true });
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
});

// ── 3) 证据优先：unknown 阻塞 / 修复在途必须保留 ──────────────────
test('mixed + unknown 阻塞：优先显示重新判定（即使店铺停用也不隐藏证据）', () => {
  const v = fakeMonitor({ enabled: false, unknownBlock: true })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'rejudging');
  assert.strictEqual(v.unknownBlock, true);
});

test('修复动作在途：优先显示重试中', () => {
  const v = fakeMonitor({ enabled: true, inflight: 1, unknownBlock: true })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'retrying');
  assert.strictEqual(v.repairInflight, true);
});

// ── 4) 敏敏数据：真实决策 + 串行门执行 + 全量回读确认 ─────────────
test('敏敏数据（0分/19单/阈值100分）mixed：低于阈值应开启，且不得被 50 元保护阻止', () => {
  const d = decideAdSwitchAction({
    costCents: 0,
    orders: 19,
    thresholdCents: 100,
    currentAdState: 'mixed',
    identityOk: true,
  });
  assert.strictEqual(d.metric, 'below_threshold');
  assert.strictEqual(d.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(d.targetState, 'on');
  assert.strictEqual(d.zeroClick, false);
  assert.strictEqual(d.spendProtected, true, '0 分在 50 元保护区内，但保护只阻止暂停、不阻止开启');
});

test('敏敏数据：动作前 mixed 经串行门执行 enable，本轮全量回读确认后为 confirmed', async () => {
  const orch = new AdSwitchOrchestrator({ gate: createSwitchSerialGate(), audit: () => {} });
  let executeCount = 0;
  let reads = 0;
  const r = await orch.runSwitchAction({
    shopId: 'min',
    action: 'enable',
    targetState: 'on',
    // 第 1 次为本轮初始回读 mixed；动作前复核回读为 off；之后由批次全量回读确认。
    readState: async () => { reads += 1; return reads === 1 ? 'mixed' : 'off'; },
    decide: (state) => orch.evaluatePeriodic({
      costCents: 0, orders: 19, thresholdCents: 100, currentAdState: state, identityOk: true,
    }),
    execute: async () => {
      executeCount += 1;
      return {
        outcome: 'all_enabled_confirmed',
        allEnabledConfirmed: true,
        counts: { confirmed: 2, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      };
    },
  });
  assert.strictEqual(r.zeroClick, false, '低于阈值必须进入开启动作');
  assert.strictEqual(r.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(executeCount, 1, '开启流程恰好一次');
  assert.ok(reads >= 2, '动作前必须再次回读');
  assert.strictEqual(r.serial, 'confirmed', '只有全量回读确认才算收敛');
  assert.strictEqual(orch.isBusy('min'), false, '结束后串行门必须释放');
});

test('等于阈值 + mixed 且 >50 元：保留统一暂停收敛；≤50 元零暂停', () => {
  const overFloor = decideAdSwitchAction({
    costCents: 10000, orders: 100, thresholdCents: 100, currentAdState: 'mixed', identityOk: true,
  });
  assert.strictEqual(overFloor.metric, 'equal_threshold');
  assert.strictEqual(overFloor.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(overFloor.reconcileBasis, 'equal_mixed_unified_pause');

  const inFloor = decideAdSwitchAction({
    costCents: 1900, orders: 19, thresholdCents: 100, currentAdState: 'mixed', identityOk: true,
  });
  assert.strictEqual(inFloor.metric, 'equal_threshold');
  assert.strictEqual(inFloor.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(inFloor.zeroClick, true);
});

test('高于阈值但 ≤50 元：spend_protected 零暂停；>50 元才允许暂停', () => {
  const protectedOne = decideAdSwitchAction({
    costCents: 4000, orders: 1, thresholdCents: 100, currentAdState: 'mixed', identityOk: true,
  });
  assert.strictEqual(protectedOne.metric, 'above_threshold');
  assert.strictEqual(protectedOne.decision, DECISION.SPEND_PROTECTED);
  assert.strictEqual(protectedOne.zeroClick, true);

  const pauseOne = decideAdSwitchAction({
    costCents: 5001, orders: 1, thresholdCents: 100, currentAdState: 'mixed', identityOk: true,
  });
  assert.strictEqual(pauseOne.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(pauseOne.pauseEligible, true);
});

test('真实 unknown 状态仍 fail-closed 零点击（不得因本轮修改而放行）', () => {
  const d = decideAdSwitchAction({
    costCents: 999999, orders: 1, thresholdCents: 100, currentAdState: 'unknown', identityOk: true,
  });
  assert.strictEqual(d.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(d.zeroClick, true);
});

// ── 5) 新鲜只读观测必须使旧决策失效 ───────────────────────────────
test('_applyObservedAdState 写入新鲜观测即清空旧 lastDecision（旧 equal/protected 不再压制 pending）', () => {
  const m = Object.create(Monitor.prototype);
  m.nowFn = () => Date.parse('2026-10-27T10:00:00+08:00');
  m.config = { shops: [{ id: 'min', enabled: true }] };
  m._runtimeMap = new Map([['min', {
    lastAdState: 'mixed',
    lastDecision: { decision: DECISION.EQUAL_NO_ACTION },
    adStateConfirmedAt: '2026-10-27T09:00:00+08:00',
  }]]);
  m._switchOrchestrator = {
    mixedInflightProof: () => ({ inflight: 0 }),
    hasUnknownBlock: () => false,
    pendingMixedReconcile: () => null,
  };
  m._applyObservedAdState('min', 'mixed', '只读刷新');
  const rt = m._runtimeMap.get('min');
  assert.strictEqual(rt.lastDecision, null, '旧决策必须随新观测失效');
  const v = m._mixedReconcileView('min', { cycleActive: true });
  assert.strictEqual(v.reconcileState, 'pending_recheck', '活动店 mixed 且无新决策 → 仍如实待收敛');
  assert.strictEqual(v.mixedIsCompletion, false);
});

test('只读刷新（refreshShopData）清空旧决策，不得沿用上一轮 equal 决策', async (t) => {
  const { monitor } = setupPollMonitor(t, { costCents: 0, orders: 19 });
  const rt = monitor._runtime('shop-001');
  rt.lastDecision = { decision: DECISION.EQUAL_NO_ACTION };
  rt.lastAdState = 'mixed';
  const r = await monitor.refreshShopData('shop-001');
  assert.strictEqual(r.readOnly, true);
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.adState, 'mixed');
  assert.strictEqual(rt.lastDecision, null, '只读观测重建后旧决策不得保留');
  const v = monitor._mixedReconcileView('shop-001', { cycleActive: true });
  assert.strictEqual(v.reconcileState, 'pending_recheck');
});

// ── 6) Monitor 未运行：没有后续巡查 → 未安排收敛（证据优先）────────
test('Monitor 未运行：mixed 无在途/阻塞 → 未安排收敛，不凭空 pending', () => {
  const v = fakeMonitor({ enabled: true, running: false })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'no_repair_scheduled');
  assert.strictEqual(v.mixedIsCompletion, false);
  assert.strictEqual(v.noRepairScheduled, true);
});

test('Monitor 未运行但存在 unknown 阻塞：证据优先，仍显示重新判定', () => {
  const v = fakeMonitor({ enabled: true, running: false, unknownBlock: true })._mixedReconcileView('min');
  assert.strictEqual(v.reconcileState, 'rejudging');
  assert.strictEqual(v.unknownBlock, true);
});

// ── 7) 真实 Monitor._pollShop（mock reader/controller，无浏览器/网络）──
const MON_NOW = shanghaiMs('2026-10-27', '10:00');
const MON_SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true };
const MON_IDENTITY = { id: 'shop-001', name: '测试店铺一' };
const MON_ADS_MIXED = [
  { adId: 'ad-1', name: '广告甲', status: '投放中', switchChecked: true },
  { adId: 'ad-2', name: '广告乙', status: '已暂停', switchChecked: false },
];

function cleanupMonitorDirs(t, dirs) {
  t.after(() => {
    const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep;
    for (const dir of dirs) {
      assert.ok(fs.realpathSync(dir).startsWith(tempRoot), 'cleanup stays inside the test temp root');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function setupPollMonitor(t, { costCents = 0, orders = 19, enabled = true } = {}) {
  const cookieDir = makeTempDir('mm-poll-ck-');
  const dataDir = makeTempDir('mm-poll-data-');
  cleanupMonitorDirs(t, [cookieDir, dataDir]);
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [{ ...MON_SHOP, enabled }],
    execution: { realMode: false, dryRun: true },
    schedule: { dailyStartHour: 8 },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const controller = makeStatefulController({ identity: MON_IDENTITY, ads: MON_ADS_MIXED });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page' }, () => MON_NOW);
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: () => MON_NOW });
  t.after(() => { try { monitor.stop(); } catch (_) { /* 已停止 */ } });
  return { monitor, controller, reader };
}

test('Monitor._pollShop：mixed + 0 分/19 单/阈值 100 分 → 实际决策 should_enable 并派发 enable（零真实点击）', async (t) => {
  const { monitor, controller } = setupPollMonitor(t, { costCents: 0, orders: 19 });
  const dispatched = [];
  monitor._runShopSwitchAction = async (shopCfg, action, data) => {
    dispatched.push({ shopId: shopCfg.id, action, costCents: data.cost.valueCents, orders: data.orders.valueCount });
    return { status: 'ok', zeroClick: false, action };
  };
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(dispatched, [{ shopId: 'shop-001', action: 'enable', costCents: 0, orders: 19 }]);
  const rt = monitor._runtimeMap.get('shop-001');
  assert.strictEqual(rt.lastAdState, 'mixed', '动作前观测如实保持 mixed，不伪装完成');
  assert.strictEqual(rt.lastDecision.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(controller.state.closeCalls.length, 0, '本测试不触达真实执行器');
});

test('Monitor._pollShop：mixed + 50 元保护（合法零动作）→ ok 且 no_repair_scheduled，零点击', async (t) => {
  const { monitor, controller } = setupPollMonitor(t, { costCents: 1200, orders: 0 });
  let dispatched = 0;
  monitor._runShopSwitchAction = async () => { dispatched += 1; return { status: 'ok' }; };
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.pending, undefined);
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.mixedReconcile.state, 'no_repair_scheduled');
  assert.strictEqual(r.mixedReconcile.mixedIsCompletion, false);
  assert.strictEqual(dispatched, 0);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('Monitor._pollShop：mixed + 等于阈值（合法零动作）→ ok 且 no_repair_scheduled', async (t) => {
  const { monitor } = setupPollMonitor(t, { costCents: 0, orders: 0 });
  monitor._runShopSwitchAction = async () => { throw new Error('合法零动作不得派发'); };
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(r.mixedReconcile.state, 'no_repair_scheduled');
});

test('Monitor._pollShop：mixed + 合法零动作但存在 unknown 阻塞 → 仍 pending（rejudging）', async (t) => {
  const { monitor, controller } = setupPollMonitor(t, { costCents: 1200, orders: 0 });
  monitor._switchOrchestrator.hasUnknownBlock = () => true;
  monitor._switchOrchestrator.pendingMixedReconcile = () => ({ actionId: 'old-action' });
  let dispatched = 0;
  monitor._runShopSwitchAction = async () => { dispatched += 1; return { status: 'ok' }; };
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.mixedReconcile.state, 'rejudging');
  assert.strictEqual(r.mixedReconcile.unknownBlock, true);
  assert.strictEqual(dispatched, 0);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('Monitor._pollShop：mixed + 合法零动作但修复在途 → 仍 pending（retrying）', async (t) => {
  const { monitor } = setupPollMonitor(t, { costCents: 1200, orders: 0 });
  monitor._switchOrchestrator.mixedInflightProof = () => ({ inflight: 1 });
  let dispatched = 0;
  monitor._runShopSwitchAction = async () => { dispatched += 1; return { status: 'ok' }; };
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.mixedReconcile.state, 'retrying');
  assert.strictEqual(r.mixedReconcile.repairInflight, true);
  assert.strictEqual(dispatched, 0);
});

test('Monitor._pollShop：回读失败 → blocked/zeroClick/UNKNOWN_BLOCKED，绝不 ok 或伪 on/off', async (t) => {
  const { monitor, controller } = setupPollMonitor(t, { costCents: 0, orders: 19 });
  monitor._readAdState = async () => ({
    error: { status: 'blocked', reason: '测试注入：清单读取失败', blocked: 'ad_state_read' },
  });
  const r = await monitor._pollShop({ ...MON_SHOP }, { aborted: false }, 'test');
  assert.strictEqual(r.status, 'blocked');
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.decision, DECISION.UNKNOWN_BLOCKED);
  assert.notStrictEqual(r.status, 'ok');
  const rt = monitor._runtimeMap.get('shop-001');
  assert.strictEqual(rt.lastAdState, 'unknown');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('停用店只读刷新：mixed 仅只读观测、零动作，面板显示未安排收敛', async (t) => {
  const { monitor, controller } = setupPollMonitor(t, { enabled: false, costCents: 0, orders: 19 });
  const r = await monitor.refreshShopData('shop-001');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.readOnly, true);
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.adState, 'mixed');
  const shop = monitor.getStatus().shops.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.lastAdState, 'mixed');
  assert.strictEqual(shop.mixedReconcile.reconcileState, 'no_repair_scheduled');
  assert.strictEqual(shop.mixedReconcile.mixedIsCompletion, false);
  assert.strictEqual(monitor.actions.length, 0);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

// ── 8) 页面主行 VM：mixed 文案只消费结构化状态 ─────────────────────
function loadShopRowRenderer() {
  const htmlPath = path.join(__dirname, '..', '..', 'app', 'index.html');
  const src = fs.readFileSync(htmlPath, 'utf8');
  const startMark = 'R41-VM-TEST:SHOP_ROW_HTML_START';
  const endMark = 'R41-VM-TEST:SHOP_ROW_HTML_END';
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark);
  assert.ok(start >= 0 && end > start, 'shopRowHtml VM markers must exist');
  const bodyStart = src.indexOf('\n', start) + 1;
  const bodyRaw = src.slice(bodyStart, end);
  const body = bodyRaw.slice(0, bodyRaw.lastIndexOf('\n') + 1);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmtTime = () => '10:00';
  const deleteBlocked = () => false;
  return new Function('s', 'esc', 'fmtTime', 'deleteBlocked', 'Date',
    `return function shopRowHtml(r, idx) {${body}};`)(
    { planPublishing: null }, esc, fmtTime, deleteBlocked, Date
  );
}

function mixedRow(adStateOver) {
  const nowIso = new Date().toISOString();
  return {
    id: 'shop-min', name: '敏敏高定私服', displayName: '敏敏高定私服', platform: 'douyin',
    thresholdCents: 100, targetRoi: 15, plansPerShopPerDay: 3,
    costCents: 0, orders: 19, balanceCents: null, balanceAt: null,
    today: { businessDate: '2026-10-27' }, lastDataAt: nowIso,
    adState: {
      state: 'mixed', reconcileState: 'no_repair_scheduled',
      reconcileText: '混合（未安排收敛，非完成态）', unknownBlock: false, observedAt: nowIso,
      ...(adStateOver || {}),
    },
    readFailure: null, readErrorKind: null, readErrorReason: null, lastError: null,
    readRecovery: null, readRetrying: false, adControl: true, roiTooLow: false,
    identityPending: false, identityNote: null, loginJoin: null, requiresLogin: false,
  };
}

test('UI VM：mixed/no_repair_scheduled 显示未安排收敛，不伪装待确认/成功', () => {
  const render = loadShopRowRenderer();
  const html = render(mixedRow(), 0);
  assert.match(html, /未安排收敛/);
  assert.doesNotMatch(html, /混合 · 待确认/);
  assert.doesNotMatch(html, /旧动作仍未确认/);
});

test('UI VM：mixed/pending_recheck 与 unknownBlock 保留真实待收敛标签', () => {
  const render = loadShopRowRenderer();
  const html = render(mixedRow({
    reconcileState: 'pending_recheck', reconcileText: '待收敛', unknownBlock: true,
  }), 0);
  assert.match(html, /混合 · 待确认/);
  assert.match(html, /待收敛/);
  assert.match(html, /旧动作仍未确认/);
});
