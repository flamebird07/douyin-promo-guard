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

test('enabled=true → spawn node runner --run --scheduler-path（镜像）+ PROMO_PROJECT_ROOT / detached', () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const guardPath = path.join(ROOT, 'config', 'config.json');
  const files = new Map([
    [cfgPath, JSON.stringify({ enabled: true })],
    [guardPath, JSON.stringify({ shops: [] })],
    [path.join(ROOT, 'integrations', 'bill-manager', 'promo-plan-scheduler.js'), 'export {}'],
  ]);
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    nodeBin: '/fake/node',
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
    writeJsonFn: (p, obj) => { files.set(p, JSON.stringify(obj)); },
  });

  hook();
  assert.strictEqual(rec.calls.length, 1);
  const { cmd, args, opts } = rec.calls[0];
  assert.strictEqual(cmd, '/fake/node');
  assert.strictEqual(args[0], path.join(ROOT, 'plan-publisher', 'daily-plan-runner.cjs'));
  assert.strictEqual(args[1], '--run');
  assert.strictEqual(args[2], '--scheduler-path');
  assert.strictEqual(args[3], path.join(ROOT, 'integrations', 'bill-manager', 'promo-plan-scheduler.js'), '调度器镜像路径显式注入（Mac 无 bill-manager 兄弟仓）');
  assert.strictEqual(opts.detached, true, '独立进程（不随值守退出）');
  assert.strictEqual(opts.env.PROMO_PROJECT_ROOT, ROOT, '控制器根注入');
});

test('数量同步桥：值守 config 的每店条数/ROI/cookieFile 原子写入 daily-config.shops；软删店不写入', () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const guardPath = path.join(ROOT, 'config', 'config.json');
  const files = new Map([
    [cfgPath, JSON.stringify({ enabled: true, autoConfirm: true, plansPerShopPerDay: 3, shops: [] })],
    [guardPath, JSON.stringify({
      shops: [
        { id: '店A', name: '店A', cookieFile: '店A', enabled: true, plansPerShopPerDay: 1, targetRoi: 15 },
        { id: '店B', name: '店B', cookieFile: '店B', enabled: true, plansPerShopPerDay: 2, targetRoi: 12.5, accountId: '1710242295996424' },
        { id: '店C', name: '店C', cookieFile: '店C', deleted: true, plansPerShopPerDay: 9 },
      ],
    })],
    [path.join(ROOT, 'integrations', 'bill-manager', 'promo-plan-scheduler.js'), 'export {}'],
  ]);
  const writes = [];
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
    writeJsonFn: (p, obj) => { writes.push({ p, obj }); },
  });

  hook();
  assert.strictEqual(writes.length, 1, '同步桥原子写一次');
  const daily = writes[0].obj;
  assert.strictEqual(daily.enabled, true, 'policy 字段保留');
  assert.strictEqual(daily.shops.length, 2, '软删店不进派发清单');
  const a = daily.shops.find((s) => s.id === '店A');
  const b = daily.shops.find((s) => s.id === '店B');
  assert.deepStrictEqual(a, { id: '店A', name: '店A', cookieFile: '店A', platform: 'douyin', plansPerShopPerDay: 1, targetRoi: 15 });
  assert.strictEqual(b.accountId, '1710242295996424', 'accountId 同步');
  assert.strictEqual(rec.calls.length, 1, '同步成功后才 spawn');
});

test('值守 config 不可读 → 本次不派发（fail-closed）', () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const files = new Map([[cfgPath, JSON.stringify({ enabled: true })]]); // guard config 缺失
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
  });
  hook();
  assert.strictEqual(rec.calls.length, 0, '数量源不可读不得盲派');
});

test('在途互斥：子进程未退出 → 再触发跳过；退出后放行', async () => {
  const cfgPath = path.join(ROOT, 'plan-publisher', 'daily-plan-config.json');
  const guardPath = path.join(ROOT, 'config', 'config.json');
  const files = new Map([
    [cfgPath, JSON.stringify({ enabled: true })],
    [guardPath, JSON.stringify({ shops: [] })],
    [path.join(ROOT, 'integrations', 'bill-manager', 'promo-plan-scheduler.js'), 'export {}'],
  ]);
  const rec = makeSpawnRecorder();
  const hook = createPlanRefillHook({
    projectRoot: ROOT,
    spawnFn: rec.spawnFn,
    existsFn: (p) => files.has(p),
    readJsonFn: (p) => JSON.parse(files.get(p)),
    writeJsonFn: (p, obj) => { files.set(p, JSON.stringify(obj)); },
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
