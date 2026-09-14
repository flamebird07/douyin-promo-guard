'use strict';

/**
 * 数据守卫 v2 —— 任何"数据不可信"必须停止本轮自动操作并给出明确原因。
 *
 * 修复 Codex 复核问题 #3：身份核验必须覆盖三个数据源（费用来源、订单来源、
 * 广告控制页面），逐源与配置店铺唯一标识精确比对（===，禁止模糊匹配）；
 * 配置了广告账户 ID 时还必须核验账户映射。任一不一致 → 零关闭。
 *
 * 同时校验：Summary 结构完整、解析无错误、业务日期=当天（上海）、抓取时效、
 * 费用与订单同日期同店铺、来源许可（真实模式禁 mock）。
 */

const { DataGuardError, AuthError } = require('../lib/errors');
const { shanghaiDate } = require('../lib/time');
const { closableSideOfAd } = require('../adapters/ad-controller');

/** 校验 Summary（费用/订单）结构完整性。 */
function validateSummaryShape(summary, kindLabel) {
  if (!summary || typeof summary !== 'object') {
    throw new DataGuardError(`${kindLabel}数据快照为空`);
  }
  if (summary.source !== 'promo-page' && summary.source !== 'mock') {
    throw new DataGuardError(`${kindLabel}数据来源未知: ${summary.source}`);
  }
  if (!summary.shopId || typeof summary.shopId !== 'string') {
    throw new DataGuardError(`${kindLabel}数据缺少页面店铺标识（shopId）`);
  }
  if (!summary.businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(summary.businessDate)) {
    throw new DataGuardError(`${kindLabel}数据缺少页面统计日期（businessDate, YYYY-MM-DD）`);
  }
  if (!summary.fetchedAt || Number.isNaN(Date.parse(summary.fetchedAt))) {
    throw new DataGuardError(`${kindLabel}数据缺少有效抓取时间（fetchedAt）`);
  }
  if (summary.parseError) {
    throw new DataGuardError(`${kindLabel}数据解析失败: ${summary.parseError}（缺失不当 0）`);
  }
  if (kindLabel === '全店推广费用') {
    if (!Number.isSafeInteger(summary.valueCents) || summary.valueCents < 0) {
      throw new DataGuardError(`${kindLabel}不是有效非负整数分: ${JSON.stringify(summary.valueCents)}`);
    }
  } else {
    if (!Number.isSafeInteger(summary.valueCount) || summary.valueCount < 0) {
      throw new DataGuardError(`${kindLabel}不是有效非负整数: ${JSON.stringify(summary.valueCount)}`);
    }
  }
}

/**
 * 单源身份核验：页面 shopId 必须与配置精确相等。
 * 广告账户映射按数据源分别校验（不能一律要求）：
 * - 千川费用源（kind='cost'）：配置了 accountId 时必须提供并精确匹配；
 * - 罗盘订单源（kind='orders'）：页面通常无千川账户概念，不强制要求 accountId，
 *   但若 summary 提供了非空 accountId，则必须与配置精确一致。
 * @param summary 带 shopId/accountId/kind 的数据源快照
 * @param shopCfg {id, accountId?}
 * @param kindLabel 用于报错说明
 */
function checkSourceIdentity(summary, shopCfg, kindLabel) {
  const cfgId = String(shopCfg.id || '').trim();
  if (!cfgId || cfgId.startsWith('TODO')) {
    throw new AuthError(`配置中的店铺唯一标识未配置，无法对${kindLabel}做身份精确比对`);
  }
  const srcId = String(summary.shopId || '').trim();
  if (srcId !== cfgId) {
    throw new AuthError(
      `${kindLabel}店铺身份不匹配：配置 ${cfgId}，${kindLabel}页面实际 ${srcId || '(空)'}。零关闭`,
      { cfgId, srcId }
    );
  }
  const cfgAccConfigured = shopCfg.accountId !== undefined && shopCfg.accountId !== null && String(shopCfg.accountId).trim() !== '' && !String(shopCfg.accountId).startsWith('TODO');
  if (!cfgAccConfigured) return;
  const cfgAcc = String(shopCfg.accountId).trim();
  const srcAccRaw = summary.accountId === undefined || summary.accountId === null ? '' : String(summary.accountId).trim();
  const provided = srcAccRaw !== '';
  if (summary.kind === 'orders') {
    // 罗盘订单源：无千川账户概念，仅在页面提供 accountId 时核对
    if (provided && srcAccRaw !== cfgAcc) {
      throw new AuthError(`${kindLabel}广告账户映射不匹配：配置 ${cfgAcc}，页面 ${srcAccRaw}。零关闭`, { cfgAcc, srcAcc: srcAccRaw });
    }
    return;
  }
  // 千川费用/广告源：必须提供账户 ID 并精确匹配
  if (!provided) {
    throw new AuthError(`${kindLabel}未提供广告账户ID，无法核验与配置账户 ${cfgAcc} 的映射关系，拒绝采用`);
  }
  if (srcAccRaw !== cfgAcc) {
    throw new AuthError(`${kindLabel}广告账户映射不匹配：配置 ${cfgAcc}，页面实际 ${srcAccRaw}。零关闭`, { cfgAcc, srcAcc: srcAccRaw });
  }
}

