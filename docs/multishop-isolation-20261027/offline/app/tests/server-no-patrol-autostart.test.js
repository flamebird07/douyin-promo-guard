'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const watchSource = fs.readFileSync(path.join(__dirname, '..', 'watch-drill.js'), 'utf8');

// 只执行源码中的构造调用和 boot 函数，避免加载服务及其真实配置与外部依赖。
function serverWatchOptions() {
  const match = serverSource.match(/^const watchDrill = createWatchDrill\(\{[\s\S]*?^\}\);/m);
  assert.ok(match, '应找到 server.js 实际的 watchDrill 构造调用');
  let received;
  vm.runInNewContext(match[0], {
    createWatchDrill(options) { received = options; return {}; },
    path: { join: path.join },
    WORKSPACE: 'isolated-workspace',
  }, { timeout: 1000 });
  assert.ok(received, '构造调用必须实际传入选项');
  return received;
}

function bootHarness(opts) {
  const match = watchSource.match(/^  function boot\(\) \{[\s\S]*?^  \}/m);
  assert.ok(match, '应找到现有 watch-drill.boot 函数');
  const calls = { patrolStart: 0, enableStart: 0, syncTimer: 0 };
  const enableTask = Object.freeze({ running: false, stoppedByUser: true });
  let running = false;
  const monitor = {
    config: { monitor: { chengfang: { enableSchedulerEnabled: true } } },
    enableSchedulerShouldRun: () => !enableTask.stoppedByUser,
    startEnableScheduler() { calls.enableStart++; return { ok: true }; },
  };
  const boot = vm.runInNewContext(`(${match[0]})`, {
    opts,
    drill: { _monitor: monitor, _notify: { enabled: false }, state: {} },
    collectRuntimeFingerprint() {},
    ensureMonitor: () => monitor,
    ensurePlanScheduler() {},
    pushLog() {},
    syncEnableTask: () => enableTask,
    refreshGates() {},
    start() { calls.patrolStart++; running = true; },
    setInterval() { calls.syncTimer++; return { unref() {} }; },
    syncFromMonitor() {},
    snapshot: () => ({ running }),
  }, { timeout: 1000 });
  return { boot, calls, enableTask };
}

test('server.js 实际向 createWatchDrill 传入 autostartOnBoot: false', () => {
  assert.equal(serverWatchOptions().autostartOnBoot, false);
});

test('既有 boot 尊重服务端 false 选项，重复 boot 不恢复巡查或已停用的每日任务', () => {
  const h = bootHarness(serverWatchOptions());
  assert.equal(h.boot().running, false);
  assert.equal(h.boot().running, false);
  assert.equal(h.calls.patrolStart, 0);
  assert.equal(h.calls.enableStart, 0);
  assert.equal(h.calls.syncTimer, 1);
  assert.deepEqual(h.enableTask, { running: false, stoppedByUser: true });
});

test('隔离对照：未传选项或显式 true 时，既有 boot 仍进入巡查启动分支', () => {
  for (const opts of [{}, { autostartOnBoot: true }]) {
    const h = bootHarness(opts);
    assert.equal(h.boot().running, true);
    assert.equal(h.calls.patrolStart, 1);
    assert.equal(h.calls.enableStart, 0);
  }
});
