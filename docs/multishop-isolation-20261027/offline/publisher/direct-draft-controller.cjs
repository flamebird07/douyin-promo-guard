'use strict';
// Isolated one-shot controller. Adapter/config requires are deferred into main()
// so that requiring this module for offline tests never reads config, auth or
// opens a browser. Project root comes ONLY from PROMO_PROJECT_ROOT.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REQUIRED_ROOT_FILES = ['src/config.js', 'src/adapters/chengfang-reader.js'];
const ACTION_OPS = ['click', 'fill', 'scroll'];
const POPUP_OPS = ['popup-dismiss'];
const SAVE_OPS = ['save-cookies'];
const OPAGE_OPS = ['page', 'show', 'inspect'];
const PUBLISH_OPS = ['publish-plan'];
const FILL_VALUES = ['15', '300']; // ROI15 / daily budget 300 only
// Explicit platform-refusal evidence (R42). A same-day retry may ONLY be opened
// by a trusted host-injected proof of an explicit platform refusal; a timeout /
// no-row / possible-review-failure is never such a proof.
const PUBLICATION_FAILURE_MARK = '发布失败';
const DELISTED_MARK = '商品已下架';
// R50 exact creation-route whitelist: the platform canonically serves the SAME verified
// account's creation page at EITHER /uni-creation/overall-product-multi OR
// /create-ad/overall-product (Root read-only snapshot reference-live-route.json). Exact
// paths with an optional trailing slash only — any other /create-ad/* or /uni-creation/*
// prefix/suffix/lookalike stays refused.
const CREATION_PATH_RE = /^\/(uni-creation\/overall-product-multi|create-ad\/overall-product)\/?$/;
const QIANCHUAN_ORIGIN = 'https://qianchuan.jinritemai.com';

function resolveProjectRoot(env) {
  const raw = env && env.PROMO_PROJECT_ROOT ? String(env.PROMO_PROJECT_ROOT) : '';
  if (!raw) throw new Error('PROMO_PROJECT_ROOT is required (explicit project root for isolated run)');
  const abs = path.resolve(raw);
  for (const rel of REQUIRED_ROOT_FILES) {
    if (!fs.existsSync(path.join(abs, rel))) throw new Error(`PROMO_PROJECT_ROOT missing required file: ${rel}`);
  }
  return abs;
}

// Safety text check: element text plus aria-label/title so an icon-only parent
// button carrying publication semantics is not missed; the check applies to the
// element itself, never to a huge parent container's text.
function guardText(txt, ariaLabel, title) {
  return [txt, ariaLabel, title].filter(Boolean).join(' ').trim();
}
function isBlockedText(guard) {
  if (/发布|立即投放|创建计划|提交计划|保存并投放|保存并发布|扣款授权协议|货款直投升级版服务协议/.test(guard)) return 'Publication/access agreement blocked';
  if (/暂停|开启计划|关闭投放/.test(guard)) return 'Existing ad changes blocked';
  return null;
}
function removalRequiresProductId(guard, rowText, draftProductId, bodyHasProductModal) {
  if (!/删除|移除/.test(guard)) return false;
  return !draftProductId || !rowText || !String(rowText).includes(String(draftProductId)) || !bodyHasProductModal;
}

// Host-side gate for op=page. The observation object is produced by the real
// in-page pageObserve callback (single source of truth); this only reasons over
// the pagination metadata it reports. Accepts {page:N} or {kind:'next'|'prev'}.
function resolvePageTarget(observationState, cmd) {
  if (!observationState || !observationState.pagination) throw new Error('No pagination observed in latest state');
  const p = observationState.pagination;
  if (cmd.observation !== observationState.observation) throw new Error('Observation expired');
  if (!p.modalPresent) throw new Error('Product-selection modal not observed');
  if (!p.inProductModal) throw new Error('Pagination not inside a unique product-selection modal');
  if (!Number.isInteger(p.currentPage)) throw new Error('Current page unknown; pagination refused');
  // The real pager shows 1 2 3 4 5 ... 60 with NO "共60页" label, so the total is
  // unknown (pageCount null). Unknown total permits ONLY clicking an actually
  // observed, enabled number leaf or an enabled one-step next/prev; never a jump,
  // never an unobserved target, never a guessed last page. A known total still
  // bounds page targets.
  if (!(p.pageCount === null || p.pageCount === undefined || (Number.isInteger(p.pageCount) && p.pageCount >= 1))) {
    throw new Error('Invalid observed total page count; pagination refused');
  }
  const totalKnown = Number.isInteger(p.pageCount);
  const strictPosInt = v => typeof v === 'number' && Number.isInteger(v) && v >= 1;
  if (cmd.kind === 'next' || cmd.kind === 'prev') {
    if (cmd.kind === 'prev' && p.currentPage <= 1) throw new Error('Already at prev boundary');
    if (cmd.kind === 'next' && totalKnown && p.currentPage >= p.pageCount) throw new Error('Already at next boundary');
    const item = p.items.find(i => i.kind === cmd.kind);
    if (!item) throw new Error(`No observed ${cmd.kind} control`);
    if (item.disabled) throw new Error(`${cmd.kind} control disabled`);
    return { mode: 'click', index: item.index, expectKind: cmd.kind };
  }
  if (cmd.page === undefined || cmd.page === null || !strictPosInt(cmd.page)) {
    throw new Error('Page target must be a strict positive integer');
  }
  const target = cmd.page;
  if (totalKnown && target > p.pageCount) throw new Error('Page target out of observed page count');
  if (target === p.currentPage) throw new Error('Already on target page');
  const num = p.items.find(i => i.kind === 'number' && i.page === target && !i.disabled);
  if (num) return { mode: 'click', index: num.index, expectKind: 'number', expectPage: target };
  if (!totalKnown) throw new Error('Total page count unknown; only observed page controls may be used (no jump)');
  const jump = p.items.find(i => i.kind === 'jump-input' && !i.disabled);
  if (jump) return { mode: 'jump', index: jump.index, page: target, expectKind: 'jump-input', expectPage: target };
  throw new Error('No usable observed control for target page');
}

// Best-effort visibility request. Reports that the request was made; never
// claims the window is actually visible. --start-maximized is NOT forwarded:
// the current adapter exposes no launch-args entry point, so we do not pretend
// it took effect. --disable-web-security is intentionally never copied.
async function requestShow(page) {
  const result = { requested: true, userVisible: 'unverified', steps: [] };
  try {
    if (typeof page.bringToFront !== 'function') throw new Error('Page.bringToFront not supported');
    await page.bringToFront();
    result.steps.push({ step: 'bringToFront', ok: true });
  } catch (e) {
    result.steps.push({ step: 'bringToFront', ok: false, error: e.message });
  }
  try {
    // The callback reports only what it invoked; it never asserts that the
    // window actually moved or that the user can see it.
    const detail = await page.evaluate(() => {
      const called = [];
      if (!window.screen) return { called, reason: 'window.screen unavailable' };
      window.moveTo(0, 0); called.push('moveTo');
      window.resizeTo(window.screen.availWidth, window.screen.availHeight); called.push('resizeTo');
      return { called };
    });
    result.steps.push({ step: 'windowMoveResize', ok: true, detail, actualMovement: 'unverified' });
  } catch (e) {
    result.steps.push({ step: 'windowMoveResize', ok: false, error: e.message });
  }
  return result;
}

