'use strict';

/**
 * 抖店首页营销浮窗有限处理（AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1）。
 *
 * 根证（2026-10-19 敏敏后台只读复现，脱敏现场事实 home-modal.json）：
 *   fxg.jinritemai.com/ffa/mshop/homepage/index 上存在唯一可见
 *   .ws-arrival-modal-wrap 营销浮窗（豆包混资活动；按钮「立即报名」「我知道了」；
 *   style_closeBtn 关闭 div），拦截 getByText('成交订单数').click；当前仍已登录。
 *
 * 严格规则（fail-closed，全部通过才可点击一次）：
 *  - Node 端 + 页内双重严格可信 host/path（https + fxg.jinritemai.com +
 *    path 精确等于 /ffa/mshop/homepage 或以其加 "/" 为前缀；拒绝凭据与非默认
 *    端口；URL 解析，绝不子串匹配，防 lookalike 域名与 homepage-evil 类相似路径）；
 *  - 唯一可见浮窗根（不可见的同名根一律不触碰）；
 *  - 浮窗文案命中登录/支付/删除等业务危险词 → 零点击阻断，需人工处理；
 *  - dismiss 控件唯一且明确：精确文本「我知道了」的可见按钮；该文本控件缺失时，
 *    仅接受本精确根内唯一可见 style_closeBtn 关闭控件；两者都缺失/多个 → 阻断；
 *  - 绝不点击「立即报名」或任何泛化整页按钮；绝不删除遮罩/DOM 节点，只做真实点击；
 *  - 0 个可见浮窗 → 立即无操作；点击后有界多轮（默认 3 轮上限 10）回读真实消失，
 *    transient 重现有界等待，无无限循环；耗尽仍未消失如实报告 still_present。
 *
 * 异步渲染等待（AD-ARRIVAL-RENDER-WAIT-20261019-F1，根证 arrival-timeline.json：
 * 唯一可信根先出现、dismiss 控件晚约 3 秒渲染）：
 *  - 仅当本轮判定为 no_dismiss_control 且可见根恰好 1 个（唯一可信根）时，才做有限
 *    时间重读：默认预算 6000ms、间隔 500ms（均可在 opts 注入，硬上限 6000ms）；
 *  - 每轮重读都是完整重新判定（页内 host/path、危险词、多根、多控件），控件未就绪
 *    零点击；等待期间出现危险/多根/多控件 → 立即阻断，绝不延长业务确认；
 *  - 等待重读阶段只用实时 page.url() 复核地址，绝不复用调用方旧 urlHint 作为点击依据；
 *  - 预算耗尽仍无控件 → fail-closed（blocked no_dismiss_control），绝不假报 none/closed；
 *  - 等待次数（waits）与关闭尝试次数（clickedCount/maxRounds）分开计数，等待不消耗
 *    关闭上限；0 个浮窗根仍立即 none，不引入任何全页面固定睡眠。
 *
 * Cookie：本模块不写任何 Cookie、不做首页未身份验证的保存。值守工作副本持久化
 * 仍完全复用既有 checkpointCompassSessionCookies / checkpointQianchuanSessionCookies
 * （到达目标并严格身份正证据成立后才写；四层原始/analysis/recovery 不受影响）。
 * 关闭标记由各入口以非枚举属性挂到 cookieSession，随同一会话上下文进入收尾检查点。
 */

const HOME_HOST = 'fxg.jinritemai.com';
const HOME_PATH_PREFIX = '/ffa/mshop/homepage';

const OVERLAY_ROOT_CLASS = 'ws-arrival-modal-wrap';
const DISMISS_TEXT = '我知道了';
const CLOSE_BTN_TOKEN = 'style_closeBtn';
/** 业务危险词（浮窗文案命中任一 → 零点击阻断）。只扫描浮窗根内文本，不扫全页。 */
const DANGER_WORDS = Object.freeze([
  '登录', '扫码', '验证码', '密码', '支付', '付款', '扣款', '退款', '充值', '提现',
  '转账', '银行卡', '账单', '发票', '删除', '注销', '实名', '授权',
]);

