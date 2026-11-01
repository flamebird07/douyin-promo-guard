# 决策测试与串行门生命周期修复汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 范围：仅 `ad-switch-decision` / `switch-serial` 及对应单测
- 本阶段**未**接 monitor、**未**改生产配置、**未**启服、**未**调外部接口、**未**操作广告、**未**处理密钥或目录、**未**提交、**未**推送
- 测试命令**只执行 1 次**，未循环

---

## 1. 测试结果

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-decision.test.js test/rules-guard.test.js` | **45** | **45 pass / 0 fail** | **0** |

明细：`ad-switch-decision.test.js` 25 条 + `rules-guard.test.js` 20 条。

**说明：以上为进程内模块隔离单测通过，不是真实值守或 07:00 集成已验证。**

---

## 2. 修改文件（绝对路径）

| 路径 | 变更 |
|------|------|
| `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\src\engine\switch-serial.js` | 按生命周期规则重写转换与注释 |
| `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\test\ad-switch-decision.test.js` | 修正 identityOk 末行输入；补/改串行门生命周期用例 |

未改：`ad-switch-decision.js`、`rules.js`、生产配置、密钥、目录结构。

---

## 3. 问题与修复

### 3.1 决策测试默认输入与 should_pause 断言不一致

- **现象**：`dec({ identityOk: true })` 默认 `costCents: 5000` + `currentAdState: 'off'` → `should_enable`，断言却写 `SHOULD_PAUSE`。
- **修复**：末行改为显式入参 `costCents: 10001`（高于 `orders × thresholdCents = 10000`）且 `currentAdState: 'on'`，断言仍为 `DECISION.SHOULD_PAUSE`（**未降低断言**）。

### 3.2 `markSettled(CONFIRMED)` 先 `markConfirmed` 再走仅允许 unknown 的恢复入口

- **现象**：CONFIRMED 路径先 `markConfirmed`（清掉 `unknown`）再调 `resolveUnknownAfterReadback`，后者要求 `unknown`，导致确认后无法结束。
- **修复**：`markSettled({kind:CONFIRMED})` 自成路径：仅当 **非 unknown 且 `confirmed === true`** 时 `settled` 并释放；**未确认时不得自行制造已确认**。

### 3.3 `resolveUnknownAfterReadback` 缺参 / `confirmed:false` 曾会释放

- **修复**：仅 `p` 存在且 `p.confirmed === true` 才结束并释放；缺参、`false`、非法参数（非严格 true）**一律保持 unknown 阻塞**，不释放、不自动补点。

### 3.4 `markNotSent` 曾可释放 already-unknown 动作

- **修复**：`markNotSent` **仅 in-flight**；`unknown` 或 `confirmed` 状态均拒绝，不得绕过回读要求。

### 3.5 注释

- 删除 `resolveUnknownAfterReadback` 中「或保持？」等未定口径。
- 修正头注释与 `markSettled` 注释，与下述生命周期规则一致。

---

## 4. 生命周期规则（实现口径）

槽位状态：`in-flight` → `unknown` | `confirmed` → `settled`

| 转换 | 允许条件 | 结果 |
|------|----------|------|
| `tryBegin` | 无未结束槽 | 唯一 `actionId`，in-flight |
| `markNotSent` / `markSettled(NOT_SENT)` | **仅 in-flight** | 结束并释放 |
| `markUnknown` / `markSettled(UNKNOWN)` | 未 settled | 进入/保持 unknown，**阻塞** |
| `markConfirmed` | **仅 in-flight**（非 unknown） | 置 `confirmed=true`，**不释放** |
| `markSettled(CONFIRMED)` | 非 unknown 且已 `confirmed` | 结束并释放；未确认 → 拒绝（不伪造确认） |
| `resolveUnknownAfterReadback` | 槽为 unknown 且 **`p.confirmed === true`** | 唯一恢复入口，结束并释放 |
| 同上，缺参 / false / 非法 | — | **保持阻塞**，不释放 |

约束：

1. 全部转换核对 **shopId + actionId**；旧 actionId 延迟回调失败且不影响新动作。
2. `markConfirmed` **不得**绕过 unknown 恢复入口。
3. `markNotSent` **不得**释放 `unknown` 或 `confirmed`。
4. 回读未确认目标达成 → **本阶段保持阻塞**；不设计自动补点。
5. 异常/超时 ≠ 未发出，须走 `markUnknown`。
6. 生产 API **无** `clear()`。
7. `slot` / `peek()` 为快照，外部改字段不能绕锁。

---

## 5. 测试覆盖（本轮新增/调整）

| 用例 | 验证点 |
|------|--------|
| 正常确认后可以释放 | `markConfirmed` → `markSettled(CONFIRMED)` |
| 未确认不能伪装成功释放 | 未确认时 CONFIRMED 拒绝，`confirmed` 保持 false |
| unknown 经 `confirmed:true` 恢复 | `resolveUnknownAfterReadback` 唯一出口 |
| unknown 缺参/false 回读不释放 | 保持 busy + unknown block |
| 不能经 `markNotSent`/`markConfirmed` 绕过 | unknown 下两者及 settle 变体均拒绝 |
| 已 confirmed 不得 `markNotSent` | 走 CONFIRMED 结束 |
| 旧 actionId 不影响新动作 | 旧回调全部失败，新槽完好 |
| identityOk 严格 true | 非法 → `data_blocked`；合法高费用+on → `should_pause` |
| 整数溢出 / 快照保护 / 并发门 / 无 clear | 原有语义保持 |
| 决策矩阵 / rules-guard 回归 | 25 + 20 全过 |

---

## 6. 边界重申

- **不是**真实值守、**不是** 07:00 集成验证。
- 未接 `monitor` / 调度 / 真实广告页点击。
- 门闩为进程内 `Map`，重启恢复未验证。
- Git 未提交、未推送。

---

## 7. 停止

代码与测试修复完成；双测试一次通过（45/45，退出码 0）。本阶段结束，**不再重跑**。
