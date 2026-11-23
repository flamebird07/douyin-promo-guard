'use strict';
// R55 OFFLINE regression: a KNOWN late guidance overlay landing right before the
// numeric-leaf pager advance. Exercises the REAL exported driver
// (run-plans.cjs createRealDrivers.browseProducts) and the REAL in-page callbacks
// (numericPickerPagingInPage / drawerSnapshotInPage / guidanceActionInPage dispatch
// identity) against an in-process fake page — the same harness approach as
// numericOvuiPagerHost, never a mirrored model or a source-regex. No network, no
// browser, no CDP, no real cookies (ctx.saveCookies/ctx.persistFlags offline seams),
// no production, no publish/enable/pause/delete, no ledger writes. Only command:
//   node --test late-numeric-guide.test.cjs
//
// Scenarios pinned (fail-closed, zero pager clicks unless everything is proven):
//   known handled + persisted  -> fresh re-proven scope, ONE leaf click, 30 real ids
//   no overlay                 -> zero extra phase/cookie/flag work (no regression)
//   transient (callback 0)     -> safe fresh re-read path, still completes
//   unknown overlay            -> original unknown reason, zero action
//   cookie save failure        -> native-advance-guide-state-not-persisted, zero action
//   persistent overlay         -> guidance-advance timeout, zero pager action
//   guide-induced footer/category/account/main drift -> zero pager clicks, honest stop
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const wf = require('./plan-workflow.cjs');
const c = require('./direct-draft-controller.cjs');
const rp = require('./run-plans.cjs');

