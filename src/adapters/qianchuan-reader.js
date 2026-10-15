'use strict';

/**
 * 巨量千川只读读取器 v2（第五轮重构）。
 *
 * 页面证据（2026-09-13 实测，evidence/）：
 * - 入口：抖店首页顶部"巨量千川" → 新标签 qianchuan.jinritemai.com/home?aavid=<账户ID>；
 *   头部 class shop-name 两个元素（账户名"伊人美"+ ID），ID 兜底全文检索。
 * - 费用：首页 summaryCard "账户整体消耗(元)" = 乘方+标准投放+全域投放+品牌投放 分项之和；
 *   统计周期 datepicker 两 input = 当天；更新时间 refreshTime-*（数据概览区块）。
 * - 投放类型入口（覆盖表依据，实测）：
 *   · 全域投放：导航 data-e2e="…navigatormenu_uni_promotion" → /uni-prom（二级 tab 全域投放/标准投放）；
 *     行 tr.ovui-tr（含 .oc-switch 才是计划行），计划名 oc-typography-value-int，
 *     行内无计划ID → 点击计划名进详情页（新标签或同页）"计划ID：xxx"/URL adId 实测；
 *   · 标准投放：全域页二级 tab → /promotion-v2/standard，行内直接含"托管ID:<12-20位>"，
 *     状态词实测"已终止"（157 条，含分页）；
 *   · 乘方：导航 navigatormenu_overall → /uni-prom/overall 为**新建引导页**，
 *     无计划列表/开关（主文档 innerText 极少，未见 iframe 计划列表）——
 *     当天分项消耗 14.98→16.45 来自乘方，但控制对象本轮未定位 → 覆盖缺口；
 *   · 品牌投放：导航存在（navigatormenu_brand_promotion_bidding），本轮未接入读取 → 覆盖缺口。
 *
 * v2 修复（Codex 第五轮）：
 * - 行与稳定 ID 在行所在页当场绑定（行索引定位，同名计划各自独立，不按名称合并）；
 * - 返回列表后校验页码/行数，位置变化如实记录；
 * - 完整性元数据：total/已读行数/翻页轮数/行失败/未解析 全部如实返回；
 *   总数不符、翻页失败、游标不前进、解析失败、unresolved 非空 → complete=false，
 *   上层据此阻止"全店可关闭/已关闭"结论（不得把部分数据包装成完整清单）；
 * - 覆盖表：coverage 逐类型输出（费用分项↔管理入口↔对象↔ID↔开关↔完整性）；
 *   未接入类型（乘方/品牌）与读取不完整类型列入 coverageGaps → 零关闭；
 * - 资源清理：openQianchuanHome 任意初始化失败都关闭本次创建的浏览器；
 *   支持 browserFactory 注入（测试）。
 *
 * 安全：只读导航（入口/导航/tab/计划名/详情/翻页），绝不点击投放开关；
 * Cookie 只读加载；凭证零输出。closeAd 见 createQianchuanAdController（默认硬拒绝）。
 */

const fs = require('fs');
const path = require('path');
const { AuthError, DataGuardError } = require('../lib/errors');
const { parseMoneyCents } = require('../lib/money');
const { shanghaiDate } = require('../lib/time');
const { resolveCookieFile } = require('../login/session');
const { fingerprintFile } = require('../login/cookie-writeback');
const { closableSideOfAd } = require('./ad-controller');

const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const QC_HOME_MARKER = 'qianchuan.jinritemai.com';
const CONSUME_LABEL = '账户整体消耗';

// ── 抖店首页自动 SSO 收敛（R51）────────────────────────────────────
// 根证 reference-readonly-session.json（2026-10-15 只读复测）：同一已保存 Cookie 装入
// 全新无头 Edge 后，DOMContentLoaded 后 5s/15s 仍在 /login/common（自动 SSO 中转），
// 30s 才自动落到 /ffa/mshop/homepage/index（title=首页），全程零人工/零点击/零写入。
// 旧实现固定等 5s 后立即把中转 URL 判成 AuthError → FALSE-EXPIRED（伪登录过期），
// 上层 requiresLogin=true 要求重扫。修复：先做**有界被动收敛等待**（只在已打开页面
// 上轮询地址，不点击/不导航/零请求），收敛成功才继续；到达上界仍未到首页才做登录
// 正证据分类。上界 45s > 实测 30s 收敛点；快路径（已是首页）零额外等待。
const HOME_HOST = 'fxg.jinritemai.com';
const HOME_PATH_PREFIX = '/ffa/mshop/homepage';
const DEFAULT_SETTLE_TIMEOUT_MS = 45000;
const DEFAULT_SETTLE_INTERVAL_MS = 3000;
const MAX_SETTLE_ATTEMPTS = 1000;

/** 是否已真正落在抖店首页：严格 origin+path 解析（防 lookalike 域名/子串伪造，
 *  如 https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index 不得算成功）。 */
function isDoudianHomepageUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  return p.protocol === 'https:' && p.hostname === HOME_HOST && p.pathname.startsWith(HOME_PATH_PREFIX);
}

/**
 * 有界被动等待抖店首页自动 SSO 收敛：轮询 page.url()（零点击/零导航/零请求），
 * 直到严格命中首页 host/path 或到达上界。快路径：已是首页 → attempts=0 立即返回。
 * 双保险上界：墙钟 deadline（nowFn 单调前进时）+ 独立硬限次（nowFn 冻结/回拨也收敛）。
 * 页面被关闭 → 有界返回 {ok:false, reason:'settle-page-closed'}，绝不空转。
 * 依赖注入：settleNowFn/settleSleep 可注入（离线测试，免真实等待）。
 */
