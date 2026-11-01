'use strict';

/**
 * 规则判断 v2 —— 用户明确的唯一规则（全店口径）：
 *
 *   当天累计推广费用 ÷ 当天累计全店订单数 > 每单成本阈值（用户规则 1 元/单 = 100 分）
 *
 * 判定实现：费用整数分 > 订单数 × thresholdCents（整数运算）。
 * - 恰好等于阈值不关闭（严格大于）；
 * - 禁止先算出"每单成本"四舍五入再比较（浮点精度陷阱）；
 * - 订单数必须是非负整数；0 单与正单走同一公式（客户 2026-10-27 修正：
 *   0 单有消耗也正常，expectedCents=0，正费用按同一公式仍可超标）；
 * - 费用与订单必须同一店铺、同一业务日期（由 guard 校验后传入）。
 *
 * 消耗门槛已取消（客户 2026-10-30 D55）：
 * - 不再有 50 元下限保护：只要费比严格超标（cost > orders×threshold），即具备暂停资格；
 * - 字段 SPEND_FLOOR_CENTS / spendFloorCents / spendProtected 仅为既有 API 兼容保留，
 *   现恒为 0 / false，如实表达「无消耗门槛」；
 * - pauseEligible / roiTooLow 与 over 同义，0 费用不产生暂停（0 > 0 不成立）。
 */

const { DataGuardError } = require('../lib/errors');

/** 兼容字段：消耗保护线已取消（D55），恒为 0；spendProtected 恒为 false。 */
const SPEND_FLOOR_CENTS = 0;

/**
 * @param {object} p
 * @param {number} p.costCents       整数分（>=0）
 * @param {number} p.orders          整数（>=0）
 * @param {number} p.thresholdCents  整数分/单（>0）
 * @returns {{over:boolean, spendProtected:boolean, pauseEligible:boolean, roiTooLow:boolean,
 *   costCents, orders, expectedCents:number, spendFloorCents:number, reason:string}}
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
  const expectedCents = orders * thresholdCents; // 整数运算：订单数×阈值分（0 单 → 0）
  // 无消耗门槛：保护线为 0 时 spendProtected 恒 false（0 费用本身也不会 over）。
  const spendProtected = SPEND_FLOOR_CENTS > 0 && costCents <= SPEND_FLOOR_CENTS;
  const over = costCents > expectedCents;
  const pauseEligible = over && !spendProtected;
  const roiTooLow = pauseEligible;
  let reason;
  if (over) {
    reason = `全店触发：当天推广费用 ${costCents} 分 > 订单数 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分（严格大于，恰好相等不关闭；无消耗门槛，暂停资格成立）`;
  } else {
    reason = `未触发：当天推广费用 ${costCents} 分 ≤ 订单数 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分`;
  }
  return {
    over,
    spendProtected,
    pauseEligible,
    roiTooLow,
    costCents, orders, expectedCents, spendFloorCents: SPEND_FLOOR_CENTS,
    reason,
  };
}

/** 供展示的每单成本文本（仅展示用，绝不参与判定）。 */
function perOrderDisplayText(costCents, orders) {
  if (!Number.isSafeInteger(orders) || orders <= 0) return '—（订单为 0，无法计算）';
  return `${(costCents / orders / 100).toFixed(4)} 元/单（精确值 ${costCents}/${orders} 分，判定用整数运算）`;
}

module.exports = { evaluateWholeShopCostPerOrder, perOrderDisplayText, SPEND_FLOOR_CENTS };
// 开关目标状态决策见 ad-switch-decision.js（单独 require，避免与本模块循环依赖）。
