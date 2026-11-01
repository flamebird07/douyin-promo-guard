# 并发场景装配修复 — 测试报告（失败即停）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 只改测试，未改生产逻辑（`monitor.js` / `ad-switch-orchestrator.js` / `switch-serial.js` / 配置均未动）
- 纪律：集成只跑 **1 次**；失败 → 不执行回归、不循环重跑

---

## 1. 修改文件

| 文件 | 变更 |
|------|------|
| `test/ad-switch-integration.test.js` | 仅重写用例 `主链路集成：07:00 日程开启与周期 pause 并发 → 第二个被串行门阻止` 的 fixture/时序与断言 |

---

## 2. 该用例如何制造同店并发

| 步骤 | 路径 | 决策 | 串行门 |
|------|------|------|--------|
| 1 | `mon._runShopEnablePhase(SHOP, …)`（07:00 日程开启） | `evaluateDailyEnable`，回读 **off** → `should_enable` | 同店 `SHOP.id` **同一** `mon._switchOrchestrator.gate` 上 `tryBegin('enable')` |
| 2 | `_executeEnableBatchFor` 挂起 | — | 槽位保持占用（`isBusy===true`） |
| 3 | `mon._runShopSwitchAction(SHOP, 'pause', …)`（值守周期） | `evaluatePeriodic`，回读 **on** + 费用高于阈值 → `should_pause` | 同店同一门 `tryBegin('pause')` → **拒绝** |
| 4 | 断言 | — | `rPause.blocked === 'serial_gate'`，`zeroClick===true`，保留 `reason`，`calls.pause===0` |
| 5 | 放行 enable | — | 回读确认后释放；`calls.enable===1` |

真实意图（每日开启与值守周期动作不能并发）已按生产入口分别走 `_runShopEnablePhase` / `_runShopSwitchAction`，共用 shopId 与门实例；**未**改「低于阈值 + on = already_on」。

---

## 3. 集成测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-integration.test.js` | 25 | **24 pass / 1 fail** | **1** |

回归 **未执行**。

### 并发用例执行到哪一步

串行门竞争断言**已通过**（失败点在放行之后）：

- `rPause.blocked === 'serial_gate'` — 通过  
- `rPause.zeroClick === true` — 通过  
- `rPause.reason` 有值 — 通过  
- `calls.pause === 0` — 通过  
- `isBusy` 占用检查 — 通过  

失败断言（用例内自写错误）：

```text
开启路径带 actionId
actual:   'act_1790057230961_15'
expected: null
```

原因：放行并确认后槽位已释放，`mon._switchGate.peek(SHOP.id)` 为 `null`，断言写成  
`rEnable.actionId === (peek(...) && rEnable.actionId)` → 右侧变 `null`。  
`rEnable.actionId` 本身**有值且正确**，属于**测试断言装配错误**，不是决策问题、不是串行门/持久化问题、也不是生产映射问题。

---

## 4. 失败归类

**装配/断言问题**（本用例最后一行断言写法）。  
同店并发与 `blocked:'serial_gate'` 行为已实际发生并通过断言。

---

## 5. 明确仍未验证

- 真实值守  
- 07:00 真机  
- 真实广告页面  
- monitor / chengfang / close-flow 回归（未跑）  

---

## 6. 停止

集成 24/1 退出码 1；回归未跑；不循环重跑。完成后停止。
