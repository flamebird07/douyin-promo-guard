'use strict';

/**
 * 登录失效对外文案（单一来源，2026-11-02 CODE_FAIL 加严）。
 *
 * 硬约束：`policy === 'fix3-four'` 的对外 / AuthError / 结案文案**一律禁止扫码类结论**
 * （「扫码」「请重新扫码登录」「扫码登录」等），**不论 authClosedOut 真假**。未结案与
 * 已结案两种文案都只提「重新登录旁路」，绝不把用户引向扫码。
 * 非 fix3-four（默认五层恢复）保持既有文案不变。
 *
 * @param {object} p
 *   - policy {string} 恢复策略（fix3-four 走收紧口径）
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
  return {
    tail: closed ? '；auth 结案（不要求扫码）' : '，请重新扫码登录',
    restoreNote: closed
      ? '；固定四份候选均不可用且已排除代码误判（对照店 checkLogin 通过）：auth 结案，不要求扫码'
      : `；四层恢复未取得可验证候选（${p.restoreReason || '未提升'}），工作副本现状未被盲覆盖`,
  };
}

module.exports = { buildAuthFailureSuffix };
