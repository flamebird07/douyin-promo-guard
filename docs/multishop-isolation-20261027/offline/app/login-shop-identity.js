'use strict';
/**
 * login-shop-identity.js — 抖店登录店铺身份提取（LOGIN-NAME-1，2026-10-02）。
 *
 * 背景：旧 login-shop.js 按“全页元素固定坐标取第一条文字 + compass 宽泛坐标匹配”提取店名，
 * 2026-10-02 19:07 登录因页面重定向到资金账户中心、坐标窗口（top>100）框不住移到顶行的
 * 身份区（真实位置 top≈17），候选 0 → compass 抓到“返回旧版”按钮文案 → 以错误店名保存
 * Cookie 并生成错误值守条目。
 *
 * 本模块以**真实 DOM 证据**（2026-10-02 只读核实，两页同构）为基础：
 *   店名叶子   div[class*="index_userName"]        （直接文本=店名，rect t≈17）
 *   身份容器   div[class*="index_headerShopName"]   （内含 shopTitle/shopDetails/userName）
 *   顶栏       div[class*="nav-menu_wrapper"] → nav-menu_rightBar → nav-menu_extra
 * 首页与 fund-control/account-center 重定向页同位置同结构（leaf-chain.json / leaf-chain-account-center.json）。
 *
 * 规则（客户要求逐条落实）：
 *  - 只认语义身份节点，不再全页按坐标取第一条，也不加“返回旧版”式黑名单；
 *  - 等待由调用方 waitForSelector 承担；候选缺失/冲突/未登录/身份未确认 → 明确失败
 *    （不生成“未知店铺”、不写 Cookie、不输出成功 SHOP_NAME、不接入值守）；
 *  - 名称原文保留（仅 trim）；安全文件名沿用既有规则（替换 \/:*?"<>| 为 _），
 *    但 raw≠safe 且目标文件已存在 = 转换冲突（可能把不同身份覆盖到同一文件）→ 拒绝；
 *    raw===safe 且文件已存在 = 同店重登，允许覆盖；
 *  - stdout 行解析按行缓冲（标记跨块安全），只接受唯一有效 SHOP_NAME 结果。
 */

/** 页面上下文内收集语义身份候选（自包含函数；page.evaluate 直接序列化执行）。 */
function collectPageIdentityCandidates() {
  return (function () {
    const out = [];
    const own = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    // 主：店名叶子（真实 DOM 确认：直接文本=店名）
    for (const el of document.querySelectorAll('[class*="index_userName"]')) {
      const t = own(el);
      const r = el.getBoundingClientRect();
      if (t && r.width > 0 && r.height > 0) out.push({ source: 'userName-leaf', text: t, rect: rectOf(el) });
    }
    // 次：身份容器（叶子缺失时取其首行文本；同源语义，非坐标猜测）
    if (out.length === 0) {
      for (const el of document.querySelectorAll('[class*="index_headerShopName"]')) {
        const t = (el.innerText || '').trim().split('\n')[0].trim();
        const r = el.getBoundingClientRect();
        if (t && r.width > 0 && r.height > 0) out.push({ source: 'headerShopName-container', text: t, rect: rectOf(el) });
      }
    }
    return out;
  })();
}

/** 是否登录页/未登录 URL（登录区检测之一；调用方还需身份节点存在性）。 */
function isLoginPageUrl(url) {
  return /passport\.jinritemai\.com|\/login|\/\/login\?|service\/login/i.test(String(url || ''));
}

/**
 * 从语义候选提取唯一店名（纯函数）。
 * 防御：仅接受语义来源（userName-leaf/headerShopName-container）——其他来源（页面按钮、
 * 坐标扫描结果等）一律忽略，绝不因误传的“返回旧版”式文案得出店名。
 * @returns {{ok:true, name:string, source:string} |
 *           {ok:false, code:'no_candidates'|'conflict'|'invalid', reason:string}}
 */
function extractShopIdentity(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && typeof c.text === 'string') : [];
  const KNOWN_SOURCES = new Set(['userName-leaf', 'headerShopName-container']);
  const clean = (t) => String(t || '').trim();
  const semantic = list.filter((c) => KNOWN_SOURCES.has(c.source));
  if (semantic.length === 0) {
    return { ok: false, code: 'no_candidates', reason: '身份区未提供语义候选（未加载完成、未登录或页面结构与预期不符）' };
  }
  const usable = semantic
    .map((c) => ({
      source: c.source,
      // 容器 innerText 天然多行（店名/店铺状态），取首行；叶子原文保留（仅 trim）
      text: c.source === 'headerShopName-container' ? clean(c.text).split('\n')[0].trim() : clean(c.text),
    }))
    .filter((c) => {
      const t = c.text;
      return t.length >= 2 && t.length <= 30 && !/[\r\n]/.test(t);
    });
  if (usable.length === 0) {
    return { ok: false, code: 'invalid', reason: `语义候选均不满足店名形态（${semantic.map((c) => JSON.stringify(clean(c.text))).join('、')}）` };
  }
  const leaves = usable.filter((c) => c.source === 'userName-leaf');
  const distinct = (arr) => [...new Set(arr.map((c) => c.text))];
  if (leaves.length > 0) {
    const d = distinct(leaves);
    if (d.length === 1) return { ok: true, name: d[0], source: 'userName-leaf' };
    return { ok: false, code: 'conflict', reason: `身份节点给出 ${d.length} 个不同店名（${d.map((x) => JSON.stringify(x)).join('、')}），无法唯一确认` };
  }
  const containers = usable.filter((c) => c.source === 'headerShopName-container');
  const dc = distinct(containers);
  if (dc.length === 1) return { ok: true, name: dc[0], source: 'headerShopName-container' };
  if (dc.length > 1) {
    return { ok: false, code: 'conflict', reason: `身份容器给出 ${dc.length} 个不同店名（${dc.map((x) => JSON.stringify(x)).join('、')}），无法唯一确认` };
  }
  return { ok: false, code: 'invalid', reason: '语义候选均不满足店名形态' };
}

