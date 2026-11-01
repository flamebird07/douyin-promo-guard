# 错误断言修复 — 集成全绿 / 回归结果汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 本阶段只改测试断言，**未改生产代码**
- 纪律：集成、回归各只跑 **1 次**；不循环重跑

---

## 1. 修改文件

| 文件 | 变更 |
|------|------|
| `test/ad-switch-integration.test.js` | 删除释放后 `actionId === (peek() && actionId)` 错误断言；改为竞争期 `inflight.actionId`、放行后执行次数、`peek()===null` / `isBusy===false` |

---

## 2. 集成测试（第 1 条命令，只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-integration.test.js` | **25** | **25 pass / 0 fail** | **0** |

### 并发竞争 / 动作释放 / 槽位清理证据

用例：`主链路集成：07:00 日程开启与周期 pause 并发 → 第二个被串行门阻止`（**通过**）

| 阶段 | 断言 | 含义 |
|------|------|------|
| 竞争期间 | `peek(shop).actionId` 有值 | 同店槽位被 07:00 enable 占用 |
| 竞争期间 | `rPause.blocked === 'serial_gate'` | 周期 pause 被同店门拒绝 |
| 竞争期间 | `rPause.inflight.actionId === busyBefore.actionId` | 拒绝结果指向占用槽 actionId |
| 竞争期间 | `rPause.zeroClick === true`、`reason` 有值、`calls.pause === 0` | 零点击且不进 pause execute |
| 放行后 | `calls.enable === 1`、`rEnable.enable.serial === 'confirmed'` | 动作确实执行一次并回读确认 |
| 释放后 | `isBusy === false`、`peek() === null` | 槽位清理（**不用**「释放后仍 peek 到 actionId」） |

同店并发路径：`_runShopEnablePhase`（日程开启）与 `_runShopSwitchAction(pause)` 共用 `SHOP.id` 与 `mon._switchOrchestrator.gate`。

---

## 3. 回归测试（第 2 条命令，集成全绿后只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-decision.test.js test/rules-guard.test.js test/close-flow.test.js test/coordinator.test.js test/monitor.test.js test/monitor-chengfang.test.js test/chengfang-executor.test.js` | **224** | **211 pass / 13 fail** | **1** |

`close-flow` / `chengfang-executor` / `rules-guard` / `ad-switch-decision` / 多数 `coordinator`、`monitor-chengfang` **通过**。

### 回归失败 13 条（未再跑、未改代码）

均在 `monitor.test.js` / `monitor-chengfang.test.js`，与决策层接入后的行为/返回形状有关（本阶段按约定不修生产）：

| 文件 | 失败摘要 |
|------|----------|
| `monitor-chengfang.test.js` | 未配置乘方范围期望 `blocked` 得到 `ok`；07:00 开启 actions 2≠1；07:00 pollOnce 期望 `window_blocked` 得到 `ok`；开启窗口拦截后 actions 1≠0；enableEnabled=false 时期望 0 动作得到 1 |
| `monitor.test.js` | 演练超标 `triggers` 形状；清单身份失败期望 `blocked`；07:59 期望 `window_blocked`；08:00 批次字段；清单身份 real 模式；跨日/重启恢复 close 次数 0≠3；getStatus 触发数 0≠1 |

说明：这些是 **回归未全绿**，不是本阶段断言修复引入的集成失败；集成层 25/25 已绿。

---

## 4. 明确仍未验证

- 真实值守  
- 07:00 真机  
- 真实广告页面  

---

## 5. 停止

- 修改文件：仅 `test/ad-switch-integration.test.js`  
- 集成：25 pass / 0 fail，退出码 **0**  
- 回归：211 pass / 13 fail，退出码 **1**（只跑 1 次）  
- 并发竞争、动作释放、槽位清理证据见 §2  

完成后停止。