async function waitForDoudianHomepageSettled(page, opts = {}) {
  const timeoutMs = sanitizePositiveMs(opts.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
  const intervalMs = sanitizePositiveMs(opts.settleIntervalMs, DEFAULT_SETTLE_INTERVAL_MS);
  const nowFn = opts.settleNowFn || opts.nowFn || (() => Date.now());
  const sleep = opts.settleSleep || opts.sleep || ((ms) => page.waitForTimeout(ms));
  const maxAttempts = Math.max(1, Math.min(MAX_SETTLE_ATTEMPTS, Math.ceil(timeoutMs / intervalMs) + 1));
  const deadline = nowFn() + timeoutMs;
  const urlNow = () => {
    try { return String(page.url()); } catch (_) { return ''; }
  };
  const pageClosed = () => {
    try { return typeof page.isClosed === 'function' ? page.isClosed() === true : false; } catch (_) { return true; }
  };
  const first = urlNow();
  if (isDoudianHomepageUrl(first)) return { ok: true, url: first, attempts: 0, waited: false };
  let attempts = 0;
  let url = first;
  for (;;) {
    attempts += 1;
    url = urlNow();
    if (isDoudianHomepageUrl(url)) return { ok: true, url, attempts, waited: true };
    if (pageClosed()) return { ok: false, reason: 'settle-page-closed', url, attempts };
    if (attempts >= maxAttempts) break;              // 硬限次上界：冻结/回拨时钟下也收敛
    if (!(nowFn() + intervalMs <= deadline)) break;  // 墙钟上界：不再空转
    try { await sleep(intervalMs); } catch (_) { /* 页面关闭等：下一轮 pageClosed 收敛 */ }
  }
  return { ok: false, reason: 'settle-timeout', url, attempts };
}

// 费用卡就绪等待的有界默认（仅在已打开页面上被动重读 DOM：不 reload、不点击、不导航、零网络请求）。
const DEFAULT_READINESS_TIMEOUT_MS = 60000;
const DEFAULT_READINESS_INTERVAL_MS = 3000;
// 独立硬限次（与墙钟 deadline 双保险）：仅在"墙钟单调前进"时才靠 deadline 收敛；一旦 nowFn
// 冻结/回拨（或 interval 非法导致 deadline 永不越过），必须靠限次收敛，绝不空转。
// maxAttempts = ceil(timeout/interval)+1，并夹到 [1, MAX_READINESS_ATTEMPTS]。
const MAX_READINESS_ATTEMPTS = 1000;

/** 归一化有限正毫秒：非有限（NaN/Infinity）或非正（0/负数）一律回落默认值（避免 0 造成零等待、
 *  负数造成不死循环/忙等）。 */
function sanitizePositiveMs(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

/** 已知投放类型（来自首页 summaryCard 分项实测：乘方+标准+全域+品牌=整体）。 */
const KNOWN_AD_TYPES = [
  { type: 'overall', label: '乘方', entry: '导航"乘方"（/uni-prom/overall）' },
  { type: 'standard', label: '标准投放', entry: '全域投放页二级 tab"标准投放"（/promotion-v2/standard）' },
  { type: 'uni_promotion', label: '全域投放', entry: '导航"全域投放"（/uni-prom）' },
  { type: 'brand', label: '品牌投放', entry: '导航"品牌投放"' },
];

// ── 纯逻辑（可隔离测试）───────────────────────────────────────────

/** 从 summaryCard 文本提取账户整体消耗（"账户整体消耗(元)14.98相比上周期+70.03%"）。 */
function extractConsumeCentsFromCardText(text) {
  const m = /账户整体消耗\(元\)\s*([\d,]+(?:\.\d+)?)/.exec(text || '');
  if (!m) return { ok: false, reason: `卡片文本中未找到「${CONSUME_LABEL}(元)」数值: ${JSON.stringify((text || '').slice(0, 80))}` };
  const parsed = parseMoneyCents(m[1]);
  if (!parsed.ok) return { ok: false, reason: `消耗数值解析失败: ${JSON.stringify(m[1])}（${parsed.reason}）` };
  return { ok: true, cents: parsed.cents, rawText: m[1] };
}

/** 核验统计周期 datepicker 两个 input 均为当天（上海）。 */
function verifyStatPeriod(values, nowMs) {
  const today = shanghaiDate(nowMs);
  if (!Array.isArray(values) || values.length < 2) {
    return { ok: false, reason: `统计周期控件未读到起止日期（实测 ${JSON.stringify(values)}）` };
  }
  const [s, e] = values;
  if (s !== today || e !== today) {
    return { ok: false, reason: `统计日期不是当天：统计周期实测 ${s} ~ ${e}，当前上海日期 ${today}` };
  }
  return { ok: true, businessDate: today };
}

/**
 * 单次**被动**探测千川首页费用就绪（绝不点击/滚动/reload/导航/网络请求）：
 * 读取统计周期 datepicker 与"账户整体消耗"卡片，返回两条守卫的判定与原始文本。
 * ready = 同一轮内统计周期为当天（上海）**且**卡片存在**且**数值可解析；
 * 任一不满足都视为未就绪（尤其严禁在周期为昨日/延期 UI 时直接采信）。
 */
async function probeQianchuanConsumeReadiness(target, nowMs) {
  const period = await target.evaluate(() => {
    const wrap = document.querySelector('[class*="report-shortcuts-datepicker"]');
    if (!wrap) return null;
    return [...wrap.querySelectorAll('input')].map((i) => i.value);
  }).catch(() => null);
  const scope = verifyStatPeriod(period, nowMs);

  const cardText = await target.evaluate(() => {
    const cards = document.querySelectorAll('[class*="summaryCard"]');
    for (const c of cards) {
      const tx = (c.textContent || '').replace(/\s+/g, ' ').trim();
      if (tx.includes('账户整体消耗')) return tx;
    }
    return null;
  }).catch(() => null);
  const parsed = cardText
    ? extractConsumeCentsFromCardText(cardText)
    : { ok: false, reason: `千川首页未找到"${CONSUME_LABEL}(元)"卡片（不替换成余额/预算/其他消耗指标）` };

  return { period, scope, cardText, parsed, ready: scope.ok === true && !!cardText && parsed.ok === true };
}

/** 就绪上界失败时，按真实 DOM 事实给出与严格解析一致的 DataGuard 原因（不臆造数值）。 */
function readinessFailureReason(last) {
  if (!last || !last.scope || last.scope.ok !== true) return (last && last.scope && last.scope.reason) || '千川统计周期未就绪';
  if (!last.cardText) return `千川首页未找到"${CONSUME_LABEL}(元)"卡片（不替换成余额/预算/其他消耗指标）`;
  if (!last.parsed || last.parsed.ok !== true) return (last.parsed && last.parsed.reason) || '消耗数值解析失败';
  return '千川首页费用卡片未就绪';
}

/**
 * 有界被动就绪等待：在 openQianchuanHome 的固定等待之后，仅在**已存在的页面**上重复探测，
 * 直到（同一轮）统计周期为当天且"账户整体消耗(元)"卡片可解析，或到达上界。
 * 到达上界返回 { ok:false, reason }（调用方按 DataGuardError 处理），绝不部分采信。
 * 依赖注入：nowFn/sleep 可注入（离线测试）；默认 sleep 用 target.waitForTimeout（纯等待，无副作用）。
 */
async function waitForQianchuanConsumeReady(target, opts = {}) {
  // 有限正参数归一化：非法 timeout/interval（0/负数/NaN/Infinity/非数）一律回落默认值，
  // 避免 0 造成零次等待、负数造成忙等。
  const timeoutMs = sanitizePositiveMs(opts.timeoutMs, DEFAULT_READINESS_TIMEOUT_MS);
  const intervalMs = sanitizePositiveMs(opts.intervalMs, DEFAULT_READINESS_INTERVAL_MS);
  const nowFn = opts.nowFn || (() => Date.now());
  const sleep = opts.sleep || ((ms) => target.waitForTimeout(ms));
  // 独立硬限次：即使 nowFn 冻结/回拨（deadline 永不越过）也保证有限次探测后收敛。
  const maxAttempts = Math.max(1, Math.min(MAX_READINESS_ATTEMPTS, Math.ceil(timeoutMs / intervalMs) + 1));
  const deadline = nowFn() + timeoutMs;
  let last = null;
  let attempts = 0;
  for (;;) {
    last = await probeQianchuanConsumeReadiness(target, nowFn());
    attempts += 1;
    if (last.ready) return { ok: true, attempts, period: last.period, cardText: last.cardText, cents: last.parsed.cents };
    if (attempts >= maxAttempts) break;                 // 硬限次上界：冻结/回拨时钟下也收敛
    if (!(nowFn() + intervalMs <= deadline)) break;     // 墙钟上界：再等也会越过上界，不再空转
    await sleep(intervalMs);
  }
  return { ok: false, attempts, reason: readinessFailureReason(last) };
}

/** "更新于：09-13 11:17" → 补当前年份。 */
function normalizeQcUpdatedAt(text, nowMs) {
  const m = /更新于[：:]\s*(\d{2})-(\d{2})\s+(\d{2}:\d{2})/.exec(text || '');
  if (!m) return null;
  const year = new Date(nowMs).getFullYear();
  return `${year}-${m[1]}-${m[2]} ${m[3]}:00（千川"数据概览"区块更新时间，+08:00）`;
}

/** 从详情页文本提取计划ID（"计划ID：1794726122856516"），提取与比对分离保证精确。 */
function extractPlanIdFromDetail(text) {
  const m = /计划\s*ID[：:]\s*(\d{8,20})(?!\d)/.exec(text || '');
  return m ? m[1] : null;
}

/** 行内计划 ID（标准投放行："…日常销售托管ID:1813702913164419…"；无空格格式，避免误取达人"ID: 79863866"）。 */
function extractInlinePlanId(rowText) {
  const matches = [];
  const re = /ID[:：](\d{12,20})(?!\d)/g;
  let m;
  while ((m = re.exec(rowText || ''))) matches.push(m[1]);
  const uniq = [...new Set(matches)];
  if (uniq.length === 0) return { ok: false, reason: '行内无计划ID文本' };
  if (uniq.length > 1) return { ok: false, reason: `行内出现多个候选ID: ${uniq.join(',')}，无法唯一定位` };
  return { ok: true, planId: uniq[0] };
}

/** 千川行状态词归一化（实测词表；词表外返回 null，调用方 fail-closed）。 */
const QC_STATUS_WORDS = ['投放中', '已暂停', '已终止', '已结束', '审核中', '已下线', '未投放', '投放完成', '预算不足', '已拒绝', '暂停中', '已删除'];
function mapRowStatus(rowText) {
  for (const w of QC_STATUS_WORDS) {
    if ((rowText || '').includes(w)) return w;
  }
  return null;
}

/**
 * 可关闭语义（页面证据分离"投放开关状态"与"运行状态"）：
 * - 开关开启（switchChecked===true）= 处于投放侧 → 关闭目标（无论运行状态词、无论是否零消耗）；
 * - 开关未开启（false）= 已在关闭侧 → 无需操作；
 * - 开关未知（null/缺失）= 不得当作已关闭，也不得静默漏掉 → 计入覆盖缺口/未知侧。
 * 运行状态词仅作记录，不替代开关证据。
 */
const closableSideOf = closableSideOfAd;

/**
 * 覆盖表组装与完整性判定（纯函数）。
 * @param results 逐类型读取结果 [{type, total, rowsRead, withId, unresolvedCount, pagesVisited, pageFailures, truncated}]
 * @param configuredTypes 本次配置要读取的类型
 * @returns {{coverage, coverageGaps, complete}}
 */
function buildCoverage(results, configuredTypes, knownTypes = KNOWN_AD_TYPES) {
  const coverage = [];
  const gaps = [];
  let complete = true;
  for (const r of results || []) {
    const expectedRows = r.total;
    const rowDeficit = expectedRows !== null && expectedRows !== undefined && expectedRows !== r.rowsRead;
    const typeComplete = !rowDeficit && r.unresolvedCount === 0 && r.pageFailures === 0 && r.truncated !== true;
    coverage.push({
      type: r.type,
      entry: r.entry,
      total: expectedRows,
      rowsRead: r.rowsRead,
      withId: r.withId,
      unresolvedCount: r.unresolvedCount,
      pagesVisited: r.pagesVisited,
      complete: typeComplete,
      note: r.note || null,
    });
    if (!typeComplete) {
      complete = false;
      const why = [];
      if (rowDeficit) why.push(`已读 ${r.rowsRead}/${expectedRows} 行`);
      if (r.unresolvedCount > 0) why.push(`${r.unresolvedCount} 行未取得稳定ID`);
      if (r.pageFailures > 0) why.push(`${r.pageFailures} 次翻页/读取失败`);
      if (r.truncated) why.push('达到分页上限被截断');
      gaps.push({ type: r.type, reason: `类型「${r.type}」读取不完整：${why.join('；')}` });
    }
  }
  // 已知但本次未配置读取的类型 = 覆盖缺口（不能因当天消耗为零就认定没有开启的广告）
  for (const k of knownTypes) {
    if (!configuredTypes.includes(k.type)) {
      complete = false;
      gaps.push({ type: k.type, reason: `类型「${k.label}」（${k.type}）本次未接入读取：费用分项包含该类型，其开启状态未知，不得视为无广告` });
    }
  }
  return { coverage, coverageGaps: gaps, complete };
}

/**
 * 千川首页地址（文档证据：入口新标签 = /home?aavid=<账户ID>）。
 * 账户ID 已知 → 带 ?aavid 的精确直连；账户ID 未知（null）→ **不带账户ID的通用 /home**，
 * 用于同一已登录 Cookie 会话的只读后备，账户在该页运行时由正式调用链发现。
 */
function qianchuanHomeUrl(shopCfg) {
  const accountId = shopCfg && shopCfg.accountId ? String(shopCfg.accountId).trim() : '';
  return `https://qianchuan.jinritemai.com/home${accountId ? `?aavid=${encodeURIComponent(accountId)}` : ''}`;
}

/** 是否已真正落在千川首页（排除登录/授权中转页，避免把登录页当成功）。 */
function isQianchuanHomeUrl(u) {
  return typeof u === 'string' && u.includes(QC_HOME_MARKER) && !/\/login|\/passport|\/signin|sso\.jinritemai/i.test(u);
}

// ── 页面导航胶水（实机验证；browserFactory 可注入用于测试）─────────

/**
 * R41 scope(4)：唯一定位「巨量千川」入口。旧实现 `getByText(...,{exact:false}).first()`
 * 会命中 school.jinritemai 教程/帮助类同文字链接（2026-10-12 敏敏店实测被导航到教程页，
 * 又被上层误报为登录问题）。规则：
 *  1) 先精确文本匹配；0 命中才降级子串匹配（保持旧页面兼容）；
 *  2) 每个候选读取自身最近祖先 <a> 的 href，命中教程/帮助/客服类链接一律排除；
 *  3) 剩余 1 个 → 用它；>1 个 → **拒绝盲点**，如实报"无法唯一定位"；0 个 → 未找到入口。
 * 所有失败原因都是**导航事实**，绝不含"登录失效"字样——导航失败 ≠ 登录过期。
 */
const TUTORIAL_LINK_RE = /school\.jinritemai|doudian\/web\/article|\/help\/|tutorial|kefu/i;

async function entryCandidateHref(loc) {
  try {
    return await loc.evaluate((el) => {
      const a = el && el.closest ? el.closest('a') : null;
      return a && a.href ? String(a.href) : '';
    });
  } catch (_) { return ''; }
}

async function locateQianchuanEntry(page) {
  for (const mode of ['exact', 'contains']) {
    const loc = page.getByText('巨量千川', { exact: mode === 'exact' });
    const count = await loc.count().catch(() => 0);
    const chosen = [];
    for (let i = 0; i < count; i += 1) {
      const cand = loc.nth(i);
      const href = await entryCandidateHref(cand);
      if (href && TUTORIAL_LINK_RE.test(href)) continue;
      chosen.push(cand);
    }
    if (chosen.length === 1) return { ok: true, locator: chosen[0], matchMode: mode };
    if (chosen.length > 1) return { ok: false, reason: 'ambiguous', matchMode: mode, matchedCount: chosen.length };
  }
  return { ok: false, reason: 'not-found' };
}

/**
 * 抖店首页 → 点"巨量千川" → 千川首页（只读导航，有界重试）。
 *
 * 2026-09-21 实测：入口点击偶发"点击已派发但既不弹新标签也不导航"（当晚 21:00 实录：
 * target.url() 仍为 https://fxg.jinritemai.com/ffa/mshop/homepage/index → 整轮
 * "操作前重新读取"作废、零请求）。同一入口 19:35/20:09/20:42 三轮均正常，属间歇性。
 * 该步只读，因此：入口点击最多 3 次（每次回抖店首页重试，关掉非千川残留标签），
 * 再用同一已登录 Cookie 上下文直连兜底一次。直连必须落在千川首页且非登录页；
 * 否则如实失败（绝不把空页/登录页当作千川）。
 *
 * 2026-10-12 敏敏店实测新增判据：顶部「巨量千川」是 **无 href 的 JS 菜单**
 * （index_menuItem/index_menuTitle/menu-label DIV/SPAN），点击后本店会被带到
 * school 文章（doudian/web/article...）——这不是「瞬态无导航」，重复点击同一入口
 * 只会反复进教程（实录连点 3 次都到同一教程）。因此点击已确认被带到 school/帮助
 * 教程页时**立即结束同一入口重试**，直接转有界只读后备；只有真正的瞬态无导航才保留
 * 原有的多轮重试。
 *
 * 后备是**同一 context 的只读直连**：账户ID 已知时用既有 ?aavid 地址（并由既有 live
 * 校验把关）；账户ID 未知（accountId=null，新店/未绑定）时 qianchuanHomeUrl 返回
 * **不带账户ID的通用 /home**，账户由后续正式调用链在该页运行时（严格唯一头部）发现
 * 并与本店 Cookie 会话绑定。它不解析/复制 Cookie 值、不开另一 Cookie 会话、
 * 不借用他店身份、不填任意账号、不硬编码店名/账号——当此页是登录页时 isQianchuanHomeUrl
 * 会拒绝，绝不把登录页当成功。
 *
 * @returns {{ok:boolean, target?:object, url:string, mode?:string, attempts?:number, reason?:string}}
 */
async function reachQianchuanHome({ page, context, shopCfg }) {
  let lastUrl = null;
  let lastReason = '点击"巨量千川"后未到达千川';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    const located = await locateQianchuanEntry(page);
    if (!located.ok) {
      lastUrl = page.url();
      lastReason = located.reason === 'ambiguous'
        ? `无法唯一定位"巨量千川"入口（${located.matchMode} 匹配 ${located.matchedCount} 个候选）：停止导航，绝不盲点`
        : '抖店首页未找到"巨量千川"入口';
      continue;
    }
    const entry = located.locator;
    let clickErr = null;
    try {
      await entry.click({ timeout: 15000 });
    } catch (e) {
      clickErr = e;
    }
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const target = popup && !popup.isClosed() ? popup : page;
    await target.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await target.waitForTimeout(8000);
    const url = target.url();
    if (isQianchuanHomeUrl(url)) return { ok: true, target, url, mode: 'entry-click', attempts: attempt };
    lastUrl = url;
    lastReason = clickErr ? `点击"巨量千川"未成功：${(clickErr && clickErr.message) || clickErr}` : '点击"巨量千川"后未到达千川';
    // 非千川的残留标签先关掉，避免干扰下一次尝试（主页面保留）
    if (target !== page) await target.close().catch(() => {});
    // 点击已确认被带到 school/帮助教程页：结束同一入口重试（不再连点 3 次），转只读后备。
    if (!clickErr && TUTORIAL_LINK_RE.test(String(url || ''))) break;
  }
  // 有界只读后备（同 Cookie 上下文）：账户ID 未知时打开**不带账户ID的通用 /home**，
  // 供正式调用链在该页运行时严格唯一头部发现账户并与本店绑定。
  await page.goto(qianchuanHomeUrl(shopCfg), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const url = page.url();
  if (isQianchuanHomeUrl(url)) return { ok: true, target: page, url, mode: 'direct-home-url', attempts: 4 };
  lastUrl = url;
  lastReason = `${lastReason}（直连千川首页兜底亦未到达）`;
  return { ok: false, url: lastUrl || (page.url && page.url()) || '', reason: lastReason };
}

/**
 * 登录失效正证据判定：**只认 UI 语义结构**——明确登录页 URL、真实登录表单
 * （password/passport 输入）、登录 dialog、可见语义登录控件（button/role=button/
 * INPUT button|submit，或位于 form/dialog/login 容器内的 A）。
 * 教程/帮助正文出现「扫码登录」等字样**绝不是**失效证据：任何 body 文本 includes
 * 都不参与判定；普通段落、隐藏控件、纯文字链接一律按导航事实处理。
 * 本函数内嵌的页面探针会被序列化到真实页面上下文执行，必须自包含（无外部闭包）。
 */
async function collectLoginExpiryEvidence(page) {
  const url = String(typeof page.url === 'function' ? page.url() : '');
  const ev = {
    loginUrl: /\/login|passport|signin|sso\.[a-z]*jinritemai|account\.[a-z]*doudian|verify.*login/i.test(url),
    loginFormVisible: false, loginControlVisible: false, loginDialogVisible: false,
  };
  if (ev.loginUrl) return ev;
  try {
    const probe = await page.evaluate(() => {
      const needles = ['扫码登录', '登录抖音', '立即登录', '手机号登录', '请先登录'];
      const out = { loginForm: false, loginControl: false, loginDialog: false };
      const visible = (el) => {
        try {
          if (typeof getComputedStyle === 'function') {
            const cs = getComputedStyle(el);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
          }
        } catch (_) { /* 样式不可得：保守视为可见 */ }
        return true;
      };
      const isControl = (el) => {
        const tag = String((el && el.tagName) || '').toUpperCase();
        let role = '';
        try { role = String((el && typeof el.getAttribute === 'function' && el.getAttribute('role')) || '').toLowerCase(); } catch (_) { role = ''; }
        if (role === 'button' || tag === 'BUTTON') return true;
        if (tag === 'INPUT') { let t = ''; try { t = String(el.type || '').toLowerCase(); } catch (_) {} return t === 'button' || t === 'submit'; }
        if (tag === 'A') { try { return !!(el.closest && el.closest('form, [role="dialog"], [class*="login"], [class*="passport"]')); } catch (_) { return false; } }
        return false;
      };
      const ctaText = (el) => {
        let txt = '';
        try { txt = String((el && (el.innerText || el.value || el.textContent)) || '').replace(/\s+/g, ' ').trim(); } catch (_) { txt = ''; }
        return txt.length > 0 && txt.length <= 12 && needles.some((n) => txt.includes(n));
      };
      try {
        if (typeof document.querySelector === 'function' && document.querySelector('input[type="password"], form [name*="passport"], [class*="login-form"] input')) out.loginForm = true;
      } catch (_) { /* 探针降级 */ }
      try {
        const dlgs = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('[role="dialog"], dialog') : [];
        for (let i = 0; i < dlgs.length; i += 1) {
          let t = '';
          try { t = String((dlgs[i] && (dlgs[i].innerText || dlgs[i].textContent)) || ''); } catch (_) { t = ''; }
          if (needles.some((n) => t.includes(n)) && visible(dlgs[i])) { out.loginDialog = true; break; }
        }
      } catch (_) { /* 探针降级 */ }
      try {
        const nodes = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]') : [];
        for (let i = 0; i < nodes.length; i += 1) {
          if (ctaText(nodes[i]) && visible(nodes[i])) { out.loginControl = true; break; }
        }
      } catch (_) { /* 探针降级 */ }
      return out;
    });
    if (probe && typeof probe === 'object') {
      ev.loginFormVisible = probe.loginForm === true;
      ev.loginControlVisible = probe.loginControl === true;
      ev.loginDialogVisible = probe.loginDialog === true;
    }
  } catch (_) { /* 页面不可达或探针失败：不是登录证据 */ }
  const locProbe = async (factory) => {
    try {
      const node = typeof factory === 'function' ? factory() : null;
      if (node && typeof node.count === 'function' && (await node.count()) > 0) {
        const vis = node.isVisible ? (await node.isVisible().catch(() => false)) : false;
        return vis === true;
      }
    } catch (_) { /* 控件不可得 */ }
    return false;
  };
  if (!ev.loginControlVisible && typeof page.getByRole === 'function') {
    ev.loginControlVisible = await locProbe(() => page.getByRole('button', { name: '扫码登录' }));
  }
  if (!ev.loginFormVisible && typeof page.locator === 'function') {
    ev.loginFormVisible = await locProbe(() => page.locator('input[type="password"]'));
  }
  if (!ev.loginControlVisible && typeof page.getByText === 'function' && typeof page.evaluate === 'function') {
    try {
      const node = page.getByText('扫码登录');
      if (node && typeof node.count === 'function' && (await node.count()) > 0 && node.isVisible && (await node.isVisible().catch(() => false)) === true && typeof node.evaluate === 'function') {
        const sem = await node.evaluate((el) => {
          const tag = String((el && el.tagName) || '').toUpperCase();
          let role = '';
          try { role = String((el && typeof el.getAttribute === 'function' && el.getAttribute('role')) || '').toLowerCase(); } catch (_) { role = ''; }
          if (role === 'button' || tag === 'BUTTON') return true;
          if (tag === 'INPUT') { let t = ''; try { t = String(el.type || '').toLowerCase(); } catch (_) {} return t === 'button' || t === 'submit'; }
          if (tag === 'A') { try { return !!(el.closest && el.closest('form, [role="dialog"], [class*="login"], [class*="passport"]')); } catch (_) { return false; } }
          return false;
        });
        ev.loginControlVisible = sem === true;
      }
    } catch (_) { ev.loginControlVisible = ev.loginControlVisible === true; }
  }
  return ev;
}

/**
 * Cookie → 抖店首页 → 登录检查 → 点"巨量千川" → 千川落地页。
 * 任意初始化失败都会关闭本次创建的浏览器后抛错；成功返回后由调用者负责释放。
 */
async function openQianchuanHome(loginCfg, shopCfg, opts = {}) {
  let browser = null;
  let context = null;
  try {
    const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
    // 会话 Cookie 回写所需的元信息（2026-09-16 用户明确授权）：
    // 记录**本次实际加载的精确文件路径**与会话开始时的指纹（size/mtime/sha256）。
    // 指纹用于回写前的冲突保护：会话期间用户重新登录/其他进程写入 → 保留较新文件。
    // 这里只记录路径与指纹，不读取、不输出任何 Cookie 值。
    const cookieSession = {
      filePath: resolved.path,
      dir: resolved.dir,
      readOnly: resolved.readOnly,
      startFingerprint: fingerprintFile(resolved.path),
    };
    if (opts.browserFactory) {
      browser = await opts.browserFactory();
    } else {
      const { chromium } = require('playwright');
      browser = await chromium.launch({
        headless: opts.headless !== false,
        executablePath: loginCfg.edgePath,
        args: ['--window-size=1920,1080'],
      });
    }
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    const cookies = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    // R51：自动 SSO 中转（/login/common → 首页，实测 ~30s）不得在 5s 处被判伪过期。
    // 先有界被动收敛（仅轮询地址，零点击/零导航/零请求）；收敛成功才继续既有链路；
    // 上界到达才做登录正证据分类（真过期仍 AuthError；其余按导航事实 DataGuard）。
    const settled = await waitForDoudianHomepageSettled(page, opts);
    if (!settled.ok) {
      if (settled.reason === 'settle-page-closed') {
        throw new DataGuardError(`抖店主页面在自动登录收敛期内被关闭（最后地址 ${settled.url || '未知'}）；按导航事实处理，需人工核实`);
      }
      const evidence = await collectLoginExpiryEvidence(page);
      if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
        throw new AuthError(`登录失效：抖店页面在 ${settled.attempts} 次有界收敛（上限 ${Math.round(sanitizePositiveMs(opts.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS) / 1000)}s）后仍命中登录页地址或可见登录控件/表单（当前 ${page.url()}），请重新扫码登录`);
      }
      throw new DataGuardError(`抖店主页面在有界自动登录收敛期内未到达首页（${settled.attempts} 次探测，当前 ${settled.url || page.url()}）；未见登录正证据，按导航事实处理，需人工核实`);
    }
    const reached = await reachQianchuanHome({ page, context, shopCfg });
    if (!reached.ok) {
      throw new DataGuardError(`${reached.reason}（当前: ${reached.url}）；若需额外登录/授权请先人工完成一次`);
    }
    const target = reached.target;
    return { browser, context, page, target, cookieSession, navMode: reached.mode };
  } catch (e) {
    // 任意初始化失败：关闭本次创建的浏览器，再抛出原始错误
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

async function closeBrowser(browser) {
  await browser.close().catch(() => {});
}

/** 读取千川头部账户 ID 与账户名。 */
async function readQianchuanAccountId(target) {
  return target.evaluate(() => {
    const out = { accountId: null, accountName: null };
    const nameEl = document.querySelector('[class*="shop-name"]');
    if (nameEl) {
      const t = (nameEl.textContent || '').trim();
      const m = /ID[:：]\s*(\d{8,20})/.exec(t);
      if (m) out.accountId = m[1];
      else if (t && !/^ID/.test(t)) out.accountName = t;
    }
    if (!out.accountId) {
      const m = /ID[:：]\s*(\d{8,20})/.exec(document.body ? document.body.innerText : '');
      if (m) out.accountId = m[1];
    }
    return out;
  }).then((r) => (r && r.accountId ? { accountId: r.accountId, accountName: r.accountName || null } : null)).catch(() => null);
}

// ── 页面内行收集（生产函数，供 evaluate 与 DOM fixture 测试共用）────

/**
 * 在千川计划列表页 DOM 中收集当前页的计划行。
 * 只收含投放开关（.oc-switch）的 tr.ovui-tr（排除表头/汇总行）；
 * 计划名取 oc-typography-value-int；开关选中态 = oc-switch--checked；
 * 行内计划ID（标准投放行）与行文本一并返回；每行带 rowIndex（供行定位）。
 */
function collectQianchuanRowsInPage() {
  const out = { rows: [], total: null };
  const m = /共\s*(\d+)\s*条记录|共\s*(\d+)\s*条/.exec(document.body.innerText || '');
  if (m) out.total = Number(m[1] || m[2]);
  const trs = document.querySelectorAll('tr.ovui-tr');
  let rowIndex = 0;
  for (const tr of trs) {
    if (String(tr.className || '').includes('ovui-t-summary')) continue;
    const sw = tr.querySelector('.oc-switch');
    if (!sw) continue; // 表头/非计划行
    const nameEl = tr.querySelector('[class*="oc-typography-value-int"]');
    let name = nameEl ? (nameEl.textContent || '').trim() : null;
    const rowText = (tr.textContent || '').replace(/\s+/g, ' ');
    // 标准投放行的第一个 typography 元素可能是预算列（如 "5,000.00"）——
    // 此时从行文本首段提取计划名（到行内 ID 或动作词之前）
    if (!name || /^[\d,.\-]+$/.test(name)) {
      const nm = /^(.*?)\s*(?:ID[:：]\s*\d{12,20}|编辑|复制|已终止|已暂停|投放中)/.exec(rowText);
      name = nm && nm[1].trim() ? nm[1].trim().slice(0, 60) : name;
    }
    const swCls = String(sw.className || '');
    out.rows.push({
      rowIndex,
      name,
      switchChecked: swCls.includes('oc-switch--checked'),
      rowText: rowText.slice(0, 400),
    });
    rowIndex += 1;
  }
  return out;
}

// ── 费用读取器 ────────────────────────────────────────────────────

function createQianchuanCostReader(p) {
  const loginCfg = p.loginCfg;
  const nowFn = p.nowFn || (() => Date.now());
  const evidenceDir = p.evidenceDir || path.join(__dirname, '..', '..', 'evidence');
  // 会话开启可注入（离线测试）：默认仍是真实 openQianchuanHome；注入仅替换入口，不改任何守卫。
  const openSession = p.openSession || openQianchuanHome;
  return {
    connected: true,
    source: 'promo-page',
    kind: 'cost',
    async readCostSummary({ shopCfg }) {
      const { browser, target } = await openSession(loginCfg, shopCfg, p);
      try {
        // Cookie 文件绑定决定店铺归属；页面账户 ID 仅为可选观测，缺失/不同均不得拒绝费用数据。
        const acct = await readQianchuanAccountId(target);
        const accountId = acct && acct.accountId ? acct.accountId : null;

        // 有界被动就绪等待（客户实测：卡片/周期延时导致 04:15、13:41 UTC 即刻漏读）：
        // 固定初等等待后仅在已打开页面上重读 DOM，等**同一轮**周期=当天且账户整体消耗卡可解析；
        // 上界到达即按 DataGuard 失败（零请求、不替换余额、不放宽任何守卫）。
        const ready = await waitForQianchuanConsumeReady(target, {
          timeoutMs: p.readinessTimeoutMs,
          intervalMs: p.readinessIntervalMs,
          nowFn,
          sleep: p.sleep,
        });
        if (!ready.ok) throw new DataGuardError(ready.reason);

        const period = await target.evaluate(() => {
          const wrap = document.querySelector('[class*="report-shortcuts-datepicker"]');
          if (!wrap) return null;
          return [...wrap.querySelectorAll('input')].map((i) => i.value);
        }).catch(() => null);
        const scope = verifyStatPeriod(period, nowFn());
        if (!scope.ok) throw new DataGuardError(scope.reason);

        const cardText = await target.evaluate(() => {
          const cards = document.querySelectorAll('[class*="summaryCard"]');
          for (const c of cards) {
            const tx = (c.textContent || '').replace(/\s+/g, ' ').trim();
            if (tx.includes('账户整体消耗')) return tx;
          }
          return null;
        }).catch(() => null);
        if (!cardText) {
          throw new DataGuardError('千川首页未找到"账户整体消耗(元)"卡片（不替换成余额/预算/其他消耗指标）');
        }
        const parsed = extractConsumeCentsFromCardText(cardText);
        if (!parsed.ok) throw new DataGuardError(parsed.reason);

        const updatedAtRaw = await target.evaluate(() => {
          const el = document.querySelector('[class*="refreshTime"]');
          return el ? (el.textContent || '').trim() : null;
        }).catch(() => null);
        const pageUpdatedAt = normalizeQcUpdatedAt(updatedAtRaw || '', nowFn());

        try {
          if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
          await target.screenshot({ path: path.join(evidenceDir, `qc-cost-${Date.now()}.png`), timeout: 8000 });
        } catch (_) { /* 不阻塞 */ }

        // 分项消耗（覆盖表依据：账户整体=乘方+标准+全域+品牌）
        const breakdown = await target.evaluate(() => {
          const out = [];
          for (const c of document.querySelectorAll('[class*="summaryCard"]')) {
            const tx = (c.textContent || '').replace(/\s+/g, ' ').trim();
            const m = /(乘方计划消耗|标准投放消耗|全域投放消耗|品牌投放消耗|账户整体消耗)\(元\)\s*([\d,]+(?:\.\d+)?)/.exec(tx);
            if (m) out.push({ item: m[1], raw: m[2] });
          }
          return out;
        }).catch(() => []);

        return {
          source: 'promo-page',
          kind: 'cost',
          shopId: shopCfg.id,
          shopIdAttribution: '配置归因：千川页不展示店铺ID/店铺名；shopId 取自配置，身份经"抖店首页入口授权进入该千川账户"链路核验',
          accountId,
          accountName: (acct && acct.accountName) || null,
          accountIdAttribution: accountId
            ? '页面可选观测：千川头部 ID 元素（class shop-name）/正文 ID 兜底；不参与费用采集聚属'
            : '页面未读到账户ID（可选观测缺失，不阻断费用采集；归属以 shopCfg.cookieFile 为准）',
          businessDate: scope.businessDate,
          dateScopeEvidence: `统计周期 datepicker 实测 ${JSON.stringify(period)}（当天单日）`,
          fetchedAt: new Date(nowFn()).toISOString(),
          pageUpdatedAt,
          pageUpdatedAtNote: pageUpdatedAt ? null : '千川页未见更新时间',
          rawText: parsed.rawText,
          cardText,
          breakdown,
          coverageNote: '账户整体消耗包含乘方/标准投放/全域投放/品牌投放四分项（实测之和吻合）；'
            + '页面未发现账户切换器；账户与店铺绑定经抖店首页入口授权链路（页面不展示店铺名/店铺ID，属间接证据）',
          valueCents: parsed.cents,
        };
      } finally {
        await closeBrowser(browser);
      }
    },
  };
}

// ── 广告清单读取器（多类型覆盖 + 行绑定 ID + 完整性元数据）─────────

const ADS_PAGE_SIZE = 10;

/** 类型入口定义：navigate(ctx,target) 在当前千川 tab 内进入该类型列表页。 */
const AD_TYPE_ENTRIES = {
  uni_promotion: async (target) => {
    await target.evaluate(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_uni_promotion/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    });
    await target.waitForTimeout(10000);
  },
  standard: async (target) => {
    // 先到全域投放页，再点二级 tab"标准投放"
    await target.evaluate(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_uni_promotion/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    });
    await target.waitForTimeout(9000);
    const clicked = await target.evaluate(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '标准投放';
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.y < 250; });
      if (el) { el.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) throw new DataGuardError('未找到"标准投放"二级 tab');
    await target.waitForTimeout(10000);
    await target.waitForFunction(() => /promotion-v2\/standard/.test(location.href), { timeout: 15000 }).catch(() => {});
  },
  brand: async (target) => {
    // 实测（2026-09-13）：/brand_bid/promotion/standard，标题"推广管理"；
    // 本账户"共0条"、0 开关、消耗 0.00 —— 完整空清单证据，可认定无对象。
    await target.evaluate(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /brand_promotion/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    });
    await target.waitForTimeout(10000);
    await target.waitForFunction(() => /brand_bid/.test(location.href), { timeout: 15000 }).catch(() => {});
  },
};

