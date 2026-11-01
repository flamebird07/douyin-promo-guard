'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const INDEX_HTML = path.join(__dirname, '../../bill-manager/index.html');
const LOG_POLL_CORE = path.join(__dirname, '../../bill-manager/log-poll-core.js');
const ROWS = ['a', 'b'].map(id => ({
  id: 'test-' + id, name: '测试店' + id, platform: 'douyin', adControl: true,
  adState: { state: 'off', on: false, note: '关闭' }, thresholdCents: 1000,
}));
const state = shopRows => ({
  shopRows, running: false, status: 'idle', realMode: false, realModeKnown: true,
  gates: { realMode: false, dryRun: true, pauseWillExecute: false, enableWillExecute: false },
  enableTask: { configEnabled: false }, notify: { enabled: false },
});
let browser, server, origin;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX_HTML));
    } else if (req.method === 'GET' && req.url === '/log-poll-core.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(LOG_POLL_CORE));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function holdNext(model, kind, holdConcurrent = false) {
  const held = { started: deferred(), release: deferred(), holdConcurrent };
  assert.equal(model[kind + 'Hold'], undefined);
  model[kind + 'Hold'] = held;
  model.holds.push(held);
  return held;
}

async function waitForRelease(model, kind, request) {
  const key = kind + 'Hold';
  const held = model[key];
  if (!held) return;
  if (!held.holdConcurrent) delete model[key];
  held.started.resolve(request);
  await held.release.promise;
  if (model[key] === held) delete model[key];
}

async function openPage(t, rows = ROWS) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const model = {
    rows: structuredClone(rows), posts: [], errors: [], dialogs: [], holds: [], logsSince: [],
    stateFailure: '', deleteFailure: '', logsFailure: '', cancel: false, omitDeleteState: false,
    stateResponse: undefined, deleteResponse: undefined, logsResponse: undefined,
  };
  page.on('pageerror', e => model.errors.push(e.message));
  page.on('dialog', async dialog => {
    model.dialogs.push({ type: dialog.type(), accepted: !model.cancel });
    await (model.cancel ? dialog.dismiss() : dialog.accept());
  });
  t.after(async () => {
    model.holds.forEach(held => held.release.resolve());
    await context.close();
    assert.deepEqual(model.errors, []);
  });
  await context.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (req.method() === 'GET' && req.isNavigationRequest() && req.url() === origin + '/') return route.continue();
    if (req.method() === 'GET' && req.resourceType() === 'script' && req.url() === origin + '/log-poll-core.js') return route.continue();
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const legacyGets = {
      '/get-dir-config': { dir: '' },
      '/get-shops': { shops: [] },
      '/get-shop-logs': { logs: [] },
      '/get-shop-logs?lines=200': { logs: [] },
      '/get-process-status': { running: false, billRunning: false, shopRunning: false, douyinRunning: false, autoRunning: false },
      '/check-shutdown': { shutdownScheduled: false },
    };
    const target = url.pathname + url.search;
    if (req.method() === 'GET' && Object.hasOwn(legacyGets, target)) return json(legacyGets[target]);
    if (!url.pathname.startsWith('/api/')) return route.abort();
    if (req.method() !== 'GET') model.posts.push({ path: url.pathname, body: req.postDataJSON() });
    // Only the existing delete fixture may handle a write; nothing else reaches the server.
    if (target === '/api/watch-drill/shop/delete' && req.method() === 'POST') {
      const failure = model.deleteFailure;
      const omitState = model.omitDeleteState;
      const response = structuredClone(model.deleteResponse);
      await waitForRelease(model, 'delete', req);
      if (failure === 'network') return route.abort('failed');
      if (failure === 'json') return route.fulfill({ contentType: 'application/json', body: '{invalid' });
      if (failure === 'rejected') return json({ ok: false, error: '测试拒绝' });
      if (response !== undefined) return json(response);
      model.rows = model.rows.filter(r => r.id !== req.postDataJSON().shopId);
      return json(omitState ? { ok: true } : { ok: true, state: state(model.rows) });
    }
    if (req.method() !== 'GET') return route.abort();
    if (target === '/api/watch-drill/state') {
      const failure = model.stateFailure;
      // Snapshot at request start so releasing an older GET cannot borrow newer fixture state.
      const response = structuredClone(model.stateResponse === undefined
        ? { ok: true, state: state(model.rows) } : model.stateResponse);
      await waitForRelease(model, 'state', req);
      if (failure === 'network') return route.abort('failed');
      if (failure === 'json') return route.fulfill({ contentType: 'application/json', body: '{invalid' });
      return json(response);
    }
    if (url.pathname === '/api/watch-drill/logs') {
      const failure = model.logsFailure;
      const response = structuredClone(model.logsResponse === undefined
        ? { ok: true, logs: [], seq: 0 } : model.logsResponse);
      model.logsSince.push(url.searchParams.get('since'));
      await waitForRelease(model, 'logs', req);
      if (failure === 'network') return route.abort('failed');
      if (failure === 'json') return route.fulfill({ contentType: 'application/json', body: '{invalid' });
      return json(response);
    }
    return route.abort();
  });
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('button.tab-btn[onclick*="watchdrill"]').click();
  await page.waitForFunction(count => document.querySelectorAll('[data-wd-shop]').length === count, rows.length);
  return { page, model };
}

