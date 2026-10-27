'use strict';

/**
 * 电商罗盘"经营概况"订单只读读取器（第三轮接入，真实页面证据建立）。
 *
 * 用户指明的真实路径（2026-09-13 实机探查核实，证据存 evidence/）：
 *   1. 抖店主页面 https://fxg.jinritemai.com/ffa/mshop/homepage/index
 *      （主页外层"成交订单数"数字经常延迟，不使用）；
 *   2. 点击文字"成交订单数"（DIV，class compassTitle-*；主页该精确文本唯一）；
 *   3. 新标签页打开电商罗盘 compass.jinritemai.com/shop（页面标题"核心数据-抖音电商罗盘"，
 *      "经营概况"卡片可见；URL 上的 date_type/date_value 参数是瞬态的，前端路由约 15 秒后
 *      会改写掉，因此日期口径以页面选择器选中态为准，URL 参数仅作旁证）；
 *   4. 双口径核验：页面顶部范围选择器"实时"与售卖类型"全店"都必须处于选中态
 *      （实机证据：选中 tab 的祖先带 aurora-tabs-tab-active 类）；仅实时选中不足以
 *      保证全店订单口径；
 *   5. 指标标签：span[data-index-uuid="pay_cnt"] 内精确文本"成交订单数"；
 *   6. 当前值 = 同一 aurora-data-card-card-item 内 .aurora-data-card-value-main 的文本
 *      （实测 2026-09-13 09:24 为 16、09:50 为 26；昨日/同行基准在 main-right 区块，
 *      绝不跨入——当前值节点缺失/隐藏/加载中/占位时如实阻止，不回退遍历数字）；
 *   7. 店铺身份：右上角 [class*="userName"] 元素文本与配置店铺名精确相等；
 *      罗盘页未见店铺 ID 元素，shopId 为配置归因（如实记录，不宣称独立读取页面 ID）；
 *   8. 数据更新时间：只接受"经营概况"容器内的时间戳（实测容器内无——保持未知；
 *      页面其他区块如"看流量"的时间戳不属于该指标，不采用）。
 *
 * 只读约定：仅导航、点击入口、读取文本；不在罗盘页点击任何其他控件。
 * Cookie 只读加载（本项目 cookies/ 优先，其次电商助手来源目录），绝不打印内容。
 */

const fs = require('fs');
const path = require('path');
const { AuthError, DataGuardError } = require('../lib/errors');
const { parseIntegerCount } = require('../lib/money');
const { shanghaiDate, shanghaiMs } = require('../lib/time');
const { resolveCookieFile, restoreDutyWorkCopy } = require('../login/session');
const { fingerprintFile } = require('../login/cookie-writeback');
// R87：关闭前罗盘会话收尾检查点（同 context 严格语义店名 + 目标文件名绑定 + 既有写入器 CAS）。
const { checkpointCompassSessionCookies } = require('../login/session-cookie-checkpoint');
// COOKIE-PROCESS-ISOLATION-20261026：恢复候选专用独立浏览器进程工厂/关闭证明助手。
const { createCandidateBrowserFactory, closeBrowserProven } = require('../login/candidate-browser');
// R53：单向复用 R51 的抖店首页自动 SSO 有界收敛与登录正证据分类
// （qianchuan-reader 不 import 本文件，无循环依赖）。
const {
  waitForDoudianHomepageSettled,
  collectLoginExpiryEvidence,
  DEFAULT_SETTLE_TIMEOUT_MS,
  sanitizePositiveMs,
} = require('./qianchuan-reader');
// AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1：抖店首页营销浮窗有限处理（根证 2026-10-19：
// 唯一可见 .ws-arrival-modal-wrap 拦截"成交订单数"点击）。本模块不写 Cookie、不改四层。
const { dismissDoudianArrivalOverlay } = require('./doudian-arrival-overlay');

const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const ORDER_LABEL = '成交订单数';
const OVERVIEW_TITLE = '经营概况';

// ── 页面内提取（生产逻辑，自包含函数：reader 通过 page.evaluate 调用，
//    DOM 回归测试通过 setContent + page.evaluate 复用同一函数）────────

