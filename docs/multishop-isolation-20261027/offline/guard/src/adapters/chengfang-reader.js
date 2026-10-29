'use strict';

/**
 * 乘方只读读取与暂停原语 v1（覆盖范围：乘方 = 全店托管 + 商品自选）。
 *
 * 页面证据（2026-09-13 只读实测，evidence/r7e、r7f、r8）：
 * - 入口：抖店首页"巨量千川" → 千川导航"乘方"（navigatormenu_overall）→
 *   https://qianchuan.jinritemai.com/uni-prom/overall?aavid=<账户ID>（标题"投放管理"）。
 * - 子标签：页面内"商品自选 / 全店托管"两个 ovui-tabs__tab（实测全店托管为默认激活）。
 *   商品自选视图实测 23 条"千川乘方"计划；全店托管视图实测 1 条全店托管计划（ID 184388555253250562）。
 * - 行结构：tr.ovui-tr > td；名称列含开关 .oc-switch > .ovui-switch.ovui-switch--checked；
 *   行文本含 "ID：<12-20位>"（全角冒号无空格）；状态列 .ad-status；行内动作 编辑/日志/删除。
 * - 分页：.ovui-page-total（"共 N 条记录"）；.ovui-page-select input（每页条数，实测 10条/页 默认，
 *   选项 10/20/50/100条/页）；翻页 li.ovui-page-turner__item（含 next-icon，禁用带 --disabled）。
 * - 批量操作栏：.oc-promotion-batch-operation-bar（默认 display:none），按钮
 *   data-auto-id="bar-groups-group-item-btn-pause"（暂停）、…-btn-delete（删除）、…-btn-open（开启）；
 *   文本分别为 暂停/删除/开启。防误删：本模块只允许暂停按钮，删除按钮仅识别标记、绝不返回可点击对象。
 * - 表头全选框：th 内 label.ovui-checkbox[data-e2e="checkbox"]（勾选当前页全部行 checkbox）。
 * - 账户：千川头部"伊人美 ID：1710242295996424"；cookie 来源"瑾漂亮潮流服饰.json"（电商助手只读）。
 *
 * 安全：真实页面只读导航 + 允许的 UI 切换（子标签/每页条数）；批量暂停原语仅供注入测试与
 * 演练计划使用，真实点击由上层 execute 门禁控制（默认关闭）。
 */

const path = require('path');
const { AuthError, DataGuardError } = require('../lib/errors');
const { maskUrlQueries } = require('../lib/log');
const { openQianchuanHome, closeBrowser } = require('./qianchuan-reader');
const { attestResourceNotCreated } = require('../lib/resource-attestation');
const {
  checkpointQianchuanSessionCookies,
  probeQianchuanHeaderIdentityInPage,
  discoverUnknownShopAccountId,
} = require('../login/session-cookie-checkpoint');

// 自动会话始终保持后台运行；仅控件定位失败时，另开一份同店铺可见会话供人工检查。
// 每店最多保留一个窗口，用户关闭窗口后下一轮才允许再次尝试。
const manualReviewSessions = new Map();

// ── 本次会话严格关闭证据（2026-10-18 F2-R3）────────────────────────
// openChengfangShop 的失败路径会在关闭浏览器后，把「本次是否真的已关闭」作为
// 非枚举、无凭据的纯数据证据挂到原始错误上；Monitor 只有读到 closed===true 才允许
// 同一周期内重读。closeBrowser 自身会吞掉 browser.close 的拒绝（并承载 Cookie 收尾），
// 因此它的返回/异常都不能作为成功证明；这里用 browser.isConnected() 的当前事实独立核对，
// 不可用/抛错/仍连接一律视为未证明。
const CLEANUP_EVIDENCE_KEY = 'chengfangCleanupEvidence';

function readChengfangCleanupEvidence(err) {
  if (!err || typeof err !== 'object') return null;
  const ev = err[CLEANUP_EVIDENCE_KEY];
  if (!ev || typeof ev !== 'object') return null;
  return {
    attempted: ev.attempted === true,
    closed: ev.closed === true,
    source: typeof ev.source === 'string' ? ev.source : 'unknown',
  };
}

