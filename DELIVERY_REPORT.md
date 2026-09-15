# 交付报告 —— 乘方推广值守（交接修复 + 3443 接入真实操作模式）

- 交接提交：`12d59855a9d82afae0f9364d9316552bb8b79dbc`
- 本地路径：`C:\Users\Administrator\Documents\ChatGPT\推广广告控制`
- 3443 后端：`C:\Users\Administrator\Documents\电商助手\bill-manager\watch-drill.js`
- 日期：2026-09-15（第二轮修复）
- 状态：**代码与测试完成；3443 未重启，运行中的服务仍是旧只读版（详见第 5 节）**

---

## 0. 第二轮 7 项修复（本次新增，全部落地 + 回归测试）

> 旧行为 → 修复位置 → 回归测试（测试名）。测试总数见第 3 节。

### ① 日志增量游标：禁止基于有界数组长度

- **旧行为**：`watch-drill.js` 用 `drill._lastActionsSeen = list.length` / `_lastTriggersSeen` /
  `_lastErrorSeen` 作为游标。Monitor 的 `triggers`/`actions`/`recentErrors` 是**有界数组**
  （封顶后从头部裁剪），一旦裁剪，`list.length` 不再增长 → 游标永远停在旧值，
  **新事件永久漏日志**；或索引整体前移导致**重复日志**。
- **修复位置**：
  - `src/engine/monitor.js`：`_memPush` 为每条事件附加**单调递增 `evtSeq`**（进程内全局唯一、
    永不回退）；裁剪时把被丢弃区段记入 `_evtDropped`；新增 `getEventStream(since)`。
  - `bill-manager/watch-drill.js`：游标改为 `_lastEvtSeq`，按 `evtSeq > lastSeq` 增量消费，
    与数组长度完全解耦；`/logs` 返回 `evtSeq`/`consumedEvtSeq`/`gap`。
- **覆盖事件类型**：触发（triggers）、批次（actions）、错误（recentErrors）、重试与回读
  （随批次 `outcome`/`confirmReason`/`remaining`）、每日开启（enablePhase）、失败事件（error）。
- **超缓存缺口**：轮询期间发生裁剪时，依据 `dropped` 记录一条
  「日志缺口：…共丢失 N 条事件（序号 a-b）」，**随后继续同步**，不静默错位。
- **回归测试**：
  - `增量游标：超过 100 条动作后仍能持续接收最新事件（不因数组封顶而永久漏日志）`
  - `增量游标：>50 条错误与 >50 条触发后，最新事件仍可到达日志`
  - `增量游标：事件被裁剪（超缓存）时记录明确日志缺口，并继续同步后续事件`

### ② 六类日志必须真实进入 3443 日志

- **旧行为**：判断日志只在「数据变化」时输出；重试/回读结论只在审计文件，`/api/watch-drill/logs`
  看不到。
- **修复位置**：`monitor.js` 新增 `judgements[]` 事件流；`watch-drill.js` 统一经
  `getEventStream` 转译，批次事件携带 `confirmReason`（回读）与 `error`（失败/重试原因）。
- **回归测试**：`六类日志齐备：每日开启、每轮判断、暂停、重试、回读、失败原因都能经 /api/watch-drill/logs 取到`

### ③ 每个完整巡查周期都记录一次判断

- **旧行为**：`syncFromMonitor` 用 `changed`（费用/订单与上一轮比较）作为记录条件 →
  连续两轮数据相同时**没有判断日志**，无法证明「每 30 分钟确实巡查了」。
- **修复位置**：`monitor.js` 新增 `cycleNo`（每次 `pollOnce` +1）与 `_emitJudgement`，
  在 `data.ok===false` 与正常判定两条路径上**无条件**调用；`judgements` 每周期恰好一条。
  `watch-drill.js` 的 `roundNo` 改为跟随 `Monitor.cycleNo`。
