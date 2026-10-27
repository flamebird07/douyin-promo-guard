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
 *   0 单有消耗也正常，expectedCents=0，是否超标只看费用与 50 元保护线）；
 * - 费用与订单必须同一店铺、同一业务日期（由 guard 校验后传入）。
 *
 * 50 元保护（客户 2026-10-17）：
 * - 当天账户整体消耗 <= 5000 分（50.00 元）时，不因费比超标自动暂停；
 * - 只有消耗 > 5000 分（50.01 元起）且费比严格超标，才具备暂停资格并提示「ROI设置过低」；
 * - over 保留原始费比语义（cost > orders×threshold），保护门槛另以
 *   spendProtected / pauseEligible / roiTooLow 显式表达，避免把保护误标成数据异常。
 */

const { DataGuardError } = require('../lib/errors');

/** 当天消耗保护线：5000 分 = 50.00 元（<= 保护，> 才允许自动暂停）。 */
const SPEND_FLOOR_CENTS = 5000;

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
  const spendProtected = costCents <= SPEND_FLOOR_CENTS;
  const over = costCents > expectedCents;
  const pauseEligible = over && !spendProtected;
  const roiTooLow = pauseEligible;
  let reason;
  if (over) {
    reason = `全店触发：当天推广费用 ${costCents} 分 > 订单数 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分（严格大于，恰好相等不关闭）`;
    reason += spendProtected
      ? `；当天消耗 ${costCents} 分 ≤ ${SPEND_FLOOR_CENTS} 分（50 元）：50 元保护生效，本轮不自动暂停`
      : `；当天消耗 ${costCents} 分 > ${SPEND_FLOOR_CENTS} 分（50 元）：暂停资格成立`;
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
