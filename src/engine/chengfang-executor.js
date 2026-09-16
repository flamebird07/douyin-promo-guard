'use strict';

/**
 * 乘方暂停执行器 v2（可审查流程，fail-closed）。
 *
 * 本轮控制范围（用户明确）：乘方 = 全店托管（总开关）+ 商品自选（100条/页 → 全选 → 批量暂停）。
 * 首版只自动暂停；自动开启仅预留扩展位（不实现点击路径，也不设置开启条件）。
 *
 * 执行门槛（集中校验，见 chengfang-gate.js）：
 * - 真实暂停必须同时满足 execution.realMode=true、monitor.chengfang.pauseEnabled=true、
 *   非演练（execution.dryRun!==true）；显式 dryRun:false 不能越过配置门槛。
 * - 每个"真正发出的"托管关闭/批量暂停请求前重新检查：停止信号、上海时段 08:00 后、
 *   触发业务日期一致（未跨日）、真实门槛仍通过。
 * - 点击结果未知（非定位类异常）→ 强制回读实际状态，禁止盲点重试：
 *   托管开关是切换动作，回读仍开启时不得再次点击（避免反向开启）。
 * - 千川实机已知限制（2026-09-14）：新开页面中的首次“商品自选批量暂停”可能显示确认
 *   但不落地；需要在同一浏览器会话中回读后最多重新执行一次。允许刷新该页面，禁止为了
 *   重试重开浏览器。二次仍未确认则报告结果未知，绝不无限重试。
 *
 * 防误删硬性约束：业务动作只允许 pause（及未来预留 enable）；任何删除确认/非预期弹窗/
 * 文案不符/按钮缺失或重复 → 立即停止，零点击。弹窗检测失败同样停止（绝不当作无弹窗）。
 *
 * 全量回读（verifyAllPaused）：
 * - 重新扫描两区域"完整当前清单"（第一页起、逐页核验分页总数与页码、稳定ID），
 *   确认所有当前对象都处于关闭侧；新增/重新开启/状态未知/目标失踪/分页不完整 → 不报告全部暂停。
 * - 对象键 = 区域 + 稳定ID（不假定两区域ID永不重叠）。
 * - 空清单必须有明确空态证据（分页 total=0），缺失分页字段不当作空。
 */

const { DataGuardError } = require('../lib/errors');
const { shanghaiDate } = require('../lib/time');
const { boundedLandingPoll, resolvePollingConfig } = require('../lib/bounded-poll');
const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed, buildChengfangRequestGate } = require('./chengfang-gate');

const MAX_PAGE_VISITS = 20; // 商品自选分页处理/全量回读的翻页硬上限（防失控循环）

// 视图结论常量
const V_READ_FAILED = 'read_failed';       // 读取失败（绝不当作空/已关闭）
const V_CONFIRMED_EMPTY = 'confirmed_empty'; // 已确认无计划（成功读取且分页 total=0）
const V_ALREADY_PAUSED = 'already_paused';   // 全部已关闭，幂等跳过
const V_PAUSED = 'paused';                   // 目标全部确认关闭
const V_PARTIAL_FAILED = 'partial_failed';   // 部分目标未确认/未生效 → 不报告全部暂停
const V_ALREADY_ENABLED = 'already_enabled'; // 全部已开启，幂等跳过（开启流程）
const V_ENABLED = 'enabled';                 // 目标全部确认开启（开启流程）

/**
 * 执行乘方暂停流程。
 * @param {object} p
 * @param {object} p.controller  乘方控制器（真实 createChengfangController 或测试注入）
 * @param {object} p.page        页面句柄（真实 Playwright Page 或 mock）
 * @param {object} p.shopCfg     店铺配置
 * @param {object} p.config      完整配置（真实门槛/调度）
 * @param {boolean} [p.dryRun]   演练：只记录不点击。true 强制演练；
 *                               false/缺省仍受配置门槛约束（dryRun:false 不能越过门槛）
 * @param {string} [p.businessDate] 触发业务日期（上海日历日），用于请求级跨日检查
 * @param {()=>number} [p.now]
 * @param {(e:object)=>void} [p.audit]
 * @param {()=>boolean} [p.stopRequested]
 * @returns {Promise<object>} 结果（含 views/targets/allPausedConfirmed/confirmReason/finalVerify）
 */
async function executeChengfangPause(p) {
  const { controller, page, shopCfg, config } = p;
  const now = p.now || Date.now;
  const audit = p.audit || (() => {});
  const stopRequested = p.stopRequested || (() => false);

  // 集中门槛：dryRun 由配置决定，显式 dryRun:false 不能越过配置门槛；
  // 但显式 dryRun:true（如演练入口强制）无条件进入演练，无视当前配置许可。
  const realAllowed = resolveChengfangRealAllowed(config);
  const dryRun = p.dryRun === true ? true : !realAllowed.ok;

  const requestGate = buildChengfangRequestGate({
    config,
    nowFn: now,
    stopRequested,
    businessDate: p.businessDate,
  });

  const result = {
    startedAt: new Date(now()).toISOString(),
    shopId: shopCfg ? shopCfg.id : null,
    mode: dryRun ? 'dry-run' : 'execute',
    scope: ['全店托管', '商品自选'],
    businessDate: p.businessDate !== undefined && p.businessDate !== null ? p.businessDate : shanghaiDate(now()),
    gate: { ok: realAllowed.ok, reason: realAllowed.reason || null },
    identity: null,
    views: {},
    targets: [],           // { view, planId, action: 'pause' }
    selectionNote: null,
    notFoundIds: [],       // 处理中行消失、待全量回读核验
    allPausedConfirmed: false,
    confirmReason: null,
    dryRunTargets: [],     // 演练：将暂停的对象（含动作说明）
    finalVerify: null,
    polling: {},           // 各视图落地确认的**实际生效**轮询配置与结果（页面/日志可展示）
    stoppedAfterDispatch: null, // 点击已派发后收到停止时的真实只读确认结果（不谎报失败/成功）
    // 仅在本次浏览器会话内使用：千川提交后若跳回首页，回到这里恢复读取/重试。
    // 不写入审计日志，也不跨批次复用 Cookie 或浏览器。
    managementUrl: null,
  };
  const fail = (view, status, reason) => {
    result.views[view] = result.views[view] || {};
    result.views[view].status = status;
    result.views[view].reason = reason;
    result.confirmReason = reason;
    audit({ kind: 'chengfang', event: 'abort', view, status, reason });
  };

  // ── 0. 身份核验 ──────────────────────────────────────────────────
  const identity = await controller.verifyIdentity({ page, shopCfg }).catch((e) => ({ ok: false, reason: e.reason || e.message }));
  if (!identity || identity.ok !== true) {
    fail('identity', V_READ_FAILED, `身份核验失败：${(identity && identity.reason) || '未知'}`);
    return result;
  }
  result.identity = identity;
  if (typeof page.url === 'function') {
    const currentUrl = page.url();
    if (typeof currentUrl === 'string' && currentUrl.includes('/uni-prom/overall')) result.managementUrl = currentUrl;
  }
  audit({ kind: 'chengfang', event: 'identity', ok: true, accountId: identity.pageAccountId });

  try {
    // 贴近真正点击的最终检查：注册到控制器，在每次实际业务点击派发前（最后一次异步
    // 页面检查完成后）重新校验停止/时段/跨日/当前配置许可，并复检账户/页面身份；
    // 任一不满足 → 抛 DataGuardError，控制器不派发点击（零点击停止）。
    if (!dryRun && typeof controller.setBeforeDispatch === 'function') {
      controller.setBeforeDispatch(async ({ page: pg }) => {
        // 核验前检查（保留）：停止/时段/跨日/当前许可任一不满足 → 不进入异步身份复核
        const g0 = requestGate();
        if (!g0.ok) throw new DataGuardError(g0.reason);
        const id = await controller.verifyIdentity({ page: pg, shopCfg })
          .catch((e) => ({ ok: false, reason: e.reason || e.message }));
        if (!id || id.ok !== true) {
          throw new DataGuardError(`账户/页面身份变化：${(id && id.reason) || '未知'}（不再发出暂停请求）`);
        }
        // 身份复核成功返回后，再次同步检查 requestGate：停止/时段/跨日/当前许可
        // 可能在异步身份核验期间变化（如核验期间收到停止、跨午夜、关闭 pauseEnabled）。
        // 不通过立即抛错，禁止派发点击（与核验前检查构成双重保护）。
        const g1 = requestGate();
        if (!g1.ok) throw new DataGuardError(g1.reason);
      });
    }

    // ── 1. 全店托管 ──────────────────────────────────────────────
    const tuoguanOk = await pauseTuoguan({ controller, page, result, dryRun, requestGate, fail, audit, config, now, stopRequested });
    if (!tuoguanOk) return result;

    // ── 2. 商品自选 ──────────────────────────────────────────────
    const zixuanOk = await pauseZixuan({ controller, page, shopCfg, result, dryRun, requestGate, fail, audit, config, now, stopRequested });
    if (!zixuanOk) return result;
    if (dryRun) {
      result.confirmReason = '演练模式：仅记录将执行的动作，未点击任何开关/暂停，不得宣称已暂停';
      return result;
    }

    // ── 3. 全量回读验证（完整当前范围）──────────────────────────
    const verifyOk = await verifyAllPaused({ controller, page, result });
    result.allPausedConfirmed = verifyOk;
    result.confirmReason = verifyOk
      ? `乘方全部已暂停：全店托管 ${tuoguanCount(result)} 个目标 + 商品自选 ${zixuanCount(result)} 个目标，完整当前清单回读均确认关闭侧`
      : (result.confirmReason || '全量回读未全部确认');
    audit({ kind: 'chengfang', event: 'done', allPausedConfirmed: verifyOk, confirmReason: result.confirmReason, targets: result.targets.map((t) => t.planId) });
  } catch (e) {
    fail('global', V_PARTIAL_FAILED, `乘方暂停流程停止：${e.reason || e.message}`);
  }
  return result;
}

function tuoguanCount(result) {
  return (result.views.tuoguan && result.views.tuoguan.confirmedCount) || 0;
}
function zixuanCount(result) {
  return (result.views.zixuan && result.views.zixuan.confirmedCount) || 0;
}

// ── 全店托管：读取开关状态；已关闭跳过；开启才关闭 ──────────────────

