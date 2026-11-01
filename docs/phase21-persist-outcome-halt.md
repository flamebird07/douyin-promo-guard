# persistence_blocked 映射丢失 — 失败即停汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 针对性测试 1 次；失败即停（未跑 npm.cmd test）

## 1. 三个失败核实

| 用例 | 期望 | 实际 | 结论 |
|------|------|------|------|
| 动作前写入失败 | `outcome=persistence_blocked` | **null**（test:94） | 仅 outcome 映射丢失 |
| 原子替换失败 | 同上 | **null**（:112） | 同 |
| 三种入口 | 同上 | **null**（:124） | 同 |

同套件 4 条通过（确认后不放锁、已发出非 zeroClick、重启 unknown、正常保存）→ **不是**保存顺序/锁/底层调用错误。

## 2. 修改

- `src/engine/ad-switch-orchestrator.js` `_settleFromExecute` never_sent：强制保留 `persistence_blocked` 作 outcome  
- `src/engine/monitor.js` `_mapSwitchReturn`：该 outcome → `status:blocked`，persist 失败补 outcome  
未改测试、锁条件、保存顺序。

## 3. 动作前/后返回

- 前：应 `persistence_blocked` + `zeroClick:true` + 底层 0（outcome 仍 null）  
- 后：保留真实 outcome + `persistence` 字段，`zeroClick:false`，锁不释放  

## 4. 测试

`node --test test/ad-switch-persist-guard.test.js`：**7 / 4 pass / 3 fail / exit 1**  
输出：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase21-persist-test-output.txt`  
报告：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase21-persist-outcome-halt.md`

## 5. 边界

隔离通过 ≠ 上线；界面集成与真实业务验收未完成。

完成后停止。