// In-page observer. Self-contained (serialized by Playwright): no outer refs.
// It locates the UNIQUE visible product-selection modal root and derives all
// pagination evidence strictly from that root. Anything ambiguous, missing, or
// hidden makes the reported pagination fail closed.
function pageObserve() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const clsOf = e => String(e.className || '');
  const hasCls = (e, re) => re.test(clsOf(e).toLowerCase());
  const dialogSel = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const titleRe = /选择要投放的商品|添加商品/;
  const productSignals = ['全部', '店铺新品', '破圈尖货', '流量扶持', '搜索趋势'];

  // Classify an editable field by walking UP from the input to the NEAREST
  // ancestor container that (a) owns exactly this one visible editable input and
  // (b) whose own text (plus the input's own non-generic hint) carries a unique
  // ROI or budget label. Never ordered by DOM position or coordinates; a big
  // container (multiple inputs), a mixed ROI+budget container, or a search /
  // page / cost / bid context is refused. Bounded to a few levels so it cannot
  // swallow the whole page.
  function classifyFillField(input) {
    const ownHint = [input.getAttribute('placeholder') || '', input.getAttribute('aria-label') || '', input.getAttribute('title') || ''].join(' ');
    // The real ROI label sits far above the input ("综合营销ROI目标(含达人佣金)",
    // with help text mentioning 出价分析/综合成本), so the walk is bounded at 12
    // levels and an explicit ROI-target / 日预算 field name outranks help text:
    // 成本/出价 in the explanatory copy never negates a legitimate explicit ROI
    // target label (and never authorizes a bare cost/bid field either).
    const MAXL = 12;
    let anc = input.parentElement, level = 0;
    const ancestors = [];
    while (anc && level < MAXL) {
      const edits = Array.from(anc.querySelectorAll('input,textarea')).filter(visible);
      const flat = (text(anc) + ' ' + ownHint).replace(/\s+/g, ' ').trim();
      ancestors.push({ level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), text: flat.slice(0, 80), editableCount: edits.length });
      if (edits.length === 1 && edits[0] === input) {
        const t = flat;
        const hasRoi = /roi|投产/i.test(t);
        const hasBudget = /预算/.test(t);
        const hasCostBid = /成本|出价/.test(t);
        const hasSearchPage = /搜索|关键词|商品名|商品标题|分页|页码|jump|goto|\bpage\b/i.test(t);
        const explicitRoi = /(?:目标|营销)(?:roi|投产)|(?:roi|投产)目标/i.test(t.replace(/\s+/g, ''));
        if (hasSearchPage) return { ok: false, field: null, reason: 'excluded-context', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasRoi && hasBudget) return { ok: false, field: null, reason: 'mixed-roi-budget', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (explicitRoi) return { ok: true, field: 'roi', reason: 'roi-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasCostBid) return { ok: false, field: null, reason: 'excluded-context', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasRoi) return { ok: true, field: 'roi', reason: 'roi-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasBudget) return { ok: true, field: 'budget', reason: 'budget-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
      }
      anc = anc.parentElement; level++;
    }
    return { ok: false, field: null, reason: 'no-unique-labeled-field', level, tag: null, cls: '', labelSample: '', ancestors };
  }

  // ---- unique product-selection modal root ----
  const dialogCands = [...document.querySelectorAll(dialogSel)].filter(visible);
  const headTextOf = el => {
    const aria = el.getAttribute('aria-label') || '';
    const head = [...el.querySelectorAll('h1,h2,h3,[class*="title"],[class*="Title"],[class*="header"],[class*="Header"],[role="heading"]')]
      .map(text).join(' ');
    return (aria + ' ' + head).trim();
  };
  // The REAL product drawer has no "添加商品" title: its header is the unique tab
  // strip (全部/店铺新品/破圈尖货+流量扶持badge/搜索趋势 on product-drawer-header-tab-item /
  // ovui-tabs__tab) and its footer shows 已选 n/30 plus 下一步. A root matches when
  // it carries the legacy title (with product signals) OR this full untitled
  // signature; the douyin-binding drawer ("为商品添加抖音号", product-name tabs
  // only) never matches. Nested candidates collapse to the MINIMAL root owning
  // header/list/footer; two disjoint minimal roots stay ambiguous.
  function isProductDrawerRoot(el) {
    const head = headTextOf(el);
    const inner = text(el);
    if (/为商品添加抖音号/.test(head + ' ' + inner)) return false;
    if (titleRe.test(head)) return productSignals.some(s => inner.includes(s)) ||
      /ID\s*[:：]\s*\d{15,20}/.test(inner); // real product-list row id (ID: + 15-20 digits)
    const tabTexts = [...el.querySelectorAll('[class*="product-drawer-header-tab-item"],[class*="ovui-tabs__tab"]')].filter(visible).map(text);
    // Real field: tabs are 全部/店铺新品/破圈尖货(badge 流量扶持)/搜索趋势. The
    // observed badge is the ONLY extra token normalized away; tabs otherwise match
    // exactly (搜索趋势 keeps legacy 搜索趋势推荐 compatibility). No substring
    // matching against product names.
    const normTab = t => t.replace(/\s+/g, '').replace(/流量扶持/g, '');
    const hasTab = (name, o = {}) => tabTexts.some(t => {
      if (o.badge && !/流量扶持/.test(t)) return false;
      const nt = normTab(t);
      return nt === name || (o.legacy || []).includes(nt);
    });
    const tabsOk = hasTab('全部') && hasTab('店铺新品') &&
      hasTab('破圈尖货', { badge: true }) && hasTab('搜索趋势', { legacy: ['搜索趋势推荐'] });
    // Footer denominator is the REMAINING selection capacity, not always 30: a
    // re-opened drawer for the 2nd/3rd plan (or a top-up) shows 已选 n/1, n/2,
    // n/12 … Accept any 1..30 remaining capacity (30 still matches).
    const footerMatch = inner.match(/已选\s*\d+\s*\/\s*(\d{1,2})/);
    const footerOk = !!footerMatch && Number(footerMatch[1]) >= 1 && Number(footerMatch[1]) <= 30 &&
      [...el.querySelectorAll('button,[role="button"]')].filter(visible).some(b => text(b) === '下一步');
    return tabsOk && footerOk;
  }
  const matched = dialogCands.filter(isProductDrawerRoot);
  const roots = matched.filter(el => !matched.some(o => o !== el && el.contains(o)));
  const modalPresent = roots.length >= 1;
  const modalUnique = roots.length === 1;
  const modalRoot = modalUnique ? roots[0] : null;

  // ---- single pagination region inside the modal root ----
  let region = null, pagAmbiguous = false;
  if (modalRoot) {
    let containers = [...modalRoot.querySelectorAll('[class*="pagination"],[class*="Pagination"],[class*="page-item"],[class*="pager"],[class*="Pager"],[class*="pages"]')].filter(visible);
    containers = containers.filter(c => !containers.some(o => o !== c && typeof o.contains === 'function' && o.contains(c)));
    pagAmbiguous = containers.length > 1;
    region = containers.length === 1 ? containers[0] : null;
  }
  const inProductModal = !!region;

  // ---- leaves + total/current page from the region only ----
  const leaves = [];
  if (region) {
    const seen = new Set();
    for (const e of region.querySelectorAll('button,a,li,input,span,[role="button"]')) {
      if (!visible(e) || seen.has(e)) continue;
      const isLeaf = e.tagName === 'INPUT' || ![...e.children].some(ch => visible(ch) && text(ch) === text(e) && text(e) !== '');
      if (!isLeaf) continue;
      seen.add(e);
      // inherit active/current and disabled semantics from ancestors up to region
      let active = false, disabled = !!(e.disabled || e.getAttribute('aria-disabled') === 'true'), ariaCurrent = null;
      let cur = e;
      while (cur && cur !== region) {
        if (cur.getAttribute && cur.getAttribute('aria-current') === 'page') active = true;
        if (hasCls(cur, /(^|[-_ ])(active|current)([-_ ]|$)/)) active = true;
        if (cur.disabled || (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true')) disabled = true;
        cur = cur.parentElement;
      }
      ariaCurrent = e.getAttribute('aria-current');
      const t = text(e);
      const clsS = clsOf(e).toLowerCase();
      const ariaLabel = e.getAttribute('aria-label') || '';
      const hint = [e.getAttribute('placeholder') || '', ariaLabel, clsS].join(' ');
      let kind = 'other', page = null;
      if (e.tagName === 'INPUT') { if (/页|jump|goto|page/i.test(hint)) kind = 'jump-input'; }
      else if (/下一页/i.test(t) || /(^|[-_ ])(next|arrow-right)([-_ ]|$)/.test(clsS)) kind = 'next';
      else if (/上一页/i.test(t) || /(^|[-_ ])(prev|previous|arrow-left)([-_ ]|$)/.test(clsS)) kind = 'prev';
      else if (/^\d{1,4}$/.test(t) || /^\d{1,4}$/.test(ariaLabel)) { kind = 'number'; page = Number(/^\d{1,4}$/.test(t) ? t : ariaLabel); }
      if (kind === 'other') continue;
      leaves.push({ el: e, kind, page, active, disabled, ariaLabel, cls: clsS });
    }
  }

  const regionText = region ? text(region) : '';
  const ariaBlob = leaves.map(l => l.ariaLabel).join(' ');

  // Total page count is accepted ONLY from an explicit total label ("共 N 页" /
  // "of N") or an explicit last-page marker. The visible maximum of a
  // contiguous run of numbered buttons is NOT trusted as the total: a sliding
  // window of pages 1..max says nothing about whether more pages exist, so an
  // unlabeled contiguous pager is refused (pageCount stays null).
  let pageCount = null, pageCountSource = null;
  const totalMatch = (regionText + ' ' + ariaBlob).match(/共\s*(\d+)\s*页/) || (regionText + ' ' + ariaBlob).match(/\bof\s+(\d+)\b/i);
  if (totalMatch) { pageCount = Number(totalMatch[1]); pageCountSource = 'total-label'; }
  if (!pageCount) {
    const lastLeaf = leaves.find(l => l.kind === 'number' && hasCls(l.el, /(^|[-_ ])(last|末页)([-_ ]|$)/));
    if (lastLeaf) { pageCount = lastLeaf.page; pageCountSource = 'last-page'; }
  }
  const currentLeaf = leaves.find(l => l.kind === 'number' && l.active);
  const currentPage = currentLeaf ? currentLeaf.page : null;

  // register observed element list + observation id (whole page) for actions
  const named = new Set(['全部', '店铺新品', '破圈尖货', '流量扶持', '搜索趋势', '下一步', '我知道了', '确认', '将所选抖音号批量添加至所有商品', '全选', '添加抖音号', '移除']);
  const baseEls = [...document.querySelectorAll('button,a,input,select,textarea,label,[role="button"],[role="checkbox"],[role="tab"],[class*="checkbox"],[class*="tab"]')].filter(visible);
  const namedLeaf = [...document.querySelectorAll('body *')].filter(e => visible(e) && named.has(text(e)) && ![...e.children].some(ch => visible(ch) && text(ch) === text(e)));
  const regionLeaves = leaves.map(l => l.el);
  const list = [...new Set([...baseEls, ...namedLeaf, ...regionLeaves])];
  window.__directDraftElements = list;
  window.__directDraftObservation = String(Date.now());

  // pagination evidence: items carry the GLOBAL element-list index that
  // pageApply later resolves, and the observed set/kind let pageApply
  // re-verify membership and purpose in-page before any dispatch.
  const pagSet = new Set(regionLeaves);
  const pagKind = new Map();
  const pagPage = new Map();
  const items = [];
  leaves.forEach(l => {
    const gi = list.indexOf(l.el);
    if (gi < 0) return;
    pagKind.set(gi, l.kind);
    pagPage.set(gi, l.page === null || l.page === undefined ? null : l.page);
    items.push({ index: gi, kind: l.kind, page: l.page === null || l.page === undefined ? null : l.page, disabled: !!l.disabled, cls: l.cls });
  });
  window.__directDraftPagSet = pagSet;
  window.__directDraftPagKind = pagKind;
  window.__directDraftPagPage = pagPage;
  window.__directDraftModalRoot = region ? modalRoot : null;
  window.__directDraftRegion = region || null;
  window.__directDraftPageSig = { currentPage, pageCount };

  const elements = list.map((e, index) => {
    const r = e.getBoundingClientRect();
    const row = e.closest('tr,[role="row"],.ovui-table__row');
    const field = e.closest('[class*="form-item"],[class*="formItem"],[class*="form_item"]');
    const editable = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA';
    const ff = editable ? classifyFillField(e) : null;
    return { index, el: e, info: {
      index, tag: e.tagName, role: e.getAttribute('role'), text: text(e).slice(0, 180),
      placeholder: e.getAttribute('placeholder'), type: e.getAttribute('type'),
      value: e.value, checked: e.checked,
      disabled: !!(e.disabled || e.getAttribute('aria-disabled') === 'true'),
      cls: clsOf(e).slice(0, 150),
      ariaLabel: e.getAttribute('aria-label'), ariaCurrent: e.getAttribute('aria-current'),
      rowText: row ? text(row).slice(0, 550) : null, fieldText: field ? text(field).slice(0, 350) : null,
      fillField: ff ? { recognized: !!ff.ok, kind: ff.field, reason: ff.reason, source: 'nearby-field', level: ff.level, ancestorTag: ff.tag, ancestorCls: ff.cls, labelSample: ff.labelSample, ancestors: (ff.ancestors || []).slice(0, 12) } : null,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    } };
  });

  // Read-only pagination region metadata to help a human confirm the real total
  // count and capacity from the observation. Never changes the rule that
  // pageCount requires an explicit total label / last-page marker; carries no
  // credential values or full HTML -- only the region's visible text and its
  // inputs' value/aria/class.
  const regionInputs = region
    ? [...region.querySelectorAll('input')].filter(visible).map(inp => ({
        value: inp.value === undefined ? null : String(inp.value),
        placeholder: inp.getAttribute('placeholder'),
        ariaLabel: inp.getAttribute('aria-label'),
        cls: clsOf(inp).slice(0, 100),
      }))
    : [];

  const pagination = {
    modalPresent, modalUnique, pagAmbiguous: !!pagAmbiguous, inProductModal,
    currentPage, pageCount, pageCountSource,
    regionText: regionText.slice(0, 300),
    regionInputs,
    items,
  };

  // ---- creation-page publish summary (strictly from the live DOM) ----
  // Every field is derived from what the page actually renders; anything
  // missing or ambiguous is reported as unknown / flagged, never defaulted and
  // never taken from host state or the authorization object. The host-side
  // publish gate and the in-page publishApply executor re-derive this evidence
  // independently before any click. Account identity comes ONLY from the
  // verified navigator header container (the same element the project's
  // chengfang identity reader uses); a short id anywhere else in the body can
  // never pose as the account. Product rows come ONLY from the unique visible
  // creation main table whose real header carries 商品信息/投放抖音号/素材/操作,
  // so dialogs and unrelated tables can never make up the 30; a row's manual
  // douyin count is bound to its 管理手动添加抖音号 cell, never to auto-pull or
  // unrelated counts. Anything missing or ambiguous stays unknown / zero.
  const creation = (() => {
    const idRe = /ID\s*[:：]\s*\d{15,20}/g;
    const stripId = s => s.replace(/ID\s*[:：]\s*/, '');
    const originOk = location.origin === 'https://qianchuan.jinritemai.com';
    const pathOk = /^\/(uni-creation\/overall-product-multi|create-ad\/overall-product)\/?$/.test(location.pathname);
    // Account identity comes ONLY from a uniquely proven navigator header ID.
    // Prefer the exact account container (.qc-page-navigator-container, the
    // project chengfang identity reader root); only when NO exact root exists
    // at all do we fall back to [class*="navigator"]. Navigator elements that
    // carry no account ID are ignored (sub-navigation like 首页/数据). Nested
    // containers and repeated text that show the SAME id collapse to one value;
    // any conflicting distinct id in the authoritative header scope stays
    // unknown. Never backfill from body text, an adapter cache, or the
    // authorization object. Bounded read-only candidate evidence (tag/class/id,
    // selection source) is emitted for real-DOM readback -- never a Cookie.
    const navExact = [...new Set([...document.querySelectorAll('.qc-page-navigator-container')])].filter(visible).filter(el => !el.closest(dialogSel));
    const navCands = navExact.length ? navExact : [...new Set([...document.querySelectorAll('[class*="navigator"]')])].filter(visible).filter(el => !el.closest(dialogSel));
    const accountNavSource = navExact.length ? 'exact' : (navCands.length ? 'fallback' : 'none');
    const accountIdSet = new Set();
    const accountEvidence = [];
    for (const el of navCands) {
      const ids = (text(el).match(/ID\s*[:：]\s*\d{8,20}/g) || []).map(stripId);
      if (ids.length === 0) continue;
      for (const id of ids) accountIdSet.add(id);
      if (accountEvidence.length < 6) accountEvidence.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 120), id: String(el.id || '').slice(0, 60), source: accountNavSource });
    }
    const accountId = accountIdSet.size === 1 ? [...accountIdSet][0] : 'unknown';
    const tableSel = 'table,[role="table"],[role="grid"],[class*="table"],[class*="Table"]';
    const requiredHeaders = ['商品信息', '投放抖音号', '素材', '操作'];
    const carriesHeader = el => requiredHeaders.every(h => text(el).includes(h));
    const mainCandidates = [...document.querySelectorAll(tableSel)].filter(visible)
      .filter(el => !el.closest(dialogSel)).filter(carriesHeader);
    const rowIds = el => [...el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible)
      .filter(row => /ID\s*[:：]\s*\d{15,20}/.test(text(row)));
    // The Aurora table can contain a nested header-only table. Prefer the
    // uniquely evidenced candidate with the most real product rows; never let
    // a deepest empty header node shadow the populated creation table.
    const scored = mainCandidates.map(el => ({ el, count: rowIds(el).length }));
    const maxRows = Math.max(0, ...scored.map(x => x.count));
    const maxCandidates = scored.filter(x => x.count === maxRows);
    const mainRoots = maxRows > 0
      ? maxCandidates.filter(x => !maxCandidates.some(y => y !== x && x.el.contains(y.el))).map(x => x.el)
      : mainCandidates.filter(el => !mainCandidates.some(other => other !== el && el.contains(other)));
    // bounded read-only main-root evidence (tag/class + visible row count) so a
    // real 30-product readback can confirm which DOM root was chosen; rule is
    // unchanged, no new layout framework is added here
    const mainRootEvidence = mainRoots.slice(0, 4).map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 120), rowCount: [...el.querySelectorAll('tr,[role="row"]')].filter(visible).length }));
    const productRows = [];
    // Native single-manual layout (the real Minmin 30 rows): NO "N个抖音号" counter. Positive
    // proof = exactly one VISIBLE manual .aweme-entry outside the auto-pull subtree carrying
    // the 管理(手动添加)抖音号 control AND a visible .item-info-wrapper with a non-empty name +
    // a non-empty explicit ID. A lone manage button, a lone name/ID, hidden/duplicate entries,
    // an empty name/ID or an unknown layout never count as 1; an explicit counter outranks it.
    const singleManualAwemeRow = row => {
      const wraps = [...row.querySelectorAll('.aweme-wrapper')].filter(visible);
      if (wraps.length !== 1) return false;
      const auto = [...wraps[0].querySelectorAll('.auto-pull-aweme-wrapper')];
      const entries = [...wraps[0].querySelectorAll('.aweme-entry')].filter(e => !auto.some(a => a.contains(e)));
      if (entries.length !== 1 || !visible(entries[0])) return false;
      if (!/管理(?:手动添加)?抖音号/.test(text(entries[0]))) return false;
      const infos = [...entries[0].querySelectorAll('.item-info-wrapper')].filter(visible);
      if (infos.length !== 1) return false;
      const m = text(infos[0]).match(/^(\S.*?)\s*ID\s*[:：]\s*(\S.*?)$/);
      return !!m && m[1].trim() !== '' && m[2].trim() !== '';
    };
    if (mainRoots.length === 1) {
      for (const row of [...mainRoots[0].querySelectorAll('tr,[role="row"]')].filter(visible)) {
        if (row.closest(dialogSel)) continue;
        const rt = text(row);
        const ids = (rt.match(idRe) || []).map(stripId);
        if (ids.length === 1) {
          const mm = rt.match(/(\d+)\s*个抖音号\s*管理(?:手动添加)?抖音号/);
          productRows.push({ productId: ids[0], manualAccounts: mm ? Number(mm[1]) : (singleManualAwemeRow(row) ? 1 : 0) });
        } else if (ids.length > 1) productRows.push({ productId: null, manualAccounts: 0 });
      }
    }
    const productIds = productRows.map(r => r.productId).filter(x => x != null);
    function labeledCheckboxes(labelRe) {
      return [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).filter(inp => {
        // the ancestor must OWN exactly this one visible checkbox and carry the
        // label; body-level containers owning several checkboxes never qualify
        let anc = inp.parentElement, level = 0;
        while (anc && level < 8) {
          const boxes = [...anc.querySelectorAll('input[type="checkbox"]')].filter(visible);
          if (boxes.length === 1 && boxes[0] === inp && labelRe.test(text(anc))) return true;
          anc = anc.parentElement; level++;
        }
        return false;
      });
    }
    const roiInputs = elements.filter(x => x.info.tag === 'INPUT' && x.info.fillField && x.info.fillField.recognized && x.info.fillField.kind === 'roi');
    const budgetInputs = elements.filter(x => x.info.tag === 'INPUT' && x.info.fillField && x.info.fillField.recognized && x.info.fillField.kind === 'budget');
    const roi = roiInputs.length === 1 && roiInputs[0].info.value != null ? String(roiInputs[0].info.value) : 'unknown';
    const budget = budgetInputs.length === 1 && budgetInputs[0].info.value != null ? String(budgetInputs[0].info.value) : 'unknown';
    // a non-boolean checked (or a non-unique checkbox) is unknown, never false
    const checkboxState = hits => hits.length !== 1 ? 'unknown' : (typeof hits[0].checked === 'boolean' ? hits[0].checked : 'unknown');
    const commissionChecked = checkboxState(labeledCheckboxes(/含达人佣金/));
    const nameInputs = [...document.querySelectorAll('input,textarea')].filter(visible).filter(inp => {
      if (/计划名称/.test(inp.getAttribute('placeholder') || '')) return true;
      let anc = inp.parentElement, level = 0;
      while (anc && level < 8) {
        const edits = [...anc.querySelectorAll('input,textarea')].filter(visible);
        if (edits.length === 1 && edits[0] === inp && /计划名称/.test(text(anc))) return true;
        anc = anc.parentElement; level++;
      }
      return false;
    });
    const planName = nameInputs.length === 1 && nameInputs[0].value != null && String(nameInputs[0].value).trim() !== '' ? String(nameInputs[0].value) : 'unknown';
    const exactPublish = [...document.querySelectorAll('button')].filter(visible).filter(b => text(b) === '发布计划');
    const publishEnabledUnique = exactPublish.length === 1 && !(exactPublish[0].disabled || exactPublish[0].getAttribute('aria-disabled') === 'true');
    const dp = labeledCheckboxes(/货款直投/);
    const optionalDirectPayChecked = checkboxState(dp);
    const visibleDialogCount = [...document.querySelectorAll(dialogSel)].filter(visible).length;
    return {
      originOk, pathOk, accountId, accountNavSource, accountEvidence, mainRootEvidence,
      mainTableUnique: mainRoots.length === 1,
      productRowCount: productRows.length, rows: productRows, productIds,
      uniqueProductCount: [...new Set(productIds)].length,
      eachRowHasManualAccount: productRows.length > 0 && productRows.every(r => Number.isInteger(r.manualAccounts) && r.manualAccounts >= 1),
      roi, budget, commissionChecked, planName,
      publishButtonCount: exactPublish.length, publishEnabledUnique,
      optionalDirectPayChecked, visibleDialogCount,
    };
  })();

  return { observation: window.__directDraftObservation, url: location.origin + location.pathname,
    text: document.body.innerText.slice(0, 26000),
    elements: elements.map(i => i.info), pagination, creation,
    // bounded read-only ad/guide popup candidates (index + target kind + short
    // context) for a human to audit one by one; the observer never auto-dismisses
    popupCandidates: elements.filter(x => {
      const own = String(x.info.text || '').trim();
      const isGuide = /c-lib-guide/i.test(x.info.cls || '') && (own === '下一步' || own === '我知道了');
      const isClose = /(^|[-_ ])(close|icon-close|cancel)([-_ ]|$)/i.test(x.info.cls || '') || /^[×✕]$/.test(own);
      return isGuide || isClose;
    }).slice(0, 10).map(x => {
      const own = String(x.info.text || '').trim();
      return { index: x.info.index, targetKind: (/c-lib-guide/i.test(x.info.cls || '') && (own === '下一步' || own === '我知道了')) ? 'guide' : 'close', contextText: own.slice(0, 40) };
    }),
    rows: [...document.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).map(e => text(e).slice(0, 1000)).slice(0, 80) };
}