/** 业务日期必须等于当前上海统计日期（页面口径与本地时钟一致）。 */
function checkBusinessDateToday(summary, kindLabel, nowMs) {
  const today = shanghaiDate(nowMs);
  if (summary.businessDate !== today) {
    throw new DataGuardError(
      `${kindLabel}统计日期不是当天：页面口径 ${summary.businessDate}，当前上海日期 ${today}（跨日数据不用于关闭决策）`
    );
  }
}

/** 抓取时效。 */
function checkFreshness(fetchedAt, maxAgeMinutes, nowMs, kindLabel) {
  const ageMs = nowMs - Date.parse(fetchedAt);
  const maxMs = maxAgeMinutes * 60 * 1000;
  if (ageMs > maxMs) {
    throw new DataGuardError(
      `${kindLabel}数据已过期：抓取于 ${fetchedAt}，距今 ${Math.round(ageMs / 60000)} 分钟，超过上限 ${maxAgeMinutes} 分钟`
    );
  }
  if (ageMs < -5 * 60 * 1000) {
    throw new DataGuardError(`${kindLabel}数据抓取时间来自未来，时钟异常，停止判断`);
  }
}

/** 费用与订单必须同店铺、同业务日期（且各自身份已对配置核验）。 */
function checkSameShopAndDate(costSummary, orderSummary) {
  if (costSummary.shopId !== orderSummary.shopId) {
    throw new DataGuardError(
      `费用与订单来源店铺不一致：费用 ${costSummary.shopId}，订单 ${orderSummary.shopId}。零关闭`
    );
  }
  if (costSummary.businessDate !== orderSummary.businessDate) {
    throw new DataGuardError(
      `费用与订单统计日期不一致：费用 ${costSummary.businessDate}，订单 ${orderSummary.businessDate}。零关闭`
    );
  }
}

/**
 * 广告控制页身份核验（控制器 verifyIdentity 的结果与配置比对）。
 * @param pageIdentity {ok, pageShopId?, pageShopName?, pageAccountId?}
 */
function checkControllerIdentity(pageIdentity, shopCfg) {
  if (!pageIdentity || pageIdentity.ok !== true) {
    throw new AuthError(
      `无法确认广告控制页面的实际店铺身份：${(pageIdentity && pageIdentity.reason) || '身份读取失败'}`
    );
  }
  const cfgId = String(shopCfg.id || '').trim();
  if (!cfgId || cfgId.startsWith('TODO')) {
    throw new AuthError('配置中的店铺唯一标识未配置，无法对广告控制页做身份精确比对');
  }
  const pageId = String(pageIdentity.pageShopId || '').trim();
  if (pageId !== cfgId) {
    throw new AuthError(
      `广告控制页店铺身份不匹配：配置 ${cfgId}，页面实际 ${pageId || '(空)'}。停止本轮自动操作`,
      { cfgId, pageId, pageShopName: pageIdentity.pageShopName }
    );
  }
  if (shopCfg.accountId !== undefined && shopCfg.accountId !== null) {
    const cfgAcc = String(shopCfg.accountId).trim();
    const pageAcc = pageIdentity.pageAccountId === undefined || pageIdentity.pageAccountId === null ? '' : String(pageIdentity.pageAccountId).trim();
    if (pageAcc !== cfgAcc) {
      throw new AuthError(`广告控制页账户映射不匹配：配置 ${cfgAcc}，页面实际 ${pageAcc || '(空)'}`);
    }
  }
  if (shopCfg.name && pageIdentity.pageShopName && String(shopCfg.name).trim() !== String(pageIdentity.pageShopName).trim()) {
    throw new AuthError(`店铺名称不匹配：配置「${shopCfg.name}」，页面实际「${pageIdentity.pageShopName}」`);
  }
}

