# R123/R124/R125 千川多店发布流程加固（2026-10-17）

本目录只固化这次真实页面补救涉及的行为，不引入新框架、定时任务、自动重试服务，
也不改动 Cookie 回写 CAS / 双份隔离、final/nonce/authority/forge 消费语义。

## 变更文件

| 文件 | 范围 |
| --- | --- |
| `plan-workflow.cjs` | 可用性证据分类、整批/部分移除模式、durable cursor 前进证明、绑定+配置后的审核稳定性合同、prepare→repair 合同透传 bind 失败信息；R124：真实入口稳定读、bind 失败整批证据、配置后晚到失败的有界替换/复绑/重配；R125：fresh 稳定行与 bind 明确逐商品证据合并、`provenDuplicateIds` 透传 repair |
| `run-plans.cjs` | 指导浮窗 `跳过` 优先级、known 管理浮窗关闭、取消账号选择确认、产品 panel 加载/spinner/稳定读、管理页一次只读 refresh、稳定行读取驱动；R124：日常/手动入口接线稳定读与三个开关、真实 bind 失败返回 rows/failedIds/理由、数字 cursor 走 `advanceCatalogCursor`、`requireNextPage` 前进证明；R125：hover tooltip 逐账号取证、repair 前先正向关闭 drawer、requireNextPage 在 browse 内实际翻页 |
| `flow-hardening-r123.test.cjs` | 新增离线行为/负例测试（fake DOM / fake page / fake clock 语义），零真实浏览器、网络、广告；R124 更新为完整入口补救路径 + unknown 负例 + 真实 binder 证据链；R125 增加可归属 tooltip DOM fixture + 真实 driver 链路、repair 先关抽屉链路、证据合并 |
| `README-flow-hardening-r123.md` | 本说明 |

## 关键行为

1. **指导/浮窗**：只允许既有 `.c-lib-guide-mask` / FIREFLY 开放 ShadowRoot 范围内的
   `下一步 / 我知道了 / 知道了 / 完成 / 跳过`；同一 guide 同时出现 `跳过` 与 `下一步` 时
   按 `跳过 → 我知道了 → 知道了 → 完成` 的固定优先级只点一个；同优先级重复/多个`下一步`
   仍是未知形状、零点击。管理页只关闭两项 known：余额提示的唯一 `我知道了`、营销弹窗的
   唯一 `aria-label/title=关闭`；`投放乘方 / 开启货款直投 / 发布计划 / 下一步` 永不作为
   关闭目标；未知弹窗零点击停止。
2. **取消账号选择**：`取消` 之后若出现已知确认（`确定要取消选择抖音号吗…再想想…确定`），
   要求唯一可见+启用的 `确定`，点击后必须再读出 drawer 与确认层都已消失才继续；
   不改 disabled、不 force、不在遮罩后点击。只有正向 `closed` 证据后才移除 draft 行。
3. **panel 可用性**：`ovui-spin__block` 未消失、panel 集合不等于本批 30、active 不是当前
   商品、行/footer 读取不确定，一律不是 settled；生产额外要求连续两次快照一致。
   灰色/禁用本身只算 `disabled-unknown`，不是“已存在计划”。
4. **重复/不可绑**：只有平台明确文案 `商品与该抖音号已存在商品投放计划`（或明确
   review-failed / 明确 auto-pull-only）才可整批判定；30 条全部有证据 →
   `whole-batch-removal`，部分坏 → `partial-removal`；任何未知行阻断移除与补齐。
   `bindAccountsToAll` 失败不再只返回 `account-anchor-no-usable-product`：真实驱动带上
   已读 `rows`、逐商品 `failedIds`、settled panel 的 hover/title 文案与
   `bindingEvidence`（`proven` 只认明确文案，gray 不算）。
5. **cursor**：持久化在**当前 shop 的 day state**；数字页只认 `observedPage =
   previous+1` 才前进（真实调用 `advanceCatalogCursor`，未知/回退/跳页在写 cursor 前抛错），
   native 分类只保留分类游标且不伪造数字页，切换分类回第 1 页；超时/未知不是 EOF。
   `repairDraft` 的 `requireNextPage` 会实际生效：整批/部分移除后不得回退 cursor、不得
   复用被移除 id；整批轮次还必须证明数字页前进 / 分类切换 / native seen 增长之一。
   seen 与 attempted 随 shop day state 持久化，attempted 是当日集合，不做永久黑名单。
