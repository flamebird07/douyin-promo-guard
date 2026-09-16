'use strict';

/**
 * 有界落地轮询（2026-09-16 定点修复）。
 *
 * 背景（旧实现的两个缺陷）：
 *  1) 旧代码按 `Math.ceil(readbackTimeoutMs / readbackIntervalMs)` 计算**次数**，
 *     完全没有计入每次页面读取本身的耗时。真实页面上单次"强制新扫描回读"可能耗时数秒，
 *     于是 N 次 × (间隔 + 读取耗时) 的实际总等待远超配置的超时值——慢读取让等待无限延长，
 *     且超时语义与配置值不再对应。
 *  2) 执行器 fallback 写成 30000/3000，而 config.json / src/config.js 实际是 15000/2000，
 *     导致"生产默认 30 秒/3 秒"的说法与真实生效值不一致（报告不可信）。
 *
 * 修复后的语义（唯一有效配置 = execution.readbackTimeoutMs / execution.readbackIntervalMs）：
 *  - **按实际截止时间**（deadline = 开始时刻 + timeoutMs，用注入时钟 now() 计算）决定是否
 *    再发起一次读取，而不是按次数；读取缓慢只消耗剩余预算，不会额外延长总等待。
 *  - 读取**串行**：上一轮读取返回后才可能发起下一轮；任何情况下都不与上一轮重叠
 *    （无法取消的底层读取不会被并发触发）。
 *  - 至少读取一次（即使 timeoutMs < intervalMs），保证有界且总有结果可用。
 *  - 停止语义：`stopRequested()` 为真后**不再重试、不再发起新业务请求**，但已派发的请求
 *    继续在**有限期限内只读确认**（默认沿用原截止时间；可用 stopGraceMs 收窄）。
 *
 * 返回结果刻意区分 `ok`（已收敛）/`stopped`（因停止而在期限内结束）/`timedOut`（超时未收敛）/
 * `readFailures`（读取失败次数），调用方据此决定是否允许"同会话重试一次"。
 */

/** 与 src/config.js DEFAULTS.execution 保持同一份数字（唯一来源）。 */
const POLLING_DEFAULTS = { timeoutMs: 30000, intervalMs: 3000 };

/**
 * 解析生效的轮询配置。缺失/非法时回落到 POLLING_DEFAULTS，并如实标注来源，
 * 使页面/日志可以显示"当前真实生效值"而不是 fallback 猜测值。
 * @param {object} executionCfg config.execution
 * @returns {{timeoutMs:number, intervalMs:number, timeoutSource:string, intervalSource:string}}
 */
function resolvePollingConfig(executionCfg) {
  const e = executionCfg || {};
  const t = e.readbackTimeoutMs;
  const i = e.readbackIntervalMs;
  const timeoutOk = typeof t === 'number' && Number.isFinite(t) && t > 0;
  const intervalOk = typeof i === 'number' && Number.isFinite(i) && i >= 0;
  return {
    timeoutMs: timeoutOk ? t : POLLING_DEFAULTS.timeoutMs,
    intervalMs: intervalOk ? i : POLLING_DEFAULTS.intervalMs,
    timeoutSource: timeoutOk ? 'execution.readbackTimeoutMs' : 'builtin-default',
    intervalSource: intervalOk ? 'execution.readbackIntervalMs' : 'builtin-default',
  };
}

/**
 * 有界落地轮询。
 *
 * @param {object} p
 * @param {() => Promise<any>} p.read            一次只读回读（失败请 throw；返回值交给 isPending）
 * @param {(value:any) => {pending:number, unknown:number}} p.isPending
 *        判定"是否已落地"。pending = 明确尚未落地的目标数；unknown = 状态无法判定（如目标行消失）。
 *        **收敛条件**：pending === 0（全部落地）或 unknown > 0（状态未知 → 继续等待不会提高确定性，
 *        立即结束并按未知处理，绝不重试）。
 * @param {number} p.timeoutMs                   总预算（毫秒，按实际时钟）
 * @param {number} p.intervalMs                  两次读取之间的等待（毫秒）
 * @param {() => number} [p.now]                 **必须单调推进的时钟**（默认 Date.now）。
 *                                               注意：不要传入被冻结的业务时钟——预算将永不耗尽。
 *                                               本函数另有硬性迭代上限做兜底。
 * @param {(ms:number) => Promise<void>} [p.sleep]
 * @param {() => boolean} [p.stopRequested]
 * @param {number|null} [p.stopGraceMs]          停止后允许的只读确认余量；null/缺省 = 用尽原预算
 * @param {(info:object) => void} [p.onAttempt]
 * @returns {Promise<{ok:boolean, settled:boolean, value:any, attempts:number, readFailures:number,
 *                    stopped:boolean, timedOut:boolean, lastError:any, elapsedMs:number}>}
 */
