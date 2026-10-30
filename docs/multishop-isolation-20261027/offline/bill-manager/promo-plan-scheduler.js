'use strict';

/**
 * 推广值守后台自动发布排程（客户 2026-10-11）。
 *
 * 目标：把"每天北京时间某时刻、每店 N 份免审核计划、持续授权自动初次/最终确认"固化到
 * 推广值守后台代码里，页面只调整时间与参数；不依赖任何网页保持打开、不依赖 Codex 定时任务、
 * 不依赖模型运行、不依赖人为 POST。
 *
 * 设计约束（与主脑合同一致）：
 * - 默认**未配置不发布**：只有显式 enabled:true 且 autoConfirm:true 才在到点时派发；
 * - 时刻按 Asia/Shanghai 固定（明确标签），时区不做本地推断；
 * - 每店每天成功份数 <= plans（1..3），**只有成功才推进**；未知/失败不推进、不重放；
 * - 单店异常继续其他店；跨日立即停止未发布清单，绝不用旧 hash 配新身份；
 * - 配置/执行账本原子持久；账本只有成功计数/状态/时间/错误摘要，**绝不含 Cookie 值**；
 * - 页面刷新/多标签/关页不触发发布；boot 幂等；stop/停用只停止未来派发，不强杀不确定的在途；
 * - 真实发布能力由注入的 runPlan(business, opts) 提供（正式 publisher 入口），本模块只做
 *   日期时刻判断、配置校验、账本与并发去重，绝不 stub/throw TODO 假冒入口。
 *
 * 全部外部依赖（时间、文件系统根、发布执行器、店铺列表读取）均可注入，便于离线用假 clock +
 * 临时目录证明时区/跨日/重启去重/并发/单店失败继续/非法参数零派发等行为。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PLAN_PUBLISHING = Object.freeze({
  enabled: false,        // 默认关闭：不配置就不自作主张真实发布
  autoConfirm: false,    // 持续授权自动初次/最终确认；默认关闭
  time: '08:00',         // Asia/Shanghai 固定
  plansPerShopPerDay: 3, // 1..3
  dailyBudget: 300,      // 每份预算，默认 300；仅走 trusted business，不在此覆盖
  timezone: 'Asia/Shanghai',
});

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// 每店可覆盖每日计划数量的合法上界（全局 planPublishing.plansPerShopPerDay 仍限 1..3，
// 缺省 3；每店 shops[].plansPerShopPerDay 允许 1..10）。两店相互独立，互不影响。
const MAX_PER_SHOP_OVERRIDE = 10;

/**
 * 某店本日**有效**每日份数上限：优先该店已保存且合法的 plansPerShopPerDay（整数 1..10），
 * 否则回落全局 cfg.plansPerShopPerDay（已由 validatePlanPublishing 归一到 1..3）。
 * 非法/缺失一律回落全局默认，绝不静默抬高。
 */
function resolveShopPlansPerDay(shop, cfgPlans) {
  const global = Number.isInteger(cfgPlans) && cfgPlans >= 1 ? cfgPlans : DEFAULT_PLAN_PUBLISHING.plansPerShopPerDay;
  if (shop && Object.prototype.hasOwnProperty.call(shop, 'plansPerShopPerDay')) {
    const n = shop.plansPerShopPerDay;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PER_SHOP_OVERRIDE) return n;
  }
  return global;
}

/** 解析 "HH:mm" → 当天分钟数；非法返回 null。 */
function parseHm(hm) {
  const m = HM_RE.exec(String(hm == null ? '' : hm).trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 严格校验 planPublishing 配置。永远返回一个可直接使用的规范化对象：
 * - 缺字段用默认；非法值不静默修补成"可发布"（enabled/autoConfirm 回落 false），
 *   并在 reasons 中给出原因，供页面显示与"非法参数零派发"。
 * 返回 { value, ok, reasons }。
 */
function validatePlanPublishing(raw) {
  const reasons = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = { ...DEFAULT_PLAN_PUBLISHING };

  value.enabled = src.enabled === true;
  value.autoConfirm = src.autoConfirm === true;
  if (src.enabled !== undefined && typeof src.enabled !== 'boolean') reasons.push('enabled 必须是布尔值');
  if (src.autoConfirm !== undefined && typeof src.autoConfirm !== 'boolean') reasons.push('autoConfirm 必须是布尔值');

  if (src.time !== undefined) {
    const mins = parseHm(src.time);
    if (mins == null) reasons.push('time 必须是 00:00–23:59 的 HH:mm');
    else value.time = String(src.time).trim();
  }
  if (src.timezone !== undefined && src.timezone !== 'Asia/Shanghai') reasons.push('timezone 仅支持 Asia/Shanghai');

  if (src.plansPerShopPerDay !== undefined) {
    const n = src.plansPerShopPerDay;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3) reasons.push('plansPerShopPerDay 必须是 1..3 的整数');
    else value.plansPerShopPerDay = n;
  }
  if (src.dailyBudget !== undefined) {
    const b = src.dailyBudget;
    if (typeof b !== 'number' || !Number.isFinite(b) || !(b > 0)) reasons.push('dailyBudget 必须是正有限数字');
    else value.dailyBudget = b;
  }
  return { value, ok: reasons.length === 0, reasons };
}

// ── Asia/Shanghai 时刻（固定 UTC+8，无夏令时）──────────────────────────────
function shanghaiParts(nowMs) {
  const d = new Date(nowMs);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (p.find((x) => x.type === t) || {}).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // en-CA + hour12:false 在 24:00 边界可能返回 '24'；归一到 0。
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { date, minutes: hour * 60 + minute, hhmm: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') };
}

// S129: Windows 上 renameSync 覆盖被短暂占用（杀毒/索引/另一读取句柄）时可能抛
// EPERM/EBUSY。仅对这两个**可重试**代码做有界同步短退避，仍然把同一 temp rename 到同一
// dest（绝不以 unlink/非原子覆盖兜底，绝不吞错）。整个等待预算 < 1s，正常路径零等待；
// EACCES 等永久错误立即抛出。失败时只清理自己创建的 temp，且清理失败不掩盖原错误，
// 旧目标字节原样保留。
const RENAME_TRANSIENT_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [50, 150, 300]; // 3 次重试，累计 500ms

function syncSleepMs(ms) {
  if (!(ms > 0)) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { /* 环境不支持 Atomics.wait 时不等待，仍有界重试 */ }
}

function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  let lastErr = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!e || !RENAME_TRANSIENT_CODES.has(e.code) || attempt === RENAME_RETRY_DELAYS_MS.length) break;
      syncSleepMs(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
  try { fs.unlinkSync(tmp); } catch (_) { /* 绝不掩盖原始 rename 错误 */ }
  throw lastErr;
}

function emptyLedger() {
  return { version: 1, days: {} };
}

function loadLedger(file) {
  try {
    if (!fs.existsSync(file)) return emptyLedger();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.days !== 'object') return emptyLedger();
    return parsed;
  } catch (_) {
    // 账本损坏：fail-closed——不重放，按空账本但标记冲突，调用方停止当天派发。
    return { version: 1, days: {}, corrupt: true };
  }
}

function saveLedger(file, ledger) {
  atomicWriteJson(file, ledger);
}

function dayRecord(ledger, date) {
  if (!ledger.days[date]) ledger.days[date] = { shops: {} };
  if (!ledger.days[date].shops) ledger.days[date].shops = {};
  return ledger.days[date];
}

function shopDay(ledger, date, shopId) {
  const rec = dayRecord(ledger, date);
  if (!rec.shops[shopId]) rec.shops[shopId] = { status: 'pending', plans: 0, lastAt: null, error: null, entries: {} };
  if (!rec.shops[shopId].entries || typeof rec.shops[shopId].entries !== 'object') rec.shops[shopId].entries = {};
  return rec.shops[shopId];
}

/** 统计某店某日**已确认成功**的计划数（entries 中 status==='success'，按 planNumber 去重）。
 *  与 rec.plans 计数解耦：entries 是唯一真相，重启后据此防止裸重发。 */
function countSuccessEntries(rec) {
  const seen = new Set();
  const entries = (rec && rec.entries) || {};
  for (const key of Object.keys(entries)) {
    const e = entries[key];
    if (e && e.status === 'success') seen.add(String(e.planNumber != null ? e.planNumber : key));
  }
  return seen.size;
}

/** 某店某日是否存在**未决（in-progress）**记录——崩溃/重启后据此判定 unknown，绝不裸重发。 */
function hasInProgress(rec) {
  const entries = (rec && rec.entries) || {};
  for (const key of Object.keys(entries)) if (entries[key] && entries[key].status === 'in-progress') return true;
  return false;
}