async function settleUi(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function refresh(page, renderFails = false) {
  const response = page.waitForResponse(r => r.url().includes(renderFails ? '/api/watch-drill/state' : '/api/watch-drill/logs'));
  await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
  await (await response).finished();
  await settleUi(page);
}

function deleteButton(page, id = 'test-a') {
  return page.locator('[data-wd-act="delete"][data-wd-id="' + id + '"]');
}

function expectPosts(model, ids) {
  assert.deepEqual(model.posts, ids.map(shopId => ({ path: '/api/watch-drill/shop/delete', body: { shopId } })));
}

function expectConfirms(model, accepted) {
  assert.deepEqual(model.dialogs, accepted.map(value => ({ type: 'confirm', accepted: value })));
}

async function expectNotice(page, shopName, pattern) {
  await page.waitForFunction(({ shopName, pattern }) => {
    const lines = document.getElementById('tab-watchdrill').innerText.split('\n');
    return lines.some(line => line.includes(shopName) && new RegExp(pattern).test(line));
  }, { shopName, pattern });
}

async function deleteAsUnknown(page, model, id, failure) {
  model.deleteFailure = failure;
  const completed = failure === 'network'
    ? page.waitForEvent('requestfailed', req => new URL(req.url()).pathname === '/api/watch-drill/shop/delete')
    : page.waitForResponse(res => new URL(res.url()).pathname === '/api/watch-drill/shop/delete').then(res => res.finished());
  await deleteButton(page, id).click();
  await completed;
  await settleUi(page);
  await expectNotice(page, model.rows.find(row => row.id === id).name, '删除结果待核实');
  assert.equal(await deleteButton(page, id).isDisabled(), true);
  assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效/);
}

async function expectEmpty(page) {
  await page.waitForFunction(() => document.getElementById('wdShopEmpty').getBoundingClientRect().height > 0);
  assert.equal(await page.locator('[data-wd-shop]').count(), 0);
  assert.equal(await page.locator('#wdShopEmpty').count(), 1);
  assert.equal(await page.locator('#wdShopEmpty').innerText(), '暂无活动店铺');
  assert.equal(await page.locator('#wdShopList').evaluate(el => el.children.length), 0);
}

test('删除 2→1→0：稳定空态、成功回执、另一店编辑节点保留', async t => {
  const { page, model } = await openPage(t);
  await page.locator('[data-wd-act="edit"][data-wd-id="test-b"]').click();
  const input = page.locator('#wd-edit-test-b .wd-ethr');
  await input.fill('9.99');
  await input.evaluate(el => el.dataset.identityMark = 'retained');
  await page.locator('[data-wd-act="delete"][data-wd-id="test-a"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-wd-shop]').length === 1);
  assert.equal(await input.inputValue(), '9.99');
  assert.equal(await input.getAttribute('data-identity-mark'), 'retained');
  assert.match(await page.locator('#wdShopDeleteResult').innerText(), /测试店a.*软删除已生效/);
  assert.equal(await page.locator('#wdShopEmpty').isVisible(), false);
  await page.locator('[data-wd-act="delete"][data-wd-id="test-b"]').click();
  await expectEmpty(page);
  assert.match(await page.locator('#wdShopDeleteResult').innerText(), /测试店b.*软删除已生效/);
  assert.equal(await page.locator('#wdError').innerText(), '');
  assert.deepEqual(model.posts, ROWS.map(row => ({ path: '/api/watch-drill/shop/delete', body: { shopId: row.id } })));
});

