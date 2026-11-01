# 13 条回归失败定位报告（只读调查 · 不改代码）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 证据来源：`docs/phase6-assert-fix-report.md` + 上一轮回归完整输出（224/211/13）+ 源码/测试对照 + `git diff HEAD -- test/monitor-chengfang.test.js`
- 本回合**未**改生产/测试、未提交、未推送、未启停服务、未连广告/飞书
- 未重跑测试（已有完整失败输出）

测试隔离确认：两文件均用 `makeTempDir` 状态目录 + `makeLinkedReader` / `makeStatefulController` /（乘方）本地 DOM fixture；**非**真实页面。

---

## 1. 13 条失败逐项表

图例：  
**记录** = `triggers`/`actions`/`batch`/`status` 等进程内记录；**底层调用** = runner/executor/closeAd/clickLog。

### A. `test/monitor.test.js`（legacy 全店路径；`legacyWholeShopCloseEnabled:true`，无 `readAdState` 注入）

| # | 完整名称 | 行 | 输入 / 时钟 / fixture | 预期 | 实际 | 生产分支 |
|---|----------|----|----------------------|------|------|----------|
| 1 | 演练模式：全店超标 → 记录"将关闭哪些广告"，绝不执行关闭 | 81 | 默认 `costCents:15001, orders:100`；ads=3×投放中+1×已暂停；realMode=false；**无 clock**（真实墙钟） | `status:ok`，`dryRun:true`，`targetCount:3`，`triggers[0].mode=dry` | 断言`:85` `r.results[0].dryRun` 为 `undefined`（≠ true） | `_readCurrentAdState`→`mapAdStateFromAdList` **混合侧别→unknown** → `evaluatePeriodic`→`unknown_blocked` → `_pollShop` **零点击短路**，**不进** `_pollLegacyWholeShopOver` |
| 2 | 三源身份：广告清单页店铺不匹配 → 零关闭 | 127 | 同上 + `adsShopId:'shop-002'` | `status:blocked`，reason 含身份不匹配 | `'ok' !== 'blocked'` | 同上：从未调用 `listAllAds`/清单身份核验；返回零点击 `ok` |
| 3 | 真实模式 07:59：读取并记录但不关闭 | 144 | `realMode:true`；clock=`2026-09-12 07:59`；混合 ads | `window_blocked` | `'ok' !== 'window_blocked'` | 同上短路；**未**到达 `isAfterDailyStart` 窗口门（`_pollLegacyWholeShopOver`） |
| 4 | 真实模式 08:00 整：执行全店关闭并回读确认 | 154 | `realMode:true`；clock=08:00；混合 ads | `batch.outcome=...`，`closeCalls=3` | `TypeError: batch.outcome`（batch 未定义） | 同上短路；**底层 `closeAd` 0 次**（记录亦无） |
| 5 | 真实模式：清单页身份不匹配 → 零关闭 | 167 | `realMode:true`；clock=08:00；`adsShopId:shop-002` | `blocked` | `'ok' !== 'blocked'` | 同 #2 |
| 6 | 跨日执行：历史已关闭不永久跳过 | 257 | `realMode:true`；clock 08:00→次日；期望先关 3 个 | `closeCalls=3`（首日） | `0 !== 3` | 首日即短路；**底层关闭 0** |
| 7 | 重启恢复：损坏状态文件被隔离重建 | 277 | 同上；`closeCalls` 期望 3 | `0 !== 3` | 同 #6 |
| 8 | getStatus 暴露今日数据/调度/触发 | 305 | clock=09:00；cost 15001 | `triggers.length===1` | `0 !== 1` | 短路后**无 trigger 记录**（非无点击问题） |

### B. `test/monitor-chengfang.test.js`（乘方主链路 + `readAdState`=fixture 行映射）