6. **审核晚到**：绑定后与配置后都做有界**只读**稳定读。`awaitMainTableStable`
   `ok !== true` 时其返回行**绝不**当作 ready/可用，直接停在 `stable-read`，不配置、不发布。
   配置后晚出现的明确 `当前商品广告审核不通过` / 明确重复行会进入逐行移除、从 durable
   cursor 补齐、复绑、重新配置可信参数、再做稳定检查的有界循环（最多 2 轮配置后修复），
   最终要求 30 unique、每行 manual>=1、无 reviewFailed；unknown/ambiguous 仍零移除停止。
7. **管理页回读**：精确同名、精确账号、new plan id vs 预点旧 id、30 商品、账号 1-2、
   ROI/预算/含佣完整匹配；旧 SPA 缓存或缺少同名行时，允许对**正确管理页**做一次
   `reload` 后重新完整读取（只读，不重新 publish/final/reopen/启停删除），仍未知则
   `unknown`，不补成功。
8. **hover tooltip 重复证据（R125）**：真实重复文案只出现在悬停禁用 checkbox 后弹出的
   浮动 tooltip。`bindingRowTooltipInPage` 只读唯一 drawer、唯一 `.panel`、唯一 active、
   唯一账号行与该行唯一禁用 label 的**可归属** tooltip（行内 / aria-describedby / 紧贴
   label 的浮层），不扫全 body、不用 `nth(1)`。悬停前后都复核 active / 精确 30 panel /
   spinner / rows+footer / 账号 id；残留下拉、另产品浮层、未知文案、授权漂移都返回
   `proven:false`。只有该商品**每一个**账号行都逐一无残留地读到精确文案才记一条
   `alreadyPlanned`；任一账号可用即走正常绑定。30 商品全部被证明才返回 `duplicateProven`
   并整批 repair；29/30 仍是零移除停止。证据按 batch epoch + accountId 存放，每次
   `bindAccountsToAll` 先清空，不会跨 batch / 授权漂移复用。
9. **repair 顺序（R125）**：`repairDraft` 在**第一次 remove 之前**必须调用
   `closeAccountDrawerBeforeDraftRemoval`：识别当前 drawer → 唯一启用 `取消` → 精确文案
   确认层（唯一可见启用 `确定`）→ 正向证明 drawer 与确认层都为 0 且无 blocking overlay
   → 才允许 remove。未知/多根/文案漂移/未启用/未闭合一律零 remove；原本无 drawer 的页面
   也走同一正向证明，但仍可继续；不认识 drawer census 的旧 fake 保持原路径。
10. **证据合并（R125）**：bind 失败后即使 `awaitMainTableStable` 重新读表（fresh 行没有
    tooltip 文案），也只按精确 productId 合并 explicit `alreadyPlanned/reviewFailed/
    autoPullOnly` 标志，不复制 manual 计数；merge 后重新算 `provenDuplicateIds` 并透传
    repair。`repairDraft` 对 fresh 行仍要求“行仍存在”，但接受已经证明的重复 id，不再
    因为没有 `manual 0` 而拒绝已证明重复；无证明时仍零移除。
11. **向前浏览（R125）**：`requireNextPage` 在 `browseProducts` 内实际执行——同一数字
    分类从 `cursor.page+1` 开始扫描（观测到 +1 才推进，边界即结束本分类），不是只做
    事后检查；repair 的 cursor 回退判定只在**同一分类**内成立，切到别的分类回 page 1
    是正常前进，不误判为回退。

## R126 异常门禁与策略撤销恢复

- **drawer 异常门禁（R126）**：`closeAccountDrawerBeforeDraftRemoval` 只有在
  `cancelConfirmHandling === true && requireDrawerStability === true`（真实日常入口的
  两个生产开关）时，才把 drawer census 读取异常 / 授权 URL 未知视为 fail-closed：
  `ok:false` 且零 remove。仅一个或两个开关都不传的旧 fake 保持 R125 之前的兼容路径；
  真实入口不会因此放宽。新增两个负例（census throw、URL throw）进
  `flow-hardening-r123.test.cjs`。