- **回归测试**：
  - `判断数据日志：连续两轮数据完全相同 → 仍然各有两条判断日志（不以"数据变化"为条件）`
  - `周期号正确递增：roundNo 跟随 Monitor.cycleNo（每个完整巡查周期 +1）`

### ④ 批次结果必须带显式 `actionType`/`action`

- **旧行为**：`describeBatch` 用 `a.allEnabledConfirmed === true || /enable/i.test(String(a.outcome))`
  反推动作类型。**部分开启、开启失败、每日开启演练**会被误写成「暂停」（危险误导）。
- **修复位置**：
  - `src/engine/chengfang-runner.js`：`runDryCycle` 三个 return 加 `actionType:'pause'`；
    `runDryEnableCycle` 三个 return 加 `actionType:'enable'`。
  - `src/engine/monitor.js`：`_summarizeBatch` 显式输出 `actionType`/`action`，
    判定顺序 `batch.actionType → …Confirmed → dryEnableRun/dryRun → actionTypeHint → 'unknown'`；
    三处 `_recordBatch` 调用点显式声明。
  - `watch-drill.js`：`actionKindOf` 只认显式字段；缺失即 `unknown`（如实报「未知动作」），
    **禁止文本推断**。
- **回归测试**：
  - `actionType 显式传递：outcome 含 "enable" 字样但 actionType=pause → 仍标为暂停（不按文本猜测）`
  - `actionType 显式传递：部分开启（partial）必须标为"开启"，绝不误写为"暂停"`
  - `actionType 显式传递：开启失败（failed）必须标为"开启"并记录失败原因`
  - `actionType 缺失（unknown）→ 如实报"未知动作"，绝不按结果文本猜测为暂停/开启`
  - `演练开启（dry enable）必须写"将开启"，绝不误写为"暂停"`

### ⑤ 所有危险弹窗检测必须 fail-closed

- **旧行为**：
  - `submitConfirmIfPresent`：`page.evaluate(hasChengfangDeleteDialogInPage).catch(() => ({found:false}))`
    —— **读取异常被吞成"无弹窗"**，于是继续走到提交逻辑。
  - `clickRowSwitch`：删除/危险弹窗检测 `.catch((e) => ({ error: String(e) }))` —— 异常既不阻断
    也不抛错，仅当作「没有弹窗」继续点击业务开关。
- **修复位置**：`src/adapters/chengfang-reader.js`
  - `submitConfirmIfPresent`：删除弹窗检测改为 `try/catch` 并在异常时
    `throw new DataGuardError(删除弹窗检测失败，停止提交（读取异常，绝不视为无弹窗）)`。
  - `clickRowSwitch`：两处检测改为 `try/catch` → 异常时在**任何业务点击派发之前**
    抛 `DataGuardError`（此时零业务点击）；检测返回非列表也阻断。
  - 复核：`clickBatchPause`/`clickBatchEnable`/`detectDanger`/`hasDeleteDialog` 均已是
    fail-closed（不 catch 成"无弹窗"）。
- **回归测试**（推广控制 `test/chengfang-confirm-switch.test.js`）：
  - `fail-closed：clickRowSwitch 删除弹窗检测抛错 → 抛 DataGuardError 且零业务点击`
  - `fail-closed：clickRowSwitch 危险弹窗检测抛错 → 抛 DataGuardError 且零业务点击`
  - `fail-closed：clickBatchPause 检测抛错 → 抛 DataGuardError 且零业务点击`
  - `fail-closed：clickBatchEnable 检测抛错 → 抛 DataGuardError 且零业务点击`
  - `fail-closed：submitConfirmIfPresent 删除弹窗检测抛错 → 不当作"无弹窗"，抛错`
  - `fail-closed：删除弹窗在页面上时，clickBatchPause/Enable 均阻断且不点确定`
  - `fail-closed：detectDanger/hasDeleteDialog 读取异常必须抛出，不返回空列表`
  - 断言均为：`switchClicks/pauseClicks/enableClicks/deleteClicks/okClicks === 0`。

