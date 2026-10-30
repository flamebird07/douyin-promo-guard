'use strict';

/**
 * 抖店首页「有界被动收敛」策略（叶子模块：零依赖，只读语义常量 + 纯等待例程）。
 *
 * 为什么单独成模块：主链（adapters/qianchuan-reader）require 登录模块，登录模块
 * （login/session、login/session-cookie-checkpoint）反向 require 主链会成循环依赖。
 * 独立候选验证必须复用与主链**同一份**收敛语义（同一上界/同一间隔/同一严格首页判定/
 * 同一双保险限次），故把这份语义下沉为叶子，由三方共同引用，杜绝两处各自演进再失配。
 *
 * 根证 reference-readonly-session.json（2026-10-15 只读复测）：同一已保存 Cookie 装入
 * 全新无头 Edge 后，DOMContentLoaded 后 5s/15s 仍在 /login/common（自动 SSO 中转），
 * 30s 才自动落到 /ffa/mshop/homepage/index，全程零人工/零点击/零写入。任何小于实测
 * 收敛点的等待上界都会把「仍在自动 SSO 的中转」误判成登录失效（FALSE-EXPIRED）。
 *
 * 安全：仅读取地址与可见身份/登录控件，绝不点击/不导航/不 reload/零额外请求；不写 Cookie；
 * 不输出任何凭据值。
 */

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
  return p.origin === `https://${HOME_HOST}` && /^\/ffa\/mshop\/homepage(?:\/index)?\/?$/.test(p.pathname);
}

function probeDoudianHomepageReadyInPage() {
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const login = document.querySelectorAll('input[type="password"], input[placeholder*="手机"], input[placeholder*="验证码"], button, [class*="login"]');
  if ([...login].some(el => visible(el) && (el.tagName === 'INPUT' || /^登录$/.test((el.textContent || '').trim())))) return false;
  const names = document.querySelectorAll('[class*="index_userName"], [class*="index_headerShopName"]');
  return [...names].some(el => visible(el) && (el.textContent || '').trim().length > 0);
}

/** 归一化有限正毫秒：非有限（NaN/Infinity）或非正（0/负数）一律回落默认值（避免 0 造成零等待、
 *  负数造成不死循环/忙等）。 */
function sanitizePositiveMs(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

/**
 * 有界被动等待抖店首页地址与可见身份就绪（零点击/零导航/零请求），
 * 空首页或可见登录控件不会仅凭 URL 放行，等待仍受同一时限约束。
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
  let attempts = 0;
  let url = urlNow();
  for (;;) {
    attempts += 1;
    url = urlNow();
    if (pageClosed()) return { ok: false, reason: 'settle-page-closed', url, attempts };
    if (isDoudianHomepageUrl(url)) {
      let ready = false;
      try { ready = await page.evaluate(probeDoudianHomepageReadyInPage); } catch (_) { ready = false; }
      if (ready === true && !pageClosed() && urlNow() === url) {
        return { ok: true, url, attempts, waited: attempts > 1 };
      }
    }
    if (attempts >= maxAttempts) break;              // 硬限次上界：冻结/回拨时钟下也收敛
    if (!(nowFn() + intervalMs <= deadline)) break;  // 墙钟上界：不再空转
    try { await sleep(intervalMs); } catch (_) { /* 页面关闭等：下一轮 pageClosed 收敛 */ }
  }
  return { ok: false, reason: 'settle-timeout', url, attempts };
}

/**
 * 收敛后的「身份探针」轮询节拍：复用同一间隔语义，避免各处硬编码 2000ms 各自漂移。
 * 返回 { intervalMs, sleepOnce }；sleepOnce 由调用方 await（离线测试注入自己的 sleep）。
 */
function settlePacing(opts = {}) {
  const intervalMs = sanitizePositiveMs(opts.settleIntervalMs, DEFAULT_SETTLE_INTERVAL_MS);
  const timeoutMs = sanitizePositiveMs(opts.settleTimeoutMs, DEFAULT_SETTLE_TIMEOUT_MS);
  const maxAttempts = Math.max(1, Math.min(MAX_SETTLE_ATTEMPTS, Math.ceil(timeoutMs / intervalMs) + 1));
  return { intervalMs, timeoutMs, maxAttempts };
}

module.exports = {
  HOME_HOST,
  HOME_PATH_PREFIX,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_INTERVAL_MS,
  MAX_SETTLE_ATTEMPTS,
  isDoudianHomepageUrl,
  sanitizePositiveMs,
  waitForDoudianHomepageSettled,
  settlePacing,
};
