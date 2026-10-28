'use strict';

/**
 * 关闭流程 v2（单广告级）。
 *
 * 本轮修复的 Codex 复核问题：
 * - #2 回读不到广告（!cur.found）不能证明已关闭 → 进入"结果未知"，
 *   只有"精确身份 + 稳定 ID 定位到广告 + 明确的关闭/暂停状态"才确认成功；
 * - #7 Promise.race 超时不会取消底层关闭操作 → 引入按稳定 ID 的"在途请求登记"：
 *   超时后底层请求继续运行并登记在册，后续尝试先等它在途请求落定（或加入其结果），
 *   绝不在旧请求可能仍在执行时发出重叠的新请求；
 * - #6 停止信号：shouldAbortNewActions() 为真时不再发出新的关闭请求；
 *   已经发出的请求继续回读确认并记录。
 *
 * 其余原则保持：
 * - 点击成功 ≠ 关闭成功，必须回读；
 * - 结果未知（unknown）不自动重试关闭，等待人工核实后再由下一轮基于最新状态决定；
 * - 不提供、不调用"恢复投放"；每一步写审计。
 */

const { AuthError, PreCheckError, CloseOutcomeUnknownError } = require('../lib/errors');
const { checkControllerIdentity } = require('./guard');
const { isClosedStatus, isActiveStatus } = require('../adapters/ad-controller');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 getAd 结果判定"是否已在关闭侧"（开关/运行状态分离，页面证据优先）：
 * - 开关字段 switchChecked 布尔（千川列表/行级实测证据）→ 最优先；
 * - 适配器派生字段 alreadyClosedSide → 次之；
 * - 否则回退状态词表（mock/旧适配）。
 */
function alreadyClosedSideOf(cur) {
  if (typeof cur.switchChecked === 'boolean') return !cur.switchChecked;
  if (cur.alreadyClosedSide !== undefined) return cur.alreadyClosedSide === true;
  return isClosedStatus(cur.status);
}

/** 从 getAd 结果判定"当前可关闭"（投放侧），优先级同上。 */
function closableNowOf(cur) {
  if (typeof cur.switchChecked === 'boolean') return cur.switchChecked;
  if (cur.closableNow !== undefined) return cur.closableNow === true;
  return isActiveStatus(cur.status);
}

