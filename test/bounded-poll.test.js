'use strict';

/**
 * 有界落地轮询回归测试（2026-09-16 定点修复）。
 *
 * 复现的旧问题：
 *  - 旧实现按 `Math.ceil(timeout/interval)` 计算**次数**，未计入每次读取耗时 →
 *    慢读取让总等待无限延长（本文件"读取缓慢"用例在旧语义下会读满 N 次且总时长不可控）；
 *  - 执行器 fallback 30000/3000 与 config.json 的 15000/2000 不一致 →
 *    "生产默认 30 秒/3 秒"的说法不成立（本文件"配置解析"用例锁定唯一来源）。
 *
 * 全部用例使用注入时钟，不触网、不启动浏览器、不操作真实广告。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { boundedLandingPoll, resolvePollingConfig, POLLING_DEFAULTS } = require('../src/lib/bounded-poll');

/** 虚拟时钟：sleep 直接推进时间，使用例确定且瞬间完成。 */
function makeClock(start = 1000000) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms) => { t += Math.max(0, ms); return Promise.resolve(); },
    advance: (ms) => { t += ms; },
    at: () => t,
  };
}

// ── 配置解析：唯一有效来源 ─────────────────────────────────────────

test('配置解析：存在 execution.readback* → 原样生效并标注来源（不再有独立 fallback 数值）', () => {
  const r = resolvePollingConfig({ readbackTimeoutMs: 15000, readbackIntervalMs: 2000 });
  assert.strictEqual(r.timeoutMs, 15000);
  assert.strictEqual(r.intervalMs, 2000);
  assert.strictEqual(r.timeoutSource, 'execution.readbackTimeoutMs');
  assert.strictEqual(r.intervalSource, 'execution.readbackIntervalMs');
});

test('配置解析：缺失/非法 → 回落内置默认，并如实标注 builtin-default（与 src/config.js DEFAULTS 同值）', () => {
  const r = resolvePollingConfig({});
  assert.strictEqual(r.timeoutMs, 30000);
  assert.strictEqual(r.intervalMs, 3000);
  assert.strictEqual(r.timeoutSource, 'builtin-default');
  assert.strictEqual(r.intervalSource, 'builtin-default');
  assert.deepStrictEqual(POLLING_DEFAULTS, { timeoutMs: 30000, intervalMs: 3000 });
  const bad = resolvePollingConfig({ readbackTimeoutMs: -1, readbackIntervalMs: 'x' });
  assert.strictEqual(bad.timeoutMs, 30000);
  assert.strictEqual(bad.intervalMs, 3000);
});

// ── 异步落地 ──────────────────────────────────────────────────────

test('异步落地：第 3 次读取才落地 → 立即收敛，不额外等待', async () => {
  const clock = makeClock();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => { reads += 1; return { pending: reads < 3 ? 4 : 0, unknown: 0 }; },
    isPending: (v) => ({ pending: v.pending, unknown: v.unknown }),
    timeoutMs: 10000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 3, '落地即停，不多读');
  assert.strictEqual(r.elapsedMs, 3000, '总耗时 = 3 个间隔（虚拟时钟）');
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.stopped, false);
});

test('持续未落地：读满预算后按超时结束（不无限延长）', async () => {
  const clock = makeClock();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => { reads += 1; return { pending: 5, unknown: 0 }; },
    isPending: (v) => v,
    timeoutMs: 5000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.stopped, false);
  assert.strictEqual(r.elapsedMs, 5000, '总等待严格等于配置预算（按实际截止时间，不是次数）');
  assert.ok(reads <= 6, `读取次数应有界，实际 ${reads}`);
});