function attachChengfangCleanupEvidence(err, evidence) {
  if (!err || typeof err !== 'object') return err;
  try {
    Object.defineProperty(err, CLEANUP_EVIDENCE_KEY, {
      value: {
        attempted: !!(evidence && evidence.attempted === true),
        closed: !!(evidence && evidence.closed === true),
        source: (evidence && typeof evidence.source === 'string') ? evidence.source : 'unknown',
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (_) { /* 错误对象不可扩展：保留原始错误，缺证明按未知处理 */ }
  return err;
}

/** 关闭后核对浏览器连接事实：只有明确 isConnected()===false 才算已关闭。 */
function proveChengfangBrowserClosed(browser) {
  if (!browser || typeof browser !== 'object') {
    return { attempted: false, closed: false, source: 'no-browser' };
  }
  if (typeof browser.isConnected !== 'function') {
    return { attempted: true, closed: false, source: 'isConnected-unavailable' };
  }
  try {
    return { attempted: true, closed: browser.isConnected() === false, source: 'browser.isConnected' };
  } catch (_) {
    return { attempted: true, closed: false, source: 'isConnected-threw' };
  }
}

// 跨周期收口句柄（2026-10-18 F3-R7）：失败路径已拿到 browser 对象时，绝不能抛掉引用后
// 让后续周期永远 unknown。browser 引用登记在模块内部 WeakMap（键为原始错误）：非枚举、
// 不可序列化、绝不进日志；Monitor 凭句柄推进本次真实关闭与连接核验，成功后清门恢复读取。
const chengfangCleanupHandles = new WeakMap();

function attachChengfangCleanupHandle(err, browser) {
  if (!err || typeof err !== 'object' || !browser || typeof browser !== 'object') return err;
  try { chengfangCleanupHandles.set(err, browser); } catch (_) { /* 不可作 WeakMap 键：保持无句柄（Monitor 保守阻断） */ }
  return err;
}

function readChengfangCleanupHandle(err) {
  if (!err || typeof err !== 'object') return null;
  return chengfangCleanupHandles.get(err) || null;
}

/**
 * 可信"本次未创建任何需收口资源"标记（2026-10-23；r13 缺口 1 收紧为所有权证明）：
 * 随原始错误交给 Monitor。只允许在**能证明本调用没有 launch 浏览器、也没有新建 context/page**
 * 的路径上由所有者本人调用；裸属性写入不再被 Monitor 采信（见 lib/resource-attestation.js）。
 */
function markChengfangResourceNotCreated(err) {
  return attestResourceNotCreated('chengfang-manual-review', err);
}

function isMissingChengfangControl(error) {
  const reason = String((error && (error.reason || error.message)) || error || '');
  return /(?:未找到|无法唯一定位|定位失败|二次定位不一致|控件缺失)/.test(reason)
    && /(?:子标签|按钮|开关|每页条数|全选框|批量操作栏|分页器|控件|确认弹窗)/.test(reason);
}

function manualReviewShopKey(shopCfg) {
  return String((shopCfg && (shopCfg.id || shopCfg.name || shopCfg.cookieFile)) || '');
}

function hasChengfangManualReview(shopCfg) {
  const key = manualReviewShopKey(shopCfg);
  const held = manualReviewSessions.get(key);
  if (!held) return false;
  if (held.page && typeof held.page.isClosed === 'function' && held.page.isClosed()) {
    manualReviewSessions.delete(key);
    return false;
  }
  return true;
}

/** 本次进程内的「保留窗口恢复者」占位：同店同一时刻只允许一个恢复者，绝不并发新开。 */
const manualReviewRecoveries = new Set();

/** 保留窗口内冻结的原始账户身份（只在内存；不写配置、不进日志）。 */
function readHeldFrozenAccountId(held) {
  const v = held && held.frozenAccountId;
  return (typeof v === 'string' && /^\d{8,20}$/.test(v)) ? v : null;
}

/** 保留窗口地址必须是严格可信千川乘方管理页（URL 解析，绝不子串匹配）。 */
function isTrustedChengfangUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  if (p.origin !== 'https://qianchuan.jinritemai.com') return false;
  if (/\/login|\/passport|\/signin|sso\.jinritemai/i.test(p.pathname)) return false;
  return CHENGFANG_URL_RE.test(p.pathname);
}

async function retainChengfangPageForManualReview({ context, target, shopCfg, loginCfg, browserFactory, cookieSession }) {
  const key = manualReviewShopKey(shopCfg);
  if (!key || !context || !target || typeof context.storageState !== 'function') return { held: false, reason: '页面会话不可用' };
  if (hasChengfangManualReview(shopCfg)) return { held: true, reused: true };
  const url = typeof target.url === 'function' ? target.url() : '';
  if (!/^https:\/\/qianchuan\.jinritemai\.com\//i.test(url)) return { held: false, reason: '当前不是千川页面' };
  // 保留时从**原会话当前唯一头部正证据**冻结账户ID：后续恢复只认这个冻结值。
  // 缺失/多候选/可见登录控件 → 不冻结（legacy/held 无身份一律不猜、不解除）。
  let frozenAccountId = null;
  try {
    if (typeof target.evaluate === 'function') {
      const obs = await target.evaluate(probeQianchuanHeaderIdentityInPage);
      if (obs && obs.unique === true && obs.loginVisible !== true
        && typeof obs.accountId === 'string' && /^\d{8,20}$/.test(obs.accountId)) {
        frozenAccountId = obs.accountId;
      }
    }
  } catch (_) { frozenAccountId = null; }
  // 仅保留文件路径/起始指纹两项元信息：绝不复制 identityPage（原 context 的页面在
  // 新 reviewContext 里不构成同 context 证据），也不复制任何 Cookie 值。
  const reviewCookieSession = (cookieSession && typeof cookieSession.filePath === 'string' && cookieSession.startFingerprint)
    ? { filePath: cookieSession.filePath, startFingerprint: cookieSession.startFingerprint }
    : null;
  let browser = null;
  try {
    const storageState = await context.storageState(); // 仅在内存传递，绝不写入日志或文件
    if (browserFactory) browser = await browserFactory();
    else {
      const { chromium } = require('playwright');
      browser = await chromium.launch({
        headless: false,
        executablePath: loginCfg.edgePath,
        args: ['--window-size=1920,1080'],
      });
    }
    const reviewContext = await browser.newContext({
      storageState,
      viewport: { width: 1920, height: 1080 },
      timezoneId: 'Asia/Shanghai',
    });
    const page = await reviewContext.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The original page can be covered by a first-visit overlay before its header
    // identity renders.  The freshly opened review page is still built from the
    // exact same in-memory storageState and URL, so take one more strict header
    // observation here.  This does not infer identity from the URL or shop config:
    // only one visible account id, with no login control, may fill the missing
    // frozen value.  Without that positive evidence the existing fail-closed
    // recovery guard remains unchanged.
    if (frozenAccountId == null && typeof page.evaluate === 'function') {
      try {
        const reviewObs = await page.evaluate(probeQianchuanHeaderIdentityInPage);
        if (reviewObs && reviewObs.unique === true && reviewObs.loginVisible !== true
          && typeof reviewObs.accountId === 'string' && /^\d{8,20}$/.test(reviewObs.accountId)) {
          frozenAccountId = reviewObs.accountId;
        }
      } catch (_) { /* keep null: recovery must remain blocked without proof */ }
    }
    if (typeof page.bringToFront === 'function') await page.bringToFront();
    const held = { browser, page, context: reviewContext, frozenAccountId, cookieSession: reviewCookieSession };
    manualReviewSessions.set(key, held);
    if (typeof page.on === 'function') page.on('close', () => {
      if (manualReviewSessions.get(key) === held) manualReviewSessions.delete(key);
      closeBrowser(browser);
    });
    if (typeof browser.on === 'function') browser.on('disconnected', () => {
      if (manualReviewSessions.get(key) === held) manualReviewSessions.delete(key);
    });
    return { held: true, reused: false, identityFrozen: frozenAccountId != null };
  } catch (e) {
    if (browser) await closeBrowser(browser);
    return { held: false, reason: `可见窗口打开失败：${e.message}` };
  }
}

async function holdOnMissingChengfangControl(error, session) {
  if (!error || typeof error !== 'object' || error.manualReviewHandled) return false;
  if (!isMissingChengfangControl(error)) return false;
  error.manualReviewHandled = true;
  // 注入的 browserFactory 属隔离测试，不得意外启动真实可见浏览器。
  if (session.browserFactory && !session.reviewBrowserFactory) return false;
  const held = await retainChengfangPageForManualReview({
    context: session.context,
    target: session.target,
    shopCfg: session.shopCfg,
    loginCfg: session.loginCfg,
    browserFactory: session.reviewBrowserFactory,
    cookieSession: session.cookieSession,
  });
  const suffix = held.held
    ? '；已保留可见千川页面供人工检查：请在保留窗口里点**浮窗右上角的 ❌** 关闭引导/介绍浮层（不是关闭整个浏览器，也不需要重新扫码）；'
      + '下一轮自动尝试会先核验同店身份与浮窗是否真的消失，核验通过才继续，未通过继续阻断'
    : `；未能打开人工检查窗口（${held.reason}），该轮仍停止自动操作`;
  error.reason = `${error.reason || error.message}${suffix}`;
  error.message = error.reason;
  return held.held;
}

/**
 * 只读控件恢复策略（业务动作永不隐式重放）：
 *  - IDEMPOTENT：重复执行同一目标状态是安全的（切同一 tab / 设同一页大小 / 回第一页）；
 *  - PROOF_REQUIRED：导航类动作（翻页）不幂等，必须先用前后页码快照证明「第一次未生效」
 *    才允许重试一次，否则宁可如实抛错，绝不二次翻页/漏页。
 * 业务动作 clickBatchPause / clickBatchEnable / clickRowSwitch / setRowCheckbox /
 * selectAllInPage 永远不在恢复集合内。
 */
const IDEMPOTENT_READ_ONLY_METHODS = new Set(['switchView', 'switchPageSize', 'ensureFirstPage']);
const PROOF_REQUIRED_READ_ONLY_METHODS = new Set(['clickNextPage']);

/** 只读页码快照（供导航类动作证明是否已生效；失败返回 null，按不可重试处理）。 */
async function readChengfangRecoveryPageState(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const st = await page.evaluate(collectChengfangPaginationInPage);
    return (st && typeof st === 'object') ? st : null;
  } catch (_) { return null; }
}

function watchChengfangControlsForManualReview(controller, session) {
  const methods = ['switchView', 'refreshView', 'switchPageSize', 'selectAllInPage',
    'clickBatchPause', 'clickBatchEnable', 'clickRowSwitch', 'setRowCheckbox',
    'clickNextPage', 'ensureFirstPage'];
  for (const name of methods) {
    if (typeof controller[name] !== 'function') continue;
    const original = controller[name];
    controller[name] = async function (...args) {
      const page = args[0] && args[0].page;
      const needsProof = PROOF_REQUIRED_READ_ONLY_METHODS.has(name);
      const idempotent = IDEMPOTENT_READ_ONLY_METHODS.has(name);
      // 导航类动作在第一次调用前记录页码，失败后只有证明「页码未变」才允许一次重试。
      const preState = (needsProof && page) ? await readChengfangRecoveryPageState(page) : null;
      let err = null;
      try { return await original.apply(this, args); }
      catch (e) { err = e; }
      let retryable = false;
      if (page && (idempotent || needsProof) && isMissingChengfangControl(err)) {
        const dr = await dismissKnownChengfangOverlays({
          page,
          audit: session.audit,
          shopId: session.shopCfg && session.shopCfg.id,
          maxRounds: 1,
        });
        if (dr.dismissed === true || dr.state === 'none') {
          if (idempotent) retryable = true;
          else {
            const postState = await readChengfangRecoveryPageState(page);
            retryable = !!(preState && postState
              && preState.activePage != null && postState.activePage != null
              && String(preState.activePage) === String(postState.activePage));
          }
        }
      }
      if (retryable) {
        try { return await original.apply(this, args); }
        catch (e2) { err = e2; }
      }
      await holdOnMissingChengfangControl(err, session);
      throw err;
    };
  }
  return controller;
}

/**
 * 有界关闭已知引导/介绍浮窗（节点侧）：只调用页面内的白名单探针/关闭器，绝不盲点任何 X。
 *
 * 规则：
 *  - 探针必须确认严格可信千川 origin/path；否则零点击；
 *  - 未知/多义/多个独立浮窗 → 阻断（零点击），不做任何猜测；
 *  - 已知浮窗只点容器内**唯一**关闭控件（intro）或唯一"跳过/我知道了"（guidance 容器内）；
 *  - 点击后必须**连续两次**观察到浮窗消失才算完成；未消失如实返回失败，绝不伪造关闭。
 *  - 2026-10-18 F1 有界重读：只读探针遭遇**短暂导航**（Execution context destroyed 等）
 *    或已知浮窗 root 的关闭控件**尚未就绪**（no-control）时，在总预算（默认 ≤3 秒、
 *    次数上限）内等待并重读；每次重读走完整探针（重新核验可信 URL/唯一控件）后才可能
 *    进入既有点击路径。未知/多义/危险阻断（blocked/untrusted）绝不重读、立即零点击返回；
 *    预算耗尽仍 no-control → 如实阻断，不扩大选择器、不点业务 CTA。
 * @returns {Promise<{dismissed:boolean, state:string, action?:string|null, reason?:string}>}
 */
async function dismissKnownChengfangOverlays({ page, audit, shopId, maxRounds = 2, gapMs = 250,
  transientBudgetMs = 3000, transientGapMs = 300, maxTransientRereads = 10 }) {
  const emit = (action, result, reason, extra) => {
    if (typeof audit !== 'function') return;
    try { audit({ kind: 'chengfang-overlay', shopId: shopId || null, action, result, reason: reason || null, ...(extra || {}) }); } catch (_) { /* 审计失败不影响结果 */ }
  };
  if (!page || typeof page.evaluate !== 'function') {
    return { dismissed: false, state: 'unavailable', reason: '页面不可用' };
  }
  const wait = async (ms) => {
    if (typeof page.waitForTimeout === 'function') { try { await page.waitForTimeout(ms); return; } catch (_) { /* 落到本地等待 */ } }
    await new Promise((r) => setTimeout(r, ms));
  };
  // 有界重读：仅针对「短暂导航销毁执行上下文」与「已知 root 控件尚未就绪」两类瞬态。
  const NAVIGATING_RE = /Execution context was destroyed|navigation|navigating/i;
  let transientRereads = 0;
  let transientDeadline = null;
  const transientWait = async (kind, detail) => {
    if (transientRereads >= maxTransientRereads) return false;
    const now = Date.now();
    if (transientDeadline === null) transientDeadline = now + Math.max(0, transientBudgetMs);
    if (now >= transientDeadline) return false;
    transientRereads += 1;
    emit('probe', 'transient-reread', `${kind}（有界重读 ${transientRereads}/${maxTransientRereads}，预算 ${transientBudgetMs}ms）：${detail}`);
    await wait(Math.min(transientGapMs, Math.max(50, transientDeadline - now)));
    return true;
  };
  // 完整探针 + 瞬态有界重读：每次重读都是全新的白名单探针（重新核验可信 URL/唯一控件）。
  const probeWithTransientReread = async () => {
    for (;;) {
      try {
        const p = await page.evaluate(handleChengfangOverlayInPage, { click: false });
        if (p && p.state === 'no-control' && await transientWait('control-not-ready', '已知浮窗缺少唯一点击控件（可能尚未渲染完成）')) continue;
        return { probe: p };
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (NAVIGATING_RE.test(msg) && await transientWait('probe-navigation', msg)) continue;
        return { error: msg };
      }
    }
  };
  let lastState = 'unknown';
  for (let round = 0; round < Math.max(1, maxRounds); round++) {
    const probed = await probeWithTransientReread();
    if (probed.error !== undefined) {
      return { dismissed: false, state: 'probe-failed', reason: `浮窗探测失败：${probed.error}` };
    }
    const probe = probed.probe;
    lastState = (probe && probe.state) || 'unknown';
    if (!probe || probe.trusted !== true) {
      emit('probe', 'blocked', '当前不是可信千川页面（严格 origin/path），零点击');
      return { dismissed: false, state: 'untrusted', reason: '当前不是可信千川页面，零点击' };
    }
    if (probe.state === 'blocked') {
      const reason = (probe.blockers || []).join(',') || '未知/多义浮窗';
      const diag = (probe.unknownDiag || []).slice(0, 5);
      emit('probe', 'blocked', reason, diag.length ? { unknownDiag: diag } : null);
      return { dismissed: false, state: 'blocked', reason, ...(diag.length ? { unknownDiag: diag } : {}) };
    }
    if (probe.state === 'no-control') {
      // 有界重读预算耗尽仍缺唯一控件：如实阻断（永久缺控件不猜测、不扩大选择器）。
      emit('probe', 'blocked', `已知浮窗缺少唯一点击控件，零点击（有界重读 ${transientRereads}/${maxTransientRereads} 次后仍未就绪）`);
      return { dismissed: false, state: 'no-control', reason: '已知浮窗缺少唯一点击控件，零点击' };
    }
    if (probe.state === 'none') {
      return { dismissed: round > 0, state: 'none', action: null };
    }
    // dismissable：点击容器内唯一控件（页面内会再校验一次，避免 TOCTOU）
    let clicked = null;
    try { clicked = await page.evaluate(handleChengfangOverlayInPage, { click: true }); }
    catch (e) { return { dismissed: false, state: 'click-failed', reason: `浮窗关闭点击失败：${(e && e.message) || e}` }; }
    if (!clicked || clicked.clicked !== true) {
      const reason = (clicked && clicked.blockers && clicked.blockers.join(',')) || '关闭控件未派发点击';
      const cdiag = ((clicked && clicked.unknownDiag) || []).slice(0, 5);
      emit('dismiss', 'failed', reason, cdiag.length ? { unknownDiag: cdiag } : null);
      return { dismissed: false, state: (clicked && clicked.state) || 'click-failed', reason, ...(cdiag.length ? { unknownDiag: cdiag } : {}) };
    }
    // 二次观察：连续两次探针都必须看到"无浮窗"才算完成
    let gone = 0;
    for (let i = 0; i < 2; i++) {
      await wait(gapMs);
      let again = null;
      try { again = await page.evaluate(handleChengfangOverlayInPage, { click: false }); } catch (_) { again = null; }
      if (again && again.trusted === true && again.state === 'none') gone += 1;
      else break;
    }
    if (gone === 2) {
      emit(clicked.action, 'dismissed', null);
      return { dismissed: true, state: 'none', action: clicked.action };
    }
    emit(clicked.action, 'failed', '点击后二次观察未消失');
    return { dismissed: false, state: 'not-disappeared', action: clicked.action, reason: '点击后浮窗未在二次观察中消失' };
  }
  return { dismissed: false, state: lastState, reason: '超过有界轮次仍未完成' };
}

const CHENGFANG_URL_MARKER = '/uni-prom/overall';
// 2026-09-21：千川把乘方管理页路径由 /uni-prom/overall 改为 /overall-prom，
// 此处同时兼容新旧两版（页面结构不变，仅路径前缀变化）。正则统一用本变量构造。
const CHENGFANG_URL_RE = /\/(uni-prom\/overall|overall-prom)(?:[/?#]|$)/i;
const SUB_TAB_OPTIONS = ['商品自选', '全店托管'];

// ── 纯 DOM 逻辑（页面 evaluate 与本地 fixture 测试共用同一函数）─────

/** 行文本内提取稳定计划ID（"ID：<12-20位>"，全角/半角冒号；多个候选拒绝）。 */
function resolveRowPlanIdFromText(rowText) {
  const matches = [];
  const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
  let m;
  while ((m = re.exec(rowText || ''))) matches.push(m[1]);
  const uniq = [...new Set(matches)];
  if (uniq.length === 0) return { ok: false, reason: '行内无计划ID文本' };
  if (uniq.length > 1) return { ok: false, reason: `行内出现多个候选ID: ${uniq.join(',')}，拒绝猜测` };
  return { ok: true, planId: uniq[0] };
}

/**
 * 收集当前页乘方计划行（自包含，evaluate 与 fixture 共用）。
 * 行判定：tr.ovui-tr 且（含投放开关 .oc-switch/.ovui-switch[data-e2e=switch] 或行文本含计划ID）；
 * 排除表头行（含 th）与汇总行（ovui-t-summary）。
 */
function collectChengfangRowsInPage() {
  // 状态词表内联（本函数会被 page.evaluate 序列化进浏览器执行，不能引用模块级常量）
  const STATUS_WORDS = ['投放中', '已暂停', '已终止', '已结束', '审核中', '已下线', '未投放', '投放完成', '预算不足', '已拒绝', '暂停中', '已删除'];
  const out = { rows: [], total: null, totalText: null, ui: 'legacy' };
  const bodyText = document.body ? document.body.innerText : '';
  const tm = /共\s*([\d,]+)\s*条记录|共\s*([\d,]+)\s*条计划/.exec(bodyText);
  if (tm) {
    out.total = Number(String(tm[1] || tm[2]).replace(/,/g, ''));
    out.totalText = tm[0].replace(/\s+/g, ' ');
  }

  // 2026-09-21：千川乘方管理页整体迁移到新前端（aurora-qc 组件：
  // .aurora-qc-table / .aurora-qc-switch / .aurora-qc-pagination），旧 .ovui-* 结构消失
  // （旧路径 /uni-prom/overall 与新路径 /overall-prom 都是新 UI，实测同日）。
  // 新 UI 行：tr[data-row-key=<计划ID>]（汇总行 rowKey=__qc_table_summary_row__、
  // 度量行 .aurora-qc-table-measure-row 必须排除）；开关状态取 .aurora-qc-switch 的 aria-checked。
  if (document.querySelector('.aurora-qc-table')) {
    out.ui = 'aurora';
    const trs = [...document.querySelectorAll('.aurora-qc-table-tbody tr, .aurora-qc-table-row')];
    const seen = new Set();
    let rowIndex = 0;
    for (const tr of trs) {
      if (seen.has(tr)) continue;
      seen.add(tr);
      if (String(tr.className || '').includes('measure-row')) continue;
      const key = String(tr.getAttribute('data-row-key') || '').trim();
      if (!/^\d{12,20}$/.test(key)) continue; // 汇总/度量/分组行不当作计划行
      const rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      const sw = tr.querySelector('.aurora-qc-switch');
      const swCount = tr.querySelectorAll('.aurora-qc-switch').length;
      const aria = sw ? String(sw.getAttribute('aria-checked') || '') : '';
      const checked = swCount === 1 ? (aria === 'true') : null;
      const statusEl = tr.querySelector('[class*="ad-status"], [class*="status"]');
      let status = '';
      if (statusEl) {
        const raw = (statusEl.textContent || '').replace(/\s+/g, ' ').trim();
        for (const w of STATUS_WORDS) {
          if (raw.includes(w)) { status = w; break; }
        }
      }
      if (!status) {
        for (const w of STATUS_WORDS) {
          if (rowText.includes(w)) { status = w; break; }
        }
      }
      const cb = tr.querySelector('input[type="checkbox"]');
      const idText = new Set();
      const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
      let mm;
      while ((mm = re.exec(rowText))) idText.add(mm[1]);
      // 行键即平台计划ID（data-row-key）：行内文本ID仅作参考——新 UI 相邻单元格数字会与
      // "ID：" 连写（如 ID：1875859981405339 29），文本解析不再作为一致性判据。
      const ops = [...tr.querySelectorAll('.aurora-qc-promotion-operation-item, .oc-promotion-operation-action-item')]
        .map((s) => (s.textContent || '').trim())
        .filter((t) => /^(编辑|日志|删除|暂停|开启)$/.test(t));
      const nameEl = tr.querySelector('[class*="name"], [class*="Name"]');
      out.rows.push({
        rowIndex,
        id: key,
        idError: null,
        textIds: [...idText],
        name: (nameEl ? (nameEl.textContent || '') : rowText).replace(/\s+/g, ' ').trim().slice(0, 60),
        status,
        switchChecked: checked,
        switchCls: sw ? String(sw.className || '').slice(0, 60) : '',
        switchAria: aria || null,
        checkboxChecked: cb ? cb.checked : null,
        ops: [...new Set(ops)],
        rowText: rowText.slice(0, 300),
      });
      rowIndex += 1;
    }
    return out;
  }

  const trs = document.querySelectorAll('tr.ovui-tr');
  let rowIndex = 0;
  for (const tr of trs) {
    if (String(tr.className || '').includes('ovui-t-summary')) continue;
    if (tr.querySelector('th')) continue;
    // 开关容器：外层 .oc-switch 包裹内层 .ovui-switch[data-e2e=switch]；
    // 选中态标记（--checked）在内层（2026-09-13 实测结构），须穿透检测，不能只看外层类。
    const sw = tr.querySelector('.oc-switch, .ovui-switch[data-e2e="switch"]');
    const rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim();
    const hasId = /ID[:：]\s*\d{12,20}/.test(rowText);
    if (!sw && !hasId) continue;
    const idMatches = [];
    const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
    let mm;
    while ((mm = re.exec(rowText))) idMatches.push(mm[1]);
    const uniqIds = [...new Set(idMatches)];
    const swCls = sw ? String(sw.className || '') : '';
    const checked =
      sw ? (
        swCls.includes('ovui-switch--checked') || swCls.includes('oc-switch--checked')
        || !!sw.querySelector('.ovui-switch--checked, .oc-switch--checked')
      ) : null;
    const statusEl = tr.querySelector('.ad-status, [class*="ad-status"]');
    let status = statusEl ? (statusEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!status) {
      for (const w of STATUS_WORDS) {
        if (rowText.includes(w)) { status = w; break; }
      }
    }
    const cb = tr.querySelector('input[type="checkbox"]');
    const ops = [...tr.querySelectorAll('.oc-promotion-operation-action-item')]
      .map((s) => (s.textContent || '').trim())
      .filter((t) => /^(编辑|日志|删除|暂停|开启)$/.test(t));
    out.rows.push({
      rowIndex,
      id: uniqIds.length === 1 ? uniqIds[0] : null,
      idError: uniqIds.length === 0 ? '行内无计划ID' : (uniqIds.length > 1 ? `行内多个候选ID: ${uniqIds.join(',')}` : null),
      name: rowText.slice(0, 60),
      status,
      switchChecked: checked,
      switchCls: swCls.slice(0, 60),
      checkboxChecked: cb ? cb.checked : null,
      ops: [...new Set(ops)],
      rowText: rowText.slice(0, 300),
    });
    rowIndex += 1;
  }
  return out;
}

/** 分页信息（自包含）。 */
function collectChengfangPaginationInPage() {
  const out = { total: null, totalText: null, pageSize: null, activePage: null, hasNext: null, ui: 'legacy' };
  // 新 UI（aurora-qc）：总数 .aurora-qc-pagination-total-text（"共 23 条记录"），
  // 每页条数取选项控件当前值（"10 条/页"），当前页 .aurora-qc-pagination-item-active，
  // 下一页 .aurora-qc-pagination-next（禁用时类名含 -disabled）。
  if (document.querySelector('.aurora-qc-table')) {
    out.ui = 'aurora';
    const totalEl = document.querySelector('.aurora-qc-pagination-total-text');
    if (totalEl) {
      const t = (totalEl.textContent || '').replace(/\s+/g, ' ').trim();
      out.totalText = t;
      const m = /(\d[\d,]*)/.exec(t);
      if (m) out.total = Number(m[1].replace(/,/g, ''));
    } else {
      const body = document.body ? document.body.innerText : '';
      const m = /共\s*([\d,]+)\s*条(记录|计划)/.exec(body);
      if (m) { out.total = Number(m[1].replace(/,/g, '')); out.totalText = m[0].replace(/\s+/g, ' '); }
    }
    const selVal = document.querySelector('.aurora-qc-pagination-options .aurora-qc-select-content-value');
    if (selVal) {
      const t = (selVal.getAttribute('title') || selVal.textContent || '').replace(/\s+/g, '').trim();
      const m = /(\d+)/.exec(t);
      if (m) out.pageSize = m[1];
    }
    const active = document.querySelector('.aurora-qc-pagination-item-active');
    if (active) {
      const t = (active.textContent || '').trim();
      if (/^\d+$/.test(t)) out.activePage = t;
    }
    if (out.activePage == null) {
      const items = [...document.querySelectorAll('.aurora-qc-pagination-item')];
      if (items.length <= 1) out.activePage = '1';
    }
    const next = document.querySelector('.aurora-qc-pagination-next');
    if (next) out.hasNext = !String(next.className || '').includes('disabled');
    return out;
  }
  const totalEl = document.querySelector('.ovui-page-total, [data-e2e*="pagination_group_total"]');
  if (totalEl) {
    const t = (totalEl.textContent || '').replace(/\s+/g, ' ').trim();
    out.totalText = t;
    const m = /(\d[\d,]*)/.exec(t);
    if (m) out.total = Number(m[1].replace(/,/g, ''));
  }
  const selInput = document.querySelector('.ovui-page-select input');
  out.pageSize = selInput ? selInput.value : null;
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    const txt = (li.textContent || '').trim();
    if (/^\d+$/.test(txt) && String(li.className || '').includes('--active')) out.activePage = txt;
    if (li.querySelector('.ovui-page-turner__next-icon')) {
      out.hasNext = !String(li.className || '').includes('--disabled');
    }
  }
  return out;
}

/**
 * 切换子标签（商品自选/全店托管）。
 * 2026-09-27 实页证据（高定私服）：aurora 新 UI 计划视图下两子视图是
 * .aurora-qc-radio-group 单选组——必须精确点击目标单选项（input[type=radio]
 * 优先，其次 wrapper），绝不点击外层组容器（div.tabs-*，点中也切不动视图）；
 * 点击后核对选中态（input.checked 或 wrapper 含 -checked 类），未确认则如实
 * 失败，绝不虚报成功。
 * 2026-09-27 实页证据二（潮流服饰，clf-inspect.json）：另一 aurora 变体是两个
 * role=tab（"商品自选" 文本全等；"全店托管加速新品爆发" 前缀起始）——优先找
 * 唯一目标 role=tab（文本全等或前缀起始，多候选拒绝猜测），点击真实 tab 控件；
 * 页面提供 aria-selected 时点击后核对已选中，未确认则如实失败；已选中保持幂等。
 * 旧 UI 保持"含该文本的 tab 祖先并点击"原口径；单选组内元素不走 tab 祖先后备，
 * 防止后备命中组容器。
 */
const clickChengfangSubTab = (label) => `(async () => {
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labels = [...document.querySelectorAll('.aurora-qc-radio-group .aurora-qc-radio-button-label')]
    .filter((el) => (el.textContent || '').trim() === '${label}' && visible(el));
  if (labels.length > 1) return { clicked: false, reason: '单选标签候选 ' + labels.length + ' 个，拒绝猜测' };
  if (labels.length === 1) {
    const wrap = labels[0].closest('.aurora-qc-radio-button-wrapper');
    if (!wrap) return { clicked: false, reason: '未找到目标单选项容器' };
    const input = wrap.querySelector('input[type="radio"]');
    const selected = () => !!(input && input.checked) || String(wrap.className || '').includes('checked');
    if (selected()) return { clicked: true, target: 'aurora-radio', alreadySelected: true };
    (input || wrap).click();
    for (let i = 0; i < 10; i++) {
      if (selected()) return { clicked: true, target: 'aurora-radio', verified: true };
      await new Promise((res) => setTimeout(res, 150));
    }
    return { clicked: false, target: 'aurora-radio', reason: '已点击目标单选项但选中态未确认，拒绝虚报成功' };
  }
  let tabCands = [...document.querySelectorAll('[role="tab"]')]
    .filter((el) => visible(el) && !(el.closest && el.closest('.aurora-qc-radio-group')))
    .filter((el) => { const t = (el.textContent || '').trim(); return t === '${label}' || t.startsWith('${label}'); });
  tabCands = tabCands.filter((el) => !tabCands.some((p) => p !== el && p.contains(el)));
  if (tabCands.length > 1) return { clicked: false, reason: '目标 tab 候选 ' + tabCands.length + ' 个，拒绝猜测' };
  if (tabCands.length === 1) {
    const tab = tabCands[0];
    const hasAria = tab.getAttribute('aria-selected') != null;
    const isSel = () => tab.getAttribute('aria-selected') === 'true';
    if (hasAria && isSel()) return { clicked: true, target: 'aurora-tab', alreadySelected: true };
    tab.click();
    if (hasAria) {
      for (let i = 0; i < 10; i++) {
        if (isSel()) return { clicked: true, target: 'aurora-tab', verified: true };
        await new Promise((res) => setTimeout(res, 150));
      }
      return { clicked: false, target: 'aurora-tab', reason: '已点击目标 tab 但选中态未确认，拒绝虚报成功' };
    }
    return { clicked: true, target: 'aurora-tab' };
  }
  const els = [...document.querySelectorAll('body *')].filter((el) => {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
    return own === '${label}' && el.getBoundingClientRect().width > 0;
  });
  for (const el of els) {
    if (el.closest && el.closest('.aurora-qc-radio-group')) continue;
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const cls = String(cur.className || '');
      const role = cur.getAttribute && cur.getAttribute('role');
      if (/tab|Tab|tabs|Tabs/.test(cls) || role === 'tab') {
        const r = cur.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { cur.click(); return { clicked: true, cls: cls.slice(0, 60) }; }
      }
      cur = cur.parentElement;
    }
  }
  return { clicked: false, reason: '未找到目标子标签' };
})()`;

/** 打开每页条数下拉（只读 UI）。 */
function openChengfangPageSizeSelectInPage() {
  // 新 UI：li.aurora-qc-pagination-options 内的 aurora-qc-select（ant 风格，需 mousedown 展开）
  const auroraSel = document.querySelector('.aurora-qc-pagination-options .aurora-qc-select');
  if (auroraSel) {
    auroraSel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const content = auroraSel.querySelector('.aurora-qc-select-content') || auroraSel;
    content.click();
    return { opened: true, ui: 'aurora' };
  }
  const sel = document.querySelector('.ovui-page-select .ovui-select__input, .ovui-page-select, [data-e2e*="pagination_group_select"]');
  if (!sel) return { opened: false, reason: '未找到每页条数下拉' };
  const clickable = sel.closest('.ovui-select, [class*="select"]') || sel;
  clickable.click();
  return { opened: true, ui: 'legacy' };
}

/** 选择每页条数选项（如"100条/页"）。 */
function pickChengfangPageSizeInPage(text) {
  const opts = [...document.querySelectorAll('.ovui-option, .aurora-qc-select-item-option, .aurora-qc-select-item')];
  const target = opts.find((o) => (o.textContent || '').replace(/\s+/g, '').includes(text));
  if (!target) {
    return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
  }
  target.click();
  return { picked: true };
}

/** 勾选表头全选框（旧 UI：th 内 label.ovui-checkbox；新 UI：表头 input[type=checkbox]）。仅勾选，不触碰批量按钮。 */
function clickChengfangHeaderSelectAllInPage() {
  const aurora = document.querySelector('.aurora-qc-table-thead input[type="checkbox"]');
  if (aurora) {
    if (aurora.disabled) return { clicked: false, reason: '表头全选框不可用' };
    aurora.click();
    return { clicked: true, ui: 'aurora' };
  }
  const label = document.querySelector('th .ovui-checkbox[data-e2e="checkbox"], th label.ovui-checkbox, th .ovui-checkbox');
  if (!label) return { clicked: false, reason: '未找到表头全选框' };
  const input = label.querySelector('input[type="checkbox"]');
  if (input && !input.disabled) input.click();
  else label.click();
  return { clicked: true, ui: 'legacy' };
}

/** 读取当前页选中行集合（行内 checkbox:checked → 行稳定ID）。自包含。 */
function readSelectedChengfangRowIdsInPage() {
  const out = { selectedIds: [], selectedCount: 0, checkedRows: [], ui: 'legacy' };
  if (document.querySelector('.aurora-qc-table')) {
    out.ui = 'aurora';
    const trs = [...document.querySelectorAll('.aurora-qc-table-tbody tr[data-row-key]')];
    for (const tr of trs) {
      if (String(tr.className || '').includes('measure-row')) continue;
      const key = String(tr.getAttribute('data-row-key') || '').trim();
      if (!/^\d{12,20}$/.test(key)) continue;
      const cb = tr.querySelector('input[type="checkbox"]');
      if (!cb || !cb.checked) continue;
      out.selectedIds.push(key);
      out.checkedRows.push({ id: key, text: (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
    out.selectedCount = out.checkedRows.length;
    return out;
  }
  const trs = document.querySelectorAll('tr.ovui-tr');
  for (const tr of trs) {
    if (String(tr.className || '').includes('ovui-t-summary')) continue;
    if (tr.querySelector('th')) continue;
    const cb = tr.querySelector('input[type="checkbox"]');
    if (!cb || !cb.checked) continue;
    const rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim();
    const idMatches = [];
    const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
    let mm;
    while ((mm = re.exec(rowText))) idMatches.push(mm[1]);
    const uniqIds = [...new Set(idMatches)];
    if (uniqIds.length === 1) out.selectedIds.push(uniqIds[0]);
    out.checkedRows.push({ id: uniqIds.length === 1 ? uniqIds[0] : null, text: rowText.slice(0, 80) });
  }
  out.selectedCount = out.checkedRows.length;
  return out;
}

/**
 * 批量操作栏"暂停"按钮精确定位（防误删核心）：
 * 限定在批量操作栏容器内，文本必须为"暂停"；全部候选数 0 或 >1 → 拒绝（零点击）；
 * 唯一候选必须带可识别标记（data-auto-id 含 btn-pause 或 data-e2e 以 _pause 结尾），
 * 无标记的纯文本"暂停"不可信（禁止模糊文本兜底）。绝不返回"删除"/"开启"。
 */
function findChengfangBatchPauseButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return { ok: false, reason: '未找到可见批量操作栏' };
  // 新 UI：批量操作项为 span.aurora-qc-promotion-batch-operation-bar-item（无 data 标记），
  // 以**精确文本**唯一匹配兜底；文本必须恰为"暂停"，且在可见批量栏内（删除/开启不会被选中）。
  const auroraItems = [...bar.querySelectorAll('.aurora-qc-promotion-batch-operation-bar-item')]
    .filter((b) => (b.textContent || '').trim() === '暂停');
  if (auroraItems.length === 1 && bar.querySelectorAll('.oc-promotion-batch-operation-bar').length === 0) {
    return { ok: true, e2e: '', autoId: '', tag: auroraItems[0].tagName, marker: 'aurora-exact-text' };
  }
  const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '暂停');
  if (btns.length === 0) return { ok: false, reason: '批量操作栏内未找到"暂停"按钮（删除/开启不得被选中）' };
  if (btns.length > 1) return { ok: false, reason: `批量操作栏内出现 ${btns.length} 个"暂停"候选，拒绝点击` };
  const b = btns[0];
  const autoId = b.getAttribute('data-auto-id') || '';
  const e2e = b.getAttribute('data-e2e') || '';
  if (!/btn-pause$/.test(autoId) && !/_pause$/.test(e2e)) {
    return { ok: false, reason: `唯一"暂停"候选缺少可识别标记（autoId=${autoId || '-'} e2e=${e2e || '-'}），禁止模糊文本兜底` };
  }
  return { ok: true, e2e, autoId, tag: b.tagName };
}

/**
 * 批量操作栏"开启"按钮精确定位（防误删/防误暂停）：
 * 限定在批量操作栏容器内，文本必须为"开启"；全部候选数 0 或 >1 → 拒绝（零点击）；
 * 唯一候选必须带可识别标记（data-auto-id 含 btn-open 或 data-e2e 以 _open 结尾），
 * 无标记的纯文本"开启"不可信（禁止模糊文本兜底）。绝不返回"删除"/"暂停"。
 */
function findChengfangBatchEnableButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return { ok: false, reason: '未找到可见批量操作栏' };
  // 新 UI：同"暂停"——精确文本唯一匹配，且在可见批量栏内（删除/暂停不会被选中）。
  const auroraItems = [...bar.querySelectorAll('.aurora-qc-promotion-batch-operation-bar-item')]
    .filter((b) => (b.textContent || '').trim() === '开启');
  if (auroraItems.length === 1 && bar.querySelectorAll('.oc-promotion-batch-operation-bar').length === 0) {
    return { ok: true, e2e: '', autoId: '', tag: auroraItems[0].tagName, marker: 'aurora-exact-text' };
  }
  const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '开启');
  if (btns.length === 0) return { ok: false, reason: '批量操作栏内未找到"开启"按钮（删除/暂停不得被选中）' };
  if (btns.length > 1) return { ok: false, reason: `批量操作栏内出现 ${btns.length} 个"开启"候选，拒绝点击` };
  const b = btns[0];
  const autoId = b.getAttribute('data-auto-id') || '';
  const e2e = b.getAttribute('data-e2e') || '';
  if (!/btn-open$/.test(autoId) && !/_open$/.test(e2e)) {
    return { ok: false, reason: `唯一"开启"候选缺少可识别标记（autoId=${autoId || '-'} e2e=${e2e || '-'}），禁止模糊文本兜底` };
  }
  return { ok: true, e2e, autoId, tag: b.tagName };
}

/**
 * 读取批量操作栏当前状态（自包含）：
 * 返回 { visible, selectedText, selectedCount, buttons }；"已选N个" 用于
 * 点击前核验所选范围（与 readSelectedChengfangRowIdsInPage 交叉核对）。
 */
function readChengfangBatchBarInPage() {
  const out = { visible: false, selectedText: null, selectedCount: null, buttons: [], ui: 'legacy' };
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return out;
  out.visible = true;
  if (bar.querySelector('.aurora-qc-promotion-batch-operation-bar-item')) out.ui = 'aurora';
  const text = (bar.textContent || '').replace(/\s+/g, ' ').trim();
  out.selectedText = text.slice(0, 60);
  const m = /已选\s*(\d+)\s*个/.exec(text);
  if (m) out.selectedCount = Number(m[1]);
  const items = bar.querySelectorAll('button, .aurora-qc-promotion-batch-operation-bar-item');
  for (const b of items) {
    const t = (b.textContent || '').trim();
    if (!t) continue;
    out.buttons.push({
      text: t,
      e2e: b.getAttribute('data-e2e') || '',
      autoId: b.getAttribute('data-auto-id') || '',
    });
  }
  return out;
}

/** 批量操作栏"删除"按钮识别（仅标记，绝不返回可点击句柄）。 */
function findChengfangBatchDeleteButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
  const out = [];
  for (const bar of bars) {
    for (const b of bar.querySelectorAll('button, .aurora-qc-promotion-batch-operation-bar-item')) {
      const t = (b.textContent || '').trim();
      if (t === '删除' || /_delete$/.test(b.getAttribute('data-e2e') || '')
        || b.getAttribute('data-auto-id') === 'bar-groups-group-item-btn-delete') {
        out.push({ text: t, e2e: b.getAttribute('data-e2e') || '', autoId: b.getAttribute('data-auto-id') || '' });
      }
    }
  }
  return out;
}

/**
 * 弹窗分类（内部工具；不导出，供 danger 检测与确认提交共用）。
 *
 * 2026-09-15 修复（交接第 2 项）：正式控制器此前只能识别"删除/非预期"弹窗，无法提交
 * 合法业务确认弹窗，导致真实暂停/开启链路在弹窗处断掉。
 *
 * 严格原则：**只确认与当前动作、数量精确一致的弹窗**；未知结构一律阻断（不猜测、不兜底）。
 *
 * 实测已确认的合法弹窗（仅此三类，文本来自真实页面）：
 *   - 批量暂停：「确定要暂停 N 条计划吗？暂停后将停止投放，请谨慎操作。 取消 确定」
 *   - 托管关闭：「确定关闭乘方投放吗？」（另有"其他推商品计划需手动恢复"的提示，用户已同意）
 *   - 托管开启（2026-09-15 真机实测）：「为保证投放的唯一性，温馨提示您乘方投放时，
 *     受到互斥影响的放量投放-全域投放计划、标准投放计划将会暂停（如有）。同时小店随心推
 *     订单将被终止，终止后不可恢复。」按钮【再想想】【确定】；实测批量开启（商品自选）
 *     无确认弹窗（点击即生效），故 batch_enable 不声明文本句式——出现任何弹窗仍按未知阻断。
 *
 * 注意：本函数同时以文本形式内联进 page.evaluate 的执行体（浏览器序列化不支持闭包引用），
 * 因此必须保持**自包含**（不引用模块级常量/函数）。
 */
function classifyDialogText(text, expectedAction) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { kind: 'empty', text: '' };

  // 1) 删除确认：绝对禁止确认（最高优先级，先判）
  if (t.includes('删除')) return { kind: 'delete_confirm', text: t.slice(0, 200) };

  // 2) 批量暂停确认：文本必须精确匹配"确定要暂停 N 条计划吗"句式
  const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
  if (mPause) {
    const count = Number(mPause[1]);
    const okText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
    if (expectedAction === 'batch_pause') {
      return { kind: 'batch_pause_confirm', text: t.slice(0, 200), count, exactText: okText };
    }
    // 当前动作不是批量暂停，却弹出暂停确认 → 非预期，阻断
    return { kind: 'unexpected_confirm', text: t.slice(0, 200), count };
  }

  // 3) 全店托管关闭确认
  if (/确定关闭乘方投放吗/.test(t)) {
    if (expectedAction === 'shop_disable') {
      return { kind: 'shop_disable_confirm', text: t.slice(0, 200), count: null };
    }
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }

  // 3b) 全店托管开启确认（2026-09-15 真机实测：互斥提示，按钮【再想想】【确定】）。
  // 双锚点精确匹配，任一不满足 → 落入未知阻断；含"删除"字样已被上面分支拦截。
  if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
    if (expectedAction === 'shop_enable') {
      return { kind: 'shop_enable_confirm', text: t.slice(0, 200), count: null };
    }
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }

  // 4) 含"确定/确认"但结构未知：不得编造，一律阻断
  if (t.includes('确定') || t.includes('确认')) {
    return { kind: 'unknown_confirm', text: t.slice(0, 200) };
  }
  return { kind: 'other', text: t.slice(0, 200) };
}

/**
 * 弹窗分类的浏览器内联版本（与 classifyDialogText 保持逐字一致，供 page.evaluate 序列化使用）。
 * 二者必须同步修改；此处为避免闭包引用导致的 ReferenceError 而独立定义。
 */
function classifyDialogTextInPage(text, expectedAction) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { kind: 'empty', text: '' };
  if (t.includes('删除')) return { kind: 'delete_confirm', text: t.slice(0, 200) };
  const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
  if (mPause) {
    const count = Number(mPause[1]);
    const okText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
    if (expectedAction === 'batch_pause') return { kind: 'batch_pause_confirm', text: t.slice(0, 200), count, exactText: okText };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200), count };
  }
  if (/确定关闭乘方投放吗/.test(t)) {
    if (expectedAction === 'shop_disable') return { kind: 'shop_disable_confirm', text: t.slice(0, 200), count: null };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }
  if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
    if (expectedAction === 'shop_enable') return { kind: 'shop_enable_confirm', text: t.slice(0, 200), count: null };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }
  if (t.includes('确定') || t.includes('确认')) return { kind: 'unknown_confirm', text: t.slice(0, 200) };
  return { kind: 'other', text: t.slice(0, 200) };
}

