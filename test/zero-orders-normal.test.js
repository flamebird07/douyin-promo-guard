'use strict';

/**
 * 0 单正常流全链路验收（客户 2026-10-27 修正）。
 *
 * 修正前：rules 在公式前返回 zero_orders blocked；coordinator 对每个有效 0 单再读一次并 ok:false；
 * decision 把 zero_orders 提升为 DATA_BLOCKED；monitor 有 zero_orders 专用阻断分支；UI 隐藏旧原因。
 * 修正后：0 单与正单走同一整数公式（expectedCents=0），50 元保护线不变：
 *   - 0 费 0 单：相等 → 零动作；
 *   - 0 单有消耗 ≤50 元：spend_protected（原始 over=true，但不自动暂停）；
 *   - 0 单有消耗 >50 元：pauseEligible（on/mixed → should_pause；off → already_off）；
 *   - unknown / 缺字段 / null / 负数 / 非整数 / 身份/日期/时效/解析故障仍是真实错误。
 *
 * 全部离线：mock reader/controller + 临时目录 + 注入时钟；无浏览器、无网络、无真实开关。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { evaluateWholeShopCostPerOrder, SPEND_FLOOR_CENTS } = require('../src/engine/rules');
const { decideAdSwitchAction, DECISION, METRIC } = require('../src/engine/ad-switch-decision');
const { WholeShopCloseCoordinator } = require('../src/engine/close-coordinator');
const { Monitor } = require('../src/engine/monitor');
const { DataGuardError, AuthError } = require('../src/lib/errors');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const NOW = shanghaiMs('2026-10-27', '10:00');
const TODAY = '2026-10-27';
const IDENTITY = { id: 'shop-001', name: '测试店铺一' };
const SHOP_CFG = { id: 'shop-001', name: '测试店铺一', cookieFile: 'x' };
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true };
const ADS_ON = [
  { adId: 'ad-1001', name: '广告甲', status: '投放中', switchChecked: true },
  { adId: 'ad-1002', name: '广告乙', status: '投放中', switchChecked: true },
];
// 3 个投放侧 + 1 个关闭侧：批次应只关闭投放侧 3 个，已暂停的不动。
const ADS_MIXED = [
  { adId: 'ad-1001', name: '广告甲', status: '投放中', switchChecked: true },
  { adId: 'ad-1002', name: '广告乙', status: '投放中', switchChecked: true },
  { adId: 'ad-1003', name: '广告丙', status: '投放中', switchChecked: true },
  { adId: 'ad-1004', name: '已暂停广告', status: '已暂停', switchChecked: false },
];

function cleanup(t, dirs) {
  t.after(() => {
    const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep;
    for (const dir of dirs) {
      assert.ok(fs.realpathSync(dir).startsWith(tempRoot), 'cleanup stays inside the test temp root');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function setupCoordinator(t, {
  costCents = 1200, orders = 0, ads = ADS_ON, realMode = false, readerDef = {},
} = {}) {
  const cookieDir = makeTempDir('zo-norm-ck-');
  const dataDir = makeTempDir('zo-norm-data-');
  cleanup(t, [cookieDir, dataDir]);
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    execution: { realMode, dryRun: !realMode },
    schedule: { dailyStartHour: 8 },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads });
  const reader = makeLinkedReader(controller, {
    costCents, orders, pageSource: 'promo-page', ...readerDef,
  }, () => NOW);
  const coord = new WholeShopCloseCoordinator({
    reader, controller, config: cfgResult.config, now: () => NOW, audit: () => {},
  });
  return { coord, controller, reader, cfgResult };
}

function setupMonitor(t, { costCents = 1200, orders = 0, ads = ADS_ON } = {}) {
  const cookieDir = makeTempDir('zo-norm-mon-ck-');
  const dataDir = makeTempDir('zo-norm-mon-data-');
  cleanup(t, [cookieDir, dataDir]);
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: { realMode: false, dryRun: true },
    schedule: { dailyStartHour: 8 },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads });
  const reader = makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page' }, () => NOW);
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: () => NOW });
  t.after(() => { try { monitor.stop(); } catch (_) { /* 已停止 */ } });
  return { monitor, controller, reader };
}

// ── 规则层：0 单与正单同一整数公式 ────────────────────────────────

