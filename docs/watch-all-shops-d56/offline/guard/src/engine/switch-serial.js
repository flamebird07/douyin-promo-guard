'use strict';

/**
 * 同一店铺「开关动作」串行化门（决策/调度层，不点真实页面）。
 *
 * 槽位状态（互斥，按此生命周期）：
 *   in-flight  tryBegin 后：未确认、非 unknown、未结束
 *   unknown    markUnknown 后：可能已发出，结果未知 → **保持阻塞**
 *   confirmed  markConfirmed 后（仅 in-flight）：已确认未结束
 *   settled    结束并释放槽位
 *
 * 转换规则：
 *   1) tryBegin → 唯一 actionId，进入 in-flight；
 *   2) 明确尚未发出 → markNotSent / markSettled({kind:NOT_SENT})：仅 in-flight；
 *      unknown 或 confirmed 不得经此释放；
 *   3) 可能已发出 / 超时 / 回读失败 → markUnknown / markSettled({kind:UNKNOWN})：保留阻塞，禁止补点；
 *   4) 正常确认：markConfirmed（仅 in-flight）→ markSettled({kind:CONFIRMED}) 释放；
 *      未确认时 markSettled(CONFIRMED) **不得**自行制造已确认；
 *   5) unknown 仅可由 resolveUnknownAfterReadback 且 p.confirmed === true 恢复并释放；
 *      缺参 / false / 非法参数一律保持阻塞；
 *   6) markConfirmed 不得绕过 unknown 恢复入口；
 *   7) 回读未确认目标达成时保持阻塞；不自动补点。
 *
 * 全部转换核对 shopId + actionId；旧 actionId 不得影响新动作。
 * 异常/超时 ≠ 未发出，须走 markUnknown。
 * 生产 API 不提供无条件 clear()。
 *
 * 8) mixed 重判交接（reconcileMixedHandoff）：mixed 只是过渡观测，不是合法完成态。
 *    旧 unknown 动作可在**证据齐全**时如实收口为「部分完成/未收敛」（绝不标 confirmed），
 *    并在同一步原子登记下一动作；证据缺一、身份不符、清单不完整、落盘失败
 *    → 零新动作 + 旧槽保持 unknown 阻塞。
 */

const ACTIONS = new Set(['enable', 'pause']);

/** 结束原因（不用单一 ok 布尔混合语义） */
const SETTLE_KIND = Object.freeze({
  /** 明确尚未发出动作：仅 in-flight 可释放 */
  NOT_SENT: 'not_sent',
  /** 动作可能已发出，结果未知/回读失败：保留阻塞 */
  UNKNOWN: 'unknown',
  /** 已确认结果：结束当前动作并释放（unknown 须走 resolveUnknownAfterReadback） */
  CONFIRMED: 'confirmed',
});

/**
 * mixed 重判交接的收口类：旧动作如实结束为「部分完成/未收敛」，**不是** confirmed。
 * 只在证据齐全时由 reconcileMixedHandoff 使用，并原子登记下一动作。
 */
const HANDOFF_KIND = Object.freeze({
  MIXED_NOT_CONVERGED: 'mixed_not_converged',
  /**
   * 旧 enable unknown 槽位「目标未达成」安全结案（2026-10-19 enable 永久阻断修复）。
   * 触发证据：本轮新鲜完整清单 + identity.ok===true + 所有行严格 switchChecked===false，
   * 全量 off 明确证明旧 enable 的目标 on 未达成。据此把旧动作以「已核验失败/未达成」
   * **终态**释放串行门（绝不标 confirmed、绝不声明历史点击因果），使同一轮可正常创建新 enable。
   */
  ENABLE_TARGET_NOT_ACHIEVED: 'enable_target_not_achieved',
});

/** mixed 交接证据字段：必须逐项严格 === true，缺一即零新动作。 */
const MIXED_HANDOFF_EVIDENCE = Object.freeze([
  'executorFinished',    // 旧执行器已在本进程结束（不靠 sleep 猜）
  'noInflightWrites',    // 无在途写请求
  'listComplete',        // 本轮回读为完整清单（全量分页 + 行级开关可信）
  'identityOk',          // 同店同平台身份核验通过
  'freshReadbackMixed',  // 本轮新鲜回读确为 mixed
]);

/** 历史审计（旧 actionId 收口记录）上限：仅保留最近若干条，防止无界增长。 */
const HANDOFF_HISTORY_LIMIT = 50;

