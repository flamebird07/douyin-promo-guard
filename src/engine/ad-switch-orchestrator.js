'use strict';

/**
 * 开关动作编排器：决策层 + 串行门外层（不复制 Playwright；execute 复用 runner/executor）。
 *
 * 统一路径：每日 07:00 开启、低于阈值开启、高于阈值暂停。
 *
 * 流程：
 *   1) 本轮回读 currentAdState（on/off/unknown；adBelief 不得代替）；
 *   2) decideAdSwitchAction（周期）或日程意图（07:00）；
 *   3) 仅 should_enable→enable / should_pause→pause 继续，其余零点击；
 *   4) createSwitchSerialGate.tryBegin 登记 actionId；
 *   5) 动作前再次回读 + 再决策；已变 → markNotSent（明确未发出）并零点击；
 *   6) 调用 execute（现有 runner/executor）；
 *   7) 按生命周期收口：明确未发出 markNotSent；可能已发出/回读失败 markUnknown；
 *      最新回读确认目标状态后 markConfirmed+markSettled(CONFIRMED) 或
 *      resolveUnknownAfterReadback(..., confirmed:true)。
 *
 * 旧 actionId 不得影响新动作（由 switch-serial 保证）。
 * 回读未确认目标达成 → 保持阻塞，不自动补点。
 */

const { decideAdSwitchAction, DECISION } = require('./ad-switch-decision');
const { createSwitchSerialGate, SETTLE_KIND } = require('./switch-serial');
const { normalizeAdState } = require('./ad-switch-state');

const ZERO_CLICK_DECISIONS = new Set([
  DECISION.ALREADY_ON,
  DECISION.ALREADY_OFF,
  DECISION.EQUAL_NO_ACTION,
  DECISION.UNKNOWN_BLOCKED,
  DECISION.DATA_BLOCKED,
]);

/**
 * 执行结果契约 → 串行门收口类（严格 outcome / === true，禁止字符串模糊匹配）。
 *
 * never_sent —— 代码证明本次未发出业务动作（门槛/窗口/停止/取消/演练；
 *   或完整清单核验后 0 目标：nothing_to_close / nothing_to_pause / nothing_to_enable）。
 * confirmed  —— 已执行且回读确认目标状态（按动作类型绑定结果码/布尔）。
 * unknown    —— 可能已发出、结果未确认（partial/超时/异常/无法证明）→ 保持阻塞。
 */
const NEVER_SENT_OUTCOMES = new Set([
  'blocked', 'blocked_window', 'blocked_stopped', 'blocked_coverage',
  'cancelled', 'dry', 'dry_failed', 'persistence_blocked',
  'nothing_to_close', 'nothing_to_pause', 'nothing_to_enable',
]);
const CONFIRMED_PAUSE_OUTCOMES = new Set(['all_closed_confirmed', 'all_paused_confirmed']);
const CONFIRMED_ENABLE_OUTCOMES = new Set(['all_enabled_confirmed']);

function pickOutcome(r) {
  if (!r || typeof r !== 'object') return null;
  const nested = r.batch && typeof r.batch === 'object' ? r.batch : null;
  return r.outcome || (nested && nested.outcome) || null;
}

function flagTrue(v) {
  return v === true;
}

/** 本轮已发出的业务动作计数（confirmed/failed/unknown）；名称不能代替证据。 */
function dispatchedCount(r) {
  const nested = (r && r.batch && typeof r.batch === 'object') ? r.batch : {};
  const c = (r && r.counts) || nested.counts || {};
  const n = (x) => (Number.isFinite(x) ? x : 0);
  return n(c.confirmed) + n(c.failed) + n(c.unknown);
}

/**
 * @param {'enable'|'pause'} action
 * @param {object} r execute 返回（可含嵌套 batch）
 * @returns {'never_sent'|'confirmed'|'unknown'}
 */
function classifyExecuteResult(action, r) {
  const nested = (r && r.batch && typeof r.batch === 'object') ? r.batch : {};
  const outcome = pickOutcome(r);
  const sent = dispatchedCount(r);

  // 1) 明确未发出：须有证据（neverSent/dryRun 标志或 0 已发出计数）。
  //    名称本身不够：若 counts 显示已发出 → 不得 not_sent。
  const claimsNotSent =
    (r && (r.neverSent === true || r.dryRun === true)) ||
    (outcome && NEVER_SENT_OUTCOMES.has(outcome)) ||
    (nested.outcome && NEVER_SENT_OUTCOMES.has(nested.outcome));
  if (claimsNotSent) {
    return sent === 0 ? 'never_sent' : 'unknown';
  }

  // 2) 已执行且回读确认（动作类型绑定；缺失字段不当作否定证据）
  if (action === 'pause') {
    if (
      flagTrue(r && r.allClosedConfirmed) || flagTrue(nested.allClosedConfirmed) ||
      flagTrue(r && r.allPausedConfirmed) || flagTrue(nested.allPausedConfirmed) ||
      (outcome && CONFIRMED_PAUSE_OUTCOMES.has(outcome)) ||
      (nested.outcome && CONFIRMED_PAUSE_OUTCOMES.has(nested.outcome))
    ) {
      return 'confirmed';
    }
  } else if (action === 'enable') {
    if (
      flagTrue(r && r.allEnabledConfirmed) || flagTrue(nested.allEnabledConfirmed) ||
      (outcome && CONFIRMED_ENABLE_OUTCOMES.has(outcome)) ||
      (nested.outcome && CONFIRMED_ENABLE_OUTCOMES.has(nested.outcome))
    ) {
      return 'confirmed';
    }
  }

  // 3) 可能已发出 / 未确认（含部分完成后中止）
  return 'unknown';
}