| # | 完整名称 | 行 | 输入 / 时钟 / fixture | 预期 | 实际 | 生产分支 |
|---|----------|----|----------------------|------|------|----------|
| 9 | 主链路：未配置乘方范围且未开启历史路径 → blocked | 446 | `noScope:true`；clock=08:00；**空 plans**（map→`off`）；cost 10001 | `blocked`，reason 含未配置乘方控制范围；sessions=0 | `'ok' !== 'blocked'` | 空清单→`off`；above+off→`already_off` 零点击短路；**未**执行 scope fail-closed |
| 10 | 自动开启调度：07:00 整 → 执行每日开启 | 658 | clock=07:00；enableEnabled；fixture 全关 | `actions.length===1`；clickLog switch=1, enable=1 | `2 !== 1`（**仅 actions 记录**） | `_executeEnableBatchFor` 与 `_runShopEnablePhase` **各写一次** `actions`/`_recordBatch`（双记）。底层 clickLog 本用例另断言通过则≠2 次真点 |
| 11 | 自动开启调度：监控未启动 → 手动 pollOnce（07:00） | 755 | 不 `start()`；clock=07:00；fixture **全关**→`off`；cost 10001 | `window_blocked` | `'ok' !== 'window_blocked'` | above+off→`already_off` 短路；**未**进入 pause 路径窗口门 |
| 12 | 第三轮：真实开启路径被窗口拦下 | 777 | clock=08:30（窗外）；直接 `_runShopEnablePhase` | `actions.length===0`；sessions=0；有 `targetAction=enable` 的 window trigger | `1 !== 0` | `executeChengfangEnableBatch`→`blocked_window`；`_runShopEnablePhase` 仍把带 `counts` 的 blocked 批次 **记入 actions**。**非**真实点击（sessions 期望 0） |
| 13 | 自动开启调度：enableEnabled=false | 795 | clock=07:00；enableEnabled=false | `actions.length===0`；sessions=0；recentErrors 含开启 | `1 !== 0` | 同 #12：`blocked` 批次被记入 actions；门槛在 runner，未必写入 recentErrors |

---

## 2. 根因分组（含证据）

### 组 G1 — 状态映射使全店混合侧别变成 unknown，决策短路（影响 #1–#8, #9, #11）

| 项 | 内容 |
|----|------|
| 标签 | **实现缺陷**（与全店暂停语义/安全门禁不一致） |
| 证据 | `ad-switch-state.js`：混合 on/off → `'unknown'`；`ad-switch-decision.js`：unknown → `unknown_blocked` 零动作；`monitor.js` `_pollShop`：非 should_* 直接 `{status:'ok', zeroClick}`，**不再**进入 legacy/乘方路径 |
| `monitor.test.js` ADS | 3×`投放中` + 1×`已暂停` → map 出 **unknown** |
| 后果 | 超标时不再演练枚举、不再跑清单身份、不再受 07:59 窗口门、不再 `closeAd`、无 trigger |
| 返回 vs 底层 | #1–#8：**返回/记录**已变（ok/dryRun/triggers）；#4/#6/#7 的 `closeCalls` 是 **底层调用** 且为 0（不是“记了假点击”） |
| 兼容性 | 非乘方 close/coordinator **未被编排器替代**；是 **根本进不去** `_pollLegacyWholeShopOver` / `_pollChengfangOver` |
| 建议最小修复位置 | ① `src/engine/ad-switch-state.js`：暂停语义下“存在任一投放侧/可关对象”应映射 **on**（或引入 `mixed→pause 看作 on`）；或 ② `src/engine/monitor.js` `_pollShop`：在 `data.evaluation.over===true` 时强制进入 pause 门禁链（scope/窗口/身份）再决定是否零点击 |
| 不能确认 | 产品是否**有意**要求“混合库存禁止暂停”（与旧测试/安全关闭语义冲突） |

### 组 G2 — over / fail-closed 门禁被 already_off 短路（影响 #2, #3, #5, #9, #11）

| 项 | 内容 |
|----|------|
| 标签 | **实现缺陷**（安全门禁：身份、scope、时间窗） |
| 证据 | 旧逻辑：`evaluation.over` → 进入路径 → 清单身份失败=`blocked`、07:59=`window_blocked`、无 scope=`blocked`。新逻辑：above+off 或 unknown → 先返回 `ok` |
| #9 特别证据 | 空 fixture 映射 **`off`**（`mapRowsToAdState` 空→off）→ `already_off`；测试期望的是 **配置缺失 fail-closed**，不是“已关闭” |
| 返回 vs 底层 | 只有 **返回 status** 变化；sessions/closeCalls 仍为 0（未误点） |
| 建议最小修复位置 | `monitor.js` `_pollShop`：`over` 时先做 scope / 时间窗 /（进入执行前）清单身份；**不得**因 already_off/equal 跳过这些门禁的 **blocked/window_blocked 语义**（或至少 over+无 scope 仍 `blocked`） |
| 不能确认 | 产品是否接受“已关闭 + 超标 + 无 scope → ok 零点击”（当前新语义） |

### 组 G3 — 开启批次双记 / blocked 批次记入 actions（影响 #10, #12, #13）

