'use strict';

/**
 * 推广数据读取适配器 v2 —— 三源分离契约 + 未接入实现 + 明确标注的 mock 实现。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用户规则与数据要求：
 * - 触发指标 = 当天累计推广费用（全店汇总） ÷ 当天累计全店订单数，> 1 元/单（100分）；
 * - 全店费用与全店订单是两个独立数据源，必须分别读取，且二者必须对应
 *   同一店铺、同一实际业务日期；不能把广告归因订单当全店订单（页面字段待核实）。
 * - 关闭作用对象 = 该店铺全部可投放广告（含当前零消耗广告），清单必须分页读全。
 *
 * 接口契约（接入真实页面时必须实现，需以真实页面证据为准）：
 *
 *   connected: boolean
 *   async readCostSummary({ shopCfg })  -> Summary  // 全店当天累计推广费用
 *   async readOrderSummary({ shopCfg }) -> Summary  // 全店当天累计订单数（页面字段待核实）
 *   async listAdPage({ shopCfg, pageNo, pageToken? }) -> AdPage  // 广告清单，逐页读取
 *
 * Summary 结构：
 * {
 *   source: 'promo-page'|'mock', kind: 'cost'|'orders',
 *   shopId: string,          // ★ 该数据源页面上实际展示的店铺/账户标识
 *   accountId?: string,      // 广告账户 ID（页面可见时）
 *   businessDate: 'YYYY-MM-DD', // ★ 页面统计口径日期（上海日历日），必须与当天一致才可用
 *   fetchedAt: ISO,          // 抓取时间
 *   pageUpdatedAt?: ISO,     // 页面提供的数据更新时间（如有）
 *   rawText?: string,        // 页面原始展示文本（留档核对）
 *   valueCents?: number,     // cost：解析出的整数分
 *   valueCount?: number,     // orders：解析出的整数
 *   parseError?: string      // 解析失败原因（绝不静默当 0）
 * }
 *
 * AdPage 结构：
 * {
 *   source, shopId, accountId?, businessDate, fetchedAt,
 *   pageNo: number, hasNext: boolean, pageToken?: string,
 *   ads: [{ adId: string(稳定ID), name, status }],
 *   coverageNote?: string    // 账户/筛选覆盖范围说明（真实接入时必填）
 * }
 *
 * 本轮没有真实推广页面：真实实现抛 NotConnectedError，不编造任何接口/字段/选择器。
 * mock 实现仅供演练演示与隔离测试（真实模式拒绝 mock 数据源）。
 * ══════════════════════════════════════════════════════════════════
 */

const { NotConnectedError } = require('../lib/errors');
const { shanghaiDate } = require('../lib/time');

/** 未接入实现。 */
function createPromoReaderNotConnected() {
  return {
    connected: false,
    source: 'not-connected',
    async readCostSummary() { throw new NotConnectedError('全店推广费用读取（推广页面）'); },
    async readOrderSummary() { throw new NotConnectedError('全店订单数读取（推广页面）'); },
    async listAdPage() { throw new NotConnectedError('广告清单分页读取（推广页面）'); },
  };
}

/**
 * Mock 读取器（仅限演练演示与测试）。
 * @param {object} def
 *   cost:   Summary 骨架（不含 source/kind/fetchedAt 缺省补齐）
 *   orders: Summary 骨架
 *   adPages: AdPage 的 ads 数组数组，[[{adId,name,status}...],[...]]（多页）
 *   identity: { id, name }
 *   now: 可注入时间戳（缺省 Date.now()）
 */
function createMockPromoReader(def, meta = {}) {
  const now = () => (meta.now ? meta.now() : Date.now());
  return {
    connected: false,
    source: 'mock',
    async readCostSummary() {
      return normalizeSummary(def.cost, 'cost', now());
    },
    async readOrderSummary() {
      return normalizeSummary(def.orders, 'orders', now());
    },
    async listAdPage({ pageNo = 1, scanId } = {}) {
      const pages = def.adPages || [];
      const idx = pageNo - 1;
      if (idx < 0 || idx >= pages.length) {
        return {
          source: 'mock', shopId: (def.adsMeta && def.adsMeta.shopId) || (def.identity && def.identity.id),
          accountId: def.adsMeta && def.adsMeta.accountId,
          businessDate: (def.adsMeta && def.adsMeta.businessDate) || shanghaiDate(now()),
          fetchedAt: new Date(now()).toISOString(),
          pageNo, hasNext: false, ads: [],
        };
      }
      return {
        source: 'mock',
        scanId: scanId || 'mock-scan',
        shopId: (def.adsMeta && def.adsMeta.shopId) || (def.identity && def.identity.id),
        accountId: def.adsMeta && def.adsMeta.accountId,
        businessDate: (def.adsMeta && def.adsMeta.businessDate) || shanghaiDate(now()),
        fetchedAt: new Date(now()).toISOString(),
        pageNo,
        hasNext: idx < pages.length - 1,
        ads: pages[idx].map((a) => ({ ...a })),
        coverage: [{ type: 'mock', complete: true }],
        coverageGaps: [],
        listComplete: true,
        coverageNote: 'mock',
      };
    },
  };
}

function normalizeSummary(def, kind, nowMs) {
  return {
    source: 'mock',
    kind,
    shopId: def.shopId,
    accountId: def.accountId,
    businessDate: def.businessDate || shanghaiDate(nowMs),
    fetchedAt: def.fetchedAt || new Date(nowMs).toISOString(),
    pageUpdatedAt: def.pageUpdatedAt || null,
    rawText: def.rawText || null,
    valueCents: def.valueCents,
    valueCount: def.valueCount,
    parseError: def.parseError,
  };
}

/**
 * 组合读取器 v2：按数据源逐个接入——
 *   cost  = qianchuan（千川"账户整体消耗"，真实）
 *   orders= compass（罗盘"经营概况"成交订单数，真实）
 *   ads   = qianchuan（全域投放清单，真实）
 * 未接入的源保持 NotConnected（明确"尚未接入"）。
 */
function createCompositeReader({ orderReader, costReader, adReader } = {}) {
  const nc = createPromoReaderNotConnected();
  const parts = [];
  if (costReader && costReader.connected) parts.push('cost');
  if (orderReader && orderReader.connected) parts.push('orders');
  if (adReader && adReader.connected) parts.push('ads');
  return {
    connected: parts.length > 0,
    source: parts.length ? `promo-page(${parts.join('+')})` : 'not-connected',
    costConnected: Boolean(costReader && costReader.connected),
    orderConnected: Boolean(orderReader && orderReader.connected),
    adsConnected: Boolean(adReader && adReader.connected),
    async readCostSummary(...a) {
      if (!costReader) return nc.readCostSummary(...a);
      return costReader.readCostSummary(...a);
    },
    async readOrderSummary(...a) {
      if (!orderReader) return nc.readOrderSummary(...a);
      return orderReader.readOrderSummary(...a);
    },
    async listAdPage(...a) {
      if (!adReader) return nc.listAdPage(...a);
      return adReader.listAdPage(...a);
    },
  };
}

module.exports = { createPromoReaderNotConnected, createMockPromoReader, createCompositeReader };
