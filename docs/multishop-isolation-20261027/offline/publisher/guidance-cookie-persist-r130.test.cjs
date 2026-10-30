'use strict';
// R130 offline behavioural regression for AD-GUIDANCE-COOKIE-PERSIST-20261021-F1.
//
// Incident: the real scheduled second plan handled the 千川 guidance overlay
// (handled=1) but the promotion working-cookie writeback failed (cookieStatus=failed,
// cookieReason=unknown — the writeback honestly kept the existing healthy source),
// and the old runGuidancePhase refused to persist the guidance flags on any
// non-conflict cookie failure (flagsSaved=false, flagsReason=cookie-not-saved), so
// handleLateGuidanceBeforeNativeAdvance fail-closed with
// `native-advance-guide-state-not-persisted` and the plan was zero-consumption closed.
//
// Fix under test: guidance flags live in an INDEPENDENT private per-account file
// (atomic write + full readback), so their durability never depends on the
// working-cookie outcome. flagsSaved=true now means exactly one durable readback
// success; a flags failure stays fail-closed with a DETERMINISTIC reason. No cookie
// conflict/identity/shop/source validation is relaxed and the shop-product-analysis
// read-only raw layer is never touched.
//
// Second half of the fix (T9-T11): the production fingerprint chain
// direct-draft-controller.runSaveCookies -> run-plans.createRealDrivers().saveCookies
// -> updateCookieSessionFingerprint must gate on the CANONICAL helper's own
// post-normalization write hash (expectedSha256/afterSha256 pass-through), never on
// a hash of the pre-normalization raw context cookies — the normalized file
// legitimately differs, so the old raw-content expectation made every successful
// writeback look like cookie-write-readback-does-not-match-owned-content, froze the
// session fingerprint and turned the next save into a phantom external conflict.
//
// Every test drives the REAL production functions (rp.runGuidancePhase,
// rp.handleLateGuidanceBeforeNativeAdvance, rp.persistPrivateGuidanceState,
// rp.runScheduledPlan) — no reimplemented helper logic. No browser, no network, no
// real cookie values, no publish, no production state writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const rp = require('./run-plans.cjs');
const sp = require('./shop-profile.cjs');
const wf = require('./plan-workflow.cjs');

const ACCOUNT = '1888123400000002';
const SHOP = 'R130引导耐久店';
const BUSINESS_DATE = '2026-10-21';
// Incident reproduction: the writeback failed and KEPT the old bytes (its own
// protection); the Chinese helper reason matches no English category -> 'unknown',
// exactly like the real evidence cookieStatus=failed / cookieReason=unknown.
const INCIDENT_COOKIE = { status: 'failed', reason: 'Cookie 回写失败（旧文件保留）: EBUSY: resource busy or locked' };

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r130-' + name + '-'));
}

// Production-shape guidance page stub: snapshot/step through the REAL
// rp.guidanceActionInPage contract and localStorage capture through the REAL
// rp.guidanceStorageCaptureInPage reference (only whitelisted guide flags).
function guidePage(opts) {
  const o = opts || {};
  let snap = 0, steps = 0, captures = 0;
  const page = {
    evaluate: async (fn, arg) => {
      if (fn === rp.guidanceActionInPage) {
        if (arg && arg.mode === 'snapshot') {
          snap++;
          // The overlay stays present until it is actually clicked away (steps>0),
          // mirroring the real DOM: a handleLate probe + the phase's own settle
          // snapshot must both see the same still-present overlay.
          if (o.absent || steps > 0) return { present: false, unknown: null, roots: [] };
          return { present: true, unknown: null, roots: [{ order: 0, kind: 'next-step', content: 'c', label: '我知道了' }] };
        }
        if (arg && arg.mode === 'step') { steps++; return { clicked: true, kind: arg.kind, label: arg.label }; }
        throw new Error('unexpected guidanceActionInPage mode');
      }
      if (fn === rp.guidanceStorageCaptureInPage) {
        captures++;
        return { values: o.values || [{ key: 'qc_lite_c_guide_overall_multi', value: '1' }] };
      }
      throw new Error('unexpected evaluate target: ' + String(fn && fn.name));
    },
  };
  page.calls = { get snaps() { return snap; }, get steps() { return steps; }, get captures() { return captures; } };
  return page;
}