class AdSwitchOrchestrator {
  /**
   * @param {object} p
   * @param {ReturnType<typeof createSwitchSerialGate>} [p.gate]
   * @param {(e:object)=>void} [p.audit]
   */
  constructor(p = {}) {
    this.gate = p.gate || createSwitchSerialGate();
    this.audit = p.audit || (() => {});
  }

  /** 周期评估：费用/订单/阈值 + 本轮 currentAdState + identityOk → decision。 */
  evaluatePeriodic({ costCents, orders, thresholdCents, currentAdState, identityOk, dataError = null, adStateSource = null }) {
    return decideAdSwitchAction({
      costCents,
      orders,
      thresholdCents,
      currentAdState: normalizeAdState(currentAdState),
      identityOk,
      dataError,
      adStateSource,
    });
  }

  /**
   * 每日 07:00 开启意图（不读费用/订单，不用阈值）。
   * currentAdState 必须来自本轮回读；identityOk 严格 true。
   * @returns {{decision:string, action:'enable'|null, zeroClick:boolean, reason:string}}
   */
  evaluateDailyEnable({ currentAdState, identityOk }) {
    const st = normalizeAdState(currentAdState);
    if (identityOk !== true) {
      return {
        decision: DECISION.DATA_BLOCKED,
        action: null,
        zeroClick: true,
        blocked: 'identity_mismatch',
        reason: 'identityOk 不是严格 true：每日开启 fail-closed，零动作',
      };
    }
    if (st === 'on') {
      return {
        decision: DECISION.ALREADY_ON,
        action: null,
        zeroClick: true,
        reason: '本轮回读已在投放中（already_on），无需开启：跳过开启进程（不打开浏览器、零请求）',
      };
    }
    if (st === 'off' || st === 'mixed') {
      return {
        decision: DECISION.SHOULD_ENABLE,
        action: 'enable',
        zeroClick: false,
        reason: st === 'mixed'
          ? '本轮回读 mixed：每日开启仅开启 off 项（should_enable）'
          : '本轮回读当前为关闭且处于每日开启窗口：需要开启（should_enable）',
      };
    }
    return {
      decision: DECISION.UNKNOWN_BLOCKED,
      action: null,
      zeroClick: true,
      blocked: 'unknown_ad_state',
      reason: '本轮回读当前状态为 unknown：每日开启 fail-closed，零点击',
    };
  }

