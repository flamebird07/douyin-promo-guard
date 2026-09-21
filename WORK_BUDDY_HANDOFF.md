# Work Buddy 接手说明（2026-09-15）

## 开工条件和交付性质
本仓库 https://github.com/flamebird07/douyin-promo-guard 为公开仓库。第十二轮是待修复交接版本，不是已可上线版本。Codex 独立运行 npm test：237/237 通过，约 280 秒；隔离测试不证明真实操作闭环已接通。开工前核对远端 main 与本地提交；保留工作区已有修改。不得上传 Cookie、Token、config/config.json、evidence、日志、浏览器会话数据。不要提交诊断探针 test/probe-*.js。

本地项目：C:\Users\Administrator\Documents\电商助手\douyin-promo-guard（2026-09-21 自 ChatGPT/推广广告控制 迁入）。
现有电商助手：C:\Users\Administrator\Documents\电商助手\bill-manager。
用户界面：https://localhost:3443/。
从 Trae 转交 Work Buddy，由用户转发提示词，Codex 不可直连 Work Buddy。

## 最终业务要求（覆盖旧文档中的只读限制）
- 单店：瑾漂亮潮流服饰；千川账户 1710242295996424，账户名伊人美。登录 Cookie 文件按店铺精确匹配，读取电商助手 cookies 目录，禁止输出值。
- 费用：当天千川账户整体消耗；订单：抖店首页点击“成交订单数”进入罗盘经营概况，读取全店+实时下当前成交订单数，不能用首页延迟数字、昨日/同行数字或广告归因订单。
- 上海时间每天 07:00 开启全部当前乘方计划，包括人工暂停的计划。全店托管和商品自选均在范围内。
- 每天 08:00 后每半小时巡查；费用整数分严格大于全店订单数乘100才暂停全部乘方。等于不暂停；零订单/缺失/身份不符/日期不符不得当作有效数据。
- 全店托管操作单一实际开关；商品自选100条/页、全选、批量动作，超过100需完整分页。删除绝不能点击；开启/暂停用独立精确文本和稳定标识，不按位置猜测。
- 3443 原“推广值守演练”改为“推广值守”，接真实开启/暂停链路，删除过时的“只读演练·不操作广告”标识。用户最新补充取代上一轮提示词“3443 永远只读”的要求。保留独立演练入口时必须仍严格只读。
- 界面日志必须显示费用、全店订单、阈值判断、07:00开启计划与实际结果、暂停、重试、回读、失败及下次执行时间。
- 交付功能但不要自行启动值守，不要让服务重启后自动执行广告。用户通过界面明确启动后运行；停止须即时阻止新的业务请求。实机操作全程可见。

## 登录与会话
必须从抖店首页进入巨量千川，不能用千川直达替代初次登录链。保存实际抖店首页URL及进入后的乘方URL。一次操作/重试保持同一 browser/context，不重新灌入旧Cookie、不关闭重开浏览器；允许刷新。在同会话按已核验入口重新进入所需页面。
用户观察首次操作可能不落地，猜测与Cookie有关；根因尚未证实，不写成确定事实。只能在可靠新回读确认目标仍需变更、且无在途请求时有限重试一次；切换开关不能盲目重复。跳回首页、缺少计划、读数0不等于全部成功。

