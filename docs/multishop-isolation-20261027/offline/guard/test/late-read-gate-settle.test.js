'use strict';

/**
 * D9G 迟到收口回归：有界探测（1s→5s→30s）用尽转 terminal 后，底层 work 才 settle 的场景。
 *
 * 锁死边界：
 *  - 转 terminal 时在 gate.workRec.settledP 上挂**一次性**事件唤醒（含早已 settle），
 *    不是新轮询服务、不加 timer、不延长任何 deadline；
 *  - 唤醒只复用既有 _advanceReadGate 证明链：not-created / 真实关闭+连接核验，
 *    拿到证明才注销登记簿并按身份 CAS 清门；
 *  - work 未 settle 绝不清门（即使句柄当前已断开——未 settle 的 work 仍可能再创建资源）；
 *  - work settle 但句柄仍在线/关闭被拒/关闭后仍连接 → 保持阻断，绝不假放行；
 *  - 被替换的旧门：settle 唤醒只注销自己的收口义务，绝不清新当前门；
 *  - 全程零新 opener、零页面读取、零点击。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；探测 timer 全部注入，不做真实长等待。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const SHOP_B = { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true };

/** fake clock：与 dian4-unknown-gate-ownership.test.js 同款（收口竞速在真实时间上收敛）。 */
function makeClock(startMs = Date.parse('2026-10-27T02:46:00Z')) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    nowFn: () => now,
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), ms: Number(ms) || 0, fn });
      return { id, unref() { /* fake */ } };
    },
    clearTimeoutFn(h) { if (h && h.id != null) timers.delete(h.id); },
    pending() { return Array.from(timers.values()).sort((a, b) => a.at - b.at || a.id - b.id); },
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (let guard = 0; guard < 300; guard += 1) {
        const due = this.pending().filter((t) => t.at <= now)[0];
        if (!due) break;
        timers.delete(due.id);
        due.fn();
        await new Promise((r) => setTimeout(r, 45));
        await flush();
      }
      await new Promise((r) => setTimeout(r, 45));
      await flush();
    },
    async flush() { await flush(); },
  };
}

async function drainTimers(clock, maxSteps = 10) {
  for (let i = 0; i < maxSteps; i += 1) {
    const due = clock.pending();
    if (!due.length) return i;
    await clock.advance(Math.max(1, due[0].at - clock.nowFn()));
  }
  return maxSteps;
}

/** 未 settle 的 work 记录（resolve()/reject() 都算 settle，与生产 _settleRecord 同语义）。 */
function makeDeferredWork() {
  let done = false;
  let settleIt = null;
  const settledP = new Promise((r) => { settleIt = r; }).then(() => { done = true; }, () => { done = true; });
  return { settledP, isSettled: () => done, settle: () => settleIt() };
}

/**
 * 可控收口句柄（活对象，经 handleRef 闭包取用——晚到更新同样可见）：
 *  state: { connected, closeReject, closeSlowConnect }
 *   closeReject=true        close() 拒绝 → 无法证明
 *   closeSlowConnect=true   close() 成功但 isConnected 仍 true → 无法证明
 */
function makeHandle(state = {}) {
  const s = { connected: true, closeReject: false, closeSlowConnect: false, ...state };
  return {
    closeCount: 0,
    state: s,
    close() {
      this.closeCount += 1;
      if (s.closeReject) return Promise.reject(new Error('mock close rejected'));
      if (!s.closeSlowConnect) s.connected = false;
      return Promise.resolve();
    },
    isConnected() { return s.connected; },
  };
}

function buildMonitor({ dataDir, clock, opener }) {
  const cfgResult = makeCfgResult({
    shops: [SHOP_A, SHOP_B].map((x) => ({ ...x })),
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 50,
        adStateCloseWaitMs: 30,
        adStateSettleWaitMs: 30,
      },
    },
  });
  return new Monitor(cfgResult, null, {
    dataDir,
    chengfangOpener: opener,
    nowFn: clock.nowFn,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

function gateEvents(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l)).filter((j) => String(j.event || '').indexOf('gate-') === 0);
}

