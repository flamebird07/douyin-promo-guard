# 串行门拒绝返回映射修复 — 测试报告（失败即停）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 边界：不启服务、不登录、不访问真实广告页、不调飞书、不真实开关广告、不发通知、不提交、不推送
- 纪律：集成测试只跑 **1 次**；失败 → 不执行回归、不循环重跑

---

## 1. 修改文件

| 文件 | 变更 |
|------|------|
| `src/engine/monitor.js` | `_runShopSwitchAction` / `_runShopEnablePhase`：把 `settled.blocked === 'serial_gate'` 分支**提到**普通 `zeroClick` 之前；仍 `zeroClick:true`；透出 `blocked:'serial_gate'`、`reason`、`inflight`；不误报为 already_*/成功 |

未改：串行门生命周期、`ad-switch-orchestrator.js`、`ad-switch-state.js`、调度结构、真实配置。

映射契约（已实现）：

- 串行门拒绝 → 零点击  
- 返回必须含 `blocked: 'serial_gate'`  
- 保留 `reason` / `inflight`（占用信息）/ `decision` / `currentAdState`  
- 不误报为 `already_on` / `already_off` / 成功 / 普通 `zeroClick`  

---

## 2. 集成测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-integration.test.js` | 25 | **24 pass / 1 fail** | **1** |

回归 **未执行**（约定：集成非 0 → 立即停止）。

### `blocked: 'serial_gate'` 实际返回证据（已通过用例）

- `主链路集成：动作回读失败（partial）→ 下一周期不补点`  
  断言 `r2.results[0].blocked === 'serial_gate'` **通过**（上一轮该条因映射顺序失败，本轮已绿）
- 纯编排器：`集成：07:00 enable 与周期 enable/pause 并发…`、`动作回读失败后下一周期不补点`  
  断言 `r.blocked === 'serial_gate'` **通过**

---

## 3. 仍失败 1 条

`主链路集成：07:00 日程开启与周期 pause 并发 → 第二个被串行门阻止`  
（`test/ad-switch-integration.test.js:609`，断言 `:630`：`rPause.blocked` 仍为 `undefined`）

### 失败归类：**测试装配问题**（不是决策问题，不是串行门/持久化问题，也不是本轮映射修复未生效）

根因：

1. 用例用 `adState: 'on'` + `cost.valueCents: 5000` 调用 `_runShopSwitchAction(..., 'enable')`  
2. 该入口使用 **`evaluatePeriodic`**（低于阈值+on → `already_on`）  
3. **从未 `tryBegin`**，串行门未被 enable 占用  
4. 随后的 pause 自然不会拿到 `blocked: 'serial_gate'`

对照：真正的 07:00 日程开启走 `_runShopEnablePhase` → `evaluateDailyEnable`；本用例却用周期决策入口模拟「日程开启」，且回读状态为 `on` 时 enable 本就应零点击。

本轮映射修复对该场景**无法单独变绿**——门上根本没有槽位可拒。  
按「失败即停、不循环重跑」**不改测试、不再跑**。

若允许下一步：仅改该用例装配（例如 `adState:'off'` 使 below+off→`should_enable` 占门，或改走 `_runShopEnablePhase`），属测试断言/装配修正，不是业务重构。

---

## 4. 明确仍未验证

- 真实值守  
- 07:00 真机  
- 真实广告页面  
- monitor / chengfang / close-flow 回归（本回合未跑）  

---

## 5. 停止

生产映射已最小修复；集成 24/1 退出码 1；回归未跑；剩余 1 条为测试装配问题已记录。完成后停止。
