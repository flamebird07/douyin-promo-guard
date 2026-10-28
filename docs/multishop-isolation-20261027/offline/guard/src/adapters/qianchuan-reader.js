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
const { resolveCookieFile, restoreDutyWorkCopy } = require('../login/session');
const { fingerprintFile } = require('../login/cookie-writeback');
const { maskUrlQueries } = require('../lib/log');
const { checkpointQianchuanSessionCookies } = require('../login/session-cookie-checkpoint');
// COOKIE-PROCESS-ISOLATION-20261026：恢复候选专用独立浏览器进程工厂/关闭证明助手。
const { createCandidateBrowserFactory, closeBrowserProven } = require('../login/candidate-browser');
const { beginLauncherScope, runInLauncherScope, attestFromLauncherScope } = require('../lib/resource-attestation');
const { closableSideOfAd } = require('./ad-controller');
// AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1：抖店首页营销浮窗有限处理（同页根证，与
// compass-order-reader 共用；本模块不写 Cookie、不改四层，循环依赖不存在）。
const { dismissDoudianArrivalOverlay } = require('./doudian-arrival-overlay');
// 抖店首页有界被动收敛语义（叶子模块，与登录侧独立候选验证共用同一份）。
const {
  isDoudianHomepageUrl,
  waitForDoudianHomepageSettled,
  sanitizePositiveMs,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_INTERVAL_MS,
  MAX_SETTLE_ATTEMPTS,
} = require('../lib/settle-policy');

const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const QC_HOME_MARKER = 'qianchuan.jinritemai.com';
const CONSUME_LABEL = '账户整体消耗';

// ── 抖店首页自动 SSO 收敛（R51）────────────────────────────────────
// 语义本体已下沉到 lib/settle-policy（45s/3s/严格首页判定/双保险限次），本模块只做
// 引用与原样再导出：登录侧的独立候选验证与主链必须共用**同一份**收敛语义，而登录
// 模块被本模块 require（反向 require 成循环依赖），故二者都指向该叶子模块。
// 根证仍是 reference-readonly-session.json：约 30s 才自动落首页，上界必须 > 实测值。