/**
 * S129 陈旧准备状态收敛判据：**只**凭本店本日账本 entries 的完整成功证据返回 true。
 * 要求 entries 恰好覆盖 1..shopLimit 每一份，每份 status==='success'、planNumber 唯一且
 * 合法、planId 存在且唯一；任何 unknown/in-progress/failed/其它状态、缺失份号、重复
 * planNumber/planId、条目数不符一律 false。本函数不改写任何东西，也绝不读取 rec.plans
 * 或外部成功计数作为证据——因此无法把未决/失败/假计数收敛成成功。
 */
function hasCompleteSuccessEntries(rec, shopLimit) {
  if (!rec || !Number.isInteger(shopLimit) || shopLimit < 1) return false;
  const entries = rec.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
  const keys = Object.keys(entries);
  if (keys.length !== shopLimit) return false;
  const planNumbers = new Set();
  const planIds = new Set();
  for (const key of keys) {
    const e = entries[key];
    if (!e || e.status !== 'success') return false;
    if (!Number.isInteger(e.planNumber) || e.planNumber < 1 || e.planNumber > shopLimit) return false;
    if (planNumbers.has(e.planNumber)) return false;
    planNumbers.add(e.planNumber);
    if (e.planId == null || String(e.planId).trim() === '') return false;
    const planId = String(e.planId);
    if (planIds.has(planId)) return false;
    planIds.add(planId);
  }
  return planNumbers.size === shopLimit;
}

/**
 * 严格"从未发布"证明的结构判据（仅结构校验，事实由 publisher 侧新鲜回读产生）。
 * 只接受**预导航打开失败**这一确证零消费形状：run 从未取得任何活动页（opened:false），
 * 且对当日 day-state 与 attempts store 的新鲜回读都证明无任何发布/消费记录。缺任一字段、
 * 值不符、或任一证明位为假一律不算证明——绝不凭错误文本（如 ERR_CONNECTION_CLOSED）放行，
 * 绝不对任意 failed 自动重试。
 */
function strictNoPublicationProof(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && p.method === 'pre-navigation-open-failed'
    && /^\d{4}-\d{2}-\d{2}$/.test(String(p.businessDate || ''))
    && p.opened === false
    && p.stateProven === true
    && p.attemptsProven === true;
}

/**
 * S47 run-binding guard: a proof that only satisfies strictNoPublicationProof is still just a
 * generic (method/date/boolean) shape — it could have come from ANOTHER shop/date/plan/account/run.
 * A SAFE auto-retry is allowed ONLY when the proof is bound to the CURRENT dispatch context and
 * every bound field matches: businessDate, shop, accountId, planNumber and runId must all be
 * present and equal to the values the scheduler is about to retry, and sourceHash must be a real
 * 64-hex content hash. Missing / null / stale / foreign / account-mismatch / plan-mismatch /
 * run-mismatch → NOT bound → the caller must fall through to unknown (no replay). This never
 * weakens the structural guard above; it only adds the exact-context comparison it lacked.
 */
function publicationProofBindsRun(p, ctx) {
  if (!strictNoPublicationProof(p) || !ctx) return false;
  if (!/^[0-9a-f]{64}$/.test(String(p.sourceHash || ''))) return false;
  if (String(p.businessDate) !== String(ctx.businessDate)) return false;
  if (typeof p.shop !== 'string' || p.shop === '' || String(p.shop) !== String(ctx.shop)) return false;
  if (p.accountId == null || String(p.accountId) !== String(ctx.accountId)) return false;
  if (!Number.isInteger(p.planNumber) || p.planNumber !== Number(ctx.planNumber)) return false;
  if (typeof p.runId !== 'string' || p.runId === '' || String(p.runId) !== String(ctx.runId)) return false;
  return true;
}

function sha256Hex(text) { return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex'); }

/**
 * F1 本地准备恢复证明结构判据（无浏览器收口的账本侧复验）：只接受由 publisher 本地
 * recoverLocalPreparationClose 产生的 preparationClosed 事实，并逐字绑定当前账本条目：
 * 业务日/店/份号/排程 runId（内嵌日期必须等于业务日）/源字节 64hex hash/六字段零消费证明。
 * in-progress 条目还要求绑定 startedAt，防止把证明套到另一份在途条目上。任一缺字段/错值/
 * 非排程 runId/零消费结构不全一律 false。
 */
function strictLocalPreparationClosureProof(p) {
  const c = p && p.preparationClosureProof;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (c.method !== 'local-preparation-closed') return false;
  if (String(c.businessDate || '') !== String(p.businessDate)) return false;
  if (String(c.shop || '') !== String(p.shop)) return false;
  // 身份必须是 publisher 解析出的可信账号；null/空不能被当成"已证明身份"，且外层释放
  // 证明与内层收口事实必须逐字同账号。
  if (!/^\d{6,24}$/.test(String(c.accountId || ''))) return false;
  if (String(p.accountId || '') !== String(c.accountId)) return false;
  if (Number(c.planNumber) !== Number(p.planNumber)) return false;
  const origin = /^plan-scheduler-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/.exec(String(c.runId || ''));
  if (!origin || origin[1] !== String(p.businessDate)) return false;
  if (!/^[0-9a-f]{64}$/.test(String(c.sourceHash || ''))) return false;
  if (typeof c.reason !== 'string' || c.reason.trim() === '') return false;
  const z = c.zeroConsumptionProof;
  if (!z || typeof z !== 'object' || Array.isArray(z)) return false;
  if (z.initialConsumptions !== 0 || z.finalConsumptions !== 0 || z.reopenConsumptions !== 0
    || z.manualUnresolved !== 0 || z.plansContainsNumber !== false || z.confirmationConsumptionsRecorded !== false) return false;
  if (p.entryStatus === 'in-progress') {
    if (typeof p.entryStartedAt !== 'string' || p.entryStartedAt === '') return false;
    if (String(c.entryStartedAt || '') !== String(p.entryStartedAt)) return false;
  }
  return true;
}

/**
 * S44 严格的「当前日终态释放」证明结构判据。只接受把**当前账本条目**逐字绑定的释放证明：
 * method/status 必须是 scheduler-release-prepublication，业务日合法，店名/份号精确，
 * 记录终态只能是 failed|blocked（S56 起另接受 failed-permanent：条目须恰为
 * preparation-stopped，或 S57 起条目恰为 unsubmitted 且携带账本 retryHistory 证明的
 * pre-navigation-open-failed 溯源），被释放条目只能是 failed|preparation-stopped|unsubmitted，
 * entryReasonHash 必须是 64 位十六进制（条目原因的 sha256），并携带严格的**零发布**证明
 * （strictNoPublicationProof 且业务日与外层一致）。缺任一字段/任意值/非对象一律不算证明——
 * 绝不凭任意布尔"已恢复"标志或错误文本释放账本。
 * F1：另接受一条**仅本地准备恢复**的形状（recStatus=unknown + in-progress/unknown 条目 +
 * entryProvenanceMethod=local-preparation-closed），它不带发布证明，而带 publisher 的
 * preparationClosed 严格零消费事实（strictLocalPreparationClosureProof）。
 */
function strictSchedulerReleaseProof(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (p.method !== 'scheduler-release-prepublication' || p.status !== 'scheduler-release-prepublication') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.businessDate || ''))) return false;
  if (typeof p.shop !== 'string' || p.shop.trim() === '') return false;
  if (!Number.isInteger(p.planNumber) || p.planNumber < 1) return false;
  if (!/^[0-9a-f]{64}$/.test(String(p.entryReasonHash || ''))) return false;
  if (p.recStatus === 'unknown' && p.entryProvenanceMethod === 'local-preparation-closed'
    && (p.entryStatus === 'in-progress' || p.entryStatus === 'unknown')) {
    return strictLocalPreparationClosureProof(p);
  }
  const releaseShape = ((p.recStatus === 'failed' || p.recStatus === 'blocked')
      && (p.entryStatus === 'failed' || p.entryStatus === 'preparation-stopped'))
    // S56：failed-permanent 仅当被释放条目恰为 preparation-stopped（已证明零发布）才可释放。
    || (p.recStatus === 'failed-permanent' && p.entryStatus === 'preparation-stopped')
    // S57：或条目恰为 unsubmitted 且携带由账本自身 retryHistory 证明的
    // pre-navigation-open-failed 溯源（apply 时仍在锁内复验该历史绑定）。
    || (p.recStatus === 'failed-permanent' && p.entryStatus === 'unsubmitted'
      && p.entryProvenanceMethod === 'pre-navigation-open-failed')
    // S126：仅这份精确的 legacy pre-initial policy-cancel unknown 形状。原因字符串只选候选，
    // 真正的证明是 policyCancelProof（独立新鲜 day-state + attempts 复证，含 sourceHash）。
    || (p.recStatus === 'unknown' && p.entryStatus === 'unknown'
      && p.entryProvenanceMethod === 'pre-initial-policy-cancel'
      && p.policyCancelProof && typeof p.policyCancelProof === 'object' && !Array.isArray(p.policyCancelProof)
      && p.policyCancelProof.method === 'pre-initial-policy-cancel'
      && String(p.policyCancelProof.businessDate) === String(p.businessDate)
      && String(p.policyCancelProof.shop) === String(p.shop)
      && Number(p.policyCancelProof.planNumber) === Number(p.planNumber)
      && p.policyCancelProof.stateActiveStatus === 'preparation-stopped'
      && /^[0-9a-f]{64}$/.test(String(p.policyCancelProof.stateReasonHash || ''))
      && String(p.policyCancelProof.stateReasonHash) === String(p.entryReasonHash)
      && /^[0-9a-f]{64}$/.test(String(p.policyCancelProof.sourceHash || ''))
      && p.policyCancelProof.zeroConsumptionProof && typeof p.policyCancelProof.zeroConsumptionProof === 'object'
      && p.policyCancelProof.zeroConsumptionProof.initialConsumptions === 0
      && p.policyCancelProof.zeroConsumptionProof.finalConsumptions === 0
      && p.policyCancelProof.zeroConsumptionProof.reopenConsumptions === 0
      && p.policyCancelProof.zeroConsumptionProof.manualUnresolved === 0
      && p.policyCancelProof.zeroConsumptionProof.plansContainsNumber === false
      && p.policyCancelProof.zeroConsumptionProof.confirmationConsumptionsRecorded === false);
  if (!releaseShape) return false;
  return strictNoPublicationProof(p.publicationProof)
    && String(p.publicationProof.businessDate) === String(p.businessDate);
}