test('初始零行与整页重载保持唯一空态且零 POST', async t => {
  const { page, model } = await openPage(t, []);
  await expectEmpty(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('button.tab-btn[onclick*="watchdrill"]').click();
  await expectEmpty(page);
  assert.equal(await page.locator('#wdError').innerText(), '');
  assert.deepEqual(model.posts, []);
});

test('删除后重复只读刷新不会重提 POST 或丢失成功回执', async t => {
  const { page, model } = await openPage(t, [ROWS[0]]);
  await page.locator('[data-wd-act="delete"]').click();
  await expectEmpty(page);
  for (let i = 0; i < 3; i++) {
    await refresh(page);
    await expectEmpty(page);
    assert.match(await page.locator('#wdShopDeleteResult').innerText(), /软删除已生效/);
  }
  assert.equal(model.posts.length, 1);
  assert.equal(await page.locator('#wdError').innerText(), '');
});

test('原生鼠标双击可见删除按钮：POST 在途及完成后均仅确认和提交一次', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  const held = holdNext(model, 'delete');
  const button = deleteButton(page);
  await button.scrollIntoViewIfNeeded();
  assert.equal(await button.isVisible(), true);
  const box = await button.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 50 });
  await held.started.promise;
  await settleUi(page);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  held.release.resolve();
  await expectNotice(page, '测试店a', '软删除已生效');
  await page.waitForFunction(() => document.querySelectorAll('[data-wd-shop]').length === 1);
  assert.equal(await button.count(), 0);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
});

test('在途删除阻止真实点击后的合成重入，成功无快照后旧按钮仍禁用', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  model.stateResponse = { ok: true, state: state(ROWS) };
  model.omitDeleteState = true;
  const held = holdNext(model, 'delete');
  const button = deleteButton(page);
  await Promise.all([
    button.click(),
    held.started.promise.then(async () => {
      expectPosts(model, ['test-a']);
      assert.equal(await button.isDisabled(), true);
      await button.dispatchEvent('click');
    }),
  ]);
  await settleUi(page);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  held.release.resolve();
  await expectNotice(page, '测试店a', '软删除已生效');
  assert.equal(await button.isDisabled(), true);
  await button.dispatchEvent('click');
  await refresh(page);
  assert.equal(await button.isDisabled(), true);
  await button.dispatchEvent('click');
  await settleUi(page);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
});

test('在途只读刷新替换按钮后，明确拒绝会重新启用当前按钮', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  model.deleteFailure = 'rejected';
  const held = holdNext(model, 'delete');
  const button = deleteButton(page);
  await button.click();
  await held.started.promise;
  await button.evaluate(el => el.dataset.fixtureIdentity = 'before-refresh');
  await refresh(page);
  assert.equal(await button.getAttribute('data-fixture-identity'), null);
  assert.equal(await button.isDisabled(), true);
  await button.dispatchEvent('click');
  await settleUi(page);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
  held.release.resolve();
  await page.waitForFunction(() => document.getElementById('wdError').innerText.includes('删除未获确认'));
  assert.equal(await button.isEnabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  assert.equal(await page.locator('[data-wd-shop]').count(), 2);
  expectPosts(model, ['test-a']);
});

test('POST 已成功但渲染抛错：保留成功、禁止旧按钮重提、刷新只 GET', async t => {
  const { page, model } = await openPage(t);
  await page.evaluate(() => {
    const original = document.getElementById.bind(document);
    window.restoreRender = () => { document.getElementById = original; };
    document.getElementById = id => {
      if (id === 'wdShopList') throw new Error('模拟列表渲染失败');
      return original(id);
    };
  });
  const deletedButton = page.locator('[data-wd-act="delete"][data-wd-id="test-a"]');
  await deletedButton.click();
  await page.waitForFunction(() => document.getElementById('wdError').innerText.includes('页面渲染失败'));
  assert.match(await page.locator('#wdShopDeleteResult').innerText(), /软删除已生效/);
  assert.equal(await deletedButton.isDisabled(), true);
  await deletedButton.dispatchEvent('click');
  await refresh(page, true);
  await page.waitForFunction(() => document.getElementById('wdError').innerText.includes('状态已收到'));
  const error = await page.locator('#wdError').innerText();
  assert.match(error, /页面渲染失败/);
  assert.doesNotMatch(error, /接口异常|服务未就绪|未重启|删除失败/);
  assert.equal(model.posts.length, 1);
  await page.evaluate(() => window.restoreRender());
  await refresh(page);
  await page.waitForFunction(() => document.getElementById('wdError').innerText === '');
  assert.equal(await deletedButton.count(), 0);
  assert.match(await page.locator('#wdShopDeleteResult').innerText(), /软删除已生效/);
  assert.equal(model.posts.length, 1);
});

