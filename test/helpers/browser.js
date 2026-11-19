'use strict';

/**
 * DOM 测试共用浏览器启动 helper（MAC-2 2026-11-16）。
 *
 * 可执行路径解析优先级：
 * 1. PROMO_GUARD_TEST_BROWSER_PATH 环境变量（支持 ~/ 前缀按家目录展开）；
 * 2. 默认 Windows 沿用原硬编码 Edge 路径（旧语义不变）；
 * 3. macOS/Linux 默认省略 executablePath，使用 Playwright 自带 Chromium。
 *
 * 仅用于测试；不读取任何 Cookie/凭据。
 */

const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function testExecutableOption() {
  const raw = (process.env.PROMO_GUARD_TEST_BROWSER_PATH || '').trim();
  if (raw) {
    const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    return { executablePath: expanded };
  }
  if (process.platform === 'win32') return { executablePath: EDGE };
  return {};
}

/**
 * 启动测试浏览器。extra 可覆盖 headless/args/executablePath 等（如窗口尺寸）。
 */
function launchTestBrowser(extra) {
  return chromium.launch({ headless: true, ...testExecutableOption(), ...(extra || {}) });
}

module.exports = { launchTestBrowser };