### ⑥ 门槛展示与实际执行条件一致

- **旧行为**：`gates` 只在 `ensureMonitor()` 装配时取一次，**之后永不更新**。运行中修改
  `realMode`/`pauseEnabled`/`enableEnabled` 后，页面仍显示旧的「会执行/不会执行」，
  与实际 gate 不一致（用户可能以为不会操作广告，实际会）。
- **修复位置**：`watch-drill.js` 抽出 `computeGates()` + `refreshGates()`；
  `syncFromMonitor()` 每轮**重新读取当前 Monitor 配置**（含实时 `Monitor.realMode` getter）并刷新
  `state.gates`；门槛变化时记一条「门槛已变化（运行中配置变更）」日志。
  `pauseWillExecute`/`enableWillExecute` 由**实时** realMode 与开关共同决定。
- **回归测试**：
  - `门槛实时性：运行中修改 realMode/pauseEnabled/enableEnabled 后，state 与 logs 立即反映且与实际 gate 一致`
  - `门槛与 dryRun 一致：dryRun 开启时页面不得显示"会执行"真实操作`

### ⑦ 开启确认弹窗未实测 → 保持保守阻断

- **旧行为/风险**：为实现功能而把未实测的「开启」确认弹窗放宽到「盲点确定」。
- **修复位置**：保持保守——`submitConfirmIfPresent` 中 `shop_enable`/`row_toggle` 不在
  `KNOWN_ACTIONS` 内，出现任何确认弹窗即抛 `DataGuardError`；`watch-drill.js` 对外暴露
  `confirmDialogs = { batch_pause: true, batch_enable: false, shop_disable: true, shop_enable: false }`
  （`false` = 未实测 = 阻断），`/logs` 与模块属性均可查询。**未因测试而放宽**。
- **回归测试**：
  - `第 7 项：开启类确认弹窗仍未实测 → 界面契约明确标注为阻断（false），且不得盲点确定`
  - `第 7 项：生产控制器对"开启"未知确认弹窗必须阻断（复核，不经测试放宽）`

### 日志安全（贯穿）

- **回归测试**：
  - `日志安全：/logs 输出不得含 Cookie/token/敏感参数（含被 Monitor 事件透传的情况）`
  - `日志安全：state 与 logs 响应均不含 cookie 文件路径以外的凭据内容`

---

## 1. 交接 6 项修复（全部落地）

### ① 真实开关（内层 `.ovui-switch`，非外层 `.oc-switch`）
文件：`src/adapters/chengfang-reader.js`

- 新增自包含 `resolveChengfangRowSwitchHandleInPage(planId)`；`locateChengfangRowSwitchInPage` /
  `clickChengfangRowSwitchByPlanId` 重写为**完全自包含**（`page.evaluate` 序列化后不引用任何模块级符号）。
- 定位规则：行 `.oc-switch` 恰好 1 个 → 其内层 `.ovui-switch[data-e2e="switch"]` 恰好 1 个
  （退化取 `.ovui-switch`）→ **点击内层**；数量不为 1 即拒绝点击。
- ID **全等核验**：`/ID[:：]\s*([0-9]{6,24})/`，杜绝 `123` 误命中 `12345`。

### ② 确认弹窗闭环
文件：`src/adapters/chengfang-reader.js`

- 新增纯函数 `classifyDialogText(text, expectedAction)`（Node 端单测用）+ 自包含内联版
  `classifyDialogTextInPage`（浏览器端用）。
- 重写 `detectChengfangDangerDialogInPage` / `readChengfangConfirmDialogInPage` /
  `clickChengfangConfirmOkInPage({ action, expectedCount })` / `hasChengfangDeleteDialogInPage`。
- 优先级：**删除弹窗最高优先级阻断** → 批量暂停精确匹配 `/确定要暂停\s*(\d+)\s*条计划吗/`
  → 托管关闭 `/确定关闭乘方投放吗/` → 其他含「确定/确认」一律 `unknown_confirm` 阻断。
