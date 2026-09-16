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
 *
 * 2026-09-16 第二轮定点修复（Codex 独立复现）：
 *  旧实现的截止时间**只**用于决定"两次读取之间是否继续"，`await read()` 本身没有任何上界。
 *  隔离复现：timeoutMs=20、intervalMs=0，read 返回永不落定的 Promise → 100ms 后仍未返回；
 *  真实页面上一次卡住的读取会让整个任务永久挂起。
 *  现补齐（不是简单地 `Promise.race` 丢弃，也不是单纯加大超时）：
 *   a) **单次读取也在预算内被等待**：等待上界 = 剩余预算；超时即返回，绝不无限等待。
 *   b) **优先取消并确认释放**：提供 `abort` 时先请求取消，再用 `cancelGraceMs` 确认读取已释放。
 *   c) **无法取消 → 保留在途登记**：返回 `inFlight: true`，调用方据此**不得**启动新的
 *      浏览器任务与旧读取重叠；在途读取未释放前本函数也不会发起下一次读取。
 *   d) **迟到结果被隔离**：被放弃的读取落定后只写入本地登记对象，既不改写已返回的结果，
 *      也不会成为下一轮的输入；同时挂接错误处理，不产生未处理拒绝。
 *   e) **最新状态未知必须可识别**：`lastReadFailed`（最后一次读取失败）与 `valueStale`
 *      （旧快照不可信）供调用方判断"是否禁止重发"——绝不拿此前的"仍关闭"旧快照去重试。
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
 * @param {() => (void|Promise<void>)} [p.abort] 请求取消当前在途读取（可选；调用后仍需确认释放）
 * @param {number} [p.cancelGraceMs]             取消后等待"确认释放"的余量（默认 0，即有界不额外等待）
 * @param {(info:object) => void} [p.onAttempt]
 * @returns {Promise<{ok:boolean, settled:boolean, value:any, attempts:number, readFailures:number,
 *                    abandonedReads:number, inFlight:boolean, lastReadFailed:boolean, valueStale:boolean,
 *                    peakInFlight:number, stopped:boolean, timedOut:boolean, lastError:any, elapsedMs:number}>}
 *          `inFlight=true` 表示返回时仍有一个**无法取消**的在途读取（调用方不得据此启动新任务）；
 *          `valueStale=true` 表示 `value` 可能已过期（最后一次读取失败 / 仍有在途读取 / 从未读成功），
 *          调用方**不得**据此快照重发请求。
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
  const abort = typeof p.abort === 'function' ? p.abort : null;
  const cancelGraceMs = Number.isFinite(p.cancelGraceMs) && p.cancelGraceMs >= 0 ? p.cancelGraceMs : 0;

  const startMs = now();
  const deadline = startMs + timeoutMs;
  // 硬性迭代上限：即使调用方误传了不推进的时钟，也不可能无限循环（有界兜底）。
  const maxAttempts = Math.max(2, Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2);
  let stoppedAt = null;
  let attempts = 0;
  let readFailures = 0;
  let abandonedReads = 0;
  let lastValue = null;
  let lastError = null;
  let lastReadFailed = false;
  let unreleased = false;   // 返回时是否仍有无法取消的在途读取
  let inFlightCount = 0;
  let peakInFlight = 0;
  let inflight = null;      // 当前在途读取的登记记录

  /** 当前允许读取到的最晚时刻（停止后收窄，但绝不超过原截止时间）。 */
  const limitOf = () => {
    if (stoppedAt === null) return deadline;
    const grace = stopGraceMs === null ? (deadline - stoppedAt) : stopGraceMs;
    return Math.min(deadline, stoppedAt + Math.max(0, grace));
  };

  /**
   * 启动一次读取并登记在途状态。登记结果永远以 {ok, value|error} 落定（不抛出），
   * 这样即使调用方最终放弃了这次读取，也不会产生未处理拒绝。
   */
  const startRead = () => {
    attempts += 1;
    inFlightCount += 1;
    if (inFlightCount > peakInFlight) peakInFlight = inFlightCount;
    const rec = { done: false, result: null };
    let pr;
    try {
      pr = Promise.resolve(read());
    } catch (e) {
      pr = Promise.reject(e);
    }
    rec.promise = pr.then(
      (value) => { inFlightCount -= 1; rec.done = true; rec.result = { ok: true, value }; return rec.result; },
      (error) => { inFlightCount -= 1; rec.done = true; rec.result = { ok: false, error }; return rec.result; },
    );
    return rec;
  };

  /**
   * 等待在途读取落定，最多 ms 毫秒；返回是否已落定。
   *
   * 这里的 race **只用来给等待设上界**：即使 race 先返回，被放弃的读取仍保留登记
   * （inFlight / abandonedReads），绝不会因为"race 结束了"就并发发起下一次读取。
   */
  const waitSettle = async (rec, ms) => {
    if (rec.done) return true;
    // 让已落定 Promise 的微任务先跑完（读取可能已完成，只是 .then 尚未执行）。
    // 用 0ms 宏任务确保微任务队列已刷新，避免把"已完成的读取"误判为在途。
    await new Promise((r) => { setTimeout(r, 0); });
    if (rec.done) return true;
    if (!(ms > 0)) return false;
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), ms); });
    const winner = await Promise.race([rec.promise.then(() => 'settled'), timeout]);
    if (timer) clearTimeout(timer);
    return winner === 'settled';
  };

  for (;;) {
    // 停止信号在**每次读取前**记录：一旦停止，就不再重试/不再发起新业务请求，
    // 但仍允许已派发请求在有限期限内完成只读确认（limitOf 据此收窄预算）。
    if (stoppedAt === null && stopRequested()) stoppedAt = now();

    if (inflight) {
      const settled = await waitSettle(inflight, Math.max(0, limitOf() - now()));
      if (!settled) {
        // 超时仍未释放：优先取消并确认释放；确认不了则保留在途登记后结束（返回未知）。
        let released = false;
        if (abort) {
          try { await abort(); } catch (_) { /* 取消失败不致命，仍按在途处理 */ }
          released = await waitSettle(inflight, cancelGraceMs);
        }
        if (!released) {
          unreleased = true;
          abandonedReads += 1;
          inflight = null;
          break;
        }
      }
      // 已落定（或取消后确认释放）→ 消费结果；迟到的结果永远不会走到这里。
      const r = inflight.result;
      inflight = null;
      if (r && r.ok === false) {
        readFailures += 1;
        lastError = r.error;
        lastReadFailed = true;
        onAttempt({ attempt: attempts, error: r.error && (r.error.reason || r.error.message || String(r.error)) });
      } else if (r && r.ok) {
        lastValue = r.value;
        lastError = null;
        lastReadFailed = false;
        const pr = isPending(r.value) || {};
        const pending = Number.isFinite(pr.pending) ? pr.pending : 0;
        const unknown = Number.isFinite(pr.unknown) ? pr.unknown : 0;
        onAttempt({ attempt: attempts, pending, unknown });
        if (pending === 0 || unknown > 0) {
          return {
            ok: true, settled: true, value: r.value, attempts, readFailures, abandonedReads,
            inFlight: false, lastReadFailed: false, valueStale: false, peakInFlight,
            // 读取期间到达的停止信号同样必须如实上报（调用方据此禁止重试/新请求）
            stopped: stoppedAt !== null || stopRequested(), timedOut: false, lastError: null,
            elapsedMs: now() - startMs,
          };
        }
      }
      if (stoppedAt === null && stopRequested()) stoppedAt = now();
      continue;
    }

    const limit = limitOf();
    const remaining = limit - now();
    // 至少读取一次（attempts === 0 不受预算限制）；之后只要预算耗尽就结束，不再发起新读取。
    if (attempts > 0 && remaining <= 0) break;
    // 硬性兜底：时钟不推进等异常情况下也不会无限循环。
    if (attempts >= maxAttempts) break;
    const wait = Math.max(0, Math.min(intervalMs, remaining));
    if (wait > 0) await sleep(wait);
    // 睡眠可能越过截止时间（分片抖动/系统休眠）：越界后不再发起新读取。
    if (attempts > 0 && now() >= limitOf()) break;

    inflight = startRead();
  }

  const stoppedNow = stoppedAt !== null || stopRequested();
  return {
    ok: false, settled: false, value: lastValue, attempts, readFailures, abandonedReads,
    inFlight: unreleased, lastReadFailed, peakInFlight,
    valueStale: unreleased || lastReadFailed || lastValue === null,
    stopped: stoppedNow, timedOut: !stoppedNow, lastError, elapsedMs: now() - startMs,
  };
}

module.exports = { boundedLandingPoll, resolvePollingConfig, POLLING_DEFAULTS };