for (const failure of ['network', 'json']) {
  test('状态 ' + failure + ' 失败不误报渲染错误，刷新不抹掉错误', async t => {
    const { page, model } = await openPage(t);
    model.stateFailure = failure;
    await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
    await page.waitForFunction(() => document.getElementById('wdError').innerText.includes('状态接口请求或 JSON 解析失败'));
    assert.doesNotMatch(await page.locator('#wdError').innerText(), /页面渲染失败|服务未就绪|未重启/);
    assert.deepEqual(model.posts, []);
    model.stateFailure = '';
    await refresh(page);
    await page.waitForFunction(() => document.getElementById('wdError').innerText === '');
  });

  test('删除 ' + failure + ' 未知后新完整 GET 缺少该 id：确认软删除且不重提', async t => {
    const { page, model } = await openPage(t);
    model.stateResponse = { ok: true, state: state(undefined) };
    await deleteAsUnknown(page, model, 'test-a', failure);
    await deleteButton(page).dispatchEvent('click');
    await settleUi(page);
    expectPosts(model, ['test-a']);
    expectConfirms(model, [true]);
    model.rows = [structuredClone(ROWS[1])];
    model.stateResponse = undefined;
    await refresh(page);
    await expectNotice(page, '测试店a', '软删除已生效');
    assert.equal(await deleteButton(page).count(), 0);
    assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
    assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|可核对后重试/);
    for (let i = 0; i < 2; i++) {
      await refresh(page);
      await expectNotice(page, '测试店a', '软删除已生效');
      assert.equal(await page.locator('[data-wd-shop]').count(), 1);
    }
    expectPosts(model, ['test-a']);
    expectConfirms(model, [true]);
  });

  test('删除 ' + failure + ' 未知后新完整 GET 仍有该 id：持续提示可重试且须重新确认', { timeout: 30000 }, async t => {
    const { page, model } = await openPage(t);
    model.stateResponse = { ok: true, state: state(undefined) };
    await deleteAsUnknown(page, model, 'test-a', failure);
    model.stateResponse = undefined;
    const button = deleteButton(page);
    for (let i = 0; i < 3; i++) {
      await refresh(page);
      await expectNotice(page, '测试店a', '未删除.*可核对后重试');
      assert.equal(await button.isEnabled(), true);
      assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
      assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|软删除已生效/);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
    }
    model.cancel = true;
    await button.click();
    await settleUi(page);
    expectPosts(model, ['test-a']);
    expectConfirms(model, [true, false]);
    assert.equal(await button.isEnabled(), true);
    await expectNotice(page, '测试店a', '未删除.*可核对后重试');
    model.cancel = false;
    model.deleteFailure = '';
    const held = holdNext(model, 'delete');
    await button.click();
    await held.started.promise;
    expectPosts(model, ['test-a', 'test-a']);
    expectConfirms(model, [true, false, true]);
    assert.equal(await button.isDisabled(), true);
    await button.dispatchEvent('click');
    await settleUi(page);
    expectPosts(model, ['test-a', 'test-a']);
    expectConfirms(model, [true, false, true]);
    held.release.resolve();
    await expectNotice(page, '测试店a', '软删除已生效');
    await page.waitForFunction(() => document.querySelectorAll('[data-wd-shop]').length === 1);
    assert.equal(await deleteButton(page).count(), 0);
    assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
    assert.deepEqual(model.rows, [ROWS[1]]);
    assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|可核对后重试/);
    expectPosts(model, ['test-a', 'test-a']);
  });
}