async function pauseTuoguan({ controller, page, result, dryRun, requestGate, fail, audit, config, now = Date.now, stopRequested = () => false }) {
  await controller.switchView({ page, tab: '全店托管' });
  const view = await readViewFor(controller, page, '全店托管');
  if (!view) {
    fail('tuoguan', V_READ_FAILED, '全店托管视图读取失败（不当作无计划）');
    return false;
  }
  const rows = view.rows || [];
  if (rows.length === 0) {
    // 空态证据：分页 total 必须显式为 0，缺失分页字段不当作空
    const pag = view.pagination || {};
    if (pag.total !== 0) {
      fail('tuoguan', V_READ_FAILED, `全店托管无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不当作无计划`);
      return false;
    }
    result.views.tuoguan = { status: V_CONFIRMED_EMPTY, note: '已确认无计划（成功读取且分页 total=0）' };
    audit({ kind: 'chengfang', event: 'view', view: '全店托管', status: V_CONFIRMED_EMPTY });
    return true;
  }
  const unknown = rows.filter((r) => !r.id || r.switchChecked === null || r.switchChecked === undefined);
  if (unknown.length > 0) {
    fail('tuoguan', V_PARTIAL_FAILED, `全店托管存在 ${unknown.length} 行无法判定开关状态（含无稳定ID），不当作已关闭`);
    return false;
  }
  const open = rows.filter((r) => r.switchChecked === true);
  const closed = rows.filter((r) => r.switchChecked === false);
  if (open.length === 0) {
    result.views.tuoguan = { status: V_ALREADY_PAUSED, note: `全部 ${rows.length} 条已关闭，幂等跳过`, closedCount: closed.length };
    audit({ kind: 'chengfang', event: 'view', view: '全店托管', status: V_ALREADY_PAUSED, closed: closed.map((r) => r.id) });
    return true;
  }
  for (const r of open) {
    result.targets.push({ view: '全店托管', planId: r.id, action: 'pause' });
    result.dryRunTargets.push({ view: '全店托管', planId: r.id, action: 'pause（点击行内开关）' });
  }
  if (dryRun) {
    result.views.tuoguan = { status: V_PAUSED, dryRun: true, note: `演练：将暂停 ${open.length} 个开启中的托管计划`, openIds: open.map((r) => r.id) };
    audit({ kind: 'chengfang', event: 'plan', view: '全店托管', mode: 'dry-run', targets: open.map((r) => r.id) });
    return true;
  }
  for (const r of open) {
    // 每个真正发出的托管关闭请求前：停止/时段/跨日/门槛
    const g = requestGate();
    if (!g.ok) { fail('tuoguan', V_PARTIAL_FAILED, `停止发出托管关闭请求：${g.reason}`); return false; }
    // 弹窗检测失败 → 停止（绝不当作无弹窗）
    let danger;
    try {
      danger = await controller.detectDanger({ page, expectedAction: 'shop_disable' });
    } catch (e) {
      fail('tuoguan', V_PARTIAL_FAILED, `弹窗检测失败，停止点击行内开关：${e.reason || e.message}`);
      return false;
    }
    if (danger.length > 0) {
      fail('tuoguan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击行内开关：${danger.map((d) => d.kind).join(',')}`);
      return false;
    }
    let clickError = null;
    try {
      // 托管关闭实测有确认弹窗「确定关闭乘方投放吗？」，走精确提交闭环
      await controller.clickRowSwitch({ page, planId: r.id, expectAction: 'shop_disable' });
    } catch (e) {
      clickError = e;
    }
    if (clickError instanceof DataGuardError) {
      // 定位/标记核验失败 → 点击尚未发出
      fail('tuoguan', V_PARTIAL_FAILED, `托管开关未点击（零点击）：${clickError.reason || clickError.message}`);
      return false;
    }
    // 落地确认（有界轮询）：点击异常（非定位类，如页面关闭）也可能已执行 → 一律以回读为准。
    // 托管开关是**切换**动作：超时/状态未知一律只回读，绝不重复点击（避免反向开启）。
    const landing = await confirmLanding({
      controller, page, view: '全店托管', targetIds: [r.id], wantChecked: false,
      config, stopRequested, audit, eventKind: 'chengfang',
    });
    result.polling['全店托管'] = pollingSummary(landing.polling, landing.poll, { targetCount: 1 });
    if (!landing.rows) {
      fail('tuoguan', V_PARTIAL_FAILED, `托管计划 ${r.id} 开关${clickError ? '点击可能已执行，' : ''}回读失败：结果未知${clickError ? '，禁止重复切换' : ''}`);
      return false;
    }
    const row = landing.rows.find((x) => x.id === r.id);
    if (!row) {
      fail('tuoguan', V_PARTIAL_FAILED, `托管计划 ${r.id} 关闭后行消失，无法确认（不当作已关闭）`);
      return false;
    }
    if (row.switchChecked !== false) {
      fail('tuoguan', V_PARTIAL_FAILED, clickError
        ? `托管计划 ${r.id} 开关点击结果未知且回读仍开启：禁止重复切换（避免反向开启），需人工确认，停止`
        : `托管计划 ${r.id} 开关回读仍为开启`);
      return false;
    }
    audit({ kind: 'chengfang', event: 'paused', view: '全店托管', planId: r.id, confirmed: true, note: clickError ? '点击结果曾未知，回读确认已关闭' : undefined });
    if (landing.poll.stopped) {
      // 停止信号：本次已派发请求已按真实回读确认；不再重试、不再发出任何新业务请求。
      result.stoppedAfterDispatch = {
        view: '全店托管', action: 'pause', planId: r.id, wantChecked: false, gotChecked: row.switchChecked,
        note: '落地确认期间收到停止：已派发请求仅完成只读确认，不再发出新请求',
      };
      fail('tuoguan', V_PARTIAL_FAILED, `落地确认期间收到停止信号：托管计划 ${r.id} 已按真实回读确认（关闭侧），不再重试、不再发出任何新请求`);
      return false;
    }
  }
  result.views.tuoguan = { status: V_PAUSED, confirmedCount: open.length, note: `已确认关闭 ${open.length} 个开启中的托管计划` };
  return true;
}

// ── 商品自选：100条/页 → 全选（实测范围）→ 批量暂停 → 稳定ID去重翻页 ──

async function pauseZixuan({ controller, page, shopCfg, result, dryRun, requestGate, fail, audit, config, now = Date.now, stopRequested = () => false }) {
  await controller.switchView({ page, tab: '商品自选' });
  const firstView = await readViewFor(controller, page, '商品自选');
  if (!firstView) {
    fail('zixuan', V_READ_FAILED, '商品自选视图读取失败（不当作无计划）');
    return false;
  }
  // 确保 100条/页（已满足则幂等跳过）
  const ps = firstView.pagination && firstView.pagination.pageSize;
  if (!ps || !String(ps).includes('100')) {
    await controller.switchPageSize({ page, size: '100条/页' });
  }
  const view0 = await readViewFor(controller, page, '商品自选');
  if (!view0) {
    fail('zixuan', V_READ_FAILED, '切换100条/页后商品自选视图读取失败');
    return false;
  }
  if (view0.rows.length === 0) {
    // 空态证据：分页 total 必须显式为 0，缺失分页字段不当作空
    const pag = view0.pagination || {};
    if (pag.total !== 0) {
      fail('zixuan', V_READ_FAILED, `商品自选无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不当作无计划`);
      return false;
    }
    result.views.zixuan = { status: V_CONFIRMED_EMPTY, note: '已确认无计划（成功读取且分页 total=0）' };
    audit({ kind: 'chengfang', event: 'view', view: '商品自选', status: V_CONFIRMED_EMPTY });
    return true;
  }

  const processed = new Set(); // 已确认暂停的稳定 ID
  const drySeen = new Set();   // 演练已记录的目标（防止跨页重复记录）
  let pageVisits = 0;
  result.views.zixuan = { total: view0.pagination && view0.pagination.total, pageSize: view0.pagination && view0.pagination.pageSize, processedCount: 0 };

  while (true) {
    // 每次决策前强制新扫描（绝不复用操作前缓存）
    const view = await readViewFor(controller, page, '商品自选');
    if (!view) {
      fail('zixuan', V_PARTIAL_FAILED, '商品自选强制新扫描失败');
      return false;
    }
    // 勾选/任何点击之前先检测非预期弹窗（含删除确认）——弹窗存在即停止；检测失败同样停止
    let dangerBefore;
    try {
      dangerBefore = await controller.detectDanger({ page });
    } catch (e) {
      fail('zixuan', V_PARTIAL_FAILED, `弹窗检测失败，停止后续点击：${e.reason || e.message}`);
      return false;
    }
    if (dangerBefore.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击：${dangerBefore.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      return false;
    }
    const rows = view.rows || [];
    const targets = rows.filter((r) => r.id && r.switchChecked === true && !processed.has(r.id) && (dryRun ? !drySeen.has(r.id) : true));
    result.views.zixuan.currentPageTargets = targets.map((r) => r.id);

    if (targets.length === 0) {
      const pag = view.pagination || {};
      if (!pag.hasNext) break;
      const next = await controller.clickNextPage({ page });
      pageVisits += 1;
      if (pageVisits > MAX_PAGE_VISITS) {
        fail('zixuan', V_PARTIAL_FAILED, `翻页超过 ${MAX_PAGE_VISITS} 次仍未收敛，停止`);
        return false;
      }
      if (!next || next.clicked !== true) {
        if (next && next.atEnd) break;
        fail('zixuan', V_PARTIAL_FAILED, `翻页失败：${(next && next.reason) || '未知'}（停止，防止页码位移漏处理）`);
        return false;
      }
      continue;
    }

    const pageOk = await pausePageTargets({ controller, page, shopCfg, targets, rows, result, dryRun, processed, drySeen, requestGate, fail, audit, config, now, stopRequested });
    if (!pageOk) return false;
    // 处理完成继续循环：列表可能收缩/前移，重新扫描当前页
  }

  if (dryRun) {
    result.views.zixuan.dryRun = true;
    result.views.zixuan.status = V_PAUSED;
    result.views.zixuan.dryRunCount = drySeen.size;
    result.views.zixuan.note = `演练：共枚举 ${drySeen.size} 个商品自选开启目标（100条/页翻页），将执行 全选→批量暂停（未点击）`;
    return true;
  }

  result.views.zixuan.status = V_PAUSED;
  result.views.zixuan.processedCount = processed.size;
  result.views.zixuan.note = `已确认暂停 ${processed.size} 个商品自选计划（100条/页，稳定ID去重）`;
  return true;
}

async function readViewFor(controller, page, tab) {
  const v = await controller.readView({ page, tab }).catch((e) => ({ error: String(e.reason || e.message) }));
  if (!v || v.error) return null;
  if (v.rows && v.rows.error) return null;
  return { rows: (v.rows && v.rows.rows) || [], pagination: v.pagination || {} };
}

// ── 落地确认（有界轮询，暂停/开启共用）──────────────────────────────
//
// 2026-09-16 定点修复：旧实现在"点击已派发"后只做**一次立即回读**（暂停侧），
// 或按 ceil(timeout/interval) 次数轮询（开启侧）。真实平台存在数秒~数十秒的异步落地
// （实测 27 秒后仍未落地、稍后全部生效），单次立即回读会把成功误判为失败；
// 次数轮询则因未计入每次读取耗时而使总等待不可控。
// 现统一为 boundedLandingPoll：按**实际截止时间**有界、读取串行不重叠，
// 停止后不再重试/不再发新请求，但已派发请求继续在有限期限内只读确认。

/** 判定是否仍有目标未落地：pending=明确未落地；unknown=状态无法判定（行消失）。 */
function landingPending(rows, targetIds, wantChecked) {
  const list = rows || [];
  let pending = 0;
  let unknown = 0;
  for (const id of targetIds) {
    const row = list.find((x) => String(x.id) === String(id));
    if (!row) { unknown += 1; continue; }
    if (row.switchChecked !== wantChecked) pending += 1;
  }
  return { pending, unknown };
}

/** 按期望开关状态归类回读结果（confirmed / failed / notFound）。 */
function classifyLanding(rows, targetIds, wantChecked) {
  const list = rows || [];
  const confirmed = [];
  const failed = [];
  const notFound = [];
  for (const id of targetIds) {
    const row = list.find((x) => String(x.id) === String(id));
    if (!row) notFound.push(id);
    else if (row.switchChecked === wantChecked) confirmed.push(id);
    else failed.push(id);
  }
  return { confirmed, failed, notFound };
}

/**
 * 点击已派发后的落地确认（有界轮询）。
 *
 * 时钟说明（2026-09-16 定点修复）：轮询预算必须按**真实经过的时间**计算，因此这里
 * 一律使用单调推进的真实时钟（`Date.now`），**绝不使用调用方的业务时钟 `now`**——
 * 业务时钟在调用方是"当次检查时刻"的固定快照（用于上海时段/跨日判断），把它当轮询时钟
 * 会让 deadline 永不耗尽（预算恒为正剩余），轮询退化为死循环。
 * @param {object} o { controller, page, view, targetIds, wantChecked, config, stopRequested, audit, eventKind }
 * @returns {Promise<{polling:object, poll:object, rows:Array|null, confirmed:string[], failed:string[], notFound:string[]}>}
 *          rows === null 表示整个轮询期间没有一次成功读取（结果未知，绝不当作成功）。
 */
async function confirmLanding(o) {
  const { controller, page, view, targetIds, wantChecked, config, stopRequested, audit, eventKind } = o;
  const polling = resolvePollingConfig(config && config.execution);
  const poll = await boundedLandingPoll({
    read: async () => {
      const v = await readViewFor(controller, page, view);
      if (!v) {
        const e = new Error(`${view}强制新扫描回读失败`);
        e.reason = e.message;
        throw e;
      }
      return v;
    },
    isPending: (v) => landingPending(v.rows, targetIds, wantChecked),
    timeoutMs: polling.timeoutMs,
    intervalMs: polling.intervalMs,
    // 真实单调时钟：见上方说明。业务时钟 now 不得用于轮询预算。
    now: Date.now,
    stopRequested,
    onAttempt: (info) => audit({
      kind: eventKind, event: 'landing-poll', view,
      timeoutMs: polling.timeoutMs, intervalMs: polling.intervalMs, ...info,
    }),
  });
  const rows = poll.value ? (poll.value.rows || []) : null;
  const cls = rows ? classifyLanding(rows, targetIds, wantChecked) : { confirmed: [], failed: [], notFound: [] };
  return { polling, poll, rows, ...cls };
}

/** 落地轮询结果 → 结果对象的可展示摘要（不含 Cookie 值/敏感数据）。 */
function pollingSummary(polling, poll, extra = {}) {
  return {
    timeoutMs: polling.timeoutMs,
    intervalMs: polling.intervalMs,
    timeoutSource: polling.timeoutSource,
    intervalSource: polling.intervalSource,
    attempts: poll.attempts,
    elapsedMs: poll.elapsedMs,
    readFailures: poll.readFailures,
    settled: poll.settled,
    stopped: poll.stopped,
    timedOut: poll.timedOut,
    // 2026-09-16 第二轮：有界读取的完整性信息（供页面/日志与"是否允许重发"判断）
    abandonedReads: poll.abandonedReads,
    inFlight: poll.inFlight,
    lastReadFailed: poll.lastReadFailed,
    valueStale: poll.valueStale,
    ...extra,
  };
}

/**
 * 落地确认结束后的"最新状态是否可信"判定（2026-09-16 第二轮定点修复）。
 *
 * 旧缺陷：轮询结束时若**最后一次读取失败**，调用方仍会用此前那次成功读取的旧快照
 * （往往显示"仍未落地/仍关闭"）去走重试分支 —— 用陈旧状态重发请求。
 * 判定为不可信的情形：
 *  - `inFlight`：返回时仍有无法取消的在途读取，平台真实状态尚未确定；
 *  - `lastReadFailed`：最后一次读取失败，快照是更早的；
 *  - `valueStale`：轮询层给出的综合标记（含"从未读成功"）。
 * @returns {{trustworthy:boolean, reason:string|null}}
 */
function landingStateTrustworthy(poll) {
  if (!poll) return { trustworthy: false, reason: '无轮询结果' };
  if (poll.inFlight) {
    return { trustworthy: false, reason: '落地确认超时后仍有一个无法取消的在途读取（最新状态未知）' };
  }
  if (poll.lastReadFailed) {
    return { trustworthy: false, reason: '落地确认的最后一次读取失败（最新状态未知，不得据旧快照重发）' };
  }
  if (poll.valueStale) {
    return { trustworthy: false, reason: '落地确认未取得可信的最新快照' };
  }
  return { trustworthy: true, reason: null };
}

/**
 * 单页处理：全选 → 实测选择范围（跨页则清除并改按当前页目标勾选）→ 精确校正 →
 * 请求级门槛 → 危险检测 → 暂停 → 强制新扫描回读。
 * 返回 true 继续；false 表示已 fail（调用方停止）。
 */
async function pausePageTargets({ controller, page, shopCfg, targets, rows, result, dryRun, processed, drySeen, requestGate, fail, audit, config, now = Date.now, stopRequested = () => false, retryAttempt = 0 }) {
  const targetIds = targets.map((t) => t.id);
  for (const id of targetIds) {
    if (retryAttempt === 0) {
      result.targets.push({ view: '商品自选', planId: id, action: 'pause' });
      result.dryRunTargets.push({ view: '商品自选', planId: id, action: 'pause（批量暂停）' });
    }
    if (drySeen) drySeen.add(id);
  }
  audit({ kind: 'chengfang', event: 'plan', view: '商品自选', targets: targetIds, mode: dryRun ? 'dry-run' : 'execute' });
  if (dryRun) return true;

  // 请求级门槛（勾选前）：停止/时段/跨日/配置门槛
  const g0 = requestGate();
  if (!g0.ok) { fail('zixuan', V_PARTIAL_FAILED, `停止发出商品自选暂停请求：${g0.reason}`); return false; }

  await controller.selectAllInPage({ page });
  const sel = await controller.readSelection({ page }).catch(() => ({ selectedIds: [], selectedCount: 0 }));
  let finalSel = sel.selectedIds || [];
  const targetSet = new Set(targetIds);
  const allRowIds = rows.filter((r) => r.id).map((r) => r.id);
  const allRowSet = new Set(allRowIds);

  // 全选范围以实测为准（不靠猜测）。DOM 只呈现当前页行；跨页全选只能由
  // 批量栏"已选N个"（> 当前页勾选数）或选中集合含当前页外 ID 判定。
  const bar0 = await controller.readBatchBar({ page }).catch(() => null);
  const domCount = finalSel.length;
  const barCount = (bar0 && bar0.selectedCount !== null && bar0.selectedCount !== undefined) ? bar0.selectedCount : null;
  const crossPage = finalSel.some((id) => !allRowSet.has(id)) || (barCount !== null && barCount > domCount);

  if (crossPage) {
    // 优先策略：清除跨页选择 → 按已核验的当前页目标重新勾选；
    // 平台残留不可见跨页选择（批量栏计数>0）→ 选择范围无法确认 → 停止，不宽松通过。
    const toClear = [...new Set(finalSel)];
    for (const id of toClear) {
      const cr = await controller.setRowCheckbox({ page, planId: id, checked: false }).catch((e) => ({ error: String(e) }));
      if (cr && cr.error) {
        fail('zixuan', V_PARTIAL_FAILED, `清除跨页选择失败（${id}）：${cr.error}`);
        return false;
      }
    }
    const selAfterClear = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
    if (selAfterClear.selectedIds.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `跨页选择清除失败：仍有 ${selAfterClear.selectedIds.length} 个可见行选中，选择范围不可确认，停止`);
      return false;
    }
    const barAfterClear = await controller.readBatchBar({ page }).catch(() => null);
    const afterClearCount = (barAfterClear && barAfterClear.selectedCount !== null && barAfterClear.selectedCount !== undefined) ? barAfterClear.selectedCount : 0;
    if (afterClearCount > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `清除跨页选择后批量栏仍显示已选 ${afterClearCount} 个（不可见跨页行残留），完整范围无法确认，停止`);
      return false;
    }
    // 按已核验的当前页目标逐行勾选
    for (const id of targetIds) {
      const sr = await controller.setRowCheckbox({ page, planId: id, checked: true }).catch((e) => ({ error: String(e) }));
      if (sr && sr.error) {
        fail('zixuan', V_PARTIAL_FAILED, `按目标勾选 ${id} 失败：${sr.error}`);
        return false;
      }
    }
    const sel2 = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
    finalSel = sel2.selectedIds || [];
    const missing = targetIds.filter((id) => !finalSel.includes(id));
    const stillExtra = finalSel.filter((id) => !targetSet.has(id));
    const bar2 = await controller.readBatchBar({ page }).catch(() => null);
    const bar2Count = (bar2 && bar2.selectedCount !== null && bar2.selectedCount !== undefined) ? bar2.selectedCount : null;
    if (missing.length > 0 || stillExtra.length > 0 || (bar2Count !== null && bar2Count !== targetIds.length)) {
      fail('zixuan', V_PARTIAL_FAILED, `跨页选择清除后按目标重选仍未收敛（缺失 ${missing.length}、多余 ${stillExtra.length}、批量栏已选 ${bar2Count}），选择范围不可确认，停止`);
      return false;
    }
    result.selectionNote = `表头全选实测为跨页：已清除跨页选择，改为按当前页已核验目标勾选（${targetIds.length} 行，批量栏已选 ${bar2Count}）`;
    audit({ kind: 'chengfang', event: 'selection', view: '商品自选', scope: 'cross-page-cleared', count: targetIds.length });
  } else {
    const extra = finalSel.filter((id) => !targetSet.has(id));
    if (extra.length > 0) {
      // 全选包含非目标行（如已关闭行）→ 精确取消勾选
      for (const id of extra) {
        const cr = await controller.setRowCheckbox({ page, planId: id, checked: false }).catch((e) => ({ error: String(e) }));
        if (cr && cr.error) {
          fail('zixuan', V_PARTIAL_FAILED, `取消勾选 ${id} 失败：${cr.error}`);
          return false;
        }
      }
      const sel2 = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
      finalSel = sel2.selectedIds || [];
    }
    const stillExtra = finalSel.filter((id) => !targetSet.has(id));
    const missing = targetIds.filter((id) => !finalSel.includes(id));
    if (stillExtra.length > 0 || missing.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `精确选择后仍未收敛：多余 ${stillExtra.length}、缺失 ${missing.length}，停止（全选范围不可确认）`);
      return false;
    }
    // 当前页模式下"已选N个"必须与 DOM 选中集合一致
    const bar = await controller.readBatchBar({ page }).catch(() => null);
    const barN = (bar && bar.selectedCount !== null && bar.selectedCount !== undefined) ? bar.selectedCount : null;
    if (barN !== null && barN !== finalSel.length) {
      fail('zixuan', V_PARTIAL_FAILED, `批量栏"已选${barN}个"与实际选中 ${finalSel.length} 个不一致，停止`);
      return false;
    }
    result.selectionNote = `全选框实测为当前页全选，共 ${finalSel.length} 行（批量栏已选 ${barN}）`;
  }

  // 点击前：请求级门槛（选择完成后停止 → 不发新暂停请求）
  const g = requestGate();
  if (!g.ok) { fail('zixuan', V_PARTIAL_FAILED, `停止发出批量暂停请求：${g.reason}`); return false; }
  // 危险弹窗检测（删除确认/非预期弹窗一律停止，不点击通用"确定"；检测失败同样停止）
  let danger;
  try {
    danger = await controller.detectDanger({ page });
  } catch (e) {
    fail('zixuan', V_PARTIAL_FAILED, `弹窗检测失败，停止点击批量"暂停"：${e.reason || e.message}`);
    return false;
  }
  if (danger.length > 0) {
    fail('zixuan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击：${danger.map((d) => `${d.kind}:${d.text}`).join('；')}`);
    return false;
  }

  let clickError = null;
  let clickResult = null;
  try {
    clickResult = await controller.clickBatchPause({ page, expectedCount: targetIds.length });
  } catch (e) {
    clickError = e;
  }
  if (clickError instanceof DataGuardError) {
    // 定位/标记/检测/弹窗类失败 → 点击或确认未发出（零点击/零确认停止）
    fail('zixuan', V_PARTIAL_FAILED, `批量暂停未发出（零点击）：${clickError.reason || clickError.message}`);
    return false;
  }

  // 操作后强制新扫描回读（绝不复用操作前缓存；点击异常也可能已发出请求 → 以回读为准）
  // 千川有时在确认后跳回首页。仅在本次 page/browser/context 内回到已记录的管理页；
  // 不重开浏览器、不重新加载 Cookie。恢复失败即结果未知，绝不把空页当作已暂停。
  const recovered = await restoreManagementPageForReadback({ controller, page, shopCfg, managementUrl: result.managementUrl });
  if (!recovered.ok) {
    fail('zixuan', V_PARTIAL_FAILED, `批量暂停后无法恢复乘方管理页回读：${recovered.reason}`);
    return false;
  }
  // 落地确认（有界轮询，2026-09-16 补齐暂停侧）：平台异步落地可能延迟数秒~数十秒，
  // 单次立即回读会把成功误判为失败。停止信号到达后不再重试/不再发新请求，
  // 但已派发请求继续在有限期限内只读确认。
  const landing = await confirmLanding({
    controller, page, view: '商品自选', targetIds, wantChecked: false,
    config, stopRequested, audit, eventKind: 'chengfang',
  });
  result.polling['商品自选'] = pollingSummary(landing.polling, landing.poll, { targetCount: targetIds.length });
  if (!landing.rows) {
    fail('zixuan', V_PARTIAL_FAILED, `批量暂停请求${clickError ? '可能已发出但' : ''}落地轮询回读失败：结果未知，停止`);
    return false;
  }
  const postRows = landing.rows;
  const failed = landing.failed;
  const notFound = landing.notFound;
  for (const id of landing.confirmed) processed.add(id);
  for (const id of notFound) {
    if (!result.notFoundIds.includes(id)) result.notFoundIds.push(id);
  }
  if (landing.poll.stopped) {
    // 停止信号：已派发请求仅完成只读确认；绝不重试、绝不发出新业务请求。
    result.stoppedAfterDispatch = {
      view: '商品自选', action: 'pause', confirmed: landing.confirmed, failed, notFound,
      note: '落地确认期间收到停止：已派发请求仅完成只读确认，未重试、未发出新请求',
    };
    fail('zixuan', V_PARTIAL_FAILED,
      `落地确认期间收到停止信号：已派发批量暂停仅完成只读确认（${landing.confirmed.length}/${targetIds.length} 个已确认关闭），不再重试、不再发出任何新请求`);
    return false;
  }
  if (failed.length > 0) {
    // 千川实机限制：首次提交有时确认成功却未落地。保持同一页面/同一浏览器会话，
    // 按**实际仍未落地**的目标（含部分成功场景）重新选择并仅重试一次；
    // 不关闭浏览器、不重新读取 Cookie、不反向切换、不扩范围。
    // 2026-09-15 修复（交接第 6 项）：原实现仅在"全部失败"时重试，部分成功/未知状态一律直接失败；
    // 现改为：仍有失败目标且本次未重试过 → 以回读为准只对失败目标重试一次。
    // 2026-09-16 修复（本轮第 4 项）：重试前必须**重新核验真实状态、身份、停止与时间门槛**。
    if (retryAttempt === 0 && failed.length <= targetIds.length) {
      // 2026-09-16 第二轮：最新状态不可信（最后一次读取失败 / 仍有无法取消的在途读取）时，
      // 绝不用此前的"仍关闭"旧快照去重发 —— 那会把已经落地的目标再点一次。
      const trust = landingStateTrustworthy(landing.poll);
      if (!trust.trustworthy) {
        fail('zixuan', V_PARTIAL_FAILED,
          `${trust.reason}：不据旧快照重发（已确认 ${landing.confirmed.length}/${targetIds.length} 个关闭）`);
        return false;
      }
      // 未知状态（notFound/开关状态未知）不参与重试：无法确认目标当前实际状态，避免盲重发。
      if (notFound.length > 0) {
        fail('zixuan', V_PARTIAL_FAILED,
          `暂停回读存在 ${notFound.length} 个目标行消失（状态未知），不盲目重发；失败目标 ${failed.length} 个：${failed.slice(0, 5).join(',')}`);
        return false;
      }
      const retryPlan = await prepareRetry({
        controller, page, shopCfg, failed, wantChecked: false, requestGate, fail, audit, result, eventKind: 'chengfang',
      });
      if (!retryPlan.ok) return false;
      if (retryPlan.landed.length > 0) {
        for (const id of retryPlan.landed) processed.add(id);
        audit({
          kind: 'chengfang', event: 'retry-skipped', view: '商品自选',
          note: `重试前重新核验：${retryPlan.landed.length} 个目标已落地（回读确认关闭），不再重发`,
          targets: retryPlan.landed,
        });
      }
      if (retryPlan.stillPending.length === 0) return true;
      const retryTargets = targets.filter((t) => retryPlan.stillPending.includes(t.id));
      audit({
        kind: 'chengfang', event: 'retry', view: '商品自选', attempt: 2,
        targets: retryTargets.map((t) => t.id),
        note: `首次暂停回读仍有 ${failed.length}/${targetIds.length} 个未落地，仅对未落地目标同会话重试一次（已重新核验状态/身份/停止/时段，不反向切换、不扩范围）`,
      });
      return pausePageTargets({
        controller, page, shopCfg, targets: retryTargets, rows: postRows, result, dryRun,
        processed, drySeen, requestGate, fail, audit, config, now, stopRequested, retryAttempt: 1,
      });
    }
    fail('zixuan', V_PARTIAL_FAILED, `暂停未生效（开关仍开启）：${failed.slice(0, 5).join(',')}...${failed.length > 5 ? `（共 ${failed.length} 个）` : ''}${clickError ? `（点击结果曾未知，以回读为准：${clickError.reason || clickError.message}）` : ''}`);
    return false;
  }
  if (notFound.length > 0) {
    audit({ kind: 'chengfang', event: 'paused', view: '商品自选', confirmed: targetIds.filter((id) => processed.has(id)), missing: notFound, note: '行消失未当作已关闭，待全量回读核验' });
  } else {
    audit({ kind: 'chengfang', event: 'paused', view: '商品自选', confirmed: targetIds });
  }
  return true;
}

