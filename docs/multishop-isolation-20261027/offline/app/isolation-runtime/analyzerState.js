'use strict';
const fs = require('fs');
const path = require('path');
const { RunDedup } = require('./runDedup');

/**
 * analyzerState.js — 分析器侧状态文件管理。
 *
 * 修复 Codex 阻断问题 3 & 6 & 7：
 *   3) 加载去重文件只取 productId 未过滤平台和店铺 → 跨店误跳过
 *   6) persistSkipSet 作用域/platform/_loadedCount 问题
 *   7) 拼多多接入 + 公共状态文件隔离不同运行
 *
 * === 运行隔离 ===
 * 状态文件名包含 runId（server 启动时生成的唯一ID），防止不同运行残留互相影响。
 * 单次执行模式（无 runId）不加载状态文件，行为不变。
 *
 * === 平台+店铺过滤 ===
 * 加载时只取 platform|shopName 匹配的键的 productId，避免跨店误跳过。
 * 持久化时写入完整键（platform|shopName|productId）。
 */

/**
 * 分析器侧状态管理器。
 * 在子进程(analyzer)内创建，负责加载/持久化 skipProductIds。
 */
class AnalyzerState {
  /**
   * @param {object} opts
   * @param {string} opts.platform   'douyin' | 'pinduoduo'
   * @param {string} opts.shopName   店铺名
   * @param {string} [opts.runId]    运行ID（server 生成，无则单次模式）
   * @param {string} [opts.workspace] 工作目录
   */
  constructor(opts) {
    this.platform = opts.platform || 'douyin';
    this.shopName = opts.shopName || '';
    this.runId = opts.runId || null;
    this.workspace = opts.workspace || process.cwd();

    // 状态文件名：有 runId 时用运行专属文件，否则不加载（单次模式）
    if (this.runId) {
      this.stateFile = path.join(this.workspace, `run_dedup_${this.runId}.json`);
    } else {
      this.stateFile = null; // 单次模式不使用状态文件
    }

    /** @type {Set<string>} 子进程内已处理商品ID（只有 productId） */
    this.skipProductIds = new Set();
    /** @type {Set<string>} 本轮写入失败的商品ID（用于 RESULT 登记失败身份，反例1） */
    this.failedKeys = new Set();
    /** 启动时从文件加载的数量（用于计算 newCount） */
    this.loadedCount = 0;
    /** AUTO-CONT-1：加载阶段失败时记录原因；此时 persist() 拒绝覆写，防止残缺内存集合覆盖既有键 */
    this.loadError = null;
    /** AUTO-CONT-1：最近一次持久化失败原因（诊断用） */
    this.lastPersistError = null;
  }

