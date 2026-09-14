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
