# Session recovery investigation — 2026-10-27

Business status: authentication remains blocked. The store's current-day publication count is still 0/4. This document does not claim that login, data reading, or publication has recovered.

Two operational defects were corrected without changing product features:

- Three private verification/restoration scripts still passed the removed shared `browser` option to `createDefaultCandidateVerifier`. They now pass `candidateBrowserFactory`. Each existing attempt already launches its own new browser, constructs a new verifier, and invokes it once; process isolation and the existing waits remain intact. The patch records only those three property changes.
- A failed current-day publication record could not obtain the existing release proof while the state file still described a proven stopped preparation from the previous day. A shadow check established that the existing native `loadDayState` / `persistDayState` rollover resolves this. The controller then performed that normal rollover under the native publisher and ledger locks, with exact backup and source checks. The original ledger, attempts and published-product store remained byte-identical. The prior successful plan remains in the old-day ledger, published store and private exact backup. The current failed ledger entry has not been released.

Validation:

- Five isolated probe checks passed; the navigation diagnostic passed six groups plus native home/login URL checks.
- All three corrected legacy scripts passed Node syntax checks. The private scripts were not rerun against stale old results.
- Native shadow rollover and actual readback passed. The current-day zero-publication release proof now succeeds; no plan was dispatched by this operation.
- All 81 previously inventoried same-store Cookie sets were retested in fresh owned browser processes in this run, with approximately 180 seconds for redirection. None authenticated. Additional post-recovery checkpoints, both immutable sources, a historical immutable source, headed-browser comparison and the advertising entry also failed authentication.
- All completed source checks remained unchanged and owned probe browsers disconnected. The 243 protected versions retained their hashes and read-only attributes. No QR, phone number, password, verification code or OAuth permission was submitted.

Production application source, configuration, scheduled tasks and other shops' successful plans were not changed in this operation. No service restart was needed for the native data repair or for operational scripts that read their source on a new invocation.

The guard and independent publisher use different ordinary working copies. After obtaining a platform-accepted session, both must be independently validated and restored through the existing native work-copy writer. Only then should the existing current-day recovery and publication flow fill the remaining quantity with the latest configured ROI. Neither immutable source may be rewritten.

Five real ZCode submissions requested GLM-5.3; backend model identity was not independently attested. One additional preflight attempt submitted nothing. A generated rollover helper failed independent review and was not used; the controller instead invoked the existing native operations after shadow verification. Stage assessments were recorded locally as identity-pending, without inventing confirmed scores. Raw receipts and private data backups remain outside this repository.

Remaining requirement: a platform-accepted authenticated session. A no-QR SMS/password verification choice has been requested from the member. Business acceptance remains incomplete.