| 项 | 内容 |
|----|------|
| 标签 | **实现缺陷**（记录层；**不是**真实点击次数） |
| 证据 | `_executeEnableBatchFor` 对非 blocked 成功批次 `_memPush(actions)`；`_runShopEnablePhase` 在 settle 后**再次** `if (batch.outcome && batch.counts) _recordBatch + _memPush(actions)`（**未**排除 `blocked`/`blocked_window`） |
| #10 | 成功开启被记 **2** 条 action → `actions.length` 2≠1；同用例 clickLog 仍应用 switch/enable 次数判断真点 |
| #12/#13 | `blocked_window` / `blocked` 仍带 `counts` → 被记入 actions（1≠0） |
| 返回 vs 底层 | `monitor.actions[]` 是 **审计/事件记录**，**禁止**当作真实点击次数；底层以 `track.sessions`、`clickLog`、`closeCalls` 为准 |
| 建议最小修复位置 | `src/engine/monitor.js` `_runShopEnablePhase`：去掉重复 `_recordBatch`/`actions`，或仅在 `_executeEnableBatchFor` **未**记录时补记；**blocked\* 一律不进 actions** |
| 不能确认 | 无（双记与 blocked 入账可由代码路径直接证明） |

### 组 G4 — `monitor-chengfang.test.js` 相对 HEAD 的 fixture 改动（非失败根因，但相关）

| 项 | 内容 |
|----|------|
| 标签 | **测试装配改动**（已存在，本回合**不**恢复/覆盖） |
| 差异摘要 | ① setup 增加 `readAdState`（fixture 行→on/off/unknown）与 `live` 行同步；② 会话 close 时从页面回读刷新 live；③ 跨日用例断言 `/跳过开启进程\|already_on/`；④ 第 3 天用 `hLive.setRows(...switchChecked:false)` 模拟暂停后回读（不再只改 adBelief） |
| 为何改 | 决策层要求 currentAdState 来自本轮回读；adBelief 不得代替 |
| 与 13 条关系 | **不是** #9–#13 的主因（主因在生产短路/双记）；空 plans→`off` 的映射来自该 setup，放大了 G2 的 #9/#11 |

---

## 3. 返回记录 vs 底层调用（总表）

| 失败 | 主要变化是记录/返回？ | 是否调用 runner/executor？ | fixture 底层调用次数（据用例设计） |
|------|----------------------|---------------------------|-------------------------------------|
| #1 演练 dryRun | 是（无 trigger/dryRun 字段） | 否（短路） | closeAd=0；期望本就不点 |
| #2/#5 清单身份 | 是（status ok≠blocked） | 否 | closeAd=0 |
| #3 07:59 | 是（ok≠window_blocked） | 否 | closeAd=0 |
| #4/#6/#7 关闭次数 | **底层 closeAd=0** + 无 batch | 否 | 期望 3 次 closeAd（真实 mock 调用） |
| #8 triggers | 是（triggers 0≠1） | 否 | — |
| #9 无 scope | 是（ok≠blocked） | 否 | sessions=0 |
| #10 actions 2 | **记录双写** | 是（一次开启流程） | clickLog：switch/enable 各 1（用例已断言）≠ actions 2 |
| #11 07:00 window | 是 | 否 | sessions=0 |
| #12/#13 actions 1 | **blocked 误入 actions** | runner 有调用但应 blocked | sessions=0（期望）；actions≠点击 |

---

## 4. 建议修复文件（最小位置 · 待主脑统一指令）

| 组 | 文件 | 最小改动意图 |
|----|------|----------------|
| G1 | `src/engine/ad-switch-state.js` **或** `src/engine/monitor.js` `_pollShop` | 混合/存在投放侧时暂停决策不得 unknown 短路 |
| G2 | `src/engine/monitor.js` `_pollShop`（及必要时 `_runShopSwitchAction` 入口） | `over` 时保留 scope / 时间窗 / 清单身份的 **blocked / window_blocked** 语义 |
| G3 | `src/engine/monitor.js` `_runShopEnablePhase`、`_executeEnableBatchFor` | 消除 actions 双记；blocked* 不进 actions |
| G4 | （无需改） | 保留 `test/monitor-chengfang.test.js` 现有 diff |

**明确不建议**：为变绿而改安全门禁期望值（window_blocked / blocked / identity）。

---

## 5. 尚不能确认的事实

1. 产品是否**有意**规定：库存混合 on/off 时禁止任何暂停（与旧全店关闭/安全语义冲突）。  
2. `already_off` + `evaluation.over` 时是否仍必须返回 `window_blocked`/`blocked`（本报告按 **安全门禁应保留** 分类为缺陷）。  
3. `actions[]` 在产品语义上是否允许包含 blocked 批次（当前测试断言 **不允许**）。  
4. #10 双记是否另有消费方依赖两条记录（证据显示测试期望 1）。  
5. 真值守 / 07:00 真机 / 真实页面行为（本调查全部为 fixture）。

---

## 6. 停止

只读定位完成。等待主脑统一修复指令。  
报告绝对路径：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase7-13-failures-root-cause.md`