## Codex 本轮源码复核：优先修复
1. src/adapters/chengfang-reader.js 的 clickChengfangRowSwitchByPlanId 仍 wrappers[0].click() 点击外层 .oc-switch。此前实测需要点击内层 .ovui-switch；临时脚本的修复未进入正式控制器。按稳定ID全等核验并限定唯一实际开关。
2. 正式 clickBatchPause/clickBatchEnable 和托管路径没有确认弹窗提交闭环。批量暂停实测弹窗为“确定要暂停N条计划吗？暂停后将停止投放，请谨慎操作。取消 确定”；托管关闭实测“确定关闭乘方投放吗？”并有其他推商品计划需手动恢复的提示。用户已同意托管关闭该提示。只能确认与当前动作和数量精确一致的弹窗，每次确认前同样执行最终门禁、身份、停止检查；开启弹窗结构未实测，不能编造。未知/删除弹窗必须阻断。
3. Monitor._lastEnableDate 仅在内存且执行前赋值：新进程会重复开启，失败/演练也会占用日期。实现按店铺+上海日期+动作的持久化状态，区分执行中/成功/失败/未知，重启先回读处理未知，不能盲重发。
4. _intervalLoop 在 await _runEnablePhase 后仍使用相位前 now 计算到08:00等待，导致首轮暂停巡查延后。用执行后的当前时间重新计算，覆盖慢执行、跨08:00和停止/重启。
5. restoreManagementPageForReadback 只 goto 管理页、固定等8秒、切标签。真实页面可能要先选“商品”，恢复后还需100条/页、分页位置及完整性核验。身份不匹配必须阻断，不得仅导航恢复掩盖账户变更。
6. 同会话重试当前只对全部目标未落地递归处理；检查选择状态、部分成功、未知状态和在途请求，确保不反向切换、不扩范围、不重复审计目标。测试必须使用真实生产控制器的确认提交函数，不能fixture点击按钮就立即成功来替代真实弹窗。

## 实测边界
历史手动可视测试：托管关闭曾刷新确认已暂停；两条商品暂停曾确认；后续完整23条通过抖店入口读到0条开启。但这些是历史快照且主要使用 evidence 临时脚本，不代表当前线上状态，更不代表正式执行器支持真实确认。证据目录仅本地可用。真正自动开启未实测。
本轮只独立运行隔离测试，没有真实广告操作或重启服务。配置按报告 realMode=false / pauseEnabled=false / enableEnabled=false / enableHour=7；开工应重新核实。不要根据历史PID结束进程。

## 实施与验证
先修真实闭环和调度，再接3443，同一后端状态源驱动启动/停止/日志；不要只改标签。不破坏电商助手其他业务。使用现有单活跃读取防重叠逻辑，开启与暂停互斥。
覆盖内层开关、真实确认弹窗结构、数量不符/删除零点击、最终身份核验期间停止/跨日/许可关闭、首次未落地同会话重试、回到首页恢复、分页不完整、部分成功、未知不重发、持久化恢复、防重复07:00开启和08:00准时巡查。
完成 npm test、npm run check 和3443接口/UI隔离验证，给出修改文件、实际测试总数、已验证/未验证、配置与服务加载状态。不要启动值守、不要擅自真实开启计划，不要上传秘密；将受控可视实机验证步骤留给用户明确发起。需要重启共享3443时先检查业务状态并报告影响。不得通过批量结束node/Edge清理。


---

## 第二轮修复交接（2026-09-15，提交 1996e15 / 6ac1d77）

上一轮 6 项交接修复已落地并复测。本轮针对「日志与展示可信度」追加 7 项修复，
全部带回归测试；详见 DELIVERY_REPORT.md 第 0 节（旧行为 / 修复位置 / 回归测试名）。

1. **日志增量游标**：删除 `_lastActionsSeen = list.length` 等**基于有界数组长度**的游标；
   Monitor `_memPush` 为每条事件附加单调 `evtSeq`，新增 `_evtDropped`（裁剪区段）与
   `getEventStream(since)`；watch-drill 按 `evtSeq > lastSeq` 增量消费，与数组长度解耦。
   超缓存时记录明确「日志缺口 N 条」并继续同步。
2. **六类日志**（每日开启 / 每轮判断 / 暂停 / 重试 / 回读 / 失败原因）全部真实进入
   `/api/watch-drill/logs`；重试与回读不再只写审计文件。
3. **每周期一条判断**：Monitor `cycleNo` + `_emitJudgement` **无条件**记录（连续两轮相同数据
   也有两条）；watch-drill `roundNo` 跟随 `Monitor.cycleNo`。
4. **actionType 显式字段**：runner dry 路径 + Monitor `_summarizeBatch` 显式输出
   `actionType`/`action`；watch-drill 移除 `/enable/i.test(outcome)` 文本推断。
   部分开启 / 开启失败 / 每日开启演练一律标「开启」；缺失字段如实报「未知动作」。