test('规则边界（orders=0）：0 / 1 / 5000 / 5001 分与 50 元保护线', () => {
  assert.strictEqual(SPEND_FLOOR_CENTS, 5000);

  const zero = evaluateWholeShopCostPerOrder({ costCents: 0, orders: 0, thresholdCents: 100 });
  assert.strictEqual(zero.expectedCents, 0);
  assert.strictEqual(zero.over, false, '0 分 == 0 分：相等不关闭');
  assert.strictEqual(zero.spendProtected, true);
  assert.strictEqual(zero.pauseEligible, false);
  assert.strictEqual(zero.blocked, undefined);

  const one = evaluateWholeShopCostPerOrder({ costCents: 1, orders: 0, thresholdCents: 100 });
  assert.strictEqual(one.expectedCents, 0);
  assert.strictEqual(one.over, true, '1 分 > 0 分：严格超标');
  assert.strictEqual(one.spendProtected, true);
  assert.strictEqual(one.pauseEligible, false, '≤50 元不自动暂停');
  assert.strictEqual(one.blocked, undefined);

  const floor = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 0, thresholdCents: 100 });
  assert.strictEqual(floor.over, true);
  assert.strictEqual(floor.spendProtected, true);
  assert.strictEqual(floor.pauseEligible, false);
  assert.strictEqual(floor.roiTooLow, false);

  const over = evaluateWholeShopCostPerOrder({ costCents: 5001, orders: 0, thresholdCents: 100 });
  assert.strictEqual(over.over, true);
  assert.strictEqual(over.spendProtected, false);
  assert.strictEqual(over.pauseEligible, true);
  assert.strictEqual(over.roiTooLow, true);
});

test('规则：0 单合法；缺失/null/负数/非整数/metric 非法仍是真实错误', () => {
  assert.doesNotThrow(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: 0, thresholdCents: 100 }));
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: null, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: undefined, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: -1, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: 1.5, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: null, orders: 0, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: -1, orders: 0, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 12.5, orders: 0, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 0, orders: 0, thresholdCents: 0 }), DataGuardError);
});

// ── 决策层：0 单 × 当前状态边界矩阵 ──────────────────────────────