// Host adapted from plan-workflow.test.cjs numericOvuiPagerHost: leaf:'unique' All
// pager, page1 20 + page2 10 real-shape 15-20 digit ids, plus a guidance state
// machine armed exactly at the leaf-pager scope read (the moment the live
// numeric-leaf-guide-overlay-present stops happened).
function lateGuidePagerHost(cfg = {}) {
  const acct = String(wf.BUSINESS.accountId);
  const cat = '全部';
  const baseIds = (cfg.baseIds || []).map(String);
  const baseSet = new Set(baseIds);
  const page1Ids = cfg.page1Ids || Array.from({ length: 20 }, (_, i) => '384581162524855' + String(1000 + i));
  const page2Ids = cfg.page2Ids || Array.from({ length: 10 }, (_, i) => '384581162524855' + String(2000 + i));
  const guide = cfg.guide || 'none';            // none | known | transient | unknown | saveFail | persistent
  const postGuideDrift = cfg.postGuideDrift || null; // footer | category | account | main
  const capacity = wf.BUSINESS.productsPerPlan - baseIds.length;
  const checked = new Set((cfg.checkedIds || []).map(String));
  const batchCount = () => [...checked].filter(id => !baseSet.has(id)).length;
  let page = 1, submitClicks = 0, selectCalls = 0, leafClickCalls = 0, nextClickCalls = 0, readCalls = 0, screenshotCalls = 0, screenshotTimeout = null, postClickObserveReads = 0;
  let closed = false, guideArmed = false, guideActive = false, guideSeen = false, guideSteps = 0, cookieSaves = 0, flagSaves = 0;
  let driftLive = false;
  const STRANGER = '399999999999999991';
  const mkLeaf = (p, index, disabled) => ({ index, kind: 'number', page: p, disabled, cls: 'ovui-page-turner__item' });
  const domIds = () => (page === 1 ? page1Ids : page === 3 && cfg.page3Ids ? cfg.page3Ids : page2Ids).slice();
  const cards = () => domIds().map(id => ({ id, text: '可投商品 ID: ' + id, checked: checked.has(id), checkboxCount: 1, disabled: false }));
  const drawerSnap = () => closed ? { ok: false, reason: 'closed' } : {
    ok: true, cards: cards(), selectedCount: batchCount(), remainingCapacity: capacity,
    activeTabs: driftLive && postGuideDrift === 'category' ? ['店铺新品'] : [cat],
    rootText: '已选 ' + batchCount() + ' / ' + capacity, pagerCount: 1,
  };
  const root = () => ({ order: 0, kind: 'clib', content: '新手引导 下一步', label: '下一步', disabled: false });
  const events = new EventEmitter();
  const pageObj = { on: events.on.bind(events), removeListener: events.removeListener.bind(events), url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=1234567890',
    isClosed: () => false,
    screenshot: async ({ path: screenshotPath, timeout }) => { screenshotCalls++; screenshotTimeout = timeout; fs.writeFileSync(screenshotPath, 'synthetic screenshot'); },
    evaluate: async (fn, arg) => {
    if (fn === rp.drawerSnapshotInPage) return drawerSnap();
    if (fn === rp.selectNativeCardInPage) { selectCalls++; checked.add(String(arg)); return { id: String(arg), checked: true }; }
    if (fn === rp.deselectNativeCardInPage) { checked.delete(String(arg)); return { id: String(arg), checked: false }; }
    if (fn === rp.classifyAndCancelAutoPullInPage) return { kind: 'none', productIds: [] };
    if (fn === rp.guidanceActionInPage) {
      if (arg && arg.mode === 'step') {
        guideSteps++;
        if (guide !== 'persistent') guideActive = false;
        if (postGuideDrift) {
          driftLive = true;
          if (postGuideDrift === 'footer') checked.add(STRANGER);
        }
        return { clicked: true };
      }
      if (!guideArmed) return { present: false, unknown: null, roots: [] };
      if (guide === 'unknown') return { present: false, unknown: 'guide-shape-unknown', roots: [] };
      if (guideActive) {
        if (guide === 'transient') { guideActive = false; return { present: true, unknown: null, roots: [root()] }; }
        return { present: true, unknown: null, roots: [root()] };
      }
      return { present: false, unknown: null, roots: [] };
    }
    if (fn === c.pageObserve) {
      if (cfg.landOnFinalRead && leafClickCalls && ++postClickObserveReads === 2) page = 2;
      if (cfg.throwReadAfterClick && leafClickCalls > 0 && ++postClickObserveReads > 1) throw new Error('synthetic-post-timeout-read-failure');
      const creation = cfg.creationOverride && !driftLive ? cfg.creationOverride
        : driftLive && postGuideDrift === 'main' ? { accountId: acct, mainTableUnique: false }
        : { accountId: acct, mainTableUnique: true };
      return {
        observation: 'obs-' + page, url: 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',
        pagination: { currentPage: page, pageCount: cfg.page3Ids ? 3 : 2, modalPresent: true, inProductModal: true, items: [mkLeaf(page, 8, false), mkLeaf(page + 1, 9, false)] },
        elements: [{ text: '下一步', tag: 'BUTTON', index: 4 }], creation,
      };
    }
    if (fn === rp.numericPickerPagingInPage) {
      if (arg.mode === 'read') {
        readCalls++;
        // the overlay lands exactly at the leaf-pager scope read, once (never re-armed
        // by the later post-advance verification reads)
        if (!guideArmed && guide !== 'none') { guideArmed = true; guideActive = true; }
        return {
          ok: true, mode: 'read', clicked: false, currentPage: page,
          footerSelectedCount: batchCount() + (cfg.footerDriftAfterClick && leafClickCalls > 0 ? 1 : 0), footerRemainingCapacity: capacity,
          checkedIds: [...checked], accountId: driftLive && postGuideDrift === 'account' ? '9999999999999999' : acct,
        };
      }
      throw new Error('unexpected numeric paging mode ' + JSON.stringify(arg && arg.mode));
    }
    if (fn === c.actionApply) { submitClicks++; closed = true; return { clicked: true }; }
    if (fn === c.pageApply) {
      if (!arg || arg.mode !== 'click' || arg.expectKind !== 'number' || arg.expectPage !== page + 1) throw new Error('host generic pageApply received a non next-number instruction ' + JSON.stringify(arg));
      if (cfg.catalogStatus) {
        const targetPage = page + 1;
        const request = { method: () => 'GET', url: () => rp.CATALOG_ORIGIN + rp.CATALOG_PATH + '?aavid=' + acct + '&tab=1&page=' + targetPage };
        events.emit('request', request);
        events.emit('response', {
          request: () => request, status: () => cfg.catalogStatus,
          json: async () => cfg.catalogBody?.(targetPage),
        });
      }
      leafClickCalls++; if (!cfg.stallAfterClick && !cfg.landOnFinalRead) page = page + 1;
      return { paged: true, mode: 'click', index: arg.index, kind: 'number' };
    }
    if (fn === rp.readMainTableInPage) return closed ? { ok: true, rows: [] } : { ok: false, reason: 'table-not-submitted' };
    throw new Error('unexpected late-guide host evaluate ' + (fn.name || String(fn).slice(0, 30)));
  } };
  const dayState = { lastSelected: [], attempted: [], cursor: { category: cat, page: cfg.cursorPage || 1, seenProductIds: [] } };
  const driver = rp.createRealDrivers({
    page: pageObj, managerPage: {}, context: {}, dayState, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: acct,
    opened: {}, projectRoot: cfg.projectRoot || __dirname, planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: cfg.timeoutMs || 1500,
    saveCookies: async () => { cookieSaves++; return guide === 'saveFail' ? { status: 'failed', reason: 'offline-stub-write-failed' } : { status: 'saved', count: 3, bytes: 128, domains: 1, conflict: false }; },
    persistFlags: async () => { flagSaves++; return { saved: true, count: 0 }; },
  });
  return { page: pageObj, dayState, driver,
    state: () => ({ submitClicks, selectCalls, leafClickCalls, nextClickCalls, readCalls, screenshotCalls, screenshotTimeout, page, closed, cursorPage: dayState.cursor.page, guideSteps, cookieSaves, flagSaves }),
    run: () => driver.browseProducts({ selectedIds: baseIds.slice(), needed: capacity, categories: [cat], onProgress: async () => {} }) };
}