for (const [label, response] of [
  ['null', null],
  ['空对象', {}],
  ['ok 为字符串 false', { ok: 'false' }],
]) {
  test('删除返回有效 JSON ' + label + '：完整新 GET 前保持未知且禁用，不视为明确拒绝', async t => {
    const { page, model } = await openPage(t);
    model.deleteResponse = response;
    model.stateResponse = { ok: true, state: state(undefined) };
    await deleteAsUnknown(page, model, 'test-a', '');
    for (let i = 0; i < 2; i++) {
      await refresh(page, true);
      await expectNotice(page, '测试店a', '删除结果待核实');
      assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
      assert.equal(await deleteButton(page).isDisabled(), true);
      assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
      assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效|可核对后重试/);
      await deleteButton(page).dispatchEvent('click');
      await settleUi(page);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
    }
    model.stateResponse = { ok: true, state: state(ROWS) };
    await refresh(page);
    await expectNotice(page, '测试店a', '未删除.*可核对后重试');
    assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
    assert.equal(await deleteButton(page).isEnabled(), true);
    assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|软删除已生效/);
    expectPosts(model, ['test-a']);
    expectConfirms(model, [true]);
  });
}

const incompleteStates = [
  ['缺少 shopRows', { ok: true, state: state(undefined) }],
  ['shopRows 为 null', { ok: true, state: state(null) }],
  ['shopRows 非数组', { ok: true, state: state({}) }],
  ['空行对象', { ok: true, state: state([ROWS[1], null]) }],
  ['缺少 id', { ok: true, state: state([ROWS[1], { name: '测试无标识店' }]) }],
  ['空 id', { ok: true, state: state([ROWS[1], { ...ROWS[0], id: '' }]) }],
  ['非字符串 id', { ok: true, state: state([ROWS[1], { ...ROWS[0], id: 123 }]) }],
  ['重复 id 且目标缺席', { ok: true, state: state([ROWS[1], ROWS[1]]) }],
  ['重复 id 且目标在场', { ok: true, state: state([ROWS[0], ROWS[0], ROWS[1]]) }],
  ['未成功的状态响应', { ok: false, state: state([ROWS[1]]) }],
];

for (const [label, response] of incompleteStates) {
  test('未知删除遇到' + label + '：保留原行、禁用按钮与待核实提示', async t => {
    const { page, model } = await openPage(t);
    model.stateResponse = { ok: true, state: state(undefined) };
    await deleteAsUnknown(page, model, 'test-a', 'network');
    const button = deleteButton(page);
    await button.evaluate(el => el.dataset.fixtureIdentity = 'unknown-button');
    await page.locator('[data-wd-shop="test-b"]').evaluate(el => el.dataset.fixtureIdentity = 'unrelated-row');
    model.stateResponse = response;
    for (let i = 0; i < 2; i++) {
      await refresh(page, true);
      await expectNotice(page, '测试店a', '删除结果待核实');
      assert.deepEqual(await page.locator('[data-wd-shop]').evaluateAll(rows => rows.map(row => row.dataset.wdShop)), ['test-a', 'test-b']);
      assert.equal(await button.getAttribute('data-fixture-identity'), 'unknown-button');
      assert.equal(await page.locator('[data-wd-shop="test-b"]').getAttribute('data-fixture-identity'), 'unrelated-row');
      assert.equal(await button.isDisabled(), true);
      assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
      assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效|可核对后重试/);
      await button.dispatchEvent('click');
      await settleUi(page);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
    }
    model.rows = [structuredClone(ROWS[1])];
    model.stateResponse = undefined;
    await refresh(page);
    await expectNotice(page, '测试店a', '软删除已生效');
    assert.equal(await button.count(), 0);
    expectPosts(model, ['test-a']);
  });
}

