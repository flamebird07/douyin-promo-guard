# 阶段报告：安全窗口重启与运行时版本指纹核验

- 工作目录：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 父仓值守入口：`C:\Users\Administrator\Documents\电商助手\bill-manager\start-server.js`
- 范围：只读安全检查 → 增加非敏感版本指纹 → 一次安全重启 → 重启后核对
- 禁止项（本阶段全程遵守）：不打开真实广告页；不执行 enable/pause/switch；不手动运行 `pollOnce`；不发送通知；不改真实配置；不提交/推送
- 结论标签约定：路径解析已确认 / 运行时加载字节已确认 / 仅能推断、尚未确认

---

## 1. 重启前 PID 与入口

| 项 | 重启前 | 证据 |
|---|---|---|
| Node 进程 | PID **4764**，命令 `node start-server.js` | wmic |
| 包装 cmd | PID **21900**，`cmd.exe /c node start-server.js >> server-console.log 2>&1` | wmic |
| 入口 | `bill-manager/start-server.js` → `server.js` → `watch-drill.js` | 进程命令行 |
| 监听 | `0.0.0.0:3443` / `[::]:3443`（PID 4764） | netstat |
| 安全检查 | `switchSlots.slots=[]`；`enableTask.phase=waiting_window`；最近一轮未超标、零动作；轮次间（非 in-flight） | `/api/watch-drill/state`、`data/state.json` |

重启前判定：**无在途暂停/开启动作，无 in-flight / unknown 串行槽**，可安全重启。

---

## 2. 运行时实际加载路径（路径解析已确认）

指纹经 `require.resolve` 解析，进程 PID **9120**：

| 模块 | resolvedPath | 旧目录 D？ |
|---|---|---|
| monitor | `…\电商助手\douyin-promo-guard\src\engine\monitor.js` | 否 |
| ad-switch-orchestrator | `…\电商助手\douyin-promo-guard\src\engine\ad-switch-orchestrator.js` | 否 |
| switch-serial | `…\电商助手\douyin-promo-guard\src\engine\switch-serial.js` | 否 |
| watch-drill | `…\电商助手\bill-manager\watch-drill.js` | 否 |

- 正式仓 C：**已确认**（上述三条 engine 路径均在 `douyin-promo-guard`）
- 父仓 watch-drill：**已确认**（`bill-manager\watch-drill.js`）
- 旧目录 `C:\Users\Administrator\Documents\ChatGPT\推广广告控制`：**无任何加载路径**（已确认）

---

## 3. 非敏感指纹 / hash 对照（运行时加载字节已确认）

静态构建标记：`promo-guard-runtime-fp-v1`  
Node：`v24.14.0`；指纹时间：`2026-09-23T05:23:34.502Z`（与进程 CreationDate `20260923132334.381026+480` 对齐）

| 文件 | 运行时指纹 sha256（前 16） | 正式仓 C 磁盘 sha256（前 16） | 全量一致？ |
|---|---|---|---|
| monitor.js | `2d6c3ca104101a45` | `2d6c3ca104101a45…e9ff7` | 是 |
| ad-switch-orchestrator.js | `0144ab2f50a0fb28` | `0144ab2f50a0fb28…3eb26` | 是 |
| switch-serial.js | `47134e3372ca1c93` | `47134e3372ca1c93…5ad1ba` | 是 |
| watch-drill.js | `107967211b317c92` | `107967211b317c92…e9931` | 是 |

全量 sha256：

- monitor.js `2d6c3ca104101a45b2722a83c67569f10a99aa516360a2259cddf340488e9ff7`（117916 B）
- ad-switch-orchestrator.js `0144ab2f50a0fb28d31c4a9b13f981d972b7def6297cf9c4747c3cd41153eb26`（18175 B）
- switch-serial.js `47134e3372ca1c93747b41292e032481d3ff6f327d9f42e649e54578be5ad1ba`（14075 B）
- watch-drill.js `107967211b317c92cba4fbfabf34e06c6248e8c8638df539987229c82b4e9931`（70357 B）

实现：`douyin-promo-guard/src/lib/runtime-fingerprint.js`  
暴露：启动日志一行 + `/api/watch-drill/state` 字段 `runtimeFingerprint`（只读，无 Cookie/店铺 ID/令牌/密钥）。

证据边界：指纹证明的是 **require.resolve 实际解析路径上的文件字节** 与正式仓 C 磁盘一致，且解析路径不含旧目录 D。这是本阶段可达成的运行时版本确认；不把「工作区文件存在」单独当作已加载证据。

---

## 4. 重启前后 PID 与入口

