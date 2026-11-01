# 统一执行结果契约映射 — 验证汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：两组各跑 **1 次**；失败保存输出并停止，不循环重跑
- 本阶段：统一 `classifyExecuteResult` + normalize 不把缺失布尔写成 false + 契约/三轮测试

---

## 1. 结果契约表（代码位置 · 语义）

| outcome / 标志 | 生成位置 | 动作 | ①已执行且回读确认 | ②未发出且无需执行 | ③可能已发出未确认 | settle |
|----------------|----------|------|-------------------|-------------------|-------------------|--------|
| `all_closed_confirmed` | `close-coordinator.js` :363（终态清单 complete + 0 closable/unknown + counts 全 0 约束） | **仅 pause** | 是 | — | — | `confirmed` 释放 |
| `all_paused_confirmed` | `chengfang-runner.js` :502（`allPausedConfirmed===true`） | **仅 pause** | 是 | — | — | `confirmed` |
| `all_enabled_confirmed` | `chengfang-runner.js` :557 | **仅 enable** | 是 | — | — | `confirmed` |
| `nothing_to_close` | `close-coordinator.js` :274（**完整 listAllAds 后** targets=0，**close 循环前**，counts 全 0） | pause | — | **是**（未发出） | — | `not_sent` 释放（**不**冒充成功） |
| `nothing_to_pause` | `chengfang-runner.js` :495（视图回读 targets=0 且 `allPausedConfirmed`） | pause | — | **是** | — | `not_sent` |
| `nothing_to_enable` | `chengfang-runner.js` :550 | enable | — | **是** | — | `not_sent` |
| `blocked` / `blocked_window` / `blocked_stopped` / `blocked_coverage` | runner/coordinator 门槛与覆盖检查（**close/click 循环前**） | any | — | **是** | — | `not_sent` |
| `cancelled` | 操作前重核不超标 | any | — | **是** | — | `not_sent` |
| `dry` / `dry_failed` / `dryRun:true` | runner 演练 | any | — | **是** | — | `not_sent` |
| `partial` | 执行后未全部确认 | any | — | — | **是** | `unknown` 阻塞 |
| 其它/缺失/异常 | — | any | — | — | **是** | `unknown` 阻塞 |
| 任意含 `closed` 的字符串 | — | — | **否** | — | — | `unknown`（禁止模糊匹配） |
| pause 码用于 enable | — | enable | **否** | — | — | `unknown` |

**`nothing_to_close` 核对**：完整分页清单 + 身份/日期/时效后，在逐个 `closeOneAd` **之前**返回；`alreadyClosedCount` 计入已在关闭侧。属「未发出 + 完整核验无待关闭目标」。

**normalize**：缺失 `allPausedConfirmed`/`allClosedConfirmed`/`allEnabledConfirmed` **不再**写成 `false`（不作否定证据）；仅 `=== true` 写入。

---

## 2. 修改文件

| 文件 | 变更 |
|------|------|
| `src/engine/ad-switch-orchestrator.js` | `classifyExecuteResult` 三类契约；`_settleFromExecute` 按类收口；导出契约表 |
| `src/engine/monitor.js` | `_normalizeExecuteResult`：缺失布尔不置 false；`blocked_coverage` 归 never_sent |
| `test/ad-switch-integration.test.js` | 契约矩阵、`nothing_to_close`→not_sent、enable 不认 pause 码、三轮生命周期、旧 actionId |

---

## 3. 三轮生命周期（集成测试 + 跨日回归）

| 轮 | 状态 | decision | 结果 | closeAd | batch/outcome | 槽位 |
|----|------|----------|------|---------|---------------|------|
| 1 | mixed（有开启目标） | should_pause | `all_closed_confirmed` | **3** | batch.outcome 同左 | **释放** confirmed |
| 2 | 全 off | already_off+盘点 | `nothing_to_close` | **0** | batch.outcome 同左 | **释放** not_sent |
| 3 | 恢复 1 条 on | should_pause | `all_closed_confirmed` | **+1（共 4）** | batch.outcome 同左 | **释放** confirmed |

`monitor.test.js` **跨日执行**用例（未改断言）在第一组 **通过**。  
另：enable 不接受 pause 码、partial 不释放、旧 actionId 不影响新动作 — 均有专项测试。

---

## 4. 测试命令与结果

| 组 | 命令 | 数量 | 结果 | 退出码 | 输出绝对路径 |
|----|------|------|------|--------|--------------|
| 1 | `node --test test/monitor.test.js test/monitor-chengfang.test.js` | **67** | **67 pass / 0 fail** | **0** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase12-group1-test-output.txt` |
| 2 | `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js test/rules-guard.test.js test/close-flow.test.js test/coordinator.test.js test/chengfang-executor.test.js` | **197** | **196 pass / 1 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase12-group2-test-output.txt` |

### 第二组剩余失败

| 项 | 内容 |
|----|------|
| 名称 | `主链路集成：高于阈值 + 回读 off → 零点击` |
| 位置 | `test/ad-switch-integration.test.js:546`，断言 `:549` |
| 预期 | `results[0].zeroClick === true` |
| 实际 | `false` |
| 原因 | 跨日契约要求「超标 + already_off → 暂停只读盘点」后返回 `nothing_to_close` batch（0 次 closeAd）；该集成用例仍断言纯 zeroClick，与 **本阶段契约/跨日用例** 冲突。属**测试期望与统一契约不一致**，非 settle 误放行。 |
| 建议（待指令） | 将该用例改为：`closeAd/calls.pause === 0` 且（`zeroClick` 或 `batch.outcome==='nothing_to_close'` / `serial==='not_sent'`），**不**弱化跨日断言 |

---

## 5. 尚不能确定的结果语义

1. `blocked_coverage` 一律 `not_sent` 是否在所有消费方可接受（代码上 close 循环前返回，无点击）。  
2. chengfang `nothing_to_pause`（含 `allPausedConfirmed:true`）按「未发出」而非「执行成功」的产品口径是否与值守文案一致。  
3. 真实页面 / 生产加载 / 07:00 真机。

---

## 6. 停止

第一组全绿；第二组 196/1；完整输出见 §4。完成后停止。  
**隔离测试通过 ≠ 生产或真实页面验证。**
