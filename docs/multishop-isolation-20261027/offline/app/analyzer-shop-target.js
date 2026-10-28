'use strict';

/**
 * MULTISHOP-ISOLATION-20261027 D16：分析器店铺目标（每次调用冻结）。
 *
 * 背景：server 的 /run-douyin-analyzer 与 /run-douyin-multi 各有独立运行标志，
 * 可同时存活；两者都写同一个 current_shop.txt 再 spawn 子进程。子进程启动稍慢时
 * 会读到另一任务后写入的店名，从而加载别的店铺 Cookie（跨店串号）。
 *
 * 这里只做两件事：
 *  1) buildAnalyzerLaunchEnv：在 spawn 时把本次任务的店名放进子进程 env（新对象，
 *     不改 process.env）。显式店名（包括空串）总是覆盖父环境里的同名继承值；
 *     仅当调用方未提供（undefined）时才保留父环境值。
 *  2) resolveAnalyzerShopTarget：子进程只认显式 env；显式存在（含空串）绝不回读
 *     共享 current_shop.txt。只有变量完全缺失（例如直接 CLI 启动）才回退旧文件，
 *     保持既有直连调用兼容。
 *
 * 店铺名不做 trim/修复/模糊匹配：显式值原样保留（Unicode 精确店名不变）。
 */

const fs = require('fs');
const path = require('path');

const ANALYZER_SHOP_ENV = 'ANALYZER_SHOP_NAME';

/**
 * 构造一次 spawn 的 env。永远返回新对象，绝不修改 parentEnv / process.env。
 * @param {object} parentEnv 父进程 env（通常是 process.env）
 * @param {string|undefined} jobShopName 本次任务店铺名；undefined 表示“未提供”
 * @returns {object}
 */
function buildAnalyzerLaunchEnv(parentEnv, jobShopName) {
  const env = { ...(parentEnv || {}) };
  if (jobShopName !== undefined) {
    // 显式存在（含空串）即冻结；不在这里做 trim/repair/类型以外的转换。
    env[ANALYZER_SHOP_ENV] = typeof jobShopName === 'string'
      ? jobShopName
      : String(jobShopName == null ? '' : jobShopName);
  }
  return env;
}

/**
 * 解析本进程应使用的店铺名。
 * - env 中显式存在 ANALYZER_SHOP_NAME（own property，含 ''）→ 直接使用，不读任何文件；
 * - 变量完全缺失 → 回退 current_shop.txt（旧 CLI 兼容）。
 * @param {object} [options]
 * @param {object} [options.env] 环境对象，默认 process.env
 * @param {string} [options.envKey] 覆盖变量名（测试用）
 * @param {string} [options.legacyShopFile] 旧临时文件路径
 * @param {Function} [options.readFile] 注入读文件（测试用）
 * @param {Function} [options.exists] 注入存在判断（测试用）
 * @returns {{shopName: string, source: string, legacyShopFile?: string, error?: string}}
 */
function resolveAnalyzerShopTarget(options = {}) {
  const env = options.env || process.env;
  const envKey = options.envKey || ANALYZER_SHOP_ENV;

  if (Object.prototype.hasOwnProperty.call(env, envKey)) {
    const raw = env[envKey];
    // 显式存在即权威：空串表示“本次任务无店铺目标”，绝不回退到别的任务写下的文件。
    return { shopName: raw == null ? '' : String(raw), source: 'explicit-env' };
  }

  const legacyShopFile = options.legacyShopFile
    || path.join(__dirname, 'current_shop.txt');
  const readFile = options.readFile || fs.readFileSync;
  const exists = options.exists || fs.existsSync;
  try {
    if (exists(legacyShopFile)) {
      const raw = readFile(legacyShopFile, 'utf8');
      return {
        shopName: raw == null ? '' : String(raw).trim(),
        source: 'legacy-file',
        legacyShopFile,
      };
    }
  } catch (error) {
    return {
      shopName: '',
      source: 'legacy-file-error',
      legacyShopFile,
      error: error && error.message ? error.message : String(error),
    };
  }
  return { shopName: '', source: 'none', legacyShopFile };
}

module.exports = {
  ANALYZER_SHOP_ENV,
  buildAnalyzerLaunchEnv,
  resolveAnalyzerShopTarget,
};