/** 可见弹窗候选（内部工具；自包含，须可被 page.evaluate 序列化）。 */
function visibleChengfangDialogElsInPage() {
  return [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
}

/**
 * 非预期弹窗检测：可见的 dialog/modal/confirm 类元素。
 * 文本含"删除"→ 删除确认（绝对禁止确认）；含"确定/确认"但非当前动作的合法弹窗 → 阻断。
 * 返回 { kind, text, count? }[]；调用方据 expectedAction 判定是否可确认。
 * 自包含：不引用模块级函数（page.evaluate 序列化限制）。
 */
function detectChengfangDangerDialogInPage(expectedAction) {
  const out = [];
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let c;
    if (t.includes('删除')) c = { kind: 'delete_confirm', text: t.slice(0, 200) };
    else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) {
        c = (expectedAction === 'batch_pause')
          ? { kind: 'batch_pause_confirm', text: t.slice(0, 200), count: Number(mPause[1]) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200), count: Number(mPause[1]) };
      } else if (/确定关闭乘方投放吗/.test(t)) {
        c = (expectedAction === 'shop_disable')
          ? { kind: 'shop_disable_confirm', text: t.slice(0, 200) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200) };
      } else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
        c = (expectedAction === 'shop_enable')
          ? { kind: 'shop_enable_confirm', text: t.slice(0, 200) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200) };
      } else if (t.includes('确定') || t.includes('确认')) {
        c = { kind: 'unknown_confirm', text: t.slice(0, 200) };
      } else {
        c = { kind: 'other', text: t.slice(0, 200) };
      }
    }
    if (c.kind === 'other' || c.kind === 'empty') continue;
    out.push(c);
  }
  return out;
}

/**
 * 读取当前可见的业务确认弹窗（含按钮句柄定位信息；不点击）。
 * 供 clickBatchPause/clickBatchEnable/托管关闭的"点击 → 检测弹窗 → 提交确认"闭环。
 * 仅返回与 expectedAction 精确一致的弹窗；未知/删除/不匹配 → 由调用方阻断。
 * 自包含：不引用模块级函数。
 */
function readChengfangConfirmDialogInPage(expectedAction) {
  const out = { found: false, kind: null, text: '', count: null, buttons: [], okCandidateCount: 0, cancelCandidateCount: 0, exactText: false };
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let kind = null; let count = null; let exactText = false;
    if (t.includes('删除')) {
      kind = 'delete_confirm';
    } else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) {
        count = Number(mPause[1]);
        exactText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
        kind = (expectedAction === 'batch_pause') ? 'batch_pause_confirm' : 'unexpected_confirm';
      } else if (/确定关闭乘方投放吗/.test(t)) {
        kind = (expectedAction === 'shop_disable') ? 'shop_disable_confirm' : 'unexpected_confirm';
      } else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
        kind = (expectedAction === 'shop_enable') ? 'shop_enable_confirm' : 'unexpected_confirm';
      } else if (t.includes('确定') || t.includes('确认')) {
        kind = 'unknown_confirm';
      } else {
        kind = 'other';
      }
    }
    if (kind === 'other') continue;
    out.found = true;
    out.kind = kind;
    out.text = t.slice(0, 200);
    out.count = count;
    out.exactText = exactText;
    const btns = [...el.querySelectorAll('button')];
    for (const b of btns) {
      const bt = (b.textContent || '').replace(/\s+/g, '').trim();
      if (!bt) continue;
      const isOk = bt === '确定' || bt === '确认' || bt === '确认暂停' || bt === '确认关闭';
      const isCancel = bt === '取消';
      out.buttons.push({ text: bt, isOk, isCancel, e2e: b.getAttribute('data-e2e') || '', autoId: b.getAttribute('data-auto-id') || '' });
      if (isOk) out.okCandidateCount += 1;
      if (isCancel) out.cancelCandidateCount += 1;
    }
    break;
  }
  return out;
}

/**
 * 点击确认弹窗中的"确定"（唯一候选；二次定位核验）。
 * 严格条件：可见弹窗文本须与 expectedAction 精确一致；弹窗内"确定"类候选恰好 1 个。
 * 任何不满足 → 返回 { ok:false, reason }，零点击。自包含：不引用模块级函数。
 *
 * 参数为单对象 { action, expectedCount }（page.evaluate 只接受单个参数，且数组会被视为
 * 多参数展开，故必须用对象承载）。
 */
function clickChengfangConfirmOkInPage({ action, expectedCount }) {
  const expectedAction = action;
  const wantKind = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
    : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
      : (expectedAction === 'batch_enable' ? 'batch_enable_confirm'
        : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : null)));
  if (!wantKind) return { ok: false, reason: `动作 ${expectedAction} 无确认弹窗结构定义，零点击` };
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let kind = null; let count = null;
    if (t.includes('删除')) kind = 'delete_confirm';
    else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) { count = Number(mPause[1]); kind = (expectedAction === 'batch_pause') ? 'batch_pause_confirm' : 'unexpected_confirm'; }
      else if (/确定关闭乘方投放吗/.test(t)) kind = (expectedAction === 'shop_disable') ? 'shop_disable_confirm' : 'unexpected_confirm';
      else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) kind = (expectedAction === 'shop_enable') ? 'shop_enable_confirm' : 'unexpected_confirm';
      else if (t.includes('确定') || t.includes('确认')) kind = 'unknown_confirm';
      else kind = 'other';
    }
    if (kind !== wantKind) continue;
    if (expectedCount != null && count != null && count !== expectedCount) {
      return { ok: false, reason: `弹窗数量不匹配：期望 ${expectedCount}，弹窗 ${count}，零点击` };
    }
    const okBtns = [...el.querySelectorAll('button')].filter((b) => {
      const bt = (b.textContent || '').replace(/\s+/g, '').trim();
      return bt === '确定' || bt === '确认' || bt === '确认暂停' || bt === '确认关闭';
    });
    if (okBtns.length !== 1) return { ok: false, reason: `"确定"候选数为 ${okBtns.length}（要求恰好 1 个），零点击` };
    okBtns[0].click();
    return { ok: true, kind: wantKind, count };
  }
  return { ok: false, reason: `未找到与动作 ${expectedAction} 匹配的确认弹窗，零点击` };
}

/** 是否存在可见的删除确认弹窗（删除零点击守卫；在任何点击前调用）。自包含。 */
function hasChengfangDeleteDialogInPage() {
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.includes('删除')) return { found: true, text: t.slice(0, 200) };
  }
  return { found: false };
}

/** 翻页到下一页（事件绑在 li 上；点到内部 svg 不翻页——实测踩坑）。 */
function clickChengfangNextPageInPage() {
  const auroraNext = document.querySelector('.aurora-qc-pagination-next');
  if (auroraNext) {
    if (String(auroraNext.className || '').includes('disabled')) return { clicked: false, atEnd: true };
    const btn = auroraNext.querySelector('.aurora-qc-pagination-item-link') || auroraNext;
    btn.click();
    return { clicked: true, ui: 'aurora' };
  }
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    if (!li.querySelector('.ovui-page-turner__next-icon')) continue;
    if (String(li.className || '').includes('--disabled')) return { clicked: false, atEnd: true };
    li.click();
    return { clicked: true };
  }
  return { clicked: false, reason: '未找到分页器' };
}

