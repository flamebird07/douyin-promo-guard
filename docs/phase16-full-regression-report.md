# phase16 完整隔离回归 — 阶段报告（更新）

- 项目：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard`
- 区分：上一回 **未启动** vs **本轮已启动并跑完**

## 1. 启动错误实际原因

| 轮次 | 入口 | 现象 | 根因 |
|------|------|------|------|
| 上一回 | 外层工具 shell 调 `npm test` | `/usr/bin/env: 'bash': No such file or directory`，exit **127** | **外层工具**用 bash 包装；本机无该 bash。npm `script-shell` 为 **null**（Windows 默认），**不是** npm/业务/测试失败 |
| 本轮 | Windows **cmd.exe** + 本进程 `npm_config_script_shell=cmd.exe` + `npm.cmd test` | 正常执行 | 工作目录：`C:\Users\Administrator\Documents\电商助手\douyin-promo-guard` |

## 2. Node / npm 路径、版本、执行方式

| 项 | 值 |
|----|-----|
| node | `C:\Program Files\nodejs\node.exe` **v24.14.0** |
| npm | `C:\Program Files\nodejs\npm.cmd` **11.9.0** |
| script-shell | **null**（未改全局配置） |
| 本轮执行 | `cmd /c` + 显式工作目录 + `set npm_config_script_shell=cmd.exe` + `npm.cmd test`（仅本进程） |
| 未做 | 不安装 Bash、不改全局 npm、不改业务代码 |

## 3. 本轮测试结果

| 项 | 值 |
|----|-----|
| 命令 | `npm.cmd test`（package.json 全清单 20 文件） |
| tests | **448** |
| pass | **448** |
| fail | **0** |
| skipped | **0** |
| cancelled | **0** |
| 退出码 | **0** |
| 输出绝对路径 | `C:\Users\Administrator\Documents\电商助手\douyin-promo-guard\docs\phase16b-npm-test-output.txt` |

失败名称/预期/实际：无。

## 4. 与未启动 / phase15 的区分

| 轮次 | 范围 | 结果 |
|------|------|------|
| phase15 | 选定 8 文件 | 268 pass / 0 fail |
| phase16 上一回 | `npm test` | **未启动** exit 127 |
| **phase16 本轮** | **完整** 20 文件 | **448 pass / 0 fail** exit **0** |

## 5. 边界

完整隔离回归通过后仍需主脑审查执行链与集成层；不得声称已上线或真实业务验收完成（真实页面 / 07:00 真机未验证）。

完成后停止。