/**
 * 在罗盘页面 DOM 中锁定"成交订单数"当前值节点。
 * 证据结构（2026-09-13 实测）：
 *   aurora-data-card-card-item
 *   └─ aurora-data-card-row-content
 *      ├─ aurora-data-card-main-left
 *      │  ├─ aurora-data-card-title（含 span[data-index-uuid="pay_cnt"] > "成交订单数"）
 *      │  └─ aurora-data-card-data → … → aurora-data-card-value-main（当前值，如 "26"）
 *      └─ aurora-data-card-main-right（昨日/同行基准，不属于当前值）
 * 定位链：uuid 元素 → 向上到 card-item → 其内 .aurora-data-card-value-main。
 * 绝不跨入昨日/同行基准：找不到当前值节点就报错，不回退遍历后续数字。
 * @returns 状态码对象 {code, ...}，code 取值：
 *   ok | no_uuid_element | label_mismatch | no_card_item | value_node_missing
 *   | value_hidden | value_loading | value_placeholder | value_not_plain_number
 */
function extractOrderValueInPage(args) {
  const uuid = args.uuid || 'pay_cnt';
  const expectLabel = args.label || '成交订单数';
  const uuidEl = document.querySelector(`[data-index-uuid="${uuid}"]`);
  if (!uuidEl) return { code: 'no_uuid_element', reason: `页面未找到 [data-index-uuid="${uuid}"] 指标节点` };
  const labelText = (uuidEl.textContent || '').trim();
  if (!labelText.includes(expectLabel)) {
    return { code: 'label_mismatch', reason: `data-index-uuid="${uuid}" 节点文本为「${labelText}」，与「${expectLabel}」不符（uuid 可能被复用）` };
  }
  let cardItem = uuidEl;
  for (let i = 0; i < 12 && cardItem; i++) {
    if (String(cardItem.className || '').includes('aurora-data-card-card-item')) break;
    cardItem = cardItem.parentElement;
  }
  if (!cardItem || !String(cardItem.className || '').includes('aurora-data-card-card-item')) {
    return { code: 'no_card_item', reason: '未找到指标所属的 aurora-data-card-card-item 容器' };
  }
  const valueNodes = cardItem.querySelectorAll('.aurora-data-card-value-main');
  // 用户确认（2026-10-25）：罗盘"成交订单数"现场显示横杠（-）就是 0，属正常读数；
  // 两种正常布局下的横杠都按数值 0 沿同一正常分支流转（含双口径核验），不按占位符阻止。
  let valueText = null;
  if (valueNodes.length === 0) {
    // 当前值节点 .value-main 缺失。但罗盘在"暂无实时数值"时仍保留同一卡片 main-left 的
    // 当前数据容器 .aurora-data-card-data（用户确认此时显示 "-" 即 0；昨日值在
    // .aurora-data-card-information 兄弟节点，绝不在此读取）。严格只锁定与当前 pay_cnt
    // 卡片 main-left 绑定的唯一数据容器，据其文本区分横杠 0/加载中与真缺失/版式无法确认/歧义；
    // 绝不把容器里的数字当回退解析。
    const leftCol = cardItem.querySelector('.aurora-data-card-main-left');
    const curData = leftCol ? leftCol.querySelectorAll('.aurora-data-card-data') : [];
    const hasYesterday = /昨日/.test(cardItem.textContent || '');
    if (curData.length === 1) {
      const curText = (curData[0].textContent || '').trim();
      if (curText === '') {
        return { code: 'value_loading', reason: '罗盘当前成交订单数为空（实时数据加载中），等待返回有效数值' };
      }
      if (/^[—\-–]+$/.test(curText)) {
        // 用户确认：横杠即 0，视为正常值继续走双口径核验
        valueText = '0';
      } else {
        // 数据容器存在但无 .value-main 且内容非横杠：版式无法确认，保持数据护栏，不回退解析数字
        return { code: 'value_node_missing', reason: `当前值节点 .aurora-data-card-value-main 缺失，且左栏数据容器内容「${curText}」无法确认为有效当前值（不回退解析容器数字）`, hasYesterday };
      }
    } else {
      // 当前数据容器缺失或重复：结构性问题，保持 value_node_missing，不回退
      return {
        code: 'value_node_missing',
        reason: curData.length === 0
          ? '当前值节点 .aurora-data-card-value-main 缺失'
          : `当前值节点 .aurora-data-card-value-main 缺失，且左栏数据容器出现 ${curData.length} 处，无法唯一定位`,
        hasYesterday,
      };
    }
  } else if (valueNodes.length > 1) {
    return { code: 'value_node_missing', reason: `当前值节点出现 ${valueNodes.length} 处，无法唯一定位` };
  } else {
    const vEl = valueNodes[0];
    const r = vEl.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      return { code: 'value_hidden', reason: '当前值节点不可见（display:none 或未渲染）' };
    }
    const raw = (vEl.textContent || '').trim();
    if (raw === '') return { code: 'value_loading', reason: '当前值节点为空（数据加载中）' };
    if (/^[—\-–]+$/.test(raw)) {
      // 用户确认：横杠即 0，视为正常值继续走双口径核验
      valueText = '0';
    } else if (!/^[\d,]+$/.test(raw)) {
      return { code: 'value_not_plain_number', reason: `当前值「${raw}」不是纯整数（万级/小数展示不用于订单数）` };
    } else {
      valueText = raw;
    }
  }
  // 双口径核验：页面顶部 aurora-tabs 组中"实时"与"全店"都必须处于选中态
  const tabState = (text) => {
    let found = null;
    for (const el of document.querySelectorAll('body *')) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
      if (own !== text) continue;
      let a = el, active = false, isTab = false;
      for (let k = 0; k < 6 && a; k++) {
        const cls = String(a.className || '');
        if (cls.includes('aurora-tabs-tab-active')) active = true;
        if (cls.includes('aurora-tabs-tab')) isTab = true;
        a = a.parentElement;
      }
      const rect = el.getBoundingClientRect();
      if (isTab && rect.width > 0 && rect.height > 0) { found = { active, y: Math.round(rect.y) }; break; }
    }
    return found;
  };
  const realtime = tabState('实时');
  const saleAll = tabState('全店');
  // 经营概况容器（订单标签祖先 30 层内含"经营概况"文本的容器）内的数据更新时间
  let overviewContainer = null;
  let a = uuidEl;
  for (let i = 0; i < 30 && a && a !== document.body; i++) {
    if ((a.textContent || '').includes('经营概况')) { overviewContainer = a; break; }
    a = a.parentElement;
  }
  const tsMatch = overviewContainer ? (overviewContainer.textContent || '').match(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/) : null;
  return {
    code: 'ok',
    valueText,
    labelText,
    cardText: (cardItem.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    saleScope: {
      realtimeActive: Boolean(realtime && realtime.active),
      saleAllActive: Boolean(saleAll && saleAll.active),
      realtimeFound: Boolean(realtime),
      saleAllFound: Boolean(saleAll),
      tabs: [realtime, saleAll].filter(Boolean),
    },
    overviewTimestamp: tsMatch ? tsMatch[0] : null,
  };
}

