# 交付报告 —— 乘方推广值守（交接修复 + 3443 接入真实操作模式）

- 交接提交：`12d59855a9d82afae0f9364d9316552bb8b79dbc`
- 本地路径：`C:\Users\Administrator\Documents\ChatGPT\推广广告控制`
- 3443 后端：`C:\Users\Administrator\Documents\电商助手\bill-manager\watch-drill.js`
- 日期：2026-09-15（第三轮定点修复，基于 Codex 复核 R2）
- 基线：`a64675d`（第二轮已推送）
- 状态：**代码与测试完成；见第 5 节「运行服务加载状态」（重要事实说明）**

---

## 0-R16. 第十六轮定点收尾（2026-09-16）：轮询语义 / 停止语义 / 暂停侧核查 / 会话 Cookie 回写

> 基线 `7416d2aab57dd1b60960238c6cdb25ce73f0ebf5`（= origin/main，`git ls-remote origin main` 已核验）。
> **本轮不重做项目**；生产门槛配置未改动；**未启动暂停值守**；**本轮无任何真实广告动作**。
> 完整背景与接手要点见 `HANDOFF.md` 第十六轮（最新段落）与 `WORK_BUDDY_HANDOFF.md` 末尾。

### 1) 修复证据与旧代码失败的回归

| 修复项 | 旧行为（基线 `7416d2aa`） | 回归用例（新代码 61/61，旧代码失败） |
| --- | --- | --- |
| 暂停侧落地确认 | 点击后**一次立即回读** → 平台异步落地（实测 27s+）被误判失败 | `暂停异步落地延迟（slow-landing）…` |
| 暂停侧托管开关 | 同上；且超时未知后存在重复点击风险 | `暂停侧托管开关异步落地：等待真实翻转后确认关闭，绝不因超时不明反向切换` |
| 停止语义 | 落地轮询检测到停止后**直接 return**，已派发请求不再确认 | `停止语义：开启…` / `停止语义：暂停…` / `停止语义优先：…` |
| 状态未知 | 目标行消失未区分"未知"与"未落地" | `状态未知：落地确认期间目标行消失 → 不视为确认关闭，且绝不重试` |
| 读取失败 | 无轮询结果可查，失败原因不可分辨 | `落地确认期间读取失败：结果未知，不重试、不谎报成功` |
| 重试前核验 | 无此步骤（只走普通请求门槛） | `重试前重新核验真实状态…`（断言 `retry-precheck`/`retry-skipped` 审计） / `重试前门槛重新核验…` |

- **回归方法**：`git worktree add <tmp> 7416d2aa` 检出基线，仅替换新测试文件与 fixture，
  运行**生产执行器/控制器**（非替代实现）；不触碰生产 `data`/`state`/`audit`，不加载真实广告操作。
- **结果**：基线代码 `test/chengfang-executor.test.js` **52/61（9 个新用例全部失败）**；
  当前代码 **61/61**。日志：`evidence/old-code-executor-regression.log`。
- **本轮自查修复的一处自身缺陷**：`confirmLanding` 最初把业务时钟 `now` 当轮询时钟 →
  预算永不耗尽、轮询死循环（两个新用例曾挂死 70s+）。现轮询一律 `Date.now`，
  业务 `now` 仅用于上海时段/跨日；`bounded-poll` 另加硬性迭代上限兜底。

### 2) 实际生效的轮询配置

- 唯一有效来源：`execution.readbackTimeoutMs` / `execution.readbackIntervalMs`，
  **生产实际加载值 = 30000 / 3000**（`config/config.json` 与 `src/config.js` DEFAULTS 已对齐，
  `config/config.example.json` 同步）。
- 语义：**按实际截止时间**有界（不是 次数×间隔），读取串行不重叠，至少读取一次；
  停止后不再重试/不再发新请求，已派发请求在有限期限内只读确认。
- 页面/状态展示：`gates.polling = {timeoutMs:30000, intervalMs:3000, timeoutSource:'execution.readbackTimeoutMs', intervalSource:'execution.readbackIntervalMs'}`
  （与执行器同源解析 `src/lib/bounded-poll.js`，**无独立 fallback 数值**）。
  实测 `/api/watch-drill/state` 返回上述值（见第 5 节）。