/**
 * 广告清单分页核验（严格契约）：
 * - 每页必须带布尔 hasNext；只有最后一页显式 hasNext===false 才算清单结束
 *   （缺失/null/字符串等一律判契约非法，不能当作结束）；
 * - 页码必须从 1 连续递增且不重复（检测重复页/乱序）；
 * - 游标 pageToken 不得循环重复；
 * - 同一稳定广告 ID 不得跨页重复出现；
 * - 逐页核验来源许可、店铺身份、业务日期、抓取时效。
 * @returns {{ads: Array, pages: number}}
 */
function collectInventoryPages(pageResults, shopCfg, nowMs, maxAgeMinutes, realMode) {
  if (!Array.isArray(pageResults) || pageResults.length === 0) {
    throw new DataGuardError('广告清单为空（未读到任何分页）');
  }
  const seenTokens = new Set();
  const seenAdIds = new Set();
  const ads = [];
  for (const [i, pg] of pageResults.entries()) {
    const label = `广告清单第${i + 1}页`;
    if (!pg || typeof pg !== 'object') throw new DataGuardError(`${label} 数据缺失`);
    if (typeof pg.hasNext !== 'boolean') {
      throw new DataGuardError(
        `${label} hasNext 缺失或不是布尔值（${JSON.stringify(pg.hasNext)}）：分页契约非法，不能当作清单结束`
      );
    }
    if (pg.pageNo !== i + 1) {
      throw new DataGuardError(
        `${label} 页码契约非法：期望 pageNo=${i + 1}，实际 ${JSON.stringify(pg.pageNo)}（重复页或乱序）`
      );
    }
    if (pg.pageToken !== undefined && pg.pageToken !== null) {
      const tk = String(pg.pageToken);
      if (seenTokens.has(tk)) {
        throw new DataGuardError(`${label} 游标循环：pageToken "${tk}" 重复出现，清单不可信`);
      }
      seenTokens.add(tk);
    }
    checkSourceAllowed(pg.source, realMode);
    checkSourceIdentity(pg, shopCfg, label);
    checkBusinessDateToday(pg, label, nowMs);
    checkFreshness(pg.fetchedAt, maxAgeMinutes, nowMs, label);
    if (!Array.isArray(pg.ads)) throw new DataGuardError(`${label} 缺少 ads 数组`);
    for (const ad of pg.ads) {
      if (!ad.adId || typeof ad.adId !== 'string') {
        throw new DataGuardError(`广告清单中存在缺少稳定 ID 的广告（名称: ${ad.name || '未知'}）—— 禁止用名称/行号替代`);
      }
      if (seenAdIds.has(ad.adId)) {
        throw new DataGuardError(`${label} 广告稳定 ID 跨页重复：${ad.adId}（清单不可信，不能默认完整）`);
      }
      seenAdIds.add(ad.adId);
      ads.push(ad);
    }
  }
  const last = pageResults[pageResults.length - 1];
  if (last.hasNext !== false) {
    throw new DataGuardError(
      `广告清单不完整：第 ${pageResults.length} 页 hasNext=${JSON.stringify(last.hasNext)}，只有显式 false 才表示结束，不能宣称"全店"`
    );
  }
  return { ads, pages: pageResults.length };
}

/** 真实模式禁止 mock 数据。 */
function checkSourceAllowed(source, realMode) {
  if (realMode && source === 'mock') {
    throw new DataGuardError('真实执行模式下禁止使用模拟数据（source=mock），已停止');
  }
}

module.exports = {
  validateSummaryShape,
  checkSourceIdentity,
  checkBusinessDateToday,
  checkFreshness,
  checkSameShopAndDate,
  checkControllerIdentity,
  collectInventoryPages,
  checkSourceAllowed,
  closableSideOfAd,
};