/** 登记一扇会走到 terminal 的门（无会话、有所有者句柄、work 迟到 settle）。 */
function registerLateGate(mon, shop, work, handle) {
  return mon._newReadGate(shop.id, {
    workRec: work,
    sessionRef: () => null,
    handleRef: () => handle,
    resourceCreated: true,
    closes: [{ label: 'opener-cleanup', closed: false, error: null, promise: null }],
  });
}

// ────────────────────────────────────────────────────────────────────

test('L1 探测用尽转 terminal 后 work 才 settle：句柄已断开 → 凭证明清门+注销，零新读取', async () => {
  const dataDir = makeTempDir('late-gate-l1-');
  const clock = makeClock();
  const openerCalls = { n: 0 };
  const opener = async () => { openerCalls.n += 1; throw new Error('收口路径绝不允许 opener'); };
  const mon = buildMonitor({ dataDir, clock, opener });

  const work = makeDeferredWork();
  const handle = makeHandle();
  const gate = registerLateGate(mon, SHOP_A, work, handle);
  assert.equal(clock.pending().length, 1, '只允许门自身的有界探测 timer');

  await drainTimers(clock, 6); // 1s/5s/30s 依次到期（work 未 settle → 全部无法证明）
  assert.equal(gate.phase, 'terminal', '三次探测用尽必须转 terminal');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, 'terminal 后门仍在（阻断事实不丢）');
  assert.equal(clock.pending().length, 0, 'terminal 后无 timer（唤醒不是轮询服务）');

  // 生产 D9G 场景：候选浏览器在 work settle 前已自行退出（连接已断）
  handle.state.connected = false;
  work.settle(); // 迟到 settle（在 terminal 之后 28s 量级）
  await clock.flush();
  await clock.flush();

  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, 'work settle + 句柄断开证明 → 事件唤醒清门');
  assert.equal(mon._cleanupRegistryIndexOf(gate), -1, '清门同时注销登记簿');
  assert.equal(handle.closeCount, 0, '已断开的句柄无需再 close（already-closed 证明）');
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released');
  assert.equal(rel.length, 1, '清门事实只留一次');
  assert.equal(rel[0].via, 'settle-wake');
  assert.equal(rel[0].proof, 'already-closed');
  assert.equal(rel[0].unregistered, true);
  assert.equal(openerCalls.n, 0, '唤醒路径零新 opener');
  mon.stop();
});

test('L2 work 未 settle 绝不清门（句柄当前已断开也不行）；settle 后才允许清', async () => {
  const dataDir = makeTempDir('late-gate-l2-');
  const clock = makeClock();
  const opener = async () => { throw new Error('收口路径绝不允许 opener'); };
  const mon = buildMonitor({ dataDir, clock, opener });

  const work = makeDeferredWork();
  const handle = makeHandle();
  const gate = registerLateGate(mon, SHOP_A, work, handle);
  await drainTimers(clock, 6);
  assert.equal(gate.phase, 'terminal');

  handle.state.connected = false; // 即使句柄此刻断开：未 settle 的 work 仍可能再创建资源
  await clock.advance(60000);
  await clock.flush();
  await clock.flush();
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, 'work 未 settle：唤醒绝不提前清门');
  assert.equal(gateEvents(dataDir).filter((j) => j.event === 'gate-released').length, 0);

  work.settle();
  await clock.flush();
  await clock.flush();
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, 'settle 之后事件唤醒才凭证明清门');
  mon.stop();
});