- 共享说明：`readbackAttempts`（次数语义）**仅** `close-flow.js` 使用；`readbackTimeoutMs` 同时被
  close-flow 复用为**单次读取超时**（15s→30s 只会更耐心）。

### 3) Cookie 保存 / 冲突保护 / 下次加载结果（不含任何值）

- 新模块 `src/login/cookie-writeback.js`；接线 `qianchuan-reader` → `chengfang-reader` →
  `defaultChengfangOpener` → `ChengfangRunner._closeSession` → `batch.cookieWriteback` →
  `Monitor.lastCookieWriteback` → `getStatus().monitor.cookieWriteback` → 页面「Cookie 回写」栏。
- 触发条件（全部满足才写）：`mode==='execute'` 且 `writeback!==false` 且身份核验通过，
  且浏览器关闭**之前**。演练周期、无 context、身份未通过 → 不写。
- 保护：原子写入（临时文件 + fsync + rename）；失败保留旧文件；登录失效/身份不符/空或非法
  Cookie/缺少 `jinritemai.com` 关键域/条数塌缩（<60%）→ 拒绝覆盖；**冲突保护**（会话开始时记录
  size+mtimeMs+sha256，回写前重比对，源文件在会话期间被改动 → 保留较新文件、不做无依据合并）；
  写入后自校验（条数/域名形状）不一致 → 原子回滚。
- **下次加载结果**：单测 `正常回写…` 断言"写入后按该文件加载读到的就是本次保存结果"
  （`inspectCookieFile` 条数/域名一致）——**用临时文件与合成 Cookie 验证**，未触真实凭据。
- **不含值**：返回值/审计/`/api/watch-drill/state`/页面只含结果、条数、域数、域名、字节数、时间；
  测试对返回值与审计做了逐条 Cookie 值泄漏断言（`assert.ok(!dump.includes(c.value))`）。
- **未实测**：真实店铺 Cookie 文件上的回写尚未发生（需真实 execute 批次）。

### 4) 测试数量与退出码

| 范围 | 结果 |
| --- | --- |
| 主项目 `npm test` | **329/329 通过，退出码 0**，428.1s（基线 290 → 329，+39） |
| `test/chengfang-executor.test.js` | **61/61**，exit 0，432.1s |
| `test/bounded-poll.test.js`（新） | **11/11** |
| `test/cookie-writeback.test.js`（新） | **16/16** |
| `test/watch-drill-tab.test.js` | **13/13**（10 → +3） |
| `integrations/bill-manager/watch-drill.test.js` | **62/62**（58 → +4），exit 0，25.1s |
| 基线 `7416d2aa` 上运行新执行器回归 | **52/61**（9 个新用例失败，作为修复证据） |
| `npm run check` | 通过（真实执行模式；阈值 100 分/单；1 家店铺；Cookie 条数 65） |

新增用例合计 **43** 个（执行器 +9、bounded-poll +11、cookie-writeback +16、watch-drill-tab +3、
集成值守 +4）。

### 5) Git 提交与远端核验

- 开工核验：本地 HEAD = `7416d2aa…`；`git ls-remote origin main` = `7416d2aa…` → 基线已推送、工作区干净，无需备份提交。
- 本轮提交与推送结果见下方"本轮实测"。
- 未上传：凭据、`config/config.json`（`.gitignore` 第 5 行）、日志、`data/`、`evidence/`、浏览器数据。

### 6) 生产服务加载 / 独立每日任务 / 暂停值守

- 重启前：PID `37876`（`netstat` + `.server.lock` 双源一致），`running=false`、`cycleNo=0`、
  开启相位 `waiting_window` → 业务空闲；旧进程**未**加载本轮 `src` 改动（`state` 无 `polling` 字段）。
- 重启后：新 PID **25788**（双源一致），`/api/watch-drill/state` = 200，含
  `polling {30000,3000,execution.readbackTimeoutMs,execution.readbackIntervalMs}` 与 `cookieWriteback: null`
  → **确认新代码已加载**。
- 独立每日开启：`enableTask.running=true / phase=waiting_window / nextRunAt=2026-09-16T23:00:00Z`
  （= 2026-09-17 07:00 上海）；`enablePhaseToday` 沿用持久化的 2026-09-16 记录（status=unknown）。
