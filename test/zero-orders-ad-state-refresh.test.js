'use strict';

/**
 * 0 单正常流：_pollShop 与只读状态观测（规则 C，用户 2026-11-01 拍板）。
 *
 * 旧口径（2026-10-27：0 单与正单同一公式 + 50 元保护线）自规则 C 起废止，本文件验证：
 * 1. 0 单任何费用：zero_order_no_pause 零动作，仍做一次真实只读状态观测；
 * 2. on/off/mixed 如实落账，绝不因 0 单触发开启/暂停（含 50.01 元旧口径会暂停的用例）；
 * 3. mixed + 0 单：合法零动作、未安排收敛 → ok（不再是 pending）；
 * 4. 真实读取失败仍 blocked + 完整原因；unknown 仍 unknown_blocked；
 * 5. 其他数据阻断（身份等）不新增状态读；配置/落盘路径不变。
 *
 * 全部隔离：临时目录 + 合成假 Cookie + 注入 readAdState/Coordinator/Orchestrator；
 * 不启动浏览器/调度器，不访问网络，不读生产路径。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Monitor } = require('../src/engine/monitor');
const { evaluateWholeShopCostPerOrder } = require('../src/engine/rules');
const { decideAdSwitchAction, DECISION } = require('../src/engine/ad-switch-decision');
const { makeTempDir, writeTempCookie, makeCfgResult, makeClock } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-jianshang', name: '简尚', cookieFile: '简尚', enabled: true };

function normalZeroData(nowMs, { costCents = 1200, businessDate = '2026-10-26' } = {}) {
  const fetchedAt = new Date(nowMs).toISOString();
  const evaluation = evaluateWholeShopCostPerOrder({ costCents, orders: 0, thresholdCents: 100 });
  return {
    ok: true,
    rechecked: 0,
    cost: { source: 'mock', businessDate, fetchedAt, rawText: null, valueCents: costCents, pageUpdatedAt: null },
    orders: { source: 'mock', businessDate, fetchedAt, rawText: null, valueCount: 0, pageUpdatedAt: null },
    evaluation,
  };
}

/**
 * 构造真实 Monitor（不 start()）。coordinator 返回正常 0 单数据；readAdState 按序返回；
 * switchOrchestrator 使用真实 decideAdSwitchAction 判定，但 runSwitchAction 被拦截，
 * 证明规则 C 的 0 单（任何费用）只到观察决策层，绝不真正派发（mocked controller only）。
 */
