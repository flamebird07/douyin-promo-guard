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
      });
    }
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
      })),
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
};
