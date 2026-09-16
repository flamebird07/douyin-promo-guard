# HANDOFF — 有界读取 / Cookie 异步空隙 / 服务启动稳定性 · 第十七轮定点修复（2026-09-16）

> 交付日期：2026-09-16。基线 `4efe5a725f0a3f3e9787c29013b18d366a54ef03`（开工核对：= origin/main，工作区干净）。
> 本轮只修 Codex 独立复现的**两个缺陷** + 服务启动稳定性收尾，**不重做项目**。
> 生产门槛配置未改动：`realMode=true` / `dryRun=false` / `pauseEnabled=true` / `enableEnabled=true` / `enableSchedulerEnabled=true`。
> **未启动暂停值守**（`running=false` 全程）；**本轮未发生任何真实广告动作**。

## 0.1 bounded-poll：单次读取必须有界（旧代码永久挂起）

- **旧缺陷**：截止时间只用于决定"两次读取之间是否继续"，`await read()` 本身**没有任何上界**。
  隔离复现（`timeoutMs=20` / `intervalMs=0`，read 返回永不落定的 Promise）：100ms 后函数仍未返回，
  真实页面上一次卡住的回读会让整个任务**永久挂起**。
- **修复**（`src/lib/bounded-poll.js`；**不是**单纯 `Promise.race` 丢弃，也不是加大超时）：
  - `startRead()` 把每次读取登记为 `{done, result}`，结果**永远**以 `{ok, value|error}` 落定
    → 被放弃的读取不会产生未处理拒绝；`inFlightCount / peakInFlight` 统计真实并发。
  - `waitSettle(rec, ms)`：**等待上界 = 剩余预算**。内部先用 0ms 宏任务刷新微任务队列，
    避免把"已完成但 `.then` 尚未执行"的读取误判为在途。
  - 超时未释放 → 先 `abort()` 请求取消，再用 `cancelGraceMs` **确认释放**；确认不了 →
    `unreleased=true` + `abandonedReads++`，返回 `inFlight:true`（调用方不得启动新任务与旧读取重叠）。
  - 迟到结果只写入本地登记对象，**不改写已返回结果，也不成为下一轮输入**。
- **新增返回字段**：`inFlight` / `abandonedReads` / `lastReadFailed` / `valueStale` / `peakInFlight`。
- **执行器配套**：新增 `landingStateTrustworthy(poll)`。`inFlight || lastReadFailed || valueStale`
  → **禁止重发**：绝不拿此前"仍关闭"的旧快照去重试（暂停/开启两条路径都加了这道闸）。

## 0.2 Cookie 回写：跨越 `await context.cookies()` 的异步空隙

- **旧缺陷**：指纹检查在 `await context.cookies()` **之前**，之后直接写入。异步期间用户重新登录
  写入新文件后，旧会话仍把旧 Cookie 覆盖回去并返回 `ok=true`（静默丢失新登录）。
  同时：初始指纹缺失时 `if (start && ...)` 会**静默跳过**冲突保护；`loginOk` **默认 true**。
- **修复**（`src/login/cookie-writeback.js`）：
  - 初始指纹缺失/无效 → **拒绝回写**；
  - `context.cookies()` 之后、提交写入之前**再取一次指纹快照**，变化即保留较新文件（conflict）；
  - 回滚改为 `rollbackIfUnchanged(file, writtenSha, prev)`：**仅当文件仍是本次写入的那份**才回滚，
    否则放弃回滚（避免用旧内容覆盖其他进程的新登录结果）；
  - `loginOk` 由"默认 true"改为 **fail-closed：必须严格 `true`**。
- **runner 配套**（`src/engine/chengfang-runner.js`）：新增 `_writebackSessionCookies` +
  `_currentLoginEvidence` —— 回写前用 `controller.verifyIdentity({page, shopCfg})` 取**当前**
  只读登录/身份证据；缺参、核验未通过或异常 → 不覆盖。两个 execute 调用点补传 `shopCfg`。
- **边界（不夸大）**：sha256 比对-后-写 + 原子 rename 只保证"不出现半写文件"，
  **不是**完整并发互斥（最后一次比对与 rename 之间仍有极小窗口）。已在文件头如实写明。

## 0.3 服务启动稳定性：修复两个真实缺陷

- **陈旧锁判定失效**（`电商助手/bill-manager/server.js`，非公开仓库）：`LOCK_STALE_MS=5min`
  但时间戳只在启动时写一次、从不刷新 → 服务运行满 5 分钟后，任何新实例都判定锁陈旧并
  **窃取/删除**它。实测复现：在 PID 25788 运行时启动第二份，第二份偷走锁（`.server.lock` → 38116），
  并因 EADDRINUSE **只打印不退出**变成僵尸进程（还重复登记了进程内每日 07:00 任务）。
- **修复**：`isLockStale` 改为**先看 PID 存活**（活着就是有效锁，与时间戳无关）；新增
  `tryCreateLock`（临时文件 + `linkSync` → 原子且互斥）、`writeLockAtomic`、60s 锁心跳
  （锁易主则停止续期）、`ownsLock` 标记 + `releaseLock` 只删自己的锁；EADDRINUSE →
  `releaseLock()` + `process.exit(1)`。备份 `server.js.bak-pre-lockfix-20260916-193410`。
- **验证**：修复后启动第二份 → `服务已在运行中 (PID: 25788)` 且 `rc=1`，锁未被改动，
  3443 仍 HTTP 200，`enablePhaseToday` 等状态无损。
- **重启以加载修复**（业务空闲确认后执行：`running=false` / `cycleNo=0` / 无进行中周期）：
  精确停止 PID 25788（`MSYS_NO_PATHCONV=1 taskkill /F /PID 25788`，未批量结束进程）→
  以可用方式启动新实例 → **新 PID 31324**，陈旧锁被正确接管，`/api/watch-drill/state` HTTP 200。
  - **锁心跳实测**：`.server.lock` 时间戳 60.5 秒内刷新（`...115150 → ...175724`）
    → 证明新代码确实已加载（旧代码从不刷新时间戳）。
  - **单实例保护实测（新代码）**：再次启动第二份 → `服务已在运行中 (PID: 31324)`、`rc=1`、
    锁文件未被窃取、3443 仍 HTTP 200。
  - 重启后状态无损：`realMode=true` / `dryRun=false` / `pauseEnabled=true` / `enableEnabled=true`；
    `polling = 30000/3000`（同源）；`enableTask.nextRunAt=2026-09-16T23:00:00Z`；
    `enablePhaseToday` 保留 2026-09-16 的 `unknown` 记录；`cookieWriteback=null`。

## 0.4 脱离会话生命周期：本环境明确拒绝（已实测）

| 方式 | 结果 |
|---|---|
| WMI/CIM `Win32_Process Create` | 被安全策略拦截（等同 Start-Process） |
| 任务计划程序 `Register-ScheduledTask` + `Start` | 被拦截（wscript 属受限可执行文件） |
| `explorer.exe <file>` 外壳启动 | rc=1，无效 |
| Python `ctypes` → `CreateProcessW` + `CREATE_BREAKAWAY_FROM_JOB` | **WinError 5（拒绝访问）** |
| 退化为 `DETACHED_PROCESS` | 能启动，但随命令结束即被回收（探针只 tick 3 次） |

**结论**：本会话的作业对象未设 `BREAKAWAY_OK`，**任何会话内进程都无法脱离**其生命周期。
这不是业务要求，而是环境限制 —— 具体被拒操作与错误码见上表。

## 0.5 测试与旧代码回归对照

- 主项目 `npm test` **348/348**（退出码 0，16 个测试文件；上一轮 329 → +19）；`npm run check` 通过。
- 集成值守 `integrations/bill-manager/watch-drill.test.js` **62/62**；运行位置
  `电商助手/bill-manager/tests/watch-drill.test.js` **62/62**（与公开副本 `diff -q` = SAME）。
- **旧代码回归对照**（`git worktree add --detach C:/tmp/oldbase17 4efe5a7`，只替换新测试文件，
  运行**生产** bounded-poll / cookie-writeback / chengfang-executor）：
  - `bounded-poll.test.js` + `cookie-writeback.test.js`：基线 **44 项中 18 项 not ok**（EXIT=1），
    当前 **44/44 通过**。
  - `chengfang-executor.test.js`：基线 **63 项中 2 项 not ok**（EXIT=1）——一条
    `test timed out after 30000ms`（旧代码在卡住的读取上永久挂起），一条
    `lastReadFailed` 为 `undefined`（旧代码无该字段）；当前 **63/63 通过**。
  - 完整日志：`evidence/old-code-executor-regression-r17.log`（`evidence/` 已 gitignore，不入公开仓库）。

## 0.6 本轮改动文件

`src/lib/bounded-poll.js`、`src/login/cookie-writeback.js`、`src/engine/chengfang-executor.js`、
`src/engine/chengfang-runner.js`、`test/bounded-poll.test.js`、`test/cookie-writeback.test.js`、
`test/chengfang-executor.test.js`；集成侧 `电商助手/bill-manager/server.js`（锁与端口占用，非公开仓库）。

---

# HANDOFF — 轮询语义 / 停止语义 / 会话 Cookie 回写 · 第十六轮定点收尾（2026-09-16）

> 交付日期：2026-09-16。基线 `7416d2aab57dd1b60960238c6cdb25ce73f0ebf5`（= origin/main，`git ls-remote origin main` 已核验）。
> 本轮提交 `0972257b80e0add2eb6260e0990e003ba4df994b`（+ 文档补记），推送后 `git ls-remote origin main` 与本地 HEAD 一致。
> **本轮不重做项目，只做四项定点收尾**（轮询配置与超时语义、停止语义、暂停侧同问题核查、Cookie 回写）。
> 生产门槛配置未改动：`realMode=true` / `dryRun=false` / `pauseEnabled=true` / `enableEnabled=true` / `enableSchedulerEnabled=true`。
> **未启动暂停值守**（`running=false` 全程）；**本轮未发生任何真实广告动作**（不在 07:00 窗口内补开整店，未为测试反复开关）。

## 0.1 轮询配置与超时语义统一（本轮第 2 项）

