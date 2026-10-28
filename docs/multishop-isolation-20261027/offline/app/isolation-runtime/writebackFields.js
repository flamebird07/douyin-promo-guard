'use strict';
/**
 * writebackFields.js — 修正后的写回字段与利润输入（隔离专用，不写生产）。
 *
 * 利润状态：
 *   ok                 必需输入齐全（详情或明确允许的同源列表），可靠
 *   limited_estimate   用列表窗口/缺广告等降级估算，不可当作可靠利润写回
 *   not_calculable     必需率/价/本缺失，禁止用 0 冒充
 *
 * calcMinGross 单位：返回建议毛利金额（元）；目标为 每单利润 ≈ 售价 × target%。
 */

const {
  normalizeRatePercent,
  normalizeMoney,
  selectRefundRate,
  normalizeAdSpend,
  shippingShare,
} = require('./rateNormalize');

const DEFAULT_SHIPPING_FEE = 2.4;
const DEFAULT_INSURANCE = 4.01;
const COMMISSION_RATE = 0.006;

/** 率来源是否为详情窗口（含真实 0） */
function isDetailSource(source) {
  return source === 'detail' || source === 'detail_after_list_fail';
}

/**
 * 构造可写回飞书的字段（空值用 null，不用 0 冒充；0 保留）。
 */
function buildWritebackFields(product, shopName, fee = {}) {
  const shippingFee = fee.shippingFee != null ? fee.shippingFee : DEFAULT_SHIPPING_FEE;
  const insurance = fee.insurance != null ? fee.insurance : DEFAULT_INSURANCE;

  const listRate = normalizeRatePercent(product.listReturnRate);
  const totalSel = selectRefundRate(product.totalRefundRate, product.listReturnRate, { preferList: false });
  const postShipSel = selectRefundRate(product.postShipRefundRate, product.postShipRate, { preferList: false });
  const postShipping = normalizeRatePercent(product.postShippingRate);
  const ad = normalizeAdSpend(product.adSpend);
  const orderCount = normalizeMoney(product.orderCount, { allowNegative: false });
  const income = normalizeMoney(product.merchantIncome);
  const cost = normalizeMoney(product.cost);

  const fields = {
    '商品id': String(product.id),
    '平台': '抖店',
    '店铺': shopName || '',
    '记录时间': Date.now(),
    '30天成交订单数': orderCount.ok ? orderCount.value : null,
    '近30天退款率': listRate.ok ? listRate.value / 100 : null,
    '修正退款率': isDetailSource(totalSel.source) ? totalSel.value / 100 : null,
    '修正发后退货率': isDetailSource(postShipSel.source) ? postShipSel.value / 100 : null,
    '退货占发货占比': null,
    '修正退货率参考销量': (product.refundOrderCount !== null && product.refundOrderCount !== undefined && Number.isFinite(Number(product.refundOrderCount)))
      ? Number(product.refundOrderCount)
      : null,
    '商品编码': product.merchantCode || '',
    '最新售价': income.ok ? income.value : null,
    '发货后退款率': postShipping.ok ? postShipping.value / 100 : null,
    '月广告消耗': ad.ok ? ad.value : null,
    '平均每单广告费': (ad.ok && orderCount.ok && orderCount.value > 0)
      ? Number((ad.value / orderCount.value).toFixed(2))
      : null,
  };

  const share = shippingShare(product.totalRefundRate, product.postShipRefundRate);
  if (share.reason === 'ok') {
    fields['退货占发货占比'] = share.value;
  }

  if (income.ok) {
    fields['纯利3%'] = Number((income.value * 0.03).toFixed(2));
    fields['纯利5%'] = Number((income.value * 0.05).toFixed(2));
  }
  if (cost.ok) {
    fields['成本'] = cost.value;
  }

  const quality = {
    listRate: listRate.ok ? 'ok' : listRate.reason,
    totalSource: totalSel.source,
    totalReason: totalSel.detailReason,
    postShipSource: postShipSel.source,
    postShipReason: postShipSel.detailReason,
    postShipping: postShipping.ok ? 'ok' : postShipping.reason,
    ad: ad.ok ? 'ok' : ad.reason,
    income: income.ok ? 'ok' : income.reason,
    cost: cost.ok ? 'ok' : cost.reason,
    share: share.reason,
    windows: {
      list: 'list_default_near30d',
      detail: 'detail_T-40_to_T-10',
    },
  };
  quality.detailMissing = !isDetailSource(totalSel.source);
  quality.postShipDetailMissing = !isDetailSource(postShipSel.source);
  quality.usedListFallbackForTotal = totalSel.source === 'list_fallback';
  quality.ratesCompleteForGross =
    totalSel.value != null && postShipSel.value != null && cost.ok && income.ok;

  return { fields, quality, fee: { shippingFee, insurance } };
}

