'use strict';

/**
 * 登录失效对外文案（单一来源，2026-11-02 CODE_FAIL 加严）。
 *
 * 硬约束（2026-11-02 全仓加严）：**所有策略**的对外 / AuthError / 结案文案一律禁止
 * 扫码类结论（「扫码」「请重新扫码登录」「扫码登录」等），**不论 authClosedOut 真假**。
 * fix3-four 与默认五层恢复的未结案/已结案文案都只提「重新登录旁路」，绝不把用户引向扫码。
 *
 * @param {object} p
 *   - policy {string} 恢复策略（fix3-four 走固定四份证据口径）
 *   - authClosedOut {boolean} 是否已 auth 结案
 *   - controlCheckSkipped {boolean} fix3-four 未结案时对照店检查是否「未提供」（未注入/未跑）
 *   - restoreReason {string} 恢复链原因（未结案时如实拼接）
 * @returns {{tail:string, restoreNote:string}} 追加到登录失效消息尾部的两段文案
 */
function buildAuthFailureSuffix(p = {}) {
  const closed = p.authClosedOut === true;
  const fix3 = p.policy === 'fix3-four';
  if (fix3) {
    // fix3 文案拆分（2026-11-02）：「对照店检查未提供」（检查根本没注入/没跑）与
    // 「对照店检查未通过」（跑了但 checkLogin 失败）是两种不同态势，必须区分，
    // 不得再合并误导值守；未传 controlCheckSkipped 时保持旧口径（按「未通过」）。
    return {
      tail: closed
        ? '；auth 结案（不要求重新登录旁路）'
        : (p.controlCheckSkipped === true
          ? '；auth 未结案：无可用会话候选或对照店检查未提供（不要求重新登录旁路）'
          : '；auth 未结案：无可用会话候选或对照店检查未通过（不要求重新登录旁路）'),
      restoreNote: closed
        ? '；固定四份候选均不可用且已排除代码误判（对照店 checkLogin 通过）：auth 结案，不要求重新登录旁路'
        : `；四层恢复未取得可验证候选（${p.restoreReason || '未提升'}），工作副本现状未被盲覆盖`,
    };
  }
  // CODE_FAIL 加严（2026-11-02，全仓口径）：默认五层恢复的对外文案同样不得出现扫码类
  // 结论（只提非扫码的「重新登录旁路」），与 fix3-four 保持一致。
  return {
    tail: closed
      ? '；auth 结案（不要求重新登录旁路）'
      : '；auth 未结案：无可用会话候选或对照店检查未通过（不要求重新登录旁路）',
    restoreNote: closed
      ? '；固定四份候选均不可用且已排除代码误判（对照店 checkLogin 通过）：auth 结案，不要求重新登录旁路'
      : `；四层恢复未取得可验证候选（${p.restoreReason || '未提升'}），工作副本现状未被盲覆盖`,
  };
}

/**
 * 登录失效日志的 60s 保护字段（fix4，2026-11-03）：只做日志字段拼接，不改判定与既有文案。
 *
 * heldMs = 正向证据连续观测的实际持续时长（与 loginUrlObserv.heldMs 同源，monitor.js
 * 用 now - firstSeenAt 计算）；holdMs = 判定窗口 AUTH_LOGIN_URL_HOLD_MS。两者都是数值，
 * 便于 PROD 日志直接取证「是否真的持续满 60s」。
 *
 * @param {object} p
 *   - heldMs {number} 实际持续时长（毫秒）
 *   - holdMs {number} 判定窗口（毫秒）
 * @returns {string} 形如「；heldMs=61234 holdMs=60000」；无有效数值时返回空串
 */
function buildHoldLogFields(p = {}) {
  const heldMs = Number(p.heldMs);
  const holdMs = Number(p.holdMs);
  if (!Number.isFinite(heldMs) || !Number.isFinite(holdMs) || heldMs < 0 || holdMs < 0) return '';
  return `；heldMs=${Math.round(heldMs)} holdMs=${Math.round(holdMs)}`;
}

module.exports = { buildAuthFailureSuffix, buildHoldLogFields };
