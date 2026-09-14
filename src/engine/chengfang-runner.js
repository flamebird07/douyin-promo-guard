'use strict';

/**
 * 乘方批次执行器（监控主链路接入层，fail-closed）。
 *
 * 把「当天费用/全店订单判断 → 乘方全店托管+商品自选 → 结果回读」接入
 * monitor 的半小时巡查路径：
 *
 * executeChengfangBatch（真实批次）：
 *   0) 前置门槛（集中校验，见 chengfang-gate.js）：realMode=true + pauseEnabled=true +
 *      非演练（dryRun!==true）→ 上海时段 08:00 后 → 未停止；任一不过 → 零请求。
 *   1) 批次开始前重新读取费用与全店订单（复用 close-coordinator.readAndEvaluate 的
 *      身份/日期/时效/来源核验链与零订单重读）：仍严格超过 1 元/单才执行，否则取消。
 *   2) 打开乘方页（pageOpener 注入：生产=openChengfangShop 真实页；测试=本地 DOM fixture），
 *      由 executeChengfangPause 完成身份核验 → 全店托管 → 商品自选 → 全量回读。
 *   3) 关闭浏览器会话，汇总批次（details 按「区域:稳定ID」键，见 verifyAllPaused）。
 *
 * runDryCycle（演练周期）：只枚举将暂停目标（executor 由配置门槛自动转演练），零业务点击。
 *
 * 只读边界：本模块不创建、不点击任何真实开关；真实点击完全由 executor 的集中门槛控制。
 * 会话契约：pageOpener 返回 { page, controller, browser?, close? }；close 优先，
 * 否则关闭 browser。
 */

const { resolveChengfangRealAllowed } = require('./chengfang-gate');
const { executeChengfangPause, V_READ_FAILED, V_PARTIAL_FAILED } = require('./chengfang-executor');
const { isAfterDailyStart, shanghaiDate } = require('../lib/time');
const { perOrderDisplayText } = require('./rules');

/** 生产默认会话开启器：真实乘方管理页（openChengfangShop + 真实控制器）。 */
async function defaultChengfangOpener({ loginCfg, shopCfg }) {
  const { openChengfangShop, createChengfangController } = require('../adapters/chengfang-reader');
  const { browser, target, account } = await openChengfangShop({ loginCfg, shopCfg });
  const controller = createChengfangController({});
  return { browser, page: target, controller, account };
}

/**
 * 演练是否"正常完成"：身份核验通过，且两区域视图无 read_failed / partial_failed。
 * 任何读取/分页/选择范围/弹窗失败 → 不算成功（演练完成≠成功，失败必须透出）。
 */
function dryCycleSucceeded(result) {
  if (!result || !result.identity || result.identity.ok !== true) return false;
  const FAIL = new Set([V_READ_FAILED, V_PARTIAL_FAILED]);
  for (const k of Object.keys(result.views || {})) {
    const s = result.views[k] && result.views[k].status;
    if (s && FAIL.has(s)) return false;
  }
  return true;
}

class ChengfangRunner {
  /**
   * @param {object} p
   * @param {object} p.coordinator  WholeShopCloseCoordinator（复用 readAndEvaluate 费用/订单核验）
   * @param {object} p.config       完整配置（execution/schedule/monitor/rules）
   * @param {()=>number} [p.now]
   * @param {(e:object)=>void} [p.audit]
   */
  constructor(p) {
    this.coordinator = p.coordinator;
    this.config = p.config;
    this.now = p.now || Date.now;
    this.audit = p.audit || (() => {});
  }

  async _openSession(pageOpener, shopCfg, loginCfg) {
    const session = await pageOpener({ loginCfg, shopCfg });
    if (!session || !session.page || !session.controller) {
      throw new Error('页面会话不完整（缺 page/controller），拒绝继续');
    }
    return session;
  }

  async _closeSession(session) {
    if (!session) return;
    try {
      if (typeof session.close === 'function') await session.close();
      else if (session.browser) await session.browser.close();
    } catch (_) { /* 关闭失败不阻塞批次结果 */ }
  }