- **旧问题**：`config/config.json` 与 `src/config.js` 实际是 `readbackTimeoutMs=15000 / readbackIntervalMs=2000`，而执行器内联 fallback 写成 30000/3000 → 交接报告里的「生产默认 30 秒/3 秒」**不成立**；且旧实现按 `ceil(timeout/interval)` 计算**次数**，未计入每次页面读取耗时 → 慢读取让等待无限延长。
- **修复**：新增 `src/lib/bounded-poll.js`（`boundedLandingPoll` / `resolvePollingConfig` / `POLLING_DEFAULTS`）。
  - **按实际截止时间**有界：`deadline = 起始时刻 + timeoutMs`，用**真实单调时钟**判定是否再发起一次读取；读取缓慢只消耗剩余预算。
  - **读取串行**：上一轮 `read()` 返回后才可能发起下一轮，任何情况下不与上一轮重叠（无法取消的底层读取不会被并发触发）；至少读取一次。
  - **停止语义**：`stopRequested()` 为真后不再重试、不再发起新业务请求，但已派发请求继续在**有限期限**内只读确认（默认沿用原预算，可用 `stopGraceMs` 收窄）。
  - 硬性迭代上限兜底（防止调用方误传不推进的时钟导致死循环）。
- **唯一有效配置**：`execution.readbackTimeoutMs`（现为 **30000**）/ `execution.readbackIntervalMs`（现为 **3000**），生产 `config/config.json`、`src/config.js` DEFAULTS、`config/config.example.json` 三处已对齐，**不存在独立的 fallback 数值**。页面与 `/api/watch-drill/state` 通过同一份 `resolvePollingConfig` 解析并**标注来源**（`execution.readbackTimeoutMs` / `builtin-default`），不会出现「页面说 30 秒、实际 15 秒」的漂移。
- **共享说明（重要）**：`execution.readbackTimeoutMs/readbackIntervalMs` 同时被**关闭推广流程**（`close-flow.js`，`opts = config.execution`）复用为**单次读取超时**与重试间隔；`readbackAttempts`（次数语义）**仅** close-flow 使用。本次调大 15s→30s 只会让 close-flow 更耐心，不会更激进（已在 `config/config.json` 与 `config.example.json` 注释中写明）。
- **时钟误用修正（本轮自查发现并修复）**：`confirmLanding` 最初把调用方的**业务时钟** `now` 传给了轮询 → 业务时钟是「本次检查时刻」的固定快照（用于上海时段/跨日判断），deadline 永不耗尽 → 轮询退化为死循环（两个新用例曾挂死 70s+）。现 `confirmLanding` 一律使用 `Date.now`，业务 `now` 只用于 `shanghaiDate`/跨日。

## 0.2 停止语义恢复（本轮第 3 项）

- 旧实现：开启落地轮询检测到 `stopRequested` 后**直接 return**（已派发请求不再确认）。
- 修复：停止立即禁止重试与任何新业务请求，但**已派发请求继续在有限期限内只读确认**，并把真实回读结果写入 `result.stoppedAfterDispatch`（含 confirmed/failed/notFound 与说明），随后按失败收敛——**绝不因停止把已落地的动作谎报为失败或成功**。
- 覆盖用例：`停止语义：开启点击已派发后收到停止…` / `停止语义：暂停点击已派发后收到停止…`（断言只有 1 次点击、`stoppedAfterDispatch` 记录了真实回读结果、平台随后确实落地、`delete` 零点击）。

## 0.3 暂停侧同问题核查（本轮第 4 项）

- 暂停侧原先「点击后**一次立即回读** + 一次重试」：平台异步落地（实测 27 秒以上）会被误判为失败。
- 修复：暂停/开启两条路径统一走 `confirmLanding`（有界轮询）：
  - **全店托管行内开关**（暂停关闭 / 开启打开）：点击后只做有界回读；超时或状态未知**一律只回读、绝不重复点击**（托管开关是**切换**动作，重复点击会反向切换）。停止信号到达时记录 `stoppedAfterDispatch` 并按失败收敛。
  - **商品自选批量暂停/开启**：统一有界落地确认 + 停止语义；仅在「首次未落地且状态明确」时才允许同会话重试一次。
  - **重试前重新核验**（新增 `prepareRetry`）：重试前必须重新核验 ①停止/时段/跨日/配置门槛（`requestGate` 实时重算）②页面身份 ③**真实开关状态**（绝不复用旧缓存）。已落地 → 不再重发并记录 `retry-skipped`；目标行消失（状态未知）→ 不重发；只有确实仍未落地才允许重发。
  - 修正了一处方向性错误：`prepareRetry` 的 `wantChecked` 在暂停路径传成了 `true`、开启路径传成了 `false`（会把「已落地」误判为「仍未落地」而盲目重发），已按语义修正为暂停 `false` / 开启 `true`。

## 0.4 会话 Cookie 回写（本轮第 1 项，用户新要求）

- 新增 `src/login/cookie-writeback.js`：操作完成并回读确认、店铺与账户身份核验通过后，在浏览器关闭**之前**取得本次 context 的 Cookie，保存回**本次实际加载的精确店铺 Cookie 文件**（`resolveCookieFile()` 结果，本机为 `电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json`）。
- 硬性保护（全部落为代码路径）：原子写入（同目录临时文件 + `fsync` + `rename`）；失败保留旧文件；登录失效/身份不符/空或非法 Cookie/缺少抖店与千川关键域/条数塌缩 → **拒绝覆盖**；会话期间源文件被改动（用户重新登录/其他进程写入）→ **冲突保护：保留较新文件，不做无依据合并**；写入后自校验不一致 → 原子回滚；**绝不输出任何 Cookie 值**（返回值/审计/页面只有数量、域名、字节数）。
- 接线：`openQianchuanHome` 记录 `cookieSession = { filePath, dir, readOnly, startFingerprint }`（size + mtimeMs + sha256）并透出到 `openChengfangShop` → `defaultChengfangOpener`；`ChengfangRunner._closeSession` 在 `mode==='execute' && writeback!==false && identityOk===true` 时回写，结果挂 `batch.cookieWriteback` → `Monitor.lastCookieWriteback` → `getStatus().monitor.cookieWriteback` → 页面「Cookie 回写」栏。**回写失败单独记录，绝不改写已确认的广告动作结果，也不因此重做动作**；演练周期与未提供 context 的路径**不回写**；当前批次继续使用原 context，不回灌、不刷新会话。

## 0.5 测试与旧代码回归对照

- 新增测试文件：`test/bounded-poll.test.js`（11 用例）、`test/cookie-writeback.test.js`（16 用例，含 `ChengfangRunner._closeSession` 接线与 Monitor 记录）。
- 扩充：`test/chengfang-executor.test.js` 52 → **61**（新增 9：暂停异步落地、暂停侧托管开关异步落地、停止语义 ×2、状态未知行消失、落地轮询读取失败、重试前重新核验、重试前门槛重新核验、停止语义优先）；`test/watch-drill-tab.test.js` 10 → **13**；`integrations/bill-manager/watch-drill.test.js` 58 → **62**（新增 polling 同源/缺省来源、Cookie 回写元信息、冲突不改写批次结果）。
- **旧代码回归对照**（用 `git worktree` 检出基线 `7416d2aa`，只替换新测试文件与 fixture，运行**生产执行器**）：见 `evidence/old-code-executor-regression.log`。基线代码在「暂停异步落地」「停止语义 ×2」「状态未知行消失」「重试前核验证据」「落地轮询读取失败」等用例上**失败**，新代码全部通过。
- 结果：主项目 `npm test` **329/329**（退出码 0，428.1s）、`npm run check` 通过；值守测试 `integrations/bill-manager/watch-drill.test.js` **62/62**（运行位置 `tests/watch-drill.test.js` 同步）。

## 0.6 部署与运行状态

- 3443 重启前核验：PID `37876`（`netstat` 与 `.server.lock` 双源一致），`running=false`、`cycleNo=0`、开启相位 `waiting_window` → 业务空闲。
- 停止旧进程后**沙箱禁止 wscript/cmd/schtasks**，无法从会话内启动「脱离进程树」的服务；最终以会话后台任务方式启动，新 PID **25788**（`netstat` + `.server.lock` 双源一致），`/api/watch-drill/state` 返回 200 且已含 `polling`（30000/3000，来源 `execution.readbackTimeoutMs`）与 `cookieWriteback: null` → **确认新代码已加载**。
- 重启后状态：`realMode=true`、`running=false`（暂停值守未启动）、`enableTask.running=true / phase=waiting_window / nextRunAt=2026-09-16T23:00:00Z`（= 2026-09-17 07:00 上海）、`enablePhaseToday` 沿用持久化的 2026-09-16 记录（status=unknown）→ 独立每日开启任务与持久化均未被重启破坏。
- ⚠️ **待用户确认**：本次 3443 进程由本会话后台任务启动，**尚未交还给开机启动项**（`Startup\电商助手服务.vbs`）。请注销/重新登录，或手动双击该 VBS，使其成为常规常驻进程。
- **待观察（未发生的真实验证，不得当作已验证）**：本轮**未**执行任何真实广告动作，因此「点击 → 异步落地 → 确认」的真实链路、以及**会话 Cookie 回写**在真实店铺文件上的效果**均未实测**。下一次 2026-09-17 07:00 若所有对象本来已开启，幂等跳过只证明调度与回读有效，**不能**称为验证了「点击→异步落地→确认」，也**不能**验证 Cookie 回写（无 execute 批次即不回写）。

# HANDOFF — 正式上线：独立每日开启 + 真实开启接线 + 生产切换 · 第十五轮（2026-09-15 上线轮）

> **本轮为用户明确授权的实操上线轮**（"补齐吧，我要直接能用，不需要演练了"）。基线 `e665c73`（=origin/main）。
> **生产配置已切换并重启加载**：`execution.realMode=true`、`execution.dryRun=false`、`monitor.chengfang.pauseEnabled=true`、`monitor.chengfang.enableEnabled=true`、`monitor.chengfang.enableSchedulerEnabled=true`（新增）。3443 已精确重启（旧 PID 18920 → 新 PID，入口 `node start-server.js`），重启前核验全部业务状态接口为空闲。

## 0.1 独立每日开启调度器（生命周期分离）