for (const phase of ['删除前', '删除在途']) {
  for (const targetPresent of [true, false]) {
    test(phase + '开始的旧 GET ' + (targetPresent ? '仍含目标' : '缺少目标') + '不能核实后来未知的删除', { timeout: 30000 }, async t => {
      const { page, model } = await openPage(t);
      const rows = targetPresent ? ROWS : [ROWS[1]];
      model.stateResponse = { ok: true, state: state(undefined) };
      model.deleteFailure = 'network';
      const deleteHeld = phase === '删除在途' ? holdNext(model, 'delete') : null;
      if (deleteHeld) {
        await deleteButton(page).click();
        await deleteHeld.started.promise;
      }
      model.stateResponse = { ok: true, state: state(rows) };
      const stateHeld = holdNext(model, 'state', true);
      await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
      const oldRequest = await stateHeld.started.promise;
      const oldResponse = page.waitForResponse(response => response.request() === oldRequest);
      model.stateResponse = { ok: true, state: state(undefined) };
      if (deleteHeld) deleteHeld.release.resolve();
      else await deleteButton(page).click();
      await expectNotice(page, '测试店a', '删除结果待核实');
      assert.equal(await deleteButton(page).isDisabled(), true);
      stateHeld.release.resolve();
      await (await oldResponse).finished();
      await settleUi(page);
      await expectNotice(page, '测试店a', '删除结果待核实');
      assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效|可核对后重试/);
      assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
      assert.equal(await deleteButton(page).isDisabled(), true);
      assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
      await deleteButton(page).dispatchEvent('click');
      await settleUi(page);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
      model.stateResponse = { ok: true, state: state(rows) };
      await refresh(page);
      await expectNotice(page, '测试店a', targetPresent ? '未删除.*可核对后重试' : '软删除已生效');
      if (targetPresent) assert.equal(await deleteButton(page).isEnabled(), true);
      else assert.equal(await deleteButton(page).count(), 0);
      assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
    });
  }
}

test('未知删除后 GET A/B 乱序：较新 B 核实可重试后，缺少目标的旧 A 不能覆盖当前行', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  model.stateResponse = { ok: true, state: state(undefined) };
  await deleteAsUnknown(page, model, 'test-a', 'network');
  model.stateResponse = { ok: true, state: state([ROWS[1]]) };
  const heldA = holdNext(model, 'state');
  await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
  const requestA = await heldA.started.promise;
  const responseA = page.waitForResponse(response => response.request() === requestA);
  assert.equal(await deleteButton(page).isDisabled(), true);
  // GET B completes with a newer full snapshot while A remains held.
  model.stateResponse = { ok: true, state: state(ROWS) };
  await refresh(page);
  await expectNotice(page, '测试店a', '未删除.*可核对后重试');
  assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
  assert.equal(await deleteButton(page).isEnabled(), true);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
  heldA.release.resolve();
  await (await responseA).finished();
  await settleUi(page);
  await expectNotice(page, '测试店a', '未删除.*可核对后重试');
  assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
  assert.equal(await deleteButton(page).isEnabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|软删除已生效/);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
});

test('上一删除尝试的旧 GET 不能核实重新确认后产生的新未知尝试', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  model.stateResponse = { ok: true, state: state(undefined) };
  await deleteAsUnknown(page, model, 'test-a', 'network');
  model.stateResponse = { ok: true, state: state([ROWS[1]]) };
  const held = holdNext(model, 'state');
  await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
  const oldRequest = await held.started.promise;
  const oldResponse = page.waitForResponse(response => response.request() === oldRequest);
  model.stateResponse = { ok: true, state: state(ROWS) };
  await refresh(page);
  await expectNotice(page, '测试店a', '未删除.*可核对后重试');
  assert.equal(await deleteButton(page).isEnabled(), true);
  expectPosts(model, ['test-a']);
  model.stateResponse = { ok: true, state: state(undefined) };
  await deleteAsUnknown(page, model, 'test-a', 'json');
  expectPosts(model, ['test-a', 'test-a']);
  expectConfirms(model, [true, true]);
  held.release.resolve();
  await (await oldResponse).finished();
  await settleUi(page);
  await expectNotice(page, '测试店a', '删除结果待核实');
  assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效|可核对后重试/);
  assert.equal(await page.locator('[data-wd-shop="test-a"]').count(), 1);
  assert.equal(await deleteButton(page).isDisabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  await deleteButton(page).dispatchEvent('click');
  await settleUi(page);
  expectPosts(model, ['test-a', 'test-a']);
  expectConfirms(model, [true, true]);
  model.rows = [structuredClone(ROWS[1])];
  model.stateResponse = undefined;
  await refresh(page);
  await expectNotice(page, '测试店a', '软删除已生效');
  assert.equal(await deleteButton(page).count(), 0);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  expectPosts(model, ['test-a', 'test-a']);
  expectConfirms(model, [true, true]);
});