  /**
   * 统一执行开关动作（串行门 + 动作前复核 + 生命周期收口）。
   *
   * @param {object} p
   * @param {string} p.shopId
   * @param {'enable'|'pause'} p.action
   * @param {()=>Promise<'on'|'off'|'unknown'>} p.readState  本轮页面/清单回读
   * @param {()=>Promise<object>} p.execute  现有 runner/executor 入口（复用，不复制 Playwright）
   * @param {(state:string)=>object} p.decide  给定 currentAdState 的决策（周期或日程）
   * @param {'on'|'off'} p.targetState  目标状态（enable→on / pause→off）
   * @returns {Promise<object>}
   */
  async runSwitchAction({ shopId, action, readState, execute, decide, targetState, allowAlreadyOffPause = false, persistBeforeRelease = null }) {
    const base = { shopId, action, targetState };
    const opts = { allowAlreadyOffPause };
    if (action !== 'enable' && action !== 'pause') {
      return { ...base, ok: false, zeroClick: true, reason: `action 非法：${action}` };
    }
    const want = action === 'enable' ? DECISION.SHOULD_ENABLE : DECISION.SHOULD_PAUSE;
    // 超标盘点：pause + already_off 允许进入执行器做只读盘点（0 关闭，返回 nothing_to_close）
    const allowOffInventory = opts.allowAlreadyOffPause === true && action === 'pause';
    const proceedOk = (d) => {
      if (d.decision === want && d.zeroClick === false) return true;
      if (allowOffInventory && d.decision === DECISION.ALREADY_OFF) return true;
      return false;
    };

    // ── 1) 本轮回读 + 决策 ───────────────────────────────────────
    let state1;
    try {
      state1 = normalizeAdState(await readState());
    } catch (e) {
      this.audit({ kind: 'ad-switch', step: 'read-state', shopId, ok: false, error: e.message });
      return { ...base, ok: false, zeroClick: true, decision: DECISION.UNKNOWN_BLOCKED, reason: `本轮状态回读失败：${e.message}` };
    }
    const d1 = decide(state1);
    if (!proceedOk(d1)) {
      this.audit({ kind: 'ad-switch', step: 'decide', shopId, decision: d1.decision, currentAdState: state1, zeroClick: true });
      return {
        ...base,
        ok: true,
        zeroClick: true,
        decision: d1.decision,
        currentAdState: state1,
        reason: d1.reason,
        metric: d1.metric || null,
      };
    }

    // ── 2) 串行门登记 actionId ───────────────────────────────────
    const begin = this.gate.tryBegin(shopId, action);
    if (!begin.ok) {
      this.audit({ kind: 'ad-switch', step: 'serial-gate', shopId, ok: false, reason: begin.reason });
      return {
        ...base,
        ok: false,
        zeroClick: true,
        blocked: 'serial_gate',
        decision: d1.decision,
        currentAdState: state1,
        reason: begin.reason,
        inflight: begin.inflight || null,
      };
    }
    const actionId = begin.actionId;
    this.audit({ kind: 'ad-switch', step: 'begin', shopId, action, actionId, decision: d1.decision });

    try {
      // ── 3) 动作前再次回读 + 再决策（未发出时可 markNotSent）────
      let state2;
      try {
        state2 = normalizeAdState(await readState());
      } catch (e) {
        // 尚未调用 execute → 明确未发出
        this.gate.markNotSent(shopId, actionId);
        this.audit({ kind: 'ad-switch', step: 're-read', shopId, actionId, ok: false, error: e.message });
        return {
          ...base,
          ok: true,
          zeroClick: true,
          actionId,
          decision: DECISION.UNKNOWN_BLOCKED,
          reason: `动作前复核回读失败（明确未发出）：${e.message}`,
        };
      }
      const d2 = decide(state2);
      if (!proceedOk(d2)) {
        this.gate.markNotSent(shopId, actionId);
        this.audit({ kind: 'ad-switch', step: 're-decide', shopId, actionId, decision: d2.decision, currentAdState: state2, zeroClick: true });
        return {
          ...base,
          ok: true,
          zeroClick: true,
          actionId,
          decision: d2.decision,
          currentAdState: state2,
          reason: `动作前复核状态已变化（${d2.decision}），明确未发出，零点击`,
        };
      }

      // ── 4) 复用现有 runner/executor ────────────────────────────
      let result;
      try {
        result = await execute();
      } catch (e) {
        // execute 抛出：可能已发出 → markUnknown（禁止补点）
        this.gate.markUnknown(shopId, actionId, `execute 异常：${e.message}`);
        this.audit({ kind: 'ad-switch', step: 'execute', shopId, actionId, ok: false, unknown: true, error: e.message });
        return {
          ...base,
          ok: false,
          zeroClick: false,
          actionId,
          decision: d2.decision,
          serial: 'unknown',
          reason: `执行异常，结果未知，保持阻塞：${e.message}`,
        };
      }

      // ── 5) 生命周期收口 ────────────────────────────────────────
      return this._settleFromExecute({ ...base, actionId, decision: d2.decision, currentAdState: state2, result, targetState, persistBeforeRelease });
    } catch (e) {
      // 兜底：tryBegin 之后的意外异常 → 视为可能已发出
      try { this.gate.markUnknown(shopId, actionId, e.message); } catch (_) { /* 已结束则忽略 */ }
      throw e;
    }
  }