/** 回到第一页（分页导航，只读 UI；供全量回读的扫描起点，避免从非首页开始漏扫）。 */
function clickChengfangFirstPageInPage() {
  const auroraActive = document.querySelector('.aurora-qc-pagination-item-active');
  const auroraFirst = document.querySelector('.aurora-qc-pagination-item-1');
  if (auroraFirst || auroraActive) {
    if (auroraActive && (auroraActive.textContent || '').trim() === '1') return { clicked: false, alreadyFirst: true, ui: 'aurora' };
    const btn = auroraFirst ? (auroraFirst.querySelector('.aurora-qc-pagination-item-link') || auroraFirst) : null;
    if (!btn) return { clicked: false, reason: '未找到分页器（新 UI 首页按钮缺失）' };
    btn.click();
    return { clicked: true, ui: 'aurora' };
  }
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    const txt = (li.textContent || '').trim();
    if (/^\d+$/.test(txt) && txt === '1') {
      if (String(li.className || '').includes('--active')) return { clicked: false, alreadyFirst: true };
      li.click();
      return { clicked: true };
    }
  }
  return { clicked: false, reason: '未找到分页器' };
}

/**
 * 行内投放开关句柄解析（内部工具；不导出）。
 *
 * 2026-09-15 修复（交接第 1 项）：实测真实点击目标是**内层** `.ovui-switch[data-e2e="switch"]`。
 * 外层 `.oc-switch` 只是容器/包装（点击它不改变投放状态）；历史 `wrappers[0].click()`
 * 点击外层即为「首次点击不落地」的已知成因之一。
 *
 * 严格条件（任一不满足即拒绝，零点击）：
 *   - 行文本必须含精确 `ID：<planId>` 或 `ID:<planId>`（全等核验，非模糊包含）
 *   - 行内 `.oc-switch` 容器恰好 1 个
 *   - 该容器内 `.ovui-switch[data-e2e="switch"]` 内层开关恰好 1 个
 * 返回 { ok, el } 或 { ok:false, reason }。
 */
function resolveChengfangRowSwitchHandle(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  // 新 UI（aurora-qc）：行以 data-row-key 精确承载计划ID，行内开关 button.aurora-qc-switch 恰好 1 个
  if (document.querySelector('.aurora-qc-table')) {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row')]
      .filter((tr) => String(tr.getAttribute('data-row-key') || '').trim() === want);
    if (rows.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（data-row-key 全等核验）` };
    if (rows.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${rows.length} 行，拒绝点击` };
    const sws = [...rows[0].querySelectorAll('.aurora-qc-switch')];
    if (sws.length !== 1) return { ok: false, reason: `计划ID ${want} 行内开关数量为 ${sws.length}（要求恰好 1 个），拒绝点击` };
    return { ok: true, el: sws[0], wrapperCount: 1, innerCount: 1, ui: 'aurora' };
  }
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  // 全等核验：优先取行内"ID：xxx"精确标注（避免 123 命中 12345）
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];

  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };

  // 内层实际开关：优先精确 data-e2e=switch；退化也只接受 ovui-switch 类名（仍是内层）。
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) {
    el = inner[0];
  } else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) {
    return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  }
  return { ok: true, el, wrapperCount: wrappers.length, innerCount };
}

/**
 * 行内投放开关解析（浏览器内联版；与 resolveChengfangRowSwitchHandle 逻辑逐字一致）。
 * page.evaluate 序列化不支持闭包引用模块级函数，故独立自包含定义；二者须同步修改。
 *
 * 严格条件（任一不满足即拒绝，零点击）：
 *   - 行文本必须含精确 `ID：<planId>` 或 `ID:<planId>`（全等核验，非模糊包含）
 *   - 行内 `.oc-switch` 容器恰好 1 个
 *   - 该容器内 `.ovui-switch[data-e2e="switch"]`（退化 `.ovui-switch`）内层开关恰好 1 个
 * 返回 { ok, el } 或 { ok:false, reason }。
 */
function resolveChengfangRowSwitchHandleInPage(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  // 新 UI（aurora-qc）：行以 data-row-key 精确承载计划ID；行内 .aurora-qc-switch 恰好 1 个。
  if (document.querySelector('.aurora-qc-table')) {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row')]
      .filter((tr) => String(tr.getAttribute('data-row-key') || '').trim() === want);
    if (rows.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（data-row-key 全等核验）` };
    if (rows.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${rows.length} 行，拒绝点击` };
    const sws = [...rows[0].querySelectorAll('.aurora-qc-switch')];
    if (sws.length !== 1) return { ok: false, reason: `计划ID ${want} 行内开关数量为 ${sws.length}（要求恰好 1 个），拒绝点击` };
    return { ok: true, el: sws[0], wrapperCount: 1, innerCount: 1, ui: 'aurora' };
  }
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  return { ok: true, el, wrapperCount: wrappers.length, innerCount };
}

/**
 * 定位指定计划行内的投放开关（不点击）。
 * 供 clickRowSwitch 的"定位 → 最终检查(beforeDispatch) → 实际点击"两段式。
 * 自包含（可被 page.evaluate 序列化）。
 */
function locateChengfangRowSwitchInPage(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  // 新 UI（aurora-qc）：开关为 button.aurora-qc-switch，状态以 aria-checked 承载（true=投放中）。
  if (document.querySelector('.aurora-qc-table')) {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row')]
      .filter((tr) => String(tr.getAttribute('data-row-key') || '').trim() === want);
    if (rows.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（data-row-key 全等核验）` };
    if (rows.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${rows.length} 行，拒绝点击` };
    const sws = [...rows[0].querySelectorAll('.aurora-qc-switch')];
    if (sws.length !== 1) return { ok: false, reason: `计划ID ${want} 行内开关数量为 ${sws.length}（要求恰好 1 个），拒绝点击` };
    const el = sws[0];
    const aria = el.getAttribute('aria-checked');
    return { ok: true, wrapperCount: 1, innerCount: 1, beforeChecked: aria === 'true' ? true : (aria === 'false' ? false : null), checkedAttr: aria || null, ui: 'aurora' };
  }
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  const cls = String(el.className || '');
  const beforeChecked = cls.includes('ovui-switch--checked') || !!el.querySelector('.ovui-switch--checked');
  return { ok: true, wrapperCount: wrappers.length, innerCount, beforeChecked, checkedAttr: el.getAttribute('aria-checked') || null };
}

/**
 * 点击指定计划行内的投放开关（全店托管总开关用；execute 门禁控制，绝不用于删除）。
 * 2026-09-15 修复：点击**内层** `.ovui-switch[data-e2e="switch"]`，不再点外层 `.oc-switch`。
 * 自包含（可被 page.evaluate 序列化）。
 */
function clickChengfangRowSwitchByPlanId(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝点击开关' };
  // 新 UI（aurora-qc）：点击行内唯一 button.aurora-qc-switch（aria-checked 承载状态）。
  if (document.querySelector('.aurora-qc-table')) {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row')]
      .filter((tr) => String(tr.getAttribute('data-row-key') || '').trim() === want);
    if (rows.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（data-row-key 全等核验）` };
    if (rows.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${rows.length} 行，拒绝点击` };
    const sws = [...rows[0].querySelectorAll('.aurora-qc-switch')];
    if (sws.length !== 1) return { ok: false, reason: `计划ID ${want} 行内开关数量为 ${sws.length}（要求恰好 1 个），拒绝点击` };
    const el = sws[0];
    const beforeAria = el.getAttribute('aria-checked');
    el.click();
    return { ok: true, beforeChecked: beforeAria === 'true', beforeAria, target: 'aurora-row-switch' };
  }
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  const cls = String(el.className || '');
  const beforeChecked = cls.includes('ovui-switch--checked') || !!el.querySelector('.ovui-switch--checked');
  const beforeAria = el.getAttribute('aria-checked');
  el.click();
  return { ok: true, beforeChecked, beforeAria, target: 'inner-ovui-switch' };
}

/**
 * 设置指定计划行内复选框（全选后精确校正：取消勾选非目标行）。
 * 精确定位：行文本必须含该 planId；行内复选框恰好一个；禁用则拒绝。
 * 参数为单对象 { planId, checked }（evaluate 只接受单个参数，保持自包含）。
 * 返回后由上层以 readSelection 回读核验实际选中集合（以回读为准）。
 */
function setChengfangRowCheckboxByPlanId({ planId, checked }) {
  // 新 UI（aurora-qc）：行以 data-row-key 精确定位；行内复选框恰好 1 个。
  if (document.querySelector('.aurora-qc-table')) {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row')]
      .filter((tr) => String(tr.getAttribute('data-row-key') || '').trim() === String(planId));
    if (rows.length === 0) return { ok: false, reason: `未找到计划ID ${planId} 所在行（data-row-key 全等核验）` };
    if (rows.length > 1) return { ok: false, reason: `计划ID ${planId} 匹配到 ${rows.length} 行，拒绝操作` };
    const cbs = [...rows[0].querySelectorAll('input[type="checkbox"]')];
    if (cbs.length === 0) return { ok: false, reason: `计划ID ${planId} 行内未找到复选框` };
    if (cbs.length > 1) return { ok: false, reason: `计划ID ${planId} 行内出现 ${cbs.length} 个复选框，拒绝操作` };
    const cb = cbs[0];
    if (cb.disabled) return { ok: false, reason: `计划ID ${planId} 复选框不可用` };
    if (cb.checked !== checked) cb.click();
    return { ok: true, want: checked, ui: 'aurora' };
  }
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const target = trs.find((tr) => (tr.textContent || '').includes(`ID：${planId}`) || (tr.textContent || '').includes(`ID:${planId}`));
  if (!target) return { ok: false, reason: `未找到计划ID ${planId} 所在行` };
  const cbs = [...target.querySelectorAll('input[type="checkbox"]')];
  if (cbs.length === 0) return { ok: false, reason: `计划ID ${planId} 行内未找到复选框` };
  if (cbs.length > 1) return { ok: false, reason: `计划ID ${planId} 行内出现 ${cbs.length} 个复选框，拒绝操作` };
  const cb = cbs[0];
  if (cb.disabled) return { ok: false, reason: `计划ID ${planId} 复选框不可用` };
  if (cb.checked !== checked) cb.click();
  return { ok: true, want: checked };
}

/** 账户与页面身份（自包含）。 */
/**
 * 余额原文 → 整数分（严格十进制字符串，禁止浮点乘法）。
 * 接受 0-9 位整数与可选 1-2 位小数，容忍千分位逗号；其余一律 null（显示"未知"，绝不编造 0）。
 */
function parseBalanceTextToCents(raw) {
  const t = String(raw == null ? '' : raw).trim().replace(/,/g, '');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(t)) return null;
  const dot = t.indexOf('.');
  const intPart = dot === -1 ? t : t.slice(0, dot);
  const frac = dot === -1 ? '00' : (t.slice(dot + 1) + '00').slice(0, 2);
  const cents = Number(intPart) * 100 + Number(frac);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/**
 * 乘方页"千川可用余额(元)"只读取证（自包含，page.evaluate 用；不点击任何控件）。
 * 2026-09-27 实页证据（bal-inspect.json，两店同构）：同一 div.infoItem 内
 * div.infoLabel 自身文本恰为"千川可用余额(元)"，数值在其 div.infoValue 叶子；
 * "千川日预算(元)"与"余额不足"徽标为相邻结构，绝不取值。CSS 哈希后缀仅辅助。
 * 返回 { balanceText, reason }；金额→分由节点侧 parseBalanceTextToCents 完成。
 */
function readQianchuanBalanceInPage() {
  const out = { balanceText: null, reason: null };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
  const labels = [...document.querySelectorAll('div[class*="infoLabel"]')]
    .filter((el) => visible(el) && ownText(el) === '千川可用余额(元)');
  if (labels.length === 0) { out.reason = '未找到"千川可用余额(元)"标签'; return out; }
  const items = [...new Set(labels.map((el) => el.closest('[class*="infoItem"]')).filter(Boolean))];
  if (items.length !== 1) { out.reason = `余额标签所在 infoItem 有 ${items.length} 个，拒绝猜测`; return out; }
  const values = [...items[0].querySelectorAll('div[class*="infoValue"]')].filter(visible);
  const texts = [...new Set(values.map((el) => (el.textContent || '').trim()).filter((t) => t.length > 0))];
  if (texts.length !== 1) { out.reason = `余额数值叶子 ${texts.length} 个，拒绝猜测`; return out; }
  out.balanceText = texts[0];
  return out;
}

/** 页面余额取证结果 → { balanceCents, balanceText, reason }（原文非法 → null 分，不编造 0）。 */
function balanceCentsFromPageResult(pageResult) {
  if (!pageResult || pageResult.balanceText == null) {
    return { balanceCents: null, balanceText: null, reason: (pageResult && pageResult.reason) || '页面未返回余额' };
  }
  const cents = parseBalanceTextToCents(pageResult.balanceText);
  if (cents == null) {
    return { balanceCents: null, balanceText: pageResult.balanceText, reason: `余额原文无法解析为整数分: ${pageResult.balanceText}` };
  }
  return { balanceCents: cents, balanceText: pageResult.balanceText, reason: null };
}

/** 账户与页面身份（自包含）。 */
function readChengfangAccountInPage() {
  const out = {
    url: location.href.slice(0, 160),
    accountId: null,
    accountName: null,
    hasChengfangNav: false,
    hasSubTabs: false,
    navText: '',
  };
  const nav = document.querySelector('.qc-page-navigator-container, [class*="navigator"]');
  const navText = nav ? (nav.textContent || '') : '';
  out.navText = navText.replace(/\s+/g, ' ').trim().slice(0, 200);
  const m = /ID[:：]\s*(\d{8,20})/.exec(navText);
  if (m) out.accountId = m[1];
  const nameM = /([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*ID[:：]\s*\d{8,20}/.exec(navText.replace(/\s+/g, ' '));
  if (nameM) out.accountName = nameM[1];
  out.hasChengfangNav = navText.includes('乘方');
  // 商品视图的商品行也包含这两个词，必须核对真实可见的标签控件。
  // 2026-09-27 实页证据一（高定私服，cf-deep-*.json）：aurora 计划视图下两个子视图是
  // .aurora-qc-radio-group 单选组（wrapper 内含 input[type=radio]），不是 tab；
  // 商品卡片上的同名字样是 .aurora-qc-tag-text 文本，不在单选组内，不得误认。
  // 2026-09-27 实页证据二（潮流服饰，clf-inspect.json）：另一 aurora 变体点击"商品"后
  // 直接是两个 role=tab——"商品自选"（文本全等）与"全店托管加速新品爆发"（以前缀
  // "全店托管"起始）。前缀放宽仅限真实 role=tab 控件：表格（无 role=tab）、商品卡片、
  // 整页文字均不命中，不会回到旧的卡片文字误报。
  const tabs = [...document.querySelectorAll('[role="tab"], [class*="tab"], [class*="Tab"]')];
  const tabMatch = (el, label) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const text = (el.textContent || '').trim();
    if (text === label) return true;
    return !!el.getAttribute && el.getAttribute('role') === 'tab' && text.startsWith(label);
  };
  const radioLabels = [...document.querySelectorAll('.aurora-qc-radio-group .aurora-qc-radio-button-label')];
  out.hasSubTabs = ['商品自选', '全店托管'].every(label => tabs.some(el => tabMatch(el, label)) || radioLabels.some(el => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || (el.textContent || '').trim() !== label) return false;
    const wrap = el.closest('.aurora-qc-radio-button-wrapper');
    return !!(wrap && wrap.querySelector('input[type="radio"]'));
  }));
  return out;
}

/**
 * 千川引导/介绍浮窗白名单探针与关闭器（自包含：会被 page.evaluate 序列化执行）。
 *
 * 安全边界（全部 fail-closed）：
 *  - 只认严格可信千川来源：https + origin 全等 + 非登录/授权中转 + 受支持管理路径；
 *  - 只认已知白名单容器：介绍浮层只认 modal 容器语义（.ocean-vmok-plugin-oc-modal-wrap /
 *    .tools-vmok-plugin-modal__wrap / [class*=modal-wrap|modal__wrap]），**不**以共享埋点属性
 *    [data-e2e="oc_emptyKey_overall-prom"] 当弹窗根（该属性被导航/徽标/工具栏/popover 共用）；
 *    关闭控件必须落在容器内且唯一；
 *    引导容器 [class*=guide|Guide|tour|Tour] 必须**容器内确有唯一可见"跳过/我知道了"**才算引导
 *    浮窗；无跳过/关闭控件的普通营销卡片（货款直投等"去开启"CTA）不当浮窗、绝不点业务 CTA；
 *  - CSS 只是**发现线索**，不能代替内容判定：白名单容器正文出现删除/暂停/开启确认、
 *    互斥/终止/不可恢复、小店随心推、授权登录等危险业务文本 → 一律阻断，绝不点 X；
 *  - 未知可见浮层（dialog/alertdialog/modal/popup/mask/dialog/confirm 类，且不属于上述
 *    白名单子树、也不是已精确归属的紧邻独立遮罩）→ 阻断；外壳同时包含已知浮窗与其它疑似
 *    业务对话框时，不把整棵外壳当白名单；多个独立白名单浮窗 / 多候选控件 → 阻断；一律零点击。
 *  - 绝不以 [class*=modal] 泛化盲点 X，绝不点击业务确认/删除/开关类控件。
 *
 * 兼容语义：本函数同时是 advanceChengfangPlanViewInPage 的兼容实现（alias）。
 * 未显式传 {click:false} 时执行点击；page.evaluate 序列化后完全自包含。
 * @param {{click?:boolean}} [options] click=false 时只探测；其余情况对唯一控件派发一次点击
 */
