# 阶段报告：安全窗口重启与运行时版本指纹核验（本阶段）

- 工作目录：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 父仓值守入口：`C:\Users\Administrator\Documents\电商助手\bill-manager\start-server.js`
- 范围：只读安全检查 → 确认只读版本指纹 → 一次安全重启 → 重启后核对
- 禁止项（全程遵守）：不打开真实广告页；不执行 enable/pause/switch；不手动 `pollOnce`；不发送通知；不改真实配置；不提交/推送
- 证据标签：路径解析已确认 / 运行时加载字节已确认 / 仅能推断、尚未确认

---

## 1. 重启前 PID 与入口

| 项 | 重启前 | 证据 |
|---|---|---|
| Node 进程 | PID **9120**，`node start-server.js` | wmic |
| 创建时间 | `2026/9/23 13:23:34` | wmic CreationDate |
| 入口 / 工作目录 | `bill-manager/start-server.js` / `bill-manager` | 进程命令行 |
| 监听 | `:3443`（PID 9120） | netstat |
| 安全检查 | `switchSlots.slots=[]`；`enableTask.phase=waiting_window`、`lastRunAt=null`；`running=false`（暂停巡查未运行）；`lastRound=null`；最近批次 `2026-09-21 nothing_to_pause`（历史，非在途） | `/api/watch-drill/state`、`data/state.json` |

**判定：无在途暂停/开启动作，无 in-flight / unknown 串行槽，可安全重启。**

---

## 2. 运行时实际加载路径（路径解析已确认）

进程 PID **9956**，指纹 `require.resolve` 解析路径：

| 模块 | resolvedPath | 旧目录 D？ |
|---|---|---|
| monitor | `…\电商助手\douyin-promo-guard\src\engine\monitor.js` | 否 |
| ad-switch-orchestrator | `…\电商助手\douyin-promo-guard\src\engine\ad-switch-orchestrator.js` | 否 |
| switch-serial | `…\电商助手\douyin-promo-guard\src\engine\switch-serial.js` | 否 |
| watch-drill | `…\电商助手\bill-manager\watch-drill.js` | 否 |

- 正式仓 C：**已确认**
- 旧目录 `C:\Users\Administrator\Documents\ChatGPT\推广广告控制`：**无加载路径**（`hasD=false`）

---

## 3. 非敏感指纹 / hash 对照（运行时加载字节已确认）

静态构建标记：`promo-guard-runtime-fp-v1`  
指纹时间：`2026-09-23T05:44:38.376Z`（与进程 CreationDate `20260923134438.295172+480` 对齐）

| 文件 | 运行时 sha256 | 正式仓 C 磁盘 sha256 | 全量一致 |
|---|---|---|---|
| monitor.js | `2d6c3ca104101a45…e9ff7` | 同左 | **是** |
| ad-switch-orchestrator.js | `0144ab2f50a0fb28…3eb26` | 同左 | **是** |
| switch-serial.js | `47134e3372ca1c93…5ad1ba` | 同左 | **是** |
| watch-drill.js | `107967211b317c92…e9931` | 同左 | **是** |

全量 sha256：

- `monitor.js` `2d6c3ca104101a45b2722a83c67569f10a99aa516360a2259cddf340488e9ff7`（117916 B）
- `ad-switch-orchestrator.js` `0144ab2f50a0fb28d31c4a9b13f981d972b7def6297cf9c4747c3cd41153eb26`（18175 B）
- `switch-serial.js` `47134e3372ca1c93747b41292e032481d3ff6f327d9f42e649e54578be5ad1ba`（14075 B）
- `watch-drill.js` `107967211b317c92cba4fbfabf34e06c6248e8c8638df539987229c82b4e9931`（70357 B）

指纹实现（既有，本阶段确认可用、未改语义）：`douyin-promo-guard/src/lib/runtime-fingerprint.js`  
暴露：启动日志 + `/api/watch-drill/state.runtimeFingerprint`（无 Cookie/店铺 ID/令牌/密钥）。

证据边界：以 **require.resolve 实际解析路径上的文件字节** 对照正式仓 C 磁盘；不把「工作区文件存在」单独当作已加载证据。

---

## 4. 重启前后 PID 与入口

| 项 | 重启前 | 重启后 |
|---|---|---|
| PID | **9120** | **9956** |
| 入口 | `bill-manager/start-server.js` | `bill-manager/start-server.js`（端口 3443、config、realMode/dryRun 未改） |
| 启动时间 | 2026-09-23 13:23:34 +08 | **2026-09-23 13:44:38 +08** |
| 工作目录 | `bill-manager` | `bill-manager` |

说明：停止 PID 9120 后按同一入口 `node start-server.js` 拉起。**仅一次安全重启**，未循环重启。

---

## 5. 重启后核对清单

| 核对项 | 结果 | 标签 |
|---|---|---|
| 新 PID 与启动时间 | 9956 / 2026-09-23 13:44:38 +08 | 已确认 |
| 工作目录与 require.resolve 路径 | C + bill-manager，无 D | 路径解析已确认 |
| 启动指纹 vs 正式仓 C 磁盘 hash | 四文件全量一致 | 运行时加载字节已确认 |
| 无旧目录 D 加载路径 | `hasD=false` | 已确认 |
| `/api/watch-drill/state` | HTTP 200，`ok:true` | 已确认 |
| 07:00 进程内调度仍登记 | `enableTask.running=true`，`nextRunAt=2026-09-23T23:00:00.000Z`（次日上海 07:00） | 已确认 |
| 暂停巡查仍在运行 | **否**：`running=false` / `idle`（见下） | 已确认（如实记录） |
| 重启引起真实广告动作 | **0** | 已确认（第 6 节） |

### 暂停巡查状态（单列）

- `watch-drill.boot()` **只装配并登记每日开启任务，不自动启动暂停巡查**。
- 当前已过上海 08:00；若 `POST /api/watch-drill/start`，`monitor.start()` 会**立即 `pollOnce`**（真实广告页 + 可能通知）。
- 本阶段禁止 pollOnce / 真实页 / 通知，**故未手动拉起**。「暂停巡查仍在运行」**未满足**；恢复须主脑另令。

---

## 6. 是否有真实广告动作（预期 0）

**计数：0。**

1. 未执行 enable/pause/switch，未手动 `pollOnce`。
2. `lastRound=null`，无新巡查周期。
3. `notify.lastStatus/lastAt=null`，`lastCycleNo=0`（启动后未发通知）。
4. 每日开启 `waiting_window`、`lastRunAt=null`，今日窗口已过且未补开。
5. `deleteAdEnabled=false`；配置未改动。

真实广告页操作：**0**。

---

## 7. 仍未验证（不得宣称上线）

| 项 | 状态 |
|---|---|
| 真实广告页读写 / 回读核验 | **未验证** |
| 07:00 真机每日开启业务结果 | **未验证**（仅调度已登记） |
| 08:00 后阈值暂停真机结果 | **未验证**（暂停巡查未运行） |
| 生产上线 | **不得宣称** |

---

## 8. 一句话结论

**重启后 Node 进程（PID 9956）经 require.resolve 加载正式仓 C 与 bill-manager 最新磁盘字节，四文件 sha256 全量一致，无旧目录 D 路径；07:00 调度已登记；本阶段真实广告动作 0。暂停巡查未在运行（boot 不自动启动，且禁止立即 pollOnce）。真实页面与 07:00 真机业务结果仍未验证。**