- 暂停值守：`running=false`（**本轮未启动**，按要求）。
- ⚠️ 环境限制：沙箱禁止 `wscript`/`cmd`/`schtasks`，无法从会话内启动"脱离进程树"的服务；
  当前 3443 由**会话后台任务**启动，**尚未交还给开机启动项**（`Startup\电商助手服务.vbs`）。
  请注销/重新登录或手动双击该 VBS，使其恢复为常规常驻进程。

### 7) 真实动作与回读结果

- **本轮真实广告动作数 = 0**（未开启、未暂停、未删除；未在 07:00 窗口外补开整店；
  未为测试反复开关整店）。所有测试均作用于本地 DOM fixture / 注入桩。
- 因此**没有真实回读结果**可报告。

### 8) 仍待观察（未发生的真实验证）

- 「点击 → 异步落地 → 确认」的**真实链路**未实测（本轮零真实动作）。
- **会话 Cookie 回写**在真实店铺文件上的效果未实测（无 execute 批次即不触发）。
- 2026-09-17 07:00 的每日开启：若所有对象**本来已开启**，幂等跳过**只证明调度与回读有效**，
  不能称为验证了「点击→异步落地→确认」，也不能验证 Cookie 回写。
- 3443 进程的常驻性待用户确认（见第 6 节环境限制）。
- 页面「落地回读 / Cookie 回写」两栏的真机显示未人工目视核对（静态片段已由 VM 测试覆盖）。

---

## 0-R3. 第三轮 4 项定点修复（针对 CODEX_REVIEW_WORKBUDDY_R2，全部落地）

> 复核输入：`evidence/CODEX_REVIEW_WORKBUDDY_R2.md`（+ `.cjs`/`.json` 复现脚本）。
> 机器可读验证：`node evidence/codex-workbuddy-r3-verify.cjs` → `evidence/codex-workbuddy-r3-verify.json`（summary.allOk=true）。

### R3-1 接通生产事件到值守日志（auditDelivery）

- **旧行为**：`Monitor._audit` 只追加审计文件；runner/executor 的 retry/paused/view/
  identity/abort/done 过程事件**从未进入** `getEventStream` → `/logs` 看不到重试与回读
  （复核实测 `forwardedEvents=0`）。
- **修复**：
  - `monitor.js`：`_audit` **双写**（审计文件 + `processEvents` 事件流，带显式
    `evtType:'process'`）；全部 5 个事件数组（triggers/actions/recentErrors/judgements/
    processEvents）统一带 `evtSeq` + `evtType`（25 处调用补标）。
  - **trigger 字段隔离**：触发记录 `actionType/action` → `targetAction`（将来时），
    消除「开启演练 trigger 被误判为 unknown 批次」的根因。
  - `watch-drill.js`：分派改为**按显式 `evtType`**（judgement/trigger/batch/process/error），
    不再靠字段形状猜测；新增 `describeProcess` 过程事件转译
    （retry→重试 / paused→暂停 / view,readback→回读核验 / *enable*→开启相位）；
    `describeBatch` 从 `targets` **对象数组**提取稳定 ID（`planId`/`adId`），
    修复 `ID [object Object],[object Object]`。
- **真实链路测试（不是手工填 error 文本）**：`第 1 项真实链路：生产 runner/executor 的
  「首次未落地→重试→回读」经 _audit 进入 /logs` —— 生产 `executeChengfangPause` +
  生产 controller + 本地 fixture 页面（`pauseEffect:'first-noop'`，route 拦截不触真实站点），
  实际触发「首次未落地 → 同会话重试 → 回读确认」，断言 executor 的 `audit` 经
  `Monitor._audit` 进入事件流（`event:'retry'` 存在）且经 `/api/watch-drill/logs` 可见
  「过程：重试」。
- **回归测试**：另增 trigger 归类（不得显示 `批次结果：unknown`）与 `[object Object]` 2 例。

### R3-2 修正模式与门槛展示（dryRunGate / preStartDisplay）

- **旧行为**：`computeGates` 只算 `realMode && 开关`，**不含 dryRun** → 三开关全开 +
  `dryRun=true` 时页面显示「会执行」，而执行器（chengfang-gate）实际拒绝（展示与执行不一致）；
  首次启动前 `gates=null`、`realMode=false` → 用户误以为「必然演练、安全」。