/**
 * 同会话重试前的重新核验（2026-09-16 本轮第 4 项）。
 * 重试前必须重新核验：停止/时段/跨日/配置门槛（requestGate）+ 页面身份 + **真实状态**
 * （绝不复用旧缓存）。返回 {ok:false} 表示不得重试；landed=已落地目标（无需重发），
 * stillPending=确实仍未落地的目标（才允许重试）。
 * @param {object} o { controller, page, shopCfg, failed, wantChecked, requestGate, fail, audit, result, eventKind }
 */
async function prepareRetry(o) {
  const { controller, page, shopCfg, failed, wantChecked, requestGate, fail, audit, eventKind } = o;
  const g = requestGate();
  if (!g.ok) {
    fail('zixuan', V_PARTIAL_FAILED, `重试前门槛复核不通过（不再重发）：${g.reason}`);
    return { ok: false };
  }
  const id = await controller.verifyIdentity({ page, shopCfg }).catch((e) => ({ ok: false, reason: e.reason || e.message }));
  if (!id || id.ok !== true) {
    fail('zixuan', V_PARTIAL_FAILED, `重试前身份复核不通过（不再重发）：${(id && id.reason) || '未知'}`);
    return { ok: false };
  }
  const fresh = await readViewFor(controller, page, '商品自选');
  if (!fresh) {
    fail('zixuan', V_PARTIAL_FAILED, '重试前重新读取商品自选视图失败：结果未知，不重试');
    return { ok: false };
  }
  const rows = fresh.rows || [];
  const landed = [];
  const stillPending = [];
  const vanished = [];
  for (const pid of failed) {
    const row = rows.find((x) => String(x.id) === String(pid));
    if (!row) vanished.push(pid);
    else if (row.switchChecked === wantChecked) landed.push(pid);
    else stillPending.push(pid);
  }
  if (vanished.length > 0) {
    fail('zixuan', V_PARTIAL_FAILED,
      `重试前核验发现 ${vanished.length} 个目标行消失（状态未知），不重发：${vanished.slice(0, 5).join(',')}`);
    return { ok: false };
  }
  audit({ kind: eventKind, event: 'retry-precheck', view: '商品自选', landed, stillPending, note: '重试前已重新核验停止/时段/配置门槛、页面身份与真实开关状态' });
  return { ok: true, landed, stillPending };
}