function handleChengfangOverlayInPage(options) {
  const wantClick = !options || options.click !== false;
  const out = {
    trusted: false, path: '', state: 'blocked', kind: null, key: null,
    closeCandidates: 0, textCandidates: 0, blockers: [], clicked: false, action: 'none',
  };
  const doc = (typeof document !== 'undefined' && document) ? document : null;
  const loc = (typeof location !== 'undefined' && location) ? location : null;
  if (!doc || typeof doc.querySelectorAll !== 'function' || !loc) {
    out.blockers.push('no-document');
    return out;
  }
  let parsed = null;
  try { parsed = new URL(String(loc.href || '')); } catch (_) { parsed = null; }
  if (!parsed) { out.blockers.push('unparsable-url'); return out; }
  out.path = String(parsed.pathname || '');
  if (parsed.origin !== 'https://qianchuan.jinritemai.com') { out.blockers.push('untrusted-origin'); return out; }
  if (/\/login|\/passport|\/signin|sso\.jinritemai/i.test(out.path)) { out.blockers.push('login-path'); return out; }
  if (!/^\/(?:home|uni-prom|overall-prom|promotion-v2|brand_bid)(?:\/|$)/.test(out.path)) {
    out.blockers.push('unsupported-path');
    return out;
  }
  out.trusted = true;

  const visible = (el) => {
    if (!el) return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    if (typeof getComputedStyle === 'function') {
      let cs = null;
      try { cs = getComputedStyle(el); } catch (_) { cs = null; }
      if (cs) {
        if (String(cs.display || '').toLowerCase() === 'none') return false;
        if (String(cs.visibility || '').toLowerCase() === 'hidden') return false;
      }
    }
    return true;
  };
  const all = (sel) => {
    try { return Array.prototype.slice.call(doc.querySelectorAll(sel)); } catch (_) { return []; }
  };
  // 仅收集**实际渲染**的文本：跳过可见性不成立的子树（display:none / visibility:hidden /
  // 零尺寸）、以及 script/style/noscript/template 等非渲染节点。危险判定只看真正显示的浮层文本，
  // 避免把隐藏模板/背景说明/脚本内字符串当成现场危险确认（2026-10-19 误判排查）。
  const collectVisibleText = (el) => {
    if (!el || !visible(el)) return '';
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return '';
    let text = '';
    if (typeof el.ownText === 'string') text += el.ownText; // 合成 fixture 自带文本
    if (el.childNodes && el.childNodes.length) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const n = el.childNodes[i];
        if (!n) continue;
        if (n.nodeType === 3 || n.nodeType === 4) text += String(n.textContent || '');
        else if (n.nodeType === 1) text += collectVisibleText(n);
      }
    } else if (Array.isArray(el.children)) {
      for (let i = 0; i < el.children.length; i++) text += collectVisibleText(el.children[i]);
    }
    return text;
  };
  const dedupeOuter = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains && o.contains(el)));

  // 危险业务文本：CSS 像 intro 不代表内容安全；删除/暂停/开启确认、互斥/终止、
  // 小店随心推、授权登录等一律优先阻断。文本归一化后匹配，避免换行/空格绕过。
  const DANGER_TEXT_RE = /(?:确认|确定|是否)[^。！？\n]{0,16}(?:删除|暂停|开启|关闭|终止)|(?:删除|暂停|开启|终止)[^。！？\n]{0,16}(?:不可恢复|确认|是否)|互斥|小店随心推|授权登录|扫码登录|重新登录|删除后不可恢复|终止[^。！？\n]{0,8}不可恢复|(?:暂停|删除|开启|终止)\s*[0-9一二三四五六七八九十百千]+\s*条/;

  // 页面根绝不等于弹层容器：vmok 插件把状态类写到 body 上（observed-overlay.json：
  // body.tools-vmok-plugin-popup__lock），若被泛选择器收入，dedupeOuter 祖先去重会把
  // body 之外所有真实弹窗候选吞掉，背景正文危险词反过来污染弹窗判定。排除必须发生在
  // 去重之前，真实弹窗/业务确认的后代才能继续作为独立候选被扫描。
  const notPageRoot = (el) => !!el && el !== doc && el !== doc.documentElement && el !== doc.body;
  // 介绍/模态浮窗根：只认已知 modal 容器语义（modal-wrap / modal__wrap 外壳），
  // 绝不把共享埋点属性 [data-e2e="oc_emptyKey_overall-prom"] 本身当弹窗根——该属性被
  // 导航/徽标/右侧工具栏/popover 等多个**非模态、无关闭控件**元素共用，据此发现会与真实
  // modal 并列出 multiple-intro 假阻断（2026-10-18 真实 DOM 取证）。真实 modal 靠其
  // modal-wrap 类被识别，仍要求容器内唯一可见关闭控件（见下 dismissable 分支）才可点。
  const introRoots = dedupeOuter(all(
    '.ocean-vmok-plugin-oc-modal-wrap, .tools-vmok-plugin-modal__wrap, '
    + '[class*="modal-wrap"], [class*="modal__wrap"]'
  ).filter((el) => notPageRoot(el) && visible(el)));
  // 引导容器：class 含 guide/tour 只是线索；必须**容器内确有唯一可见"跳过/我知道了"**才算
  // 引导浮窗。普通右侧营销卡片（如 productFundModuleGuide，270x190，只有业务"去开启"CTA、
  // 无跳过/关闭控件）没有浮层语义 → 不是阻断引导，忽略之，绝不点它的业务 CTA。
  const hasSkipControl = (el) => {
    if (!el || !el.querySelectorAll) return false;
    return dedupeOuter(Array.prototype.slice.call(el.querySelectorAll('button, a, [role="button"], span')).filter((b) => {
      if (!visible(b)) return false;
      const t = String(b.textContent || '').replace(/\s+/g, '');
      return t === '跳过' || t === '跳过引导' || t === '我知道了';
    })).length > 0;
  };
  const guideRoots = dedupeOuter(all('[class*="guide"], [class*="Guide"], [class*="tour"], [class*="Tour"]').filter((el) => {
    if (!notPageRoot(el)) return false;
    if (!visible(el)) return false;
    if (introRoots.some((r) => r === el || (r.contains && r.contains(el)))) return false;
    return hasSkipControl(el);
  }));
  const known = introRoots.concat(guideRoots);
  // 未知/业务浮层候选：除常见 modal/popup/mask 外，必须纳入 dialog/confirm 类
  // （business-confirm 等），否则已知浮窗旁边的业务确认框永远不会进入 foreign 扫描。
  const dialogCands = dedupeOuter(all(
    '[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="Modal"], '
    + '[class*="popup"], [class*="Popup"], [class*="mask"], [class*="Mask"], '
    + '[class*="dialog"], [class*="Dialog"], [class*="confirm"], [class*="Confirm"]'
  ).filter((el) => notPageRoot(el) && visible(el)));
  const inKnown = (el) => known.some((k) => k === el || (k.contains && k.contains(el)));
  let foreign = [];
  for (const el of dialogCands) {
    if (inKnown(el)) continue;
    const wrapsKnown = known.some((k) => el.contains && el.contains(k));
    if (wrapsKnown) {
      // 外壳包着已知浮窗时，只有外壳内还存在已知子树之外的弹层候选才按未知处理：
      // 同一外壳混有业务对话框时绝不把整棵树当白名单。
      const other = dialogCands.some((c) => c !== el && !inKnown(c)
        && el.contains(c) && !(c.contains && c.contains(el)));
      if (!other) continue;
    }
    foreign.push(el);
  }
  // 已知弹窗的独立遮罩归属（2026-10-19 两份**完整**现场 DOM 取证）：
  //   fixtures/complete-popup-dom.html    首页：mask + overall-release-modal-v2-wrap；
  //   fixtures/management-popup-dom.html  管理页：mask + ocean-vmok-plugin-oc-modal-wrap
  //                                       （内部 .aweme-auto-pull-modal-content）。
  // 两份取证均为 mask.outerHTML 紧跟 nextElementSibling.outerHTML，即 mask 与弹窗根是
  // **同一父节点的紧邻兄弟**（实测同为 BODY 直接子节点，z-index 均 2000）。既有 foreign
  // 扫描把该空壳遮罩判为 unknown-overlay:1，导致同一已知弹窗的唯一可见关闭按钮不可点。
  // 归属条件必须全部成立，任一不成立即保持 unknown 阻断（门禁不放宽）：
  //   1) introRoot 恰 1 个，且类名精确命中两种**实测**已知类型之一：
  //      overall-release-modal-v2-wrap；或 ocean-vmok-plugin-oc-modal-wrap 且内部确有
  //      .aweme-auto-pull-modal-content。其余 modal+mask 组合不白名单；
  //   2) 遮罩类名 token 精确等于 tools-vmok-plugin-popup__mask（绝不泛匹配任意 mask/popup 类）；
  //   3) 遮罩与 introRoot **同 parentNode** 且**紧邻**（nextElementSibling 互为对方）：
  //      仅用 contains 排除无法证明兄弟关系，远处节点或另一容器内的同名 mask 一律不归属；
  //   4) 遮罩为空壳（无元素子节点、无非空白文本），且不含任何弹层候选；
  //   5) 此类遮罩恰 1 个（≥2 时无法归属，整组仍按未知阻断）。
  // 遮罩自身作为 dialogCand 仍参与下方危险文本扫描；无已知弹窗时遮罩仍按未知阻断。
  const classTokens = (el) => String(
    (el.getAttribute && el.getAttribute('class')) || el.className || ''
  ).split(/\s+/).filter(Boolean);
  const isKnownAffiliatedPopup = (root) => {
    const toks = classTokens(root);
    if (toks.indexOf('overall-release-modal-v2-wrap') !== -1) return true;
    if (toks.indexOf('ocean-vmok-plugin-oc-modal-wrap') === -1) return false;
    let inner = null;
    try { inner = root.querySelector('.aweme-auto-pull-modal-content'); } catch (_) { inner = null; }
    return !!inner;
  };
  const adjacentSiblings = (a, b) => {
    if (!a || !b || !a.parentNode || !b.parentNode) return false;
    if (a.parentNode !== b.parentNode) return false;
    return a.nextElementSibling === b || b.nextElementSibling === a;
  };
  const isEmptyMaskShell = (el) => {
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (!n) continue;
      if (n.nodeType === 1) return false;
      if ((n.nodeType === 3 || n.nodeType === 4) && String(n.textContent || '').trim()) return false;
    }
    return true;
  };
  if (introRoots.length === 1) {
    const ir = introRoots[0];
    if (isKnownAffiliatedPopup(ir)) {
      const maskEls = foreign.filter((el) => {
        if (classTokens(el).indexOf('tools-vmok-plugin-popup__mask') === -1) return false;
        if (!adjacentSiblings(el, ir)) return false;
        if (el.contains && el.contains(ir)) return false;
        if (dialogCands.some((o) => o !== el && el.contains && el.contains(o))) return false;
        if (!isEmptyMaskShell(el)) return false;
        return true;
      });
      if (maskEls.length === 1) {
        foreign = foreign.filter((el) => el !== maskEls[0]);
        out.affiliatedMask = { cls: 'tools-vmok-plugin-popup__mask' };
      }
    }
  }
  // 危险文本扫描：白名单容器与短文本弹层候选（页面级大 mask 不做全文扫描，
  // 避免把列表正文误判为浮窗；其内部真实业务弹层会作为独立候选被扫描）。
  // 阻断以**可见渲染文本**为准（真实弹层的危险确认必然可见）；危险文本仅存在于
  // 未渲染节点（隐藏模板/背景/script）时不阻断，只记录无敏感原文的结构化诊断供精确定位。
  let dangerText = false;
  const dangerDiag = [];
  for (const el of known.concat(dialogCands)) {
    const raw = String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length > 1200) continue;
    const vis = collectVisibleText(el).replace(/\s+/g, ' ').trim();
    const visHit = !!vis && DANGER_TEXT_RE.test(vis);
    const rawHit = DANGER_TEXT_RE.test(raw);
    if (visHit) {
      dangerText = true;
      if (dangerDiag.length < 5) {
        dangerDiag.push({
          scope: inKnown(el) ? 'known' : 'dialog',
          tag: String(el.tagName || '').toLowerCase(),
          cls: String((el.getAttribute && el.getAttribute('class')) || '').slice(0, 60),
          chars: vis.length, hidden: false,
        });
      }
    } else if (rawHit && dangerDiag.length < 5) {
      dangerDiag.push({
        scope: inKnown(el) ? 'known' : 'dialog',
        tag: String(el.tagName || '').toLowerCase(),
        cls: String((el.getAttribute && el.getAttribute('class')) || '').slice(0, 60),
        rawChars: raw.length, visChars: vis.length, hidden: true,
      });
    }
  }
  if (dangerText) out.blockers.push('danger-text');
  if (dangerDiag.length) out.dangerDiag = dangerDiag;
  if (foreign.length > 0) {
    out.blockers.push(`unknown-overlay:${foreign.length}`);
    const structure = (el) => ({
      tag: String(el.tagName || '').toLowerCase().slice(0, 24),
      cls: String((el.getAttribute && el.getAttribute('class')) || '').slice(0, 60),
      role: String((el.getAttribute && el.getAttribute('role')) || '').slice(0, 24),
    });
    out.unknownDiag = foreign.slice(0, 5).map((el) => {
      const diag = {};
      try {
        Object.assign(diag, structure(el));
        const rect = el.getBoundingClientRect();
        diag.rect = {};
        for (const key of ['left', 'top', 'width', 'height']) {
          diag.rect[key] = Number.isFinite(rect[key]) ? rect[key] : null;
        }
        const children = el.children || [];
        diag.directChildren = children.length;
        diag.visibleDirectChildren = 0;
        diag.directChildrenTruncated = children.length > 200;
        diag.children = [];
        for (let i = 0; i < Math.min(children.length, 200); i++) {
          const childVisible = visible(children[i]);
          if (childVisible) diag.visibleDirectChildren += 1;
          if (i < 5) diag.children.push({ ...structure(children[i]), visible: childVisible });
        }
        diag.containedIntroRoots = introRoots.filter((root) => el.contains(root)).length;
        diag.containedGuideRoots = guideRoots.filter((root) => el.contains(root)).length;
        diag.rawChars = 0;
        diag.visChars = 0;
        diag.visibleDescendants = 0;
        diag.scannedNodes = 0;
        diag.closeControls = [];
        diag.visibleCloseControls = 0;
        const stack = [{ nodes: [el], index: 0, rendered: true }];
        // 截断时文本长度与可见后代计数仅为下界；不递归、不扩展到候选外。
        while (stack.length && diag.scannedNodes < 200) {
          const frame = stack[stack.length - 1];
          if (frame.index >= frame.nodes.length) { stack.pop(); continue; }
          const node = frame.nodes[frame.index++];
          diag.scannedNodes += 1;
          if (node.nodeType === 3 || node.nodeType === 4) {
            const chars = String(node.textContent || '').length;
            diag.rawChars += chars;
            if (frame.rendered) diag.visChars += chars;
            continue;
          }
          if (node.nodeType !== 1 && !node.tagName) continue;
          const tag = String(node.tagName || '').toLowerCase();
          const rendered = frame.rendered && visible(node)
            && !['script', 'style', 'noscript', 'template'].includes(tag);
          if (typeof node.ownText === 'string') {
            diag.rawChars += node.ownText.length;
            if (rendered) diag.visChars += node.ownText.length;
          }
          if (rendered && node !== el) {
            diag.visibleDescendants += 1;
            const legacyClose = node.matches('.tools-vmok-plugin-modal__close-icon');
            const v2CloseButton = node.matches('button.close-button[aria-label="关闭"][type="button"]');
            let closeText = null;
            if (node.matches('button, a, [role="button"], span')) {
              const text = String(node.textContent || '');
              const compact = text.length <= 1200 ? text.replace(/\s+/g, '') : '';
              if (compact === '跳过') closeText = 'skip';
              else if (compact === '跳过引导') closeText = 'skip-guide';
              else if (compact === '我知道了') closeText = 'acknowledge';
            }
            if (legacyClose || v2CloseButton || closeText) {
              diag.visibleCloseControls += 1;
              if (diag.closeControls.length < 5) {
                diag.closeControls.push({
                  ...structure(node), legacyClose, v2CloseButton, closeText,
                  ariaClose: node.getAttribute('aria-label') === '关闭',
                });
              }
            }
          }
          const nodes = node.childNodes || node.children || [];
          if (nodes.length) stack.push({ nodes, index: 0, rendered });
        }
        while (stack.length && stack[stack.length - 1].index >= stack[stack.length - 1].nodes.length) stack.pop();
        diag.scanTruncated = stack.length > 0;
        diag.closeControlsTruncated = diag.visibleCloseControls > 5;
      } catch (_) {
        // 诊断失败不能替换原有 unknown 阻断，异常原文也不得进入审计。
        diag.incomplete = true;
      }
      return diag;
    });
  }
  if (introRoots.length > 1) out.blockers.push(`multiple-intro:${introRoots.length}`);
  if (guideRoots.length > 1) out.blockers.push(`multiple-guide:${guideRoots.length}`);
  if (introRoots.length === 1 && guideRoots.length > 0) out.blockers.push('intro-and-guide');
  if (out.blockers.length > 0) { out.state = 'blocked'; return out; }
  if (introRoots.length === 0 && guideRoots.length === 0) { out.state = 'none'; return out; }

  let root = null;
  let control = null;
  if (introRoots.length === 1) {
    out.kind = 'intro';
    root = introRoots[0];
    const e2e = (root.getAttribute ? String(root.getAttribute('data-e2e') || '') : '');
    out.key = e2e || 'ocean-modal';
    // 旧白名单 X：--hide 时不可见，被 visible() 过滤，不计入候选。
    let cands = Array.prototype.slice.call(
      root.querySelectorAll('.tools-vmok-plugin-modal__close-icon')
    ).filter(visible);
    // 新版介绍浮窗（overall-release-modal-v2-wrap，2026-10-18 真实 DOM 取证 exact-overlay-block.json）：
    // 唯一可见关闭控件为 button.close-button[aria-label="关闭"][type="button"]，内部含
    // iconpark-icon[name="oc-icon-close"]。仅在同一已知 root 且 root 具 overall-release-modal-v2-wrap
    // 类时纳入；绝不泛匹配任意 aria-label=关闭、绝不放宽 root、绝不点业务 CTA（投放乘方/开启货款直投）。
    const rootClass = String((root.getAttribute && root.getAttribute('class')) || root.className || '');
    if (rootClass.split(/\s+/).indexOf('overall-release-modal-v2-wrap') !== -1) {
      const v2 = Array.prototype.slice.call(
        root.querySelectorAll('button.close-button[aria-label="关闭"][type="button"]')
      );
      for (const b of v2) {
        if (!visible(b)) continue;
        let icon = null;
        try { icon = b.querySelector('iconpark-icon[name="oc-icon-close"]'); } catch (_) { icon = null; }
        if (!icon) continue;
        cands.push(b);
      }
    }
    cands = dedupeOuter(cands);
    out.closeCandidates = cands.length;
    if (cands.length === 0) { out.state = 'no-control'; return out; }
    if (cands.length > 1) { out.blockers.push(`ambiguous-close:${cands.length}`); out.state = 'blocked'; return out; }
    control = cands[0];
    out.action = 'dismiss-intro';
  } else {
    out.kind = 'guide';
    root = guideRoots[0];
    out.key = String(root.className || '').slice(0, 60) || 'guide';
    const cands = dedupeOuter(Array.prototype.slice.call(root.querySelectorAll('button, a, [role="button"], span')).filter((el) => {
      if (!visible(el)) return false;
      const t = String(el.textContent || '').replace(/\s+/g, '');
      return t === '跳过' || t === '跳过引导' || t === '我知道了';
    }));
    out.textCandidates = cands.length;
    if (cands.length === 0) { out.state = 'no-control'; return out; }
    if (cands.length > 1) { out.blockers.push(`ambiguous-skip:${cands.length}`); out.state = 'blocked'; return out; }
    control = cands[0];
    out.action = 'skip-guide';
  }
  out.state = 'dismissable';
  if (!wantClick) return out;
  try { control.click(); } catch (_) { out.blockers.push('click-threw'); out.state = 'blocked'; return out; }
  out.clicked = true;
  return out;
}

/**
 * 进入商品的计划视图（只读 tab 导航；**不处理浮窗**）。
 * 浮窗只由 handleChengfangOverlayInPage / dismissKnownChengfangOverlays 关闭，
 * 二者不得混在一起：导航函数绝不点击任何关闭/跳过控件。
 */
function navigateChengfangPlanViewInPage() {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const findTab = (name) => tabs.find((el) => visible(el) && (el.textContent || '').trim() === name);
  const product = findTab('商品');
  if (product && product.getAttribute('aria-selected') !== 'true') {
    product.click();
    return { action: 'open-product' };
  }
  const plan = findTab('计划视图');
  if (product && product.getAttribute('aria-selected') === 'true'
      && plan && plan.getAttribute('aria-selected') !== 'true') {
    plan.click();
    return { action: 'open-plan-view' };
  }
  return { action: 'none' };
}

/**
 * 纯浮窗关闭入口（保留原导出名）：只关闭白名单浮窗，不做任何 tab 导航。
 *
 * 直接 alias 到真正自包含的页面函数：page.evaluate(advanceChengfangPlanViewInPage)
 * 只会序列化本函数自身，任何模块闭包引用都会在浏览器里 ReferenceError。
 * 兼容语义：未传 {click:false} 即执行一次唯一控件点击，返回 clicked/action/blockers。
 */
const advanceChengfangPlanViewInPage = handleChengfangOverlayInPage;

// ── 页面驱动（真实页面；browserFactory 可注入供测试）────────────────