test('L3 work settle 但句柄仍在线 / close 被拒 / close 后仍连接：一律保持阻断', async () => {
  const dataDir = makeTempDir('late-gate-l3-');
  const clock = makeClock();
  const opener = async () => { throw new Error('收口路径绝不允许 opener'); };
  const mon = buildMonitor({ dataDir, clock, opener });

  // A 店：句柄仍在线且 close 被拒
  const workA = makeDeferredWork();
  const handleA = makeHandle({ closeReject: true });
  const gateA = registerLateGate(mon, SHOP_A, workA, handleA);
  // B 店：close 成功但连接核验仍在线（假成功）
  const workB = makeDeferredWork();
  const handleB = makeHandle({ closeSlowConnect: true });
  const gateB = registerLateGate(mon, SHOP_B, workB, handleB);
  await drainTimers(clock, 8);
  assert.equal(gateA.phase, 'terminal');
  assert.equal(gateB.phase, 'terminal');

  workA.settle();
  workB.settle();
  await clock.flush();
  await clock.flush();

  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gateA, 'close 被拒：无证明不清门');
  assert.ok(handleA.closeCount >= 1, '唤醒确实推进过真实关闭尝试');
  assert.equal(mon._pendingReadGateFor(SHOP_B.id), gateB, 'close 后仍连接：无证明不清门');
  const wake = gateEvents(dataDir).filter((j) => j.event === 'gate-settle-wake');
  assert.equal(wake.length, 2, '两条失败唤醒都留审计事实');
  assert.ok(wake.every((j) => j.ok === false && j.reason));
  assert.equal(gateEvents(dataDir).filter((j) => j.event === 'gate-released').length, 0, '零清门');
  mon.stop();
});

test('L4 被替换的旧门：settle 唤醒只注销自己的收口义务，绝不清新当前门', async () => {
  const dataDir = makeTempDir('late-gate-l4-');
  const clock = makeClock();
  const opener = async () => { throw new Error('收口路径绝不允许 opener'); };
  const mon = buildMonitor({ dataDir, clock, opener });

  const workOld = makeDeferredWork();
  const handleOld = makeHandle();
  const oldGate = registerLateGate(mon, SHOP_A, workOld, handleOld);
  await drainTimers(clock, 6);
  assert.equal(oldGate.phase, 'terminal');

  // 同店更晚一次未收口失败：旧门被替换但仍在登记簿
  const workNew = makeDeferredWork();
  const newGate = registerLateGate(mon, SHOP_A, workNew, makeHandle());
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), newGate, '新门是当前门');
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [oldGate.gateId, newGate.gateId]);

  handleOld.state.connected = false;
  workOld.settle();
  await clock.flush();
  await clock.flush();

  assert.equal(mon._pendingReadGateFor(SHOP_A.id), newGate, '旧门唤醒不得清新门');
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [newGate.gateId], '旧门只注销自己');
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === oldGate.gateId);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].via, 'settle-wake');
  assert.equal(rel[0].cleared, false, '旧门 CAS 必须失败');
  assert.equal(rel[0].unregistered, true);
  assert.equal(newGate.phase, 'pending', '新门不受旧门唤醒影响');
  mon.stop();
});

test('L5 work settle 后句柄仍在线：唤醒做且只做一次真实关闭，与探测并发不叠加', async () => {
  const dataDir = makeTempDir('late-gate-l5-');
  const clock = makeClock();
  const opener = async () => { throw new Error('收口路径绝不允许 opener'); };
  const mon = buildMonitor({ dataDir, clock, opener });

  const work = makeDeferredWork();
  const handle = makeHandle(); // 在线；close 成功后断开
  const gate = registerLateGate(mon, SHOP_A, work, handle);
  await drainTimers(clock, 6);
  assert.equal(gate.phase, 'terminal');

  work.settle();
  await clock.flush();
  await clock.flush();
  await clock.advance(60000); // 再走任意虚拟时间：唤醒是一次性的，不产生重复收口
  await clock.flush();

  assert.equal(handle.closeCount, 1, '真实关闭只做一次（不叠加）');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, 'close+连接核验通过 → 清门');
  assert.equal(mon._cleanupRegistryIndexOf(gate), -1);
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === gate.gateId);
  assert.equal(rel.length, 1, '清门事实恰好一次');
  assert.equal(rel[0].via, 'settle-wake');
  assert.equal(rel[0].proof, 'closed');
  assert.equal(clock.pending().length, 0, '唤醒不排任何新 timer');
  mon.stop();
});
