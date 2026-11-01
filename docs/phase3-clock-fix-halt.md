# 第三阶段固定时钟装配修复 — 测试报告（失败即停）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 边界：不启服务、不登录、不访问真实广告页、不调飞书、不真实开关广告、不发通知、不提交、不推送、不改真实配置
- 纪律：集成测试只跑 **1 次**；失败 → 不执行回归、不循环重跑

---

## 1. 修改文件

| 文件 | 变更 | 性质 |
|------|------|------|
| `test/ad-switch-integration.test.js` | `setupMonitor` 抽出固定 `nowFn = () => shanghaiMs('2026-09-12','08:30')`，**同一 `nowFn` 同时传给** `makeLinkedReader` 与 `new Monitor` | **仅测试装配** |

未改：`ad-switch-state.js` / `ad-switch-orchestrator.js` / `switch-serial.js` / `monitor.js` 生产逻辑；未改跨日校验；未用真实墙钟作 fixture 默认值。

装配核对（符合要求）：

- 费用/订单（`makeLinkedReader`）与 Monitor 共享注入 `nowFn`
- 广告状态回读（`readAdState`）为 fixture 注入，不读 `adBelief`
- 07:00 enable / 低于阈值 enable / 高于阈值 pause 共用 Monitor 内持久化串行门
- unknown / 回读失败 / 跨日 / 身份失败 → 零动作（本文件纯编排器用例已覆盖并通过）

---

## 2. 集成测试结果（只跑 1 次）

| 命令 | 数量 | 结果 | 退出码 |
|------|------|------|--------|
| `node --test test/ad-switch-integration.test.js` | 25 | **23 pass / 2 fail** | **1** |

与上一轮（15/10）对比：时钟装配修复生效，主链路 10 条中 **8 条已通过**。

**回归未执行**（约定：第一条非 0 → 立即停止）。

**说明：fixture/mock 集成测试，不是真实值守 / 07:00 真机 / 真实页面验证。**

---

## 3. 仍失败的 2 条（已停止，未改生产）

| 用例 | 断言 | 实际 |
|------|------|------|
| 主链路集成：动作回读失败（partial）→ 下一周期不补点 | `r2.results[0].blocked === 'serial_gate'` | `undefined` |
| 主链路集成：07:00 日程开启与周期 pause 并发 → 第二个被串行门阻止 | `rPause.blocked === 'serial_gate'` | `undefined` |

### 失败归类

**装配问题**（时钟/跨日）—— **已修复**，不再出现。  
**决策问题** —— 未发现（should_* / zeroClick 矩阵均过）。  
**串行门/持久化问题** —— **门本身工作正常**（不补点、并发阻止在纯编排器用例已验证；本两条也确实未再次调用 execute）。  
**剩余为 Monitor 返回值映射问题（生产逻辑）**：

`monitor.js` → `_runShopSwitchAction` 中分支顺序：

1. `if (settled.zeroClick) return { status:'ok', zeroClick:true, ... }`  
2. `if (settled.blocked === 'serial_gate') return { blocked:'serial_gate', ... }`

`runSwitchAction` 在串行门拒绝时同时设置了 `zeroClick: true` **和** `blocked: 'serial_gate'`，于是先被 (1) 吞掉，`blocked` 字段未带到 `results[0]`。  
门拒绝语义正确，仅 **pollOnce 结果契约字段** 未透出。

按你的规则「生产逻辑确有独立错误 → 记录并停止，不顺手扩大修改」，**本回合不修 `monitor.js`**。

---

## 4. 明确仍未验证

- 真实值守  
- 07:00 真机  
- 真实广告页面  
- monitor / chengfang / close-flow 回归（本回合按约定未跑）

---

## 5. 停止

时钟装配已修；集成 23/2 退出码 1；回归未跑；生产映射问题已记录。等待主脑指示。