// 费用卡就绪等待的有界默认（仅在已打开页面上被动重读 DOM：不 reload、不点击、不导航、零网络请求）。
const DEFAULT_READINESS_TIMEOUT_MS = 60000;
const DEFAULT_READINESS_INTERVAL_MS = 3000;
// 独立硬限次（与墙钟 deadline 双保险）：仅在"墙钟单调前进"时才靠 deadline 收敛；一旦 nowFn
// 冻结/回拨（或 interval 非法导致 deadline 永不越过），必须靠限次收敛，绝不空转。
// maxAttempts = ceil(timeout/interval)+1，并夹到 [1, MAX_READINESS_ATTEMPTS]。
const MAX_READINESS_ATTEMPTS = 1000;

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
    return { ok: false, reason: '千川账户费用的当天日期证据尚未读到：不能将未知日期费用作为今天数据' };
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
  let snapshot = null;
  let failure = null;
  try {
    const before = target.url();
    if (!isQianchuanHomeUrl(before)) {
      failure = '当前页面不是可信千川首页：拒绝读取费用';
    } else {
      snapshot = await target.evaluate(() => {
        const shopView = /店铺视图[：:]/.test(document.body ? document.body.innerText : '');
        const wrap = shopView ? null : document.querySelector('[class*="report-shortcuts-datepicker"]');
        const period = wrap ? [...wrap.querySelectorAll('input')].map(i => i.value) : null;
        const texts = shopView ? [] : [...document.querySelectorAll('[class*="summaryCard"]')]
          .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim());
        const cardText = texts.find(text => text.includes('账户整体消耗')) || null;
        const updated = shopView ? null : document.querySelector('[class*="refreshTime"]');
        const breakdown = [];
        for (const text of texts) {
          const match = /(乘方计划消耗|标准投放消耗|全域投放消耗|品牌投放消耗|账户整体消耗)\(元\)\s*([\d,]+(?:\.\d+)?)/.exec(text);
          if (match) breakdown.push({ item: match[1], raw: match[2] });
        }
        const loginVisible = [...document.querySelectorAll('input[type="password"], input[placeholder*="手机"], input[placeholder*="验证码"], button, [class*="login"]')].some(el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
            && (el.tagName === 'INPUT' || /^登录$/.test((el.textContent || '').trim()));
        });
        return { href: location.href, period, cardText, breakdown, updatedAtRaw: updated ? (updated.textContent || '').trim() : null, loginVisible, shopView };
      });
      if (target.url() !== before || !snapshot || snapshot.href !== before) failure = '费用探测期间页面导航：拒绝混用不同页面数据';
      else if (snapshot.loginVisible) failure = '千川首页存在可见登录控件：拒绝采信残留费用';
      else if (snapshot.shopView) failure = '千川仍处于店铺视图：不能将店铺整体消耗作为账户费用';
    }
  } catch (_) {
    failure = '千川费用 DOM evaluate 读取异常：本轮未取得日期与费用快照';
  }
  const period = snapshot ? snapshot.period : null;
  const cardText = snapshot ? snapshot.cardText : null;
  const scope = failure ? { ok: false, reason: failure } : verifyStatPeriod(period, nowMs);
  const parsed = cardText
    ? extractConsumeCentsFromCardText(cardText)
    : { ok: false, reason: `千川首页未找到"${CONSUME_LABEL}(元)"卡片（不替换成余额/预算/其他消耗指标）` };
  return { ...snapshot, period, scope, cardText, parsed, ready: scope.ok === true && parsed.ok === true };
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
 *
 * POPUP-CLOSE-20261025：可选 overlayCloser（内部 hook，默认不存在=行为与旧版完全一致）：
 * 每轮探测前先对**已知介绍浮窗**做一次有界收口（复用 chengfang-reader 既有白名单关闭器），
 * 覆盖"读取开始前已有"与"等待期间晚到"两类浮窗。无浮窗时仅多一次只读探针、零点击、
 * 零额外固定等待；关闭结果只如实记录（overlayOutcomes），不改变就绪/失败判定口径。
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
  const overlayCloser = typeof opts.overlayCloser === 'function' ? opts.overlayCloser : null;
  const overlayOutcomes = overlayCloser ? [] : null;
  let last = null;
  let attempts = 0;
  for (;;) {
    if (overlayCloser) {
      // 晚到浮窗收口：每轮探测前先跑一次既有白名单关闭器（含有限瞬态重读与点击后消失验证）。
      // 关闭失败（未知/多义/未消失）只如实记录，不放宽就绪口径，也不点任何业务 CTA。
      const closed = await overlayCloser();
      if (closed) overlayOutcomes.push({ dismissed: closed.dismissed === true, state: closed.state || null });
    }
    last = await probeQianchuanConsumeReadiness(target, nowFn());
    attempts += 1;
    if (last.ready) return { ...last, ok: true, attempts, cents: last.parsed.cents, ...(overlayOutcomes ? { overlayOutcomes } : {}) };
    if (attempts >= maxAttempts) break;                 // 硬限次上界：冻结/回拨时钟下也收敛
    if (!(nowFn() + intervalMs <= deadline)) break;     // 墙钟上界：再等也会越过上界，不再空转
    await sleep(intervalMs);
  }
  return { ok: false, attempts, reason: readinessFailureReason(last), ...(overlayOutcomes ? { overlayOutcomes } : {}) };
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
  let parsed;
  try { parsed = new URL(u); } catch (_) { return false; }
  return parsed.origin === `https://${QC_HOME_MARKER}` && /^\/home\/?$/.test(parsed.pathname);
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
async function reachQianchuanHome({ page, context, shopCfg, overlayOpts = {} }) {
  let lastUrl = null;
  let lastReason = '点击"巨量千川"后未到达千川';
  let overlayResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    // AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1：点"巨量千川"入口前处置首页营销浮窗
    // （根证 2026-10-19：唯一可见 .ws-arrival-modal-wrap 拦截入口点击）。
    // 0 浮窗立即无操作；业务危险/多根/多控件 → 零点击阻断（含跳过只读兜底，需人工）；
    // 绝不点击"立即报名"或遮罩删除；探测异常非阻断，保持原链路行为。
    const overlay = await dismissDoudianArrivalOverlay(page, overlayOpts);
    overlayResult = overlay;
    if (overlay.blocked || overlay.status === 'still_present') {
      return {
        ok: false, url: page.url(),
        reason: `抖店首页营销浮窗处理受阻：${overlay.reason}；绝不点击浮窗内其他控件`,
        overlay: overlayResult,
      };
    }
    const located = await locateQianchuanEntry(page);
    if (!located.ok) {
      lastUrl = page.url();
      lastReason = located.reason === 'ambiguous'
        ? `无法唯一定位"巨量千川"入口（${located.matchMode} 匹配 ${located.matchedCount} 个候选）：停止导航，绝不盲点`
        : '抖店首页未找到"巨量千川"入口';
      continue;
    }
    const entry = located.locator;
    const popupPromise = page.waitForEvent('popup', { timeout: 25000 }).catch(() => null);
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
    if (isQianchuanHomeUrl(url)) return { ok: true, target, url, mode: 'entry-click', attempts: attempt, overlay: overlayResult };
    lastUrl = url;
    lastReason = clickErr ? `点击"巨量千川"未成功：${(clickErr && clickErr.message) || clickErr}` : '点击"巨量千川"后未到达千川';
    // 非千川的残留标签先关掉，避免干扰下一次尝试（主页面保留）
    if (target !== page) await target.close().catch(() => {});
    // 点击已确认被带到 school/帮助教程页：结束同一入口重试（不再连点 3 次），转只读后备。
    if (!clickErr && TUTORIAL_LINK_RE.test(String(url || ''))) break;
  }
  // 有界只读后备（同 Cookie 上下文）：账户ID 未知时打开**不带账户ID的通用 /home**，
  // 供正式调用链在该页运行时严格唯一头部发现账户并与本店绑定。
  // R74：兜底在同一 context **新建本次 owned 的千川页**导航，绝不再 goto 覆盖原 FXG 主页
  //（旧实现把 cookieSession.identityPage 也变成了 QC 页，未知店铺检查点永远跳过保存）。
  // 原 FXG 页始终原样保留供身份复验；兜底失败的残留页由上层 browser.close 保守清理。
  let qcFallbackPage = null;
  try {
    qcFallbackPage = await context.newPage();
    await qcFallbackPage.goto(qianchuanHomeUrl(shopCfg), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await qcFallbackPage.waitForTimeout(6000);
  } catch (_) { qcFallbackPage = null; }
  const url = qcFallbackPage ? String(qcFallbackPage.url()) : '';
  if (qcFallbackPage && isQianchuanHomeUrl(url)) return { ok: true, target: qcFallbackPage, url, mode: 'direct-home-url', attempts: 4, overlay: overlayResult };
  lastUrl = url || lastUrl;
  lastReason = `${lastReason}（直连千川首页兜底亦未到达）`;
  return { ok: false, url: lastUrl || (page.url && page.url()) || '', reason: lastReason, overlay: overlayResult };
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
      // S6 2026-10-26：登录正证据必须来自**真实渲染可见**的元素。旧实现只查自身
      // computed style（隐藏祖先/收起容器内的控件会被误判可见），且 loginForm 用
      // querySelector 命中即 true（隐藏的 password 输入框也算登录表单），会把已登录
      // 页面上残留的隐藏登录组件误判为登录失效。可见性判据（保守，API 不可得一律
      // 判不可见，绝不凭空出具登录正证据）：
      //  1) 自身与全部祖先 computed style 不得 display:none / visibility:hidden；
      //  2) 布局盒尺寸非零（getBoundingClientRect width/height > 0）。
      const visible = (el) => {
        if (!el) return false;
        try {
          if (typeof getComputedStyle !== 'function') return false;
          let node = el;
          let hops = 0;
          while (node && node !== document && hops < 100) {
            const cs = getComputedStyle(node);
            if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
            const parent = node.parentElement || (node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null);
            node = parent;
            hops += 1;
          }
          if (typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
        } catch (_) { return false; }
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
        // 遍历全部候选而非只看第一个：隐藏残留表单在前、真实可见表单在后时也能命中。
        if (typeof document.querySelectorAll === 'function') {
          const forms = document.querySelectorAll('input[type="password"], form [name*="passport"], [class*="login-form"] input');
          for (let i = 0; i < forms.length; i += 1) {
            if (visible(forms[i])) { out.loginForm = true; break; }
          }
        }
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

async function ensureQianchuanAccountView(target, shopCfg, opts = {}) {
  const timeoutMs = sanitizePositiveMs(opts.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS);
  const intervalMs = sanitizePositiveMs(opts.readinessIntervalMs, DEFAULT_READINESS_INTERVAL_MS);
  const nowFn = opts.nowFn || (() => Date.now());
  const sleep = opts.sleep || (ms => target.waitForTimeout(ms));
  const deadline = nowFn() + timeoutMs;
  const maxAttempts = Math.min(MAX_READINESS_ATTEMPTS, Math.ceil(timeoutMs / intervalMs) + 1);
  const expectedName = String((shopCfg && (shopCfg.compassShopName || shopCfg.name)) || '').trim();
  let switched = false;
  let popupClosed = false;
  let blockedSwitchUrl = null;
  let reason = '千川视图内容未就绪或结构未识别：未取得账户数据';
  const fail = async message => {
    const evidence = await collectLoginExpiryEvidence(target);
    if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
      throw new AuthError('千川视图读取遇到登录页或登录控件：尚未取得账户数据');
    }
    throw new DataGuardError(message);
  };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = target.url();
    if (!isQianchuanHomeUrl(before)) return fail('千川视图导航未停留在可信首页：未取得账户数据');
    if (blockedSwitchUrl !== null && before !== blockedSwitchUrl) {
      return fail('千川受阻切换再观察期间发生导航：停止后续点击');
    }
    let view;
    try {
      view = await target.evaluate(() => {
        const visible = el => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const shopView = /店铺视图[：:]/.test(document.body ? document.body.innerText : '');
        const switchPresent = [...document.querySelectorAll('button')]
          .some(el => (el.textContent || '').trim() === '切至账户视图');
        const accountContent = [...document.querySelectorAll('[class*="summaryCard"]')]
          .some(el => visible(el) && (el.textContent || '').includes('账户整体消耗'));
        const popup = { present: false, safe: false };
        if (shopView || switchPresent) {
          const closes = [...document.querySelectorAll('button.close-button')];
          const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')].filter(visible);
          popup.present = closes.some(visible) || dialogs.length > 0;
          if (popup.present && closes.length === 1) {
            const close = closes[0];
            const content = close.parentElement;
            if (content && content.classList.contains('content') && visible(content) && visible(close)) {
              const controls = [...content.querySelectorAll('button, [role="button"], a[href], input, select, textarea')];
              const business = controls.filter(el => el !== close && el.tagName === 'BUTTON');
              const links = controls.filter(el => el.tagName === 'A' && el.hasAttribute('href'));
              popup.safe = (controls.length === 3 || controls.length === 4) && controls.includes(close)
                && business.length === 2 && business.every(visible)
                && links.length === controls.length - 3
                && business.filter(el => (el.textContent || '').trim() === '投放乘方').length === 1
                && business.filter(el => (el.textContent || '').trim() === '开启货款直投').length === 1
                && /^[xX×]?$/.test((close.textContent || '').trim())
                && /^(?:关闭|close)?$/i.test((close.getAttribute('aria-label') || '').trim())
                && dialogs.every(dialog => dialog.contains(close));
            }
          }
        }
        return { href: location.href, shopView, switchPresent, accountContent, popup };
      });
    } catch (_) {
      return fail('千川视图 DOM 读取异常：未执行其他导航或按钮操作');
    }
    if (!view || view.href !== before || target.url() !== before) {
      return fail('千川视图探测期间发生导航：拒绝混用不同页面数据');
    }
    const shopView = view.shopView || view.switchPresent;
    const evidence = await collectLoginExpiryEvidence(target);
    if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
      throw new AuthError('千川视图读取遇到登录页或登录控件：尚未取得账户数据');
    }
    if (target.url() !== before) return fail('千川视图核验期间发生导航：未取得账户数据');
    if (blockedSwitchUrl !== null && !switched
      && (!view.shopView || !view.switchPresent || (!popupClosed && (!view.popup.present || !view.popup.safe)))) {
      return fail('千川受阻切换未取得同页店铺视图及唯一已证营销弹窗的新鲜证据：停止后续点击');
    }
    if (!shopView && view.accountContent === true) return { switched };
    if (shopView && expectedName) {
      let identityOk;
      try {
        const title = target.getByText(`店铺视图：${expectedName}`, { exact: true });
        identityOk = await title.count() === 1 && await title.isVisible();
      } catch (_) {
        return fail('千川店铺视图身份读取异常：停止读取，不选择其他账户');
      }
      if (!identityOk) return fail('千川店铺视图身份与目标店铺不一致或不唯一：停止读取，不选择其他账户');
    }
    if (shopView && !switched) {
      reason = '千川店铺视图未找到唯一的“切至账户视图”按钮：未执行切换';
      const button = target.getByRole('button', { name: '切至账户视图', exact: true, includeHidden: true });
      let count;
      try { count = await button.count(); } catch (_) {
        return fail('千川“切至账户视图”按钮定位失败：未执行切换');
      }
      if (count > 1) return fail('千川“切至账户视图”按钮重名：无法唯一定位，未执行切换');
      if (count === 1) {
        if (target.url() !== before) return fail('千川切换前发生导航：未执行切换');
        if (view.popup.present) {
          if (!view.popup.safe || popupClosed) {
            return fail('千川营销弹窗未知、不唯一、不匹配或关闭后仍存在：停止后续点击，未点击业务按钮');
          }
          try {
            const close = target.locator('.content > button.close-button');
            if (await close.count() !== 1) return fail('千川营销弹窗关闭按钮不唯一：未执行关闭');
            if (target.url() !== before) return fail('千川弹窗关闭前发生导航：未执行关闭');
            await close.click({ timeout: Math.min(timeoutMs, 1500) });
          } catch (_) {
            return fail('千川已证营销弹窗关闭按钮不可操作或导航异常：未尝试其他按钮');
          }
          popupClosed = true;
          if (target.url() !== before) return fail('千川营销弹窗关闭期间发生导航：未执行视图切换');
        } else {
          try {
            // 不强制点击；Playwright 的可见、启用和命中测试保护被遮挡的按钮。
            await button.click({ timeout: Math.min(timeoutMs, 10000) });
            switched = true;
            reason = '千川切换后账户视图内容未就绪或结构未识别：未读取店铺汇总，未取得账户数据';
          } catch (error) {
            if (popupClosed || blockedSwitchUrl !== null || !error || error.name !== 'TimeoutError'
              || !/intercepts pointer events/i.test(String(error.message)) || target.url() !== before) {
              return fail('千川“切至账户视图”按钮不可操作或切换导航失败：未尝试其他按钮');
            }
            blockedSwitchUrl = before;
            reason = '千川视图切换被遮挡：未在有界再观察内确认并关闭唯一已证营销弹窗';
          }
        }
      }
    }
    if (attempt + 1 >= maxAttempts || !(nowFn() + intervalMs <= deadline)) break;
    await sleep(intervalMs);
  }
  return fail(reason);
}

