# D49 recovery routing continuation (2026-10-30)

After a proven first publication has been reconciled, its historical success marker must not compete with a later in-progress entry or intercept the existing preparation/readback recovery routes. The crash-recovery candidate selection now prioritizes actual in-progress entries. Marker-only idempotence requires a fully converged record and the corresponding latest entry; incomplete status, errors and inconsistent counts cannot be reported as already recovered.

A current preparation with no durable success, including preparation-stopped, returns to the original strict local preparation proof after validating the entry key and integer plan number. This is a route correction, not a new no-replay exception or permission to reuse a prior plan's frozen data.

The original 323 crash-regression test bytes remain intact; 45 scenarios were appended. Independent result: 368/368 crash tests and 12/12 stale-preparation tests passed. Replacing only the runner with the preceding D47 bytes makes the same regression report 325 pass / 43 fail. The original F1/R16 bodies and proof gates were not changed. Existing R16 native multi-plan limitations remain, including first-plan mismatch, cross-CID consumption and nonunique daily publication; equivalent marked/unmarked inputs keep the same refusals.

Production changed only daily-plan-runner.cjs from 42bab2fc to 039552fa. The actual historical first-plan entry was re-proved through a fresh process and returned already-converged; ledger and publisher data bytes/mtime were unchanged, no publication/browser capability was called, no new plan was published, and the guard was not restarted. Explicit automatic-shop switches remain off pending the user's separate operating choice.

Reproduce from offline with `node --test publisher/crash-success-recovery.test.cjs`. Apply D47 before the incremental recovery-continuation-D49.patch. No credentials, runtime ledgers or live snapshots are included.