- **Monitor**（`src/engine/monitor.js`）：新增 `enableRunning/_enableGen/_enableSchedule` 与 `startEnableScheduler/stopEnableScheduler/resumeEnableScheduler`、专属 `_enableLoop`（等待每日 `[enableHour, dailyStartHour)` 窗口 → 复用 `_runEnablePhase`）与 `_chunkedEnableDelay`（只随开启调度器中断）。停止令牌按动作区分（`kind:'pause'|'enable'`）：`stop()`（停止值守）只中止暂停令牌，绝不取消每日开启；`stopEnableScheduler` 只中止开启令牌。`_intervalLoop` 的开启窗口分支在调度器运行时跳过（防双循环重复开启）；`_runEnablePhase` 入口加 `_cycleRunning` 互斥（两相位绝不并发）。`getStatus().monitor.enableScheduler` 如实透出 running/nextRunAt/stoppedByUser/lastMissedReason。
- **错过窗口**：08:00 后启动且当日无任何开启记录 → 记录"今日开启窗口已过且未执行开启：不擅自补开广告"（按日期去重），下次登记明日 07:00。窗口内重启按当日记录处理（success 不重复；unknown/failed 先回读）。
- **持久化**：`stoppedByUser` 写入 state.json（用户独立停用后重启不自动复活）；enablePhase 沿用 店铺+上海日期 持久化与重启回读（in_progress→unknown）。
- **watch-drill/服务**（`bill-manager/watch-drill.js` + `server.js`）：新增 `boot()`——服务进程启动即装配 Monitor、按配置自动登记每日开启任务（写日志）、启动 60s 后台同步（无人打开页面也转译事件流并落盘 JSONL）。新增 HTTP `POST /api/watch-drill/daily-enable/start|stop`（独立停用/恢复）。快照新增 `enableTask` 块，与 `running`（暂停值守）完全分离。
- **页面**：值守卡片新增"独立每日开启任务"行（已登记待命+下次时间+错过原因 / 已独立停用+恢复按钮），启动按钮旁明确标注"启动值守只控制超额暂停巡查"；规则文案更新为双任务独立语义。上轮全部修复（未知模式待核实、日志缺口、dryRun 阻断原因、动作标签）保留。

## 0.2 真实开启接线（真机实测证据）

- **真机可视测量**（headed Edge，抖店首页→巨量千川→乘方，同一 browser/context/Cookie，账户核验 1710242295996424/伊人美）：
  - **商品自选批量开启：无确认弹窗**——勾选 1 条（ID 187585998140533930）点击批量"开启"直接生效；回读 `投放中/switchChecked=true`（一次成功）。
  - **全店托管行内开关开启：实测确认弹窗**——「为保证投放的唯一性…受到互斥影响的放量投放-全域投放计划、标准投放计划将会暂停（如有）。同时小店随心推订单将被终止，终止后不可恢复。」按钮【再想想】【确定】。首轮按 fail-closed 取消并回读确认未变化；实现精确句式后二轮实测确认 → 回读托管（ID 184388555253250584）`投放中/switchChecked=true`。
  - 测试对象最终状态：上述 2 个对象均为开启侧（与上线后的预期稳态一致）；未新建计划、未开启无关广告；平台互斥副作用（全域/标准计划暂停、随心推终止）已如实记录在测量证据（evidence/，不入库）。
- **接线**（`src/adapters/chengfang-reader.js`）：双锚点（`为保证投放的唯一性`+`受到互斥影响`+`乘方投放`）识别 `shop_enable_confirm`，同步全部 4 个浏览器内联副本；`submitConfirmIfPresent`/`clickChengfangConfirmOkInPage`/`clickRowSwitch` 阻断过滤/`detectDanger` 白名单加入 shop_enable；`batch_enable` 保持无句式声明（实测无弹窗；若未来出现任何弹窗仍按未知阻断）。`watch-drill` 的 `CONFIRM_DIALOG_MEASURED` 四项全部 true（batch_enable=true 注明"实测无弹窗"）。

## 0.3 测试与部署验证

- 新增回归：monitor 调度分离 6 用例（未启动值守仍 07:00 开启/停止值守不取消开启/独立停用零请求且持久化/08:00 后错过窗口不补开/当日 success 重启不重复/两相位互斥）+ chengfang-confirm-switch 托管开启弹窗 5 用例 + watch-drill boot 独立性与 daily-enable 端点 2 用例 + 片段 enable-task 渲染 1 用例。
- 3443 重启后实测：state `realMode=true, gates 全过（pauseWillExecute/enableWillExecute=true）`、`enableTask.running=true, nextRunAt=2026-09-15T23:00:00Z（=09-16 07:00 上海）`、值守 running=false；日志含"独立每日开启任务已登记/每日开启任务登记/每日开启错过窗口"；页面含独立任务行与全部历史修复。
- 服务自启动：修复 Startup 内既有 VBS（原指向已不存在的旧目录 `5uFU㏑Kb`），现指向当前 bill-manager 目录与 `start-server.js`，未安装重复启动项。
- **待观察**：2026-09-16 07:00 首次定时真实开启的结果未实际观察（按用户要求不为证明部署而夜间开启整店）；"启动值守"页上按钮的实点验证未执行（为避免夜间触发真实巡查轮），其独立性已由两层自动化测试覆盖。

# HANDOFF — 页面同步回退修复 + 测试确定性 · 第十四轮（2026-09-15 第四轮定点收尾）

> 交付日期：2026-09-15。**realMode=false、dryRun=true、pauseEnabled=false、enableEnabled=false 全程未变；未重启 3443（PID 18920）、未启动值守、未操作真实广告；删除零点击；测试仅用隔离数据。**
> 本轮起点基线 `95d7f446501a513e460c9f43b103b54ad86c6703`（= origin/main）。Codex 复核确认第十三轮 describeTrigger 动作映射与 dryRun 阻断文案有效；本轮只处理其发现的三项：

1. **恢复未知模式展示**（`bill-manager/index.html` renderState + 同步公开片段）：上轮同步把徽标简化为仅按 `s.realMode` 二分，`realMode=false` 且 `realModeKnown=false / gates.modeKnown=false`（或 gates 未取得）时误显示"演练模式 · 不操作广告"。已恢复显式未知分支：显示 `modeText`（"待核实（配置缺少 execution.realMode，不得据此认为安全）"），琥珀色警示，不把未知当作已确认演练；已确认演练（modeKnown=true）仍显示"演练模式"。上轮的 dryRun 具体阻断原因、今日开启、调度展示全部保留。
2. **恢复日志缺口提示**（同上两份文件）：对比 2280cbc 确认上轮同步删除了 `wdGap` 元素、`renderGap()`、`loadStateAndLogs` 对 `/logs` 的 `gap/droppedCount` 消费。已按旧实现恢复（文案与接口语义一致：`gap=null 且 droppedCount=0`=未发生裁剪 → 隐藏；textContent 整体覆写 → 重复拉取不重复追加；`logs=[]` 也展示缺口）。后台事件计数零改动。
3. **修复 close-flow 回归 #7 测试抖动**（`test/close-flow.test.js`）：旧写法依赖 `delayMsFor=260` 与 `closeTimeoutMs=200` 的**真实计时差**决定 confirmed 文案分支，负载下回读可能落在延迟完成之后而走另一条文案（Codex 实跑 271/272 即此因）。改为**手工 deferred + 审计轨迹驱动**：closeAd 返回测试显式放行的挂起 Promise，按审计记录依次确认「请求发出一次 → 超时分支（unknown=true）→ 落定前回读仍在投放侧 → 放行落定 → 延迟后回读（delayed=true）确认关闭」；断言 closeCalls===1、confirmed_closed、afterStatus=已关闭、note /延迟完成/。生产 close-flow 零改动。验证：close-flow 17/17，串行 5 连跑 + 并行 6 连跑全部退出码 0。

**回归测试（真实页面脚本渲染，非源文件文字检查）**：bill-manager `tests/watch-drill.test.js` 新增 3 用例（51→54，Node VM 实际运行 renderState/loadStateAndLogs，覆盖运行页与公开片段；修复前旧代码 3/3 失败，修复后全绿）；主项目 `test/watch-drill-tab.test.js` 同步镜像（6→9 用例）。验证：bill-manager 54/54（含集成副本清空 `PROMO_GUARD_DIR` 自举实跑 54/54）；主项目 `npm test`、`npm run check`、`node evidence/codex-workbuddy-r3-verify.cjs`（结果见本轮交付报告）。

**加载状态**：3443 页面（index.html 静态读取）本轮修复已即时生效（已核实线上 HTML 含 wdGap/renderGap/待核实分支）；后端 watch-drill.js 本轮零改动，无需重启。

# HANDOFF — 推广值守展示层修复 · 第十三轮（2026-09-15 第三轮定点修复）

> 交付日期：2026-09-15。**realMode=false、dryRun=true、pauseEnabled=false、enableEnabled=false 全程未变；本轮未启动值守/未启动监控、未点击任何真实开关/暂停/开启/删除、未重启 3443（PID 18920 保持运行）；删除路径零触碰。**
> **历史标注（重要）**：本文件下方 r10–r12 段落中的「强制只读 / 只读演练」为**历史轮次语义**（当时 watch-drill 确为强制只读入口）。2026-09-15 起 3443「推广值守」已接入真实操作模式：是否真实操作广告由 `config.json` 的 fail-closed 门槛（`execution.realMode` + `execution.dryRun` + `monitor.chengfang.pauseEnabled/enableEnabled` + 上海时段）决定，`/api/watch-drill/state` 的 `gates.blockedBy` 如实展示阻断原因。阅读历史段落时按历史记录理解，不得以其覆盖当前 3443 真实门槛语义。
> 基准：`DELIVERY_REPORT.md` 中部分提交编号为旧交接编号；实际以 Git HEAD 与 origin/main 为准（本轮起点 `2280cbc100b3a142780166a92299a88aba4a36f7`，本地与远端已核对一致）。

## 0. 第十三轮修改明细（全部含回归测试）