const DEFAULT_MAX_ROUNDS = 3;
const MAX_ROUNDS_HARD_LIMIT = 10;
const DEFAULT_ROUND_INTERVAL_MS = 1000;

/** 唯一可信根已出现但 dismiss 控件尚未渲染时的有限重读（默认 6s 预算 / 500ms 间隔）。 */
const DEFAULT_WAIT_BUDGET_MS = 6000;
const MAX_WAIT_BUDGET_MS = 6000;
const DEFAULT_WAIT_INTERVAL_MS = 500;
const MIN_WAIT_INTERVAL_MS = 50;

/** 有限正毫秒归一化（非法值回落默认，避免 0 忙等/负数失控）。 */
function sanitizePositiveMs(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

function sanitizePositiveInt(v, fallback, hardMax) {
  const n = Math.floor(Number(v));
  return (Number.isFinite(n) && n >= 1) ? Math.min(n, hardMax) : fallback;
}

/** 严格可信抖店首页判定：URL 解析 + protocol/hostname 全等 + 无凭据 + 默认端口 +
 * path 精确等于前缀或以「前缀/」开头（裸前缀子串一律拒绝）。 */
function isTrustedDoudianHomepageUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  if (p.protocol !== 'https:' || p.hostname !== HOME_HOST) return false;
  // 带 credentials 的地址一律保守拒绝（正常抖店首页不会以 userinfo 形式出现）
  if (p.username !== '' || p.password !== '') return false;
  // WHATWG URL 已剥离方案默认端口，此处显式拒绝任何非默认端口（如 :444/:8443）
  if (p.port !== '' && p.port !== '443') return false;
  return p.pathname === HOME_PATH_PREFIX || p.pathname.startsWith(`${HOME_PATH_PREFIX}/`);
}

/**
 * 页内探测/处置函数（自包含：会被序列化进真实页面 evaluate 执行，不能引用闭包；
 * 词表/类名/期望地址全部经 args 传入。同时导出供本地 DOM fixture 测试直接调用）。
 * mode='probe' 只观察零点击；mode='dismiss' 仅在全部严格判据成立时点击一次 dismiss 控件。
 * 返回 status：none | dismissable | clicked | danger_content | multi_visible_roots
 *   | multi_dismiss_controls | no_dismiss_control | url_mismatch | no_document
 */