test('决策矩阵（orders=0）：0/1/5000 保护区零动作；5001 按 on/off/mixed 分流；unknown 仍阻止', () => {
  function dec(costCents, currentAdState) {
    return decideAdSwitchAction({
      costCents, orders: 0, thresholdCents: 100, currentAdState, identityOk: true,
    });
  }

  for (const st of ['on', 'off', 'mixed']) {
    const r = dec(0, st);
    assert.strictEqual(r.metric, METRIC.EQUAL, `0 分 + ${st}`);
    assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION, `0 分 + ${st}：相等保持`);
    assert.strictEqual(r.zeroClick, true);
  }
  assert.strictEqual(dec(0, 'unknown').decision, DECISION.UNKNOWN_BLOCKED);

  for (const cost of [1, 5000]) {
    for (const st of ['on', 'off', 'mixed']) {
      const r = dec(cost, st);
      assert.strictEqual(r.metric, METRIC.ABOVE, `${cost} 分 + ${st}`);
      assert.strictEqual(r.decision, DECISION.SPEND_PROTECTED, `${cost} 分 + ${st}：50 元保护`);
      assert.strictEqual(r.spendProtected, true);
      assert.strictEqual(r.pauseEligible, false);
      assert.strictEqual(r.roiTooLow, false);
      assert.strictEqual(r.zeroClick, true);
      assert.strictEqual(r.blocked, null);
    }
    assert.strictEqual(dec(cost, 'unknown').decision, DECISION.UNKNOWN_BLOCKED);
  }

  const on = dec(5001, 'on');
  assert.strictEqual(on.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(on.action, 'pause');
  assert.strictEqual(on.pauseEligible, true);
  assert.strictEqual(on.roiTooLow, true);
  assert.strictEqual(dec(5001, 'mixed').decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(dec(5001, 'off').decision, DECISION.ALREADY_OFF);
  const unknown = dec(5001, 'unknown');
  assert.strictEqual(unknown.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(unknown.pauseEligible, false);
  assert.strictEqual(unknown.roiTooLow, false);
});

// ── 真实 coordinator：0 单 ok:true，无零单专用重读 ────────────────

test('coordinator：0 单 + 12.00 元 → ok:true、spendProtected，恰读一次订单（无专用重读）', async (t) => {
  const { coord, reader, controller } = setupCoordinator(t, { costCents: 1200, orders: 0 });
  const data = await coord.readAndEvaluate(SHOP_CFG);

  assert.strictEqual(data.ok, true);
  assert.strictEqual(data.blocked, undefined, '0 单不再 blocked');
  assert.strictEqual(data.orders.valueCount, 0);
  assert.strictEqual(data.rechecked, 0);
  assert.strictEqual(data.evaluation.over, true, '1200 分 > 0×100=0 分');
  assert.strictEqual(data.evaluation.spendProtected, true);
  assert.strictEqual(data.evaluation.pauseEligible, false);
  assert.strictEqual(reader.readOrderSummaryCalls, 1, '每轮评估只读一次订单，无零单专用重读');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('coordinator：0 单 + 12.00 元批次 → 50 元保护取消，零关闭', async (t) => {
  const { coord, controller } = setupCoordinator(t, { costCents: 1200, orders: 0, realMode: true });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: SHOP_CFG, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'cancelled');
  assert.match(r.reason, /50 元保护/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('coordinator：0 单 + 50.01 元批次 → 正常关闭（保护线不被零单绕过）', async (t) => {
  const { coord, controller, reader } = setupCoordinator(t, { costCents: 5001, orders: 0, realMode: true, ads: ADS_MIXED });
  const r = await coord.executeWholeShopCloseBatch({ shopCfg: SHOP_CFG, cycleToken: { aborted: false } });
  assert.strictEqual(r.outcome, 'all_closed_confirmed');
  assert.strictEqual(r.counts.confirmed, 3, '3 个投放侧广告全部关闭（已暂停的不动）');
  assert.strictEqual(controller.state.closeCalls.length, 3);
  assert.strictEqual(reader.readOrderSummaryCalls, 1, '操作前复核也只读一次订单');
});

test('coordinator：0 单合法，但跨店/跨日/缺失/null/负数仍是真实错误', async (t) => {
  const wrongShop = setupCoordinator(t, { costCents: 1200, orders: 0, readerDef: { orderShopId: 'shop-002' } });
  await assert.rejects(() => wrongShop.coord.readAndEvaluate(SHOP_CFG), (e) => e instanceof AuthError);

  const wrongDate = setupCoordinator(t, { costCents: 1200, orders: 0, readerDef: { orderDate: '2026-10-26' } });
  await assert.rejects(
    () => wrongDate.coord.readAndEvaluate(SHOP_CFG),
    (e) => e instanceof DataGuardError && /日期|当天/.test(e.message)
  );

  const missing = setupCoordinator(t, { costCents: 1200, orders: null });
  await assert.rejects(
    () => missing.coord.readAndEvaluate(SHOP_CFG),
    (e) => e instanceof DataGuardError && /订单数/.test(e.message)
  );

  // 注意：函数参数默认值会把显式 undefined 变为 0，必须从 readerDef 覆盖为缺失值。
  const undefinedOrders = setupCoordinator(t, { costCents: 1200, readerDef: { orders: undefined } });
  await assert.rejects(
    () => undefinedOrders.coord.readAndEvaluate(SHOP_CFG),
    (e) => e instanceof DataGuardError && /订单数/.test(e.message)
  );

  const negative = setupCoordinator(t, { costCents: 1200, orders: -1 });
  await assert.rejects(
    () => negative.coord.readAndEvaluate(SHOP_CFG),
    (e) => e instanceof DataGuardError && /订单数/.test(e.message)
  );
});

// ── 真实 Monitor：只读刷新与普通巡查 ─────────────────────────────

test('Monitor.refreshShopData：0 单 + 12.00 元返回 ok/readOnly/zeroClick，today 无 blockedReason', async (t) => {
  const { monitor } = setupMonitor(t, { costCents: 1200, orders: 0, ads: ADS_ON });
  const res = await monitor.refreshShopData('shop-001');

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.readOnly, true);
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.blocked, undefined);
  assert.strictEqual(res.data.orders, 0);
  assert.strictEqual(res.data.costCents, 1200);
  assert.strictEqual(res.data.over, true);
  assert.strictEqual(res.data.spendProtected, true);
  assert.strictEqual(res.data.pauseEligible, false);
  assert.strictEqual(res.data.blockedReason, undefined, '正常 0 单不产生 blockedReason');
  const shop = monitor.getStatus().shops.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.today.blockedReason, undefined);
});

test('Monitor 普通巡查：0 单 + 12.00 元 → spend_protected，不是 DATA_BLOCKED、零动作', async (t) => {
  const { monitor, controller, reader } = setupMonitor(t, { costCents: 1200, orders: 0, ads: ADS_ON });
  const r = await monitor.pollOnce('test');
  const res = r.results[0];

  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.decision, DECISION.SPEND_PROTECTED);
  assert.notStrictEqual(res.decision, DECISION.DATA_BLOCKED, '正常 0 单不得标 DATA_BLOCKED');
  assert.strictEqual(res.blocked, undefined);
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.spendProtected, true);
  assert.strictEqual(res.pauseEligible, false);
  assert.strictEqual(controller.state.closeCalls.length, 0, '保护区内零动作');
  assert.strictEqual(monitor.triggers.length, 0);
  assert.strictEqual(monitor.actions.length, 0);
  assert.strictEqual(reader.readOrderSummaryCalls, 1, '无零单专用重读');
  const shop = monitor.getStatus().shops.find((s) => s.id === 'shop-001');
  assert.strictEqual(shop.today.blockedReason, undefined);
});

// ── UI 真实组件 VM：正常 0 单不显示异常；旧错误仍可见 ─────────────

function loadShopRowRenderer() {
  const htmlPath = path.join(__dirname, '..', 'docs', 'zero-order-rules-20261027', 'offline', 'index.html');
  const src = fs.readFileSync(htmlPath, 'utf8');
  const startMark = 'R41-VM-TEST:SHOP_ROW_HTML_START';
  const endMark = 'R41-VM-TEST:SHOP_ROW_HTML_END';
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark);
  assert.ok(start >= 0 && end > start, 'shopRowHtml VM markers must exist');
  const bodyStart = src.indexOf('\n', start) + 1;
  // 结束标记前的缩进与 `// ` 注释前缀也必须剔除，否则拼接的 `};` 会被注释吞掉（函数未闭合）。
  const bodyRaw = src.slice(bodyStart, end);
  const body = bodyRaw.slice(0, bodyRaw.lastIndexOf('\n') + 1);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const fmtTime = () => '10:00';
  const deleteBlocked = () => false;
  // s 仅用于今日计划摘要（planPublishing）；正常 DTO 不涉及发布记录。
  return new Function('s', 'esc', 'fmtTime', 'deleteBlocked', 'Date',
    `return function shopRowHtml(r, idx) {${body}};`)(
    { planPublishing: null }, esc, fmtTime, deleteBlocked, Date
  );
}

