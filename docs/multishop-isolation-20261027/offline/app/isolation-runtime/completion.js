'use strict';
/**
 * completion.js — 自动化完成判定状态机（第3版，修复 Codex 二次复核反例 1/2/3）。
 *
 * === 反例修复 ===
 * 1) 未确认耗尽(hitZeroOrder=false)绝不能凭 writeCount<target 判成功。
 *    → writeCount<target 且未耗尽时继续观察（RUNNING），不足目标不再 NORMAL_COMPLETE。
 * 2) 明确耗尽(hitZeroOrder=true)且无待解决失败，即使零写入也应正常结束。
 *    → hitZeroOrder 判断移到 writeCount===0 之前。
 * 3) consecutiveFailures 只是重试轮次计数，不是未解决失败清单。
 *    → 新增 pendingRetries（按商品身份 key 集合）：failedKeys 加入、successKeys 清除，
 *      仅在该商品实际成功后清除。列表耗尽时若仍有待重试 → INCOMPLETE。
 *
 * === AUTO-CONT-1（2026-10-04，纠正 SD1 的关机口径）===
 * 客户实测（runId=prodmusgfw9o896b）：分析器状态从未持久化 → 父调度器轮轮 newCount=0
 * → 第2轮即 NO_PROGRESS 提前停止（20个商品），证明“无进展停止”可能是假无进展。
 * 纠正两点：
 *   1) 新增 exhausted（可靠耗尽证据：分析器走完整份列表、确认末页、无失败、无未处理遗留）
 *      作为 NORMAL_COMPLETE 的第二条通路，与 hitZeroOrder（0单页）并列；
 *      unprocessedLeft>0（数据异常排除等未处理遗留）时耗尽判定必须降级 INCOMPLETE。
 *   2) NO_PROGRESS 不再具备关机资格（原 SD1 口径取消）：无进展不证明商品耗尽。
 *      关机资格唯一来源 = NORMAL_COMPLETE（见 prodAutoScheduler 的关机判定）。
 *      NO_PROGRESS 仍是正常停止终态：isSuccess() 保持 false，业务口径不变。
 *
 * 完成状态：
 *   RUNNING          继续下一轮
 *   NORMAL_COMPLETE  可靠列表耗尽（hitZeroOrder 或 exhausted）且无待解决失败、无未处理遗留
 *   NO_PROGRESS       连续 N 轮零新进展（不证明耗尽，isSuccess=false，不再触发关机）
 *   FAILED            连续失败达上限
 *   CANCELLED         用户手动停止
 *   INCOMPLETE        安全上限 或 列表耗尽但有待重试商品/未处理遗留未解决
 *
 * === SD1 修复（历史记录）===
 * SD1 曾把“关机资格与业务成功分离”，允许 NO_PROGRESS 关机；AUTO-CONT-1 已纠正——
 * 进入 NO_PROGRESS 的分支仍要求本轮 allSuccess=true 且无待重试商品（失败/待重试
 * 分支先行拦截），但它不证明商品耗尽，因此不再作为关机资格。
 */

const STATE = {
  RUNNING: 'RUNNING',
  NORMAL_COMPLETE: 'NORMAL_COMPLETE',
  NO_PROGRESS: 'NO_PROGRESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  INCOMPLETE: 'INCOMPLETE',
};

const DEFAULTS = {
  maxRounds: 50,
  maxNoProgressRounds: 2,
  maxRetries: 3,
  targetCount: 10,
};

class ShopTracker {
  constructor(opts = {}) {
    this.targetCount = opts.targetCount || DEFAULTS.targetCount;
    this.maxRounds = opts.maxRounds || DEFAULTS.maxRounds;
    this.maxNoProgressRounds = opts.maxNoProgressRounds || DEFAULTS.maxNoProgressRounds;
    this.maxRetries = opts.maxRetries || DEFAULTS.maxRetries;

    this.round = 0;
    this.consecutiveFailures = 0;
    this.consecutiveNoProgress = 0;
    this.totalWritten = 0;
    this.totalNew = 0;
    /** 待重试商品集合（按商品身份 key）。仅在该商品实际成功后清除。 */
    this.pendingRetries = new Set();
    this.state = STATE.RUNNING;
    this.stopReason = '';
  }