- **legacy pre-initial policy-cancel（R126）**：`proveSchedulerReleaseProof` 新增一个狭义
  分支：rec `unknown` + plans 0 + 唯一 entry `1` unknown + 精确 reason
  `scheduled-policy-drift-before-initial:policy-disabled-or-not-autoconfirmed` +
  `rec.error === 'unknown:'+reason` + entry/rec 无 CID/planId/manifest/nonce/frozen，
  且独立新鲜 day-state 证明（`preparation-stopped` plan 1、无 runId/frozen/nonce、
  plans/confirmationConsumptions/manual 为空、attempts 三表当日为零）与 `sourceHash`
  逐字绑定。映射仍只经唯一 `applySchedulerReleaseToRecord` → `unsubmitted`，
  `releasedFrom`/原 reason/其它店原样保留；任意 unknown/已消费/已冻结/多 entry/
  另一个账户/配置撤销/锁忙/源字节漂移一律零改动。
- **未来 writer（R126）**：`runScheduledPlan` 的 `driftBeforeInitial` 分支不再先覆盖
  `ready-awaiting-confirmation`。新增
  `applyProvenPreInitialPolicyCancelClose`：从**仍带 frozen** 的原始状态独立证明
  attempts/CID/runId/同日份号零消费，再写 `preparation-stopped`，原 runId/planNumber/
  date 与 frozen nonce/CID 以 `frozenDisposition`（clicked:false/consumed:false）保留审计；
  返回既有 `preparation-stopped + preparationClosure`，由既有 scheduler 映射收口。
  证明不成立仍停止，绝不清掉 frozen 再声称无冻结。
- **离线验证**：`node app/tests/policy-cancel-recovery-r126.test.js` 覆盖
  ready/frozen → 零消费收口、无 runId legacy 不编造、已消费/已清 frozen/manifest 被改
  拒绝且源字节零改动、release 后 tick 只补 3 份缺额且旧 nonce 不进入账本。

## R127 可选 attempts 表的合法缺省

- **背景**：S126 已验收；新后台正式恢复仍被
  `release-proof-not-established:policy-cancel-attempts-malformed` 拒绝，零广告动作、
  零账本修改。实际店铺 attempts 文件 schema 为 `consumed`（19 条历史）+
  `finalConsumed`（19 条历史），`reopenConsumed` 从未使用因此键不存在（undefined），
  不是损坏；guard `loadAttemptsStore` 本身也把 `finalConsumed` / `reopenConsumed`
  视为可选，只在**存在**时要求非 null、非数组的对象。
- **补丁**：仅 `provePreInitialPolicyCancelState` 的 attempts 结构检查与 guard 语义对齐：
  `consumed` 仍是必需合法对象；`finalConsumed` / `reopenConsumed` **键缺失**时按空表
  做只读零消费证明。null / array / scalar 仍 malformed；缺失/undefined 的 `consumed`
  仍 malformed；当日记录、非空历史、record 字段校验、同日消费/未决/跨店/源码 hash/
  nonce/CID/锁/配置等门禁全部不变。证明只读，绝不把空表写回源文件制造“合法”，
  也不清账本、nonce 或状态。
- **离线验证**：`flow-hardening-r123.test.cjs` 追加两例（原 29 例保留）：19+19 历史且
  `reopenConsumed` 缺失、双可选表缺失、三表皆空均证明 ok 且源字节不变；optional
  null/array/scalar/number、required 缺失/null/array/scalar、当日记录、坏历史记录
  均被拒绝且源字节不变。

## 入口接线（R124）

日常 `runScheduledPlan` 与手动 `main` 都向 `preparePlan` 传
`awaitMainTableStable`，并在 `createRealDrivers` 传
`dismissObstructions / cancelConfirmHandling / requireDrawerStability = true`。
离线旧测试不传这些开关，保持原有节奏与断言。Root 的入口测试用注入 fake 驱动证明
**真实日常入口**确实调用了稳定读，且 `ok=false` 时未进入配置。

## 离线验证

```bash
CANDIDATE_PUB_DIR=<workspace>/publisher node --test reference/root-entry-wiring.test.cjs reference/root-binding-safety.test.cjs
node --test publisher/flow-hardening-r123.test.cjs
node --test publisher/plan-workflow.test.cjs publisher/direct-draft-controller.test.cjs publisher/multi-shop.test.cjs
```

`publisher/guidance-runtime.test.cjs` 在本工作根不存在（已如实记录，不伪造）。
原有 4 个 baseline 失败与本次改动无关：bind driver 1-of-2、final confirm drift、
R29 leaf guide overlay、R40 redirected field-incomplete；三文件原回归 475 项 / 471 通过 /
4 失败。没有删改任何旧断言、fixtures 或 reference。无网络、无依赖安装、无 Git、
无正式入口、无 Cookie/端口/生产 state。
