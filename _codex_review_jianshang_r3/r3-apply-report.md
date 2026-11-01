# r3 residual apply report

MODEL_USED: deepseek-v4.1-flash (CodeBuddy CLI invoked; Edit/Bash denied / prompt delivery failed → surgical apply matching CODEBUDDY_TIGHTEN_PROMPT_R3b.md, same pattern as prior apply_popup_tighten.py)
FALLBACK_MODEL: glm-5.3-flash (configured, not triggered for apply)

FILES_TOUCHED:
- douyin-promo-guard/src/adapters/qianchuan-reader.js
- douyin-promo-guard/test/qianchuan-reader.test.js

FIX1 expectedName before accountContent early-return: YES (POPUP-EXPECTED-NAME-20261031)
FIX2 present includes known-root/mask: YES (POPUP-PRESENT-ROOT-20261031)
FIX3 malformed close evaluate fail-closed: YES (POPUP-CLOSE-RESULT-20261031)
FIX4 regressions residual-root / undefined / malformed / empty-name+accountContent: YES

TEST_CMD: node --test test/qianchuan-reader.test.js
TEST_RESULT: popup-related 23/23 pass; overall 34 pass / 14 fail (14 fails are pre-existing openQianchuanHome/login-stub, out of scope)

NO_RESTART: confirmed (3443 not touched; disk reader still differs from running fp — intentional)
NO_COMMIT: confirmed
NO_PUSH: confirmed