- 控制器新增内部 `submitConfirmIfPresent({ page, expectedAction, expectedCount, timeoutMs = 800 })`：
  读弹窗 → 类型/数量核验 → `fireBeforeDispatch` 再校验 → 点确定。
  `KNOWN_ACTIONS = ['batch_pause','batch_enable','shop_disable']`，`row_toggle`/`shop_enable` 遇弹窗即阻断。

### ③ 每日开启持久化
文件：`src/engine/monitor.js`

- 删除内存 `_lastEnableDate`，改为 `enablePhase[shopId][date] =
  { status: 'in_progress'|'success'|'failed'|'unknown'|'dry_done', at, phase, reason }`。
- `_loadState`/`_saveState` 读写 `enablePhase`（原子写 + 损坏隔离）；保留 30 天。
- 新增 `_reconcileEnablePhaseOnBoot()`：重启时 `in_progress` → `unknown`（先回读，绝不盲目重发）。
- `_enablePhaseDone(shopId, date)` **仅 `success` 视为当日完成**；`failed`/`unknown` 允许窗口内重处理。

### ④ 调度问题（相位后用执行后时间重算）
文件：`src/engine/monitor.js`

- `_intervalLoop` 开启窗口分支改为按店铺查 `_enablePhaseDone`；执行后用 `afterMs = this.nowFn()` 重算：
  - 跨日（`afterWall.date !== w.date`）→ 回环重算；
  - 未到 dailyStartHour 且 `waitMs > 0` → `delayFn(waitMs)` 进入暂停巡查等待；
  - 已到/已过 → **不等待，直接进入暂停巡查**（修复慢执行导致首轮巡查延后）。

### ⑤ `restoreManagementPageForReadback` 补全恢复核验
文件：`src/engine/chengfang-executor.js`

- goto 后**先点「商品」标签**（25s 轮询 `verifyIdentity`）→ `switchView(wantTab)` →
  商品自选确保 **100 条/页**并核验 `pageSize` / `activePage` / `total`
  （字段名是 `activePage`，非 `pageNo`）→ 身份二次核验。
- `total > 100 && pageNo == null` 时阻断；身份不匹配阻断（不得仅导航掩盖账户变更）。

### ⑥ 同会话有限重试（覆盖部分成功/未知）
文件：`src/engine/chengfang-executor.js`

- 从「仅全失败才重试」改为：`failed.length > 0` 且 `retryAttempt === 0` 时，
  **仅对未落地目标** `retryTargets = targets.filter(t => failed.includes(t.id))` 同会话重试一次
  （不反向切换、不扩范围）。
- `notFound.length > 0`（行消失 = 状态未知）→ **不盲重发**，直接判 `V_PARTIAL_FAILED`。

---

## 2. 3443 接入真实操作模式

### `watch-drill.js`（重写，21.6 KB → 新实现）
**设计要点：不再自研只读调度，改为进程内装配推广控制 `Monitor`**，本模块只做
「装配 + 日志转译 + HTTP 暴露」。这样 3443 与 CLI 走**同一份经过测试的链路**，不会出现两份实现漂移。

- 复用：`src/engine/monitor.js`（Monitor）/ `chengfang-runner.js` / `chengfang-executor.js` /
  `guard.js` / `rules.js` / `time.js` / `money.js`。
- HTTP 契约保持不变：`/api/watch-drill/{start,stop,state,logs}`（`index.html` 无需重构即可用）。
- `snapshot()` 新增字段：`gates`（fail-closed 门槛快照）、`enablePhaseToday`、`phase`、
  `windowBlockReason`、`businessDate`、`clock`。
- `gates` 内容：`realMode` / `pauseEnabled` / `enableEnabled` / `scope` / `enableHour` /
  `dailyStartHour` / `intervalMinutes` / `pauseWillExecute` / `enableWillExecute` /
  **`deleteAdEnabled: false`（常量，永不删除广告）**。
