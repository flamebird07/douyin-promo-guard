# 只读审查：默认执行链与 bill-manager 集成

- 范围：`douyin-promo-guard` + `bill-manager`；**未改代码**、未重跑全量测试、未启停服务
- 区分：**源码可确认** / **fixture 验证** / **尚未验证**（448 条 ≠ 默认生产链完整）

---

## 0. Bash 环境

| 项 | 结论 |
|----|------|
| 报错来源 | 工具 shell 已是 `/usr/bin/bash`，但 **PATH 无 `bash`/`env` 兼容名** → `npm test` 等脚本 shebang `/usr/bin/env bash` 失败（exit 127）。**不是** npm `script-shell`（null） |
| 本机 Bash | Git for Windows：`C:\Program Files\Git\bin\bash.exe`（短路径 `C:\Progra~1\Git\bin\bash.exe`）**GNU bash 5.2.37** |
| 修复 | **仅本进程** `export PATH="/c/Program Files/Git/bin:/c/Program Files/Git/usr/bin:$PATH"`；未改全局 PATH / npm 配置 |
| 验证 | `bash --version` → 5.2.37；`/usr/bin/env bash -c "echo env-ok"` → **env-ok**（原失败入口已恢复）；中文路径下 `node -e require('./package.json')` → `douyin-promo-guard`，test 清单含 `ad-switch-decision` / `ad-switch-integration` |
| 仍有限制 | PATH **每条命令需重新 export**（工具未持久会话 env）；`which` 不在 PATH；未安装 WSL、未动 Git 全局 |

---

## 1. 默认调用链（未注入测试适配器）

```
Monitor.pollOnce / _runEnablePhase
  → _readCurrentAdState          monitor.js:1095
  → evaluatePeriodic / evaluateDailyEnable   ad-switch-orchestrator.js:47 / :64
  → decideAdSwitchAction         ad-switch-decision.js:76
  → AdSwitchOrchestrator.runSwitchAction + createSwitchSerialGate
       ad-switch-orchestrator.js:181 / switch-serial.js:74
  → ChengfangRunner.executeChengfang*Batch  chengfang-runner.js:300 / :385
  → executeChengfangPause/Enable           chengfang-executor.js:70 / :1180
  → confirmLanding + refreshView           chengfang-executor.js:457 / :466 / :835 / :968
  → _mapSwitchReturn / _commitExecutedBatch monitor.js:1274 / :1134
  → _saveState(switchSlots)                monitor.js:248 / :261
```

### 1.1 当前状态读取（**缺陷**）

| 路径 | 位置 | 行为 |
|------|------|------|
| `opts.readAdState` | `monitor.js:72,1096` | **仅测试注入** |
| 乘方 scope 且未注入 | **`monitor.js:1106–1107`** | **直接 `return { state: 'unknown' }`，不读全店托管/商品自选** |
| 否则 | `monitor.js:1110–1117` | `listAllAds` + `mapAdStateFromAdList`（旧广告清单，**不是**乘方双 UI） |

**源码可确认**：生产默认 **不会** 读取乘方「全店托管 + 商品自选」开关状态；决策 `currentAdState` 恒为 unknown → 零动作。fixture 测试因注入 `readAdState` 而掩盖此缺口。

---

## 2. 动作与执行器

| 规则 | 证据 | 结论 |
|------|------|------|
| below → enable | `monitor.js:1411–1412` → `_runShopSwitchAction('enable')` | 源码可确认 |
| above → pause | `monitor.js:1406` | 源码可确认 |
| mixed 只动对侧 | pause 仅 `switchChecked===true`（executor `:219,357`）；enable 仅 `false`（`:1235,1364`） | **源码可确认** |
| equal / unknown / 不完整清单 / 身份失败 | decision `data_blocked`/`unknown_blocked`/`equal_no_action`；清单 error→blocked | 源码可确认 |
| 双 UI / 分页 / 刷新回读 | 全店托管+商品自选；`refreshView` `:466,:835,:968,:1642`；`confirmLanding` `:457` | **复用既有实现**（源码可确认） |

---

## 3. 调度与恢复

