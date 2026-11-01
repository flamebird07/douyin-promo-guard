你是只读代码复审员（brain-only）。审查 Qoder CN 落地的「简尚余额未知 / 轮询竞态」最小原子提交修复。禁止修改任何文件、禁止 commit/push、禁止重启服务。

## 仓库
- 父仓: C:\Users\Administrator\Documents\电商助手  HEAD c168b01
- 嵌套: douyin-promo-guard HEAD 08b3730
- 本补丁声称文件（工作区脏，未 commit）：
  1) douyin-promo-guard/src/engine/monitor.js
  2) douyin-promo-guard/integrations/bill-manager/watch-drill.js
  3) bill-manager/watch-drill.js（父仓透传）
- 同工作区另有无关脏改：src/adapters/qianchuan-reader.js（弹窗轨，已另次 Codex PASS_WITH_NOTES）。**本审查不得因 qianchuan-reader 脏而 FAIL/PASS；忽略它，除非本余额补丁改动了它（Qoder 声称未动）。**

## 先验诊断（必须对齐）
见父仓 `_codex_review_balance_null/codex-verdict.txt`：根因是 `_pollShop` 先把无余额的 `_summarizeData` 发布到 `rt.lastData`，余额稍后才 `_applyBalanceToLastData`，造成「新费用 + balanceCents=null」半成品窗口。选择器本身能读到 29973。

## 声称行为
- candidate 组装 cost/orders + 规则投影 + adState/balance 后一次性 `_commitShopLastData`
- 在途 `_markShopDataRefreshing` 保留上一完整快照 + refreshing
- 失败 null+reason；不沿用旧余额冒充本轮；不编造 0；真 0 为整数 0
- refreshShopData 同竞态一并覆盖
- getStatus/watch-drill 透出 balanceStatus/balanceReason/refreshing
- selftest-atomic.js（需 argv[2]=monitor.js 路径）已 PASS；node --check 三文件 OK
- 公开 `rt.lastData =` 仅 `_commitShopLastData` 一处（约 L1624）

## 工件（请阅读）
目录：douyin-promo-guard/_codex_review_balance_atomic/
- diff-monitor.js.patch / diff-nested-watch-drill.patch / diff-parent-watch-drill.patch（UTF-8）
- excerpt-helpers-refreshShopData-start.txt
- excerpt-poll-commit-path.txt
- excerpt-getStatus-balance-fields.txt
- excerpt-applyBalance-rt-suspicious.txt（恢复成功路径 `_applyBalanceToLastData(rt, result)` —— 注意 target 是 rt 不是 lastData/candidate）
- selftest-atomic.js + selftest-run.txt
- prep-log.txt

也请直接阅读工作区 `src/engine/monitor.js` 中：
- `_applyBalanceToLastData` / `_markShopDataRefreshing` / `_commitShopLastData` / `_commitShopLastDataSkippedBalance`
- `refreshShopData` 成功/失败提交路径
- `_pollShop`（或等价巡查）candidate→balance→commit 路径
- getStatus 对 balance*/refreshing 的投影
以及两个 watch-drill.js 透传。

## 审查标准（对照先验 MINIMAL_FIX / FAIL_CLOSED / TESTS）
1. 不得再公开发布「本轮 cost 已更新但余额终态未完成」的 lastData
2. 在途保留上一完整快照 + refreshing；首次无旧快照不得用假 0
3. 失败/缺失：balanceCents=null + status/reason；不复用旧余额作本轮；不编造 0；真 0 为 int 0
4. refreshShopData 同竞态须覆盖（若声称覆盖）
5. 早退（门禁/窗口/读取失败）须有完整余额终态（skipped/error/missing 等）再提交，不得留下半成品或残留 refreshing
6. 弹窗/qianchuan-reader 不在本补丁范围
7. 测试是否足以覆盖原子性与失败路径（selftest 是原型级；说明缺口是否阻塞）

## 已知旁注（请判定是否阻塞）
- `_applyReadRecoverySuccess` 仍有 `_applyBalanceToLastData(rt, result)`（写到 runtime 对象字段，非 lastData），并单独 bump `rt.lastDataAt`。若这不在本补丁引入/不破坏公开 lastData 原子性，可 NOTES；若破坏 fail-closed 或可再开半成品窗口，则 FAIL。
- commit 后 `rt.lastData.blockedReason = ...` 的原地改写：NOTES 或 FAIL 按严重度。
- 整文件相对 HEAD 的 diff 很大（工作区本就有大量未提交历史改动）。审查范围聚焦余额原子提交相关行为与三文件中与此相关的 hunk；不要因无关脏改自动 FAIL，但若无法从工作区确认该行为正确，可 FAIL 并说明。

## 运行态
- 3443 PID 15528，StartTime 2026-10-31 19:30:13 Asia/Shanghai；**本补丁未重启**。磁盘 vs 运行中代码预期不一致。不要要求本轮重启。

## 输出要求
在 stdout 给出结构化结论，并明确一行：
VERDICT: PASS
或 VERDICT: PASS_WITH_NOTES
或 VERDICT: FAIL

再给出：
- BLOCKERS:（FAIL 时必须；否则写 none）
- NOTES:
- READY_FOR_CONTROLLED_3443_RESTART_WITH_POPUP_TRACK: yes/no + 一句理由
- EVIDENCE_GAPS:
- CONFIDENCE: 高/中/低

只审不改。