  /**
   * 处理一轮结果。
   * @param {object} r
   * @param {number} r.writeCount      本轮成功写入数
   * @param {number} r.newCount        本轮新增去重商品数
   * @param {boolean} r.hitZeroOrder   是否明确到达列表末尾(0单商品)
   * @param {boolean} [r.exhausted]    AUTO-CONT-1：可靠耗尽证据（走完整份列表确认末页且无遗留）
   * @param {number} [r.unprocessedLeft] AUTO-CONT-1：本轮见到但未处理、未登记失败的商品数（数据异常排除等）
   * @param {boolean} r.allSuccess      本轮所有写入是否全部成功
   * @param {string[]} [r.successKeys]  本轮成功处理(写入/跳过)的商品键 —— 清除待重试
   * @param {string[]} [r.failedKeys]   本轮写入失败的商品键 —— 加入待重试
   * @param {boolean} r.cancelled
   * @returns {{state:string, stop:boolean, reason:string}}
   */
  applyRound(r) {
    if (this.state !== STATE.RUNNING) {
      return { state: this.state, stop: true, reason: this.stopReason };
    }

    // 取消优先级最高
    if (r.cancelled) {
      this.state = STATE.CANCELLED;
      this.stopReason = '用户手动停止';
      return { state: this.state, stop: true, reason: this.stopReason };
    }

    this.round++;
    this.totalWritten += (r.writeCount || 0);
    this.totalNew += (r.newCount || 0);

    // === 更新待重试清单（按商品身份） ===
    if (Array.isArray(r.failedKeys)) {
      for (const k of r.failedKeys) this.pendingRetries.add(String(k));
    }
    if (Array.isArray(r.successKeys)) {
      for (const k of r.successKeys) this.pendingRetries.delete(String(k));
    }

    // === 0. 安全上限：统一约束所有继续执行分支（反例2修复） ===
    // 在所有 continue 分支之前检查，防止不足目标/交错失败等分支绕过 maxRounds。
    // 但不抢占明确耗尽/取消/失败终态的判定（那些在下面）。
    // 注意：如果本轮确认耗尽(hitZeroOrder)且有待重试，仍应 INCOMPLETE（下方处理）。

    // === 1. 可靠列表耗尽（判断最优先，但不能覆盖失败证据——反例5修复） ===
    // AUTO-CONT-1：hitZeroOrder（0单页）或 exhausted（走完整份列表确认末页）都是耗尽证据；
    // 但存在待重试、本轮失败/状态不一致、或 unprocessedLeft>0（未处理遗留）时必须 INCOMPLETE。
    if (r.hitZeroOrder === true || r.exhausted === true) {
      const leftUnprocessed = r.unprocessedLeft || 0;
      if (this.pendingRetries.size > 0 || r.allSuccess === false || leftUnprocessed > 0) {
        const why = [];
        if (this.pendingRetries.size > 0) why.push(`${this.pendingRetries.size}个待重试商品`);
        if (r.allSuccess === false) why.push('本轮存在失败或状态不一致');
        if (leftUnprocessed > 0) why.push(`${leftUnprocessed}个商品未处理（数据异常等遗留）`);
        this.state = STATE.INCOMPLETE;
        this.stopReason = `列表耗尽但存在未解决项（${why.join('；')}），报告未完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      this.state = STATE.NORMAL_COMPLETE;
      this.stopReason = r.hitZeroOrder
        ? `已无新商品（销量为0），共${this.round}轮`
        : `列表已走完且无未处理商品，共${this.round}轮`;
      return { state: this.state, stop: true, reason: this.stopReason };
    }

    // === 2. 有待解决失败（本轮失败或历史未解决）→ 不能判成功 ===
    if (!r.allSuccess || this.pendingRetries.size > 0) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxRetries) {
        this.state = STATE.FAILED;
        this.stopReason = `连续${this.consecutiveFailures}轮存在失败（${this.pendingRetries.size}个待重试商品），标记为完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      // 统一 maxRounds 约束（反例2修复）：即使重试未达上限，轮数到也必须 INCOMPLETE
      if (this.round >= this.maxRounds) {
        this.state = STATE.INCOMPLETE;
        this.stopReason = `已达安全上限${this.maxRounds}轮且仍有${this.pendingRetries.size}个待重试商品，报告未完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      return {
        state: STATE.RUNNING, stop: false,
        reason: `存在${this.pendingRetries.size}个待重试商品，重试 ${this.consecutiveFailures}/${this.maxRetries}`,
      };
    }

    // 到这里：allSuccess=true 且 pendingRetries 为空

    // === 3. 零写入（未耗尽）===
    if (r.writeCount === 0) {
      // 3a) 反例3（五次复核）：全部命中运行级去重 = 成功读取但无新工作，不是失败。
      //     判据：本轮有成功处理(跳过)记录 + 无失败 → 计入零新进展。
      if (r.allSuccess === true
          && this.pendingRetries.size === 0
          && Array.isArray(r.successKeys) && r.successKeys.length > 0) {
        this.consecutiveNoProgress++;
        if (this.consecutiveNoProgress >= this.maxNoProgressRounds) {
          this.state = STATE.NO_PROGRESS;
          this.stopReason = `全部商品已处理（${r.successKeys.length}个跳过），连续${this.consecutiveNoProgress}轮零新进展，停止`;
          return { state: this.state, stop: true, reason: this.stopReason };
        }
        return {
          state: STATE.RUNNING, stop: false,
          reason: `全部已处理（${r.successKeys.length}个跳过），零新进展 ${this.consecutiveNoProgress}/${this.maxNoProgressRounds}`,
        };
      }
      // 3b) 真零写入 → 失败重试
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.maxRetries) {
        this.state = STATE.FAILED;
        this.stopReason = `连续${this.consecutiveFailures}轮零写入，标记为完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      // 统一 maxRounds 约束
      if (this.round >= this.maxRounds) {
        this.state = STATE.INCOMPLETE;
        this.stopReason = `已达安全上限${this.maxRounds}轮且连续零写入，报告未完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      return {
        state: STATE.RUNNING, stop: false,
        reason: `零写入重试 ${this.consecutiveFailures}/${this.maxRetries}`,
      };
    }

    // === 4. 不足目标且未确认耗尽 → 不能判成功 ===
    if (r.writeCount < this.targetCount) {
      if ((r.newCount || 0) === 0) {
        this.consecutiveNoProgress++;
        if (this.consecutiveNoProgress >= this.maxNoProgressRounds) {
          this.state = STATE.NO_PROGRESS;
          this.stopReason = `写入${r.writeCount}/${this.targetCount}不足且连续${this.consecutiveNoProgress}轮零新进展`;
          return { state: this.state, stop: true, reason: this.stopReason };
        }
        // 统一 maxRounds 约束
        if (this.round >= this.maxRounds) {
          this.state = STATE.INCOMPLETE;
          this.stopReason = `已达安全上限${this.maxRounds}轮且写入不足，报告未完成`;
          return { state: this.state, stop: true, reason: this.stopReason };
        }
        return {
          state: STATE.RUNNING, stop: false,
          reason: `写入${r.writeCount}/${this.targetCount}不足且零进展 ${this.consecutiveNoProgress}/${this.maxNoProgressRounds}`,
        };
      }
      // 有新进展但不足目标，未确认耗尽 → 继续观察（可能还有更多页）
      // 统一 maxRounds 约束
      if (this.round >= this.maxRounds) {
        this.state = STATE.INCOMPLETE;
        this.stopReason = `已达安全上限${this.maxRounds}轮且写入不足目标，报告未完成`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      this.consecutiveNoProgress = 0;
      this.consecutiveFailures = 0;
      return {
        state: STATE.RUNNING, stop: false,
        reason: `写入${r.writeCount}/${this.targetCount}不足但新增${r.newCount}，未确认耗尽，继续`,
      };
    }

    // 到这里：writeCount >= target 且 allSuccess 且无待重试

    // === 5. 安全上限 ===
    if (this.round >= this.maxRounds) {
      this.state = STATE.INCOMPLETE;
      this.stopReason = `已达安全上限${this.maxRounds}轮，报告未完成`;
      return { state: this.state, stop: true, reason: this.stopReason };
    }

    // === 6. 零新进展（写满但全是跨日重复） ===
    if ((r.newCount || 0) === 0) {
      this.consecutiveNoProgress++;
      if (this.consecutiveNoProgress >= this.maxNoProgressRounds) {
        this.state = STATE.NO_PROGRESS;
        this.stopReason = `连续${this.consecutiveNoProgress}轮零新进展（均为跨日重复），停止`;
        return { state: this.state, stop: true, reason: this.stopReason };
      }
      return {
        state: STATE.RUNNING, stop: false,
        reason: `零新进展 ${this.consecutiveNoProgress}/${this.maxNoProgressRounds}，继续观察`,
      };
    }

    // === 7. 有新进展 + 写满目标 → 继续 ===
    this.consecutiveNoProgress = 0;
    this.consecutiveFailures = 0;
    return {
      state: STATE.RUNNING, stop: false,
      reason: `新增${r.newCount}条，继续下一轮`,
    };
  }

  /**
   * 处理子进程启动失败/异常（无商品身份信息）。
   */
  applyFailure(r = {}) {
    if (this.state !== STATE.RUNNING) {
      return { state: this.state, stop: true, reason: this.stopReason };
    }
    this.round++;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxRetries) {
      this.state = STATE.FAILED;
      this.stopReason = `连续失败${this.consecutiveFailures}次（${r.message || '启动失败'}），标记为完成`;
      return { state: this.state, stop: true, reason: this.stopReason };
    }
    return {
      state: STATE.RUNNING, stop: false,
      reason: `失败重试 ${this.consecutiveFailures}/${this.maxRetries}`,
    };
  }

  cancel() {
    if (this.state === STATE.RUNNING) {
      this.state = STATE.CANCELLED;
      this.stopReason = '用户手动停止';
    }
    return { state: this.state, stop: true, reason: this.stopReason };
  }

  isDone() {
    return this.state !== STATE.RUNNING;
  }

  /**
   * 是否为成功完成（业务口径）。
   * 只有 NORMAL_COMPLETE（明确耗尽且无待解决失败）才算成功。
   * NO_PROGRESS/INCOMPLETE/FAILED/CANCELLED 均不是成功。
   */
  isSuccess() {
    return this.state === STATE.NORMAL_COMPLETE;
  }

  /**
   * 是否为“连续无新进展的正常停止”。
   * AUTO-CONT-1 起仅表达停止方式：无进展不证明商品耗尽（客户实测 20 商品即假无进展停机），
   * 因此不再作为自动关机资格（见 prodAutoScheduler 关机判定）；业务成功口径不变
   * （isSuccess() 仍为 false）。
   */
  isNormalNoProgress() {
    return this.state === STATE.NO_PROGRESS;
  }
}

module.exports = { STATE, ShopTracker, DEFAULTS };
