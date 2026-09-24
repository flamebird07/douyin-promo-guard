'use strict';

/**
 * 当前广告状态映射（只读，不点击）。
 *
 * 口径：当前状态只能来自**本轮**页面/清单回读；不得用 adBelief 代替。
 * 映射（fail-closed）：
 *   - 全部明确开启 → 'on'
 *   - 全部明确关闭 → 'off'
 *   - 部分 on、部分 off → 'mixed'（不得当 unknown，也不得统一当 on）
 *   - 任一行无法识别 / 缺行 / 开关非布尔 → 'unknown'
 *   - 空清单且 listComplete+范围有效（confirmedEmpty）→ 'off'（无目标，零动作）
 *   - 空清单但无空态证据 → 'unknown'
 */

const AD_STATES = new Set(['on', 'off', 'mixed', 'unknown']);

/**
 * 从行级开关回读映射当前广告状态。
 * @param {Array<{id?:string, switchChecked?:boolean|null|undefined}>} rows
 * @param {{confirmedEmpty?:boolean}} [opts]
 * @returns {'on'|'off'|'mixed'|'unknown'}
 */
function mapAdStateFromSwitchRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return 'unknown';
  if (rows.length === 0) {
    // 空清单：仅当确认读取完整且范围有效才表示无目标 → off；否则 unknown
    return opts.confirmedEmpty === true ? 'off' : 'unknown';
  }
  let sawOn = false;
  let sawOff = false;
  for (const r of rows) {
    if (!r) return 'unknown';
    if (r.switchChecked === true) {
      sawOn = true;
      continue;
    }
    if (r.switchChecked === false) {
      sawOff = true;
      continue;
    }
    return 'unknown'; // null/undefined/非布尔 → 无法识别
  }
  if (sawOn && sawOff) return 'mixed';
  if (sawOn) return 'on';
  if (sawOff) return 'off';
  return 'unknown';
}

/**
 * 从广告清单映射。优先 switchChecked；状态词表仅作回退；无法识别 → unknown。
 * @param {Array} ads
 * @param {{confirmedEmpty?:boolean}} [opts]
 */
function mapAdStateFromAdList(ads, opts = {}) {
  if (!Array.isArray(ads)) return 'unknown';
  if (ads.length === 0) {
    return opts.confirmedEmpty === true ? 'off' : 'unknown';
  }
  const rows = ads.map((a) => {
    if (a && typeof a.switchChecked === 'boolean') {
      return { id: a.adId || a.id, switchChecked: a.switchChecked };
    }
    const st = a && a.status;
    if (st === '投放中' || st === 'on' || st === '开启') {
      return { id: a.adId || a.id, switchChecked: true };
    }
    if (st === '已关闭' || st === '已暂停' || st === 'off' || st === '暂停') {
      return { id: a.adId || a.id, switchChecked: false };
    }
    return { id: (a && (a.adId || a.id)) || null, switchChecked: null };
  });
  return mapAdStateFromSwitchRows(rows, opts);
}

/** 归一为 AD_STATES 成员；非法值一律 'unknown'。 */
function normalizeAdState(v) {
  return AD_STATES.has(v) ? v : 'unknown';
}

module.exports = {
  AD_STATES,
  mapAdStateFromSwitchRows,
  mapAdStateFromAdList,
  normalizeAdState,
};