/**
 * 已保留同店检查窗口的「有界只读恢复」。
 *
 * 只有同时满足以下全部条件才解除 manualReview，并把**已验证的保留 page/context/browser**
 * 交回正常只读打开链复用（不关闭用户窗口、不新开浏览器）：
 *  1) 同一保留项（同店 key）、page 未关闭、context 存在；同店同一时刻只允许一个恢复者；
 *  2) 保留时已从**原会话**冻结了唯一头部账户ID（legacy/缺失 → 永远阻断，不猜）；
 *  3) 保留页地址是严格可信千川乘方管理页；
 *  4) 保留页当前新鲜唯一头部账户ID 与冻结值全等，且无可见登录表单/控件；
 *  5) 只有白名单浮窗，且关闭后**二次观察消失**；未知/多义/多个独立浮窗 → 阻断；
 *  6) 必要子标签（商品自选/全店托管）就绪（只读导航，有界）；
 *  7) 异步边界后再做一次新鲜核验（窗口/地址/身份/浮窗），任一漂移 → 保持 guard。
 * 任何异常/超时/未落定一律不释放 guard；不伪造关闭、不写任何 Cookie。
 */
async function releaseChengfangManualReviewForReadOnlyOpen({ shopCfg, audit }) {
  const key = manualReviewShopKey(shopCfg);
  const held = manualReviewSessions.get(key);
  const fail = (reason) => ({ released: false, reason });
  if (!held) return fail('没有保留的检查窗口');
  if (manualReviewRecoveries.has(key)) return fail('另一个恢复流程正在进行，禁止第二个恢复者或新开页面');
  manualReviewRecoveries.add(key);
  const emit = (result, reason) => {
    if (typeof audit !== 'function') return;
    try {
      audit({
        kind: 'chengfang-overlay', shopId: (shopCfg && shopCfg.id) || null,
        action: 'release-manual-review', result, reason: reason || null,
      });
    } catch (_) { /* 审计失败不影响恢复结果 */ }
  };
  const wait = async (ms) => {
    if (held.page && typeof held.page.waitForTimeout === 'function') {
      try { await held.page.waitForTimeout(ms); return; } catch (_) { /* 落到本地等待 */ }
    }
    await new Promise((r) => setTimeout(r, ms));
  };
  // 成功返回时**不释放同店 lease，也不删除 manualReviewSessions**：后续最终身份/
  // URL/浮窗复核与 Cookie checkpoint 仍在这一临界区内完成；期间任何并发 opener
  // 都会看到「另一个恢复流程正在进行」，绝不会新开 browser。安全交回或异常收口时
  // 才由 openChengfangShop 统一清理。
  let leaseHandedOff = false;
  try {
    if (!held.page) return fail('保留窗口页面缺失');
    if (typeof held.page.isClosed === 'function' && held.page.isClosed()) {
      manualReviewSessions.delete(key);
      return fail('保留的检查窗口已关闭');
    }
    if (!held.context) return fail('保留窗口缺少会话上下文');
    const frozen = readHeldFrozenAccountId(held);
    if (!frozen) return fail('保留窗口未冻结原始账户身份（legacy/证据缺失），不猜测、不解除');
    let url = '';
    try { url = String(held.page.url()); } catch (_) { return fail('保留窗口地址不可读'); }
    if (!isTrustedChengfangUrl(url)) return fail('保留窗口不是可信千川乘方管理页');
    const headerOk = async () => {
      let obs = null;
      try { obs = await held.page.evaluate(probeQianchuanHeaderIdentityInPage); } catch (_) { obs = null; }
      if (!obs || obs.unique !== true || typeof obs.accountId !== 'string') {
        return { ok: false, reason: '保留窗口千川头部账户身份缺失或候选不唯一' };
      }
      if (obs.loginVisible === true) return { ok: false, reason: '保留窗口存在可见登录表单/控件' };
      if (obs.accountId !== frozen) return { ok: false, reason: '保留窗口账户与冻结的原始账户不一致（身份漂移/跨店）' };
      return { ok: true };
    };
    const h1 = await headerOk();
    if (!h1.ok) return fail(h1.reason);
    // 只关白名单浮窗；未知/多义/多个独立浮窗由探针阻断（零点击）
    const dr = await dismissKnownChengfangOverlays({
      page: held.page, audit, shopId: shopCfg && shopCfg.id, maxRounds: 2,
    });
    if (!(dr.dismissed === true || dr.state === 'none')) {
      return fail(`浮窗未安全关闭（${dr.reason || dr.state}）`);
    }
    // 必要子标签就绪：只读 tab 导航（有界），绝不点业务控件
    let ready = null;
    for (let i = 0; i < 10; i++) {
      let st = null;
      try { st = await held.page.evaluate(readChengfangAccountInPage); } catch (_) { st = null; }
      if (st && isTrustedChengfangUrl(String(st.url || '')) && st.hasSubTabs === true) { ready = st; break; }
      try { await held.page.evaluate(navigateChengfangPlanViewInPage); } catch (_) { /* 只读导航失败按未就绪处理 */ }
      await wait(500);
    }
    if (!ready) return fail('保留窗口未达到子标签就绪（必要子标签未出现）');
    // 异步边界后的最终新鲜核验：窗口 / 地址 / 身份 / 浮窗
    if (typeof held.page.isClosed === 'function' && held.page.isClosed()) return fail('保留窗口在核验期间被关闭');
    let url2 = '';
    try { url2 = String(held.page.url()); } catch (_) { return fail('保留窗口地址在核验期间不可读'); }
    if (url2 !== url || !isTrustedChengfangUrl(url2)) return fail('核验期间保留窗口地址漂移');
    const h2 = await headerOk();
    if (!h2.ok) return fail(h2.reason);
    const final = await dismissKnownChengfangOverlays({
      page: held.page, audit, shopId: shopCfg && shopCfg.id, maxRounds: 1, gapMs: 0,
    });
    if (!(final.dismissed === true || final.state === 'none')) return fail('核验结束时仍有浮窗');
    // lease 与 guard 均保持，交给 openChengfangShop 在最终新鲜复核 + checkpoint 后收口。
    leaseHandedOff = true;
    emit('released', null);
    return {
      released: true, page: held.page, context: held.context, browser: held.browser,
      account: ready, frozenAccountId: frozen, shopKey: key,
      cookieSession: held.cookieSession,
    };
  } catch (e) {
    emit('held', '恢复流程异常');
    return fail(`恢复流程异常（guard 保持）：${(e && e.message) || e}`);
  } finally {
    if (!leaseHandedOff) manualReviewRecoveries.delete(key);
  }
}

/** 人工检查 guard 的标准错误（同店保留窗口未安全交回时使用；绝不静默继续）。 */
function chengfangManualReviewError(reason) {
  return new DataGuardError(
    '该店千川页面正在等待人工检查：请在保留的检查窗口里点**浮窗右上角的 ❌** 关闭引导/介绍浮层'
    + '（不是关闭整个浏览器，也不需要重新扫码）；下一轮会先核验同店身份与浮窗是否真的消失，'
    + `核验通过才继续。本轮不解除、不自动操作。未继续原因：${reason}`
  );
}

/** 浮窗探针结果门禁：未知/危险/多义/未消失一律阻断，绝不放行到业务路径。 */
const OVERLAY_BLOCKING_STATES = new Set([
  'blocked', 'no-control', 'probe-failed', 'click-failed', 'not-disappeared',
]);

function assertChengfangOverlaySafe(result, { phase, allowUntrusted }) {
  if (!result || typeof result !== 'object') {
    throw new DataGuardError(`浮窗探测失败（${phase}）：无结果，停止自动操作`);
  }
  if (result.state === 'dismissed' || result.state === 'none') return;
  if (result.state === 'untrusted') {
    if (allowUntrusted === true) return;
    throw new DataGuardError(`浮窗探测不在可信千川页面（${phase}）：停止自动操作`);
  }
  if (OVERLAY_BLOCKING_STATES.has(result.state)) {
    throw new DataGuardError(`浮窗阻断（${phase}）：${result.reason || result.state}，停止自动操作`);
  }
  throw new DataGuardError(`浮窗状态未知（${phase}）：${result.state || 'unknown'}，停止自动操作`);
}

const readOnlyEmptySessions = new WeakMap();

function readChengfangFirstUseInPage() {
  const url = new URL(location.href);
  if (url.origin !== 'https://qianchuan.jinritemai.com' || url.pathname !== '/overall-prom') return false;
  const visible = el => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
  const text = el => (el.textContent || '').replace(/\s+/g, '').trim();
  if (!['新建乘方直播', '新建乘方商品自选'].every(label => controls.filter(el => text(el) === label).length === 1)) return false;
  const views = [...document.querySelectorAll('[role="tab"], [class*="tab"], [class*="Tab"], .aurora-qc-radio-button-label')].filter(visible);
  if (views.some(el => /^(商品|计划视图|商品自选|全店托管)/.test(text(el)))) return false;
  if (document.querySelectorAll('tr.ovui-tr, [role="switch"], .ovui-switch, .aurora-qc-switch').length > 0) return false;
  return true;
}

function observeChengfangEmptyScope(target, accountId) {
  const startedAt = Date.now();
  const deadline = startedAt + 20000;
  const requests = new Map();
  let disposed = false;
  let invalid = false;
  let collected = false;
  let pending = 0;
  let pc = false;
  let upgrade = false;
  let timer;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    target.removeListener('request', onRequest);
    target.removeListener('response', onResponse);
    target.removeListener('close', onClose);
    requests.clear();
  };
  const onClose = () => { invalid = true; dispose(); };
  const onRequest = request => {
    const observedAt = Date.now();
    if (disposed || (!collected && observedAt > deadline)) return;
    try {
      if (request.frame() !== target.mainFrame()) return;
      const pageUrl = new URL(target.url());
      if (pageUrl.origin !== 'https://qianchuan.jinritemai.com' || pageUrl.pathname !== '/overall-prom') return;
      const url = new URL(request.url());
      if (url.origin !== 'https://qianchuan.jinritemai.com') return;
      let kind;
      if (url.pathname === '/ad/api/pmc/agw/uni/get-uni-prom-has-pc-delivery') {
        const scenes = url.searchParams.getAll('AdlabScene');
        if (scenes.length === 0) return;
        if (scenes.length !== 1 || scenes[0] !== '1') { invalid = true; return; }
        kind = 'pc';
      } else if (url.pathname === '/ad/api/pmc/v1/ad/get_overall_upgrade_info') {
        kind = 'upgrade';
      } else return;
      const ids = url.searchParams.getAll('aavid');
      const requestAt = request.timing().startTime;
      // Playwright leaves startTime at 0 until the response arrives.
      if (request.method() !== 'GET' || ids.length !== 1 || ids[0] !== accountId
          || observedAt < startedAt || !Number.isFinite(requestAt) || requestAt < 0
          || (requestAt > 0 && (requestAt < startedAt || requestAt > observedAt
            || (!collected && requestAt >= deadline)))) {
        invalid = true;
        return;
      }
      requests.set(request, { kind, observedAt });
    } catch (_) { invalid = true; }
  };
  const onResponse = response => {
    if (disposed) return;
    let kind;
    try {
      const request = response.request();
      const observed = requests.get(request);
      if (!observed) return;
      requests.delete(request);
      const responseAt = Date.now();
      const requestAt = request.timing().startTime;
      if (!Number.isFinite(requestAt) || requestAt <= 0 || requestAt < startedAt
          || requestAt > responseAt || (!collected && (requestAt >= deadline || responseAt >= deadline))
          || observed.observedAt < startedAt || observed.observedAt > responseAt
          || response.status() !== 200 || response.url() !== request.url()) { invalid = true; return; }
      kind = observed.kind;
    } catch (_) { invalid = true; return; }
    pending++;
    Promise.resolve().then(() => response.json()).then(body => {
      if (disposed) return;
      if (!body || body.status_code !== 0 || !body.data) { invalid = true; return; }
      if (kind === 'pc') {
        const rows = body.data.results;
        const scopes = new Set(['1:0', '2:0', '1:7', '2:7']);
        if (!Array.isArray(rows) || rows.length !== 4) { invalid = true; return; }
        for (const row of rows) {
          if (!row || row.adlabScene !== 1 || ![1, 2].includes(row.marGoal)
              || ![0, 7].includes(row.smartBidType) || row.hasPcDelivery !== false
              || !scopes.delete(`${row.marGoal}:${row.smartBidType}`)) { invalid = true; return; }
        }
        pc = scopes.size === 0;
      } else {
        if (!['productInfo', 'shopInfo', 'liveInfo'].every(key => body.data[key] && body.data[key].hasAd === false)) {
          invalid = true;
          return;
        }
        upgrade = true;
      }
    }).catch(() => { if (!disposed) invalid = true; }).finally(() => { pending--; });
  };
  const confirmed = () => !disposed && !invalid && pending === 0 && requests.size === 0 && pc && upgrade
    && (collected || Date.now() < deadline) && !target.isClosed();
  // R9（2026-10-25）：双源正证据在原 20 秒窗口内完整确认后即标记收集完成并清除该窗口
  // timer——此后工作 Cookie 检查点等保存/收尾耗时不再把已验证数据过期丢弃。监听与全部
  // 真实性校验（原生 request0→response>0 时序、当前 owner、新鲜 observedAt、来源/账户）
  // 保持不变，晚到矛盾/失败/未完成仍使 confirmed=false；dispose 仍在 finally。
  const markCollected = () => {
    if (disposed || invalid || pending !== 0 || requests.size !== 0 || !pc || !upgrade) return false;
    if (Date.now() >= deadline) return false;
    collected = true;
    clearTimeout(timer);
    return true;
  };
  target.on('request', onRequest);
  target.on('response', onResponse);
  target.on('close', onClose);
  timer = setTimeout(() => { invalid = true; dispose(); }, 20000);
  return {
    dispose,
    confirmed,
    markCollected,
    async wait(readiness) {
      while (!disposed && Date.now() < deadline) {
        const ready = await readiness();
        if (disposed || Date.now() >= deadline) return null;
        if (ready === 'tabs' || (ready === 'first-use' && confirmed())) return ready;
        await target.waitForTimeout(Math.min(250, deadline - Date.now()));
      }
      return null;
    },
  };
}

async function verifyChengfangReadOnlyEmpty({ evidence, page, shopCfg }) {
  const binding = evidence && readOnlyEmptySessions.get(evidence);
  const fail = () => { throw new DataGuardError('乘方只读空范围身份或页面证据未通过，拒绝判定关闭'); };
  if (!binding || evidence.kind !== 'chengfang-readonly-empty' || binding.target !== page
      || binding.shopId !== shopCfg.id || page.isClosed() || page.context() !== binding.context) return fail();
  if (shopCfg.accountId != null && String(shopCfg.accountId).trim() !== binding.accountId) return fail();
  const header = await page.evaluate(probeQianchuanHeaderIdentityInPage);
  if (!header || header.unique !== true || header.loginVisible !== false || header.accountId !== binding.accountId) return fail();
  const sso = await discoverUnknownShopAccountId({ context: binding.context, identityPage: binding.identityPage,
    target: page, shopCfg, url: page.url(), observed: header });
  if (!sso || sso.ok !== true || sso.accountId !== binding.accountId) return fail();
  if (await page.evaluate(readChengfangFirstUseInPage) !== true) return fail();
  const overlay = await page.evaluate(handleChengfangOverlayInPage, { click: false });
  if (!overlay || overlay.trusted !== true || overlay.state !== 'none') return fail();
  const finalHeader = await page.evaluate(probeQianchuanHeaderIdentityInPage);
  const url = new URL(page.url());
  if (page.isClosed() || url.origin !== 'https://qianchuan.jinritemai.com' || url.pathname !== '/overall-prom'
      || !finalHeader || finalHeader.unique !== true || finalHeader.loginVisible !== false
      || finalHeader.accountId !== binding.accountId) return fail();
  return { ok: true, pageShopId: binding.shopId, pageShopName: sso.shopName,
    pageAccountId: binding.accountId, pageAccountName: finalHeader.accountName || null,
    pageUrl: url.origin + url.pathname, accountIdOptional: false };
}