function normalZeroRow(over = {}) {
  const nowIso = new Date().toISOString();
  return {
    id: 'shop-jianshang', name: '简尚', displayName: '简尚', platform: 'douyin',
    thresholdCents: 100, targetRoi: 15, plansPerShopPerDay: 3,
    costCents: 1200, orders: 0, balanceCents: null, balanceAt: null,
    today: { businessDate: TODAY },
    lastDataAt: nowIso,
    adState: { state: 'on', confirmedAt: nowIso },
    readFailure: null, readErrorKind: null, readErrorReason: null, lastError: null,
    readRecovery: null, readRetrying: false, adControl: true,
    roiTooLow: false, identityPending: false, identityNote: null,
    loginJoin: null, requiresLogin: false,
    ...over,
  };
}

test('UI VM：正常 0 单 DTO 不显示异常原因；旧的错误 blockedReason 仍必须可见', () => {
  const render = loadShopRowRenderer();

  const normal = render(normalZeroRow(), 0);
  assert.match(normal, /订单 0 单/);
  assert.match(normal, /12\.00 元/);
  assert.match(normal, /开启/);
  assert.doesNotMatch(normal, /异常原因/, '正常 0 单一律不显示异常 details');
  assert.doesNotMatch(normal, /当日 0 单/);

  const legacyReason = '当日 0 单（0 费 0 单）：无需关闭';
  const legacy = render(normalZeroRow({ today: { businessDate: TODAY, blockedReason: legacyReason } }), 0);
  assert.match(legacy, /异常原因/, '旧错误原因不得被 0 单特例吞掉（展示抑制已移除）');
  assert.ok(legacy.includes(legacyReason), '原始错误原因必须可见');
});

test('UI VM：真实认证/身份错误仍可见（不因 0 单正常化而隐藏）', () => {
  const render = loadShopRowRenderer();
  const detail = '登录验证未通过：账号身份不匹配';
  const html = render(normalZeroRow({
    readFailure: { detail, requiresLogin: true },
    readErrorKind: 'auth',
    requiresLogin: true,
  }), 0);
  assert.match(html, /登录验证未通过/);
  assert.match(html, /异常原因/, '真实错误必须走同一 errDetail 链展示');
  assert.ok(html.includes(detail), '完整错误详情必须可见');
});

// ── 配置边界：不新增设置、不迁移旧字段 ───────────────────────────

test('配置：阈值/规则/zeroOrderRecheck 均保持原值（本阶段不迁移、不新增设置）', () => {
  const cfgResult = makeCfgResult({});
  assert.strictEqual(cfgResult.config.rules[0].thresholdCents, 100);
  assert.strictEqual(cfgResult.config.rules[0].comparator, '>');
  assert.strictEqual(cfgResult.config.execution.zeroOrderRecheck, 1, '旧配置字段保留，不再参与判定');
});
