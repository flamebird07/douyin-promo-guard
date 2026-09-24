'use strict';

/**
 * 值守主链路 fixture 集成测试：决策层 + 串行门外层接入（隔离 mock）。
 *
 * 边界：
 * - 不启动服务、不登录、不访问真实广告页面；
 * - 不调用飞书、不暂停/开启真实广告、不发通知；
 * - 不修改生产配置、不提交 Git、不推送；
 * - execute 为 mock（复用契约），**不是**真实 07:00 / 真实页面集成验证。
 *
 * 覆盖：
 * - 低于阈值 + 回读 off → enable 流程一次；回读 on → 零点击
 * - 高于阈值 + 回读 on → pause 流程一次；回读 off → 零点击
 * - 等于阈值 / unknown / 身份失败 / 数据异常 → 零点击
 * - 07:00 enable 与周期 enable/pause 并发：第二个被门阻止
 * - 动作回读失败后下一周期不补点
 * - 旧 actionId 不影响新动作
 * - dryRun/realMode 门禁仍有效（execute 被调用前决策/门已拦截或 execute 契约返回 neverSent）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  AdSwitchOrchestrator,
  createSwitchSerialGate,
  SETTLE_KIND,
  DECISION,
} = require('../src/engine/ad-switch-orchestrator');
const { mapAdStateFromSwitchRows, mapAdStateFromAdList } = require('../src/engine/ad-switch-state');
const { decideAdSwitchAction } = require('../src/engine/ad-switch-decision');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock,
} = require('./helpers');
const fs = require('fs');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: '1710242295996424', enabled: true };
const IDENTITY = { id: 'shop-001', name: '测试店铺一', accountId: '1710242295996424' };
const TH = 100;

// ── 状态映射（页面/清单回读 → on/off/unknown）─────────────────────

test('映射：全部开启→on；全部关闭→off；混合→mixed；空清单需空态证据', () => {
  assert.strictEqual(mapAdStateFromSwitchRows([
    { id: 'a', switchChecked: true },
    { id: 'b', switchChecked: true },
  ]), 'on');
  assert.strictEqual(mapAdStateFromSwitchRows([
    { id: 'a', switchChecked: false },
    { id: 'b', switchChecked: false },
  ]), 'off');
  assert.strictEqual(mapAdStateFromSwitchRows([
    { id: 'a', switchChecked: true },
    { id: 'b', switchChecked: false },
  ]), 'mixed', '混合侧别是 mixed，不是 unknown 也不是 on');
  assert.strictEqual(mapAdStateFromSwitchRows([
    { id: 'a', switchChecked: true },
    { id: 'b', switchChecked: null },
  ]), 'unknown');
  assert.strictEqual(mapAdStateFromSwitchRows([], { confirmedEmpty: true }), 'off');
  assert.strictEqual(mapAdStateFromSwitchRows([], { confirmedEmpty: false }), 'unknown');
  assert.strictEqual(mapAdStateFromAdList([
    { adId: '1', switchChecked: true, status: '投放中' },
  ]), 'on');
  assert.strictEqual(mapAdStateFromAdList([
    { adId: '1', status: '神秘状态' },
  ]), 'unknown');
  assert.strictEqual(mapAdStateFromAdList([
    { adId: '1', status: '投放中' },
    { adId: '2', status: '已暂停' },
  ]), 'mixed');
});

// ── 编排器：阈值矩阵 + 生命周期 ───────────────────────────────────

function makeOrch(gate) {
  const audits = [];
  const orch = new AdSwitchOrchestrator({
    gate: gate || createSwitchSerialGate(),
    audit: (e) => audits.push(e),
  });
  return { orch, audits };
}

function periodicDecide(orch) {
  return (currentAdState) => orch.evaluatePeriodic({
    costCents: 5000,
    orders: 100,
    thresholdCents: TH,
    currentAdState,
    identityOk: true,
  });
}

function periodicDecideOver(orch) {
  return (currentAdState) => orch.evaluatePeriodic({
    costCents: 10001,
    orders: 100,
    thresholdCents: TH,
    currentAdState,
    identityOk: true,
  });
}

test('集成：低于阈值 + 回读 off → 进入 enable 流程恰好一次', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  let reads = 0;
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => { reads += 1; return 'off'; },
    decide: periodicDecide(orch),
    execute: async () => {
      executeCount += 1;
      return { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
    },
  });
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(r.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(executeCount, 1, 'enable 流程恰好一次');
  assert.ok(reads >= 2, '动作前再次回读');
  assert.strictEqual(r.serial, 'confirmed');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
});

test('集成：低于阈值 + 回读 on → 零点击（already_on，execute 不调用）', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => 'on',
    decide: periodicDecide(orch),
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.decision, DECISION.ALREADY_ON);
  assert.strictEqual(executeCount, 0);
});

test('集成：高于阈值 + 回读 on → 进入 pause 流程恰好一次', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => {
      executeCount += 1;
      return { outcome: 'all_paused_confirmed', allPausedConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
    },
  });
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(executeCount, 1, 'pause 流程恰好一次');
  assert.strictEqual(r.serial, 'confirmed');
});

test('集成：高于阈值 + 回读 off → 零点击（already_off）', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'off',
    decide: periodicDecideOver(orch),
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.decision, DECISION.ALREADY_OFF);
  assert.strictEqual(executeCount, 0);
});

test('集成：等于阈值 → 零点击（equal_no_action）', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  const decide = (currentAdState) => orch.evaluatePeriodic({
    costCents: 10000, orders: 100, thresholdCents: TH, currentAdState, identityOk: true,
  });
  for (const action of ['enable', 'pause']) {
    for (const st of ['on', 'off']) {
      const r = await orch.runSwitchAction({
        shopId: SHOP.id,
        action,
        targetState: action === 'enable' ? 'on' : 'off',
        readState: async () => st,
        decide,
        execute: async () => { executeCount += 1; return {}; },
      });
      assert.strictEqual(r.zeroClick, true, `${action}/${st}`);
      assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION);
    }
  }
  assert.strictEqual(executeCount, 0);
});

test('集成：unknown / 身份失败 / 数据异常 → 零点击', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  // unknown 状态
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'unknown',
    decide: periodicDecideOver(orch),
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r1.zeroClick, true);
  assert.strictEqual(r1.decision, DECISION.UNKNOWN_BLOCKED);

  // 身份失败
  const decideBadId = (currentAdState) => orch.evaluatePeriodic({
    costCents: 10001, orders: 100, thresholdCents: TH, currentAdState, identityOk: false,
  });
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: decideBadId,
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r2.zeroClick, true);
  assert.strictEqual(r2.decision, DECISION.DATA_BLOCKED);

  // 数据异常
  const decideErr = (currentAdState) => orch.evaluatePeriodic({
    costCents: 10001, orders: 100, thresholdCents: TH, currentAdState, identityOk: true, dataError: 'parse',
  });
  const r3 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: decideErr,
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r3.zeroClick, true);
  assert.strictEqual(r3.decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(executeCount, 0);
});

test('集成：07:00 enable 与周期 enable/pause 并发时第二个被门阻止', async () => {
  const { orch } = makeOrch();
  let enableExec = 0;
  let pauseExec = 0;
  let releaseEnable;
  const enableGate = new Promise((res) => { releaseEnable = res; });

  const p1 = orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => 'off',
    decide: (st) => orch.evaluateDailyEnable({ currentAdState: st, identityOk: true }),
    execute: async () => {
      enableExec += 1;
      await enableGate;
      return { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true };
    },
  });
  // 等第一个进入 execute（已 tryBegin）
  await new Promise((r) => setTimeout(r, 5));

  const p2 = orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => { pauseExec += 1; return {}; },
  });
  const r2 = await p2;
  assert.strictEqual(r2.blocked, 'serial_gate', '并发第二个必须被串行门阻止');
  assert.strictEqual(pauseExec, 0);

  const p3 = orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => 'off',
    decide: (st) => orch.evaluateDailyEnable({ currentAdState: st, identityOk: true }),
    execute: async () => { enableExec += 1; return {}; },
  });
  const r3 = await p3;
  assert.strictEqual(r3.blocked, 'serial_gate', '同店同向并发同样被门阻止');
  assert.strictEqual(enableExec, 1);

  releaseEnable();
  const r1 = await p1;
  assert.strictEqual(r1.serial, 'confirmed');
  assert.strictEqual(enableExec, 1);
});

test('集成：动作回读失败后下一周期不补点（unknown 阻塞）', async () => {
  const { orch } = makeOrch();
  let executeCount = 0;
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => {
      executeCount += 1;
      return { outcome: 'partial', allPausedConfirmed: false, reason: '回读失败，结果未知' };
    },
  });
  assert.strictEqual(r1.serial, 'unknown');
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true);
  assert.strictEqual(executeCount, 1);

  // 下一周期：仍 should_pause，但门必须拒绝（不补点）
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r2.blocked, 'serial_gate');
  assert.strictEqual(executeCount, 1, '下一周期不得补点');
});

test('集成：unknown 仅 confirmed:true 回读可恢复；旧 actionId 不影响新动作', async () => {
  const { orch } = makeOrch();
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'partial', reason: 'timeout' }),
  });
  const oldId = r1.actionId;
  assert.strictEqual(r1.serial, 'unknown');

  // 缺参/false 不释放
  assert.strictEqual(orch.resolveUnknownWithReadback(SHOP.id, oldId, {}).ok, false);
  assert.strictEqual(orch.resolveUnknownWithReadback(SHOP.id, oldId, { confirmed: false }).ok, false);
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true);

  // confirmed:true 恢复
  const ok = orch.resolveUnknownWithReadback(SHOP.id, oldId, { confirmed: true, note: '只读回读已确认目标状态' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(orch.isBusy(SHOP.id), false);

  // 新动作
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => 'off',
    decide: periodicDecide(orch),
    execute: async () => ({ outcome: 'all_enabled_confirmed', allEnabledConfirmed: true }),
  });
  const neuId = r2.actionId;
  assert.notStrictEqual(neuId, oldId);
  assert.strictEqual(r2.serial, 'confirmed');

  // 旧 actionId 回调不影响新动作（新动作已结束；旧回调应失败）
  assert.strictEqual(orch.gate.markConfirmed(SHOP.id, oldId).ok, false);
  assert.strictEqual(orch.gate.markNotSent(SHOP.id, oldId).ok, false);
  assert.strictEqual(orch.gate.resolveUnknownAfterReadback(SHOP.id, oldId, { confirmed: true }).ok, false);
});

test('集成：动作前复核状态已变化 → markNotSent，零点击', async () => {
  const { orch } = makeOrch();
  let n = 0;
  let executeCount = 0;
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => {
      n += 1;
      return n === 1 ? 'on' : 'off'; // 第二次回读已关闭
    },
    decide: periodicDecideOver(orch),
    execute: async () => { executeCount += 1; return {}; },
  });
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.decision, DECISION.ALREADY_OFF);
  assert.strictEqual(executeCount, 0);
  assert.strictEqual(orch.isBusy(SHOP.id), false);
});

test('集成：execute 契约 neverSent（dryRun/realMode 门禁）→ markNotSent，不占用槽位', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    // 模拟 runner 集中门槛拒绝 / 演练：明确未发出
    execute: async () => ({ outcome: 'blocked', neverSent: true, reason: 'execution.realMode 未开启（演练模式不执行真实暂停）' }),
  });
  assert.strictEqual(r.serial, 'not_sent');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
  // 门释放后可再次 begin
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'dry', dryRun: true, neverSent: true }),
  });
  assert.strictEqual(r2.serial, 'not_sent');
});

test('集成：重启恢复——未结束动作导入为 unknown 阻塞，不把未知写成成功', () => {
  const gate1 = createSwitchSerialGate();
  const a = gate1.tryBegin('shop-001', 'pause');
  assert.strictEqual(a.ok, true);
  gate1.markUnknown('shop-001', a.actionId, '回读失败');
  const state = gate1.exportState();

  const gate2 = createSwitchSerialGate({ state });
  assert.strictEqual(gate2.hasUnknownBlock('shop-001'), true, '重启后必须恢复为 unknown 阻塞');
  assert.strictEqual(gate2.tryBegin('shop-001', 'pause').ok, false, '禁止补点');
  assert.strictEqual(gate2.peek('shop-001').confirmed, false, '不得把未知写成成功');

  // settled 槽不导入
  const gate3 = createSwitchSerialGate({
    state: { slots: [{ shopId: 's2', action: 'enable', actionId: 'x', settled: true, confirmed: true }] },
  });
  assert.strictEqual(gate3.isBusy('s2'), false);
});

test('集成：日程开启意图——on 跳过 / off 开启 / unknown 阻止；adBelief 不参与决策', async () => {
  const { orch } = makeOrch();
  assert.strictEqual(orch.evaluateDailyEnable({ currentAdState: 'on', identityOk: true }).decision, DECISION.ALREADY_ON);
  assert.strictEqual(orch.evaluateDailyEnable({ currentAdState: 'off', identityOk: true }).decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(orch.evaluateDailyEnable({ currentAdState: 'unknown', identityOk: true }).decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(orch.evaluateDailyEnable({ currentAdState: 'off', identityOk: false }).decision, DECISION.DATA_BLOCKED);
});

// ── Monitor 主链路 fixture 集成（mock 适配器 + 注入 readAdState/execute）────

async function setupMonitor(t, { costCents, orders = 100, adState = 'on', realMode = false, execution = {}, monitorExt = {} } = {}) {
  const cookieDir = makeTempDir('sw-ck-');
  const dataDir = makeTempDir('sw-data-');
  t.after(() => {
    try { mon.stopEnableScheduler({ byUser: false, reason: 'cleanup' }); } catch (_) {}
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: Object.assign({ realMode, dryRun: !realMode, readbackTimeoutMs: 200, readbackIntervalMs: 1 }, execution),
    monitor: Object.assign({
      chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true },
    }, monitorExt),
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  // 固定时钟：费用/订单/广告状态回读与 Monitor 必须共享同一 nowFn（禁止真实墙钟）
  const nowFn = () => shanghaiMs('2026-09-12', '08:30');
  const reader = makeLinkedReader(controller, {
    costCents, orders, pageSource: 'promo-page', costAccountId: IDENTITY.accountId,
  }, nowFn);
  const calls = { enable: 0, pause: 0, readState: 0 };
  let stateRef = adState;
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn,
    readAdState: async () => { calls.readState += 1; return stateRef; },
  });
  // 注入 execute 契约（复用 runner 返回形状；不启动浏览器/不点真实页面）
  mon._executeEnableBatchFor = async () => {
    calls.enable += 1;
    return {
      outcome: 'all_enabled_confirmed',
      allEnabledConfirmed: true,
      actionType: 'enable',
      counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      targets: [{ view: '全店托管', planId: 'p1' }],
    };
  };
  const origPoll = mon._pollChengfangOver.bind(mon);
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return {
      status: 'ok',
      over: true,
      batch: {
        actionType: 'pause',
        outcome: 'all_paused_confirmed',
        allPausedConfirmed: true,
        counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
        targets: [{ view: '全店托管', planId: 'p1' }],
      },
    };
  };
  void origPoll;
  return {
    mon, calls, controller, reader,
    setAdState: (s) => { stateRef = s; },
  };
}

test('主链路集成：低于阈值 + 回读 off → 周期评估进入 enable 流程一次', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 5000, adState: 'off' });
  const r = await mon.pollOnce('test');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.results[0].decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(r.results[0].zeroClick, false);
  assert.strictEqual(calls.enable, 1, 'enable 流程恰好一次');
  assert.strictEqual(calls.pause, 0);
  const j = mon.judgements[mon.judgements.length - 1];
  assert.strictEqual(j.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(j.currentAdState, 'off');
});

test('主链路集成：低于阈值 + 回读 on → 零点击', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 5000, adState: 'on' });
  const r = await mon.pollOnce('test');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(r.results[0].decision, DECISION.ALREADY_ON);
  assert.strictEqual(calls.enable, 0);
  assert.strictEqual(calls.pause, 0);
});

test('主链路集成：高于阈值 + 回读 on → 周期评估进入 pause 流程一次', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'on' });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(calls.pause, 1, 'pause 流程恰好一次');
  assert.strictEqual(calls.enable, 0);
});

test('主链路集成：高于阈值 + 回读 off → 零点击', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'off' });
  mon._pollChengfangOver = async () => ({
    status: 'ok',
    over: true,
    batch: {
      actionType: 'pause',
      outcome: 'nothing_to_close',
      counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      alreadyClosedCount: 0,
    },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].zeroClick, true, '盘点无动作必须 zeroClick');
  assert.strictEqual(r.results[0].decision, DECISION.ALREADY_OFF);
  assert.strictEqual(calls.pause, 0, '底层暂停开关调用为 0');
  assert.strictEqual(calls.enable, 0);
  assert.strictEqual(mon.actions.length, 0, '盘点无动作不进已执行 actions');
  assert.ok(r.results[0].reason || r.results[0].batch, '保留盘点结果/原因');
  assert.strictEqual(r.results[0].serial, 'not_sent');
});

test('主链路集成：等于阈值 → 零点击', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10000, adState: 'on' });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(r.results[0].decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(calls.pause, 0);
  assert.strictEqual(calls.enable, 0);
});

test('主链路集成：回读 unknown → 零点击', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'unknown' });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(r.results[0].decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(calls.pause, 0);
});

test('主链路集成：动作回读失败（partial）→ 下一周期不补点', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'on' });
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return {
      status: 'ok',
      over: true,
      batch: {
        actionType: 'pause',
        outcome: 'partial',
        allPausedConfirmed: false,
        reason: '回读失败，结果未知',
        counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 },
      },
    };
  };
  const r1 = await mon.pollOnce('interval');
  assert.strictEqual(r1.results[0].serial, 'unknown');
  assert.strictEqual(calls.pause, 1);

  const r2 = await mon.pollOnce('interval');
  assert.strictEqual(r2.results[0].blocked, 'serial_gate');
  assert.strictEqual(calls.pause, 1, '下一周期不得补点');
  assert.ok(mon._switchOrchestrator.hasUnknownBlock(SHOP.id));
});

test('主链路集成：dryRun/realMode 门禁——execute 返回 neverSent 时串行门释放且不计成功', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'on', realMode: false });
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return {
      status: 'blocked',
      reason: 'execution.realMode 未开启（演练模式不执行真实暂停）',
      batch: { outcome: 'blocked', reason: 'realMode 未开启' },
    };
  };
  const r = await mon.pollOnce('interval');
  assert.strictEqual(calls.pause, 1);
  assert.strictEqual(r.results[0].serial, 'not_sent');
  assert.strictEqual(mon._switchOrchestrator.isBusy(SHOP.id), false);
});

test('主链路集成：07:00 日程开启与周期 pause 并发 → 第二个被串行门阻止', async (t) => {
  // 真实意图：每日开启与值守周期动作不能并发。
  // 装配要点：同一 shopId + 同一串行门（Monitor 内 _switchOrchestrator.gate）；
  // 07:00 走 evaluateDailyEnable（回读 off → should_enable）先占门；
  // 周期走 evaluatePeriodic（回读 on + 高于阈值 → should_pause）再撞门。
  // 不改变生产规则「低于阈值 + on = already_on」。
  const { mon, calls, setAdState } = await setupMonitor(t, { costCents: 10001, adState: 'off' });
  assert.strictEqual(mon._switchOrchestrator.gate, mon._switchGate, '必须共用同一串行门实例');

  let release;
  const hold = new Promise((res) => { release = res; });
  mon._executeEnableBatchFor = async () => {
    calls.enable += 1;
    await hold; // 07:00 开启已 tryBegin 并占门
    return { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, actionType: 'enable', counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
  };

  // 路径 A：07:00 日程开启（_runShopEnablePhase → evaluateDailyEnable）
  setAdState('off');
  const pEnable = mon._runShopEnablePhase(SHOP, { aborted: false }, '2026-09-12');
  // 等 enable 真正进入 execute（已登记 actionId、占用同店槽位）
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(calls.enable, 1, '07:00 开启应已进入 execute');
  assert.strictEqual(mon._switchOrchestrator.isBusy(SHOP.id), true, '同店串行门应已被 enable 占用');

  // 路径 B：值守周期 pause（同一 shopId、同一门；高于阈值 + 回读 on → should_pause）
  setAdState('on');
  const busyBefore = mon._switchOrchestrator.peek(SHOP.id);
  assert.ok(busyBefore && busyBefore.actionId, '竞争期间应能读到占用槽 actionId');
  const pPause = mon._runShopSwitchAction(SHOP, 'pause', {
    cost: { valueCents: 10001, businessDate: '2026-09-12' },
    orders: { valueCount: 100 },
    evaluation: { reason: 'over' },
  }, { aborted: false }, 'interval');
  const rPause = await pPause;
  assert.strictEqual(rPause.blocked, 'serial_gate', '同店并发第二个必须被串行门拒绝');
  assert.strictEqual(rPause.zeroClick, true, '串行门拒绝仍为零点击');
  assert.ok(rPause.reason, '必须保留拒绝原因');
  // 竞争期间 inflight.actionId 必须与当时占用槽一致（不是释放后再 peek）
  assert.strictEqual(rPause.inflight && rPause.inflight.actionId, busyBefore.actionId,
    '拒绝结果 inflight.actionId 应与占用槽 actionId 一致');
  assert.strictEqual(calls.pause, 0, '被拒路径不得进入 pause execute');

  release();
  const rEnable = await pEnable;
  assert.strictEqual(calls.enable, 1, '日程开启 execute 恰好一次');
  assert.ok(rEnable.actionId, '开启路径应带 actionId');
  assert.strictEqual(rEnable.enable && rEnable.enable.serial, 'confirmed', '开启经回读确认后释放');
  assert.strictEqual(calls.pause, 0);
  // 生命周期：放行并确认后槽位清理（不得用「释放后仍 peek 到 actionId」证明）
  assert.strictEqual(mon._switchOrchestrator.isBusy(SHOP.id), false, '开启确认后释放槽位');
  assert.strictEqual(mon._switchOrchestrator.peek(SHOP.id), null, '释放后 peek 应为 null');
});

test('主链路集成：旧 actionId 回调不影响新动作（经 Monitor 串行门）', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 10001, adState: 'on' });
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return { status: 'ok', over: true, batch: { actionType: 'pause', outcome: 'partial', allPausedConfirmed: false, reason: 'timeout', counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 } } };
  };
  const r1 = await mon.pollOnce('interval');
  const oldId = r1.results[0].actionId;
  assert.strictEqual(r1.results[0].serial, 'unknown');

  // 用 confirmed:true 回读恢复后开新动作
  mon._switchOrchestrator.resolveUnknownWithReadback(SHOP.id, oldId, { confirmed: true });
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return { status: 'ok', over: true, batch: { actionType: 'pause', outcome: 'all_paused_confirmed', allPausedConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } } };
  };
  const r2 = await mon.pollOnce('interval');
  const neuId = r2.results[0].actionId;
  assert.notStrictEqual(neuId, oldId);
  assert.strictEqual(r2.results[0].serial, 'confirmed');
  // 旧 actionId 不能再影响
  assert.strictEqual(mon._switchGate.markConfirmed(SHOP.id, oldId).ok, false);
  assert.strictEqual(mon._switchGate.markNotSent(SHOP.id, oldId).ok, false);
});

test('决策层单测契约：metric 与 decision 分离（与 orchestrator.evaluatePeriodic 一致）', () => {
  const { orch } = makeOrch();
  const r = orch.evaluatePeriodic({
    costCents: 10001, orders: 100, thresholdCents: TH, currentAdState: 'on', identityOk: true,
  });
  assert.strictEqual(r.metric, 'above_threshold');
  assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE);
  const d = decideAdSwitchAction({
    costCents: 5000, orders: 100, thresholdCents: TH, currentAdState: 'off', identityOk: true,
  });
  assert.strictEqual(d.metric, 'below_threshold');
  assert.strictEqual(d.decision, DECISION.SHOULD_ENABLE);
});

// ── mixed / 门禁优先级 / 批次单次记录（G1–G3 补充）────────────────

test('mixed 目标筛选语义：above+mixed 进 pause；below+mixed 进 enable；equal+mixed 零动作', async () => {
  const { orch } = makeOrch();
  let pauseExec = 0;
  let enableExec = 0;
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'mixed',
    decide: periodicDecideOver(orch),
    execute: async () => { pauseExec += 1; return { outcome: 'all_paused_confirmed', allPausedConfirmed: true }; },
  });
  assert.strictEqual(r1.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(pauseExec, 1, 'above+mixed 进入 pause（执行器只停 on 项）');

  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'enable', targetState: 'on',
    readState: async () => 'mixed',
    decide: periodicDecide(orch),
    execute: async () => { enableExec += 1; return { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true }; },
  });
  assert.strictEqual(r2.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(enableExec, 1, 'below+mixed 进入 enable（执行器只开 off 项）');

  const r3 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'mixed',
    decide: (st) => orch.evaluatePeriodic({ costCents: 10000, orders: 100, thresholdCents: TH, currentAdState: st, identityOk: true }),
    execute: async () => { pauseExec += 1; return {}; },
  });
  assert.strictEqual(r3.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(pauseExec, 1, 'equal+mixed 零动作');
});

test('门禁优先级：无控制范围 → blocked（不因 already_off 包成 ok）', async (t) => {
  const { mon, calls } = await setupMonitor(t, {
    costCents: 10001, adState: 'off',
    monitorExt: { chengfang: undefined, legacyWholeShopCloseEnabled: undefined },
  });
  // 覆盖为无 scope 且无 legacy
  mon.config.monitor = {};
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /未配置乘方控制范围/);
  assert.strictEqual(calls.pause, 0);
  assert.strictEqual(calls.enable, 0);
});

test('门禁优先级：超标 + 07:59 → window_blocked（不因 already_off/mixed 包成 ok）', async (t) => {
  const clockNow = shanghaiMs('2026-09-12', '07:59');
  const cookieDir = makeTempDir('sw-ck-');
  const dataDir = makeTempDir('sw-data-');
  t.after(() => {
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: { realMode: true, dryRun: false, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true } },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const nowFn = () => clockNow;
  const reader = makeLinkedReader(controller, {
    costCents: 10001, orders: 100, pageSource: 'promo-page', costAccountId: IDENTITY.accountId,
  }, nowFn);
  let exec = 0;
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn,
    readAdState: async () => 'off', // already_off 也不得吞掉 window_blocked
  });
  mon._pollChengfangOver = async () => { exec += 1; return { status: 'ok', batch: {} }; };
  mon._executeEnableBatchFor = async () => { exec += 1; return { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true }; };
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'window_blocked');
  assert.match(r.results[0].reason, /08:00/);
  assert.strictEqual(exec, 0, '窗口外不打开执行会话');
});

test('门禁优先级：清单身份失败 → blocked（不包成 ok/unknown 零点击）', async (t) => {
  const cookieDir = makeTempDir('sw-ck-');
  const dataDir = makeTempDir('sw-data-');
  t.after(() => {
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP], // SHOP.accountId 已配置
    execution: { realMode: true, dryRun: false, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const nowFn = () => shanghaiMs('2026-09-12', '08:30');
  const reader = makeLinkedReader(controller, {
    costCents: 10001, orders: 100, pageSource: 'promo-page',
    // 费用/订单源身份与配置匹配（否则会在 readAndEvaluate 先 stopped，走不到清单）
    costAccountId: IDENTITY.accountId,
    orderAccountId: undefined, // 订单源不强制账户
    adsShopId: 'shop-002', // 故意：广告清单店铺身份不匹配 → 应在清单核验 blocked
  }, nowFn);
  let enableExec = 0;
  let pauseExec = 0;
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn,
  });
  mon._executeEnableBatchFor = async () => { enableExec += 1; return {}; };
  mon._pollChengfangOver = async () => { pauseExec += 1; return { status: 'ok', batch: {} }; };
  mon._pollLegacyWholeShopOver = async () => { pauseExec += 1; return { status: 'ok', batch: {} }; };
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /身份/);
  assert.strictEqual(enableExec, 0, '清单身份失败不得进入 enable');
  assert.strictEqual(pauseExec, 0, '清单身份失败不得进入 pause');
});

test('批次单次记录：enable 成功只记一条 actions；blocked 不进 actions', async (t) => {
  const { mon, calls } = await setupMonitor(t, { costCents: 5000, adState: 'off' });
  await mon.pollOnce('test');
  assert.strictEqual(calls.enable, 1);
  assert.strictEqual(mon.actions.length, 1, '成功开启批次只记录一次 actions');
  assert.strictEqual(mon.actions[0].actionType, 'enable');

  // blocked 不进 actions
  const { mon: mon2, calls: calls2 } = await setupMonitor(t, { costCents: 5000, adState: 'off' });
  mon2._executeEnableBatchFor = async () => {
    calls2.enable += 1;
    return { outcome: 'blocked_window', reason: '窗口外', counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
  };
  await mon2.pollOnce('test');
  assert.strictEqual(mon2.actions.length, 0, 'blocked_window 不进已执行 actions');
});

// ── legacy all_closed_confirmed 与串行门映射（严格结果码）────────

// ── 执行结果契约 → 串行门（统一分类，禁止模糊字符串）────────────────

const { classifyExecuteResult, NEVER_SENT_OUTCOMES } = require('../src/engine/ad-switch-orchestrator');

test('结果契约：classifyExecuteResult 三类收口', () => {
  // 已执行且回读确认
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'all_closed_confirmed', allClosedConfirmed: true }), 'confirmed');
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'all_paused_confirmed', allPausedConfirmed: true }), 'confirmed');
  assert.strictEqual(classifyExecuteResult('enable', { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true }), 'confirmed');
  // 未发出 / 完整核验无目标
  for (const o of ['blocked', 'blocked_window', 'blocked_stopped', 'blocked_coverage', 'cancelled', 'dry', 'dry_failed', 'nothing_to_close', 'nothing_to_pause', 'nothing_to_enable']) {
    assert.strictEqual(classifyExecuteResult('pause', { outcome: o }), 'never_sent', o);
    assert.ok(NEVER_SENT_OUTCOMES.has(o));
  }
  assert.strictEqual(classifyExecuteResult('enable', { outcome: 'nothing_to_enable', neverSent: false }), 'never_sent');
  // 可能已发出、未确认
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'partial' }), 'unknown');
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'all_closed_str_in_name_only' }), 'unknown', '禁止模糊匹配');
  assert.strictEqual(classifyExecuteResult('enable', { outcome: 'all_closed_confirmed', allClosedConfirmed: true }), 'unknown', 'enable 不得用 pause 码');
  // 缺失布尔不作否定证据，也不得单独当成功
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'all_closed_confirmed' }), 'confirmed', '结果码本身可证成功');
  assert.strictEqual(classifyExecuteResult('pause', { outcome: 'partial', allPausedConfirmed: undefined }), 'unknown');
});

test('pause + all_closed_confirmed → confirmed 并释放槽位', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'mixed',
    decide: periodicDecideOver(orch),
    execute: async () => ({
      outcome: 'all_closed_confirmed',
      allClosedConfirmed: true,
      counts: { confirmed: 3, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    }),
  });
  assert.strictEqual(r.serial, 'confirmed');
  assert.strictEqual(r.settleOk, true);
  assert.strictEqual(orch.isBusy(SHOP.id), false, '确认后必须释放槽位');
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), false);
});

test('nothing_to_close → 未发出释放（不冒充执行成功）', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'off',
    decide: periodicDecideOver(orch),
    allowAlreadyOffPause: true,
    execute: async () => ({
      outcome: 'nothing_to_close',
      counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      alreadyClosedCount: 4,
    }),
  });
  assert.strictEqual(r.serial, 'not_sent');
  assert.notStrictEqual(r.serial, 'confirmed');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
});

test('enable 不得因暂停成功结果码被确认', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'enable',
    targetState: 'on',
    readState: async () => 'off',
    decide: periodicDecide(orch),
    execute: async () => ({
      outcome: 'all_closed_confirmed',
      allClosedConfirmed: true,
      counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    }),
  });
  assert.strictEqual(r.serial, 'unknown', 'enable 不得用 pause 结果码确认');
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true, '槽位保持阻塞');
});

test('partial / 未知结果 → 保持 unknown 阻塞，不释放', async () => {
  const { orch } = makeOrch();
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'partial', reason: '部分未确认' }),
  });
  assert.strictEqual(r1.serial, 'unknown');
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true);

  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'some_closed_string', reason: '任意含 closed 的字符串不得当成功' }),
  });
  assert.strictEqual(r2.blocked, 'serial_gate', 'partial 后不补点');
});

test('旧 actionId 不能在 all_closed_confirmed 路径上影响新动作', async () => {
  const { orch } = makeOrch();
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'partial', reason: 'timeout' }),
  });
  const oldId = r1.actionId;
  orch.resolveUnknownWithReadback(SHOP.id, oldId, { confirmed: true });
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id,
    action: 'pause',
    targetState: 'off',
    readState: async () => 'mixed',
    decide: periodicDecideOver(orch),
    execute: async () => ({ outcome: 'all_closed_confirmed', allClosedConfirmed: true }),
  });
  assert.strictEqual(r2.serial, 'confirmed');
  assert.notStrictEqual(r2.actionId, oldId);
  assert.strictEqual(orch.gate.markConfirmed(SHOP.id, oldId).ok, false);
  assert.strictEqual(orch.gate.markSettled(SHOP.id, oldId, { kind: SETTLE_KIND.CONFIRMED }).ok, false);
});

test('发出前取消可释放（cancelled + 0 已发出 → not_sent）', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({
      outcome: 'cancelled',
      counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 1 },
    }),
  });
  assert.strictEqual(r.serial, 'not_sent');
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(orch.isBusy(SHOP.id), false);
});

test('发出后取消且回读未确认不得释放（counts 有已发出 → unknown）', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({
      outcome: 'cancelled',
      counts: { confirmed: 1, failed: 0, unknown: 1, skipped: 1, cancelled: 1 },
    }),
  });
  assert.strictEqual(r.serial, 'unknown');
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true);
});

test('部分完成后中止不得被当成 zeroClick', async () => {
  const { orch } = makeOrch();
  const r = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: periodicDecideOver(orch),
    execute: async () => ({
      outcome: 'partial',
      counts: { confirmed: 2, failed: 0, unknown: 1, skipped: 2, cancelled: 0 },
    }),
  });
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(r.serial, 'unknown');
  assert.strictEqual(orch.hasUnknownBlock(SHOP.id), true);
});

test('单纯盘点无动作不会进入已执行 actions（名称不能代替证据）', () => {
  const { classifyExecuteResult, dispatchedCount } = require('../src/engine/ad-switch-orchestrator');
  const inv = {
    outcome: 'nothing_to_close',
    counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  };
  assert.strictEqual(classifyExecuteResult('pause', inv), 'never_sent');
  assert.strictEqual(dispatchedCount(inv), 0);
  assert.strictEqual(
    classifyExecuteResult('pause', {
      outcome: 'nothing_to_close',
      counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    }),
    'unknown'
  );
});

test('三轮生命周期：确认关闭 → 无需关闭释放 → 恢复后再次确认', async () => {
  const { orch } = makeOrch();
  let closeAd = 0;
  // 轮1：有开启目标 → 暂停并确认 → 释放
  const r1 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'mixed',
    decide: periodicDecideOver(orch),
    execute: async () => {
      closeAd += 3;
      return { outcome: 'all_closed_confirmed', allClosedConfirmed: true, counts: { confirmed: 3, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
    },
  });
  assert.strictEqual(r1.serial, 'confirmed');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
  assert.strictEqual(closeAd, 3);

  // 轮2：全部已关闭 → 无需关闭、零调用 → 未发出释放
  const r2 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'off',
    decide: periodicDecideOver(orch),
    allowAlreadyOffPause: true,
    execute: async () => {
      // 完整盘点 0 目标，closeAd 不增加
      return { outcome: 'nothing_to_close', counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 }, alreadyClosedCount: 3 };
    },
  });
  assert.strictEqual(r2.serial, 'not_sent');
  assert.strictEqual(r2.outcome, 'nothing_to_close');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
  assert.strictEqual(closeAd, 3, '轮2 底层关闭次数为 0');

  // 轮3：目标重新开启 → 再次暂停、返回 batch → 释放
  const r3 = await orch.runSwitchAction({
    shopId: SHOP.id, action: 'pause', targetState: 'off',
    readState: async () => 'mixed',
    decide: periodicDecideOver(orch),
    execute: async () => {
      closeAd += 1;
      return { outcome: 'all_closed_confirmed', allClosedConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
    },
  });
  assert.strictEqual(r3.serial, 'confirmed');
  assert.strictEqual(r3.outcome, 'all_closed_confirmed');
  assert.strictEqual(r3.batch.outcome, 'all_closed_confirmed');
  assert.strictEqual(orch.isBusy(SHOP.id), false);
  assert.strictEqual(closeAd, 4);
});