function handleArrivalOverlayInPage(args) {
  const out = {
    status: 'none', visibleRoots: 0, hiddenRoots: 0,
    textControls: 0, closeControls: 0, dangerWords: [],
    rootText: '', clickedKind: null, controlKind: null, reason: '',
  };
  const doc = (typeof document !== 'undefined' && document) ? document : null;
  if (!doc || typeof doc.querySelectorAll !== 'function') {
    out.status = 'no_document'; out.reason = '页面无 document：零操作'; return out;
  }
  // 页内地址复核（防 Node 判定与 evaluate 之间发生导航；fixture 测试可显式关本项，
  // Node 端可信门不受影响、始终强制）。
  if (args.checkUrl !== false) {
    let loc = null;
    try { loc = new URL(String(location.href)); } catch (_) { loc = null; }
    const prefix = String(args.expectPathPrefix || '');
    // 与 Node 端同一判据：无凭据、默认端口、path 精确等于前缀或「前缀/」开头（自包含内联，不引闭包）
    const okUrl = !!loc && loc.protocol === 'https:'
      && loc.hostname === args.expectHost
      && loc.username === '' && loc.password === ''
      && (loc.port === '' || loc.port === '443')
      && (loc.pathname === prefix || loc.pathname.startsWith(`${prefix}/`));
    if (!okUrl) {
      out.status = 'url_mismatch';
      out.reason = '执行时页面地址已不在可信抖店首页（严格 host/path 复核）：零操作';
      return out;
    }
  }
  const visible = (el) => {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    if (typeof getComputedStyle === 'function') {
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { cs = null; }
      if (cs) {
        if (String(cs.display || '').toLowerCase() === 'none') return false;
        if (String(cs.visibility || '').toLowerCase() === 'hidden') return false;
      }
    }
    return true;
  };
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

  const all = doc.querySelectorAll(`[class*="${args.rootClass}"]`);
  const vis = [];
  for (let i = 0; i < all.length; i += 1) {
    if (visible(all[i])) vis.push(all[i]); else out.hiddenRoots += 1;
  }
  out.visibleRoots = vis.length;
  if (vis.length === 0) { out.status = 'none'; return out; }        // 0 个可见浮窗：立即无操作
  if (vis.length > 1) {
    out.status = 'multi_visible_roots';
    out.reason = `页面出现 ${vis.length} 个可见 ${args.rootClass} 浮窗根，无法唯一定位：零点击阻断，绝不遮罩删除`;
    return out;
  }
  const root = vis[0];
  out.rootText = norm(root.textContent).slice(0, 160);
  const hits = (args.dangerWords || []).filter((w) => out.rootText.indexOf(norm(w)) >= 0);
  if (hits.length > 0) {
    out.status = 'danger_content';
    out.dangerWords = hits;
    out.reason = `浮窗文案命中业务危险词（${hits.join('、')}）：零点击阻断，需人工处理`;
    return out;
  }

  // dismiss 控件识别（仅本精确根内、仅可见；「立即报名」等其它控件永不入选）
  const textHits = [];
  const btnCands = root.querySelectorAll('button, [role="button"]');
  for (let i = 0; i < btnCands.length; i += 1) {
    const el = btnCands[i];
    if (!visible(el)) continue;
    if (norm(el.textContent) === norm(args.dismissText)) textHits.push(el);
  }
  const closeHits = [];
  const closeCands = root.querySelectorAll(`[class*="${args.closeToken}"]`);
  for (let i = 0; i < closeCands.length; i += 1) {
    const el = closeCands[i];
    if (textHits.indexOf(el) >= 0) continue;
    if (visible(el)) closeHits.push(el);
  }
  out.textControls = textHits.length;
  out.closeControls = closeHits.length;

  let target = null;
  let kind = null;
  if (textHits.length === 1) { target = textHits[0]; kind = 'know_button'; }
  else if (textHits.length > 1) {
    out.status = 'multi_dismiss_controls';
    out.reason = `浮窗内可见「${args.dismissText}」控件 ${textHits.length} 个，无法唯一定位：零点击阻断`;
    return out;
  } else if (closeHits.length === 1) { target = closeHits[0]; kind = 'close_btn'; }
  else if (closeHits.length > 1) {
    out.status = 'multi_dismiss_controls';
    out.reason = `浮窗内无「${args.dismissText}」控件，且可见关闭控件 ${closeHits.length} 个：零点击阻断`;
    return out;
  } else {
    out.status = 'no_dismiss_control';
    out.reason = `浮窗内无唯一明确 dismiss 控件（未知内容）：零点击阻断，绝不遮罩删除、绝不点击其他按钮`;
    return out;
  }

  out.controlKind = kind;
  if (args.mode !== 'dismiss') { out.status = 'dismissable'; return out; }  // 只读探测：零点击
  target.click();
  out.status = 'clicked';
  out.clickedKind = kind;
  return out;
}

function buildInPageArgs(mode, opts) {
  return {
    mode,
    rootClass: OVERLAY_ROOT_CLASS,
    dismissText: DISMISS_TEXT,
    closeToken: CLOSE_BTN_TOKEN,
    dangerWords: DANGER_WORDS,
    expectHost: HOME_HOST,
    expectPathPrefix: HOME_PATH_PREFIX,
    checkUrl: opts.checkUrl !== false,
  };
}