- **修复**：
  - `monitor.js` 新增 **`gatePreview()`**：直接复用 `resolveChengfangRealAllowed` /
    `resolveChengfangEnableAllowed`（含 `execution.dryRun === true` 拒绝分支），与
    `buildChengfangRequestGate` 同源。
  - `watch-drill.js` `computeGates()`：`pauseWillExecute`/`enableWillExecute` 由
    **真实许可**决定（运行中经 `m.gatePreview()`，未启动时直接 require 同一份
    `chengfang-gate.js`）；透出 `dryRun`/`pauseGateReason`/`enableGateReason`/`blockedBy`。
  - `snapshot()`：**首次启动前也读配置展示真实模式**（`loadConfigReadOnly()` 只读
    `loadConfig()`，不 new Monitor、不启动调度/浏览器/广告）；未知模式 `modeText`
    显示「待核实（配置缺少 execution.realMode…）」，**不默认宣称演练安全**。
- **回归测试（直接断言结果）**：`第 2 项：三许可开关全开 + dryRun=true → 两个
  WillExecute 必须为 false`（并与 `buildChengfangRequestGate` 交叉核对同源一致）；
  `第 2 项：首次启动前也读取配置展示真实模式（不启动调度/浏览器/广告，timers=0）`；
  `第 2 项：未知模式显示"待核实"`。
- **复核实测值**（`evidence/codex-workbuddy-r3-verify.json`）：三开关 true + dryRun=true →
  `pauseWillExecute=false, enableWillExecute=false`，reason=
  `execution.dryRun=true（演练模式，禁止真实暂停）`，与执行器 gate 完全一致。

### R3-3 修正日志缺口计数（droppedCounts）

- **旧行为**：`_evtDropped.length > 50 → splice` 直接丢弃更早区段计数 →
  写 1000 条、保留 300 条，实际缺失 700，`droppedCount` 只报 50。
- **修复**：
  - `_evtTrimmedTotal`（累计裁剪总数，单调，永不自减）+ `_evtDropped` 仅存未合并尾部区段
    （上限 50，超出时**最旧区段 count 累加进 total**，绝不静默丢弃）；
  - `_mergeDroppedRanges()`：相邻/重叠区段合并（`firstSeq <= lastSeq+1`）；
  - `getEventStream(since)`：`droppedCount = trimmedTotal + 未消费区段计数`，并引入
    **报告锁定**（`_evtAckSeq` WeakMap）：区段一经报告，不因消费者游标随后越过而消失、
    也不重复计数 —— 任何读取顺序（直读 / 先消费再查 / 重复查）都得到同一真实缺口。
  - `watch-drill.js` `latestGap()`：直接用 `getEventStream().droppedCount`（日志正则仅兜底）；
    `/logs` 顶层新增 `droppedCount` 字段；`gap=null` 表示「无缺口」（契约不变）。
- **回归测试**：`第 3 项：写 1000 条、留 300 条 → 缺口必须报 700`（HTTP 顶层字段同步断言）；
  `第 3 项：连续多次裁剪 + 重复拉取 + 部分已消费 + 继续接收新事件`（200 留 50 → 150；
  再写 300 → 累计 450；重复拉取幂等；新事件继续接收）。
- **复核实测值**：`{added:1000, retained:300, actualMissing:700, reportedDirect:700,
  reportedAfterConsumeCross:700, reportedOnRepeat:700, stableAcrossReadOrder:true}`（旧值 50）。

### R3-4 同步公开仓库发布内容（publicRepo）

- `integrations/bill-manager/watch-drill-tab.html`：
  - 标题「推广值守演练 / 只读演练 · 不操作广告」→「推广值守」+ **动态模式徽标**
    （真实执行=红 / 演练模式=绿 / 未知=「模式待核实」黄，不默认宣称演练安全）；
  - 新增「实际门槛」栏（真实暂停/开启 会执行/不会执行 + realMode/开关/dryRun 状态 +
    被哪道门槛拦住的原因）；
  - 新增「日志缺口」警示条（按 `gap.droppedCount` 显示丢失条数）；
  - 底部规则说明改为「07:00 开启全部乘方；08:00 后每 30 分钟检查…以实际门槛为准；
    绝不存在删除广告的代码路径」，删除「强制演练」过期表述。