| 项 | 重启前 | 重启后 |
|---|---|---|
| PID | 4764（cmd 21900） | **9120** |
| 入口 | `bill-manager/start-server.js` | `bill-manager/start-server.js`（未改端口/入口/config） |
| 启动时间 | （既有进程） | `2026-09-23 13:23:34 +08:00` |
| 工作目录 | `bill-manager` | `bill-manager` |

说明：停止使用 `taskkill /T`（旧树含由 Node 拉起的 publish-service 子进程）。拉起使用与入口一致的 `node start-server.js`（PowerShell `Start-Process` 分离启动；辅助脚本 `bill-manager/start-watch-duty.cmd` 仅作入口封装）。**仅完成这一次授权的安全重启**；未再循环重启。

---

## 5. 重启后核对清单

| 核对项 | 结果 | 标签 |
|---|---|---|
| 新 PID 与启动时间 | PID 9120 / 2026-09-23 13:23:34 +08 | 已确认 |
| 实际工作目录与 require.resolve 路径 | 均在 C + bill-manager，无 D | 路径解析已确认 |
| 启动指纹 vs 正式仓 C 磁盘 hash | 四文件全量一致 | 运行时加载字节已确认 |
| 无旧目录 D 加载路径 | `hasChatGPT=false` | 已确认 |
| `/api/watch-drill/state` 可读 | HTTP 200，`ok:true` | 已确认 |
| 07:00 进程内调度仍登记 | `enableTask.running=true`，`nextRunAt=2026-09-23T23:00:00.000Z`（次日上海 07:00），`enableHour=7` | 已确认 |
| 暂停巡查仍在运行 | **否**：`running=false`，`status=idle`（见下） | 已确认（如实记录） |
| 重启引起的真实广告动作 | **0** | 已确认（见第 6 节） |

### 暂停巡查状态说明（必须单列）

- 设计事实：`watch-drill.boot()` **只装配 Monitor 并登记每日开启任务，不自动启动暂停巡查**（代码注释与实现一致）。
- 本阶段约束：不运行 `pollOnce`、不打开真实广告页、不发送通知。
- 当前已过上海 08:00，若调用 `POST /api/watch-drill/start`，`monitor.start()` → `_intervalLoop` 会**立即** `pollOnce('interval')`，将打开真实广告页并可能发通知——**故本阶段未手动拉起暂停巡查**。
- 因此「暂停巡查仍在运行」**未满足**；若需恢复巡查，须主脑另令，并知悉首巡即真实读页/可能触发阈值动作。

---

## 6. 是否有真实广告动作（预期 0）

**计数：0。** 依据：

1. 未调用 enable/pause/switch，未手动 `pollOnce`。
2. 重启后 `lastRound=null`，无新巡查周期。
3. `notify.lastStatus=null`、`lastAt=null`、`lastCycleNo=0`（进程启动后未发通知）。
4. 每日开启任务处于 `waiting_window`，`lastRunAt=null`，今日窗口已过且未补开。
5. `deleteAdEnabled=false`；配置门槛未改动。

真实广告页操作：**本阶段为 0**（未打开千川广告页）。

---

## 7. 仍未验证（明确不得宣称上线）

| 项 | 状态 |
|---|---|
| 真实广告页读写 / 回读核验 | **未验证** |
| 07:00 真机每日开启业务结果 | **未验证**（仅确认调度已登记） |
| 08:00 后阈值暂停真机结果 | **未验证**（暂停巡查当前未运行） |
| 生产上线 | **不得宣称** |

---

## 8. 本阶段产出（代码/入口）

| 文件 | 变更 |
|---|---|
| `douyin-promo-guard/src/lib/runtime-fingerprint.js` | 新增：require.resolve 路径 + 文件 sha256 + 静态构建标记 |
| `bill-manager/watch-drill.js` | boot/装配时收集指纹；写入启动日志与只读 `runtimeFingerprint` |
| `bill-manager/start-watch-duty.cmd` | 仅启动入口封装（无业务逻辑） |

未改：`config.json`、realMode/dryRun、端口、`start-server.js` 入口逻辑。  
未做：完整测试套件、git commit/push、真实页操作、通知、enable/pause/switch。

---

## 9. 一句话结论

**重启后 Node 进程（PID 9120）经 require.resolve 加载正式仓 C 与 bill-manager 的最新磁盘字节，四文件 sha256 全量一致，无旧目录 D 路径；07:00 调度已登记；本阶段真实广告动作 0。**  
**暂停巡查未在运行（boot 不自动启动，且本阶段禁止立即 pollOnce）。真实页面与 07:00 真机业务结果仍未验证，不得宣称上线。**