5. **危险弹窗 fail-closed**：`submitConfirmIfPresent` 删除弹窗检测异常不再 catch 成
   `{found:false}`；`clickRowSwitch` 两处检测异常在**业务点击派发前**抛 `DataGuardError`（零点击）。
6. **门槛实时一致**：watch-drill 每轮重读 Monitor 配置（含实时 `realMode`），运行中改
   `realMode`/`pauseEnabled`/`enableEnabled` 后 state 与 logs 立即反映。
7. **未实测开启弹窗保守阻断**：`confirmDialogs` 中 `batch_enable`/`shop_enable` 保持 `false`（阻断），
   未因测试放宽为盲点「确定」。

### 本轮测试总数
- 推广控制 `npm test`：**265/265**（乘方四套 124 + 其余 141）。
- `npm run check`：通过（配置齐全，演练模式，阈值 100 分/单，1 家店铺）。
- bill-manager `tests/watch-drill.test.js`：**38/38**。
- `test/chengfang-confirm-switch.test.js`：21 → **28**（新增 fail-closed 7 例）。

### 仍未做（按要求）
未重启 3443（仍 PID 18916 旧只读版，实测仍返回 `forcedDrill:true` 且无 `gates`）；
未启动值守；未修改生产三开关；未点击真实广告或删除。

---

## 第十六轮定点收尾（2026-09-16，基线 7416d2aa）

**范围**：不重做项目，只做四项 —— ①会话 Cookie 回写（用户新要求）②轮询配置与超时语义统一
③停止语义恢复 ④暂停侧同问题核查。详见 `HANDOFF.md` 第十六轮（最新段落）。

**关键事实（接手前必读）**

- **轮询唯一有效配置** = `execution.readbackTimeoutMs`（30000）/ `execution.readbackIntervalMs`（3000），
  生产 `config/config.json` 与 `src/config.js` DEFAULTS 已对齐；执行器与页面同源解析
  （`src/lib/bounded-poll.js`），**没有独立的 fallback 数值**。旧文档里「生产默认 30 秒/3 秒」在
  本轮之前**不成立**（实际是 15000/2000 + 执行器内联 fallback 30000/3000），现已统一为真实生效的 30/3。
- **轮询时钟**：`confirmLanding` 必须用真实单调时钟（`Date.now`）。业务 `now` 是「本次检查时刻」的
  固定快照，只能用于上海时段/跨日判断；把它当轮询时钟会让 deadline 永不耗尽 → 死循环（本轮踩过）。
- **停止语义**：停止后立即禁止重试与新请求，但**已派发请求继续在有限期限内只读确认**，
  真实回读结果记录在 `result.stoppedAfterDispatch`。