- `integrations/bill-manager/README.md`：删除「本模块强制只读，任何配置组合下都不操作广告」；
  新增业务规则（07:00/08:00/严格超过 1 元/单/绝不删除）、fail-closed 安全边界
  （dryRun 双重保险、门槛与执行器同源、开启弹窗未实测阻断、日志 scrub）。
- `config/config.example.json`：新增 `monitor.chengfang` 段（scope/pauseEnabled/
  enableEnabled/enableHour 及说明）；`execution.dryRun_说明`（双重 fail-closed）；
  **删除**「乘方（overall）控制对象未定位」过期说明；顶部 `_说明` 更新为当前值守语义。
- 同步副本：`watch-drill.js`、`watch-drill.test.js`（45 用例版）已复制入
  `integrations/bill-manager/`。**只同步值守相关片段，不含电商助手其他业务、凭据或真实配置。**

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

### R3（第三轮，本次）实测结果 —— 2026-09-15 18:2x

| 项目 | 结果 |
|---|---|
| **推广控制 `npm test` 全量** | **265/265 通过**（含 monitor.js 第三轮改动） |
| **`npm run check`** | **通过**（配置齐全；演练模式；生产开关未改动） |
| **bill-manager `tests/watch-drill.test.js`** | **45/45 通过**（38 → 45，新增 7 例） |
| **`evidence/codex-workbuddy-r3-verify.cjs`** | **item1/2/3/4 全 true（summary.allOk=true）** |

R3 新增 7 例（bill-manager）：
1. `第 1 项：开启演练 trigger 不得被误归类为批次（evtType=trigger，不显示 unknown 批次）`
2. `第 1 项：目标 ID 不得渲染为 [object Object]（对象数组 → 提取稳定 planId）`
3. `第 1 项真实链路：生产 runner/executor 的「首次未落地→重试→回读」经 _audit 进入 /logs`
   （**生产 executor + 本地 fixture 页面 + 生产 controller**，route 拦截，不触真实站点）
4. `第 2 项：三许可开关全开 + dryRun=true → 两个 WillExecute 必须为 false（复用实际许可，含 dryRun）`
5. `第 2 项：首次启动前也读取配置展示真实模式（不启动调度/浏览器/广告）`
6. `第 2 项：未知模式显示"待核实"，不得默认宣称演练安全`
7. `第 3 项：写 1000 条、留 300 条 → 缺口必须报 700`；`第 3 项：连续多次裁剪+重复拉取+部分已消费+继续接收新事件`

原 38 例中 1 例升级：`六类日志齐备` 的 targets 改为**对象数组**（生产真实形状），
过程事件改走真实 `_audit` 入口；新增 `[object Object]` 禁用断言。

### 推广控制项目（第二轮历史）
| 测试文件 | 结果 |
|---|---|
| `test/chengfang-confirm-switch.test.js`（**21 → 28 用例**） | **28/28 通过** |
| `test/monitor-chengfang.test.js` | **30/30 通过** |
| `test/chengfang-dom.test.js` | **15/15 通过**（第 6 例期望值随契约更新） |
| **`npm test` 全量（265 用例）** | **265/265 通过**（降并发 4 复核亦全绿） |
| **`npm run check`** | **通过**（配置齐全；店铺 1 家；阈值 100 分/单） |

> 测试总数演进：交接基线 237 → 上一轮 258（+21）→ **本轮 265**（乘方四套 124 + 其余 141）。
> `test/chengfang-confirm-switch.test.js` 由 21 → **28**（新增 fail-closed 7 例）。

> ⚠️ **已知测试抖动（非本轮引入）**：13 个测试文件**全并发**运行时，
> `test/close-flow.test.js` 的「回归 #7：超时后底层请求延迟完成…」偶发失败
> （该用例用 260ms 延迟 vs 200ms 超时的真实计时窗口，高负载下计时器抖动）。
> 隔离运行 3 次均 17/17 通过；降并发（`--test-concurrency=4`）全量亦全绿。
> 该文件与本轮改动**无关**，交由 Codex 复核时可留意（建议 CI 固定并发度）。

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

1. **R3 引擎层运行时确证**：3443 进程内 `src/engine/monitor.js` 的 `_audit` 双写 /
   `gatePreview` / 缺口合并是否已随 18:21:23 的重启加载，需触发一次真实轮询才能
   外部确证；本会话按约束不启动值守、不操作真实广告，故未验证。