  /**
   * 演练周期：一律强制 dryRun=true（无条件演练，不依赖当前配置），零业务点击。
   * 身份核验/读取/分页/选择范围/弹窗任何失败都必须透出为 outcome='dry_failed'，
   * 不得显示为"正常枚举 0 个目标"。
   * 演练失败不视为停机（没有发出任何请求）：错误写入返回的 error / reason 供触发记录。
   */
  async runDryCycle({ shopCfg, pageOpener, loginCfg }) {
    let session = null;
    try {
      session = await this._openSession(pageOpener, shopCfg, loginCfg);
      const result = await executeChengfangPause({
        controller: session.controller,
        page: session.page,
        shopCfg,
        config: this.config,
        dryRun: true, // 演练入口无条件强制演练，无视 pauseEnabled/realMode 是否已开启
        now: this.now,
        audit: this.audit,
        stopRequested: () => false,
      });
      if (!dryCycleSucceeded(result)) {
        const reason = result.confirmReason || '乘方演练未完成（身份/读取/分页/选择范围失败）';
        this.audit({ kind: 'chengfang-dry', shopId: shopCfg.id, outcome: 'dry_failed', reason });
        return {
          outcome: 'dry_failed',
          dryRun: true,
          executor: result,
          targets: [],
          views: result.views,
          mode: result.mode || 'dry-run',
          error: reason,
          reason,
        };
      }
      return {
        outcome: 'dry',
        dryRun: true,
        executor: result,
        targets: (result.dryRunTargets || []).map((t) => ({ view: t.view, planId: t.planId })),
        views: result.views,
        mode: result.mode,
        error: null,
      };
    } catch (e) {
      const reason = e.reason || e.message;
      this.audit({ kind: 'chengfang-dry', shopId: shopCfg.id, outcome: 'dry_failed', reason });
      return {
        outcome: 'dry_failed',
        dryRun: true,
        executor: null,
        targets: [],
        views: null,
        mode: 'dry-run',
        error: reason,
        reason,
      };
    } finally {
      await this._closeSession(session);
    }
  }

