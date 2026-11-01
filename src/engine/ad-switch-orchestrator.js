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
 *
 * mixed 不是合法完成态：旧动作回读 mixed 时，由 reconcileMixedAndReoperate 用本轮新鲜
 * 清单/费用/订单/最新阈值重判目标，证据齐全后把旧动作如实收口为「未收敛」（不标
 * confirmed），原子登记下一动作，再走同一真实链路做一次修复；仍 mixed → 待重判。
 *
 * 预登记槽位（mixed 交接的下一动作）不得成为"永久在途"：任何在 execute 之前的返回
 * （首读失败/首次决策抛错/首次决策结果非法/首读已是目标态/方向变化/店铺停用/身份变化/
 * 停止代数/窗口关闭/动作非法）都必须对该**精确 actionId** 做可持久化的「明确未发出」收口；
 * 落盘失败一律退回 unknown 阻塞（fail-closed），绝不留下 busy=true 且 unknown=false 的不死槽。
 */

const { decideAdSwitchAction, DECISION } = require('./ad-switch-decision');
const { createSwitchSerialGate, SETTLE_KIND, HANDOFF_KIND } = require('./switch-serial');
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
    // 本进程在途执行器计数（mixed 交接证据来源；不靠 sleep 猜旧动作是否结束）
    this._execInflight = new Map();
  }

  /**
   * mixed 交接的执行侧证据：本进程该店是否仍有 execute() 在途。
   * 在途未结束 → 一律拒绝交接（只能等下一轮或如实 blocked）。
   */
  mixedInflightProof(shopId) {
    const n = this._execInflight.get(String(shopId)) || 0;
    return { executorFinished: n === 0, noInflightWrites: n === 0, inflight: n };
  }

  /**
   * 预登记（mixed 交接原子登记的下一动作）槽位——「代码证明未发出」收口。
   *
   * 只接受精确 shopId + actionId、且仍在途（非 unknown、非 settled）的槽：
   *   - unknown 槽不得经此释放（可能已发出，只能走回读确认入口）；
   *   - 不是本 actionId（迟到回调/别的店/已被替换）一律拒绝，不动别的槽；
   *   - 终态必须先落盘（persist 同步 ok===true），落盘失败 → markUnknown 保持阻塞
   *     （fail-closed：宁可继续挡下一轮，也不留下"内存已释放、磁盘未记"的分裂态）。
   *
   * @param {string} shopId
   * @param {string} actionId
   * @param {string} reason  收口原因（进入审计与槽位记录）
   * @param {()=>object} [persist]  同步落盘（返回 {ok,reason}）
   * @returns {{ok:boolean, released:boolean, persistFailed?:boolean, serial?:string, reason?:string}}
   */
  settlePreActionNotSent(shopId, actionId, reason, persist = null, step = 'pre-action-release') {
    const cur = this.gate.peek(shopId);
    if (!cur || cur.actionId !== actionId) {
      // 不是本动作（迟到回调/已被替换）：绝不触碰他人槽位
      return { ok: false, released: false, reason: `预登记槽不匹配（当前=${cur ? cur.actionId : '无'}，本次=${actionId}）：不做收口` };
    }
    if (cur.settled === true) return { ok: true, released: true, reason: '槽位已结束（幂等）' };
    if (cur.unknown === true) {
      return { ok: false, released: false, reason: `槽位已是 unknown（可能已发出）：不得伪未发出（${actionId}）` };
    }
    const n = this.gate.markNotSent(shopId, actionId, { persist: persist || undefined });
    if (n && n.persistFailed === true) {
      const u = this.gate.markUnknown(shopId, actionId, `persistence_blocked: 未发出终态落盘失败（${n.reason || '未知'}），保持阻塞`);
      this.audit({ kind: 'ad-switch', step, shopId, actionId, ok: false, serial: 'unknown', outcome: 'persistence_blocked', reason: n.reason || null });
      return {
        ok: false,
        released: false,
        persistFailed: true,
        serial: 'unknown',
        settleOk: u.ok === true,
        innerReason: n.reason || null,
        reason: `persistence_blocked: 未发出终态落盘失败，保持 unknown 阻塞：${n.reason || '未知'}`,
      };
    }
    this.audit({ kind: 'ad-switch', step, shopId, actionId, ok: n.ok === true, serial: 'not_sent', reason: reason || null });
    return { ok: n.ok === true, released: n.ok === true, reason: n.reason || reason || null };
  }

  /**
   * 「execute 之前、代码证明未发出」的通用精确收口（含串行门正常登记路径）。
   * 只结束精确 actionId；落盘失败由 settlePreActionNotSent 内部转 markUnknown（fail-closed）。
   */
  _releaseNotSent(shopId, actionId, reason, persist, step) {
    return this.settlePreActionNotSent(shopId, actionId, reason, persist, step);
  }

  /**
   * 预登记槽位——「是否已发出无法证明」收口（execute 抛出、runAction 抛错/提前返回等）。
   * 一律 markUnknown 保持阻塞，绝不伪装未发出，也绝不释放。
   */
  markPreActionUnknown(shopId, actionId, reason) {
    const cur = this.gate.peek(shopId);
    if (!cur || cur.actionId !== actionId) {
      return { ok: false, reason: `预登记槽不匹配（当前=${cur ? cur.actionId : '无'}，本次=${actionId}）：不做标记` };
    }
    const u = this.gate.markUnknown(shopId, actionId, reason || '结果未知：保持阻塞，禁止补点');
    this.audit({ kind: 'ad-switch', step: 'pre-action-unknown', shopId, actionId, ok: u.ok === true, serial: 'unknown', reason: reason || null });
    return { ok: u.ok === true, serial: 'unknown', reason: reason || u.reason || null };
  }

  /** 周期评估：费用/订单/阈值 + 本轮 currentAdState + identityOk → decision。 */
  evaluatePeriodic({ costCents, orders, thresholdCents, currentAdState, identityOk, identityReason = null, dataError = null, adStateSource = null }) {
    return decideAdSwitchAction({
      costCents,
      orders,
      thresholdCents,
      currentAdState: normalizeAdState(currentAdState),
      identityOk,
      identityReason,
      dataError,
      adStateSource,
    });
  }

  /**
   * 每日 07:00 开启意图（不读费用/订单，不用阈值）。
   * currentAdState 必须来自本轮回读；identityOk 严格 true。
   * @param {string|null} [identityReason] 身份未通过的具体原因（如"待身份核验：…"）
   * @returns {{decision:string, action:'enable'|null, zeroClick:boolean, reason:string}}
   */
  evaluateDailyEnable({ currentAdState, identityOk, identityReason = null }) {
    const st = normalizeAdState(currentAdState);
    if (identityOk !== true) {
      return {
        decision: DECISION.DATA_BLOCKED,
        action: null,
        zeroClick: true,
        blocked: 'identity_mismatch',
        reason: identityReason
          ? `${identityReason}：每日开启 fail-closed，零动作`
          : 'identityOk 不是严格 true：每日开启 fail-closed，零动作',
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
   * @param {string} [p.preActionId]  已由 mixed 交接原子登记的 actionId（沿用，不重复占槽）
   * @returns {Promise<object>}
   */
  async runSwitchAction({ shopId, action, readState, execute, decide, targetState, allowAlreadyOffPause = false, persistBeforeRelease = null, preActionId = null }) {
    const base = { shopId, action, targetState };
    const opts = { allowAlreadyOffPause };
    if (action !== 'enable' && action !== 'pause') {
      // 预登记槽存在但动作非法：代码证明未发出 → 精确收口该 actionId（不得留不死槽、不动别的槽）
      const pre = preActionId != null
        ? this.settlePreActionNotSent(shopId, preActionId, `动作非法：${action}`, persistBeforeRelease)
        : null;
      return {
        ...base,
        ok: pre ? pre.ok : false,
        zeroClick: true,
        reason: `action 非法：${action}`,
        ...(pre && pre.persistFailed === true ? { serial: 'unknown', blocked: 'persistence' } : {}),
      };
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
      // execute 尚未被调用 → 可证明未发出；预登记槽必须精确收口，否则永远 busy
      const pre = preActionId != null
        ? this.settlePreActionNotSent(shopId, preActionId, `首读回读失败：${e.message}`, persistBeforeRelease)
        : null;
      return {
        ...base,
        ok: pre ? pre.ok !== false : false,
        zeroClick: true,
        decision: DECISION.UNKNOWN_BLOCKED,
        reason: `本轮状态回读失败：${e.message}`,
        ...(pre && pre.persistFailed === true ? { serial: 'unknown', blocked: 'persistence', persistence: { ok: false, reason: pre.reason } } : {}),
      };
    }
    // 首次决策发生在 execute 之前：任何抛错或非法决策结果都可证明未发出，
    // 必须对精确 actionId 做可持久化的「未发出」收口（否则 mixed 交接登记的新槽
    // 会永久 busy=true/unknown=false/settled=false，形成不死槽）。落盘失败退回 unknown
    // （fail-closed），绝不释放别的槽、绝不伪旧动作 confirmed、绝不伪收敛。
    let d1;
    try {
      d1 = decide(state1);
    } catch (e) {
      this.audit({ kind: 'ad-switch', step: 'decide', shopId, currentAdState: state1, ok: false, error: e.message });
      const pre = preActionId != null
        ? this.settlePreActionNotSent(shopId, preActionId, `首次决策异常（未发出）：${e.message}`, persistBeforeRelease)
        : null;
      return {
        ...base,
        ok: pre ? pre.ok !== false : false,
        zeroClick: true,
        decision: DECISION.UNKNOWN_BLOCKED,
        currentAdState: state1,
        reason: `首次决策异常（明确未发出）：${e.message}`,
        ...(pre && pre.persistFailed === true
          ? { serial: 'unknown', blocked: 'persistence', persistence: { ok: false, reason: pre.reason } }
          : (pre ? { preActionReleased: pre.released === true, slotReleased: pre.released === true } : {})),
      };
    }
    if (!d1 || typeof d1 !== 'object' || typeof d1.decision !== 'string') {
      // 非法决策结果（decide 返回 null/缺 decision）：同样在 execute 之前 → 可证明未发出，精确收口本槽
      this.audit({ kind: 'ad-switch', step: 'decide', shopId, currentAdState: state1, ok: false, reason: '首次决策结果非法：未发出' });
      const pre = preActionId != null
        ? this.settlePreActionNotSent(shopId, preActionId, '首次决策结果非法（未发出）', persistBeforeRelease)
        : null;
      return {
        ...base,
        ok: pre ? pre.ok !== false : false,
        zeroClick: true,
        decision: DECISION.UNKNOWN_BLOCKED,
        currentAdState: state1,
        reason: '首次决策结果非法（无 decision 字段）：fail-closed，零点击',
        ...(pre && pre.persistFailed === true
          ? { serial: 'unknown', blocked: 'persistence', persistence: { ok: false, reason: pre.reason } }
          : (pre ? { preActionReleased: pre.released === true, slotReleased: pre.released === true } : {})),
      };
    }
    if (!proceedOk(d1)) {
      this.audit({ kind: 'ad-switch', step: 'decide', shopId, decision: d1.decision, currentAdState: state1, zeroClick: true });
      // 首读即零动作（已达目标/方向变化/等保持/被阻止）：未发出可证明 → 精确收口预登记槽
      const pre = preActionId != null
        ? this.settlePreActionNotSent(shopId, preActionId, `首读决策 ${d1.decision}：未发出`, persistBeforeRelease)
        : null;
      return {
        ...base,
        ok: pre ? pre.ok !== false : true,
        zeroClick: true,
        decision: d1.decision,
        currentAdState: state1,
        reason: d1.reason,
        metric: d1.metric || null,
        ...(pre && pre.persistFailed === true
          ? { serial: 'unknown', blocked: 'persistence', persistence: { ok: false, reason: pre.reason } }
          : (pre ? { preActionReleased: pre.released === true, slotReleased: pre.released === true } : {})),
      };
    }

    // ── 2) 串行门登记 actionId ───────────────────────────────────
    // mixed 交接已**原子**登记的下一动作槽位直接沿用（同一 actionId 走完真实链路），
    // 绝不重复占槽，也不因「自己刚登记的槽」把自己挡在门外。
    let actionId = null;
    if (preActionId != null) {
      const cur = this.gate.peek(shopId);
      const mine = !!(cur && cur.actionId === preActionId);
      if (!mine) {
        this.audit({ kind: 'ad-switch', step: 'serial-gate', shopId, ok: false, reason: `mixed 交接槽位不可用（preActionId=${preActionId}）：零新广告动作` });
        return {
          ...base,
          ok: false,
          zeroClick: true,
          blocked: 'serial_gate',
          decision: d1.decision,
          currentAdState: state1,
          reason: `mixed 交接槽位不可用（preActionId=${preActionId}）：零新广告动作`,
          inflight: cur ? { actionId: cur.actionId, action: cur.action, unknown: cur.unknown === true } : null,
        };
      }
      if (cur.settled === true) {
        // 已结束的预登记槽：不重复使用，也不制造新动作（幂等，零点击）
        return { ...base, ok: false, zeroClick: true, blocked: 'pre_action_settled', decision: d1.decision, currentAdState: state1, reason: `mixed 交接槽位已结束（preActionId=${preActionId}）：零新广告动作` };
      }
      if (cur.unknown === true) {
        // 已是 unknown（可能已发出）：不得当作未发出，也不得据此发新动作
        return { ...base, ok: false, zeroClick: true, blocked: 'serial_gate', decision: d1.decision, currentAdState: state1, serial: 'unknown', reason: `mixed 交接槽位已转 unknown（preActionId=${preActionId}）：保持阻塞，零新广告动作`, inflight: { actionId: cur.actionId, action: cur.action, unknown: true } };
      }
      if (cur.action !== action) {
        // 方向与登记不符：调用方错误，代码证明未发出 → 精确收口本 actionId（不动别的槽）
        const pre = this.settlePreActionNotSent(shopId, preActionId, `预登记动作=${cur.action} 与本次=${action} 不符`, persistBeforeRelease);
        return {
          ...base,
          ok: pre.ok === true,
          zeroClick: true,
          blocked: pre.persistFailed === true ? 'persistence' : 'pre_action_mismatch',
          decision: d1.decision,
          currentAdState: state1,
          reason: `预登记动作（${cur.action}）与本次动作（${action}）不符：零新广告动作`,
          ...(pre.persistFailed === true ? { serial: 'unknown', persistence: { ok: false, reason: pre.reason } } : {}),
        };
      }
      actionId = preActionId;
      this.audit({ kind: 'ad-switch', step: 'begin', shopId, action, actionId, decision: d1.decision, preRegistered: true });
    } else {
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
      actionId = begin.actionId;
      this.audit({ kind: 'ad-switch', step: 'begin', shopId, action, actionId, decision: d1.decision });
    }

    try {
      // ── 3) 动作前再次回读 + 再决策（未发出时可 markNotSent）────
      let state2;
      try {
        state2 = normalizeAdState(await readState());
      } catch (e) {
        // 尚未调用 execute → 明确未发出：精确收口本 actionId，并落盘（失败 fail-closed）
        const rel = this._releaseNotSent(shopId, actionId, `动作前复核回读失败（明确未发出）：${e.message}`, persistBeforeRelease, 're-read');
        if (rel.persistFailed === true) {
          return {
            ...base,
            ok: false,
            zeroClick: true,
            actionId,
            serial: 'unknown',
            blocked: 'persistence',
            decision: DECISION.UNKNOWN_BLOCKED,
            reason: rel.reason,
            persistence: { ok: false, reason: rel.innerReason || rel.reason },
          };
        }
        return {
          ...base,
          ok: true,
          zeroClick: true,
          actionId,
          slotReleased: true,
          decision: DECISION.UNKNOWN_BLOCKED,
          reason: `动作前复核回读失败（明确未发出）：${e.message}`,
        };
      }
      let d2;
      try {
        d2 = decide(state2);
      } catch (e) {
        // decide 抛错发生在 execute 之前 → 代码证明未发出：可持久化收口，不落入兜底 markUnknown
        const rel = this._releaseNotSent(shopId, actionId, `动作前复核决策异常（未发出）：${e.message}`, persistBeforeRelease, 're-decide-error');
        if (rel.persistFailed === true) {
          return {
            ...base,
            ok: false,
            zeroClick: true,
            actionId,
            serial: 'unknown',
            blocked: 'persistence',
            decision: DECISION.UNKNOWN_BLOCKED,
            currentAdState: state2,
            reason: rel.reason,
            persistence: { ok: false, reason: rel.innerReason || rel.reason },
          };
        }
        return {
          ...base,
          ok: true,
          zeroClick: true,
          actionId,
          slotReleased: true,
          decision: DECISION.UNKNOWN_BLOCKED,
          currentAdState: state2,
          reason: `动作前复核决策异常（明确未发出）：${e.message}`,
        };
      }
      if (!proceedOk(d2)) {
        const rel = this._releaseNotSent(shopId, actionId, `动作前复核状态已变化（${d2.decision}），明确未发出`, persistBeforeRelease, 're-decide');
        if (rel.persistFailed === true) {
          return {
            ...base,
            ok: false,
            zeroClick: true,
            actionId,
            serial: 'unknown',
            blocked: 'persistence',
            decision: d2.decision,
            currentAdState: state2,
            reason: rel.reason,
            persistence: { ok: false, reason: rel.innerReason || rel.reason },
          };
        }
        return {
          ...base,
          ok: true,
          zeroClick: true,
          actionId,
          slotReleased: true,
          decision: d2.decision,
          currentAdState: state2,
          reason: `动作前复核状态已变化（${d2.decision}），明确未发出，零点击`,
        };
      }

      // ── 4) 复用现有 runner/executor ────────────────────────────
      const inflightKey = String(shopId);
      let result;
      this._execInflight.set(inflightKey, (this._execInflight.get(inflightKey) || 0) + 1);
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
      } finally {
        const left = (this._execInflight.get(inflightKey) || 1) - 1;
        if (left <= 0) this._execInflight.delete(inflightKey);
        else this._execInflight.set(inflightKey, left);
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
   * mixed 重判 + 同轮再操作（有界：一次调用至多一次额外修复动作）。
   *
   * 语义：mixed 不是合法完成态。旧动作回读为 mixed 时，必须用**本轮新鲜**的完整清单、
   * 费用、订单、最新阈值重新判定目标，再执行一次修复；不能机械重复旧方向，也不能
   * 靠旧 unknown 把该店永久锁死。
   *
   * 流程（任一步不满足即零新广告动作）：
   *   1) 该店须存在 unknown 阻塞槽位；否则本次不做任何事（正常收口路径负责）；
   *   2) readFull 本轮完整清单回读：error/非 mixed → 不交接（on/off 由目标态核验释放）；
   *   3) redecide(read) 由新鲜费用/订单/阈值 + 本轮 mixed + 可靠目标重判；零动作 → 待处理；
   *   4) gate.reconcileMixedHandoff：证据（执行器已结束/无在途写/清单完整/身份通过/本轮 mixed）
   *      齐全才把旧动作如实收口为「未收敛」并**原子**登记下一动作；持久化失败整体回滚；
   *   5) runAction 走真实链路（Monitor→runner/executor→动作后完整回读）完成下一动作。
   *
   * @param {object} p
   * @param {string} p.shopId
   * @param {()=>Promise<object>} p.readFull  本轮完整清单回读（{state, rows, identity, error?}）
   * @param {(read:object)=>object} p.redecide  新鲜数据重判（返回决策对象）
   * @param {()=>{executorFinished:boolean, noInflightWrites:boolean}} p.inflightProof
   * @param {(action:'enable'|'pause', ctx:object)=>Promise<object>} p.runAction 真实链路入口
   * @param {()=>object} [p.persist]  交接终态落盘（同步返回 {ok,reason}）
   * @param {()=>(string|null)} [p.abortCheck]  交接后、再操作前的停止/窗口/店铺有效性检查；
   *        返回原因字符串表示本轮不得再发新动作：必须对**新登记槽**做可持久化未发出收口，
   *        不能留下永不恢复的在途槽，也不能伪称已发出。
   */
  async reconcileMixedAndReoperate({ shopId, readFull, redecide, inflightProof, runAction, persist = null, abortCheck = null }) {
    const slot = this.gate.peek(shopId);
    if (!slot || slot.settled === true || slot.unknown !== true) {
      return { reconciled: false, skipped: true, zeroClick: true, reason: '该店无 unknown 阻塞槽位：不做 mixed 交接' };
    }
    let read;
    try {
      read = await readFull();
    } catch (e) {
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: slot.actionId, ok: false, reason: `完整清单回读异常：${e.message}` });
      // 本轮没有可信清单：如实 unknown（不得写 mixed、不得伪收敛）
      return {
        reconciled: false,
        blocked: true,
        zeroClick: true,
        actionId: slot.actionId,
        observedTrustworthy: false,
        mixedEvidence: false,
        currentAdState: 'unknown',
        reason: `完整清单回读异常：${e.message}`,
      };
    }
    const r = read || {};
    if (r.error) {
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: slot.actionId, ok: false, reason: `完整清单回读被阻止：${r.error.reason || ''}` });
      return {
        reconciled: false,
        blocked: true,
        zeroClick: true,
        actionId: slot.actionId,
        observedTrustworthy: false,
        mixedEvidence: false,
        currentAdState: 'unknown',
        reason: `完整清单回读被阻止：${r.error.reason || 'unknown'}`,
      };
    }
    const state = normalizeAdState(r.state);
    if (state !== 'mixed') {
      return { reconciled: false, skipped: true, zeroClick: true, observedTrustworthy: true, currentAdState: state, reason: `本轮回读=${state}（非 mixed）：不做交接，on/off 走目标态核验释放` };
    }
    const jd = (await Promise.resolve(redecide(r))) || {};
    if (jd.action !== 'enable' && jd.action !== 'pause') {
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: slot.actionId, ok: false, decision: jd.decision || null, reason: jd.reason || '重判为零动作：保持待处理' });
      return { reconciled: false, pending: true, zeroClick: true, actionId: slot.actionId, decision: jd.decision || null, observedTrustworthy: true, mixedEvidence: true, currentAdState: 'mixed', reason: jd.reason || '重判为零动作：保持待处理，零新广告动作' };
    }
    const proof = typeof inflightProof === 'function' ? (inflightProof() || {}) : {};
    const rowsOk = Array.isArray(r.rows) && r.rows.length > 0 && r.rows.every((x) => x && typeof x.switchChecked === 'boolean');
    const evidence = {
      executorFinished: proof.executorFinished === true,
      noInflightWrites: proof.noInflightWrites === true,
      listComplete: rowsOk,
      identityOk: !!(r.identity && r.identity.ok === true),
      freshReadbackMixed: true,
      freshState: 'mixed',
    };
    const handoff = this.gate.reconcileMixedHandoff(shopId, slot.actionId, jd.action, {
      evidence,
      note: jd.reason || null,
      persist: persist || undefined,
    });
    if (!handoff || handoff.ok !== true) {
      const reason = (handoff && handoff.reason) || 'mixed 交接被拒：保持 unknown 阻塞';
      this.audit({ kind: 'ad-switch', step: 'mixed-handoff', shopId, actionId: slot.actionId, ok: false, reason });
      return { reconciled: false, blocked: true, zeroClick: true, actionId: slot.actionId, decision: jd.decision || null, observedTrustworthy: true, mixedEvidence: true, currentAdState: 'mixed', reason, persistFailed: handoff && handoff.persistFailed === true };
    }
    this.audit({
      kind: 'ad-switch',
      step: 'mixed-handoff',
      shopId,
      previousActionId: handoff.previousActionId,
      previousAction: handoff.previous.action,
      actionId: handoff.actionId,
      nextAction: jd.action,
      targetState: jd.targetState || null,
      decision: jd.decision || null,
      directionChanged: jd.action !== handoff.previous.action,
      ok: true,
      reason: '旧动作如实收口为未收敛（非 confirmed），已原子登记下一动作',
    });
    // 交接已成功、再操作尚未开始：此刻若停止代数变化/窗口关闭/店铺失效，新动作必然未发出
    // → 精确收口新登记槽（可持久化），不得留下永不恢复的在途 unknown 槽，也不得零收口旧槽。
    let abortReason = null;
    if (typeof abortCheck === 'function') {
      try {
        const a = abortCheck();
        if (a === true || (typeof a === 'string' && a)) abortReason = typeof a === 'string' ? a : 'aborted';
        else if (a && typeof a === 'object' && (a.blocked || a.reason)) abortReason = a.reason || String(a.blocked);
      } catch (e) {
        abortReason = `停止/窗口检查异常：${e.message}`;
      }
    }
    if (abortReason) {
      const rel = this.settlePreActionNotSent(shopId, handoff.actionId, `mixed 交接后本轮终止：${abortReason}`, persist, 'mixed-handoff-abort');
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: handoff.actionId, ok: rel.ok === true, zeroClick: true, blocked: rel.persistFailed === true ? 'persistence' : 'aborted', reason: `mixed 交接后本轮终止（${abortReason}）：零新广告动作` });
      if (rel.persistFailed === true) {
        return {
          reconciled: true,
          previousActionId: handoff.previousActionId,
          previousAction: handoff.previous.action,
          actionId: handoff.actionId,
          decision: jd.decision || null,
          targetState: jd.targetState || null,
          directionChanged: jd.action !== handoff.previous.action,
          observedTrustworthy: true,
          mixedEvidence: true,
          currentAdState: 'mixed',
          zeroClick: true,
          serial: 'unknown',
          blocked: 'persistence',
          reason: rel.reason,
          persistence: { ok: false, reason: rel.innerReason || rel.reason },
          repair: null,
        };
      }
      return {
        reconciled: true,
        previousActionId: handoff.previousActionId,
        previousAction: handoff.previous.action,
        actionId: handoff.actionId,
        decision: jd.decision || null,
        targetState: jd.targetState || null,
        directionChanged: jd.action !== handoff.previous.action,
        observedTrustworthy: true,
        mixedEvidence: true,
        currentAdState: 'mixed',
        zeroClick: true,
        blocked: 'aborted',
        slotReleased: true,
        reason: `mixed 交接后本轮终止（${abortReason}）：零新广告动作，新槽已如实收口为未发出`,
        repair: null,
      };
    }

    let repair;
    try {
      repair = await runAction(jd.action, {
        previousActionId: handoff.previousActionId,
        previousAction: handoff.previous.action,
        actionId: handoff.actionId,
        decision: jd,
        targetState: jd.targetState || (jd.action === 'pause' ? 'off' : 'on'),
      });
    } catch (e) {
      // 再操作调用异常：是否已发出无法证明 → 保持 unknown 阻塞，绝不伪未发出、绝不释放
      const marked = this.markPreActionUnknown(shopId, handoff.actionId, `mixed 交接后再操作调用异常：${e.message}`);
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: handoff.actionId, ok: false, serial: 'unknown', reason: `mixed 交接后再操作调用异常：${e.message}` });
      return {
        reconciled: true,
        previousActionId: handoff.previousActionId,
        previousAction: handoff.previous.action,
        actionId: handoff.actionId,
        decision: jd.decision || null,
        targetState: jd.targetState || null,
        directionChanged: jd.action !== handoff.previous.action,
        observedTrustworthy: true,
        mixedEvidence: true,
        zeroClick: false,
        serial: 'unknown',
        reason: `mixed 交接后再操作调用异常，结果未知，保持阻塞（${marked.ok === true ? '已登记 unknown' : marked.reason}）：${e.message}`,
        repair: null,
      };
    }
    if (!repair || typeof repair !== 'object') {
      // runAction 提前返回（无结果对象）：同样无法证明未发出 → 保持 unknown，不伪装终态
      const marked = this.markPreActionUnknown(shopId, handoff.actionId, 'mixed 交接后再操作未返回结果：状态未知');
      this.audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId, actionId: handoff.actionId, ok: false, serial: 'unknown', reason: 'mixed 交接后再操作未返回结果：保持 unknown 阻塞' });
      return {
        reconciled: true,
        previousActionId: handoff.previousActionId,
        previousAction: handoff.previous.action,
        actionId: handoff.actionId,
        decision: jd.decision || null,
        targetState: jd.targetState || null,
        directionChanged: jd.action !== handoff.previous.action,
        observedTrustworthy: true,
        mixedEvidence: true,
        serial: 'unknown',
        zeroClick: false,
        reason: `mixed 交接后再操作未返回结果，状态未知，保持阻塞（${marked.ok === true ? '已登记 unknown' : marked.reason}）`,
        repair: null,
      };
    }
    return {
      reconciled: true,
      previousActionId: handoff.previousActionId,
      previousAction: handoff.previous.action,
      actionId: handoff.actionId,
      decision: jd.decision || null,
      reconcileBasis: jd.reconcileBasis || null,
      targetState: jd.targetState || null,
      directionChanged: jd.action !== handoff.previous.action,
      observedTrustworthy: true,
      mixedEvidence: true,
      currentAdState: repair.currentAdState || null,
      repair,
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

  /**
   * 旧 enable unknown 槽位「目标未达成」安全结案（2026-10-19 修复永久阻断）。
   * 调用方（Monitor）已用本轮新鲜、完整、身份背书的回读严格证明全量 off（旧 enable 目标 on
   * 明确未达成）；本入口据此把旧动作以未达成/已核验失败终态安全释放（绝不标 confirmed），
   * 使同一轮正常决策创建新 enable。证据校验/持久化回滚均在串行门内完成。
   */
  settleUnknownEnableTargetNotAchieved(shopId, actionId, { evidence, note, persist } = {}) {
    const r = this.gate.settleUnknownTargetNotAchieved(shopId, actionId, {
      evidence: evidence || {},
      note: note || null,
    }, { persist: persist || undefined });
    this.audit({
      kind: 'ad-switch',
      step: 'resolve-unknown',
      shopId,
      actionId,
      ok: r.ok === true,
      settledAs: r.ok === true ? (r.kind || 'enable_target_not_achieved') : null,
      confirmed: false,
      evidence: evidence || null,
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

  /** 该店是否处于「mixed 未收敛/待重判」（供界面与门禁消费；无则 null）。 */
  pendingMixedReconcile(shopId) {
    return typeof this.gate.pendingMixedReconcile === 'function' ? this.gate.pendingMixedReconcile(shopId) : null;
  }

  /** 旧动作 mixed 收口审计（只读副本；保留旧 actionId）。 */
  mixedHandoffHistory(shopId) {
    return typeof this.gate.handoffHistory === 'function' ? this.gate.handoffHistory(shopId) : [];
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
