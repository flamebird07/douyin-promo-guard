# 身份失败返回契约 — 验证汇报

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 两组命令各 1 次；均通过

## 1. 修改位置

| 文件 | 变更 |
|------|------|
| `src/engine/monitor.js`（`_pollShop` stateRead.error 分支） | 补 `zeroClick:true`、`decision:unknown_blocked`；保留 `blocked` + 身份原因 |
| `test/ad-switch-default-chain.test.js` | 身份失败断言：返回字段 + fixture 开关次数 0 |
| `package.json` | 清单追加 `test/ad-switch-default-chain.test.js` |

未改开启窗口 / enableSource / 串行门；动作可能已发出时仍按执行证据 unknown。

## 2. 身份失败实际返回

```
status: 'blocked'
reason: （含「身份」）
blocked: 'identity' | 'ad_state_read'
zeroClick: true
decision: 'unknown_blocked'
currentAdState: 'unknown'
```

底层开关调用：enable **0**、pause **0**、switch **0**。

## 3. 测试统计

| 组 | 命令 | tests | pass | fail | 退出码 | 输出绝对路径 |
|----|------|-------|------|------|--------|--------------|
| 1 | `node --test test/ad-switch-default-chain.test.js` | 9 | **9** | 0 | **0** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase19-default-chain-test-output.txt` |
| 2 | `npm.cmd test`（cmd + `npm_config_script_shell=cmd.exe`） | 457 | **457** | 0 | **0** | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase19-npm-test-output.txt` |

## 4. 边界

- **持久化写失败仍待解决**（`_saveState` 仅 warn）— **不能声明具备上线条件**  
- 真实页面 / 07:00 真机未验证  

完成后停止。
