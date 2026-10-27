'use strict';

/**
 * COOKIE-PROCESS-ISOLATION-20261026：恢复候选验证的独立浏览器进程助手。
 *
 * 用户明确要求：改成每份 Cookie 使用独立浏览器进程。旧的 createDefaultCandidateVerifier
 * 接收调用方共享的 opts.browser、在同一进程内为每个候选开新 context，不满足该要求；
 * 本模块提供两个最小助手：
 *  - createCandidateBrowserFactory：包装显式注入的 browserFactory（离线测试）或默认
 *    Playwright 启动参数（生产），**每次调用必须返回全新浏览器对象**；工厂返回重复
 *    实例（同一对象复用）或不可用对象 → 立即关闭并抛错（fail-closed，绝不把共享
 *    进程当独立候选进程）。每次成功启动都同步登记 onResource 收口句柄（与店铺浏览器
 *    同一早期所有权协议）。
 *  - closeBrowserProven：关闭并核验（close 未抛错且 isConnected()===false 才算证明）。
 *    读取异常一律按"未关闭"处理：宁可阻断，绝不伪造已关闭。
 *
 * 安全：本模块不打印任何 Cookie/凭证；只持有浏览器对象引用。仅用 Playwright 自带的
 * browser.close()，绝不杀进程树/按映像名杀进程。
 */

/**
 * @param {object} opts
 * @param {Function|null} [opts.injectedFactory] 显式注入的浏览器工厂（测试桩；每次调用应新建实例）
 * @param {Function|null} [opts.fallbackLaunch] 生产默认启动（Playwright chromium.launch，每次全新进程）
 * @param {Function|null} [opts.onResource] 浏览器早所有权登记回调（收口句柄）
 * @returns {Function|null} 每次调用返回全新独立浏览器的异步工厂；无任何启动能力时返回 null
 */
function createCandidateBrowserFactory(opts = {}) {
  const injected = typeof opts.injectedFactory === 'function' ? opts.injectedFactory : null;
  const fallback = typeof opts.fallbackLaunch === 'function' ? opts.fallbackLaunch : null;
  const onResource = typeof opts.onResource === 'function' ? opts.onResource : null;
  const launch = injected || fallback;
  if (!launch) return null;
  // WeakSet：只按对象身份查重，不长期持有已关闭浏览器对象的强引用。
  const seen = new WeakSet();
  return async function launchCandidateBrowser() {
    const browser = await launch();
    const unusable = !browser || typeof browser.newContext !== 'function';
    const duplicate = !unusable && seen.has(browser);
    if (unusable || duplicate) {
      // 拒绝前保守关闭；关闭未获证明必须如实带出——调用方据此停止链条，绝不静默重试。
      let closeProven = false;
      if (browser && typeof browser.close === 'function') closeProven = await closeBrowserProven(browser);
      throw new Error((duplicate
        ? '候选浏览器工厂返回了重复的浏览器实例：每个候选必须使用全新独立浏览器进程'
        : '候选浏览器工厂未返回可用浏览器实例（缺少 newContext）：拒绝验证')
        + (closeProven ? '' : '；且拒绝实例关闭未获证明：停止链条，不盲目重试'));
    }
    seen.add(browser);
    if (onResource) {
      const owned = browser;
      const handle = { close: () => owned.close() };
      if (typeof owned.isConnected === 'function') {
        // 读取异常一律按"仍在线"处理：宁可保守阻断，绝不伪造已关闭。
        handle.isConnected = () => { try { return owned.isConnected() !== false; } catch (_) { return true; } };
      }
      try { onResource(handle); } catch (_) { /* 登记失败不改变验证链路结果 */ }
    }
    return browser;
  };
}

/**
 * 关闭浏览器并给出"确已关闭"证明：close 未抛错，且（若可用）isConnected()===false。
 * @returns {Promise<boolean>} true=已获证明；false=close 抛错或仍连接（按未关闭处理）
 */
async function closeBrowserProven(browser) {
  if (!browser) return true;
  let ok = true;
  try { await browser.close(); } catch (_) { ok = false; }
  if (ok && typeof browser.isConnected === 'function') {
    try { if (browser.isConnected() !== false) ok = false; } catch (_) { ok = false; }
  }
  return ok;
}

module.exports = { createCandidateBrowserFactory, closeBrowserProven };