| 项 | 证据 | 结论 |
|----|------|------|
| 周期低阈值开启 vs 07:00 窗口 | `executeChengfangEnableBatch` **仅** `[enableHour, dailyStartHour)`（runner `:406–410`）；周期巡查在 08:00 后 → **恒 `blocked_window`** | **缺陷**：周期 `SHOULD_ENABLE` 被 07:00 开启窗口错误拦截 |
| 周期开启 vs「每日已 success」 | `SHOULD_ENABLE` 走 `_runShopSwitchAction`，**不**经 `_enablePhaseDone`（`:1411` vs `:1565`） | 源码可确认：**不会**被每日成功错误拦截 |
| 值守时间窗口 | pause：`isAfterDailyStart` runner `:310`；enable：`:406` | 保留 |
| 07:00 与周期同店锁 | 同一 `createSwitchSerialGate` / shopId（monitor `:158`；orchestrator 同 gate） | 源码可确认 |
| stop/cancel/异常/重启误释放 unknown | `markNotSent` 仅 in-flight；unknown 仅 `resolveUnknownAfterReadback(confirmed===true)`（switch-serial `:192–:207`）；重启未结束→unknown（`:78–:92`） | 源码可确认：**不会**误释放 |
| 持久化写失败仍发动作 | `_saveState` 失败仅 `log.warn`（monitor `:248` 一带），`_setEnablePhase`/执行继续 | **缺陷**：写失败不阻断动作 |

---

## 4. bill-manager 集成

| 位置 | 问题 |
|------|------|
| `bill-manager/watch-drill.js:249,535` | 文案 **「未超标，不暂停乘方」** — 未覆盖 below→开启、mixed、already_on/off |
| `watch-drill.js:253,711`；`index.html:1243` | 仅 `over/under` 二分「超标/未超标」，**无** decision / zeroClick / mixed / not_sent |
| `watch-drill.js:548–561` `describeTrigger` | **已**只认 `targetAction`（enable/pause）；缺失→「未知动作/待核实」— **无** enable→pause 误标（源码可确认） |
| `watch-drill.js` 状态 `conclusionText:711` | 同上，enable/混合/阻止/未知无法识别 |
| `douyin-promo-guard/integrations/bill-manager/watch-drill.js` | **另一副本**；未同步覆盖（按要求） |

测试：`bill-manager/tests/watch-drill.test.js` 覆盖 `targetAction` 与「未超标」旧文案；**未**覆盖 mixed / below-enable / zeroClick。

---

## 5. 覆盖与缺口

| 层级 | 内容 |
|------|------|
| **源码可确认** | mixed 只动对侧；串行门不误释放 unknown；07:00 与周期共用锁；pause 窗口；describeTrigger 显式 targetAction |
| **fixture 验证** | 448 条隔离套件（含 decision/integration）；**均注入 `readAdState` / mock execute** |
| **尚未验证** | **生产默认乘方状态读取**；周期 08:00 后真实 enable；bill-manager 对 mixed/开启文案；真实页面 / 07:00 真机 |

---

## 6. 明确缺陷与最小修复范围（待主脑裁决）

1. **P0** `monitor.js:1106–1107`：乘方默认状态读取写死 `unknown` — 须读全店托管+商品自选开关（复用 executor `readView`/`refreshView`，勿新写 Playwright）  
2. **P0** `chengfang-runner.js:406` + `monitor.js:1411`：周期 `SHOULD_ENABLE` 在 08:00 后被 enable 窗口拒绝 — 为低阈值开启定独立窗口/门槛（产品裁决）  
3. **P1** `monitor.js` `_saveState` 失败仍继续 execute — 建议 fail-closed 阻断新动作  
4. **P1** `bill-manager/watch-drill.js:249,535,253,711` + `index.html:1243`：补 decision/mixed/开启/阻止/未知文案（与 integrations 副本分开维护）

**无缺陷（证据见上）**：mixed 执行器筛选；unknown 不释放；同店串行锁；`describeTrigger`；pause 时间窗。

---

## 7. 尚未完成

- 未改任何代码；未跑测试；未碰 bill-manager 副本同步  
- 真实页面 / 生产加载 / 07:00 真机  

完成后停止，等待主脑裁决。  
报告路径：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase17-readonly-chain-audit.md`