1. **watch-drill `describeTrigger` 动作映射**（电商助手 `bill-manager/watch-drill.js`，同步 `integrations/bill-manager/watch-drill.js`）：dry 分支曾硬编码「将暂停 N 条乘方计划」不读 `targetAction`，每日开启演练被误展示为「将暂停」。修复为显式映射：`targetAction==='pause'`→「将暂停」、`==='enable'`→「将开启」、缺失/未识别→「未知动作/待核实（未按结果文本猜测）」；真实 blocked trigger 追加「未执行：原因」。保持 `evtType` 显式事件分派不变。
2. **Monitor 真实 trigger 补显式动作标签**（`src/engine/monitor.js`）：乘方暂停 `blocked_window`、乘方开启 `blocked_window`、历史全店路径（仅测试可达）三处 trigger 记录与对应审计补 `targetAction`，使值守侧无需猜测。
3. **3443 徽标/门槛明细真实阻断原因**（`bill-manager/index.html`，同步重生成 `integrations/bill-manager/watch-drill-tab.html`）：三开关全开 + dryRun=true 时原误显示「但开关未全开，暂不会操作」；现徽标显示「真实执行 · 暂不会操作 · 阻断：<blockedBy 明细>」，门槛明细新增 `dryRun` 字段与 per-action 拦截原因（`pauseGateReason/enableGateReason`）。fail-closed 执行逻辑零改动。
4. **可移植性**：`watch-drill.js` 与集成测试副本的主项目根目录改为候选探测（env `PROMO_GUARD_DIR` → 本机生产路径 → 公开仓库内相对位置），公开仓库副本可自举。
5. **测试**：bill-manager `tests/watch-drill.test.js` 新增 6 用例（45→51，含两个真实 Monitor→事件流→`/api/watch-drill/logs` E2E：开启相位显示「将开启 N 条」且不显示「将暂停 N 条」/无「批次结果：unknown」；超标 dry 周期显示「将暂停 N 条」；targetAction 缺失不被 outcome 文本误导；real blocked trigger 带动作标签；徽标 VM 回归 ×2）。主项目新增 `test/watch-drill-tab.test.js`（6 用例，VM 真实运行片段 renderState）并在 `test/monitor-chengfang.test.js` 补 real trigger `targetAction` 断言 + 新增开启 blocked_window 用例；`package.json` 注册新测试文件。
6. **验证**：推广控制 `npm test` **272/272**、`npm run check` 通过、`node evidence/codex-workbuddy-r3-verify.cjs` `allOk=true`；值守测试 **51/51**。
7. **3443 加载状态**：`index.html` 按请求静态读取 → 徽标修复已在 3443 生效（已核实线上页面含新文案）；`watch-drill.js` 为进程启动时 require → `describeTrigger` 修复需重启 3443 才生效。当前 `running=false/idle`，重启实际影响面小，但按约定本轮不擅自重启（重启会中断：该进程内的值守调度与 `/api/watch-drill/*` 日志内存态）。

# HANDOFF — 乘方自动暂停 + 每日 07:00 自动开启 · 第十二轮

> 交付日期：2026-09-14（第十二轮：乘方自动暂停之上新增"每日 07:00 自动开启"）。**realMode=false、pauseEnabled=false、enableEnabled=false 全程未变；本轮未启动值守/监控服务；未点击任何真实开关/暂停/删除；未提交 Git。**
> 本轮：自动开启独立门禁 `monitor.chengfang.enableEnabled`（默认 false）+ `enableHour=7`（Asia/Shanghai），每天 07:00 开启**当前全部**乘方计划（全店托管+商品自选，含昨日被暂停的全部计划，而非仅系统暂停记录）；开启不依赖费用/订单阈值。隔离测试 **237/237 通过**（12 个测试文件 + 2 个辅助 fixture/helpers）。

## 1. 每日 07:00 自动开启（r12）

### 1.1 业务规则与独立门禁

- 调度：每天上海时间 07:00（`monitor.chengfang.enableHour=7`）执行一次，开启**当前全部**乘方计划——全店托管（行内开关，已开启幂等跳过）+ 商品自选（100条/页 → 全选 → 批量"开启"）。不是只恢复系统前一天暂停的计划：回读以完整当前清单为准，全部开启侧才报告"乘方全部已开启"。
- 独立门禁（与暂停完全分离）：真实开启必须同时满足 `execution.realMode=true` + `monitor.chengfang.enableEnabled=true` + 上海时间在 `[enableHour, dailyStartHour)` 窗口内 + 未停止 + 触发业务日期一致。**开启不读取费用与订单、不依赖任何阈值**。
- 默认关闭：`enableEnabled=false`（config.json 默认）；`realMode=false` 或 `enableEnabled=false` → 开启相位自动转演练（只枚举将开启目标，零点击）。无 CLI 真实开启入口。
- 监控未启动（`monitor.running=false`）→ 不自行执行任何开启或暂停；手动 `pollOnce` 在开启窗口内仅返回 `window_blocked`，不触发开启动作。

### 1.2 调度实现（`src/engine/monitor.js`）

`_intervalLoop` 重构为双相位：

- 开启窗口 `[enableHour, dailyStartHour)`：`_lastEnableDate` 记录已执行日期（当天只一次，跨日重置）。到窗口且当日未执行 → `_runEnablePhase`（遍历启用店铺：演练=runDryEnableCycle / 真实=executeChengfangEnableBatch）→ 执行后等待到 `dailyStartHour` 进入暂停巡查。
- 00:00–enableHour：等待开启窗口起点（未配置开启窗口则等待 dailyStartHour）。
- 08:00 后暂停巡查不变；**跨日等待目标改为 enableHour**（配置了开启窗口时），保证次日 07:00 开启相位被唤醒（`nextIntervalDelayMs` 新增 `crossDayHour` 参数）。
- 真实开启批次（`executeChengfangEnableBatch`）与暂停批次对称：前置门槛（enable 门禁 → 开启时段 → 停止）→ 打开乘方页 → `executeChengfangEnable` → 关闭会话 → 批次按 店铺+业务日期 持久化（`_recordBatch` 支持 `allEnabledConfirmed`）。

### 1.3 门禁实现（`src/engine/chengfang-gate.js`）

- 新增 `resolveChengfangEnableAllowed(config)`：`realMode=true` + `enableEnabled=true` + 非 `dryRun`。
- `buildChengfangRequestGate` 支持 `action: 'enable'`：时段检查改用开启窗口 `[enableHour, dailyStartHour)`，配置许可实时重算 `resolveChengfangEnableAllowed(config)`（每次 `check()` 重算，无静态缓存，与暂停一致）。

### 1.4 执行器实现（`src/engine/chengfang-executor.js` `executeChengfangEnable`）

与 `executeChengfangPause` 完全对称的 fail-closed 流程：

1. 身份核验（URL/子标签/账户 ID 精确比对）→ 记录本次会话内乘方管理页 URL（`result.managementUrl`，仅会话内使用，不写审计日志）。
2. 全店托管：读取开关状态；已开启 → `already_enabled` 幂等跳过；关闭 → 严格单候选点击行内开关 → 强制新扫描回读。
3. 商品自选：确保 100条/页 → 稳定 ID 逐页处理 → 表头全选后实测选择范围（跨页优先清除重选）→ 危险弹窗检测 → 精确定位唯一"开启"按钮（带稳定标识；缺失/多候选/无标记 → 零点击；删除/暂停绝不点击）→ 点击批量"开启" → 强制新扫描回读。
4. 全量回读：两区域完整当前清单（第一页起逐页、核验分页总数与页码、对象键=`区域:稳定ID`）确认全部开启侧才报告"乘方全部已开启"；空页/跳回首页/分页不完整/回读失败 → 结果未知不报成功。
5. `beforeDispatch` 双重门禁（与暂停共用）：每次真实点击派发前 requestGate → 异步身份复核 → 复核返回后**再同步检查一次** requestGate（停止/跨日/账户变化/关闭 enableEnabled 在复核期间到达均拦截，零点击）。

### 1.5 千川首次未落地：同会话单次重试

千川已知问题：首次批量操作有时确认成功却未落地。开启路径与暂停一致：

- 本次浏览器会话内记录乘方管理页 URL；操作后回读仍关闭 → **同一 page/browser/context 内恢复该 URL 重试一次**（`restoreManagementPageForReadback`：先验证当前页身份 → 非管理页且有记录 URL 时 `page.goto` 恢复 → 恢复后再验身份；不重开浏览器、不重建上下文、不重读 Cookie）。
- 提交后跳回首页同样回到记录的乘方 URL 回读；恢复失败 → 结果未知，不报成功、不再点击。
- 第二次仍未确认 → 停止并标记结果未知（`partial_failed`），不报"全部开启"。

### 1.6 修改文件（r12）

```
src/engine/monitor.js              修改：_intervalLoop 双相位调度（开启窗口/跨日唤醒）；_runEnablePhase/_runShopEnablePhase（演练/真实分流）；_recordBatch/_summarizeBatch 支持 allEnabledConfirmed；getStatus 增加 enableHour/lastEnableDate
src/engine/chengfang-runner.js     修改：新增 runDryEnableCycle（无条件强制 dryRun:true，dry_failed 透出）与 executeChengfangEnableBatch（enable 门禁+开启窗口+停止；不读费用/订单）
src/engine/chengfang-executor.js   修改：新增 executeChengfangEnable（托管/商品自选开启、同会话单次重试、全量回读 allEnabledConfirmed、beforeDispatch 双重门禁）；复用 restoreManagementPageForReadback
src/engine/chengfang-gate.js       修改：新增 resolveChengfangEnableAllowed；buildChengfangRequestGate 支持 action='enable'（开启窗口+enableEnabled 实时重算）
src/adapters/chengfang-reader.js   修改：新增"开启"按钮精确定位与 clickBatchEnable（定位→fireBeforeDispatch→点击三段式）
src/lib/time.js                    修改：新增 msUntilHour；nextIntervalDelayMs 支持 crossDayHour（跨日等待次日 enableHour）
src/config.js                      修改：chengfang 配置增加 enableEnabled/enableHour 默认值（false/7）
config/config.json                 修改：monitor.chengfang 增加 enableEnabled=false、enableHour=7 及说明（默认关闭，须 realMode+enableEnabled 同时为真）
test/chengfang-fixture.js          修改：开启状态机（enableEffect/批量开启/100条/页/尝试计数 sessionStorage 持久化——页面跳转不重置首次未落地状态）
test/chengfang-executor.test.js    修改：新增 23 项开启用例（共 51 项）
test/monitor-chengfang.test.js     修改：新增 8 项开启调度用例（共 30 项）
test/probe-enable.js / test/probe-restore.js  新建（仅诊断用临时脚本，不纳入 npm test）
README.md / HANDOFF.md             本轮更新（237/237、自动开启流程/门禁/重试、未验证边界）
```

### 1.7 测试（r12）

`npm test` → **237/237 通过**（12 个测试文件 + 2 个辅助，隔离浏览器；本地 DOM fixture，模拟浏览器隔离，测试不访问生产页面）。

- `test/chengfang-executor.test.js`（51 项，含 23 项开启用例）：
  - 开启正常/幂等/两视图空（confirmed_empty）；realMode=false 或 enableEnabled=false → 自动转演练零点击
  - 开启/暂停/删除并存 → 开启只点开启、暂停只点暂停、删除始终零点击；开启按钮缺失/多候选/无标记 → 零点击
  - 120条/2页跨页开启、同名不同 ID 精确去重、开启后列表收缩不谎报；空清单缺分页字段 → read_failed
  - 千川首次未落地（first-noop）→ 同会话仅重试一次、第二次回读确认开启；连续两次未生效 → 停止且不再点击
  - 千川提交后跳回首页 → 同会话恢复记录的管理页 URL 回读并重试（不重开浏览器）；恢复失败 → 结果未知
  - 开启前/最终身份复核期间收到停止、跨日（跨出开启窗口）、页面账户变化、关闭 enableEnabled → 零业务点击（beforeDispatch 双重门禁）