function readLiveUrl(page) {
  try { return String(page.url()); } catch (_) { return ''; }
}

/**
 * 可信地址门：opts.urlHint（调用方在本次会话早前经严格 host/path 收敛校验通过的地址，
 * 如 SSO 收敛结果）优先，避免对页面做额外地址读取；无提示时才实时 page.url() 严格判定。
 * 无论哪条路径，点击时刻仍由页内 location.href 严格复核兜底（checkUrl 默认强制）；
 * 等待重读阶段则强制实时 page.url() 复核，绝不复用旧 urlHint。
 */
function gateTrustedUrl(page, opts, action) {
  let url = '';
  let via = 'live';
  if (typeof opts.urlHint === 'string' && opts.urlHint.length > 0) {
    url = opts.urlHint;
    via = 'hint';
  } else {
    url = readLiveUrl(page);
  }
  if (!isTrustedDoudianHomepageUrl(url)) {
    return {
      ok: false,
      result: normalizeResult(null, {
        blocked: true, status: 'untrusted_url',
        reason: `页面地址不是可信抖店首页（严格 origin+path），不做浮窗${action}: ${url.slice(0, 120)}`,
      }),
    };
  }
  return { ok: true, via };
}

/** 浮窗根存在性廉价预检（不注入页面函数、不点击）：null=能力不可用（非浮窗事实）。 */
async function countOverlayRoots(page) {
  try {
    const n = await page.locator(`[class*="${OVERLAY_ROOT_CLASS}"]`).count();
    const c = Number(n);
    return (Number.isFinite(c) && c >= 0) ? c : null;
  } catch (_) { return null; }
}

function normalizeResult(res, extra) {
  const base = {
    ok: false, blocked: false, closed: false,
    clickedCount: 0, rounds: 0, waits: 0, status: 'probe_unavailable',
    reason: '', rootText: '',
  };
  return Object.assign(base, extra || {}, {
    controlKind: (res && res.controlKind) || null,
    dangerWords: (res && res.dangerWords) || [],
    visibleRoots: (res && res.visibleRoots) || 0,
  });
}

/**
 * 只读探测（不点击、不修改 DOM；导出供主脑现场验证）：Node 端严格可信门 +
 * 页内结构观测。非可信地址 → {blocked:true, status:'untrusted_url'}，且页面零调用。
 */
async function probeDoudianArrivalOverlay(page, opts = {}) {
  const gate = gateTrustedUrl(page, opts, '探测');
  if (!gate.ok) return gate.result;
  const rootCount = await countOverlayRoots(page);
  if (rootCount === null) {
    return normalizeResult(null, { status: 'probe_unavailable', reason: '页面不支持浮窗根计数（locator/count 不可用）：不视为浮窗事实' });
  }
  if (rootCount === 0) return normalizeResult(null, { ok: true, status: 'none', rounds: 1, reason: '' });
  let res = null;
  try {
    res = await page.evaluate(handleArrivalOverlayInPage, buildInPageArgs('probe', opts));
  } catch (e) {
    return normalizeResult(null, {
      status: 'probe_error',
      reason: `浮窗只读探测异常：${String((e && e.message) || e).slice(0, 120)}`,
    });
  }
  if (!res || typeof res !== 'object' || typeof res.status !== 'string') {
    return normalizeResult(null, { status: 'probe_unavailable', reason: '浮窗探测返回不可确认（非本模块结构）：不视为浮窗事实' });
  }
  const blocked = ['danger_content', 'multi_visible_roots', 'multi_dismiss_controls', 'no_dismiss_control'].includes(res.status);
  return normalizeResult(res, {
    ok: !blocked, blocked,
    status: res.status,
    reason: res.reason || '',
    rootText: res.rootText || '',
    rounds: 1,
  });
}