  /**
   * 从状态文件加载已处理商品ID（只取当前平台+店铺的）。
   * 修复问题 3：必须过滤平台和店铺，不能只取 productId。
   * AUTO-CONT-1：加载失败不再静默吞错——区分「文件尚不存在(正常首轮)」与
   * 「文件存在但损坏/不可读(错误)」，后者记录 loadError 并返回 {ok:false}，
   * 由 RESULT 上报为可识别失败，且 persist() 拒绝覆写既有文件。
   * @returns {{ok: boolean, error?: string}}
   */
  load() {
    if (!this.stateFile) return { ok: true }; // 单次模式不加载

    try {
      if (!fs.existsSync(this.stateFile)) return { ok: true };
      const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!Array.isArray(saved)) {
        this.loadError = 'state_file_not_array';
        console.log(`[运行级去重] 加载失败: 状态文件内容不是数组（疑似损坏）`);
        return { ok: false, error: this.loadError };
      }

      const prefix = `${this.platform}|${this.shopName}|`;
      let count = 0;
      for (const key of saved) {
        // 只加载当前平台+店铺的键
        if (typeof key === 'string' && key.startsWith(prefix)) {
          const productId = key.substring(prefix.length);
          this.skipProductIds.add(productId);
          count++;
        }
      }
      this.loadedCount = count;
      console.log(`[运行级去重] 从文件加载 ${count} 个已处理商品 [${this.platform}|${this.shopName}]`);
      return { ok: true };
    } catch (e) {
      this.loadError = e.message;
      console.log(`[运行级去重] 加载失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 持久化当前 skipProductIds 到状态文件（合并已有键）。
   * 修复问题 6：platform 正确使用 this.platform，不再依赖外部变量。
   * AUTO-CONT-1：不再吞错——返回 {ok,error}，由分析器 RESULT 上报；
   * 加载阶段失败时拒绝覆写，防止用残缺内存集合覆盖既有键。
   * AUTO-CONT-1补修(缺口四): persist 内部读取/解析既有文件失败同样必须中止并保护原文件
   * （旧实现内层 catch 吞掉解析错误后用空数组继续覆盖，会丢弃其他店铺的键并覆写损坏内容）。
   * @returns {{ok: boolean, error?: string}}
   */
  persist() {
    if (!this.stateFile) return { ok: true }; // 单次模式不持久化
    if (this.loadError) {
      console.log(`[运行级去重] 拒绝持久化（加载阶段已失败，保护既有状态文件）: ${this.loadError}`);
      return { ok: false, error: 'load_error_protect_state_file: ' + this.loadError };
    }

    // 读取既有键：文件不存在=空集合（正常首轮）；存在但读取/解析失败=中止并保护原文件
    let existing = [];
    if (fs.existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (!Array.isArray(parsed)) {
          this.lastPersistError = 'existing_state_not_array';
          console.log('[运行级去重] 持久化中止: 既有状态文件内容不是数组（保护原文件，不覆盖）');
          return { ok: false, error: 'existing_state_not_array' };
        }
        existing = parsed;
      } catch (e) {
        this.lastPersistError = e.message;
        console.log(`[运行级去重] 持久化中止: 既有状态文件读取/解析失败（保护原文件，不覆盖）: ${e.message}`);
        return { ok: false, error: 'existing_state_read_failed: ' + e.message };
      }
    }

    try {
      // 构建当前店铺的新键
      const prefix = `${this.platform}|${this.shopName}|`;
      const currentKeys = Array.from(this.skipProductIds).map(pid => `${prefix}${pid}`);

      // 合并：先去掉当前店铺的旧键，再添加新键（覆盖当前店铺的部分；其他店铺键保留）
      const others = existing.filter(k =>
        typeof k === 'string' && !k.startsWith(prefix)
      );
      const merged = [...others, ...currentKeys];

      fs.writeFileSync(this.stateFile, JSON.stringify(merged), 'utf8');
      return { ok: true };
    } catch (e) {
      this.lastPersistError = e.message;
      console.log(`[运行级去重] 持久化失败: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 标记一个商品为已处理（加入 skipProductIds、从 failedKeys 移除并持久化）。
   * @param {string|number} productId
   * @returns {{ok: boolean, error?: string}} persist 结果
   */
  markProcessed(productId) {
    const pid = String(productId);
    this.skipProductIds.add(pid);
    this.failedKeys.delete(pid); // 成功后清除失败身份
    return this.persist();
  }

  /**
   * 标记一个商品为处理失败（从 skipProductIds 移除、加入 failedKeys 并持久化）。
   * 失败身份仅通过 RESULT 的 failedKeys 上报，不持久化到状态文件（失败不入成功集）。
   * @param {string|number} productId
   * @returns {{ok: boolean, error?: string}} persist 结果
   */
  markFailed(productId) {
    const pid = String(productId);
    this.skipProductIds.delete(pid);
    this.failedKeys.add(pid);
    return this.persist();
  }

  /** 是否已处理 */
  has(productId) {
    return this.skipProductIds.has(String(productId));
  }

  /**
   * 计算本轮新增数量（相对于加载时的基数）。
   * 修复问题 1 & 6：用 loadedCount 正确计算。
   */
  newCount() {
    return Math.max(0, this.skipProductIds.size - this.loadedCount);
  }
}

module.exports = { AnalyzerState };