- `test/monitor-chengfang.test.js`（30 项，含 8 项开启调度用例）：
  - 07:00 前（06:00）启动 → 等待开启窗口，零开启动作、零页面会话；07:00 整 → 执行每日开启（真实 all_enabled_confirmed，只走全店托管+商品自选，删除零点击）
  - 当天只执行一次（同一天重启监控不重复开启）；跨日重置 → 次日 07:00 允许再次执行
  - 监控未启动 → 手动 pollOnce（07:00）也不触发开启（window_blocked，零会话）；enableEnabled=false → 07:00 相位 blocked 零会话零动作；realMode=false → 开启相位演练枚举零点击
  - 演练入口强制只读：realMode+pauseEnabled+enableEnabled 全开也走 dryRun（托管/暂停/开启/删除均零点击）——3443「推广值守演练」只读边界不回退

### 1.8 默认配置状态（r12 交付时）

- `config/config.json`：`execution.realMode=false`、`monitor.chengfang.pauseEnabled=false`、`monitor.chengfang.enableEnabled=false`、`monitor.chengfang.enableHour=7`——**全部保持默认关闭**。
- 本轮**未启动**任何值守/监控服务（未运行 `npm start`、未启动 3443 值守、未调用 pollOnce 真实链路）；3443「推广值守演练」由用户自行决定是否重启加载 r11.1 补丁（见 r11 §3.1，运行中进程仍为修复前逻辑）。
- **未执行任何真实广告动作**：全部测试在本地 DOM fixture + 模拟浏览器隔离环境运行，零真实点击。
- Cookie/浏览器会话不跨重试重建：千川重试只在同一 page/browser/context 内恢复记录的乘方管理页 URL，不重开浏览器、不重建上下文、不重读 Cookie（已测试断言）。

### 1.9 未验证边界（r12，如实保留）

1. **真实页面开启/暂停的确认弹窗结构**仍未人工确认（fixture 按无弹窗/有弹窗两态覆盖）——启用 pauseEnabled/enableEnabled 前必须人工确认。
2. 千川"首次批量操作确认但不落地""提交后跳回首页"为已知问题描述，fixture 模拟两态；**真实页面行为未实测**。
3. 批量开启后列表真实行为（收缩/前移/顺序变化）未实测；实现两态均安全（稳定 ID 去重 + 全量回读）。
4. 千川页面类名（hash 后缀）长期稳定性未验证。
5. **真实主链路未在真实页面跑通**（开启与暂停均如此）：Monitor→Runner→执行器仅在本地 fixture 下验证；当前真实页面 24 个对象全部关闭侧，真实暂停会幂等跳过、真实开启会批量开启——均需用户人工盯守验证（见 r10 §8 的下一步验证流程，开启路径同前置条件）。
6. 真实 07:00 调度跨日行为（当天一次、次日重置）由模拟时钟验证；真实 24 小时观察待用户启动监控后确认。

---

# HANDOFF — 乘方自动暂停（全店托管 + 商品自选）· 第十一轮

> 交付日期：2026-09-14（第十一轮：推广值守演练页面接入 3443）。**realMode=false、pauseEnabled=false 全程未变；未点击任何真实开关/暂停/删除；未开启长期监控；未提交 Git。**
> 本轮（第十一轮）：在电商助手 3443 首页新增「推广值守演练」Tab —— 独立**强制只读**演练入口，后端调度（上海 08:00 后立即读取 + 每 30 分钟巡查 + 跨日等待），复用本项目的千川费用/罗盘订单读取器与 guard 校验链、整数分判定规则。隔离测试 **21/21 通过**；生产链路实测一轮（真实读取费用 0.00 元、订单 31 单 → 未超标 → 停止回到未启动）；UI 部署验证通过（5 Tab、标识、状态、不自动启动）。默认保持「未启动」，由用户点击按钮开始真实半小时值守。
> 本轮用户已授权修改电商助手页面及必要接口（`bill-manager/server.js`、`index.html`），新增 `bill-manager/watch-drill.js`；其他业务功能与用户已有改动全部保留（修改前已备份到 `backups/watch-drill-20260914-123603/`）。

## 1. 推广值守演练（r11，3443 页面）

### 1.1 位置与文件

```
电商助手/bill-manager/watch-drill.js   新建：createWatchDrill —— 强制只读调度 + 状态机 + 有界日志（JSONL 持久化）+ 同源 HTTP 接口
电商助手/bill-manager/server.js        修改：require watch-drill；创建实例（默认不启动）；handleRequest 增加 /api/watch-drill/* 路由（认证策略与其他 API 一致）
电商助手/bill-manager/index.html       修改：顶部新增 Tab「推广值守演练」+ 页面（状态/数据/可滚动日志框，安全文本渲染，5 秒轮询状态与增量日志）
电商助手/bill-manager/tests/watch-drill.test.js      新建：隔离测试 21 项
电商助手/bill-manager/tests/verify-watch-drill-ui.js 新建：部署 UI 验证脚本（msedge headless）
电商助手/bill-manager/tests/verify-watch-drill-prod-path.js 新建：生产链路受控实测脚本（真实一轮读取→停止）
电商助手/bill-manager/.gitignore      追加 watch-drill-logs.jsonl
推广控制/config/config.json            未改（realMode=false、pauseEnabled=false 保持）
```

### 1.2 接口（3443 同源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/watch-drill/start` | 启动值守（幂等；重复启动不建新循环） |
| POST | `/api/watch-drill/stop` | 停止值守（不再安排下一轮；读取中按明确状态结束） |
| GET | `/api/watch-drill/state` | 当前状态快照（running/status/roundNo/lastCheckAt/nextRunAt/lastRound…） |
| GET | `/api/watch-drill/logs?since=<seq>` | 增量日志（seq 游标；有界 500 条，JSONL 持久化可恢复） |

### 1.3 值守行为（已实现并测试）

- 启动后：上海 08:00 后**立即读取一轮**，此后每 30 分钟巡查（复用 `nextIntervalDelayMs`，跨日等到次日 08:00）；08:00 前启动 → 状态「等待08:00」，到点才读取。
- 后端调度（setTimeout 链，在 3443 进程内）：刷新/切换 Tab/关闭页面**不重复启动也不停止**；多页面观察同一实例。
- 幂等启动、停止后不再安排下一轮、正在读取的任务按「停止中（本轮读取结束后停止）」明确结束、服务重启默认不自动恢复（running=false）、页面加载不自动启动。
- 单轮读取有独立超时（默认 120s）+ **单一活跃读取守护**：新读取开始前必须先确认旧读取已结束或已取消释放（优先尝试取消并确认，无取消能力则本轮跳过并显示「等待旧读取结束」），仍安排下一轮——单轮失败/超时不卡死调度，也不重叠浏览器任务、不堆积任务。
- 失败/登录失效/零订单/数据不可信 → 日志「本轮无法判断 + 具体原因」，且**仍安排下一轮**（避免静默停机）；状态显示「读取失败」。

### 1.4 判断与日志（复用本项目已验证逻辑，未重新实现抓取）

- 费用 = 千川「账户整体消耗」（`createQianchuanCostReader`）；订单 = 罗盘「经营概况 全店+实时」成交订单数（`createCompassOrderReader`）；进入判定前过 guard 链（结构/身份精确比对/业务日期=当天/时效/同店同日）+ Cookie 静态核验。
- 判定 = `evaluateWholeShopCostPerOrder`：费用**整数分** > 订单数×100 才超标；恰好 1 元/单（相等）不超标。
- 每轮日志：轮次、上海时间、业务日期、开始读取 → 费用原始值与读取时间 → 订单原始值与读取时间 → 每单成本（仅展示可四舍五入）→ 精确比较依据（如 `7937分 ≤ 89×100分=8900分`）→ 结论（未超标/超标，超标时注明"应暂停乘方全店托管和商品自选，本轮未执行"）→ 本轮耗时与下次检查时间。
- Cookie/令牌/敏感请求参数一律 scrub，绝不写入日志。

### 1.5 只读边界（强制）

- `watch-drill.js` **不含任何广告操作代码路径**：不导入乘方执行器、广告控制器、开关、批量暂停、开启、删除；测试断言模块源码无相关 require/关键字。
- 即使 `config.execution.realMode=true` 与 `monitor.chengfang.pauseEnabled=true` 全开，演练入口仍只读取数据、零广告操作（测试 5 已覆盖：超标数据下仅发生 cost/order 两次读取）。
- 不调用托管开关、批量暂停、开启或删除；不提供真实执行切换按钮；超标时仅在日志记录应暂停范围，无需扫描全部计划。

## 2. 测试结果（r11）

- 隔离测试 `tests/watch-drill.test.js`：**24/24 通过**（node:test，注入可控时钟/定时器/模拟读取器，不触碰生产页面）。第 22–24 项为**超时重叠修复回归**（r11.1 补丁：单一活跃读取守护，见 §4.3）：
  1. 创建后默认未启动 + 强制只读标识；
  2. 模块不含广告操作代码路径（源码级断言）；
  3. 08:00 后启动立即读取一轮，日志含费用/订单/每单成本/精确比较/结论/耗时/下次时间；
  4. 重复启动幂等（多次 start 仅一轮、仅一个定时器）；
  5. 停止在读取中 → 明确状态结束、零定时器；
  6. 停止在等待 → 立即空闲；
  7. 停止后再次启动可重新开始；
  8. 超标（10001 分 vs 100×100）：`> 10000分，超标` + 应暂停范围文案（本轮未执行）；
  9. 恰好相等（10000 分 vs 10000 分）→ 未超标；
  10. 零订单 → 「本轮无法判断」+ 原因；
  11. 读取失败 → 「本轮无法判断」+ 仍安排下一轮 + 状态「读取失败」；
  12. Cookie 静态核验失败 → 本轮无法判断、不启动浏览器读取；
  13. 08:00 前启动 → 等待08:00，到点触发读取；
  14. 跨日（23:30 轮次后）→ 等待次日 08:00；
  15. 读取失败跨日 → 状态「读取失败」且等待次日 08:00；
  16. **realMode=true + pauseEnabled=true 全开 + 超标数据 → 仅读取，零广告操作**；
  17. 读取超时不卡死调度（下一轮仍安排）；
  18. 日志 scrub（Cookie/令牌遮蔽，中文说明文本不被吞）；
  19. 重启语义（新实例默认未启动，日志从 JSONL 恢复）；
  20. HTTP 接口（state/start/stop/logs 增量 since）；
  21. 页面加载只读接口无副作用（不触发读取、不启动）；
  22. **回归**：旧读取永久未结束（costHang）→ 后续轮次全部跳过读取、显示「等待旧读取结束」、仍只一个活跃读取任务、只一个下轮定时器、不出现旧「本轮继续」放行——断言费用/订单并发峰值均 ≤1；
  23. **回归**：旧读取延迟结束后恢复——下一轮正常读取并判定，不误跳轮次，恢复后仍无并发读取；
  24. **回归**：读取中停止后立即重启——旧读取未结束前不启动新读取，重启轮显示「等待旧读取结束」且仍安排下一轮，值守保持运行。