/**
 * S44 唯一的账本释放映射（scheduler 与 watch-drill 恢复端点共用**同一实现**）：
 * 把一个已证明"当前日、该份预发布失败且零发布"的终态 failed/blocked 记录，释放为可重试的
 * unsubmitted（复用既有 tick + 有界 unsubmitted 重试路径），从而只补发**未提交的剩余份数**。
 * 成功条目/其它条目/原始 reason/历史尝试（retryHistory）与快照（releasedFrom.entries）全部原样保留，
 * 上限（plansPerShopPerDay）不变。任一绑定不符（记录状态/条目状态/原因 hash 不匹配、存在 in-progress、
 * plans 计数与 success 条目不一致、已无剩余份数）一律零改动。
 */
function applySchedulerReleaseToRecord(rec, proof, nowMs, plansPerShopPerDay) {
  if (!rec || typeof rec !== 'object' || !strictSchedulerReleaseProof(proof)) return { changed: false, rec: rec || null };
  if (String(rec.status) !== String(proof.recStatus)) return { changed: false, rec };
  if (!rec.entries || typeof rec.entries !== 'object') return { changed: false, rec };
  const key = String(proof.planNumber);
  const e = rec.entries[key];
  if (!e || String(e.status) !== String(proof.entryStatus)) return { changed: false, rec };
  if (sha256Hex(e.reason) !== String(proof.entryReasonHash)) return { changed: false, rec };
  // F1：本地准备恢复（无浏览器）产生的在途/未知条目释放。除上面通用绑定外还要求：
  // 记录错误恰为未决终态标记、条目没有任何 CID/planId/manifest/nonce/frozen 消费痕迹、
  // 记录本身也无确认痕迹，且证明的份号/（在途时）startedAt 与本条目逐字一致。
  const localPreparation = proof.recStatus === 'unknown' && proof.entryProvenanceMethod === 'local-preparation-closed';
  if (localPreparation) {
    if (proof.entryStatus !== 'in-progress' && proof.entryStatus !== 'unknown') return { changed: false, rec };
    const c = proof.preparationClosureProof;
    if (Number(c.planNumber) !== Number(e.planNumber)) return { changed: false, rec };
    if (proof.entryStatus === 'in-progress') {
      if (String(rec.error || '') !== 'unresolved-in-progress-no-replay') return { changed: false, rec };
      if (typeof e.startedAt !== 'string' || e.startedAt === '' || String(e.startedAt) !== String(proof.entryStartedAt)) return { changed: false, rec };
      // 只允许"唯一一条在途"被释放：多条在途说明还有其它未证明的派发，绝不整店放开。
      const inFlight = Object.keys(rec.entries).filter((k) => rec.entries[k] && rec.entries[k].status === 'in-progress');
      if (inFlight.length !== 1 || inFlight[0] !== key) return { changed: false, rec };
    } else if (!/^(scheduled-run-exception|dispatch-exception):/.test(String(e.reason || ''))) {
      return { changed: false, rec };
    }
    if (e.confirmationId != null || e.planId != null || e.manifestHash != null || e.nonce != null || e.frozen) return { changed: false, rec };
    if (rec.confirmationId != null || rec.frozen || rec.nonce != null) return { changed: false, rec };
    if (rec.plans != null && !Number.isInteger(Number(rec.plans))) return { changed: false, rec };
  }
  // S126：精确 legacy pre-initial policy-cancel unknown 的锁内逐字复验。除上面的记录/条目/
  // 原因 hash 外，还要求：唯一第 1 条、plans=0、rec.error 与条目原因一致、条目/记录无任何
  // CID/planId/manifest/nonce/frozen 痕迹，且证明携带的独立源状态原因 hash 与条目原因相等。
  if (proof.recStatus === 'unknown' && !localPreparation) {
    if (proof.entryStatus !== 'unknown' || proof.entryProvenanceMethod !== 'pre-initial-policy-cancel') return { changed: false, rec };
    if (Number(proof.planNumber) !== 1) return { changed: false, rec };
    if (Number(rec.plans) !== 0) return { changed: false, rec };
    if (!rec.entries || typeof rec.entries !== 'object' || Array.isArray(rec.entries)) return { changed: false, rec };
    const keys = Object.keys(rec.entries);
    if (keys.length !== 1 || keys[0] !== '1') return { changed: false, rec };
    if (Number(e.planNumber) !== 1) return { changed: false, rec };
    if (typeof e.reason !== 'string' || e.reason !== 'scheduled-policy-drift-before-initial:policy-disabled-or-not-autoconfirmed') return { changed: false, rec };
    if (String(rec.error || '') !== 'unknown:' + e.reason) return { changed: false, rec };
    if (e.confirmationId != null || e.planId != null || e.manifestHash != null || e.nonce != null || e.frozen) return { changed: false, rec };
    if (rec.confirmationId != null || rec.frozen || rec.nonce != null) return { changed: false, rec };
    const pc = proof.policyCancelProof;
    if (!pc || pc.stateReasonHash !== proof.entryReasonHash) return { changed: false, rec };
  }
  // S57：unsubmitted 溯源复验——证明携带的 pre-navigation-open-failed 必须仍由**当前**记录
  // 自身的 retryHistory 绑定（同份号 + 原因逐字相等 + proof.method 一致）；伪造/缺失/被改
  // 历史一律零改动，绝不凭 unsubmitted 标签或任意错误文本释放。
  if (proof.entryStatus === 'unsubmitted') {
    if (typeof e.reason !== 'string' || !e.reason.startsWith('scheduled-pre-navigation-open-failed:')) return { changed: false, rec };
    const history = Array.isArray(rec.retryHistory) ? rec.retryHistory : [];
    const proven = history.some((h) => h && typeof h === 'object'
      && Number(h.planNumber) === proof.planNumber
      && h.reason === e.reason
      && h.proof && typeof h.proof === 'object' && !Array.isArray(h.proof)
      && h.proof.method === 'pre-navigation-open-failed');
    if (!proven) return { changed: false, rec };
  }
  const clearInProgress = localPreparation && proof.entryStatus === 'in-progress';
  // 除本分支要清掉的那一条在途外，其它任何在途都禁止释放。
  if (!clearInProgress && hasInProgress(rec)) return { changed: false, rec };
  const successCount = countSuccessEntries(rec);
  if (successCount !== (Number(rec.plans) || 0)) return { changed: false, rec };
  const limit = Number.isInteger(plansPerShopPerDay) && plansPerShopPerDay >= 1 ? plansPerShopPerDay : 3;
  if (successCount >= limit) return { changed: false, rec };
  const atIso = new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString();
  rec.releasedFrom = {
    status: rec.status, plans: rec.plans, error: rec.error || null,
    entries: JSON.parse(JSON.stringify(rec.entries)), releasedAt: atIso,
    releaseProof: {
      method: proof.method, businessDate: proof.businessDate, shop: proof.shop, planNumber: proof.planNumber,
      accountId: proof.accountId != null ? String(proof.accountId) : null,
      entryReasonHash: proof.entryReasonHash,
      entryProvenanceMethod: proof.entryProvenanceMethod || null,
      preparationRunId: localPreparation ? String(proof.preparationClosureProof.runId) : null,
      zeroConsumptionProof: localPreparation ? proof.preparationClosureProof.zeroConsumptionProof : null,
      sourceHash: localPreparation ? String(proof.preparationClosureProof.sourceHash) : null,
    },
  };
  rec.retry = { attempts: 0, lastAt: atIso, nextAt: atIso };
  rec.retryHistory = Array.isArray(rec.retryHistory) ? rec.retryHistory.slice(-9) : [];
  rec.retryHistory.push({
    at: atIso, planNumber: proof.planNumber, reason: 'scheduler-release-prepublication',
    proof: { method: proof.method, entryReasonHash: proof.entryReasonHash, entryProvenanceMethod: proof.entryProvenanceMethod || null },
  });
  if (clearInProgress) {
    // 该份**从未提交**（publisher 已严格证明零消费）：条目标为 preparation-stopped 并保留
    // 原在途 startedAt 与恢复 runId 作为审计；绝不是 success，成功计数不变。
    rec.entries[key] = {
      planNumber: Number(key), status: 'preparation-stopped',
      reason: String(proof.preparationClosureProof.reason || 'preparation-closed'),
      preparationRunId: String(proof.preparationClosureProof.runId),
      startedAt: String(e.startedAt), closedAt: atIso, recoveredBy: 'local-preparation-recovery',
    };
    rec.error = 'local-preparation-recovered:' + String(proof.preparationClosureProof.reason || 'preparation-closed');
  }
  rec.status = 'unsubmitted';
  rec.lastAt = atIso;
  return { changed: true, rec };
}

