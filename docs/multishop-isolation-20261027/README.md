# 多店会话隔离调用链修复

2026-10-27。修复已存在的隔离与错误分类漏洞：分析器按精确店名选文件，恢复后关闭旧进程再以新进程加载本店副本；初始及恢复登录被动等待45秒内跳转，页面/导航故障不产生过期删除信号；成功恢复推进基线及登录成功标记。值守恢复首选与旧来源分别有界尝试，避免只读健康备份被永久排除。检查点校验使用独立候选浏览器，拒绝共享进程且不关闭外来主浏览器；千川保存校验延至业务读取结束后的唯一关闭收尾，不在业务读取前重复校验。

没有新增功能、设置或界面。两个只读角色共243版本的内容、修改时间和只读属性由本机验收核对；仅正常可写副本按已有恢复流程更新。本机按成员此前恢复三店值守授权，恢复简尚enabled，其余业务阈值、ROI、每日数量不改；生产配置未上传。

测试：最终专项app 34/34；guard 126/126；真实Edge独立PID/临时目录及关闭旧分析进程后全新加载合成Cookie测试通过。另48项旧应用兼容测试有8项既有失败，修改前后逐项一致，无新增失败，详见本机对照日志。

本提交交付精确生产差异、批准前后SHA256及无凭据离线源码夹具。历史默认源码与本机已验收生产版本存在其他差异，不用整包旧源码覆盖生产，也不声称默认src已与生产完全一致。配置、真实Cookie、归档、运行数据、私有日志及备份均未上传。生产读取结果和加载证据以本机reports/multishop-isolation-20261027/final-acceptance.json为准。

复验（使用已有Playwright依赖，全部合成输入，无真实登录/导航）：

    node --test docs/multishop-isolation-20261027/offline/app/tests/multishop-isolation-regression.test.js
    node --test docs/multishop-isolation-20261027/offline/guard/test/checkpoint-process-isolation.test.js docs/multishop-isolation-20261027/offline/guard/test/multishop-isolation-regression.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-process-isolation.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-archive-provenance.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-workcopy-r96.test.js docs/multishop-isolation-20261027/offline/guard/test/cookie-finalization-r87.test.js

追加修复（2026-10-28）：有限收口探测耗尽后，底层任务迟到结束时，由一次性结束通知复用原关闭证明及身份检查释放阻断；不启动新读取、不开新页面、不增加计时轮询、不伪装健康。新及既有资源收尾/截止测试37项通过，连同最终隔离专项共160项通过。生产三店读取结果仍须独立实测，代码测试不等同于平台会话有效。

补充复验：node --test docs/multishop-isolation-20261027/offline/guard/test/late-read-gate-settle.test.js docs/multishop-isolation-20261027/offline/guard/test/dian4-unknown-gate-ownership.test.js docs/multishop-isolation-20261027/offline/guard/test/enable-read-deadline.test.js

归档截断修复 D10R/D11R（2026-10-28）：恢复选择优先覆盖不同会话，剩余名额保留同会话变体；仅恢复内部的本地只读归档扫描上限200，普通调用仍50，平台验证仍guard5+5/app4+3。既有SHA、店名、独立进程、关闭证明和并发文件比较保持。199项专项最终复跑通过；首次全量一次恢复用例未通过，单项及全量复跑通过，尚未定位偶发原因，记录保留本机test-first-failure-D11R.json摘要与复跑日志。真实只读文件选择从4组扩至7组；这不证明这些会话被平台接受，也不代表三店业务已完成验收。三个恢复源文件已按批准哈希加载，配置及两类只读Cookie未写入。

跨轮候选覆盖修复 D12（2026-10-28）：同一登录配置、同店工作文件和未变化指纹下，只在内存记录明确login-invalid且无收尾阻断的失败；后续优先未试过的会话，再尝试同会话其他字节副本。瞬态/身份未核验/关闭不明确不按坏凭据缓存，成功、文件指纹变化、配置对象变化或本批耗尽后重置；没有持久游标、配置、计时器或UI。单次仍5+5验证、本地归档仍200。RAM失败记录256可覆盖最多206个有界候选，避免原64容量提前重置导致旧备份永久不可达。211项专项及独立87版本/206候选容量测试通过；曾退回失败版本及两处夹具错误，未将其加载生产。两个只读角色不写入。真实平台是否接受历史会话仍以运行回执验收，不凭测试宣称两店已恢复。

独立验收：node --test docs/multishop-isolation-20261027/offline/guard/test/independent-history-acceptance.test.cjs
