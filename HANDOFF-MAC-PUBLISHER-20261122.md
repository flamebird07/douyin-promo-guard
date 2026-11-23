# MAC 版计划发布——卡点交接报告（2026-11-22 01:30）

> 交接对象：下一个接手调试的 AI/工程师。所有结论均有文件/日志/审计证据，无猜测。
> 仓库：douyin-promo-guard（已全部推送，最新 38313c8）。运行环境：macOS + launchd 常驻服务。

## 一、目标与现状

目标：`plan-publisher/` 每日自动发布 N 条商品自选计划（autoConfirm=true，客户 2026-10-11 合同入口）。
现状：链路已打通到**商品选择器的数字翻页器**，当前卡点见 §三。值守（费比暂停）与每日开启相位均正常。

## 二、本机特有事实（接手前必读）

1. **无 bill-manager 兄弟仓**：调度器用本仓镜像 `integrations/bill-manager/promo-plan-scheduler.js`（runner 已显式 `--scheduler-path` 注入，见 plan-refill-hook）。
2. **发布器状态目录**：`plan-publisher/shop-state/<店名>__<id>/`（每店隔离）、`plan-publisher/daily-plan-config.json`（策略，enabled+autoConfirm）、`daily-plan-data/ledger.json`（账本）。全部 gitignore 不入库。
3. **launchd**：`com.flamebird07.douyin-promo-guard`（RunAtLoad+KeepAlive）。值守有 patrolWanted 自动恢复；发布 tick 由值守巡查完成自动触发（`src/engine/plan-refill-hook.js`）。
4. **严格契约**：`plan-publisher/flow-hardening-r123.test.cjs` 等 53 用例必须保持绿（R42/R126/R127/R128/R63 等编号合同都在里面，改恢复链前先读）。
5. 千川页面计数文案双形态：「预估自动拉取 N 个」（旧）与「自动拉取 N 个」（Mac 新后台实测）——解析器已兼容（plan-workflow.cjs `parseMainTableRow`）。

## 三、当前卡点（按证据）

### 卡点 1：数字翻页器翻页超时（最新停止形态）
- 停止记录：`{"op":"stopped","reason":"numeric-leaf-page-advance-timeout"}`（2026-11-22 00:5x 运行）。
- 位置：`run-plans.cjs` 数字翻页器推进（numericPickerPagingInPage 的 next-page 点击/导航），等待下一页就绪超时。
- 页面：千川创建计划页 `create-ad/overall-product?aavid=<accountId>`，商品选择抽屉打开、已选 30/30。
- 可能原因（按证据排序）：① 平台翻页器在无头/自动化会话下响应慢或请求被风控；② 页面上仍有未清的浮窗挡住翻页控件（清扫器只点「跳过/我知道了/×」精确文本控件，若浮窗控件形态不同则漏）；③ 目录该筛选下无更多商品但 hasMore 未正确翻面。
- 诊断工具（已就位）：`plan-publisher/overlay-diag.log`——numeric-pager-blocking-overlay 时自动 dump 可见浮层类名+跳过控件；`plan-publisher/stuck-page.png`——非成功收口自动截图（本轮停止是 workflow stopped 返回 + preserveOwnedBrowser，截图在进程退出时触发，若进程被杀则无）。
- 复现：`PROMO_PROJECT_ROOT=$(pwd) node plan-publisher/run-plans.cjs --shop 敏敏高定私服`（会弹浏览器，观察卡住的页面）。

### 卡点 2：乘方「可选不可绑」整批轮转（用户 2026-11-22 纠正——不是联盟自动投）
- **误判更正**：此前把 `labelDisabled` / `account-anchor-no-usable-product` / 主表「手动添加抖音号 自动拉取 0 个」归因成「联盟合伙人自动投」——**错误**。用户明确：这是千川新产品**乘方**平台 bug——**曾经发布过计划的商品仍可选进新草稿，但账号行全置灰无法绑定**。不要擅自去关联盟开关。
- 正确策略：对本批 ≤30 个商品**穷举**绑定；**30 个都绑不上就整批丢掉、选目录下一批**；翻完目录才正常终止。有 hover「已存在计划」更好，但不是轮转前提。
- 备注已写入：`.cursor/rules/chengfang-unbindable-batch-rotate.mdc`（alwaysApply）。

### 卡点 3：瑾漂亮店已推进到目录翻页（等下一 tick 自然重试）
- 11-20 的 preparing 遗留已按严格零消费证明收口（`preparationClosed`，recoverLocalPreparationClose）。
- 11-21 的停止（read-only-recovery-required / catalog 响应异常）根因已修（解析器双形态 + 新机无 attempts 文件物化）。
- 预期：下一次值守巡查完成后的补发 tick 自动重试；若再卡，stuck-page.png/overlay-diag.log 会给证据。

## 四、本轮已完成修复（全部已推送）

