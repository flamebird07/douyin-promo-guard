'use strict';

/**
 * S3 / JIANSHANG-ROI14-20261026：zero_orders 阻断轮询不得跳过只读广告状态观测。
 * 根因：_pollShop 的 data.ok===false 分支直接 return，绕过 _readCurrentAdState/
 * _applyObservedAdState → 旧 on/off 观测超 35 分钟有效期后前端持续"未知"。
 * 验证（全部隔离：临时目录 + 合成假 Cookie + 注入 readAdState/FakeCoordinator，
 * 不启动浏览器/调度器，不读生产路径）：
 * 1. zero_orders 轮询做一次真实只读观测，观测时间用本轮真实时钟推进；
 * 2. 读到 off 如实记 off，绝不触发开启/暂停（evaluatePeriodic/runSwitchAction 计数 0）；
 * 3. 读失败/抛错 → unknown + 完整失败原因（不得吞成成功、不得用旧 on 保绿）；
 * 4. 其他 blocked 类型不新增状态读；
 * 5. ROI/阈值/Cookie/全局开关配置不变；state/audit 落临时目录。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeClock } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-jianshang', name: '简尚', cookieFile: '简尚', enabled: true };

function zeroOrdersData(nowMs) {
  const fetchedAt = new Date(nowMs).toISOString();
  return {
    ok: false,
    blocked: 'zero_orders',
    reason: '当日 0 单（0 费 0 单）：无需关闭',
    cost: { source: 'mock', businessDate: '2026-10-26', fetchedAt, rawText: null, valueCents: 0, pageUpdatedAt: null },
    orders: { source: 'mock', businessDate: '2026-10-26', fetchedAt, rawText: null, valueCount: 0, pageUpdatedAt: null },
  };
}

/**
 * 构造真实 Monitor（不 start()）。coordinator/readAdState 均为注入的假实现：
 * readAdState 计数并按序返回观测结果；switchOrchestrator 的任何 evaluatePeriodic/
 * runSwitchAction 调用都计数并抛错，证明 zero_orders 轮询零广告动作。
 */