test('LNG1 a known late overlay is handled by the real guidance phase (click+cookie+flags persisted once), then the fresh re-proven leaf advances once and fills 30', async () => {
  const h = lateGuidePagerHost({ guide: 'known' });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.selectedIds.length, 30);
  const s = h.state();
  assert.equal(s.guideSteps, 1, '引导浮窗被真实 phase 处理一次');
  assert.equal(s.cookieSaves, 1, 'handled>0 必须 cookie saved 一次');
  assert.equal(s.flagSaves, 1, 'handled>0 必须 flags persisted 一次');
  assert.equal(s.leafClickCalls, 1, '处理后全新读取，数字叶一次且仅一次点击');
  assert.equal(s.nextClickCalls, 0, '数字叶路径绝不点svg');
  assert.equal(s.selectCalls, 30, 'page1 20 + page2 10');
  assert.equal(s.submitClicks, 1);
  assert.equal(s.cursorPage, 2, '确认到第2页后才写cursor');
});

test('LNG2 no overlay: zero extra guidance/cookie/flag work — the pre-R55 fast path is unchanged', async () => {
  const h = lateGuidePagerHost({ guide: 'none' });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = h.state();
  assert.equal(s.guideSteps, 0); assert.equal(s.cookieSaves, 0); assert.equal(s.flagSaves, 0);
  assert.equal(s.leafClickCalls, 1); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.selectCalls, 30); assert.equal(s.submitClicks, 1); assert.equal(s.cursorPage, 2);
});

test('LNG3 a transient overlay the phase itself never clicks (handled 0, fresh absent) continues through the safe fresh re-read and still fills 30', async () => {
  const h = lateGuidePagerHost({ guide: 'transient' });
  const r = await h.run();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.selectedIds.length, 30);
  const s = h.state();
  assert.equal(s.guideSteps, 0, 'vanishing overlay: phase handled 0, zero clicks');
  assert.equal(s.cookieSaves, 0); assert.equal(s.flagSaves, 0);
  assert.equal(s.leafClickCalls, 1);
  assert.equal(s.submitClicks, 1); assert.equal(s.cursorPage, 2);
});