- **日志覆盖用户点名六项**：
  - **开启**：`每日开启相位：开启成功/执行中/失败/结果未知`；
  - **判断数据**：`判断数据：费用 X 元，订单 N 单，每单 Y；整数分判定 A 分 ≶ N×100 分 → 超标/未超标`；
  - **暂停**：`暂停批次结果：<outcome>（已确认…失败…未知…）；目标 N 条（ID …）`；
  - **重试**：由 Monitor 的 retry 审计透出（同一批次结果内体现未落地目标重试）；
  - **回读**：`回读核验：<confirmReason>`；
  - **失败原因**：`失败原因：<error> [code]（scope）` 与 `命中处理失败：…`。
- **fail-closed 不被绕过**：本模块**不提供任何**修改 `realMode`/开关的入口；
  真实操作仍须推广控制 `config.json` 同时满足 `execution.realMode=true` +
  `monitor.chengfang.pauseEnabled`（暂停）/ `enableEnabled`（开启）。日志会如实说明被哪道门槛拦住。
- 重启语义：服务重启后 `running=false`（页面如实显示"未启动"）；页面加载**不自动启动**；
  日志有界持久化到 `watch-drill-logs.jsonl`，可恢复查看。
- 日志安全：统一 scrub，绝不记录 Cookie/令牌；单行上限 2000 字符。

### `server.js`
- 3 处注释/说明更新（模块引入、实例创建、路由分支），去掉「强制只读」措辞。

### `index.html`
- Tab 名：「推广值守演练」→ **「推广值守」**。
- 移除固定「只读演练 · 不操作广告」徽标，改为**动态模式徽标**：
  演练模式 → 「演练模式 · 不操作广告」；真实模式 → 「真实执行 · 会操作广告」或
  「真实执行 · 但开关未全开，暂不会操作」。
- 新增**门槛明细行**：`realMode / 暂停开关 / 开启开关` + `真实暂停：会/不会执行` +
  `真实开启：会/不会执行` + 控制范围 + `删除广告：永不执行`。
- 新增两格：**今日开启（乘方）**、**调度 / 下次触发**（含 windowBlockReason）。
- 规则说明更新为：07:00 开启 / 08:00 后每 30 分钟 / 严格超过 1 元/单 / 绝不删除广告。

---

## 3. 测试证据

### 推广控制项目
| 测试文件 | 结果 |
|---|---|
| `test/chengfang-confirm-switch.test.js`（**新建**，21 用例） | **21/21 通过** |
| `test/monitor-chengfang.test.js` | **30/30 通过** |
| `test/chengfang-dom.test.js` | **15/15 通过**（第 6 例期望值随契约更新） |
| **`npm test` 全量（258 用例）** | **258/258 通过** |
| **`npm run check`** | **通过**（配置齐全；店铺 1 家；阈值 100 分/单） |

> 注：`npm test` 原脚本未包含新建的 `chengfang-confirm-switch.test.js`，
> 已同步加入 `package.json` 的 `test` 脚本，使新覆盖真正进入 CI
> （总数 237 → **258**，即新增 21 例）。

新建测试覆盖：弹窗分类纯函数、danger 检测（含删除弹窗优先级）、确认读取/点击、
内层开关点击与 ID 全等核验、多容器/内层缺失拒绝、真实控制器
`clickBatchPause`/`clickBatchEnable`/`clickRowSwitch` 各弹窗分支。

**契约变更说明**：`test/chengfang-dom.test.js` 原第 6 例断言 `unexpected_confirm`，
现按交接第 2 项契约改为 `unknown_confirm`（未识别弹窗一律阻断，绝不按其文案盲点"确定"），
并追加校验保留弹窗原文 `text`。