/** 沿用既有安全文件名规则：替换 \/:*?"<>| 为下划线。 */
function safeNameOf(rawName) {
  return String(rawName || '').replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Cookie 目标文件决定（纯函数）：转换冲突必须拒绝——raw≠safe 且 <safe>.json 已存在时，
 * 该文件可能属于另一个身份（其本名恰为 safe 形态），覆盖会把不同身份写进同一文件。
 * raw===safe 且文件已存在 = 同店重登（文件名即身份），允许覆盖。
 * @param {string} rawName 确认后的店名原文
 * @param {string[]} existingCookieFiles cookies 目录现存文件名（如 ['返回旧版.json', …]）
 */
function resolveCookieTarget(rawName, existingCookieFiles) {
  const raw = String(rawName || '').trim();
  if (!raw) return { ok: false, code: 'invalid', reason: '店名为空' };
  const safe = safeNameOf(raw);
  const files = Array.isArray(existingCookieFiles) ? existingCookieFiles : [];
  const existing = files.includes(`${safe}.json`);
  if (safe !== raw && existing) {
    return {
      ok: false,
      code: 'name_conflict',
      reason: `安全文件名转换冲突：店名 ${JSON.stringify(raw)} 将写入已存在的 ${safe}.json（可能属于其他身份），拒绝覆盖`,
      safeName: safe,
    };
  }
  return { ok: true, safeName: safe, file: `${safe}.json`, overwriting: existing };
}

/**
 * 登录子进程 stdout 行解析器：按行缓冲（SHOP_NAME:/COOKIE_SAVE_FAILED:/IDENTITY_FAILED:
 * 标记跨 data 块安全）。
 */
function createLoginStdoutLineParser() {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk || '');
      const lines = [];
      let idx;
      while ((idx = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n/, '');
        if (line.trim()) lines.push(line);
      }
      return lines;
    },
    flush() {
      const rest = buf.trim();
      buf = '';
      return rest ? [rest] : [];
    },
  };
}

/** 从整段 stdout 文本取行（测试便利封装）。 */
function parseLines(text) {
  const p = createLoginStdoutLineParser();
  return p.push(text).concat(p.flush());
}

/**
 * 登录结果判定（纯函数）：只接受唯一有效结果；退出码与 Cookie 保存结果同时满足才成功。
 * @param {{lines:string[], exitCode:number}} p
 * @returns {{success:boolean, shopName:string|null, safeName:string|null,
 *           cookieSaveFailed:boolean, identityFailed:boolean, reason:string|null, code:string}}
 */
function interpretLoginResult(p) {
  const lines = Array.isArray(p && p.lines) ? p.lines : [];
  const exitCode = p ? p.exitCode : undefined;
  const nameMarks = [];
  let cookieSaveFailed = false;
  let identityFailed = false;
  let identityReason = null;
  let cookieReason = null;
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (line.startsWith('SHOP_NAME:')) {
      const v = line.slice('SHOP_NAME:'.length).trim();
      if (v) nameMarks.push(v);
    } else if (line.startsWith('COOKIE_SAVE_FAILED:')) {
      cookieSaveFailed = true;
      cookieReason = line.slice('COOKIE_SAVE_FAILED:'.length).trim();
    } else if (line.startsWith('IDENTITY_FAILED:')) {
      identityFailed = true;
      identityReason = line.slice('IDENTITY_FAILED:'.length).trim();
    }
  }
  const distinctNames = [...new Set(nameMarks)];
  const base = { cookieSaveFailed, identityFailed, shopName: null, safeName: null, reason: null };
  if (identityFailed) {
    return Object.assign(base, { success: false, code: 'identity', reason: identityReason || '未能确认店铺身份' });
  }
  if (distinctNames.length > 1) {
    return Object.assign(base, { success: false, code: 'conflict', reason: `店铺名称标记冲突（${distinctNames.map((x) => JSON.stringify(x)).join('、')}），拒绝采用` });
  }
  const shopName = distinctNames[0] || null;
  if (exitCode === 2 || cookieSaveFailed) {
    return Object.assign(base, { shopName, safeName: shopName, success: false, code: 'cookie_save', reason: '扫码成功但Cookie保存失败' + (cookieReason ? '：' + cookieReason : '') + '，请检查磁盘权限后重试' });
  }
  if (exitCode !== 0) {
    return Object.assign(base, { shopName, success: false, code: 'login_failed', reason: '登录失败或超时，请重新扫码' });
  }
  if (!shopName) {
    return Object.assign(base, { success: false, code: 'identity', reason: '登录成功但未输出有效店铺身份标记' });
  }
  return Object.assign(base, { success: true, shopName, safeName: shopName, code: 'ok', reason: null });
}

module.exports = {
  collectPageIdentityCandidates,
  isLoginPageUrl,
  extractShopIdentity,
  safeNameOf,
  resolveCookieTarget,
  createLoginStdoutLineParser,
  parseLines,
  interpretLoginResult,
};
