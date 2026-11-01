# zeroClick / not_sent 证据 — 第一组失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：第一组失败 → 保存输出并停止；不跑第二组、不循环重跑

---

## 1. 修改位置

| 文件 | 变更 |
|------|------|
| `test/ad-switch-integration.test.js` | `高于阈值+off`：盘点 mock 返回 `nothing_to_close`，断言 `zeroClick:true`、底层 0、`actions===0` |
| `test/ad-switch-integration.test.js` | 补：发出前取消可释放；发出后取消/未确认不释放；部分完成中止非 zeroClick；盘点 0 动作证据 |
| `src/engine/ad-switch-orchestrator.js`（前序） | `dispatchedCount`；`not_sent` 须 0 已发出；settle `zeroClick:true` |
| `src/engine/monitor.js`（前序） | 盘点/门槛结果不进 actions |

---

## 2. 结果生成证据（盘点 / 动作 / 回读 / 审计）

| 结果 | 生成位置 | 证据 | 分类 |
|------|----------|------|------|
| `nothing_to_close` | close-coordinator.js :274 | 完整 listAllAds 后、close 循环前；dispatched=0 | 盘点无动作 → not_sent |
| `cancelled` | close-coordinator :218 / chengfang-runner :345 | close/click 前；dispatched=0 | not_sent |
| `blocked*` / `dry*` | 门槛/演练（动作循环前） | 无开关调用 | not_sent |
| 名称 not_sent 但 counts 已发出>0 | — | dispatchedCount>0 | **unknown** 不释放 |
| `partial` / 部分完成中止 | 执行循环内 | 有 confirmed/unknown | **unknown**，zeroClick **false** |
| `all_closed_confirmed` 等 | 终态回读 | 回读确认 | confirmed |

盘点 ≠ 动作发出 ≠ 回读确认；actions 只记已执行批次。

---

## 3. 第一组测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 | 输出绝对路径 |
|------|------|------|--------|--------------|
| `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js test/rules-guard.test.js test/close-flow.test.js test/coordinator.test.js test/chengfang-executor.test.js` | 201 | **199 pass / 2 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase13-group1-test-output.txt` |

**第二组未执行。**

### 失败 2 条（同一根因）

1. `主链路集成：高于阈值 + 回读 off → 零点击` — 期望 `serial==='not_sent'`，实际 `undefined`
2. `主链路集成：dryRun/realMode 门禁——execute 返回 neverSent 时串行门释放且不计成功` — 同上

**根因（实现缺陷·返回映射）**：settle 已返回 `serial:'not_sent'` + `zeroClick:true`，但 `monitor.js` `_runShopSwitchAction` 的 `if (settled.zeroClick)` **早退分支**只输出 `{status,zeroClick,decision,reason}`，丢掉 `serial`/`outcome`/`batch`/`dispatched`。

**建议最小修复（本回合未再改、未重跑）**：zeroClick 分支合并输出上述字段。

---

## 4. 边界

隔离测试 **不代表** 真实页面、生产加载、07:00 真机验证。

完成后停止。