test('LNG4 an unknown overlay keeps the original unknown reason with zero pager clicks, zero cookie/flag writes', async () => {
  const h = lateGuidePagerHost({ guide: 'unknown' });
  await assert.rejects(h.run(), /guide-shape-unknown/);
  const s = h.state();
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.guideSteps, 0); assert.equal(s.cookieSaves, 0); assert.equal(s.flagSaves, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG5 a handled overlay whose cookie writeback fails stops with zero pager clicks (state-not-persisted)', async () => {
  const h = lateGuidePagerHost({ guide: 'saveFail' });
  await assert.rejects(h.run(), /native-advance-guide-state-not-persisted/);
  const s = h.state();
  assert.equal(s.guideSteps, 1);
  assert.equal(s.cookieSaves, 1, '真实尝试保存一次并失败');
  assert.equal(s.flagSaves, 0, 'cookie 未保存绝不写flags');
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG6 a persistent overlay that never disappears stops the guidance advance with zero pager clicks', async () => {
  const h = lateGuidePagerHost({ guide: 'persistent' });
  await assert.rejects(h.run(), /guidance-advance-timeout/);
  const s = h.state();
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG7 a guide-induced footer-count drift after handling is a zero-pager-click stop (no stale before/footer reuse)', async () => {
  const h = lateGuidePagerHost({ guide: 'known', postGuideDrift: 'footer' });
  await assert.rejects(h.run(), error => {
    assert.match(error.message, /current-product-page-footer-capacity-drift|numeric-leaf-post-guide-footer-drift/);
    return true;
  });
  const s = h.state();
  assert.equal(s.guideSteps, 1);
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG8 a guide-induced category drift after handling is a zero-pager-click stop', async () => {
  const h = lateGuidePagerHost({ guide: 'known', postGuideDrift: 'category' });
  await assert.rejects(h.run(), error => {
    assert.match(error.message, /current-product-page-category-not-active|numeric-leaf-post-guide-category-drift/);
    return true;
  });
  const s = h.state();
  assert.equal(s.guideSteps, 1);
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG9 a guide-induced account drift in the fresh scope read is a zero-pager-click stop', async () => {
  const h = lateGuidePagerHost({ guide: 'known', postGuideDrift: 'account' });
  await assert.rejects(h.run(), /numeric-leaf-post-guide-account-drift/);
  const s = h.state();
  assert.equal(s.guideSteps, 1);
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 1);
});

test('LNG10 a guide-induced main-table drift after handling is a zero-pager-click stop (base18 top-up, not the first-empty exception)', async () => {
  const base18 = Array.from({ length: 18 }, (_, i) => '384581162524855' + String(5000 + i));
  const h = lateGuidePagerHost({ guide: 'known', postGuideDrift: 'main', baseIds: base18, checkedIds: base18.slice(0, 13), page1Ids: base18.slice(0, 13), page2Ids: Array.from({ length: 12 }, (_, i) => '384581162524855' + String(7000 + i)), cursorPage: 2 });
  await assert.rejects(h.run(), error => {
    assert.match(error.message, /current-product-page-main-table-not-unique|numeric-leaf-post-guide-scope-not-proven/);
    return true;
  });
  const s = h.state();
  assert.equal(s.guideSteps, 1);
  assert.equal(s.leafClickCalls, 0); assert.equal(s.nextClickCalls, 0);
  assert.equal(s.submitClicks, 0); assert.equal(s.cursorPage, 2);
});

