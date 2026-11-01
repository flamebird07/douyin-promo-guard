# zeroClick 字段透传 — 验证汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：两组各跑 1 次；第二组失败 → 保存输出并停止，不循环重跑

---

## 1. 修改位置

| 文件 | 变更 |
|------|------|
| `src/engine/monitor.js` `_runShopSwitchAction` | **仅** zeroClick 分支：透传编排器已有的 `serial` / `outcome` / `batch` / `dispatched`（保留 `actionId`/`reason`/`decision`）；**未**在 Monitor 硬编码 `serial:'not_sent'` |

未改：`dispatchedCount`、串行门释放、执行器、测试断言。

---

## 2. 根因核实

与 `docs/phase13-zeroclick-halt.md` 一致：settle 已返回 `serial`，zeroClick 早退丢字段。  
两用例在第一组（修复后）中 **已通过**（含 `serial==='not_sent'`）。

### 两用例返回与底层（第一组通过时）

| 用例 | zeroClick | serial | 底层开关 | actions |
|------|-----------|--------|----------|---------|
| 高于阈值 + 回读 off | true | `not_sent`（透传） | 0 | 0 |
| dryRun/realMode neverSent | true | `not_sent`（透传） | 0 | 0 |

---

## 3. 测试结果

| 组 | 命令 | 数量 | 结果 | 退出码 | 输出绝对路径 |
|----|------|------|------|--------|--------------|
| 1 | `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js test/rules-guard.test.js test/close-flow.test.js test/coordinator.test.js test/chengfang-executor.test.js` | — | **全绿** | **0** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase14-group1-test-output.txt` |
| 2 | `node --test test/monitor.test.js test/monitor-chengfang.test.js` | 67 | **57 pass / 10 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase14-group2-test-output.txt` |

### 第二组失败 10 条（节选根因，未再改）

多条为 **zeroClick/never_sent 路径仍缺 `dryRun`/`chengfang`/trigger 侧字段**（例：`演练模式 realMode=false` 期望 `dryRun===true` 得 `undefined`）。与本次「只透传 serial」同属返回形状不完整；**本阶段范围外**，已按约定停止。

---

## 4. 边界

隔离测试 **不代表** 真实页面、生产加载、07:00 真机验证。

完成后停止。
