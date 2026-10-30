# D47 crash-success ledger recovery (2026-10-30)

An interrupted scheduler entry can now converge locally from trusted durable publication facts without replaying publication. A strict first-plan path accepts the native first-success summary, matching initial/final success under one confirmation ID and manifest hash, an independent unique plan ID/date, and the exact subsequent preparation-stopped closure with all six zero-consumption checks. Account identity and historical seed data remain account-scoped; an absent lazy reopen table is accepted, while malformed or nonempty reopen data is rejected.

The native-summary path does not reconstruct or rehash the unavailable complete manifest and does not authorize new publication. Cumulative published product IDs prove membership only, not an independent per-plan product mapping. Conflicts, additional unresolved entries, source drift and active locks refuse recovery. Source bytes are checked before and under the scheduler lock; repeated recovery is a no-op including ledger mtime.

Independent validation: 323/323 crash-recovery tests and 12/12 stale-preparation tests passed. Existing daily runner (2) and multi-shop (3) failures matched the baseline. The complete pre-change production-adjacent baseline is 15 files, 672 tests, 653 pass and 19 failures across six files; these are separate test-debt work, not evidence that the full suite is green.

Real-file rehearsal wrote only a copied ledger, then the accepted exported entry reconciled the historical first publication in production. No new plans were published; the publisher state, attempts, published store, configuration and all other shop/day records were preserved. A second recovery call left ledger bytes and mtime unchanged. The guard was not restarted and 243 protected read-only files were preserved. Automatic shop publishing remained explicitly disabled at this checkpoint.

Run the standalone synthetic regression from `offline`:

```text
node --test publisher/crash-success-recovery.test.cjs
```

Only `daily-plan-runner.cjs` changed in production. Other added source files are unchanged dependencies needed to run the portable regression. The patch applies to the preceding production runner; hashes are recorded in `source-hashes.json`. No credentials, runtime ledgers, cookies or raw live snapshots are included.