- **托管开关是切换动作**：超时/状态未知一律只回读，**绝不重复点击**（否则反向切换）。
- **同会话重试**只允许一次，且重试前必须重新核验 门槛/身份/停止/**真实开关状态**
  （`prepareRetry`，审计事件 `retry-precheck` / `retry-skipped`）。
- **Cookie 回写**：`src/login/cookie-writeback.js`，只写本次实际加载的精确店铺 Cookie 文件，
  原子写入 + 域完整性 + 冲突保护（会话期间源文件被改动则保留较新文件）+ 写入后自校验回滚；
  **绝不输出任何 Cookie 值**；回写失败单独记录，不改写广告动作结果。
- **旧代码回归对照**：`evidence/old-code-executor-regression.log`（`git worktree` 检出基线
  `7416d2aa` 运行新回归，用生产执行器）。改动新代码后请重新生成该对照。
- **3443 运行状态**：本轮重启后 PID 25788；`state` 已含 `polling`/`cookieWriteback`。
  该进程由会话后台任务启动，**尚未交还给开机启动项**（`Startup\电商助手服务.vbs`）。
- **未验证（不得当成已验证）**：本轮**无任何真实广告动作**，「点击→异步落地→确认」真实链路与
  真实店铺文件上的 Cookie 回写**均未实测**。下一次 07:00 若对象本来已开启，幂等跳过只证明
  调度与回读有效。

## 第十七轮定点修复（2026-09-16，基线 4efe5a7）

Codex 独立复现的两个缺陷 + 服务启动稳定性收尾。**本轮未发生任何真实广告动作**。

### 一、`src/lib/bounded-poll.js`：单次读取必须有界
- 旧缺陷：deadline 只决定"两次读取之间是否继续"，`await read()` 本身无上界 →
  read 返回永不落定的 Promise 时函数**永久挂起**（隔离复现：timeoutMs=20/intervalMs=0，100ms 未返回）。
- 修复：每次读取登记为 `{done,result}`（结果永远以 `{ok,value|error}` 落定，不产生未处理拒绝）；
  `waitSettle` 的等待上界 = 剩余预算（内部先用 0ms 宏任务刷新微任务队列）；
  超时未释放 → `abort()` + `cancelGraceMs` 确认释放，确认不了 → `inFlight:true` + `abandonedReads++`；
  迟到结果只写本地登记对象，不改写已返回结果。
- 新增字段：`inFlight` / `abandonedReads` / `lastReadFailed` / `valueStale` / `peakInFlight`。
- 执行器新增 `landingStateTrustworthy(poll)`：`inFlight || lastReadFailed || valueStale` → **禁止重发**。
- **不要**退回 `Promise.race` 丢弃旧任务，也不要单纯加大超时——那既会让读取重叠，也解决不了挂起。

### 二、`src/login/cookie-writeback.js`：指纹检查的异步空隙
- 旧缺陷：指纹检查在 `await context.cookies()` **之前** → 异步期间用户重新登录被旧会话覆盖且 `ok=true`。
- 修复：初始指纹缺失/无效 → 拒绝；`context.cookies()` 之后**再取一次快照**比对；
  回滚改为 `rollbackIfUnchanged`（仅当文件仍是本次写入的那份才回滚）；`loginOk` **fail-closed**。
- runner：`_writebackSessionCookies` + `_currentLoginEvidence`，回写前必须取得**当前**只读登录/身份证据。
- 边界：比对-后-写 + 原子 rename 只保证不出现半写文件，**不是**完整并发互斥。

### 三、服务启动稳定性（`电商助手/bill-manager/server.js`，**非公开仓库**）
- 修了两个真实缺陷：①陈旧锁判定失效（时间戳从不刷新 → 跑满 5 分钟后锁被新实例窃取）；
  ②EADDRINUSE 只打印不退出 → 僵尸实例。
- 修复后：`isLockStale` 先看 PID 存活；`tryCreateLock`（temp + `linkSync`）原子互斥；60s 锁心跳；
  `releaseLock` 只删自己的锁；EADDRINUSE → 退出。
- 备份 `server.js.bak-pre-lockfix-20260916-193410`。
- **已重启加载修复**（业务空闲后精确停止旧实例，未批量结束进程）：旧 PID 25788 → **新 PID 31324**。
  实测：陈旧锁正确接管、锁心跳 60.5s 刷新时间戳、单实例保护拒绝第二份（`rc=1` 且不窃锁）、
  3443 HTTP 200、状态无损（`enableTask.nextRunAt=2026-09-16T23:00:00Z`、`enablePhaseToday` 保留）。
- **脱离会话生命周期在本环境被明确拒绝**（WMI / 任务计划 / explorer / Python
  `CREATE_BREAKAWAY_FROM_JOB` → WinError 5）。这是环境限制，不是业务要求。

### 四、接手注意事项
- 公开副本只有 `watch-drill.js` / `watch-drill-tab.html` / `watch-drill.test.js` / `README.md`；
  `server.js` 属电商助手自身，改动**不需要**同步到公开仓库。
- 旧代码回归对照：`evidence/old-code-executor-regression-r17.log`（基线 `4efe5a7`）。
  改动上述源码后请重新生成。
- **未验证（不得当成已验证）**：真实店铺文件上的 Cookie 回写、「点击→异步落地→确认」真实链路。
