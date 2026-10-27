# Patrol-triggered daily plan refill

The independent runner checks today's successful plans after each completed guard patrol, at any time of day. There is no 08:00 start gate. Each shop's current `plansPerShopPerDay` and `targetRoi` are read again before dispatching each remaining plan. Lowering a target stops further dispatch; increasing it fills only the remainder. Successful plans and uncertain submissions are never replayed.

The guard launches the existing hidden VBS wrapper asynchronously. Publishing retains its separate process and durable ledger lock. A failed or locked publisher does not delay guard decisions. The existing Windows publisher task becomes on demand; deployment must remove its old clock trigger while preserving its action, principal and settings. Registering a new task does not run it automatically.

The application-side bridge and quantity synchronization live in the paired ecommerce-assistant repository. Its scheduler is mirrored in `integrations/bill-manager/promo-plan-scheduler.js` for standalone tests. This change does not enable the legacy embedded scheduler.

Verification: `node --test test/patrol-plan-refill.test.js plan-publisher/daily-plan-runner.test.cjs plan-publisher/patrol-refill.test.cjs` (30 tests). Application bridge verification adds 12 tests; set `PUBLISHER_TASK_SOURCE` to this repository's `plan-publisher/daily-plan-task.ps1` when using separate checkouts. Production migration and actual publication still require runtime readback; passing these tests alone does not prove deployment or completed plans.
