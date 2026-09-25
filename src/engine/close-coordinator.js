'use strict';

/**
 * 全店关闭协调器 v2 —— 用户规则的核心执行者。
 *
 * 职责：
 * - 触发后的"全店关闭"批次：操作前重新读取当日费用与全店订单，核验身份/日期/时效
 *   并重新判断；已不超标则取消关闭（记录取消原因）；
 * - 广告清单分页读全（hasNext=false 才可用），作用对象 = 全部当前处于可投放状态的
 *   广告（含零消耗广告）；
 * - 批次执行期间检查停止信号与跨日边界：停止后不发新请求（已发出的继续回读）；
 *   跨日后剩余广告不再操作；
 * - 汇总结果：confirmed/failed/unknown/skipped；只有"清单完整 + 全部目标
 *   回读确认关闭 + 无失败无未知"才输出 allClosedConfirmed=true。
 *
 * 依赖注入：reader / controller / now / audit / stateView（今日批次记录），
 * 便于隔离测试与真实适配替换。
 */

const guard = require('./guard');
const { evaluateWholeShopCostPerOrder, perOrderDisplayText } = require('./rules');
const { closeOneAd } = require('./close-flow');
const { DataGuardError } = require('../lib/errors');
const { shanghaiDate, isAfterDailyStart } = require('../lib/time');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WholeShopCloseCoordinator {
  /**
   * @param {object} p
   * @param {object} p.reader          推广数据读取适配器（费用/订单/广告清单）
   * @param {object} p.controller      广告控制适配器（身份/状态/关闭）
   * @param {object} p.config          完整配置（execution/schedule/monitor/rules）
   * @param {()=>number} [p.now]       可注入时钟
   * @param {(e:object)=>void} [p.audit]
   */
  constructor(p) {
    this.reader = p.reader;
    this.controller = p.controller;
    this.config = p.config;
    this.now = p.now || Date.now;
    this.audit = p.audit || (() => {});
    this.inflight = new Map(); // 跨批次共享的"在途关闭请求"登记（按广告稳定 ID）
  }

  /**
   * 读取并核验单个 Summary（身份/日期/时效/解析）。
   * @returns Summary
   */
  async _readVerifiedSummary(kind, shopCfg) {
    const label = kind === 'cost' ? '全店推广费用' : '全店订单数';
    const summary = kind === 'cost'
      ? await this.reader.readCostSummary({ shopCfg })
      : await this.reader.readOrderSummary({ shopCfg });
    guard.validateSummaryShape(summary, label);
    guard.checkSourceIdentity(summary, shopCfg, label);
    guard.checkBusinessDateToday(summary, label, this.now());
    guard.checkFreshness(summary.fetchedAt, this.config.monitor.snapshotMaxAgeMinutes, this.now(), label);
    guard.checkSourceAllowed(summary.source, this.config.execution.realMode === true);
    return summary;
  }

  /**
   * 读取费用+订单（含零订单重读核实），通过后做规则判断。
   * @returns {{ok:true, cost, orders, evaluation}} 或 {ok:false, blocked, reason}
   */
  async readAndEvaluate(shopCfg) {
    const cost = await this._readVerifiedSummary('cost', shopCfg);
    let orders = await this._readVerifiedSummary('orders', shopCfg);
    guard.checkSameShopAndDate(cost, orders);

    // 零订单/无效订单：重新读取核实（用户说明 08:00 后订单不应为 0）
    let rechecked = 0;
    while (orders.valueCount === 0 && rechecked < (this.config.execution.zeroOrderRecheck ?? 1)) {
      rechecked += 1;
      this.audit({ kind: 'zero-order-recheck', shopId: shopCfg.id, attempt: rechecked });
      await sleep(0);
      orders = await this._readVerifiedSummary('orders', shopCfg);
      guard.checkSameShopAndDate(cost, orders);
    }
    if (orders.valueCount === 0) {
      const blocked = cost.valueCents > 0
        ? '全店订单为 0 但推广费用大于 0：已重新读取核实仍为 0，数据异常，阻止本轮关闭'
        : '全店订单为 0（费用也为 0）：无需关闭';
      return {
        ok: false, blocked: 'zero_orders',
        reason: blocked,
        cost, orders, rechecked,
      };
    }

    const rule = (this.config.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
    // 多店铺：店铺级 thresholdCents 覆盖全局规则；判定语义（严格大于）不变
    const shopThr = shopCfg && Number.isSafeInteger(shopCfg.thresholdCents) && shopCfg.thresholdCents > 0
      ? shopCfg.thresholdCents : null;
    const thresholdCents = shopThr != null ? shopThr : (rule ? rule.thresholdCents : null);
    if (!Number.isSafeInteger(thresholdCents) || thresholdCents <= 0) {
      throw new DataGuardError('未找到启用的 wholeShopCostPerOrder 规则或店铺阈值，无法判定');
    }
    const evaluation = evaluateWholeShopCostPerOrder({
      costCents: cost.valueCents,
      orders: orders.valueCount,
      thresholdCents,
    });
    return { ok: true, cost, orders, evaluation, rechecked };
  }

  /**
   * 分页读取完整广告清单（逐页核验身份/日期/时效；分页契约严格）。
   * 只有显式 hasNext===false 才表示清单结束；缺失/非布尔值立即判契约非法。
   * 每次调用生成新的 scanId → 读取器强制取得新快照（初次评估/操作前重核/终态回读
   * 各自独立扫描，不靠 TTL 过期，也不复用旧快照——第六轮修复）。
   * 完整性校验逐页执行：真实数据源（source=promo-page）必须显式声明 listComplete
   * 布尔值，缺失视为不完整；后续页声明与首页不一致同样拒绝（快照内不允许变化）。
   */
  async listAllAds(shopCfg) {
    const maxPages = this.config.execution.maxAdPages ?? 50;
    const scanId = `scan-${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pageResults = [];
    let meta = null;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const page = await this.reader.listAdPage({ shopCfg, pageNo, pageToken: pageResults.length ? pageResults[pageResults.length - 1].pageToken : undefined, scanId });
      if (!meta) {
        meta = {
          coverage: page.coverage || [],
          coverageGaps: page.coverageGaps || [],
          listComplete: page.listComplete !== false, // 未提供该字段的适配器（mock/旧）视为完整
          declared: typeof page.listComplete === 'boolean',
          source: page.source,
          scanId: page.scanId || scanId,
        };
      } else {
        // 后续页声明一致性：同一快照内不允许变化；真实源缺失声明也拒绝
        if (typeof page.listComplete !== 'boolean' && page.source === 'promo-page') {
          throw new DataGuardError(`广告清单第 ${pageNo} 页未显式声明完整性（listComplete 缺失）：真实数据源不得默认视为完整`);
        }
        if (typeof page.listComplete === 'boolean' && page.listComplete !== meta.listComplete) {
          throw new DataGuardError(`广告清单第 ${pageNo} 页完整性声明（${page.listComplete}）与首页（${meta.listComplete}）不一致，快照不可信`);
        }
        const gapsKey = JSON.stringify(page.coverageGaps || []);
        if (gapsKey !== JSON.stringify(meta.coverageGaps)) {
          throw new DataGuardError(`广告清单第 ${pageNo} 页覆盖缺口与首页不一致（扫描中覆盖范围发生变化），快照不可信`);
        }
      }
      if (page.crossDayScan === true) {
        throw new DataGuardError(`清单扫描期间跨日（${page.scanDates || '日期变化'}）：快照口径混杂两个日期，不能用于关闭决策`);
      }
      if (page.hasNext !== true && page.hasNext !== false) {
        throw new DataGuardError(
          `广告清单第 ${pageNo} 页 hasNext 缺失或不是布尔值（${JSON.stringify(page.hasNext)}）：只有显式 false 才表示清单结束，不能静默认定完整`
        );
      }
      pageResults.push(page);
      if (page.hasNext === false) break;
      if (pageNo === maxPages) {
        throw new DataGuardError(`广告清单超过分页上限（${maxPages} 页）仍有下一页，清单不完整，不能执行全店关闭`);
      }
    }
    const inv = guard.collectInventoryPages(pageResults, shopCfg, this.now(), this.config.monitor.snapshotMaxAgeMinutes, this.config.execution.realMode === true);
    return {
      ...inv,
      coverage: meta.coverage,
      coverageGaps: meta.coverageGaps,
      listComplete: meta.listComplete,
      scanId: meta.scanId,
    };
  }

  /**
   * 执行全店关闭批次。
   * @param {object} p
   * @param {object} p.shopCfg
   * @param {object} p.trigger       触发上下文（首轮评估结果与数据摘要）
   * @param {{aborted:boolean}} p.cycleToken  周期停止令牌（stop() 置 true）
   * @param {Map} [p.todayStatus]    今日各广告已知状态：Map<adId, 'confirmed'|'failed'|'unknown'|'skipped'>
   * @returns {object} 批次结果
   */
  async executeWholeShopCloseBatch(p) {
    const { shopCfg, cycleToken } = p;
    const todayStatus = p.todayStatus instanceof Map ? p.todayStatus : new Map();
    const batchDate = shanghaiDate(this.now());
    const counts = { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 };
    const details = [];
    const base = { kind: 'whole-shop-batch', shopId: shopCfg.id, batchDate };

    // ── 0) 前置门槛：真实模式 + 允许时段 + 未停止 ───────────────────
    if (this.config.execution.realMode !== true) {
      return { outcome: 'blocked', reason: '真实执行模式未开启（演练模式不执行关闭）', counts };
    }
    if (!isAfterDailyStart(this.now(), this.config.schedule.dailyStartHour)) {
      const hh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
      return { outcome: 'blocked_window', reason: `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai），本轮不执行真实关闭`, counts };
    }
    if (cycleToken && cycleToken.aborted) {
      return { outcome: 'blocked_stopped', reason: '监控已停止，本轮不执行关闭', counts };
    }

    this.audit({ ...base, step: 'batch-start', trigger: p.trigger && p.trigger.reason });

    // ── 1) 操作前重新核实触发数据（修复 Codex 问题 #5）──────────────
    let fresh;
    try {
      fresh = await this.readAndEvaluate(shopCfg);
    } catch (e) {
      const reason = `操作前重新读取数据未通过核验：${e.reason || e.message}。零关闭`;
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: false, error: reason });
      return { outcome: 'blocked', reason, counts, error: e };
    }
    const pre = {
      costCents: fresh.cost.valueCents,
      orders: fresh.orders.valueCount,
      businessDate: fresh.cost.businessDate,
      perOrderText: perOrderDisplayText(fresh.cost.valueCents, fresh.orders.valueCount),
    };
    if (fresh.ok === false) {
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: false, blocked: fresh.blocked, reason: fresh.reason });
      return { outcome: 'blocked', reason: `操作前重新核实被阻止：${fresh.reason}`, counts, pre };
    }
    if (!fresh.evaluation.over) {
      const reason = `操作前重新核实：已不超标，取消关闭。${fresh.evaluation.reason}`;
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: true, cancelled: true, reason });
      counts.cancelled = 1;
      return { outcome: 'cancelled', reason, counts, pre };
    }
    this.audit({ ...base, step: 'pre-batch-revalidate', ok: true, stillOver: true, reason: fresh.evaluation.reason });

    // ── 2) 广告控制页身份核验 ────────────────────────────────────────
    try {
      const identity = await this.controller.verifyIdentity({ page: null, shopCfg });
      guard.checkControllerIdentity(identity, shopCfg);
      this.audit({ ...base, step: 'controller-identity', ok: true });
    } catch (e) {
      const reason = `广告控制页身份核验未通过：${e.reason || e.message}。零关闭`;
      this.audit({ ...base, step: 'controller-identity', ok: false, error: reason });
      return { outcome: 'blocked', reason, counts };
    }

    // ── 3) 广告清单分页读全，确定目标（覆盖表 + 开关语义）────────────
    let inventory;
    try {
      inventory = await this.listAllAds(shopCfg);
    } catch (e) {
      const reason = `广告清单读取失败：${e.reason || e.message}。零关闭`;
      this.audit({ ...base, step: 'inventory', ok: false, error: reason });
      return { outcome: 'blocked', reason, counts };
    }
    this.audit({ ...base, step: 'inventory', ok: true, pages: inventory.pages, totalAds: inventory.ads.length, coverage: inventory.coverage, coverageGaps: inventory.coverageGaps });

    // 覆盖缺口（费用分项类型未接入读取 / 清单读取不完整）→ 明确阻止"全店"结论，零关闭。
    // 即使某类型当天消耗为零，也不能据此认定没有开启的广告。
    if (inventory.listComplete === false || (inventory.coverageGaps && inventory.coverageGaps.length > 0)) {
      const reasons = [
        ...(inventory.coverageGaps || []).map((g) => g.reason),
        ...(inventory.listComplete === false ? ['清单读取不完整（总数对账/未解析行/翻页失败）'] : []),
      ].join('；');
      const reason = `广告覆盖范围不完整，阻止"全店可关闭/已关闭"结论：${reasons}。零关闭（缺失类型当天消耗为零也不视为无广告）`;
      this.audit({ ...base, step: 'coverage-check', ok: false, gaps: inventory.coverageGaps, reason });
      return { outcome: 'blocked_coverage', reason, counts, coverage: inventory.coverage, coverageGaps: inventory.coverageGaps, pre };
    }

    // 目标 = 投放开关处于开启侧的广告（无论运行状态词、无论是否零消耗）；
    // 开关未知侧不得当作已关闭也不得漏掉（unknown 非空同样阻止）；
    // 已在关闭侧的记录数量。
    const sideOf = (ad) => guard.closableSideOfAd(ad);
    const targets = inventory.ads.filter((ad) => sideOf(ad) === 'closable');
    const unknownSide = inventory.ads.filter((ad) => sideOf(ad) === 'unknown').map((a) => ({ adId: a.adId, name: a.name, status: a.status }));
    const alreadyClosed = inventory.ads.filter((ad) => sideOf(ad) === 'closed_side').map((a) => a.adId);
    if (unknownSide.length > 0) {
      const reason = `存在开关/状态均无法确认侧别的广告（${unknownSide.map((u) => `${u.name}(${u.adId || '无ID'})`).join(',')}）：不能当作已关闭，也不得静默漏掉，阻止"全店"结论`;
      this.audit({ ...base, step: 'coverage-check', ok: false, unknownSide, reason });
      return { outcome: 'blocked_coverage', reason, counts, coverage: inventory.coverage, coverageGaps: inventory.coverageGaps, pre, unknownSide };
    }
    if (targets.length === 0) {
      const reason = alreadyClosed.length > 0
        ? `清单内 ${alreadyClosed.length} 个广告均已在关闭侧（开关未开启/状态关闭），无需操作`
        : '清单内没有处于投放侧的广告，无需操作';
      this.audit({ ...base, step: 'targeting', targets: 0, reason });
      return { outcome: 'nothing_to_close', reason, counts, pre, inventoryPages: inventory.pages, alreadyClosedCount: alreadyClosed.length };
    }
    this.audit({ ...base, step: 'targeting', targets: targets.map((t) => t.adId), alreadyClosed });

    // ── 4) 逐个关闭。每个"真正发出关闭请求"的时机（含重试前）都重新检查：
    //       停止信号、允许时段、批次业务日期（修复跨午夜时机漏洞）；
    //       已经发出的请求由 close-flow 继续回读确认。──────────────────
    const startHour = this.config.schedule.dailyStartHour;
    const abortReason = () => {
      if (cycleToken && cycleToken.aborted) return '收到停止信号：不再发出新的关闭请求';
      const currentDate = shanghaiDate(this.now());
      if (currentDate !== batchDate) {
        return `跨日（批次日期 ${batchDate} → 当前 ${currentDate}）：本批次不再发出新的关闭请求（触发数据为上一日期口径）`;
      }
      if (!isAfterDailyStart(this.now(), startHour)) {
        const hh = String(startHour).padStart(2, '0');
        return `已进入新的一天且未到允许时段（每日 ${hh}:00 后，Asia/Shanghai）：不再发出新的关闭请求`;
      }
      return null;
    };
    for (const ad of targets) {
      const skipWhy = abortReason();
      if (skipWhy) {
        counts.skipped += 1;
        details.push({ adId: ad.adId, adName: ad.name, outcome: 'skipped', reason: skipWhy });
        this.audit({ ...base, step: 'abort-skip', adId: ad.adId, note: skipWhy });
        continue;
      }
      const r = await closeOneAd({
        controller: this.controller,
        pageCtx: null,
        shopCfg,
        hit: { adId: ad.adId, name: ad.name, adType: ad.adType || null, reason: fresh.evaluation.reason },
        opts: this.config.execution,
        audit: this.audit,
        shouldAbortNewActions: abortReason,
        inflight: this.inflight,
      });
      details.push({ adId: ad.adId, adName: ad.name, ...r });
      if (r.outcome === 'confirmed_closed') counts.confirmed += 1;
      else if (r.outcome === 'unknown') counts.unknown += 1;
      else if (r.outcome === 'skipped') counts.skipped += 1;
      else counts.failed += 1;
      todayStatus.set(ad.adId, r.outcome === 'confirmed_closed' ? 'confirmed'
        : r.outcome === 'unknown' ? 'unknown'
        : r.outcome === 'skipped' ? 'skipped' : 'failed');
    }

    // ── 5) 终态回读：操作结束后重新完整读取全店清单（同一覆盖表与开关语义），
    //       核验身份/分页/状态，再决定是否可确认"全店广告已关闭"。
    //       不做无限追加操作（只回读一次），剩余对象与未完成原因全部记录。
    let finalInventory = null;
    let confirmError = null;
    try {
      finalInventory = await this.listAllAds(shopCfg);
    } catch (e) {
      confirmError = e;
    }
    let allClosedConfirmed = false;
    let confirmReason = null;
    const remaining = { closableAdIds: [], unknownAdIds: [] };
    if (!finalInventory) {
      confirmReason = `终态回读失败，无法确认全店状态：${confirmError.reason || confirmError.message}`;
      this.audit({ ...base, step: 'final-verify', ok: false, error: confirmReason });
    } else if (finalInventory.listComplete === false || (finalInventory.coverageGaps && finalInventory.coverageGaps.length > 0)) {
      const reasons = (finalInventory.coverageGaps || []).map((g) => g.reason).join('；');
      confirmReason = `终态回读覆盖不完整（${reasons}），无法确认全店状态`;
      this.audit({ ...base, step: 'final-verify', ok: false, error: confirmReason });
    } else {
      remaining.closableAdIds = finalInventory.ads.filter((a) => guard.closableSideOfAd(a) === 'closable').map((a) => a.adId);
      remaining.unknownAdIds = finalInventory.ads.filter((a) => guard.closableSideOfAd(a) === 'unknown').map((a) => a.adId);
      if (counts.failed === 0 && counts.unknown === 0 && counts.skipped === 0
        && remaining.closableAdIds.length === 0 && remaining.unknownAdIds.length === 0) {
        allClosedConfirmed = true;
      } else {
        const parts = [];
        if (counts.failed) parts.push(`失败 ${counts.failed} 个`);
        if (counts.unknown) parts.push(`结果未知 ${counts.unknown} 个`);
        if (counts.skipped) parts.push(`跳过未操作 ${counts.skipped} 个`);
        if (remaining.closableAdIds.length) parts.push(`终态回读仍处于投放侧: ${remaining.closableAdIds.join(',')}（可能为执行期间新增或被恢复投放的广告）`);
        if (remaining.unknownAdIds.length) parts.push(`终态回读侧别未知: ${remaining.unknownAdIds.join(',')}`);
        confirmReason = `未达成全店关闭确认：${parts.join('；')}`;
        this.audit({ ...base, step: 'final-verify', ok: true, confirmed: false, remaining, confirmReason });
      }
      if (allClosedConfirmed) {
        this.audit({ ...base, step: 'final-verify', ok: true, confirmed: true, pages: finalInventory.pages, totalAds: finalInventory.ads.length });
      }
    }

    const outcome = allClosedConfirmed ? 'all_closed_confirmed' : 'partial';
    this.audit({
      ...base, step: 'batch-end', outcome,
      counts, inventoryPages: inventory.pages, targets: targets.length,
      allClosedConfirmed, confirmReason,
    });
    return {
      outcome, counts, details, pre,
      inventoryPages: inventory.pages,
      targets: targets.length,
      closedSideCount: alreadyClosed.length,
      allClosedConfirmed,
      confirmReason,
      finalInventoryPages: finalInventory ? finalInventory.pages : null,
      remaining,
      coverage: inventory.coverage,
      batchDate,
    };
  }
}

module.exports = { WholeShopCloseCoordinator };