test('LNG11 numeric leaf timeout records failed readiness conditions and landing screenshot without retrying or changing refusal', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-pager-timeout-'));
  try {
    const h = lateGuidePagerHost({ guide: 'none', stallAfterClick: true, catalogStatus: 503, timeoutMs: 40, projectRoot });
    await assert.rejects(h.run(), /numeric-leaf-page-advance-timeout/);
    const state = h.state();
    assert.equal(state.leafClickCalls, 1, 'the already-issued pager action is never repeated');
    assert.equal(state.nextClickCalls, 0);
    assert.equal(state.submitClicks, 0);
    assert.equal(state.cursorPage, 1, 'timeout does not advance durable cursor');
    assert.equal(state.screenshotCalls, 1, 'capture the actual landing page after timeout');
    assert.ok(state.screenshotTimeout > 0 && state.screenshotTimeout <= 3000, 'screenshot capture has a short bound');
    const artifactDir = path.join(projectRoot, 'plan-publisher');
    const evidence = JSON.parse(fs.readFileSync(path.join(artifactDir, 'numeric-pager-timeout.log'), 'utf8').trim());
    assert.equal(evidence.reason, 'numeric-leaf-page-advance-timeout');
    assert.equal(evidence.sampleReadOk, true);
    assert.equal(evidence.url, 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi', 'account query is omitted');
    assert.equal(evidence.observedPage, 1);
    assert.deepEqual(evidence.catalogHttpStatuses, [503]);
    assert.equal(evidence.checks.observePageAdvanced, false);
    assert.equal(evidence.checks.numericPagerPageAdvanced, false);
    assert.equal(evidence.checks.drawerSnapshotOk, true);
    assert.equal(evidence.checks.allCategoryActive, true);
    assert.equal(evidence.checks.cardIdsChanged, false);
    assert.doesNotMatch(JSON.stringify(evidence), /384581162524855|1234567890/);
    assert.equal(fs.readFileSync(path.join(artifactDir, 'numeric-pager-timeout.png'), 'utf8'), 'synthetic screenshot');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('LNG13 timeout diagnostic identifies page 2 reached while a separate footer gate remains false', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-pager-page2-gate-'));
  try {
    const h = lateGuidePagerHost({ guide: 'none', footerDriftAfterClick: true, timeoutMs: 40, projectRoot });
    await assert.rejects(h.run(), /numeric-leaf-page-advance-timeout/);
    const state = h.state();
    assert.equal(state.page, 2, 'synthetic pager reaches page 2');
    assert.equal(state.leafClickCalls, 1);
    assert.equal(state.cursorPage, 1, 'unmet footer gate keeps cursor unchanged');
    assert.equal(state.submitClicks, 0);
    const evidence = JSON.parse(fs.readFileSync(path.join(projectRoot, 'plan-publisher', 'numeric-pager-timeout.log'), 'utf8').trim());
    assert.equal(evidence.observedPage, 2);
    assert.equal(evidence.checks.observePageAdvanced, true);
    assert.equal(evidence.checks.numericPagerPageAdvanced, true);
    assert.equal(evidence.checks.selectedCountPreserved, false);
    assert.equal(evidence.checks.cardIdsChanged, true);
    assert.equal(evidence.sampleReadOk, true);
    assert.equal(state.screenshotCalls, 1);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('LNG14 timeout sample read failure still attempts screenshot and preserves original timeout', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-pager-read-fails-'));
  try {
    const h = lateGuidePagerHost({ guide: 'none', stallAfterClick: true, throwReadAfterClick: true, timeoutMs: 1, projectRoot });
    await assert.rejects(h.run(), /numeric-leaf-page-advance-timeout/);
    const state = h.state();
    assert.equal(state.leafClickCalls, 1);
    assert.equal(state.screenshotCalls, 1, 'screenshot is attempted independently after read failure');
    assert.equal(state.cursorPage, 1);
    assert.equal(state.submitClicks, 0);
    const evidence = JSON.parse(fs.readFileSync(path.join(projectRoot, 'plan-publisher', 'numeric-pager-timeout.log'), 'utf8').trim());
    assert.equal(evidence.sampleReadOk, false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('LNG12 overlay sweep normalizes visible whitespace before matching an approved guidance label', async () => {
  let visible = true, clicks = 0;
  const normalizePlaywrightText = value => String(value || '').replace(/\s+/g, ' ').trim();
  const frame = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',
    getByText: (label, options) => {
      assert.equal(options.exact, true);
      return {
        count: async () => (visible && normalizePlaywrightText('\n 跳过 \n') === label) ? 1 : 0,
        nth: () => ({
          isVisible: async () => visible,
          innerText: async () => '\n 跳过 \n',
          click: async () => { clicks++; visible = false; },
        }),
      };
    },
    locator: selector => {
      const requestedLabels = [...selector.matchAll(/:has-text\("([^"]+)"\)/g)].map(match => normalizePlaywrightText(match[1]));
      const normalizedText = normalizePlaywrightText('\n 跳过 \n');
      const matchesApproved = requestedLabels.some(label => normalizedText.includes(label));
      const isCloseSel = /ovui-popup|guideAnchor|aria-label/.test(selector);
      return {
        count: async () => (!isCloseSel && matchesApproved && visible) ? 1 : 0,
        nth: () => ({
          isVisible: async () => visible,
          innerText: async () => '\n 跳过 \n',
          click: async () => { clicks++; visible = false; },
        }),
      };
    },
  };
  const page = {
    frames: () => [frame],
    evaluate: async () => ({ clicked: 0, popupMaskPresent: false }),
    keyboard: { press: async () => { throw new Error('escape-should-not-run-without-mask'); } },
  };
  await rp.sweepOverlays(page, 2);
  assert.equal(clicks, 1);
});

test('LNG16 overlay sweep presses Escape once when ovui-popup mask persists without a skip control', async () => {
  let escapes = 0;
  let maskPresent = true;
  const frame = {
    url: () => 'https://qianchuan.jinritemai.com/create-ad/overall-product',
    locator: () => ({ count: async () => 0, nth: () => ({ isVisible: async () => false, innerText: async () => '', click: async () => {} }) }),
  };
  const page = {
    frames: () => [frame],
    evaluate: async (fn) => {
      // drawer-presence probe (inline function) must report false so Escape is allowed
      if (typeof fn === 'function' && !fn.name) return false;
      return { clicked: 0, actions: [], popupMaskPresent: maskPresent };
    },
    keyboard: { press: async (key) => { assert.equal(key, 'Escape'); escapes += 1; maskPresent = false; } },
  };
  const result = await rp.sweepOverlays(page, 2);
  assert.equal(escapes, 1);
  assert.ok(result.clicked >= 1);
  assert.equal(result.popupMaskPresent, false);
});

test('LNG17 overlay sweep never presses Escape while the product picker drawer is open', async () => {
  let escapes = 0;
  const frame = {
    url: () => 'https://qianchuan.jinritemai.com/create-ad/overall-product',
    locator: () => ({ count: async () => 0, nth: () => ({ isVisible: async () => false, innerText: async () => '', click: async () => {} }) }),
  };
  const page = {
    frames: () => [frame],
    evaluate: async (fn) => {
      if (typeof fn === 'function' && !fn.name) return true; // drawer open
      return { clicked: 0, actions: [], popupMaskPresent: true };
    },
    keyboard: { press: async () => { escapes += 1; } },
  };
  const result = await rp.sweepOverlays(page, 2);
  assert.equal(escapes, 0);
  assert.equal(result.clicked, 0);
  assert.equal(result.popupMaskPresent, true);
});


test('LNG15 accepts a fully verified page landing on the final read without clicking again', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-pager-late-'));
  try {
    const h = lateGuidePagerHost({ landOnFinalRead: true, timeoutMs: 40, projectRoot });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.selectedIds.length, 30);
    assert.equal(h.state().cursorPage, 2);
    assert.equal(h.state().leafClickCalls, 1);
    assert.equal(h.state().screenshotCalls, 0);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('numeric pager scans past an identical adjacent page when the target response confirms its cards', async () => {
  const page1Ids = Array.from({ length: 20 }, (_, i) => '384581162524855' + String(1000 + i));
  const page3Ids = Array.from({ length: 10 }, (_, i) => '384581162524855' + String(3000 + i));
  const h = lateGuidePagerHost({
    page1Ids, page2Ids: page1Ids.slice().reverse(), page3Ids, catalogStatus: 200,
    catalogBody: page => ({
      status_code: 0, data: {
        pagination: { page },
        productListInfos: (page === 2 ? page1Ids : page3Ids).map(id => ({ productInfo: { id } })),
      },
    }),
  });
  const result = await h.run();
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.selectedIds, [...page1Ids, ...page3Ids]);
  assert.equal(h.state().leafClickCalls, 2);
  assert.equal(h.state().cursorPage, 3);
  assert.equal(h.state().selectCalls, 30);
});

test('numeric pager preserves its cursor when repeated cards lack a matching target response', async t => {
  const page1Ids = Array.from({ length: 20 }, (_, i) => '384581162524855' + String(1000 + i));
  for (const [name, responsePage, ids] of [
    ['HTTP 200 with no body', null, []],
    ['wrong response page', 1, page1Ids],
    ['wrong response cards', 2, page1Ids.slice(1)],
  ]) {
    await t.test(name, async () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'numeric-pager-repeated-'));
      try {
        const h = lateGuidePagerHost({
          page1Ids, page2Ids: page1Ids, catalogStatus: 200, timeoutMs: 1, projectRoot,
          catalogBody: () => responsePage === null ? null : ({
            status_code: 0, data: {
              pagination: { page: responsePage },
              productListInfos: ids.map(id => ({ productInfo: { id } })),
            },
          }),
        });
        await assert.rejects(h.run(), /numeric-leaf-page-advance-timeout/);
        assert.equal(h.state().leafClickCalls, 1);
        assert.equal(h.state().cursorPage, 1);
        assert.equal(h.state().submitClicks, 0);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  }
});
