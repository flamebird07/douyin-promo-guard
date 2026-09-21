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
  assert.strictEqual(r.timeoutMs, 120000);
  assert.strictEqual(r.intervalMs, 3000);
  assert.strictEqual(r.timeoutSource, 'builtin-default');
  assert.strictEqual(r.intervalSource, 'builtin-default');
  assert.deepStrictEqual(POLLING_DEFAULTS, { timeoutMs: 120000, intervalMs: 3000 });
  const bad = resolvePollingConfig({ readbackTimeoutMs: -1, readbackIntervalMs: 'x' });
  assert.strictEqual(bad.timeoutMs, 120000);
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
  // 注意：本用例使用**真实定时器**，因此断言必须与机器快慢无关。
  // 早期版本断言 `reads >= 3`（250ms 预算），在全量并行满载时会抖动：
  // 首次 sleep 被拉长到数百毫秒后，预算内只剩 1 次读取 —— 那是负载现象，不是行为缺陷。
  // 现只断言"行为保证"：有界结束、至少重读过一次、次数有上界、读取不重叠。
  const t0 = Date.now();
  let reads = 0;
  let live = 0;
  let peak = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      reads += 1;
      live += 1;
      if (live > peak) peak = live;
      live -= 1;
      return { pending: 9, unknown: 0 };
    },
    isPending: (v) => v,
    timeoutMs: 600,
    intervalMs: 50,
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.attempts, reads, 'attempts 必须等于真实读取次数');
  assert.ok(elapsed < 3000, `真实时钟下也必须有界，实际 ${elapsed}ms`);
  assert.ok(reads >= 2, `必须至少重读过一次（不是一击即止），实际 ${reads}`);
  assert.ok(reads <= 30, `读取次数必须有界，实际 ${reads}`);
  assert.strictEqual(peak, 1, '读取绝不重叠');
});

// ══════════════════════════════════════════════════════════════════
// 第二轮定点修复：单次读取本身必须受限（旧代码永久挂起）
//
// 旧缺陷：截止时间只用于决定"两次读取之间是否继续"，`await read()` 本身没有上界。
// 隔离复现（Codex 报告）：timeoutMs=20、intervalMs=0，read 返回永不落定的 Promise
// → 100ms 后函数仍未返回；永久挂起会永久占用任务。
//
// 修复要求（全部落为本文件的断言）：
//  - 真正的有界结果返回；底层读取仍然**绝不重叠**（并发峰值 ≤1）；
//  - 优先取消并确认读取释放；无法取消时保留在途登记，超时返回未知；
//  - 在途读取未释放前，绝不启动下一次读取（不得与旧读取重叠）；
//  - 迟到结果不得改写已返回结果，也不得成为下一轮的输入；
//  - 最后一次读取失败 / 仍有在途读取 → 最新状态未知，禁止据旧快照重发。
// ══════════════════════════════════════════════════════════════════