### 电商助手 bill-manager
| 测试文件 | 结果 |
|---|---|
| `tests/watch-drill.test.js`（**第二轮扩充**，**38 用例**） | **38/38 通过** |
| `tests/*.test.js` 合计（含 auto_publish_proxy） | **46/46 通过** |

新测试覆盖：默认未启动/不自动启动、门槛快照（fail-closed，全关/半开两态）、
启停幂等、重启语义与日志恢复、启动日志规则说明、**判断数据日志（恰好 1.00 元/单不超标、
严格超过即超标）**、失败原因入日志、暂停/开启批次转译（含计数/回读/失败原因）、
HTTP 契约、scrub 敏感信息、JSONL 落盘。

**第二轮新增（第 1/3/4/6/7 项回归）**：
- 增量游标：>100 条动作持续接收、>50 条错误/>50 条触发后仍见最新事件、超缓存时明确日志缺口
- 连续两轮相同数据 → 两条判断日志；`roundNo` 跟随 `Monitor.cycleNo` 严格递增
- `actionType` 显式传递 5 例（文本不推断 / 部分开启 / 开启失败 / 缺失报未知 / 演练开启写"将开启"）
- 六类日志经 `/api/watch-drill/logs` 齐备性；`/logs` 增量与缺口契约
- 门槛实时性 2 例（运行中改开关立即反映；与 `dryRun` 一致）
- 第 7 项 2 例（未实测开启弹窗保守阻断，含生产控制器复核）
- 日志安全 2 例（`/logs` 与 `/state` 不含 Cookie/token/Bearer）

**第二轮新增（推广控制 fail-closed，`test/chengfang-confirm-switch.test.js`）**：
28 用例（原 21 + 新增 7），全部断言注入检测异常后
`switchClicks/pauseClicks/enableClicks/deleteClicks/okClicks === 0`。**全程不触网、不操作真实广告**（注入只读适配器 + 临时占位 cookie）。

---

## 4. 未验证事项（交由 Codex 复核）

1. **真实开启弹窗结构未实测**：`clickRowSwitch(expectAction: 'shop_enable')` 遇非预期弹窗即阻断，
   待实盘实测后补充分类规则。
2. **端到端实盘未执行**：07:00 自动开启、08:00 后超标暂停、回读确认、有限重试的**真实链路**
   未在真实页面跑通（按要求：实现与测试期间不启动值守、不自行开启真实广告）。
3. **异常路径实测**：真实页面上「部分成功→同会话重试」「回读未知→不重发」的实际表现未验证。
4. **3443 重启后的隔离验证**：重启后接口/UI 是否影响电商助手其他 Tab（票据/商品分析/微信群/自动上架）未做。
5. **商品自选 >100 条的分页实测**：代码已实现（100 条/页 + 分页穿透 + `activePage` 核验），
   真实 >100 条场景未验证。

---

## 5. ⚠️ 服务实际加载状态（关键）

**运行中的 3443 仍是旧的只读演练版，新代码未生效。**

证据：
- 监听进程：`PID 18916`（`netstat` 确认 `0.0.0.0:3443 LISTENING 18916`，与 `.server.lock` 一致）。
- 实测其接口 `/api/watch-drill/state` 返回：
  ```
  HTTP 200
  state keys: shopName,forcedDrill,running,status,statusText,roundNo,
              startedAt,stoppedAt,lastCheckAt,nextRunAt,lastError,lastRound
  forcedDrill: true
  gates: undefined      ← 新代码才有 gates 字段
  realMode: undefined
  ```
  → 运行中实例返回 `forcedDrill: true` 且**无 `gates`**，确证加载的是**旧只读版**。

**新代码已全部落盘，必须重启 3443 才会加载。**

**重启影响（按要求先检查业务状态后报告）：**
- 检查时刻 `/get-process-status` = `{"running":true,"billRunning":false,"shopRunning":true,"douyinRunning":true,"autoRunning":true}`
  → **店铺分析 / 自动上架任务正在运行**，现在重启会**中断在途任务**。