function createQianchuanAdListReader(p) {
  const loginCfg = p.loginCfg;
  const nowFn = p.nowFn || (() => Date.now());
  const evidenceDir = p.evidenceDir || path.join(__dirname, '..', '..', 'evidence');
  const configuredTypes = (p.adTypes && p.adTypes.length ? p.adTypes : ['uni_promotion', 'standard']);
  // 快照缓存：以调用方 scanId 为键（同一次分页扫描复用同一快照；
  // scanId 变化=强制新扫描，操作前重核/终态回读各自取得新快照，不依赖 TTL）。
  let cache = null; // {shopKey, scanId, data}

  /**
   * 读取单个类型列表：逐页收集行。跨页按行内计划ID精确去重（同一计划翻页重叠
   * 不得重复计入；同名不同ID的计划保留为独立行，不按名称合并）。
   * 返回 {rows, total, pagesVisited, pageFailures, truncated, dupSkipped}。
   */
  async function collectTypeRows(context, target, type) {
    const entry = AD_TYPE_ENTRIES[type];
    if (!entry) throw new DataGuardError(`未知千川投放类型: ${type}`);
    await entry(target);
    const rows = [];
    let total = null;
    let pagesVisited = 0;
    let pageFailures = 0;
    let truncated = false;
    let dupSkipped = 0;
    const maxPages = (p.maxAdPages ?? 50);
    const seenKeys = new Set();
    while (pagesVisited < maxPages) {
      const appeared = await target.waitForFunction(() => document.body && /共\s*\d+\s*条/.test(document.body.innerText), { timeout: 20000 }).then(() => true).catch(() => false);
      if (!appeared) { pageFailures += 1; break; }
      pagesVisited += 1;
      const pageData = await target.evaluate(collectQianchuanRowsInPage).catch(() => null);
      if (!pageData) { pageFailures += 1; break; }
      if (total === null && pageData.total !== null) total = pageData.total;
      for (const row of pageData.rows) {
        const inline = extractInlinePlanId(row.rowText);
        // 去重键：行内计划ID（精确）；无行内ID时用行文本前缀（全域行详情解析在后续步骤，逐行独立）
        const key = inline.ok ? `id:${inline.planId}` : `txt:${row.rowText.slice(0, 150)}`;
        if (seenKeys.has(key)) { dupSkipped += 1; continue; }
        seenKeys.add(key);
        rows.push({ ...row, adType: type, pageVisit: pagesVisited });
      }
      // 翻页判定：以 total 对账；无下一页可点 = 到末页
      const expectedPages = total !== null ? Math.ceil(total / ADS_PAGE_SIZE) : null;
      if (expectedPages !== null && pagesVisited >= expectedPages) break;
      if (pagesVisited >= maxPages) { truncated = true; break; }
      const clicked = await target.evaluate(() => {
        // 实测分页结构：ul.ovui-page-turner > li.ovui-page-turner__item，
        // 下一页 = 含 .ovui-page-turner__next-icon 的 li（禁用态带 --disabled 类）。
        // 事件绑定在 li 上，点内部 svg 图标不会翻页（实测踩坑）。
        const lis = document.querySelectorAll('li.ovui-page-turner__item');
        for (const li of lis) {
          if (!li.querySelector('.ovui-page-turner__next-icon')) continue;
          if (String(li.className || '').includes('--disabled')) return false; // 到末页
          li.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (!clicked) break;
      await target.waitForTimeout(6000);
    }
    return { rows, total, pagesVisited, pageFailures, truncated, dupSkipped };
  }

  /** 当场解析某行稳定ID：优先行内ID（标准投放），否则点击该行计划名进详情（全域投放）。 */
  async function resolveRowPlanId(context, target, type, row) {
    const inline = extractInlinePlanId(row.rowText);
    if (inline.ok) return { planId: inline.planId, via: 'row-inline-text' };
    // 详情路径：用行索引精确定位该行，再点行内计划名（同名计划互不影响）
    for (let attempt = 1; attempt <= 2; attempt++) {
      let popup = null;
      const onPopup = (pg) => { popup = pg; };
      context.on('page', onPopup);
      try {
        if (attempt === 2) {
          await target.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await target.waitForTimeout(8000);
        }
        const rowLoc = target.locator('tr.ovui-tr:not(.ovui-t-summary)').filter({ has: target.locator('.oc-switch') }).nth(row.rowIndex);
        const nameLoc = rowLoc.locator('[class*="oc-typography-value-int"]').first();
        await nameLoc.waitFor({ state: 'visible', timeout: 12000 });
        const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
        const navPromise = target.waitForURL(/uni-prom\/detail|adId=\d+/, { timeout: 15000 }).catch(() => null);
        await nameLoc.click({ timeout: 8000 });
        popup = await popupPromise;
        await navPromise;
        await target.waitForTimeout(1500);
        const detailPage = popup && !popup.isClosed() ? popup : target;
        await detailPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await detailPage.waitForTimeout(6000);
        const info = await detailPage.evaluate(() => {
          const body = document.body ? document.body.innerText : '';
          const m = /计划\s*ID[：:]\s*(\d{8,20})(?!\d)/.exec(body);
          const u = /adId=(\d{8,20})(?!\d)/.exec(location.href);
          return { planId: m ? m[1] : (u ? u[1] : null), url: location.href.slice(0, 130) };
        }).catch(() => null);
        if (popup && !popup.isClosed()) await popup.close().catch(() => {});
        else await target.goBack().catch(() => {});
        await target.waitForTimeout(5000);
        // 返回列表位置校验：URL 应回到该类型列表路由
        const backOk = await target.evaluate((t) => {
          const u = location.href;
          if (t === 'standard') return /promotion-v2\/standard/.test(u);
          return /uni-prom/.test(u) && !/detail/.test(u);
        }, type).catch(() => false);
        if (info && info.planId) {
          return { planId: info.planId, via: 'detail-page', backOk };
        }
      } catch (_) {
        if (popup && !popup.isClosed()) await popup.close().catch(() => {});
        else await target.goBack().catch(() => {});
        await target.waitForTimeout(4000);
      } finally {
        context.off('page', onPopup);
      }
    }
    return null;
  }

  return {
    connected: true,
    source: 'promo-page',
    kind: 'ads',
    pageSize: ADS_PAGE_SIZE,
    configuredTypes,
    /**
     * 分页读取。快照语义：同一 scanId 复用同一次完整扫描（避免逐页重复爬取）；
     * scanId 变化/缺失 → 强制新扫描（操作前重核与终态回读各自取得新快照，不靠 TTL）。
     * 快照含 scanId/抓取时间；扫描期间跨日（开始/结束上海日期不一致）→ crossDayScan=true，
     * 上层据此阻止（触发数据为上一日期口径）。
     */
    async listAdPage({ shopCfg, pageNo = 1, scanId = null }) {
      const shopKey = `${shopCfg.id}|${shopCfg.accountId || ''}`;
      const reqScan = scanId || `scan-${nowFn()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!cache || cache.shopKey !== shopKey || cache.scanId !== reqScan) {
        cache = { shopKey, scanId: reqScan, data: await this._collectAll(shopCfg, reqScan) };
      }
      const d = cache.data;
      const start = (pageNo - 1) * ADS_PAGE_SIZE;
      return {
        ...d,
        scanId: d.scanId,
        pageNo,
        hasNext: start + ADS_PAGE_SIZE < d.ads.length,
        ads: d.ads.slice(start, start + ADS_PAGE_SIZE),
      };
    },

    async _collectAll(shopCfg, scanId) {
      const startedAt = nowFn();
      const startedDate = shanghaiDate(startedAt);
      const { browser, context, target } = await openQianchuanHome(loginCfg, shopCfg, p);
      try {
        const acct = await readQianchuanAccountId(target);
        const accountId = acct ? acct.accountId : null;
        const ads = [];
        const typeResults = [];
        for (const type of configuredTypes) {
          let collected;
          try {
            collected = await collectTypeRows(context, target, type);
          } catch (e) {
            typeResults.push({ type, entry: (KNOWN_AD_TYPES.find((k) => k.type === type) || {}).entry || type, total: null, rowsRead: 0, withId: 0, unresolvedCount: 1, pageFailures: 1, truncated: false, note: e.reason || e.message });
            continue;
          }
          let unresolvedCount = 0;
          let withId = 0;
          for (const row of collected.rows) {
            const statusWord = mapRowStatus(row.rowText);
            const side = closableSideOf(row);
            const idInfo = await resolveRowPlanId(context, target, type, row);
            if (!idInfo) {
              unresolvedCount += 1;
              ads.push({
                adId: null, name: row.name, adType: type,
                status: statusWord, switchChecked: row.switchChecked,
                idResolved: false,
                closableNow: side === 'closable', alreadyClosedSide: side === 'closed_side', switchUnknown: side === 'unknown',
                unresolvedReason: '未取得稳定ID（禁止用名称/行号替代）',
              });
              continue;
            }
            withId += 1;
            ads.push({
              adId: idInfo.planId,
              name: row.name,
              adType: type,
              status: statusWord,
              switchChecked: row.switchChecked,
              idResolved: true,
              idVia: idInfo.via,
              backOk: idInfo.backOk,
              closableNow: side === 'closable',
              alreadyClosedSide: side === 'closed_side',
              switchUnknown: false,
            });
          }
          typeResults.push({
            type,
            entry: (KNOWN_AD_TYPES.find((k) => k.type === type) || {}).entry || type,
            total: collected.total,
            rowsRead: collected.rows.length,
            withId,
            unresolvedCount,
            pagesVisited: collected.pagesVisited,
            pageFailures: collected.pageFailures,
            truncated: collected.truncated,
            dupSkipped: collected.dupSkipped,
          });
        }
        const { coverage, coverageGaps, complete } = buildCoverage(typeResults, configuredTypes);
        const statusDistribution = {};
        for (const a of ads) statusDistribution[a.status || '未知'] = (statusDistribution[a.status || '未知'] || 0) + 1;
        try {
          if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
          await target.screenshot({ path: path.join(evidenceDir, `qc-ads-${startedAt}.png`), timeout: 8000 });
        } catch (_) { /* 不阻塞 */ }
        const endedDate = shanghaiDate(nowFn());
        return {
          source: 'promo-page',
          kind: 'ads',
          scanId: scanId || `scan-${startedAt}`,
          scanStartedAt: new Date(startedAt).toISOString(),
          crossDayScan: endedDate !== startedDate,
          scanDates: `${startedDate} → ${endedDate}`,
          shopId: shopCfg.id,
          shopIdAttribution: '配置归因：千川页不展示店铺ID；经抖店首页入口授权链路核验',
          accountId,
          businessDate: endedDate,
          dateScopeEvidence: '全域投放/标准投放列表 URL dr 参数与统计周期均为当天（实测）',
          fetchedAt: new Date(nowFn()).toISOString(),
          ads,
          adCountTotal: ads.length,
          statusDistribution,
          closableCount: ads.filter((a) => a.closableNow === true).length,
          closedSideCount: ads.filter((a) => a.alreadyClosedSide === true).length,
          coverage,
          coverageGaps,
          listComplete: complete,
          listCompleteNote: complete
            ? '配置的投放类型均已完整读取（总数对账一致、无未解析行、无翻页失败）'
            : '清单读取不完整（见 coverageGaps）——不得据此得出"全店可关闭/已关闭"结论',
          statusWordCalibration: '实测词表：全域"已暂停"、标准"已终止"；其他词 fail-closed（状态词不替代开关证据）',
        };
      } finally {
        await closeBrowser(browser);
      }
    },
  };
}

// ── 广告控制器（verifyIdentity/getAd/closeAd；closeAd 本轮硬拒绝）──

function createQianchuanAdController(p) {
  const loginCfg = p.loginCfg;
  const nowFn = p.nowFn || (() => Date.now());
  return {
    connected: true,
    source: 'promo-page',
    closeRealNotVerified: true,
    async verifyIdentity({ shopCfg }) {
      const { browser, target } = await openQianchuanHome(loginCfg, shopCfg, p);
      try {
        const acct = await readQianchuanAccountId(target);
        return {
          ok: Boolean(acct && acct.accountId),
          pageShopId: shopCfg.id,
          pageShopName: shopCfg.compassShopName || shopCfg.name || null,
          pageAccountId: acct ? acct.accountId : null,
          pageAccountName: acct ? acct.accountName : null,
          attribution: '千川页身份=账户ID页面实测 + 抖店首页入口授权链路（页面不展示店铺名/店铺ID）',
          reason: acct && acct.accountId ? null : '千川页面未读到账户ID',
        };
      } finally {
        await closeBrowser(browser);
      }
    },
    /**
     * @param p {page, shopCfg, adId} —— shopCfg 必传（详情页 URL 需要 accountId），统一契约。
     * 返回：found/status/closableNow/alreadyClosedSide/switchUnknown。
     * 精确核验：详情页"计划ID"提取后与 adId 全等比对（无前缀/子串匹配），
     * 并核验详情页账户ID（若有）与配置一致。
     */
    /**
     * 按投放类型分派读取（第六轮）：
     * - uni_promotion（全域手工计划）：直达详情页 /uni-prom/detail?aavid&adId（已实测），
     *   "计划ID"提取后与目标全等比对（无前缀/子串），页面账户与配置比对；
     * - standard / brand：进入对应列表页，按行内计划ID（托管ID）逐页定位行，
     *   读行级状态词 + 开关选中态（详情页不展示开关）；
     * - 其他/未知类型：明确拒绝（不把托管ID当全域计划ID，也不猜测路径）。
     */
    async getAd({ page, shopCfg, adId, adType }) {
      if (!adId || !/^\d{8,20}$/.test(String(adId))) return { found: false };
      if (!adType || !AD_TYPE_ENTRIES[adType]) {
        throw new DataGuardError(`未知投放类型「${adType || '(缺失)'}」：adType 必须与稳定ID 一并贯穿（uni_promotion/standard/brand），拒绝猜测路径`);
      }
      const aavid = String((shopCfg && shopCfg.accountId) || '').trim();
      if (!aavid) throw new AuthError('配置缺少千川账户ID（accountId），无法读取计划状态');
      const { browser, context, target } = await openQianchuanHome(loginCfg, shopCfg, p);
      try {
        if (adType === 'uni_promotion') {
          const url = `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${aavid}&adId=${adId}`;
          await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await target.waitForTimeout(9000);
          const info = await target.evaluate((want) => {
            const body = document.body ? document.body.innerText : '';
            const ids = [];
            const re1 = /计划\s*ID[：:]\s*(\d{8,20})(?!\d)/g;
            let m;
            while ((m = re1.exec(body))) ids.push(m[1]);
            const re2 = /aavid=(\d{8,20})/.exec(location.href);
            const accountOnPage = re2 ? re2[1] : null;
            const status = ['投放中', '已暂停', '已终止', '已结束', '审核中', '已下线', '未投放'].find((w) => body.includes(w)) || null;
            return { pagePlanIds: ids, accountOnPage, status };
          }, String(adId)).catch(() => null);
          if (!info) return { found: false, adType };
          if (!info.pagePlanIds.includes(String(adId))) return { found: false, adType, reason: '详情页计划ID与目标不一致' };
          if (info.accountOnPage && info.accountOnPage !== aavid) {
            return { found: false, adType, reason: `详情页账户(${info.accountOnPage})与配置账户(${aavid})不一致` };
          }
          const closedWords = ['已暂停', '已终止', '已结束', '已下线', '已删除'];
          const alreadyClosedSide = info.status ? closedWords.includes(info.status) : false;
          return {
            found: true,
            adType,
            status: info.status || '未知状态（词表外）',
            switchChecked: null,
            switchUnknown: true,
            switchNote: '全域详情页不展示开关，以状态词判定（列表行开关证据见清单快照）',
            closableNow: info.status ? info.status === '投放中' : false,
            alreadyClosedSide,
            accountIdMatched: true,
          };
        }
        // standard / brand：列表页按行内计划ID 定位行（读状态词 + 开关）
        const entry = AD_TYPE_ENTRIES[adType];
        await entry(target);
        const maxPages = (p.maxAdPages ?? 50);
        for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
          const appeared = await target.waitForFunction(() => document.body && /共\s*\d+\s*条/.test(document.body.innerText), { timeout: 20000 }).then(() => true).catch(() => false);
          if (!appeared) return { found: false, adType, reason: '列表页未渲染' };
          const pageData = await target.evaluate(collectQianchuanRowsInPage).catch(() => null);
          if (!pageData) return { found: false, adType, reason: '行收集失败' };
          for (const row of pageData.rows) {
            const inline = extractInlinePlanId(row.rowText);
            if (inline.ok && inline.planId === String(adId)) {
              const statusWord = mapRowStatus(row.rowText);
              return {
                found: true,
                adType,
                status: statusWord || '未知状态（词表外）',
                switchChecked: row.switchChecked,
                closableNow: row.switchChecked === true,
                alreadyClosedSide: row.switchChecked === false,
                accountIdMatched: true,
              };
            }
          }
          if (pageData.total !== null && pageNo * ADS_PAGE_SIZE >= pageData.total) break;
          const clicked = await target.evaluate(() => {
            const lis = document.querySelectorAll('li.ovui-page-turner__item');
            for (const li of lis) {
              if (!li.querySelector('.ovui-page-turner__next-icon')) continue;
              if (String(li.className || '').includes('--disabled')) return false;
              li.click();
              return true;
            }
            return false;
          }).catch(() => false);
          if (!clicked) break;
          await target.waitForTimeout(6000);
        }
        return { found: false, adType, reason: '列表页逐页未找到该计划ID' };
      } finally {
        await closeBrowser(browser);
      }
    },
    async closeAd() {
      // 本轮不调用真实关闭：realMode=false 时 monitor 不会走到这里；
      // 此处再加一道硬保险，防止任何路径误触真实投放开关。
      // 关闭实现方案（供下一轮实机验证，见 HANDOFF）：列表行定位 → 行内 .oc-switch 点击
      // → 处理可能的确认弹窗（结构未知，待实测）→ 回读详情状态 + 列表行开关类。
      throw new Error('真实关闭未启用（realMode=false，且开关点击路径未经真实验证；确认弹窗结构未知）。本轮仅演练。');
    },
  };
}

module.exports = {
  createQianchuanCostReader,
  createQianchuanAdListReader,
  createQianchuanAdController,
  openQianchuanHome,
  closeBrowser,
  readQianchuanAccountId,
  extractConsumeCentsFromCardText,
  verifyStatPeriod,
  probeQianchuanConsumeReadiness,
  waitForQianchuanConsumeReady,
  readinessFailureReason,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_INTERVAL_MS,
  MAX_READINESS_ATTEMPTS,
  sanitizePositiveMs,
  normalizeQcUpdatedAt,
  extractPlanIdFromDetail,
  extractInlinePlanId,
  mapRowStatus,
  closableSideOf,
  buildCoverage,
  collectQianchuanRowsInPage,
  locateQianchuanEntry,
  reachQianchuanHome,
  qianchuanHomeUrl,
  isQianchuanHomeUrl,
  isDoudianHomepageUrl,
  waitForDoudianHomepageSettled,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_INTERVAL_MS,
  MAX_SETTLE_ATTEMPTS,
  QC_STATUS_WORDS,
  KNOWN_AD_TYPES,
  CONSUME_LABEL,
};