/** 以超时兜底地等待 promise；返回 {kind:'ok'} | {kind:'error',error} | {kind:'timeout'}。 */
async function awaitSettle(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), ms); });
  try {
    return await Promise.race([
      promise.then(() => ({ kind: 'ok' }), (e) => ({ kind: 'error', error: e })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 对单个广告执行"先复核再关闭再回读"的完整流程。
 *
 * @param {object} p
 * @param {object} p.controller          广告控制适配器（真实未接入 / mock）
 * @param {object|null} p.pageCtx        页面上下文（真实接入后传 page）
 * @param {object} p.shopCfg             店铺配置 { id, name?, accountId?, cookieFile }
 * @param {object} p.hit                 触发上下文 { adId, name, reason }
 * @param {object} p.opts                execution 配置（超时/重试/回读参数）
 * @param {(entry:object)=>void} [p.audit]   审计回调
 * @param {()=>boolean} [p.shouldAbortNewActions]  返回 true = 禁止发起新的关闭请求
 * @param {Map} [p.inflight]             跨调用共享的"在途关闭请求"登记表（按稳定 ID）
 * @returns {Promise<{outcome:'confirmed_closed'|'failed'|'unknown'|'skipped', attempts, beforeStatus?, afterStatus?, error?, note?}>}
 */
async function closeOneAd(p) {
  const { controller, pageCtx, shopCfg, hit, opts } = p;
  const audit = p.audit || (() => {});
  // shouldAbortNewActions() 返回 falsy=允许发起新请求；返回字符串=阻止原因（停止/跨日/超窗口）。
  // 该检查在每个"真正发出关闭请求"的时机执行（含重试后），已发出的请求继续回读确认。
  const shouldAbortNewActions = p.shouldAbortNewActions || (() => false);
  const inflight = p.inflight instanceof Map ? p.inflight : new Map();

  const maxRetries = opts.maxRetries ?? 2;
  let attempts = 0;
  let lastFail = { outcome: 'failed', error: '未执行' };

  const base = { step: 'close-flow', shopId: shopCfg.id, adId: hit.adId, adName: hit.name, adType: hit.adType || null, realMode: true };
  // 在途请求按 投放类型+稳定ID 标识（不同类型 ID 空间不同，不可混用）
  const inflightKey = `${hit.adType || 'unknown'}|${hit.adId}`;
  audit({ ...base, step: 'close-flow-start', trigger: hit.reason });

  const end = (result) => {
    audit({ ...base, step: 'close-flow-end', ...result });
    return result;
  };

  while (attempts <= maxRetries) {
    attempts += 1;

    // ── 1) 操作前身份复核（不匹配 → 放弃，绝不操作）────────────────
    try {
      const identity = await withTimeout(
        controller.verifyIdentity({ page: pageCtx, shopCfg }),
        opts.readbackTimeoutMs, '身份复核'
      );
      checkControllerIdentity(identity, shopCfg);
      audit({ ...base, step: 'precheck-identity', ok: true, attempt: attempts });
    } catch (e) {
      const reason = `操作前身份复核未通过：${e.reason || e.message}`;
      audit({ ...base, step: 'precheck-identity', ok: false, attempt: attempts, error: reason });
      return end({ outcome: 'failed', attempts, error: reason });
    }

    // ── 2) 操作前对象复核（稳定 ID 定位；开关/运行状态分离语义）────
    let beforeStatus = null;
    try {
      const cur = await withTimeout(controller.getAd({ page: pageCtx, shopCfg, adId: hit.adId, adType: hit.adType }), opts.readbackTimeoutMs, '对象状态读取');
      if (!cur.found) {
        const reason = `操作前对象复核未通过：稳定 ID ${hit.adId} 当前不存在（可能已删除或跨店铺），不操作`;
        audit({ ...base, step: 'precheck-ad', ok: false, attempt: attempts, error: reason });
        return end({ outcome: 'failed', attempts, error: reason });
      }
      beforeStatus = cur.status;
      if (cur.switchUnknown === true) {
        audit({ ...base, step: 'precheck-ad', note: '开关状态未知（详情页不展示开关），以运行状态/适配器语义判定', attempt: attempts });
      }
      if (alreadyClosedSideOf(cur)) {
        audit({ ...base, step: 'precheck-ad', ok: true, attempt: attempts, status: cur.status, note: '已在关闭侧（开关未开启或状态为关闭），跳过重复关闭' });
        return end({ outcome: 'skipped', attempts, beforeStatus, afterStatus: cur.status });
      }
      if (!closableNowOf(cur)) {
        const reason = `操作前对象复核未通过：广告当前状态为「${cur.status}」，不在可关闭状态`;
        audit({ ...base, step: 'precheck-ad', ok: false, attempt: attempts, status: cur.status, error: reason });
        return end({ outcome: 'failed', attempts, beforeStatus, error: reason });
      }
      audit({ ...base, step: 'precheck-ad', ok: true, attempt: attempts, status: cur.status, switchChecked: cur.switchChecked !== undefined ? cur.switchChecked : null });
    } catch (e) {
      if (e instanceof AuthError || e instanceof PreCheckError) throw e;
      const reason = `操作前对象复核失败：${e.reason || e.message}`;
      audit({ ...base, step: 'precheck-ad', ok: false, attempt: attempts, error: reason });
      return end({ outcome: 'failed', attempts, error: reason });
    }

    // ── 3) 关闭请求：加入在途请求或发起新请求（绝不重叠）────────────
    let entry = inflight.get(inflightKey);
    let joinedPending = false;
    let explicitUnknown = false;
    if (entry && !entry.settled) {
      // 旧的关闭请求仍在执行（可能是此前超时留下的）：等待它落定，不发新请求
      joinedPending = true;
      audit({ ...base, step: 'close-request', joined: true, attempt: attempts, note: '存在在途关闭请求，等待其落定，不发起重叠请求' });
      const join = await awaitSettle(entry.promise, opts.closeTimeoutMs);
      if (join.kind === 'timeout') {
        const reason = '在途关闭请求长时间未返回，结果未知；停止重试，等待人工核实';
        audit({ ...base, step: 'close-request', ok: false, unknown: true, attempt: attempts, error: reason });
        return end({ outcome: 'unknown', attempts, beforeStatus, error: reason });
      }
      if (join.kind === 'error') {
        lastFail = { outcome: 'failed', error: `在途关闭请求失败：${join.error && join.error.message}` };
        audit({ ...base, step: 'close-request', ok: false, attempt: attempts, error: lastFail.error });
        if (attempts <= maxRetries) { await sleep(opts.retryBackoffMs ?? 3000); continue; }
        return end({ outcome: 'failed', attempts, beforeStatus, error: lastFail.error });
      }
      audit({ ...base, step: 'close-request', ok: true, joined: true, attempt: attempts, note: '在途请求已成功完成' });
    } else {
      const abortReason = shouldAbortNewActions();
      if (abortReason) {
        const reason = typeof abortReason === 'string' ? abortReason : '收到停止信号：未发出新的关闭请求';
        audit({ ...base, step: 'close-request', skipped: true, attempt: attempts, note: reason });
        return end({ outcome: 'skipped', attempts, beforeStatus, error: reason, note: 'stopped_before_request' });
      }
      let closePromise;
      try {
        closePromise = controller.closeAd({ page: pageCtx, shopCfg, adId: hit.adId, adType: hit.adType });
      } catch (e) {
        const reason = `关闭请求发起失败：${e.message}`;
        audit({ ...base, step: 'close-request', ok: false, attempt: attempts, error: reason });
        if (attempts <= maxRetries) { await sleep(opts.retryBackoffMs ?? 3000); continue; }
        return end({ outcome: 'failed', attempts, beforeStatus, error: reason });
      }
      entry = { promise: closePromise, settled: false, outcome: null };
      inflight.set(inflightKey, entry);
      entry.promise.then(
        () => { entry.settled = true; entry.outcome = { kind: 'ok' }; },
        (e) => { entry.settled = true; entry.outcome = { kind: 'error', error: e }; }
      );
      const res = await awaitSettle(closePromise, opts.closeTimeoutMs);
      if (res.kind === 'timeout') {
        // 超时：结果未知；底层请求继续执行并保持在途登记，不得盲目重试
        audit({ ...base, step: 'close-request', ok: false, unknown: true, attempt: attempts, error: '关闭请求超时，结果未知（请求仍在执行，已登记在途）' });
      } else if (res.kind === 'error' && res.error instanceof CloseOutcomeUnknownError) {
        // 适配器明确报告"结果未知"：与超时同路处理，交由回读确认
        audit({ ...base, step: 'close-request', ok: false, unknown: true, attempt: attempts, error: res.error.message });
        explicitUnknown = true;
      } else if (res.kind === 'error') {
        lastFail = { outcome: 'failed', error: `关闭请求失败：${res.error && res.error.message}` };
        audit({ ...base, step: 'close-request', ok: false, attempt: attempts, error: lastFail.error });
        if (attempts <= maxRetries) { await sleep(opts.retryBackoffMs ?? 3000); continue; }
        return end({ outcome: 'failed', attempts, beforeStatus, error: lastFail.error });
      } else {
        audit({ ...base, step: 'close-request', ok: true, attempt: attempts });
      }
    }

    const requestUnknown = !entry.settled || explicitUnknown === true; // 超时未落定或显式未知

    // ── 4) 回读确认（已发出的请求必须继续回读并记录）────────────────
    let readbackStatus = null;   // 最近一次读到的状态文本
    let readbackError = null;
    for (let i = 1; i <= (opts.readbackAttempts ?? 3); i++) {
      await sleep(opts.readbackIntervalMs ?? 2000);
      try {
        const cur = await withTimeout(controller.getAd({ page: pageCtx, shopCfg, adId: hit.adId, adType: hit.adType }), opts.readbackTimeoutMs, '回读');
        if (!cur.found) {
          readbackStatus = '(不存在)';
          audit({ ...base, step: 'readback', ok: false, attempt: i, status: readbackStatus, note: '回读不到广告，不能证明已关闭' });
          continue; // 继续回读，不轻易下结论
        }
        readbackStatus = cur.status;
        if (alreadyClosedSideOf(cur)) {
          audit({ ...base, step: 'readback', ok: true, attempt: i, status: cur.status });
          const note = requestUnknown || joinedPending
            ? '关闭请求曾超时/为在途请求，已通过回读确认广告处于关闭侧'
            : '回读确认已关闭';
          return end({ outcome: 'confirmed_closed', attempts, beforeStatus, afterStatus: readbackStatus, note });
        }
        audit({ ...base, step: 'readback', ok: false, attempt: i, status: cur.status, note: '状态尚未进入关闭侧' });
      } catch (e) {
        readbackError = e.reason || e.message;
        readbackStatus = null;
        audit({ ...base, step: 'readback', ok: false, attempt: i, error: readbackError });
      }
    }

    // ── 5) 回读结论（关键修复：查无此广告 ≠ 已关闭）────────────────
    if (readbackStatus === '(不存在)') {
      const reason = `关闭后回读不到广告（稳定 ID ${hit.adId}）：查无此广告不能证明已关闭，结果未知，等待人工核实`;
      audit({ ...base, step: 'close-flow-end', outcome: 'unknown', beforeStatus, error: reason });
      return { outcome: 'unknown', attempts, beforeStatus, error: reason };
    }
    if (readbackStatus === null) {
      const reason = `关闭后回读失败，结果未知：${readbackError || '无法读取广告状态'}（请人工在页面确认广告 ${hit.adId} 实际状态）`;
      audit({ ...base, step: 'close-flow-end', outcome: 'unknown', beforeStatus, error: reason });
      return { outcome: 'unknown', attempts, beforeStatus, error: reason };
    }

    // 读到了明确状态但仍是投放中：
    if (requestUnknown) {
      // 关闭请求曾超时且在途 —— 先等在途请求落定（有界），再重读一次
      const join = await awaitSettle(entry.promise, opts.closeTimeoutMs);
      if (join.kind === 'timeout') {
        const reason = '关闭请求超时且迟迟未返回，结果未知，等待人工核实';
        audit({ ...base, step: 'close-flow-end', outcome: 'unknown', beforeStatus, error: reason });
        return { outcome: 'unknown', attempts, beforeStatus, error: reason };
      }
      if (join.kind === 'error') {
        lastFail = { outcome: 'failed', error: `延迟落定的关闭请求失败：${join.error && join.error.message}` };
        audit({ ...base, step: 'close-request', ok: false, delayed: true, error: lastFail.error });
        if (attempts <= maxRetries) { await sleep(opts.retryBackoffMs ?? 3000); continue; }
        return end({ outcome: 'failed', attempts, beforeStatus, afterStatus: readbackStatus, error: lastFail.error });
      }
      // 延迟成功 → 再读一次状态确认
      try {
        const cur2 = await withTimeout(controller.getAd({ page: pageCtx, shopCfg, adId: hit.adId, adType: hit.adType }), opts.readbackTimeoutMs, '延迟后回读');
        if (cur2.found && alreadyClosedSideOf(cur2)) {
          const note = '超时关闭请求延迟完成，再次回读确认已关闭';
          audit({ ...base, step: 'readback', ok: true, delayed: true, status: cur2.status, note });
          return end({ outcome: 'confirmed_closed', attempts, beforeStatus, afterStatus: cur2.status, note });
        }
        if (!cur2.found) {
          const reason = '延迟完成后的回读仍查无此广告，不能证明已关闭，结果未知';
          audit({ ...base, step: 'close-flow-end', outcome: 'unknown', beforeStatus, error: reason });
          return { outcome: 'unknown', attempts, beforeStatus, error: reason };
        }
        readbackStatus = cur2.status;
      } catch (e) {
        const reason = `延迟完成后的回读失败，结果未知：${e.message}`;
        audit({ ...base, step: 'close-flow-end', outcome: 'unknown', beforeStatus, error: reason });
        return { outcome: 'unknown', attempts, beforeStatus, error: reason };
      }
    }

    const reason = `关闭未生效：回读状态仍为「${readbackStatus}」（第 ${attempts} 次尝试）`;
    audit({ ...base, step: 'close-flow-retry', outcome: 'failed', error: reason });
    lastFail = { outcome: 'failed', error: reason, beforeStatus, afterStatus: readbackStatus };
    if (attempts <= maxRetries) {
      await sleep(opts.retryBackoffMs ?? 3000);
      continue;
    }
    return end({ outcome: 'failed', attempts, beforeStatus, afterStatus: readbackStatus, error: reason });
  }

  return end({ outcome: lastFail.outcome, attempts, error: lastFail.error });
}

module.exports = { closeOneAd, withTimeout };
