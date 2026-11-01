'use strict';

/**
 * 规则判断 v3 —— 用户 2026-11-01 拍板的「规则 C」（全店口径）：
 *
 *   orders >= 1：当天累计推广费用 > 订单数 × 每单成本阈值（严格大于，整数分）
 *   orders === 0：一律不暂停（仅观察/告警、零点击），不因 costCents > 0 判为超标
 *
 * 判定实现（整数运算）：
 * - 订单数必须是非负整数；0 单是合法观测，不是数据异常；
 * - 只有 orders >= 1 才计算 over = costCents > orders × thresholdCents；
 *   0 单时 over / pauseEligible / roiTooLow 一律 false（expectedCents 仍为 0，仅供展示）；
 * - 恰好等于阈值不关闭（严格大于）；
 * - 禁止先算出"每单成本"四舍五入再比较（浮点精度陷阱）；
 * - 费用与订单必须同一店铺、同一业务日期（由 guard 校验后传入）。
 *
 * 取代旧口径：2026-10-27 零单修正与 2026-10-30 D55 中「0 单与正单同一公式、
 * 0 单正费用即 above / pauseEligible」的部分，自 2026-11-01 规则 C 起不再适用；
 * D55 取消 50 元消耗门槛的其余部分保持不变。
 *
 * 消耗门槛仍未恢复（方案 A 未采用）：
 * - SPEND_FLOOR_CENTS / spendFloorCents / spendProtected 仅为既有 API 兼容保留，
 *   恒为 0 / false，如实表达「无消耗门槛」；
 * - 规则 C 不引入新的金额门槛：暂停资格只由 orders >= 1 且严格超标决定。
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
  // 规则 C（2026-11-01）：0 单只观察/告警，绝不进入暂停资格，即使 costCents > 0。
  const zeroOrders = orders === 0;
  const over = !zeroOrders && costCents > expectedCents;
  const pauseEligible = over && !spendProtected;
  const roiTooLow = pauseEligible;
  let reason;
  if (zeroOrders) {
    reason = `0 单观察：当天推广费用 ${costCents} 分，不暂停（规则 C：0 单一律仅观察/告警、零点击；expectedCents=0 仅作展示）`;
  } else if (over) {
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
