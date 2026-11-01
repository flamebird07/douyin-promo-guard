# 两条回归修复 — 第一组失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：第一组失败 → 保存输出、**停止**；不跑第二组、不循环重跑
- 边界：不提交、不推送、不改生产配置、不启停服务、不连广告/飞书

---

## 1. 修改文件（本阶段）

| 文件 | 针对 | 变更 |
|------|------|------|
| `src/engine/monitor.js` | F1 | `_runShopEnablePhase`：`blocked*` 时写入 `recentErrors`（门槛原因含「开启」）；不进 actions、相位=`failed` |
| `src/engine/monitor.js` | F2 | `_pollShop`：超标 + `already_off` → 暂停只读盘点（`allowAlreadyOffPause`） |
| `src/engine/ad-switch-orchestrator.js` | F2 | `allowAlreadyOffPause`：pause + already_off 可进入执行器；`nothing_to_close` 视为已达标 |
| `test/` | — | 未改原断言 |

---

## 2. 根因与证据

### F1 enableEnabled=false → recentErrors（**已修复**）

| 项 | 内容 |
|----|------|
| 根因 | 开启被 `resolveChengfangEnableAllowed` 拒绝时只 `_setEnablePhase(failed)`，**未**按原接口写入 `recentErrors` |
| 证据 | phase9 输出：断言 `recentErrors.some(/开启/)` 为 false；门槛 reason 含「enableEnabled 未开启…」 |
| 修复行为 | `blocked/blocked_window/blocked_stopped` 一次写入 `recentErrors`；底层 session/execute=0；不标 success、不进 actions |
| 本组结果 | 用例 **已通过**（见输出） |

### F2 跨日 `batch` 为 undefined（**未闭环**）

| 项 | 内容 |
|----|------|
| 表象 | `monitor.test.js:266` 读 `r2.results[0].batch.outcome` → TypeError，`batch` undefined |
| 已做 | 超标+already_off 进入 legacy 盘点，目标返回真实 `nothing_to_close`（0 次 closeAd）；`nothing_to_close` 已计入 settle「已达标」 |
| **仍失败根因（本回合定位，未再改）** | 首日 legacy 成功 outcome 为 **`all_closed_confirmed` / `allClosedConfirmed`**，`_settleFromExecute` 的 confirmed 判断只认 `all_paused_confirmed` / `allPausedConfirmed` / `nothing_to_pause`（及刚加的 `nothing_to_close`）→ 首日 settle 走 **`markUnknown`** → 串行门阻塞 → **次日** `blocked:'serial_gate'` 返回**无 batch** → TypeError |
| 旁证 | 「真实模式 08:00」首日 `batch.outcome=all_closed_confirmed` **通过**（execute 仍有 batch）；跨日首日 closeCalls=3 断言在 TypeError **之前**（:261）可通过 |
| 性质 | **实现缺陷（settle 语义未覆盖 legacy 结果名）**，不是 fixture 未恢复投放；次日 `_testSetStatus` 装配正确 |
| 建议最小修复（待指令） | `_settleFromExecute`：confirmed 增加 `allClosedConfirmed===true` / `outcome==='all_closed_confirmed'` / `nothing_to_close`（已加）→ 释放门；次日盘点得 `nothing_to_close` |

跨日两轮实测（据代码路径 + 输出）：

| 轮 | 时钟 | 广告状态 | 决策 | closeAd | batch |
|----|------|----------|------|---------|-------|
| 1 | 09-12 08:00 | mixed 3 on+1 off | should_pause | **3** | `all_closed_confirmed`（返回有 batch） |
| 2 | 09-13 08:05 | 全 off | already_off + 盘点意图 | **0** | **undefined**（门阻塞，未到盘点） |
| 3 | （用例后续） | 恢复 1 条 on | 期望 should_pause | 期望 +1 | 期望 `all_closed_confirmed` |

---

## 3. 第一组测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 | 完整输出绝对路径 |
|------|------|------|--------|------------------|
| `node --test test/monitor.test.js test/monitor-chengfang.test.js` | 67 | **66 pass / 1 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase10-group1-test-output.txt` |

**第二组未执行。**

### 失败 1

- **名称**：`跨日执行：历史已关闭不永久跳过，按最新广告状态决定操作`
- **预期**：`r2.results[0].batch.outcome === 'nothing_to_close'`
- **实际**：`TypeError: Cannot read properties of undefined (reading 'outcome')`（`batch` undefined）
- **位置**：`test/monitor.test.js:257` / `:266`

---

## 4. 边界

隔离测试 **不代表** 真实页面、生产加载、07:00 真机验证。

---

## 5. 停止

F1 已绿；F2 根因已定位（legacy `all_closed_confirmed` 未释放串行门）。第一组 66/1，按约定停止。