for (const failure of ['network', 'json']) {
  test('最后一家店删除 ' + failure + ' 未知后完整空数组可核实并保留唯一空态', async t => {
    const { page, model } = await openPage(t, [ROWS[0]]);
    model.stateResponse = { ok: true, state: state(undefined) };
    await deleteAsUnknown(page, model, 'test-a', failure);
    model.rows = [];
    model.stateResponse = undefined;
    for (let i = 0; i < 2; i++) {
      await refresh(page);
      await expectEmpty(page);
      await expectNotice(page, '测试店a', '软删除已生效');
      assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实|可核对后重试/);
      expectPosts(model, ['test-a']);
      expectConfirms(model, [true]);
    }
  });
}

test('两家同名店的未知删除按精确 id 分别核实，互不串店且不自动重提', async t => {
  const rows = ROWS.map(row => ({ ...row, name: '同名测试店' }));
  const { page, model } = await openPage(t, rows);
  model.stateResponse = { ok: true, state: state(undefined) };
  await deleteAsUnknown(page, model, 'test-a', 'network');
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  await deleteAsUnknown(page, model, 'test-b', 'json');
  assert.equal(await deleteButton(page).isDisabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isDisabled(), true);
  model.rows = [structuredClone(rows[1])];
  model.stateResponse = undefined;
  for (let i = 0; i < 3; i++) {
    await refresh(page);
    await expectNotice(page, '同名测试店', '软删除已生效');
    await expectNotice(page, '同名测试店', '未删除.*可核对后重试');
    assert.equal(await deleteButton(page).count(), 0);
    assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
    assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /删除结果待核实/);
    expectPosts(model, ['test-a', 'test-b']);
    expectConfirms(model, [true, true]);
  }
});

test('接口精确 ok:false 明确拒绝后无需完整 GET 即可重试，重新确认仅提交第二次删除且不影响另一店', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  await page.locator('[data-wd-act="edit"][data-wd-id="test-b"]').click();
  const input = page.locator('#wd-edit-test-b .wd-ethr');
  await input.fill('8.88');
  await input.evaluate(el => el.dataset.identityMark = 'unrelated');
  model.deleteFailure = 'rejected';
  model.stateResponse = { ok: true, state: state(undefined) };
  const button = deleteButton(page);
  await button.click();
  await page.waitForFunction(() => document.getElementById('wdError').innerText.includes('删除未获确认'));
  assert.doesNotMatch(await page.locator('#tab-watchdrill').innerText(), /软删除已生效|删除结果待核实/);
  assert.equal(await button.isEnabled(), true);
  assert.equal(await page.locator('[data-wd-shop]').count(), 2);
  expectPosts(model, ['test-a']);
  expectConfirms(model, [true]);
  model.deleteFailure = '';
  const held = holdNext(model, 'delete');
  await button.click();
  await held.started.promise;
  expectPosts(model, ['test-a', 'test-a']);
  expectConfirms(model, [true, true]);
  assert.equal(await button.isDisabled(), true);
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  held.release.resolve();
  await expectNotice(page, '测试店a', '软删除已生效');
  await page.waitForFunction(() => document.querySelectorAll('[data-wd-shop]').length === 1);
  assert.equal(await button.count(), 0);
  assert.equal(await input.inputValue(), '8.88');
  assert.equal(await input.getAttribute('data-identity-mark'), 'unrelated');
  assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
  assert.deepEqual(model.rows, [ROWS[1]]);
  expectPosts(model, ['test-a', 'test-a']);
  expectConfirms(model, [true, true]);
});

test('取消确认不提交删除', async t => {
  const { page, model } = await openPage(t);
  model.cancel = true;
  await page.locator('[data-wd-act="delete"][data-wd-id="test-a"]').click();
  await refresh(page);
  assert.deepEqual(model.posts, []);
  assert.equal(await page.locator('[data-wd-shop]').count(), 2);
});