// In-page op=page executor. Re-reads the CURRENT DOM with the same rules
// pageObserve uses (inlined so the serialized closure is self-contained --
// pageApply never calls a function that is undefined in the browser) before any
// dispatch: the unique visible product-selection modal root must still be the
// same root, the pagination region must still be the same single region, the
// target element must still belong to that region with its leaf text/purpose
// unchanged, it must not now be disabled or have a disabled ancestor, and the
// observed current/total page must not have shifted. Any failed check throws
// BEFORE any click / input / dispatch, so a stale observation, a hidden root, a
// second popup, a parent-disabled control, or a repurposed leaf all produce zero
// actions, and a forged index can never touch an ROI, budget, search, or
// publication control.
function pageApply(action) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const clsOf = e => String(e.className || '');
  const hasCls = (e, re) => re.test(clsOf(e).toLowerCase());
  const dialogSel = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const titleRe = /选择要投放的商品|添加商品/;
  const productSignals = ['全部', '店铺新品', '破圈尖货', '流量扶持', '搜索趋势'];
  const regionSel = '[class*="pagination"],[class*="Pagination"],[class*="page-item"],[class*="pager"],[class*="Pager"],[class*="pages"]';

  if (!/^\/(uni-creation\/overall-product-multi|create-ad\/overall-product)\/?$/.test(location.pathname)) throw new Error('Not the authorized new creation page');
  if (action.observation !== window.__directDraftObservation) throw new Error('Observation expired');
  if (!window.__directDraftModalRoot || !window.__directDraftPagSet || !window.__directDraftPagKind || !window.__directDraftPagPage) throw new Error('No observed pagination region');

  const e = window.__directDraftElements[action.index];
  if (!e || !e.isConnected) throw new Error('Observed pagination control unavailable');
  if (!visible(e)) throw new Error('Target pagination control is no longer visible');

  // (1) unique, visible, unchanged product-selection modal root (same rules as
  // pageObserve: legacy titled path OR full untitled drawer signature, binding
  // drawer refused, nested candidates collapsed to the minimal root)
  const headTextOf = el => {
    const aria = el.getAttribute('aria-label') || '';
    const head = [...el.querySelectorAll('h1,h2,h3,[class*="title"],[class*="Title"],[class*="header"],[class*="Header"],[role="heading"]')]
      .map(text).join(' ');
    return (aria + ' ' + head).trim();
  };
  function isProductDrawerRoot(el) {
    const head = headTextOf(el);
    const inner = text(el);
    if (/为商品添加抖音号/.test(head + ' ' + inner)) return false;
    if (titleRe.test(head)) return productSignals.some(s => inner.includes(s)) ||
      /ID\s*[:：]\s*\d{15,20}/.test(inner); // real product-list row id (ID: + 15-20 digits)
    const tabTexts = [...el.querySelectorAll('[class*="product-drawer-header-tab-item"],[class*="ovui-tabs__tab"]')].filter(visible).map(text);
    // Real field: tabs are 全部/店铺新品/破圈尖货(badge 流量扶持)/搜索趋势. The
    // observed badge is the ONLY extra token normalized away; tabs otherwise match
    // exactly (搜索趋势 keeps legacy 搜索趋势推荐 compatibility). No substring
    // matching against product names.
    const normTab = t => t.replace(/\s+/g, '').replace(/流量扶持/g, '');
    const hasTab = (name, o = {}) => tabTexts.some(t => {
      if (o.badge && !/流量扶持/.test(t)) return false;
      const nt = normTab(t);
      return nt === name || (o.legacy || []).includes(nt);
    });
    const tabsOk = hasTab('全部') && hasTab('店铺新品') &&
      hasTab('破圈尖货', { badge: true }) && hasTab('搜索趋势', { legacy: ['搜索趋势推荐'] });
    // Remaining-capacity denominator (1..30), matching pageObserve's rule.
    const footerMatch = inner.match(/已选\s*\d+\s*\/\s*(\d{1,2})/);
    const footerOk = !!footerMatch && Number(footerMatch[1]) >= 1 && Number(footerMatch[1]) <= 30 &&
      [...el.querySelectorAll('button,[role="button"]')].filter(visible).some(b => text(b) === '下一步');
    return tabsOk && footerOk;
  }
  const matchedRoots = [...document.querySelectorAll(dialogSel)].filter(visible).filter(isProductDrawerRoot);
  const roots = matchedRoots.filter(el => !matchedRoots.some(o => o !== el && el.contains(o)));
  if (roots.length !== 1) throw new Error('Product-selection modal no longer uniquely visible');
  const modalRoot = roots[0];
  if (modalRoot !== window.__directDraftModalRoot) throw new Error('Product-selection modal root changed since observation');

  // (2) the SAME single visible pagination region inside the current root
  let containers = [...modalRoot.querySelectorAll(regionSel)].filter(visible);
  containers = containers.filter(c => !containers.some(o => o !== c && typeof o.contains === 'function' && o.contains(c)));
  if (containers.length !== 1) throw new Error('Pagination region no longer uniquely present');
  const region = containers[0];
  if (region !== window.__directDraftRegion) throw new Error('Pagination region changed since observation');
  if (!window.__directDraftModalRoot.contains(e)) throw new Error('Element is not inside the product-selection modal');
  if (!window.__directDraftPagSet.has(e)) throw new Error('Element is not part of the observed pagination region');
  if (!region.contains(e)) throw new Error('Element is no longer inside the current pagination region');

  // (3) live disabled state of the target AND any disabled ancestor up to region.
  // Covers the HTML disabled attribute, aria-disabled, and an explicit
  // disabled-class token (ovui commonly uses a --disabled modifier class).
  let cur = e;
  while (cur && cur !== region.parentElement) {
    if (cur.disabled || (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') || hasCls(cur, /disabled/)) throw new Error('Disabled element');
    cur = cur.parentElement;
  }

  // (4) live leaf purpose: reclassify the target element and require the kind and
  // page number are unchanged from the recorded observation
  const t = text(e);
  const clsS = clsOf(e).toLowerCase();
  const ariaLabel = e.getAttribute('aria-label') || '';
  const hint = [e.getAttribute('placeholder') || '', ariaLabel, clsS].join(' ');
  let kind = 'other', page = null;
  if (e.tagName === 'INPUT') { if (/页|jump|goto|page/i.test(hint)) kind = 'jump-input'; }
  else if (/下一页/i.test(t) || /(^|[-_ ])(next|arrow-right)([-_ ]|$)/.test(clsS)) kind = 'next';
  else if (/上一页/i.test(t) || /(^|[-_ ])(prev|previous|arrow-left)([-_ ]|$)/.test(clsS)) kind = 'prev';
  else if (/^\d{1,4}$/.test(t) || /^\d{1,4}$/.test(ariaLabel)) { kind = 'number'; page = Number(/^\d{1,4}$/.test(t) ? t : ariaLabel); }
  const cachedKind = window.__directDraftPagKind.get(action.index);
  if (kind !== cachedKind) throw new Error('Observed control purpose changed since observation');
  if (action.expectKind && kind !== action.expectKind) throw new Error('Observed control purpose changed since observation');
  // For a numbered leaf the recorded page value is compared strictly: a DOM edit
  // that turns an observed "2" into "3" would otherwise click the wrong page.
  if (kind === 'number') {
    const cachedPage = window.__directDraftPagPage.get(action.index);
    if (cachedPage === undefined || cachedPage === null || page !== cachedPage) throw new Error('Observed pagination number changed since observation');
    if (action.expectPage !== undefined && action.expectPage !== null && page !== action.expectPage) throw new Error('Target page number does not match the observed control');
  }

  // (5) current/total page must not have shifted since observation
  const leaves = [...region.querySelectorAll('button,a,li,input,span,[role="button"]')].filter(visible).filter(el => {
    const isLeaf = el.tagName === 'INPUT' || ![...el.children].some(ch => visible(ch) && text(ch) === text(el) && text(el) !== '');
    return isLeaf;
  });
  if (!leaves.includes(e)) throw new Error('Target is not a currently visible pagination leaf');
  let activePage = null;
  for (const el of leaves) {
    if (!(/^\d{1,4}$/.test(text(el)) || /^\d{1,4}$/.test(el.getAttribute('aria-label') || ''))) continue;
    let active = false, anc = el;
    while (anc && anc !== region) {
      if (anc.getAttribute && anc.getAttribute('aria-current') === 'page') active = true;
      if (hasCls(anc, /(^|[-_ ])(active|current)([-_ ]|$)/)) active = true;
      anc = anc.parentElement;
    }
    if (active) { activePage = Number(/^\d{1,4}$/.test(text(el)) ? text(el) : el.getAttribute('aria-label')); break; }
  }
  const regionText = text(region);
  const ariaBlob = leaves.map(el => el.getAttribute('aria-label') || '').join(' ');
  const totalMatch = (regionText + ' ' + ariaBlob).match(/共\s*(\d+)\s*页/) || (regionText + ' ' + ariaBlob).match(/\bof\s+(\d+)\b/i);
  let liveCount = null;
  if (totalMatch) liveCount = Number(totalMatch[1]);
  else {
    const lastLeaf = leaves.find(el => /^\d{1,4}$/.test(text(el)) && hasCls(el, /(^|[-_ ])(last|末页)([-_ ]|$)/));
    if (lastLeaf) liveCount = Number(text(lastLeaf));
  }
  const sig = window.__directDraftPageSig || { currentPage: null, pageCount: null };
  if (activePage !== sig.currentPage || liveCount !== sig.pageCount) throw new Error('Current or total page changed since observation');

  if (action.mode === 'click') {
    if (kind !== 'number' && kind !== 'next' && kind !== 'prev') throw new Error('Click target is not a pagination number/next/prev control');
    e.click();
    return { paged: true, mode: 'click', index: action.index, kind };
  }
  if (action.mode !== 'jump' || !Number.isInteger(action.page) || action.page < 1) throw new Error('Invalid jump instruction');
  if (kind !== 'jump-input') throw new Error('Jump target is not a jump input');
  const proto = HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, String(action.page));
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  const key = { key: 'Enter', code: 'Enter', bubbles: true };
  e.dispatchEvent(new KeyboardEvent('keydown', key));
  e.dispatchEvent(new KeyboardEvent('keyup', key));
  e.blur();
  return { paged: true, mode: 'jump', index: action.index, page: action.page };
}