/**
 * 平均每单利润（元）。
 * 不把「率缺失」静默当成 0：缺失即降级或 not_calculable。
 */
function avgProfitPerOrder(product, fee = {}) {
  const shippingFee = fee.shippingFee != null ? fee.shippingFee : DEFAULT_SHIPPING_FEE;
  const insurance = fee.insurance != null ? fee.insurance : DEFAULT_INSURANCE;
  const N = normalizeMoney(product.orderCount);
  const income = normalizeMoney(product.merchantIncome);
  const cost = normalizeMoney(product.cost);
  if (!N.ok || N.value <= 0 || !income.ok || !cost.ok) {
    return {
      value: null,
      status: 'not_calculable',
      reason: 'insufficient_price_cost_or_orders',
      inputs: { order: N.reason, income: income.reason, cost: cost.reason },
    };
  }

  const totalSel = selectRefundRate(product.totalRefundRate, product.listReturnRate);
  const postSel = selectRefundRate(product.postShipRefundRate, product.postShipRate);
  const ad = normalizeAdSpend(product.adSpend);

  const totalAvailable = totalSel.value != null;
  const postAvailable = postSel.value != null;
  const adAvailable = ad.ok;

  // 必需：总退款率（用于成功单）与发后率（用于退货单成本）。二者缺失不得用 0 冒充。
  if (!totalAvailable || !postAvailable) {
    return {
      value: null,
      status: 'not_calculable',
      reason: !totalAvailable && !postAvailable
        ? 'total_and_post_rates_unavailable'
        : (!totalAvailable ? 'total_rate_unavailable' : 'post_rate_unavailable'),
      inputs: {
        totalSource: totalSel.source,
        postSource: postSel.source,
        totalReason: totalSel.detailReason,
        postReason: postSel.detailReason,
        ad: ad.ok ? 'ok' : ad.reason,
      },
    };
  }

  const totalRefundRate = totalSel.value;
  const postShipRate = postSel.value;
  const adCostPerOrder = adAvailable ? ad.value / N.value : 0;

  const price = income.value;
  const costV = cost.value;
  const successOrders = N.value * (1 - totalRefundRate / 100);
  const refundOrders = N.value * (postShipRate / 100);
  const commission = price * COMMISSION_RATE;
  const profitPerSuccess = price - costV - commission - shippingFee - insurance;
  const costPerRefund = shippingFee + insurance;
  const totalProfit = profitPerSuccess * successOrders - costPerRefund * refundOrders;
  const avg = totalProfit / N.value - adCostPerOrder;

  const usesListWindow = totalSel.source === 'list_fallback' || postSel.source === 'list_fallback';
  const status = usesListWindow || !adAvailable ? 'limited_estimate' : 'ok';
  const reasons = [];
  if (usesListWindow) reasons.push('list_window_fallback');
  if (!adAvailable) reasons.push('ad_unknown_assumed_0');

  return {
    value: Number(avg.toFixed(2)),
    status,
    reason: reasons.length ? reasons.join('+') : 'ok',
    reliableForWriteback: status === 'ok',
    inputs: {
      totalRefundRate,
      postShipRate,
      totalSource: totalSel.source,
      postSource: postSel.source,
      adSource: adAvailable ? 'ok' : ad.reason,
      adCostPerOrder: Number(adCostPerOrder.toFixed(4)),
      shippingFee,
      insurance,
    },
  };
}

/**
 * 建议门禁：按动作检查输入来源/窗口/完整性。
 * 覆盖生产 writeToFeishu 的强制毛利、下架、动态建议、利润达标备注。
 */
