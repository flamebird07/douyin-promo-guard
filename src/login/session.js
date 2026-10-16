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
const { safeCookieBaseName, ensureWorkCopy } = require('./cookie-workcopy');

const PROJECT_COOKIES_DIR = path.join(__dirname, '..', '..', 'cookies');

/**
 * 工作根（写回链落盘目录）：默认固定本项目 cookies/；guard 配置可用
 * `login.cookieWorkDir`（必须绝对路径）显式指定隔离工作根（例如离线测试或多实例部署）。
 * 配置存在但非法 → 如实抛错，绝不静默回落到生产根写入。
 */
function resolveWorkDir(loginCfg, opts) {
  if (opts && typeof opts.workDir === 'string' && opts.workDir.trim()) return opts.workDir;
  const cfg = loginCfg && typeof loginCfg.cookieWorkDir === 'string' ? loginCfg.cookieWorkDir.trim() : '';
  if (!cfg) return PROJECT_COOKIES_DIR;
  if (!path.isAbsolute(cfg)) {
    throw new AuthError(`login.cookieWorkDir 配置非法（必须是绝对路径，拒绝相对路径写入未知位置）: ${cfg}`);
  }
  return cfg;
}

/**
 * 本地工作根文件返回前的隔离门：必须是工作根内的**普通文件**（符号链接/junction/目录
 * 一律拒绝），否则等于把共享上游或别名路径交给自动写回链。结构/登录有效性仍由
 * inspectCookieFile 与业务身份门判定，本函数不放宽任何既有条件。
 */
function localWorkFile(fsm, filePath, workDir, sourceSync) {
  let lst = null;
  try { lst = fsm.lstatSync(filePath); } catch (_) { lst = null; }
  if (!lst || !lst.isFile()) {
    throw new AuthError(
      `本项目 Cookie 文件不是工作根内的普通文件（符号链接/目录/不可判定: ${filePath}）：拒绝把路径别名或共享上游返回给自动写回链`
    );
  }
  const out = { path: filePath, dir: workDir, readOnly: false };
  if (sourceSync) out.sourceSync = sourceSync;
  return out;
}

/**
 * 解析指定店铺的 Cookie 文件路径。
 *
 * S97 起（共享上游保护）：配置了**不同于本项目 cookies/** 的 cookieSourceDir 且存在
 * 精确同名来源文件时，来源目录被当作只读上游——绝不把来源路径返回给自动写回链
 * （cookie-writeback / session-cookie-checkpoint 用返回 path 建 cookieSession 回写，
 * 旧的 readOnly 标记并不能阻止写共享来源）。改为经 `cookie-workcopy.ensureWorkCopy`
 * 复制到本项目 cookies/ 的该店独立工作副本后返回：
 *   { path: 本项目副本, dir: 本项目 cookies/, readOnly: false, sourceSync: {...} }
 * QC / compass / 发布控制器等现有调用者无需修改，自动写回只会落在独立副本上。
 * 来源目录零写入（无 write/rename/unlink/chmod/mkdir/sidecar/tmp）；来源坏/缺失时
 * 保留已有健康副本或抛 AuthError，绝不返回来源路径兜底。
 *
 * S99 起（用户目标：两份 Cookie 各自刷新、互不影响）：普通解析**不再**因为来源内容
 * 变化就替换结构健康的独立工作副本（商品分析普通读取的收尾保存也会改写上游，来源
 * hash 变化不等于用户重新扫码）；只有 app 侧「本次已验证新登录」的 authorizedFreshLogin
 * 调用才按冻结 commit.sha256 更新副本。差异如实出现在 sourceSync.status/reason 中。
 *
 * 无来源配置（或来源目录与本项目 cookies/ 是同一字面目录）时保留原独立登录兼容：
 * 直接用本项目 cookies/ 文件，不反向写任何来源。字面不同但 realpath 重合的
 * junction/symlink 别名属于伪隔离 → 拒绝（不返回上游可写路径给写回链）。
 *
 * @param {object} loginCfg 配置 login 段（cookieSourceDir / cookieWorkDir 可为空）
 * @param {string} cookieFile 精确店铺文件名（不含 .json 亦可；拒绝路径穿越）
 * @param {object} [opts] 仅离线测试注入：{ workDir, fsMod }；生产调用不传，
 *                        工作根为 PROJECT_COOKIES_DIR（或 login.cookieWorkDir）
 */
function resolveCookieFile(loginCfg, cookieFile, opts = {}) {
  const fsm = (opts && opts.fsMod) || fs;
  const workDir = resolveWorkDir(loginCfg, opts);
  const name = safeCookieBaseName(cookieFile);
  const projectPath = path.join(workDir, name);
  const sourceDir = loginCfg && typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim()
    ? loginCfg.cookieSourceDir.trim() : null;

  if (sourceDir) {
    // realpath 比较：symlink/junction 别名视同同一目录（不把路径别名当隔离，也不对同目录做复制）
    let srcReal = null;
    let workReal = null;
    try { srcReal = fsm.realpathSync(sourceDir); } catch (_) { srcReal = null; }
    try { workReal = fsm.realpathSync(workDir); } catch (_) { workReal = null; }
    const sameLiteralDir = path.resolve(sourceDir) === path.resolve(workDir);
    if (!sameLiteralDir && srcReal !== null && workReal !== null && srcReal === workReal) {
      // 配置成"另一个目录"却解析到上游本身（junction/symlink 别名）：伪隔离，必须拒绝
      throw new AuthError(
        `来源目录与工作目录是同一目录的路径别名（realpath 重合: ${srcReal}）：拒绝把共享上游当独立隔离返回给写回链`
      );
    }
    const separate = srcReal !== null && srcReal !== workReal;
    if (separate) {
      const srcPath = path.join(sourceDir, name);
      let srcIsFile = false;
      try { srcIsFile = fsm.lstatSync(srcPath).isFile(); } catch (_) { srcIsFile = false; }
      if (srcIsFile) {
        const r = ensureWorkCopy({ sourceDir, fileName: name, workDir, fsMod: fsm });
        return { path: r.path, dir: r.dir, readOnly: false, sourceSync: r.sourceSync };
      }
      // 来源文件缺失：本项目已有副本（如上游文件被移走）→ 继续用本地副本，不反向写来源
      if (fsm.existsSync(projectPath)) {
        return localWorkFile(fsm, projectPath, workDir, {
          status: 'source-file-missing-local-only',
          reason: '来源目录存在但缺少该店文件：使用本项目既有副本（已核验为工作根内普通文件，非共享上游别名）',
        });
      }
      throw new AuthError(
        `未找到店铺「${cookieFile}」的 Cookie 文件（已查找: ${workDir} 与 ${sourceDir}）`
      );
    }
    // 来源目录与工作根是同一字面目录（或来源目录不可解析）→ 按无独立来源的本地兼容处理
  }

  if (fsm.existsSync(projectPath)) {
    return localWorkFile(fsm, projectPath, workDir, null);
  }
  throw new AuthError(
    `未找到店铺「${cookieFile}」的 Cookie 文件（已查找: ${workDir}${sourceDir ? ` 与 ${sourceDir}` : ''}）`
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