function setup(t, { costCents = 1200, readResults, coordOverride = null } = {}) {
  const cookieDir = makeTempDir('pg-zo-cookies-');
  const dataDir = makeTempDir('pg-zo-data-');
  const cookieWorkDir = makeTempDir('pg-zo-work-');
  t.after(() => {
    const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep;
    for (const dir of [cookieDir, dataDir, cookieWorkDir]) {
      assert.ok(fs.realpathSync(dir).startsWith(tempRoot), 'cleanup stays inside the test temp root');
    }
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(cookieWorkDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, SHOP.cookieFile);
  const cfgResult = makeCfgResult({
    cookieDir,
    cookieWorkDir,
    shops: [SHOP],
    execution: { realMode: false, dryRun: true },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const clock = makeClock(shanghaiMs('2026-10-26', '10:00'));

  const coord = coordOverride || {
    readAndEvaluateCalls: 0,
    async readAndEvaluate() {
      this.readAndEvaluateCalls += 1;
      return normalZeroData(clock.now(), { costCents });
    },
  };

  let readCalls = 0;
  const readAdState = async () => {
    readCalls += 1;
    const r = readResults[Math.min(readCalls - 1, readResults.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };

  let evalCalls = 0;
  let runCalls = 0;
  const actionCalls = [];
  const switchOrchestrator = {
    evaluatePeriodic(p) {
      evalCalls += 1;
      return decideAdSwitchAction({
        costCents: p.costCents,
        orders: p.orders,
        thresholdCents: p.thresholdCents,
        currentAdState: p.currentAdState,
        identityOk: p.identityOk === true,
      });
    },
    runSwitchAction(p) {
      runCalls += 1;
      actionCalls.push(p.action);
      return {
        action: p.action,
        actionId: 'mock-action-1',
        serial: 'not_sent',
        zeroClick: true,
        decision: DECISION.SHOULD_PAUSE,
        reason: '测试注入：mocked controller only，未真实派发任何开关',
      };
    },
    hasUnknownBlock: () => false,
    peek: () => null,
    pendingMixedReconcile: () => null,
    mixedInflightProof: () => ({ inflight: 0 }),
    reconcileMixedAndReoperate: () => null,
  };

  const controller = { state: { closeCalls: [] } };
  const monitor = new Monitor(cfgResult, { controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
    readAdState,
    switchOrchestrator,
  });
  monitor._getCoordinator = () => coord;

  // 旧证据：on 观测于 60 分钟前（超过前端 35 分钟有效期）
  const oldAt = new Date(shanghaiMs('2026-10-26', '09:00')).toISOString();
  const rt = monitor._runtime(SHOP.id);
  rt.lastAdState = 'on';
  rt.adStateObservedAt = oldAt;
  rt.adStateEvidenceKind = 'read_only';
  rt.lastDataAt = oldAt;

  return {
    monitor, clock, coord, rt, oldAt, controller,
    counts: { read: () => readCalls, eval: () => evalCalls, run: () => runCalls, actions: () => actionCalls },
    poll: () => monitor._pollShop(SHOP, { aborted: false, kind: 'pause' }, 'manual'),
  };
}

const ON_READ = { state: 'on', rows: [{ id: 'p1', switchChecked: true }], identity: { ok: true }, balance: null };
const OFF_READ = { state: 'off', rows: [{ id: 'p1', switchChecked: false }], identity: { ok: true }, balance: null };
const MIXED_READ = { state: 'mixed', rows: [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: false }], identity: { ok: true }, balance: null };
const FAILED_READ = { state: 'unknown', error: { status: 'blocked', reason: '回读失败：模拟清单不完整', blocked: 'inventory' } };

test('0 单 + 12.00 元：规则 C 判定 zero_order_no_pause，仍做一次只读观测，零动作', async (t) => {
  const { monitor, clock, rt, counts, poll } = setup(t, { costCents: 1200, readResults: [ON_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.decision, DECISION.ZERO_ORDER_NO_PAUSE);
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.spendProtected, false, '无消耗门槛（D55）：spendProtected 恒 false');
  assert.strictEqual(res.pauseEligible, false, '0 单无暂停资格');
  assert.strictEqual(res.blocked, undefined, '正常 0 单不得带 blocked');
  assert.strictEqual(counts.read(), 1, '恰好一次只读状态观测');
  assert.strictEqual(counts.eval(), 1, '正常进入决策（规则 C 0 单观察分支）');
  assert.strictEqual(counts.run(), 0, '不得进入任何开关动作');

  const nowIso = new Date(clock.now()).toISOString();
  assert.strictEqual(rt.lastAdState, 'on', 'on 来自本轮真实回读');
  assert.strictEqual(rt.adStateObservedAt, nowIso, '观测时间推进到本轮真实时钟');
  assert.strictEqual(rt.lastDataAt, nowIso, 'lastDataAt 同步推进');
  assert.strictEqual(rt.lastReadError, null);
  assert.strictEqual(rt.lastData.blockedReason, undefined, '正常 0 单不产生 blockedReason');
  assert.strictEqual(monitor.triggers.length, 0, '零触发记录');
  assert.strictEqual(monitor.actions.length, 0, '零广告动作');
});

test('0 单读到 off：如实记 off，绝不因 0 单触发开启', async (t) => {
  const { rt, counts, poll } = setup(t, { costCents: 1200, readResults: [OFF_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.decision, DECISION.ZERO_ORDER_NO_PAUSE);
  assert.strictEqual(rt.lastAdState, 'off', 'off 如实落账');
  assert.strictEqual(counts.run(), 0, 'off 绝不触发开启/暂停');
  assert.strictEqual(rt.lastData.blockedReason, undefined);
});

test('0 单读到 mixed：如实落账 mixed，规则 C 合法零动作 → ok（未安排收敛）', async (t) => {
  const { rt, counts, poll } = setup(t, { costCents: 1200, readResults: [MIXED_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'ok', 'mixed + 0 单合法零动作：本轮未安排任何收敛动作 → ok');
  assert.strictEqual(res.pending, undefined, '不再 pending：规则 C 0 单没有待执行收敛');
  assert.strictEqual(res.decision, DECISION.ZERO_ORDER_NO_PAUSE);
  assert.strictEqual(res.currentAdState, 'mixed');
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(rt.lastAdState, 'mixed');
  assert.strictEqual(counts.run(), 0);
  assert.strictEqual(rt.lastData.blockedReason, undefined, 'mixed 不是数据错误，不得写成 blockedReason');
});

test('0 单读取失败：unknown + 完整原因可见，不用旧 on 保绿；本轮有效数据仍原子提交', async (t) => {
  const { rt, clock, counts, poll } = setup(t, { costCents: 1200, readResults: [FAILED_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'inventory');
  assert.match(res.reason, /模拟清单不完整/, '真实读取失败原因可见');
  assert.strictEqual(rt.lastAdState, 'unknown', '失败不得保留旧 on');
  assert.ok(rt.lastReadError, '写入结构化读取失败');
  assert.match(String(rt.lastReadError.reason), /模拟清单不完整/);
  // 已提交的竞态修正行为：状态读取失败时本轮有效费用/订单数据仍先原子提交，lastDataAt 推进；
  // 但广告状态证据被撤销（lastAdState=unknown），且不进入决策/动作。
  assert.strictEqual(rt.lastDataAt, new Date(clock.now()).toISOString(), '本轮数据原子提交，lastDataAt 推进');
  assert.strictEqual(counts.eval(), 0, '状态回读失败在决策之前返回，不进入 evaluatePeriodic');
  assert.strictEqual(counts.run(), 0);
});

test('readAdState 抛错走真实失败路径，不得吞成成功', async (t) => {
  const { rt, counts, poll } = setup(t, { costCents: 1200, readResults: [new Error('炸读：opener 异常')] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(rt.lastAdState, 'unknown');
  assert.match(String(rt.lastReadError.reason), /炸读/);
  assert.strictEqual(counts.read(), 1);
  assert.strictEqual(counts.run(), 0);
});

// 规则 C 关键回归：旧口径（>50 元 + 0 单 + on → should_pause）已废止；0 单任何费用只观察。
test('0 单 + 50.01 元 + on：规则 C 仍 zero_order_no_pause（旧口径会 should_pause），零真实动作', async (t) => {
  const { monitor, controller, counts, poll } = setup(t, { costCents: 5001, readResults: [ON_READ] });
  const res = await poll();

  assert.strictEqual(res.decision, DECISION.ZERO_ORDER_NO_PAUSE);
  assert.strictEqual(res.action, undefined, '0 单无任何动作');
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.pauseEligible, false, '0 单无暂停资格，即使费用超过旧 50 元保护线');
  assert.strictEqual(res.roiTooLow, false);
  assert.strictEqual(counts.eval(), 1);
  assert.strictEqual(counts.run(), 0, '0 单绝不进入动作入口');
  assert.deepStrictEqual(counts.actions(), []);
  assert.strictEqual(controller.state.closeCalls.length, 0, 'mocked controller only：没有真实关闭调用');
  assert.strictEqual(monitor.triggers.length, 0, '零触发记录');
  assert.strictEqual(monitor.actions.length, 0, '无执行批次');
});

test('0 单 + 50.01 元 + unknown：unknown_blocked，零点击零动作', async (t) => {
  const { counts, poll } = setup(t, { costCents: 5001, readResults: [{ state: 'unknown', rows: [], identity: { ok: true } }] });
  const res = await poll();

  assert.strictEqual(res.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(res.zeroClick, true);
  assert.strictEqual(res.pauseEligible, false, '状态未知不保留暂停资格/ROI 提示');
  assert.strictEqual(res.roiTooLow, false);
  assert.strictEqual(counts.run(), 0);
});

test('其他数据阻断（身份等）不新增状态读，旧观测不被触碰', async (t) => {
  const coordOverride = {
    async readAndEvaluate() {
      return {
        ok: false, blocked: 'identity', reason: '店铺身份不一致',
        cost: normalZeroData(0).cost,
        orders: normalZeroData(0).orders,
      };
    },
  };
  const { monitor, rt, oldAt, counts, poll } = setup(t, { readResults: [ON_READ], coordOverride });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'identity');
  assert.strictEqual(counts.read(), 0, '非正常数据路径不新增只读状态读');
  assert.strictEqual(rt.lastAdState, 'on', '旧观测不被触碰');
  assert.strictEqual(rt.adStateObservedAt, oldAt);
  assert.match(String(monitor.getStatus().shops[0].today.blockedReason), /身份不一致/);
});

test('配置与落盘路径不受影响：阈值/ROI 规则不变，zeroOrderRecheck 配置字段保留，state/audit 全在临时目录', async (t) => {
  const { monitor, poll } = setup(t, { costCents: 1200, readResults: [ON_READ] });
  const ruleBefore = JSON.stringify(monitor.config.rules);
  const thresholdBefore = monitor._thresholdCents(SHOP);
  const recheckBefore = monitor.config.execution.zeroOrderRecheck;
  await poll();

  assert.strictEqual(JSON.stringify(monitor.config.rules), ruleBefore, '不改 ROI/阈值规则');
  assert.strictEqual(monitor._thresholdCents(SHOP), thresholdBefore);
  assert.strictEqual(monitor.config.execution.zeroOrderRecheck, recheckBefore, '旧配置字段原样保留，不迁移');
  assert.ok(monitor.stateFile.includes('pg-zo-data-'), 'state 落临时目录');
  assert.ok(monitor.auditFile.includes('pg-zo-data-'), 'audit 落临时目录');
  assert.ok(monitor.config.login.cookieWorkDir.includes('pg-zo-work-'), 'login 工作目录为本测试临时目录');
  assert.strictEqual(monitor.running, false, '未启动调度器');
});
