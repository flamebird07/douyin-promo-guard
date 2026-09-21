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

const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed } = require('./chengfang-gate');
const { executeChengfangPause, executeChengfangEnable, V_READ_FAILED, V_PARTIAL_FAILED } = require('./chengfang-executor');
const { isAfterDailyStart, shanghaiDate, shanghaiWall } = require('../lib/time');
const { compactUrls } = require('../lib/log');
const { perOrderDisplayText } = require('./rules');

/** 生产默认会话开启器：真实乘方管理页（openChengfangShop + 真实控制器）。 */
async function defaultChengfangOpener({ loginCfg, shopCfg }) {
  const { openChengfangShop, createChengfangController } = require('../adapters/chengfang-reader');
  const { browser, target, account, context, cookieSession } = await openChengfangShop({ loginCfg, shopCfg });
  const controller = createChengfangController({});
  // context / cookieSession 一并透出：批次结束（浏览器关闭前）用于**本次实际加载的**
  // 店铺 Cookie 文件回写（见 _closeSession → writebackSessionCookies）。
  return { browser, page: target, controller, account, context, cookieSession };
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

/** 开启演练是否"正常完成"：与 dryCycleSucceeded 同语义（身份 + 两区域无失败视图）。 */
function dryEnableCycleSucceeded(result) {
  return dryCycleSucceeded(result);
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

  /**
   * 关闭会话。关闭浏览器**之前**，在身份核验通过的前提下回写本次 context 的 Cookie
   * （2026-09-16 用户明确授权的定点能力，见 src/login/cookie-writeback.js）。
   *
   * 安全边界：
   * - 只写 `cookieSession.filePath`（= resolveCookieFile 返回的本次实际加载路径），不接受任意路径；
   * - 身份未通过 / 登录失效 / 空或非法 Cookie / 会话期间源文件被改动 → 拒绝覆盖（保留旧文件）；
   * - 回写结果**单独记录**（audit + 批次字段 cookieWriteback），绝不影响/改写已确认的广告动作结果；
   * - 当前批次继续使用原 context，不回灌 Cookie、不刷新会话。
   * @returns {Promise<object|null>} 回写结果（不含任何 Cookie 值）
   */
  async _closeSession(session, ctx = {}) {
    if (!session) return null;
    let writeback = null;
    const shouldWriteback = ctx.writeback !== false && ctx.mode === 'execute'
      && session.cookieSession && session.cookieSession.filePath && session.context;
    if (shouldWriteback) {
      try {
        writeback = await this._writebackSessionCookies(session, ctx);
      } catch (e) {
        // 回写异常绝不冒泡：单独记录，广告动作结果保持原样
        writeback = { ok: false, skipped: false, reason: `Cookie 回写异常（旧文件保留）: ${e.message}` };
        this.audit({ kind: 'cookie-writeback', shopId: ctx.shopId || null, ok: false, error: e.message });
      }
      this.lastCookieWriteback = writeback;
    }
    try {
      if (typeof session.close === 'function') await session.close();
      else if (session.browser) await session.browser.close();
    } catch (_) { /* 关闭失败不阻塞批次结果 */ }
    return writeback;
  }

  /**
   * 回写装配（2026-09-16 第二轮定点修复）：**先取得当前有效的登录/身份证据**，再交给
   * `cookie-writeback` 落盘。旧实现把 `loginOk` 默认成 true —— 操作开始时身份正确，
   * 并不等于结束（回写）时登录仍然有效，这会让一个已失效的会话把 Cookie 覆盖回去。
   * 现改为 fail-closed：任何一项证据缺失/失败/异常都**不覆盖**。
   * 该核验是只读的（verifyIdentity 只读页面账户信息），不产生任何业务点击。
   * @returns {Promise<object>} 回写结果（不含任何 Cookie 值）
   */
  async _writebackSessionCookies(session, ctx) {
    const shopId = ctx.shopId || null;
    const { writebackSessionCookies } = require('../login/cookie-writeback');
    if (ctx.identityOk !== true) {
      const reason = '店铺/账户身份核验未通过：不覆盖 Cookie 文件';
      this.audit({ kind: 'cookie-writeback', shopId, ok: false, skipped: true, reason });
      return { ok: false, skipped: true, reason };
    }
    const ev = await this._currentLoginEvidence(session, ctx);
    if (ev.loginOk !== true) {
      const reason = `回写前未取得当前有效的登录/身份证据（fail-closed，不覆盖）：${ev.reason}`;
      this.audit({ kind: 'cookie-writeback', shopId, ok: false, skipped: true, reason });
      return { ok: false, skipped: true, reason };
    }
    return writebackSessionCookies({
      context: session.context,
      cookieFilePath: session.cookieSession.filePath,
      sessionStartFingerprint: session.cookieSession.startFingerprint,
      identityOk: true,
      loginOk: true,
      shopId,
      audit: this.audit,
    });
  }

  /**
   * 回写前的**当前**登录/身份只读证据。
   * 缺少 controller/page/shopCfg、核验未通过或抛错 → loginOk=false（fail-closed，不覆盖）。
   * @returns {Promise<{loginOk:boolean, reason:string|null}>}
   */
  async _currentLoginEvidence(session, ctx) {
    const shopCfg = ctx.shopCfg || null;
    const controller = session.controller;
    const page = session.page;
    if (!shopCfg || !page || !controller || typeof controller.verifyIdentity !== 'function') {
      return { loginOk: false, reason: '缺少可用的 controller/page/shopCfg，无法在回写前取得当前登录证据' };
    }
    try {
      const id = await controller.verifyIdentity({ page, shopCfg });
      if (id && id.ok === true) return { loginOk: true, reason: null };
      return { loginOk: false, reason: (id && id.reason) || '回写前身份核验未通过' };
    } catch (e) {
      return { loginOk: false, reason: `回写前身份核验异常：${e.reason || e.message}` };
    }
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
          actionType: 'pause',
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
        actionType: 'pause',
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
        actionType: 'pause',
        dryRun: true,
        executor: null,
        targets: [],
        views: null,
        mode: 'dry-run',
        error: reason,
        reason,
      };
    } finally {
      // 演练周期不产生真实广告动作 → 不回写 Cookie（避免无业务依据地改动店铺凭据文件）
      await this._closeSession(session, { writeback: false });
    }
  }

  /**
   * 开启演练周期：与 runDryCycle 同语义（无条件强制 dryRun=true，零业务点击），
   * 用于每日开启相位在 realMode=false 或 enableEnabled=false 时枚举"将开启"目标。
   */
  async runDryEnableCycle({ shopCfg, pageOpener, loginCfg }) {
    let session = null;
    try {
      session = await this._openSession(pageOpener, shopCfg, loginCfg);
      const result = await executeChengfangEnable({
        controller: session.controller,
        page: session.page,
        shopCfg,
        config: this.config,
        dryRun: true, // 演练入口无条件强制演练，无视 enableEnabled/realMode 是否已开启
        now: this.now,
        audit: this.audit,
        stopRequested: () => false,
      });
      if (!dryEnableCycleSucceeded(result)) {
        const reason = result.confirmReason || '乘方开启演练未完成（身份/读取/分页/选择范围失败）';
        this.audit({ kind: 'chengfang-enable-dry', shopId: shopCfg.id, outcome: 'dry_failed', reason });
        return {
          outcome: 'dry_failed',
          actionType: 'enable',
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
        actionType: 'enable',
        dryRun: true,
        executor: result,
        targets: (result.dryRunTargets || []).map((t) => ({ view: t.view, planId: t.planId })),
        views: result.views,
        mode: result.mode,
        error: null,
      };
    } catch (e) {
      const reason = e.reason || e.message;
      this.audit({ kind: 'chengfang-enable-dry', shopId: shopCfg.id, outcome: 'dry_failed', reason });
      return {
        outcome: 'dry_failed',
        actionType: 'enable',
        dryRun: true,
        executor: null,
        targets: [],
        views: null,
        mode: 'dry-run',
        error: reason,
        reason,
      };
    } finally {
      await this._closeSession(session, { writeback: false });
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
    let batchResult = null;
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
      batchResult = this._summarizeExecutorResult({ result, counts, pre, batchDate, base });
      return batchResult;
    } catch (e) {
      const reason = compactUrls(`乘方暂停流程异常停止：${e.reason || e.message}。零新增请求`);
      this.audit({ ...base, step: 'executor', ok: false, error: reason });
      return { outcome: 'partial', reason, counts, pre, batchDate, error: e };
    } finally {
      // 浏览器关闭前回写本次实际加载的店铺 Cookie（身份通过 + 真实执行 + 回读已结束时）；
      // 回写结果单独挂在批次上，绝不改写上面的 outcome/counts。
      const wb = await this._closeSession(session, {
        writeback: true,
        mode: 'execute',
        identityOk: !!(batchResult && batchResult.executor && batchResult.executor.identity
          && batchResult.executor.identity.ok === true),
        shopId: shopCfg.id,
        shopCfg,
      });
      if (wb && batchResult) batchResult.cookieWriteback = wb;
    }
  }

  /**
   * 真实开启批次（每日 07:00 相位接入 monitor 主链路）。
   * 与暂停批次的关键差异：开启不依赖费用/订单阈值（不读费用与订单），
   * 门槛 = realMode + enableEnabled + 上海 enableHour 起窗口 + 未停止 + 未跨日。
   * 返回与 Monitor._recordBatch/_summarizeBatch 兼容的批次结果。
   */
  async executeChengfangEnableBatch({ shopCfg, cycleToken, trigger, pageOpener, loginCfg }) {
    const batchDate = shanghaiDate(this.now());
    const counts = { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 };
    const base = { kind: 'chengfang-enable-batch', shopId: shopCfg.id, batchDate };
    const cf = (this.config.monitor && this.config.monitor.chengfang) || {};
    const enableHour = cf.enableHour !== undefined && cf.enableHour !== null ? cf.enableHour : 7;
    const dailyStartHour = this.config.schedule.dailyStartHour;

    // ── 0) 前置门槛（fail-closed）：集中配置门槛 → 开启时段 → 停止 ─────
    const realAllowed = resolveChengfangEnableAllowed(this.config);
    if (!realAllowed.ok) {
      return { outcome: 'blocked', reason: realAllowed.reason, counts, batchDate, error: null };
    }
    const w = shanghaiWall(this.now());
    if (!(w.hour >= enableHour && w.hour < dailyStartHour)) {
      const hh = String(enableHour).padStart(2, '0');
      const dh = String(dailyStartHour).padStart(2, '0');
      return {
        outcome: 'blocked_window',
        reason: `未到允许开启时段（每日 ${hh}:00–${dh}:00，Asia/Shanghai），本轮不执行真实开启`,
        counts, batchDate,
      };
    }
    if (cycleToken && cycleToken.aborted) {
      return { outcome: 'blocked_stopped', reason: '监控已停止，本轮不执行真实开启', counts, batchDate };
    }
    this.audit({ ...base, step: 'batch-start', trigger: trigger && trigger.reason });

    // ── 1) 打开乘方页并执行（executor 内部再做身份核验/每请求门槛/全量回读）──
    let session = null;
    let batchResult = null;
    try {
      session = await this._openSession(pageOpener, shopCfg, loginCfg);
      const result = await executeChengfangEnable({
        controller: session.controller,
        page: session.page,
        shopCfg,
        config: this.config,
        businessDate: batchDate,
        now: this.now,
        audit: this.audit,
        stopRequested: () => !!(cycleToken && cycleToken.aborted),
      });
      batchResult = this._summarizeEnableResult({ result, counts, batchDate, base });
      return batchResult;
    } catch (e) {
      const reason = compactUrls(`乘方开启流程异常停止：${e.reason || e.message}。零新增请求`);
      this.audit({ ...base, step: 'executor', ok: false, error: reason });
      return { outcome: 'partial', reason, counts, batchDate, error: e };
    } finally {
      // 浏览器关闭前回写本次实际加载的店铺 Cookie（用户 2026-09-16 明确授权）：
      // 仅在身份核验通过 + 真实执行模式下进行；失败/冲突单独记录，不改写批次结果。
      const wb = await this._closeSession(session, {
        writeback: true,
        mode: 'execute',
        identityOk: !!(batchResult && batchResult.executor && batchResult.executor.identity
          && batchResult.executor.identity.ok === true),
        shopId: shopCfg.id,
        shopCfg,
      });
      if (wb && batchResult) batchResult.cookieWriteback = wb;
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
    // 已确认键 = 全量回读结果 ∪ 流程中渐进记录（markTargetConfirmed）。
    // 2026-09-21 修复：中途失败（如商品自选回读恢复失败）时 finalVerify 可能为 null，
    // 旧实现把已确认的全店托管目标也计入 unknown（批次显示"已确认 0 / 未知 24"）。
    const confirmedKeys = new Set([
      ...((result.finalVerify && result.finalVerify.confirmed) || []),
      ...(result.targetsConfirmedKeys || []),
    ]);
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

  /** 把开启 executor 结果映射为批次结果（details 按「区域:稳定ID」键；开启不读费用/订单，无 pre）。 */
  _summarizeEnableResult({ result, counts, batchDate, base }) {
    // 身份核验失败/页面结构不可识别 → 未发出任何请求，按 blocked 处理（不进 actions）
    if (result.views && result.views.identity && result.views.identity.status === 'read_failed') {
      const reason = result.confirmReason || '乘方开启身份核验失败（未发出任何请求）';
      this.audit({ ...base, step: 'batch-end', outcome: 'blocked', reason });
      return {
        outcome: 'blocked', reason, counts, targets: [], details: [],
        allEnabledConfirmed: false, confirmReason: reason, batchDate, executor: result,
      };
    }
    const confirmedKeys = new Set([
      ...((result.finalVerify && result.finalVerify.confirmed) || []),
      ...(result.targetsConfirmedKeys || []),
    ]);
    const stillClosedKeys = new Set((result.finalVerify && result.finalVerify.stillClosed) || []);
    const details = [];
    for (const t of result.targets || []) {
      const key = `${t.view}:${t.planId}`;
      let outcome;
      if (confirmedKeys.has(key)) outcome = 'confirmed_open';
      else if (stillClosedKeys.has(key)) outcome = 'failed';
      else outcome = 'unknown'; // 缺失/未扫描/流程中止 → 结果未知，绝不当作成功
      details.push({
        adId: key, view: t.view, planId: t.planId, outcome,
        reason: outcome === 'confirmed_open' ? null : (result.confirmReason || null),
      });
      if (outcome === 'confirmed_open') counts.confirmed += 1;
      else if (outcome === 'failed') counts.failed += 1;
      else counts.unknown += 1;
    }
    const targets = (result.targets || []).map((t) => ({ view: t.view, planId: t.planId }));
    const allEnabledConfirmed = result.allEnabledConfirmed === true;

    if (targets.length === 0 && allEnabledConfirmed) {
      const reason = '乘方清单内无关闭对象（已全部开启或已确认无计划），无需操作';
      this.audit({ ...base, step: 'batch-end', outcome: 'nothing_to_enable', reason });
      return {
        outcome: 'nothing_to_enable', reason, counts, targets,
        allEnabledConfirmed: true, confirmReason: result.confirmReason || null,
        batchDate, details, executor: result,
      };
    }
    const outcome = allEnabledConfirmed ? 'all_enabled_confirmed' : 'partial';
    const reason = result.confirmReason || (allEnabledConfirmed ? '乘方全部已开启' : '乘方开启未全部确认');
    this.audit({
      ...base, step: 'batch-end', outcome, counts, targets: targets.length,
      allEnabledConfirmed, confirmReason: reason,
    });
    return {
      outcome, reason, counts, targets, allEnabledConfirmed,
      confirmReason: reason, batchDate, details, executor: result,
    };
  }
}

module.exports = { ChengfangRunner, defaultChengfangOpener, dryCycleSucceeded, dryEnableCycleSucceeded };
