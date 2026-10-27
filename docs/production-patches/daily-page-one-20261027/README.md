# Daily page-one rule (2026-10-27)

User requirement: each business day starts at page 1 to find unpublished products. Historical published-product deduplication remains intact; same-day continuation retains progress.

The repository workflow already returns newDayState on a new day. Production had drifted to inheritBrowseCursor; the accompanying production-baseline patch removes that inheritance. Do not replace the older repository run-plans module with an incomplete production snapshot.

repair-day-start.cjs is an explicitly invoked, one-time production repair helper for a proven preparation-stopped shop/day. It requires the current production native reproveDurablePreparationStoppedClose/acquireLock APIs and the bill-manager scheduler lock API, passed as absolute paths. It only changes page/category/cursor, retains financial facts, backs up exact original state, and verifies companion files unchanged. It is not a recurring repair job.

Regression test layout: copy the helper and test beside the accepted production plan-workflow.cjs in an isolated plan-publisher directory; place the accepted scheduler at ../bill-manager/promo-plan-scheduler.js. Run node --test plan-publisher/day-start-reset.test.cjs. Twelve tests passed. Two worker-written Buffer identity assertions were corrected to byte comparisons during independent review. Five targeted workflow tests passed. Four unrelated existing workflow failures reproduce on the unmodified production baseline; they were not changed.

Production acceptance: source replacement and one-time Jin browse reset applied under native publisher and ledger locks. Existing successful plans, ledger, attempts and published book preserved. Protected immutable credential versions: 243/243 unchanged and read-only. Remaining publication is verified from native receipts separately; this patch archive does not assert all shops have completed.