function setup(t, { readResults } = {}) {
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
  const cfgResult = makeCfgResult({ cookieDir, cookieWorkDir, shops: [SHOP] });
  cfgResult.config.login.cookieWorkDir = cookieWorkDir;
  const clock = makeClock(shanghaiMs('2026-10-26', '10:00'));

  const coord = {
    readAndEvaluateCalls: 0,
    async readAndEvaluate() {
      this.readAndEvaluateCalls += 1;
      return zeroOrdersData(clock.now());
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
  const switchOrchestrator = {
    evaluatePeriodic() { evalCalls += 1; throw new Error('zero_orders 轮询不得进入 evaluatePeriodic'); },
    runSwitchAction() { runCalls += 1; throw new Error('zero_orders 轮询不得进入 runSwitchAction'); },
    hasUnknownBlock: () => false,
    peek: () => null,
    pendingMixedReconcile: () => null,
    mixedInflightProof: () => ({ inflight: 0 }),
    reconcileMixedAndReoperate: () => { throw new Error('zero_orders 轮询不得进入 mixed 交接'); },
  };

  const monitor = new Monitor(cfgResult, null, {
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
    monitor, clock, coord, rt, oldAt,
    counts: { read: () => readCalls, eval: () => evalCalls, run: () => runCalls },
    poll: () => monitor._pollShop(SHOP, { aborted: false, kind: 'pause' }, 'manual'),
  };
}

const ON_READ = { state: 'on', rows: [{ id: 'p1', switchChecked: true }], identity: { ok: true }, balance: null };
const OFF_READ = { state: 'off', rows: [{ id: 'p1', switchChecked: false }], identity: { ok: true }, balance: null };
const FAILED_READ = { state: 'unknown', error: { status: 'blocked', reason: '回读失败：模拟清单不完整', blocked: 'inventory' } };

test('zero_orders 轮询推进只读状态观测：真实读到 on，观测/数据时间用本轮时钟', async (t) => {
  const { monitor, clock, rt, oldAt, counts, poll } = setup(t, { readResults: [ON_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'zero_orders', '返回仍为原 zero_orders 无需关闭结果');
  assert.strictEqual(res.reason, '当日 0 单（0 费 0 单）：无需关闭');
  assert.strictEqual(counts.read(), 1, '恰好一次只读状态观测');
  assert.strictEqual(counts.eval(), 0, '不得进入 evaluatePeriodic');
  assert.strictEqual(counts.run(), 0, '不得进入任何开关动作');

  const nowIso = new Date(clock.now()).toISOString();
  assert.strictEqual(rt.lastAdState, 'on', 'on 来自本轮真实回读，非旧值保绿');
  assert.strictEqual(rt.adStateObservedAt, nowIso, '观测时间推进到本轮真实时钟');
  assert.notStrictEqual(rt.adStateObservedAt, oldAt);
  assert.strictEqual(rt.lastDataAt, nowIso, 'lastDataAt 同步推进');
  assert.strictEqual(rt.lastReadError, null, '成功观测清除旧读取错误');
  assert.strictEqual(rt.adStateEvidenceKind, 'read_only');
  assert.strictEqual(monitor.triggers.length, 0, '零触发记录');
  assert.strictEqual(monitor.actions.length, 0, '零广告动作');
});

test('读到 off 必须如实记 off，且不得触发开启', async (t) => {
  const { rt, counts, poll } = setup(t, { readResults: [OFF_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'zero_orders');
  assert.strictEqual(rt.lastAdState, 'off', 'off 如实落账');
  assert.ok(rt.adStateObservedAt, '写入本轮观测时间');
  assert.strictEqual(counts.run(), 0, 'off 绝不触发开启/暂停');
  assert.strictEqual(counts.eval(), 0);
});

test('费用大于0但订单0仍保留原阻断原因，只更新广告观测而不操作', async (t) => {
  const { coord, clock, rt, counts, poll } = setup(t, { readResults: [OFF_READ] });
  coord.readAndEvaluate = async () => {
    const data = zeroOrdersData(clock.now());
    data.cost.valueCents = 1200;
    data.reason = '全店订单为0但推广费用大于0：已重新读取核实仍为0';
    return data;
  };
  const res = await poll();
  assert.strictEqual(res.blocked, 'zero_orders');
  assert.ok(res.reason.includes('推广费用大于0'));
  assert.strictEqual(rt.lastAdState, 'off');
  assert.strictEqual(counts.read(), 1);
  assert.strictEqual(counts.eval(), 0);
  assert.strictEqual(counts.run(), 0);
});

test('读失败 → unknown + 完整原因，不用旧 on 保绿、不推 lastDataAt', async (t) => {
  const { rt, oldAt, counts, poll } = setup(t, { readResults: [FAILED_READ] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'zero_orders', '外层仍返回原 zero_orders 结果');
  assert.strictEqual(res.reason, '当日 0 单（0 费 0 单）：无需关闭');
  assert.strictEqual(rt.lastAdState, 'unknown', '失败不得保留旧 on');
  assert.strictEqual(rt.adStateConfirmedAt, null);
  assert.ok(rt.lastReadError, '写入结构化读取失败');
  assert.ok(String(rt.lastReadError.reason).includes('模拟清单不完整'), '保留真实失败原因');
  assert.strictEqual(rt.lastDataAt, oldAt, '失败不得推进 lastDataAt');
  assert.ok(rt.adStateObservedAt > oldAt, 'unknown 观测时间仍为本轮真实时间');
  assert.strictEqual(counts.eval(), 0);
  assert.strictEqual(counts.run(), 0);
});

test('readAdState 抛错走真实失败路径，不得吞成成功', async (t) => {
  const { rt, counts, poll } = setup(t, { readResults: [new Error('炸读：opener 异常')] });
  const res = await poll();

  assert.strictEqual(res.status, 'blocked');
  assert.strictEqual(res.blocked, 'zero_orders');
  assert.strictEqual(rt.lastAdState, 'unknown');
  assert.ok(String(rt.lastReadError.reason).includes('炸读'), '抛错原因如实保留');
  assert.strictEqual(counts.read(), 1);
});

test('其他 blocked 类型不新增状态读', async (t) => {
  const { monitor, rt, oldAt, counts, poll } = setup(t, { readResults: [ON_READ] });
  const coord = monitor._getCoordinator();
  coord.readAndEvaluate = async () => ({
    ok: false, blocked: 'identity', reason: '店铺身份不一致',
    cost: zeroOrdersData(0).cost, orders: zeroOrdersData(0).orders,
  });
  const res = await poll();

  assert.strictEqual(res.blocked, 'identity');
  assert.strictEqual(counts.read(), 0, '非 zero_orders 不新增只读状态读');
  assert.strictEqual(rt.lastAdState, 'on', '旧观测不被触碰');
  assert.strictEqual(rt.adStateObservedAt, oldAt);
});

test('配置与落盘路径不受影响：阈值/ROI 规则不变，state/audit 全在临时目录', async (t) => {
  const { monitor, poll } = setup(t, { readResults: [ON_READ] });
  const ruleBefore = JSON.stringify(monitor.config.rules);
  const thresholdBefore = monitor._thresholdCents(SHOP);
  await poll();

  assert.strictEqual(JSON.stringify(monitor.config.rules), ruleBefore, '不改 ROI/阈值规则');
  assert.strictEqual(monitor._thresholdCents(SHOP), thresholdBefore);
  assert.ok(monitor.stateFile.includes('pg-zo-data-'), 'state 落临时目录');
  assert.ok(monitor.auditFile.includes('pg-zo-data-'), 'audit 落临时目录');
  assert.ok(monitor.config.login.cookieWorkDir.includes('pg-zo-work-'), 'login 工作目录为本测试临时目录');
  assert.strictEqual(monitor.running, false, '未启动调度器');
});
