# 多店会话隔离调用链修复

2026-10-27。修复已存在的隔离与错误分类漏洞：分析器按精确店名选文件，恢复后关闭旧进程再以新进程加载本店副本；初始及恢复登录被动等待45秒内跳转，页面/导航故障不产生过期删除信号；成功恢复推进基线及登录成功标记。值守恢复首选与旧来源分别有界尝试，避免只读健康备份被永久排除。检查点校验使用独立候选浏览器，拒绝共享进程且不关闭外来主浏览器；千川保存校验延至业务读取结束后的唯一关闭收尾，不在业务读取前重复校验。

没有新增功能、设置或界面。两个只读角色共243版本的内容、修改时间和只读属性由本机验收核对；仅正常可写副本按已有恢复流程更新。本机按成员此前恢复三店值守授权，恢复简尚enabled，其余业务阈值、ROI、每日数量不改；生产配置未上传。

测试：最终专项app 34/34；guard 89/89；真实Edge独立PID/临时目录及关闭旧分析进程后全新加载合成Cookie测试通过。另48项旧应用兼容测试有8项既有失败，修改前后逐项一致，无新增失败，详见本机对照日志。

本提交交付精确生产差异、批准前后SHA256及无凭据离线源码夹具。历史默认源码与本机已验收生产版本存在其他差异，不用整包旧源码覆盖生产，也不声称默认src已与生产完全一致。配置、真实Cookie、归档、运行数据、私有日志及备份均未上传。生产读取结果和加载证据以本机reports/multishop-isolation-20261027/final-acceptance.json为准。

复验（使用已有Playwright依赖，全部合成输入，无真实登录/导航）：

    node --test docs/multishop-isolation-20261027/offline/app/tests/multishop-isolation-regression.test.js
    node --test docs/multishop-isolation-20261027/offline/guard/test/checkpoint-process-isolation.test.js docs/multishop-isolation-20261027/offline/guard/test/multishop-isolation-regression.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-process-isolation.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-archive-provenance.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-workcopy-r96.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-finalization-r87.test.js