2. **3443 页面 UI 未验证**：本会话只同步了仓库快照 `integrations/bill-manager/
   watch-drill-tab.html`；3443 实际服务页面（电商助手 `index.html` 的 Tab 片段）
   是否已更新为新 UI 未检查（不属本轮范围，且需重启才生效）。
3. **真实开启弹窗结构未实测**：`clickRowSwitch(expectAction: 'shop_enable')` 遇非预期弹窗即阻断，
   待实盘实测后补充分类规则。
4. **端到端实盘未执行**：07:00 自动开启、08:00 后超标暂停、回读确认、有限重试的**真实链路**
   未在真实页面跑通（按要求：实现与测试期间不启动值守、不自行开启真实广告）。
5. **异常路径实测**：真实页面上「部分成功→同会话重试」「回读未知→不重发」的实际表现未验证
   （本地已用生产 executor + fixture 页面覆盖：`第 1 项真实链路` 用例）。
6. **3443 重启后的隔离验证**：重启后接口/UI 是否影响电商助手其他 Tab（票据/商品分析/微信群/自动上架）未做。
7. **商品自选 >100 条的分页实测**：代码已实现（100 条/页 + 分页穿透 + `activePage` 核验），
   真实 >100 条场景未验证。

---

## 5. ⚠️ 服务实际加载状态（关键，R3 复核后更新）

### R3 结论（2026-09-15 18:2x 实测）

**运行中的 3443（PID 18920）已返回第三轮新契约字段** —— 即页面/接口层已经加载了
本会话写入的新版 `watch-drill.js`：

```
GET /api/watch-drill/state →
  realModeKnown: true | modeText: "演练模式（不操作广告）"
  gates.blockedBy: ["realMode 未开启","execution.dryRun=true（演练）","暂停开关未开启","开启开关未开启"]
  gates.pauseGateReason: "execution.realMode 未开启（演练模式不执行真实暂停）"
  gates.configuredRealMode: false | gates.dryRun: true
GET /api/watch-drill/logs?since=0 →
  droppedCount: 0 | gap: null | confirmDialogs.shop_enable: false（开启弹窗仍阻断）
```

以上字段（`blockedBy`/`pauseGateReason`/`modeKnown`/`droppedCount`）均为本会话
18:13 写入磁盘后才存在的代码路径。

**重要事实说明（如实报告）**：
- `.server.lock` 显示当前服务进程 PID `18920` 于 **18:21:23 CST** 启动
  （第二轮报告时为 PID 18916 的旧只读版）。
- **本会话全程没有执行任何重启/进程操作**（只有只读 `curl` 与 `netstat` 检查；
  所有测试均在独立 node 进程内）。18:21:23 的服务（重新）启动**不是本会话所为**，
  时间在本会话编辑文件之后。谁在何时以何种方式重启，需要用户侧核实
  （可能是用户/其他会话/看护脚本所为）。
- 需要区分的两层状态，**分别列出**：
  - **代码已验证**：推广控制 265/265 + bill-manager 45/45 + `npm run check` +
    `evidence/codex-workbuddy-r3-verify.cjs` 全部通过（见第 3 节）。
  - **运行服务已加载**：PID 18920 的 3443 接口已返回第三轮新契约字段
    （gates/blockedBy/modeKnown/droppedCount/confirmDialogs）→ 接口层新代码已生效。
    但 **3443 进程内的 `Monitor` 引擎层**（`src/engine/monitor.js` 的 `_audit` 双写、
    `gatePreview`、缺口合并）属于 `PROMO_GUARD_DIR` 的模块，`require` 缓存**在进程启动时
    固化**：若 18:21:23 重启发生在 monitor.js 定稿（18:0x）之后，则引擎层亦为新版；
    **这一点无法从外部接口完全确证**（引擎行为需触发真实轮询才可见，本会话按约束
    不启动值守验证）。保守结论：接口层=新版已确证；引擎层=大概率新版（时间戳支持）、
    未运行时确证。
  - **真实页面已验证**：**未验证**。本会话未打开 3443 页面 UI（`watch-drill-tab.html`
    只同步了仓库快照；3443 实际服务页面 `index.html` 是否已切到新 UI 未检查、
    未截图、未验证），且未启动值守、未触发任何真实轮询。

### 生产开关状态（R3 复核）