  /**
   * 把 runner/executor 批次结果映射为串行门收口。
   * 契约见 classifyExecuteResult：never_sent→markNotSent 且 zeroClick（须 0 已发出证据）；
   * confirmed→确认释放；unknown/partial → markUnknown 保持阻塞。
   */
  async _settleFromExecute({ shopId, action, actionId, decision, currentAdState, result, targetState, persistBeforeRelease = null }) {
    const r = result || {};
    const base = { shopId, action, actionId, decision, currentAdState, targetState, zeroClick: false };
    const cls = classifyExecuteResult(action, r);
    const sent = dispatchedCount(r);

    if (cls === 'never_sent') {
      const n = this.gate.markNotSent(shopId, actionId, { persist: persistBeforeRelease || undefined });
      if (n && n.persistFailed === true) {
        // 动作前/未发出且 0 已发出：zeroClick=true；但终态未落盘 → serial=unknown 保持门闩
        const reason = `persistence_blocked: not_sent 终态持久化失败，保持阻塞；底层：${n.reason || '未知'}`;
        const u = this.gate.markUnknown(shopId, actionId, reason);
        this.audit({ kind: 'ad-switch', step: 'settle', shopId, actionId, serial: 'unknown', outcome: 'persistence_blocked', class: 'persistence_blocked', dispatched: sent, reason });
        return {
          ...base,
          ok: false,
          serial: 'unknown',
          zeroClick: true,
          outcome: 'persistence_blocked',
          actionId,
          reason,
          batch: r,
          dispatched: sent,
          persistence: { ok: false, reason: n.reason || null },
          settleOk: u.ok === true,
        };
      }
      const outcome = (r && r.outcome === 'persistence_blocked') ? 'persistence_blocked' : pickOutcome(r);
      this.audit({ kind: 'ad-switch', step: 'settle', shopId, actionId, serial: 'not_sent', outcome, class: cls, dispatched: sent });
      return {
        ...base,
        ok: true,
        serial: 'not_sent',
        zeroClick: true,
        outcome,
        actionId,
        reason: r.reason || '明确未发出（或完整核验无待执行目标），释放串行门',
        batch: r,
        dispatched: sent,
        persistence: null,
        settleOk: n.ok === true,
      };
    }

    if (cls === 'confirmed') {
      const c = this.gate.markConfirmed(shopId, actionId);
      const s = this.gate.markSettled(shopId, actionId, {
        kind: SETTLE_KIND.CONFIRMED,
        persist: persistBeforeRelease || undefined,
      });
      if (s && s.persistFailed === true) {
        const reason = s.reason || 'persistence_blocked: 确认完成状态保存失败，保持阻塞';
        this.audit({ kind: 'ad-switch', step: 'settle', shopId, actionId, serial: 'unknown', outcome: pickOutcome(r), class: 'persistence_blocked', reason });
        return {
          ...base,
          ok: false,
          serial: 'unknown',
          zeroClick: false,
          outcome: pickOutcome(r),
          actionId,
          reason,
          batch: r,
          dispatched: sent,
          persistence: { ok: false, reason: s.reason || null },
          settleOk: false,
        };
      }
      this.audit({ kind: 'ad-switch', step: 'settle', shopId, actionId, serial: 'confirmed', outcome: pickOutcome(r), class: cls, dispatched: sent });
      return {
        ...base,
        ok: true,
        serial: 'confirmed',
        zeroClick: false,
        outcome: pickOutcome(r),
        actionId,
        reason: r.reason || r.confirmReason || '回读确认目标状态已达成',
        batch: r,
        dispatched: sent,
        settleOk: c.ok === true && s.ok === true,
      };
    }
    // unknown：可能已发出、结果未确认（含部分完成后中止）→ 保持阻塞，不补点
    const reason = r.reason || r.confirmReason || '动作可能已发出但回读未确认目标状态：保持 unknown 阻塞';
    const u = this.gate.markUnknown(shopId, actionId, reason);
    this.audit({ kind: 'ad-switch', step: 'settle', shopId, actionId, serial: 'unknown', outcome: pickOutcome(r), class: cls, dispatched: sent, reason });
    return {
      ...base,
      ok: false,
      serial: 'unknown',
      zeroClick: false,
      outcome: pickOutcome(r),
      reason,
      batch: r,
      dispatched: sent,
      settleOk: u.ok === true,
    };
  }

  /**
   * 用最新回读恢复 unknown（唯一恢复入口；confirmed===true 才释放）。
   * 回读未确认目标达成 → 保持阻塞。
   */
  resolveUnknownWithReadback(shopId, actionId, { confirmed, note, persist } = {}) {
    // 终态落盘门禁：与 markSettled(CONFIRMED) 同序 settled→persist→delete
    const r = this.gate.resolveUnknownAfterReadback(shopId, actionId, {
      confirmed: confirmed === true,
      note: note || null,
    }, { persist: persist || undefined });
    this.audit({
      kind: 'ad-switch',
      step: 'resolve-unknown',
      shopId,
      actionId,
      ok: r.ok === true,
      confirmed: confirmed === true,
      reason: r.reason || null,
    });
    return r;
  }

  isBusy(shopId) {
    return this.gate.isBusy(shopId);
  }

  hasUnknownBlock(shopId) {
    return this.gate.hasUnknownBlock(shopId);
  }

  peek(shopId) {
    return this.gate.peek(shopId);
  }

  exportState() {
    return typeof this.gate.exportState === 'function' ? this.gate.exportState() : { slots: [] };
  }
}

module.exports = {
  AdSwitchOrchestrator,
  ZERO_CLICK_DECISIONS,
  classifyExecuteResult,
  dispatchedCount,
  NEVER_SENT_OUTCOMES,
  createSwitchSerialGate,
  SETTLE_KIND,
  DECISION,
};
