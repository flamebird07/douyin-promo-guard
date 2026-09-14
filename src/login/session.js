'use strict';

/**
 * 登录会话管理：Cookie 的精确加载与店铺身份绑定。
 *
 * 复用链（已核实，来自电商助手项目，只读参考未改动）：
 * - Cookie 文件格式：Playwright context.cookies() 的 JSON 数组
 *   （字段 name/value/domain/path/expires/httpOnly/secure/sameSite），
 *   由 bill-manager/login-shop.js 扫码后保存，bill-manager/douyin-shop-analyzer.js
 *   的 loadCookiesFromPath() 用 context.addCookies() 加载。
 * - 店铺列表来源：cookies 目录下的 *.json 文件名（bill-manager/server.js getShops()）。
 * - 登录有效性判定：访问 https://fxg.jinritemai.com/ffa/mshop/homepage/index 后
 *   URL 是否包含 "fxg.jinritemai.com/ffa/mshop/homepage"
 *   （douyin-shop-analyzer.js Step1 登录检测同款逻辑）。
 *
 * 安全约定：本模块绝不打印/返回 cookie 值；对外只暴露元信息（域名、过期时间）。
 *
 * 精确店铺规则（强制）：
 * - 必须由配置显式指定 cookieFile（不含 .json 的文件名）；
 * - 不做模糊匹配、不默认取第一个文件；找不到即报错停机。
 */

const fs = require('fs');
const path = require('path');
const { AuthError } = require('../lib/errors');

const PROJECT_COOKIES_DIR = path.join(__dirname, '..', '..', 'cookies');

/**
 * 解析指定店铺的 Cookie 文件路径。
 * 优先本项目 cookies/（新登录），其次配置的只读来源目录（电商助手，只读）。
 */
function resolveCookieFile(loginCfg, cookieFile) {
  if (!cookieFile || typeof cookieFile !== 'string' || cookieFile.startsWith('TODO')) {
    throw new AuthError('店铺 Cookie 文件名未配置（待配置项）');
  }
  const name = cookieFile.endsWith('.json') ? cookieFile : `${cookieFile}.json`;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new AuthError(`Cookie 文件名非法: ${cookieFile}`);
  }
  const candidates = [
    { dir: PROJECT_COOKIES_DIR, readOnly: false },
    { dir: loginCfg.cookieSourceDir, readOnly: true },
  ];
  for (const c of candidates) {
    if (!c.dir) continue;
    const p = path.join(c.dir, name);
    if (fs.existsSync(p)) return { path: p, dir: c.dir, readOnly: c.readOnly };
  }
  throw new AuthError(
    `未找到店铺「${cookieFile}」的 Cookie 文件（已查找: ${PROJECT_COOKIES_DIR} 与 ${loginCfg.cookieSourceDir}）`
  );
}

/**
 * 校验并返回 Cookie 元信息（不暴露任何值）。
 * @returns {{count:number, domains:string[], fxgExpired:boolean, maxExpires:number|null, readOnly:boolean, filePath:string}}
 */
function inspectCookieFile(cookieFilePath, readOnly) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (e) {
    throw new AuthError(`Cookie 文件解析失败: ${e.message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AuthError('Cookie 文件内容不是非空数组（预期 Playwright cookies 格式）');
  }
  const required = ['name', 'value', 'domain'];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || required.some((k) => typeof c[k] !== 'string')) {
      throw new AuthError('Cookie 数组中存在缺少 name/value/domain 的条目');
    }
  }
  const domains = [...new Set(raw.map((c) => c.domain))];
  const fxgCookies = raw.filter((c) => /(^|\.)jinritemai\.com$/.test(c.domain));
  let maxExpires = null;
  let fxgExpired = false;
  if (fxgCookies.length > 0) {
    const nowSec = Date.now() / 1000;
    maxExpires = Math.max(...fxgCookies.map((c) => (typeof c.expires === 'number' ? c.expires : 0)));
    // 会话 Cookie（expires=-1）视作未知，不据此判死；有明确过期时间且已过则判失效
    const definite = fxgCookies.filter((c) => typeof c.expires === 'number' && c.expires > 0);
    fxgExpired = definite.length > 0 && definite.every((c) => c.expires < nowSec);
  }
  return {
    count: raw.length,
    domains,
    fxgExpired,
    maxExpires: maxExpires && maxExpires > 0 ? maxExpires * 1000 : null,
    readOnly,
    filePath: cookieFilePath,
  };
}

/** 加载某店铺 Cookie 的元信息（不返回值本身）。 */
function loadShopCookieMeta(loginCfg, shopCfg) {
  const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
  const meta = inspectCookieFile(resolved.path, resolved.readOnly);
  if (meta.fxgExpired) {
    throw new AuthError(
      `店铺「${shopCfg.cookieFile}」的抖站 Cookie 已过有效期（最近过期时间 ${meta.maxExpires ? new Date(meta.maxExpires).toISOString() : '未知'}），本轮停止自动操作`
    );
  }
  return meta;
}

/**
 * 用已加载 Cookie 的上下文打开指定页面并检测登录态（复用参考项目的 URL 判定）。
 * 注意：本函数会真正启动浏览器，仅在已接入真实页面读取后由监控流程调用；
 * 本轮仅提供能力，不在无页面阶段自动执行。
 */
async function checkLoginByBrowser(loginCfg, cookieFilePath) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: loginCfg.edgePath,
    args: ['--window-size=1920,1080'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const cookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(loginCfg.douyinHomeUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
    const loggedIn = await page.evaluate(() =>
      window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage')
    );
    return { loggedIn, url: page.url() };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 列出可用店铺名称（本项目 cookies/ + 配置的只读来源目录，仅文件名，不读内容）。
 * 目标店铺未明确配置时供用户选择，绝不默认第一个。
 */
function listAvailableShops(loginCfg) {
  const out = [];
  const dirs = [
    { dir: PROJECT_COOKIES_DIR, readOnly: false },
    { dir: loginCfg && loginCfg.cookieSourceDir, readOnly: true },
  ];
  const seen = new Set();
  for (const d of dirs) {
    if (!d.dir || !fs.existsSync(d.dir)) continue;
    for (const f of fs.readdirSync(d.dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, dir: d.dir, readOnly: d.readOnly });
    }
  }
  return out;
}

module.exports = {
  PROJECT_COOKIES_DIR,
  resolveCookieFile,
  inspectCookieFile,
  loadShopCookieMeta,
  checkLoginByBrowser,
  listAvailableShops,
};
