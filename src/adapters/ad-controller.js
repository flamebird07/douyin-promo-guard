'use strict';

/**
 * 广告关闭控制适配器 —— 接口契约 + 未接入实现 + 明确标注的 mock 实现。
 *
 * ══════════════════════════════════════════════════════════════════
 * 接口契约（下一轮接入真实页面时必须实现，点击成功≠关闭成功，必须回读）：
 *
 * createAdController() 返回对象：
 *   connected: boolean
 *   async verifyIdentity({ page, shopCfg }) -> { ok, pageShopId?, pageShopName?, reason? }
 *       —— 从推广页面读取实际店铺/广告账户身份，由调用方与配置精确比对（===）
 *   async getAd({ page, adId }) -> { found, status?, rawName? }
 *       —— 用稳定 ID 定位广告，读取当前状态（用于操作前复核与操作后回读）
 *   async closeAd({ page, adId }) -> void
 *       —— 对稳定 ID 对应的广告执行关闭操作；超时且结果未知时抛
 *          CloseOutcomeUnknownError（绝不能把超时当成功或失败）
 *
 * 约束：
 * - 广告定位只允许使用稳定 ID；禁止按名称、行号定位（同名广告不同 ID 必须互不影响）。
 * - 不提供"恢复投放"能力；引擎不自动重开广告。
 * - 本轮无真实页面：真实实现抛 NotConnectedError。
 * - mock 实现用于隔离测试与演练演示，内部维护内存状态机。
 * ══════════════════════════════════════════════════════════════════
 */

const { NotConnectedError, CloseOutcomeUnknownError } = require('../lib/errors');

/** 关闭成功后应处于的状态集合（页面状态词待真实接入后校准，先按常见枚举）。 */
const CLOSED_STATES = ['已关闭', '已暂停', '关闭', '暂停', 'deleted', 'closed', 'paused'];
/** 仍在外投、允许执行关闭的状态。 */
const ACTIVE_STATES = ['投放中', '启用中', '投放', 'enabled', 'active', 'delivering'];

function isClosedStatus(status) {
  return CLOSED_STATES.includes(String(status || '').trim());
}
function isActiveStatus(status) {
  return ACTIVE_STATES.includes(String(status || '').trim());
}

/**
 * 广告行/对象的"可关闭侧别"语义（分离"投放开关状态"与"运行状态"，页面证据优先）：
 * - switchChecked 布尔（千川列表行级实测证据）最优先：开启=closable，未开启=closed_side；
 * - 适配器派生字段 closableNow/alreadyClosedSide（如详情页按状态词判定）次之；
 * - 状态词表回退（mock/旧适配）；
 * - 都无法判定 → 'unknown'：不得当作已关闭，也不得静默漏掉（由上层列为覆盖缺口）。
 * 运行状态词仅作记录，不替代开关证据。
 */
function closableSideOfAd(row) {
  if (!row) return 'unknown';
  if (typeof row.switchChecked === 'boolean') return row.switchChecked ? 'closable' : 'closed_side';
  if (row.closableNow === true) return 'closable';
  if (row.alreadyClosedSide === true) return 'closed_side';
  if (row.status !== undefined) {
    if (isActiveStatus(row.status)) return 'closable';
    if (isClosedStatus(row.status)) return 'closed_side';
  }
  return 'unknown';
}

/** 未接入实现。 */
function createAdControllerNotConnected() {
  return {
    connected: false,
    async verifyIdentity() {
      throw new NotConnectedError('广告账户身份校验（推广页面）');
    },
    async getAd() {
      throw new NotConnectedError('广告状态读取（推广页面）');
    },
    async closeAd() {
      throw new NotConnectedError('广告关闭操作（推广页面）');
    },
  };
}

/**
 * Mock 控制器（内存状态机，供隔离测试与演练演示）。
 * @param {object} opts
 *   identity      页面返回的身份 { id, name }
 *   ads           Map/数组：[{ adId, name, status }]
 *   failCloseFor  Set<adId>：closeAd 时抛普通错误（关闭失败）
 *   unknownFor    Set<adId>：closeAd 时先抛"结果未知"，之后 getAd 可见已关闭
 *   stuckFor      Set<adId>：closeAd 抛"结果未知"且回读仍是投放中（真实未知态）
 */
function createMockAdController(opts = {}) {
  const ads = new Map((opts.ads || []).map((a) => [a.adId, { ...a }]));
  const state = {
    identityCalls: 0,
    closeCalls: [],   // { adId, at }
    getAdCalls: 0,
  };

  return {
    connected: false,
    source: 'mock',
    state,
    isClosedStatus,
    isActiveStatus,
    async verifyIdentity() {
      state.identityCalls += 1;
      if (!opts.identity) {
        return { ok: false, reason: 'mock 未配置页面身份' };
      }
      return { ok: true, pageShopId: opts.identity.id, pageShopName: opts.identity.name };
    },
    async getAd({ adId }) {
      state.getAdCalls += 1;
      const ad = ads.get(adId);
      if (!ad) return { found: false };
      return { found: true, status: ad.status, rawName: ad.name };
    },
    async closeAd({ adId }) {
      state.closeCalls.push({ adId, at: new Date().toISOString() });
      const ad = ads.get(adId);
      if (!ad) throw new Error(`mock: 广告 ${adId} 不存在`);
      if (opts.failCloseFor && opts.failCloseFor.has(adId)) {
        throw new Error(`mock: 关闭请求被拒绝（${adId}）`);
      }
      if (opts.unknownFor && opts.unknownFor.has(adId)) {
        // 结果未知：操作可能已生效也可能没有 —— 之后 getAd 返回已关闭
        ad.status = '已关闭';
        throw new CloseOutcomeUnknownError('mock: 关闭请求超时，结果未知');
      }
      if (opts.stuckFor && opts.stuckFor.has(adId)) {
        // 结果未知且确实未生效
        throw new CloseOutcomeUnknownError('mock: 关闭请求超时，结果未知');
      }
      ad.status = '已关闭';
    },
  };
}

module.exports = { createAdControllerNotConnected, createMockAdController, isClosedStatus, isActiveStatus, closableSideOfAd, CLOSED_STATES, ACTIVE_STATES };
