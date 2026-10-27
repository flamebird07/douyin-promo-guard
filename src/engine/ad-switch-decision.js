'use strict';

/**
 * 阈值 → 开关目标状态 决策层（本文件不接触真实广告页面）。
 *
 * 两套标签（勿混称）：
 *   metric   —— 指标相对阈值：below_threshold | equal_threshold | above_threshold
 *   decision —— 是否保持/需要动作/被阻止：
 *                should_enable | should_pause | already_on | already_off
 *                | equal_no_action | unknown_blocked | data_blocked
 *
 * 指标口径（整数分，禁止用四舍五入后的每单成本）：
 *   expectedCents = orders × thresholdCents   // 须为安全整数，溢出 → data_blocked
 *   costCents  <  expectedCents  → metric=below_threshold  → 目标 on
 *   costCents === expectedCents  → metric=equal_threshold  → 保持当前状态
 *   costCents  >  expectedCents  → metric=above_threshold  → 目标 off
 *
 * 决策必须使用**当前**广告状态 currentAdState: 'on' | 'off' | 'mixed' | 'unknown'。
 * 历史 adBelief 不得代替当前状态。
 * mixed（部分 on、部分 off）：
 *   - above + mixed → should_pause（仅暂停 on 项，由执行器目标筛选）
 *   - below + mixed → should_enable（仅开启 off 项，由执行器目标筛选）
 *   - equal + mixed → equal_no_action
 * identityOk 必须严格 === true 才通过；缺失/null/字符串一律 data_blocked。
 * unknown / 数据异常 / 身份不匹配 / 乘法溢出 → fail-closed，零点击；
 * 零订单本身不是异常（客户 2026-10-27 修正）：与正单同一公式，0 单时
 * expectedCents=0，任何正费用都 strictly above，是否可暂停只由 50 元保护线决定。
 *
 * 50 元保护（客户 2026-10-17）：
 * - spendProtected = costCents <= 5000（50.00 元）→ 任何方向都不得自动暂停；
 * - pauseEligible / roiTooLow = costCents > 5000 且 metric 严格 above；
 * - 保护区内原本会暂停的 on/mixed 一律零动作（spend_protected），且不强制重开原 off；
 * - 低于阈值仍按原语义 should_enable；等于阈值 on/off/mixed 仍 equal_no_action（公共库既有语义保留）。
 */

const { DataGuardError } = require('../lib/errors');
const { evaluateWholeShopCostPerOrder, SPEND_FLOOR_CENTS } = require('./rules');

const AD_STATES = new Set(['on', 'off', 'mixed', 'unknown']);

/** 指标相对阈值（metric） */
const METRIC = Object.freeze({
  BELOW: 'below_threshold',
  EQUAL: 'equal_threshold',
  ABOVE: 'above_threshold',
});

/** 动作决策（decision）：保持 / 需要动作 / 被阻止 */
const DECISION = Object.freeze({
  SHOULD_ENABLE: 'should_enable',
  SHOULD_PAUSE: 'should_pause',
  ALREADY_ON: 'already_on',
  ALREADY_OFF: 'already_off',
  EQUAL_NO_ACTION: 'equal_no_action',
  SPEND_PROTECTED: 'spend_protected',
  UNKNOWN_BLOCKED: 'unknown_blocked',
  DATA_BLOCKED: 'data_blocked',
});

const ACTION_CLICK = Object.freeze({ ENABLE: 'enable', PAUSE: 'pause' });

/** 旧别名（仅兼容，语义见 METRIC/DECISION，勿再称「九种 decision」） */
const DECISIONS = Object.freeze({
  BELOW_THRESHOLD: METRIC.BELOW,
  EQUAL_THRESHOLD: METRIC.EQUAL,
  ABOVE_THRESHOLD: METRIC.ABOVE,
  ALREADY_ON: DECISION.ALREADY_ON,
  ALREADY_OFF: DECISION.ALREADY_OFF,
  SHOULD_ENABLE: DECISION.SHOULD_ENABLE,
  SHOULD_PAUSE: DECISION.SHOULD_PAUSE,
  SPEND_PROTECTED: DECISION.SPEND_PROTECTED,
  UNKNOWN_BLOCKED: DECISION.UNKNOWN_BLOCKED,
  DATA_BLOCKED: DECISION.DATA_BLOCKED,
});