// ── 进程间持久锁（真实入口保护；单进程 ticking 不能代表跨进程互斥）─────────────
// 以 O_EXCL 独占创建锁文件，写入 pid/时间；持有者崩溃留下的陈旧锁（超 lockStaleMs）可被接管。
function probePidAlive(pid) {
  const p = Number(pid);
  if (!Number.isSafeInteger(p) || p <= 0) return null; // 身份不可解析：无法探测
  try { process.kill(p, 0); return true; }
  catch (e) {
    if (e && e.code === 'ESRCH') return false;
    return true; // EPERM 等：进程存在但无权探测 → 视为存活，绝不抢
  }
}

function acquireProcessLock(file, nowMs, staleMs) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: new Date(nowMs()).toISOString() });
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
    return { held: true, token: payload };
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return { held: false, error: (e && e.message) || String(e) };
    // 已存在：只信"时间旧"绝不抢活 owner——必须核实持有者 PID 存活/身份。
    // owner 存活（含无权探测）→ 永远 busy；仅超阈值且 owner 确证死亡（ESRCH），
    // 或身份不可解析（按文件 mtime 计时）时才可接管。
    let info = null;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { info = null; }
    let atMs = info && info.at ? Date.parse(info.at) : NaN;
    if (!Number.isFinite(atMs)) {
      try { atMs = fs.statSync(file).mtimeMs; } catch (_) { return { held: false, busy: true }; }
    }
    const age = nowMs() - atMs;
    const alive = probePidAlive(info && info.pid);
    if (alive === true) return { held: false, busy: true };
    if (info && alive === false && String(info.pid) === String(process.pid) && age <= staleMs) return { held: false, busy: true };
    if (Number.isFinite(age) && age > staleMs) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* 竞态：另一进程已清理 */ }
      try {
        const fd = fs.openSync(file, 'wx');
        try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
        return { held: true, token: payload, tookOverStale: true, ownerDead: alive === false };
      } catch (_) { return { held: false, busy: true }; }
    }
    return { held: false, busy: true };
  }
}

function releaseProcessLock(file, token) {
  try {
    if (!fs.existsSync(file)) return;
    if (token) {
      const cur = fs.readFileSync(file, 'utf8');
      if (cur !== token) return; // 已被他方接管，绝不误删
    }
    fs.rmSync(file, { force: true });
  } catch (_) { /* 释放失败交由陈旧锁回收机制处理 */ }
}

/**
 * 创建排程器。opts:
 * - planPublishing: 原始配置（会严格校验）
 * - ledgerFile: 执行账本落盘路径（本地持久文件）
 * - lockFile: 进程间持久锁路径（默认 ledgerFile + '.lock'）；真实入口跨进程互斥保护
 * - lockStaleMs: 陈旧锁接管阈值（默认 30 分钟）
 * - nowMs: () => number，假 clock 可注入
 * - runPlan: async (business, { planNumber, businessDate, plansPerShopPerDay, autoConfirm,
 *              authorizedBy, dailyBudget, roi }) => { status, planId?, reason? }
 * - listShops: () => [{ id, name, deleted?, targetRoi?, cookieFile? }]（当前未删除店名单）
 * - buildBusiness: (shopConfig, ctx) => trusted business profile（含 accountId/roi）；ctx 带
 *              dailyBudget / plansPerShopPerDay / nowMs，供按配置对齐预算与 ROI
 * - readDaySuccess: (shopId, businessDate) => number，外部（publisher 真实日状态）本日已成功份数
 *              （含手动发布）；与账本取 max，每日上限不超过 cfg.plansPerShopPerDay；
 *              读数不可知时必须抛错（该店按 unknown 停止），绝不静默按 0 重发
 * - discoverAccount: async (shopConfig, business) => accountId|null，运行时身份发现能力
 *              （生产 openShop 级）；仅在配置 accountId=null 时调用。缺省不提供 → 按
 *              "未知账户停止本店"处理（不臆造身份，绝不借其它店）
 * - enableShop: async (business, { planId, planNumber, enableObservation }) =>
 *              { ok, reason?, alreadyEnabled? }，正式既有"普通开启"能力钩子；
 *              enableObservation 是发布入口带回的**只读**开启读数：already-enabled 时本模块
 *              根本不调用钩子（零开启请求）；缺省或失败**不回滚已发布**，也不阻止本日剩余
 *              份数继续派发，诚实记 enable 状态并继续其它店
 * - onLog: (level, msg) => void，可选
 * - intervalMs: 轮询周期，默认 30000；测试可注入极小值或直接调用 tick()
 */
