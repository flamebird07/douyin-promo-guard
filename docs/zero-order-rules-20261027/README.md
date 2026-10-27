# Zero orders use the normal cost rule

The previous zero-order implementation treated valid zero orders as bad data, reread them and stopped normal evaluation. A later UI-only workaround hid that explanation; the member explicitly rejected that approach. This change removes the special backend block and the frontend hiding workaround.

The existing integer rule applies to every nonnegative integer order count: `costCents > orders * thresholdCents`. The existing 50-yuan protection is unchanged. At zero orders, zero cost is equality and causes no action; positive cost through 5000 cents is normal protected data; above 5000 cents, an above-threshold on/mixed state is eligible for pause, while off stays off. Unknown state, missing/invalid metrics, wrong identity/date, stale or failed reads remain real faults. Valid zero orders no longer trigger a special reread. Ordinary action-time revalidation remains.

The coordinator now returns `ok:true` with the normal evaluation for valid zero data. The monitor follows its ordinary state observation and switch decision paths. The UI renders genuine errors normally; injecting the old erroneous blocked reason remains visible, proving that there is no display suppression.

Validation against the exact current production source: all 12 new cross-layer cases passed; the related run has 177 cases, 173 passing and the same four failures reproduced on the unchanged baseline. No new failures were introduced. The four baseline failures are retained in the private acceptance record rather than represented as passing. The 12-case suite also passes against this repository's selectively merged source:

    node --test test/zero-orders-normal.test.js

The offline HTML fixture contains only the accepted row-rendering component. The test helper includes the existing production fixture's isolated Cookie work directory, preventing tests from falling back to operational paths. All tests use synthetic input and mocked actions.

Production uses a newer local source baseline than this repository. The same logical deletions were merged into the tracked source without replacing unrelated local improvements. The exact production patch and before/after hashes are retained with this document. Loading covers four backend modules and the HTML, retaining the manifest's 44 entries. Runtime/data acceptance is recorded separately after the load.

No configuration, shop enable switch, publishing quantity/ROI, authenticated source, readonly Cookie, or product feature is added or changed. The two immutable roles are preserved. The earlier UI-only workaround is superseded by this backend correction.

External execution: one real ZCode request for GLM-5.3 produced partial source changes and then hit provider quota; it exited and released capacity. One real Claude Code request for deepseek-flash continued the frozen work and completed the tests/report. The controller independently ran tests, reviewed the merge and handled production loading. Raw failure/report evidence is preserved; backend model identity is not asserted.