/**
 * @param {object} p
 * @param {number} p.costCents
 * @param {number} p.orders
 * @param {number} p.thresholdCents
 * @param {'on'|'off'|'mixed'|'unknown'} p.currentAdState
 * @param {boolean} p.identityOk   必须严格 === true（缺失/null/假值/字符串皆阻止）
 * @param {string|null} [p.identityReason] 身份未通过时的具体原因（如"待身份核验：…"）；缺省用通用文案
 * @param {string|null} [p.dataError]
 * @param {string} [p.adStateSource]
 */
function decideAdSwitchAction({
  costCents,
  orders,
  thresholdCents,
  currentAdState,
  identityOk,
  identityReason = null,
  dataError = null,
  adStateSource = null,
}) {
  const base = {
    metric: null,
    decision: null,
    targetState: null,
    action: null,
    zeroClick: true,
    blocked: null,
    currentAdState: AD_STATES.has(currentAdState) ? currentAdState : 'unknown',
    costCents: Number.isSafeInteger(costCents) ? costCents : null,
    orders: Number.isSafeInteger(orders) ? orders : null,
    thresholdCents: Number.isSafeInteger(thresholdCents) ? thresholdCents : null,
    expectedCents: null,
    adStateSource,
    spendFloorCents: SPEND_FLOOR_CENTS,
    spendProtected: null,
    pauseEligible: false,
    roiTooLow: false,
  };

  // 1) 身份：必须严格 === true
  if (identityOk !== true) {
    return {
      ...base,
      decision: DECISION.DATA_BLOCKED,
      blocked: 'identity_mismatch',
      reason: identityReason
        ? `${identityReason}（identityOk 非 true：fail-closed，零动作）`
        : 'identityOk 不是严格 true（缺失/非法）：fail-closed，零动作',
    };
  }

  // 2) 外部数据守卫失败
  if (dataError) {
    return {
      ...base,
      decision: DECISION.DATA_BLOCKED,
      blocked: 'data_error',
      reason: `数据异常：${String(dataError).slice(0, 200)}（fail-closed，零动作）`,
    };
  }

  // 3) 指标安全整数校验 + 乘法溢出
  const costOk = Number.isSafeInteger(costCents) && costCents >= 0;
  const ordersOk = Number.isSafeInteger(orders) && orders >= 0;
  const thrOk = Number.isSafeInteger(thresholdCents) && thresholdCents > 0;
  if (!costOk || !ordersOk || !thrOk) {
    return {
      ...base,
      decision: DECISION.DATA_BLOCKED,
      blocked: 'invalid_metrics',
      reason: '费用/订单/阈值不是有效整数：fail-closed，零动作',
    };
  }
  const expectedCents = orders * thresholdCents;
  if (!Number.isSafeInteger(expectedCents)) {
    return {
      ...base,
      decision: DECISION.DATA_BLOCKED,
      blocked: 'overflow',
      reason: `orders × thresholdCents 溢出安全整数（${orders} × ${thresholdCents}）：fail-closed，零动作`,
    };
  }
  base.expectedCents = expectedCents;

  // 4) 复用 rules 整数判定（零订单与正单同一公式，无零单专用阻断）
  let evalR;
  try {
    evalR = evaluateWholeShopCostPerOrder({ costCents, orders, thresholdCents });
  } catch (e) {
    if (e instanceof DataGuardError) {
      return {
        ...base,
        decision: DECISION.DATA_BLOCKED,
        blocked: 'invalid_metrics',
        reason: `${e.message}（fail-closed，零动作）`,
      };
    }
    throw e;
  }

  // 5) metric：低于/等于/高于（严格整数，等于不切换）
  let metric;
  if (costCents < expectedCents) metric = METRIC.BELOW;
  else if (costCents === expectedCents) metric = METRIC.EQUAL;
  else metric = METRIC.ABOVE;
  base.metric = metric;

  // 50 元门槛：保护区内一律无暂停资格；严格超标且 >50 元才允许暂停/提示 ROI 过低。
  const spendProtected = costCents <= SPEND_FLOOR_CENTS;
  base.spendProtected = spendProtected;
  base.pauseEligible = metric === METRIC.ABOVE && !spendProtected;
  base.roiTooLow = base.pauseEligible;

  // 6) 当前状态 unknown → 阻止（不因超标绕过）
  if (!AD_STATES.has(currentAdState) || currentAdState === 'unknown') {
    return {
      ...base,
      decision: DECISION.UNKNOWN_BLOCKED,
      blocked: 'unknown_ad_state',
      // 状态未知不是有效决策：不把 ROI 提示当作已确认事实
      roiTooLow: false,
      pauseEligible: false,
      reason: '当前广告状态为 unknown（或未提供）：fail-closed，零点击；历史 adBelief 不得代替当前状态',
    };
  }

  // 7) 等于阈值 → 保持（含 mixed，零动作）
  if (metric === METRIC.EQUAL) {
    return {
      ...base,
      decision: DECISION.EQUAL_NO_ACTION,
      targetState: currentAdState === 'mixed' ? 'mixed' : currentAdState,
      action: null,
      zeroClick: true,
      reason: `费用分 ${costCents} == 订单 ${orders} × 阈值 ${thresholdCents} 分 = ${expectedCents} 分：等于阈值，保持当前状态 ${currentAdState}，零动作`,
    };
  }

  // 8) 目标对比（mixed：above 只停 on 项 / below 只开 off 项，执行器筛选）
  const targetState = metric === METRIC.BELOW ? 'on' : 'off';
  base.targetState = targetState;

  if (metric === METRIC.BELOW) {
    if (currentAdState === 'on') {
      return {
        ...base,
        decision: DECISION.ALREADY_ON,
        action: null,
        zeroClick: true,
        reason: `低于阈值且当前已为 on：保持（already_on），零点击（${evalR.reason}）`,
      };
    }
    return {
      ...base,
      decision: DECISION.SHOULD_ENABLE,
      action: ACTION_CLICK.ENABLE,
      zeroClick: false,
      reason: currentAdState === 'mixed'
        ? `低于阈值且当前 mixed：仅开启 off 项（should_enable）（${evalR.reason}）`
        : `低于阈值且当前为 off：需要开启（should_enable）（${evalR.reason}）`,
    };
  }

  // 8b) 高于阈值但仍在 50 元保护区内：零暂停、零强制开关，如实标记 spend_protected。
  if (spendProtected) {
    return {
      ...base,
      decision: DECISION.SPEND_PROTECTED,
      targetState: currentAdState,
      action: null,
      zeroClick: true,
      reason: `高于费比阈值（${evalR.reason}）；但当天消耗 ${costCents} 分 ≤ ${SPEND_FLOOR_CENTS} 分（50 元）：50 元保护生效，本轮不暂停（当前 ${currentAdState} 保持，不强制重开/关闭）`,
    };
  }

  if (currentAdState === 'off') {
    return {
      ...base,
      decision: DECISION.ALREADY_OFF,
      action: null,
      zeroClick: true,
      reason: `高于阈值且当前已为 off：保持（already_off），零点击（${evalR.reason}）`,
    };
  }
  return {
    ...base,
    decision: DECISION.SHOULD_PAUSE,
    action: ACTION_CLICK.PAUSE,
    zeroClick: false,
    reason: currentAdState === 'mixed'
      ? `高于阈值且当前 mixed：仅暂停 on 项（should_pause）（${evalR.reason}）`
      : `高于阈值且当前为 on：需要暂停（should_pause）（${evalR.reason}）`,
  };
}

module.exports = {
  decideAdSwitchAction,
  METRIC,
  DECISION,
  DECISIONS,
  ACTION_CLICK,
  AD_STATES,
};