- `npm run check`：**配置齐全；运行模式=演练模式（只记录不关闭）**；
  数据源 费用=qianchuan / 订单=compass / 广告清单=qianchuan。
- `/api/watch-drill/state`（运行服务）：`gates.blockedBy` 四道门槛全部拦截
  （realMode 未开启 / dryRun=true / 暂停开关未开启 / 开启开关未开启）→
  **真实暂停与真实开启均不会执行**；`confirmDialogs.shop_enable=false` /
  `batch_enable=false`（未知开启弹窗仍阻断，绝不盲点确定）。

### 第二轮历史记录（当时状态，供对照）

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

### 6.0 第三轮定点修复（本次，R3）

**推送记录**：`a64675d..f46ff2e`（2026-09-15 19:11 CST，PUSH_EXIT=0，1m33s 完成）。
提交仅含上述 7 个安全文件；远端 HEAD 已确认为 `f46ff2e1db524697746a55eca467f7de61e51dc4`。

**推广控制项目**
```
 M src/engine/monitor.js                (_audit 双写 processEvents + evtType 打标 25 处 +
                                         trigger→targetAction 4 处 + gatePreview +
                                         _evtTrimmedTotal/_mergeDroppedRanges/_evtAckSeq +
                                         getEventStream 重写 + getStatus.processEvents)
 A evidence/codex-workbuddy-r3-verify.cjs (R3 机器可读验证脚本)
 A evidence/codex-workbuddy-r3-verify.json (验证结果：item1/2/3/4 全 true)
 M config/config.example.json           (新增 monitor.chengfang 段 + dryRun_说明 +
                                         删除"乘方控制对象未定位"过期说明)
 M integrations/bill-manager/README.md  (删除"强制只读"；新增业务规则 + fail-closed 边界)
 M integrations/bill-manager/watch-drill-tab.html (动态模式徽标 + 实际门槛栏 + 日志缺口条 +
                                         删除"只读演练"过期表述)
 M integrations/bill-manager/watch-drill.js       (同步第三轮副本)
 M integrations/bill-manager/watch-drill.test.js  (同步 45 用例版)
 M DELIVERY_REPORT.md                   (本报告 R3 章节)
```

**电商助手 bill-manager（本地，未入公开仓库）**
```
 M watch-drill.js                       (evtType 分派 + describeProcess + computeGates 复用
                                         chengfang-gate 含 dryRun + snapshot 预启动读配置 +
                                         latestGap 用 droppedCount + /logs.droppedCount)
 M tests/watch-drill.test.js            (38 → 45 用例，新增 R3 回归 7 例)
```

### 6.1 第二轮修复（已提交并推送到公开仓库）

**提交记录（origin/main，`https://github.com/flamebird07/douyin-promo-guard`）**
```
4afaa18 docs(handoff): append round-2 fix summary (7 items + test totals)
6ac1d77 chore(handoff): sync 3443 watch-drill backend + tests (round 2)
1996e15 fix(guard): fail-closed dialog detection + event-seq cursors + live gates
```

**推广控制项目**
```
 M .gitignore                          (+9 排除探针与工作记忆目录)
 M src/adapters/chengfang-reader.js    (第 5 项 fail-closed：submitConfirmIfPresent / clickRowSwitch)
 M src/engine/chengfang-runner.js      (第 4 项 dry 路径显式 actionType)
 M src/engine/monitor.js               (第 1/3/4 项 evtSeq + cycleNo + judgements + actionType)
 M src/engine/chengfang-executor.js    (上一轮恢复核验 + 有限重试)
 M test/chengfang-dom.test.js          (上一轮契约同步)
 A test/chengfang-confirm-switch.test.js (21 → 28 用例，新增 fail-closed 7 例)
 A DELIVERY_REPORT.md                  (本报告)
 M package.json                        (test 脚本纳入新测试文件)
```
**3443 后端（bill-manager）—— 同步副本入 `integrations/bill-manager/` 供复核**
```
 M watch-drill.js                 (第 1/2/3/4/6/7 项：evtSeq 游标 + 六类日志 + actionType + 门槛实时 + confirmDialogs)
 M tests/watch-drill.test.js      (20 → 38 用例)
 M WORK_BUDDY_HANDOFF.md          (追加第二轮交接说明)
```