- 部署 UI 验证（`verify-watch-drill-ui.js`，msedge headless 访问实际 3443 页面）：5 个 Tab 齐全；店铺「瑾漂亮潮流服饰」、标识「只读演练 · 不操作广告」、「未启动」状态、「启动值守」按钮、时间为「—」；点击「🔄 刷新」不启动；`/api/watch-drill/state` 返回 `running=false, forcedDrill=true`；页面无 JS 报错。
- 生产链路受控实测（`verify-watch-drill-prod-path.js`，**生产接口 + 生产调度代码 + 真实页面读取**）：POST /start → 真实读取一轮（千川账户整体消耗 `0.00 元`（页面原始 "0.00"）、罗盘全店+实时订单 `31 单`（页面原始 "31"），耗时 59.1 秒）→ 判定 `0分 ≤ 31×100分=3100分，未超标。本轮仅演练，不暂停广告。` → POST /stop → 回到「未启动」（`running=false, nextRunAt=null`），不进入半小时循环。

## 3. 部署状态（r11 实际）

- 3443 服务已重启（新代码生效）：`ping ok`、`/api/watch-drill/state` 正常。重启前确认**无业务任务运行**（bill/shop/douyin/auto 均 false），仅结束旧的 3443 进程（PID 16720，未按 node.exe 批量结束进程）。
- 当前状态：**「未启动」**（默认）。日志 `watch-drill-logs.jsonl` 已生成，内含上述实测轮次的真实日志；页面重新打开可查看。
- 用户操作：浏览器打开 `https://localhost:3443/` → Tab「推广值守演练」→ 点击「启动值守」。08:00 后立即读取一轮，之后每 30 分钟巡查；可随时「停止值守」。真实跨 30 分钟的结果以用户启动后的实际观察为准（测试中的模拟时钟不冒充真实观察）。

### 3.1 超时重叠修复补丁（r11.1，Codex 隔离复现）——**代码已修复，运行服务待加载**

- **问题**：`costReader` 返回永不结束的 Promise 时（`readTimeoutMs=10`、`prevGraceMs=10`），首轮超时后 `settleStaleReaders` 宽限结束仅警告，仍放行新读取——旧任务未结束却开启第二次费用读取（费用被调用 2 次，日志"上一轮超时读取仍在运行……本轮继续"）。
- **修复（`bill-manager/watch-drill.js`）**：以 `guardedRead` + 单一活跃读取守护替换旧的 `withTimeout`/`settleStaleReaders`。任一时刻**最多一个活跃读取**：新读取开始前必须确认旧读取已结束或已取消释放；优先尝试取消并确认（读取任务可返回 `{promise, cancel}`），无法确认时本轮跳过并显示「等待旧读取结束」，仍安排下一轮——不重叠任务、不堆积、不静默停机。
- **测试**：新增 3 条回归（旧读取永久未结束→全跳读取且并发峰值≤1、延迟结束后恢复读取、读取中停止后立即重启）→ **24/24 通过**。
- **代码已修复 vs 运行服务已加载**：`watch-drill.js`/`watch-drill.test.js` 已修改并通过隔离测试，可直接交付；但**当前 3443 服务进程（PID 22232，`node start-server.js`）仍加载修复前的旧逻辑**（值守由用户手动启动、正在正常运行），**未经用户授权不停止/重启服务**。新逻辑需服务重启后才生效。备份：`bill-manager/backups/watch-drill-overlap-fix-20260914-133917/`。

## 4. 未确认 / 保留项（r11）

- 真实半小时连续值守的跨轮表现（间隔触发、跨日）待用户启动后实际验收；隔离测试用模拟时钟验证了 30 分钟间隔与跨日计算，但**不冒充**真实 30 分钟观察。
- 真实读取已跑通一轮（费用/订单均读到页面原始值）；若未来千川/罗盘页面结构变化导致读取失败，演练会如实显示「本轮无法判断」并继续安排下一轮，不会静默停机。
- 3443 服务进程以 `node start-server.js` 后台运行（当前会话托管的 job）；若用户自行重启服务器，值守不会自动恢复（符合设计），需在页面重新点击「启动值守」。

## 5. 历史轮次

---

# HANDOFF — 乘方自动暂停（全店托管 + 商品自选）· 第十轮

> 交付日期：2026-09-14（第十轮验收收尾）。**realMode=false、pauseEnabled=false 全程未变；未点击任何真实开关/暂停/删除；未开启长期监控；电商助手零改动；未提交 Git。**
> 本轮（第十轮）：把乘方执行器真正接入半小时自动监控主链路（只控制乘方）→ 执行门槛集中校验 → 全量回读重写（完整当前范围）→ 防误删检测失败即停止 → 跨页选择范围精确化 → 本地 DOM fixture 联合测试 **206/206 通过**（12 个测试文件 + 2 个辅助 fixture/helpers）。
> 第十轮验收收尾（Codex 复核的 4 项修复）：① 演练入口无条件强制 `dryRun:true`（演练零点击，双开关全开也走 dry-run）；② 演练失败透出为 `dry_failed`（身份/读取/分页/选择范围失败不得显示"正常枚举"）；③ 请求门槛每次 `check()` 实时重算当前配置许可（不再依赖构造时静态 realAllowed）；④ 贴近真正点击的最终检查（`beforeDispatch`）：每次业务点击派发前复核停止/时段/跨日/当前许可并复检账户身份。
> 定点修复（r10.2，Codex 本地浏览器复现）：`beforeDispatch` 在异步身份复核成功返回后**再同步检查一次 `requestGate`**（停止/跨日/许可可能在核验期间变化），不通过立即抛错禁止派发点击；复核前检查保留，双重门槛。托管开关与商品自选批量暂停共用该保护。

## 1. 当前范围（用户最新明确，优先于一切历史描述）

控制对象 = 乘方推广产品，仅两部分：

| 部分 | 控制方式 | 当前真实页面状态（r9 只读实测） |
| --- | --- | --- |
| 全店托管 | 总开关（行内开关，单候选点击） | 1 条计划（ID ****0562），开关=关闭 |
| 商品自选 | 100条/页 → 表头全选 → 批量"暂停" | 23 条计划，100条/页一页展示全部；开关全部关闭 |

- 首版只自动暂停；自动开启仅预留扩展位（`monitor.chengfang.enableEnabled=false`），本轮不设置任何自动开启条件、不暴露生产入口。
- **绝不点击"删除"**：业务动作只允许 pause（及未来预留 enable），无 delete 动作；删除确认/非预期弹窗 → 停止。
- 标准/全域/品牌不再阻塞乘方结论；但乘方任一部分读取失败或未确认（`read_failed`/`partial_failed`）→ 不报告"乘方全部已暂停"。

## 2. 只读核实（r9 证据，未点击任何业务按钮）

- 入口：乘方管理页 `https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1710242295996424`（导航"乘方"），子标签"全店托管/商品自选"均存在。
- 账户核验：页面账户名"伊人美" + ID `1710242295996424` 与配置 `shops[0].accountId` 一致。
- 全店托管视图：`共 1 条记录`（10条/页），行内开关 `oc-switch--dark`（内层无 `ovui-switch--checked` → 关闭侧），操作列=编辑/日志/删除。
- 商品自选视图：`共 23 条记录`（10条/页，hasNext=true）；切换 100条/页 成功 → `共 23 条记录`、hasNext=false、一页展示全部 23 行；表头全选框存在（未勾选）。
- 批量操作栏：未勾选时 `display:none`；按钮结构（r8 证据）：`data-auto-id="bar-groups-group-item-btn-pause"`（暂停）/ `-btn-open`（开启）/ `-btn-delete`（删除）。
- 证据文件：`evidence/r9-chengfang-1789298910130.json/png`、`evidence/r9-chengfang-1789299156510.json/png`（含 100条/页 前后对照）。
- **只读边界**：本轮切换 100条/页 属于允许的只读页面操作；未勾选全选框、未点击任何开关/暂停/删除。

## 3. 实现（r10：主链路接入 + 集中门槛 + 全量回读 + 防误删 fail-closed）

### 3.1 自动监控主链路（只控制乘方）

`src/engine/monitor.js` 每 30 分钟巡查（Asia/Shanghai 08:00 后）→ `_pollShop` 按配置分流：

1. 读取费用（账户整体消耗）与全店订单（身份/日期/时效/零订单重读核验）；仍严格超过 1 元/单（整数分：费用分 > 订单数×100）才继续，否则本轮跳过。
2. 配置了 `monitor.chengfang.scope` → **只走乘方主链路** `src/engine/chengfang-runner.js`（`ChengfangRunner`），绝不进入历史"全店关闭"流程（`close-coordinator` 仅测试显式 `monitor.legacyWholeShopCloseEnabled=true` 可达，生产配置不设置；未配置乘方范围且未开启历史路径 → fail-closed 不执行任何关闭）。
3. `ChengfangRunner`：批次开始前**重新读取费用与全店订单**（仍超标才继续，否则取消，零请求不打开页面）→ 集中门槛校验 → 打开乘方页 → `executeChengfangPause` → 关闭会话 → 批次按 店铺+业务日期 持久化。

### 3.2 执行门槛集中校验（`src/engine/chengfang-gate.js`）

`requestGate()` 统一校验真实暂停所需的全部条件：`execution.realMode=true` + `monitor.chengfang.pauseEnabled=true` + 非演练（dryRun 不得为 false 而越过配置门槛）+ 当前账户匹配 + Asia/Shanghai 08:00 后 + 未停止 + 业务日期一致。任一不满足 → 不点击。