/**
 * 同一会话回读前保证仍在乘方管理页；页面跳转时才用原 URL 恢复。
 *
 * 2026-09-15 修复（交接第 5 项）：原实现只 goto + 固定等 8 秒 + 切"商品自选"标签，
 * 真实页面 goto 后先呈现营销目标标签（"直播/商品"），必须先点"商品"才会出现
 * "商品自选/全店托管"子标签；且恢复后还需 100条/页 与分页位置/完整性核验。
 * 身份不匹配必须阻断——不得仅导航恢复掩盖账户变更。
 *
 * @param {object} o { controller, page, shopCfg, managementUrl, wantTab }
 * @returns {{ok:boolean, restored?:boolean, reason?:string, pageSize?:string, pageNo?:number|null, total?:number|null}}
 */
async function restoreManagementPageForReadback({ controller, page, shopCfg, managementUrl, wantTab = '商品自选' }) {
  const identity = await controller.verifyIdentity({ page, shopCfg }).catch(() => null);
  if (identity && identity.ok === true) return { ok: true, restored: false };
  if (!managementUrl || typeof page.goto !== 'function') return { ok: false, reason: '当前页面非乘方管理页，且没有可用的同会话管理页 URL' };
  try {
    await page.goto(managementUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(3000);

    // 1) goto 后需先点"商品"营销目标标签，才会出现"商品自选/全店托管"子标签（实测）
    const deadlineTab = Date.now() + 25000;
    let identityOk = false;
    while (Date.now() < deadlineTab) {
      const cur = await controller.verifyIdentity({ page, shopCfg }).catch(() => null);
      if (cur && cur.ok === true) { identityOk = true; break; }
      // 尝试点击"商品"标签（自包含点击；找不到则等待）
      await page.evaluate(() => {
        const els = [...document.querySelectorAll('body *')].filter((el) => {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
          return own === '商品' && el.querySelectorAll('*').length <= 4;
        });
        const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (el) el.click();
      }).catch(() => {});
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(2000);
    }
    if (!identityOk) {
      const last = await controller.verifyIdentity({ page, shopCfg }).catch(() => null);
      return { ok: false, reason: `恢复后身份/页面核验失败：${(last && last.reason) || '未到达乘方管理页（含"商品"标签点击后）'}` };
    }

    // 2) 切到目标子标签（商品自选）
    await controller.switchView({ page, tab: wantTab });

    // 3) 商品自选需确保 100条/页，并核验分页位置与完整性
    let pageSize = null;
    let pageNo = null;
    let total = null;
    if (wantTab === '商品自选') {
      let v = await readViewFor(controller, page, wantTab);
      if (!v) return { ok: false, reason: '恢复后商品自选视图读取失败' };
      const ps = v.pagination && v.pagination.pageSize;
      if (!ps || !String(ps).includes('100')) {
        await controller.switchPageSize({ page, size: '100条/页' });
        v = await readViewFor(controller, page, wantTab);
        if (!v) return { ok: false, reason: '恢复后切换100条/页失败，视图读取失败' };
      }
      pageSize = (v.pagination && v.pagination.pageSize) || null;
      pageNo = (v.pagination && v.pagination.activePage != null) ? Number(v.pagination.activePage) : null;
      total = (v.pagination && v.pagination.total != null) ? v.pagination.total : null;
      if (!pageSize || !String(pageSize).includes('100')) {
        return { ok: false, reason: `恢复后每页条数核验失败（当前 ${pageSize || '缺失'}），回读范围不可确认` };
      }
      // 分页位置核验：无法确定当前页码 → 回读起点不可信
      if (total != null && total > 100 && pageNo == null) {
        return { ok: false, reason: `恢复后无法确认分页位置（total=${total} 但 activePage 缺失），回读完整性不可确认` };
      }
    }

    // 4) 再次身份核验（慢加载后账户可能变化；身份不匹配阻断）
    const again = await controller.verifyIdentity({ page, shopCfg }).catch(() => null);
    if (!again || again.ok !== true) return { ok: false, reason: (again && again.reason) || '恢复后身份/页面核验失败' };
    return { ok: true, restored: true, pageSize, pageNo, total };
  } catch (e) {
    return { ok: false, reason: e.reason || e.message };
  }
}

// ── 全量回读验证：完整当前范围（两区域全量清单）──────────────────────

/**
 * 重新扫描两区域完整当前清单（第一页起、逐页核验总数与页码、稳定ID），
 * 确认所有当前对象均处于关闭侧。目标失踪/新增/重新开启/状态未知/分页不完整 → 不报告全部暂停。
 * 对象键 = 区域 + 稳定ID（不假定两区域ID永不重叠）。
 */
async function verifyAllPaused({ controller, page, result }) {
  const targetKeys = new Set(result.targets.map((t) => `${t.view}:${t.planId}`));
  const scope = ['全店托管', '商品自选'];
  const found = new Map(); // `${region}:${planId}` -> switchChecked
  let scanError = null;

  for (const region of scope) {
    await controller.switchView({ page, tab: region });
    const first = await readViewFor(controller, page, region);
    if (!first) {
      scanError = `全量回读：${region} 视图读取失败`;
      break;
    }
    // 商品自选确保 100条/页
    if (region === '商品自选' && first.pagination && first.pagination.pageSize && !String(first.pagination.pageSize).includes('100')) {
      await controller.switchPageSize({ page, size: '100条/页' });
    }
    // 从第一页开始扫描（只读分页导航；避免承接上次操作后的非首页）
    await controller.ensureFirstPage({ page }).catch(() => {});

    let regionTotal = null;
    let regionSeen = 0;
    let pageNo = 0;
    let visits = 0;
    while (true) {
      const view = await readViewFor(controller, page, region);
      if (!view) {
        scanError = `全量回读：${region} 第 ${pageNo + 1} 页强制新扫描失败`;
        break;
      }
      const pag = view.pagination || {};
      if (view.rows.length === 0) {
        // 空态证据：分页 total 必须显式为 0；缺失分页字段不能当作空
        if (pag.total !== 0) {
          scanError = `全量回读：${region} 无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不能当作空清单`;
        }
        break;
      }
      if (regionTotal === null) {
        regionTotal = pag.total;
        if (regionTotal === null || regionTotal === undefined) {
          scanError = `全量回读：${region} 缺失分页总数，清单完整性不可确认`;
          break;
        }
      } else if (pag.total !== regionTotal) {
        scanError = `全量回读：${region} 分页总数在扫描中变化（${regionTotal} → ${pag.total}），清单不可信`;
        break;
      }
      pageNo += 1;
      let okRows = true;
      for (const r of view.rows || []) {
        const key = `${region}:${r.id}`;
        if (!r.id) { scanError = `全量回读：${region} 存在无稳定ID的行，无法确认其状态`; okRows = false; break; }
        if (r.switchChecked === null || r.switchChecked === undefined) {
          scanError = `全量回读：${region} 计划 ${r.id} 开关状态未知，不当作已关闭`;
          okRows = false; break;
        }
        if (found.has(key)) { scanError = `全量回读：${region} 计划 ${r.id} 重复出现，清单不可信`; okRows = false; break; }
        found.set(key, r.switchChecked);
      }
      if (!okRows) break;
      regionSeen += view.rows.length;
      if (!pag.hasNext) break;
      const next = await controller.clickNextPage({ page });
      visits += 1;
      if (visits > MAX_PAGE_VISITS) {
        scanError = `全量回读：${region} 翻页超过 ${MAX_PAGE_VISITS} 次未收敛，清单不完整`;
        break;
      }
      if (!next || next.clicked !== true) {
        scanError = `全量回读：${region} 翻页失败：${(next && next.reason) || '未知'}，清单不完整`;
        break;
      }
    }
    if (scanError) break;
    // 总数对账：防静默缺行（页码起点错误/渲染缺失都会导致不一致）
    if (regionTotal !== null && regionTotal !== regionSeen) {
      scanError = `全量回读：${region} 分页总数 ${regionTotal} 与实际读取 ${regionSeen} 不一致，清单不完整`;
      break;
    }
  }

  if (scanError) {
    result.confirmReason = scanError;
    result.finalVerify = { regionKeys: found.size, targets: targetKeys.size, confirmed: [], stillOpen: [], missing: [], unknown: [], scanError };
    return false;
  }

  const confirmed = [];
  const stillOpen = [];
  const unknown = [];
  for (const [key, checked] of found) {
    if (checked === true) stillOpen.push(key);
    else confirmed.push(key);
  }
  const missing = [];
  for (const key of targetKeys) if (!found.has(key)) missing.push(key);

  result.finalVerify = { regionKeys: found.size, targets: targetKeys.size, confirmed, stillOpen, missing, unknown };

  // 新增/重新开启（全量清单中任何开启侧对象，含非目标）
  if (stillOpen.length > 0) {
    result.confirmReason = `全量回读：仍有 ${stillOpen.length} 个当前对象处于开启侧（含新增/被恢复投放）：${stillOpen.slice(0, 5).join(',')}...`;
    return false;
  }
  // 目标失踪（不当作已关闭）
  if (missing.length > 0) {
    result.confirmReason = `全量回读：找不到 ${missing.length} 个目标（不当作已关闭）：${missing.slice(0, 5).join(',')}...`;
    return false;
  }
  // 按区域统计已确认关闭的目标数
  const tuoguanTargetIds = new Set(result.targets.filter((t) => t.view === '全店托管').map((t) => t.planId));
  const zixuanTargetIds = new Set(result.targets.filter((t) => t.view === '商品自选').map((t) => t.planId));
  result.views.tuoguan.confirmedCount = [...tuoguanTargetIds].filter((id) => found.get(`全店托管:${id}`) === false).length;
  result.views.zixuan.confirmedCount = [...zixuanTargetIds].filter((id) => found.get(`商品自选:${id}`) === false).length;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// 自动开启流程（每日 07:00 相位；独立门禁 enableEnabled；不依赖费用/订单阈值）
// ═══════════════════════════════════════════════════════════════════

/**
 * 执行乘方开启流程（镜像 executeChengfangPause，方向为"关闭侧 → 开启侧"）。
 *
 * 开启门槛（集中校验，见 chengfang-gate.js）：
 * - 真实开启必须同时满足 execution.realMode=true、monitor.chengfang.enableEnabled=true、
 *   非演练（execution.dryRun!==true）；显式 dryRun:false 不能越过配置门槛。
 * - 开启不读取费用/订单，不依赖任何阈值。
 * - 每个"真正发出的"托管开关/批量开启请求前重新检查：停止信号、上海开启时段
 *   （enableHour 起、dailyStartHour 前）、触发业务日期一致（未跨日）、真实门槛仍通过。
 * - 开启范围固定为 全店托管 + 商品自选；绝不触碰标准/全域/品牌等视图。
 * - 防误删硬性约束与暂停一致：批量栏出现"开启/暂停/删除"时只点"开启"，
 *   删除按钮点击数恒为 0；删除确认/非预期弹窗/按钮缺失或重复 → 立即停止，零点击。
 * - 千川首次批量操作未落地 → 同浏览器会话内（记录乘方管理页 URL）最多重试一次；
 *   第二次仍未确认 → 结果未知，绝不无限重试、不重开浏览器、不重新读取 Cookie。
 * - 全量回读（verifyAllEnabled）：重新扫描两区域完整当前清单，确认所有当前对象
 *   均处于开启侧；跳回首页/空页缺证据/分页不完整/回读失败 → 不报告全部开启。
 *
 * @param {object} p 与 executeChengfangPause 相同参数结构；businessDate 为开启相位业务日期
 * @returns {Promise<object>} 结果（含 views/targets/allEnabledConfirmed/confirmReason/finalVerify）
 */
async function executeChengfangEnable(p) {
  const { controller, page, shopCfg, config } = p;
  const now = p.now || Date.now;
  const audit = p.audit || (() => {});
  const stopRequested = p.stopRequested || (() => false);

  // 集中门槛：dryRun 由配置决定；显式 dryRun:true（演练）无条件进入演练，无视当前配置许可
  const realAllowed = resolveChengfangEnableAllowed(config);
  const dryRun = p.dryRun === true ? true : !realAllowed.ok;

  const requestGate = buildChengfangRequestGate({
    config,
    nowFn: now,
    stopRequested,
    businessDate: p.businessDate,
    action: 'enable',
  });

  const result = {
    startedAt: new Date(now()).toISOString(),
    shopId: shopCfg ? shopCfg.id : null,
    mode: dryRun ? 'dry-run' : 'execute',
    scope: ['全店托管', '商品自选'],
    businessDate: p.businessDate !== undefined && p.businessDate !== null ? p.businessDate : shanghaiDate(now()),
    gate: { ok: realAllowed.ok, reason: realAllowed.reason || null },
    identity: null,
    views: {},
    targets: [],           // { view, planId, action: 'enable' }
    selectionNote: null,
    notFoundIds: [],       // 处理中行消失、待全量回读核验
    allEnabledConfirmed: false,
    confirmReason: null,
    dryRunTargets: [],     // 演练：将开启的对象（含动作说明）
    finalVerify: null,
    polling: {},           // 各视图落地确认的**实际生效**轮询配置与结果（页面/日志可展示）
    stoppedAfterDispatch: null, // 点击已派发后收到停止时的真实只读确认结果（不谎报失败/成功）
    // 仅在本次浏览器会话内使用：千川提交后若跳回首页，回到这里恢复读取/重试。
    // 不写入审计日志，也不跨批次复用 Cookie 或浏览器。
    managementUrl: null,
  };
  const fail = (view, status, reason) => {
    result.views[view] = result.views[view] || {};
    result.views[view].status = status;
    result.views[view].reason = reason;
    result.confirmReason = reason;
    audit({ kind: 'chengfang-enable', event: 'abort', view, status, reason });
  };

  // ── 0. 身份核验 ──────────────────────────────────────────────────
  const identity = await controller.verifyIdentity({ page, shopCfg }).catch((e) => ({ ok: false, reason: e.reason || e.message }));
  if (!identity || identity.ok !== true) {
    fail('identity', V_READ_FAILED, `身份核验失败：${(identity && identity.reason) || '未知'}`);
    return result;
  }
  result.identity = identity;
  if (typeof page.url === 'function') {
    const currentUrl = page.url();
    if (typeof currentUrl === 'string' && currentUrl.includes('/uni-prom/overall')) result.managementUrl = currentUrl;
  }
  audit({ kind: 'chengfang-enable', event: 'identity', ok: true, accountId: identity.pageAccountId });

  try {
    // 贴近真正点击的最终检查（与暂停一致的双重保护：核验前 check → 异步身份复核 → 复核后再次 check）
    if (!dryRun && typeof controller.setBeforeDispatch === 'function') {
      controller.setBeforeDispatch(async ({ page: pg }) => {
        const g0 = requestGate();
        if (!g0.ok) throw new DataGuardError(g0.reason);
        const id = await controller.verifyIdentity({ page: pg, shopCfg })
          .catch((e) => ({ ok: false, reason: e.reason || e.message }));
        if (!id || id.ok !== true) {
          throw new DataGuardError(`账户/页面身份变化：${(id && id.reason) || '未知'}（不再发出开启请求）`);
        }
        const g1 = requestGate();
        if (!g1.ok) throw new DataGuardError(g1.reason);
      });
    }

    // ── 1. 全店托管 ──────────────────────────────────────────────
    const tuoguanOk = await enableTuoguan({ controller, page, result, dryRun, requestGate, fail, audit, config, now, stopRequested });
    if (!tuoguanOk) return result;

    // ── 2. 商品自选 ──────────────────────────────────────────────
    const zixuanOk = await enableZixuan({ controller, page, shopCfg, result, dryRun, requestGate, fail, audit, config, now, stopRequested });
    if (!zixuanOk) return result;
    if (dryRun) {
      result.confirmReason = '演练模式：仅记录将执行的动作，未点击任何开关/开启，不得宣称已开启';
      return result;
    }

    // ── 3. 全量回读验证（完整当前范围）──────────────────────────
    const verifyOk = await verifyAllEnabled({ controller, page, result });
    result.allEnabledConfirmed = verifyOk;
    result.confirmReason = verifyOk
      ? `乘方全部已开启：全店托管 ${tuoguanCount(result)} 个目标 + 商品自选 ${zixuanCount(result)} 个目标，完整当前清单回读均确认开启侧`
      : (result.confirmReason || '全量回读未全部确认');
    audit({ kind: 'chengfang-enable', event: 'done', allEnabledConfirmed: verifyOk, confirmReason: result.confirmReason, targets: result.targets.map((t) => t.planId) });
  } catch (e) {
    fail('global', V_PARTIAL_FAILED, `乘方开启流程停止：${e.reason || e.message}`);
  }
  return result;
}

// ── 全店托管开启：读取开关状态；已开启跳过；关闭才开启 ──────────────

async function enableTuoguan({ controller, page, result, dryRun, requestGate, fail, audit, config, now = Date.now, stopRequested = () => false }) {
  await controller.switchView({ page, tab: '全店托管' });
  const view = await readViewFor(controller, page, '全店托管');
  if (!view) {
    fail('tuoguan', V_READ_FAILED, '全店托管视图读取失败（不当作无计划）');
    return false;
  }
  const rows = view.rows || [];
  if (rows.length === 0) {
    const pag = view.pagination || {};
    if (pag.total !== 0) {
      fail('tuoguan', V_READ_FAILED, `全店托管无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不当作无计划`);
      return false;
    }
    result.views.tuoguan = { status: V_CONFIRMED_EMPTY, note: '已确认无计划（成功读取且分页 total=0）' };
    audit({ kind: 'chengfang-enable', event: 'view', view: '全店托管', status: V_CONFIRMED_EMPTY });
    return true;
  }
  const unknown = rows.filter((r) => !r.id || r.switchChecked === null || r.switchChecked === undefined);
  if (unknown.length > 0) {
    fail('tuoguan', V_PARTIAL_FAILED, `全店托管存在 ${unknown.length} 行无法判定开关状态（含无稳定ID），不当作已开启`);
    return false;
  }
  const closed = rows.filter((r) => r.switchChecked === false);
  const open = rows.filter((r) => r.switchChecked === true);
  if (closed.length === 0) {
    result.views.tuoguan = { status: V_ALREADY_ENABLED, note: `全部 ${rows.length} 条已开启，幂等跳过`, openCount: open.length };
    audit({ kind: 'chengfang-enable', event: 'view', view: '全店托管', status: V_ALREADY_ENABLED, open: open.map((r) => r.id) });
    return true;
  }
  for (const r of closed) {
    result.targets.push({ view: '全店托管', planId: r.id, action: 'enable' });
    result.dryRunTargets.push({ view: '全店托管', planId: r.id, action: 'enable（点击行内开关）' });
  }
  if (dryRun) {
    result.views.tuoguan = { status: V_ENABLED, dryRun: true, note: `演练：将开启 ${closed.length} 个关闭中的托管计划`, closedIds: closed.map((r) => r.id) };
    audit({ kind: 'chengfang-enable', event: 'plan', view: '全店托管', mode: 'dry-run', targets: closed.map((r) => r.id) });
    return true;
  }
  for (const r of closed) {
    const g = requestGate();
    if (!g.ok) { fail('tuoguan', V_PARTIAL_FAILED, `停止发出托管开启请求：${g.reason}`); return false; }
    let danger;
    try {
      danger = await controller.detectDanger({ page, expectedAction: 'shop_enable' });
    } catch (e) {
      fail('tuoguan', V_PARTIAL_FAILED, `弹窗检测失败，停止点击行内开关：${e.reason || e.message}`);
      return false;
    }
    if (danger.length > 0) {
      fail('tuoguan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击行内开关：${danger.map((d) => d.kind).join(',')}`);
      return false;
    }
    let clickError = null;
    try {
      // 托管开启弹窗结构未实测：若出现确认弹窗且无法精确匹配，控制器内部阻断（不盲点确定）
      await controller.clickRowSwitch({ page, planId: r.id, expectAction: 'shop_enable' });
    } catch (e) {
      clickError = e;
    }
    if (clickError instanceof DataGuardError) {
      fail('tuoguan', V_PARTIAL_FAILED, `托管开关未点击（零点击）：${clickError.reason || clickError.message}`);
      return false;
    }
    // 落地确认（有界轮询）：点击异常（非定位类）也可能已执行 → 一律以回读为准。
    // 托管开关是**切换**动作：超时/状态未知一律只回读，绝不重复点击（避免反向暂停）。
    const landing = await confirmLanding({
      controller, page, view: '全店托管', targetIds: [r.id], wantChecked: true,
      config, stopRequested, audit, eventKind: 'chengfang-enable',
    });
    result.polling['全店托管'] = pollingSummary(landing.polling, landing.poll, { targetCount: 1 });
    if (!landing.rows) {
      fail('tuoguan', V_PARTIAL_FAILED, `托管计划 ${r.id} 开关${clickError ? '点击可能已执行，' : ''}回读失败：结果未知${clickError ? '，禁止重复切换' : ''}`);
      return false;
    }
    const row = landing.rows.find((x) => x.id === r.id);
    if (!row) {
      fail('tuoguan', V_PARTIAL_FAILED, `托管计划 ${r.id} 开启后行消失，无法确认（不当作已开启）`);
      return false;
    }
    if (row.switchChecked !== true) {
      fail('tuoguan', V_PARTIAL_FAILED, clickError
        ? `托管计划 ${r.id} 开关点击结果未知且回读仍关闭：禁止重复切换（避免反向暂停），需人工确认，停止`
        : `托管计划 ${r.id} 开关回读仍为关闭`);
      return false;
    }
    audit({ kind: 'chengfang-enable', event: 'enabled', view: '全店托管', planId: r.id, confirmed: true, note: clickError ? '点击结果曾未知，回读确认已开启' : undefined });
    if (landing.poll.stopped) {
      result.stoppedAfterDispatch = {
        view: '全店托管', action: 'enable', planId: r.id, wantChecked: true, gotChecked: row.switchChecked,
        note: '落地确认期间收到停止：已派发请求仅完成只读确认，不再发出新请求',
      };
      fail('tuoguan', V_PARTIAL_FAILED, `落地确认期间收到停止信号：托管计划 ${r.id} 已按真实回读确认（开启侧），不再重试、不再发出任何新请求`);
      return false;
    }
  }
  result.views.tuoguan = { status: V_ENABLED, confirmedCount: closed.length, note: `已确认开启 ${closed.length} 个关闭中的托管计划` };
  return true;
}

// ── 商品自选开启：100条/页 → 全选（实测范围）→ 批量开启 → 稳定ID去重翻页 ──

async function enableZixuan({ controller, page, shopCfg, result, dryRun, requestGate, fail, audit, config, now = Date.now, stopRequested = () => false }) {
  await controller.switchView({ page, tab: '商品自选' });
  const firstView = await readViewFor(controller, page, '商品自选');
  if (!firstView) {
    fail('zixuan', V_READ_FAILED, '商品自选视图读取失败（不当作无计划）');
    return false;
  }
  const ps = firstView.pagination && firstView.pagination.pageSize;
  if (!ps || !String(ps).includes('100')) {
    await controller.switchPageSize({ page, size: '100条/页' });
  }
  const view0 = await readViewFor(controller, page, '商品自选');
  if (!view0) {
    fail('zixuan', V_READ_FAILED, '切换100条/页后商品自选视图读取失败');
    return false;
  }
  if (view0.rows.length === 0) {
    const pag = view0.pagination || {};
    if (pag.total !== 0) {
      fail('zixuan', V_READ_FAILED, `商品自选无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不当作无计划`);
      return false;
    }
    result.views.zixuan = { status: V_CONFIRMED_EMPTY, note: '已确认无计划（成功读取且分页 total=0）' };
    audit({ kind: 'chengfang-enable', event: 'view', view: '商品自选', status: V_CONFIRMED_EMPTY });
    return true;
  }

  const processed = new Set(); // 已确认开启的稳定 ID
  const drySeen = new Set();   // 演练已记录的目标（防止跨页重复记录）
  let pageVisits = 0;
  result.views.zixuan = { total: view0.pagination && view0.pagination.total, pageSize: view0.pagination && view0.pagination.pageSize, processedCount: 0 };

  while (true) {
    const view = await readViewFor(controller, page, '商品自选');
    if (!view) {
      fail('zixuan', V_PARTIAL_FAILED, '商品自选强制新扫描失败');
      return false;
    }
    let dangerBefore;
    try {
      dangerBefore = await controller.detectDanger({ page });
    } catch (e) {
      fail('zixuan', V_PARTIAL_FAILED, `弹窗检测失败，停止后续点击：${e.reason || e.message}`);
      return false;
    }
    if (dangerBefore.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击：${dangerBefore.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      return false;
    }
    const rows = view.rows || [];
    const targets = rows.filter((r) => r.id && r.switchChecked === false && !processed.has(r.id) && (dryRun ? !drySeen.has(r.id) : true));
    result.views.zixuan.currentPageTargets = targets.map((r) => r.id);

    if (targets.length === 0) {
      const pag = view.pagination || {};
      if (!pag.hasNext) break;
      const next = await controller.clickNextPage({ page });
      pageVisits += 1;
      if (pageVisits > MAX_PAGE_VISITS) {
        fail('zixuan', V_PARTIAL_FAILED, `翻页超过 ${MAX_PAGE_VISITS} 次仍未收敛，停止`);
        return false;
      }
      if (!next || next.clicked !== true) {
        if (next && next.atEnd) break;
        fail('zixuan', V_PARTIAL_FAILED, `翻页失败：${(next && next.reason) || '未知'}（停止，防止页码位移漏处理）`);
        return false;
      }
      continue;
    }

    const pageOk = await enablePageTargets({ controller, page, shopCfg, targets, rows, result, dryRun, processed, drySeen, requestGate, fail, audit, config, now, stopRequested });
    if (!pageOk) return false;
  }

  if (dryRun) {
    result.views.zixuan.dryRun = true;
    result.views.zixuan.status = V_ENABLED;
    result.views.zixuan.dryRunCount = drySeen.size;
    result.views.zixuan.note = `演练：共枚举 ${drySeen.size} 个商品自选关闭目标（100条/页翻页），将执行 全选→批量开启（未点击）`;
    return true;
  }

  result.views.zixuan.status = V_ENABLED;
  result.views.zixuan.processedCount = processed.size;
  result.views.zixuan.note = `已确认开启 ${processed.size} 个商品自选计划（100条/页，稳定ID去重）`;
  return true;
}

/**
 * 单页开启处理：全选 → 实测选择范围（跨页则清除并改按当前页目标勾选）→ 精确校正 →
 * 请求级门槛 → 危险检测 → 开启 → 强制新扫描回读。
 * 目标 = 当前关闭侧计划（switchChecked===false）；已开启行精确取消勾选。
 * 返回 true 继续；false 表示已 fail（调用方停止）。
 */
async function enablePageTargets({ controller, page, shopCfg, targets, rows, result, dryRun, processed, drySeen, requestGate, fail, audit, retryAttempt = 0, config, now = Date.now, stopRequested = () => false }) {
  const targetIds = targets.map((t) => t.id);
  for (const id of targetIds) {
    if (retryAttempt === 0) {
      result.targets.push({ view: '商品自选', planId: id, action: 'enable' });
      result.dryRunTargets.push({ view: '商品自选', planId: id, action: 'enable（批量开启）' });
    }
    if (drySeen) drySeen.add(id);
  }
  audit({ kind: 'chengfang-enable', event: 'plan', view: '商品自选', targets: targetIds, mode: dryRun ? 'dry-run' : 'execute' });
  if (dryRun) return true;

  // 请求级门槛（勾选前）：停止/时段/跨日/配置门槛
  const g0 = requestGate();
  if (!g0.ok) { fail('zixuan', V_PARTIAL_FAILED, `停止发出商品自选开启请求：${g0.reason}`); return false; }

  await controller.selectAllInPage({ page });
  const sel = await controller.readSelection({ page }).catch(() => ({ selectedIds: [], selectedCount: 0 }));
  let finalSel = sel.selectedIds || [];
  const targetSet = new Set(targetIds);
  const allRowIds = rows.filter((r) => r.id).map((r) => r.id);
  const allRowSet = new Set(allRowIds);

  const bar0 = await controller.readBatchBar({ page }).catch(() => null);
  const domCount = finalSel.length;
  const barCount = (bar0 && bar0.selectedCount !== null && bar0.selectedCount !== undefined) ? bar0.selectedCount : null;
  const crossPage = finalSel.some((id) => !allRowSet.has(id)) || (barCount !== null && barCount > domCount);

  if (crossPage) {
    const toClear = [...new Set(finalSel)];
    for (const id of toClear) {
      const cr = await controller.setRowCheckbox({ page, planId: id, checked: false }).catch((e) => ({ error: String(e) }));
      if (cr && cr.error) {
        fail('zixuan', V_PARTIAL_FAILED, `清除跨页选择失败（${id}）：${cr.error}`);
        return false;
      }
    }
    const selAfterClear = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
    if (selAfterClear.selectedIds.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `跨页选择清除失败：仍有 ${selAfterClear.selectedIds.length} 个可见行选中，选择范围不可确认，停止`);
      return false;
    }
    const barAfterClear = await controller.readBatchBar({ page }).catch(() => null);
    const afterClearCount = (barAfterClear && barAfterClear.selectedCount !== null && barAfterClear.selectedCount !== undefined) ? barAfterClear.selectedCount : 0;
    if (afterClearCount > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `清除跨页选择后批量栏仍显示已选 ${afterClearCount} 个（不可见跨页行残留），完整范围无法确认，停止`);
      return false;
    }
    for (const id of targetIds) {
      const sr = await controller.setRowCheckbox({ page, planId: id, checked: true }).catch((e) => ({ error: String(e) }));
      if (sr && sr.error) {
        fail('zixuan', V_PARTIAL_FAILED, `按目标勾选 ${id} 失败：${sr.error}`);
        return false;
      }
    }
    const sel2 = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
    finalSel = sel2.selectedIds || [];
    const missing = targetIds.filter((id) => !finalSel.includes(id));
    const stillExtra = finalSel.filter((id) => !targetSet.has(id));
    const bar2 = await controller.readBatchBar({ page }).catch(() => null);
    const bar2Count = (bar2 && bar2.selectedCount !== null && bar2.selectedCount !== undefined) ? bar2.selectedCount : null;
    if (missing.length > 0 || stillExtra.length > 0 || (bar2Count !== null && bar2Count !== targetIds.length)) {
      fail('zixuan', V_PARTIAL_FAILED, `跨页选择清除后按目标重选仍未收敛（缺失 ${missing.length}、多余 ${stillExtra.length}、批量栏已选 ${bar2Count}），选择范围不可确认，停止`);
      return false;
    }
    result.selectionNote = `表头全选实测为跨页：已清除跨页选择，改为按当前页已核验目标勾选（${targetIds.length} 行，批量栏已选 ${bar2Count}）`;
    audit({ kind: 'chengfang-enable', event: 'selection', view: '商品自选', scope: 'cross-page-cleared', count: targetIds.length });
  } else {
    const extra = finalSel.filter((id) => !targetSet.has(id));
    if (extra.length > 0) {
      for (const id of extra) {
        const cr = await controller.setRowCheckbox({ page, planId: id, checked: false }).catch((e) => ({ error: String(e) }));
        if (cr && cr.error) {
          fail('zixuan', V_PARTIAL_FAILED, `取消勾选 ${id} 失败：${cr.error}`);
          return false;
        }
      }
      const sel2 = await controller.readSelection({ page }).catch(() => ({ selectedIds: [] }));
      finalSel = sel2.selectedIds || [];
    }
    const stillExtra = finalSel.filter((id) => !targetSet.has(id));
    const missing = targetIds.filter((id) => !finalSel.includes(id));
    if (stillExtra.length > 0 || missing.length > 0) {
      fail('zixuan', V_PARTIAL_FAILED, `精确选择后仍未收敛：多余 ${stillExtra.length}、缺失 ${missing.length}，停止（全选范围不可确认）`);
      return false;
    }
    const bar = await controller.readBatchBar({ page }).catch(() => null);
    const barN = (bar && bar.selectedCount !== null && bar.selectedCount !== undefined) ? bar.selectedCount : null;
    if (barN !== null && barN !== finalSel.length) {
      fail('zixuan', V_PARTIAL_FAILED, `批量栏"已选${barN}个"与实际选中 ${finalSel.length} 个不一致，停止`);
      return false;
    }
    result.selectionNote = `全选框实测为当前页全选，共 ${finalSel.length} 行（批量栏已选 ${barN}）`;
  }

  // 点击前：请求级门槛（选择完成后停止 → 不发新开启请求）
  const g = requestGate();
  if (!g.ok) { fail('zixuan', V_PARTIAL_FAILED, `停止发出批量开启请求：${g.reason}`); return false; }
  let danger;
  try {
    danger = await controller.detectDanger({ page });
  } catch (e) {
    fail('zixuan', V_PARTIAL_FAILED, `弹窗检测失败，停止点击批量"开启"：${e.reason || e.message}`);
    return false;
  }
  if (danger.length > 0) {
    fail('zixuan', V_PARTIAL_FAILED, `检测到非预期弹窗，停止点击：${danger.map((d) => `${d.kind}:${d.text}`).join('；')}`);
    return false;
  }

  let clickError = null;
  try {
    await controller.clickBatchEnable({ page, expectedCount: targetIds.length });
  } catch (e) {
    clickError = e;
  }
  if (clickError instanceof DataGuardError) {
    fail('zixuan', V_PARTIAL_FAILED, `批量开启未发出（零点击）：${clickError.reason || clickError.message}`);
    return false;
  }

  // 操作后强制新扫描回读（绝不复用操作前缓存；点击异常也可能已发出请求 → 以回读为准）
  // 千川有时在确认后跳回首页。仅在本次 page/browser/context 内回到已记录的管理页；
  // 不重开浏览器、不重新加载 Cookie。恢复失败即结果未知，绝不把空页当作已开启。
  const recovered = await restoreManagementPageForReadback({ controller, page, shopCfg, managementUrl: result.managementUrl });
  if (!recovered.ok) {
    fail('zixuan', V_PARTIAL_FAILED, `批量开启后无法恢复乘方管理页回读：${recovered.reason}`);
    return false;
  }
  // 落地等待轮询（2026-09-16 修复生产首次开启失败根因，2026-09-16 第二轮统一为有界截止时间）：
  // 平台异步落地可能延迟数秒到数十秒（实测 27 秒后仍未落地、稍后全部生效）。
  // 旧代码单次立即回读 → 误判 partial_failed；次数轮询 → 未计入读取耗时，总等待不可控。
  // 现按**实际截止时间**有界轮询（串行读取、不重叠），生效值来自
  // execution.readbackTimeoutMs / readbackIntervalMs（唯一来源，见 src/lib/bounded-poll.js）。
  // 停止信号到达 → 不再重试、不再发新请求，但已派发请求继续在有限期限内只读确认。
  const landing = await confirmLanding({
    controller, page, view: '商品自选', targetIds, wantChecked: true,
    config, stopRequested, audit, eventKind: 'chengfang-enable',
  });
  result.polling['商品自选'] = pollingSummary(landing.polling, landing.poll, { targetCount: targetIds.length });
  if (!landing.rows) {
    fail('zixuan', V_PARTIAL_FAILED, `批量开启请求${clickError ? '可能已发出但' : ''}落地轮询回读失败：结果未知，停止`);
    return false;
  }
  const postRows = landing.rows;
  const failed = landing.failed;
  const notFound = landing.notFound;
  for (const id of landing.confirmed) processed.add(id);
  for (const id of notFound) {
    if (!result.notFoundIds.includes(id)) result.notFoundIds.push(id);
  }
  if (landing.poll.stopped) {
    // 停止信号：已派发请求仅完成只读确认；绝不重试、绝不发出新业务请求。
    result.stoppedAfterDispatch = {
      view: '商品自选', action: 'enable', confirmed: landing.confirmed, failed, notFound,
      note: '落地确认期间收到停止：已派发请求仅完成只读确认，未重试、未发出新请求',
    };
    fail('zixuan', V_PARTIAL_FAILED,
      `落地确认期间收到停止信号：已派发批量开启仅完成只读确认（${landing.confirmed.length}/${targetIds.length} 个已确认开启），不再重试、不再发出任何新请求`);
    return false;
  }
  if (failed.length > 0) {
    // 千川实机限制：首次提交有时确认成功却未落地。保持同一页面/同一浏览器会话，
    // 按**实际仍未落地**的目标（含部分成功场景）重新选择并仅重试一次；
    // 不关闭浏览器、不重新读取 Cookie、不反向切换、不扩范围。
    // 2026-09-15 修复（交接第 6 项）：原实现仅在"全部失败"时重试，部分成功/未知状态一律直接失败。
    // 2026-09-16 修复（本轮第 4 项）：重试前必须**重新核验真实状态、身份、停止与时间门槛**。
    if (retryAttempt === 0 && failed.length <= targetIds.length) {
      // 2026-09-16 第二轮：最新状态不可信时不得据旧快照重发（与暂停侧同一原则）。
      const trust = landingStateTrustworthy(landing.poll);
      if (!trust.trustworthy) {
        fail('zixuan', V_PARTIAL_FAILED,
          `${trust.reason}：不据旧快照重发（已确认 ${landing.confirmed.length}/${targetIds.length} 个开启）`);
        return false;
      }
      if (notFound.length > 0) {
        fail('zixuan', V_PARTIAL_FAILED,
          `开启回读存在 ${notFound.length} 个目标行消失（状态未知），不盲目重发；失败目标 ${failed.length} 个：${failed.slice(0, 5).join(',')}`);
        return false;
      }
      const retryPlan = await prepareRetry({
        controller, page, shopCfg, failed, wantChecked: true, requestGate, fail, audit, result, eventKind: 'chengfang-enable',
      });
      if (!retryPlan.ok) return false;
      if (retryPlan.landed.length > 0) {
        for (const id of retryPlan.landed) processed.add(id);
        audit({
          kind: 'chengfang-enable', event: 'retry-skipped', view: '商品自选',
          note: `重试前重新核验：${retryPlan.landed.length} 个目标已落地（回读确认开启），不再重发`,
          targets: retryPlan.landed,
        });
      }
      if (retryPlan.stillPending.length === 0) return true;
      const retryTargets = targets.filter((t) => retryPlan.stillPending.includes(t.id));
      audit({
        kind: 'chengfang-enable', event: 'retry', view: '商品自选', attempt: 2,
        targets: retryTargets.map((t) => t.id),
        note: `首次开启回读仍有 ${failed.length}/${targetIds.length} 个未落地，仅对未落地目标同会话重试一次（已重新核验状态/身份/停止/时段，不反向切换、不扩范围）`,
      });
      return enablePageTargets({
        controller, page, shopCfg, targets: retryTargets, rows: postRows, result, dryRun,
        processed, drySeen, requestGate, fail, audit, retryAttempt: 1, config, now, stopRequested,
      });
    }
    fail('zixuan', V_PARTIAL_FAILED, `开启未生效（开关仍关闭）：${failed.slice(0, 5).join(',')}...${failed.length > 5 ? `（共 ${failed.length} 个）` : ''}${clickError ? `（点击结果曾未知，以回读为准：${clickError.reason || clickError.message}）` : ''}`);
    return false;
  }
  if (notFound.length > 0) {
    audit({ kind: 'chengfang-enable', event: 'enabled', view: '商品自选', confirmed: targetIds.filter((id) => processed.has(id)), missing: notFound, note: '行消失未当作已开启，待全量回读核验' });
  } else {
    audit({ kind: 'chengfang-enable', event: 'enabled', view: '商品自选', confirmed: targetIds });
  }
  return true;
}

/**
 * 开启全量回读：重新扫描两区域完整当前清单（第一页起、逐页核验总数与页码、稳定ID），
 * 确认所有当前对象均处于开启侧。仍有关闭侧对象（含新增/被暂停）/目标失踪/状态未知/
 * 分页不完整 → 不报告全部开启。对象键 = 区域 + 稳定ID。
 */
async function verifyAllEnabled({ controller, page, result }) {
  const targetKeys = new Set(result.targets.map((t) => `${t.view}:${t.planId}`));
  const scope = ['全店托管', '商品自选'];
  const found = new Map(); // `${region}:${planId}` -> switchChecked
  let scanError = null;

  for (const region of scope) {
    await controller.switchView({ page, tab: region });
    const first = await readViewFor(controller, page, region);
    if (!first) {
      scanError = `全量回读：${region} 视图读取失败`;
      break;
    }
    if (region === '商品自选' && first.pagination && first.pagination.pageSize && !String(first.pagination.pageSize).includes('100')) {
      await controller.switchPageSize({ page, size: '100条/页' });
    }
    await controller.ensureFirstPage({ page }).catch(() => {});

    let regionTotal = null;
    let regionSeen = 0;
    let pageNo = 0;
    let visits = 0;
    while (true) {
      const view = await readViewFor(controller, page, region);
      if (!view) {
        scanError = `全量回读：${region} 第 ${pageNo + 1} 页强制新扫描失败`;
        break;
      }
      const pag = view.pagination || {};
      if (view.rows.length === 0) {
        if (pag.total !== 0) {
          scanError = `全量回读：${region} 无行但缺少数量的空态证据（分页 total=${pag.total ?? '缺失'}），不能当作空清单`;
        }
        break;
      }
      if (regionTotal === null) {
        regionTotal = pag.total;
        if (regionTotal === null || regionTotal === undefined) {
          scanError = `全量回读：${region} 缺失分页总数，清单完整性不可确认`;
          break;
        }
      } else if (pag.total !== regionTotal) {
        scanError = `全量回读：${region} 分页总数在扫描中变化（${regionTotal} → ${pag.total}），清单不可信`;
        break;
      }
      pageNo += 1;
      let okRows = true;
      for (const r of view.rows || []) {
        const key = `${region}:${r.id}`;
        if (!r.id) { scanError = `全量回读：${region} 存在无稳定ID的行，无法确认其状态`; okRows = false; break; }
        if (r.switchChecked === null || r.switchChecked === undefined) {
          scanError = `全量回读：${region} 计划 ${r.id} 开关状态未知，不当作已开启`;
          okRows = false; break;
        }
        if (found.has(key)) { scanError = `全量回读：${region} 计划 ${r.id} 重复出现，清单不可信`; okRows = false; break; }
        found.set(key, r.switchChecked);
      }
      if (!okRows) break;
      regionSeen += view.rows.length;
      if (!pag.hasNext) break;
      const next = await controller.clickNextPage({ page });
      visits += 1;
      if (visits > MAX_PAGE_VISITS) {
        scanError = `全量回读：${region} 翻页超过 ${MAX_PAGE_VISITS} 次未收敛，清单不完整`;
        break;
      }
      if (!next || next.clicked !== true) {
        scanError = `全量回读：${region} 翻页失败：${(next && next.reason) || '未知'}，清单不完整`;
        break;
      }
    }
    if (scanError) break;
    if (regionTotal !== null && regionTotal !== regionSeen) {
      scanError = `全量回读：${region} 分页总数 ${regionTotal} 与实际读取 ${regionSeen} 不一致，清单不完整`;
      break;
    }
  }

  if (scanError) {
    result.confirmReason = scanError;
    result.finalVerify = { regionKeys: found.size, targets: targetKeys.size, confirmed: [], stillClosed: [], missing: [], unknown: [], scanError };
    return false;
  }

  const confirmed = [];
  const stillClosed = [];
  const unknown = [];
  for (const [key, checked] of found) {
    if (checked === false) stillClosed.push(key);
    else confirmed.push(key);
  }
  const missing = [];
  for (const key of targetKeys) if (!found.has(key)) missing.push(key);

  result.finalVerify = { regionKeys: found.size, targets: targetKeys.size, confirmed, stillClosed, missing, unknown };

  if (stillClosed.length > 0) {
    result.confirmReason = `全量回读：仍有 ${stillClosed.length} 个当前对象处于关闭侧（含新增/被暂停投放）：${stillClosed.slice(0, 5).join(',')}...`;
    return false;
  }
  if (missing.length > 0) {
    result.confirmReason = `全量回读：找不到 ${missing.length} 个目标（不当作已开启）：${missing.slice(0, 5).join(',')}...`;
    return false;
  }
  const tuoguanTargetIds = new Set(result.targets.filter((t) => t.view === '全店托管').map((t) => t.planId));
  const zixuanTargetIds = new Set(result.targets.filter((t) => t.view === '商品自选').map((t) => t.planId));
  result.views.tuoguan.confirmedCount = [...tuoguanTargetIds].filter((id) => found.get(`全店托管:${id}`) === true).length;
  result.views.zixuan.confirmedCount = [...zixuanTargetIds].filter((id) => found.get(`商品自选:${id}`) === true).length;
  return true;
}

module.exports = {
  executeChengfangPause,
  executeChengfangEnable,
  MAX_PAGE_VISITS,
  V_READ_FAILED,
  V_CONFIRMED_EMPTY,
  V_ALREADY_PAUSED,
  V_PAUSED,
  V_ALREADY_ENABLED,
  V_ENABLED,
  V_PARTIAL_FAILED,
};