// In-page ordinary action executor (click / fill / scroll). Self-contained so
// Playwright can serialize it. Fill is allowed only on a recognized ROI/budget
// field with the whitelisted value; page numbers and search boxes are refused
// (those must use op=page). Pagination controls are refused here so a plain
// click cannot bypass the op=page pagination gate.
function actionApply(action) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const clsOf = e => String(e.className || '');
  // Same nearby-field semantics pageObserve reports. Walk up from the input to the
  // NEAREST ancestor that owns exactly this one visible editable input and carries
  // a unique ROI or budget label; big/mixed/search/page/cost/bid contexts refused.
  function classifyFillField(input) {
    const ownHint = [input.getAttribute('placeholder') || '', input.getAttribute('aria-label') || '', input.getAttribute('title') || ''].join(' ');
    // The real ROI label sits far above the input ("综合营销ROI目标(含达人佣金)",
    // with help text mentioning 出价分析/综合成本), so the walk is bounded at 12
    // levels and an explicit ROI-target / 日预算 field name outranks help text:
    // 成本/出价 in the explanatory copy never negates a legitimate explicit ROI
    // target label (and never authorizes a bare cost/bid field either).
    const MAXL = 12;
    let anc = input.parentElement, level = 0;
    const ancestors = [];
    while (anc && level < MAXL) {
      const edits = Array.from(anc.querySelectorAll('input,textarea')).filter(visible);
      const flat = (text(anc) + ' ' + ownHint).replace(/\s+/g, ' ').trim();
      ancestors.push({ level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), text: flat.slice(0, 80), editableCount: edits.length });
      if (edits.length === 1 && edits[0] === input) {
        const t = flat;
        const hasRoi = /roi|投产/i.test(t);
        const hasBudget = /预算/.test(t);
        const hasCostBid = /成本|出价/.test(t);
        const hasSearchPage = /搜索|关键词|商品名|商品标题|分页|页码|jump|goto|\bpage\b/i.test(t);
        const explicitRoi = /(?:目标|营销)(?:roi|投产)|(?:roi|投产)目标/i.test(t.replace(/\s+/g, ''));
        if (hasSearchPage) return { ok: false, field: null, reason: 'excluded-context', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasRoi && hasBudget) return { ok: false, field: null, reason: 'mixed-roi-budget', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (explicitRoi) return { ok: true, field: 'roi', reason: 'roi-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasCostBid) return { ok: false, field: null, reason: 'excluded-context', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasRoi) return { ok: true, field: 'roi', reason: 'roi-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
        if (hasBudget) return { ok: true, field: 'budget', reason: 'budget-label', level, tag: anc.tagName, cls: clsOf(anc).slice(0, 80), labelSample: t.slice(0, 80), ancestors };
      }
      anc = anc.parentElement; level++;
    }
    return { ok: false, field: null, reason: 'no-unique-labeled-field', level, tag: null, cls: '', labelSample: '', ancestors };
  }
  if (!/^\/(uni-creation\/overall-product-multi|create-ad\/overall-product)\/?$/.test(location.pathname) && action.expectedText !== '商品乘方') throw new Error('Not the authorized new creation page');
  if (action.observation !== window.__directDraftObservation) throw new Error('Observation expired');
  const e = window.__directDraftElements[action.index];
  if (!e || !e.isConnected) throw new Error('Observed element unavailable');
  const txt = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  if (action.expectedText !== undefined && txt !== action.expectedText) throw new Error('Observed text mismatch');
  if (e.disabled || e.getAttribute('aria-disabled') === 'true') throw new Error('Disabled element');
  const ariaLabel = e.getAttribute('aria-label') || '';
  const title = e.getAttribute('title') || '';
  let guard = [txt, ariaLabel, title].filter(Boolean).join(' ').trim();
  // Ancestor BUTTON semantics: clicking a child <span> (or any descendant) of a
  // publication button must not bypass the block via an innocuous own text.
  let ancBtn = e.parentElement;
  while (ancBtn) {
    if (ancBtn.tagName === 'BUTTON') {
      guard = [guard, (ancBtn.innerText || ancBtn.textContent || ''), ancBtn.getAttribute('aria-label') || '', ancBtn.getAttribute('title') || '']
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }
    ancBtn = ancBtn.parentElement;
  }
  if (/发布|立即投放|创建计划|提交计划|保存并投放|保存并发布|扣款授权协议|货款直投升级版服务协议/.test(guard)) throw new Error('Publication/access agreement blocked');
  if (/暂停|开启计划|关闭投放/.test(guard)) throw new Error('Existing ad changes blocked');
  if (window.__directDraftPagSet && window.__directDraftPagSet.has(e)) throw new Error('Pagination controls must use op=page, not a plain click');
  if (/删除|移除/.test(guard)) {
    const row = e.closest('tr,[role="row"],.ovui-table__row');
    if (!action.draftProductId || !row || !row.innerText.includes(String(action.draftProductId)) || !/选择要投放的商品/.test(document.body.innerText)) throw new Error('Draft-only product removal requires observed row identity');
  }
  if (action.op === 'click') { e.click(); return { clicked: true, text: txt, index: action.index }; }
  if (action.op === 'fill') {
    // 目标 ROI/日预算动态合同（客户 2026-10-11）：携带 kind 的**新授权调用**里 ROI 与预算均允许
    // 任意正有限数字（ROI 支持 13.5、预算支持页面调整的 450 等）；field 由携带的 kind 声明并
    // 与就地识别结果核对。
    // 未携带 kind 的**旧调用**保持原严格单值合同（ROI=15 / 预算=300）、原错误文案完全不变，
    // 绝不放松安全检查、绝不静默接受旧路径的越界值。
    const val = String(action.value);
    const num = Number(val);
    // Identify the field from its NEARBY labeled container (not from input order
    // or coordinates, and not from a generic shared placeholder). Refuse unless a
    // unique ROI or budget label is found.
    let cls;
    if (action.kind !== undefined) {
      const numeric = val.trim() !== '' && Number.isFinite(num);
      if (!['INPUT', 'TEXTAREA'].includes(e.tagName) || !numeric) throw new Error('Only authorized numeric ROI/budget input allowed; page numbers must use op=page');
      cls = classifyFillField(e);
      if (!cls.ok) throw new Error(`ROI/budget field not recognized (${cls.reason}); fill refused`);
      if (action.kind !== cls.field) throw new Error('Declared fill kind does not match the recognized field');
      if (cls.field === 'roi' && !(num > 0)) throw new Error('ROI field only accepts a positive number');
      if (cls.field === 'budget' && !(num > 0)) throw new Error('Budget field only accepts a positive number');
    } else {
      // Self-contained legacy whitelist (this function is serialized into the page;
      // it must not reference the host module constant FILL_VALUES).
      const LEGACY_FILL_VALUES = ['15', '300'];
      if (!['INPUT', 'TEXTAREA'].includes(e.tagName) || !LEGACY_FILL_VALUES.includes(val)) throw new Error('Only authorized ROI15/budget300 input allowed; page numbers must use op=page');
      cls = classifyFillField(e);
      if (!cls.ok) throw new Error(`ROI/budget field not recognized (${cls.reason}); fill refused`);
      if (cls.field === 'roi' && val !== '15') throw new Error('ROI field only accepts value 15');
      if (cls.field === 'budget' && val !== '300') throw new Error('Budget field only accepts value 300');
    }
    const proto = e.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, String(action.value));
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.blur();
    return { filled: true, index: action.index, value: action.value, field: cls.field, fieldSource: { source: 'nearby-field', level: cls.level, ancestorTag: cls.tag, ancestorCls: cls.cls, labelSample: cls.labelSample, ancestors: (cls.ancestors || []).slice(0, 12) } };
  }
  let container = e;
  while (container && container.scrollWidth <= container.clientWidth && container.scrollHeight <= container.clientHeight) container = container.parentElement;
  if (!container) throw new Error('Observed scroll container missing');
  const dx = Number(action.dx || 0), dy = Number(action.dy || 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 1500 || Math.abs(dy) > 1500) throw new Error('Invalid bounded scroll');
  container.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return { scrolled: true, dx, dy };
}

// In-page op=publish-plan executor. Self-contained (serialized by Playwright):
// re-derives EVERY publish precondition from the CURRENT DOM -- never from host
// caches or the command payload alone -- and only then clicks the single exact
// "发布计划" BUTTON once. Any failed check throws BEFORE the click, producing
// zero actions. It never confirms a new dialog or agreement afterwards.
function publishApply(cmd) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const dialogSel = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  if (location.origin !== 'https://qianchuan.jinritemai.com') throw new Error('Wrong origin');
  if (!/^\/(uni-creation\/overall-product-multi|create-ad\/overall-product)\/?$/.test(location.pathname)) throw new Error('Wrong path');
  if (!cmd || cmd.observation !== window.__directDraftObservation) throw new Error('Observation expired');
  const idRe = /ID\s*[:：]\s*\d{15,20}/g;
  const stripId = s => s.replace(/ID\s*[:：]\s*/, '');
  // Account identity ONLY from a uniquely proven navigator header ID, mirroring
  // the observer: exact account container first, safe fallback only when no
  // exact root exists, no-ID navigation ignored, nested/duplicate same-ID text
  // collapsed, any conflicting id refused. Never a body/id-cache/authorization
  // backfill.
  const navExact = [...new Set([...document.querySelectorAll('.qc-page-navigator-container')])].filter(visible).filter(el => !el.closest(dialogSel));
  const navCands = navExact.length ? navExact : [...new Set([...document.querySelectorAll('[class*="navigator"]')])].filter(visible).filter(el => !el.closest(dialogSel));
  const headerIds = new Set();
  for (const el of navCands) {
    for (const id of (text(el).match(/ID\s*[:：]\s*\d{8,20}/g) || []).map(stripId)) headerIds.add(id);
  }
  if (headerIds.size !== 1) throw new Error('Account identity not uniquely proven in navigator header');
  if ([...headerIds][0] !== String(cmd.accountId)) throw new Error('Account identity mismatch');
  // Product rows ONLY from the unique visible creation main table with the
  // real 商品信息/投放抖音号/素材/操作 header; dialogs and other tables excluded.
  const tableSel = 'table,[role="table"],[role="grid"],[class*="table"],[class*="Table"]';
  const requiredHeaders = ['商品信息', '投放抖音号', '素材', '操作'];
  const carriesHeader = el => requiredHeaders.every(h => text(el).includes(h));
  const mainCandidates = [...document.querySelectorAll(tableSel)].filter(visible)
    .filter(el => !el.closest(dialogSel)).filter(carriesHeader);
  const rowIds = el => [...el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible)
    .filter(row => /ID\s*[:：]\s*\d{15,20}/.test(text(row)));
  const scored = mainCandidates.map(el => ({ el, count: rowIds(el).length }));
  const maxRows = Math.max(0, ...scored.map(x => x.count));
  const maxCandidates = scored.filter(x => x.count === maxRows);
  const mainRoots = maxRows > 0
    ? maxCandidates.filter(x => !maxCandidates.some(y => y !== x && x.el.contains(y.el))).map(x => x.el)
    : mainCandidates.filter(el => !mainCandidates.some(other => other !== el && el.contains(other)));
  if (mainRoots.length !== 1) throw new Error('Main product table not uniquely identified');
  const productRows = [];
  // Same native single-manual proof the observer's creation collector uses (inlined so this
  // serialized closure stays self-contained): one VISIBLE manual .aweme-entry outside the
  // auto-pull subtree, carrying 管理(手动添加)抖音号 AND a visible .item-info-wrapper with a
  // non-empty name + explicit non-empty ID. Anything weaker stays 0 -> the guard throws.
  const singleManualAwemeRow = row => {
    const wraps = [...row.querySelectorAll('.aweme-wrapper')].filter(visible);
    if (wraps.length !== 1) return false;
    const auto = [...wraps[0].querySelectorAll('.auto-pull-aweme-wrapper')];
    const entries = [...wraps[0].querySelectorAll('.aweme-entry')].filter(e => !auto.some(a => a.contains(e)));
    if (entries.length !== 1 || !visible(entries[0])) return false;
    if (!/管理(?:手动添加)?抖音号/.test(text(entries[0]))) return false;
    const infos = [...entries[0].querySelectorAll('.item-info-wrapper')].filter(visible);
    if (infos.length !== 1) return false;
    const m = text(infos[0]).match(/^(\S.*?)\s*ID\s*[:：]\s*(\S.*?)$/);
    return !!m && m[1].trim() !== '' && m[2].trim() !== '';
  };
  for (const row of [...mainRoots[0].querySelectorAll('tr,[role="row"]')].filter(visible)) {
    if (row.closest(dialogSel)) continue;
    const rt = text(row);
    const ids = (rt.match(idRe) || []).map(stripId);
    if (ids.length > 1) throw new Error('Product row identity ambiguous');
    if (ids.length === 1) {
      const mm = rt.match(/(\d+)\s*个抖音号\s*管理(?:手动添加)?抖音号/);
      productRows.push({ productId: ids[0], manualAccounts: mm ? Number(mm[1]) : (singleManualAwemeRow(row) ? 1 : 0) });
    }
  }
  const ids = productRows.map(r => r.productId);
  if (ids.length !== 30) throw new Error('Product row count is not 30');
  if (new Set(ids).size !== 30) throw new Error('Product ids not unique');
  const want = new Set((cmd.productIds || []).map(String));
  if (want.size !== 30 || ids.some(id => !want.has(id))) throw new Error('Product id set mismatch');
  if (!productRows.every(r => Number.isInteger(r.manualAccounts) && r.manualAccounts >= 1)) throw new Error('Every product row must have at least one manual douyin account (1 or 2)');
  function labeledCheckboxChecked(labelRe) {
    const hits = [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).filter(inp => {
      // the ancestor must OWN exactly this one visible checkbox and carry the
      // label; body-level containers owning several checkboxes never qualify
      let anc = inp.parentElement, level = 0;
      while (anc && level < 8) {
        const boxes = [...anc.querySelectorAll('input[type="checkbox"]')].filter(visible);
        if (boxes.length === 1 && boxes[0] === inp && labelRe.test(text(anc))) return true;
        anc = anc.parentElement; level++;
      }
      return false;
    });
    if (hits.length !== 1) throw new Error('Required checkbox not uniquely present');
    if (typeof hits[0].checked !== 'boolean') throw new Error('Required checkbox state unknown');
    return hits[0].checked;
  }
  function uniqueLabeledValue(kind) {
    // same nearest-unique-labeled-container rule the observer uses for fills
    const found = [];
    for (const inp of [...document.querySelectorAll('input,textarea')].filter(visible)) {
      let anc = inp.parentElement, level = 0;
      while (anc && level < 12) {
        const edits = [...anc.querySelectorAll('input,textarea')].filter(visible);
        if (edits.length === 1 && edits[0] === inp) {
          const t = (text(anc) + ' ' + [inp.getAttribute('placeholder') || '', inp.getAttribute('aria-label') || '', inp.getAttribute('title') || ''].join(' ')).replace(/\s+/g, ' ').trim();
          const hasRoi = /roi|投产/i.test(t), hasBudget = /预算/.test(t);
          const hasCostBid = /成本|出价/.test(t);
          const explicitRoi = /(?:目标|营销)(?:roi|投产)|(?:roi|投产)目标/i.test(t.replace(/\s+/g, ''));
          if (/搜索|关键词|商品名|商品标题|分页|页码|jump|goto|\bpage\b/i.test(t)) break;
          if (hasRoi && hasBudget) break;
          if (kind === 'roi' && explicitRoi) { found.push(inp); break; }
          if (hasCostBid) break;
          if (kind === 'roi' && hasRoi) { found.push(inp); break; }
          if (kind === 'budget' && hasBudget && !hasRoi) { found.push(inp); break; }
        }
        anc = anc.parentElement; level++;
      }
    }
    if (found.length !== 1) throw new Error(kind + ' field not uniquely recognized');
    return found[0].value == null ? null : String(found[0].value);
  }
  // 目标 ROI/日预算动态合同：DOM 的 ROI 必须等于本店已授权的 ROI（cmd.roi；缺省 15 兼容旧调用）；
  // 预算在携带 cmd.budget 的新授权调用里等于已授权预算（如 450），旧调用（无 budget）保持原
  // 300 合同与原错误文案，绝不放松。UI 失焦后会把 15 重排为 "15.00"，故按规范化十进制
  // 字符串等价比较（15==15.00、300==300.00），位数不同/非法形状仍拒。
  const expectedRoi = cmd && cmd.roi != null ? cmd.roi : 15;
  // Serialized into the page: this comparator is intentionally self-contained
  // (no reference to the host helper). decimal-guard-r66.test.cjs proves parity
  // of both implementations by running THIS function's real serialized source.
  const canonPosDec = v => {
    let s = typeof v === 'number' ? (Number.isFinite(v) && v > 0 ? String(v) : null)
      : (typeof v === 'string' ? v.trim() : null);
    if (s === null || s.length === 0 || s.length > 128 || !/^\d+(?:\.\d+)?$/.test(s)) return null;
    let [i, f = ''] = s.split('.');
    i = i.replace(/^0+(?=\d)/, ''); f = f.replace(/0+$/, '');
    const t = i + (f ? '.' + f : '');
    return t === '0' ? null : t;
  };
  const sameDec = (x, y) => { const a = canonPosDec(x), b = canonPosDec(y); return a !== null && b !== null && a === b; };
  if (!sameDec(uniqueLabeledValue('roi'), expectedRoi)) throw new Error('ROI value in DOM does not match the authorized ROI');
  if (cmd && cmd.budget != null) {
    if (!sameDec(uniqueLabeledValue('budget'), cmd.budget)) throw new Error('Daily budget value in DOM does not match the authorized budget');
  } else if (!sameDec(uniqueLabeledValue('budget'), 300)) throw new Error('Daily budget value in DOM is not 300');
  if (labeledCheckboxChecked(/含达人佣金/) !== true) throw new Error('Commission checkbox not checked');
  const nameInputs = [...document.querySelectorAll('input,textarea')].filter(visible).filter(inp => {
    if (/计划名称/.test(inp.getAttribute('placeholder') || '')) return true;
    let anc = inp.parentElement, level = 0;
    while (anc && level < 8) {
      const edits = [...anc.querySelectorAll('input,textarea')].filter(visible);
      if (edits.length === 1 && edits[0] === inp && /计划名称/.test(text(anc))) return true;
      anc = anc.parentElement; level++;
    }
    return false;
  });
  if (nameInputs.length !== 1 || nameInputs[0].value == null || String(nameInputs[0].value).trim() === '' || String(nameInputs[0].value) !== String(cmd.planName)) throw new Error('Plan name mismatch');
  if (labeledCheckboxChecked(/货款直投/) !== false) throw new Error('Optional direct-pay must be unchecked');
  if ([...document.querySelectorAll(dialogSel)].filter(visible).length !== 0) throw new Error('Unhandled visible dialog present');
  const btns = [...document.querySelectorAll('button')].filter(visible).filter(b => text(b) === '发布计划');
  if (btns.length !== 1) throw new Error('Publish button not unique');
  const btn = btns[0];
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') throw new Error('Publish button disabled');
  btn.click(); // exactly one click on the exact BUTTON
  return { clicked: true, planNumber: cmd.planNumber, published: 'unverified' };
}