let _seq = 0;
function nextActionId() {
  _seq += 1;
  return `act_${Date.now()}_${_seq}`;
}

function snapshot(slot) {
  if (!slot) return null;
  return {
    shopId: slot.shopId,
    action: slot.action,
    actionId: slot.actionId,
    startedAt: slot.startedAt,
    confirmed: slot.confirmed,
    settled: slot.settled,
    unknown: slot.unknown,
    blockedReason: slot.blockedReason,
    // mixed 重判交接的来源（无则为 null）：仅描述「本槽由哪个旧动作交接而来」，
    // 不代表旧动作已确认；pendingMixed 表示本槽仍是未收敛待重判状态。
    reconcile: slot.reconcile ? { ...slot.reconcile } : null,
  };
}

/**
 * @returns {{
 *   tryBegin:(shopId:string, action:'enable'|'pause')=>{ok:boolean,actionId?:string,reason?:string,slot?:object},
 *   markConfirmed:(shopId:string, actionId:string)=>{ok:boolean,reason?:string},
 *   markNotSent:(shopId:string, actionId:string)=>{ok:boolean,reason?:string},
 *   markUnknown:(shopId:string, actionId:string, reason?:string)=>{ok:boolean,reason?:string},
 *   markSettled:(shopId:string, actionId:string, opts:{kind:string, reason?:string})=>{ok:boolean,reason?:string},
 *   resolveUnknownAfterReadback:(shopId:string, actionId:string, p:{confirmed:boolean, note?:string})=>{ok:boolean,reason?:string},
 *   isBusy:(shopId:string)=>boolean,
 *   peek:(shopId:string)=>object|null,
 *   hasUnknownBlock:(shopId:string)=>boolean,
 * }}
 */