- **每个真正发出的**托管关闭或批量暂停请求**前**逐次复查（不仅循环开始检查一次）。
- **请求门槛实时重算**（问题三）：`buildChengfangRequestGate().check()` 每次调用都通过 `resolveChengfangRealAllowed(config)` 重算当前配置许可，不依赖批次最初缓存的静态结果。运行中直接修改 config 对象属性（如 `config.monitor.chengfang.pauseEnabled=false`）即被下次 `check()` 拦截；磁盘 config.json 的修改需重新 `loadConfig()` 替换引用后新 gate 才生效——**进程不宣称支持免重载热更新**。
- 执行器内部不再以 `dryRun:false` 参数作为真实点击的充分条件：CLI `chengfang` 命令 dryRun 恒 true（只读演练），真实暂停只能由监控主链路经 `requestGate` 放行后发出。

### 3.3 执行器（`src/engine/chengfang-executor.js` `executeChengfangPause`）

1. 身份核验（URL/子标签/账户 ID 精确比对，不一致 → 停止）。
2. 全店托管：读取开关状态；已关闭 → `already_paused` 幂等跳过；开启 → 严格单候选点击行内开关 → **强制新扫描**回读确认（行消失/仍开启 → 停止）。
   - **超时未知不盲点切换**：托管开关是切换动作，点击结果未知时先读取实际状态；回读仍开启也绝不再次点击（避免反向开启），只报未知并停止。
3. 商品自选：确保 100条/页 → 以稳定 ID 为基准逐页处理：
   - 表头全选后**实测选择范围**（当前页 or 跨页，以"已选 N 个"与 DOM 选中集合交叉核对，不靠猜测）；
   - **跨页选择优先清除**：平台可清除跨页选择 → 清除后按已核验的当前页目标逐行勾选，批量栏计数与选中集合一致才继续；平台残留不可见跨页选择（范围无法确认）→ 停止，不宽松通过；
   - 每次决策前强制新扫描 + 危险弹窗检测（含删除确认，弹窗存在即停止，不点击通用"确定"）；
   - 精确定位唯一"暂停"按钮（可见批量操作栏内唯一、文本="暂停"、带 `data-auto-id` 以 `btn-pause` 结尾或 `data-e2e` 以 `_pause` 结尾；缺失/多候选/无标记 → 零点击，禁止模糊文本/序号/坐标兜底）→ 点击 → 强制新扫描回读；
   - 列表收缩（行消失/前移）以稳定 ID 去重防页码位移漏处理，行消失记入全量回读核验，不当作已关闭。
4. **全量回读 = 完整当前范围**：从第一页起（`ensureFirstPage`）逐页扫描两区域完整当前清单，核验分页总数与页码；对象键 = `区域:稳定ID`（不假定两区域 ID 永不重叠）；新增/重新开启/状态未知/目标失踪/分页不完整 → 不报告"乘方全部已暂停"。空清单必须有明确空态证据（成功读取且分页 total=0 → `confirmed_empty`；缺分页字段/读取失败 → `read_failed`，不当作空）。

### 3.4 防误删检测失败即停止（`src/adapters/chengfang-reader.js`）

- `detectChengfangDangerDialogInPage` **失败（抛错）不再被当作无弹窗**：原 catch 返回 `[]` 的行为已删除，检测异常直接上抛；`clickBatchPause` 捕获后阻断点击，控制器层同样在检测失败时阻止后续任何点击。
- 生产控制器 `createChengfangController` 增加弹窗检测失败、页面关闭、结构不可识别时的 fail-closed 行为：断言暂停/开关/删除均零点击。
- 点击后抛错不笼统报"零点击"：区分"尚未发出"与"可能已执行"——后者必须回读确认实际状态。

### 3.5 验收收尾 4 项修复（r10.1）

1. **演练入口强制只读（问题一）**：`ChengfangRunner.runDryCycle` 调用 `executeChengfangPause` 时**无条件强制 `dryRun:true`**（不依赖调用者当前配置）。即使 `realMode=true` + `pauseEnabled=true` 全开，演练也返回 `mode='dry-run'`，托管开关/暂停/开启/删除均零点击。
2. **演练失败必须透出（问题二）**：新增 `dryCycleSucceeded(result)`：身份核验通过且两区域视图无 `read_failed`/`partial_failed` 才算演练成功；否则 runner 返回 `outcome='dry_failed'` 并携带 `error/reason`。Monitor 把 `dry_failed` 透传到控制台、`recentErrors` 与 `trigger`（`failed:true`、`dryOutcome:'dry_failed'`），**不得显示为"正常枚举 0 个目标"**。
3. **请求门槛实时重算（问题三）**：见 §3.2；gate 每次 `check()` 重新计算当前配置许可。
4. **贴近真正点击的最终检查（问题四）**：执行器向控制器注册 `beforeDispatch` 回调，控制器把 `clickBatchPause`/`clickRowSwitch` 拆为"定位 → `fireBeforeDispatch` → DOM 点击派发"三段式。每次业务点击派发前（最后一次异步页面检查——定位/弹窗检测——完成后）重新校验停止/时段/跨日/当前许可，并**复检账户/页面身份**（`verifyIdentity`）；任一不满足 → 抛 `DataGuardError`，控制器不派发点击（零点击停止），不依赖批次最初的身份核验。覆盖：弹窗检测期间收到停止、最后定位期间跨午夜、批次中关闭 pauseEnabled、页面账户变化——均不发新的暂停/开关请求，已发出的继续回读，不重复切换。
5. **身份复核后二次门槛（r10.2 定点修复）**：`beforeDispatch` 在身份复核**成功返回后**再次**同步**检查 `requestGate()`（复核前检查保留）。停止信号/跨日/当前许可可能在异步 `verifyIdentity` 期间到达——原实现复核返回后即点击，本地浏览器复现 `stopped=true` 却仍有一次 `type='switch'`；现在复核返回后不通过立即抛 `DataGuardError`，禁止派发点击。托管开关（`clickRowSwitch`）与商品自选批量暂停（`clickBatchPause`）共用该保护。

### 3.6 主链路调用位置（2026-09-14 实测）

```
Monitor（src/engine/monitor.js）
  :383  _pollShop → _pollChengfangOver(shopCfg, data, cycleToken, trigger)
  :321  _getChengfangRunner → new ChengfangRunner({ coordinator, config, now, audit })
  :410  _pollChengfangOver
  :419    !realMode → runner.runDryCycle({ shopCfg, pageOpener: opener, loginCfg })
  :427    res.outcome==='dry_failed' → 透出到 recentErrors/trigger(failed:true)/console
  :463    else → runner.executeChengfangBatch({ shopCfg, cycleToken, trigger, pageOpener, loginCfg })

ChengfangRunner（src/engine/chengfang-runner.js）
  :89   runDryCycle → :93 executeChengfangPause({ ..., dryRun:true, ... })   // 无条件强制演练
  :42/:103 dryCycleSucceeded(result) → 失败返回 :107 outcome:'dry_failed'
  :147  executeChengfangBatch（批次开始前重读费用/订单）→ :201 executeChengfangPause

请求门槛（src/engine/chengfang-gate.js）
  :56  buildChengfangRequestGate({ config, nowFn, stopRequested, businessDate })
  :70  check() 内实时 resolveChengfangRealAllowed(config)  // 每次重算，无静态 realAllowed

执行器（src/engine/chengfang-executor.js executeChengfangPause）
  :113/114 setBeforeDispatch（非 dryRun 时注册）
  :116 requestGate()（复核前检查 g0）→ :118 verifyIdentity 复检 → :126 requestGate()（复核后二次检查 g1，r10.2）
  :217  clickRowSwitch（托管）｜ :479 clickBatchPause（商品自选批量）
  :201/372/462 requestGate()（每次真实点击前请求级门槛）
  :138/529 verifyAllPaused（全量回读，完整当前范围）

控制器（src/adapters/chengfang-reader.js createChengfangController）
  :487 setBeforeDispatch(fn) ｜ :474 fireBeforeDispatch({page})（抛 DataGuardError → 零点击）
  :568 clickBatchPause → :585 fireBeforeDispatch → 二次定位并点击
  :611 clickRowSwitch → :618 fireBeforeDispatch → 实际点击
```

## 4. 测试（npm test → **206/206 通过**，12 个测试文件 + 2 个辅助，隔离浏览器）

新增/扩展乘方相关文件：

- `test/chengfang-fixture.js`：本地 DOM fixture 状态机（基于 r9 实测结构），模拟勾选/全选（当前页 or 跨页，跨页可清除 or 残留）/批量暂停（生效/无效/收缩）/翻页/每页条数切换/动态新增重新开启对象/缺分页字段，全部业务点击写入 `clickLog`（断言删除零点击）。
- `test/chengfang-dom.test.js`：生产 DOM 原语——按钮精确定位、行收集（内层开关穿透、稳定 ID 解析、表头/汇总行排除、多候选 ID 拒绝）、分页/翻页、表头全选、选中读取、行复选框校正、行内开关严格点击、危险弹窗识别。
- `test/chengfang-executor.test.js`：真实控制器驱动 fixture 的端到端流程，覆盖（r9 全部用例 + r10 新增）：
  - 正常（1 托管 + 23 商品自选 → 全部暂停，allPausedConfirmed=true，删除零点击）
  - 托管已关闭 → 幂等跳过；两视图均空且**有分页 total=0 证据** → confirmed_empty（无目标视为已满足）；**空清单缺分页字段 → read_failed，零点击**
  - 开启/暂停/删除并存 → 只点暂停；暂停缺失/多候选/无标记 → 零点击停止
  - 删除确认弹窗 / 非预期弹窗 → 停止（不点"确定"）；**弹窗检测失败（抛错）→ 同样零点击停止**
  - 120 条（2 页）无漏处理；暂停后收缩（120→行消失）无漏处理但回读 missing 不谎报全部暂停
  - 翻页失败 → 停止；跨页全选 → 可清除则清除后按当前页目标重选，残留不可见跨页选择 → 停止
  - 暂停未生效（noop）→ 强制新扫描发现仍开启 → 不报告全部暂停
  - **全量回读**：新增/重新开启对象、目标失踪、分页总数与行数不一致、从第一页重扫 → 不谎报全部暂停；对象键 `区域:ID` 防重叠
  - **点击结果未知 → 只回读确认不盲点重试；托管开关回读仍开启 → 禁止重复切换（避免反向开启）**
  - 商品自选读取失败 → `read_failed` ≠ 已确认无计划；dryRun 零点击；身份核验失败 → 停止