async function openChengfangShop(p) {
  const audit = typeof p.audit === 'function' ? p.audit : () => {};
  if (hasChengfangManualReview(p.shopCfg)) {
    const rel = await releaseChengfangManualReviewForReadOnlyOpen({ shopCfg: p.shopCfg, audit });
    if (!rel.released) throw markChengfangResourceNotCreated(chengfangManualReviewError(rel.reason));
    // lease 从 release 一直保留到这里：最终复核、Cookie checkpoint 与安全交回
    // 全部处在同一临界区，期间并发 opener 只能看到「另一个恢复流程正在进行」。
    const guardKey = rel.shopKey || manualReviewShopKey(p.shopCfg);
    try {
      // 复用已核验的保留窗口（不关闭用户窗口、不新开浏览器）。
      if (!rel.page) throw chengfangManualReviewError('保留窗口页面缺失');
      if (typeof rel.page.isClosed === 'function' && rel.page.isClosed()) {
        throw chengfangManualReviewError('保留窗口在最终核验前被关闭');
      }
      if (!rel.context) throw chengfangManualReviewError('保留窗口缺少会话上下文');
      // 最终新鲜核验：**不得退回 release 时的旧快照**；读取异常/漂移一律保持 guard。
      let st = null;
      try { st = await rel.page.evaluate(readChengfangAccountInPage); }
      catch (e) {
        throw chengfangManualReviewError(`最终页面身份读取异常（不退回旧快照）：${(e && e.message) || e}`);
      }
      if (!st || !isTrustedChengfangUrl(String(st.url || '')) || st.hasSubTabs !== true) {
        throw chengfangManualReviewError('最终页面身份/URL/子标签复核失败，不交回不可信会话');
      }
      if (st.accountId != null && rel.frozenAccountId
          && String(st.accountId) !== String(rel.frozenAccountId)) {
        throw chengfangManualReviewError('最终页面身份与冻结账户不一致（跨店/漂移），不交回会话');
      }
      let hdr = null;
      try { hdr = await rel.page.evaluate(probeQianchuanHeaderIdentityInPage); } catch (_) { hdr = null; }
      if (!hdr || hdr.unique !== true || hdr.loginVisible === true
          || typeof hdr.accountId !== 'string' || hdr.accountId !== rel.frozenAccountId) {
        throw chengfangManualReviewError('最终头部身份复核失败或漂移，不交回会话');
      }
      // 未知/危险浮层最终零点击复核：未知或未消失 → 保持 guard，不交回会话。
      const finalOverlay = await dismissKnownChengfangOverlays({
        page: rel.page, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 1, gapMs: 0,
      });
      if (!(finalOverlay.dismissed === true || finalOverlay.state === 'none')) {
        throw chengfangManualReviewError(`最终浮窗复核未通过（${finalOverlay.reason || finalOverlay.state}）`);
      }
      let urlNow = '';
      try { urlNow = String(rel.page.url()); } catch (_) {
        throw chengfangManualReviewError('最终地址不可读，不交回会话');
      }
      if (!isTrustedChengfangUrl(urlNow)) {
        throw chengfangManualReviewError('最终地址不再是可信千川乘方管理页，不交回会话');
      }
      // 成功 dismiss 后的 Cookie 仍走既有检查点（指纹冲突/同店身份守卫由它自身判定）；
      // 新 reviewContext 不是原 context：只传 filePath/startFingerprint 两项元信息，
      // 绝不带原 context 的 identityPage 引用，也绝不另写 Cookie 文件。
      // 检查点跳过/异常如实记录，不据此宣称会话已被核验写入。
      let cookieCheckpoint;
      try {
        cookieCheckpoint = await (p.sessionCheckpoint || checkpointQianchuanSessionCookies)({
          context: rel.context, cookieSession: rel.cookieSession, target: rel.page,
          shopCfg: p.shopCfg, audit,
        });
      } catch (e) {
        cookieCheckpoint = { saved: false, skipped: true, reason: `会话检查点异常（不影响本次打开结果）: ${(e && e.message) || e}` };
      }
      // checkpoint 是恢复交回前最后一个长 await：页面在等待期间仍可能换身份/换页/
      // 新增浮窗/被关闭。删除 guard 与交回会话之前必须再做一次**纯只读**新鲜复核
      // （绝不点击、不导航：复核自身不能再引入异步竞态）；任一异常/漂移一律保持
      // guard、不交回旧快照、不新开浏览器，异常收口只释放 lease 供下一轮重试。
      if (typeof rel.page.isClosed === 'function' && rel.page.isClosed()) {
        throw chengfangManualReviewError('会话检查点期间保留窗口被关闭，不交回会话');
      }
      let stFresh = null;
      try { stFresh = await rel.page.evaluate(readChengfangAccountInPage); }
      catch (e) {
        throw chengfangManualReviewError(`检查点后最终身份读取异常（不退回旧快照）：${(e && e.message) || e}`);
      }
      if (!stFresh || !isTrustedChengfangUrl(String(stFresh.url || '')) || stFresh.hasSubTabs !== true) {
        throw chengfangManualReviewError('检查点后最终页面身份/URL/子标签复核失败，不交回会话');
      }
      if (stFresh.accountId != null && rel.frozenAccountId
          && String(stFresh.accountId) !== String(rel.frozenAccountId)) {
        throw chengfangManualReviewError('检查点后页面身份与冻结账户不一致（跨店/漂移），不交回会话');
      }
      let urlFresh = '';
      try { urlFresh = String(rel.page.url()); } catch (_) {
        throw chengfangManualReviewError('检查点后最终地址不可读，不交回会话');
      }
      if (!isTrustedChengfangUrl(urlFresh)) {
        throw chengfangManualReviewError('检查点后地址不再是可信千川乘方管理页（窗口换页/切登录），不交回会话');
      }
      if (urlFresh !== urlNow) {
        throw chengfangManualReviewError('检查点前后保留窗口地址不一致（窗口换页），不交回会话');
      }
      let hdrFresh = null;
      try { hdrFresh = await rel.page.evaluate(probeQianchuanHeaderIdentityInPage); } catch (_) { hdrFresh = null; }
      if (!hdrFresh || hdrFresh.unique !== true || hdrFresh.loginVisible === true
          || typeof hdrFresh.accountId !== 'string' || hdrFresh.accountId !== rel.frozenAccountId) {
        throw chengfangManualReviewError('检查点后最终头部身份复核失败或漂移，不交回会话');
      }
      // 浮窗最终负证据：纯只读探针（click:false），未知/未消失/不可信一律保持 guard。
      let overlayFresh = null;
      try { overlayFresh = await rel.page.evaluate(handleChengfangOverlayInPage, { click: false }); }
      catch (_) { overlayFresh = null; }
      if (!overlayFresh || overlayFresh.trusted !== true || overlayFresh.state !== 'none') {
        const reason = overlayFresh
          ? ((overlayFresh.blockers || []).join(',') || overlayFresh.state || 'unknown')
          : 'probe-failed';
        throw chengfangManualReviewError(`检查点后最终浮窗只读复核未通过（${reason}），不交回会话`);
      }
      // 安全交回：只有到这里才解除 guard 与同店 lease。
      manualReviewSessions.delete(guardKey);
      manualReviewRecoveries.delete(guardKey);
      return {
        browser: rel.browser, target: rel.page, account: stFresh, context: rel.context,
        cookieSession: null, cookieCheckpoint, recoveredFromManualReview: true,
      };
    } catch (e) {
      // 异常收口：释放并发 lease，但保留 manualReviewSessions → guard 不解除、可重试。
      manualReviewRecoveries.delete(guardKey);
      try {
        audit({
          kind: 'chengfang-overlay', shopId: (p.shopCfg && p.shopCfg.id) || null,
          action: 'release-manual-review', result: 'held', reason: '最终复核未通过，guard 保持',
        });
      } catch (_) { /* 审计失败不影响异常传播 */ }
      // 复用分支只用已核验的保留窗口（不新开浏览器、不新建 context），且**绝不**代用户关闭
      // 保留窗口：这是可证的"未创建"，Monitor 据此清门而不必等待不可能的关闭证明。
      throw markChengfangResourceNotCreated(e);
    }
  }
  const openHome = p.openHome || openQianchuanHome;
  const { browser, context, target, cookieSession } = await openHome(p.loginCfg, p.shopCfg, p);
  let emptyObserver = null;
  try {
    await target.waitForTimeout(2000);
    // 普通打开阶段：只做有界白名单浮窗关闭（未知/多义/多个独立浮窗一律零点击）。
    // 结果必须显式判定：未知/危险浮层存在时立即阻断，绝不忽略后继续导航或返回成功。
    // 此时可能仍在千川首页/登录中转页，untrusted 不阻断；一旦探针可信且报 blocked/
    // no-control/未消失，则不进入业务路径。
    const initialOverlay = await dismissKnownChengfangOverlays({
      page: target, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 2,
    });
    assertChengfangOverlaySafe(initialOverlay, { phase: '普通打开-导航前', allowUntrusted: true });
    let emptyAccountId = null;
    if (p.readOnlyStatus === true) {
      try {
        const homeUrl = new URL(target.url());
        const header = await target.evaluate(probeQianchuanHeaderIdentityInPage);
        if (homeUrl.origin === 'https://qianchuan.jinritemai.com' && homeUrl.pathname === '/home'
            && header && header.unique === true && header.loginVisible === false
            && typeof header.accountId === 'string' && /^\d{8,20}$/.test(header.accountId)
            && (p.shopCfg.accountId == null || String(p.shopCfg.accountId).trim() === header.accountId)) {
          emptyAccountId = header.accountId;
        }
      } catch (_) { emptyAccountId = null; }
    }
    let st = null;
    let readOnlyEmpty = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (emptyObserver) emptyObserver.dispose();
      if (emptyAccountId) emptyObserver = observeChengfangEmptyScope(target, emptyAccountId);
      await target.evaluate(() => {
        const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
        if (el) el.click();
      }).catch(() => {});
      await target.waitForTimeout(9000);
      await target.waitForFunction(() => /\/(uni-prom\/overall|overall-prom)(?:[/?#]|$)/i.test(location.href), { timeout: 20000 }).catch(() => {});
      st = await target.evaluate(readChengfangAccountInPage);
      if (st && CHENGFANG_URL_RE.test(st.url)) break;
    }
    if (!st || !CHENGFANG_URL_RE.test(st.url)) {
      throw new DataGuardError(`导航"乘方"未到达管理页（当前 ${st ? maskUrlQueries(st.url).slice(0, 80) : '未知'}）`);
    }
    const readOnlyTabDeadline = p.readOnlyStatus === true && emptyObserver ? Date.now() + 55000 : null;
    let readiness = null;
    if (p.readOnlyStatus === true && st.hasSubTabs !== true && emptyObserver) {
      readiness = await emptyObserver.wait(async () => {
        st = await target.evaluate(readChengfangAccountInPage);
        if (st && st.hasSubTabs === true) return 'tabs';
        return await target.evaluate(readChengfangFirstUseInPage) === true ? 'first-use' : null;
      });
    }
    if (p.readOnlyStatus === true && (!st || st.hasSubTabs !== true)
        && (readiness === 'first-use' || await target.evaluate(readChengfangFirstUseInPage) === true)) {
      if (!emptyObserver || !emptyObserver.confirmed()) {
        throw new DataGuardError('乘方只读完整空范围双源证据不足，拒绝判定关闭');
      }
      emptyObserver.markCollected();
      readOnlyEmpty = Object.freeze({ kind: 'chengfang-readonly-empty', confirmedEmpty: true });
      readOnlyEmptySessions.set(readOnlyEmpty, { target, context, accountId: emptyAccountId,
        shopId: p.shopCfg.id, identityPage: cookieSession && cookieSession.identityPage });
      // 首次引导双源已确认后、第一次只读核验前，先走既有白名单关闭器处理合法晚到的
      // 介绍浮窗（只点容器内唯一 X；未知/危险/多义仍零点击阻断）。原顺序相反：
      // verify 先要求 overlay===none，晚到的介绍浮窗永远进不了原关闭步骤。
      const firstUseOverlay = await dismissKnownChengfangOverlays({
        page: target, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 1,
      });
      assertChengfangOverlaySafe(firstUseOverlay, { phase: '只读空范围-首次核验前', allowUntrusted: false });
      await verifyChengfangReadOnlyEmpty({ evidence: readOnlyEmpty, page: target, shopCfg: p.shopCfg });
    }
    if (!readOnlyEmpty && emptyObserver) emptyObserver.dispose();
    // 部分店铺需关闭介绍浮层，再依次进入「商品」和「计划视图」；
    // 只有「商品自选/全店托管」子标签真实出现才继续。
    const deadlineTab = readOnlyTabDeadline === null ? Date.now() + 15000 : readOnlyTabDeadline - 40000;
    let hasTabs = false;
    while (!readOnlyEmpty && Date.now() < deadlineTab) {
      // 浮窗关闭与 tab 导航严格分离：先关白名单浮窗，再做只读导航。
      // 已到达乘方管理页，探针必须可信且安全；未知/危险/未消失即阻断，不继续 tab 导航。
      const tabOverlay = await dismissKnownChengfangOverlays({
        page: target, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 1,
      });
      assertChengfangOverlaySafe(tabOverlay, { phase: '乘方管理页-子标签等待', allowUntrusted: false });
      await target.evaluate(navigateChengfangPlanViewInPage).catch(() => {});
      await target.waitForTimeout(readOnlyTabDeadline === null ? 2000 : Math.max(0, Math.min(2000, deadlineTab - Date.now())));
      const check = await target.evaluate(readChengfangAccountInPage);
      if (check && check.hasSubTabs) { st = check; hasTabs = true; break; }
    }
    if (!hasTabs && !readOnlyEmpty) {
      // 子标签（商品自选/全店托管）异步渲染，轮询等待（最长 40s）
      const deadline = readOnlyTabDeadline === null ? Date.now() + 40000 : readOnlyTabDeadline;
      while (Date.now() < deadline) {
        const tabOverlay = await dismissKnownChengfangOverlays({
          page: target, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 1,
        });
        assertChengfangOverlaySafe(tabOverlay, { phase: '乘方管理页-子标签长等待', allowUntrusted: false });
        await target.evaluate(navigateChengfangPlanViewInPage).catch(() => {});
        await target.waitForTimeout(readOnlyTabDeadline === null ? 2000 : Math.max(0, Math.min(2000, deadline - Date.now())));
        const check = await target.evaluate(readChengfangAccountInPage);
        if (check && check.hasSubTabs) { st = check; hasTabs = true; break; }
      }
    }
    if (!hasTabs && !readOnlyEmpty) {
      if (p.readOnlyStatus === true) throw new DataGuardError('乘方只读页面范围无法确认，拒绝判定关闭');
      throw new DataGuardError('乘方页未找到"商品自选/全店托管"子标签（尝试进入"商品→计划视图"后仍未出现），拒绝继续');
    }
    // 子标签 ready 不是「浮窗已消失」的证明：交回前再做一次严格零点击复核，
    // 未知/危险/未消失浮窗一律阻断，绝不带着未知浮层进入业务路径。
    const readyOverlay = await dismissKnownChengfangOverlays({
      page: target, audit, shopId: p.shopCfg && p.shopCfg.id, maxRounds: 1,
    });
    assertChengfangOverlaySafe(readyOverlay, { phase: '子标签就绪后', allowUntrusted: false });
    // R58 会话检查点（manager-ready 返回）：到达乘方管理页并见到子标签后，再以
    // 当前时刻正证据持久化一次刷新 Cookie；跳过/失败不改写本次成功结果。
    let cookieCheckpoint;
    try {
      const runCheckpoint = p.sessionCheckpoint || checkpointQianchuanSessionCookies;
      cookieCheckpoint = await runCheckpoint({ context, cookieSession, target, shopCfg: p.shopCfg, audit: p.audit });
    } catch (e) {
      cookieCheckpoint = { saved: false, skipped: true, reason: `会话检查点异常（不影响本次打开结果）: ${(e && e.message) || e}` };
    }
    if (readOnlyEmpty) {
      await verifyChengfangReadOnlyEmpty({ evidence: readOnlyEmpty, page: target, shopCfg: p.shopCfg });
      if (!emptyObserver.confirmed()) throw new DataGuardError('乘方只读空范围证据已失效，拒绝判定关闭');
    }
    return { browser, target, account: st, context, cookieSession, cookieCheckpoint,
      ...(readOnlyEmpty ? { readOnlyEmpty } : {}) };
  } catch (e) {
    if (emptyObserver) emptyObserver.dispose();
    await holdOnMissingChengfangControl(e, {
      context, target, shopCfg: p.shopCfg, loginCfg: p.loginCfg, cookieSession, audit,
      browserFactory: p.browserFactory, reviewBrowserFactory: p.reviewBrowserFactory,
    });
    // R58 失败路径检查点：关闭浏览器前再尝试一次——仅当当前时刻地址/身份仍是
    // 新鲜的同账户千川正证据才会写（登录页/foreign/身份缺失由检查点自身跳过）。
    // 结果只丢弃不传播：原始错误原样抛出，绝不掩盖或改写。
    try {
      await (p.sessionCheckpoint || checkpointQianchuanSessionCookies)({
        context, cookieSession, target, shopCfg: p.shopCfg, audit: p.audit,
      });
    } catch (_) { /* 检查点失败不得影响原始错误的如实传播 */ }
    // 关闭仍走 closeBrowser（保留其 Cookie 收尾语义）；它吞掉 browser.close 的拒绝，
    // 故关闭是否真实成功必须以独立事实核对后挂到原错误上，供 Monitor 决定能否重读。
    try {
      await closeBrowser(browser);
    } catch (_) { /* 关闭异常同样不得掩盖原始错误；是否关闭由下面的独立核对判定 */ }
    attachChengfangCleanupEvidence(e, proveChengfangBrowserClosed(browser));
    // 本次已创建浏览器却未证明关闭时，把 browser 引用交给 Monitor（WeakMap 句柄，不进日志），
    // 由后续巡查先推进真实关闭；关闭核验成功前该店不得启动新 opener。
    attachChengfangCleanupHandle(e, browser);
    throw e;
  } finally {
    if (emptyObserver) emptyObserver.dispose();
  }
}

/** 乘方控制器（真实页面版）：身份核验 + 视图读取 + 暂停原语。 */
function createChengfangController(p) {
  const nowFn = p.nowFn || (() => Date.now());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadWaitMs = p.loadWaitMs || 10000;
  const tabWaitMs = p.tabWaitMs || 8000;
  // 接近真实点击的最终检查钩子（由执行器注册）：在每次实际业务点击派发前调用。
  // 要求：定位/弹窗检测等最后一次异步页面检查完成之后、DOM click 派发之前执行；
  // 抛错 → 控制器不派发点击（零点击停止）。
  let beforeDispatch = p.beforeDispatch || null;
  const fireBeforeDispatch = async ({ page }) => {
    if (!beforeDispatch) return;
    try {
      await beforeDispatch({ page });
    } catch (e) {
      throw new DataGuardError(`点击前最终检查拦截：${e.reason || e.message}`);
    }
  };

  /**
   * 确认弹窗提交闭环（内部）：点击业务按钮后调用。
   * - 无可见弹窗：返回 { submitted:false, reason:'no-dialog' }（如实报告，不编造）
   * - 有弹窗且类型/数量与 expectedAction 精确一致 → 经 beforeDispatch 再校验后点"确定"
   * - 删除弹窗/未知弹窗/类型或数量不符 → 抛 DataGuardError（阻断，绝不点确定）
   */
  /**
   * 确认弹窗提交闭环（内部）：点击业务按钮后调用。
   * - 无可见弹窗：返回 { submitted:false, reason:'no-dialog' }（如实报告，不编造）
   * - 有弹窗且类型/数量与 expectedAction 精确一致 → 经 beforeDispatch 再校验后点"确定"
   * - 删除弹窗/未知弹窗/类型或数量不符 → 抛 DataGuardError（阻断，绝不点确定）
   *
   * 等待策略（fail-closed 与延迟的平衡）：
   *   - 首选**立即**读取一次（点击后同步渲染的弹窗此刻已在 DOM，正常路径零延迟）；
   *   - 仅当首读为空时，才在 timeoutMs 内短轮询补齐（应对异步渲染）；
   *   - 任何时刻读到弹窗即立即处理，不再白等。
   */
  const submitConfirmIfPresent = async ({ page, expectedAction, expectedCount, timeoutMs = 800 }) => {
    const KNOWN_ACTIONS = ['batch_pause', 'batch_enable', 'shop_disable', 'shop_enable'];
    const deadline = Date.now() + timeoutMs;
    let dlg = null;
    while (true) {
      // 删除弹窗优先拦截（零点击守卫），无论动作。
      // fail-closed：读取异常绝不当作"无弹窗"，必须抛 DataGuardError 阻断提交。
      let del;
      try {
        del = await page.evaluate(hasChengfangDeleteDialogInPage);
      } catch (e) {
        throw new DataGuardError(`删除弹窗检测失败，停止提交（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (del && del.found) {
        throw new DataGuardError(`检测到删除确认弹窗，停止提交（绝不确认删除）：${del.text}`);
      }
      let raw;
      try {
        raw = await page.evaluate(readChengfangConfirmDialogInPage, expectedAction);
      } catch (e) {
        throw new DataGuardError(`确认弹窗读取失败，停止提交（读取异常）：${e.reason || e.message}`);
      }
      if (raw && raw.found) { dlg = raw; break; }
      if (Date.now() >= deadline) break;
      await sleep(300);
    }
    if (!dlg) return { submitted: false, reason: 'no-dialog' };

    // 未实测/无确认语义的动作：一旦出现任何确认弹窗即阻断（不编造结构）
    if (!KNOWN_ACTIONS.includes(expectedAction)) {
      throw new DataGuardError(`动作 ${expectedAction} 的确认弹窗结构未实测，检测到弹窗即阻断（不盲点确定）：${dlg.kind}:${dlg.text}`);
    }
    const wantKind = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
      : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
        : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : 'batch_enable_confirm'));
    if (dlg.kind !== wantKind) {
      throw new DataGuardError(`确认弹窗类型与当前动作不符，停止提交：期望 ${wantKind}，实际 ${dlg.kind}（${dlg.text}）`);
    }
    if (expectedCount != null && dlg.count != null && dlg.count !== expectedCount) {
      throw new DataGuardError(`确认弹窗数量与当前动作不符，停止提交：期望 ${expectedCount}，弹窗 ${dlg.count}`);
    }
    if (dlg.okCandidateCount !== 1) {
      throw new DataGuardError(`确认弹窗"确定"候选数为 ${dlg.okCandidateCount}（要求恰好 1 个），停止提交`);
    }
    // 提交前再次执行最终门禁：停止/跨日/许可关闭 → 不点确定（避免"点了暂停按钮后却在此刻被停"）
    await fireBeforeDispatch({ page });
    const r = await page.evaluate(clickChengfangConfirmOkInPage, { action: expectedAction, expectedCount }).catch((e) => ({ ok: false, reason: String(e) }));
    if (!r || r.ok !== true) {
      throw new DataGuardError(`确认弹窗提交失败：${(r && r.reason) || '未点击确定'}`);
    }
    await sleep(1500);
    return { submitted: true, kind: wantKind, count: r.count == null ? dlg.count : r.count };
  };

  return {
    connected: true,
    source: 'promo-page',
    kind: 'chengfang',
    setBeforeDispatch(fn) { beforeDispatch = fn; return this; },
    async verifyIdentity({ page, shopCfg }) {
      const st = await page.evaluate(readChengfangAccountInPage).catch(() => null);
      if (!st) return { ok: false, reason: '乘方页身份读取失败' };
      if (!CHENGFANG_URL_RE.test(st.url)) {
        return { ok: false, reason: `未在乘方管理页（当前 ${st.url.slice(0, 80)}）` };
      }
      if (!st.hasSubTabs) {
        return { ok: false, reason: '乘方页未找到"商品自选/全店托管"子标签' };
      }
      if (!st.hasChengfangNav) {
        return { ok: false, reason: '页面缺少乘方导航（未在乘方管理页导航上下文）' };
      }
      // Cookie 绑定决定店铺归属；页面账户 ID 仅作可选观察，缺失/不同均不得阻断
      // 广告状态读取或开关（2026-09-28）。不伪造、不写回配置。
      return {
        ok: true,
        pageShopId: String(shopCfg.id || ''),
        pageShopName: shopCfg.name || null,
        pageAccountId: st.accountId || null,
        pageAccountName: st.accountName || null,
        pageUrl: st.url,
        accountIdOptional: true,
      };
    },

    /** 读取指定子标签视图（含行与分页）。 */
    async readView({ page, tab }) {
      const rows = await page.evaluate(collectChengfangRowsInPage).catch((e) => ({ error: String(e) }));
      const pagination = await page.evaluate(collectChengfangPaginationInPage).catch(() => null);
      return { tab, rows, pagination };
    },

    async switchView({ page, tab }) {
      const r = await page.evaluate(clickChengfangSubTab(tab)).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) {
        throw new DataGuardError(`切换子标签"${tab}"失败：${(r && r.reason) || '未找到目标标签'}`);
      }
      await sleep(tabWaitMs);
    },

    /**
     * 强制回读新鲜数据（2026-09-21，新 UI 缺陷：列表是"快照"）。
     *
     * 实测：新前端把列表数据快照绑在 URL 的 dataUpdateTime 参数上，**同一页面内重复读取
     * 只会拿到同一快照**——批量暂停点击已生效，但同会话回读 39 次仍显示"投放中"
     * （生产 21:30 实录：回读判未落地 → 重试再点一次 → 仍判未落地；事后新开页面加载
     * 却显示 23 条全部"已暂停"）。旧 UI 列表会原地刷新，故旧路径保持原语义（不刷新）。
     *
     * 新 UI：reload（同标签、同一会话，不重开浏览器/不重读 Cookie）→ 重新切到目标视图
     * → 重新置 100条/页（reload 会回到平台默认 10条/页，目标行会跨页导致误判缺失）。
     * @param {object} o { page, tab }
     * @returns {{refreshed:boolean, reason?:string, ui?:string, pageSize?:string|null}}
     */
    async refreshView({ page, tab }) {
      const isAurora = await page.evaluate(() => !!document.querySelector('.aurora-qc-table')).catch(() => false);
      if (!isAurora) return { refreshed: false, reason: 'legacy-ui', ui: 'legacy' };
      if (typeof page.reload !== 'function') return { refreshed: false, reason: 'page.reload 不可用', ui: 'aurora' };
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => { throw new DataGuardError(`回读前刷新乘方管理页失败：${e.reason || e.message}`); });
      await sleep(loadWaitMs);
      // 部分店铺刷新后回到「商品视图」甚至展示介绍浮层；先关白名单浮窗，再做只读 tab 导航。
      let hasSubTabs = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const dr = await dismissKnownChengfangOverlays({ page, maxRounds: 1 }).catch(() => null);
        const advanced = await page.evaluate(navigateChengfangPlanViewInPage).catch(() => null);
        if ((dr && dr.dismissed) || (advanced && advanced.action !== 'none')) await sleep(1000);
        const st = await page.evaluate(readChengfangAccountInPage).catch(() => null);
        if (st && st.hasSubTabs) { hasSubTabs = true; break; }
        await sleep(1000);
      }
      if (!hasSubTabs) throw new DataGuardError('刷新后未能恢复商品计划视图，拒绝用商品视图数据冒充计划清单');
      await this.switchView({ page, tab });
      // reload 后回到默认每页 10 条：目标清单会跨页，必须重新置 100条/页（与扫描口径一致）
      let pageSize = null;
      try {
        const pag = await page.evaluate(collectChengfangPaginationInPage);
        pageSize = pag && pag.pageSize ? String(pag.pageSize) : null;
        if (pageSize && !pageSize.includes('100')) {
          await this.switchPageSize({ page, size: '100条/页' });
          const after = await page.evaluate(collectChengfangPaginationInPage);
          pageSize = after && after.pageSize ? String(after.pageSize) : pageSize;
        }
      } catch (e) {
        return { refreshed: true, ui: 'aurora', pageSize, warning: `刷新后重设每页条数未成功：${e.reason || e.message}` };
      }
      return { refreshed: true, ui: 'aurora', pageSize };
    },

    async switchPageSize({ page, size }) {
      const opened = await page.evaluate(openChengfangPageSizeSelectInPage).catch((e) => ({ error: String(e) }));
      if (!opened || opened.opened !== true) {
        throw new DataGuardError(`打开每页条数下拉失败：${(opened && opened.reason) || '控件未找到'}`);
      }
      await sleep(1500);
      const picked = await page.evaluate((s) => {
        const opts = [...document.querySelectorAll('.ovui-option, .aurora-qc-select-item-option, .aurora-qc-select-item')];
        const target = opts.find((o) => (o.textContent || '').replace(/\s+/g, '').includes(s));
        if (!target) return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
        target.click();
        return { picked: true };
      }, size).catch((e) => ({ error: String(e) }));
      if (!picked || picked.picked !== true) {
        throw new DataGuardError(`选择"${size}"失败：${(picked && picked.available) ? `可用选项 ${picked.available.join('/')}` : (picked && picked.reason) || '选项未找到'}`);
      }
      await sleep(loadWaitMs);
    },

    async selectAllInPage({ page }) {
      const r = await page.evaluate(clickChengfangHeaderSelectAllInPage).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) {
        throw new DataGuardError(`勾选表头全选框失败：${(r && r.reason) || '全选框未找到'}`);
      }
      await sleep(500);
    },

    async readSelection({ page }) {
      return page.evaluate(readSelectedChengfangRowIdsInPage).catch(() => ({ selectedIds: [], selectedCount: 0, checkedRows: [] }));
    },

    async readBatchBar({ page }) {
      return page.evaluate(readChengfangBatchBarInPage).catch(() => ({ visible: false, selectedCount: null, buttons: [] }));
    },

    /**
     * 点击批量"暂停"并完成确认闭环（防误删：只接受精确定位且带标记的唯一"暂停"按钮）。
     *
     * 闭环步骤（2026-09-15 修复，交接第 2 项）：
     *   1. 点击前：检测删除弹窗/非预期弹窗（expectedAction='batch_pause'）→ 有则阻断
     *   2. 定位唯一"暂停"按钮 → beforeDispatch 最终门禁 → 派发点击
     *   3. 点击后：读取确认弹窗，必须为 batch_pause_confirm 且数量精确等于 expectedCount
     *      未知/删除/数量不符 → 阻断（不点确定）
     *   4. beforeDispatch 再执行一次 → 点击弹窗"确定"（唯一候选）
     * @param {object} o { page, expectedCount }
     */
    async clickBatchPause({ page, expectedCount = null }) {
      // 检测失败必须阻断点击（抛 DataGuardError，绝不 catch 成"无弹窗"）
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_pause');
      } catch (e) {
        throw new DataGuardError(`弹窗检测失败，停止点击批量"暂停"（检测异常）：${e.reason || e.message}`);
      }
      const blocking = danger.filter((d) => d.kind !== 'batch_pause_confirm');
      if (blocking.length > 0) {
        throw new DataGuardError(`检测到阻断性弹窗，停止点击：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      }
      const found = await page.evaluate(findChengfangBatchPauseButtonInPage).catch((e) => ({ error: String(e) }));
      if (!found || found.ok !== true) {
        throw new DataGuardError(`批量"暂停"按钮无法唯一定位，零点击：${(found && found.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：最后一次页面检查（定位/弹窗检测）完成后、DOM 点击派发前。
      // 停止/时段/跨日/当前许可或账户身份变化 → 抛 DataGuardError，不派发点击。
      await fireBeforeDispatch({ page });
      // 二次定位并点击（与 findChengfangBatchPauseButtonInPage 同一严格条件），结果回传核验
      const clicked = await page.evaluate(() => {
        const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
        let bar = null;
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { bar = b; break; }
        }
        if (!bar) return false;
        // 新 UI：精确文本唯一匹配的批量项（删除/开启不会命中）
        if (bar.querySelectorAll('.oc-promotion-batch-operation-bar').length === 0 && bar.querySelector('.aurora-qc-promotion-batch-operation-bar-item')) {
          const items = [...bar.querySelectorAll('.aurora-qc-promotion-batch-operation-bar-item')].filter((b) => (b.textContent || '').trim() === '暂停');
          if (items.length !== 1) return false;
          items[0].click();
          return true;
        }
        const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '暂停');
        if (btns.length !== 1) return false;
        const b = btns[0];
        const autoId = b.getAttribute('data-auto-id') || '';
        const e2e = b.getAttribute('data-e2e') || '';
        if (!/btn-pause$/.test(autoId) && !/_pause$/.test(e2e)) return false;
        b.click();
        return true;
      }).catch((e) => ({ error: String(e) }));
      if (clicked !== true) {
        throw new DataGuardError('批量"暂停"按钮二次定位不一致，零点击');
      }
      await sleep(1500);
      // 确认闭环：真实页面点击后会弹出确认，必须提交；未弹窗视为不需要确认（如实返回）
      return await submitConfirmIfPresent({ page, expectedAction: 'batch_pause', expectedCount });
    },

    /**
     * 点击批量"开启"并完成确认闭环（防误删：只接受精确定位且带标记的唯一"开启"按钮）。
     * 开启弹窗结构未实测 → 若出现确认弹窗且无法精确匹配 batch_enable_confirm，一律阻断
     * （不编造、不盲点确定）。
     * @param {object} o { page, expectedCount }
     */
    async clickBatchEnable({ page, expectedCount = null }) {
      // 检测失败必须阻断点击（抛 DataGuardError，绝不 catch 成"无弹窗"）
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_enable');
      } catch (e) {
        throw new DataGuardError(`弹窗检测失败，停止点击批量"开启"（检测异常）：${e.reason || e.message}`);
      }
      const blocking = danger.filter((d) => d.kind !== 'batch_enable_confirm');
      if (blocking.length > 0) {
        throw new DataGuardError(`检测到阻断性弹窗，停止点击：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      }
      const found = await page.evaluate(findChengfangBatchEnableButtonInPage).catch((e) => ({ error: String(e) }));
      if (!found || found.ok !== true) {
        throw new DataGuardError(`批量"开启"按钮无法唯一定位，零点击：${(found && found.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：最后一次页面检查（定位/弹窗检测）完成后、DOM 点击派发前。
      await fireBeforeDispatch({ page });
      // 二次定位并点击（与 findChengfangBatchEnableButtonInPage 同一严格条件），结果回传核验
      const clicked = await page.evaluate(() => {
        const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar, .aurora-qc-promotion-batch-operation-bar');
        let bar = null;
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { bar = b; break; }
        }
        if (!bar) return false;
        // 新 UI：精确文本唯一匹配的批量项（删除/暂停不会命中）
        if (bar.querySelectorAll('.oc-promotion-batch-operation-bar').length === 0 && bar.querySelector('.aurora-qc-promotion-batch-operation-bar-item')) {
          const items = [...bar.querySelectorAll('.aurora-qc-promotion-batch-operation-bar-item')].filter((b) => (b.textContent || '').trim() === '开启');
          if (items.length !== 1) return false;
          items[0].click();
          return true;
        }
        const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '开启');
        if (btns.length !== 1) return false;
        const b = btns[0];
        const autoId = b.getAttribute('data-auto-id') || '';
        const e2e = b.getAttribute('data-e2e') || '';
        if (!/btn-open$/.test(autoId) && !/_open$/.test(e2e)) return false;
        b.click();
        return true;
      }).catch((e) => ({ error: String(e) }));
      if (clicked !== true) {
        throw new DataGuardError('批量"开启"按钮二次定位不一致，零点击');
      }
      await sleep(1500);
      await submitConfirmIfPresent({ page, expectedAction: 'batch_enable', expectedCount });
    },

    /**
     * 点击指定计划行内投放开关（全店托管总开关用；严格单候选定位）。
     * 点击前检测删除/非预期弹窗；点击后若有确认弹窗则走 exact 提交闭环。
     * @param {object} o { page, planId, expectAction }
     *   expectAction: 'shop_disable'（关闭托管，实测弹窗「确定关闭乘方投放吗？」）
     *               | 'shop_enable'（开启托管，弹窗结构未实测→出现未知确认弹窗即阻断）
     *               | null（默认，无确认弹窗语义）
     */
    async clickRowSwitch({ page, planId, expectAction = null }) {
      // 点击前：先查删除弹窗（零点击守卫），再查与动作匹配的确认弹窗。
      // fail-closed：两处检测的 page.evaluate 异常都必须在**任何业务点击派发之前**抛
      // DataGuardError（此时零业务点击），绝不 catch 成"无弹窗"后继续点击。
      let del0;
      try {
        del0 = await page.evaluate(hasChengfangDeleteDialogInPage);
      } catch (e) {
        throw new DataGuardError(`点击前删除弹窗检测失败，零点击阻断（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (del0 && del0.found) {
        throw new DataGuardError(`点击前行内开关前检测到删除确认弹窗，停止：${del0.text}`);
      }
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, expectAction);
      } catch (e) {
        throw new DataGuardError(`点击前危险弹窗检测失败，零点击阻断（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (!Array.isArray(danger)) {
        throw new DataGuardError('点击前危险弹窗检测返回非列表，零点击阻断（无法确认无弹窗）');
      }
      {
        // 与当前动作精确一致的确认弹窗（托管关闭/托管开启实测句式）不算阻断
        const isExpectedConfirm = (d) => (expectAction === 'shop_disable' && d.kind === 'shop_disable_confirm')
          || (expectAction === 'shop_enable' && d.kind === 'shop_enable_confirm');
        const blocking = danger.filter((d) => !isExpectedConfirm(d));
        if (blocking.length > 0) {
          throw new DataGuardError(`检测到阻断性弹窗，停止点击行内开关：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
        }
      }
      const loc = await page.evaluate(locateChengfangRowSwitchInPage, planId).catch((e) => ({ ok: false, reason: String(e) }));
      if (!loc || loc.ok !== true) {
        throw new DataGuardError(`点击计划 ${planId} 行内开关失败（定位）：${(loc && loc.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：定位完成后、DOM 点击派发前。
      // 停止/时段/跨日/当前许可或账户身份变化 → 抛 DataGuardError，不派发点击。
      await fireBeforeDispatch({ page });
      const r = await page.evaluate(clickChengfangRowSwitchByPlanId, planId).catch((e) => ({ error: String(e) }));
      if (!r || r.ok !== true) {
        throw new DataGuardError(`点击计划 ${planId} 行内开关失败（二次定位不一致）：${(r && r.reason) || '定位失败'}`);
      }
      await sleep(1500);
      // 托管关闭实测有确认弹窗；开启弹窗未实测 → 出现未知确认弹窗时 submitConfirmIfPresent 会阻断
      const act = expectAction === 'shop_disable' ? 'shop_disable'
        : (expectAction === 'shop_enable' ? 'shop_enable' : 'row_toggle');
      const sub = await submitConfirmIfPresent({ page, expectedAction: act, expectedCount: null });
      return { clicked: true, beforeChecked: r.beforeChecked, confirm: sub };
    },

    /** 精确校正指定计划行内复选框（全选后取消非目标行；以 readSelection 回读核验）。 */
    async setRowCheckbox({ page, planId, checked }) {
      const r = await page.evaluate(setChengfangRowCheckboxByPlanId, { planId, checked }).catch((e) => ({ error: String(e) }));
      if (!r || r.ok !== true) {
        throw new DataGuardError(`校正计划 ${planId} 行内复选框失败：${(r && r.reason) || '定位失败'}`);
      }
      await sleep(300);
    },

    async clickNextPage({ page }) {
      const r = await page.evaluate(clickChengfangNextPageInPage).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) return r;
      await sleep(loadWaitMs);
      return { clicked: true };
    },

    /**
     * 检测阻断性弹窗（删除/未知/与当前动作不符）。expectedAction 可选；
     * 未传时任何"确定/确认"弹窗都视为阻断（保守）。
     */
    async detectDanger({ page, expectedAction = null }) {
      // 检测失败必须抛出（执行器据此停止后续点击）；绝不 catch 成"无弹窗"
      const list = await page.evaluate(detectChengfangDangerDialogInPage, expectedAction);
      if (!Array.isArray(list)) return [];
      if (!expectedAction) return list.filter((d) => d.kind !== 'other' && d.kind !== 'empty');
      const allow = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
        : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
          : (expectedAction === 'batch_enable' ? 'batch_enable_confirm'
            : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : null)));
      return list.filter((d) => d.kind !== allow);
    },

    /** 读取当前确认弹窗（只读；供执行器记录/审计）。 */
    async readConfirmDialog({ page, expectedAction = null }) {
      return page.evaluate(readChengfangConfirmDialogInPage, expectedAction);
    },

    /** 是否存在可见删除确认弹窗（零点击守卫；执行器任意点击前调用）。 */
    async hasDeleteDialog({ page }) {
      return page.evaluate(hasChengfangDeleteDialogInPage);
    },

    /** 回到第一页（全量回读扫描起点；只读分页导航）。 */
    async ensureFirstPage({ page }) {
      const r = await page.evaluate(clickChengfangFirstPageInPage).catch((e) => ({ error: String(e) }));
      if (r && r.clicked === true) await sleep(loadWaitMs);
    },
  };
}

module.exports = {
  parseBalanceTextToCents,
  readQianchuanBalanceInPage,
  balanceCentsFromPageResult,
  resolveRowPlanIdFromText,
  collectChengfangRowsInPage,
  collectChengfangPaginationInPage,
  clickChengfangSubTab,
  openChengfangPageSizeSelectInPage,
  pickChengfangPageSizeInPage,
  clickChengfangHeaderSelectAllInPage,
  readSelectedChengfangRowIdsInPage,
  findChengfangBatchPauseButtonInPage,
  findChengfangBatchEnableButtonInPage,
  findChengfangBatchDeleteButtonInPage,
  readChengfangBatchBarInPage,
  clickChengfangRowSwitchByPlanId,
  locateChengfangRowSwitchInPage,
  resolveChengfangRowSwitchHandle,
  setChengfangRowCheckboxByPlanId,
  detectChengfangDangerDialogInPage,
  classifyDialogText,
  readChengfangConfirmDialogInPage,
  clickChengfangConfirmOkInPage,
  hasChengfangDeleteDialogInPage,
  clickChengfangNextPageInPage,
  clickChengfangFirstPageInPage,
  readChengfangAccountInPage,
  readChengfangFirstUseInPage,
  verifyChengfangReadOnlyEmpty,
  advanceChengfangPlanViewInPage,
  navigateChengfangPlanViewInPage,
  handleChengfangOverlayInPage,
  dismissKnownChengfangOverlays,
  isTrustedChengfangUrl,
  isMissingChengfangControl,
  hasChengfangManualReview,
  retainChengfangPageForManualReview,
  releaseChengfangManualReviewForReadOnlyOpen,
  watchChengfangControlsForManualReview,
  openChengfangShop,
  createChengfangController,
  closeBrowser,
  readChengfangCleanupEvidence,
  readChengfangCleanupHandle,
  CHENGFANG_URL_MARKER,
  SUB_TAB_OPTIONS,
};
