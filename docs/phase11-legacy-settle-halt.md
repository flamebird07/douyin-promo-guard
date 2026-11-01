# legacy 暂停成功映射 — 第一组失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：每组只跑 1 次；失败 → 保存输出并停止，不循环重跑
- 本阶段只改 `_settleFromExecute` 结果映射 + 针对性测试

---

## 1. `all_closed_confirmed` 生成条件与位置

| 项 | 内容 |
|----|------|
| 位置 | `src/engine/close-coordinator.js`（`executeWholeShopCloseBatch` 终态回读段，约 :332–:363） |
| outcome 赋值 | `const outcome = allClosedConfirmed ? 'all_closed_confirmed' : 'partial'`（:363） |
| `allClosedConfirmed = true` **全部**条件 | ① 终态 `listAllAds` 成功；② `listComplete !== false` 且无 `coverageGaps`；③ `counts.failed === 0 && unknown === 0 && skipped === 0`；④ 终态清单 `closable` 与 `unknown` 侧 **均为空** |
| 含义 | 仅当**全量回读确认**无任何仍开启/未知目标才产生；**不是**任意 success/closed 字符串 |

另：`nothing_to_close`（:274）= 清单内 0 个可关目标（已在关闭侧），零 `closeAd`。

---

## 2. 映射修复（本阶段）

| 文件 | 变更 |
|------|------|
| `src/engine/ad-switch-orchestrator.js` `_settleFromExecute` | **pause 专用**识别：`all_closed_confirmed` / `allClosedConfirmed === true`（含 `r` 与 `r.batch`）→ `markConfirmed` + `markSettled(CONFIRMED)`；enable **不**接受该结果码；`allPausedConfirmed`/`allEnabledConfirmed` 改为**按 action 绑定** |
| `test/ad-switch-integration.test.js` | 补：pause+`all_closed_confirmed`→confirmed 释放；enable 用暂停码→unknown 阻塞；partial/任意 closed 字符串→阻塞；旧 actionId 不影响新动作 |

**未知仍阻塞**：`partial` / 非白名单 outcome / 异常 → `markUnknown`，槽位不释放、不补点（测试 `partial / 未知结果…` 与 `enable 不得因暂停成功结果码…` 覆盖）。

---

## 3. 第一组测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 | 输出绝对路径 |
|------|------|------|--------|--------------|
| `node --test test/monitor.test.js test/monitor-chengfang.test.js` | 67 | **66 pass / 1 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase11-group1-test-output.txt` |

**第二组未执行。**

### 失败 1（跨日仍未全绿，但已推进）

- **名称**：`跨日执行：历史已关闭不永久跳过，按最新广告状态决定操作`
- **位置**：`test/monitor.test.js:257`，出错 **`:272`**（phase10 为 `:266`）
- **预期**：`r3.results[0].batch.outcome === 'all_closed_confirmed'`（恢复投放后再次暂停）
- **实际**：`TypeError: … reading 'outcome'`（`batch` undefined）
- **进展**：`r2`（次日 `nothing_to_close`）断言已过 → **`all_closed_confirmed` 映射修复生效**；首日确认释放后，次日盘点可执行

### 跨日三轮（本轮输出 + 代码路径）

| 轮 | 时钟 | 状态 | 决策 | closeAd | batch | 槽位 |
|----|------|------|------|---------|-------|------|
| 1 | 09-12 08:00 | mixed | should_pause | 3 | `all_closed_confirmed` | **释放**（修复后） |
| 2 | 09-13 08:05 | 全 off | already_off+盘点 | **0** | `nothing_to_close`（:266 过） | 见下 |
| 3 | 09-13 后 | 恢复 1 on | should_pause | 期望 1 | **undefined** | 被门挡住 |

**次日 `nothing_to_close` 仍可能未释放槽位（导致第 3 轮无 batch）——本回合定位、未再改：**

`_normalizeExecuteResult` 将未提供的 `allPausedConfirmed` 归一为 **`false`**，而 settle 对 `nothing_to_close` 的条件为  
`… && r.allPausedConfirmed !== false` → **`false !== false` 为假** → 仍走 `markUnknown`。  
（与 phase10 对 `all_closed_confirmed` 同类：结果码与归一布尔不一致。）

建议最小修复（待指令）：`nothing_to_close` / `nothing_to_pause` 仅按**精确 outcome**计已达标，或让 normalize 不把缺失 `allPausedConfirmed` 写成 `false`。

---

## 4. 边界

隔离测试 **不代表** 真实页面、生产加载、07:00 真机验证。

---

## 5. 停止

`all_closed_confirmed` 已映射；跨日第 2 轮 batch 已过；第 3 轮因 `nothing_to_close` 未释放仍败。第一组 66/1，停止。