// ── 纯逻辑（可隔离测试）───────────────────────────────────────────

/**
 * 指标消歧：候选块中必须恰好有一个精确标签"成交订单数"。
 * @param {Array<{label:string,valueText:string}>} blocks
 * @returns {{ok:true,label,valueText}|{ok:false,reason}}
 */
function extractOrderMetric(blocks) {
  const hits = (blocks || []).filter((b) => (b.label || '').trim() === ORDER_LABEL);
  if (hits.length === 0) {
    const seen = [...new Set((blocks || []).map((b) => (b.label || '').trim()).filter(Boolean))];
    return { ok: false, reason: `未找到精确指标「${ORDER_LABEL}」（页面可见指标: ${seen.slice(0, 8).join('、') || '无'}）；不使用成交人数/商品件数/金额等替代` };
  }
  if (hits.length > 1) {
    return { ok: false, reason: `指标歧义：页面出现 ${hits.length} 处精确「${ORDER_LABEL}」（值: ${hits.map((h) => h.valueText).join('/')}），无法唯一定位，如实阻止` };
  }
  return { ok: true, label: ORDER_LABEL, valueText: hits[0].valueText };
}

/**
 * 从卡片文本提取标签后的数值（证据格式："成交订单数16昨日145同行基准114"）。
 */