test('读取失败：按预算有界重试，最终结果未知（不把失败当作落地）', async () => {
  const clock = makeClock();
  const r = await boundedLandingPoll({
    read: async () => { throw new Error('强制新扫描回读失败'); },
    isPending: () => ({ pending: 0, unknown: 0 }),
    timeoutMs: 3000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.value, null, '从未成功读取 → value 为 null，调用方必须按未知处理');
  assert.strictEqual(r.readFailures, r.attempts);
  assert.ok(r.attempts >= 2, `失败也应在预算内持续重试，实际 ${r.attempts}`);
  assert.strictEqual(r.elapsedMs, 3000, '总等待严格等于配置预算');
  assert.ok(r.lastError, '保留最后一次读取失败原因（供日志）');
});

test('读取缓慢：慢读取只消耗剩余预算，总等待不超过 预算+单次读取耗时；读取绝不重叠', async () => {
  const clock = makeClock();
  const SLOW = 900; // 每次读取 900ms（远超 300ms 间隔）
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      reads += 1;
      clock.advance(SLOW); // 读取耗时（虚拟时钟）
      inFlight -= 1;
      return { pending: 3, unknown: 0 };
    },
    isPending: (v) => v,
    timeoutMs: 2000,
    intervalMs: 300,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(maxInFlight, 1, '同一时刻最多一个活跃读取（不与上一轮重叠）');
  // 旧语义（ceil(2000/300)=7 次 × (300+900)）会等待约 8400ms；新语义必须有界。
  assert.ok(r.elapsedMs <= 2000 + SLOW + 1, `总等待必须有界（预算+单次读取），实际 ${r.elapsedMs}ms`);
  assert.ok(reads <= 3, `慢读取下读取次数应显著减少，实际 ${reads}`);
});

// ── 状态未知（目标消失） ──────────────────────────────────────────

test('目标消失（状态未知）：立即结束轮询并按未知返回，不继续等待、不重试', async () => {
  const clock = makeClock();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => { reads += 1; return { pending: 1, unknown: 1 }; },
    isPending: (v) => v,
    timeoutMs: 30000,
    intervalMs: 3000,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, true, '轮询本身结束（settled）');
  assert.strictEqual(reads, 1, '状态未知时继续等待不会提高确定性 → 立即结束');
  assert.ok(r.elapsedMs < 30000);
});

// ── 停止语义 ──────────────────────────────────────────────────────

test('停止：不再重试/不再发新请求，但已派发请求继续在有限期限内只读确认', async () => {
  const clock = makeClock();
  let stopped = false;
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      reads += 1;
      clock.advance(500);
      if (reads === 1) stopped = true;  // 点击后收到停止
      return { pending: 4, unknown: 0 }; // 平台尚未落地
    },
    isPending: (v) => v,
    timeoutMs: 4000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
    stopRequested: () => stopped,
  });
  assert.strictEqual(r.stopped, true, '必须如实上报"因停止结束"');
  assert.strictEqual(r.timedOut, false);
  assert.ok(reads >= 2, '停止后仍继续只读确认（不是立刻 return）');
  assert.ok(r.elapsedMs <= 4000 + 500 + 1, '停止后仍受原预算约束（有限期限）');
});

test('停止 + stopGraceMs：只读确认余量可被收窄，且绝不超过原截止时间', async () => {
  const clock = makeClock();
  let stopped = false;
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => { reads += 1; stopped = true; return { pending: 4, unknown: 0 }; },
    isPending: (v) => v,
    timeoutMs: 10000,
    intervalMs: 1000,
    stopGraceMs: 2000,
    now: clock.now,
    sleep: clock.sleep,
    stopRequested: () => stopped,
  });
  assert.strictEqual(r.stopped, true);
  assert.ok(r.elapsedMs <= 2000 + 1000 + 1, `停止后总余量应受 stopGraceMs 限制，实际 ${r.elapsedMs}ms`);
});

test('停止 + 平台随后落地：仍以真实回读为准收敛（记录真实结果，不谎报失败）', async () => {
  const clock = makeClock();
  let stopped = false;
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      reads += 1;
      clock.advance(400);
      if (reads === 1) stopped = true;
      return { pending: reads < 3 ? 5 : 0, unknown: 0 }; // 停止后才落地
    },
    isPending: (v) => v,
    timeoutMs: 6000,
    intervalMs: 1000,
    now: clock.now,
    sleep: clock.sleep,
    stopRequested: () => stopped,
  });
  assert.strictEqual(r.ok, true, '停止后已派发请求真实落地 → 收敛并如实上报');
  assert.strictEqual(r.stopped, true, '同时如实标记发生过停止（调用方据此禁止重试）');
  assert.strictEqual(r.attempts, 3);
});

// ── 真实时钟下限（确保注入时钟没有掩盖真实行为）──────────────────

test('真实时钟：小预算下有界结束（不依赖虚拟时钟）', async () => {
  const t0 = Date.now();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => { reads += 1; return { pending: 9, unknown: 0 }; },
    isPending: (v) => v,
    timeoutMs: 250,
    intervalMs: 50,
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.ok(elapsed < 1200, `真实时钟下也必须有界，实际 ${elapsed}ms`);
  assert.ok(reads >= 3 && reads <= 8, `读取次数合理，实际 ${reads}`);
});