// In-page op=popup-dismiss executor. Narrowly closes a currently-visible ad or
// guide overlay ONLY when the observed element really carries close semantics
// (a top-right X inside a dialog/guide) or is a guide step button (下一步 /
// 我知道了). Everything is re-derived from the CURRENT DOM under a fresh
// observation token, the same element/attribution/label the host audited are
// re-checked, and no coordinate or arbitrary clicks are used. Publication /
// 开启投放 / 新建自动投放计划 CTAs and existing-ad controls are refused, so this
// op never advances a real ad action -- the host calls it one candidate at a
// time after reviewing the observer's bounded popupCandidates.
function popupDismissApply(cmd) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const dialogSel = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  if (location.origin !== 'https://qianchuan.jinritemai.com') throw new Error('Wrong origin');
  if (!cmd || cmd.observation !== window.__directDraftObservation) throw new Error('Observation expired');
  const e = window.__directDraftElements && window.__directDraftElements[cmd.index];
  if (!e || !e.isConnected || !visible(e)) throw new Error('Observed dismiss element unavailable');
  if (e.disabled || e.getAttribute('aria-disabled') === 'true') throw new Error('Disabled element');
  const own = text(e);
  const aria = e.getAttribute('aria-label') || '';
  const title = e.getAttribute('title') || '';
  const cls = String(e.className || '');
  const label = [own, aria, title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const inGuide = /(^|[-_ ])c-lib-guide/i.test(cls) || !!e.closest('[class*="c-lib-guide"]');
  const isGuideStep = inGuide && (own === '下一步' || own === '我知道了');
  const inDialog = !!e.closest(dialogSel);
  const isCloseX = /(^|[-_ ])(close|icon-close|cancel)([-_ ]|$)/i.test(cls) || /^[×✕Xx]$/.test(own) || /关\s*闭/.test(own + ' ' + aria + ' ' + title);
  const targetKind = isGuideStep ? 'guide' : (isCloseX && (inDialog || inGuide) ? 'close' : 'other');
  if (targetKind === 'other') throw new Error('Element is not a recognised close or guide step');
  if (cmd.targetKind !== undefined && cmd.targetKind !== targetKind) throw new Error('Dismiss target kind changed');
  if (cmd.expectedText !== undefined && label !== cmd.expectedText) throw new Error('Dismiss target label changed');
  // One deny set used for BOTH the element's own label and any ancestor BUTTON,
  // so a child × / close icon nested inside 创建计划 / 提交计划 / 保存并 / 同意 /
  // 扣款 / 暂停 / 关闭投放 can never escape the dangerous-parent semantics.
  const denyDangerous = /发布|新建自动投放计划|开启投放|投放计划|立即投放|创建计划|提交计划|保存并|确认发布|协议|同意|扣款|授权|暂停|关闭投放/;
  if (denyDangerous.test(label)) throw new Error('Publication/ad-CTA blocked for dismiss');
  let ancBtn = e.parentElement;
  while (ancBtn) {
    if (ancBtn.tagName === 'BUTTON') {
      const bt = [text(ancBtn), ancBtn.getAttribute('aria-label') || '', ancBtn.getAttribute('title') || ''].join(' ');
      if (denyDangerous.test(bt)) throw new Error('Publication/ad-CTA ancestor blocked for dismiss');
    }
    ancBtn = ancBtn.parentElement;
  }
  e.click();
  return { dismissed: true, targetKind, index: cmd.index, text: own.slice(0, 60) };
}

// Pure-DOM, read-only identity probe run before any cookie writeback. It derives
// origin / account-header match / login validity from the CURRENT page only --
// never from a startup cache, a command-supplied value, or a hardcoded true.
function cookieIdentityProbe(expectedAccountId) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const dialogSel = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const originOk = location.origin === 'https://qianchuan.jinritemai.com';
  const navExact = [...document.querySelectorAll('.qc-page-navigator-container')].filter(visible).filter(el => !el.closest(dialogSel));
  const navCands = navExact.length ? navExact : [...document.querySelectorAll('[class*="navigator"]')].filter(visible).filter(el => !el.closest(dialogSel));
  const ids = new Set();
  for (const el of navCands) for (const m of (text(el).match(/ID\s*[:：]\s*\d{8,20}/g) || [])) ids.add(m.replace(/ID\s*[:：]\s*/, ''));
  const headerAccountId = ids.size === 1 ? [...ids][0] : 'unknown';
  const identityOk = originOk && headerAccountId !== 'unknown' && headerAccountId === String(expectedAccountId);
  const bodyText = text(document.body).slice(0, 4000);
  const loginNegative = /登录失效|请先登录|扫码登录|账号登录|请登录|重新登录/.test(bodyText) || /\/login(\?|\/|$)/.test(location.pathname);
  const loginOk = identityOk && !loginNegative;
  return { originOk, headerAccountId, identityOk, loginOk };
}

async function action(cmd) {
  if (!ACTION_OPS.includes(cmd.op)) throw new Error('Unsupported operation');
  const result = await target.evaluate(actionApply, cmd);
  state.events.push({ at: new Date().toISOString(), op: cmd.op, result }); save();
  await target.waitForTimeout(800); await inspect();
}

// Expected landing page for a pagination command, computed on the HOST from the
// pre-dispatch observation. A page-number click/jump targets that page directly;
// next/prev move one page from the currently observed page. Returned null when
// the target cannot be determined (unknown current page).
function expectedPageFor(pagination, cmd) {
  if (!pagination) return null;
  if (cmd.page !== undefined && cmd.page !== null) return cmd.page;
  if (!Number.isInteger(pagination.currentPage)) return null;
  if (cmd.kind === 'next') return pagination.currentPage + 1;
  if (cmd.kind === 'prev') return pagination.currentPage - 1;
  return null;
}

// Host-side confirmation of a page change. Compares the pre-dispatch command's
// expected landing page with the CURRENT page read back from a fresh
// observation. Dispatch alone is never treated as success; a null/absent
// readback or a mismatch is reported as not confirmed (never auto-retried).
function evaluatePageConfirmation(beforePagination, cmd, afterPagination) {
  const expected = expectedPageFor(beforePagination, cmd);
  const observed = afterPagination && Number.isInteger(afterPagination.currentPage) ? afterPagination.currentPage : null;
  return { expectedPage: expected, observedCurrentPage: observed, confirmed: expected !== null && observed === expected };
}

async function pageTo(cmd) {
  const before = state.currentState;
  const plan = resolvePageTarget(before, cmd);
  const result = await target.evaluate(pageApply, { ...plan, observation: before.observation });
  // paged:true only proves the dispatch happened, never that we landed on the
  // target page. Confirmation requires a fresh readback.
  state.events.push({ at: new Date().toISOString(), op: 'page_dispatch', requested: cmd.page !== undefined ? cmd.page : cmd.kind,
    expectedPage: expectedPageFor(before.pagination, cmd), dispatched: !!(result && result.paged === true), result }); save();
  await target.waitForTimeout(800); await inspect();
  const check = evaluatePageConfirmation(before.pagination, cmd, state.currentState && state.currentState.pagination);
  // No automatic repeat clicking: one dispatch, then report the readback. A
  // mismatch is recorded explicitly as unconfirmed instead of silently retrying.
  state.events.push({ at: new Date().toISOString(), op: 'page_confirmed', ...check }); save();
  return { dispatched: !!(result && result.paged === true), ...check };
}

async function inspect() {
  const result = await target.evaluate(pageObserve);
  await target.screenshot({ path: path.join(__dirname, 'direct-draft-current.png') });
  state.currentState = result; save(); console.log(JSON.stringify({ op: 'state', ...result }));
}

// Host-side publish gate. The human authorization is passed in by the brain;
// it is never generated here. Every authorized field must match BOTH the
// latest fresh DOM observation and the configured account, and for plan 1 the
// approved-first-plan.json product_ids/account_id exactly.
// 本门可接受的份数上界：仅信任**已注入合同**的 maxPlansPerDay（严格整数 1..10），
// 缺字段/非法一律回落 3。默认（无受信上限）仍只放行 1..3（第 4 份一律拒）；配置为 6
// 时放行 1..6，第 7 份仍拒——绝不无条件放宽，与 wf.effectivePlanLimit 同一判据。
function configuredPlanCap(contract) {
  const c = contract || {};
  const n = c.maxPlansPerDay;
  return (Number.isInteger(n) && n >= 1 && n <= 10) ? n : 3;
}
// 耐久账本**解析**的份数结构上界：合法整数 1..10。历史真实 6 在配置回落 3 后仍可被读取/
// 幂等回读（不截断），但 0/11/字符串/小数一律 fail-closed（绝不无条件放宽解析）。授权/消费
// 的**实际**上界另由 configuredPlanCap / scope.maxPlansPerDay 收紧到已配置值。
function isBoundedDurablePlanNumber(n) {
  return Number.isInteger(n) && n >= 1 && n <= 10;
}
// Strict canonical base-10 decimal equivalence for the ROI/budget guard gates
// (UI reformats a filled 15 into "15.00" after blur). Accepts only finite
// positive numbers or plain positive decimal strings (single dot, digits only,
// length bounded to 128); canonicalization trims leading integer zeros and
// trailing fraction zeros ONLY -- no float rounding, so 15.00000000000000001
// stays distinct from 15. Zero, negatives, exponents, hex, units, commas,
// blanks, booleans, null/undefined, objects, NaN/Infinity are rejected.
const PLAIN_POS_DEC_RE = /^\d+(?:\.\d+)?$/;
function canonicalizePositiveDecimal(value) {
  let s;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    s = String(value);
  } else if (typeof value === 'string') {
    s = value.trim();
  } else return null;
  if (s.length === 0 || s.length > 128 || !PLAIN_POS_DEC_RE.test(s)) return null;
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  const canon = int + (frac ? '.' + frac : '');
  return canon === '0' ? null : canon;
}
function samePositiveDecimalValue(actual, expected) {
  const a = canonicalizePositiveDecimal(actual);
  const b = canonicalizePositiveDecimal(expected);
  return a !== null && b !== null && a === b;
}
function validatePublishAuthorization(cmd, obs, configuredAccountId, expectedRunId, approvedFirstPlan, contract) {
  const c = contract || {};
  // The approved account contract. An explicit contract with boundAccounts wins.
  // A contract that explicitly declares a NON-legacy shop (isLegacy:false) but
  // carries no targets fails closed: the generic path must never inherit the
  // legacy two accounts. Only the (unchanged) legacy call with no contract keeps
  // the frozen default pair.
  let expBound;
  if (Array.isArray(c.boundAccounts) && c.boundAccounts.length) {
    expBound = c.boundAccounts.map(String);
  } else if (c.isLegacy === false) {
    throw new Error('Configured approved accounts missing for non-legacy shop');
  } else {
    expBound = ['79863866', '9zmao_fushi'];
  }
  const expProducts = Number.isInteger(c.productsPerPlan) ? c.productsPerPlan : 30;
  const expRoi = c.roi != null ? Number(c.roi) : 15;
  const expBudget = c.dailyBudget != null ? Number(c.dailyBudget) : 300;
  if (!cmd || cmd.op !== 'publish-plan') throw new Error('Unsupported operation');
  const planCap = configuredPlanCap(c);
  if (!Number.isInteger(cmd.planNumber) || cmd.planNumber < 1 || cmd.planNumber > planCap) throw new Error('planNumber must be 1..' + planCap + ' for this configured daily limit');
  const a = cmd.authorization;
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Missing authorization object');
  for (const [k, t] of Object.entries({ runId: 'string', observation: 'string', accountId: 'string', planName: 'string', confirmationId: 'string' })) {
    if (typeof a[k] !== t || !a[k]) throw new Error('Authorization ' + k + ' missing/invalid');
  }
  if (a.roi !== expRoi || a.dailyBudget !== expBudget || a.commissionIncluded !== true) throw new Error('Authorization must carry the configured roi / dailyBudget / commissionIncluded true');
  if (!Array.isArray(a.boundAccounts) || JSON.stringify(a.boundAccounts.map(String).sort()) !== JSON.stringify(expBound.slice().sort())) throw new Error('Authorization must carry the exact configured approved accounts');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.businessDate || '')) || !a.manifestHash) throw new Error('Authorization business date / manifest hash missing');
  if (!Array.isArray(a.productIds) || a.productIds.length !== expProducts || new Set(a.productIds.map(String)).size !== expProducts) throw new Error('Authorization productIds must be the configured unique id count');
  if (!expectedRunId) throw new Error('Controller runId is empty; publish refused');
  if (a.runId !== expectedRunId) throw new Error('Authorization runId does not match this controller run');
  if (a.retryOfConfirmationId !== undefined && a.retryOfConfirmationId !== null) {
    if (typeof a.retryOfConfirmationId !== 'string' || !a.retryOfConfirmationId || a.retryOfConfirmationId === a.confirmationId) {
      throw new Error('Authorization retryOfConfirmationId invalid');
    }
  }
  if (!obs || !obs.observation || a.observation !== obs.observation) throw new Error('Authorization observation is not the latest DOM observation');
  const cr = obs.creation;
  if (!cr) throw new Error('No creation summary in the observation');
  if (cr.originOk !== true) throw new Error('Creation page origin mismatch');
  if (cr.pathOk !== true) throw new Error('Creation page path mismatch');
  if (cr.mainTableUnique !== true) throw new Error('Main product table not uniquely identified');
  if (cr.accountId === 'unknown' || cr.accountId !== String(configuredAccountId) || String(a.accountId) !== String(configuredAccountId)) throw new Error('DOM account identity mismatch');
  if (cr.productRowCount !== expProducts || cr.uniqueProductCount !== expProducts || cr.eachRowHasManualAccount !== true) throw new Error('DOM product table mismatch');
  const domSet = new Set(cr.productIds.map(String));
  if (domSet.size !== expProducts || a.productIds.map(String).some(id => !domSet.has(id))) throw new Error('Authorized product ids differ from the DOM table');
  if (!samePositiveDecimalValue(cr.roi, expRoi) || !samePositiveDecimalValue(cr.budget, expBudget)) throw new Error('DOM ROI/budget values mismatch');
  if (cr.commissionChecked !== true) throw new Error('DOM commission checkbox not checked');
  if (cr.planName === 'unknown' || cr.planName !== a.planName) throw new Error('DOM plan name mismatch');
  if (cr.publishButtonCount !== 1 || cr.publishEnabledUnique !== true) throw new Error('Publish button not unique+enabled');
  if (cr.optionalDirectPayChecked !== false) throw new Error('Optional direct-pay must be unchecked');
  if (cr.visibleDialogCount !== 0) throw new Error('Unhandled visible dialog present');
  if (cmd.planNumber === 1) {
    if (!approvedFirstPlan || !Array.isArray(approvedFirstPlan.product_ids) || approvedFirstPlan.product_ids.length !== expProducts) throw new Error('Approved first plan unavailable/invalid');
    if (String(approvedFirstPlan.account_id) !== String(a.accountId)) throw new Error('First plan account mismatch');
    const ap = new Set(approvedFirstPlan.product_ids.map(String));
    if (ap.size !== expProducts || a.productIds.map(String).some(id => !ap.has(id))) throw new Error('First plan product ids mismatch');
  } else {
    if (!approvedFirstPlan || approvedFirstPlan.planNumber !== 1 || approvedFirstPlan.status !== 'success'
      || !/^\d{12,20}$/.test(String(approvedFirstPlan.planId || ''))
      || !Array.isArray(approvedFirstPlan.product_ids) || approvedFirstPlan.product_ids.length !== expProducts) {
      throw new Error('Actual successful first-plan record unavailable for plan 2/3');
    }
    if (String(approvedFirstPlan.account_id) !== String(a.accountId)) throw new Error('First plan account mismatch');
    const ap = new Set(approvedFirstPlan.product_ids.map(String));
    if (a.productIds.map(String).every(id => ap.has(id))) throw new Error('Plan 2/3 must not reuse the approved first-plan id set');
  }
  return { planNumber: cmd.planNumber, runId: a.runId, observation: a.observation, accountId: String(a.accountId),
    productIds: a.productIds.map(String), roi: expRoi, dailyBudget: expBudget, commissionIncluded: true,
    boundAccounts: a.boundAccounts.map(String), planName: a.planName, confirmationId: a.confirmationId,
    businessDate: a.businessDate, manifestHash: a.manifestHash,
    retryOfConfirmationId: a.retryOfConfirmationId ? String(a.retryOfConfirmationId) : null };
}