test('永久挂起：read 永不落定 → 必须有界返回未知，绝不永久占用任务', { timeout: 4000 }, async () => {
  const t0 = Date.now();
  let started = 0;
  let live = 0;
  let peak = 0;
  const r = await boundedLandingPoll({
    read: () => {
      started += 1;
      live += 1;
      peak = Math.max(peak, live);
      return new Promise(() => {}); // 永不落定
    },
    isPending: () => ({ pending: 5, unknown: 0 }),
    timeoutMs: 120,
    intervalMs: 0,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `必须真正有界返回，实际 ${elapsed}ms（旧代码在此永久挂起）`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.settled, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.value, null, '没有任何已落定读取 → 无可用值，必须按未知处理');
  assert.strictEqual(r.inFlight, true, '必须登记"仍有无法取消的在途读取"');
  assert.strictEqual(r.abandonedReads, 1, '必须记录被放弃的在途读取数');
  assert.strictEqual(started, 1, '在途读取未释放前绝不启动第二次读取（不重叠）');
  assert.strictEqual(peak, 1, '真实并发峰值必须 ≤1');
  assert.strictEqual(r.peakInFlight, 1);
  assert.strictEqual(r.valueStale, true, '最新状态未知 → 调用方不得据旧快照重发');
});

test('永久挂起 + abort 生效：优先取消并确认释放 → 无在途登记、无放弃计数', { timeout: 4000 }, async () => {
  const t0 = Date.now();
  let aborted = 0;
  let release = null;
  const r = await boundedLandingPoll({
    read: () => new Promise((res) => { release = res; }),
    isPending: () => ({ pending: 3, unknown: 0 }),
    timeoutMs: 80,
    intervalMs: 0,
    cancelGraceMs: 500,
    abort: () => { aborted += 1; release({ pending: 3, unknown: 0 }); }, // 取消成功并释放
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(aborted, 1, '超时必须尝试取消');
  assert.strictEqual(r.inFlight, false, '取消已确认释放 → 不得再登记在途');
  assert.strictEqual(r.abandonedReads, 0, '已确认释放不算放弃');
  assert.ok(elapsed < 2000, `有界，实际 ${elapsed}ms`);
  assert.strictEqual(r.timedOut, true, '预算已耗尽 → 仍按超时返回（不因取消成功而谎报收敛）');
});

test('永久挂起 + abort 无效：取消未确认释放 → 仍登记在途，且不并发新读取', { timeout: 4000 }, async () => {
  let aborted = 0;
  let started = 0;
  let live = 0;
  let peak = 0;
  const r = await boundedLandingPoll({
    read: () => {
      started += 1;
      live += 1;
      peak = Math.max(peak, live);
      return new Promise(() => {}); // 不可取消
    },
    isPending: () => ({ pending: 2, unknown: 0 }),
    timeoutMs: 80,
    intervalMs: 0,
    cancelGraceMs: 120,
    abort: () => { aborted += 1; }, // 取消无效
  });
  assert.strictEqual(aborted, 1, '必须尝试取消');
  assert.strictEqual(r.inFlight, true, '取消未确认 → 必须保留在途登记');
  assert.strictEqual(r.abandonedReads, 1);
  assert.strictEqual(started, 1, '在途未释放前绝不启动新读取');
  assert.strictEqual(peak, 1, '并发峰值 ≤1');
  assert.strictEqual(r.valueStale, true);
});

test('延迟落定：迟到结果不得改写已返回结果，也不得成为下一轮输入', { timeout: 4000 }, async () => {
  let release = null;
  const r = await boundedLandingPoll({
    read: () => new Promise((res) => { release = res; }),
    isPending: () => ({ pending: 2, unknown: 0 }),
    timeoutMs: 60,
    intervalMs: 0,
  });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.inFlight, true);
  const snapshot = JSON.stringify(r);
  // 超时返回后才落定（迟到）
  release({ pending: 0, unknown: 0 });
  await new Promise((res) => setTimeout(res, 60));
  assert.strictEqual(JSON.stringify(r), snapshot, '迟到结果不得改写已返回的结果对象');
  assert.strictEqual(r.value, null, '迟到结果不得被当作本轮真实回读');
  assert.strictEqual(r.settled, false, '迟到落定不得把结果改成已收敛');
});

test('放弃的在途读取迟到失败：必须已被挂接处理，不得产生未处理拒绝', { timeout: 4000 }, async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectRead = null;
    const r = await boundedLandingPoll({
      read: () => new Promise((_, rej) => { rejectRead = rej; }),
      isPending: () => ({ pending: 1, unknown: 0 }),
      timeoutMs: 60,
      intervalMs: 0,
    });
    assert.strictEqual(r.inFlight, true);
    rejectRead(new Error('迟到失败'));
    await new Promise((res) => setTimeout(res, 120));
    assert.strictEqual(unhandled.length, 0, `不得产生未处理拒绝，实际 ${unhandled.length} 个`);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('连续读取失败：最后一次失败 → 最新状态未知，禁止据旧快照重发', async () => {
  const clock = makeClock();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      reads += 1;
      clock.advance(300);
      // 第 1 次成功且显示"仍未落地"，之后持续失败 → 旧快照必须被判为不可信
      if (reads === 1) return { pending: 4, unknown: 0 };
      throw new Error('强制新扫描回读失败');
    },
    isPending: (v) => v,
    timeoutMs: 2000,
    intervalMs: 300,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.ok(r.readFailures >= 2, `必须如实统计连续失败，实际 ${r.readFailures}`);
  assert.strictEqual(r.lastReadFailed, true, '必须标记"最后一次读取失败"');
  assert.strictEqual(r.valueStale, true, '最后一次读取失败 → 旧快照不可信，禁止据此重发');
  assert.ok(r.value && r.value.pending === 4, '旧快照仍可留作证据，但必须被标记为 stale');
  assert.strictEqual(r.inFlight, false);
});

test('最后一次读取成功且收敛 → valueStale=false（不得把陈旧标记误加到正常收敛上）', async () => {
  const clock = makeClock();
  let reads = 0;
  const r = await boundedLandingPoll({
    read: async () => {
      reads += 1;
      clock.advance(200);
      if (reads === 1) throw new Error('瞬时失败');
      return { pending: 0, unknown: 0 };
    },
    isPending: (v) => v,
    timeoutMs: 3000,
    intervalMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.settled, true);
  assert.strictEqual(r.valueStale, false, '最后一次读取成功 → 快照可信');
  assert.strictEqual(r.lastReadFailed, false);
  assert.strictEqual(r.inFlight, false);
  assert.strictEqual(r.abandonedReads, 0);
});

test('停止 + 在途读取未释放：不再发起新读取，如实上报停止', { timeout: 4000 }, async () => {
  let stopped = false;
  let started = 0;
  let peak = 0;
  let live = 0;
  const r = await boundedLandingPoll({
    read: () => {
      started += 1;
      live += 1;
      peak = Math.max(peak, live);
      stopped = true; // 第一次读取期间收到停止
      return new Promise(() => {});
    },
    isPending: () => ({ pending: 6, unknown: 0 }),
    timeoutMs: 100,
    intervalMs: 0,
    stopRequested: () => stopped,
  });
  assert.strictEqual(r.stopped, true, '必须如实上报"因停止结束"');
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.inFlight, true);
  assert.strictEqual(started, 1, '停止 + 在途未释放 → 绝不发起新业务请求');
  assert.strictEqual(peak, 1, '并发峰值 ≤1');
  assert.strictEqual(r.valueStale, true, '停止后最新状态未知 → 禁止重发');
});

test('真实时钟 + 慢读取：并发峰值 ≤1 且总等待有界（含读取慢于预算的情形）', async () => {
  let started = 0;
  let live = 0;
  let peak = 0;
  const t0 = Date.now();
  const r = await boundedLandingPoll({
    read: async () => {
      started += 1;
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 150)); // 单次读取 150ms > 预算 100ms
      live -= 1;
      return { pending: 7, unknown: 0 };
    },
    isPending: (v) => v,
    timeoutMs: 100,
    intervalMs: 10,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `总等待必须有界，实际 ${elapsed}ms`);
  assert.strictEqual(peak, 1, '同一时刻最多一个活跃读取');
  assert.strictEqual(r.peakInFlight, 1);
  assert.strictEqual(r.timedOut, true);
  assert.ok(started <= 2, `读取次数必须少，实际 ${started}`);
});
