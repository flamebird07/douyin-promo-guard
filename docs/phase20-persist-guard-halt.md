# 动作状态持久化失败阻断 — 验证汇报（失败即停）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 针对性测试 1 次；失败即停（未跑 npm.cmd test）

## 1. 保存顺序

1. `tryBegin` 占槽 actionId  
2. **发动作前** `monitor._persistBeforeDispatch` → `_saveState`（返回 `{ok,reason}`）；失败 → `persistence_blocked`、neverSent、**零 runner**  
3. runner/executor 底层开关  
4. settle：confirmed **先** `persistBeforeRelease` **再** `markSettled`；保存失败 → `markUnknown` **不释放**  
5. never_sent 可 `markNotSent`；保存失败带 `persistence` 字段  

`_saveState` 原子写；失败不覆盖已有 `state.json`。日志写入失败未改成业务阻断。

## 2. 修改文件

- `src/engine/monitor.js`（`_saveState` 真实返回、`_persistBeforeDispatch`、execute 前持久化）  
- `src/engine/ad-switch-orchestrator.js`（`persistBeforeRelease`、confirmed 先存后放锁、`persistence_blocked`）  
- `test/ad-switch-persist-guard.test.js`  
- `package.json`（追加 persist-guard）

## 3. 故障返回 / 锁 / 底层（已过用例）

- 确认后保存失败 → `serial:unknown` + 保持阻塞，不释放  
- 已发出后保存失败 → `zeroClick:false`、click=1、不重复点  
- 重启未完成 → unknown；恢复后可 tryBegin  
- 正常保存路径：`all_paused_confirmed`、释放、pause=1  

## 4. 测试

| 命令 | tests | pass | fail | 退出码 | 输出 |
|------|-------|------|------|--------|------|
| `node --test test/ad-switch-persist-guard.test.js` | 7 | 4 | 3 | **1** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase20-persist-test-output.txt` |

失败 3 条同一根因：`outcome` 期望 `'persistence_blocked'` 实际 **`null`**（execute 已返回该码，settle→`_mapSwitchReturn` 未透传）。  
npm.cmd test 未执行。

## 5. 边界

界面集成与真实业务验收未完成；**不能声明上线条件**。

完成后停止。
