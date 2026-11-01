# 值守主链路接入（决策层 + 串行门）— 测试失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 边界：仅隔离测试；不启服务、不登录、不访问真实广告页、不调飞书、不真实开关广告、不发通知、不改生产配置、不提交、不推送
- 执行纪律：每条测试命令 **只跑 1 次**；失败 → 停止并报告，**不循环重跑**

---

## 1. 验证结果（失败即停）

| 顺序 | 命令 | 结果 | 退出码 |
|------|------|------|--------|
| 1（新增集成） | `node --test test/ad-switch-integration.test.js` | **15 pass / 10 fail**（25 条） | **1** |
| 2（回归） | monitor / chengfang / close-flow | **未执行**（按约定：先失败即停止） | — |

**说明：以上为 fixture/mock 集成测试，不是真实值守或 07:00/真实页面集成已验证。**

---

## 2. 失败详情（已保存，不再重跑）

### 2.1 通过的部分（15）

纯编排器 / 状态映射 / 串行门生命周期 **全部通过**：

- 映射：on/off/unknown / 空清单证据
- 低于阈值 + off → enable 一次；+ on → 零点击
- 高于阈值 + on → pause 一次；+ off → 零点击
- 等于阈值 / unknown / 身份失败 / 数据异常 → 零点击
- 07:00 enable 与周期 enable/pause 并发 → 第二个被门阻止
- 动作回读失败后下一周期不补点
- 旧 actionId 不影响新动作；动作前复核状态变化 → markNotSent
- neverSent（dryRun/realMode 门禁）→ markNotSent
- 重启恢复 → unknown 阻塞（不把未知写成成功）
- 日程开启意图（adBelief 不参与决策）
- metric/decision 分离契约

### 2.2 失败的部分（10）— 全部是「主链路 Monitor 集成」用例

失败断言均为 `r.results[0].decision / zeroClick / serial` 为 `undefined`。

**根因（测试装配，不是决策/串行门逻辑）：**

`setupMonitor` 里 `makeLinkedReader(controller, def)` **未传入 `nowFn`**，费用 `businessDate` 用了真实墙钟（今天=2026-09-22），而 Monitor 的 `nowFn` 固定为 `shanghaiMs('2026-09-12','08:30')`。

→ `guard.checkBusinessDateToday` 抛出：

```text
店铺 shop-001 本轮停止: 全店推广费用统计日期不是当天：页面口径 2026-09-22，当前上海日期 2026-09-12（跨日数据不用于关闭决策）
```

`_pollShop` 走 catch 返回 `{status:'stopped'}`，**尚未进入决策层**，故 `decision` 等字段缺失。

涉及用例：

1. 主链路集成：低于阈值 + 回读 off → 进入 enable 流程一次  
2. 主链路集成：低于阈值 + 回读 on → 零点击  
3. 主链路集成：高于阈值 + 回读 on → 进入 pause 流程一次  
4. 主链路集成：高于阈值 + 回读 off → 零点击  
5. 主链路集成：等于阈值 → 零点击  
6. 主链路集成：回读 unknown → 零点击  
7. 主链路集成：动作回读失败（partial）→ 下一周期不补点  
8. 主链路集成：dryRun/realMode 门禁——neverSent 释放  
9. 主链路集成：07:00 日程开启与周期 pause 并发  
10. 主链路集成：旧 actionId 回调不影响新动作  

### 2.3 建议修复（本回合未改、未重跑）

仅测试装配一行：`makeLinkedReader(controller, def, () => shanghaiMs('2026-09-12','08:30'))`（与 Monitor 同一时钟）。  
**不改** 决策层/串行门/编排器产品逻辑。

---

## 3. 本阶段已落地的接入（代码已写入，待回归绿后再验收）

| 文件 | 职责 |
|------|------|
| `src/engine/ad-switch-state.js` | 页面/清单回读 → on/off/unknown 明确映射（adBelief 不得代替） |
| `src/engine/ad-switch-orchestrator.js` | 决策 + 串行门外层；复用 runner/executor；生命周期收口 |
| `src/engine/switch-serial.js` | 增加 `exportState` / 启动恢复（未结束 → unknown 阻塞） |
| `src/engine/monitor.js` | 周期评估接入 `decideAdSwitchAction`；07:00/低于阈值开启/高于阈值暂停统一走门 |
| `test/ad-switch-integration.test.js` | 新增隔离集成测试 |
| `test/monitor-chengfang.test.js` | setup 注入 `readAdState`（fixture 行级开关回读） |

生命周期口径（与上一阶段一致）：

- 请求发出前登记 actionId  
- 明确未发出 → `markNotSent`  
- 可能已发出/回读失败 → `markUnknown`  
- 最新回读确认目标状态 → `markConfirmed`+`markSettled(CONFIRMED)` 或 `resolveUnknownAfterReadback(..., confirmed:true)`  
- 旧 actionId 不得影响新动作  
- 回读未确认目标达成 → 保持阻塞，不自动补点  
- 重启未结束动作 → unknown 安全阻塞  

保留门禁：`realMode` / `enableEnabled` / `pauseEnabled`、店铺/账户身份、全店托管+商品自选范围、每日开启相位去重、读取刷新与回读超时（仍在 runner/executor 内）。

---

## 4. 明确未验证边界

- **不是**真实值守、**不是**真实 07:00、**不是**真实广告页面验证  
- 回归（`monitor` / `chengfang` / `close-flow`）**尚未跑**  
- 未提交、未推送、未改生产配置  

---

## 5. 停止

已按「失败即停、不循环重跑」执行。等待主脑指示（例如：只修测试时钟后允许再跑一次）。