function pickValueFromCardText(cardText) {
  const m = /成交订单数\s*([\d,]+(?:\.\d+)?(?:万)?)/.exec(cardText || '');
  return m ? m[1] : null;
}

/**
 * 日期口径核验：落点 URL 必须带 date_type=1 且 date_value 为"当天0点秒,当天0点秒"。
 * @returns {{ok:true, businessDate:string}|{ok:false, reason:string}}
 */
function verifyDateScopeFromUrl(url, nowMs) {
  const today = shanghaiDate(nowMs);
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, reason: `落点 URL 非法: ${url}` }; }
  const dateType = u.searchParams.get('date_type');
  const dateValue = u.searchParams.get('date_value');
  if (dateType !== '1') {
    return { ok: false, reason: `日期口径非"当天实时"：URL date_type=${JSON.stringify(dateType)}（期望 1）` };
  }
  if (!dateValue) {
    return { ok: false, reason: 'URL 缺少 date_value，无法确认统计日期口径' };
  }
  const expectedStartSec = String(Math.floor(shanghaiMs(today, '00:00') / 1000));
  const parts = dateValue.split(',').map((s) => s.trim());
  if (parts.length !== 2 || parts[0] !== parts[1] || parts[0] !== expectedStartSec) {
    return {
      ok: false,
      reason: `统计日期不是当天：URL date_value=${dateValue}（期望当天 ${today} 00:00 = ${expectedStartSec} 秒，且为单日）`,
    };
  }
  return { ok: true, businessDate: today };
}

/**
 * 店铺身份核验：页面店铺名与配置精确相等（不做模糊匹配）。
 */
function matchShopIdentity(pageShopName, shopCfg) {
  const cfgName = (shopCfg.compassShopName || shopCfg.name || '').trim();
  if (!cfgName || cfgName.startsWith('TODO')) {
    return { ok: false, reason: '未配置店铺名称（shops[].name 或 compassShopName），无法对罗盘页做身份核验' };
  }
  const pageName = (pageShopName || '').trim();
  if (pageName !== cfgName) {
    return { ok: false, reason: `罗盘页店铺身份不匹配：配置「${cfgName}」，页面「${pageName || '(空)'}」` };
  }
  return { ok: true, pageShopName: pageName };
}

// ── 页面读取（Playwright 胶水层，已被实机验证）────────────────────

/**
 * @param {object} p
 * @param {object} p.loginCfg       config.login（cookieSourceDir/edgePath）
 * @param {()=>number} [p.nowFn]
 * @param {boolean} [p.headless]    默认 true
 * @param {string} [p.evidenceDir]  读取证据截图目录（默认项目 evidence/）
 */