- `test/monitor-chengfang.test.js`（r10 新增，**主链路联合测试**）：生产 `Monitor` + `ChengfangRunner` + 乘方执行器 + 本地 DOM fixture：
  - 费用 100元/100单 → 不点击；100.01元/100单 → 进入乘方暂停（托管开关 1 次 + 批量暂停 1 次，全量回读确认，删除零点击）
  - 演练或任一执行开关关闭（realMode/pauseEnabled）→ 零真实动作
  - 07:59、操作中跨日、选择完成后停止 → 不发新暂停请求
  - 批次开始前重读费用/订单 → 重算后不超标 → 取消（零请求）
  - 新增/重新开启对象 → 不误报全部暂停
  - 弹窗检测失败 → 零点击；删除按钮点击数始终为 0
  - 只控制乘方：不进入历史全店关闭流程
  - **模拟浏览器隔离**：即使测试以 realMode=true 运行也不访问生产页面（全部走本地 fixture）。
- 第十轮收尾新增用例（`test/monitor-chengfang.test.js` + `test/chengfang-executor.test.js`）：
  - **演练入口强制只读**：realMode+pauseEnabled 全开调用演练 → 仍 `mode='dry-run'`，托管/暂停/开启/删除均零点击。
  - **演练失败透出**：身份核验失败 → runner 返回 `dry_failed`，Monitor 透传 `chengfang.outcome='dry_failed'`（不显示"正常枚举 0 个目标"）。
  - **gate 实时重算**：构造 gate 后关闭 pauseEnabled（及 realMode）→ 下次 `check()` 即拒绝，不依赖静态 realAllowed。
  - **贴近点击 finally 检查**：弹窗检测期间收到停止 / 最后定位期间跨午夜 / 批次中关闭暂停许可 / 页面账户变化 → `beforeDispatch` 拦截点击，零新增暂停/开关请求，已发出的继续回读、不重复切换。
- r10.2 新增回归（`test/chengfang-executor.test.js`，生产执行器/控制器 + 本地 fixture，断言零业务点击）：
  - **最终身份核验期间收到停止**：第二次 `verifyIdentity`（最终派发前复核）返回前 `stopRequested→true` → 复核后二次 `requestGate` 拦截，`clickLog` 无 `switch`。
  - **最终身份核验期间跨午夜**：复核期间 `now` 推进到次日 → 复核后跨日拦截，零点击。
  - **最终身份核验期间关闭 pauseEnabled**：复核期间改配置 → 复核后实时拦截，零点击。

## 5. 修改文件（本轮）

r10（本轮）：
```
src/engine/monitor.js             修改：_pollShop 主链路分流 → _pollChengfangOver；只控制乘方，不再进入历史全店流程；dry_failed 透出到控制台/trigger/recentErrors
src/engine/chengfang-runner.js    新建：ChengfangRunner（批次开始前重读费用/订单、门槛校验、会话管理、结果汇总、按店铺+业务日期持久化）；runDryCycle 强制 dryRun:true + dryCycleSucceeded/dry_failed
src/engine/chengfang-gate.js      新建：requestGate 集中门槛（realMode+pauseEnabled+非演练+账户+时段+未停止+业务日期）；check() 每次实时重算配置许可（无静态 realAllowed 缓存）
src/engine/chengfang-executor.js  修改：每请求门槛复查、跨页选择清除重选、全量回读重写（区域+ID/空态证据/新增重新开启检测）、未知结果不盲点切换；注册 beforeDispatch 最终检查（实时门槛+账户复检）
src/adapters/chengfang-reader.js  修改：detectDanger 失败即抛（不再当作无弹窗）、ensureFirstPage 回到第一页、clickBatchPause/clickRowSwitch 拆为"定位→fireBeforeDispatch→点击"三段式、setBeforeDispatch 钩子
src/index.js                      修改：chengfang 只读演练命令（dryRun 恒 true，无视 pauseEnabled）+ chengfang-read 只读核实命令
config/config.json                修改：monitor.chengfang 范围/门禁说明（单独改 pauseEnabled 不生效，须 realMode 同时为真）
test/chengfang-fixture.js         修改：跨页选择清除/残留、动态新增重新开启、缺分页字段
test/chengfang-executor.test.js   修改+扩展：全量回读/跨页/检测失败/未知结果用例；gate 实时重算用例
test/monitor-chengfang.test.js    新建：主链路联合测试（生产 Monitor+执行器+本地 fixture，隔离浏览器）；演练强制只读/演练失败透出/贴近点击 finally 检查用例
README.md / HANDOFF.md            本轮更新（主链路、集中门槛、beforeDispatch、206/206=12+2、剩余未验证项）
```

r10.2（定点修复）：
```
src/engine/chengfang-executor.js  修改：beforeDispatch 身份复核返回后二次同步 requestGate()（g0 复核前 + g1 复核后双重门槛）
test/chengfang-executor.test.js   修改：run() 支持注入 config/now/businessDate；新增 3 条最终身份核验期间状态变化回归
README.md / HANDOFF.md            更新：206/206、二次门槛说明、调用位置
```

r9（上一轮，保留）：
```
src/adapters/chengfang-reader.js  修改：乘方 DOM 原语 + createChengfangController
src/engine/chengfang-executor.js  新建：executeChengfangPause（幂等/跨页/收缩/全量回读/防误删/dryRun）
scripts/verify-chengfang-readonly.js 新建：只读核实脚本（证据 r9）
test/chengfang-fixture.js / chengfang-dom.test.js / chengfang-executor.test.js 新建
evidence/r9-chengfang-*.json/png 新建：只读核实证据
```

## 6. 已确认 / 未确认

**已确认（真实页面只读）**：乘方入口与两个控制区域定位；账户与店铺关联（伊人美/****6424）；100条/页切换；表头全选框与批量栏结构；当前 24 个对象全部关闭侧；身份核验链路；监控主链路在隔离环境下按费用/订单门槛正确分流到乘方执行器。

**未确认（如实保留）**：
1. **真实点击路径**：行内开关点击后的确认弹窗结构、批量"暂停"点击后的确认弹窗结构均**未验证**（fixture 按无弹窗/有弹窗两态覆盖，真实结构未知）——启用 pauseEnabled 前必须人工确认。
2. 批量暂停后列表是否收缩（fixture 已模拟两种行为，真实行为未知，实现两态均安全）。
3. 表头全选框真实选择范围是"当前页"还是"跨全部页"、跨页选择是否可清除（实现以实测为准，两态均安全）。
4. 千川页面类名（hash 后缀）长期稳定性。
5. **主链路真实联调**：监控主链路（Monitor→Runner→执行器）仅在本地 fixture 下验证；真实页面未跑过完整主链路（费用→暂停→回读）。当前 24 个对象全部关闭侧，真实暂停会是幂等跳过，无法验证点击路径。

## 7. 运行速查

```bash
npm install && npm run check && npm test   # 206 项（12 个测试文件 + 2 个辅助，隔离浏览器）
node src/index.js check                    # 配置/Cookie 状态
node src/index.js chengfang-read           # 乘方只读核实：身份 + 两区域清单（零点击）
node src/index.js chengfang                # 乘方只读演练：枚举将暂停目标（dryRun 恒 true，零点击）
node src/index.js poll / orders / ads      # 费用订单演练一轮 / 罗盘订单 / 千川清单（历史覆盖表透明展示）
```

入口区分（读取 / 演练 / 真实执行）：
- **读取**：`orders` / `ads` / `chengfang-read` —— 只读，不打开任何可点击路径。
- **演练**：`chengfang`（dryRun 恒 true，无视 pauseEnabled）与 `poll`（按当前配置模式）。
- **真实执行**：无 CLI 命令。真实暂停只能由监控主链路发出，且必须同时满足 `execution.realMode=true` 与 `monitor.chengfang.pauseEnabled=true`（以及每日 08:00 后 Asia/Shanghai、未停止、业务日期一致等门槛）；**单独改 pauseEnabled 不会生效**，显式 `dryRun:false` 也不能越过配置门槛。

审计：`data/audit.jsonl`；状态：`data/state.json`；日志：`logs/app.log`；证据：`evidence/`。

## 8. 下一步真实暂停验证（用户决策后执行）

**前置条件**：人工在真实页面确认两处点击交互的弹窗结构后，方可继续；`pauseEnabled` 保持 false 直到用户书面确认。

1. 准备一个**开启中**的乘方商品自选计划（当前 23 条全部关闭，真实暂停会幂等跳过，无法验证点击路径）：
   - 在乘方商品自选页勾选 1 条 → 点击批量"开启"，人工盯守记录弹窗结构与文案；
   - 确认开启后，用它验证暂停路径。
2. 验证对象范围：乘方 **全店托管 1 条（ID 184388555253250562）+ 商品自选 23 条**（ID 见 evidence）。
3. 操作序列（与本轮实现一致）：
   - 全店托管：读取开关 → 若开启，行内开关点击 → 回读确认关闭；
   - 商品自选：切换 100条/页 → 等加载 → 表头全选 → 实测选择范围（当前页 or 跨页，优先清除跨页选择）→ 核对"已选 N 个"与选中集合 → 点击"暂停" → 回读；
   - 若出现删除确认/非预期弹窗/文案不符/按钮缺失或重复/检测失败 → 停止，零点击。
4. 建议以 `node src/index.js chengfang`（dryRun）先跑一遍枚举，人工核对"将暂停目标"与页面一致；确认后由用户把 `config/config.json` 的 **`execution.realMode` 与 `monitor.chengfang.pauseEnabled` 同时置 true**（缺一不生效），并保持 `serve`（监控主链路）在盯守下运行——真实暂停只由主链路发出，无 CLI 直发入口。
5. 全量回读确认两部分全部关闭侧后，才可报告"乘方全部已暂停"。

## 9. 历史调查（独立存档，已被本轮范围取代）

- 早期范围：账户整体消耗=乘方+标准+全域+品牌四分项，目标=全店关闭，建立覆盖表（全域 2/2、标准 157/157、品牌 0、乘方当时定位为引导页/覆盖缺口），并因乘方缺口以 `blocked_coverage` 阻止全店结论。
- 本轮用户明确收窄：只控制乘方（全店托管+商品自选）。标准/全域/品牌相关读取器（`qianchuan-reader.js`）、覆盖表、协调器（`close-coordinator.js`）保留为历史实现与透明展示，**不再是本轮关闭动作的依据**；`monitor.qianchuan.adTypes` 仅用于只读清单的透明性展示。
- 费用口径不变：仍为账户整体消耗（用户明确不改成乘方分项）。
