# G1/G2/G3 统一修复 — 第一组测试失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 纪律：两组命令各只跑 **1 次**；第一组非 0 → **停止**，不跑第二组、不循环修改
- 边界：不改生产配置、不启停服务、不连广告/飞书、不发通知、不提交、不推送

---

## 1. 修改文件（本阶段）

| 文件 | G | 变更 |
|------|---|------|
| `src/engine/ad-switch-state.js` | G1 | 混合 → **`mixed`**（不再 unknown）；空清单仅 `confirmedEmpty` → `off`；无法识别行 → `unknown` |
| `src/engine/ad-switch-decision.js` | G1 | `mixed`：above→`should_pause`，below→`should_enable`，equal→零动作；unknown 仍 fail-closed（不因 over 绕过） |
| `src/engine/ad-switch-orchestrator.js` | G1 | `evaluateDailyEnable`：mixed→`should_enable` |
| `src/engine/monitor.js` | G2 | `_pollShop` 顺序：数据核验 → **控制路径/scope** → **超标时间窗** → 清单回读（身份失败→**blocked**）→ 决策 |
| `src/engine/monitor.js` | G3 | `_commitExecutedBatch` 唯一落库；`_executeEnableBatchFor` 不再写 actions；`blocked*` 不进 actions |
| `src/engine/monitor.js` | G2 | `_readCurrentAdState` 返回 `{state,error?}`；清单/身份错误不得包成 ok |
| `test/monitor-chengfang.test.js` | G4 | 仅 fixture `mapRowsToAdState`：mixed 对齐生产（保留原有 readAdState/live 改动） |
| `test/ad-switch-decision.test.js` | 测试 | 补 mixed / unknown 矩阵 |
| `test/ad-switch-integration.test.js` | 测试 | 补 mixed、门禁优先级、批次单次记录 |

---

## 2. 第一组测试（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js` | 58 | **57 pass / 1 fail** | **1** |

**完整输出文件（绝对路径）**：  
`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase8-group1-test-output.txt`

**第二组未执行**（约定：第一条非 0 立即停止）。

### 失败 1 条

| 项 | 内容 |
|----|------|
| 名称 | 门禁优先级：清单身份失败 → blocked（不包成 ok/unknown 零点击） |
| 位置 | `test/ad-switch-integration.test.js:789`，断言 `:817` |
| 预期 | `status: 'blocked'` |
| 实际 | `status: 'stopped'` |
| 日志 | `全店推广费用未提供广告账户ID，无法核验与配置账户 1710242295996424 的映射关系，拒绝采用` |

**归类**：**测试装配问题**（本条新用例），不是 G1/G2/G3 产品逻辑未修好。

原因：该用例给 `SHOP` 配了 `accountId`，但 `makeLinkedReader` 未传 `costAccountId`，费用源身份在 **`readAndEvaluate` 阶段**先失败，走 `_pollShop` catch → **`stopped`**，**尚未**到达「广告清单身份」→ 本应 `blocked` 的路径。  
对照：原 `monitor.test.js` 同类用例 shop **无** `accountId`，费用核验通过后才在 `listAllAds` 撞清单身份 → `blocked`。

按约定 **不改断言、不循环修改**。

---

## 3. G1/G2/G3 修复位置与行为（代码已落地，以第一组 57 条通过为旁证）

### G1 mixed

- **位置**：`ad-switch-state.js`（映射）、`ad-switch-decision.js`（决策）、`ad-switch-orchestrator.js`（日程）
- **行为**：部分 on/off → `mixed`；above+mixed→`should_pause`（执行器只停 on 项）；below+mixed→`should_enable`（只开 off 项）；equal+mixed 零动作；无法识别/不完整 → `unknown` 阻断
- **证据**（第一组已过）：`mixed：above+mixed → should_pause…`、`mixed 不得当 unknown…`、`映射：…混合→mixed…`

### G2 门禁优先级

- **位置**：`monitor.js` `_pollShop` / `_readCurrentAdState`
- **行为**：scope → 超标时间窗 → 清单/身份 → 再决策；`already_off` 不得把 `blocked`/`window_blocked` 包成 `ok`；窗口外不打开执行会话
- **证据**（已过）：`门禁优先级：无控制范围 → blocked`、`门禁优先级：超标 + 07:59 → window_blocked`（exec=0）
- **清单身份 → blocked**：产品路径已按 error→blocked 设计；**本条用例装配有误**（见 §2），待主脑指令后再验

### G3 批次单次记录

- **位置**：`monitor.js` `_commitExecutedBatch`；`_executeEnableBatchFor` 去掉 `_recordBatch`/`actions`
- **行为**：成功开启 **1 条** actions；`blocked_window` **不进** actions
- **证据**（已过）：`批次单次记录：enable 成功只记一条 actions；blocked 不进 actions`
- **说明**：`actions[]` 是审计记录，**不是**真实点击次数（底层 click/close 另计）

---

## 4. 13 条原失败是否逐项解决

| 原 # | 摘要 | 本阶段 |
|------|------|--------|
| 1–8 monitor.test.js | mixed→unknown 短路 | **G1 映射已改**（mixed）；**第二组回归未跑**，不能在本汇报中宣布关闭 |
| 9 无 scope | already_off 吞 blocked | **G2 已修**；集成等价用例已过 |
| 10 actions 2≠1 | 双写 | **G3 已修**；集成单次记录已过 |
| 11 07:00 window | already_off 吞 window | **G2 已修**；集成 window 用例已过 |
| 12/13 blocked 入 actions | G3 | **G3 已修**；集成已过 |
| G4 fixture | mixed 映射 | 已对齐生产；未覆盖其它 G4 改动 |

**结论**：G1/G2/G3 **代码修复已实施**；13 条是否逐项变绿 **需第二组回归确认**（本回合未跑）。

---

## 5. 证据摘要

- mixed 目标筛选：第一组 `mixed 目标筛选语义…` 通过  
- 门禁优先级：`无控制范围 → blocked`、`07:59 → window_blocked`（底层 execute=0）通过  
- 批次单次记录：`enable 成功只记一条 actions；blocked 不进 actions` 通过  
- 返回记录 ≠ 底层点击：测试分别断言 `calls.*` / `exec` 与 `actions.length`

---

## 6. 两组命令

| 顺序 | 命令 | 结果 | 输出 |
|------|------|------|------|
| 1 | `node --test test/ad-switch-decision.test.js test/ad-switch-integration.test.js` | 57/58，退出码 **1** | `docs/phase8-group1-test-output.txt` |
| 2 | `node --test test/rules-guard.test.js … chengfang-executor.test.js` | **未执行** | — |

---

## 7. 尚未验证

- 真实广告页面  
- 07:00 真机 / 真实值守  
- 13 条原失败在第二组回归中的最终状态  

---

## 8. 停止

第一组失败即停。等待主脑统一指令（例如：修正该条测试装配后允许重跑两组）。