function loadApprovedFirstPlan() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'approved-first-plan.json'), 'utf8'));
}

// ---- one-shot persistent publication attempts ----
// plan-publication-attempts.json lives in this directory and is created ONLY
// by a real publish attempt (never at require time). The confirmation is
// durably marked consumed BEFORE any click; a failed persist means zero
// dispatch, and a corrupt/unknown store fails closed. A planNumber with any
// existing record (pending/dispatched/unknown) can never be replayed, and a
// consumed confirmationId can never be reused, even with a fresh nonce.
function loadAttemptsStore(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // ONLY a missing file means "first attempt ever"; any other read failure
    // (EACCES/EIO/EISDIR...) must refuse, never reset the history to empty.
    if (e && e.code === 'ENOENT') return { consumed: {}, finalConsumed: {} };
    throw new Error('Publication attempts store unreadable (fail-closed): ' + ((e && e.code) || (e && e.message) || 'unknown-error'));
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error('Publication attempts store unreadable (fail-closed)'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.consumed || typeof parsed.consumed !== 'object' || Array.isArray(parsed.consumed)) {
    throw new Error('Publication attempts store invalid (fail-closed)');
  }
  // every historical record must be strictly valid; null / string planNumber /
  // unknown status anywhere fails the whole store closed instead of being skipped
  const validStatus = new Set(['pending', 'dispatched', 'unknown', 'success', 'failed']);
  for (const [conf, rec] of Object.entries(parsed.consumed)) {
    if (!conf || typeof conf !== 'string' || !rec || typeof rec !== 'object' || Array.isArray(rec)
      || !isBoundedDurablePlanNumber(rec.planNumber)
      || !validStatus.has(rec.status)) {
      throw new Error('Publication attempts store invalid (fail-closed)');
    }
  }
  if (parsed.finalConsumed !== undefined && (!parsed.finalConsumed || typeof parsed.finalConsumed !== 'object' || Array.isArray(parsed.finalConsumed))) {
    throw new Error('Publication final-confirm store invalid (fail-closed)');
  }
  for (const [conf, rec] of Object.entries(parsed.finalConsumed || {})) {
    if (!conf || typeof conf !== 'string' || !rec || typeof rec !== 'object' || Array.isArray(rec)
      || !isBoundedDurablePlanNumber(rec.planNumber)
      || !['pending', 'clicked', 'unknown', 'success', 'failed'].includes(rec.status)) {
      throw new Error('Publication final-confirm store invalid (fail-closed)');
    }
  }
  if (parsed.reopenConsumed !== undefined && (!parsed.reopenConsumed || typeof parsed.reopenConsumed !== 'object' || Array.isArray(parsed.reopenConsumed))) {
    throw new Error('Publication reopen store invalid (fail-closed)');
  }
  for (const [conf, rec] of Object.entries(parsed.reopenConsumed || {})) {
    if (!conf || typeof conf !== 'string' || !rec || typeof rec !== 'object' || Array.isArray(rec)
      || !isBoundedDurablePlanNumber(rec.planNumber)
      || !['pending', 'unknown', 'success', 'failed'].includes(rec.status)) {
      throw new Error('Publication reopen store invalid (fail-closed)');
    }
  }
  return { ...parsed, finalConsumed: parsed.finalConsumed || {} };
}
function persistAttemptsStore(file, store) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}
// R42 one-shot retry consumption. This is the ONLY branch that may open a new
// confirmation for the SAME business date + planNumber that already has a
// consumed record. It is entitled exclusively by a trusted explicit
// platform-failure record (recordExplicitPlatformFailure): same run/date/account/
// planNumber, a NEW confirmation id and a NEW manifest hash, the exact failing
// product dropped, the other 29 ids exactly retained, and exactly one different
// replacement added. The original record is never cleared and is stamped with
// `retryConfirmationId` in the SAME atomic write as the new record, so a second
// new confirmation for the same original (or a retry of a retry) is refused. Any
// other in-flight unknown, any other record for the same date+planNumber, a
// success original, or a missing proof all make this throw BEFORE any dispatch.
function consumeAuthorizedRetryOnce(file, store, planNumber, confirmationId, s) {
  const retryOf = s.retryOfConfirmationId;
  if (typeof retryOf !== 'string' || !retryOf) throw new Error('Retry original confirmation id missing; retry refused');
  if (retryOf === confirmationId) throw new Error('Retry confirmation id must differ from the original; retry refused');
  const orig = store.consumed[retryOf];
  if (!orig || typeof orig !== 'object') throw new Error('Retry original consumption not found; retry refused');
  const fail = orig.explicitPlatformFailure;
  if (orig.status !== 'failed' || !fail || typeof fail !== 'object') throw new Error('Retry original lacks a trusted explicit platform-failure record; retry refused');
  if (orig.isRetry === true || orig.retryOfConfirmationId) throw new Error('Retry of a retry is refused');
  if (orig.retryConfirmationId) throw new Error('Original already retried; second retry refused');
  if (String(orig.runId) !== String(s.runId) || String(orig.businessDate) !== String(s.businessDate) || Number(orig.planNumber) !== Number(planNumber)) {
    throw new Error('Retry run/date/planNumber scope mismatch; retry refused');
  }
  if (String(orig.manifestHash) === String(s.manifestHash)) throw new Error('Retry must carry a NEW manifest hash; retry refused');
  if (String(orig.accountId || fail.accountId) !== String(s.accountId) || String(fail.accountId) !== String(s.accountId)) throw new Error('Retry account scope mismatch; retry refused');
  if (String(orig.planName || fail.planName) !== String(s.planName) || String(fail.planName) !== String(s.planName)) throw new Error('Retry planName mismatch; retry refused');
  const oldIds = (fail.originalProductIds || []).map(String);
  const newIds = (s.productIds || []).map(String);
  if (oldIds.length !== 30 || new Set(oldIds).size !== 30) throw new Error('Retry original product list is not 30 unique ids; retry refused');
  if (newIds.length !== 30 || new Set(newIds).size !== 30) throw new Error('Retry requires exactly 30 unique replacement ids; retry refused');
  const newSet = new Set(newIds);
  const oldSet = new Set(oldIds);
  const removed = oldIds.filter(id => !newSet.has(id));
  const added = newIds.filter(id => !oldSet.has(id));
  if (removed.length !== 1 || String(removed[0]) !== String(fail.failingProductId)) throw new Error('Retry must drop exactly the failed product; retry refused');
  if (added.length !== 1 || newSet.has(String(fail.failingProductId))) throw new Error('Retry must add exactly one different replacement product; retry refused');
  for (const [cid, rec] of Object.entries(store.consumed)) {
    if (cid === retryOf) continue;
    if (rec && ['pending', 'dispatched', 'unknown'].includes(rec.status)) throw new Error('Another in-flight publication outcome exists; retry refused');
    if (rec && rec.businessDate === s.businessDate && Number(rec.planNumber) === Number(planNumber)) throw new Error('This plan number was already consumed for the business date; retry refused');
  }
  const at = new Date().toISOString();
  const next = {
    ...store,
    consumed: {
      ...store.consumed,
      [retryOf]: { ...orig, retryConfirmationId: confirmationId, retriedAt: at },
      [confirmationId]: {
        planNumber, runId: String(s.runId), businessDate: String(s.businessDate), manifestHash: String(s.manifestHash),
        status: 'pending', at, retryOfConfirmationId: retryOf, isRetry: true,
        accountId: String(s.accountId), planName: String(s.planName), productIds: newIds,
      },
    },
  };
  persistAttemptsStore(file, next); // single atomic write binds the original marker + the new record
  return next;
}

function consumePublicationOnce(file, planNumber, confirmationId, scope) {
  const s0 = scope || {};
  const writeCap = configuredPlanCap(s0); // 无受信上限 → 3；由 runPublishPlan 传入本店已配置上限
  if (!Number.isInteger(planNumber) || planNumber < 1 || planNumber > writeCap) throw new Error('planNumber must be 1..' + writeCap + ' for this configured daily limit');
  if (!confirmationId || typeof confirmationId !== 'string') throw new Error('confirmationId must be a non-empty string');
  const s = scope || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.businessDate || '')) || !s.runId || !s.manifestHash) throw new Error('Publication businessDate/runId/manifest scope missing');
  const store = loadAttemptsStore(file);
  if (Object.prototype.hasOwnProperty.call(store.consumed, confirmationId)) throw new Error('Confirmation already consumed; replay refused');
  if (s.retryOfConfirmationId) return consumeAuthorizedRetryOnce(file, store, planNumber, confirmationId, s);
  for (const rec of Object.values(store.consumed)) {
    if (!rec || !rec.businessDate || !rec.runId) throw new Error('Legacy publication record has unknown scope; read-only recovery required');
    if (['pending', 'dispatched', 'unknown'].includes(rec.status)) throw new Error('Prior publication outcome is pending/unknown; read-only recovery required');
    if (rec.businessDate === s.businessDate && rec.planNumber === planNumber) throw new Error('This plan number was already consumed for the business date; replay refused');
  }
  const next = { ...store, consumed: { ...store.consumed, [confirmationId]: {
    planNumber, runId: String(s.runId), businessDate: String(s.businessDate), manifestHash: String(s.manifestHash),
    status: 'pending', at: new Date().toISOString(),
  } } };
  persistAttemptsStore(file, next); // any failure throws BEFORE any dispatch
  return next;
}
function recordPublicationOutcome(file, confirmationId, status) {
  const store = loadAttemptsStore(file);
  if (!Object.prototype.hasOwnProperty.call(store.consumed, confirmationId)) return false;
  store.consumed[confirmationId] = { ...store.consumed[confirmationId], status, at: new Date().toISOString() };
  try { persistAttemptsStore(file, store); return true; }
  catch (e) { return false; }
}

// ---- R42 explicit platform-failure evidence ---------------------------------
// Pure validation of a TRUSTED, host-injected platform-refusal proof against the
// ORIGINAL frozen plan. It recomputes the frozen manifest hash, requires the
// initial+final consumption to be the real same-scope records, and accepts the
// text ONLY when it is an unambiguous platform refusal ("发布失败" + "商品已下架")
// naming exactly one product id that is part of the original 30. Timeout /
// no-row / possible-review-failure text is never accepted here. Missing /
// wrong / drifted fields are refused. No click dependency, no history change.
function validateExplicitFailureProof(originalFrozen, proof) {
  const of = originalFrozen;
  if (!of || typeof of !== 'object' || Array.isArray(of)) throw new Error('Original frozen plan missing for explicit-failure record');
  if (!isBoundedDurablePlanNumber(of.planNumber)) throw new Error('Original frozen planNumber invalid for explicit-failure record');
  if (!of.runId || !of.confirmationId || !of.manifestHash || !of.planName
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(of.businessDate || '')) || !of.accountId) {
    throw new Error('Original frozen identity incomplete for explicit-failure record');
  }
  const ids = (of.productIds || []).map(String);
  if (ids.length !== 30 || new Set(ids).size !== 30) throw new Error('Original frozen must carry 30 unique product ids');
  const wf = require('./plan-workflow.cjs');
  if (typeof wf.manifestHash !== 'function') throw new Error('Manifest recompute unavailable for explicit-failure record');
  if (wf.manifestHash(of) !== String(of.manifestHash)) throw new Error('Original frozen manifest hash mismatch; explicit-failure record refused');
  const p = proof;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Trusted platform-failure proof missing');
  for (const [k, t] of Object.entries({ failureText: 'string', capturedAccountId: 'string', capturedCreationUrl: 'string', capturedAt: 'string', evidenceSha256: 'string', confirmationId: 'string', manifestHash: 'string' })) {
    if (typeof p[k] !== t || !p[k]) throw new Error('Trusted platform-failure proof missing field: ' + k);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(p.evidenceSha256))) throw new Error('Trusted platform-failure proof evidence sha256 invalid');
  if (String(p.confirmationId) !== String(of.confirmationId)) throw new Error('Trusted platform-failure proof confirmationId does not match the original frozen');
  if (String(p.manifestHash) !== String(of.manifestHash)) throw new Error('Trusted platform-failure proof manifest hash does not match the original frozen');
  if (String(p.capturedAccountId) !== String(of.accountId)) throw new Error('Trusted platform-failure proof captured account does not match the original account');
  if (!Number.isFinite(Date.parse(p.capturedAt))) throw new Error('Trusted platform-failure proof capturedAt invalid');
  let url;
  try { url = new URL(String(p.capturedCreationUrl)); } catch (e) { throw new Error('Trusted platform-failure proof creation url invalid'); }
  if (url.origin !== QIANCHUAN_ORIGIN) throw new Error('Trusted platform-failure proof creation origin mismatch');
  if (!CREATION_PATH_RE.test(url.pathname)) throw new Error('Trusted platform-failure proof creation route mismatch');
  const txt = String(p.failureText);
  if (!txt.includes(PUBLICATION_FAILURE_MARK)) throw new Error('Trusted platform-failure proof text is not an explicit 发布失败 refusal');
  if (!txt.includes(DELISTED_MARK)) throw new Error('Trusted platform-failure proof text lacks the 商品已下架 reason');
  const idsInText = [...new Set(txt.match(/\d{15,20}/g) || [])];
  if (idsInText.length !== 1) throw new Error('Trusted platform-failure proof text must name exactly one product id');
  const failingProductId = idsInText[0];
  if (!ids.includes(failingProductId)) throw new Error('Trusted platform-failure proof failing product id is not among the original 30');
  return {
    failingProductId,
    originalProductIds: ids,
    accountId: String(of.accountId),
    planName: String(of.planName),
    runId: String(of.runId),
    businessDate: String(of.businessDate),
    planNumber: of.planNumber,
    proof: {
      failureText: txt, capturedAccountId: String(p.capturedAccountId), capturedCreationUrl: String(p.capturedCreationUrl),
      capturedAt: String(p.capturedAt), evidenceSha256: String(p.evidenceSha256).toLowerCase(),
      confirmationId: String(p.confirmationId), manifestHash: String(p.manifestHash),
    },
  };
}

