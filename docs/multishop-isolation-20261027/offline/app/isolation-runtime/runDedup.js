'use strict';
/**
 * runDedup.js — 运行级去重：同一次自动化运行中成功处理的商品不得因跨日再次进入。
 *
 * 身份键 = platform|shopName|productId。
 *   - 不同店铺相同商品ID 不去重（各自独立处理）。
 *   - 只有成功处理的商品入集（checkRecentRecord 跳过 或 飞书写入成功）。
 *   - 写入失败的商品不入集，可重试。
 *
 * === 数据流（修复 Codex 阻断问题 1）===
 * 真实数据流是父子进程分离的：
 *   1) server 轮前：dedup.exportKeys() → 写文件 → 子进程加载
 *   2) 子进程：加载已有键 + 本轮新增已处理 → 写回文件
 *   3) server 轮后：读取文件 → dedup.importAndCount(savedKeys) → 返回本轮新增数
 *
 * 旧的 _roundNew/finishRound 机制在 importKeys 后不更新 _roundNew，导致
 * finishRound 永远返回 0。改用 snapshot/importAndCount：server 在轮前
 * 记录 size，轮后 importAndCount 返回实际新增数，不依赖 _roundNew。
 */

class RunDedup {
  constructor() {
    /** @type {Set<string>} 成功处理的商品键 */
    this._processed = new Set();
  }

  /**
   * 构造去重键。
   * @param {string} platform  'douyin' | 'pinduoduo'
   * @param {string} shopName  店铺名
   * @param {string|number} productId  商品ID
   */
  static key(platform, shopName, productId) {
    return `${platform || 'douyin'}|${shopName || ''}|${String(productId)}`;
  }

  /** 从键中解析 [platform, shopName, productId] */
  static parseKey(key) {
    const parts = String(key).split('|');
    if (parts.length < 3) return null;
    // productId 可能含 |？不太可能，但取最后一段为 productId，其余合并
    const productId = parts[parts.length - 1];
    const shopName = parts.slice(1, -1).join('|');
    const platform = parts[0];
    return [platform, shopName, productId];
  }

  /** 是否已处理 */
  has(platform, shopName, productId) {
    return this._processed.has(RunDedup.key(platform, shopName, productId));
  }

  /**
   * 标记一个商品为已成功处理。
   * @returns {boolean} true=首次处理(新进展), false=之前已处理(重复)
   */
  markProcessed(platform, shopName, productId) {
    const k = RunDedup.key(platform, shopName, productId);
    if (this._processed.has(k)) return false;
    this._processed.add(k);
    return true;
  }

  /**
   * 标记一个商品为处理失败 —— 不入成功集合，可后续重试。
   * 如果之前误加入，移除它。
   */
  markFailed(platform, shopName, productId) {
    const k = RunDedup.key(platform, shopName, productId);
    this._processed.delete(k);
  }

  /** 当前已处理总数 */
  size() {
    return this._processed.size;
  }

  /** 返回当前已处理键的快照（用于轮前对比） */
  snapshot() {
    return new Set(this._processed);
  }

  /**
   * 合并子进程写回的键，返回本轮实际新增数。
   * 这是 server 轮后计算 newCount 的正确方式：
   *   const before = dedup.size();
   *   // ... 写文件、子进程运行、读回文件 ...
   *   const newCount = dedup.importAndCount(savedKeys);
   *
   * @param {string[]} keys  子进程写回的全部已处理键
   * @returns {number}  本次合并实际新增的键数
   */
  importAndCount(keys) {
    if (!Array.isArray(keys)) return 0;
    let added = 0;
    for (const k of keys) {
      if (!this._processed.has(k)) {
        this._processed.add(k);
        added++;
      }
    }
    return added;
  }

  /**
   * 旧接口保留兼容：importKeys 只合并不返回计数。
   * 新代码应使用 importAndCount。
   */
  importKeys(keys) {
    this.importAndCount(keys);
  }

  /** 导出已处理键数组（供写入文件供子进程加载） */
  exportKeys() {
    return Array.from(this._processed);
  }

  /**
   * 导出指定平台+店铺的键（供子进程只加载当前店铺的去重集）。
   * 修复 Codex 阻断问题 3：加载时必须过滤平台和店铺。
   */
  exportKeysFor(platform, shopName) {
    const prefix = `${platform || 'douyin'}|${shopName || ''}|`;
    const result = [];
    for (const k of this._processed) {
      if (k.startsWith(prefix)) {
        result.push(k.substring(prefix.length));
      }
    }
    return result;
  }

  /** 重置 */
  clear() {
    this._processed.clear();
  }
}

module.exports = { RunDedup };
