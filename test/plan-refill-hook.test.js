'use strict';

/**
 * 巡查后计划补发联动钩子隔离测试（2026-11-20 收编自 bill-manager）。
 * 覆盖（spawnFn 全部注入假实现，绝不真跑发布）：
 * - fail-closed：daily-plan-config.json 缺失 / enabled!==true / JSON 非法 → 不触发；
 * - enabled=true → spawn node daily-plan-runner.cjs --run（PROMO_PROJECT_ROOT 注入、detached）；
 * - 在途互斥：子进程未退出时再次触发跳过；退出后再触发放行；
 * - spawn 抛错不外抛（绝不影响值守）。
 * 运行：node --test test/plan-refill-hook.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createPlanRefillHook } = require('../src/engine/plan-refill-hook');

const ROOT = '/fake/project-root';

function makeSpawnRecorder() {
  const calls = [];
  const rec = {
    calls,
    autoExit: false, // true = 每次 spawn 的假子进程在 setImmediate 里触发 exit
    spawnFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const handlers = {};
      setImmediate(() => {
        if (rec.autoExit && handlers.exit) handlers.exit();
      });
      return { on: (evt, fn) => { handlers[evt] = fn; } };
    },
  };
  return rec;
}

test('fail-closed：配置缺失 / enabled=false / JSON 非法 → 不 spawn', () => {
  const files = new Map(); // path -> content
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
  });

  hook(); // 配置文件不存在
  assert.strictEqual(rec.calls.length, 0);

  files.set(path.join(ROOT, 'plan-publisher', 'daily-plan-config.json'), JSON.stringify({ enabled: false }));
  hook();
  assert.strictEqual(rec.calls.length, 0, 'enabled=false 不得触发');

  files.set(path.join(ROOT, 'plan-publisher', 'daily-plan-config.json'), '{not-json');
  hook();
  assert.strictEqual(rec.calls.length, 0, '非法 JSON 静默不触发不抛错');
});

test('enabled=true → spawn node runner --run（PROMO_PROJECT_ROOT / detached）', () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const files = new Map([[cfgPath, JSON.stringify({ enabled: true })]]);
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    nodeBin: '/fake/node',
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
  });

  hook();
  assert.strictEqual(rec.calls.length, 1);
  const { cmd, args, opts } = rec.calls[0];
  assert.strictEqual(cmd, '/fake/node');
  assert.strictEqual(args[0], path.join(ROOT, 'plan-publisher', 'daily-plan-runner.cjs'));
  assert.strictEqual(args[1], '--run');
  assert.strictEqual(opts.detached, true, '独立进程（不随值守退出）');
  assert.strictEqual(opts.env.PROMO_PROJECT_ROOT, ROOT, '控制器根注入');
});

test('在途互斥：子进程未退出 → 再触发跳过；退出后放行', async () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const files = new Map([[cfgPath, JSON.stringify({ enabled: true })]]);
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
  });

  hook();
  hook(); // 子进程仍活着
  assert.strictEqual(rec.calls.length, 1, '在途时不得重复 spawn');

  rec.autoExit = true; // 下一次 spawn 的假子进程立即退出
  await new Promise((r) => setTimeout(r, 10));
  hook();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(rec.calls.length, 2, '子进程退出后可再次触发');
});

test('spawn 抛错不外抛（值守不受影响）', () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const files = new Map([[cfgPath, JSON.stringify({ enabled: true })]]);
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: () => { throw new Error('spawn 爆炸（假错误）'); },
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
  });
  assert.doesNotThrow(() => hook());
});
