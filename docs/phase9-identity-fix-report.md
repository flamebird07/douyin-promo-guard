# 身份装配修正 + 两组验证汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 本阶段只改测试装配；**未改生产代码**
- 纪律：每组只跑 **1 次**；第二组失败 → 保存输出并停止，不循环重跑

---

## 1. 修改文件及身份数据关系

| 文件 | 变更 |
|------|------|
| `test/ad-switch-integration.test.js` | 仅用例 `门禁优先级：清单身份失败 → blocked` |

**定位确认**（与 phase8 汇报一致）：

| 字段 | 值 | 作用 |
|------|-----|------|
| `SHOP.accountId` | `1710242295996424` | 配置要求费用/清单账户映射 |
| `costAccountId` | **补** `IDENTITY.accountId`（同上） | 费用源身份通过 → 进入清单 |
| `orderAccountId` | 不提供 | 订单源不强制账户 |
| `adsShopId` | **保留** `shop-002` | 清单店铺故意不匹配 → 走清单身份 |

断言保留 `status: 'blocked'` + reason `/身份/`，并分别断言 `enableExec === 0`、`pauseExec === 0`（底层 execute 均未进入）。

---

## 2. 两组测试

| 顺序 | 命令 | 数量 | 结果 | 退出码 | 完整输出绝对路径 |
|------|------|------|------|--------|------------------|
| 1 | `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js` | **58** | **58 pass / 0 fail** | **0** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase9-group1-test-output.txt` |
| 2 | `node --test test/rules-guard.test.js test/close-flow.test.js test/coordinator.test.js test/monitor.test.js test/monitor-chengfang.test.js test/chengfang-executor.test.js` | **199** | **197 pass / 2 fail** | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase9-group2-test-output.txt` |

---

## 3. 原 13 条失败逐项（第二组）

| # | 完整名称 | 文件 | 本组 |
|---|----------|------|------|
| 1 | 演练模式：全店超标 → 记录"将关闭哪些广告"，绝不执行关闭 | monitor.test.js | **通过** |
| 2 | 三源身份：广告清单页店铺不匹配 → 零关闭 | monitor.test.js | **通过** |
| 3 | 真实模式 07:59：读取并记录但不关闭 | monitor.test.js | **通过** |
| 4 | 真实模式 08:00 整：执行全店关闭并回读确认 | monitor.test.js | **通过** |
| 5 | 真实模式：清单页身份不匹配 → 零关闭 | monitor.test.js | **通过** |
| 6 | 跨日执行：历史已关闭不永久跳过，按最新广告状态决定操作 | monitor.test.js | **失败**（见下） |
| 7 | 重启恢复：损坏状态文件被隔离重建 | monitor.test.js | **通过** |
| 8 | getStatus 暴露今日数据/调度/触发 | monitor.test.js | **通过** |
| 9 | 主链路：未配置乘方范围且未开启历史路径 → blocked | monitor-chengfang.test.js | **通过** |
| 10 | 自动开启调度：07:00 整 → 执行每日开启 | monitor-chengfang.test.js | **通过** |
| 11 | 自动开启调度：监控未启动 → 手动 pollOnce（07:00）window_blocked | monitor-chengfang.test.js | **通过** |
| 12 | 第三轮：真实开启路径被窗口拦下 → targetAction=enable | monitor-chengfang.test.js | **通过** |
| 13 | 自动开启调度：enableEnabled=false → 07:00 相位 blocked | monitor-chengfang.test.js | **失败**（见下） |

**13 条中原 11 条已通过，2 条仍失败。**

---

## 4. 剩余失败（完整名称 / 预期 / 实际）

### F1

- **名称**：`自动开启调度：enableEnabled=false → 07:00 相位 blocked，零页面会话、零动作`
- **文件/行**：`test/monitor-chengfang.test.js:795`，断言 `:806`
- **预期**：`monitor.recentErrors` 中存在 `/开启/` → `true`（「门槛原因进入错误记录」）
- **实际**：`false`
- **同用例其它断言**：sessions/actions/batches 等 0 动作相关（失败点在此条；输出未显示其它断言失败）

### F2

- **名称**：`跨日执行：历史已关闭不永久跳过，按最新广告状态决定操作`
- **文件/行**：`test/monitor.test.js:257`，出错 `:266`
- **预期**：`r2.results[0].batch.outcome === 'nothing_to_close'`（次日全关时应有 batch）
- **实际**：`TypeError: Cannot read properties of undefined (reading 'outcome')` → `batch` 为 `undefined`（次日 `already_off` 零点击路径未返回 batch）

---

## 5. 边界声明

模块与 fixture 测试通过 **不代表** 真实广告页面、生产加载或 07:00 真机验证完成。

---

## 6. 停止

第一组 58/0 退出码 0；第二组 197/2 退出码 1；完整输出见 §2。完成后停止，等待主脑指令。