- **故未擅自重启**，等待确认时机。

**另一个重要事实**：旧只读版在 2026-09-15 12:31 CST 已实测到超标
（`费用52.36元，订单46单，每单约1.14元；5236分 > 46×100分=4600分，超标`），
因只读而**未执行任何操作**。这正是新真实模式会动作的条件 ——
说明「配置门槛」与「真实执行」之间需要人工确认切换。

**重启前需人工确认的三件事**：
1. 确认时机不会打断在途的店铺分析/自动上架任务；
2. 确认推广控制 `config.json` 中 `execution.realMode` 与
   `monitor.chengfang.pauseEnabled` / `enableEnabled` 的目标状态（重启后即按此生效）；
3. 确认 07:00 开启 / 08:00 暂停的首次真实执行可接受。

**当前配置实测（2026-09-15 复查）**：三个开关**全部为 false**
（`realMode=false` / `pauseEnabled=false` / `enableEnabled=false`），
`enableHour=7` / `dailyStartHour=8` / `intervalMinutes=30` / `thresholdCents=100`。

**非破坏性 fail-closed 验证（已实测通过）**：用**生产 config** 装配新版 `watch-drill`，
仅调用 `start()` 装配 Monitor + 读取门槛（不启动调度、不发起任何广告操作），结果：

```
realMode         : false
pauseEnabled     : false
enableEnabled    : false
pauseWillExecute : false     ← 不会执行真实暂停
enableWillExecute: false     ← 不会执行真实开启
deleteAdEnabled  : false     ← 永不删除广告
scope            : ["全店托管","商品自选"]
enableHour       : 7 | dailyStart: 8 | interval: 30
status           : 检查中（演练模式（只记录不关闭））
```

→ **结论：即使现在重启 3443，也只会进入演练模式，零广告操作。**
重启的唯一风险是**打断在途业务任务**（与广告操作无关）。

---

## 6. 变更文件清单

**推广控制项目（未提交，工作区改动）**
```
 M src/adapters/chengfang-reader.js   (+555/-…   真实开关 + 确认弹窗闭环)
 M src/engine/chengfang-executor.js   (+140/-…   恢复核验 + 有限重试)
 M src/engine/monitor.js              (+207/-…   开启持久化 + 调度修复)
 M test/chengfang-dom.test.js         (+6/-3     契约同步)
 M package.json                       (test 脚本加入新测试文件)
?? test/chengfang-confirm-switch.test.js   (新建 357 行，21 用例)
?? test/probe-enable.js / probe-restore.js (预存探针，未提交/未删除)
?? DELIVERY_REPORT.md                      (本报告)
?? .workbuddy-ai/                          (工作记忆)
```
合计：5 文件改动，`809 insertions(+), 99 deletions(-)`，+1 新建测试文件。

**电商助手 bill-manager**
```
 M watch-drill.js     (重写为真实操作模式，装配 Monitor)
 M server.js          (3 处注释/说明)
 M index.html         (Tab 改名 + 模式徽标 + 门槛明细 + 新增状态格)
 M tests/watch-drill.test.js (重写，20 用例)
备份：
 backups/watch-drill.js.bak-20260915-124526
 backups/watch-drill.test.js.bak-20260915-*（重写前）
```

---

## 7. 遵守的约束

- ✅ 未启动值守、未自行开启真实广告（全程未调用 `start` 真实链路；测试用注入适配器）。
- ✅ 未删除任何广告（`deleteAdEnabled: false` 为常量；删除弹窗零点击有测试覆盖）。
- ✅ 未上传秘密（Cookie 未记录、未提交；日志统一 scrub）。
- ✅ 重启共享 3443 前先检查业务状态并报告影响（第 5 节），未擅自重启。
- ✅ 未通过批量结束 node/Edge 清理（未终止任何进程）。
- ✅ 保留工作区已有未提交文件（2 个探针未动）。
