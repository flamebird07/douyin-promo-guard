'use strict';

/**
 * Cookie 自动发现店铺（2026-09-25 阶段 5，用户已确认方案）。
 *
 * 用户决策：Cookie 文件目录作为店铺发现入口，不再要求手工在 config.json 逐店
 * 配置 Cookie/账户。新增 Cookie 自动出现；已删除店铺不因重复扫描自动恢复。
 *
 * 规则（与 src/login/session.js resolveCookieFile 同源的目录优先级）：
 *  - 扫描项目 cookies/ 目录与 login.cookieSourceDir（都存在才扫；cookieSourceDir
 *    未配置时整个发现流程关闭，既有测试与无 Cookie 环境不受影响）；
 *  - 以 Cookie 文件名（去 .json）为店铺标识，命中现有 shops 条目
 *    （cookieFile/id/name 任一匹配，**含 deleted=true 的软删除条目**）→ 原样保留，
 *    绝不复活已删除店铺、绝不改动既有条目的 thresholdCents/enabled 等字段；
 *  - 未命中任何条目的 Cookie → 追加新店
 *    { id, name, cookieFile, platform:'douyin', enabled:true, autoDiscovered:true }，
 *    追加在列表末尾（不重排既有条目，保证 shops[0] 等既有下标语义不变）；
 *  - 不可解析或非数组形态的 .json 视为非 Cookie 文件，跳过并记录原因，不产生店铺；
 *  - 纯函数：不改入参、不做 IO 写入；持久化由 Monitor 的原子写统一承担。
 *
 * 安全说明（如实）：自动发现店不携带 accountId——账户映射核验在 accountId 配置前
 * 不生效（guard.checkSourceIdentity 现行语义）；店铺 ID 级身份核验与 fail-closed
 * 链路不受影响。用户如需账户映射核验，可在页面对该店「修改」后另行配置 accountId。
 */

const fs = require('fs');
const path = require('path');

/** 项目 cookies/ 目录（CLI 新登录的回写目标；resolveCookieFile 同源）。 */
const PROJECT_COOKIES_DIR = path.join(__dirname, '..', '..', 'cookies');

/** 归一化匹配键：去 .json 后缀、去空白。 */
function cookieKey(v) {
  return String(v == null ? '' : v).replace(/\.json$/i, '').trim();
}

/**
 * 从 Cookie 目录发现店铺并合并进既有清单。
 * @param {object} p
 * @param {object} [p.loginCfg]           配置的 login 段（cookieSourceDir 为发现开关）
 * @param {Array}  p.shops                既有店铺条目（含软删除条目；不会被修改）
 * @param {string} [p.projectCookiesDir]  项目 cookies 目录（默认仓库 cookies/；测试可注入）
 * @returns {{shops: Array, added: string[], skipped: Array<{file:string,dir:string,reason:string}>, scannedDirs: string[]}}
 */
function discoverShopsFromCookies(p = {}) {
  const loginCfg = p.loginCfg || {};
  const existing = Array.isArray(p.shops) ? p.shops : [];
  const projectDir = p.projectCookiesDir || PROJECT_COOKIES_DIR;
  const sourceDir = typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim()
    ? loginCfg.cookieSourceDir.trim() : null;

  const scannedDirs = [];
  const skipped = [];
  if (!sourceDir) {
    return { shops: existing, added: [], skipped, scannedDirs };
  }
  // 目录优先级与 resolveCookieFile 一致：项目目录优先，其次配置的来源目录
  const dirs = [];
  if (projectDir && fs.existsSync(projectDir)) dirs.push(projectDir);
  if (sourceDir && fs.existsSync(sourceDir)) dirs.push(sourceDir);
  if (dirs.length === 0) {
    return { shops: existing, added: [], skipped, scannedDirs };
  }

  // 既有条目（含已删除）的匹配键集合：命中即原样保留
  const known = new Set();
  for (const s of existing) {
    if (!s || typeof s !== 'object') continue;
    for (const k of [s.cookieFile, s.id, s.name]) {
      const key = cookieKey(k);
      if (key) known.add(key);
    }
  }

  const merged = existing.slice(); // 浅拷贝：不改动调用方数组
  const seenBase = new Set();
  const added = [];
  for (const dir of dirs) {
    scannedDirs.push(dir);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      skipped.push({ file: '(readdir)', dir, reason: `目录读取失败: ${e.message}` });
      continue;
    }
    for (const f of files) {
      if (!/\.json$/i.test(f)) continue;
      const base = cookieKey(f);
      if (!base) continue;
      if (seenBase.has(base)) continue; // 同名 Cookie 以高优先级目录为准（与解析顺序一致）
      seenBase.add(base);
      if (known.has(base)) continue; // 既有条目（含已删除）→ 原样保留，绝不复活
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      } catch (e) {
        skipped.push({ file: f, dir, reason: `解析失败: ${e.message}` });
        continue;
      }
      if (!Array.isArray(parsed)) {
        skipped.push({ file: f, dir, reason: '非 Cookie 数组形态，不视为店铺 Cookie' });
        continue;
      }
      merged.push({
        id: base,
        name: base,
        cookieFile: base,
        platform: 'douyin',
        enabled: true,
        autoDiscovered: true,
      });
      added.push(base);
      known.add(base);
    }
  }
  return { shops: merged, added, skipped, scannedDirs };
}

module.exports = { discoverShopsFromCookies, cookieKey, PROJECT_COOKIES_DIR };