// Record the original consumption as an EXPLICIT platform failure. This is the
// ONLY key that can later open a single same-day retry: the original record is
// marked `failed` (its prior status preserved) with the full trusted proof and
// the original 30 ids, and the corresponding final-confirm record is allowed to
// become `failed`. Idempotent for an identical proof; a conflicting proof is
// refused. It performs no click, does not touch published history, and never
// clears the original record.
function recordExplicitPlatformFailure(file, originalFrozen, proof) {
  const norm = validateExplicitFailureProof(originalFrozen, proof);
  const store = loadAttemptsStore(file);
  const cid = String(originalFrozen.confirmationId);
  const rec = store.consumed[cid];
  if (!rec || typeof rec !== 'object') throw new Error('Original publication consumption not found; explicit-failure record refused');
  if (String(rec.runId) !== norm.runId || String(rec.businessDate) !== norm.businessDate
    || Number(rec.planNumber) !== Number(norm.planNumber) || String(rec.manifestHash) !== String(originalFrozen.manifestHash)) {
    throw new Error('Original consumption scope does not match the frozen failure proof');
  }
  if (rec.status === 'failed' && rec.explicitPlatformFailure) {
    const same = rec.explicitPlatformFailure.evidenceSha256 === norm.proof.evidenceSha256
      && String(rec.explicitPlatformFailure.failingProductId) === String(norm.failingProductId)
      && String(rec.explicitPlatformFailure.confirmationId) === norm.proof.confirmationId;
    if (same) return rec;
    throw new Error('Existing explicit platform-failure record conflicts with the supplied proof');
  }
  if (!['dispatched', 'unknown'].includes(rec.status)) throw new Error('Original initial consumption is not dispatched/unknown; explicit-failure record refused');
  const fin = (store.finalConsumed || {})[cid];
  if (!fin || !['clicked', 'unknown'].includes(fin.status)) throw new Error('Original final confirmation is not clicked/unknown; explicit-failure record refused');
  const at = new Date().toISOString();
  const failedRecord = {
    ...rec, status: 'failed', priorStatus: rec.status, at,
    explicitPlatformFailure: { ...norm.proof, failingProductId: norm.failingProductId, originalProductIds: norm.originalProductIds,
      accountId: norm.accountId, planName: norm.planName, runId: norm.runId, businessDate: norm.businessDate,
      planNumber: norm.planNumber, recordedAt: at },
  };
  const next = {
    ...store,
    consumed: { ...store.consumed, [cid]: failedRecord },
    finalConsumed: { ...(store.finalConsumed || {}), [cid]: { ...fin, status: 'failed', priorStatus: fin.status, at } },
  };
  persistAttemptsStore(file, next);
  return next.consumed[cid];
}

// One-shot durable final-confirm reservation. Normal path requires the initial
// publish to be durably 'dispatched'. TWO narrow, explicitly controlled recovery
// contexts are honoured for an initial whose status is 'unknown' (the manifest hash
// must ALWAYS match and the reservation is ALWAYS a strict one-shot -- replay refused):
//   * MANUAL (resumeKnownFinalOnly): reason exactly 'unknown-or-new-final-dialog' plus a
//     fresh human authorization string; stores the human recovery metadata verbatim.
//   * SCHEDULED (resumeScheduledKnownFinalOnly): an INDEPENDENT strict recurring-user-
//     policy context (authorizedBy 'recurring-user-policy', humanApproved:false, a real
//     ISO policyAuthorizedAt) bound to the exact confirmationId/manifestHash/runId/
//     businessDate/planNumber/accountId/planName, each of which must also strictly match
//     the corresponding field CARRIED by the initial record. The auto branch REJECTS any
//     human/manual field mixed in and NEVER falls back to the manual path; only the
//     structured policy fields are stored on record.recovery.
// An 'unknown' initial without exactly one of those controlled contexts is refused and
// the initial record is left untouched.
const RECURRING_POLICY_AUTHORITY = 'recurring-user-policy';
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
function consumeFinalConfirmationOnce(file, confirmationId, manifestHash, recoveryContext) {
  if (!confirmationId || typeof confirmationId !== 'string' || !manifestHash) throw new Error('Final confirmation identity missing');
  const store = loadAttemptsStore(file);
  const initial = store.consumed[confirmationId];
  if (!initial || initial.manifestHash !== manifestHash) throw new Error('Initial publish dispatch not durably confirmed; final confirm refused');
  const rc = (recoveryContext && typeof recoveryContext === 'object') ? recoveryContext : null;
  const scheduled = !!rc && rc.authorizedBy === RECURRING_POLICY_AUTHORITY;
  let controlledRecovery = false;
  let recoveryRecord = null;
  if (scheduled) {
    // The auto branch NEVER mixes in a human field and NEVER falls back to manual.
    for (const banned of ['humanAuthorizedAt', 'humanConfirmation', 'humanAuth', 'humanConfirmed', 'humanApprovedAt', 'reason']) {
      if (Object.prototype.hasOwnProperty.call(rc, banned)) throw new Error('Scheduled recovery context must not carry human/manual field: ' + banned);
    }
    if (rc.humanApproved !== false) throw new Error('Scheduled recovery requires humanApproved === false');
    if (typeof rc.policyAuthorizedAt !== 'string' || !ISO_TIMESTAMP_RE.test(rc.policyAuthorizedAt)) throw new Error('Scheduled recovery policyAuthorizedAt missing or not ISO');
    if (rc.confirmationId !== confirmationId || rc.manifestHash !== manifestHash) throw new Error('Scheduled recovery identity binding mismatch');
    if (!rc.runId || !/^\d{4}-\d{2}-\d{2}$/.test(String(rc.businessDate || '')) || !isBoundedDurablePlanNumber(rc.planNumber) || !rc.accountId || !rc.planName) throw new Error('Scheduled recovery scope binding incomplete');
    if (initial.status !== 'unknown') throw new Error('Scheduled recovery requires the initial publish to be durably unknown');
    // Every scope field the initial record CARRIES must strictly match the binding.
    if (String(initial.runId) !== String(rc.runId) || String(initial.businessDate) !== String(rc.businessDate) || Number(initial.planNumber) !== Number(rc.planNumber)) throw new Error('Scheduled recovery initial scope mismatch');
    if (initial.accountId != null && String(initial.accountId) !== String(rc.accountId)) throw new Error('Scheduled recovery initial account mismatch');
    if (initial.planName != null && String(initial.planName) !== String(rc.planName)) throw new Error('Scheduled recovery initial planName mismatch');
    controlledRecovery = true;
    recoveryRecord = {
      authorizedBy: RECURRING_POLICY_AUTHORITY,
      humanApproved: false,
      policyAuthorizedAt: rc.policyAuthorizedAt,
      initialStatus: 'unknown',
      confirmationId: String(rc.confirmationId),
      manifestHash: String(rc.manifestHash),
      runId: String(rc.runId),
      businessDate: String(rc.businessDate),
      planNumber: Number(rc.planNumber),
      accountId: String(rc.accountId),
      planName: String(rc.planName),
    };
  } else {
    controlledRecovery = !!rc
      && rc.reason === 'unknown-or-new-final-dialog'
      && typeof rc.humanAuthorizedAt === 'string' && rc.humanAuthorizedAt.length > 0
      && initial.status === 'unknown';
    if (controlledRecovery) {
      recoveryRecord = {
        reason: rc.reason,
        initialStatus: 'unknown',
        humanAuthorizedAt: rc.humanAuthorizedAt,
        humanConfirmation: String(rc.humanConfirmation || 'user-confirmed'),
      };
    }
  }
  if (initial.status !== 'dispatched' && !controlledRecovery) throw new Error('Initial publish dispatch not durably confirmed; final confirm refused');
  if (Object.prototype.hasOwnProperty.call(store.finalConsumed, confirmationId)) throw new Error('Final confirmation already consumed; replay refused');
  const record = {
    planNumber: initial.planNumber, runId: initial.runId, businessDate: initial.businessDate,
    manifestHash, status: 'pending', at: new Date().toISOString(),
  };
  if (controlledRecovery) record.recovery = recoveryRecord;
  store.finalConsumed[confirmationId] = record;
  persistAttemptsStore(file, store);
  return record;
}

function recordFinalConfirmationOutcome(file, confirmationId, status) {
  if (!['clicked', 'unknown', 'success'].includes(status)) throw new Error('Invalid final-confirm outcome');
  const store = loadAttemptsStore(file);
  const rec = store.finalConsumed[confirmationId];
  if (!rec) return false;
  store.finalConsumed[confirmationId] = { ...rec, status, at: new Date().toISOString() };
  try { persistAttemptsStore(file, store); return true; }
  catch (e) { return false; }
}

// R38 controlled one-shot REOPEN marker. This is NOT the final-confirm ledger and
// NOT the initial publish ledger: it is a dedicated, strictly one-shot flag bound to
// confirmationId + manifestHash + runId + businessDate + planNumber, written to the
// SAME attempts store BEFORE the single native "发布计划" reopen click and NEVER
// cleared. Once present, a second reopen is refused forever (any exception / timeout
// / crash in between leaves it set), so the reopen can never become an unbounded
// retry, and normal `main` still routes to read-only recovery. Writing it is
// fail-closed: a persistence failure throws BEFORE any click, producing zero actions.
function consumeReopenOnce(file, confirmationId, scope) {
  if (!confirmationId || typeof confirmationId !== 'string') throw new Error('Reopen confirmationId missing');
  const s = scope || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.businessDate || '')) || !s.runId || !s.manifestHash
    || !isBoundedDurablePlanNumber(s.planNumber)) throw new Error('Reopen businessDate/runId/manifest/planNumber scope missing');
  const store = loadAttemptsStore(file);
  const reopen = store.reopenConsumed || {};
  if (Object.prototype.hasOwnProperty.call(reopen, confirmationId)) throw new Error('Reopen already consumed; second reopen refused');
  const record = {
    planNumber: s.planNumber, runId: String(s.runId), businessDate: String(s.businessDate),
    manifestHash: String(s.manifestHash), status: 'pending', at: new Date().toISOString(),
  };
  persistAttemptsStore(file, { ...store, reopenConsumed: { ...reopen, [confirmationId]: record } }); // throws BEFORE any click
  return record;
}
function recordReopenOutcome(file, confirmationId, status) {
  if (!['unknown', 'success', 'failed'].includes(status)) throw new Error('Invalid reopen outcome');
  const store = loadAttemptsStore(file);
  const rec = (store.reopenConsumed || {})[confirmationId];
  if (!rec) return false;
  store.reopenConsumed[confirmationId] = { ...rec, status, at: new Date().toISOString() };
  try { persistAttemptsStore(file, store); return true; }
  catch (e) { return false; }
}

// Publish flow: validate against the LATEST OBSERVED state the human actually
// saw (state.currentState from the user's own inspect; no new observation token
// is minted here, so the user's authorization can never be pre-empted), then
// durable one-shot consumption, then the in-page publishApply which re-derives
// EVERY precondition from the CURRENT DOM before the single click. A dispatch
// exception leaves the record 'unknown' and is never retried here. The click
// result is NOT business success: no plan id or review outcome is claimed.
// Dependencies (latest observation, runId, account, approved plan, ledger file,
// in-page evaluate, event sink) are injected so the real main-flow sequence is
// testable offline; publishPlan below just wires the live browser state in.
async function runPublishPlan(cmd, deps) {
  const auth = validatePublishAuthorization(cmd, deps.latest, deps.configuredAccountId, deps.runId, deps.approvedFirstPlan, deps.contract);
  const scope = { runId: auth.runId, businessDate: auth.businessDate, manifestHash: auth.manifestHash, maxPlansPerDay: configuredPlanCap(deps.contract) };
  if (auth.retryOfConfirmationId) {
    // Retry entitlement is NOT carried by the request: it is proven from the
    // durable explicit platform-failure ledger inside consumePublicationOnce.
    scope.retryOfConfirmationId = auth.retryOfConfirmationId;
    scope.accountId = auth.accountId;
    scope.planName = auth.planName;
    scope.productIds = auth.productIds;
  }
  consumePublicationOnce(deps.attemptsFile, auth.planNumber, auth.confirmationId, scope);
  let click;
  try {
    const publishCmd = { observation: deps.latest.observation, planNumber: auth.planNumber, accountId: auth.accountId, productIds: auth.productIds, planName: auth.planName, roi: auth.roi };
    // 动态预算仅在 ≠legacy 300 时进入页内合同（旧调用形状逐字节不变，原严格页内检查保持）。
    if (auth.dailyBudget != null && Number(auth.dailyBudget) !== 300) publishCmd.budget = String(auth.dailyBudget);
    click = await deps.evaluate(publishApply, publishCmd);
  } catch (error) {
    recordPublicationOutcome(deps.attemptsFile, auth.confirmationId, 'unknown');
    if (deps.onEvent) deps.onEvent({ op: 'publish-plan', planNumber: auth.planNumber, status: 'unknown', error: error.message });
    throw error;
  }
  const outcomePersisted = recordPublicationOutcome(deps.attemptsFile, auth.confirmationId, click && click.clicked === true ? 'dispatched' : 'unknown');
  if (!outcomePersisted) throw new Error('Publish dispatch outcome could not be durably recorded; read-only recovery required');
  if (deps.onEvent) deps.onEvent({ op: 'publish-plan', planNumber: auth.planNumber, clicked: !!(click && click.clicked === true), published: 'unverified' });
  return { planNumber: auth.planNumber, clicked: !!(click && click.clicked === true), published: 'unverified', planId: null, reviewStatus: 'unknown', outcomePersisted, retryOfConfirmationId: auth.retryOfConfirmationId || null };
}

async function publishPlan(cmd) {
  const summary = await runPublishPlan(cmd, {
    latest: state.currentState,
    runId: state.commandChannel ? state.commandChannel.runId : '',
    configuredAccountId: accountId,
    approvedFirstPlan: loadApprovedFirstPlan(),
    attemptsFile: PUBLICATION_ATTEMPTS_FILE,
    evaluate: (fn, arg) => target.evaluate(fn, arg),
    onEvent: ev => { state.events.push(Object.assign({ at: new Date().toISOString() }, ev)); save(); },
  });
  state.publicationAuthorized = true; save();
  // exactly one click, then a readback observation; never auto-confirm any new
  // dialog or agreement that may appear afterwards
  await target.waitForTimeout(800); await inspect();
  return summary;
}