| 提交 | 内容 |
| --- | --- |
| 1a146e0/a3ad0e0 | 浮窗清扫器上线 + 运行态文件误带纠正 |
| 003e53c | 值守 patrolWanted 持久化 + serve 自动恢复（重启不丢值守） |
| 1821941 | 「计划发布」列（账本投影+卡点原因人性化+上海时间） |
| 23a64d9 | 收尾（浮窗清扫增强等） |
| f4a443d | 解析器双形态修复（真根因：`自动拉取 0 个` 无「预估」前缀被解析成 unknown → 整批误停） |
| b8cd79f | 整批轮转触发修复（归一条件缺字段跳过解析 → every() 全 false）+ 深扫浮窗（跨 frame/shadow）+ 不可绑判定提速（稳定置灰两采样即判死，tooltip 3s 上限） |
| 38313c8 | 数字翻页器阻挡浮窗身份诊断（overlay-diag.log） |

## 五、关键文件地图

- `plan-publisher/run-plans.cjs`：发布主程序。`sweepOverlays`（Node 侧多轮清扫，跨 frame 深扫）/`overlaySweepInPage`（页面内单轮）；`proveAllSuccessByPanelNavigation`（逐商品面板验证，含 noBlockingOrClearGuidance 清后复查）；`proveDisabledActivePanelDuplicate`（置灰悬停取证）；`bindAccountsToAllInner`（绑定入口，含 sweep+guidance+anchor-candidate 诊断）；`runScheduledPlan` finally（卡点截图 stuck-page.png）。
- `plan-publisher/plan-workflow.cjs`：确定性工作流。`parseMainTableRow`（行解析，双形态计数已修）；`classifyAvailabilityEvidence`（可用性分类）；`planRemovalAndBackfill`（移除+回填计算，接受 autoPullOnly 行）；整批轮转门（解析归一已修，b8cd79f）。
- `plan-publisher/daily-plan-runner.cjs`：巡查联动 runner（tick/--check）；`validateDailyConfig`。
- `src/engine/plan-refill-hook.js`：值守巡查完成 → spawn runner（数量同步桥：值守 config 每店条数/ROI 同步进发布配置）。
- `src/adapters/chengfang-reader.js`：`dismissKnownChengfangOverlays`/`handleChengfangOverlayInPage`（管理页严格白名单——本次未改，维护乘方页面安全语义）。
- `src/adapters/qianchuan-reader.js`：`qcOverlaySweepInPage`（千川首页清扫，切账户视图点击前调用）+ 切换超时浮窗诊断。
- 诊断产物：`plan-publisher/overlay-diag.log`（浮窗身份）、`catalog-json-anomaly.log`（目录响应采样）、`stuck-page.png`+`stuck-page.log`（卡点页面）。

## 六、下一步建议（给接手者）

1. 先跑一次复现（§三卡点 1 的命令），人工看弹出的浏览器停在哪个页面；同时读 `overlay-diag.log` 的最新一条拿到浮窗类名。
2. 若浮窗类名确认（例如引导卡容器类），两条路：(a) 加进 `guidanceActionInPage` 的 UNI_PROM 扫描（带 flag 写回，治本防再弹）；(b) 加进清扫器白名单（治标）。建议 (a)。
3. 若翻页器是平台响应问题：抓 `transport` 批次响应（catalog transport 已有 anomaly 采样框架，参照 catalog-json-anomaly.log 的接入方式）确认是风控页/空响应/结构变更。
4. 卡点 2 按「穷举→整批换下一批」实现/回归，勿再提「关联盟自动投」方案。
5. 值守与发布互相独立：值守的 fail-closed 门（realMode+pauseEnabled+时段）不要动；发布链路的浮窗清扫不影响值守安全语义。

## 七、验证基线

- 新增/更新测试全绿：ui-shop-login 5、update-shop-fields 6、shop-activity 6、plan-refill-hook 6、patrol-fixes 4、sensitive-scrub 9。
- 严格契约：flow-hardening 33/33、drawer-settle/decimal-guard 等 53/53 绿（本次改动后复跑确认）。
- 已知基线失败（与本次无关，详见记忆/此前记录）：monitor.test 3-4 个、session-cookie-checkpoint 13 个（缺兄弟仓 bill-manager）、balance-display（缺 ../bill-manager）。

## 八、macOS 发布器修复（2026-11-23）

- 排程发布与账号发现使用完整 Chromium 的无头模式。数字翻页遇到相邻页商品相同，须核对目标页的目录响应、抽屉状态与当前页码。
- 账本恢复核对店铺身份、独立发布记录和提交记录。仅在证明目标计划未提交后恢复重试。
- 草稿换品确认按 DOM 节点去重，忽略 Aurora 的空遮罩。遇到独立未知弹窗时停止。重绑回读不一致时，只有稳定主表能证明当前整批均可替换，才继续翻页换品。
- 值守每次补发都从本机项目目录启动新的发布器进程。Cookie、账本、引导状态和诊断截图都保留在本机。