/**
 * 有界处置入口（Node 胶水层；sleep/轮次/时钟可注入，测试免真实等待）：
 *  - Node 端严格可信门不通过 → blocked untrusted_url（页面零调用）；
 *  - 业务危险词/多根/多控件/无唯一控件 → blocked（零点击或已点击后阻断复测），如实给 reason；
 *  - no_dismiss_control 且唯一可信根：有限时间重读（默认 6s/500ms，控件就绪前零点击），
 *    每轮完整重跑 host/path、危险词、多根、多控件判据；危险/多根/多控件立即阻断；
 *    预算耗尽 → blocked no_dismiss_control（fail-closed，不假报 none/closed）；
 *  - 点击成功后有界轮次回读真实消失；transient 重现有界再点（同一 dismiss 判据）；
 *    等待次数与关闭尝试次数分开计数，等待不消耗 maxRounds；
 *  - 轮次耗尽仍未消失 → still_present（调用方按 DataGuard 如实处理）；
 *  - 探测异常/结构不可确认 → probe_error/probe_unavailable（非阻断，保持原链路行为）。
 */
async function dismissDoudianArrivalOverlay(page, opts = {}) {
  const maxRounds = sanitizePositiveInt(opts.maxRounds, DEFAULT_MAX_ROUNDS, MAX_ROUNDS_HARD_LIMIT);
  const intervalMs = sanitizePositiveMs(opts.intervalMs, DEFAULT_ROUND_INTERVAL_MS);
  const waitBudgetMs = Math.min(
    sanitizePositiveMs(opts.waitBudgetMs, DEFAULT_WAIT_BUDGET_MS),
    MAX_WAIT_BUDGET_MS,
  );
  const waitIntervalMs = Math.max(
    MIN_WAIT_INTERVAL_MS,
    sanitizePositiveMs(opts.waitIntervalMs, DEFAULT_WAIT_INTERVAL_MS),
  );
  const maxWaits = Math.max(1, Math.floor(waitBudgetMs / waitIntervalMs));
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = opts.sleep || ((ms) => page.waitForTimeout(ms));

  const gate = gateTrustedUrl(page, opts, '处置');
  if (!gate.ok) return gate.result;
  // 廉价预检：0 个浮窗根 → 立即无操作（不注入页面函数、零点击）；
  // 计数能力不可用（注入桩缺 locator/count）→ 非阻断，保持原链路既有行为。
  const rootCount = await countOverlayRoots(page);
  if (rootCount === null) {
    return normalizeResult(null, { status: 'probe_unavailable', reason: '页面不支持浮窗根计数（locator/count 不可用）：不视为浮窗事实，保持原链路' });
  }
  if (rootCount === 0) {
    return normalizeResult(null, { ok: true, status: 'none', rounds: 1, reason: '' });
  }

  let clickedCount = 0;
  let rounds = 0;
  let waits = 0;
  let waitStartedAt = 0;
  for (;;) {
    rounds += 1;
    // 等待重读阶段只信实时地址：导航后不得沿用调用方旧 urlHint 作为点击依据。
    if (waits > 0) {
      const live = readLiveUrl(page);
      if (!isTrustedDoudianHomepageUrl(live)) {
        return normalizeResult(null, {
          clickedCount, rounds, waits, status: 'url_mismatch',
          reason: `等待重读期间页面地址已不可信（实时复核，不复用旧 urlHint）：零点击 ${live.slice(0, 120)}`,
        });
      }
    }
    let res = null;
    try {
      res = await page.evaluate(handleArrivalOverlayInPage, buildInPageArgs('dismiss', opts));
    } catch (e) {
      return normalizeResult(null, {
        clickedCount, rounds, waits, status: 'probe_error',
        reason: `浮窗探测异常（页面可能已导航/关闭）：${String((e && e.message) || e).slice(0, 120)}`,
      });
    }
    if (!res || typeof res !== 'object' || typeof res.status !== 'string') {
      return normalizeResult(null, {
        clickedCount, rounds, waits, status: 'probe_unavailable',
        reason: '浮窗探测返回不可确认（非本模块结构）：不视为浮窗事实，不重复点击',
      });
    }
    if (res.status === 'none') {
      return normalizeResult(res, {
        ok: true, closed: clickedCount > 0, clickedCount, rounds, waits,
        status: clickedCount > 0 ? 'closed' : 'none', reason: '',
      });
    }
    if (res.status === 'clicked') {
      clickedCount += 1;
      try { await sleep(intervalMs); } catch (_) { /* 页面关闭等：下轮 evaluate 收敛 */ }
      if (clickedCount >= maxRounds) {
        return normalizeResult(res, {
          clickedCount, rounds, waits, status: 'still_present',
          reason: `${maxRounds} 轮有界关闭后浮窗仍未真实消失（最后一次点击 ${res.clickedKind || '未知'}）：按导航事实如实阻断`,
        });
      }
      continue;
    }
    if (res.status === 'no_dismiss_control') {
      // 仅「唯一可信根已出现、控件尚未渲染」允许有限重读；根数异常仍立即阻断。
      if (Number(res.visibleRoots) !== 1) {
        return normalizeResult(res, {
          blocked: true, clickedCount, rounds, waits, status: res.status,
          reason: res.reason || 'no_dismiss_control 且可见根非唯一：零点击阻断',
          rootText: res.rootText || '',
        });
      }
      if (waits === 0) waitStartedAt = now();
      if (waits >= maxWaits || (now() - waitStartedAt) >= waitBudgetMs) {
        return normalizeResult(res, {
          blocked: true, clickedCount, rounds, waits, status: 'no_dismiss_control',
          reason: `浮窗已出现唯一可信根，但 ${waits} 次重读（预算 ${waitBudgetMs}ms / 间隔 ${waitIntervalMs}ms）内 dismiss 控件始终未渲染：零点击 fail-closed，不判定 none/closed`,
          rootText: res.rootText || '',
        });
      }
      waits += 1;
      try { await sleep(waitIntervalMs); } catch (_) { /* 页面关闭等：下轮 evaluate 收敛 */ }
      continue;
    }
    const blockedSet = ['danger_content', 'multi_visible_roots', 'multi_dismiss_controls'];
    if (blockedSet.includes(res.status)) {
      return normalizeResult(res, {
        blocked: true, clickedCount, rounds, waits, status: res.status,
        reason: res.reason || `浮窗判据不成立（${res.status}）：零点击阻断`,
        rootText: res.rootText || '',
      });
    }
    if (res.status === 'dismissable') {
      // mode=dismiss 下不应出现；防御：视为不可确认
      return normalizeResult(res, { clickedCount, rounds, waits, status: 'probe_unavailable', reason: '探测模式返回与处置模式不一致：不重复点击' });
    }
    // url_mismatch / no_document / 未知状态：非浮窗业务事实，不阻断既有链路，由后续真实点击自行暴露
    return normalizeResult(res, {
      clickedCount, rounds, waits, status: res.status || 'unknown',
      reason: res.reason || `浮窗处置返回未知状态 ${String(res.status)}：不重复点击`,
      rootText: res.rootText || '',
    });
  }
}

module.exports = {
  dismissDoudianArrivalOverlay,
  probeDoudianArrivalOverlay,
  handleArrivalOverlayInPage,
  isTrustedDoudianHomepageUrl,
  OVERLAY_ROOT_CLASS,
  DISMISS_TEXT,
  CLOSE_BTN_TOKEN,
  DANGER_WORDS,
  HOME_HOST,
  HOME_PATH_PREFIX,
  DEFAULT_MAX_ROUNDS,
  MAX_ROUNDS_HARD_LIMIT,
  DEFAULT_ROUND_INTERVAL_MS,
  DEFAULT_WAIT_BUDGET_MS,
  MAX_WAIT_BUDGET_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  MIN_WAIT_INTERVAL_MS,
};