async function boundedLandingPoll(p) {
  const read = p.read;
  const isPending = p.isPending;
  const timeoutMs = Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : POLLING_DEFAULTS.timeoutMs;
  const intervalMs = Number.isFinite(p.intervalMs) && p.intervalMs >= 0 ? p.intervalMs : POLLING_DEFAULTS.intervalMs;
  const now = p.now || Date.now;
  const sleep = p.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const stopRequested = p.stopRequested || (() => false);
  const stopGraceMs = (p.stopGraceMs === undefined || p.stopGraceMs === null) ? null : Math.max(0, p.stopGraceMs);
  const onAttempt = p.onAttempt || (() => {});

  const startMs = now();
  const deadline = startMs + timeoutMs;
  // 硬性迭代上限：即使调用方误传了不推进的时钟，也不可能无限循环（有界兜底）。
  const maxAttempts = Math.max(2, Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2);
  let stoppedAt = null;
  let attempts = 0;
  let readFailures = 0;
  let lastValue = null;
  let lastError = null;

  /** 当前允许读取到的最晚时刻（停止后收窄，但绝不超过原截止时间）。 */
  const limitOf = () => {
    if (stoppedAt === null) return deadline;
    const grace = stopGraceMs === null ? (deadline - stoppedAt) : stopGraceMs;
    return Math.min(deadline, stoppedAt + Math.max(0, grace));
  };

  for (let i = 0; ; i += 1) {
    // 停止信号在**每次读取前**记录：一旦停止，就不再重试/不再发起新业务请求，
    // 但仍允许已派发请求在有限期限内完成只读确认（limitOf 据此收窄预算）。
    if (stoppedAt === null && stopRequested()) stoppedAt = now();
    const limit = limitOf();
    const remaining = limit - now();
    // 至少读取一次（i === 0 不受预算限制）；之后只要预算耗尽就结束，不再发起新读取。
    if (i > 0 && remaining <= 0) break;
    // 硬性兜底：时钟不推进等异常情况下也不会无限循环。
    if (i >= maxAttempts) break;
    const wait = Math.max(0, Math.min(intervalMs, remaining));
    if (wait > 0) await sleep(wait);
    // 睡眠可能越过截止时间（分片抖动/系统休眠）：越界后不再发起新读取（不与上一轮重叠）。
    if (i > 0 && now() >= limitOf()) break;

    attempts += 1;
    let value = null;
    let err = null;
    try {
      value = await read();
    } catch (e) {
      err = e;
    }
    if (err) {
      readFailures += 1;
      lastError = err;
      onAttempt({ attempt: attempts, error: err.reason || err.message || String(err) });
    } else {
      lastValue = value;
      lastError = null;
      const r = isPending(value) || {};
      const pending = Number.isFinite(r.pending) ? r.pending : 0;
      const unknown = Number.isFinite(r.unknown) ? r.unknown : 0;
      onAttempt({ attempt: attempts, pending, unknown });
      if (pending === 0 || unknown > 0) {
        return {
          ok: true, settled: true, value, attempts, readFailures,
          // 读取期间到达的停止信号同样必须如实上报（调用方据此禁止重试/新请求）
          stopped: stoppedAt !== null || stopRequested(), timedOut: false, lastError: null,
          elapsedMs: now() - startMs,
        };
      }
    }
    if (stoppedAt === null && stopRequested()) stoppedAt = now();
  }

  const stoppedNow = stoppedAt !== null || stopRequested();
  return {
    ok: false, settled: false, value: lastValue, attempts, readFailures,
    stopped: stoppedNow, timedOut: !stoppedNow, lastError, elapsedMs: now() - startMs,
  };
}

module.exports = { boundedLandingPoll, resolvePollingConfig, POLLING_DEFAULTS };
