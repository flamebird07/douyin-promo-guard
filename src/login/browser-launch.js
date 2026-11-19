'use strict';

/**
 * 浏览器可执行路径解析（MAC-1/MAC-2 2026-11-16：Apple Silicon macOS 独立运行兼容）。
 *
 * 语义（最小改动，保留旧 Windows 行为）：
 * - login.edgePath 为空 / "playwright"（不区分大小写）→ 省略 executablePath，
 *   使用 Playwright 自带浏览器（macOS 本地方案一）；
 * - login.edgePath 以 "~/" 开头 → 按当前用户家目录展开（os.homedir()）；
 * - 恰好等于旧默认 Windows Edge 路径且 process.platform === 'darwin' → 回退 Playwright 自带浏览器
 *   （旧 Windows 默认配置在 macOS 上不必改文件即可运行）；
 * - 其余任意显式路径（含输错的 Mac 路径）→ 原样透传给 Playwright 如实报错，不静默回退。
 * 文件路径的有效性由 Playwright 检查。
 */

const os = require('os');
const path = require('path');

// 显式声明"使用 Playwright 自带浏览器"的合法取值（空串 = 未配置该键或留空）。
const PLAYWRIGHT_TOKENS = new Set(['', 'playwright']);

// 旧默认 Windows Edge 路径（config.example.json / DEFAULTS）：仅此值在 macOS 触发兼容回退。
const LEGACY_WIN_EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * 解析 login.edgePath 为实际可执行路径。
 * @returns {string|null} null = 省略 executablePath（Playwright 自带浏览器）
 */
function resolveExecutablePath(loginCfg) {
  const raw = loginCfg && typeof loginCfg.edgePath === 'string' ? loginCfg.edgePath.trim() : '';
  if (PLAYWRIGHT_TOKENS.has(raw.toLowerCase())) return null;
  if (raw === LEGACY_WIN_EDGE_PATH && process.platform === 'darwin') return null; // 旧 Windows 默认路径 → macOS 回退
  const expanded = raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  return expanded; // 显式路径（存在与否）原样透传；缺失由 Playwright 如实报错
}

/**
 * 生成可直接展开进 chromium.launch(...) 的可执行路径选项。
 * @returns {{executablePath?: string}} 非 Playwright 自带语义时含 executablePath，否则为空对象
 */
function launchExecutableOption(loginCfg) {
  const p = resolveExecutablePath(loginCfg);
  return p ? { executablePath: p } : {};
}

module.exports = { resolveExecutablePath, launchExecutableOption };