function createScheduler(opts = {}) {
  const o = opts || {};
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const onLog = typeof o.onLog === 'function' ? o.onLog : () => {};
  const ledgerFile = o.ledgerFile || path.join(__dirname, 'promo-plan-scheduler-ledger.json');
  const lockFile = o.lockFile || (ledgerFile + '.lock');
  const lockStaleMs = Number.isFinite(o.lockStaleMs) && o.lockStaleMs > 0 ? o.lockStaleMs : 30 * 60 * 1000;
  const validated = validatePlanPublishing(o.planPublishing);
  let cfg = validated.value;
  const listShops = typeof o.listShops === 'function' ? o.listShops : () => [];
  const buildBusiness = typeof o.buildBusiness === 'function' ? o.buildBusiness : (s) => s;
  const readDaySuccess = typeof o.readDaySuccess === 'function' ? o.readDaySuccess : () => 0;
  const discoverAccount = typeof o.discoverAccount === 'function' ? o.discoverAccount : null;
  const enableShop = typeof o.enableShop === 'function' ? o.enableShop : null;
  const runPlan = o.runPlan;
  // 同锁内的严格准备收口钩子（可选，缺省 null = 行为与旧版完全一致）：tick 持进程锁期间，
  // 若 runPlan 以「带耐久零消费证明的准备停滞」返回，则在同一把锁内按**注入方提供的唯一严格
  // 判据**把该份收口，避免依赖 1/15/60s timer 事后拿锁（长 tick 会让 timer 反复 busy 而放弃）。
  // 钩子返回 { applied:true } 表示已由同一严格判据改写该份条目；任何不严/漂移一律 applied:false，
  // 本模块保持原 unknown，绝不按状态字符串放行、绝不伪造成功。
  const applyRunResultToLedger = typeof o.applyRunResultToLedger === 'function' ? o.applyRunResultToLedger : null;

  // F1：陈旧在途（崩溃遗留 in-progress）的**本地**准备恢复钩子（可选；缺省 null = 行为与旧版
  // 完全一致）。tick 已持排程进程锁；钩子内部再取 publisher 真实互斥锁、锁内新鲜回读并复用
  // publisher 既有严格零消费证明 + 耐久收口，最后经**唯一** applySchedulerReleaseToRecord
  // 把该条在途映射为可重试 unsubmitted（绝不是 success）。钩子返回 { applied:true } 才继续本店
  // 派发；锁忙/证明不齐/身份或份号漂移/源字节漂移一律 applied:false → 本店保持原 unknown 终态，
  // 绝不抢占在途 worker、绝不重放。返回的 reason 会作为具体"恢复未通过原因"记入结果。
  const recoverStalePreparation = typeof o.recoverStalePreparation === 'function' ? o.recoverStalePreparation : null;

  // S47 fresh-release source verifier (optional; injected by the trusted host that can reach the
  // publisher's on-disk stores). Given a release proof it MUST re-read the exact source paths bound
  // in the proof and recompute the publication-source content hash, returning true only when the
  // CURRENT bytes match proof.sourceHash. Missing file / changed bytes / a misbound path => false =>
  // zero ledger change. Absent verifier keeps the legacy structural-only behavior (a host that has
  // no path to the stores cannot be forced to re-verify), but a bound proof then relies on the
  // scheduler's own under-lock entry rebind (shop/date/plan/status/reason-sha256) which is retained.
  const verifyReleaseSourceProof = typeof o.verifyReleaseSourceProof === 'function' ? o.verifyReleaseSourceProof : null;

  // 有界安全重试（仅针对**已证明从未发布**的失败，见 strictNoPublicationProof）：复用既有
  // tick 节拍 + 耐久账本，**不新增任何服务/定时器**。重试店每次尝试之间等待至少
  // retryBackoffMs[attempt-1]（默认 1/5/15 分钟），并在 maxUnsubmittedRetries 次后诚实封存为
  // failed-permanent（本日不再重试）。未知/已消费的失败永不进入此路径（保持 noReplay 封存）。
  // patrol-plan-refill 返修（2026-10-26）：删除自造的 48 次/日封顶。**显式 null** = 无上限
  //（Infinity，仅独立 runner 值守补发模式传入：严格证明从未提交的缺额可一直重试到配置的
  // 成功目标）；其它调用方（缺省/undefined/非法值）一律保持 legacy 默认 3，行为不变。
  const maxUnsubmittedRetries = (o.maxUnsubmittedRetries === null
      && Object.prototype.hasOwnProperty.call(o, 'maxUnsubmittedRetries'))
    ? Infinity
    : (Number.isInteger(o.maxUnsubmittedRetries) && o.maxUnsubmittedRetries > 0 ? o.maxUnsubmittedRetries : 3);
  const retryBackoffMs = (Array.isArray(o.retryBackoffMs) && o.retryBackoffMs.length && o.retryBackoffMs.every(x => Number.isFinite(x) && x >= 0))
    ? o.retryBackoffMs.slice() : [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

  const st = {
    running: false,
    timer: null,
    ticking: false,       // 单进程并发锁：同一时刻只允许一次 tick
    startGeneration: 0,   // 启动补发排队令牌：stop/再次 start 使旧排队检查失效
    lastTickAt: null,
    lastRunDate: null,
    lastDispatchAt: null,
    nextRunAt: null,
    lastResults: {},      // shopId -> 最近一次派发结果摘要
    configErrors: validated.reasons.slice(),
  };

  function shanghai(now) { return shanghaiParts(typeof now === 'number' ? now : nowMs()); }

  function due(now) {
    const t = shanghai(now);
    const target = parseHm(cfg.time);
    if (target == null) return false;
    return t.minutes >= target;
  }

  /** 下一执行时刻（UTC 毫秒）。未授权（disabled）返回 null；今日已整体完成 → 明日配置时刻；
   *  今日未到点 → 今日配置时刻；今日已到点但仍有未完成/待处理（含启动补发场景）→ 立即（now），
   *  绝不把当天逾期缺额误显示成明日。真实是否派发仍由 tick 的授权/锁/终态/退避安全门决定，
   *  本函数只表达"下一次检查/补发机会"，不表示已成功补齐。 */
  function computeNextRunAt(now, doneToday) {
    if (!cfg.enabled || !cfg.autoConfirm) return null;
    const t = shanghai(now);
    const target = parseHm(cfg.time);
    if (target == null) return null;
    const utcMs = typeof now === 'number' ? now : nowMs();
    const shMs = utcMs + 8 * 3600 * 1000;               // 上海墙上时间（当作 UTC 读）
    const sh = new Date(shMs);
    const dayStartSh = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate());
    const targetShMs = dayStartSh + target * 60 * 1000;
    // 今日已整体完成 → 顺延到明天。
    if (doneToday === true) return targetShMs + 24 * 3600 * 1000 - 8 * 3600 * 1000;
    // 今日未到点 → 今日配置时刻。
    if (target > t.minutes) return targetShMs - 8 * 3600 * 1000;
    // 今日已到点但仍有缺额/待处理 → 立即补检查（不得显示为明日）。
    return utcMs;
  }

  /** 本日是否所有未删除店都已达各自上限（用于 nextRunAt 与实际 finished 对齐）。 */
  function isDoneToday(ledger, date) {
    const shops = (listShops() || []).filter((s) => s && s.deleted !== true);
    if (shops.length === 0) return false;
    const dayRec = (ledger.days && ledger.days[date] && ledger.days[date].shops) || {};
    return shops.every((s) => {
      const shopId = String(s.id != null ? s.id : s.name);
      const limit = resolveShopPlansPerDay(s, cfg.plansPerShopPerDay);
      const rec = dayRec[shopId];
      return rec && (rec.plans >= limit
        || rec.status === 'failed' || rec.status === 'unknown'
        || rec.status === 'failed-permanent' || rec.status === 'blocked');
    });
  }

  async function tick() {
    if (st.ticking) return { skipped: 'tick-in-flight' };
    st.ticking = true;
    st.lastTickAt = new Date(nowMs()).toISOString();
    let lock = null;
    try {
      if (!cfg.enabled || !cfg.autoConfirm) {
        return { skipped: 'not-authorized', enabled: cfg.enabled, autoConfirm: cfg.autoConfirm };
      }
      if (st.configErrors.length) return { skipped: 'invalid-config', reasons: st.configErrors };
      if (typeof runPlan !== 'function') return { skipped: 'no-publish-executor' };
      const now = nowMs();
      const t = shanghai(now);
      if (!due(now)) return { skipped: 'before-time', time: cfg.time, now: t.hhmm };

      // 进程间持久锁：拿到才派发；被占（另一进程在跑）则跳过，不强杀在途。
      lock = acquireProcessLock(lockFile, nowMs, lockStaleMs);
      if (!lock.held) return { skipped: 'locked-by-other-process', busy: !!lock.busy, error: lock.error || null };

      const ledger = loadLedger(ledgerFile);
      if (ledger.corrupt) return { skipped: 'ledger-corrupt-fail-closed' };

      // 跨日：本日记录天然隔离；未发布清单不跨日（每店每天以 businessDate=t.date 重新生成，
      // 绝不用旧 hash 配新身份）。每店/每条发送前再 fresh 检查日期与授权。
      const shops = (listShops() || []).filter((s) => s && s.deleted !== true);
      const results = [];
      let interrupted = null;
      for (const shop of shops) {
        // fresh 检查（每店）：配置已停用 / 已跨日 → 立即停止未发布清单（不裸跨日、不跨进程强杀在途）。
        if (!cfg.enabled || !cfg.autoConfirm) { interrupted = 'disabled'; break; }
        if (shanghai().date !== t.date) { interrupted = 'cross-day'; break; }

        const shopId = String(shop.id != null ? shop.id : shop.name);
        const shopLimit = resolveShopPlansPerDay(shop, cfg.plansPerShopPerDay);
        const rec = shopDay(ledger, t.date, shopId);

        // 外部真实日状态（含手动发布）与账本取 max：手动已 3 → 本日跳过；未知只读，绝不重放。
        let external = 0;
        try { external = Number(readDaySuccess(shopId, t.date)) || 0; } catch (e) {
          rec.status = 'unknown'; rec.error = 'read-day-success-failed:' + ((e && e.message) || e);
          saveLedger(ledgerFile, ledger);
          results.push({ shopId, status: 'unknown', error: rec.error }); continue;
        }
        if (external > rec.plans) { rec.plans = external; saveLedger(ledgerFile, ledger); }

        // 崩溃/重启遗留的未决（in-progress）：先按终态 unknown 落盘（既有语义不变），再尝试
        // **本地**准备恢复（无浏览器）。恢复成功 → 该条在途按严格证明映射为 preparation-stopped，
        // 记录转 unsubmitted，本 tick 继续只补剩余份数；恢复未通过（锁忙/证明不齐/漂移）→ 保持
        // 原 unknown 终态并记录具体原因，绝不裸重发、绝不抢占在途 worker。
        if (hasInProgress(rec)) {
          if (rec.status !== 'unknown' || rec.error !== 'unresolved-in-progress-no-replay') {
            rec.status = 'unknown'; rec.error = 'unresolved-in-progress-no-replay';
            saveLedger(ledgerFile, ledger);
          }
          let staleRecovery = null;
          if (recoverStalePreparation) {
            try { staleRecovery = await recoverStalePreparation(shop, { businessDate: t.date, shopId, rec, cfg }); }
            catch (e) { staleRecovery = { applied: false, reason: 'stale-preparation-recovery-threw:' + ((e && e.message) || e) }; }
          }
          if (staleRecovery && staleRecovery.applied === true) {
            saveLedger(ledgerFile, ledger);
            onLog('info', `陈旧在途已按本地准备证明收口（店 ${shopId} ${t.date}）：该份从未提交，记录转 unsubmitted，本日缺额按既有调度继续`);
          }
          if (hasInProgress(rec)) {
            results.push({
              shopId, status: 'unknown', plans: rec.plans, error: rec.error,
              staleRecovery: staleRecovery ? { applied: false, reason: staleRecovery.reason || null } : { applied: false, reason: 'stale-preparation-recovery-unavailable' },
            });
            continue;
          }
        }
        // 已证明"从未发布"的失败进入有界安全重试：退避未到即等待（本 tick 跳过，不推进）；
        // 退避已过即放行到下方正常派发（同一份号，未成功不推进计数）；封顶后诚实封存
        // failed-permanent（本日不再重试）。其余 failed/unknown/blocked 一律由下方终态分支处理。
        if (rec.status === 'unsubmitted') {
          const retry = rec.retry || null;
          const attempts = retry && Number.isInteger(retry.attempts) ? retry.attempts : 0;
          if (attempts >= maxUnsubmittedRetries) {
            rec.status = 'failed-permanent';
            rec.error = 'unsubmitted-retries-exhausted:' + (rec.error || '');
            saveLedger(ledgerFile, ledger);
            results.push({ shopId, status: rec.status, plans: rec.plans, error: rec.error }); continue;
          }
          const nextAt = retry && retry.nextAt ? Date.parse(retry.nextAt) : NaN;
          if (Number.isFinite(nextAt) && nowMs() < nextAt) {
            results.push({ shopId, status: 'unsubmitted', plans: rec.plans, error: rec.error || null, retryWaiting: true }); continue;
          }
          // 退避已过：放行到下方正常派发。
        }
        // 本日已达上限 → 不再重做今天已成功的份。S129：若账本自身已具备完整、可验证的
        // 本店同日成功 entries，则把因上次保存中断而残留的 unsubmitted/partial/pending
        // 陈旧准备状态收敛为 success 并清当前 error；已有 success 的陈旧 error 也仅此狭义
        // 清理。绝不凭 rec.plans 或外部成功计数、绝不改 unknown/failed/blocked、绝不新增
        // 条目或消费、绝不调用 runPlan。
        if (rec.plans >= shopLimit) {
          const stalePrep = rec.status === 'unsubmitted' || rec.status === 'partial' || rec.status === 'pending';
          if ((stalePrep || rec.status === 'success') && hasCompleteSuccessEntries(rec, shopLimit)) {
            const changed = rec.status !== 'success' || rec.error != null;
            rec.status = 'success';
            rec.error = null;
            if (changed) saveLedger(ledgerFile, ledger);
          }
          results.push({ shopId, status: rec.status, plans: rec.plans });
          continue;
        }
        // 本日已进入失败/未知/阻塞终态：**不推进、不重放**（跨日才由新 businessDate 重新生成新身份）。
        if (rec.status === 'failed' || rec.status === 'unknown' || rec.status === 'failed-permanent' || rec.status === 'blocked') {
          results.push({ shopId, status: rec.status, plans: rec.plans, error: rec.error }); continue;
        }

        let business;
        try { business = buildBusiness(shop, { dailyBudget: cfg.dailyBudget, plansPerShopPerDay: shopLimit, nowMs }); }
        catch (e) {
          rec.status = 'failed'; rec.error = 'business-profile-failed:' + ((e && e.message) || e);
          saveLedger(ledgerFile, ledger);
          results.push({ shopId, status: 'failed', error: rec.error }); continue;
        }
        if (!business || business.accountId == null || business.accountId === '') {
          // 运行时身份发现（生产 openShop 级能力注入时才尝试）：发现成功即用同店已验证身份继续；
          // 无该能力或发现为 null 一律诚实 blocked——不预先要求人工填号、绝不借其它店身份、绝不臆造发布。
          if (business && discoverAccount) {
            try {
              const found = await discoverAccount(shop, business);
              if (found && typeof found === 'object' && typeof found.error === 'string' && found.error) {
                // 具体的身份发现失败：逐字保留发现侧原因（绝不吞成通用 unknown-account，
                // 绝不据此自动重试或当作登录过期）。
                rec.status = 'blocked'; rec.error = 'account-discovery:' + found.error;
                saveLedger(ledgerFile, ledger);
                results.push({ shopId, status: 'blocked', error: rec.error }); continue;
              }
              if (found != null && String(found) !== '') business = { ...business, accountId: String(found) };
            } catch (e) {
              rec.status = 'failed'; rec.error = 'account-discovery-failed:' + ((e && e.message) || e);
              saveLedger(ledgerFile, ledger);
              results.push({ shopId, status: 'failed', error: rec.error }); continue;
            }
          }
        }
        if (!business || business.accountId == null || business.accountId === '') {
          rec.status = 'blocked'; rec.error = 'unknown-account-or-missing-identity';
          saveLedger(ledgerFile, ledger);
          results.push({ shopId, status: 'blocked', error: rec.error }); continue;
        }
        // 预算/ROI 对齐 trusted 配置：native fill/guard/freeze/readback 由 runPlan 内部据此执行。
        // 不就地改写（buildShopProfile 等可能返回 frozen），用浅拷贝携带 cfg 预算与校验后的 ROI。
        const roi = (typeof business.roi === 'number' && Number.isFinite(business.roi) && business.roi > 0) ? business.roi : 15;
        business = { ...business, dailyBudget: cfg.dailyBudget, roi };

        let stopped = null;
        let finalLimit = shopLimit;
        // 每份派发前 fresh 重取**同一店**当前配置并据此派发（2026-10-26 patrol-plan-refill）：
        // 页面在本次 tick 内保存的数量/ROI/每店上限立即生效（降份数立即停发、改 ROI 到达后续
        // 份）；店被删除/名单移除/身份（名称或显式账号）变化 → 停止本店后续派发，绝不静默
        // 切换店或账号。已成功份数永不重发。
        while (true) {
          // fresh 检查（每条发送前）：停用/跨日 → 立即停止本店本日剩余派发。
          if (!cfg.enabled || !cfg.autoConfirm) { stopped = 'disabled'; break; }
          if (shanghai().date !== t.date) { stopped = 'cross-day'; break; }
          const freshShop = (listShops() || []).find((s) => s && s.deleted !== true
            && String(s.id != null ? s.id : s.name) === shopId);
          if (!freshShop) { stopped = 'shop-missing'; break; }
          if (String(freshShop.name != null ? freshShop.name : '') !== String(shop.name != null ? shop.name : '')) {
            stopped = 'shop-identity-changed'; break;
          }
          const freshLimit = resolveShopPlansPerDay(freshShop, cfg.plansPerShopPerDay);
          finalLimit = freshLimit;
          if (rec.plans >= freshLimit) break;
          let freshBusiness = null;
          try { freshBusiness = buildBusiness(freshShop, { dailyBudget: cfg.dailyBudget, plansPerShopPerDay: freshLimit, nowMs }); }
          catch (e) { stopped = 'business-profile-failed'; break; }
          if (!freshBusiness || typeof freshBusiness !== 'object') { stopped = 'business-profile-failed'; break; }
          const freshAccount = freshBusiness.accountId != null && String(freshBusiness.accountId) !== '' ? String(freshBusiness.accountId) : null;
          if (freshAccount != null && String(business.accountId) !== freshAccount) { stopped = 'shop-account-changed'; break; }
          const freshRoi = (typeof freshBusiness.roi === 'number' && Number.isFinite(freshBusiness.roi) && freshBusiness.roi > 0) ? freshBusiness.roi : 15;
          business = { ...freshBusiness, accountId: business.accountId, dailyBudget: cfg.dailyBudget, roi: freshRoi };

          const planNumber = rec.plans + 1;
          // dispatch 前**原子落盘 in-progress**：崩溃重启据此判 unknown，绝不裸重发。
          rec.entries[planNumber] = { planNumber, status: 'in-progress', startedAt: new Date(nowMs()).toISOString() };
          rec.lastAt = new Date(nowMs()).toISOString();
          saveLedger(ledgerFile, ledger);

          let r;
          try {
            r = await runPlan(business, {
              planNumber, businessDate: t.date,
              plansPerShopPerDay: freshLimit,
              autoConfirm: true, authorizedBy: 'recurring-user-policy',
              dailyBudget: cfg.dailyBudget, roi: freshRoi,
            });
          } catch (e) { r = { status: 'unknown', reason: 'dispatch-exception:' + ((e && e.message) || e) }; }
          const status = (r && r.status) || 'unknown';
          const reason = (r && r.reason) || null;

          if (status === 'success') {
            // 每条成功**立即持久**（planId/日期/一次性消费），不只计总数。
            rec.entries[planNumber] = { planNumber, status: 'success', planId: (r && r.planId) || null, at: new Date(nowMs()).toISOString() };
            rec.plans += 1;
            rec.retry = null;
            rec.lastAt = new Date(nowMs()).toISOString();
            // 正式既有"普通开启"钩子：缺能力/失败均**不回滚已发布**，诚实记录后继续下一条/其它店。
            // 发布入口带回的**只读**开启读数（postPublishEnable）优先：读数已确认 already-enabled
            // → 零开启请求（不再向 Monitor 发单）；只有读数不是 already-enabled（已暂停/未知/缺读数）
            // 才调用钩子，钩子据精确身份 + 该读数决定是否走正式核实并**有界等待**终态。
            const observation = (r && r.postPublishEnable) || null;
            const observationStatus = (observation && observation.status) ? String(observation.status) : null;
            if (observationStatus === 'already-enabled') {
              rec.entries[planNumber].enable = 'already-enabled';
            } else if (enableShop) {
              try {
                const er = await enableShop(business, { planId: (r && r.planId) || null, planNumber, enableObservation: observation });
                rec.entries[planNumber].enable = (er && er.ok) ? ((er.alreadyEnabled === true) ? 'already-enabled' : 'enabled')
                  : ('enable-pending:' + ((er && er.reason) || 'not-ok'));
              } catch (e) { rec.entries[planNumber].enable = 'enable-failed:' + ((e && e.message) || e); }
            } else {
              rec.entries[planNumber].enable = 'enable-unsupported';
            }
            saveLedger(ledgerFile, ledger);
            continue;
          }
          // 失败/未知：记录真实 reason 后停止本店（其他店继续）；未知绝不重放。
          if (status === 'unsubmitted'
            && publicationProofBindsRun(r && r.publicationProof, {
              businessDate: t.date, shop: shopId, accountId: business.accountId,
              planNumber, runId: r && r.runId,
            })) {
            // 已证明"从未发布"：耐久记录本次并安排有界退避；绝不封存当天、绝不伪造成功。
            // 原始尝试逐条保留在 retryHistory（可审计的失败/重试链），条目本身标为可重试。
            const prev = rec.retry && Number.isInteger(rec.retry.attempts) ? rec.retry.attempts : 0;
            const attemptNo = prev + 1;
            const delay = retryBackoffMs[Math.min(attemptNo - 1, retryBackoffMs.length - 1)];
            const atIso = new Date(nowMs()).toISOString();
            rec.retry = { attempts: attemptNo, lastAt: atIso, nextAt: new Date(nowMs() + delay).toISOString() };
            rec.retryHistory = Array.isArray(rec.retryHistory) ? rec.retryHistory.slice(-9) : [];
            rec.retryHistory.push({ at: atIso, planNumber, reason: reason || status, proof: { method: (r.publicationProof && r.publicationProof.method) || null } });
            rec.entries[planNumber] = { planNumber, status: 'unsubmitted', reason: reason || status, at: atIso, retryable: true, attempt: attemptNo };
            rec.lastAt = atIso;
            rec.error = reason || status;
            rec.status = 'unsubmitted';
            saveLedger(ledgerFile, ledger);
            stopped = 'unsubmitted';
            break;
          }
          rec.entries[planNumber] = { planNumber, status: status === 'failed' ? 'failed' : 'unknown', reason: reason || status, at: new Date(nowMs()).toISOString() };
          rec.lastAt = new Date(nowMs()).toISOString();
          rec.error = reason || status;
          // 同锁内的严格准备收口：runPlan 自带耐久零消费证明时，用注入方提供的**同一**严格判据
          // 在本次 tick 的锁内直接改写该份（证明不严/漂移 → applied:false，保持上面写入的 unknown）。
          if (applyRunResultToLedger) {
            let ap = null;
            try { ap = applyRunResultToLedger(ledger, t.date, shopId, r, cfg, planNumber); }
            catch (e) { ap = { applied: false, error: (e && e.message) || String(e) }; }
            if (ap && ap.applied === true) {
              // R50 修复：已证明零消费的准备收口也必须走**同一条**耐久有界重试记账。
              // 旧行为把 rec.error 清空、不动 rec.retry，当记录此前经严格释放入口已处于
              // unsubmitted（retry.attempts=0）时，下一 tick 直接放行再次派发——2026-10-14
              // 生产中 11:34/11:47/11:48/11:50 UTC 连续多次 preparation-stopped 重试即此路径。
              // 现与 unsubmitted 分支同一记账：attempts+1、退避 nextAt、retryHistory 逐条
              // 保留（原始 reason 不覆盖），条目标记 retryable；封顶/退避由既有 unsubmitted
              // 顶部分支统一执行（maxUnsubmittedRetries 次后诚实 failed-permanent）。
              stopped = 'preparation-stopped';
              const prevP = rec.retry && Number.isInteger(rec.retry.attempts) ? rec.retry.attempts : 0;
              const attemptP = prevP + 1;
              const delayP = retryBackoffMs[Math.min(attemptP - 1, retryBackoffMs.length - 1)];
              const atIsoP = new Date(nowMs()).toISOString();
              rec.retry = { attempts: attemptP, lastAt: atIsoP, nextAt: new Date(nowMs() + delayP).toISOString() };
              rec.retryHistory = Array.isArray(rec.retryHistory) ? rec.retryHistory.slice(-9) : [];
              rec.retryHistory.push({ at: atIsoP, planNumber, reason: reason || status, proof: { method: 'preparation-closure' } });
              const entryP = rec.entries[planNumber];
              if (entryP && typeof entryP === 'object') { entryP.retryable = true; entryP.attempt = attemptP; }
              rec.lastAt = atIsoP;
              rec.error = reason || status;
              rec.status = 'unsubmitted';
              saveLedger(ledgerFile, ledger);
              break;
            }
          }
          stopped = (status === 'failed' ? 'failed' : 'unknown');
          saveLedger(ledgerFile, ledger);
          break;
        }

        if (stopped === 'preparation-stopped') {
          // 已按严格证明在本次锁内收口：mapper 已诚实重算 rec.status/plans（未消费不虚构成功）。
          // R50：保持 unsubmitted 可重试状态与原始 reason（上面已记账 attempts/退避），
          // 由既有退避分支统一决定等待/封顶，绝不无限零退避重试、也绝不封当天。
          rec.status = 'unsubmitted';
        } else if (stopped === 'unsubmitted') {
          // 已证明从未发布：保持可重试状态与原始 reason，由上方退避分支决定后续重试（不封当天）。
          rec.status = 'unsubmitted';
        } else if (stopped === 'failed') rec.status = 'failed';
        else if (stopped === 'unknown') rec.status = 'unknown';
        // fresh 重取发现的店身份/配置漂移：诚实 failed 并停止本店后续派发（绝不静默换店换号）。
        else if (stopped === 'shop-missing' || stopped === 'shop-identity-changed'
          || stopped === 'shop-account-changed' || stopped === 'business-profile-failed') rec.status = 'failed';
        else if (stopped === 'disabled' || stopped === 'cross-day') rec.status = 'partial';
        else if (rec.plans >= finalLimit) { rec.status = 'success'; rec.error = null; }
        else rec.status = 'unknown';
        if (stopped !== 'preparation-stopped' && stopped !== 'unsubmitted' && rec.status !== 'success') {
          rec.error = stopped ? (stopped + ((rec.entries && rec.entries[rec.plans + 1] && rec.entries[rec.plans + 1].reason) ? ':' + rec.entries[rec.plans + 1].reason : '')) : (rec.error || null);
        }
        saveLedger(ledgerFile, ledger);
        results.push({ shopId, status: rec.status, plans: rec.plans, error: rec.error || null, stopped: stopped || null });
        if (stopped === 'disabled' || stopped === 'cross-day') { interrupted = stopped; break; }
      }
      // 当日容器必须先于 lastRunAt 存在：空店/全删除名单循环零执行时旧代码在此
      // TypeError（不得因此把删店改活避错）；此处只初始化容器，不派发任何发布。
      dayRecord(ledger, t.date).lastRunAt = new Date(nowMs()).toISOString();
      saveLedger(ledgerFile, ledger);
      st.lastRunDate = t.date;
      st.lastDispatchAt = new Date(nowMs()).toISOString();
      st.lastResults = {};
      results.forEach((x) => { if (x && x.shopId) st.lastResults[x.shopId] = x; });
      const doneToday = isDoneToday(ledger, t.date);
      const nx = computeNextRunAt(nowMs(), doneToday);
      st.nextRunAt = nx == null ? null : new Date(nx).toISOString();
      return { ran: true, date: t.date, results, interrupted, nextRunAt: st.nextRunAt };
    } finally {
      if (lock && lock.held) releaseProcessLock(lockFile, lock.token);
      st.ticking = false;
    }
  }

  /**
   * S44 显式受信任释放入口：把当前日一个已证明"预发布失败且零发布"的终态 failed/blocked 店记录
   * 释放为可重试的 unsubmitted，使后续 tick 只补发未提交的剩余份数（成功份数不可变、上限不变）。
   * 证明必须是严格结构（strictSchedulerReleaseProof）且逐字绑定当前账本条目（由
   * publisher.proveSchedulerReleaseProof 生成）；本方法在**排程进程锁内**重读账本、重比记录状态 /
   * 条目状态 / 条目原因 sha256，任一不符零改动。绝不裸改账本、绝不重放已成功/未知/已消费的份。
   */
  function releaseProvenRemainder(proof) {
    if (!strictSchedulerReleaseProof(proof)) return { ok: false, released: false, reason: 'release-proof-not-strict' };
    const lock = acquireProcessLock(lockFile, nowMs, lockStaleMs);
    if (!lock.held) return { ok: false, released: false, reason: 'release-locked-by-other-process', busy: !!lock.busy, error: lock.error || null };
    try {
      const ledger = loadLedger(ledgerFile);
      if (ledger.corrupt) return { ok: false, released: false, reason: 'release-ledger-corrupt-fail-closed' };
      const date = String(proof.businessDate);
      const shopId = String(proof.shop);
      const day = ledger.days && ledger.days[date];
      const rec = day && day.shops && day.shops[shopId];
      if (!rec) return { ok: false, released: false, reason: 'release-no-current-entry' };
      // Fresh source re-verification UNDER THE LOCK, before any mutation: recompute the bound
      // publication-source hash from the CURRENT on-disk stores and refuse on changed/deleted bytes
      // or a misbound path. Absent verifier => structural-only trust (legacy host without store
      // access); the under-lock entry rebind below still gates every mutation.
      if (verifyReleaseSourceProof) {
        let fresh = false;
        try { fresh = verifyReleaseSourceProof(proof) === true; } catch (_) { fresh = false; }
        if (!fresh) return { ok: false, released: false, reason: 'release-source-not-fresh' };
      }
      const hit = (listShops() || []).find((s) => s && String(s.id != null ? s.id : s.name) === shopId);
      const limit = resolveShopPlansPerDay(hit || { id: shopId }, cfg.plansPerShopPerDay);
      const mapped = applySchedulerReleaseToRecord(rec, proof, nowMs(), limit);
      if (!mapped.changed) return { ok: false, released: false, reason: 'release-binding-mismatch' };
      saveLedger(ledgerFile, ledger);
      return { ok: true, released: true, shop: shopId, planNumber: proof.planNumber, status: rec.status };
    } finally {
      releaseProcessLock(lockFile, lock.token);
    }
  }

  function start() {
    if (st.running) return { ok: true, alreadyRunning: true, nextRunAt: st.nextRunAt };
    st.running = true;
    const generation = ++st.startGeneration;
    const intervalMs = Number.isInteger(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : 30000;
    st.nextRunAt = refreshNextRunAt();
    st.timer = setInterval(() => { tick().catch((e) => onLog('error', '排程 tick 异常：' + ((e && e.message) || e))); }, intervalMs);
    if (typeof st.timer.unref === 'function') st.timer.unref();
    onLog('info', `自动发布排程${cfg.enabled ? '已启动' : '已登记（未授权，不派发）'}：每日 ${cfg.time}（上海）· 每店最多 ${cfg.plansPerShopPerDay} 份 · 预算 ${cfg.dailyBudget}`);
    // 启动补发：服务启动后在本轮事件循环尽早复用既有 tick 检查一次当天逾期缺额，
    // 不等待默认轮询、不依赖页面或手工 POST。微任务不阻塞 start 返回/服务启动；
    // 异步错误全部捕获交 onLog，绝不产生 unhandled rejection。重复 start 直接回落
    // alreadyRunning；stop/再次 start 通过代数令牌取消尚未执行的旧排队检查，
    // tick 自身的 tick-in-flight 与进程锁/耐久账本负责其余并发去重。
    const startupCheck = () => {
      if (!st.running || st.startGeneration !== generation) return;
      let p;
      try { p = tick(); } catch (e) {
        onLog('error', '排程启动补发异常：' + ((e && e.message) || e));
        return;
      }
      if (p && typeof p.catch === 'function') {
        p.catch((e) => onLog('error', '排程启动补发异常：' + ((e && e.message) || e)));
      }
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(startupCheck);
    else process.nextTick(startupCheck);
    return { ok: true, running: true, nextRunAt: st.nextRunAt };
  }

  /** 依据当前账本日完成状态重排下一次执行时刻，令显示与实际 due/当天 finished 一致。 */
  function refreshNextRunAt() {
    let doneToday = false;
    try { const led = loadLedger(ledgerFile); if (!led.corrupt) doneToday = isDoneToday(led, shanghai().date); } catch (_) { /* 读账本失败按未完成 */ }
    const next = computeNextRunAt(nowMs(), doneToday);
    st.nextRunAt = next == null ? null : new Date(next).toISOString();
    return st.nextRunAt;
  }

  function stop(reason) {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    st.running = false;
    st.startGeneration++; // 使已排队但尚未执行的启动补发检查失效（不影响已在途 tick）
    st.nextRunAt = null;
    onLog('info', `自动发布排程已停止（未来派发不再发生；不影响不确定的在途）：${reason || ''}`);
    return { ok: true, running: false };
  }

  /** 重新校验配置并重排下一次执行（页面保存后调用）。默认关闭必须显式授权。 */
  function configure(raw) {
    const v = validatePlanPublishing(raw);
    cfg = v.value;
    st.configErrors = v.reasons.slice();
    refreshNextRunAt();
    return { ok: v.ok, config: { ...cfg }, reasons: v.reasons };
  }

  function state() {
    const ledger = loadLedger(ledgerFile);
    const t = shanghai(nowMs());
    const today = (ledger.days && ledger.days[t.date]) || { shops: {} };
    const next = computeNextRunAt(nowMs(), ledger.corrupt ? false : isDoneToday(ledger, t.date));
    st.nextRunAt = next == null ? null : new Date(next).toISOString();
    return {
      running: st.running,
      config: { ...cfg },
      configErrors: st.configErrors.slice(),
      nextRunAt: st.nextRunAt,
      lastTickAt: st.lastTickAt,
      lastRunDate: st.lastRunDate,
      lastDispatchAt: st.lastDispatchAt,
      today: { date: t.date, shops: { ...(today.shops || {}) } },
      lastResults: { ...st.lastResults },
    };
  }

  return { start, stop, configure, tick, state, releaseProvenRemainder };
}

/** 从正式配置里读取 planPublishing 并装配（boot 幂等由调用方保证 start 幂等）。 */
function bootScheduler(opts = {}) {
  const cfg = (opts.config && opts.config.planPublishing) || opts.planPublishing || null;
  const scheduler = createScheduler({ ...opts, planPublishing: cfg });
  if (cfg && cfg.enabled === true && cfg.autoConfirm === true) scheduler.start();
  return scheduler;
}

module.exports = {
  DEFAULT_PLAN_PUBLISHING,
  MAX_PER_SHOP_OVERRIDE,
  parseHm,
  resolveShopPlansPerDay,
  validatePlanPublishing,
  shanghaiParts,
  createScheduler,
  bootScheduler,
  atomicWriteJson,
  loadLedger,
  saveLedger,
  countSuccessEntries,
  hasInProgress,
  strictNoPublicationProof,
  publicationProofBindsRun,
  strictSchedulerReleaseProof,
  applySchedulerReleaseToRecord,
  sha256Hex,
  acquireProcessLock,
  releaseProcessLock,
};