function createSwitchSerialGate(opts = {}) {
  /** @type {Map<string, object>} shopId → in-flight / unknown / confirmed 槽 */
  const slots = new Map();
  /** 旧动作收口审计（含 mixed 交接的「未收敛」记录）；只追加、有界保留。 */
  const handoffs = [];

  // 进程重启恢复：未结束动作一律恢复为 unknown 阻塞（不把未知写成成功，禁止补点）
  if (opts.state && Array.isArray(opts.state.slots)) {
    for (const raw of opts.state.slots) {
      if (!raw || typeof raw.shopId !== 'string' || !raw.shopId) continue;
      if (raw.settled === true) continue;
      slots.set(raw.shopId, {
        shopId: raw.shopId,
        action: raw.action,
        actionId: raw.actionId,
        startedAt: raw.startedAt || Date.now(),
        confirmed: false,
        settled: false,
        unknown: true,
        blockedReason: raw.blockedReason
          || '进程重启：未结束动作恢复为 unknown 阻塞，禁止补点；须 resolveUnknownAfterReadback 且 confirmed===true',
        reconcile: raw.reconcile && typeof raw.reconcile === 'object' ? { ...raw.reconcile } : null,
      });
    }
  }
  if (opts.state && Array.isArray(opts.state.handoffs)) {
    for (const raw of opts.state.handoffs) {
      if (!raw || typeof raw.actionId !== 'string' || !raw.actionId) continue;
      handoffs.push({ ...raw });
    }
    if (handoffs.length > HANDOFF_HISTORY_LIMIT) handoffs.splice(0, handoffs.length - HANDOFF_HISTORY_LIMIT);
  }

  /** 持久化快照（供 state.json；不含敏感值）。 */
  function exportState() {
    return {
      slots: [...slots.values()].map((s) => ({
        shopId: s.shopId,
        action: s.action,
        actionId: s.actionId,
        startedAt: s.startedAt,
        confirmed: s.confirmed === true,
        settled: s.settled === true,
        unknown: s.unknown === true,
        blockedReason: s.blockedReason || null,
        reconcile: s.reconcile ? { ...s.reconcile } : null,
      })),
      handoffs: handoffs.slice(-HANDOFF_HISTORY_LIMIT).map((h) => ({ ...h })),
    };
  }

  function tryBegin(shopId, action) {
    if (typeof shopId !== 'string' || !shopId) {
      return { ok: false, reason: 'shopId 无效：拒绝登记开关动作' };
    }
    if (!ACTIONS.has(action)) {
      return { ok: false, reason: `action 无效（应为 enable|pause）: ${String(action)}` };
    }
    const cur = slots.get(shopId);
    if (cur && !cur.settled) {
      const label = cur.unknown
        ? `结果未知/回读未核验的动作 ${cur.action}`
        : `未结束动作 ${cur.action}`;
      return {
        ok: false,
        reason: `串行化门：店铺 ${shopId} 已有${label}（actionId=${cur.actionId}），拒绝并发/补点 ${action}`,
        inflight: snapshot(cur),
      };
    }
    const actionId = nextActionId();
    const slot = {
      shopId,
      action,
      actionId,
      startedAt: Date.now(),
      confirmed: false,
      settled: false,
      unknown: false,
      blockedReason: null,
    };
    slots.set(shopId, slot);
    return { ok: true, actionId, slot: snapshot(slot) };
  }

  function requireMatch(shopId, actionId) {
    if (typeof shopId !== 'string' || !shopId) {
      return { ok: false, reason: 'shopId 无效' };
    }
    if (typeof actionId !== 'string' || !actionId) {
      return { ok: false, reason: 'actionId 无效' };
    }
    const cur = slots.get(shopId);
    if (!cur) {
      return { ok: false, reason: `无对应动作槽（shopId=${shopId}, actionId=${actionId}）` };
    }
    if (cur.actionId !== actionId) {
      return {
        ok: false,
        reason: `actionId 不匹配：当前槽 ${cur.actionId}，回调 ${actionId}（延迟回调不得影响新动作）`,
        current: snapshot(cur),
      };
    }
    return { ok: true, slot: cur };
  }

  /**
   * 标记已确认（仅 in-flight）。不得用于绕过 unknown 恢复入口。
   * 确认本身不释放槽位；释放见 markSettled({kind:CONFIRMED})。
   */
  function markConfirmed(shopId, actionId) {
    const m = requireMatch(shopId, actionId);
    if (!m.ok) return m;
    if (m.slot.settled) {
      return { ok: false, reason: '动作已结束，不能再确认' };
    }
    if (m.slot.unknown) {
      return {
        ok: false,
        reason: 'unknown 状态不得经 markConfirmed 绕过恢复入口；只能 resolveUnknownAfterReadback 且 confirmed===true 恢复',
      };
    }
    m.slot.confirmed = true;
    m.slot.blockedReason = null;
    return { ok: true, slot: snapshot(m.slot) };
  }

  /**
   * 明确尚未发出动作：仅 in-flight 可结束并释放。
   * unknown 或 confirmed 状态不得经此释放。
   */
  function markNotSent(shopId, actionId, opts = {}) {
    const m = requireMatch(shopId, actionId);
    if (!m.ok) return m;
    if (m.slot.settled) {
      return { ok: false, reason: '动作已结束' };
    }
    if (m.slot.unknown) {
      return {
        ok: false,
        reason: 'unknown 状态不得经 markNotSent 释放；只能 resolveUnknownAfterReadback 且 confirmed===true 恢复',
      };
    }
    if (m.slot.confirmed) {
      return {
        ok: false,
        reason: '已 confirmed 的动作不得经 markNotSent 释放；应 markSettled(CONFIRMED)',
      };
    }
    // 终态先落盘（settled=true 可安全恢复），成功后再删内存槽
    m.slot.settled = true;
    if (typeof opts.persist === 'function') {
      let persist;
      try {
        persist = (typeof opts.persist.then === 'function') ? null : opts.persist();
        if (persist && typeof persist.then === 'function') {
          // 同步 API 契约：调用方应传同步或已决结果；此处仅兼容 thenable 会破坏同步性
        }
      } catch (e) {
        persist = { ok: false, reason: e.message };
      }
      if (!persist || persist.ok !== true) {
        m.slot.settled = false;
        return { ok: false, persistFailed: true, reason: (persist && persist.reason) || 'not_sent 终态持久化失败，保持阻塞' };
      }
    }
    slots.delete(shopId);
    return { ok: true, kind: SETTLE_KIND.NOT_SENT };
  }

  /**
   * 动作可能已发出，但结果未知/回读失败：**保留阻塞**，禁止后续补点。
   * 异常、超时必须走此路径，不得当作「未发出」。
   */
  function markUnknown(shopId, actionId, reason) {
    const m = requireMatch(shopId, actionId);
    if (!m.ok) return m;
    if (m.slot.settled) {
      return { ok: false, reason: '动作已结束，不能标记未知' };
    }
    m.slot.unknown = true;
    m.slot.confirmed = false;
    m.slot.blockedReason = String(reason || '结果未知/回读失败：可能已发出，禁止补点');
    return { ok: true, kind: SETTLE_KIND.UNKNOWN, slot: snapshot(m.slot) };
  }

  /**
   * unknown 状态的唯一恢复入口。
   * 仅当 p 存在且 p.confirmed === true 时结束并释放；
   * 缺参、confirmed:false、非法参数一律保持阻塞，不释放、不自动补点。
   */
  function resolveUnknownAfterReadback(shopId, actionId, p, opts = {}) {
    const m = requireMatch(shopId, actionId);
    if (!m.ok) return m;
    if (m.slot.settled) {
      return { ok: false, reason: '动作已结束' };
    }
    if (!m.slot.unknown) {
      return { ok: false, reason: '当前槽不是 unknown 状态，无需回读恢复' };
    }
    if (!p || p.confirmed !== true) {
      return {
        ok: false,
        reason: '回读未确认目标达成（缺参/confirmed 非严格 true）：保持 unknown 阻塞，禁止释放；不自动补点',
        slot: snapshot(m.slot),
      };
    }
    m.slot.confirmed = true;
    m.slot.unknown = false;
    m.slot.blockedReason = null;
    m.slot.settled = true;
    if (typeof opts.persist === 'function') {
      let persist;
      try {
        persist = opts.persist();
        if (persist && typeof persist.then === 'function') persist = null;
      } catch (e) {
        persist = { ok: false, reason: e.message };
      }
      if (!persist || persist.ok !== true) {
        m.slot.settled = false;
        m.slot.confirmed = false;
        m.slot.unknown = true;
        m.slot.blockedReason = (persist && persist.reason) || '恢复终态持久化失败，保持阻塞';
        return {
          ok: false,
          persistFailed: true,
          reason: `persistence_blocked: 恢复终态保存失败（${m.slot.blockedReason}），保持阻塞`,
          slot: snapshot(m.slot),
        };
      }
    }
    slots.delete(shopId);
    return {
      ok: true,
      kind: SETTLE_KIND.CONFIRMED,
      confirmed: true,
      note: (p && p.note) || null,
    };
  }

  /**
   * unknown enable 槽位「目标未达成」安全结案（2026-10-19 修复永久阻断）。
   *
   * 与 resolveUnknownAfterReadback 的区别：后者要求回读**等于**旧动作目标态（on）才算确认；
   * 本入口处理相反事实——旧 enable 的目标明确**未达成**：本轮新鲜、完整、身份背书的回读
   * 严格全量 off（所有行 switchChecked===false）。这证明旧 enable 已核验失败，不是"结果未知"，
   * 因此可以把旧动作以「未达成/已核验失败」终态安全释放，使同一轮正常决策创建新的 enable。
   *
   * fail-closed（任一不满足即保持 unknown 阻塞、零点击、绝不释放）：
   *   1) 本槽存在、精确 actionId、unknown===true 且未 settled；
   *   2) 本槽动作必须是 enable（本阶段只处理 enable 的对称安全结案；pause 不在此处）；
   *   3) evidence.listComplete===true（调用方核对本轮完整清单背书）；
   *   4) evidence.identityOk===true（同店同平台身份核验通过）；
   *   5) evidence.allRowsOff===true（所有行严格 switchChecked===false）且 evidence.rowCount>0；
   *   6) evidence.freshState==='off'（本轮归一态确为 off）；
   *   7) 终态先落盘（persist 同步 ok===true）再删槽；落盘失败整体回滚 unknown 阻塞。
   * 释放**绝不**标 confirmed、**绝不**声明历史点击因果；旧 actionId 进 handoffs 审计（settledAs
   * = ENABLE_TARGET_NOT_ACHIEVED，confirmed:false）。
   */
  function settleUnknownTargetNotAchieved(shopId, actionId, p = {}, opts = {}) {
    const m = requireMatch(shopId, actionId);
    if (!m.ok) return m;
    const old = m.slot;
    if (old.settled) return { ok: false, reason: '动作已结束，不得再做目标未达成结案' };
    if (!old.unknown) {
      return { ok: false, reason: '仅 unknown（可能已发出、未确认）动作可做目标未达成结案；in-flight/confirmed 须走正常收口', slot: snapshot(old) };
    }
    // 防御性不变式：unknown 槽不得已是 confirmed（markUnknown 会清 confirmed；
    // 恢复/重启也一律 confirmed:false）。若出现污染数据，宁可保持阻塞也不释放。
    if (old.confirmed === true) {
      return { ok: false, reason: 'unknown 槽位出现 confirmed=true 的矛盾状态：拒绝目标未达成结案，保持阻塞', slot: snapshot(old) };
    }
    if (old.action !== 'enable') {
      return { ok: false, reason: `本结案入口仅处理 enable（当前=${String(old.action)}）：保持 unknown 阻塞`, slot: snapshot(old) };
    }
    const ev = (p && p.evidence) || {};
    if (ev.listComplete !== true || ev.identityOk !== true || ev.allRowsOff !== true) {
      return {
        ok: false,
        reason: `目标未达成结案证据不足（listComplete=${ev.listComplete === true}/identityOk=${ev.identityOk === true}/allRowsOff=${ev.allRowsOff === true}）：保持 unknown 阻塞`,
        slot: snapshot(old),
      };
    }
    const rowCount = Number(ev.rowCount);
    if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
      return { ok: false, reason: `目标未达成结案须本轮完整清单含实际行（rowCount=${String(ev.rowCount)}）：保持 unknown 阻塞`, slot: snapshot(old) };
    }
    if (ev.freshState !== 'off') {
      return { ok: false, reason: `目标未达成结案仅适用于本轮归一态 off（当前=${String(ev.freshState)}）：保持 unknown 阻塞`, slot: snapshot(old) };
    }
    const note = String((p && p.note) || '').slice(0, 300) || null;
    // 终态先落盘：settled=true → persist → 删槽；失败回滚 unknown 阻塞（fail-closed）
    old.settled = true;
    if (typeof opts.persist === 'function') {
      let persist;
      try {
        persist = opts.persist();
        if (persist && typeof persist.then === 'function') persist = null;
      } catch (e) {
        persist = { ok: false, reason: e.message };
      }
      if (!persist || persist.ok !== true) {
        old.settled = false;
        old.unknown = true;
        old.confirmed = false;
        old.blockedReason = (persist && persist.reason) || 'target_not_achieved 终态持久化失败，保持阻塞';
        return {
          ok: false,
          persistFailed: true,
          reason: `persistence_blocked: 目标未达成结案保存失败（${old.blockedReason}），旧动作恢复 unknown 阻塞，零新广告动作`,
          slot: snapshot(old),
        };
      }
    }
    const historyEntry = {
      shopId,
      action: old.action,
      actionId: old.actionId,
      endedAt: Date.now(),
      settledAs: HANDOFF_KIND.ENABLE_TARGET_NOT_ACHIEVED,
      confirmed: false,
      targetState: 'on',
      freshReadState: 'off',
      readEvidence: { rowCount, listComplete: true, identityOk: true, allRowsOff: true },
      blockedReason: old.blockedReason || null,
      note,
    };
    const previous = snapshot(old);
    slots.delete(shopId);
    handoffs.push(historyEntry);
    if (handoffs.length > HANDOFF_HISTORY_LIMIT) handoffs.splice(0, handoffs.length - HANDOFF_HISTORY_LIMIT);
    return {
      ok: true,
      kind: HANDOFF_KIND.ENABLE_TARGET_NOT_ACHIEVED,
      actionId: old.actionId,
      previousActionId: old.actionId,
      previous,
    };
  }

  /**
   * 通用结束入口：必须给出明确 kind，禁止用 ok 布尔混语义。
   * kind=NOT_SENT → markNotSent（仅 in-flight）；
   * kind=UNKNOWN → markUnknown（保留阻塞）；
   * kind=CONFIRMED → 仅当已 confirmed 且非 unknown 时释放；未确认不得自行制造已确认。
   */
  function markSettled(shopId, actionId, opts = {}) {
    const kind = opts && opts.kind;
    if (kind === SETTLE_KIND.NOT_SENT) {
      return markNotSent(shopId, actionId, opts);
    }
    if (kind === SETTLE_KIND.UNKNOWN) {
      return markUnknown(shopId, actionId, opts && opts.reason);
    }
    if (kind === SETTLE_KIND.CONFIRMED) {
      const m = requireMatch(shopId, actionId);
      if (!m.ok) return m;
      if (m.slot.settled) {
        return { ok: false, reason: '动作已结束' };
      }
      if (m.slot.unknown) {
        return {
          ok: false,
          reason: 'unknown 状态不得经 markSettled(CONFIRMED) 绕过；只能 resolveUnknownAfterReadback 且 confirmed===true 恢复',
        };
      }
      if (m.slot.confirmed !== true) {
        return {
          ok: false,
          reason: '未确认的动作不得 markSettled(CONFIRMED) 伪装成功释放；需先 markConfirmed',
        };
      }
      // 终态 settled 先持久化，成功后再删槽（重启可安全恢复，不误锁）
      m.slot.settled = true;
      if (typeof opts.persist === 'function') {
        let persist;
        try {
          persist = opts.persist();
          if (persist && typeof persist.then === 'function') persist = null;
        } catch (e) {
          persist = { ok: false, reason: e.message };
        }
        if (!persist || persist.ok !== true) {
          m.slot.settled = false;
          m.slot.confirmed = false;
          m.slot.unknown = true;
          m.slot.blockedReason = (persist && persist.reason) || 'confirmed 终态持久化失败，保持阻塞';
          return {
            ok: false,
            persistFailed: true,
            reason: `persistence_blocked: 确认完成状态保存失败（${m.slot.blockedReason}），保持阻塞`,
          };
        }
      }
      slots.delete(shopId);
      return { ok: true, kind: SETTLE_KIND.CONFIRMED, confirmed: true };
    }
    return {
      ok: false,
      reason: `markSettled 必须指定 kind=${SETTLE_KIND.NOT_SENT}|${SETTLE_KIND.UNKNOWN}|${SETTLE_KIND.CONFIRMED}，禁止用单一 ok 布尔混语义`,
    };
  }

  /**
   * mixed 重判交接（唯一把 unknown 动作如实收口为「部分完成/未收敛」的入口）。
   *
   * 客户新目标：mixed 只能作为过渡观测，不是合法完成态；遇到 mixed 必须重新判定并
   * 重新操作一遍。为此旧 unknown 动作不得永久锁死下一轮修复，但收口必须有证据：
   *   1) 本槽存在且为 unknown（可能已发出、结果未确认）；in-flight/confirmed 一律拒绝；
   *   2) evidence 逐项严格 === true（执行器已结束、无在途写、清单完整、身份通过、本轮 mixed）；
   *   3) nextAction ∈ {enable,pause}；
   *   4) 终态先落盘（persist 同步返回 ok===true）再删除旧槽并登记新槽——任一步失败即整体回滚，
   *      旧槽恢复 unknown 阻塞、新槽撤销、审计条目丢弃 → 零新广告动作。
   * 收口**绝不**标 confirmed、**绝不**伪造 on/off；旧 actionId 进 handoffs 审计。
   * 迟到旧回报：旧 actionId 已不在槽位且 handoff 记录只读，任何按旧 actionId 的回调经
   * requireMatch 拒绝，不污染新槽。
   *
   * @returns {{ok:boolean, actionId?:string, previousActionId?:string, kind?:string, reason?:string,
   *            slot?:object, previous?:object, persistFailed?:boolean}}
   */
  function reconcileMixedHandoff(shopId, oldActionId, nextAction, opts = {}) {
    const m = requireMatch(shopId, oldActionId);
    if (!m.ok) return m;
    const old = m.slot;
    if (old.settled) return { ok: false, reason: '动作已结束，不得再做 mixed 交接' };
    if (!old.unknown) {
      return {
        ok: false,
        reason: '仅 unknown（可能已发出、未确认）动作可做 mixed 重判交接；in-flight/confirmed 须走正常收口，不得据此提前释放',
        slot: snapshot(old),
      };
    }
    if (!ACTIONS.has(nextAction)) {
      return { ok: false, reason: `下一动作非法（应为 enable|pause）：${String(nextAction)}：零新广告动作` };
    }
    const ev = (opts && opts.evidence) || {};
    for (const key of MIXED_HANDOFF_EVIDENCE) {
      if (ev[key] !== true) {
        return {
          ok: false,
          reason: `mixed 交接证据不足（${key} 非严格 true）：保持 unknown 阻塞，零新广告动作`,
          slot: snapshot(old),
        };
      }
    }
    if (ev.freshState !== 'mixed') {
      return {
        ok: false,
        reason: `mixed 交接仅适用于本轮回读 mixed（当前=${String(ev.freshState)}）：on/off 须走目标态核验释放`,
        slot: snapshot(old),
      };
    }
    const note = String((opts && opts.note) || '').slice(0, 300) || null;
    const newActionId = nextActionId();
    const previous = snapshot(old);
    const historyEntry = {
      shopId,
      action: old.action,
      actionId: old.actionId,
      endedAt: Date.now(),
      settledAs: HANDOFF_KIND.MIXED_NOT_CONVERGED,
      confirmed: false,
      targetState: old.action === 'pause' ? 'off' : 'on',
      freshReadState: 'mixed',
      repairAction: nextAction,
      repairActionId: newActionId,
      directionChanged: nextAction !== old.action,
      blockedReason: old.blockedReason || null,
      note,
    };
    // 原子段：撤旧槽 → 登记新槽 → 落盘；失败整体回滚
    slots.delete(shopId);
    slots.set(shopId, {
      shopId,
      action: nextAction,
      actionId: newActionId,
      startedAt: Date.now(),
      confirmed: false,
      settled: false,
      unknown: false,
      blockedReason: null,
      reconcile: {
        basis: HANDOFF_KIND.MIXED_NOT_CONVERGED,
        previousActionId: old.actionId,
        previousAction: old.action,
        mixedNote: note,
      },
    });
    handoffs.push(historyEntry);
    if (handoffs.length > HANDOFF_HISTORY_LIMIT) handoffs.splice(0, handoffs.length - HANDOFF_HISTORY_LIMIT);
    if (typeof opts.persist === 'function') {
      let persist;
      try {
        persist = opts.persist();
        if (persist && typeof persist.then === 'function') persist = null;
      } catch (e) {
        persist = { ok: false, reason: e.message };
      }
      if (!persist || persist.ok !== true) {
        slots.delete(shopId);
        slots.set(shopId, old);
        handoffs.pop();
        return {
          ok: false,
          persistFailed: true,
          reason: `persistence_blocked: mixed 交接终态保存失败（${(persist && persist.reason) || '未知'}），旧动作恢复 unknown 阻塞，零新广告动作`,
          slot: snapshot(old),
        };
      }
    }
    return {
      ok: true,
      kind: HANDOFF_KIND.MIXED_NOT_CONVERGED,
      actionId: newActionId,
      previousActionId: old.actionId,
      previous,
      slot: snapshot(slots.get(shopId)),
    };
  }

  /** 该店是否处于「mixed 未收敛待重判」：本槽由 mixed 交接而来且仍未确认结束。 */
  function pendingMixedReconcile(shopId) {
    const cur = slots.get(shopId);
    if (!cur || cur.settled) return null;
    if (!cur.reconcile && !cur.unknown) return null;
    return {
      shopId: cur.shopId,
      action: cur.action,
      actionId: cur.actionId,
      unknown: cur.unknown === true,
      basis: cur.reconcile ? cur.reconcile.basis : 'unknown_pending',
      previousActionId: cur.reconcile ? cur.reconcile.previousActionId : null,
      previousAction: cur.reconcile ? cur.reconcile.previousAction : null,
      mixedNote: cur.reconcile ? cur.reconcile.mixedNote : null,
    };
  }

  /** 旧动作收口审计（只读副本；含 mixed 未收敛记录）。 */
  function handoffHistory(shopId) {
    return handoffs
      .filter((h) => !shopId || h.shopId === shopId)
      .map((h) => ({ ...h }));
  }

  function isBusy(shopId) {
    const cur = slots.get(shopId);
    return !!(cur && !cur.settled);
  }

  function hasUnknownBlock(shopId) {
    const cur = slots.get(shopId);
    return !!(cur && !cur.settled && cur.unknown);
  }

  function peek(shopId) {
    return snapshot(slots.get(shopId));
  }

  return {
    tryBegin,
    markConfirmed,
    markNotSent,
    markUnknown,
    markSettled,
    resolveUnknownAfterReadback,
    settleUnknownTargetNotAchieved,
    reconcileMixedHandoff,
    pendingMixedReconcile,
    handoffHistory,
    isBusy,
    hasUnknownBlock,
    peek,
    exportState,
  };
}

module.exports = {
  createSwitchSerialGate,
  ACTIONS,
  SETTLE_KIND,
  HANDOFF_KIND,
  MIXED_HANDOFF_EVIDENCE,
};
