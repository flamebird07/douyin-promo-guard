'use strict';

/**
 * 规则判断 v2 —— 用户明确的唯一规则（全店口径）：
 *
 *   当天累计推广费用 ÷ 当天累计全店订单数 > 每单成本阈值（用户规则 1 元/单 = 100 分）
 *
 * 判定实现：费用整数分 > 订单数 × thresholdCents（整数运算）。
 * - 恰好等于阈值不关闭（严格大于）；
 * - 禁止先算出"每单成本"四舍五入再比较（浮点精度陷阱）；
 * - 订单数必须是非负整数；为 0 或无效时不能用于关闭决策：
 *   费用>0 且订单为 0 → 阻止关闭并说明（用户说明 08:00 后订单不应为 0，需重读核实）；
 * - 费用与订单必须同一店铺、同一业务日期（由 guard 校验后传入）。
 */

const { DataGuardError } = require('../lib/errors');

/**
 * @param {object} p
 * @param {number} p.costCents       整数分（>=0）
 * @param {number} p.orders          整数（>=0）
 * @param {number} p.thresholdCents  整数分/单（>0）
 * @returns {{over:boolean, costCents, orders, expectedCents:number, reason:string, blocked?:string}}
 */
function evaluateWholeShopCostPerOrder({ costCents, orders, thresholdCents }) {
  if (!Number.isSafeInteger(costCents) || costCents < 0) {
    throw new DataGuardError(`全店推广费用不是有效整数分: ${JSON.stringify(costCents)}`);
  }
  if (!Number.isSafeInteger(orders) || orders < 0) {
    throw new DataGuardError(`全店订单数不是有效非负整数: ${JSON.stringify(orders)}`);
  }
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents <= 0) {
    throw new DataGuardError(`每单成本阈值不是有效正整数分: ${JSON.stringify(thresholdCents)}`);
  }
  const expectedCents = orders * thresholdCents; // 整数运算：订单数×阈值分
  if (orders === 0) {
    return {
      over: false,
      blocked: 'zero_orders',
      costCents, orders, expectedCents,
      reason: costCents > 0
        ? '全店订单为 0 但推广费用大于 0：数据异常，按用户说明需重新读取核实，阻止本轮关闭'
        : '全店订单为 0 且推广费用为 0：未超标，不关闭',
    };
  }
  const over = costCents > expectedCents;
  return {
    over,
    costCents, orders, expectedCents,
    reason: over
      ? `全店触发：当天推广费用 ${costCents} 分 > 订单数 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分（严格大于，恰好相等不关闭）`
      : `未触发：当天推广费用 ${costCents} 分 ≤ 订单数 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分`,
  };
}

/** 供展示的每单成本文本（仅展示用，绝不参与判定）。 */
function perOrderDisplayText(costCents, orders) {
  if (!Number.isSafeInteger(orders) || orders <= 0) return '—（订单为 0，无法计算）';
  return `${(costCents / orders / 100).toFixed(4)} 元/单（精确值 ${costCents}/${orders} 分，判定用整数运算）`;
}

module.exports = { evaluateWholeShopCostPerOrder, perOrderDisplayText };
// 开关目标状态决策见 ad-switch-decision.js（单独 require，避免与本模块循环依赖）。
