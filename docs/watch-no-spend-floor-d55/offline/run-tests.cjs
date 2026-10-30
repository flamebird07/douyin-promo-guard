const path = require('path');
const { spawnSync } = require('child_process');
const guard = path.join(__dirname, 'guard');
const targeted = ['test/no-spend-floor-d55.test.js', 'test/enable-stop-pause-d53.test.js', 'test/cookie-checkpoint-wiring-d52.test.js', '../bill-manager/tests/spend-floor-100-ui.test.js'];
const legacy = ['test/spend-floor-100.test.js', 'test/rules-guard.test.js', 'test/ad-switch-decision.test.js', '../bill-manager/tests/spend-floor-100.test.js'];
const files = process.argv[2] === 'legacy' ? legacy : targeted;
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: guard, env: { ...process.env, PROMO_GUARD_DIR: guard }, stdio: 'inherit' });
if (r.error) { process.stderr.write(String(r.error)); process.exitCode = 1; } else process.exitCode = typeof r.status === 'number' ? r.status : 1;
