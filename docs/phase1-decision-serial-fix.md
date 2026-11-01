# 第一阶段决策模块 / 串行门修正汇报

项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`  
边界：未接 monitor、未操作真实页面、未持久化生产状态、未启服务、未提交/推送。

## 1. 修改文件

| 文件 | 变更 |
|------|------|
| `src/engine/switch-serial.js` | 重写锁生命周期：`tryBegin` 返回 `actionId`；`markNotSent` / `markUnknown` / `markConfirmed` / `resolveUnknownAfterReadback` / `markSettled({kind})`；移除生产 `clear()`；`peek`/`slot` 为快照 |
| `src/engine/ad-switch-decision.js` | `identityOk === true` 严格校验；`orders × thresholdCents` 溢出 → `data_blocked`；`metric` 与 `decision` 分离；注释整理 |
| `test/ad-switch-decision.test.js` | 覆盖未知阻塞、actionId、快照、溢出、identityOk、矩阵；保留不同店铺互不阻塞；注明非真实 07:00 集成 |

## 2. 结果模型（勿混称）

- **metric**（指标相对阈值）：`below_threshold` | `equal_threshold` | `above_threshold`
- **decision**（保持 / 需动作 / 阻止）：`should_enable` | `should_pause` | `already_on` | `already_off` | `equal_no_action` | `unknown_blocked` | `data_blocked`

整数比较：`costCents` vs `orders × thresholdCents`；等于阈值零切换。

## 3. 串行门语义

| 情形 | API | 行为 |
|------|-----|------|
| 明确尚未发出 | `markNotSent(shopId, actionId)` | 结束并释放 |
| 可能已发出 / 超时 / 回读失败 | `markUnknown(shopId, actionId, reason)` | **保留阻塞**，同向/反向 `tryBegin` 均拒绝 |
| 回读确认结果 | `resolveUnknownAfterReadback(shopId, actionId, {confirmed})` | 唯一恢复入口；结束本轮 |
| 确认成功后完成 | `markConfirmed` + `markSettled({kind:'confirmed'})` | 完成并释放 |

- 异常/超时 **不等于** 未发出。
- 全部确认/结束/恢复必须匹配 **shopId + actionId**；旧 `actionId` 延迟回调失败且不影响新槽。
- `tryBegin` 返回的 `slot`、`peek()` 均为快照；外部改字段不能绕锁。
- **无** 生产可调 `clear()`。

## 4. 测试命令 / 数量 / 退出码

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-decision.test.js` | 20 | 20 pass / 0 fail | **0** |
| `node --test test/rules-guard.test.js`（回归） | 20 | 20 pass / 0 fail | **0** |

覆盖：超时后同向/反向拒绝；`markNotSent` 释放；unknown 回读恢复；旧 actionId 不影响新动作；快照不可绕锁；`identityOk` 非法零动作；乘法溢出；阈值矩阵；不同店铺互不阻塞。  
说明：`tryBegin` 并发用例仅为**进程内串行门单测**，不是真实 07:00/值守集成验证。

## 5. 仍属进程内模块

- 门闩为 **进程内 Map**，**重启恢复未验证**（无生产持久化）。
- **未接入** `monitor` / `chengfang-executor` 调度；**未**实读 `currentAdState`。
- 真实配置开关未改；Git 未提交、未推送。