function createCompassOrderReader(p) {
  const loginCfg = p.loginCfg;
  const nowFn = p.nowFn || (() => Date.now());
  const headless = p.headless !== false;
  const evidenceDir = p.evidenceDir || path.join(__dirname, '..', '..', 'evidence');
  // COOKIE-PROCESS-ISOLATION-20261026：店铺浏览器启动助手（恢复重载时启动**全新**进程）
  // 与恢复候选专用独立浏览器工厂（每个候选一份全新进程；绝不复用共享店铺浏览器）。
  // 校正：店铺浏览器启动同样经"每次全新实例"工厂包装（对象身份查重）——注入工厂在恢复后
  // 返回**同一个旧浏览器对象**（复用旧进程）→ 在 addCookies 之前拒绝（关闭并抛错），
  // 绝不带旧 Cookie 进程重载新工作副本。生产默认 chromium.launch 每次全新进程，行为不变。
  const shopBrowserFactory = createCandidateBrowserFactory({
    injectedFactory: typeof p.browserFactory === 'function' ? p.browserFactory : null,
    fallbackLaunch: () => require('playwright').chromium.launch({
      headless,
      executablePath: loginCfg.edgePath,
      args: ['--window-size=1920,1080'],
    }),
  });
  const launchShopBrowser = () => shopBrowserFactory();
  const candidateBrowserFactory = typeof p.restoreCandidateBrowserFactory === 'function'
    ? p.restoreCandidateBrowserFactory
    : createCandidateBrowserFactory({
      injectedFactory: typeof p.browserFactory === 'function' ? p.browserFactory : null,
      fallbackLaunch: () => require('playwright').chromium.launch({
        headless,
        executablePath: loginCfg.edgePath,
        args: ['--window-size=1920,1080'],
      }),
    });

  async function readOrderSummary({ shopCfg }) {
    const startedAt = nowFn();
    const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
    // R87：会话收尾保存元信息——加载前指纹必须在 addCookies 之前捕获（冲突保护基线）。
    const cookieSession = {
      filePath: resolved.path,
      readOnly: resolved.readOnly,
      startFingerprint: fingerprintFile(resolved.path),
    };
    // browserFactory 可注入（离线测试）；默认行为与原实现完全一致。
    let browser = await launchShopBrowser();
    const shopBrowserIdentities = [browser];
    // R87：finally 中收尾保存所需的当前会话引用（try 块内 const 在 finally 不可见）。
    let sessionCtx = null;
    let sessionTarget = null;
    let context = null;
    let page = null;
    try {
      // AD-COOKIE-FOUR-TIER-20261019-F1：会话打开收口（含恢复成功后的有界一次重试）。
      // 1) 抖店主页面（入口），核验登录态（R53：复用 R51 有界自动 SSO 收敛）。
      //    根证：有效 Cookie 装入全新浏览器后先停在 /login/common 中转，~30s 才落首页；
      //    旧实现固定等 6s 即把中转地址判 AuthError → 伪登录过期（误要求重扫）。
      //    收敛成功才继续；上界到达才做登录正证据分类：
      //    真过期（登录页地址/可见登录表单控件）仍 AuthError；
      //    页面被关闭/教程/未知导航按 DataGuard 导航事实处理，不触发重扫。
      const openFxgSession = async () => {
        const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
        try {
          const cookies = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
          await ctx.addCookies(cookies);
          const pg = await ctx.newPage();
          await pg.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await pg.waitForTimeout(6000);
          const settled = await waitForDoudianHomepageSettled(pg, p);
          return { ctx, pg, settled };
        } catch (e) {
          try { await ctx.close(); } catch (_) { /* 关闭失败不掩盖原始错误 */ }
          throw e;
        }
      };
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
      // 仅明确登录失效正证据进入四层恢复链（导航/页面关闭类不触碰 Cookie）：
      // 值守工作副本当前字节排除（刚在本浏览器失败）→ 恢复副本 → 匹配店铺最近原始快照；
      // 候选独立新上下文验证通过才冻结基线 CAS 提升；成功重试一次；全部失败如实保留
      // AuthError，不盲覆盖、不跨店、不循环（p.restoreOnAuthFailure===false 关闭）。
      if (fail && fail.kind === 'login' && p.restoreOnAuthFailure !== false) {
        await sess.ctx.close();
        // 候选切换前先关闭当前店铺浏览器进程（不能带着旧 Cookie 进程活着等候选验证）；
        // 关闭未获证明 → 阻断恢复（绝不重叠会话/绝不带旧进程继续）。
        const browserClosed = await closeBrowserProven(browser);
        if (browserClosed) browser = null;
        if (!browserClosed) {
          throw new AuthError('登录失效后原店铺浏览器进程关闭未获证明：阻断四层恢复（绝不重叠会话/绝不带着旧 Cookie 进程继续）');
        }
        let restore = null;
        try {
          const runner = p.restoreRunner || restoreDutyWorkCopy;
          restore = await runner(loginCfg, shopCfg.cookieFile, {
            shopCfg,
            excludeWorkCopy: true,
            candidateBrowserFactory,
            forbiddenBrowsers: shopBrowserIdentities.slice(),
            verify: p.restoreVerify,
            vaultModule: p.restoreVaultModule,
            vaultRoots: p.restoreVaultRoots,
            recoveryDir: p.restoreRecoveryDir,
            nowFn,
            audit: p.audit,
          });
        } catch (e) {
          restore = { ok: false, reason: '恢复链异常：' + ((e && e.message) || e) };
        }
        fail.restore = restore;
        if (restore.ok) {
          // 恢复提升已更新工作副本：刷新指纹基线，并在**全新**店铺浏览器进程上重开有界一次
          //（旧进程已关闭，绝不复用旧 Cookie 进程重载）。
          cookieSession.startFingerprint = fingerprintFile(resolved.path);
          browser = await launchShopBrowser();
          shopBrowserIdentities.push(browser);
          sess = await openFxgSession();
          fail = sess.settled.ok ? null : await classifySettleFailure(sess);
        }
      }
      context = sess.ctx;
      page = sess.pg;
      sessionCtx = context;
      if (fail) {
        if (fail.kind === 'page-closed') {
          throw new DataGuardError(`抖店主页面在自动登录收敛期内被关闭（最后地址 ${sess.settled.url || '未知'}）；按导航事实处理，需人工核实`);
        }
        if (fail.kind === 'login') {
          const restoreNote = fail.restore
            ? `；四层恢复未取得可验证候选（${fail.restore.reason || '未提升'}），工作副本现状未被盲覆盖`
            : '';
          throw new AuthError(`登录失效：抖店页面在 ${sess.settled.attempts} 次有界收敛（上限 ${Math.round(sanitizePositiveMs(p.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS) / 1000)}s）后仍命中登录页地址或可见登录控件/表单（当前 ${page.url()}），请重新扫码登录${restoreNote}`);
        }
        throw new DataGuardError(`抖店主页面在有界自动登录收敛期内未到达首页（${sess.settled.attempts} 次探测，当前 ${sess.settled.url || page.url()}）；未见登录正证据，按导航事实处理，需人工核实`);
      }

      // 2) 点击"成交订单数"文字入口；处理新标签页或当前页跳转
      //    AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1：入口点击前处置首页营销浮窗——
      //    严格可信 host/path + 唯一可见根 + 唯一明确 dismiss 控件才点击；检测到
      //    登录/支付/删除等业务危险内容、多根/多控件 → 零点击阻断（DataGuard，绝不
      //    点击"立即报名"、绝不遮罩删除）；0 浮窗立即无操作；点击后有界轮回读消失。
      //    关闭标记以非枚举属性挂 cookieSession，随同一会话进入 finally 收尾检查点；
      //    Cookie 持久化链路不变（到达罗盘并严格店铺身份后仅由
      //    checkpointCompassSessionCookies 写 guard 工作副本，首页未身份验证绝不保存）。
      const overlay = await dismissDoudianArrivalOverlay(page, {
        // 地址门复用 SSO 收敛已严格核验的首页地址（不额外读取页面地址）；
        // 点击时刻仍由页内 location.href 严格 host/path 复核兜底。
        urlHint: sess.settled.url,
        sleep: p.overlaySleep, maxRounds: p.overlayMaxRounds, intervalMs: p.overlayIntervalMs,
      });
      Object.defineProperty(cookieSession, 'arrivalOverlay', {
        value: {
          stage: 'compass-home',
          status: overlay.status,
          closed: overlay.closed === true,
          clickedCount: overlay.clickedCount,
          rounds: overlay.rounds,
        },
        enumerable: false, configurable: true, writable: true,
      });
      if (overlay.blocked || overlay.status === 'still_present') {
        throw new DataGuardError(`抖店首页营销浮窗处理受阻：${overlay.reason}；绝不点击浮窗内其他控件`);
      }
      //    R54：SSO 收敛后首页 URL 已就绪但 SPA 入口渲染有延迟，首次 count=0
      //    属瞬时渲染而非结构性缺失——先做有界被动等待（复用既有 locator，
      //    ≤20s，无新定时器/服务）；等待后仍缺失才维持原 DataGuard 语义。
      const labelLoc = page.getByText(ORDER_LABEL, { exact: true });
      if ((await labelLoc.count()) === 0 && typeof labelLoc.first().waitFor === 'function') {
        await labelLoc.first().waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
      }
      if ((await labelLoc.count()) === 0) {
        throw new DataGuardError('抖店主页面未找到"成交订单数"文字入口（页面结构可能变化），不使用主页外层数字');
      }
      const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
      const navPromise = page.waitForURL(/compass\.jinritemai\.com/, { timeout: 25000 }).catch(() => null);
      await labelLoc.first().click({ timeout: 15000 });
      const popup = await popupPromise;
      await navPromise;
      await page.waitForTimeout(2000);
      const target = popup && !popup.isClosed() ? popup : page;
      sessionTarget = target;

      // 3) 落点核验：电商罗盘 + 经营概况
      await target.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await target.waitForFunction(() => document.body && document.body.innerText.includes('经营概况'), { timeout: 30000 }).catch(() => {});
      const landedUrl = target.url();
      if (!/compass\.jinritemai\.com/.test(landedUrl)) {
        throw new DataGuardError(`点击"成交订单数"后未到达电商罗盘（当前: ${landedUrl}）`);
      }
      const overviewOk = await target.evaluate((t) => document.body.innerText.includes(t), OVERVIEW_TITLE);
      if (!overviewOk) {
        throw new DataGuardError('罗盘页面未见"经营概况"卡片，无法按用户指定路径读取');
      }

      // 4) 指标定位与数值读取（生产提取函数，运行于页面 DOM）：
      //    uuid=pay_cnt → card-item → .aurora-data-card-value-main 当前值；
      //    同时核验"售卖类型=全店"与"日期=实时"双口径；
      //    当前值缺失/隐藏/加载中/占位时如实阻止，绝不回退读取昨日/同行基准。
      let probed = null;
      let lastProbe = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        probed = await target.evaluate(extractOrderValueInPage, {
          uuid: 'pay_cnt',
          label: ORDER_LABEL,
          overview: OVERVIEW_TITLE,
        }).catch((e) => ({ code: 'evaluate_error', reason: String(e.message).slice(0, 160) }));
        lastProbe = probed;
        if (probed.code === 'ok'
          && probed.saleScope.realtimeActive
          && probed.saleScope.saleAllActive) break;
        await page.waitForTimeout(1000); // 等待真实数据加载
      }
      if (!probed || probed.code !== 'ok') {
        const reason = probed && probed.reason ? probed.reason : '页面提取失败';
        const detail = probed && probed.code === 'value_placeholder'
          ? { source: 'compass-order-reader', metric: 'pay_cnt', observation: 'value_placeholder' }
          : null;
        throw new DataGuardError(`"成交订单数"读取失败：${reason}（不回退读取昨日值/同行基准）`, detail);
      }
      const saleScope = probed.saleScope || {};
      if (!saleScope.saleAllActive) {
        throw new DataGuardError(
          `订单口径核验失败：售卖类型未处于"全店"选中态（实测 ${saleScope.saleAllFound ? '全店未选中' : '页面未见售卖类型 tabs'}）；仅实时选中不足以保证全店订单口径`
        );
      }
      if (!saleScope.realtimeActive) {
        throw new DataGuardError(
          `订单口径核验失败：日期范围未处于"实时"选中态（实测 ${saleScope.realtimeFound ? '实时未选中' : '页面未见实时 tabs'}）`
        );
      }
      const parsed = parseIntegerCount(probed.valueText);
      if (!parsed.ok) throw new DataGuardError(`"成交订单数"数值解析失败: ${JSON.stringify(probed.valueText)}（${parsed.reason}）`);
      const scope = { ok: true, businessDate: shanghaiDate(nowFn()) };

      // 5) 店铺身份核验（右上角 userName 元素精确比对）
      const cfgName = (shopCfg.compassShopName || shopCfg.name || '').trim();
      if (!cfgName || cfgName.startsWith('TODO')) {
        throw new AuthError('未配置店铺名称（shops[].name 或 compassShopName），无法对罗盘页做身份核验');
      }
      const userNameEl = target.locator('[class*="userName"]').first();
      let pageShopName = '';
      try {
        pageShopName = (await userNameEl.textContent({ timeout: 10000 })) || '';
      } catch (_) { /* 元素缺失走下方核验失败 */ }
      const ident = matchShopIdentity(pageShopName, shopCfg);
      if (!ident.ok) throw new AuthError(ident.reason);

      // 6) 证据截图（尽力而为，不阻塞）
      try {
        if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
        await target.screenshot({ path: path.join(evidenceDir, `order-read-${startedAt}.png`), timeout: 8000 });
      } catch (_) { /* 截图失败不影响读取 */ }

      // 身份经店铺名精确核验后，shopId 以配置 ID 归因——罗盘页未展示店铺 ID，
      // 未独立读取页面 ID；归因方式如实记录于 shopIdAttribution / identityEvidence。
      const tsNote = probed.overviewTimestamp
        ? `${probed.overviewTimestamp}（经营概况容器内时间戳，+08:00）`
        : null;
      return {
        source: 'promo-page',
        kind: 'orders',
        shopId: shopCfg.id,
        shopIdAttribution: '配置归因：罗盘页未见店铺 ID 元素，未独立读取页面 ID；shopId 取自配置并经页面店铺名精确映射核验',
        accountId: null,
        businessDate: scope.businessDate,
        dateScopeEvidence: `售卖类型=全店 且 日期=实时 均处于选中态（aurora-tabs-tab-active 实测）；当天 00:00 起累计（tabs 实测: ${JSON.stringify(saleScope.tabs)}）`,
        fetchedAt: new Date(nowFn()).toISOString(),
        pageUpdatedAt: tsNote,
        pageUpdatedAtNote: tsNote
          ? null
          : '经营概况容器内未见数据更新时间（页面其他区块的时间戳不属于该指标，不采用）——源数据更新时间未知，不使用抓取时间冒充',
        rawText: probed.valueText,
        cardText: probed.cardText || null,
        identityEvidence: { via: '罗盘右上角 userName 元素精确比对', pageShopName: ident.pageShopName },
        // 结构化来源标记（2026-09-25 阶段 6 来源门禁）：证明店铺名证据出自本罗盘
        // 适配器的实测链（userName 精确比对）；下游建立账户映射前必须核对该标记，
        // 不得仅凭 identityEvidence.pageShopName 字段存在放行。
        identitySource: {
          adapter: 'compass-order-reader',
          evidence: 'userName-exact-match',
          pageShopName: ident.pageShopName,
        },
        pageUrl: landedUrl,
        valueCount: parsed.count,
      };
    } finally {
      // R87 收尾检查点：关闭前以当前时刻事实重新核验罗盘经营页的严格语义店铺名身份
      // （同 context + 可信 /shop 页 + 唯一可见 [class*=userName] 店名 + 目标文件名绑定），
      // 成立时才经既有授权写入器回写刷新 Cookie。任何跳过/异常都只如实记录，绝不掩盖原始
      // 读取结果或原始异常、绝不把跳过标成 Cookie 过期；无身份/登录/foreign/关闭页即零写。
      try {
        await checkpointCompassSessionCookies({
          context: sessionCtx,
          cookieSession,
          target: sessionTarget,
          shopCfg,
          audit: p.audit,
        });
      } catch (_) { /* 收尾保存失败不得阻止关闭，也不改变已确认的业务结果 */ }
      // 恢复失败路径中浏览器可能已因候选切换被证明关闭并置空：不为 null 才需要收口。
      if (browser) await browser.close().catch(() => {});
    }
  }

  return {
    connected: true,
    source: 'promo-page',
    kind: 'orders',
    readOrderSummary,
  };
}

module.exports = {
  createCompassOrderReader,
  extractOrderValueInPage,
  extractOrderMetric,
  pickValueFromCardText,
  verifyDateScopeFromUrl,
  matchShopIdentity,
  ORDER_LABEL,
};