test('旧日志成功晚于新读取：不能追加旧消息、缺口或覆盖新游标', { timeout: 30000 }, async t => {
  const { page, model } = await openPage(t);
  model.logsResponse = {
    ok: true, seq: 91, gap: { droppedCount: 17 },
    logs: [{ t: '2026-10-23T00:00:00.000Z', level: 'info', msg: '迟到旧日志消息' }],
  };
  const held = holdNext(model, 'logs');
  await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
  const oldRequest = await held.started.promise;
  const oldResponse = page.waitForResponse(response => response.request() === oldRequest);
  assert.equal(new URL(oldRequest.url()).searchParams.get('since'), '0');
  assert.equal(model.logsSince.at(-1), '0');

  model.logsResponse = {
    ok: true, seq: 42, gap: null,
    logs: [{ t: '2026-10-23T00:01:00.000Z', level: 'info', msg: '较新日志消息' }],
  };
  await refresh(page);
  const currentLog = await page.locator('#wdLog').innerText();
  assert.match(currentLog, /较新日志消息/);
  assert.doesNotMatch(currentLog, /迟到旧日志消息/);
  assert.equal(await page.locator('#wdGap').textContent(), '');
  assert.equal(await page.locator('#wdGap').isVisible(), false);

  held.release.resolve();
  await (await oldResponse).finished();
  await settleUi(page);
  assert.equal(await page.locator('#wdLog').innerText(), currentLog);
  assert.equal(await page.locator('#wdGap').textContent(), '');
  assert.equal(await page.locator('#wdGap').isVisible(), false);
  assert.equal(await page.locator('#wdError').textContent(), '');

  // Observe the next real GET rather than inspecting the closure's private cursor.
  model.logsResponse = { ok: true, logs: [], seq: 42, gap: null };
  await refresh(page);
  assert.equal(model.logsSince.at(-1), '42');
  assert.equal(await page.locator('#wdLog').innerText(), currentLog);
  assert.equal(await page.locator('#wdGap').textContent(), '');
  expectPosts(model, []);
  expectConfirms(model, []);
});

for (const failure of ['network', 'json']) {
  test('旧日志 ' + failure + ' 失败晚于确认删除：不能覆盖成功后的错误状态', { timeout: 30000 }, async t => {
    const { page, model } = await openPage(t);
    model.logsFailure = failure;
    const held = holdNext(model, 'logs');
    await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
    const oldRequest = await held.started.promise;
    const completed = failure === 'network'
      ? page.waitForEvent('requestfailed', req => req === oldRequest)
      : page.waitForResponse(res => res.request() === oldRequest).then(res => res.finished());
    model.logsFailure = '';
    await deleteButton(page).click();
    await expectNotice(page, '测试店a', '软删除已生效');
    await page.waitForFunction(() => document.querySelectorAll('[data-wd-shop]').length === 1);
    const receipt = await page.locator('#wdShopDeleteResult').textContent();
    assert.equal(await page.locator('#wdError').textContent(), '');
    assert.equal(await page.locator('#alError').textContent(), '');

    // No intervening refresh: delete start/settlement must invalidate the held logs read.
    held.release.resolve();
    await completed;
    await settleUi(page);
    assert.equal(await page.locator('#wdError').textContent(), '');
    assert.equal(await page.locator('#alError').textContent(), '');
    assert.equal(await page.locator('#wdShopDeleteResult').textContent(), receipt);
    assert.equal(await deleteButton(page).count(), 0);
    assert.equal(await deleteButton(page, 'test-b').isEnabled(), true);
    expectPosts(model, ['test-a']);
    expectConfirms(model, [true]);
  });

  test('旧状态 ' + failure + ' 失败晚于新成功刷新：不能改写 wdError 或 alError', { timeout: 30000 }, async t => {
    const { page, model } = await openPage(t);
    model.stateFailure = failure;
    const held = holdNext(model, 'state');
    await page.locator('#tab-watchdrill button[onclick="wdRefreshAll()"]').click();
    const oldRequest = await held.started.promise;
    const completed = failure === 'network'
      ? page.waitForEvent('requestfailed', req => req === oldRequest)
      : page.waitForResponse(res => res.request() === oldRequest).then(res => res.finished());
    model.stateFailure = '';
    await refresh(page);
    assert.equal(await page.locator('#wdError').textContent(), '');
    assert.equal(await page.locator('#alError').textContent(), '');
    const badge = await page.locator('#alBadge').textContent();
    assert.match(badge, /已同步/);

    held.release.resolve();
    await completed;
    await settleUi(page);
    assert.equal(await page.locator('#wdError').textContent(), '');
    assert.equal(await page.locator('#alError').textContent(), '');
    assert.equal(await page.locator('#alBadge').textContent(), badge);
    assert.equal(await page.locator('[data-wd-shop]').count(), 2);
    expectPosts(model, []);
    expectConfirms(model, []);
  });
}
