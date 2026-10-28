'use strict';
/**
 * rateNormalize.js — 退款率/费用等数值的严格规范化。
 * 目标：合法 0 必须保留；缺失/非法/NaN/Infinity/越界必须显式分类，禁止 truthy 静默。
 * 禁止：把不同统计窗口自动当成可替代来源（窗口切换由调用方显式决定并打标）。
 */

/** 粗清洗字符串数字（¥ , % 空白）；无法解析返回 NaN */
function parseLooseNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return NaN;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '' || t === '-' || t === '--' || t === '—' || t === 'null' || t === 'undefined' || t === 'N/A' || t === 'nan') {
      return NaN;
    }
    const cleaned = t.replace(/[¥,\s%]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '--') return NaN;
    const n = Number(cleaned);
    return n;
  }
  return NaN;
}

/**
 * @returns {{ok:boolean, value:number|null, reason:string}}
 * reason: ok | missing | not_finite | out_of_range
 */
function normalizeRatePercent(raw, { min = 0, max = 100 } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, value: null, reason: 'missing' };
  }
  const n = parseLooseNumber(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, reason: 'not_finite' };
  }
  if (n < min || n > max) {
    return { ok: false, value: null, reason: 'out_of_range' };
  }
  return { ok: true, value: n, reason: 'ok' };
}

/**
 * 金额/件数：允许 0；缺失与非法区分。
 * @returns {{ok:boolean, value:number|null, reason:string}}
 */
function normalizeMoney(raw, { allowNegative = false } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, value: null, reason: 'missing' };
  }
  const n = parseLooseNumber(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, reason: 'not_finite' };
  }
  if (!allowNegative && n < 0) {
    return { ok: false, value: null, reason: 'out_of_range' };
  }
  return { ok: true, value: n, reason: 'ok' };
}

/**
 * 选择退款率：详情窗口优先（含真实 0）；仅当详情不可用时才允许列表回退，并必须带 source。
 * 不自动认定两窗口等价。
 * @returns {{value:number|null, source:string, detailReason:string, listReason:string}}
 */
function selectRefundRate(detailRaw, listRaw, { preferList = false } = {}) {
  const detail = normalizeRatePercent(detailRaw);
  const list = normalizeRatePercent(listRaw);
  if (!preferList && detail.ok) {
    return { value: detail.value, source: 'detail', detailReason: detail.reason, listReason: list.reason };
  }
  if (preferList && list.ok) {
    return { value: list.value, source: 'list', detailReason: detail.reason, listReason: list.reason };
  }
  if (list.ok) {
    return { value: list.value, source: 'list_fallback', detailReason: detail.reason, listReason: list.reason };
  }
  if (detail.ok) {
    return { value: detail.value, source: 'detail_after_list_fail', detailReason: detail.reason, listReason: list.reason };
  }
  return { value: null, source: 'unavailable', detailReason: detail.reason, listReason: list.reason };
}

/**
 * 广告消耗：0 是合法；-1 表示列表未采集哨兵。
 */
function normalizeAdSpend(raw) {
  if (raw === -1) {
    return { ok: false, value: null, reason: 'sentinel_missing' };
  }
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, value: null, reason: 'missing' };
  }
  const n = parseLooseNumber(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, value: null, reason: 'not_finite' };
  }
  if (n < 0) {
    return { ok: false, value: null, reason: 'out_of_range' };
  }
  return { ok: true, value: n, reason: 'ok' };
}

/**
 * 退货占发货占比：
 * 占比 = (发后/100) / (1 - (总-发后)/100)
 * 仅当总与发后均有效、分母 > 0 且结果在 [0,1] 附近时给出；否则 null + 原因。
 */
function shippingShare(totalPct, postShipPct) {
  const t = normalizeRatePercent(totalPct);
  const p = normalizeRatePercent(postShipPct);
  if (!t.ok || !p.ok) {
    return { value: null, reason: !t.ok ? `total_${t.reason}` : `post_${p.reason}` };
  }
  if (p.value > t.value) {
    return { value: null, reason: 'post_gt_total' };
  }
  const denom = 1 - (t.value - p.value) / 100;
  if (!Number.isFinite(denom) || denom <= 0) {
    return { value: null, reason: 'denom_non_positive' };
  }
  const share = (p.value / 100) / denom;
  if (!Number.isFinite(share) || share < 0 || share > 1.0001) {
    return { value: null, reason: 'share_out_of_range' };
  }
  return { value: Number(share.toFixed(4)), reason: 'ok', denom };
}

module.exports = {
  parseLooseNumber,
  normalizeRatePercent,
  normalizeMoney,
  selectRefundRate,
  normalizeAdSpend,
  shippingShare,
};
