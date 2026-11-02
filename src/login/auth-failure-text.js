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
 *   - restoreReason {string} 恢复链原因（未结案时如实拼接）
 * @returns {{tail:string, restoreNote:string}} 追加到登录失效消息尾部的两段文案
 */
function buildAuthFailureSuffix(p = {}) {
  const closed = p.authClosedOut === true;
  const fix3 = p.policy === 'fix3-four';
  if (fix3) {
    return {
      tail: closed
        ? '；auth 结案（不要求重新登录旁路）'
        : '；auth 未结案：无可用会话候选或对照店检查未通过（不要求重新登录旁路）',
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

module.exports = { buildAuthFailureSuffix };