  /**
   * 真实批次（接入 monitor 主链路）。返回与 Monitor._recordBatch/_summarizeBatch 兼容的批次结果。
   */
  async executeChengfangBatch({ shopCfg, cycleToken, trigger, pageOpener, loginCfg }) {
    const batchDate = shanghaiDate(this.now());
    const counts = { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 };
    const base = { kind: 'chengfang-batch', shopId: shopCfg.id, batchDate };

    // ── 0) 前置门槛（fail-closed）：集中配置门槛 → 时段 → 停止 ──────────
    const realAllowed = resolveChengfangRealAllowed(this.config);
    if (!realAllowed.ok) {
      return { outcome: 'blocked', reason: realAllowed.reason, counts, batchDate, error: null };
    }
    if (!isAfterDailyStart(this.now(), this.config.schedule.dailyStartHour)) {
      const hh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
      return {
        outcome: 'blocked_window',
        reason: `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai），本轮不执行真实暂停`,
        counts, batchDate,
      };
    }
    if (cycleToken && cycleToken.aborted) {
      return { outcome: 'blocked_stopped', reason: '监控已停止，本轮不执行真实暂停', counts, batchDate };
    }
    this.audit({ ...base, step: 'batch-start', trigger: trigger && trigger.reason });

    // ── 1) 批次开始前重新读取费用+全店订单（严格 > 1元/单；否则取消，零请求）──
    let fresh;
    try {
      fresh = await this.coordinator.readAndEvaluate(shopCfg);
    } catch (e) {
      const reason = `操作前重新读取数据未通过核验：${e.reason || e.message}。零请求`;
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: false, error: reason });
      return { outcome: 'blocked', reason, counts, batchDate, error: e };
    }
    const pre = {
      costCents: fresh.cost.valueCents,
      orders: fresh.orders.valueCount,
      businessDate: fresh.cost.businessDate,
      perOrderText: perOrderDisplayText(fresh.cost.valueCents, fresh.orders.valueCount),
    };
    if (fresh.ok === false) {
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: false, blocked: fresh.blocked, reason: fresh.reason });
      return { outcome: 'blocked', reason: `操作前重新核实被阻止：${fresh.reason}`, counts, pre, batchDate };
    }
    if (!fresh.evaluation.over) {
      const reason = `操作前重新核实：已不超标，取消暂停。${fresh.evaluation.reason}`;
      this.audit({ ...base, step: 'pre-batch-revalidate', ok: true, cancelled: true, reason });
      counts.cancelled = 1;
      return { outcome: 'cancelled', reason, counts, pre, batchDate };
    }
    this.audit({ ...base, step: 'pre-batch-revalidate', ok: true, stillOver: true, reason: fresh.evaluation.reason });

    // ── 2) 打开乘方页并执行（executor 内部再做身份核验/每请求门槛/全量回读）──
    let session = null;
    try {
      session = await this._openSession(pageOpener, shopCfg, loginCfg);
      const result = await executeChengfangPause({
        controller: session.controller,
        page: session.page,
        shopCfg,
        config: this.config,
        businessDate: fresh.cost.businessDate,
        now: this.now,
        audit: this.audit,
        stopRequested: () => !!(cycleToken && cycleToken.aborted),
      });
      return this._summarizeExecutorResult({ result, counts, pre, batchDate, base });
    } catch (e) {
      const reason = `乘方暂停流程异常停止：${e.reason || e.message}。零新增请求`;
      this.audit({ ...base, step: 'executor', ok: false, error: reason });
      return { outcome: 'partial', reason, counts, pre, batchDate, error: e };
    } finally {
      await this._closeSession(session);
    }
  }

  /** 把 executor 结果映射为批次结果：details 按「区域:稳定ID」键归类 confirmed/failed/unknown。 */
  _summarizeExecutorResult({ result, counts, pre, batchDate, base }) {
    // 身份核验失败/页面结构不可识别 → 未发出任何请求，按 blocked 处理（不进 actions）
    if (result.views && result.views.identity && result.views.identity.status === 'read_failed') {
      const reason = result.confirmReason || '乘方身份核验失败（未发出任何请求）';
      this.audit({ ...base, step: 'batch-end', outcome: 'blocked', reason });
      return {
        outcome: 'blocked', reason, counts, pre, targets: [], details: [],
        allPausedConfirmed: false, confirmReason: reason, batchDate, executor: result,
      };
    }
    const confirmedKeys = new Set((result.finalVerify && result.finalVerify.confirmed) || []);
    const stillOpenKeys = new Set((result.finalVerify && result.finalVerify.stillOpen) || []);
    const details = [];
    for (const t of result.targets || []) {
      const key = `${t.view}:${t.planId}`;
      let outcome;
      if (confirmedKeys.has(key)) outcome = 'confirmed_closed';
      else if (stillOpenKeys.has(key)) outcome = 'failed';
      else outcome = 'unknown'; // 缺失/未扫描/流程中止 → 结果未知，绝不当作成功
      details.push({
        adId: key, view: t.view, planId: t.planId, outcome,
        reason: outcome === 'confirmed_closed' ? null : (result.confirmReason || null),
      });
      if (outcome === 'confirmed_closed') counts.confirmed += 1;
      else if (outcome === 'failed') counts.failed += 1;
      else counts.unknown += 1;
    }
    const targets = (result.targets || []).map((t) => ({ view: t.view, planId: t.planId }));
    const allPausedConfirmed = result.allPausedConfirmed === true;

    if (targets.length === 0 && allPausedConfirmed) {
      const reason = '乘方清单内无开启对象（已全部关闭或已确认无计划），无需操作';
      this.audit({ ...base, step: 'batch-end', outcome: 'nothing_to_pause', reason });
      return {
        outcome: 'nothing_to_pause', reason, counts, pre, targets,
        allPausedConfirmed: true, confirmReason: result.confirmReason || null,
        batchDate, details, executor: result,
      };
    }
    const outcome = allPausedConfirmed ? 'all_paused_confirmed' : 'partial';
    const reason = result.confirmReason || (allPausedConfirmed ? '乘方全部已暂停' : '乘方暂停未全部确认');
    this.audit({
      ...base, step: 'batch-end', outcome, counts, targets: targets.length,
      allPausedConfirmed, confirmReason: reason,
    });
    return {
      outcome, reason, counts, pre, targets, allPausedConfirmed,
      confirmReason: reason, batchDate, details, executor: result,
    };
  }
}

module.exports = { ChengfangRunner, defaultChengfangOpener, dryCycleSucceeded };