function suggestionGate(quality, product, profitResult) {
  const orderNum = normalizeMoney(product.orderCount);
  const n = orderNum.ok ? orderNum.value : 0;

  const totalOk = quality.totalSource && quality.totalSource !== 'unavailable'
    && (product.totalRefundRate != null || product.listReturnRate != null);
  const postShipOk = quality.postShipSource && quality.postShipSource !== 'unavailable'
    && (product.postShipRefundRate != null || product.postShipRate != null);
  const postShippingOk = quality.postShipping === 'ok';
  const listPostOk = normalizeRatePercent(product.postShipRate).ok;
  const listRateVal = normalizeRatePercent(product.postShipRate);
  const postShipVal = normalizeRatePercent(product.postShipRefundRate);
  const postShippingVal = normalizeRatePercent(product.postShippingRate);
  const maxRate = Math.max(
    listRateVal.ok ? listRateVal.value : 0,
    postShippingVal.ok ? postShippingVal.value : 0,
    postShipVal.ok ? postShipVal.value : 0
  );

  const hasCostIncome = quality.cost === 'ok' && quality.income === 'ok';
  const detailTotal = isDetailSource(quality.totalSource);
  const detailPost = isDetailSource(quality.postShipSource);
  const ratesForCalcMinGross = totalOk && postShipOk && hasCostIncome;
  const profitOk = profitResult && profitResult.status === 'ok';

  const actions = {
    // 高退货强制毛利≥80：生产条件 order>10, listRate>70, corrected(postShipping)>75
    FORCE_MIN_GROSS: {
      allowed: false,
      requires: [],
      blockedBy: [],
    },
    DELIST: {
      allowed: false,
      requires: [],
      blockedBy: [],
    },
    SUGGEST_GROSS_INCREASE: {
      allowed: false,
      requires: [],
      blockedBy: [],
    },
    REMARK_GROSS_OK: {
      allowed: false,
      requires: [],
      blockedBy: [],
    },
  };

  function requireAction(key, ok, tag) {
    if (ok) actions[key].requires.push(tag);
    else actions[key].blockedBy.push(tag);
  }

  const forcedByProdCond = n > 10 && listRateVal.ok && listRateVal.value > 70
    && postShippingVal.ok && postShippingVal.value > 75;
  requireAction('FORCE_MIN_GROSS', forcedByProdCond, 'prod_thresholds');
  requireAction('FORCE_MIN_GROSS', ratesForCalcMinGross, 'rates_cost_income_complete');
  requireAction('FORCE_MIN_GROSS', detailTotal && detailPost, 'detail_window_both_rates');
  requireAction('FORCE_MIN_GROSS', !profitResult || profitResult.status !== 'not_calculable', 'profit_not_impossible');
  actions.FORCE_MIN_GROSS.allowed = actions.FORCE_MIN_GROSS.blockedBy.length === 0;

  const delistCond = n >= 5 && maxRate > 90;
  requireAction('DELIST', delistCond, 'order_and_max_rate');
  // 硬下架需要详情窗口证据：详情总率或详情发货后率；纯列表 postShipRate 不够
  const detailShipEvidence = detailPost || postShippingOk;
  requireAction('DELIST', detailShipEvidence || detailTotal, 'detail_window_evidence');
  requireAction('DELIST', !(quality.detailMissing && !detailShipEvidence), 'not_list_only_without_detail_ship');
  actions.DELIST.allowed = actions.DELIST.blockedBy.length === 0;

  const suggestCond = n >= 5 && hasCostIncome;
  requireAction('SUGGEST_GROSS_INCREASE', suggestCond, 'orders_and_cost_income');
  requireAction('SUGGEST_GROSS_INCREASE', ratesForCalcMinGross, 'rates_complete');
  requireAction('SUGGEST_GROSS_INCREASE', detailTotal && detailPost, 'detail_window');
  requireAction('SUGGEST_GROSS_INCREASE', profitOk || (profitResult && profitResult.status === 'limited_estimate'), 'profit_available');
  // limited_estimate 时只允许「参考建议」，但不标 allowHardActions
  actions.SUGGEST_GROSS_INCREASE.allowed = actions.SUGGEST_GROSS_INCREASE.blockedBy.length === 0;
  actions.SUGGEST_GROSS_INCREASE.hard = profitOk && detailTotal && detailPost;

  const remarkCond = n >= 10 && hasCostIncome;
  requireAction('REMARK_GROSS_OK', remarkCond, 'orders_and_cost_income');
  requireAction('REMARK_GROSS_OK', ratesForCalcMinGross, 'rates_complete');
  requireAction('REMARK_GROSS_OK', detailTotal && detailPost, 'detail_window');
  actions.REMARK_GROSS_OK.allowed = actions.REMARK_GROSS_OK.blockedBy.length === 0;

  const hardActions = [];
  if (actions.FORCE_MIN_GROSS.allowed) hardActions.push('MAY_FORCE_MIN_GROSS');
  else if (forcedByProdCond) hardActions.push('SUPPRESS_FORCE_MIN_GROSS');

  if (actions.DELIST.allowed) hardActions.push('MAY_DELIST');
  else if (delistCond) hardActions.push('SUPPRESS_DELIST');

  if (!actions.SUGGEST_GROSS_INCREASE.allowed && suggestCond) hardActions.push('SUPPRESS_SUGGEST_GROSS');
  if (!actions.REMARK_GROSS_OK.allowed && remarkCond) hardActions.push('SUPPRESS_REMARK_GROSS');

  const allowHardActions = actions.FORCE_MIN_GROSS.allowed || actions.DELIST.allowed;

  return {
    allowHardActions,
    actions,
    hardActions,
    maxRate,
    profitStatus: profitResult ? profitResult.status : 'unknown',
    note: allowHardActions
      ? '至少一项硬动作输入完整'
      : '硬动作（下架/强制毛利）被抑制：输入不完整或窗口不符',
  };
}

module.exports = {
  buildWritebackFields,
  avgProfitPerOrder,
  suggestionGate,
  isDetailSource,
  DEFAULT_SHIPPING_FEE,
  DEFAULT_INSURANCE,
  COMMISSION_RATE,
};
