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
const { resolveCookieFile } = require('../login/session');

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
  if (valueNodes.length === 0) {
    // 当前值节点缺失（昨日在不在都不接受）：明确不回退
    const hasYesterday = /昨日/.test(cardItem.textContent || '');
    return { code: 'value_node_missing', reason: '当前值节点 .aurora-data-card-value-main 缺失', hasYesterday };
  }
  if (valueNodes.length > 1) {
    return { code: 'value_node_missing', reason: `当前值节点出现 ${valueNodes.length} 处，无法唯一定位` };
  }
  const vEl = valueNodes[0];
  const r = vEl.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    return { code: 'value_hidden', reason: '当前值节点不可见（display:none 或未渲染）' };
  }
  const raw = (vEl.textContent || '').trim();
  if (raw === '') return { code: 'value_loading', reason: '当前值节点为空（数据加载中）' };
  if (/^[—\-–]+$/.test(raw)) return { code: 'value_placeholder', reason: `当前值为占位符「${raw}」` };
  if (!/^[\d,]+$/.test(raw)) {
    return { code: 'value_not_plain_number', reason: `当前值「${raw}」不是纯整数（万级/小数展示不用于订单数）` };
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
    valueText: raw,
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

  async function readOrderSummary({ shopCfg }) {
    const startedAt = nowFn();
    const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      headless,
      executablePath: loginCfg.edgePath,
      args: ['--window-size=1920,1080'],
    });
    try {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
      const cookies = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
      await context.addCookies(cookies);
      const page = await context.newPage();

      // 1) 抖店主页面（入口），核验登录态
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
      if (!page.url().includes('fxg.jinritemai.com/ffa/mshop/homepage')) {
        throw new AuthError(`登录失效：抖店主页面未进入登录后地址（当前 ${page.url()}），请重新扫码登录`);
      }

      // 2) 点击"成交订单数"文字入口；处理新标签页或当前页跳转
      const labelLoc = page.getByText(ORDER_LABEL, { exact: true });
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
        throw new DataGuardError(`"成交订单数"读取失败：${reason}（不回退读取昨日值/同行基准）`);
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
      await browser.close().catch(() => {});
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