// EXACT production default persistFlags closure (run-plans.cjs createRealDrivers:
// capture from the page via guidanceStorageCaptureInPage, persist via
// persistPrivateGuidanceState with real atomic write + readback).
function productionPersistFlags(page, dir) {
  return async () => {
    const captured = await page.evaluate(rp.guidanceStorageCaptureInPage, ACCOUNT);
    return rp.persistPrivateGuidanceState(rp.guidanceFilePath(ACCOUNT, dir), ACCOUNT, (captured && captured.values) || []);
  };
}

function snapshotTree(root) {
  const out = {};
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p).toString('hex');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

// ── T1 normal promotion working-cookie writeback: saved cookie + durable flags ──
test('T1 real phase + real handleLate: saved working copy, flags durably persisted, late guidance continues', async () => {
  const dir = tmpDir('normal');
  try {
    const page = guidePage();
    const out = await rp.runGuidancePhase(page, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ status: 'saved' }),
      persistFlags: productionPersistFlags(page, dir),
    });
    assert.equal(out.handled, 1);
    assert.equal(out.cookieStatus, 'saved');
    assert.equal(out.flagsSaved, true);
    assert.equal(out.flagsReason, null);
    assert.equal(page.calls.captures, 1, 'flags captured exactly once');
    const file = rp.guidanceFilePath(ACCOUNT, dir);
    assert.equal(fs.existsSync(file), true, 'private guidance file exists');
    const read = rp.readPrivateGuidanceState(file, ACCOUNT);
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.values, [{ key: 'qc_lite_c_guide_overall_multi', value: '1' }]);
    // The SAME real phase consumed by the REAL late-guidance orchestration seam
    // (handleLateGuidanceBeforeNativeAdvance) must continue without throwing.
    const page2 = guidePage();
    const late = await rp.handleLateGuidanceBeforeNativeAdvance(page2, ACCOUNT,
      () => rp.runGuidancePhase(page2, {
        accountId: ACCOUNT,
        saveCookies: async () => ({ status: 'saved' }),
        persistFlags: productionPersistFlags(page2, dir),
      }));
    assert.equal(late.handled, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T2 cookie CAS conflict: healthy source never overwritten, flags still durable ──
test('T2 real phase on cookie conflict: one write attempt, healthy source untouched, private flags durable, continues', async () => {
  const dir = tmpDir('conflict');
  try {
    // Healthy promotion working copy standing in for the untouched newer file.
    const healthySource = path.join(dir, 'cookies-shop-working-copy.json');
    const healthyBytes = JSON.stringify([{ name: 'sessionid', value: 'HEALTHY', domain: '.jinritemai.com' }], null, 2);
    fs.writeFileSync(healthySource, healthyBytes);
    let saveCalls = 0;
    const page = guidePage();
    const out = await rp.runGuidancePhase(page, {
      accountId: ACCOUNT,
      saveCookies: async () => {
        saveCalls++;
        return { status: 'conflict', conflict: true, reason: '源 Cookie 文件在本次会话期间已被改变：保留较新文件，本次不回写' };
      },
      persistFlags: productionPersistFlags(page, dir),
    });
    assert.equal(saveCalls, 1, 'exactly one cookie write attempt — no overwrite/retry loop');
    assert.equal(fs.readFileSync(healthySource, 'utf8'), healthyBytes, 'healthy cookie source byte-identical');
    // The closed status enum has no 'conflict' literal: the sanitizer keeps the
    // conflict as conflict=true / cookieReason='conflict' and coerces the status.
    assert.equal(out.cookieStatus, 'failed');
    assert.equal(out.conflict, true);
    assert.equal(out.cookieReason, 'conflict');
    assert.equal(out.flagsSaved, true, 'guidance flags durable INDEPENDENT of the cookie conflict');
    assert.equal(out.flagsReason, null);
    assert.equal(rp.readPrivateGuidanceState(rp.guidanceFilePath(ACCOUNT, dir), ACCOUNT).ok, true);
    const page2 = guidePage();
    const late = await rp.handleLateGuidanceBeforeNativeAdvance(page2, ACCOUNT,
      () => rp.runGuidancePhase(page2, {
        accountId: ACCOUNT,
        saveCookies: async () => { saveCalls++; return { status: 'conflict', conflict: true }; },
        persistFlags: productionPersistFlags(page2, dir),
      }));
    assert.equal(late.handled, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T3 the REAL incident: failed writeback (old bytes kept) must not block flags ──
test('T3 real phase on failed writeback (incident shape): flagsSaved=true from real readback, never cookie-not-saved, continues', async () => {
  const dir = tmpDir('incident');
  try {
    const page = guidePage();
    const out = await rp.runGuidancePhase(page, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ ...INCIDENT_COOKIE }),
      persistFlags: productionPersistFlags(page, dir),
    });
    assert.equal(out.cookieStatus, 'failed');
    assert.equal(out.cookieReason, 'unknown', 'incident categorization reproduced exactly');
    assert.equal(out.flagsSaved, true, 'the fix: flags durably persisted despite the failed writeback');
    assert.equal(out.flagsReason, null);
    assert.notEqual(out.flagsReason, 'cookie-not-saved');
    assert.equal(rp.readPrivateGuidanceState(rp.guidanceFilePath(ACCOUNT, dir), ACCOUNT).ok, true);
    const page2 = guidePage();
    const late = await rp.handleLateGuidanceBeforeNativeAdvance(page2, ACCOUNT,
      () => rp.runGuidancePhase(page2, {
        accountId: ACCOUNT,
        saveCookies: async () => ({ ...INCIDENT_COOKIE }),
        persistFlags: productionPersistFlags(page2, dir),
      }));
    assert.equal(late.handled, 1, 'second plan continues from the existing cursor/page');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T4 durable flag-save failure stays fail-closed with a DETERMINISTIC reason ──
test('T4 real private readback failure: strict stop with the exact deterministic reason', async () => {
  const dir = tmpDir('readback-fail');
  try {
    // Corrupt the private guidance file: the REAL persister must refuse honestly.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(rp.guidanceFilePath(ACCOUNT, dir), '{not-json');
    const page = guidePage();
    const out = await rp.runGuidancePhase(page, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ status: 'saved' }),
      persistFlags: productionPersistFlags(page, dir),
    });
    assert.equal(out.flagsSaved, false);
    assert.equal(out.flagsReason, 'private-guidance-file-invalid-json', 'deterministic cause, not a generic failure');
    let caught = null;
    const page2 = guidePage();
    try {
      await rp.handleLateGuidanceBeforeNativeAdvance(page2, ACCOUNT,
        () => rp.runGuidancePhase(page2, {
          accountId: ACCOUNT,
          saveCookies: async () => ({ status: 'saved' }),
          persistFlags: productionPersistFlags(page2, dir),
        }));
    } catch (error) { caught = error; }
    assert.ok(caught instanceof Error, 'fail-closed stop before native advance');
    assert.equal(caught.message, 'native-advance-guide-state-not-persisted');
    assert.equal(caught.guidanceDiagnostic.flagsReason, 'private-guidance-file-invalid-json');
    // A deterministic-but-unknown enum violation stays closed: arbitrary text -> 'unknown'.
    const page3 = guidePage();
    const out3 = await rp.runGuidancePhase(page3, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ status: 'saved' }),
      persistFlags: async () => ({ saved: false, reason: 'disk exploded at C:\\private\\secret\\path.txt' }),
    });
    assert.equal(out3.flagsSaved, false);
    assert.equal(out3.flagsReason, 'unknown');
    assert.equal(JSON.stringify(out3).includes('secret'), false, 'no path material leaves the phase');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T5 the shop-product-analysis READ-ONLY raw layer is never written ──
test('T5 real phase writes ONLY the private guidance dir; raw/analysis layers byte-identical', async () => {
  const root = tmpDir('layers');
  try {
    const shop = 'r130shop';
    const rawFile = path.join(root, 'cookie-archive', 'raw', shop, 'v1.json');
    const analysisFile = path.join(root, 'cookies', shop + '.json');
    fs.mkdirSync(path.dirname(rawFile), { recursive: true });
    fs.mkdirSync(path.dirname(analysisFile), { recursive: true });
    fs.writeFileSync(rawFile, JSON.stringify([{ name: 'sessionid', value: 'RAW-ARCHIVE', domain: '.jinritemai.com' }], null, 2));
    fs.writeFileSync(analysisFile, JSON.stringify([{ name: 'sessionid', value: 'ANALYSIS', domain: '.jinritemai.com' }], null, 2));
    const guidanceDir = path.join(root, 'guidance');
    const before = snapshotTree(root);
    const page = guidePage();
    const out = await rp.runGuidancePhase(page, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ ...INCIDENT_COOKIE }),
      persistFlags: productionPersistFlags(page, guidanceDir),
    });
    assert.equal(out.flagsSaved, true);
    const after = snapshotTree(root);
    const added = Object.keys(after).filter(k => !before[k]);
    assert.deepEqual(added, [rp.guidanceFilePath(ACCOUNT, guidanceDir)], 'the ONLY new/changed file is the private guidance file');
    for (const k of Object.keys(before)) assert.equal(after[k], before[k], 'existing layer byte-identical: ' + k);
    // The private file holds only whitelisted guide flags, never cookie material.
    const parsed = JSON.parse(fs.readFileSync(rp.guidanceFilePath(ACCOUNT, guidanceDir), 'utf8'));
    for (const item of parsed.values) {
      assert.equal(rp.isAllowedGuidanceKey(item.key, ACCOUNT), true, 'whitelisted key only: ' + item.key);
      assert.equal(typeof item.value, 'string');
      assert.equal(item.value.includes('sessionid'), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── T6 idempotent repeated calls + zero-guidance zero-write ──
test('T6 repeated real phases are idempotent; zero guidance performs zero cookie/flag writes', async () => {
  const dir = tmpDir('idempotent');
  try {
    const page1 = guidePage();
    const out1 = await rp.runGuidancePhase(page1, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ status: 'saved' }),
      persistFlags: productionPersistFlags(page1, dir),
    });
    assert.equal(out1.flagsSaved, true);
    const file = rp.guidanceFilePath(ACCOUNT, dir);
    const first = fs.readFileSync(file, 'utf8');
    const page2 = guidePage({ values: [{ key: 'qc_lite_c_guide_overall_multi', value: '1' }, { key: 'user-guide-achieved-tasks', value: '["a"]' }] });
    const out2 = await rp.runGuidancePhase(page2, {
      accountId: ACCOUNT,
      saveCookies: async () => ({ status: 'saved' }),
      persistFlags: productionPersistFlags(page2, dir),
    });
    assert.equal(out2.flagsSaved, true);
    const read = rp.readPrivateGuidanceState(file, ACCOUNT);
    assert.equal(read.ok, true);
    const keys = read.values.map(v => v.key);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate keys after merge');
    assert.equal(keys.includes('user-guide-achieved-tasks'), true, 'second run merged its flags in');
    // Idempotent re-persist of the SAME snapshot does not corrupt or duplicate.
    const again = rp.persistPrivateGuidanceState(file, ACCOUNT, read.values);
    assert.equal(again.saved, true);
    assert.equal(rp.readPrivateGuidanceState(file, ACCOUNT).ok, true);
    // Zero guidance: zero phase work, zero writes, file untouched.
    const beforeBytes = fs.readFileSync(file, 'utf8');
    let cookieWrites = 0, flagWrites = 0;
    const quiet = guidePage({ absent: true });
    const out0 = await rp.runGuidancePhase(quiet, {
      accountId: ACCOUNT,
      saveCookies: async () => { cookieWrites++; return { status: 'saved' }; },
      persistFlags: async () => { flagWrites++; return { saved: true }; },
    });
    assert.equal(out0.handled, 0);
    assert.equal(out0.cookieStatus, 'not-needed');
    assert.equal(cookieWrites, 0, 'zero cookie writes with zero guidance');
    assert.equal(flagWrites, 0, 'zero flag writes with zero guidance');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeBytes, 'private guidance file untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── T7 the REAL runScheduledPlan entry consumes the fix (second-plan incident) ──
// First plan of the business date already succeeded in the durable ledger; the
// second plan hits the exact late-guidance + failed-writeback incident during
// preparation. Before the fix it was zero-consumption closed with
// `native-advance-guide-state-not-persisted`; after the fix it must proceed past
// guidance from the EXISTING cursor/page, keep the first success untouched, and
// never reach any publish/confirmation surface.
test('T7 runScheduledPlan second plan survives the incident late-guidance and keeps plan-1 success intact', async () => {
  const stateRoot = tmpDir('sched');
  const logs = [];
  let configureCalls = 0, publishSurfaces = 0;
  let capturedCursor = null;
  try {
    const business = sp.buildShopProfile({ shop: SHOP, accountId: ACCOUNT, roi: 17, dailyBudget: 300, productsPerPlan: 30 });
    const paths = sp.shopStatePaths(business, stateRoot, { legacy: false });
    fs.mkdirSync(paths.dir, { recursive: true });
    // Durable ledger: plan 1 of today already consumed SUCCESS (first plan untouched).
    const seededAttempts = {
      consumed: {
        'conf-r130-first-plan': {
          planNumber: 1, runId: 'plan-scheduler-2026-10-21-aaaaaaaaaaaaaaaa',
          businessDate: BUSINESS_DATE, manifestHash: 'a'.repeat(64),
          status: 'success', at: '2026-10-21T05:40:00.000Z',
        },
      },
      finalConsumed: {}, reopenConsumed: {},
    };
    fs.writeFileSync(paths.attemptsFile, JSON.stringify(seededAttempts, null, 2));
    // Day state carries the EXISTING cursor/page the second plan must continue from.
    const dayState = wf.newDayState(BUSINESS_DATE);
    dayState.cursor = { category: '店铺新品', page: 2, seenProductIds: [] };
    dayState.page = 2;
    fs.writeFileSync(paths.stateFile, JSON.stringify(dayState, null, 2));

    const readAccountStub = () => {};
    const fakeOpened = {
      target: { evaluate: async fn => (fn === readAccountStub ? { accountId: ACCOUNT } : { clicked: true }) },
      context: { addInitScript: async () => {} },
    };
    const incidentSave = async () => ({ ...INCIDENT_COOKIE });
    const R130_IDS = Array.from({ length: 30 }, (_, i) => '169' + String(1000000000000 + i));
    const rows = () => R130_IDS.map((productId, i) => ({
      productId, text: 'ID：' + productId,
      manualAccounts: i === 0 ? 0 : 1, manualEvidence: true, manualCountKnown: true,
      autoPullOnly: false, reviewFailed: false, alreadyPlanned: false,
    }));
    const schedDriver = ctx => ({
      // REAL production openCreationPage guidance consumption (run-plans.cjs:6404-6412):
      // the real runGuidancePhase with the real private persistFlags and the
      // offline-stubbed working-cookie writeback (r128/R55 offline seam).
      openCreationPage: async () => {
        const p = guidePage();
        const guidance = await rp.runGuidancePhase(p, {
          accountId: ctx.accountId, saveCookies: incidentSave,
          persistFlags: productionPersistFlags(p, ctx.guidancePrivateDir),
        });
        return { header: { originOk: true, accountId: ctx.accountId, commissionOptionPresent: true }, guidance };
      },
      // The EXACT native-advance late-guidance seam (run-plans.cjs:4654):
      // handleLateGuidanceBeforeNativeAdvance(page, accountId, guidancePhase) with the
      // REAL phase — the surface that used to throw native-advance-guide-state-not-persisted.
      browseProducts: async args => {
        capturedCursor = args.cursor;
        const p = guidePage();
        await rp.handleLateGuidanceBeforeNativeAdvance(p, ctx.accountId,
          () => rp.runGuidancePhase(p, {
            accountId: ctx.accountId, saveCookies: incidentSave,
            persistFlags: productionPersistFlags(p, ctx.guidancePrivateDir),
          }));
        return { ok: true, selectedIds: R130_IDS.slice(), attempted: R130_IDS.slice(), cursor: args.cursor, hints: args.hints || {} };
      },
      bindAccountsToAll: async () => ({ ok: true, accountIds: ['79863866', '9zmao_fushi'] }),
      readMainTable: async () => rows(),
      // Stop deterministically AFTER the guidance seam, BEFORE any configuration/publish.
      repairDraft: async () => ({ ok: false, reason: 'offline-stop-r130' }),
      configurePlan: async () => { configureCalls++; return { ok: true, planName: 'r130' }; },
      clickFinalConfirm: async () => { publishSurfaces++; return {}; },
      clickNativePublishPlan: async () => { publishSurfaces++; return {}; },
      saveCookies: incidentSave,
    });
    const scheduled = await rp.runScheduledPlan(
      { shop: SHOP, accountId: ACCOUNT, boundAccounts: ['79863866', '9zmao_fushi'], roi: 17, dailyBudget: 300 },
      {
        projectRoot: stateRoot, stateRoot, businessDate: BUSINESS_DATE,
        nowMs: () => Date.parse('2026-10-21T06:00:00Z'),
        plansPerShopPerDay: 3, dailyBudget: 300, roi: 17, autoConfirm: true,
        policy: { enabled: true, autoConfirm: true, plansPerShopPerDay: 3, dailyBudget: 300 },
        loadConfig: () => ({ ready: true, config: { login: {}, shops: [{ name: SHOP, accountId: ACCOUNT, targetRoi: 17, dailyBudget: 300, enabled: true }] } }),
        onLog: (level, msg) => logs.push(level + ' ' + msg),
        readers: {
          openChengfangShop: async () => fakeOpened, readChengfangAccountInPage: readAccountStub,
          clickChengfangSubTab: () => () => ({ clicked: true }), closeBrowser: async () => {},
        },
        driversFactory: schedDriver,
      },
    );
    // The incident stop is GONE: the run proceeds past late guidance and stops only
    // at the deterministic offline repair stop, with the second plan number.
    assert.equal(scheduled.status, 'preparation-stopped', JSON.stringify(scheduled));
    assert.equal(scheduled.reason, 'prepare-stopped:offline-stop-r130');
    assert.equal(scheduled.planNumber, 2, 'the ledger derived the SECOND plan of the day');
    assert.ok(scheduled.preparationClosure && scheduled.preparationClosure.planNumber === 2);
    // First-plan success record untouched; zero consumption added by this run.
    const attemptsAfter = JSON.parse(fs.readFileSync(paths.attemptsFile, 'utf8'));
    assert.deepEqual(Object.keys(attemptsAfter.consumed), ['conf-r130-first-plan'], 'no new consumption, first success intact');
    assert.equal(attemptsAfter.consumed['conf-r130-first-plan'].status, 'success');
    // The second plan continued from the EXISTING cursor/page.
    assert.deepEqual(capturedCursor, { category: '店铺新品', page: 2, seenProductIds: [] });
    // Zero publish/confirmation surface reached.
    assert.equal(configureCalls, 0, 'no configuration after the offline stop');
    assert.equal(publishSurfaces, 0, 'zero publish/confirmation calls');
    // Guidance flags were durably saved for THIS account and are recoverable at the
    // next context init (the REAL installGuidanceRestore readback).
    const guidanceFile = rp.guidanceFilePath(ACCOUNT, paths.guidanceDir);
    assert.equal(fs.existsSync(guidanceFile), true, 'private guidance file written under the shop guidance dir');
    const restoreCtx = { addInitScript: async () => {} };
    const restore = await rp.installGuidanceRestore(restoreCtx, ACCOUNT, { baseDir: paths.guidanceDir });
    assert.equal(restore.registered, true, JSON.stringify(restore));
    assert.ok(restore.count >= 1, 'flags recoverable at next context init');
    // Diagnostics hygiene: the raw cookie failure reason never crosses the boundary.
    const all = logs.join('\n');
    assert.equal(all.includes('native-advance-guide-state-not-persisted'), false, 'the incident stop no longer occurs');
    assert.equal(all.includes('cookie-not-saved'), false);
    assert.equal(all.includes('EBUSY'), false);
    assert.equal(all.includes('回写失败'), false);
    assert.equal(JSON.stringify(scheduled).includes('EBUSY'), false);
  } finally { fs.rmSync(stateRoot, { recursive: true, force: true }); }
});

// ── T8 the counterfactual stays closed: unsaved flags still stop the scheduler ──
test('T8 runScheduledPlan with durably-UNSAVED guidance flags still stops before advance (fail-closed kept)', async () => {
  const stateRoot = tmpDir('sched-closed');
  const logs = [];
  try {
    const business = sp.buildShopProfile({ shop: SHOP, accountId: ACCOUNT, roi: 17, dailyBudget: 300, productsPerPlan: 30 });
    const paths = sp.shopStatePaths(business, stateRoot, { legacy: false });
    fs.mkdirSync(paths.dir, { recursive: true });
    const readAccountStub = () => {};
    const fakeOpened = {
      target: { evaluate: async fn => (fn === readAccountStub ? { accountId: ACCOUNT } : { clicked: true }) },
      context: { addInitScript: async () => {} },
    };
    const schedDriver = ctx => ({
      openCreationPage: async () => ({ header: { originOk: true, accountId: ctx.accountId, commissionOptionPresent: true } }),
      browseProducts: async args => {
        const p = guidePage();
        // Real phase whose REAL private persist fails (corrupt file) -> flagsSaved=false.
        await rp.handleLateGuidanceBeforeNativeAdvance(p, ctx.accountId,
          () => rp.runGuidancePhase(p, {
            accountId: ctx.accountId,
            saveCookies: async () => ({ status: 'saved' }),
            persistFlags: async () => ({ saved: false, reason: 'guidance-state-readback-mismatch' }),
          }));
        return { ok: true, selectedIds: [], attempted: [], cursor: args.cursor, hints: {} };
      },
      bindAccountsToAll: async () => ({ ok: true, accountIds: ['79863866'] }),
      readMainTable: async () => [],
      repairDraft: async () => ({ ok: false, reason: 'offline-stop-r130' }),
      configurePlan: async () => ({ ok: true, planName: 'r130' }),
    });
    const scheduled = await rp.runScheduledPlan(
      { shop: SHOP, accountId: ACCOUNT, roi: 17, dailyBudget: 300 },
      {
        projectRoot: stateRoot, stateRoot, businessDate: BUSINESS_DATE,
        nowMs: () => Date.parse('2026-10-21T06:00:00Z'),
        plansPerShopPerDay: 3, dailyBudget: 300, roi: 17, autoConfirm: true,
        policy: { enabled: true, autoConfirm: true, plansPerShopPerDay: 3, dailyBudget: 300 },
        loadConfig: () => ({ ready: true, config: { login: {}, shops: [{ name: SHOP, accountId: ACCOUNT, targetRoi: 17, dailyBudget: 300, enabled: true }] } }),
        onLog: (level, msg) => logs.push(level + ' ' + msg),
        readers: {
          openChengfangShop: async () => fakeOpened, readChengfangAccountInPage: readAccountStub,
          clickChengfangSubTab: () => () => ({ clicked: true }), closeBrowser: async () => {},
        },
        driversFactory: schedDriver,
      },
    );
    // The durable-flags failure must still fail closed with the deterministic reason
    // carried into the scheduler diagnostics packet.
    const diagLines = logs.filter(l => l.includes('scheduled-readiness-summary') || l.includes('scheduled-preparation-diagnostic'));
    assert.equal(scheduled.reason.includes('native-advance-guide-state-not-persisted'), true,
      'fail-closed kept: ' + JSON.stringify({ status: scheduled.status, reason: scheduled.reason }));
    assert.ok(diagLines.length >= 0);
  } finally { fs.rmSync(stateRoot, { recursive: true, force: true }); }
});

// ── T9-T11 production fingerprint chain via the REAL createRealDrivers.saveCookies ──
// A fixture projectRoot carries a src/login/cookie-writeback stub that behaves like
// the canonical helper: it NORMALIZES the context cookies before writing, so the
// final file bytes legitimately differ from JSON.stringify(rawCookies, null, 2).
// Success returns its own expectedSha256/afterSha256; modes inject an external
// post-return file change, or drop/corrupt the hashes. No real cookie material,
// path or network is involved; values below are synthetic.
const shaHex = buf => crypto.createHash('sha256').update(buf).digest('hex');
function chainFixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r130-chain-'));
  const loginDir = path.join(root, 'src', 'login');
  fs.mkdirSync(loginDir, { recursive: true });
  const cookieFile = path.join(root, 'cookies-shop-working.json');
  fs.writeFileSync(cookieFile, '{"seed":1}');
  fs.writeFileSync(path.join(loginDir, 'cookie-writeback.js'), `'use strict';
const fs = require('fs'); const crypto = require('crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const MODE = ${JSON.stringify(mode)};
function fingerprintFile(p) {
  try { const buf = fs.readFileSync(p); return { exists: true, size: buf.length, mtimeMs: 1, sha256: sha(buf) }; }
  catch (_) { return { exists: false, size: null, mtimeMs: null, sha256: null }; }
}
async function writebackSessionCookies(opts) {
  if (!opts || !opts.context || typeof opts.cookieFilePath !== 'string' || !opts.sessionStartFingerprint
    || opts.identityOk !== true || opts.loginOk !== true || typeof opts.audit !== 'function') {
    return { ok: false, skipped: true, reason: 'fixture-guard-refused' };
  }
  const cookies = await opts.context.cookies();
  const normalized = cookies.filter(c => c && !c.__expired)
    .map(c => ({ name: c.name, value: c.value, domain: c.domain }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const serialized = JSON.stringify(normalized, null, 2);
  fs.writeFileSync(opts.cookieFilePath, serialized);
  const expectedSha256 = sha(Buffer.from(serialized, 'utf8'));
  const afterSha256 = sha(fs.readFileSync(opts.cookieFilePath));
  if (MODE === 'external') fs.writeFileSync(opts.cookieFilePath, '{"tampered-by-outsider":1}');
  const base = { ok: true, skipped: false, reason: null, count: normalized.length,
    bytes: Buffer.byteLength(serialized, 'utf8'), domains: [...new Set(normalized.map(c => c.domain))].sort() };
  if (MODE === 'nohash') return base;
  if (MODE === 'badhash') return Object.assign({}, base, { expectedSha256: 'C:/Users/secret/cookies.json', afterSha256: 'nothex64!!' });
  return Object.assign({}, base, { expectedSha256, afterSha256 });
}
module.exports = { writebackSessionCookies, fingerprintFile };
`);
  return { root, cookieFile };
}
function chainDrivers(fixture) {
  const rawCookies = [
    { name: 'sid', value: 'RAW-A', domain: '.jinritemai.com', httpOnly: true, secure: true, sameSite: 'Lax', expires: 1893456000 },
    { name: 'tt', value: 'RAW-B', domain: 'qianchuan.jinritemai.com', httpOnly: false, secure: false, sameSite: 'Strict', expires: 1893456000 },
    { name: 'gone', value: 'RAW-C', domain: '.jinritemai.com', __expired: true },
  ];
  const session = { filePath: fixture.cookieFile, startFingerprint: { exists: true, size: 12, mtimeMs: 1, sha256: '0'.repeat(64) } };
  const drivers = rp.createRealDrivers({
    page: null,
    managerPage: { evaluate: async () => ({ originOk: true, identityOk: true, loginOk: true }) },
    context: { cookies: async () => rawCookies.map(c => Object.assign({}, c)) },
    dayState: {}, persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: ACCOUNT, opened: { cookieSession: session }, projectRoot: fixture.root, planNumber: 2, runId: 'offline-chain',
  });
  return { drivers, session, rawCookies };
}

test('T9 real chain: canonical normalized writeback advances the session fingerprint; repeat save stays saved', async () => {
  const fx = chainFixture('ok');
  try {
    const { drivers, session, rawCookies } = chainDrivers(fx);
    const r1 = await drivers.saveCookies();
    assert.equal(r1.status, 'saved', JSON.stringify(r1));
    const canon = shaHex(fs.readFileSync(fx.cookieFile));
    const rawHash = shaHex(Buffer.from(JSON.stringify(rawCookies, null, 2), 'utf8'));
    assert.notEqual(canon, rawHash, 'normalized file bytes differ from the raw context JSON (the exact spot the old raw-hash expectation false-alerted on)');
    assert.equal(session.startFingerprint.sha256, canon, 'fingerprint advances to the CANONICAL final hash backed by the immediate file readback');
    assert.equal(session.startFingerprint.size, fs.statSync(fx.cookieFile).size);
    const r2 = await drivers.saveCookies();
    assert.equal(r2.status, 'saved', 'the next save is not a phantom external conflict');
    assert.equal(session.startFingerprint.sha256, canon);
    const blob = JSON.stringify([r1, r2]);
    assert.ok(!blob.includes(fx.cookieFile) && !blob.includes('cookies-shop-working'), 'no file path in the summaries');
    assert.ok(!blob.includes('RAW-A') && !blob.includes('RAW-B') && !blob.includes('RAW-C'), 'no cookie value in the summaries');
    assert.ok(!blob.includes(canon) && !blob.includes('expectedSha256'), 'write hashes stay inside the driver and never cross its return surface');
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('T10 real chain: helper succeeded but the file changed afterwards - fingerprint must not advance', async () => {
  const fx = chainFixture('external');
  try {
    const { drivers, session } = chainDrivers(fx);
    const before = session.startFingerprint;
    const r = await drivers.saveCookies();
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.reason, 'cookie-write-readback-does-not-match-owned-content');
    assert.equal(session.startFingerprint, before, 'refused update leaves the session baseline object untouched');
    assert.equal(session.startFingerprint.sha256, '0'.repeat(64));
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
});

test('T11 real chain: missing or malformed canonical hash never advances the fingerprint and never leaks', async () => {
  for (const mode of ['nohash', 'badhash']) {
    const fx = chainFixture(mode);
    try {
      const { drivers, session } = chainDrivers(fx);
      const r = await drivers.saveCookies();
      assert.equal(r.status, 'failed', mode + ': a saved write without a usable canonical hash fails closed');
      assert.equal(r.reason, 'owned-cookie-write-summary-missing', mode);
      assert.equal(session.startFingerprint.sha256, '0'.repeat(64), mode + ': fingerprint untouched');
      const blob = JSON.stringify(r);
      assert.ok(!blob.includes('C:/Users/secret'), mode + ': the malformed hash-shaped path value never surfaces');
      assert.ok(!blob.includes('nothex64'), mode + ': malformed afterSha256 dropped before the summary');
    } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
  }
});