// Cookie-writeback orchestrator (DI so it is testable offline). It closes ONLY
// over the actual opened.context + opened.cookieSession handed in by deps; the
// command can never choose the path (cmd is not consulted for filePath). Before
// calling the helper it requires the deps-provided fresh DOM probe to confirm
// origin+identity+login; on any skip/mismatch it makes ZERO helper calls.
// The canonical helper takes ONE options object (context, cookieFilePath,
// sessionStartFingerprint, identityOk, loginOk, shopId, audit=function), so the
// injected writeback and the main lazy adapter both forward exactly that object
// -- never positional arguments. Its real shape is
// {ok,skipped,reason,conflict?,count?,bytes?,domains?,rollback?}: there is no
// status/result field, so ONLY ok===true && skipped===false counts as saved.
// skipped / conflict / ok===false / null / undefined / malformed / throw are
// never success, and the bounded reason plus conflict flag are preserved. The
// result carries metadata only (status/count/bytes/domains/rollback); no cookie
// value, file path or raw helper argument is ever returned or logged. A helper
// failure is preserved and never triggers any publish or new recovery flow.
async function runSaveCookies(cmd, deps) {
  const { context, cookieSession, probe, writeback, accountId } = deps;
  if (!context || !cookieSession || !cookieSession.filePath || !cookieSession.startFingerprint) {
    return { op: 'save-cookies', status: 'skipped', reason: 'no-live-session' };
  }
  if (!probe || !probe.originOk || !probe.identityOk || !probe.loginOk) {
    return { op: 'save-cookies', status: 'skipped', reason: 'identity-not-confirmed' };
  }
  let res;
  try {
    res = await writeback({
      context,
      cookieFilePath: cookieSession.filePath,
      sessionStartFingerprint: cookieSession.startFingerprint,
      identityOk: probe.identityOk === true,
      loginOk: probe.loginOk === true,
      shopId: accountId,
      // audit must be callable; it deliberately captures nothing, so no helper
      // argument (path / account / cookie material) can reach a sink.
      audit: () => {},
    });
  } catch (error) {
    return { op: 'save-cookies', status: 'failed', success: false, reason: error.message };
  }
  if (!res || typeof res !== 'object' || Array.isArray(res)
    || typeof res.ok !== 'boolean' || typeof res.skipped !== 'boolean') {
    return { op: 'save-cookies', status: 'failed', success: false, reason: 'invalid-helper-result-shape' };
  }
  let status;
  if (res.ok === true && res.skipped === false) status = 'saved';
  else if (res.conflict === true) status = 'conflict';
  else if (res.skipped === true) status = 'skipped';
  else status = 'failed';
  const summary = { op: 'save-cookies', status, success: status === 'saved' };
  summary.reason = typeof res.reason === 'string' ? res.reason.slice(0, 200) : null;
  if (res.conflict === true) summary.conflict = true;
  if (typeof res.count === 'number') summary.count = res.count;
  if (typeof res.bytes === 'number') summary.bytes = res.bytes;
  if (Array.isArray(res.domains)) summary.domains = res.domains.length;
  if (typeof res.rollback === 'string') summary.rollback = res.rollback;
  // AD-GUIDANCE-COOKIE-PERSIST: on a real saved write forward ONLY the canonical
  // helper's own write fingerprints: expectedSha256 = sha of the exact normalized
  // bytes the helper serialized and wrote; afterSha256 = sha of its immediate
  // readback. Callers cannot hash the PRE-normalization context cookies instead:
  // the legitimate normalized file bytes differ, and a raw-content expectation
  // misjudges a successful write as a readback mismatch. Only strict 64-hex
  // digests pass, so a malformed value (or smuggled path/cookie material) never
  // reaches the summary; non-saved statuses carry no hashes at all.
  if (status === 'saved') {
    if (typeof res.expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(res.expectedSha256)) summary.expectedSha256 = res.expectedSha256;
    if (typeof res.afterSha256 === 'string' && /^[a-f0-9]{64}$/.test(res.afterSha256)) summary.afterSha256 = res.afterSha256;
  }
  return summary;
}

// Advance the live session fingerprint only when the canonical helper's strict
// success, the exact array fetched from the owned context, and the immediate
// file SHA/shape readback all describe the same serialized write. The expected
// summary contains metadata only; cookie material never leaves the caller's
// memory and is never returned, logged, or persisted here.
function updateCookieSessionFingerprint(cookieSession, summary, expectedWrite, observedFingerprint) {
  if (!cookieSession || !cookieSession.startFingerprint || !summary || summary.status !== 'saved' || summary.success !== true) {
    return { updated: false, reason: 'canonical-writeback-not-successful' };
  }
  if (!expectedWrite || !/^[a-f0-9]{64}$/i.test(String(expectedWrite.sha256 || ''))
    || !Number.isInteger(expectedWrite.bytes) || expectedWrite.bytes < 1
    || !Number.isInteger(expectedWrite.count) || expectedWrite.count < 0
    || !Number.isInteger(expectedWrite.domains) || expectedWrite.domains < 0) {
    return { updated: false, reason: 'owned-cookie-write-summary-missing' };
  }
  if (!observedFingerprint || observedFingerprint.exists !== true
    || observedFingerprint.sha256 !== expectedWrite.sha256
    || observedFingerprint.size !== expectedWrite.bytes
    || summary.bytes !== expectedWrite.bytes
    || summary.count !== expectedWrite.count
    || summary.domains !== expectedWrite.domains) {
    return { updated: false, reason: 'cookie-write-readback-does-not-match-owned-content' };
  }
  cookieSession.startFingerprint = {
    exists: true,
    size: observedFingerprint.size,
    mtimeMs: observedFingerprint.mtimeMs,
    sha256: observedFingerprint.sha256,
  };
  return { updated: true };
}

async function main() {
  const root = resolveProjectRoot(process.env);
  const { loadConfig } = require(path.join(root, 'src/config'));
  const { openChengfangShop, readChengfangAccountInPage, clickChengfangSubTab } = require(path.join(root, 'src/adapters/chengfang-reader'));
  const config = loadConfig().config;
  const matches = config.shops.filter(s => s.name === state.account && s.enabled !== false);
  if (matches.length !== 1) throw new Error('Authorized account configuration must be unique');
  accountId = String(matches[0].accountId);
  const opened = await openChengfangShop({ loginCfg: config.login, shopCfg: matches[0], headless: false });
  browser = opened.browser; target = opened.target;
  const identity = await target.evaluate(readChengfangAccountInPage);
  if (String(identity.accountId) !== accountId) throw new Error('Account identity mismatch');
  const tab = await target.evaluate(clickChengfangSubTab('商品自选'));
  if (!tab.clicked) throw new Error('Product self-selection tab not found');
  state.events.push({ at: new Date().toISOString(), op: 'login_verified', accountId, headless: false }); save();
  state.show = await requestShow(target);
  state.events.push({ at: new Date().toISOString(), op: 'show_requested', userVisible: state.show.userVisible, steps: state.show.steps }); save();
  await inspect();
  const runCommand = async cmd => {
    if (cmd.op === 'inspect') await inspect();
    else if (cmd.op === 'show') { state.show = await requestShow(target); state.events.push({ at: new Date().toISOString(), op: 'show_requested', userVisible: state.show.userVisible, steps: state.show.steps }); save(); console.log(JSON.stringify({ op: 'show', ...state.show })); }
    else if (cmd.op === 'page') await pageTo(cmd);
    else if (cmd.op === 'publish-plan') await publishPlan(cmd);
    else if (cmd.op === 'popup-dismiss') {
      // narrow, host-audited: evaluate re-derives close/guide semantics in-page
      const result = await target.evaluate(popupDismissApply, cmd);
      state.events.push({ at: new Date().toISOString(), op: 'popup-dismiss', result }); save();
      await target.waitForTimeout(400); await inspect();
    } else if (cmd.op === 'save-cookies') {
      // metadata-only; no Cookie value or raw helper argument is ever logged.
      // runSaveCookies closes ONLY over the actual opened.context + cookieSession
      // (never a command path) and requires a fresh pure-DOM identity probe.
      // The canonical helper takes a single options object, so the lazy adapter
      // forwards that object verbatim -- no positional expansion.
      const session = opened && opened.cookieSession;
      let probe = { originOk: false, identityOk: false, loginOk: false };
      if (opened && opened.context && session && session.filePath && session.startFingerprint) {
        probe = await target.evaluate(cookieIdentityProbe, accountId);
      }
      const summary = await runSaveCookies(cmd, {
        context: opened && opened.context,
        cookieSession: session,
        probe,
        accountId,
        writeback: options => {
          const { writebackSessionCookies } = require(path.join(root, 'src/login/cookie-writeback'));
          return writebackSessionCookies(options);
        },
      });
      state.events.push({ at: new Date().toISOString(), op: 'save-cookies', status: summary.status, success: summary.success, reason: summary.reason, conflict: summary.conflict === true, count: summary.count, bytes: summary.bytes, domains: summary.domains, rollback: summary.rollback }); save();
      console.log(JSON.stringify({ op: 'save-cookies', status: summary.status, success: summary.success }));
    }
    else await action(cmd);
  };
  const queuedRunCommand = makeSerialRunner(runCommand);
  // runId is generated at THIS process start and persisted; a command file from
  // any earlier run is rejected with zero action.
  state.commandChannel = { file: COMMAND_FILE, runId: makeRunId(), lastSeq: 0, lastCommand: null }; save();
  commandFileLoop(queuedRunCommand).catch(error => { state.commandLoopError = error.message; save(); });
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      await queuedRunCommand(JSON.parse(line));
    } catch (error) {
      state.events.push({ at: new Date().toISOString(), op: 'blocked', error: error.message }); save();
      console.log(JSON.stringify({ op: 'blocked', error: error.message }));
    }
  }
  state.controllerInputEndedAt = new Date().toISOString(); save();
  // Keep the authorized browser open; there is no close command in this
  // controller, and the file-command loop keeps serving commands.
  await new Promise(() => {});
}

const logPath = path.join(__dirname, 'direct-draft-state.json');
// Local command-file channel: fixed workspace file so a dead exec session cannot
// sever control. Only the existing inspect/show/page/click/fill/scroll executors
// are reachable; there is no evaluate/shell/close/re-login command here.
const COMMAND_FILE = path.join(__dirname, 'direct-draft-command.json');
// One-shot publication ledger: created only by a real publish attempt, never
// at require/test time. Persisted consumption must precede any click.
const PUBLICATION_ATTEMPTS_FILE = path.join(__dirname, 'plan-publication-attempts.json');
const COMMAND_POLL_MS = 500;
const ALL_COMMAND_OPS = ACTION_OPS.concat(POPUP_OPS, SAVE_OPS, OPAGE_OPS, PUBLISH_OPS);
// Shared serial command queue: the file loop and stdin BOTH go through the same
// queued runner, so one command (including its trailing inspect write-back) always
// finishes before the next one starts; a rejected command never blocks the queue.
function makeSerialRunner(runOne) {
  let tail = Promise.resolve();
  return cmd => {
    const run = tail.catch(() => {}).then(() => runOne(cmd));
    tail = run.catch(() => {});
    return run;
  };
}
function makeRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
// Pure verdict for one read of the command file: wait (missing/unparsable),
// reject (foreign/old runId, already-processed seq, unsupported op -- always
// ZERO action, never replays an old file), or run. Exported for offline testing.
function classifyCommandEntry(raw, expectedRunId, lastSeq) {
  if (raw === null || raw === undefined || raw === '') return { action: 'wait' };
  let entry;
  try { entry = JSON.parse(raw); } catch (e) { return { action: 'wait', reason: 'unparsable-file' }; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { action: 'wait', reason: 'unparsable-file' };
  const seq = entry.seq === undefined ? null : entry.seq;
  if (entry.runId !== expectedRunId) return { action: 'reject', seq, reason: 'stale-or-foreign-runId' };
  if (!Number.isInteger(entry.seq) || entry.seq < 1) return { action: 'reject', seq, reason: 'invalid-seq' };
  if (entry.seq <= lastSeq) return { action: 'reject', seq: entry.seq, reason: 'already-processed-seq' };
  const cmd = entry.command;
  if (!cmd || typeof cmd !== 'object' || !ALL_COMMAND_OPS.includes(cmd.op)) {
    return { action: 'reject', seq: entry.seq, reason: 'unsupported-or-missing-op' };
  }
  return { action: 'run', seq: entry.seq, cmd };
}
function recordCommandState(channel, rec, advanceSeq) {
  return { ...channel, lastSeq: advanceSeq ? rec.seq : channel.lastSeq, lastCommand: rec };
}
async function commandFileLoop(runCommand) {
  let lastHandledRaw = null;
  for (;;) {
    let raw = null;
    try { raw = fs.readFileSync(COMMAND_FILE, 'utf8'); } catch (e) { raw = null; }
    if (raw !== null && raw !== lastHandledRaw) {
      const verdict = classifyCommandEntry(raw, state.commandChannel ? state.commandChannel.runId : '', state.commandChannel ? state.commandChannel.lastSeq : 0);
      if (verdict.action === 'run') {
        // Persist the seq BEFORE any dispatch so a crash/restart can never
        // re-execute it; result status is recorded after.
        state.commandChannel = recordCommandState(state.commandChannel, { seq: verdict.seq, status: 'received', result: null, error: null }, true);
        save();
        try {
          await runCommand(verdict.cmd);
          state.commandChannel = recordCommandState(state.commandChannel, { seq: verdict.seq, status: 'done', result: 'ok', error: null }, true);
          save();
        } catch (error) {
          state.commandChannel = recordCommandState(state.commandChannel, { seq: verdict.seq, status: 'error', result: null, error: error.message }, true);
          save();
          console.log(JSON.stringify({ op: 'blocked', via: 'file', seq: verdict.seq, error: error.message }));
        }
      } else if (verdict.action === 'reject') {
        state.commandChannel = recordCommandState(state.commandChannel, { seq: verdict.seq, status: 'rejected', result: null, error: verdict.reason }, false);
        save();
        console.log(JSON.stringify({ op: 'file_command_rejected', seq: verdict.seq, reason: verdict.reason }));
      }
      if (verdict.action !== 'wait') lastHandledRaw = raw;
    }
    // Missing file or nothing new: keep waiting. EOF on stdin never stops this loop.
    await new Promise(r => setTimeout(r, COMMAND_POLL_MS));
  }
}
const state = { task: 'single-draft-direct-controller', account: '瑾漂亮潮流服饰', startedAt: new Date().toISOString(), headless: false,
  roi: 15, dailyBudget: 300, includesCommission: true, publicationAuthorized: false, existingAdMutations: 0, events: [] };
function save() { fs.writeFileSync(logPath, JSON.stringify(state, null, 2)); }
let browser, target, accountId;

if (require.main === module) {
  main().catch(error => { state.error = error.message; save(); console.log(JSON.stringify({ op: 'blocked', error: error.message })); });
}

module.exports = {
  resolveProjectRoot, requestShow, resolvePageTarget, expectedPageFor, evaluatePageConfirmation,
  guardText, isBlockedText, removalRequiresProductId,
  pageObserve, pageApply, actionApply, publishApply,
  popupDismissApply, cookieIdentityProbe,
  validatePublishAuthorization, loadApprovedFirstPlan, runPublishPlan,
  configuredPlanCap, isBoundedDurablePlanNumber, samePositiveDecimalValue,
  runSaveCookies,
  updateCookieSessionFingerprint,
  loadAttemptsStore, persistAttemptsStore, consumePublicationOnce, recordPublicationOutcome,
  validateExplicitFailureProof, recordExplicitPlatformFailure,
  consumeFinalConfirmationOnce, recordFinalConfirmationOutcome,
  consumeReopenOnce, recordReopenOutcome,
  classifyCommandEntry, recordCommandState, makeRunId, makeSerialRunner, ALL_COMMAND_OPS,
  ACTION_OPS, FILL_VALUES, OPAGE_OPS, PUBLISH_OPS, POPUP_OPS, SAVE_OPS,
};