**未入库（本地只读/敏感，已由 `.gitignore` 排除）**
```
config/config.json、data/、logs/、evidence/、cookies/*.json、*.jsonl
test/probe-*.js（本地探针）、.workbuddy-ai/（工作记忆）
```

合计（第二轮）：`9 files changed, 1903 insertions(+), 108 deletions(-)`（核心修复提交）。

---

### 6.2 上一轮（交接 6 项）变更（当时状态）

**推广控制项目**
```
 M src/adapters/chengfang-reader.js   (真实开关 + 确认弹窗闭环)
 M src/engine/chengfang-executor.js   (恢复核验 + 有限重试)
 M src/engine/monitor.js              (开启持久化 + 调度修复)
 M test/chengfang-dom.test.js         (契约同步)
 M package.json                       (test 脚本)
 A test/chengfang-confirm-switch.test.js
```

**电商助手 bill-manager**
```
 M watch-drill.js                     (装配 Monitor，真实操作模式)
 M server.js                          (3 处注释/说明)
 M index.html                        (Tab 改名 + 模式徽标 + 门槛明细)
 M tests/watch-drill.test.js          (重写)
备份：backups/watch-drill.js.bak-20260915-124526 等
```

---

## 7. 遵守的约束

### 第三轮（R3，本次）—— 全部遵守

- ✅ **未重启 3443**：本会话未执行任何进程操作（只有只读 `curl`/`netstat`/`stat` 检查）。
  `.server.lock` 显示当前 PID 18920 启动于 18:21:23 CST（非本会话所为，来源需用户核实，
  见第 5 节）。
- ✅ **未启动值守**：真实链路用例在独立测试进程内用本地 fixture 页面（route 拦截）+
  注入 `audit` 回调，未启动生产值守调度。
- ✅ **未操作真实广告**：所有 Playwright 点击只作用于本地 fixture 页面；
  运行服务 `gates.blockedBy` 显示四道门槛全部拦截。
- ✅ **保留未知开启确认弹窗阻断规则**：`confirmDialogs.shop_enable/batch_enable=false`
  保持不变；生产控制器 fail-closed 测试（28 例）全部通过；**全程零删除点击**
  （删除弹窗 fail-closed + 测试断言 deleteClicks===0）。
- ✅ **未修改生产开关**：`npm run check` 复核为演练模式；config.json 未改动。
- ✅ **只同步相关页面片段**：公开仓库仅更新值守 Tab 片段/README/配置示例模板，
  不含电商助手其他业务、凭据、真实配置或运行日志。

### 第二轮（用户明确禁止清单）—— 全部遵守

- ✅ **未重启 3443**：仍为 PID `18916`，`netstat` 实测 `0.0.0.0:3443 LISTENING 18916`；
  接口实测仍返回 `forcedDrill:true` 且**无 `gates`**（确证仍是旧只读版，未加载新代码）。
- ✅ **未启动值守**：全程未调用真实 `start` 链路；`Monitor.start()` 仅在测试进程内、用注入只读适配器。
- ✅ **未修改生产三开关**：`config.json` 未改动（`realMode=false` / `pauseEnabled=false` / `enableEnabled=false`，
  `npm run check` 复核为「演练模式」）。
- ✅ **未点击真实广告**：所有 `page.evaluate` 点击均作用于 `page.setContent` 注入的本地 HTML fixture；
  测试结束后 `browser.close()`，无残留浏览器实例（仅有 IDE 自带的 `msedgewebview2.exe` 与用户自有 Edge 窗口）。
- ✅ **未点击删除**：删除弹窗检测为 fail-closed，且测试断言 `deleteClicks === 0`、`okClicks === 0`。
- ✅ **未通过批量结束 node/Edge 清理**（未终止任何进程）。
- ✅ **推送仅含安全源码与交接文档**：远端已复核**不含** Cookie、token、运行日志、真实配置
  （仅 `config/config.example.json` 模板）、证据文件、`.bak`、探针脚本。

### 上一轮同时遵守

- ✅ 未删除任何广告（`deleteAdEnabled: false` 为常量；删除弹窗零点击有测试覆盖）。
- ✅ 未上传秘密（Cookie 未记录、未提交；日志统一 scrub）。
- ✅ 重启共享 3443 前先检查业务状态并报告影响（第 5 节），未擅自重启。
- ✅ 保留工作区已有未提交文件（探针脚本未动，仅加入 `.gitignore`）。
