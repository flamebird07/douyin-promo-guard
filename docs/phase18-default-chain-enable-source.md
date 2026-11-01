# 默认乘方状态读取 + 周期开启窗口 — 验证汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 新增测试只跑 1 次；失败即停；**未**跑 npm test、未循环

## 1. 默认调用链

```
_readCurrentAdState
  → 乘方: _readChengfangAdState（opener→身份→双 UI readView/分页→map→close）
  → decide* → createSwitchSerialGate(同店)
  → _executeEnableBatchFor(enableSource) / pause→runner
  → executeChengfangEnableBatch → executeChengfangEnable
  → buildChengfangRequestGate(enableSource) → confirmLanding/refreshView
  → _mapSwitchReturn / _commitExecutedBatch
```

## 2. enableSource

| 值 | 窗口 | 每日相位去重 |
|----|------|--------------|
| `daily_schedule`（缺省） | `[enableHour, dailyStartHour)` | 有 |
| `threshold_recovery` | `dailyStartHour` 起值守窗 | **无** |
| 未知 | 拒绝 | — |

## 3. 修改文件

- `src/engine/monitor.js`（默认 `_readChengfangAdState`、enableSource）
- `src/engine/chengfang-gate.js` / `chengfang-runner.js` / `chengfang-executor.js`（窗口与来源）
- `test/ad-switch-default-chain.test.js`（无 readAdState/execute 注入）

## 4. 测试

`node --test test/ad-switch-default-chain.test.js`  
**tests 9 / pass 8 / fail 1 / exit 1**  
输出：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase18-default-chain-test-output.txt`

通过：默认 on/off/mixed；08:00 低阈值开启一次；已开零点击；mixed 只开 off；07:00 窗外拒；recovery 07:30 拒；定时成功后 recovery 仍执行；演练/enableEnabled=false 零点击。

失败：`默认读取：身份失败…` `:120` 期望 `zeroClick:true` 实际 `undefined`（status:blocked 路径未带 zeroClick）。归类：返回契约/测试，非窗口或状态映射错误。

## 5. 边界

持久化写失败仍可发动作（待修）；bill-manager 未改；**不具备上线条件**；真实页面/07:00 真机未验证。

完成后停止。