/**
 * Cookie → 抖店首页 → 登录检查 → 点"巨量千川" → 千川落地页。
 * 任意初始化失败都会关闭本次创建的浏览器后抛错；成功返回后由调用者负责释放。
 */
async function openQianchuanHome(loginCfg, shopCfg, opts = {}) {
  let browser = null;
  const launchScope = beginLauncherScope('qianchuan-home');
  // COOKIE-PROCESS-ISOLATION-20261026：本次 open 内的店铺浏览器启动/关闭助手。
  // 恢复链切换候选前必须先关闭当前店铺浏览器进程（不能带着旧 Cookie 活着），恢复成功
  // 重载新工作副本前必须启动**全新**店铺浏览器进程；每次启动都同步登记 onResource 收口
  // 句柄（同一早期所有权协议，重开的新进程同样登记，绝不留无主进程）。
  const shopBrowserIdentities = [];
  // COOKIE-PROCESS-ISOLATION-20261026 校正：店铺浏览器启动也经同一"每次全新实例"工厂包装
  // （对象身份查重）：注入工厂在恢复后返回**同一个旧浏览器对象**（复用旧进程）→ 在
  // addCookies 之前拒绝（关闭并抛错，走既有 catch 收口），绝不带着旧 Cookie 进程重载。
  // 生产默认 fallbackLaunch 每次 chromium.launch 全新进程，行为不变。onResource 早登记
  // 语义由工厂内部同步完成（与下方候选工厂同一协议），launcher 范围证明照旧包住启动调用。
  const shopBrowserFactory = createCandidateBrowserFactory({
    injectedFactory: typeof opts.browserFactory === 'function' ? opts.browserFactory : null,
    fallbackLaunch: () => {
      const { chromium } = require('playwright');
      return chromium.launch({
        headless: opts.headless !== false,
        executablePath: loginCfg.edgePath,
        args: ['--window-size=1920,1080'],
      });
    },
    onResource: typeof opts.onResource === 'function' ? opts.onResource : null,
  });
  const launchShopBrowser = async () => {
    const opened = await runInLauncherScope(launchScope, () => shopBrowserFactory());
    shopBrowserIdentities.push(opened);
    return opened;
  };
  // 关闭当前店铺浏览器并给出证明；先摘引用（关闭后绝不再被当作活会话/不被重复收口），
  // 未获证明时保留给出错出口再试关闭。
  const closeShopBrowserProven = async () => {
    if (!browser) return true;
    const closing = browser;
    browser = null;
    const ok = await closeBrowserProven(closing);
    if (!ok) browser = closing;
    return ok;
  };
  // 候选专用浏览器工厂：每个恢复候选一份全新独立浏览器进程（显式注入优先；测试用
  // browserFactory 包装并强制每次新实例；生产默认 Playwright chromium.launch，每次调用
  // 即每次全新进程）。绝不把当前/历史店铺浏览器共享给候选验证（forbiddenBrowsers 拒绝）。
  const candidateBrowserFactory = typeof opts.restoreCandidateBrowserFactory === 'function'
    ? opts.restoreCandidateBrowserFactory
    : createCandidateBrowserFactory({
      injectedFactory: typeof opts.browserFactory === 'function' ? opts.browserFactory : null,
      fallbackLaunch: () => {
        const { chromium } = require('playwright');
        return chromium.launch({
          headless: opts.headless !== false,
          executablePath: loginCfg.edgePath,
          args: ['--window-size=1920,1080'],
        });
      },
      onResource: typeof opts.onResource === 'function' ? opts.onResource : null,
    });
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
    browser = await launchShopBrowser();
    // AD-COOKIE-FOUR-TIER-20261019-F1：会话打开收口（含恢复成功后的有界一次重试）。
    const openFxgSession = async () => {
      const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
      try {
        const cookies = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
        await ctx.addCookies(cookies);
        const pg = await ctx.newPage();
        await pg.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await pg.waitForTimeout(5000);
        // R51：自动 SSO 中转（/login/common → 首页，实测 ~30s）不得在 5s 处被判伪过期。
        // 空首页不代表登录完成；地址与可见身份均就绪才继续。
        // 上界到达才做登录正证据分类（真过期仍 AuthError；其余按导航事实 DataGuard）。
        const settled = await waitForDoudianHomepageSettled(pg, opts);
        return { ctx, pg, settled };
      } catch (e) {
        try { await ctx.close(); } catch (_) { /* 关闭失败不掩盖原始错误 */ }
        throw e;
      }
    };
    // 收敛失败的既有分类（与旧实现逐字同口径）：page-closed / 登录正证据 / 导航事实。
    const classifySettleFailure = async (sess) => {
      if (sess.settled.reason === 'settle-page-closed') return { kind: 'page-closed', restore: null };
      const evidence = await collectLoginExpiryEvidence(sess.pg);
      if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
        return { kind: 'login', restore: null };
      }
      return { kind: 'nav', restore: null };
    };
    let sess = await openFxgSession();
    let fail = sess.settled.ok ? null : await classifySettleFailure(sess);
    // 仅明确登录失效正证据进入四层恢复链（导航/页面关闭类一律不触碰 Cookie）：
    // 值守工作副本当前字节排除（刚在本浏览器验证失败）→ 恢复副本 → 匹配店铺最近原始快照；
    // 候选先在隔离新上下文独立验证（正确店名+有效登录），验证通过才按冻结基线 CAS 提升
    //（保留上一版；验证期间并发新登录胜出）；成功重载恢复副本有界重试一次；全部失败
    // 如实保留原 AuthError，不盲覆盖、不跨店猜文件、不循环。opts.restoreOnAuthFailure===false 关闭。
    // S8 2026-10-26：恢复配额下沉为**整次 open 调用共享**（初始收敛与千川账户视图阶段
    // 合计至多一次）：初始阶段已用过 → 千川阶段的 AuthError 不再二次恢复；反之亦然。
    let restoreUsed = false;
    const runRestoreChain = async () => {
      if (restoreUsed) return { ok: false, reason: '本次打开的四层恢复配额已用尽（初始收敛与千川阶段共享一次）' };
      restoreUsed = true;
      try {
        const runner = opts.restoreRunner || restoreDutyWorkCopy;
        return await runner(loginCfg, shopCfg.cookieFile, {
          shopCfg,
          excludeWorkCopy: true,
          candidateBrowserFactory,
          forbiddenBrowsers: shopBrowserIdentities.slice(),
          verify: opts.restoreVerify,
          vaultModule: opts.restoreVaultModule,
          vaultRoots: opts.restoreVaultRoots,
          recoveryDir: opts.restoreRecoveryDir,
          nowFn: opts.nowFn,
          audit: opts.audit,
        });
      } catch (e) {
        return { ok: false, reason: '恢复链异常（未回显可能含凭据的异常详情）' };
      }
    };
    if (fail && fail.kind === 'login' && opts.restoreOnAuthFailure !== false) {
      await sess.ctx.close();
      // 候选切换前先关闭当前店铺浏览器进程（不能带着旧 Cookie 进程活着等候选验证）；
      // 关闭未获证明 → 阻断恢复（绝不重叠会话/绝不带旧进程继续）。
      const browserClosed = await closeShopBrowserProven();
      if (!browserClosed) {
        throw new AuthError('登录失效后原店铺浏览器进程关闭未获证明：阻断四层恢复（绝不重叠会话/绝不带着旧 Cookie 进程继续）');
      }
      const restore = await runRestoreChain();
      fail.restore = restore;
      if (restore.ok) {
        // 恢复提升已更新工作副本：刷新会话指纹基线（提升后字节即新基线），并在**全新
        // 店铺浏览器进程**上有界重试一次（旧进程已关闭，绝不复用旧 Cookie 进程重载）。
        cookieSession.startFingerprint = fingerprintFile(resolved.path);
        browser = await launchShopBrowser();
        sess = await openFxgSession();
        fail = sess.settled.ok ? null : await classifySettleFailure(sess);
      }
    }
    let context = sess.ctx;
    let page = sess.pg;
    if (fail) {
      if (fail.kind === 'page-closed') {
        throw new DataGuardError(`抖店主页面在自动登录收敛期内被关闭（最后地址 ${sess.settled.url ? maskUrlQueries(sess.settled.url) : '未知'}）；按导航事实处理，需人工核实`);
      }
      if (fail.kind === 'login') {
        const restoreNote = fail.restore
          ? `；四层恢复未取得可验证候选（${fail.restore.reason || '未提升'}），工作副本现状未被盲覆盖`
          : '';
        throw new AuthError(`登录失效：抖店页面在 ${sess.settled.attempts} 次有界收敛（上限 ${Math.round(sanitizePositiveMs(opts.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS) / 1000)}s）后仍命中登录页地址或可见登录控件/表单（当前 ${maskUrlQueries(page.url())}），请重新扫码登录${restoreNote}`);
      }
      throw new DataGuardError(`抖店主页面在有界自动登录收敛期内未到达首页（${sess.settled.attempts} 次探测，当前 ${maskUrlQueries(sess.settled.url || page.url())}）；未见登录正证据，按导航事实处理，需人工核实`);
    }
    // S8 2026-10-26：千川账户视图阶段补齐同一四层恢复链。此前 ensureQianchuanAccountView
    // 在千川入口抛出的 AuthError 直接外抛，已保存的有效同店候选从未被尝试（已核读源码
    // 核实的缺口）。约束：仅在 genuine AuthError（登录正证据语义）上触发，且先在同一
    // target 上重新取证复核（S6 修复后的同一探针）；恢复配额与初始收敛共享（整次 open
    // 至多一次）；恢复成功 → 刷新指纹基线 → 重开干净上下文 → 按原链路重走 FXG→千川与
    // 同一身份核验；旧上下文必须先被证明关闭（close 抛错或页面仍开放一律阻断恢复，
    // 绝不重叠会话）；导航/DataGuard/超时类错误绝不触发恢复；恢复失败/异常/禁用/重试
    // 仍失效 → 如实保留认证错误并收口资源，绝不伪造成功。
    let reached = null;
    let qcFailure = null;
    for (let round = 0; round < 2; round += 1) {
      reached = await reachQianchuanHome({
        page: sess.pg, context: sess.ctx, shopCfg,
        // 地址门复用 SSO 收敛已严格核验的首页地址（重试轮 goto 目标即该首页；点击时刻
        // 仍由浮窗模块页内 location.href 严格 host/path 复核兜底），避免额外地址读取扰动链路。
        overlayOpts: {
          urlHint: sess.settled.url,
          sleep: opts.overlaySleep, maxRounds: opts.overlayMaxRounds, intervalMs: opts.overlayIntervalMs,
        },
      });
      if (!reached.ok) {
        qcFailure = new DataGuardError(`${reached.reason}（当前: ${reached.url}）；若需额外登录/授权请先人工完成一次`);
        break;
      }
      try {
        await ensureQianchuanAccountView(reached.target, shopCfg, opts);
        break;
      } catch (e) {
        if (!(e instanceof AuthError) || round === 1) { qcFailure = e; break; }
        // 同一 target 重新取证复核：没有新鲜登录正证据就不恢复（原 AuthError 原样上抛）。
        const reconfirm = await collectLoginExpiryEvidence(reached.target);
        const positive = reconfirm.loginUrl || reconfirm.loginControlVisible
          || reconfirm.loginFormVisible || reconfirm.loginDialogVisible;
        if (!positive || opts.restoreOnAuthFailure === false || restoreUsed) { qcFailure = e; break; }
        // 旧上下文必须先被证明关闭：close 抛错或页面仍报告未关闭 → 阻断恢复重开。
        let closedOk = true;
        try { await sess.ctx.close(); } catch (_) { closedOk = false; }
        if (closedOk && typeof sess.pg.isClosed === 'function') {
          try { if (sess.pg.isClosed() !== true) closedOk = false; } catch (_) { closedOk = false; }
        }
        if (!closedOk) {
          qcFailure = new AuthError(`${e.message}；原会话上下文关闭未获证明：阻断四层恢复重开，绝不重叠会话`);
          break;
        }
        // 会话中段恢复同样先关闭当前店铺浏览器进程：候选切换与重载都不得复用旧 Cookie 进程。
        const browserClosed = await closeShopBrowserProven();
        if (!browserClosed) {
          qcFailure = new AuthError(`${e.message}；原店铺浏览器进程关闭未获证明：阻断四层恢复重开，绝不重叠会话`);
          break;
        }
        const restore = await runRestoreChain();
        if (!restore.ok) {
          qcFailure = new AuthError(`${e.message}；四层恢复未取得可验证候选（${restore.reason || '未提升'}），工作副本现状未被盲覆盖`);
          break;
        }
        // 恢复提升已更新工作副本：刷新指纹基线（提升后字节即新基线），启动全新店铺浏览器
        // 进程重开干净上下文重走全链路（旧进程已关闭，绝不复用旧 Cookie 进程重载）。
        cookieSession.startFingerprint = fingerprintFile(resolved.path);
        browser = await launchShopBrowser();
        sess = await openFxgSession();
        if (!sess.settled.ok) {
          const reopenFail = await classifySettleFailure(sess);
          qcFailure = reopenFail.kind === 'login'
            ? new AuthError(`恢复重开后抖店登录仍失效（当前 ${maskUrlQueries(sess.pg.url())}）：本次恢复已结束，当前会话仍未通过验证`)
            : new DataGuardError(`恢复重开后抖店主页面在有界自动登录收敛期内未到达首页（当前 ${maskUrlQueries(sess.settled.url || sess.pg.url())}）；未见登录正证据，按导航事实处理，需人工核实`);
          break;
        }
        context = sess.ctx;
        page = sess.pg;
      }
    }
    if (qcFailure) throw qcFailure;
    const target = reached.target;
    // AD-DOUDIAN-ARRIVAL-OVERLAY：浮窗关闭标记以非枚举属性挂到本次 cookieSession
    // （与 R73 identityPage 同口径，不进 JSON 序列化），随同一会话上下文进入
    // 入口/收尾两处检查点。Cookie 持久化链路不变：仅到达千川并经严格身份正证据
    // 成立后由 checkpointQianchuanSessionCookies 写 guard 工作副本，绝不在首页保存。
    if (reached.overlay) {
      Object.defineProperty(cookieSession, 'arrivalOverlay', {
        value: {
          stage: 'qianchuan-home',
          status: reached.overlay.status,
          closed: reached.overlay.closed === true,
          clickedCount: reached.overlay.clickedCount,
          rounds: reached.overlay.rounds,
        },
        enumerable: false, configurable: true, writable: true,
      });
    }
    // R73：把原抖店身份页以**非枚举临时引用**挂到本次 cookieSession 上，供会话检查点在
    // 未知 accountId 时于同一 context 的原抖店页取严格语义店铺名正证据（自动发现账户）；
    // 后续复用同一 cookieSession 的检查点（如乘方链路）同样可取得。非枚举：不进入
    // JSON 序列化，不改变既有返回字段；检查点缺失该引用时按原有约定跳过，零写入。
    Object.defineProperty(cookieSession, 'identityPage', {
      value: page, enumerable: false, configurable: true, writable: true,
    });
    const cookieCheckpoint = { saved: false, skipped: true, reason: '检查点延迟到关闭前：不在首次业务读取前创建并行验证会话' };
    // R87 关闭前收尾检查点登记：把同一检查点实现登记到以本次 owned browser 为键的 WeakMap，
    // 供 closeBrowser 在关闭前以**当前时刻事实**（同 context + 严格可信 URL + 新鲜语义身份）
    // 再保存一次。管理/发布/发现共用 closeBrowser 均走同一检查；未知/非受支持页面由检查点自身
    // 安全跳过。登记失败不影响本次打开结果；绝不 monkeypatch browser.close、不引入全局服务。
    try {
      const runFinalize = opts.sessionCheckpoint || checkpointQianchuanSessionCookies;
      browserFinalizers.set(browser, {
        // D5G：收尾检查点的写前候选验证必须经**候选专用独立浏览器工厂**（每个候选
        // 全新进程），并把本次全部店铺浏览器身份列为禁止返回实例——绝不借用本次
        // 主业务浏览器/context.browser() 做检查点验证，也绝不关闭外部健康主浏览器。
        finalize: () => runFinalize({
          context,
          cookieSession,
          target,
          shopCfg,
          audit: opts.audit,
          candidateBrowserFactory,
          forbiddenBrowsers: shopBrowserIdentities.slice(),
        }),
      });
    } catch (_) { /* 登记失败不改变打开结果 */ }
    return { browser, context, page, target, cookieSession, navMode: reached.mode, cookieCheckpoint };
  } catch (e) {
    // 可信"未创建"（2026-10-23 验收边界 1 收紧）：证明只能由**包住 launcher 调用的范围**出具。
    // 失败严格发生在进入 factory/launch 之前（Cookie 解析、指纹读取等）才可登记；一旦进入过
    // launcher，即使局部 browser 仍为 null，也无法排除其内部已创建资源后再 reject，故**绝不**
    // 出具证明——Monitor 据此保持 unknown 保守阻断，而不是被一句"没拿到句柄"放行。
    // browser 已创建时同理走收口句柄（真实连接状态判定），不由本函数标记。
    if (e && typeof e === 'object') attestFromLauncherScope(launchScope, e);
    // 任意初始化失败：关闭本次创建的浏览器，再抛出原始错误
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

/**
 * 本次 owned 浏览器 → 关闭前收尾保存处理器（R87/R89）。仅登记 openQianchuanHome 成功返回的
 * browser。**同一个已登记 promise 同时包含收尾最终化与 browser.close()**：重复/并发 closeBrowser
 * 复用同一 promise，故至多 save 1 次、close 1 次。登记项不再删除，保留已完成 promise，由 WeakMap
 * 键（本次 owned browser）的生命周期自然释放，因此已结束后再次调用也不会二次最终化或二次关闭。
 * 收尾最终化抛错既不吞掉调用方原业务错误，也不阻止关闭；未登记 browser 的原关闭行为不变。
 * 绝不 monkeypatch browser.close，不引入全局服务。
 */
const browserFinalizers = new WeakMap();

async function closeBrowser(browser) {
  if (browser && typeof browser === 'object') {
    const entry = browserFinalizers.get(browser);
    if (entry) {
      let p = entry.promise;
      if (!p) {
        p = (async () => {
          // 收尾保存失败/异常绝不阻止正常关闭，也不改变已确认的业务结果。
          try { await entry.finalize(); } catch (_) { /* ignore */ }
          await browser.close().catch(() => {});
        })();
        entry.promise = p;
      }
      await p;
      return;
    }
  }
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

/**
 * POPUP-CLOSE-20261025：费用读取链路的已知介绍浮窗收口（只读复用，不重复造选择器）。
 * chengfang-reader 顶部 require 本模块，顶层反向 require 会成循环依赖；因此这里在
 * **读函数执行时** lazy require——彼时两模块均已完成初始化。已有关闭器
 * dismissKnownChengfangOverlays / handleChengfangOverlayInPage 支持千川首页 /home 路径上
 * overall-release-modal-v2-wrap 介绍浮窗（唯一 button.close-button[aria-label="关闭"]），
 * 并自带未知/多义/危险阻断、有限瞬态重读与点击后消失验证；本函数不扩大关闭范围、
 * 不点任何业务 CTA（投放乘方/开启货款直投）。
 */
function closeKnownIntroOverlayAroundCostRead(target) {
  const { dismissKnownChengfangOverlays } = require('./chengfang-reader');
  return dismissKnownChengfangOverlays({ page: target, maxRounds: 2 });
}

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

        // POPUP-CLOSE-20261025：介绍浮窗收口（读取开始前 + 就绪等待每轮 + 截图前）。
        // 无浮窗时只多两次只读探针、零点击、零无条件固定等待；关闭不成功不声称成功，
        // 结果如实随返回值记录（introOverlay），不改变费用/周期/身份任何既有口径。
        const runOverlayClose = async () => {
          try { return await closeKnownIntroOverlayAroundCostRead(target); } catch (_) { return null; }
        };
        // 有界被动就绪等待（客户实测：卡片/周期延时导致 04:15、13:41 UTC 即刻漏读）：
        // 固定初等等待后仅在已打开页面上重读 DOM，等**同一轮**周期=当天且账户整体消耗卡可解析；
        // 上界到达即按 DataGuard 失败（零请求、不替换余额、不放宽任何守卫）。
        const ready = await waitForQianchuanConsumeReady(target, {
          timeoutMs: p.readinessTimeoutMs,
          intervalMs: p.readinessIntervalMs,
          nowFn,
          sleep: p.sleep,
          overlayCloser: runOverlayClose,
        });
        if (!ready.ok) throw new DataGuardError(ready.reason);

        // 截图前再次处理晚到浮窗；未消失时保留实际诊断，不声称已关闭。
        const finalOverlay = await runOverlayClose();

        const { period, scope, cardText, parsed, updatedAtRaw, breakdown } = ready;
        const pageUpdatedAt = normalizeQcUpdatedAt(updatedAtRaw || '', nowFn());

        try {
          if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
          await target.screenshot({ path: path.join(evidenceDir, `qc-cost-${Date.now()}.png`), timeout: 8000 });
        } catch (_) { /* 不阻塞 */ }

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
          introOverlay: {
            duringWait: (ready.overlayOutcomes || []).slice(),
            final: finalOverlay ? { dismissed: finalOverlay.dismissed === true, state: finalOverlay.state || null } : null,
          },
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
  ensureQianchuanAccountView,
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
  collectLoginExpiryEvidence,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_INTERVAL_MS,
  MAX_SETTLE_ATTEMPTS,
  QC_STATUS_WORDS,
  KNOWN_AD_TYPES,
  CONSUME_LABEL,
};
