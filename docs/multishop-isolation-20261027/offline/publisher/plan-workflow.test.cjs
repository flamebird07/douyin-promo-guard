'use strict';
// Specialized OFFLINE regression for the frozen plan-publish flow. No network, no
// browser, no real config/credentials, no LLM. Exercises the REAL exported
// functions of plan-workflow.cjs / confirmation-ui.cjs / direct-draft-controller.cjs
// (never a parallel copy) against packaged fixtures and a tiny in-workspace DOM/vm
// harness. Run: node --test plan-workflow.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawn } = require('node:child_process');

const wf = require('./plan-workflow.cjs');
const ui = require('./confirmation-ui.cjs');
const c = require('./direct-draft-controller.cjs');
const rp = require('./run-plans.cjs');

const FIX = path.join(__dirname, 'fixtures');
const readFix = n => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const CONFIRM_TEST_NOW_MS = Date.now();
const CONFIRM_TEST_BUSINESS_DATE = wf.shanghaiDate(CONFIRM_TEST_NOW_MS);
const CONFIRM_TEST_PREVIOUS_DATE = wf.shanghaiDate(CONFIRM_TEST_NOW_MS - 24 * 60 * 60 * 1000);

// ── minimal DOM/vm harness (enough for the two in-page collectors) ───────────
let SEQ = 0;
const ElementProto = {
  getAttribute(name) {
    if (name === 'class') return this.className != null ? String(this.className) : null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
  setAttribute(name, val) { if (name === 'class') { this.className = val; return; } this.attrs[name] = String(val); },
  getBoundingClientRect() { const top = this.__top || 0; const r = this.__rect; const width = r ? r[0] : 0; const height = r ? r[1] : 0; return { width, height, x: 0, y: top, top, bottom: top + height }; },
  get innerText() { return this.__computeText(); },
  get textContent() { return this.__computeText(); },
  get children() { return this.__kids; },
  get parentElement() { return this.parent; },
  get isConnected() { let n=this;while(n){if(n.tagName==='BODY')return true;n=n.parent;}return false; },
  get value() { return this.__value == null ? '' : this.__value; },
  set value(v) { this.__value=String(v); },
  __computeText() { let s = ''; const walk = n => { if (n.__text != null) s += n.__text + ' '; for (const ch of n.__kids) walk(ch); }; walk(this); return s.replace(/\s+/g, ' ').trim(); },
  querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (matchesSel(ch, sel)) out.push(ch); walk(ch); } }; walk(this); return out; },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  closest(sel) { let n = this; while (n) { if (matchesSel(n, sel)) return n; n = n.parent; } return null; },
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parent; } return false; },
  click() {
    this.__clicks = (this.__clicks || 0) + 1;
    if (this.tagName === 'LABEL') {
      const input = this.querySelector('input[type="checkbox"]');
      if (input) { const next=!input.checked;if(input.__controlled){if(typeof input.__onToggle==='function')input.__onToggle(next);}else{input.checked=next;if(typeof input.__onToggle==='function')input.__onToggle(input.checked);} }
    } else if (this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox') {
      const next=!this.checked;if(this.__controlled){if(typeof this.__onToggle==='function')this.__onToggle(next);}else{this.checked=next;if(typeof this.__onToggle==='function')this.__onToggle(this.checked);}
    }
  },
  dispatchEvent(event) { this.__events=(this.__events||[]).concat(event&&event.type||''); return true; },
  blur() { this.__blurred=true; },
  attachShadow(opts) {
    if (!opts || opts.mode !== 'open') return null;
    const sr = {
      __kids: [],
      querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (matchesSel(ch, sel)) out.push(ch); walk(ch); } }; walk(this); return out; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    this.shadowRoot = sr;
    return sr;
  },
};
function HTMLInputElement() {}
Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){return this.__value==null?'':this.__value;},set(v){this.__value=String(v);}});
function HTMLTextAreaElement() {}
Object.defineProperty(HTMLTextAreaElement.prototype,'value',{configurable:true,get(){return this.__value==null?'':this.__value;},set(v){this.__value=String(v);}});
function Event(type,options={}) { this.type=type;this.bubbles=!!options.bubbles; }
function KeyboardEvent(type,options={}) { this.type=type;this.key=options.key||''; }
// A minimal CSSStyleDeclaration stand-in: only the surface the native marker nudge
// touches (setProperty / getPropertyValue / getPropertyPriority / removeProperty). Values
// and priorities are kept in per-property maps so height/min-height can be reverted
// independently without ever overwriting other inline properties (Vue vShow display etc).
function makeStyleObj() {
  const props = Object.create(null);
  const prio = Object.create(null);
  return {
    setProperty(name, value, priority) { props[name] = String(value); prio[name] = priority || ''; },
    getPropertyValue(name) { return props[name] != null ? props[name] : ''; },
    getPropertyPriority(name) { return prio[name] != null ? prio[name] : ''; },
    removeProperty(name) { const had = props[name]; delete props[name]; delete prio[name]; return had != null ? had : ''; },
  };
}
function El(tag, opts = {}, kids = []) {
  opts = opts || {};
  const el = Object.create(ElementProto);
  el.tagName = String(tag).toUpperCase();
  el.__seq = SEQ++;
  el.attrs = {};
  el.className = opts.class != null ? opts.class : (opts.cls || '');
  el.__text = opts.text != null ? String(opts.text) : null;
  el.__rect = opts.rect;
  el.__top = opts.top != null ? opts.top : 0;
  el.__display = opts.display != null ? opts.display : null;
  el.style = makeStyleObj();
  el.__vis = opts.hidden ? 'hidden' : 'visible';
  el.disabled = opts.disabled === true;
  if (opts.checked !== undefined) el.checked = opts.checked === true;
  if (opts.value !== undefined) el.value = String(opts.value);
  el.__kids = []; el.parent = null;
  if (opts.attrs) for (const k in opts.attrs) el.attrs[k] = String(opts.attrs[k]);
  for (const ch of kids) { if (!ch) continue; ch.parent = el; el.__kids.push(ch); }
  return el;
}
function parseCompound(str) {
  const parts = []; let i = 0;
  const tm = str.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tm) { parts.push({ t: 'tag', v: tm[0].toUpperCase() }); i = tm[0].length; }
  while (i < str.length) {
    if (str[i] === '[') {
      const close = str.indexOf(']', i); const inside = str.slice(i + 1, close);
      const am = inside.match(/^([a-zA-Z-]+)([*^$]?=)?"?([^"]*)"?:?$/);
      if (am && am[2]) parts.push({ t: 'attr', name: am[1], op: am[2], val: am[3] });
      else parts.push({ t: 'attr', name: inside.trim(), op: 'present' });
      i = close + 1;
    } else if (str[i] === '.') { const mm = str.slice(i).match(/^\.([A-Za-z0-9_-]+)/); parts.push({ t: 'class', v: mm[1] }); i += mm[0].length; }
    else { i++; }
  }
  return parts;
}
function matchPart(el, p) {
  if (p.t === 'tag') return el.tagName === p.v;
  if (p.t === 'class') return (' ' + el.className + ' ').includes(' ' + p.v + ' ');
  if (p.t === 'attr') {
    const cur = el.getAttribute(p.name);
    if (p.op === 'present') return cur != null;
    if (cur == null) return false;
    if (p.op === '=') return cur === p.val;
    if (p.op === '*=') return cur.includes(p.val);
    return false;
  }
  return false;
}
function matchesSel(el, selStr) {
  return selStr.split(',').some(g => {
    const chain = g.trim().split(/\s+/).filter(Boolean);
    if (!chain.length) return false;
    const matchesCompound = (node, compound) => { const parts = parseCompound(compound); return parts.length > 0 && parts.every(p => matchPart(node, p)); };
    let node = el;
    if (!matchesCompound(node, chain[chain.length - 1])) return false;
    for (let i = chain.length - 2; i >= 0; i--) {
      node = node.parent;
      while (node && !matchesCompound(node, chain[i])) node = node.parent;
      if (!node) return false;
    }
    return true;
  });
}
function allDesc(node) { const out = []; const walk = n => { for (const ch of n.__kids) { out.push(ch); walk(ch); } }; walk(node); return out; }
function makeCtx(bodyKids, locationOverride = {}, storageInit = {}) {
  SEQ = 0;
  const body = El('body', {}, bodyKids || []);
  const doc = {
    body,
    querySelectorAll(sel) { if (sel.trim() === 'body *') return allDesc(body); return allDesc(body).filter(el => matchesSel(el, sel)); },
    querySelector(sel) { const a = this.querySelectorAll(sel); return a[0] || null; },
  };
  const windowObj = {};
  let clock=1700000000000;
  const ctx = { window: windowObj, document: doc, location: { origin: 'https://qianchuan.jinritemai.com', pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId, ...locationOverride }, getComputedStyle: el => ({ visibility: el.__vis || 'visible', display: el.__display != null ? el.__display : 'block' }), HTMLInputElement, HTMLTextAreaElement, Event, KeyboardEvent, Date:{now(){return ++clock;}}, setTimeout, URLSearchParams, console: { log() {} } };
  const store = Object.assign({}, storageInit);
  const localStorageStub = {
    get length() { return Object.keys(store).length; },
    key(i) { const keys = Object.keys(store); return i < keys.length ? keys[i] : null; },
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, String(k)) ? store[String(k)] : null; },
    setItem(k, v) { store[String(k)] = String(v); },
    removeItem(k) { delete store[String(k)]; },
  };
  ctx.localStorage = localStorageStub;
  const context = vm.createContext(ctx);
  windowObj.document = doc;
  windowObj.localStorage = localStorageStub;
  return {
    context, doc, body, store,
    run(fn, arg) { const a = arguments.length > 1 ? ', ' + JSON.stringify(arg) : ''; return vm.runInContext('(' + fn.toString() + ').call(window' + a + ')', context); },
  };
}
const plain = value => JSON.parse(JSON.stringify(value));

function configureCreationFixture({roi='4.34',budget='',directPayChecked=true}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5400+i));
  const nav=El('div',{class:'qc-page-navigator-container',rect:[900,40],text:'千川 乘方 ID：'+wf.BUSINESS.accountId+' 伊人美'});
  const rowOf=(id,i)=>El('tr',{rect:[600,40]},[
    El('td',{rect:[500,30],text:'商品'+i+' 店铺新品 ID：'+id}),
    El('td',{rect:[160,30],text:'2个抖音号 管理手动添加抖音号'}),
  ]);
  const table=El('table',{class:'ovui-table',rect:[900,640]},[
    El('tr',{rect:[900,30]},[
      El('th',{rect:[220,20],text:'商品信息'}),El('th',{rect:[160,20],text:'投放抖音号'}),
      El('th',{rect:[160,20],text:'素材（默认启用智能优选）'}),El('th',{rect:[80,20],text:'操作'}),
    ]),...ids.map(rowOf),
  ]);
  const commission=El('div',{class:'oc-switch-card-item',rect:[400,60],text:'含达人佣金出价 说明'},[
    El('input',{attrs:{type:'checkbox'},checked:true,rect:[20,20]}),
  ]);
  const roiField=El('div',{class:'ovui-field-row',rect:[320,60]},[
    El('label',{rect:[180,24],text:'综合营销ROI目标(含达人佣金)'}),
    El('input',{class:'ovui-input',attrs:{placeholder:'请输入'},value:roi,rect:[120,30]}),
  ]);
  const budgetField=El('div',{class:'ovui-field-row',rect:[320,60]},[
    El('label',{rect:[180,24],text:'日预算'}),
    El('input',{class:'ovui-input',attrs:{placeholder:'请输入'},value:budget,rect:[120,30]}),
  ]);
  const nameField=El('div',{class:'oc-input-group-wrap',rect:[320,60],text:'计划名称 0/50'},[
    El('input',{class:'ovui-input',attrs:{placeholder:'请输入计划名称，1-50个字符'},value:'待设置',rect:[140,30]}),
  ]);
  const directPayCard=El('div',{class:'good-direct-pay-guide',rect:[400,80],text:'为店铺开启 货款直投升级版 勾选视为同意协议'},[
    El('label',{text:'为店铺开启 货款直投升级版',rect:[200,32]},[
      El('div',{},[El('input',{attrs:{type:'checkbox'},checked:directPayChecked,rect:[20,20]})]),
    ]),
  ]);
  return [nav,table,commission,roiField,budgetField,nameField,directPayCard,El('button',{rect:[100,36],text:'发布计划'})];
}

test('run-plans entry uses its real native checkbox and account-header helpers against isolated DOM state', () => {
  const id='3845811625248555099';
  const productInput=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const productLabel=El('label',{rect:[40,20]},[productInput]);
  const productCard=El('div',{class:'card-container',rect:[240,120],text:'商品 ID: '+id},[productLabel]);
  const productDrawer=El('div',{attrs:{role:'dialog'},rect:[500,400],text:'全部 已选 0 / 30'},[productCard]);
  const productCtx=makeCtx([productDrawer]);
  assert.deepEqual(plain(productCtx.run(rp.selectNativeCardInPage,id)),{id,clicked:true,checkedNow:true,pending:false});
  assert.equal(productInput.checked,true);
  assert.deepEqual(plain(productCtx.run(rp.selectNativeCardInPage,id)),{id,clicked:false,checkedNow:true,alreadyChecked:true});
  assert.equal(productLabel.__clicks,1,'选择已选商品必须幂等，不反向切换');
  assert.deepEqual(plain(productCtx.run(rp.deselectNativeCardInPage,id)),{id,clicked:true,checkedNow:false,pending:false});
  assert.equal(productInput.checked,false);

  const accountChecks=['79863866','9zmao_fushi'].map(()=>El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]}));
  const accountRows=['79863866','9zmao_fushi'].map((account,index)=>El('tr',{rect:[400,32]},[
    El('td',{text:'ID: '+account}),El('td',{},[accountChecks[index]]),
  ]));
  const headerInput=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  headerInput.__onToggle=checked=>accountChecks.forEach(box=>{box.checked=checked;});
  const headerLabel=El('label',{class:'ovui-checkbox',rect:[20,20]},[headerInput]);
  const header=El('thead',{},[El('tr',{},[El('th',{},[headerLabel])])]);
  const batchButton=El('button',{rect:[260,20],text:'将所选抖音号批量添加至所有商品'});
  const confirm=El('button',{rect:[80,32],text:'确定'});
  const accountFooter=El('div',{text:'当前商品已选：0/30'});
  headerInput.__onToggle=checked=>{accountChecks.forEach(box=>{box.checked=checked;});accountFooter.__text=checked?'当前商品已选：2/30':'当前商品已选：0/30';};
  const accountDrawer=El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号'},[
    header,...accountRows,accountFooter,batchButton,confirm,
  ]);
  const accountCtx=makeCtx([accountDrawer]);
  const initiallyEmpty=plain(accountCtx.run(rp.bindingDrawerSnapshotInPage));
  assert.equal(initiallyEmpty.selectedCount,0,'首次进入账号抽屉实际是 0/30，不能误当作绑定失败');
  const first=plain(accountCtx.run(rp.selectAllAccountsInPage));
  assert.deepEqual(first,{clicked:true});
  assert.equal(headerLabel.__clicks,1,'只通过真实表头一次性全选');
  assert.ok(accountChecks.every(box=>box.checked));
  assert.deepEqual(plain(accountCtx.run(rp.selectAllAccountsInPage)),{alreadyChecked:true});
  assert.equal(headerLabel.__clicks,1,'已全选时不再 toggle 表头');
  const snapshot=plain(accountCtx.run(rp.bindingDrawerSnapshotInPage));
  assert.equal(snapshot.ok,true);
  assert.equal(snapshot.rows.length,2);
  assert.equal(snapshot.selectedCount,2);
  assert.equal(snapshot.totalCount,30);
  assert.ok(snapshot.rows.every(row=>row.checked===true));
  assert.equal(snapshot.selectedCount,2,'表头全选后必须回读成 2/30');
  assert.equal(snapshot.batchButtonCount,1,'批量入口是真实按钮而非checkbox');
  assert.deepEqual(plain(accountCtx.run(rp.applyBatchAccountsInPage)),{clicked:true});
  assert.equal(batchButton.__clicks,1,'批量按钮只点一次');
  assert.equal(confirm.__clicks,undefined,'批量按钮阶段绝不提前点抽屉确定');
  assert.deepEqual(plain(accountCtx.run(rp.confirmBatchAccountsApplyInPage)),{clicked:true});
  assert.equal(confirm.__clicks,1,'抽屉确定仅在批次经回读确认后的单独一次提交');

  const third=El('tr',{rect:[400,32]},[El('td',{text:'ID: 55555555'}),El('td',{},[El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})])]);
  const drawerWithThird=El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号 当前商品已选：0/30'},[
    header,...accountRows,third,batchButton,confirm,
  ]);
  const thirdCtx=makeCtx([drawerWithThird]);
  const thirdSnapshot=plain(thirdCtx.run(rp.bindingDrawerSnapshotInPage));
  assert.equal(thirdSnapshot.rows.length,3,'collector must preserve an unknown third account row');
  assert.deepEqual(plain(thirdSnapshot.rows.map(row=>row.ids[0])),['79863866','9zmao_fushi','55555555']);
  assert.throws(()=>thirdCtx.run(rp.selectAllAccountsInPage),/exact-target-rows/,'third accounts must stop before header select-all');
});

test('native product checkbox callbacks click once and never trust an immediate cached read (controlled pending)', () => {
  const id='3845971591229997378';
  // A controlled ovui checkbox: clicking the label does NOT synchronously flip
  // input.checked — the real page updates it asynchronously. The old logic read the
  // cached input.checked inside the same evaluate and threw product-checkbox-readback-failed.
  const input=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  input.__controlled=true; let toggles=0; input.__onToggle=()=>{toggles++;};
  const label=El('label',{class:'ovui-checkbox ovui-checkbox--md',rect:[40,20]},[input]);
  const card=El('div',{class:'card-container',rect:[240,120],text:'商品 ID: '+id},[label]);
  const drawer=El('div',{attrs:{role:'dialog'},rect:[500,400],text:'全部 已选 0 / 30'},[card]);
  const ctx=makeCtx([drawer]);
  const r=plain(ctx.run(rp.selectNativeCardInPage,id));
  assert.equal(r.clicked,true);assert.equal(r.pending,true);assert.equal(r.checkedNow,false);
  assert.equal(label.__clicks,1,'真实原生label点击恰好一次');assert.equal(toggles,1);
  assert.equal(input.checked,false,'即时cached read未落稳，回调绝不据此throw旧的readback-failed');
  // A fresh re-read that sees the replacement node checked true is a legal path with
  // ZERO further clicks; alreadyChecked must not toggle back.
  input.checked=true;
  const r2=plain(ctx.run(rp.selectNativeCardInPage,id));
  assert.equal(r2.clicked,false);assert.equal(r2.alreadyChecked,true);
  assert.equal(label.__clicks,1,'已勾选合法路径保持零toggle，不反向切换');
});

test('native product checkbox callbacks fail closed with zero clicks on disabled / duplicate checkbox / duplicate card / non-unique drawer', () => {
  const id='3845971591229997378';
  const mkDrawer=(kids)=>El('div',{attrs:{role:'dialog'},rect:[500,400],text:'全部 已选 0 / 30'},kids);
  // disabled card
  const disCard=El('div',{class:'card-container',rect:[240,120],attrs:{'aria-disabled':'true'},text:'商品 ID: '+id},[
    El('label',{rect:[40,20]},[El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})]),
  ]);
  assert.throws(()=>makeCtx([mkDrawer([disCard])]).run(rp.selectNativeCardInPage,id),/product-card-disabled/);
  // duplicate native checkbox inside the single card
  const dupCard=El('div',{class:'card-container',rect:[240,120],text:'商品 ID: '+id},[
    El('label',{rect:[40,20]},[El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})]),
    El('label',{rect:[40,20]},[El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})]),
  ]);
  assert.throws(()=>makeCtx([mkDrawer([dupCard])]).run(rp.selectNativeCardInPage,id),/native-product-checkbox-not-unique/);
  // same id on two cards (ambiguous target)
  const cardOf=x=>El('div',{class:'card-container',rect:[240,120],text:'商品 ID: '+x},[El('label',{rect:[40,20]},[El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})])]);
  assert.throws(()=>makeCtx([mkDrawer([cardOf(id),cardOf(id)])]).run(rp.selectNativeCardInPage,id),/product-card-not-unique/);
  // two independent drawers => product-drawer-not-unique
  assert.throws(()=>makeCtx([mkDrawer([cardOf(id)]),mkDrawer([cardOf(id)])]).run(rp.selectNativeCardInPage,id),/product-drawer-not-unique/);
});

test('account select-all callback refuses a partial 1-of-2 selection and disabled header with zero clicks', () => {
  const mk=(checks)=>{
    const rows=['79863866','9zmao_fushi'].map((a,i)=>El('tr',{rect:[400,32]},[El('td',{text:'ID: '+a}),El('td',{},[checks[i]])]));
    const headerInput=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
    const headerLabel=El('label',{class:'ovui-checkbox',rect:[20,20]},[headerInput]);
    const header=El('thead',{},[El('tr',{},[El('th',{},[headerLabel])])]);
    return El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号 当前商品已选：1/30'},[header,...rows]);
  };
  // one account already checked, the other not => partial, unknown, must not click header
  const partial=makeCtx([mk([El('input',{attrs:{type:'checkbox'},checked:true,rect:[12,12]}),El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]})])]);
  assert.throws(()=>partial.run(rp.selectAllAccountsInPage),/partial-account-selection-state-unknown/);
});

test('run-plans accepts the real repair-picker 0/1 batch as capacity for a 29+1 plan', () => {
  const tabs=['全部','店铺新品','破圈尖货','搜索趋势推荐'].map(name=>El('div',{class:'product-drawer-header-tab-item',rect:[100,30],text:name}));
  const footer=El('div',{text:'已选 0 / 1'});
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[...tabs,footer,El('button',{text:'下一步',rect:[80,28]})]);
  const ctx=makeCtx([drawer]);
  const empty=plain(ctx.run(rp.drawerSnapshotInPage));
  assert.equal(empty.selectedCount,0);
  assert.equal(empty.remainingCapacity,1);
  assert.equal(rp.pickerBatchStateMatches(empty,29,0),true,'29 existing rows plus an empty 1-slot picker is valid');
  footer.__text='已选 1 / 1';
  const one=plain(ctx.run(rp.drawerSnapshotInPage));
  assert.equal(rp.pickerBatchStateMatches(one,29,1),true,'the one newly selected product completes 30');
  assert.equal(rp.pickerBatchStateMatches(one,0,1),false,'batch count cannot be compared with all 30 product IDs');
  assert.equal(rp.pickerBatchStateMatches({...one,remainingCapacity:30},29,1),false,'stale whole-plan capacity is rejected');
});

test('run-plans category switch recognizes the observed 搜索趋势推荐 tab for 搜索趋势', () => {
  const tabs=['全部','店铺新品','破圈尖货','搜索趋势推荐'].map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'搜索趋势')),{clicked:true,alreadyActive:false});
  assert.equal(tabs[3].__clicks,1,'真实推荐标签别名必须只触发一次');
});

test('run-plans category switch: string name matches real DOM tab text for all four categories', () => {
  const names=['全部','店铺新品','破圈尖货','搜索趋势'];
  for (const target of names) {
    const tabs=names.map((name,index)=>El('div',{
      class:'product-drawer-header-tab-item'+(index===0?' current':''),
      attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
    }));
    const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
      ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
    ]);
    const ctx=makeCtx([drawer]);
    const r=plain(ctx.run(rp.clickDrawerTabInPage,target));
    const idx=names.indexOf(target);
    if (idx===0) { assert.deepEqual(r,{clicked:false,alreadyActive:true},target+' 已激活零动作'); assert.equal(tabs[0].__clicks,undefined); }
    else { assert.deepEqual(r,{clicked:true,alreadyActive:false},target+' 切换'); assert.equal(tabs[idx].__clicks,1); }
  }
});

test('run-plans category switch: 流量扶持 annotation stripped from DOM tab text still matches', () => {
  const tabs=['全部','店铺新品 流量扶持','破圈尖货','搜索趋势'].map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品')),{clicked:true,alreadyActive:false});
  assert.equal(tabs[1].__clicks,1);
});

test('run-plans category switch: already active tab yields zero action', () => {
  const names=['全部','店铺新品','破圈尖货','搜索趋势'];
  const tabs=names.map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===1?' current':''),
    attrs:{'aria-selected':index===1?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品')),{clicked:false,alreadyActive:true});
  assert.equal(tabs[1].__clicks,undefined);
});

test('run-plans category switch: hidden required tab prevents drawer identification', () => {
  const names=['全部','店铺新品','破圈尖货','搜索趋势'];
  const tabs=names.map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
    hidden:index===1,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/product-drawer-not-unique/);
});

test('run-plans category switch: duplicate visible tabs yield not-unique', () => {
  const names=['全部','店铺新品','店铺新品','破圈尖货','搜索趋势'];
  const tabs=names.map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-not-unique:店铺新品/);
});

test('run-plans category switch: unknown name with no matching tab yields not-unique', () => {
  const names=['全部','店铺新品','破圈尖货','搜索趋势'];
  const tabs=names.map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'不存在分类'),/category-tab-not-unique:不存在分类/);
});

test('run-plans category switch: non-product drawer (为商品添加抖音号) rejected', () => {
  const names=['全部','店铺新品','破圈尖货','搜索趋势'];
  const tabs=names.map((name,index)=>El('div',{
    class:'product-drawer-header-tab-item'+(index===0?' current':''),
    attrs:{'aria-selected':index===0?'true':'false'},rect:[120,30],text:name,
  }));
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[600,500]},[
    ...tabs,El('div',{text:'为商品添加抖音号 已选 0 / 30'}),El('button',{text:'下一步',rect:[100,30]}),
  ]);
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/product-drawer-not-unique/);
});

// ── live three-layer native tab tree (reference-acceptance/live-category-dom-20261010.json) ──
function nestedTab(label, {active=false,wrapperHidden=false,wrapperDisabled=false}={}) {
  const leaf=El('div',{class:'product-drawer-header-tab-item',rect:[100,20],text:label});
  const btn=El('div',{class:'ovui-tabs__tab-btn',rect:[100,20],text:label},[leaf]);
  const wrapper=El('div',{class:'ovui-tabs__tab'+(active?' ovui-tabs__tab--active':'')+(wrapperDisabled?' ovui-tabs__tab--disabled':''),rect:wrapperHidden?undefined:[100,30],text:label},[btn]);
  return {wrapper,btn,leaf};
}
function nestedDrawerTabList(chains, extraAttrs={}) {
  return El('div',{class:'ovui-tabs__nav-list',rect:[600,40],attrs:{...extraAttrs}},chains.map(c=>c.wrapper));
}
function nestedDrawer(tabsNode,footerText='已选 0/30'){
  return El('div',{class:'ovui-drawer__wrap ovui-drawer__wrap--right',rect:[600,500]},[
    tabsNode,El('div',{rect:[600,40],text:footerText}),El('button',{rect:[100,30],text:'下一步'}),
  ]);
}
function makeNestedDrawer(activeIndex=0){
  const labels=['全部','店铺新品','破圈尖货 流量扶持','搜索趋势'];
  const chains=labels.map((label,index)=>nestedTab(label,{active:index===activeIndex}));
  return {chains,drawer:nestedDrawer(nestedDrawerTabList(chains))};
}
const totalClicks = node => (node.__clicks||0)+node.__kids.reduce((s,ch)=>s+totalClicks(ch),0);

test('run-plans nested tab tree: owner click for each of the four categories matches live evidence structure', () => {
  const targets=['全部','店铺新品','破圈尖货','搜索趋势'];
  const expected=[{clicked:false,alreadyActive:true},{clicked:true,alreadyActive:false},{clicked:true,alreadyActive:false},{clicked:true,alreadyActive:false}];
  targets.forEach((target,index)=>{
    const {chains,drawer}=makeNestedDrawer(0);
    const ctx=makeCtx([drawer]);
    const result=plain(ctx.run(rp.clickDrawerTabInPage,target));
    assert.deepEqual(result,expected[index],target+' 嵌套 owner 行为');
    chains.forEach((chain,ci)=>{
      const clicks=totalClicks(chain.wrapper);
      assert.equal(clicks,ci===index&&index!==0?1:0,target+' 仅 wrapper owner 最多一次原生 click，子孙零动作');
    });
    if (index!==0) assert.equal(chains[index].wrapper.__clicks,1,target+' 点击落在真实 wrapper owner');
  });
});

test('run-plans nested tab tree: descendants are not counted as extra independent candidates', () => {
  const {drawer}=makeNestedDrawer(0);
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品')),{clicked:true,alreadyActive:false});
});

test('run-plans nested tab tree: active flag on wrapper yields zero action, children without active do not flip twice', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===1}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains));
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品')),{clicked:false,alreadyActive:true});
  assert.equal(totalClicks(drawer),0,'已激活 owner 必须零动作');
});

test('run-plans nested tab tree: two independent same-name wrappers stop with zero clicks', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0}));
  const extra=nestedTab('店铺新品');
  const drawer=nestedDrawer(El('div',{class:'ovui-tabs__nav-list',rect:[600,40]},[...chains.map(c=>c.wrapper),extra.wrapper]));
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-not-unique:店铺新品/);
  assert.equal(totalClicks(extra.wrapper),0);
  assert.equal(totalClicks(chains[1].wrapper),0);
});

test('run-plans nested tab tree: hidden wrapper owner refuses with zero clicks', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0,wrapperHidden:index===1}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains));
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-not-visible:店铺新品/);
  assert.equal(totalClicks(chains[1].wrapper),0);
});

test('run-plans nested tab tree: disabled wrapper class refuses with zero clicks', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0,wrapperDisabled:index===1}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains));
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-disabled:店铺新品/);
  assert.equal(totalClicks(chains[1].wrapper),0);
});

test('run-plans nested tab tree: aria-disabled ancestor refuses with zero clicks', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains,{'aria-disabled':'true'}));
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-disabled:店铺新品/);
  assert.equal(totalClicks(chains[1].wrapper),0);
});

test('run-plans nested tab tree: missing product drawer (no footer) rejects identification', () => {
  const {chains}=makeNestedDrawer(0);
  const drawer=El('div',{class:'ovui-drawer__wrap',rect:[600,500]},[nestedDrawerTabList(chains)]);
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.clickDrawerTabInPage,'店铺新品'),/product-drawer-not-unique/);
});

test('run-plans nested tab tree: 搜索趋势推荐 and 流量扶持 modifiers resolve through the wrapper owner', () => {
  const labels=['全部','店铺新品 流量扶持','破圈尖货','搜索趋势推荐'];
  const chains=labels.map((label,index)=>nestedTab(label,{active:index===0}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains));
  const ctx=makeCtx([drawer]);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'搜索趋势')),{clicked:true,alreadyActive:false});
  assert.equal(chains[3].wrapper.__clicks,1);
  assert.equal(chains[3].btn.__clicks,undefined);
  assert.deepEqual(plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品')),{clicked:true,alreadyActive:false});
  assert.equal(chains[1].wrapper.__clicks,1);
});

test('run-plans nested tab tree: snapshot keeps a single correct activeTab label from the wrapper', () => {
  const chains=['全部','店铺新品','破圈尖货 流量扶持','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0}));
  const drawer=nestedDrawer(nestedDrawerTabList(chains));
  const ctx=makeCtx([drawer]);
  const initial=plain(ctx.run(rp.drawerSnapshotInPage));
  assert.equal(initial.ok,true);
  assert.deepEqual(initial.activeTabs,['全部']);
  chains[0].wrapper.className='ovui-tabs__tab';
  chains[1].wrapper.className='ovui-tabs__tab ovui-tabs__tab--active';
  const after=plain(ctx.run(rp.drawerSnapshotInPage));
  assert.equal(after.ok,true);
  assert.deepEqual(after.activeTabs,['店铺新品']);
});

test('run-plans reads the actual main-row product IDs and management plan data-row-key', () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5000+i));
  const heading=El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})]);
  const rows=ids.map(id=>El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: '+id+' 2个抖音号 管理手动添加抖音号'})]));
  const table=El('table',{rect:[900,900]},[heading,...rows]);
  const main=makeCtx([table]).run(rp.readMainTableInPage);
  assert.equal(main.ok,true);
  assert.equal(main.rows.length,30);
  assert.deepEqual(plain(main.rows.map(row=>row.productId)),ids);
  assert.ok(main.rows.every(row=>row.manualAccounts===2&&row.manualEvidence===true));

  const planName='2026-10-09_千川乘方_11:22:33';
  const navigator=El('div',{class:'qc-page-navigator-container',rect:[220,48],text:'千川账户 ID: 1710242295996424'});
  const managerRow=El('tr',{attrs:{'data-row-key':'1878537802445003'},rect:[900,60]},[
    El('td',{rect:[200,60],text:planName}),El('td',{rect:[220,60],text:'共30个商品 2个抖音号'}),El('td',{rect:[480,60],text:'ROI 15 日预算 300元 含达人佣金出价 商品 ID: 3845811625248555000 投放中'}),
  ]);
  const suffixRow=El('tr',{attrs:{'data-row-key':'1878537802445004'},rect:[900,60]},[
    El('td',{rect:[200,60],text:planName+'_extra'}),El('td',{rect:[220,60],text:'共30个商品 2个抖音号'}),El('td',{rect:[480,60],text:'ROI 15 日预算 300元 含达人佣金出价 投放中'}),
  ]);
  const readback=plain(makeCtx([navigator,El('table',{rect:[900,500]},[managerRow,suffixRow])]).run(rp.readManagementRowsInPage,planName));
  assert.equal(readback.accountId,'1710242295996424');
  assert.equal(readback.rowCount,1);
  assert.equal(readback.rows[0].planId,'1878537802445003','管理行键才是计划 ID，不能误取商品 ID');
  assert.equal(readback.rows[0].productCount,30);
  assert.equal(readback.rows[0].accountCount,2);
  assert.equal(readback.rows[0].roi,15);
  assert.equal(readback.rows[0].dailyBudget,300);
  assert.equal(readback.rows[0].commissionIncluded,true);
  assert.equal(readback.rows[0].status,'投放中');
  assert.equal(readback.rows[0].planName,planName,'actual exact plan-name cell text is returned');
  const suffixOnly=plain(makeCtx([navigator,El('table',{rect:[900,500]},[suffixRow])]).run(rp.readManagementRowsInPage,planName));
  assert.equal(suffixOnly.rowCount,0,'targetName_extra must not match targetName');

  const ambiguousCount=El('tr',{attrs:{'data-row-key':'1878537802445004'},rect:[900,60]},[
    El('td',{rect:[200,60],text:planName}),El('td',{rect:[700,60],text:'商品 ID: 3845811625248555000 商品 30 2个抖音号 ROI 15 日预算 300元 含达人佣金出价 投放中'}),
  ]);
  const notCounted=plain(makeCtx([navigator,El('table',{rect:[900,500]},[ambiguousCount])]).run(rp.readManagementRowsInPage,planName));
  assert.equal(notCounted.rows[0].productCount,null,'未标注商品数的近似数字不得被误当作30商品');
});

test('commission and direct-pay helpers climb empty wrappers and use native checkbox readback', async () => {
  const commission=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const commissionCtx=makeCtx([El('label',{text:'含达人佣金出价',rect:[180,24]},[El('div',{},[commission])])]);
  const commissionResult=await commissionCtx.run(rp.ensureCommissionInPage);
  assert.deepEqual(plain(commissionResult),{checked:true});
  assert.equal(commission.checked,true);
  assert.equal(commission.parent.parent.__clicks,1,'the unique native label is clicked once through the empty wrapper');

  const direct=El('input',{attrs:{type:'checkbox'},checked:true,rect:[12,12]});
  const directLabel=El('label',{text:'为店铺开启 货款直投升级版',rect:[200,40]},[El('div',{},[direct])]);
  const directCtx=makeCtx([directLabel]);
  assert.deepEqual(plain(await directCtx.run(rp.ensureDirectPayOffInPage)),{checked:false});
  assert.equal(direct.checked,false,'checked optional direct-pay is explicitly turned off and read back');
  assert.equal(directLabel.__clicks,1,'direct-pay requires and uses its unique owning label');
});

test('commission and direct-pay helpers confirm delayed native changes on replacement nodes without a second action', async () => {
  const delayedSwitch=(labelText,initial,target,helper)=>{
    const input=El('input',{attrs:{type:'checkbox'},checked:initial,rect:[12,12]});
    const wrapper=El('div',{},[input]);
    const label=El('label',{text:labelText,rect:[180,24]},[wrapper]);
    input.__controlled=true;
    input.__onToggle=next=>setTimeout(()=>{
      const replacement=El('input',{attrs:{type:'checkbox'},checked:target,rect:[12,12]});
      wrapper.__kids=[replacement];replacement.parent=wrapper;input.parent=null;
    },75);
    return {dom:makeCtx([label]),label,initial};
  };
  const commission=delayedSwitch('含达人佣金出价',false,true,rp.ensureCommissionInPage);
  assert.deepEqual(plain(await commission.dom.run(rp.ensureCommissionInPage)),{checked:true});
  assert.equal(commission.label.__clicks,1,'佣金原生动作最多一次');
  const direct=delayedSwitch('为店铺开启 货款直投升级版',true,false,rp.ensureDirectPayOffInPage);
  assert.deepEqual(plain(await direct.dom.run(rp.ensureDirectPayOffInPage)),{checked:false});
  assert.equal(direct.label.__clicks,1,'直投原生动作最多一次');
});

test('switch helpers leave target states untouched and fail closed on ambiguous or disabled native controls', async () => {
  const commissionOn=El('input',{attrs:{type:'checkbox'},checked:true,rect:[12,12]});
  const commissionLabel=El('label',{text:'含达人佣金出价',rect:[180,24]},[commissionOn]);
  assert.deepEqual(plain(await makeCtx([commissionLabel]).run(rp.ensureCommissionInPage)),{checked:true});
  assert.equal(commissionLabel.__clicks,undefined,'already-on commission causes zero actions');

  const directOff=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const directLabel=El('label',{text:'货款直投',rect:[180,24]},[directOff]);
  assert.deepEqual(plain(await makeCtx([directLabel]).run(rp.ensureDirectPayOffInPage)),{checked:false});
  assert.equal(directLabel.__clicks,undefined,'already-off direct pay causes zero actions');

  const unknownCommission=El('input',{attrs:{type:'checkbox'},rect:[12,12]});
  await assert.rejects(makeCtx([El('label',{text:'含达人佣金',rect:[180,24]},[unknownCommission])]).run(rp.ensureCommissionInPage),/commission-checkbox-state-unknown/);
  const unknownDirect=El('input',{attrs:{type:'checkbox'},rect:[12,12]});
  await assert.rejects(makeCtx([El('label',{text:'货款直投',rect:[180,24]},[unknownDirect])]).run(rp.ensureDirectPayOffInPage),/direct-pay-checkbox-state-unknown/);

  const ambiguousCommission=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const innerLabel=El('label',{text:'含达人佣金',rect:[180,24]},[ambiguousCommission]);
  const outerLabel=El('label',{text:'含达人佣金',rect:[200,32]},[innerLabel]);
  await assert.rejects(makeCtx([outerLabel]).run(rp.ensureCommissionInPage),/commission-native-label-not-unique/);
  assert.equal(outerLabel.__clicks,undefined,'ambiguous native label does not trigger an action');

  const dupA=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]}),dupB=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const dup=makeCtx([El('label',{text:'含达人佣金',rect:[180,24]},[dupA]),El('label',{text:'含达人佣金',rect:[180,24]},[dupB])]);
  await assert.rejects(dup.run(rp.ensureCommissionInPage),/commission-checkbox-not-unique/);
  assert.equal(dupA.parent.__clicks,undefined);assert.equal(dupB.parent.__clicks,undefined);

  const blocked=El('input',{attrs:{type:'checkbox'},checked:true,disabled:true,rect:[12,12]});
  const blockedLabel=El('label',{text:'货款直投',rect:[180,24]},[blocked]);
  await assert.rejects(makeCtx([blockedLabel]).run(rp.ensureDirectPayOffInPage),/direct-pay-checkbox-disabled/);
  assert.equal(blockedLabel.__clicks,undefined,'disabled control is never clicked');

  const disabledTarget=El('input',{attrs:{type:'checkbox'},checked:true,disabled:true,rect:[12,12]});
  await assert.rejects(makeCtx([El('label',{text:'含达人佣金',rect:[180,24]},[disabledTarget])]).run(rp.ensureCommissionInPage),/commission-checkbox-disabled/);
  const disabledOff=El('input',{attrs:{type:'checkbox'},checked:false,disabled:true,rect:[12,12]});
  await assert.rejects(makeCtx([El('label',{text:'货款直投',rect:[180,24]},[disabledOff])]).run(rp.ensureDirectPayOffInPage),/direct-pay-checkbox-disabled/);
});

test('switch helper gives up after one unconfirmed action instead of repeatedly flipping a controlled checkbox', async () => {
  const input=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});input.__controlled=true;input.__onToggle=()=>{};
  const label=El('label',{text:'含达人佣金',rect:[180,24]},[input]);
  await assert.rejects(makeCtx([label]).run(rp.ensureCommissionInPage),/commission-check-not-confirmed/);
  assert.equal(label.__clicks,1,'bounded polling does not repeat the native action');
});

test('picker entry clicks the historical empty-page native 添加商品 button exactly once and never a business button', () => {
  const title=El('p',{rect:[220,28],text:'选择要投放的商品'});
  const entry=El('button',{class:'ovui-button ovui-button--primary ovui-button--primary-fill',rect:[110,32],text:'添加商品'});
  const hint=El('div',{rect:[400,40],text:'暂无商品，点击上方按钮可添加多个商品'});
  const exclude1=El('button',{class:'ovui-button ovui-button--disabled',rect:[56,22],text:'手动排除',disabled:true});
  const exclude2=El('button',{class:'ovui-button ovui-button--disabled',rect:[56,22],text:'手动排除',disabled:true});
  const publish=El('button',{rect:[120,34],text:'发布计划'});
  const cancel=El('button',{rect:[120,34],text:'取消'});
  const nav=El('button',{rect:[94,42],text:'品牌投放'});
  const ctx=makeCtx([nav,title,entry,hint,exclude1,exclude2,publish,cancel]);
  assert.equal(ctx.run(rp.openPickerInPage),true);
  assert.equal(entry.__clicks,1,'the unique enabled native entry receives exactly one native click');
  assert.equal(publish.__clicks,undefined,'publish must never be touched by picker opening');
  assert.equal(cancel.__clicks,undefined);
  assert.equal(exclude1.__clicks,undefined);assert.equal(exclude2.__clicks,undefined);assert.equal(nav.__clicks,undefined);
});

test('picker entry clicks the continuation 继续添加商品 button and a semantic role=button entry', () => {
  const title=El('p',{rect:[220,28],text:'选择要投放的商品 继续添加商品 已添加：30/30'});
  const entry=El('button',{class:'ovui-button',rect:[120,32],text:'继续添加商品'});
  const publish=El('button',{rect:[120,34],text:'发布计划'});
  const ctx=makeCtx([title,entry,publish]);
  assert.equal(ctx.run(rp.openPickerInPage),true);
  assert.equal(entry.__clicks,1);assert.equal(publish.__clicks,undefined);

  const semantic=El('div',{attrs:{role:'button'},rect:[110,32],text:'添加商品'});
  const semCtx=makeCtx([El('p',{rect:[220,28],text:'选择要投放的商品'}),semantic]);
  assert.equal(semCtx.run(rp.openPickerInPage),true);
  assert.equal(semantic.__clicks,1,'visible semantic button entry is accepted deterministically');
});

test('picker entry stops with zero clicks on title-only text, duplicate candidates and mixed entries', () => {
  const title=El('p',{rect:[220,28],text:'选择要投放的商品'});
  const heading=El('div',{rect:[200,24],text:'添加商品'});
  const hint=El('div',{rect:[400,40],text:'暂无商品，点击上方按钮可添加多个商品'});
  const titleOnly=makeCtx([title,heading,hint]);
  assert.throws(()=>titleOnly.run(rp.openPickerInPage),/product-picker-entry-not-unique/);
  assert.equal(title.__clicks,undefined);assert.equal(heading.__clicks,undefined,'a text title is never a clickable entry');

  const titledButton=El('div',{attrs:{role:'button'},rect:[220,28],text:'选择要投放的商品'});
  assert.throws(()=>makeCtx([titledButton]).run(rp.openPickerInPage),/product-picker-entry-not-unique/);
  assert.equal(titledButton.__clicks,undefined,'the paragraph title text is not accepted as an entry label');

  const dupA=El('button',{rect:[110,32],text:'添加商品'}),dupB=El('button',{rect:[110,32],text:'添加商品'});
  assert.throws(()=>makeCtx([dupA,dupB]).run(rp.openPickerInPage),/product-picker-entry-not-unique/);
  assert.equal(dupA.__clicks,undefined);assert.equal(dupB.__clicks,undefined,'duplicate candidates receive no fallback first-click');

  const contA=El('button',{rect:[120,32],text:'继续添加商品'}),contB=El('button',{rect:[110,32],text:'添加商品'});
  assert.throws(()=>makeCtx([contA,contB]).run(rp.openPickerInPage),/product-picker-entry-not-unique/);
  assert.equal(contA.__clicks,undefined);assert.equal(contB.__clicks,undefined,'mixed empty/continuation entries are ambiguous and stop');
});

test('picker entry excludes hidden candidates, clicks only the visible one, and stops on disabled entries with zero clicks', () => {
  const hidden=El('button',{rect:[110,32],text:'添加商品',hidden:true});
  assert.throws(()=>makeCtx([hidden]).run(rp.openPickerInPage),/product-picker-entry-not-unique/);
  assert.equal(hidden.__clicks,undefined,'a hidden entry is never clicked');

  const visible=El('button',{rect:[110,32],text:'添加商品'});
  const ctx=makeCtx([El('p',{rect:[220,28],text:'选择要投放的商品'}),hidden,visible]);
  assert.equal(ctx.run(rp.openPickerInPage),true);
  assert.equal(visible.__clicks,1);assert.equal(hidden.__clicks,undefined,'visibility filtering is deterministic');

  const disabledNative=El('button',{rect:[110,32],text:'添加商品',disabled:true});
  assert.throws(()=>makeCtx([disabledNative]).run(rp.openPickerInPage),/product-picker-entry-disabled/);
  assert.equal(disabledNative.__clicks,undefined,'a disabled native entry is never clicked');

  const ariaDisabled=El('div',{attrs:{role:'button','aria-disabled':'true'},rect:[110,32],text:'添加商品'});
  assert.throws(()=>makeCtx([ariaDisabled]).run(rp.openPickerInPage),/product-picker-entry-disabled/);
  assert.equal(ariaDisabled.__clicks,undefined);
});

test('picker entry stops on unauthorized origin or path before any click', () => {
  const entry=El('button',{rect:[110,32],text:'添加商品'});
  const wrongPath=makeCtx([entry],{pathname:'/uni-prom/overall'});
  assert.throws(()=>wrongPath.run(rp.openPickerInPage),/not-authorized-creation-page/);
  assert.equal(entry.__clicks,undefined);
  const wrongOrigin=makeCtx([entry],{origin:'https://qianchuan.jinritemai.com.evil.test'});
  assert.throws(()=>wrongOrigin.run(rp.openPickerInPage),/not-authorized-creation-page/);
  assert.equal(entry.__clicks,undefined,'the exact authorized creation route gate stays enforced');
});

test('real browseProducts opens a closed picker through the exported native 添加商品 entry, fills 30 and submits without touching publish', async () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5300+i));
  const title=El('p',{rect:[220,28],text:'选择要投放的商品'});
  const entry=El('button',{class:'ovui-button ovui-button--primary-fill',rect:[110,32],text:'添加商品'});
  const publish=El('button',{rect:[120,34],text:'发布计划'});
  const cancel=El('button',{rect:[120,34],text:'取消'});
  const dom=makeCtx([title,entry,publish,cancel]);
  const selected=new Set();let opened=false,submitClicks=0,selectCalls=0,entryEvaluations=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.openPickerInPage){entryEvaluations++;const r=dom.run(fn);if(entry.__clicks===1)opened=true;return r;}
    if(fn===rp.drawerSnapshotInPage){
      if(!opened)return {ok:false,reason:'picker-not-open'};
      if(submitClicks>0)return {ok:false,reason:'closed'};
      return {ok:true,cards:ids.map(id=>({id,text:'可投商品 ID: '+id,checked:selected.has(id),checkboxCount:1,disabled:false})),selectedCount:selected.size,remainingCapacity:30,activeTabs:['全部']};
    }
    if(fn===rp.selectNativeCardInPage){selectCalls++;selected.add(String(arg));return {id:String(arg),checked:true};}
    if(fn===rp.classifyAndCancelAutoPullInPage)return {kind:'none',productIds:[]};
    if(fn===c.pageObserve)return {observation:'obs-entry-1',url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage:1,pageCount:1,modalPresent:true,inProductModal:true,items:[]},elements:[{text:'下一步',tag:'BUTTON',index:4}]};
    if(fn===c.actionApply){submitClicks++;return {clicked:true};}
    if(fn===rp.readMainTableInPage)return submitClicks>0?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    throw new Error('unexpected picker evaluate '+(fn.name||String(fn).slice(0,30)));
  }};
  const dayState={lastSelected:[],attempted:[],cursor:{category:'全部',page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}});
  assert.equal(result.ok,true);assert.equal(result.selectedIds.length,30);
  assert.equal(entryEvaluations,1,'the closed initial drawer read is followed by exactly one native entry action');
  assert.equal(entry.__clicks,1,'the historical empty-page native button is what opens the drawer');
  assert.equal(selectCalls,30);assert.equal(submitClicks,1);
  assert.equal(publish.__clicks,undefined);assert.equal(cancel.__clicks,undefined,'no publish or cancel business button is touched');
});

test('real browseProducts stops with zero selection when the empty-page entry is ambiguous or off-route', async () => {
  const mkDriver=(dom,entryIds)=>{
    const selected=new Set();let opened=false,submitClicks=0,selectCalls=0;
    const page={evaluate:async(fn,arg)=>{
      if(fn===rp.openPickerInPage){const r=dom.run(fn);if([...entryIds].some(id=>dom.body.__kids.find(b=>b.__seq===id&&b.__clicks>0)))opened=true;return r;}
      if(fn===rp.drawerSnapshotInPage){
        if(!opened)return {ok:false,reason:'picker-not-open'};
        if(submitClicks>0)return {ok:false,reason:'closed'};
        return {ok:true,cards:[],selectedCount:0,remainingCapacity:30,activeTabs:['全部']};
      }
      if(fn===rp.selectNativeCardInPage){selectCalls++;return {checked:true};}
      throw new Error('unexpected picker evaluate '+(fn.name||String(fn).slice(0,30)));
    }};
    const dayState={lastSelected:[],attempted:[],cursor:{category:'全部',page:1,seenProductIds:[]}};
    const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
    return {driver,counters:()=>({opened,selectCalls})};
  };
  const dupA=El('button',{rect:[110,32],text:'添加商品'}),dupB=El('button',{rect:[110,32],text:'添加商品'});
  const dupDom=makeCtx([El('p',{rect:[220,28],text:'选择要投放的商品'}),dupA,dupB]);
  const dupRun=mkDriver(dupDom,[dupA.__seq,dupB.__seq]);
  await assert.rejects(dupRun.driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}}),/product-picker-entry-not-unique/);
  assert.equal(dupA.__clicks,undefined);assert.equal(dupB.__clicks,undefined);
  assert.deepEqual(dupRun.counters(),{opened:false,selectCalls:0},'ambiguous entries open nothing and select nothing');

  const offRouteEntry=El('button',{rect:[110,32],text:'添加商品'});
  const offDom=makeCtx([offRouteEntry],{pathname:'/uni-creation/other'});
  const offRun=mkDriver(offDom,[offRouteEntry.__seq]);
  await assert.rejects(offRun.driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}}),/not-authorized-creation-page/);
  assert.equal(offRouteEntry.__clicks,undefined);
  assert.deepEqual(offRun.counters(),{opened:false,selectCalls:0},'a non-authorized route performs zero dangerous actions');
});

test('configurePlan fills ROI and budget through the real observer and current actionApply observation', async () => {
  const dom=makeCtx(configureCreationFixture());
  const page={evaluate:async(fn,arg)=>dom.run(fn,arg)};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.configurePlan({businessDate:'2026-10-09'});
  assert.equal(result.ok,true,JSON.stringify(result));
  const verified=dom.run(c.pageObserve).creation;
  assert.equal(verified.roi,'15');assert.equal(verified.budget,'300');
  assert.equal(verified.commissionChecked,true);assert.equal(verified.optionalDirectPayChecked,false);
  assert.equal(verified.planName,result.planName);
});

test('real actionApply rejects the observation from before a direct-pay state change, then accepts fresh ROI evidence', async () => {
  const dom=makeCtx(configureCreationFixture());
  const before=dom.run(c.pageObserve);
  await dom.run(rp.ensureDirectPayOffInPage);
  const fresh=dom.run(c.pageObserve);
  const roi=fresh.elements.find(e=>e.fillField&&e.fillField.recognized&&e.fillField.kind==='roi');
  assert.ok(roi,'real observer must identify the ROI field');
  assert.notEqual(fresh.observation,before.observation,'a fresh DOM observation receives a distinct guard token');
  assert.throws(()=>dom.run(c.actionApply,{observation:before.observation,index:roi.index,op:'fill',value:'15'}),/Observation expired/);
  const result=dom.run(c.actionApply,{observation:fresh.observation,index:roi.index,op:'fill',value:'15'});
  assert.equal(result.filled,true);assert.equal(result.field,'roi');
});

test('draft deletion helpers reject management route/unknown identity, fall back to the narrow account nav, and acknowledge immediate no-dialog removal', () => {
  const id='3845811625248555001';
  const nav=El('div',{class:'qc-page-navigator-container',rect:[220,40],text:'千川账户 ID: 1710242295996424'});
  const del=El('button',{text:'删除',rect:[60,24]});
  const row=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: '+id}),del]);
  const table=El('table',{rect:[900,500]},[El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})]),row]);
  // management origin/path must never receive draft removal clicks
  const wrong=makeCtx([nav,table],{pathname:'/uni-prom/overall'});
  assert.throws(()=>wrong.run(rp.removeNativeCardInPage,id),/not-authorized-creation-route/);
  assert.equal(del.__clicks,undefined,'same-looking management page cannot receive draft removal clicks');
  // wrong account id in the header is unknown identity => zero clicks
  const badNav=El('div',{class:'qc-page-navigator-container',rect:[220,40],text:'千川账户 ID: 9999999999999999'});
  assert.throws(()=>makeCtx([badNav,table]).run(rp.removeNativeCardInPage,id),/account-identity-unknown/);
  // no aavid => URL/route alone is never account confirmation
  const noAavid=makeCtx([nav,table],{search:''});
  assert.throws(()=>noAavid.run(rp.removeNativeCardInPage,id),/account-identity-unknown/);
  // the real creation page header may lack .qc-page-navigator-container: narrow .qc-navigator-account fallback proves identity
  const fallbackNav=El('div',{class:'qc-navigator-account',rect:[220,40],text:'账户 ID：1710242295996424'});
  assert.deepEqual(plain(makeCtx([fallbackNav,table]).run(rp.removeNativeCardInPage,id)),{clicked:true,productId:id},'最窄回退导航可证明真实创建页身份');
  assert.equal(del.__clicks,1);
  // immediate removal: the row is already gone and there is NO dialog => acknowledged, not an error
  const after=El('table',{rect:[900,500]},[El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})])]);
  assert.deepEqual(plain(makeCtx([nav,after]).run(rp.confirmDraftRemovalInPage,id)),{noDialog:true},'已即时移除的行不得被要求仍存在');
  // a matching deletion-confirm dialog is still clicked exactly once
  const confirm=El('div',{attrs:{role:'dialog'},rect:[300,180],text:'确认删除商品 ID: '+id},[El('button',{text:'确定',rect:[60,24]})]);
  assert.equal(plain(makeCtx([nav,table,confirm]).run(rp.confirmDraftRemovalInPage,id)).confirmed,true);
  assert.equal(confirm.querySelectorAll('button')[0].__clicks,1);
});

test('draft removal confirm rejects an unknown modal and never lets a conflicting legacy header fall back to the narrow nav', () => {
  const id='3845811625248555001';
  const nav=El('div',{class:'qc-page-navigator-container',rect:[220,40],text:'千川账户 ID: 1710242295996424'});
  const empty=El('table',{rect:[900,500]},[El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})])]);
  // no dialog + row absent => normal immediate removal
  assert.deepEqual(plain(makeCtx([nav,empty]).run(rp.confirmDraftRemovalInPage,id)),{noDialog:true},'即时移除无对话框仍为正常');
  // a present-but-unrecognised modal (does not name the product) is NOT reported as noDialog
  const unknown=El('div',{class:'modal',attrs:{role:'dialog'},rect:[300,180],text:'未知操作确认'},[El('button',{text:'我知道了',rect:[60,24]})]);
  assert.throws(()=>makeCtx([nav,empty,unknown]).run(rp.confirmDraftRemovalInPage,id),/draft-remove-unknown-modal/,'未知模态不得当作已确认移除');
  assert.equal(unknown.querySelectorAll('button')[0].__clicks,undefined,'未知模态零点击');
  // the narrow .qc-navigator-account may NOT override a conflicting legacy header (fallback only when legacy absent)
  const badLegacy=El('div',{class:'qc-page-navigator-container',rect:[220,40],text:'千川账户 ID: 9999999999999999'});
  const goodNarrow=El('div',{class:'qc-navigator-account',rect:[220,40],text:'账户 ID：1710242295996424'});
  const del=El('button',{text:'删除',rect:[60,24]});
  const row=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: '+id}),del]);
  const table=El('table',{rect:[900,500]},[El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})]),row]);
  assert.throws(()=>makeCtx([badLegacy,goodNarrow,table]).run(rp.removeNativeCardInPage,id),/account-identity-unknown/,'冲突旧头不得被窄导航覆盖回退');
  assert.equal(del.__clicks,undefined,'冲突身份零删除点击');
});

test('real main-table collector exposes migration, precheck and hard review evidence, then prepare freeze discloses risks by exact product id', async () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5000+i));
  const heading=El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})]);
  const rows=ids.map((id,i)=>El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: '+id+' 2个抖音号 管理抖音号'+(i===0?' 该商品已创建「全店托管」计划':i===1?' 根据系统前置检测，当前商品可能审核不通过':i===2?' 当前商品广告审核不通过':'' )})]));
  const table=El('table',{rect:[900,900]},[heading,...rows]);
  const collected=plain(makeCtx([table]).run(rp.readMainTableInPage));
  assert.equal(collected.rows[0].migrationWarning,true);
  assert.equal(collected.rows[1].precheckRisk,true);
  assert.equal(collected.rows[2].reviewFailed,true);
  assert.equal(wf.evaluateReadiness(collected.rows,30).reviewFailedIds.includes(ids[2]),true,'hard row signal remains a hard readiness failure');

  const validRows=collected.rows.map(row=>({...row,reviewFailed:false}));
  const date='2026-10-09';
  const prepared=await wf.preparePlan({planNumber:1,runId:'offline-risk-merge',businessDate:date,dayState:wf.newDayState(date),
    openCreationPage:async()=>({header:{originOk:true,accountId:wf.BUSINESS.accountId,commissionOptionPresent:true}}),
    browseProducts:async()=>({ok:true,selectedIds:ids,hints:{},attempted:[],cursor:{category:'全部',page:1}}),
    bindAccountsToAll:async()=>({ok:true,partial:true}),readMainTable:async()=>validRows,
    repairDraft:async()=>{throw new Error('ready rows should not need repair');},configurePlan:async()=>({ok:true,planName:'offline-exact-risk'}),persistState:async()=>{},
  });
  assert.equal(prepared.status,'ready-awaiting-confirmation');
  assert.deepEqual(prepared.frozen.disclosures.migration,[ids[0]]);
  assert.deepEqual(prepared.frozen.disclosures.precheck,[ids[1]],'main-table precheck is disclosed without becoming a hard failure');
});

test('real binding driver returns a fresh 29+1 partial batch so workflow repair is reachable', async () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const rows=ids.map((productId,i)=>({productId,manualAccounts:i===29?0:2,manualEvidence:i!==29,manualCountKnown:true,autoPullOnly:i===29,reviewFailed:false,text:'fresh row '+productId}));
  const accountIds=wf.BUSINESS.boundAccounts;
  const snap={ok:true,rows:accountIds.map(id=>({ids:[id],checked:false})),headerSelectAllCount:1,selectedCount:0,totalCount:30,batchButtonCount:1,batchEnabled:true,panelProductIds:ids,activeProductIds:[ids[0]]};
  let confirmed=0,modalConfirmed=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows};
    if(fn===rp.bindingDrawerSnapshotInPage)return {...snap,rows:snap.rows.map(row=>({...row}))};
    if(fn===rp.selectAllAccountsInPage){snap.rows.forEach(row=>{row.checked=true;});snap.selectedCount=2;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage)return {clicked:true};
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:true};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage)return {present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,failedIds:[ids[29]],successCount:28};
    if(fn===rp.acknowledgeBatchResultInPage)return {present:true,acked:true,failedIds:[ids[29]],successCount:28};
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected fake page function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.bindAccountsToAll({productIds:ids});
  assert.equal(result.ok,true,'batch application plus fresh row readback is acknowledged independently from full readiness');
  assert.equal(result.batchApplied,true);
  assert.equal(result.partial,true);
  assert.equal(confirmed,1,'抽屉草稿确定恰好一次');
  assert.equal(modalConfirmed,1,'独立批量确认模态确定恰好一次');
  assert.equal(result.rows.length,30);
  assert.equal(result.rows[29].manualAccounts,0);
});

function controlledSelectHost({neverLand=false,landAfter=1,timeoutMs=3000}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5800+i));
  const entry=El('button',{class:'ovui-button ovui-button--primary-fill',rect:[110,32],text:'添加商品'});
  const dom=makeCtx([El('p',{rect:[220,28],text:'选择要投放的商品'}),entry]);
  let opened=false,submitClicks=0,selectCalls=0,drawerReads=0;
  const pending=new Map(),landed=new Set();
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.openPickerInPage){dom.run(fn);opened=true;return true;}
    if(fn===rp.drawerSnapshotInPage){
      if(!opened)return {ok:false,reason:'picker-not-open'};
      if(submitClicks>0)return {ok:false,reason:'closed'};
      drawerReads++;
      // Each read builds FRESH card objects (models DOM replacement); a pending id
      // only reports checked after landAfter reads, never on the click evaluate.
      const cards=ids.map(id=>{
        if(pending.has(id)&&!neverLand){const left=pending.get(id)-1;if(left<=0){pending.delete(id);landed.add(id);}else pending.set(id,left);}
        return {id,text:'可投商品 ID: '+id,checked:landed.has(id),checkboxCount:1,disabled:false};
      });
      return {ok:true,cards,selectedCount:landed.size,remainingCapacity:30,activeTabs:['全部']};
    }
    if(fn===rp.selectNativeCardInPage){selectCalls++;pending.set(String(arg),landAfter);return {id:String(arg),clicked:true,checkedNow:false,pending:true};}
    if(fn===rp.classifyAndCancelAutoPullInPage)return {kind:'none',productIds:[]};
    if(fn===c.pageObserve)return {observation:'obs',url:'https://qianchuan.jinquitemai.invalid/',pagination:{currentPage:1,pageCount:1,modalPresent:true,inProductModal:true,items:[{kind:'next',index:0,disabled:true}]},elements:[{text:'下一步',tag:'BUTTON',index:4}]};
    if(fn===c.actionApply){submitClicks++;return {clicked:true};}
    if(fn===rp.readMainTableInPage)return submitClicks>0?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    throw new Error('unexpected controlled select evaluate '+(fn.name||String(fn).slice(0,30)));
  }};
  const dayState={lastSelected:[],attempted:[],cursor:{category:'全部',page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,ids,state:()=>({selectCalls,drawerReads,landed:landed.size,submitClicks})};
}

test('select driver confirms selection only through a bounded FRESH re-read (async landing + node replacement), one click each', async () => {
  const h=controlledSelectHost({landAfter:1,timeoutMs:3000});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}});
  assert.equal(result.ok,true);assert.equal(result.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.selectCalls,30,'每份商品只点击一次原生label/input，确认来自后续独立回读');
  assert.equal(s.landed,30);
  assert.ok(s.drawerReads>s.selectCalls,'确认必须由点击之后的多次fresh回读完成，而非点击即判');
});

test('select driver stops as readback-failed with NO reverse toggle when the controlled checkbox never lands', async () => {
  const h=controlledSelectHost({neverLand:true,timeoutMs:600});
  await assert.rejects(h.driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}}),/native-checkbox-readback-failed/);
  assert.equal(h.state().selectCalls,1,'未落稳的第一份即停止，绝不二次toggle反向取消');
});

function controlledAccountHost({headerPartial=false,batchNever=false,batchDelay=0,resultDelay=0,resultNever=false,resultUnknown=false,timeoutMs=3000}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const rows=ids.map((productId,i)=>({productId,manualAccounts:i===29?0:2,manualEvidence:i!==29,manualCountKnown:true,autoPullOnly:i===29,reviewFailed:false,text:'fresh row '+productId}));
  const accountIds=wf.BUSINESS.boundAccounts;
  const snap={ok:true,rows:accountIds.map(id=>({ids:[id],checked:false})),headerSelectAllCount:1,selectedCount:0,totalCount:30,batchButtonCount:1,batchEnabled:true,panelProductIds:ids,activeProductIds:[ids[0]]};
  let confirmed=0,modalConfirmed=0,applyCalls=0,selectAllCalls=0,postBatchReads=0,resultReads=0,resultAcks=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows};
    if(fn===rp.bindingDrawerSnapshotInPage)return {...snap,rows:snap.rows.map(r=>({...r}))};
    if(fn===rp.selectAllAccountsInPage){selectAllCalls++;snap.rows.forEach((row,i)=>{row.checked=headerPartial?i===0:true;});snap.selectedCount=headerPartial?1:2;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage){postBatchReads++;const settled=snap.selectedCount===2&&!batchNever&&postBatchReads>=batchDelay;return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:settled};}
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage){
      resultReads++;
      if(resultNever)return {present:false,known:false,settled:false,uniqueCount:0,failedIds:[],successCount:0};
      if(resultUnknown)return {present:true,known:false,settled:false,reason:'batch-result-modal-unknown',uniqueCount:0,failedIds:[],successCount:0};
      const settled=!resultNever&&resultReads>=Math.max(1,resultDelay);
      return {present:true,known:true,settled,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,failedIds:[ids[29]],successCount:28};
    }
    if(fn===rp.acknowledgeBatchResultInPage){resultAcks++;return {present:true,acked:true,failedIds:[ids[29]],successCount:28};}
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected fake page function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({confirmed,modalConfirmed,applyCalls,selectAllCalls,resultAcks,resultReads})};
}

test('bind driver waits for the batch confirm modal to settle, then commits exactly once', async () => {
  const h=controlledAccountHost({batchDelay:2,timeoutMs:3000});
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  assert.equal(h.state().modalConfirmed,1,'独立批量确认模态确定恰好一次');
  assert.equal(h.state().confirmed,1,'抽屉草稿确定恰好一次');
});

test('bind driver performs ZERO submit when the batch confirm modal never settles', async () => {
  const h=controlledAccountHost({batchNever:true,timeoutMs:600});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'native-batch-apply-modal-not-confirmed');
  const s=h.state();assert.equal(s.modalConfirmed,0);assert.equal(s.confirmed,0,'模态未落稳不得点任何确定');
});

test('bind driver accepts a consistent min-1 selection but refuses a stale batch modal that still claims 2 accounts', async () => {
  const h=controlledAccountHost({headerPartial:true,timeoutMs:600});
  const result=await h.bind();
  // R32/binding-3plus: one checked row of a displayed pair is a legitimate min-1
  // selection, so the header fresh-wait now settles; the stale modal (2 declared vs
  // 1 actually checked) must still stop before ANY confirm.
  assert.equal(result.ok,false);assert.equal(result.reason,'native-batch-apply-modal-not-confirmed');
  const s=h.state();
  assert.equal(s.modalConfirmed,0,'模态账号数与实际勾选数不一致绝不点确定');
  assert.equal(s.confirmed,0,'草稿绝不提交');
});

test('bind driver bounded-waits for a DELAYED settled result before acknowledging once and committing once', async () => {
  const h=controlledAccountHost({resultDelay:2,timeoutMs:3000});
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.partial,true);
  const s=h.state();
  assert.ok(s.resultReads>=2,'异步结果必须经多次只读回读落稳，而非首次即判');
  assert.equal(s.resultAcks,1,'落稳后我知道了恰好一次');
  assert.equal(s.confirmed,1,'结果确认后草稿确定恰好一次');
});

test('bind driver performs ZERO acknowledge and ZERO commit while the async result never settles', async () => {
  const h=controlledAccountHost({resultNever:true,timeoutMs:600});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-pending-or-unknown-not-confirmed','缺结果=待定而非成功');
  const s=h.state();
  assert.equal(s.resultAcks,0,'结果未落稳绝不点我知道了');
  assert.equal(s.confirmed,0,'结果未落稳绝不点草稿确定');
});

test('bind driver performs ZERO acknowledge and ZERO commit on an UNKNOWN result modal', async () => {
  const h=controlledAccountHost({resultUnknown:true,timeoutMs:600});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-pending-or-unknown-not-confirmed');
  const s=h.state();
  assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0,'未知结果模态不确认不提交');
});

function accountDriftHost({drift='none',delay=2,timeoutMs=600}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mainRows=ids.map((productId)=>({productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false,text:'fresh row '+productId}));
  const GOOD=['79863866','9zmao_fushi'];
  let headerCalls=0,applyCalls=0,confirmed=0,modalConfirmed=0,snapReads=0;
  const checked=[false,false];
  const currentIds=()=>{
    const drifted=(drift==='header'&&snapReads>=delay)||(drift==='batch'&&applyCalls>0);
    return drifted?['01234567',GOOD[1]]:GOOD.slice();
  };
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:mainRows};
    if(fn===rp.bindingDrawerSnapshotInPage){
      snapReads++;
      const curIds=currentIds();
      return {ok:true,rows:[{ids:[curIds[0]],checked:checked[0]},{ids:[curIds[1]],checked:checked[1]}],headerSelectAllCount:1,selectedCount:checked.every(Boolean)?2:0,totalCount:30,batchButtonCount:1,batchEnabled:true,panelProductIds:ids,activeProductIds:[ids[0]]};
    }
    if(fn===rp.selectAllAccountsInPage){headerCalls++;checked[0]=true;checked[1]=true;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage){const cur=currentIds();const settled=cur[0]===GOOD[0]&&cur[1]===GOOD[1]&&checked.every(Boolean);return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:settled};}
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage)return {present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,failedIds:[],successCount:29};
    if(fn===rp.acknowledgeBatchResultInPage)return {present:true,acked:true,failedIds:[],successCount:29};
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected drift account function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({headerCalls,applyCalls,confirmed,modalConfirmed,snapReads})};
}

test('bind driver stops before batch apply when an account ID drifts during the header fresh wait', async () => {
  const h=accountDriftHost({drift:'header'});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'native-header-select-all-not-confirmed','header等待期间账号ID改变不得沿用初次snap或数量常量');
  const s=h.state();
  assert.equal(s.applyCalls,0,'ID漂移后绝不批量应用');assert.equal(s.confirmed,0,'ID漂移后绝不submit');assert.equal(s.modalConfirmed,0);
});

test('bind driver stops before submit when an account ID drifts during the batch modal fresh wait', async () => {
  const h=accountDriftHost({drift:'batch'});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'native-batch-apply-modal-not-confirmed','batch模态等待期间账号ID改变必须停止');
  const s=h.state();
  assert.equal(s.modalConfirmed,0,'batch后ID漂移绝不点模态确定');assert.equal(s.confirmed,0,'batch后ID漂移绝不点抽屉确定');
});

test('bind driver still submits exactly once for the correct two accounts (1 header, 1 batch, 1 modal, 1 commit)', async () => {
  const h=accountDriftHost({drift:'none',timeoutMs:3000});
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  const s=h.state();
  assert.equal(s.headerCalls,1);assert.equal(s.applyCalls,1);assert.equal(s.modalConfirmed,1);assert.equal(s.confirmed,1,'精确两账号只各一次表头/批量按钮/模态确定/草稿确定');
});

// R25 root cause: on a FULL-success batch the platform shows NO per-product result popup, so the
// settled-result wait times out. The driver must NOT read "no popup" as success and must NOT bypass
// any guard: it proves completion by bounded read-only .panel navigation across the batch's known
// 30 ids (each target shows the exact two accounts checked at 2/30, the same 30-panel set, a single
// active === the target), restores the original anchor, and only THEN does the drawer 确定 + full
// main-table readback (failedIds empty derived from that 30 proof). Any mid-probe anomaly stops with
// ZERO acknowledge and ZERO drawer commit. This host reproduces those live shapes offline; `fault`
// injects one anomaly at panel index `at`.
function allSuccessNoResultModalHost({fault='none',at=5,timeoutMs=120}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const GOOD=wf.BUSINESS.boundAccounts;
  const mainRowsPre=ids.map((productId)=>({productId,manualAccounts:0,manualEvidence:false,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const mainRowsPost=ids.map((productId)=>({productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  let headerDone=false,batchDone=false,committed=false,confirmed=0,modalConfirmed=0,resultAcks=0,overlayChecks=0;
  let selectCalls=0,probeActive=ids[0],panelReads=0,navClicks=0;
  const faultActive=()=>batchDone&&String(probeActive)===String(ids[at]);
  const panelSetFor=()=>faultActive()&&fault==='foreignPanel'?ids.map((id,i)=>i===12?'399999999999999':id):ids.slice();
  const rowsFor=()=>{
    // Every synthetic row carries the CURRENT contract's explicit LABEL-disabled state
    // (boundedAccountsReadBack requires a definite true|false on each row); the fault
    // branches below then inject the drift/partial/footer anomaly they are about.
    if(!headerDone) return GOOD.map(id=>({ids:[id],checked:false,labelDisabled:false}));
    if(faultActive()&&fault==='account') return [{ids:['01234567'],checked:true,labelDisabled:false},{ids:[GOOD[1]],checked:true,labelDisabled:false}];
    if(faultActive()&&fault==='partial') return [{ids:[GOOD[0]],checked:true,labelDisabled:false},{ids:[GOOD[1]],checked:false,labelDisabled:false}];
    return GOOD.map(id=>({ids:[id],checked:true,labelDisabled:false}));
  };
  const countsFor=()=>{
    if(!headerDone) return {selectedCount:0,totalCount:30};
    if(faultActive()&&fault==='footer') return {selectedCount:2,totalCount:29};
    if(faultActive()&&fault==='missingSelected') return {selectedCount:1,totalCount:30};
    return {selectedCount:2,totalCount:30};
  };
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:committed?mainRowsPost:mainRowsPre};
    if(fn===rp.bindingDrawerSnapshotInPage){
      panelReads++;
      const c=countsFor();
      return {ok:true,rows:rowsFor().map(r=>({...r,ids:r.ids.slice()})),headerSelectAllCount:1,headerLabelDisabled:false,
        selectedCount:c.selectedCount,totalCount:c.totalCount,batchButtonCount:1,batchEnabled:true,
        panelProductIds:panelSetFor(),activeProductIds:[probeActive]};
    }
    if(fn===rp.selectAllAccountsInPage){headerDone=true;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage)return {clicked:true};
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:headerDone};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;batchDone=true;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage)return {present:false,known:false,settled:false,rowCount:0,uniqueCount:0,outside:0,duplicate:false,ambiguous:0,anchorMismatch:false,failedIds:[],successCount:0};
    if(fn===rp.acknowledgeBatchResultInPage){resultAcks++;return {present:true,acked:true,failedIds:[],successCount:29};}
    if(fn===rp.bindingOverlaySnapshotInPage){
      overlayChecks++;
      const blocking=fault==='newModal'&&selectCalls>at;
      return {accountDrawerCount:1,blockingOverlayPresent:blocking};
    }
    if(fn===rp.selectBindingDrawerPanelInPage){
      if(fault==='navReject'&&selectCalls>=at) throw new Error('account-drawer-not-unique');
      selectCalls++;probeActive=String(arg);navClicks++;return {clicked:true,id:String(arg)};
    }
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;committed=true;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected all-success function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,ids,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({confirmed,modalConfirmed,resultAcks,overlayChecks,selectCalls,navClicks,panelReads})};
}

test('R25 all-success no result modal proves all 30 panels by read-only navigation, then commits once (zero ACK)', async () => {
  const h=allSuccessNoResultModalHost({timeoutMs:120});
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  assert.deepEqual(result.failedIds,[],'空failedIds必须来自全30 UI证明而非缺弹窗');
  assert.equal(result.partial,false);
  const s=h.state();
  assert.equal(s.resultAcks,0,'全成功无浮窗绝不点我知道了');
  assert.equal(s.modalConfirmed,1,'独立批量确认模态确定恰好一次');
  assert.equal(s.confirmed,1,'全30证明后抽屉确定恰好一次');
  assert.equal(s.navClicks,31,'本批30个panel逐个核验后精确还原初始anchor一次');
  assert.ok(s.overlayChecks>=31,'每次导航前后都重核阻挡modal');
  assert.equal(result.rows.length,30);assert.ok(result.rows.every(r=>r.manualAccounts===2),'完整主表回读30manual2');
});

test('R25 probe stops with ZERO ACK/commit when an account ID drifts mid-navigation', async () => {
  const h=allSuccessNoResultModalHost({fault:'account',at:5,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-target-not-verified');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0);
});

test('R25 probe stops with ZERO ACK/commit on a partial row mid-navigation', async () => {
  const h=allSuccessNoResultModalHost({fault:'partial',at:6,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-target-not-verified');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0);
});

test('R25 probe stops with ZERO ACK/commit on a footer total conflict mid-navigation', async () => {
  const h=allSuccessNoResultModalHost({fault:'footer',at:4,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-target-not-verified');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0);
});

test('R25 probe stops with ZERO ACK/commit when the 30-panel set drifts to a foreign panel', async () => {
  const h=allSuccessNoResultModalHost({fault:'foreignPanel',at:7,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-target-not-verified');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0);
});

test('R25 probe stops with ZERO ACK/commit when a target is not selected2 mid-navigation', async () => {
  const h=allSuccessNoResultModalHost({fault:'missingSelected',at:3,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-target-not-verified');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0);
});

test('R25 probe stops with ZERO ACK/commit when a new blocking modal appears mid-navigation', async () => {
  const h=allSuccessNoResultModalHost({fault:'newModal',at:4,timeoutMs:80});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'batch-result-panel-navigation-blocking-overlay');
  const s=h.state();assert.equal(s.resultAcks,0);assert.equal(s.confirmed,0,'阻挡modal后绝不点抽屉确定');
});

function confirmAccountDrawerDom({ids=['79863866','9zmao_fushi'],checks=[true,true],footer='当前商品已选：2/30',batchChecked=true,extraRow=false,cutRow=false}={}) {
  const rowIds=cutRow?ids.slice(0,1):ids.slice();
  const rows=rowIds.map((id,i)=>El('tr',{rect:[400,32]},[El('td',{text:'ID: '+id}),El('td',{},[El('input',{attrs:{type:'checkbox'},checked:checks[i]!==false,rect:[12,12]})])]));
  if(extraRow)rows.push(El('tr',{rect:[400,32]},[El('td',{text:'ID: '+ids[0]}),El('td',{},[El('input',{attrs:{type:'checkbox'},checked:true,rect:[12,12]})])]));
  const batchInput=El('input',{attrs:{type:'checkbox'},checked:batchChecked,rect:[12,12]});
  const batchLabel=El('label',{rect:[260,20],text:'将所选抖音号批量添加至所有商品'},[batchInput]);
  const confirm=El('button',{rect:[80,32],text:'确定'});
  const footerEl=El('div',{text:footer});
  const drawer=El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号'},[...rows,footerEl,batchLabel,confirm]);
  return {run:fn=>makeCtx([drawer]).run(fn),confirm};
}

test('final confirm callback refuses account ID drift / duplicate / stale footer with ZERO submit (R32: bounded 1..10 subset ok)', () => {
  const drift=confirmAccountDrawerDom({ids:['01234567','9zmao_fushi']});
  assert.throws(()=>drift.run(rp.confirmBatchAccountsApplyInPage),/account-id-drift-before-submit/);
  assert.equal(drift.confirm.__clicks,undefined,'漂移ID不得点确定');
  const dup=confirmAccountDrawerDom({extraRow:true});
  // The third row is now within the bounded 1..10 surface, so the duplicate ID itself
  // (not the row count) is the hard stop.
  assert.throws(()=>dup.run(rp.confirmBatchAccountsApplyInPage),/account-id-drift-before-submit/);
  assert.equal(dup.confirm.__clicks,undefined);
  // R32: a single available target checked at 1/30 may submit
  const single=confirmAccountDrawerDom({cutRow:true,footer:'当前商品已选：1/30'});
  assert.deepEqual(plain(single.run(rp.confirmBatchAccountsApplyInPage)),{clicked:true},'仅剩一个可用目标已勾选可提交草稿');
  assert.equal(single.confirm.__clicks,1);
  // but a single checked row with a stale 2/30 footer still refuses
  const cutStale=confirmAccountDrawerDom({cutRow:true});
  assert.throws(()=>cutStale.run(rp.confirmBatchAccountsApplyInPage),/account-footer-not-checked-count-of-30-before-submit/);
  assert.equal(cutStale.confirm.__clicks,undefined);
  const partial=confirmAccountDrawerDom({checks:[true,false]});
  assert.throws(()=>partial.run(rp.confirmBatchAccountsApplyInPage),/account-footer-not-checked-count-of-30-before-submit/);
  assert.equal(partial.confirm.__clicks,undefined);
  const staleFooter=confirmAccountDrawerDom({footer:'当前商品已选：1/30'});
  assert.throws(()=>staleFooter.run(rp.confirmBatchAccountsApplyInPage),/account-footer-not-checked-count-of-30-before-submit/);
  assert.equal(staleFooter.confirm.__clicks,undefined);
});

test('final confirm callback submits once only for exact two checked accounts at 2/30', () => {
  const ok=confirmAccountDrawerDom({});
  assert.deepEqual(plain(ok.run(rp.confirmBatchAccountsApplyInPage)),{clicked:true});
  assert.equal(ok.confirm.__clicks,1);
});

// ── R16 real-page preparation chain: button+modal+result+commit, empty-cell 0, LABEL
// disabled, anchor supplement, immediate draft removal ────────────────────────────────
function bindingDrawerRoot({ids=['79863866','9zmao_fushi'],checks=[true,true],footer='当前商品已选：2/30',disabledHeader=false,disabledRows=false}={}) {
  const headerInput=El('input',{attrs:{type:'checkbox'},checked:checks.every(Boolean),rect:[12,12]});
  const headerLabel=El('label',{class:disabledHeader?'ovui-checkbox ovui-checkbox--disabled':'ovui-checkbox',rect:[20,20]},[headerInput]);
  const header=El('thead',{},[El('tr',{},[El('th',{},[headerLabel])])]);
  const rows=ids.map((id,i)=>{const cb=El('input',{attrs:{type:'checkbox'},checked:checks[i],rect:[12,12]});const cell=disabledRows?El('td',{},[El('label',{class:'ovui-checkbox ovui-checkbox--disabled',rect:[20,20]},[cb])]):El('td',{},[cb]);return El('tr',{rect:[400,32]},[El('td',{text:'ID: '+id}),cell]);});
  const footerEl=El('div',{text:footer});
  const batchButton=El('button',{rect:[260,20],text:'将所选抖音号批量添加至所有商品'});
  const drawerConfirm=El('button',{rect:[80,32],text:'确定'});
  return El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号'},[header,...rows,footerEl,batchButton,drawerConfirm]);
}
function batchModalRoot({count='29',accounts='2',text='确定要添加至所有商品吗'}={}) {
  const btn=El('button',{rect:[60,24],text:'确定'});
  return El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,200],text:`${text} 将在${count}个商品上批量添加${accounts}个抖音号`},[btn]);
}

test('R32 bounded account set: three rows accept a min-1 settled subset; eleven and a foreign configured row refuse', () => {
  const targets=['target_0001','target_0002','target_0003'];
  const settled={ok:true,rows:[
    {ids:[targets[0]],checked:true,labelDisabled:false},
    {ids:[targets[1]],checked:false,labelDisabled:false},
    {ids:[targets[2]],checked:false,labelDisabled:true},
  ],selectedCount:1,totalCount:30};
  assert.equal(rp.bindingAccountsSnapshotSettled(settled,targets,30),true,'三行中至少一行已选且页脚1/30可稳定通过');

  const eleven=Array.from({length:11},(_,i)=>'target_'+String(i+1).padStart(4,'0'));
  const elevenDrawer=bindingDrawerRoot({ids:eleven,checks:Array(11).fill(false),footer:'当前商品已选：0/30'});
  assert.throws(()=>makeCtx([elevenDrawer]).run(rp.selectAllAccountsInPage,{targets:eleven}),/account-drawer-does-not-show-exact-target-rows/,'第11行越过有界身份面，零点击拒绝');

  const foreignDrawer=bindingDrawerRoot({ids:[targets[0],targets[1],'foreign_0001'],checks:[false,false,false],footer:'当前商品已选：0/30'});
  assert.throws(()=>makeCtx([foreignDrawer]).run(rp.selectAllAccountsInPage,{targets}),/account-drawer-does-not-show-exact-target-rows/,'已配置集合中的外来第三行必须拒绝');
});

test('readMainTable maps a unique live aweme-cell 添加抖音号 button to 0 accounts, never notice text', () => {
  const heading=El('tr',{},[El('th',{text:'商品信息 投放抖音号 素材 操作'})]);
  // the 0 / 2 evidence must come from the unique .aweme-wrapper cell, exactly like the real page
  const empty=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: 3845811625248555123 请为该商品选择要投放的抖音号，或开启联盟合作达人自动投'}),El('td',{},[El('div',{class:'aweme-wrapper',rect:[120,20],text:'添加抖音号'})])]);
  const bound=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: 3845811625248555124 根据系统前置检测，当前商品可能审核不通过'}),El('td',{},[El('div',{class:'aweme-wrapper',rect:[120,20],text:'2个抖音号 管理抖音号'})])]);
  // a row whose ONLY 抖音号 wording is in unrelated product-notice text (no aweme cell) must NOT be a 0
  const noticeOnly=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: 3845811625248555125 请为该商品选择要投放的抖音号或添加手动添加抖音号'})]);
  const table=El('table',{rect:[900,900]},[heading,empty,bound,noticeOnly]);
  const rows=plain(makeCtx([table]).run(rp.readMainTableInPage)).rows;
  assert.equal(rows[0].manualAccounts,0,'精确空aweme单元格映射0');
  assert.equal(rows[0].manualEvidence,true,'空单元格证据可供repair');
  assert.equal(rows[1].manualAccounts,2,'成功行仍为2且带前置风险提示不降级');
  assert.equal(rows[2].manualAccounts,null,'无aweme单元格的无关文案绝不映射为0');
});

test('account header select-all refuses a LABEL-disabled header with zero clicks', () => {
  const drawer=bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30',disabledHeader:true});
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.selectAllAccountsInPage),/native-account-header-label-disabled/);
});

test('account header select-all refuses unselected LABEL-disabled rows even with an enabled header (zero header clicks)', () => {
  // INPUT.disabled reads false and the header itself is enabled, but both target rows carry
  // the ovui-checkbox--disabled ancestor and are unchecked — header select-all must not click.
  const drawer=bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30',disabledRows:true});
  const headerLabel=[...drawer.querySelectorAll('thead label')][0];
  const ctx=makeCtx([drawer]);
  assert.throws(()=>ctx.run(rp.selectAllAccountsInPage),/native-account-rows-label-disabled/);
  assert.equal(headerLabel.__clicks,undefined,'禁用行的表头一次都不点');
  // already-exactly-two checked rows require no header toggle even when flagged disabled
  const checked=bindingDrawerRoot({checks:[true,true],footer:'当前商品已选：2/30',disabledRows:true});
  const checkedHeader=[...checked.querySelectorAll('thead label')][0];
  assert.deepEqual(plain(makeCtx([checked]).run(rp.selectAllAccountsInPage)),{alreadyChecked:true});
  assert.equal(checkedHeader.__clicks,undefined,'已精确两号checked不再翻表头');
});

test('binding snapshot reports a row-level LABEL-disabled account', () => {
  const snap=plain(makeCtx([bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30',disabledRows:true})]).run(rp.bindingDrawerSnapshotInPage));
  assert.equal(snap.ok,true);
  assert.equal(snap.headerLabelDisabled,false,'表头本身可点');
  assert.ok(snap.rows.every(r=>r.labelDisabled===true),'账号行标签被禁用');
});

test('binding snapshot reports the batch as a real enabled button and a disabled header', () => {
  const ok=plain(makeCtx([bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30'})]).run(rp.bindingDrawerSnapshotInPage));
  assert.equal(ok.batchButtonCount,1);assert.equal(ok.batchEnabled,true);assert.equal(ok.headerLabelDisabled,false);
  const dis=plain(makeCtx([bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30',disabledHeader:true})]).run(rp.bindingDrawerSnapshotInPage));
  assert.equal(dis.headerLabelDisabled,true);
});

test('applyBatch clicks the batch button once only when the exact two accounts are checked at 2/30', () => {
  const drawer=bindingDrawerRoot({checks:[true,true],footer:'当前商品已选：2/30'});
  assert.deepEqual(plain(makeCtx([drawer]).run(rp.applyBatchAccountsInPage)),{clicked:true});
  const btn=[...drawer.querySelectorAll('button,[role="button"]')].find(b=>/批量/.test((b.innerText||'')));
  assert.equal(btn.__clicks,1);
  const unchecked=bindingDrawerRoot({checks:[true,false],footer:'当前商品已选：2/30'});
  assert.throws(()=>makeCtx([unchecked]).run(rp.applyBatchAccountsInPage),/batch-apply-accounts-not-settled/);
});

test('batch confirm modal gates on exact product/account counts and drawer identity before one 确定', () => {
  const drawer=bindingDrawerRoot({});
  const modal=batchModalRoot({});
  const snap=plain(makeCtx([drawer,modal]).run(rp.batchAddAllModalSnapshotInPage));
  assert.deepEqual(snap,{ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:true});
  assert.deepEqual(plain(makeCtx([drawer,modal]).run(rp.confirmBatchAddAllModalInPage,29)),{clicked:true,productCount:29});
  const drifted=batchModalRoot({count:'30'});
  assert.throws(()=>makeCtx([drawer,drifted]).run(rp.confirmBatchAddAllModalInPage,29),/batch-add-modal-product-count-mismatch/);
  const wrongAcc=batchModalRoot({accounts:'1'});
  assert.throws(()=>makeCtx([drawer,wrongAcc]).run(rp.confirmBatchAddAllModalInPage,29),/batch-add-modal-account-count-mismatch/);
  const badDrawer=bindingDrawerRoot({ids:['01234567','9zmao_fushi']});
  assert.throws(()=>makeCtx([badDrawer,modal]).run(rp.confirmBatchAddAllModalInPage,29),/batch-add-modal-accounts-not-settled/);
});

test('batch result snapshot is read-only and settle-gated; acknowledge clicks 我知道了 once only for a complete result', () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mk=(id,outcome)=>El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+id+' 2个抖音号添加'+outcome})]);
  const build=(rowList,title='以下商品部分抖音号添加失败')=>{const ack=El('button',{rect:[60,24],text:'我知道了'});return {ack,modal:El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,240],text:title},[...rowList,ack])};};
  // complete result over the 29 non-anchor products, ids[1],ids[2] fail, rest success
  const rows=ids.slice(1).map((id,i)=>mk(id,(i===0||i===1)?'失败':'成功'));
  const {ack,modal}=build(rows);
  const snap=plain(makeCtx([modal]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(snap.settled,true,'29 unique authorized ids each definite 成功/失败 => settled');
  assert.equal(snap.known,true);assert.equal(snap.uniqueCount,29);assert.equal(snap.successCount,27);
  assert.deepEqual([...snap.failedIds].sort(),[ids[1],ids[2]].sort());
  const res=plain(makeCtx([bindingDrawerRoot({}),modal]).run(rp.acknowledgeBatchResultInPage,ids));
  assert.equal(res.acked,true);assert.equal(ack.__clicks,1,'结果模态我知道了恰好一次');
  assert.deepEqual([...res.failedIds].sort(),[ids[1],ids[2]].sort());
  // NO snapshot click happens (read-only)
  const ack2=build(ids.slice(1).map(id=>mk(id,'成功'))).ack;
  const snap2ctx=makeCtx([build(ids.slice(1).map(id=>mk(id,'成功'))).modal]);
  const snap2=plain(snap2ctx.run(rp.batchResultSnapshotInPage,ids));
  assert.equal(snap2.settled,true);assert.equal(snap2.failedIds.length,0);assert.equal(ack2.__clicks,undefined,'快照只读绝不点击');
  // absence is pending, NOT a normal close: snapshot unsettled, acknowledge refuses with zero click
  const absentSnap=plain(makeCtx([bindingDrawerRoot({})]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(absentSnap.settled,false);assert.equal(absentSnap.present,false,'缺结果=待定，不是成功');
  assert.throws(()=>makeCtx([bindingDrawerRoot({})]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-modal-absent/,'缺结果不得直接点确定');
  // unknown modal title is never settled and never acknowledged
  const unk=build(ids.slice(1).map(id=>mk(id,'成功')),'未知操作确认');
  const unkSnap=plain(makeCtx([unk.modal]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(unkSnap.settled,false);assert.equal(unkSnap.known,false);
  assert.throws(()=>makeCtx([unk.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-modal-unknown/);
  assert.equal(unk.ack.__clicks,undefined,'未知结果模态不点我知道了');
  // an incomplete (too few rows) result is unsettled and cannot be acknowledged
  const few=build(ids.slice(1,10).map(id=>mk(id,'成功')));
  assert.equal(plain(makeCtx([few.modal]).run(rp.batchResultSnapshotInPage,ids)).settled,false,'行数不足不得视为完成');
  assert.throws(()=>makeCtx([few.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-incomplete-or-unreadable/);
  // an outside (foreign) product id row makes the result unsettled
  const foreign=build([...ids.slice(1,29).map(id=>mk(id,'成功')),mk('3845900000000000000','成功')]);
  const foreignSnap=plain(makeCtx([foreign.modal]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(foreignSnap.settled,false);assert.equal(foreignSnap.outside>=1,true,'外来商品ID不得计入结果');
  assert.throws(()=>makeCtx([foreign.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-incomplete-or-unreadable/);
  // two result modals is ambiguous
  const two=build([mk(ids[1],'成功')]).modal;
  assert.throws(()=>makeCtx([modal,two]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-modal-not-unique/);
});

test('R18 ack callback re-verifies the FRESH drawer account identity at the click instant (drift => ZERO 我知道了)', () => {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mk=(id,outcome)=>El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+id+' 2个抖音号添加'+outcome})]);
  const build=()=>{const ack=El('button',{rect:[60,24],text:'我知道了'});return {ack,modal:El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,240],text:'以下商品部分抖音号添加失败'},[...ids.slice(1).map(id=>mk(id,'成功')),ack])};};
  // A complete, recognised result modal is present, but the delayed-result ack instant finds the
  // account drawer showing a DRIFTED id (79863866 -> 01234567). The self-contained fresh identity
  // check must reject with ZERO 我知道了 even though the result snapshot itself is settled.
  const drift=build();
  assert.equal(plain(makeCtx([drift.modal]).run(rp.batchResultSnapshotInPage,ids)).settled,true,'结果本身落稳');
  assert.throws(()=>makeCtx([bindingDrawerRoot({ids:['01234567','9zmao_fushi']}),drift.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-ack-account-identity-drift/);
  assert.equal(drift.ack.__clicks,undefined,'账号ID漂移不得点我知道了');
  // footer not 2/30 at the ack instant
  const stale=build();
  assert.throws(()=>makeCtx([bindingDrawerRoot({footer:'当前商品已选：1/30'}),stale.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-ack-account-identity-drift/);
  assert.equal(stale.ack.__clicks,undefined,'footer非2/30不得点我知道了');
  // an unchecked target row at the ack instant
  const uncheck=build();
  assert.throws(()=>makeCtx([bindingDrawerRoot({checks:[true,false]}),uncheck.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-ack-account-identity-drift/);
  assert.equal(uncheck.ack.__clicks,undefined,'未全checked不得点我知道了');
  // no account drawer at all at the ack instant
  const nodrawer=build();
  assert.throws(()=>makeCtx([nodrawer.modal]).run(rp.acknowledgeBatchResultInPage,ids),/batch-result-ack-account-drawer-not-unique/);
  assert.equal(nodrawer.ack.__clicks,undefined,'无账号抽屉不得点我知道了');
  // the correct exact-two-identity drawer still acks once
  const good=build();
  const gres=plain(makeCtx([bindingDrawerRoot({}),good.modal]).run(rp.acknowledgeBatchResultInPage,ids));
  assert.equal(gres.acked,true);assert.equal(good.ack.__clicks,1,'精确两账号我知道了恰好一次');
});

test('partial draft warning is accepted only with known failed ids, never as an ad publication', () => {
  const warn=El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,180],text:'部分商品未选择抖音号，确定提交吗？'},[El('button',{rect:[60,24],text:'确定'})]);
  assert.equal(plain(makeCtx([warn]).run(rp.acceptPartialDraftWarningInPage,true)).accepted,true);
  assert.throws(()=>makeCtx([warn]).run(rp.acceptPartialDraftWarningInPage,false),/partial-draft-warning-without-known-failures/);
  assert.deepEqual(plain(makeCtx([bindingDrawerRoot({})]).run(rp.acceptPartialDraftWarningInPage,true)),{present:false},'无提示即正常，不等待必然不存在的warning');
});

test('anchor management opens uniquely; auto-opened drawer cancels only on a unique enabled 取消', () => {
  const mkRow=(id,labels)=>El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: '+id}),...labels.map(t=>El('button',{rect:[60,24],text:t}))]);
  const open=El('div',{});
  const row=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: 3845811625248555010'}),El('button',{rect:[60,24],text:'管理抖音号'})]);
  assert.deepEqual(plain(makeCtx([row]).run(rp.openAnchorManagementInPage,'3845811625248555010')),{ok:true});
  const dupEl=El('tr',{rect:[600,48]},[El('td',{text:'商品 ID: 3845811625248555011'}),El('button',{rect:[60,24],text:'管理抖音号'}),El('button',{rect:[60,24],text:'管理手动添加抖音号'})]);
  assert.deepEqual(plain(makeCtx([dupEl]).run(rp.openAnchorManagementInPage,'3845811625248555011')),{ok:false},'两个管理按钮不唯一');
  const cancelBtn=El('button',{rect:[80,32],text:'取消'});
  const drawer=El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号'},[cancelBtn]);
  assert.deepEqual(plain(makeCtx([drawer]).run(rp.cancelAutoOpenedDrawerInPage)),{cancelled:true});
  assert.equal(cancelBtn.__clicks,1);
  assert.deepEqual(plain(makeCtx([bindingDrawerRoot({})]).run(rp.cancelAutoOpenedDrawerInPage)),{cancelled:false},'无取消按钮不强行动作');
});

function supplementAnchorHost({timeoutMs=1500}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mainRows=ids.map((productId,i)=>({productId,manualAccounts:i===0?2:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const GOOD=['79863866','9zmao_fushi'];
  const checked=[false,false];
  let opened=false,anchorReopened=0,cancelled=0,confirmed=0,modalConfirmed=0,headerCalls=0,applyCalls=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:mainRows};
    if(fn===rp.bindingDrawerSnapshotInPage){
      if(!opened)return {ok:false,reason:'account-drawer-not-unique',count:0};
      return {ok:true,rows:[{ids:[GOOD[0]],checked:checked[0]},{ids:[GOOD[1]],checked:checked[1]}],headerSelectAllCount:1,selectedCount:checked.every(Boolean)?2:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[ids[0]]};
    }
    if(fn===rp.cancelAutoOpenedDrawerInPage){cancelled++;return {cancelled:true};}
    if(fn===rp.openAnchorManagementInPage){opened=true;anchorReopened++;return {ok:true};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;checked[0]=true;checked[1]=true;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:opened&&checked.every(Boolean)};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage)return {present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,failedIds:ids.slice(1),successCount:0};
    if(fn===rp.acknowledgeBatchResultInPage)return {present:true,acked:true,failedIds:ids.slice(1),successCount:0};
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected supplement function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({cancelled,anchorReopened,headerCalls,applyCalls,modalConfirmed,confirmed})};
}

test('supplement cancels the auto-opened drawer, reuses the manual2 anchor, then batch-commits once', async () => {
  const h=supplementAnchorHost();
  const result=await h.bind();
  assert.equal(result.ok,true);
  const s=h.state();
  assert.equal(s.cancelled,1,'auto-opened未提交drawer先取消');
  assert.equal(s.anchorReopened,1,'唯一打开已验证manual2 anchor管理按钮');
  assert.equal(s.headerCalls,1);assert.equal(s.applyCalls,1);assert.equal(s.modalConfirmed,1);assert.equal(s.confirmed,1,'表头/批量/模态/草稿各一次');
});

function cancelNotClosedHost({closeEvidence='never',timeoutMs=1500}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mainRows=ids.map((productId,i)=>({productId,manualAccounts:i===0?2:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const GOOD=['79863866','9zmao_fushi'];
  const checked=[false,false];
  let opened=false,anchorReopened=0,cancelled=0,confirmed=0,modalConfirmed=0,headerCalls=0,applyCalls=0,cancelReads=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:mainRows};
    if(fn===rp.bindingDrawerSnapshotInPage){
      if(!opened){
        cancelReads++;
        // 'never' keeps a lingering unrecognised overlay (count 1) even after 取消 => NON-positive-closed.
        // 'clean' shows the drawer truly gone (count 0) => positive closed evidence.
        if(closeEvidence==='never')return {ok:false,reason:'account-drawer-not-unique',count:1};
        return {ok:false,reason:'account-drawer-not-unique',count:0};
      }
      return {ok:true,rows:[{ids:[GOOD[0]],checked:checked[0]},{ids:[GOOD[1]],checked:checked[1]}],headerSelectAllCount:1,selectedCount:checked.every(Boolean)?2:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[ids[0]]};
    }
    if(fn===rp.cancelAutoOpenedDrawerInPage){cancelled++;return {cancelled:true};}
    if(fn===rp.openAnchorManagementInPage){opened=true;anchorReopened++;return {ok:true};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;checked[0]=true;checked[1]=true;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:opened&&checked.every(Boolean)};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage)return {present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,failedIds:ids.slice(1),successCount:0};
    if(fn===rp.acknowledgeBatchResultInPage)return {present:true,acked:true,failedIds:ids.slice(1),successCount:0};
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected cancel-not-closed function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({cancelled,anchorReopened,headerCalls,applyCalls,modalConfirmed,confirmed,cancelReads})};
}

test('R18 reopen requires POSITIVE closed evidence; a 取消 that does not truly close opens ZERO anchor and ZERO batch', async () => {
  const h=cancelNotClosedHost({closeEvidence:'never'});
  const result=await h.bind();
  assert.equal(result.ok,false,'非positive-closed必须停止');
  const s=h.state();
  assert.equal(s.cancelled,1,'先取消一次');
  assert.equal(s.anchorReopened,0,'cancel未真正关闭(残留overlay)绝不打开anchor');
  assert.equal(s.headerCalls,0);assert.equal(s.applyCalls,0);assert.equal(s.modalConfirmed,0);assert.equal(s.confirmed,0,'无positive-closed证据绝不批量/提交');
  // control: genuine positive closed evidence (count 0) still reuses the anchor exactly once
  const c=cancelNotClosedHost({closeEvidence:'clean'});
  const cres=await c.bind();
  assert.equal(cres.ok,true,'positive-closed仍走通过链路');
  const cs=c.state();
  assert.equal(cs.cancelled,1);assert.equal(cs.anchorReopened,1,'positive closed后才唯一打开anchor');assert.equal(cs.confirmed,1);
});

function headerDisabledHost({timeoutMs=600}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const mainRows=ids.map((productId)=>({productId,manualAccounts:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const GOOD=['79863866','9zmao_fushi'];
  let headerCalls=0,applyCalls=0,panelClicks=0,active=ids[0];
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:mainRows};
    if(fn===rp.bindingDrawerSnapshotInPage)return {ok:true,rows:GOOD.map(id=>({ids:[id],checked:false,labelDisabled:true})),headerSelectAllCount:1,selectedCount:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:true,panelProductIds:ids,activeProductIds:[active]};
    if(fn===rp.selectBindingDrawerPanelInPage){panelClicks++;active=String(arg);return {clicked:true,id:String(arg)};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected header-disabled function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({headerCalls,applyCalls,panelClicks})};
}

test('a LABEL-disabled header on every product navigates the known panels and stops bounded with zero select-all and zero batch', async () => {
  const h=headerDisabledHost();
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'account-anchor-no-usable-product');
  const s=h.state();
  assert.equal(s.headerCalls,0,'禁用表头绝不点击');assert.equal(s.applyCalls,0,'禁用表头绝不批量');
  assert.equal(s.panelClicks,29,'有界遍历其余29个已知panel后停止，绝不越界重试');
});

// ── R22 usable-anchor closed loop: active panel id, bounded .panel navigation, non-first anchor ──
function panelBindingDrawerRoot({pids=[],active=null,checks=[false,false],footer='当前商品已选：0/30',disabledHeader=false,disabledRows=false,extraPanels=null}={}) {
  const headerInput=El('input',{attrs:{type:'checkbox'},checked:checks.every(Boolean),rect:[12,12]});
  const headerLabel=El('label',{class:disabledHeader?'ovui-checkbox ovui-checkbox--disabled':'ovui-checkbox',rect:[20,20]},[headerInput]);
  const header=El('thead',{},[El('tr',{},[El('th',{},[headerLabel])])]);
  const accIds=['79863866','9zmao_fushi'];
  const rows=accIds.map((id,i)=>{const cb=El('input',{attrs:{type:'checkbox'},checked:checks[i],rect:[12,12]});const cell=disabledRows?El('td',{},[El('label',{class:'ovui-checkbox ovui-checkbox--disabled',rect:[20,20]},[cb])]):El('td',{},[cb]);return El('tr',{rect:[400,32]},[El('td',{text:'ID: '+id}),cell]);});
  const footerEl=El('div',{text:footer});
  const batchButton=El('button',{rect:[260,20],text:'将所选抖音号批量添加至所有商品'});
  const drawerConfirm=El('button',{rect:[80,32],text:'确定'});
  const list=(Array.isArray(extraPanels)?extraPanels:pids).map(id=>El('div',{class:id===active?'panel active':'panel',attrs:{id},rect:[120,40],text:'未选抖音号 '+id}));
  return El('div',{class:'dialog',attrs:{role:'dialog'},rect:[900,600],text:'为商品添加抖音号'},[...list,header,...rows,footerEl,batchButton,drawerConfirm]);
}
const R22_IDS=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));

test('binding snapshot reports the ordered 30 panel ids and the unique active product id', () => {
  const drawer=panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]});
  const snap=plain(makeCtx([drawer]).run(rp.bindingDrawerSnapshotInPage));
  assert.equal(snap.ok,true);
  assert.deepEqual(snap.panelProductIds,R22_IDS,'30 panels preserved in DOM order');
  assert.deepEqual(snap.activeProductIds,[R22_IDS[0]],'exactly one active panel id');
  // a second active panel => two active ids (the driver must refuse this, so report both verbatim)
  const two=panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[1]});
  const secondActive=El('div',{class:'panel active',attrs:{id:R22_IDS[2]},rect:[120,40],text:'未选'});
  two.__kids.push(secondActive); secondActive.parent=two;
  assert.deepEqual(plain(makeCtx([two]).run(rp.bindingDrawerSnapshotInPage)).activeProductIds,[R22_IDS[1],R22_IDS[2]],'两个active原样上报，不擅自择一');
});

test('panel navigation clicks the single matching product panel once; invalid/absent/duplicate/ambiguous refuse with zero clicks', () => {
  const drawer=panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]});
  const r=plain(makeCtx([drawer]).run(rp.selectBindingDrawerPanelInPage,R22_IDS[1]));
  assert.deepEqual(r,{clicked:true,id:R22_IDS[1]});
  const target=[...drawer.querySelectorAll('.panel')].find(el=>el.getAttribute('id')===R22_IDS[1]);
  assert.equal(target.__clicks,1,'普通面板导航只点一个panel');
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]})]).run(rp.selectBindingDrawerPanelInPage,'123'),/anchor-panel-id-invalid/);
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]})]).run(rp.selectBindingDrawerPanelInPage,'3845811625248559999'),/anchor-panel-not-unique/);
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0],extraPanels:R22_IDS.concat([R22_IDS[1]])})]).run(rp.selectBindingDrawerPanelInPage,R22_IDS[1]),/anchor-panel-not-unique/,'重复id面板不点');
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]}),panelBindingDrawerRoot({pids:R22_IDS,active:R22_IDS[0]})]).run(rp.selectBindingDrawerPanelInPage,R22_IDS[1]),/account-drawer-not-unique/);
});

test('batch result gates on the CURRENT active anchor: the anchor id must be excluded, a different-missing/anchor-included result fails', () => {
  const ids=R22_IDS;
  const mk=(id,outcome)=>El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+id+' 2个抖音号添加'+outcome})]);
  const build=(rowList,title='以下商品部分抖音号添加失败')=>{const ack=El('button',{rect:[60,24],text:'我知道了'});return {ack,modal:El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,240],text:title},[...rowList,ack])};};
  const anchor=ids[1];
  // valid: the 29 NON-anchor products (anchor excluded), ids[2] fails, rest success
  const good=build(ids.filter(id=>id!==anchor).map(id=>mk(id,id===ids[2]?'失败':'成功')));
  const gs=plain(makeCtx([good.modal]).run(rp.batchResultSnapshotInPage,{productIds:ids,anchorProductId:anchor}));
  assert.equal(gs.settled,true,'排除当前active锚点=合法完成');
  assert.equal(gs.anchorMismatch,false);
  const gres=plain(makeCtx([panelBindingDrawerRoot({pids:ids,active:anchor,checks:[true,true],footer:'当前商品已选：2/30'}),good.modal]).run(rp.acknowledgeBatchResultInPage,{productIds:ids,anchorProductId:anchor}));
  assert.equal(gres.acked,true);assert.equal(good.ack.__clicks,1);
  // wrong: result contains the anchor yet drops some OTHER id => never settled, ack refuses with zero click
  const bad=build(ids.filter(id=>id!==ids[0]).map(id=>mk(id,'成功')));
  const bs=plain(makeCtx([bad.modal]).run(rp.batchResultSnapshotInPage,{productIds:ids,anchorProductId:anchor}));
  assert.equal(bs.settled,false,'含锚点/缺别的id不得视为完成');
  assert.equal(bs.anchorMismatch,true);
  assert.throws(()=>makeCtx([bindingDrawerRoot({}),bad.modal]).run(rp.acknowledgeBatchResultInPage,{productIds:ids,anchorProductId:anchor}),/batch-result-anchor-identity-mismatch/);
  assert.equal(bad.ack.__clicks,undefined,'锚点身份不符绝不点我知道了');
  // legacy array input keeps the old read-only contract (no anchor gate)
  const la=plain(makeCtx([good.modal]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(la.settled,true,'老数组调用保留原契约');
});

test('ACK-instant re-check: active drifting off the anchor or the 30-panel set drifting gives zero acknowledge', () => {
  const ids=R22_IDS;const anchor=ids[1];
  const mk=(id,outcome)=>El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+id+' 2个抖音号添加'+outcome})]);
  const build=(rowList,title='以下商品部分抖音号添加失败')=>{const ack=El('button',{rect:[60,24],text:'我知道了'});return {ack,modal:El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,240],text:title},[...rowList,ack])};};
  const good=build(ids.filter(id=>id!==anchor).map(id=>mk(id,id===ids[2]?'失败':'成功')));
  // The result itself is legitimate (anchor excluded), but at the ACK instant the drawer's ACTIVE
  // product has switched to another panel => the batch scope would be wrong. Zero 我知道了 click.
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:ids,active:ids[0],checks:[true,true],footer:'当前商品已选：2/30'}),good.modal]).run(rp.acknowledgeBatchResultInPage,{productIds:ids,anchorProductId:anchor}),/batch-result-ack-active-anchor-drift/);
  assert.equal(good.ack.__clicks,undefined,'ACK瞬间active漂移绝不点我知道了');
  // Same but the 30-panel set has drifted (only 29 panels present) => zero acknowledge.
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:ids.slice(0,29),active:anchor,checks:[true,true],footer:'当前商品已选：2/30'}),good.modal]).run(rp.acknowledgeBatchResultInPage,{productIds:ids,anchorProductId:anchor}),/batch-result-ack-anchor-panel-set-drift/);
});

// R31: the real complete-failure title 以下商品抖音号添加失败 (no 部分) is added to the two title
// recognisers only; every structural/identity gate below stays exactly as before.
const R31_TITLE='以下商品抖音号添加失败';
const r31Row=(id,outcome)=>El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+id+' 2个抖音号添加'+outcome})]);
const r31Build=(rowList,title=R31_TITLE)=>{const ack=El('button',{rect:[60,24],text:'我知道了'});return {ack,modal:El('div',{class:'modal',attrs:{role:'dialog'},rect:[400,240],text:title},[...rowList,ack])};};

test('R31 真实29全部失败标题：strict object(30商品+第22个active锚点)快照settled/失败29成功0，我知道了仅一次', () => {
  const ids=R22_IDS;const anchor=ids[21];
  const nonAnchor=ids.filter(id=>id!==anchor);
  const good=r31Build(nonAnchor.map(id=>r31Row(id,'失败')));
  const input={productIds:ids,anchorProductId:anchor};
  const snap=plain(makeCtx([good.modal]).run(rp.batchResultSnapshotInPage,input));
  assert.equal(snap.known,true,'已证明的完整失败标题属于已知');
  assert.equal(snap.settled,true);
  assert.equal(snap.uniqueCount,29);assert.equal(snap.successCount,0);assert.equal(snap.anchorMismatch,false);
  assert.deepEqual([...snap.failedIds].sort(),[...nonAnchor].sort(),'29个唯一授权非锚点全部失败');
  assert.equal(good.ack.__clicks,undefined,'快照只读绝不点击');
  const res=plain(makeCtx([panelBindingDrawerRoot({pids:ids,active:anchor,checks:[true,true],footer:'当前商品已选：2/30'}),good.modal]).run(rp.acknowledgeBatchResultInPage,input));
  assert.equal(res.acked,true);
  assert.deepEqual([...res.failedIds].sort(),[...nonAnchor].sort());
  assert.equal(good.ack.__clicks,1,'唯一我知道了恰好一次');
  // legacy array caller keeps its original contract (only the recognised title set grew)
  const la=plain(makeCtx([good.modal]).run(rp.batchResultSnapshotInPage,ids));
  assert.equal(la.settled,true);assert.equal(la.failedIds.length,29);
});

test('R31 旧两种partial标题与12/29混合结果原样不变', () => {
  const ids=R22_IDS;
  for(const title of ['以下商品部分抖音号添加失败','部分抖音号添加失败']){
    const mixed=r31Build(ids.slice(1).map((id,i)=>r31Row(id,i<12?'失败':'成功')),title);
    const snap=plain(makeCtx([mixed.modal]).run(rp.batchResultSnapshotInPage,ids));
    assert.equal(snap.settled,true,title+' 仍已知且落稳');
    assert.equal(snap.failedIds.length,12);assert.equal(snap.successCount,17);
    const res=plain(makeCtx([bindingDrawerRoot({}),mixed.modal]).run(rp.acknowledgeBatchResultInPage,ids));
    assert.equal(res.acked,true);assert.equal(mixed.ack.__clicks,1);
  }
});

test('R31 完整失败标题的负例：结构/身份/唯一性不符一律不settled且零我知道了', () => {
  const ids=R22_IDS;const anchor=ids[21];
  const nonAnchor=ids.filter(id=>id!==anchor);
  const input={productIds:ids,anchorProductId:anchor};
  const drawer=()=>panelBindingDrawerRoot({pids:ids,active:anchor,checks:[true,true],footer:'当前商品已选：2/30'});
  const noClick=(b,msg)=>assert.equal(b.ack.__clicks,undefined,msg);
  // 28 rows: one authorized id beyond the anchor is missing
  const few=r31Build(nonAnchor.slice(0,28).map(id=>r31Row(id,'失败')));
  assert.equal(plain(makeCtx([few.modal]).run(rp.batchResultSnapshotInPage,input)).settled,false,'28行不完整不settled');
  assert.throws(()=>makeCtx([drawer(),few.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-incomplete-or-unreadable/);
  noClick(few,'28行零点击');
  // duplicate row
  const dup=r31Build([...nonAnchor.map(id=>r31Row(id,'失败')),r31Row(nonAnchor[0],'失败')]);
  assert.equal(plain(makeCtx([dup.modal]).run(rp.batchResultSnapshotInPage,input)).settled,false);
  assert.throws(()=>makeCtx([drawer(),dup.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-incomplete-or-unreadable/);
  noClick(dup,'重复行零点击');
  // foreign product id
  const foreign=r31Build([...nonAnchor.slice(0,28).map(id=>r31Row(id,'失败')),r31Row('3845900000000000000','失败')]);
  const fs=plain(makeCtx([foreign.modal]).run(rp.batchResultSnapshotInPage,input));
  assert.equal(fs.settled,false);assert.equal(fs.outside>=1,true);
  assert.throws(()=>makeCtx([drawer(),foreign.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-incomplete-or-unreadable/);
  noClick(foreign,'外来ID零点击');
  // result includes the active anchor while dropping a different id
  const incl=r31Build(ids.filter(id=>id!==ids[0]).map(id=>r31Row(id,'失败')));
  const is=plain(makeCtx([incl.modal]).run(rp.batchResultSnapshotInPage,input));
  assert.equal(is.settled,false);assert.equal(is.anchorMismatch,true);
  assert.throws(()=>makeCtx([drawer(),incl.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-anchor-identity-mismatch/);
  noClick(incl,'含锚点零点击');
  // one row without a definite 成功/失败 outcome
  const amb=r31Build([...nonAnchor.slice(0,28).map(id=>r31Row(id,'失败')),El('tr',{rect:[400,32]},[El('td',{text:'商品 ID: '+nonAnchor[28]+' 处理中'})])]);
  const as=plain(makeCtx([amb.modal]).run(rp.batchResultSnapshotInPage,input));
  assert.equal(as.settled,false);assert.equal(as.ambiguous>=1,true);
  assert.throws(()=>makeCtx([drawer(),amb.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-incomplete-or-unreadable/);
  noClick(amb,'不确定行零点击');
  // an account row is unchecked at the ACK instant
  const uncheck=r31Build(nonAnchor.map(id=>r31Row(id,'失败')));
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:ids,active:anchor,checks:[true,false],footer:'当前商品已选：2/30'}),uncheck.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-ack-account-identity-drift/);
  noClick(uncheck,'未全checked零点击');
  // the current active anchor has drifted to another panel
  const drift=r31Build(nonAnchor.map(id=>r31Row(id,'失败')));
  assert.throws(()=>makeCtx([panelBindingDrawerRoot({pids:ids,active:ids[0],checks:[true,true],footer:'当前商品已选：2/30'}),drift.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-ack-active-anchor-drift/);
  noClick(drift,'active锚点漂移零点击');
  // two result modals are ambiguous
  const twoA=r31Build(nonAnchor.map(id=>r31Row(id,'失败')));
  const twoB=r31Build(nonAnchor.map(id=>r31Row(id,'失败')));
  const ts=plain(makeCtx([twoA.modal,twoB.modal]).run(rp.batchResultSnapshotInPage,input));
  assert.equal(ts.settled,false);assert.equal(ts.reason,'batch-result-modal-not-unique');
  assert.throws(()=>makeCtx([drawer(),twoA.modal,twoB.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-modal-not-unique/);
  noClick(twoA,'重复modal零点击');
  // failure-looking titles that were never proven stay unknown: no 失败/添加/我知道了 generalisation
  for(const t of ['以下商品全部抖音号添加失败','抖音号添加失败确认','批量抖音号添加失败','以下商品部分抖音号添加成功']){
    const unk=r31Build(nonAnchor.map(id=>r31Row(id,'失败')),t);
    const s=plain(makeCtx([unk.modal]).run(rp.batchResultSnapshotInPage,input));
    assert.equal(s.known,false,t+' 仍判未知');assert.equal(s.settled,false);
    assert.throws(()=>makeCtx([drawer(),unk.modal]).run(rp.acknowledgeBatchResultInPage,input),/batch-result-modal-unknown/);
    noClick(unk,'未知标题零点击');
  }
});

// Initial entry gate: BEFORE any navigation/header/batch the driver must prove a trustworthy
// 30-panel set with a single in-batch active, and a consistent all-unchecked-0/30 or
// all-checked-2/30 selection. Any anomaly stops with ZERO header, batch or panel clicks.
function initialGateHost(overrides) {
  const ids=R22_IDS;const GOOD=['79863866','9zmao_fushi'];
  let headerCalls=0,applyCalls=0,panelClicks=0;
  const snap=Object.assign({ok:true,rows:GOOD.map(id=>({ids:[id],checked:false})),headerSelectAllCount:1,selectedCount:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[ids[0]]},overrides||{});
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:ids.map(productId=>({productId,manualAccounts:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}))};
    if(fn===rp.bindingDrawerSnapshotInPage)return snap;
    if(fn===rp.selectAllAccountsInPage){headerCalls++;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.selectBindingDrawerPanelInPage){panelClicks++;return {clicked:true,id:String(arg)};}
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected initial-gate function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:200});
  return {bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({headerCalls,applyCalls,panelClicks})};
}

test('untrusted initial panel set (duplicate/foreign/missing/multiple-active/no-active/foreign-active) stops with zero navigation/header/batch', async () => {
  const ids=R22_IDS;
  const cases=[
    {name:'duplicate',ov:{panelProductIds:ids.slice(0,29).concat([ids[0]])}},
    {name:'foreign',ov:{panelProductIds:ids.slice(0,29).concat(['3845811625248559999'])}},
    {name:'missing',ov:{panelProductIds:ids.slice(0,29)}},
    {name:'multiple-active',ov:{activeProductIds:[ids[0],ids[1]]}},
    {name:'no-active',ov:{activeProductIds:[]}},
    {name:'foreign-active',ov:{activeProductIds:['3845811625248559999']}}
  ];
  for(const c of cases){
    const h=initialGateHost(c.ov);
    const r=await h.bind();
    assert.equal(r.ok,false,c.name+' 入口panel身份不可信必须停止');
    assert.equal(r.reason,'account-drawer-panel-identity-unverified',c.name);
    const s=h.state();
    assert.equal(s.headerCalls,0,c.name+' 绝不点表头');assert.equal(s.applyCalls,0,c.name+' 绝不批量');assert.equal(s.panelClicks,0,c.name+' 绝不导航');
  }
});

test('a partially-checked initial drawer with footer/row conflict stops before any navigation/header/batch', async () => {
  const GOOD=['79863866','9zmao_fushi'];
  const h=initialGateHost({rows:[{ids:[GOOD[0]],checked:true},{ids:[GOOD[1]],checked:false}],selectedCount:0,headerLabelDisabled:true});
  const r=await h.bind();
  assert.equal(r.ok,false);assert.equal(r.reason,'account-drawer-footer-row-state-conflict');
  const s=h.state();
  assert.equal(s.headerCalls,0,'选择态冲突绝不再点表头');assert.equal(s.applyCalls,0);assert.equal(s.panelClicks,0,'冲突在任何导航之前停止');
});

function anchorNavigationHost({usableIndex=1,allBlocked=false,anomaly='none',timeoutMs=200}={}) {
  const ids=R22_IDS;
  const GOOD=['79863866','9zmao_fushi'];
  let active=ids[0];
  let checked=[false,false];
  let committed=false;
  const isBlocked=pid=>allBlocked||(pid===ids[0]);
  let panelClicks=0,headerCalls=0,applyCalls=0,confirmed=0,modalConfirmed=0,lastBatchArg=null;
  const mainRowsFinal=()=>ids.map(productId=>{
    if(productId===active) return {productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false};
    if(productId===ids[7]) return {productId,manualAccounts:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:true,reviewFailed:false};
    return {productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false};
  });
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:committed?mainRowsFinal():ids.map(productId=>({productId,manualAccounts:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}))};
    if(fn===rp.bindingDrawerSnapshotInPage){
      const blocked=isBlocked(active);
      const activeIds=(anomaly==='active-drift'&&panelClicks>0)?[active,ids[(usableIndex+5)%30]]:[active];
      const panelProductIds=(anomaly==='panel-drift'&&panelClicks>0)?ids.slice(0,29):ids;
      const isChecked=checked.every(Boolean)&&!blocked;
      return {ok:true,rows:GOOD.map(id=>({ids:[id],checked:checked.includes(id)?true:isChecked,labelDisabled:blocked})),headerSelectAllCount:1,selectedCount:checked.every(Boolean)?2:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:blocked,panelProductIds,activeProductIds:activeIds};
    }
    if(fn===rp.selectBindingDrawerPanelInPage){panelClicks++;active=String(arg);checked=[false,false];return {clicked:true,id:String(arg)};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;if(isBlocked(active))throw new Error('native-account-header-label-disabled');checked=GOOD.slice();return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:checked.every(Boolean)};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage){lastBatchArg=arg;return {present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,anchorMismatch:false,failedIds:[ids[7]],successCount:28};}
    if(fn===rp.acknowledgeBatchResultInPage){lastBatchArg=arg;return {present:true,acked:true,failedIds:[ids[7]],successCount:28};}
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;committed=true;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected anchor-nav function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({panelClicks,headerCalls,applyCalls,confirmed,modalConfirmed,lastBatchArg})};
}

test('with no existing anchor a blocked first product is navigated past to a usable panel, one header click, batch anchored on the active product', async () => {
  const h=anchorNavigationHost({usableIndex:1});
  const result=await h.bind();
  assert.equal(result.ok,true);
  const s=h.state();
  assert.equal(s.headerCalls,1,'usable面板后仅一次原生表头全选');
  assert.equal(s.applyCalls,1);assert.equal(s.confirmed,1);assert.equal(s.modalConfirmed,1);
  assert.ok(s.panelClicks>=1,'越过了被禁的起点panel');
  assert.equal(s.lastBatchArg.anchorProductId,R22_IDS[1],'批量锚点=fresh证实的active起点(第2个而非ids[0])');
  assert.equal(result.partial,true);assert.equal(result.rows.length,30);
});

test('when every panel product stays disabled the driver stops bounded with zero header click and zero batch', async () => {
  const h=anchorNavigationHost({allBlocked:true});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'account-anchor-no-usable-product');
  const s=h.state();
  assert.equal(s.headerCalls,0,'无可用起点绝不点表头');assert.equal(s.applyCalls,0);assert.equal(s.confirmed,0);
});

test('panel navigation stops on active-id drift / panel-set drift with zero header and zero batch', async () => {
  const drift=anchorNavigationHost({anomaly:'active-drift'});
  const r1=await drift.bind();
  assert.equal(r1.ok,false);assert.equal(r1.reason,'account-anchor-active-drift');
  assert.equal(drift.state().headerCalls,0);assert.equal(drift.state().applyCalls,0);
  const pd=anchorNavigationHost({anomaly:'panel-drift'});
  const r2=await pd.bind();
  assert.equal(r2.ok,false);assert.equal(r2.reason,'account-anchor-panel-set-drift');
  assert.equal(pd.state().headerCalls,0);assert.equal(pd.state().applyCalls,0);
});

// ── R24 same-root anchor reuse: a usable new supplement / a second bound active must REUSE the
//    existing manual2 anchor (or the current active) with ZERO header, not false-stop on the
//    initial-anchor-equality check. The three failing live shapes are reproduced here offline.
function boundBatchTail(pageRefs){
  // shared canned batch/result/commit responses for the R24 reuse hosts
  const {ids,openedState}=pageRefs;
  return {
    batchAddAllModalSnapshotInPage:()=>({ok:true,modalCount:1,productCount:29,accountCount:2,drawerSettled:openedState()}),
    confirmBatchAddAllModalInPage:()=>({clicked:true,productCount:29}),
    batchResultSnapshotInPage:()=>({present:true,known:true,settled:true,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,anchorMismatch:false,failedIds:[],successCount:29}),
    acknowledgeBatchResultInPage:()=>({present:true,acked:true,failedIds:[],successCount:29}),
    acceptPartialDraftWarningInPage:()=>({present:false}),
    guidanceActionInPage:()=>({present:false,unknown:false,roots:[]}),
  };
}

function usableSupplementHost({asyncFallBack=false,neverSettleToAnchor=false,timeoutMs=120}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const anchorId=ids[0], supplementId=ids[29];
  const GOOD=wf.BUSINESS.boundAccounts;
  const mainRowsPre=ids.map((productId,i)=>({productId,manualAccounts:i===29?0:2,manualEvidence:i!==29,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const mainRowsPost=ids.map((productId)=>({productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  let reopened=false,closed=false,cancelled=0,anchorReopened=0,headerCalls=0,applyCalls=0,confirmed=0,modalConfirmed=0,committed=false,reopenReads=0;
  const supplementSnap={ok:true,rows:GOOD.map(id=>({ids:[id],checked:false})),headerSelectAllCount:1,selectedCount:0,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[supplementId]};
  const anchorSnap={ok:true,rows:GOOD.map(id=>({ids:[id],checked:true})),headerSelectAllCount:1,selectedCount:2,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[anchorId]};
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:committed?mainRowsPost:mainRowsPre};
    if(fn===rp.bindingDrawerSnapshotInPage){
      if(reopened){
        reopenReads++;
        if(neverSettleToAnchor) return supplementSnap; // management button reopened but active never falls back to the anchor
        if(asyncFallBack&&reopenReads===1) return supplementSnap; // transient: not yet settled to the requested anchor
        return anchorSnap;
      }
      if(closed) return {ok:false,reason:'account-drawer-not-unique',count:0};
      return supplementSnap; // picker auto-opened the SUPPLEMENT drawer: own accounts unbound 0/30, header/rows ENABLED
    }
    if(fn===rp.cancelAutoOpenedDrawerInPage){cancelled++;closed=true;return {cancelled:true};}
    if(fn===rp.openAnchorManagementInPage){if(String(arg)!==anchorId)return {ok:false};reopened=true;closed=false;anchorReopened++;return {ok:true};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;committed=true;return {clicked:true};}
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    const t=boundBatchTail({ids,openedState:()=>reopened});
    if(t[fn.name])return t[fn.name]();
    if(!fn.name)return {ok:true};
    throw new Error('unexpected usable-supplement function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({cancelled,anchorReopened,headerCalls,applyCalls,modalConfirmed,confirmed,reopenReads})};
}

function boundActiveSecondHost({timeoutMs=120}={}) {
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const activeId=ids[1]; // a SECOND legitimately-bound product, not the first rows.find anchor
  const GOOD=wf.BUSINESS.boundAccounts;
  const mainRows=ids.map((productId,i)=>({productId,manualAccounts:i===29?0:2,manualEvidence:i!==29,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const mainRowsPost=ids.map((productId)=>({productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  let cancelled=0,anchorReopened=0,headerCalls=0,applyCalls=0,confirmed=0,modalConfirmed=0,committed=false;
  const snap={ok:true,rows:GOOD.map(id=>({ids:[id],checked:true})),headerSelectAllCount:1,selectedCount:2,totalCount:30,batchButtonCount:1,batchEnabled:true,headerLabelDisabled:false,panelProductIds:ids,activeProductIds:[activeId]};
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:committed?mainRowsPost:mainRows};
    if(fn===rp.bindingDrawerSnapshotInPage)return {...snap,rows:snap.rows.map(r=>({...r}))};
    if(fn===rp.cancelAutoOpenedDrawerInPage){cancelled++;return {cancelled:true};}
    if(fn===rp.openAnchorManagementInPage){anchorReopened++;return {ok:true};}
    if(fn===rp.selectAllAccountsInPage){headerCalls++;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;committed=true;return {clicked:true};}
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    const t=boundBatchTail({ids,openedState:()=>true});
    if(t[fn.name])return t[fn.name]();
    if(!fn.name)return {ok:true};
    throw new Error('unexpected bound-active-second function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({cancelled,anchorReopened,headerCalls,applyCalls,modalConfirmed,confirmed})};
}

test('R24 scenario1: a usable new-supplement auto drawer (unblocked 0/30) reuses the known old manual2 anchor with zero header click', async () => {
  const h=usableSupplementHost();
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  const s=h.state();
  assert.equal(s.cancelled,1,'当前未保存的补选drawer先取消一次');
  assert.equal(s.anchorReopened,1,'唯一打开旧的manual2 anchor管理按钮');
  assert.equal(s.headerCalls,0,'复用已绑定anchor，绝不额外点表头');
  assert.equal(s.applyCalls,1);assert.equal(s.modalConfirmed,1);assert.equal(s.confirmed,1);
  assert.ok(result.rows.every(r=>r.manualAccounts===2),'补选经旧anchor批量后30全部为2');
});

test('R24 scenario2: the current drawer already shows 2/30 on a second legitimately-bound product -> reuse directly with zero cancel/reopen/header', async () => {
  const h=boundActiveSecondHost();
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  const s=h.state();
  assert.equal(s.cancelled,0,'已选2且active是本批合法绑定商品，直接复用不取消');
  assert.equal(s.anchorReopened,0,'绝不打开管理按钮');
  assert.equal(s.headerCalls,0,'绝不点表头');
  assert.equal(s.applyCalls,1);assert.equal(s.modalConfirmed,1);assert.equal(s.confirmed,1);
});

test('R24 scenario3: reopen bounded-read-waits for the async fall-back to the requested anchor, then reuses it with zero header', async () => {
  const h=usableSupplementHost({asyncFallBack:true,timeoutMs:600});
  const result=await h.bind();
  assert.equal(result.ok,true);assert.equal(result.batchApplied,true);
  const s=h.state();
  assert.equal(s.cancelled,1);assert.equal(s.anchorReopened,1);
  assert.equal(s.headerCalls,0,'异步回落到anchor期间不得抢先点表头');
  assert.ok(s.reopenReads>=2,'reopen必须有界只读等待异步回落到anchor，而非首次即判');
});

test('R24 negative: a reopen that never falls back to the requested anchor stops with the mismatch reason and zero header/batch', async () => {
  const h=usableSupplementHost({neverSettleToAnchor:true});
  const result=await h.bind();
  assert.equal(result.ok,false);assert.equal(result.reason,'anchor-active-management-product-mismatch');
  const s=h.state();
  assert.equal(s.headerCalls,0,'active不回落到请求anchor绝不表头');assert.equal(s.applyCalls,0,'也绝不批量');
});

test('preparePlan repairs the exact 29+1 row, rebinds all final IDs, then freezes only a fresh 30x2 readback', async () => {
  const selected=Array.from({length:30},(_,i)=>'384581162524855'+String(5400+i));
  const replacement='3845811625248555499';const deficient=selected[29];
  const initial=selected.map((productId,i)=>({productId,manualAccounts:i===29?0:2,manualEvidence:i!==29,manualCountKnown:true,autoPullOnly:i===29,reviewFailed:false}));
  const finalIds=selected.slice(0,29).concat(replacement);
  const finalRows=finalIds.map(productId=>({productId,manualAccounts:2,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  let bindCalls=0,readCalls=0,repairEvidence=null;
  const date='2026-10-09';
  const prepared=await wf.preparePlan({planNumber:1,runId:'offline-29-plus-1',businessDate:date,dayState:wf.newDayState(date),catalogRemainingIds:[replacement],
    openCreationPage:async()=>({header:{originOk:true,accountId:wf.BUSINESS.accountId,commissionOptionPresent:true}}),
    browseProducts:async()=>({ok:true,selectedIds:selected,hints:{},attempted:[],cursor:{category:'全部',page:1}}),
    bindAccountsToAll:async({productIds})=>{bindCalls++;assert.equal(productIds.length,30);return {ok:true,partial:bindCalls===1};},
    readMainTable:async()=>{readCalls++;return readCalls===1?initial:finalRows;},
    repairDraft:async plan=>{repairEvidence={removeIds:plan.removeIds,backfillIds:plan.backfillIds};return {ok:true,mainRows:finalRows,selectedCount:30,progress:true};},
    configurePlan:async()=>({ok:true,planName:'offline-repaired-plan'}),persistState:async()=>{},
  });
  assert.deepEqual(repairEvidence.removeIds,[deficient]);
  assert.deepEqual(repairEvidence.backfillIds,[replacement]);
  assert.equal(bindCalls,2,'post-repair batch binding is always re-applied to all 30 exact IDs');
  assert.equal(readCalls,2,'freeze consumes the post-rebind fresh table readback');
  assert.equal(prepared.status,'ready-awaiting-confirmation');
  assert.deepEqual(prepared.frozen.productIds,finalIds);
  assert.equal(prepared.readiness.ready,true);
});

test('real management driver waits for complete exact-name row identity and settings fields', async () => {
  let reads=0;
  const planName='2026-10-09_千川乘方_12:00:00';
  const identityFn=function readIdentity(){ return null; };
  const managerPage={goto:async()=>{},evaluate:async(fn,arg)=>{
    if(fn===identityFn)return {accountId:wf.BUSINESS.accountId};
    if(typeof fn==='string')return {clicked:true};
    if(fn===rp.readManagementRowsInPage) {
      reads++;
      if(reads===1)return {accountId:wf.BUSINESS.accountId,rowCount:1,rows:[{planId:null,planName,text:'late row',productCount:null,accountCount:null,roi:null,dailyBudget:null,commissionIncluded:null,status:null}]};
      return {accountId:wf.BUSINESS.accountId,rowCount:1,rows:[{planId:'1878537802445009',planName,text:'complete row',productCount:30,accountCount:2,roi:15,dailyBudget:300,commissionIncluded:true,status:'审核中'}]};
    }
    throw new Error('unexpected management evaluate '+(fn.name||String(fn).slice(0,20)));
  }};
  const driver=rp.createRealDrivers({page:null,managerPage,context:{},dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',readAccountInPage:identityFn,clickSubTab:label=>'subtab:'+label});
  const row=await driver.readManagementRow({planName,accountId:wf.BUSINESS.accountId});
  assert.equal(reads,2,'the exact row name alone cannot end the bounded read');
  assert.equal(row.found,true);assert.equal(row.uniqueRow,true);assert.equal(row.planId,'1878537802445009');
  assert.equal(row.productCount,30);assert.equal(row.accountCount,2);assert.equal(row.roi,15);assert.equal(row.dailyBudget,300);assert.equal(row.commissionIncluded,true);assert.equal(row.status,'审核中');
});

function makeSubmitAutoPullHarness({candidateIds,disabledIds=[],unknownAtSelection=false}={}) {
  const base=Array.from({length:29},(_,i)=>'384581162524855'+String(5200+i));
  const selected=new Set();const attemptedSet=new Set();
  let pageNo=1,dialog=false,closed=false,submitClicks=0,pageApplyCount=0,cancelCount=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===c.pageObserve)return {observation:'obs-'+pageNo,url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage:pageNo,pageCount:1,modalPresent:true,inProductModal:true,items:[{kind:'next',index:0,disabled:true}]},elements:[{text:'下一步',tag:'BUTTON',index:4}]};
    if(fn===c.actionApply){submitClicks++;if(submitClicks===1)dialog=true;else{closed=true;dialog=false;}return {clicked:true};}
    if(fn===c.pageApply){pageApplyCount++;return {paged:true};}
    if(fn===rp.drawerSnapshotInPage)return closed?{ok:false,reason:'closed'}:{ok:true,cards:candidateIds.map(id=>({id,text:'可投商品 ID: '+id,checked:selected.has(id),checkboxCount:1,disabled:disabledIds.includes(id)})),selectedCount:selected.size,remainingCapacity:1,activeTabs:['全部']};
    if(fn===rp.readMainTableInPage)return closed?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
    if(fn===rp.selectNativeCardInPage){selected.add(String(arg));if(unknownAtSelection)dialog=true;return {id:String(arg),checked:true};}
    if(fn===rp.deselectNativeCardInPage){selected.delete(String(arg));return {id:String(arg),checked:false};}
    if(fn===rp.classifyAndCancelAutoPullInPage){
      if(unknownAtSelection&&dialog)return {kind:'unknown',reason:'unknown-auto-pull-copy'};
      if(dialog)return {kind:'observed',text:'已存在自动拉取投放计划，添加后将会关闭自动拉取抖音号功能 ID: '+candidateIds[0]};
      return {kind:'none',productIds:[]};
    }
    if(fn.name==='cancelObservedAutoPullInPage'){cancelCount++;dialog=false;return {cancelled:true};}
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    throw new Error('unexpected picker evaluate '+(fn.name||String(fn).slice(0,30)));
  }};
  const dayState={lastSelected:base.slice(),attempted:[],cursor:{category:'全部',page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet,hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  return {driver,base,dayState,attemptedSet,selected,pageNo:()=>pageNo,submitClicks:()=>submitClicks,pageApplyCount:()=>pageApplyCount,cancelCount:()=>cancelCount,closed:()=>closed};
}

test('real picker driver re-scans the last page after auto-pull cancellation and submits a still-valid same-page replacement', async () => {
  const extra1='3845811625248555230',extra2='3845811625248555231';
  const h=makeSubmitAutoPullHarness({candidateIds:[extra1,extra2]});
  const result=await h.driver.browseProducts({selectedIds:h.base,needed:1,categories:['全部'],cursor:h.dayState.cursor,onProgress:async()=>{}});
  assert.equal(result.ok,true);assert.equal(result.selectedIds.length,30);
  assert.equal(result.selectedIds.includes(extra1),false);assert.equal(result.selectedIds.includes(extra2),true);
  assert.equal(h.attemptedSet.has(extra1),true);assert.equal(h.attemptedSet.has(extra2),true);
  assert.equal(h.selected.has(extra2),true);assert.equal(h.closed(),true);
  assert.equal(h.pageNo(),1,'replacement was consumed on the observed last page without advancing');
  assert.equal(h.submitClicks(),2,'after deselection the replacement is selected and the same batch is submitted again');
  assert.equal(h.cancelCount(),1);assert.equal(h.pageApplyCount(),0);
});

test('real picker driver stops at the last-page boundary when auto-pull cancellation leaves no usable replacement', async () => {
  const extra1='3845811625248555232',disabled='3845811625248555233';
  const h=makeSubmitAutoPullHarness({candidateIds:[extra1,disabled],disabledIds:[disabled]});
  const result=await h.driver.browseProducts({selectedIds:h.base,needed:1,categories:['全部'],cursor:h.dayState.cursor,onProgress:async()=>{}});
  assert.equal(result.ok,false);assert.equal(result.selectedIds.length,29);
  assert.equal(h.attemptedSet.has(extra1),true);assert.equal(h.attemptedSet.has(disabled),false);
  assert.equal(h.pageNo(),1);assert.equal(h.pageApplyCount(),0);assert.equal(h.submitClicks(),1);
});

test('real picker driver stops on an unknown auto-pull prompt without submitting or advancing', async () => {
  const extra='3845811625248555234';
  const h=makeSubmitAutoPullHarness({candidateIds:[extra],unknownAtSelection:true});
  await assert.rejects(h.driver.browseProducts({selectedIds:h.base,needed:1,categories:['全部'],cursor:h.dayState.cursor,onProgress:async()=>{}}),/unknown-auto-pull-copy/);
  assert.equal(h.pageNo(),1);assert.equal(h.pageApplyCount(),0);assert.equal(h.submitClicks(),0);assert.equal(h.cancelCount(),0);
});

test('real picker driver rejects a page jump before persisting a false page cursor', async () => {
  const candidate='3845811625248555300';let pageNo=1;
  const page={evaluate:async(fn,arg)=>{
    if(fn===c.pageObserve)return {observation:'jump-'+pageNo,pagination:{currentPage:pageNo,pageCount:3,modalPresent:true,inProductModal:true,items:[{kind:'next',index:0,disabled:false}]},elements:[]};
    if(fn===c.pageApply){pageNo=3;return {paged:true};}
    if(fn===rp.drawerSnapshotInPage)return {ok:true,cards:[{id:pageNo===1?candidate:'3845811625248555301',text:'商品 ID: '+(pageNo===1?candidate:'3845811625248555301'),checked:false,checkboxCount:1,disabled:false}],selectedCount:0,remainingCapacity:30,activeTabs:['全部']};
    throw new Error('unexpected page evaluate '+(fn.name||String(fn).slice(0,25)));
  }};
  const cursors=[];const dayState={lastSelected:[],attempted:[],cursor:{category:'全部',page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async state=>{cursors.push(state.cursor.page);},publishedIds:new Set(),attemptedSet:new Set([candidate]),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  await assert.rejects(driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],cursor:dayState.cursor,onProgress:async()=>{}}),/page-advance-not-exactly-confirmed/);
  assert.equal(pageNo,3,'synthetic host demonstrated the bad jump');
  assert.ok(cursors.every(page=>page===1),'no cursor value 2 is persisted for a 1-to-3 jump');
});

test('real picker category driver waits for the new card set instead of treating an active tab with stale cards as empty', async () => {
  let active='旧分类',afterClick=false,afterClickSnapshots=0;
  const oldId='3845811625248555310',newId='3845811625248555311';
  const page={evaluate:async(fn,arg)=>{
    if(fn===c.pageObserve)return {observation:'category-page-1',pagination:{currentPage:1,pageCount:1,modalPresent:true,inProductModal:true,items:[{kind:'next',index:0,disabled:true}]},elements:[]};
    if(fn===rp.clickDrawerTabInPage){afterClick=true;active='新分类';return {clicked:true,alreadyActive:false};}
    if(fn===rp.drawerSnapshotInPage){
      const id=!afterClick||afterClickSnapshots++===0?oldId:newId;
      return {ok:true,cards:[{id,text:'商品 ID: '+id,checked:false,checkboxCount:1,disabled:false}],selectedCount:0,remainingCapacity:30,activeTabs:[active]};
    }
    throw new Error('unexpected category evaluate '+(fn.name||String(fn).slice(0,25)));
  }};
  const cursor={category:'旧分类',page:1,seenProductIds:[]};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],attempted:[],cursor:{...cursor}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set([newId]),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.browseProducts({selectedIds:[],needed:30,categories:['新分类'],cursor,onProgress:async()=>{}});
  assert.equal(afterClick,true);assert.equal(result.ok,false,'one safely observed boundary means incomplete catalog, not fake completion');
  assert.ok(afterClickSnapshots>=2,'the driver waited until the category card IDs changed');
});

test('fresh post-publish shop status requires complete exact-account facts from both plan tabs', async () => {
  const identityFn=function readIdentity(){ return null; };
  const rowsFn=function readShopRows(){};const paginationFn=function readShopPagination(){};const firstFn=function goFirst(){};const nextFn=function goNext(){};
  let activeTab='';
  const managerPage={evaluate:async(fn,arg)=>{
    if(fn===identityFn)return {accountId:wf.BUSINESS.accountId,url:'https://qianchuan.jinritemai.com/uni-prom/overall?aavid='+wf.BUSINESS.accountId};
    if(typeof fn==='string'&&fn.startsWith('subtab:')){activeTab=fn.slice('subtab:'.length);return {clicked:true};}
    if(fn===firstFn)return {clicked:false,alreadyFirst:true};
    if(fn===rowsFn)return {rows:[{id:activeTab==='商品自选'?'1878537802445010':'1878537802445011',switchChecked:true}]};
    if(fn===paginationFn)return {total:1,pageSize:'10',activePage:'1',hasNext:false};
    throw new Error('unexpected shop-state evaluate '+(fn.name||String(fn).slice(0,25)));
  }};
  const driver=rp.createRealDrivers({page:null,managerPage,context:{},dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',readAccountInPage:identityFn,clickSubTab:label=>'subtab:'+label,readShopRowsInPage:rowsFn,readShopPaginationInPage:paginationFn,goFirstShopPageInPage:firstFn,goNextShopPageInPage:nextFn});
  const current=await driver.readCurrentShopEnableState();
  assert.equal(current.readOk,true,JSON.stringify(current));assert.equal(current.enabled,true);assert.equal(current.rowCount,2);
  assert.equal(wf.planPostPublishEnable(current,{}).status,'already-enabled');
  const incomplete={...current,readOk:false,enabled:null,reason:'second-tab-unread'};
  assert.equal(wf.planPostPublishEnable(incomplete,{}).status,'unknown-current-state','unknown scope stops instead of claiming the shop is enabled');
});

test('publisher lock refuses a live owner, recovers a killed owner once, and gates unresolved state into read-only recovery', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plan-publisher-lock-'));
  const lock=path.join(dir,'plan-publisher.lock');
  const stateFile=path.join(dir,'state.json'),attemptsFile=path.join(dir,'attempts.json');
  const state={active:{status:'publish-unknown',frozen:{planName:'offline-pending'}}};
  const attempts={consumed:{offline:{status:'unknown',businessDate:'2026-10-09'}},finalConsumed:{}};
  fs.writeFileSync(stateFile,JSON.stringify(state));fs.writeFileSync(attemptsFile,JSON.stringify(attempts));
  const originalState=fs.readFileSync(stateFile,'utf8'),originalAttempts=fs.readFileSync(attemptsFile,'utf8');
  const root=path.join(__dirname,'run-plans.cjs');
  const startOwner=()=>spawn(process.execPath,['-e',`const r=require(${JSON.stringify(root)});r.acquireLock(process.argv[1]);console.log('READY');setInterval(()=>{},1000);`,lock],{stdio:['ignore','pipe','pipe']});
  const waitLine=child=>new Promise((resolve,reject)=>{
    let out='';const timer=setTimeout(()=>reject(new Error('child lock owner readiness timeout')),10000);
    child.stdout.on('data',chunk=>{out+=chunk.toString();if(out.includes('READY')){clearTimeout(timer);resolve(out);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{if(!out.includes('READY')){clearTimeout(timer);reject(new Error('lock child exited before ready: '+code));}});
  });
  const owner=startOwner();const children=[owner];
  t.after(async()=>{for(const child of children)try{child.kill();}catch(_){}try{fs.rmSync(dir,{recursive:true,force:true});}catch(_){}});
  await waitLine(owner);
  assert.throws(()=>rp.acquireLock(lock),/owner-active|owner-unknown/,'a live PID is never unlinked');
  const ownerExit=new Promise(resolve=>owner.once('exit',resolve));owner.kill();await ownerExit;

  const contenders=[0,1].map(()=>spawn(process.execPath,['-e',`const r=require(${JSON.stringify(root)});try{r.acquireLock(process.argv[1]);console.log('ACQUIRED');setInterval(()=>{},1000);}catch(e){console.log('REFUSED:'+e.message);}`,lock],{stdio:['ignore','pipe','pipe']}));
  children.push(...contenders);
  const outcomes=await Promise.all(contenders.map(child=>new Promise((resolve,reject)=>{
    let out='';const timer=setTimeout(()=>reject(new Error('lock race result timeout')),10000);
    child.stdout.on('data',chunk=>{out+=chunk.toString();if(out.includes('ACQUIRED')||out.includes('REFUSED:')){clearTimeout(timer);resolve(out);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
  })));
  const acquired=outcomes.filter(value=>value.includes('ACQUIRED'));
  assert.equal(acquired.length,1,'the competing recovery attempts establish at most one owner');
  const contenderExits=contenders.map(child=>new Promise(resolve=>child.once('exit',resolve)));
  for(const child of contenders)try{child.kill();}catch(_){}
  await Promise.all(contenderExits);

  const release=rp.acquireLock(lock);
  let replayActions=0;
  const startupMode=rp.shouldRunReadOnlyRecovery(JSON.parse(fs.readFileSync(stateFile,'utf8')),JSON.parse(fs.readFileSync(attemptsFile,'utf8')))?'read-only-recovery':'publish';
  if(startupMode==='publish')replayActions++;
  assert.equal(startupMode,'read-only-recovery');
  assert.equal(replayActions,0,'restart after orphan recovery cannot replay publish actions');
  assert.equal(fs.readFileSync(stateFile,'utf8'),originalState,'read-only recovery selection leaves pending state bytes unchanged');
  assert.equal(fs.readFileSync(attemptsFile,'utf8'),originalAttempts,'read-only recovery selection leaves consumed ledger bytes unchanged');
  release();

  const legacyLock=path.join(dir,'legacy.lock');
  fs.writeFileSync(legacyLock,JSON.stringify({pid:owner.pid,startedAt:new Date().toISOString()}));
  const legacyRelease=rp.acquireLock(legacyLock);
  assert.equal(JSON.parse(fs.readFileSync(legacyLock,'utf8')).pid,process.pid,'a verifiably dead R2-format owner can be recovered');
  legacyRelease();
  const unknownLock=path.join(dir,'unknown.lock');fs.writeFileSync(unknownLock,'{not-json');
  assert.throws(()=>rp.acquireLock(unknownLock),/owner-unknown/,'malformed/unknown owner is never unlinked');
  assert.equal(fs.readFileSync(unknownLock,'utf8'),'{not-json');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 7 — BOTH real main-table manual copies count; auto-pull-only / 1 account do NOT
// ═══════════════════════════════════════════════════════════════════════════
test('parseMainTableRow accepts both real manual copies and rejects auto-pull-only / single account', () => {
  const shortCopy = wf.parseMainTableRow('示例商品 ID：3845811625248555026 2个抖音号 管理抖音号 预估自动拉取 0 个');
  assert.equal(shortCopy.manualAccounts, 2, '短文案「管理抖音号」也是手动管理证据');
  assert.equal(shortCopy.manualEvidence, true);
  assert.equal(shortCopy.productId, '3845811625248555026');

  const longCopy = wf.parseMainTableRow('示例商品 ID：3845811625248555027 2个抖音号 管理手动添加抖音号 预估自动拉取 0 个');
  assert.equal(longCopy.manualAccounts, 2, '长文案「管理手动添加抖音号」同样是手动管理证据');
  assert.equal(longCopy.manualEvidence, true);

  const autoOnly = wf.parseMainTableRow('示例商品 ID：3845811625248555028 预估自动拉取 2 个');
  assert.equal(autoOnly.manualAccounts, 0, '明确仅自动拉取文案与解析未知区分开');
  assert.equal(autoOnly.manualEvidence, false);
  assert.equal(autoOnly.autoPullOnly, true);
  assert.equal(autoOnly.manualCountKnown, true, '自动拉取计数是已知零手动绑定，但不是手动绑定证据');

  const unknown = wf.parseMainTableRow('示例商品 ID：3845811625248555030 页面文案无法识别');
  assert.equal(unknown.manualAccounts, null, '缺少明确绑定文案时保持未知，不伪造为 0');
  assert.equal(unknown.manualCountKnown, false);

  const oneAccount = wf.parseMainTableRow('示例商品 ID：3845811625248555029 1个抖音号 管理抖音号');
  assert.equal(oneAccount.manualAccounts, 1);
});

test('evaluateReadiness gates on 30 unique products each with at least 1 manual account (R32 min-1)', () => {
  const ok = id => ({ productId: id, manualAccounts: 2, reviewFailed: false, ambiguous: false, idCount: 1 });
  const good = Array.from({ length: 30 }, (_, i) => ok('384581162524855' + String(5000 + i)));
  assert.equal(wf.evaluateReadiness(good, 30).ready, true);

  const oneAutoOnly = good.slice(0, 29).concat([{ productId: '3845811625248559999', manualAccounts: 0, reviewFailed: false, ambiguous: false, idCount: 1 }]);
  const r1 = wf.evaluateReadiness(oneAutoOnly, 30);
  assert.equal(r1.ready, false);
  assert.deepEqual(r1.deficientIds, ['3845811625248559999']);

  // R32: a definite manual count of 1 is sufficient; it must NOT be removed or re-backfilled
  const oneManual = good.slice(0, 29).concat([{ productId: '3845811625248558888', manualAccounts: 1, reviewFailed: false, ambiguous: false, idCount: 1 }]);
  const r2 = wf.evaluateReadiness(oneManual, 30);
  assert.equal(r2.ready, true, '只有 1 个手动账号也算就绪（R32 最低一个）');
  assert.deepEqual(r2.deficientIds, [], '1 个手动账号不是不足行');

  const dupe = good.slice(0, 29).concat([good[0]]);
  assert.equal(wf.evaluateReadiness(dupe, 30).ready, false, '29 个唯一 + 1 个重复不等于 30 唯一');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 7 — 29 valid + 1 invalid: remove ONLY the invalid one, backfill, never mis-delete
// ═══════════════════════════════════════════════════════════════════════════
test('planRemovalAndBackfill removes only the evidenced-deficient row and backfills exactly one', () => {
  const rows = [];
  for (let i = 0; i < 29; i++) rows.push({ productId: '384581162524855' + String(5000 + i), manualAccounts: 2, reviewFailed: false, ambiguous: false, idCount: 1 });
  rows.push({ productId: '3845811625248559999', manualAccounts: 0, reviewFailed: false, ambiguous: false, idCount: 1 }); // auto-only, deficient
  const plan = wf.planRemovalAndBackfill({
    rows, capacity: 30,
    catalogRemainingIds: ['3845811625248559999', '3840000000000000001', '3840000000000000002'],
    // the just-removed deficient candidate was tried today, so it is in the per-day
    // attempted set and must NOT be re-picked as its own backfill (req 7: tried once/day)
    attempted: ['3845811625248559999'], published: [],
  });
  assert.deepEqual(plan.removeIds, ['3845811625248559999'], '只移除有真实证据的不足行');
  assert.equal(plan.removeReasons['3845811625248559999'], 'manual-accounts-0');
  assert.deepEqual(plan.backfillIds, ['3840000000000000001'], '被移除的候选当日不再补选，跳过它取下一个');
  assert.equal(plan.need, 1);
  assert.equal(plan.catalogExhausted, false);
  assert.ok(!plan.removeIds.includes('3845811625248555000'), '有效商品绝不能被误删');
});

test('planRemovalAndBackfill never removes a row whose parse is unknown/ambiguous', () => {
  const rows = [
    { productId: null, ambiguous: true, idCount: 2, manualAccounts: 0, reviewFailed: false }, // unknown parse
    ...Array.from({ length: 29 }, (_, i) => ({ productId: '384581162524855' + String(5000 + i), manualAccounts: 2, reviewFailed: false, ambiguous: false, idCount: 1 })),
  ];
  const plan = wf.planRemovalAndBackfill({ rows, capacity: 30, catalogRemainingIds: [], attempted: [], published: [] });
  assert.deepEqual(plan.removeIds, [], '解析未知的行必须保留，绝不删除');

  const knownIdUnknownBinding = wf.planRemovalAndBackfill({
    rows: [{ productId: '3845811625248555998', manualAccounts: null, manualEvidence: false, autoPullOnly: false, reviewFailed: false, idCount: 1 }],
    capacity: 30, catalogRemainingIds: ['3840000000000000001'], attempted: [], published: [],
  });
  assert.deepEqual(knownIdUnknownBinding.removeIds, [], '商品 ID 已知也不能把未知绑定状态当作不足后移除');
  assert.deepEqual(knownIdUnknownBinding.unknownIds, ['3845811625248555998']);
  assert.deepEqual(knownIdUnknownBinding.backfillIds, [], '绑定状态未知时不猜测并继续补选');
});

test('planRemovalAndBackfill removes review-failed rows by exact id and reports exhaustion', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ productId: '384581162524855' + String(5000 + i), manualAccounts: 2, reviewFailed: i === 5, ambiguous: false, idCount: 1 }));
  const plan = wf.planRemovalAndBackfill({ rows, capacity: 30, catalogRemainingIds: [], attempted: [], published: [] });
  assert.deepEqual(plan.removeIds, [rows[5].productId]);
  assert.equal(plan.removeReasons[rows[5].productId], 'review-failed');
  assert.equal(plan.need, 1);
  assert.equal(plan.catalogExhausted, true, '没有可用候选补选时如实标记目录耗尽');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 6 — dual-account header select-all + batch, exactly 2 targets both checked
// ═══════════════════════════════════════════════════════════════════════════
test('verifyAccountBinding accepts 2-account and 1-account target subsets, refuses unchecked / wrong-count / foreign', () => {
  const drawer = readFix('both-accounts-native-selected.json');
  const ok = wf.verifyAccountBinding(drawer, 30);
  assert.equal(ok.ok, true, '两个目标账号都勾选且已选 2/30 才算通过');
  assert.deepEqual(ok.checkedAccounts.slice().sort(), ['79863866', '9zmao_fushi'].slice().sort());
  assert.equal(ok.selectedCount, 2);

  // R32 min-1: one available target checked at 1/30 is a valid subset selection
  const one = { text: '当前商品已选：1/30', rows: [{ text: 'ID: 79863866', checked: true }] };
  const okOne = wf.verifyAccountBinding(one, 30);
  assert.equal(okOne.ok, true, '一个可用目标已勾选且已选 1/30 合格');
  assert.deepEqual(okOne.checkedAccounts, ['79863866']);

  // subset selected but footer count disagrees => refuse
  const wrongCount = { text: '当前商品已选：2/30', rows: [{ text: 'ID: 79863866', checked: true }] };
  assert.equal(wf.verifyAccountBinding(wrongCount, 30).reason, 'selected-count-not-checked-accounts');

  // both present but one unchecked (select-all not applied)
  const unchecked = { text: '当前商品已选：1/30', rows: [{ text: 'ID: 79863866', checked: true }, { text: 'ID: 9zmao_fushi', checked: false }] };
  const r = wf.verifyAccountBinding(unchecked, 30);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'an-account-row-not-checked');

  // an extra non-target account row
  const extra = { text: '当前商品已选：3/30', rows: [{ text: 'ID: 79863866', checked: true }, { text: 'ID: 9zmao_fushi', checked: true }, { text: 'ID: 55555555', checked: true }] };
  assert.equal(wf.verifyAccountBinding(extra, 30).ok, false, '出现非目标账号行必须拒绝');

  // a foreign single account row is still out of scope (身份scope不放宽)
  const foreignOne = { text: '当前商品已选：1/30', rows: [{ text: 'ID: 55555555', checked: true }] };
  assert.equal(wf.verifyAccountBinding(foreignOne, 30).reason, 'account-rows-not-target-subset');
});

test('chooseAnchorProduct accepts any product with at least 1 manual account (R32 min-1)', () => {
  const rows = [
    { productId: 'A', manualAccounts: 1, reviewFailed: false },
    { productId: 'B', manualAccounts: 2, reviewFailed: true },
    { productId: 'C', manualAccounts: 2, reviewFailed: false },
  ];
  assert.equal(wf.chooseAnchorProduct(rows), 'A', '1 个手动账号即可作为 anchor，不再强制恰好 2');
  assert.equal(wf.chooseAnchorProduct([{ productId: 'B', manualAccounts: 2, reviewFailed: true }]), null, '审核失败行不能做 anchor');
  assert.equal(wf.chooseAnchorProduct([{ productId: 'A', manualAccounts: 0, reviewFailed: false }]), null, '0 个手动账号不能做 anchor');
  assert.equal(wf.chooseAnchorProduct([{ productId: 'A', manualAccounts: null, reviewFailed: false }]), null, '未知账号数不能做 anchor');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 8 — auto-pull dialog is CANCELLED and its ids skipped; unknown-confirm stops
// ═══════════════════════════════════════════════════════════════════════════
test('classifyAddDialog cancels the real auto-pull dialog and extracts its exact product ids', () => {
  const warning = readFix('auto-pull-cancelled.json').warning;
  const r = wf.classifyAddDialog(warning);
  assert.equal(r.kind, 'auto-pull');
  assert.equal(r.action, 'cancel', '自动拉取弹窗必须取消，绝不确认');
  assert.deepEqual(r.productIds, ['3845056406831104024']);
});

test('classifyAddDialog stops on auto-pull copy whose ids cannot be determined, and on unknown confirm', () => {
  const noIds = wf.classifyAddDialog('以下商品已存在自动拉取投放计划，添加后将会关闭自动拉取抖音号功能');
  assert.equal(noIds.action, 'stop');
  assert.equal(noIds.reason, 'auto-pull-ids-unknown');

  const unknown = wf.classifyAddDialog('确定要执行此操作吗？');
  assert.equal(unknown.kind, 'unknown-confirm');
  assert.equal(unknown.action, 'stop', '未知确认弹窗一律停止，绝不猜测点击');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 3 — outer .card-container capture keeps the sibling migration/precheck warning
// ═══════════════════════════════════════════════════════════════════════════
test('collectProductCardsInPage uses the outer card so a sibling warning is not lost', () => {
  const card = El('div', { class: 'card-container', rect: [300, 200] }, [
    El('div', { class: 'card-product-item', rect: [280, 120], text: '示例商品A ID：3845811625248555026 价格 163.9 元' }),
    // the warning is a SIBLING of .card-product-item inside .card-container
    El('div', { class: 'card-warning', rect: [280, 40], text: '该商品已创建「全店托管」计划。当前计划成功创建后，全店托管计划将停止投放该商品' }),
  ]);
  const ctx = makeCtx([card]);
  const cards = ctx.run(wf.collectProductCardsInPage);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, '3845811625248555026');
  assert.ok(cards[0].text.includes('全店托管'), '外层容器文本必须保留兄弟节点的迁移警告');

  const parsed = wf.parseProductCard(cards[0]);
  assert.equal(parsed.migrationWarning, true);
  assert.equal(parsed.selectable, true);
});

test('parseProductCard treats precheck risk as disclosable, review-failed as hard reject', () => {
  const pre = wf.parseProductCard({ text: '商品 ID：3845209709162397994 根据系统前置检测，当前商品可能审核不通过' });
  assert.equal(pre.precheckRisk, true);
  assert.equal(pre.selectable, true, '前置检测是可披露项，不是硬拒绝');
  assert.equal(pre.reviewFailed, false);

  const failed = wf.parseProductCard({ text: '商品 ID：3845209709162397995 当前商品广告审核不通过' });
  assert.equal(failed.reviewFailed, true);
});

test('mergeCardHints only turns flags on and never erases history', () => {
  let hints = {};
  hints = wf.mergeCardHints(hints, [{ productId: 'X', migrationWarning: true, precheckRisk: false, reviewFailed: false, text: 'first' }]);
  hints = wf.mergeCardHints(hints, [{ productId: 'X', migrationWarning: false, precheckRisk: true, reviewFailed: false, text: 'second' }]);
  assert.equal(hints.X.migrationWarning, true, '先前的迁移提示不能被后来的无提示擦除');
  assert.equal(hints.X.precheckRisk, true);
  assert.equal(hints.X.text, 'second');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 4 — new-day reset vs same-day cursor; published seed dedup
// ═══════════════════════════════════════════════════════════════════════════
test('loadDayState continues the browse cursor within the same day and resets it on a new business day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daystate-'));
  const file = path.join(dir, 'day.json');
  try {
    // no file => fresh day state at page 1
    const fresh = wf.loadDayState(file, '2026-10-09');
    assert.equal(fresh.page, 1);
    assert.deepEqual(fresh.lastSelected, []);

    wf.persistDayState(file, { businessDate: '2026-10-09', page: 7, category: '搜索趋势', lastSelected: ['a', 'b'], attempted: ['z'], cursor: { category: '搜索趋势', page: 7, seenProductIds: ['a', 'b'] } });
    const same = wf.loadDayState(file, '2026-10-09');
    assert.equal(same.page, 7, '同日必须延续页码游标');
    assert.deepEqual(same.lastSelected, ['a', 'b']);
    assert.deepEqual(same.attempted, ['z']);
    assert.deepEqual(same.cursor, { category: '搜索趋势', page: 7, seenProductIds: ['a', 'b'] }, '同日游标原样延续');

    // 2026-10-27 用户规则：新业务日完全重新开始浏览位置（第 1 页/首个分类/空 seen 集），
    // 不继承昨日的 page/category/seenProductIds；跨日去重只由全局 published store 承担。
    const nextDay = wf.loadDayState(file, '2026-10-10');
    assert.equal(nextDay.page, 1, '新业务日从第 1 页重新浏览，不继承昨日页码');
    assert.equal(nextDay.category, '店铺新品', '新业务日回到首个分类');
    assert.deepEqual(nextDay.cursor, { category: '店铺新品', page: 1, seenProductIds: [] }, '新业务日清空浏览位置与 seen 集');
    assert.deepEqual(nextDay.lastSelected, []);
    assert.deepEqual(nextDay.attempted, [], 'attempted 是每日集合，不是永久黑名单');

    wf.persistDayState(file,{businessDate:'2026-10-09',active:{status:'publish-unknown',planNumber:1,frozen:{manifestHash:'f'.repeat(64)}}});
    assert.throws(()=>wf.loadDayState(file,'2026-10-10'),/pending\/unknown.*recovery/,'新业务日不得绕过昨天未决发布');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// F1(2026-10-21) / 2026-10-27 user rule — new business day re-browses from page 1
// with an empty seen set; every per-day publication fact is reset; cross-day
// dedupe is carried ONLY by the global published-products store.
// ═══════════════════════════════════════════════════════════════════════════
test('new business day starts at page 1 with an empty seen set, clears every per-day fact, and dedupes only via the global published store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daystate-crossday-'));
  const file = path.join(dir, 'day.json');
  const storeFile = path.join(dir, 'published.json');
  try {
    const priorPlan = { planId: '7100000000000001', planNumber: 1, productIds: ['3844471923857818440'] };
    wf.persistDayState(file, {
      businessDate: '2026-10-20',
      page: 31,
      category: '全部',
      lastSelected: ['3844471923857818440', '3843944823912531173'],
      attempted: ['3845032940992069859'],
      cursor: { category: '全部', page: 31, seenProductIds: ['3844471923857818440', '3843944823912531173'], nativeEof: true, nativeAdvances: 5 },
      hints: { '3844471923857818440': { migrationWarning: true, precheckRisk: false, reviewFailed: false, text: 'x' } },
      plans: [priorPlan],
      active: { status: 'published-success', planNumber: 1, planId: priorPlan.planId, runId: 'plan-publisher-2026-10-20-0123456789abcdef' },
      firstPublishedPlan: priorPlan,
      confirmationConsumptions: [{ confirmationId: 'conf-old', manifestHash: 'e'.repeat(64) }],
      manualUiPublicationFacts: [{ status: 'published-success', source: 'user-authorized-native-ui', planId: '7100000000000002' }],
    });

    const next = wf.loadDayState(file, '2026-10-21');
    assert.equal(next.businessDate, '2026-10-21');
    // 新业务日：完全重新开始浏览位置（用户 2026-10-27 规则），不继承昨日游标
    assert.equal(next.page, 1, '新业务日从第 1 页开始');
    assert.equal(next.category, '店铺新品', '新业务日回到首个分类');
    assert.deepEqual(next.cursor, { category: '店铺新品', page: 1, seenProductIds: [] }, 'page/category/seenProductIds 一律重置');
    assert.notEqual(next.cursor.nativeEof, true, 'nativeEof 是当日扫描证明，新日必须重新证明');
    assert.equal(next.cursor.nativeAdvances, undefined, 'nativeAdvances 不跨日继承');
    assert.ok(!next.cursor.seenProductIds.includes('3844471923857818440'), '昨日 seen 集不得继承（已发布商品靠全局账本去重）');
    // per-day publication facts are all reset — nothing copied from the old day
    assert.deepEqual(next.plans, [], 'plans 必须按新业务日清空');
    assert.equal(next.active, null, 'active 必须按新业务日清空');
    assert.equal(next.firstPublishedPlan, null);
    assert.deepEqual(next.confirmationConsumptions, [], 'confirmationConsumptions 不得从旧日复制');
    assert.deepEqual(next.manualUiPublicationFacts, [], 'manualUiPublicationFacts 不得从旧日复制');
    assert.deepEqual(next.lastSelected, []);
    assert.deepEqual(next.attempted, [], '旧日 attempted 不整体继承为永久排除');
    assert.deepEqual(next.hints, {});

    // 跨日已发布商品仍由全局 published store 去重（不依赖被重置的游标/attempted）。
    const seeded = wf.loadPublishedStore(storeFile);
    wf.persistPublished(storeFile, wf.appendPublished(seeded, priorPlan));
    const reread = wf.loadPublishedStore(storeFile);
    assert.ok(reread.publishedIds.includes('3844471923857818440'), '跨日已发布商品仍在全局账本中，次日不会被重发');
    assert.equal(reread.publishedIds.filter(id => id === '3844471923857818440').length, 1, '账本去重是唯一跨日去重来源');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cross-day reset is fail-safe for missing fields, legacy state and invalid page/category', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daystate-crossday-bad-'));
  const file = path.join(dir, 'day.json');
  try {
    // legacy state WITHOUT a cursor object: a new day still starts fresh (no inheritance)
    wf.persistDayState(file, { businessDate: '2026-10-18', page: 12, category: '破圈尖货' });
    const legacyNext = wf.loadDayState(file, '2026-10-19');
    assert.equal(legacyNext.page, 1);
    assert.equal(legacyNext.category, '店铺新品');
    assert.deepEqual(legacyNext.cursor, { category: '店铺新品', page: 1, seenProductIds: [] });
    assert.deepEqual(legacyNext.plans, []);

    // invalid page/category/cursor fields never crash and never leak into the new day
    wf.persistDayState(file, {
      businessDate: '2026-10-19',
      page: -3,
      category: '不存在的分类',
      cursor: { category: '坏分类', page: 'x', seenProductIds: 'not-an-array' },
    });
    const bad = wf.loadDayState(file, '2026-10-20');
    assert.equal(bad.page, 1, '新业务日固定从第 1 页开始');
    assert.equal(bad.category, '店铺新品', '新业务日固定回到首个分类');
    assert.deepEqual(bad.cursor, { category: '店铺新品', page: 1, seenProductIds: [] }, '新业务日游标是安全默认');

    // a resolved prior day with an unknown-shaped cursor still resets the new day
    wf.persistDayState(file, { businessDate: '2026-10-20', page: 4, category: '搜索趋势', cursor: 42, plans: [{ planId: 'p' }] });
    const mixed = wf.loadDayState(file, '2026-10-21');
    assert.equal(mixed.page, 1);
    assert.equal(mixed.category, '店铺新品');
    assert.deepEqual(mixed.cursor, { category: '店铺新品', page: 1, seenProductIds: [] });
    assert.deepEqual(mixed.plans, [], '每日计划事实仍清空');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same-day continuation keeps per-day facts while a new business day resets them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daystate-sameday-'));
  const file = path.join(dir, 'day.json');
  try {
    const plan = { planId: '7100000000000003', planNumber: 1 };
    wf.persistDayState(file, {
      businessDate: '2026-10-21',
      page: 5,
      category: '搜索趋势',
      lastSelected: ['a'],
      attempted: ['b'],
      cursor: { category: '搜索趋势', page: 5, seenProductIds: ['a', 'b'] },
      plans: [plan],
      active: { status: 'published-success', planNumber: 1 },
      confirmationConsumptions: [{ confirmationId: 'conf-1' }],
    });
    // same day: EVERYTHING continues exactly as before (no regression)
    const same = wf.loadDayState(file, '2026-10-21');
    assert.equal(same.page, 5);
    assert.deepEqual(same.lastSelected, ['a']);
    assert.deepEqual(same.attempted, ['b']);
    assert.deepEqual(same.plans, [plan]);
    assert.deepEqual(same.active, { status: 'published-success', planNumber: 1 });
    assert.deepEqual(same.confirmationConsumptions, [{ confirmationId: 'conf-1' }]);
    assert.deepEqual(same.cursor, { category: '搜索趋势', page: 5, seenProductIds: ['a', 'b'] }, '同日游标延续');
    // next day: neither the cursor nor any daily fact leaks across
    const next = wf.loadDayState(file, '2026-10-22');
    assert.equal(next.page, 1);
    assert.equal(next.category, '店铺新品');
    assert.deepEqual(next.cursor, { category: '店铺新品', page: 1, seenProductIds: [] });
    assert.deepEqual(next.plans, []);
    assert.equal(next.active, null);
    assert.deepEqual(next.confirmationConsumptions, []);
    assert.deepEqual(next.attempted, []);
    assert.deepEqual(next.lastSelected, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── R19: atomicWriteJson bounded transient-retry (Windows EPERM save resilience) ──────
// Isolated tempdir + controlled fs.renameSync faults. Never reads/writes production state,
// an old production tmp, or a Cookie. Atomics.wait is stubbed to a recorder so the synchronous
// wait CAP is provable without real elapsed time; the production code is exercised as-is.
function withRenameFaults({failTimes, code='EPERM'}={}) {
  const realRename = fs.renameSync;
  const realWait = Atomics.wait;
  const state = { renameAttempts: 0, waits: [] };
  fs.renameSync = function (from, to) {
    state.renameAttempts++;
    if (failTimes === Infinity || state.renameAttempts <= failTimes) {
      const e = new Error('simulated ' + code); e.code = code; throw e;
    }
    return realRename.call(fs, from, to);
  };
  Atomics.wait = function (_a, _i, _v, ms) { state.waits.push(ms); return 'ok'; };
  return { state, restore: () => { fs.renameSync = realRename; Atomics.wait = realWait; } };
}

test('R19 atomicWriteJson lands the exact new JSON after a brief transient EPERM burst, with a bounded wait', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-brief-'));
  const file = path.join(dir, 'plan-publisher-state.json');
  const realRename = fs.renameSync;
  try {
    fs.writeFileSync(file, JSON.stringify({ v: 'OLD' }, null, 2)); // prior durable content
    const data = { v: 'NEW', businessDate: '2026-10-11', selected: ['a'] };
    const { state, restore } = withRenameFaults({ failTimes: 2 }); // first two renames hit EPERM
    try { wf.atomicWriteJson(file, data); } finally { restore(); }
    const expected = JSON.stringify(data, null, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), expected, '短暂拒绝后新JSON必须确切落盘');
    assert.equal(state.renameAttempts, 3, '前2次EPERM + 第3次真实rename成功');
    assert.ok(state.waits.reduce((a, b) => a + b, 0) <= 900, '同步等候总上限<=900ms');
    assert.ok(fs.existsSync(file + '.tmp') === false || fs.readFileSync(file + '.tmp', 'utf8') === expected, 'tmp不得留下与目标不一致的旧内容');
  } finally { fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R19 atomicWriteJson throws the original EPERM under a persistent lock, keeps the old target intact, retries only a bounded number of times', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-persist-'));
  const file = path.join(dir, 'plan-publisher-state.json');
  const realRename = fs.renameSync;
  try {
    const oldBytes = JSON.stringify({ v: 'OLD', protected: true }, null, 2);
    fs.writeFileSync(file, oldBytes);
    const { state, restore } = withRenameFaults({ failTimes: Infinity }); // rename never lands
    assert.throws(() => { try { wf.atomicWriteJson(file, { v: 'NEW' }); } finally { restore(); } }, e => e.code === 'EPERM', '持续锁定仍抛原transient错误');
    assert.equal(fs.readFileSync(file, 'utf8'), oldBytes, '持续失败旧目标必须原封保存');
    assert.equal(state.renameAttempts, 6, '有界重试最大6次，绝不无限');
    assert.ok(state.waits.reduce((a, b) => a + b, 0) <= 900, '持续锁定总等候仍<=900ms');
  } finally { fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R19 atomicWriteJson does NOT blind-retry a non-transient error and does not delete an existing target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-fatal-'));
  const file = path.join(dir, 'plan-publisher-state.json');
  const realRename = fs.renameSync;
  try {
    fs.writeFileSync(file, JSON.stringify({ v: 'OLD' }, null, 2));
    const { state, restore } = withRenameFaults({ failTimes: Infinity, code: 'EXDEV' }); // not transient
    assert.throws(() => { try { wf.atomicWriteJson(file, { v: 'NEW' }); } finally { restore(); } }, e => e.code === 'EXDEV');
    assert.equal(state.renameAttempts, 1, '非transient错误只试一次即抛，不盲重试');
    assert.equal(state.waits.length, 0, '非transient错误不等待');
    assert.equal(fs.existsSync(file), true, '绝不通过删除现有目标绕过');
  } finally { fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R19 atomicWriteJson only short-circuits on exact identical target bytes, never from a failed rename alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-idem-'));
  const file = path.join(dir, 'plan-publisher-state.json');
  const realRename = fs.renameSync;
  try {
    const data = { v: 'SAME', businessDate: '2026-10-11' };
    fs.writeFileSync(file, JSON.stringify(data, null, 2)); // target already holds exact intended bytes
    const { state, restore } = withRenameFaults({ failTimes: Infinity });
    try { wf.atomicWriteJson(file, data); } finally { restore(); }
    assert.equal(state.renameAttempts, 1, 'identical-bytes正向证据即成功返回，不反复rename');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2), 'samebytes目标原样保持');
    // a DIFFERENT payload under the same always-EPERM rename must NOT short-circuit (covered by persistent test)
    const diff = withRenameFaults({ failTimes: Infinity });
    assert.throws(() => { try { wf.atomicWriteJson(file, { v: 'DIFFERENT' }); } finally { diff.restore(); } }, e => e.code === 'EPERM', '不同内容不得凭rename失败谎称成功');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data, null, 2), '不同内容失败后旧目标仍完整');
  } finally { fs.renameSync = realRename; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('post-publish enable pending/stopped states route same-day restart to read-only recovery and block cross-day bypass', () => {
  const businessDate='2026-10-09';
  for(const status of ['post-publish-enable-check-pending','post-publish-enable-stopped']) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'post-enable-recovery-'));
    const stateFile=path.join(dir,'plan-publisher-state.json');
    const attemptsFile=path.join(dir,'plan-publication-attempts.json');
    try {
      const frozen={runId:'prior-successful-run',businessDate,planNumber:1,confirmationId:'consumed-success-'+status,manifestHash:'a'.repeat(64),planName:'previous-successful-plan'};
      const first={planNumber:1,status:'success',planId:'1800000000000001',accountId:wf.BUSINESS.accountId,planName:frozen.planName,businessDate,runId:frozen.runId};
      const state={...wf.newDayState(businessDate),plans:[first],firstPublishedPlan:first,active:{status,planNumber:1,frozen,planId:first.planId,postPublishEnable:{status:'unknown-current-state'}}};
      wf.persistDayState(stateFile,state);
      c.consumePublicationOnce(attemptsFile,1,frozen.confirmationId,frozen);
      c.recordPublicationOutcome(attemptsFile,frozen.confirmationId,'dispatched');
      c.consumeFinalConfirmationOnce(attemptsFile,frozen.confirmationId,frozen.manifestHash);
      c.recordFinalConfirmationOutcome(attemptsFile,frozen.confirmationId,'success');
      c.recordPublicationOutcome(attemptsFile,frozen.confirmationId,'success');
      const stateBytes=fs.readFileSync(stateFile,'utf8'),attemptBytes=fs.readFileSync(attemptsFile,'utf8');
      const sameDay=wf.loadDayState(stateFile,businessDate),attempts=c.loadAttemptsStore(attemptsFile);
      assert.equal(wf.hasUnresolvedPlan(sameDay),true,status+' remains unresolved after successful publication');
      assert.equal(rp.shouldRunReadOnlyRecovery(sameDay,attempts),true,'the same startup predicate used by main selects read-only recovery');
      assert.throws(()=>wf.loadDayState(stateFile,'2026-10-10'),/pending\/unknown.*recovery/,'new business day cannot reset unresolved post-publish state');

      let preparations=0,publishDispatches=0,recoveryStops=0;
      if(rp.shouldRunReadOnlyRecovery(sameDay,attempts))recoveryStops++;
      else { preparations++;publishDispatches++; }
      assert.equal(recoveryStops,1);assert.equal(preparations,0);assert.equal(publishDispatches,0);
      assert.equal(fs.readFileSync(stateFile,'utf8'),stateBytes,'read-only restart does not clear or rewrite the previous success boundary');
      assert.equal(fs.readFileSync(attemptsFile,'utf8'),attemptBytes,'successful consume/final consume remain unchanged');
      const saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
      assert.equal(saved.active.status,status);assert.equal(saved.plans.length,1);assert.equal(saved.plans[0].status,'success');
      assert.equal(c.loadAttemptsStore(attemptsFile).consumed[frozen.confirmationId].status,'success');
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }
});

test('loadPublishedStore seeds once from the packaged seed when the store file is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const file = path.join(dir, 'published.json');
  try {
    const seeded = wf.loadPublishedStore(file, path.join(FIX, 'published-plan-seed.json'));
    assert.equal(seeded.seeded, true);
    assert.ok(seeded.publishedIds.length >= 100, '种子应包含历史已发布商品 id（4 计划约 120 个）');
    assert.equal(new Set(seeded.publishedIds).size, seeded.publishedIds.length, '种子 id 去重');

    wf.persistPublished(file, seeded);
    const reopened = wf.loadPublishedStore(file, path.join(FIX, 'published-plan-seed.json'));
    assert.equal(reopened.seeded, false, '已存在存储不得再次种子化');

    // a previously published id is skipped by selection
    const dupId = seeded.publishedIds[0];
    const step = wf.selectFromPage({ selectedIds: [], publishedSet: seeded.publishedIds, attemptedSet: [], capacity: 30 },
      [{ productId: dupId, selectable: true, text: '' }, { productId: 'NEW1', selectable: true, text: '' }]);
    assert.ok(!step.selectedIds.includes(dupId), '历史已发布商品必须去重跳过');
    assert.ok(step.selectedIds.includes('NEW1'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selectFromPage honors remaining capacity and skips attempted/disabled cards', () => {
  const step = wf.selectFromPage(
    { selectedIds: ['KEEP'], publishedSet: ['PUB'], attemptedSet: ['ATT'], capacity: 3 },
    [
      { productId: 'PUB', selectable: true, text: '' },
      { productId: 'ATT', selectable: true, text: '' },
      { productId: 'DIS', selectable: false, text: '', disabled: true },
      { productId: 'N1', selectable: true, text: '' },
      { productId: 'N2', selectable: true, text: '' },
      { productId: 'N3', selectable: true, text: '' },
    ],
  );
  assert.deepEqual(step.selectedIds, ['KEEP', 'N1', 'N2'], '按可见顺序填满剩余容量并跳过历史/当日尝试/不可选');
  assert.equal(step.full, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// req 2 — creation header / commission gate
// ═══════════════════════════════════════════════════════════════════════════
test('verifyCreationHeader requires origin, exact account id, and the commission option', () => {
  assert.equal(wf.verifyCreationHeader({ originOk: true, accountId: '1710242295996424', commissionOptionPresent: true }).ok, true);
  assert.equal(wf.verifyCreationHeader({ originOk: false, accountId: '1710242295996424', commissionOptionPresent: true }).reason, 'origin-mismatch');
  assert.equal(wf.verifyCreationHeader({ originOk: true, accountId: '999', commissionOptionPresent: true }).reason, 'account-mismatch');
  assert.equal(wf.verifyCreationHeader({ originOk: true, accountId: '1710242295996424', commissionOptionPresent: false }).reason, 'commission-option-missing');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 12 — final mutual-exclusion dialog + semantic SPAN->BUTTON
// ═══════════════════════════════════════════════════════════════════════════
test('matchFinalExclusionDialog matches whitespace-insensitively and rejects any other copy', () => {
  const spaced = wf.FINAL_EXCLUSION_TEXT.replace(/(?=.)/g, ' ').replace(/，/g, ' ， ');
  assert.equal(wf.matchFinalExclusionDialog(spaced).known, true, '仅空白差异必须视为同一已知弹窗');
  assert.equal(wf.matchFinalExclusionDialog(wf.FINAL_EXCLUSION_TEXT).known, true);
  assert.equal(wf.matchFinalExclusionDialog('为保证乘方投放的唯一性，另有未知新文案').known, false);
  assert.equal(wf.matchFinalExclusionDialog('').known, false);
});

test('resolveFinalPublishButton resolves the real semantic button, never the bare span', () => {
  assert.equal(wf.resolveFinalPublishButton({ tag: 'BUTTON' }).ok, true);
  assert.equal(wf.resolveFinalPublishButton({ tag: 'SPAN', closestButton: true }).target, 'button');
  assert.equal(wf.resolveFinalPublishButton({ tag: 'SPAN', closestButton: true }).via, 'span-closest-button');
  assert.equal(wf.resolveFinalPublishButton({ tag: 'SPAN', closestButton: false }).ok, false, 'SPAN 无最近 BUTTON 时不得当作已点击');
  assert.equal(wf.resolveFinalPublishButton(null).ok, false);
});

test('resolveFinalConfirmButtonInPage finds the unique button behind a 确认发布 span', () => {
  const btn = El('button', { class: 'ovui-btn', rect: [120, 40] }, [El('span', { rect: [100, 24], text: '确认发布' })]);
  const ctx = makeCtx([El('div', { class: 'dialog', rect: [400, 200] }, [btn])]);
  const r = ctx.run(wf.resolveFinalConfirmButtonInPage);
  assert.equal(r.ok, true);
  assert.equal(r.tag, 'BUTTON');

  const none = makeCtx([El('div', { class: 'x', rect: [10, 10], text: '别的' })]).run(wf.resolveFinalConfirmButtonInPage);
  assert.equal(none.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// req 13 — publish click is NOT success; management-page readback decides
// ═══════════════════════════════════════════════════════════════════════════
test('classifyPublishOutcome: a not-yet-found row / timeout is unknown, never failed', () => {
  assert.equal(wf.classifyPublishOutcome({ found: false }, {}).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ found: false, reason: 'timeout' }, {}).reason, 'timeout');
});

test('classifyPublishOutcome: exact readback of a live row is success', () => {
  const rb = { found: true, uniqueRow: true, accountId: wf.BUSINESS.accountId, planName: 'P', planId: '1878537802445003', productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' };
  const r = wf.classifyPublishOutcome(rb, { planName: 'P' });
  assert.equal(r.outcome, 'success');
  assert.equal(r.planId, '1878537802445003');
});

test('classifyPublishOutcome: failed status is failed; field mismatch / unknown status is unknown', () => {
  const base = { found: true, uniqueRow: true, planName: 'P', planId: '1878537802445003', productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true };
  assert.equal(wf.classifyPublishOutcome({ ...base, status: '已拒绝' }, { planName: 'P' }).outcome, 'failed');
  assert.equal(wf.classifyPublishOutcome({ ...base, productCount: 29, status: '投放中' }, { planName: 'P' }).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ ...base, roi: 4.34, status: '投放中' }, { planName: 'P' }).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ ...base, status: '莫名其妙' }, { planName: 'P' }).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ found: true, uniqueRow: false, planName: 'P' }, { planName: 'P' }).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ found: true, uniqueRow: true, planName: 'OTHER' }, { planName: 'P' }).outcome, 'unknown');
  assert.equal(wf.classifyPublishOutcome({ ...base, planId: null, status: '投放中' }, { planName: 'P' }).reason, 'plan-id-missing-or-invalid');
  assert.equal(wf.classifyPublishOutcome({ ...base, status: '投放中' }, { planName: 'P', existingPlanIds: ['1878537802445003'] }).reason, 'plan-id-not-new');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 14 — post-publish enable: minimal, delegates or stops with a reported gap
// ═══════════════════════════════════════════════════════════════════════════
test('planPostPublishEnable: enabled => zero action; paused + verified lock => delegate; else stop', () => {
  assert.equal(wf.planPostPublishEnable({ enabled: true, readOk: true }, {}).action, 'none');
  assert.equal(wf.planPostPublishEnable({ enabled: null, readOk: false }, {}).action, 'stop');
  const deleg = wf.planPostPublishEnable({ enabled: false, readOk: true }, { enableHook: { lockContractVerified: true, run() {}, name: 'locked-daily-enable' } });
  assert.equal(deleg.action, 'delegate');
  const stop = wf.planPostPublishEnable({ enabled: false, readOk: true }, {});
  assert.equal(stop.action, 'stop');
  assert.equal(stop.status, 'needs-existing-enable-capability');
  assert.ok(stop.gap && stop.gap.length > 0, '停止时必须如实报告能力缺口');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 10/11 — default NO publish; per-plan one-shot confirmation; zero-click refusals
// ═══════════════════════════════════════════════════════════════════════════
function frozenFixture(over = {}) {
  return wf.freezePlan({
    planNumber: 1, runId: 'run-1', businessDate: CONFIRM_TEST_BUSINESS_DATE, accountId: '1710242295996424',
    planName: `瑾漂亮-${CONFIRM_TEST_BUSINESS_DATE.replace(/-/g, '')}-1`, roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false,
    boundAccounts: ['79863866', '9zmao_fushi'], productIds: Array.from({ length: 30 }, (_, i) => 'ID' + i),
    disclosures: { migration: ['ID0'], precheck: [], reviewFailed: [] },
    ...over,
  }, { nowMs: CONFIRM_TEST_NOW_MS, nonce: 'fixed-nonce' });
}
function goodRequest(f) {
  return { method: 'POST', action: '确认发布本计划', nonce: f.nonce, planNumber: f.planNumber, businessDate: f.businessDate, manifestHash: f.manifestHash, acceptedDisclosures: true };
}

test('validateConfirmation authorizes only the exact POST and refuses every replay/drift variant with zero clicks', () => {
  const f = frozenFixture();
  const today = f.businessDate;
  assert.equal(wf.validateConfirmation(f, goodRequest(f), { businessDate: today }).authorized, true);

  const deny = (mut, reason) => {
    const req = goodRequest(f); mut(req);
    const r = wf.validateConfirmation(f, req, { businessDate: today });
    assert.equal(r.authorized, false);
    assert.equal(r.reason, reason);
  };
  deny(r => { r.method = 'GET'; }, 'not-a-post');                       // GET/refresh
  deny(r => { r.action = '确认发布'; }, 'action-text-mismatch');          // wrong action text
  deny(r => { r.nonce = 'other'; }, 'nonce-mismatch');                    // wrong nonce
  deny(r => { r.planNumber = 2; }, 'plan-number-mismatch');               // another plan
  deny(r => { r.manifestHash = 'deadbeef'; }, 'manifest-drift');          // drifted manifest
  deny(r => { r.businessDate = CONFIRM_TEST_PREVIOUS_DATE; }, 'business-date-mismatch');// old date in request
  deny(r => { r.acceptedDisclosures = false; }, 'disclosures-not-accepted');

  // a frozen plan from an old date is stale even if the request echoes it
  const old = frozenFixture({ businessDate: CONFIRM_TEST_PREVIOUS_DATE });
  const oldReq = goodRequest(old);
  assert.equal(wf.validateConfirmation(old, oldReq, { businessDate: CONFIRM_TEST_BUSINESS_DATE }).reason, 'stale-date-not-today');

  // consumed once => a repeat is refused (one-shot ledger)
  const consumed = new Set([f.confirmationId]);
  assert.equal(wf.validateConfirmation(f, goodRequest(f), { businessDate: today, consumed }).reason, 'confirmation-already-consumed');
});

test('manifestHash binds exact ids/params; any drift changes the hash', () => {
  const f = frozenFixture();
  assert.equal(wf.manifestHash(f), f.manifestHash);
  const drifted = { ...f, productIds: [...f.productIds.slice(0, 29), 'DIFFERENT'] };
  assert.notEqual(wf.manifestHash(drifted), f.manifestHash, '30 个 id 的精确冻结顺序被绑定进哈希');
  const roiDrift = { ...f, roi: 4.34 };
  assert.notEqual(wf.manifestHash(roiDrift), f.manifestHash);
});

test('handleConfirmRequest never fires onConfirm on a refusal (zero clicks)', () => {
  const f = frozenFixture();
  const okBody = { action: '确认发布本计划', nonce: f.nonce, planNumber: String(f.planNumber), businessDate: f.businessDate, manifestHash: f.manifestHash, acceptedDisclosures: 'true' };
  const ok = ui.handleConfirmRequest(f, okBody, { businessDate: f.businessDate, consumed: new Set() });
  assert.equal(ok.authorized, true);
  assert.equal(ok.statusCode, 200);

  const bad = ui.handleConfirmRequest(f, { ...okBody, nonce: 'wrong' }, { businessDate: f.businessDate, consumed: new Set() });
  assert.equal(bad.authorized, false);
  assert.equal(bad.statusCode, 409);
});

test('confirmation server consumes a nonce once: a repeat POST is refused and onConfirm fires exactly once', async () => {
  const f = frozenFixture();
  let fired = 0;
  const srv = ui.createConfirmationServer({ frozen: f, businessDate: f.businessDate, onConfirm: () => { fired++; } });
  const body = 'action=' + encodeURIComponent('确认发布本计划') + '&nonce=' + f.nonce + '&planNumber=' + f.planNumber
    + '&businessDate=' + f.businessDate + '&manifestHash=' + f.manifestHash + '&acceptedDisclosures=true';

  // Drive the handler deterministically with a tiny EventEmitter-like request.
  const drive = () => new Promise(resolve => {
    const handlers = {};
    const req = { method: 'POST', url: '/confirm', on(ev, cb) { handlers[ev] = cb; }, destroy() {} };
    const res = { statusCode: null, writeHead(code) { this.statusCode = code; return this; }, end(b) { resolve({ statusCode: this.statusCode, body: b }); } };
    srv.handler(req, res);
    handlers.data(body);
    handlers.end();
  });

  const first = await drive();
  assert.equal(first.statusCode, 200, '第一次显式确认被授权');
  const second = await drive();
  assert.equal(second.statusCode, 409, '同一 nonce 重复提交必须被拒绝');
  assert.ok(second.body.includes('consumed') || second.body.includes('已拒绝'));
  // onConfirm is only invoked for the authorized first request
  await new Promise(r => setTimeout(r, 5));
  assert.equal(fired, 1, 'onConfirm 恰好触发一次，消费后未知不重放');
});

test('confirmation UI retains one isolated localhost listener while sequential plans replace its view', async () => {
  const makePlan=number=>wf.freezePlan({
    planNumber:number,runId:'three-plan-run',businessDate:CONFIRM_TEST_BUSINESS_DATE,accountId:wf.BUSINESS.accountId,
    planName:'P'+number,roi:15,dailyBudget:300,commissionIncluded:true,directPay:false,
    boundAccounts:wf.BUSINESS.boundAccounts,productIds:Array.from({length:30},(_,i)=>'PRODUCT'+i),
    disclosures:{migration:['PRODUCT0'],precheck:['PRODUCT1'],reviewFailed:[]},
  },{nowMs:CONFIRM_TEST_NOW_MS,nonce:'nonce-plan-'+number});
  const first=makePlan(1),second=makePlan(2),third=makePlan(3);
  const fired=[];
  const confirm=(_authorization,plan)=>{fired.push(plan.planNumber);};
  const server=ui.createConfirmationServer({host:'127.0.0.1',port:0,frozen:first,onConfirm:confirm});
  const getPage=port=>new Promise((resolve,reject)=>{
    http.get({hostname:'127.0.0.1',port,path:'/'},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
    }).on('error',reject);
  });
  const post= (port,plan)=>new Promise((resolve,reject)=>{
    const body=new URLSearchParams({action:'确认发布本计划',nonce:plan.nonce,planNumber:String(plan.planNumber),businessDate:plan.businessDate,manifestHash:plan.manifestHash,acceptedDisclosures:'true'}).toString();
    const req=http.request({hostname:'127.0.0.1',port,path:'/confirm',method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text}));
    });req.on('error',reject);req.end(body);
  });
  try {
    const one=await server.start();
    const again=await server.start();
    assert.equal(one.address,'127.0.0.1');
    assert.equal(again.port,one.port,'start() 必须复用稳定端口');
    assert.equal(again.address,one.address);
    assert.equal((await getPage(one.port)).body.includes('P1'),true);
    assert.equal((await post(one.port,first)).status,200);
    server.setPlan(second,confirm);
    assert.equal((await getPage(one.port)).body.includes('P2'),true,'同一个服务可展示第二份计划');
    assert.equal((await post(one.port,second)).status,200);
    server.setPlan(third,confirm);
    assert.equal((await getPage(one.port)).body.includes('P3'),true,'同一个服务可展示第三份计划');
    assert.equal((await post(one.port,third)).status,200);
    assert.deepEqual(fired,[1,2,3],'三份计划各自需要单独的有效 POST 确认');
    assert.equal((await post(one.port,first)).status,409,'旧份 POST 在端口复用后仍失效');
  } finally { await server.stop(); }
});

test('renderPlanPage discloses shop, 30 ids, both accounts, params, migration/precheck and the final exclusion', () => {
  const f = frozenFixture();
  const html = ui.renderPlanPage(f);
  assert.ok(html.includes(wf.BUSINESS.shop));
  assert.ok(html.includes('79863866') && html.includes('9zmao_fushi'));
  assert.ok(html.includes('确认发布本计划'));
  assert.ok(html.includes(f.nonce) && html.includes(f.manifestHash));
  assert.ok(html.includes('全店托管') || html.includes('迁移提示'));
  assert.ok(html.includes('ID0'), '迁移披露的具体商品 id 必须展示');
  // no cookie/secret material is rendered
  assert.ok(!/cookie|token|secret|password/i.test(html));
});

// ═══════════════════════════════════════════════════════════════════════════
// req 1 — preparePlan NEVER publishes; it stops at ready-awaiting-confirmation
// ═══════════════════════════════════════════════════════════════════════════
test('preparePlan stops at ready-awaiting-confirmation and never calls any publish path', async () => {
  const published = [];
  let clickedPublish = 0;
  const cat = Array.from({ length: 30 }, (_, i) => ({ productId: 'N' + i, selectable: true, text: 'N' + i }));
  const mainRows = Array.from({ length: 30 }, (_, i) => ({ productId: 'N' + i, manualAccounts: 2, reviewFailed: false, ambiguous: false, idCount: 1 }));
  const deps = {
    businessDate: '2026-10-09', nowMs: Date.UTC(2026, 9, 9),
    planNumber: 1, runId: 'run-1', planName: 'P1',
    persistState: async () => {},
    openCreationPage: async () => ({ header: { originOk: true, accountId: '1710242295996424', commissionOptionPresent: true } }),
    readPageCards: async () => cat,
    goNextPage: async () => ({ confirmed: false }),
    bindAccountsToAll: async () => ({ ok: true }),
    readMainTable: async () => mainRows,
    // these must NEVER be touched by preparePlan
    runPublishPlan: async () => { clickedPublish++; return {}; },
    clickFinalConfirm: async () => { clickedPublish++; },
  };
  const r = await wf.preparePlan(deps);
  assert.equal(r.status, 'ready-awaiting-confirmation');
  assert.equal(clickedPublish, 0, '准备阶段绝不发布、绝不点击最终确认');
  assert.equal(r.frozen.productIds.length, 30);
  assert.equal(r.frozen.planNumber, 1);
  assert.ok(r.frozen.manifestHash && r.frozen.nonce);
});

test('preparePlan stops (keeps page) when the creation header/commission option is missing', async () => {
  const deps = {
    businessDate: '2026-10-09',
    persistState: async () => {},
    openCreationPage: async () => ({ header: { originOk: true, accountId: '1710242295996424', commissionOptionPresent: false } }),
    readPageCards: async () => { throw new Error('must-not-select'); },
  };
  const r = await wf.preparePlan(deps);
  assert.equal(r.status, 'stopped');
  assert.equal(r.stage, 'creation-header');
  assert.equal(r.reason, 'commission-option-missing');
});

// publishConfirmedPlan refuses a bad confirmation and clicks nothing.
test('publishConfirmedPlan refuses an unauthorized request and performs zero page actions', async () => {
  const f = frozenFixture();
  let touched = 0;
  const deps = { businessDate: f.businessDate, consumed: new Set(), observe: async () => { touched++; return { observation: 'x' }; }, runPublishPlan: async () => { touched++; } };
  const r = await wf.publishConfirmedPlan(f, { ...goodRequest(f), nonce: 'wrong' }, deps);
  assert.equal(r.status, 'refused');
  assert.equal(touched, 0, '未授权时不得观测、不得点击');
});

test('publishConfirmedPlan stops on an unknown final dialog after an authorized confirmation', async () => {
  const f = frozenFixture({ planName: 'P' });
  const deps = {
    businessDate: f.businessDate, consumed: new Set(),
    observe: async () => ({ observation: 'obs-1' }),
    runPublishPlan: async () => ({ clicked: true }),
    readFinalDialog: async () => ({ text: '一个全新的未知弹窗文案', confirmTarget: { tag: 'BUTTON' } }),
    clickFinalConfirm: async () => { throw new Error('must-not-click-unknown-dialog'); },
    readManagementRow: async () => ({ found: false }),
  };
  const r = await wf.publishConfirmedPlan(f, goodRequest(f), deps);
  assert.equal(r.status, 'stopped');
  assert.equal(r.stage, 'final-dialog-unknown');
});

// ═══════════════════════════════════════════════════════════════════════════
// req 9 — cookie saveback: only ok && !skipped counts; consecutive self-save + conflict
// ═══════════════════════════════════════════════════════════════════════════
test('runSaveCookies counts only ok&&!skipped as saved; conflict and skipped are never success; no cookie value leaks', async () => {
  const session = { filePath: '/tmp/cookie.json', startFingerprint: 'fp-1' };
  const probe = { originOk: true, identityOk: true, loginOk: true };
  const mk = res => ({ context: {}, cookieSession: session, probe, accountId: '1710242295996424', writeback: async () => res });

  const saved = await c.runSaveCookies({ op: 'save-cookies' }, mk({ ok: true, skipped: false, count: 12, bytes: 300, domains: ['a', 'b'] }));
  assert.equal(saved.status, 'saved');
  assert.equal(saved.success, true);
  assert.equal(saved.count, 12);
  assert.equal(saved.domains, 2, '只回读域数量，绝不输出 cookie 值');

  // consecutive self-save is idempotent and still 'saved'
  const saved2 = await c.runSaveCookies({ op: 'save-cookies' }, mk({ ok: true, skipped: false }));
  assert.equal(saved2.status, 'saved');

  // external modification => fingerprint conflict, never success, never overwrite
  const conflict = await c.runSaveCookies({ op: 'save-cookies' }, mk({ ok: false, skipped: true, conflict: true, reason: 'fingerprint-changed' }));
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.success, false, '冲突绝不是成功保存');
  assert.equal(conflict.conflict, true);

  // a skipped (unchanged) write is not a save
  const skip = await c.runSaveCookies({ op: 'save-cookies' }, mk({ ok: true, skipped: true }));
  assert.equal(skip.status, 'skipped');
  assert.notEqual(skip.status, 'saved');

  // no live session / unconfirmed identity never even calls writeback
  const noSession = await c.runSaveCookies({ op: 'save-cookies' }, { context: {}, cookieSession: null, probe, writeback: async () => ({ ok: true, skipped: false }) });
  assert.equal(noSession.status, 'skipped');
  const noProbe = await c.runSaveCookies({ op: 'save-cookies' }, { context: {}, cookieSession: session, probe: { originOk: false }, writeback: async () => ({ ok: true, skipped: false }) });
  assert.equal(noProbe.status, 'skipped');

  // metadata-only: no cookie material / file path in the summary
  assert.ok(!JSON.stringify(saved).includes('cookie.json'));
});

test('cookie session fingerprint advances only on exact owned-write SHA, byte, count and domain readback', () => {
  const hashA='a'.repeat(64),hashB='b'.repeat(64),hashExternal='c'.repeat(64);
  const session={startFingerprint:{exists:true,size:120,mtimeMs:1,sha256:hashA}};
  const expectedA={sha256:hashA,bytes:120,count:3,domains:2};
  const summaryA={status:'saved',success:true,bytes:120,count:3,domains:2};
  const readbackA={exists:true,size:120,mtimeMs:2,sha256:hashA};
  for(let i=0;i<3;i++) {
    const result=c.updateCookieSessionFingerprint(session,summaryA,expectedA,readbackA);
    assert.equal(result.updated,true,'内容不变的三次连续自有回写可保留同一 fingerprint');
    assert.equal(session.startFingerprint.sha256,hashA);
  }

  const ownChangedWrite={sha256:hashB,bytes:140,count:4,domains:2};
  const summaryB={status:'saved',success:true,bytes:140,count:4,domains:2};
  const readbackB={exists:true,size:140,mtimeMs:3,sha256:hashB};
  assert.equal(c.updateCookieSessionFingerprint(session,summaryB,ownChangedWrite,readbackB).updated,true);
  assert.equal(session.startFingerprint.sha256,hashB,'hash只在与本次owned context序列化摘要一致后滚动');

  const beforeConflict=session.startFingerprint;
  const conflict={status:'conflict',success:false,conflict:true};
  const externalReadback={exists:true,size:144,mtimeMs:4,sha256:hashExternal};
  assert.equal(c.updateCookieSessionFingerprint(session,conflict,ownChangedWrite,externalReadback).updated,false);
  assert.equal(session.startFingerprint,beforeConflict,'外部冲突不刷新会话基线');
  assert.equal(c.updateCookieSessionFingerprint(session,summaryB,ownChangedWrite,externalReadback).updated,false,'helper成功但读回SHA不同也不吸收外部写入');
  assert.equal(session.startFingerprint,beforeConflict);
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider imports and model/network call sites are prohibited. Explanatory
// comments may describe the no-model design without becoming executable APIs.
// ═══════════════════════════════════════════════════════════════════════════
test('flow source imports no model provider and makes no model or network inference calls', () => {
  const files = ['plan-workflow.cjs', 'confirmation-ui.cjs', 'run-plans.cjs', 'direct-draft-controller.cjs'];
  const forbiddenProvider = /(?:openai|anthropic|claude|dashscope|generativelanguage|@azure\/openai|langchain|litellm)/i;
  const forbiddenCall = /\b(?:fetch|axios\.(?:get|post|request)|createCompletion|chat\.completions\.create)\s*\(/i;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...src.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    assert.ok(!imports.some(name => forbiddenProvider.test(name)), f + '不得导入模型提供方依赖');
    assert.equal(src.match(forbiddenCall), null, f + '不得发起模型或网络推理调用');
  }
  const entry = fs.readFileSync(path.join(__dirname, 'run-plans.cjs'), 'utf8');
  for (const local of ['./plan-workflow.cjs', './direct-draft-controller.cjs', './confirmation-ui.cjs']) {
    assert.ok(entry.includes(`require('${local}')`), 'live entry must reach the tested deterministic local flow');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Guidance flow (AD-PLAN-FLOW-FREEZE-20261010-F1-R9): real exported callbacks
// against the live c-lib mask DOM, the open Firefly ShadowRoot notice, honest
// unknown/drift/duplicate/disabled stops, private per-account flag restore and
// persistence, and the scroll-container disabled false-positive fix.
// ═══════════════════════════════════════════════════════════════════════════
function clibGuideMask(text, label, {buttonDisabled=false,ariaDisabled=false}={}) {
  const button=El('div',{class:'c-lib-guide-button inbl',rect:[80,24],text:label,disabled:buttonDisabled,attrs:ariaDisabled?{'aria-disabled':'true'}:undefined});
  const actions=El('div',{class:'c-lib-guide-actions',rect:[200,30]},[button]);
  const bottom=El('div',{class:'c-lib-guide-bottom',rect:[200,30]},[actions]);
  const body=El('div',{class:'c-lib-guide-body',rect:[240,120],text},[bottom]);
  const mask=El('div',{class:'c-lib-guide-mask',rect:[800,600]},[body]);
  return {mask,button,body};
}
function fireflyGuideNotice(text,label) {
  const button=El('div',{class:' firefly-content__button firefly-content__next-step-button ',rect:[120,32],text:label});
  const container=El('div',{class:'firefly-content__button-container',rect:[120,32]},[button]);
  const stepContainer=El('div',{class:'firefly-content__step-container firefly-content__custom-button',rect:[220,60]},[container]);
  const popper=El('div',{class:'firefly-popper-content',rect:[260,140],text},[stepContainer]);
  const host=El('firefly-content',{rect:[260,140]});
  const sr=host.attachShadow({mode:'open'});
  popper.parent=host;
  sr.__kids.push(popper);
  return {host,button,popper};
}
function guidanceDomPage(maskRef) {
  return dom => ({evaluate:async(fn,arg)=>{
    const r=dom.run(fn,arg);
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step'&&r&&r.clicked&&maskRef)maskRef.__rect=undefined;
    return r;
  }});
}
// An ordinary business custom element whose OPEN shadow tree merely copies the
// Firefly class shape. It is NOT a FIREFLY-CONTENT host and must never be
// collected as guidance nor clicked.
function ordinaryBusinessFireflyWidget(text,label) {
  const button=El('div',{class:'firefly-content__button firefly-content__next-step-button',rect:[120,32],text:label});
  const popper=El('div',{class:'firefly-popper-content',rect:[260,140],text},[button]);
  const host=El('ordinary-business-widget',{rect:[260,140]});
  const sr=host.attachShadow({mode:'open'});
  popper.parent=host;
  sr.__kids.push(popper);
  return {host,button,popper};
}
// A genuine FIREFLY-CONTENT open-shadow host with a VISIBLE popper whose control
// is either absent ('missing') or carries an unrecognized class ('different'),
// so no known allowed selector matches. The popper must still be retained and
// reported unknown, never silently dropped.
function fireflyUnknownControlNotice(text,{mode='missing'}={}) {
  const control=mode==='different'?El('div',{class:'some-unrecognized-cta-button',rect:[120,32],text:'立即体验'}):null;
  const popper=El('div',{class:'firefly-popper-content',rect:[260,140],text},control?[control]:[]);
  const host=El('firefly-content',{rect:[260,140]});
  const sr=host.attachShadow({mode:'open'});
  popper.parent=host;
  sr.__kids.push(popper);
  return {host,popper,button:control};
}

test('guidance flow: real callback walks the three live c-lib mask steps with one fresh click each', async () => {
  const steps=[
    {text:'达人自动投已就绪，合作达人素材自动拉取投放 单计划支持投多个抖音号，不用逐个建计划； 可选择「联盟合作抖音号」，达人授权后一键投放 开启「联盟合作达人自动投」后，合作达人素材自动拉取投放，无需逐条创建',label:'下一步'},
    {text:'营销引擎更高效，低佣好素材优先拿量 含达人佣金出价：出价自动包含佣金成本，系统优先多投低佣高转素材，效果更可控',label:'下一步'},
    {text:'综合营销ROI 口径已升级，别照搬全域数值 分母比全域多了达人佣金成本，所以目标值会比净成交 ROI 低，建议参考系统建议出价设置。',label:'我知道了'},
  ];
  const built=steps.map(s=>clibGuideMask(s.text,s.label));
  let index=0;
  const page={evaluate:async(fn,arg)=>{
    const dom=makeCtx(index<built.length?[built[index].mask]:[]);
    const r=dom.run(fn,arg);
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step')index++;
    return r;
  }};
  const result=await rp.runGuidanceOnPage(page,wf.BUSINESS.accountId);
  assert.equal(result.handled.length,3,JSON.stringify(result.handled));
  assert.deepEqual(result.handled.map(h=>h.kind),['clib','clib','clib']);
  assert.deepEqual(result.handled.map(h=>h.label),['下一步','下一步','我知道了']);
  built.forEach((b,i)=>assert.equal(b.button.__clicks,1,'mask step '+(i+1)+' 恰好一次原生 click'));
});

test('guidance flow: open Firefly ShadowRoot notice is found through real shadow traversal and clicked exactly once', () => {
  const notice=fireflyGuideNotice('千川乘方重磅升级 乘方是更高效的智能营销引擎,针对达人营销、素材获取和权益发放等多项营销能力调优,通过智能分配投放预算和权益补贴,让每一笔投入更高效。','我知道了');
  const drawerNext=El('button',{rect:[100,30],text:'下一步'});
  const dom=makeCtx([notice.host,drawerNext]);
  const snap=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snap.present,true);
  assert.equal(snap.roots.length,1);
  assert.equal(snap.roots[0].kind,'firefly');
  assert.match(snap.roots[0].content,/千川乘方重磅升级/);
  assert.equal(snap.roots[0].label,'我知道了');
  const stepped=plain(dom.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,...snap.roots[0]}));
  assert.equal(stepped.clicked,true);
  assert.equal(notice.button.__clicks,1,'shadow 内指导按钮恰好一次 click');
  assert.equal(drawerNext.__clicks,undefined,'业务下一步按钮不属于指导根，零动作');
  notice.popper.__rect=undefined;
  const after=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(after.present,false,'click 后新鲜回读确认通知消失');
});

test('guidance flow: product drawer 下一步, 确认发布 and plain business buttons never enter the guidance snapshot', () => {
  const drawer=El('div',{attrs:{role:'dialog'},rect:[500,400],text:'全部 店铺新品 破圈尖货 搜索趋势 已选 0 / 30'},[El('button',{rect:[100,30],text:'下一步'})]);
  const final=El('div',{attrs:{role:'dialog'},class:'confirm-modal',rect:[400,200],text:'为保证乘方投放的唯一性'},[El('button',{rect:[100,30],text:'确认发布'})]);
  const publish=El('button',{rect:[120,34],text:'发布计划'});
  const dom=makeCtx([drawer,final,publish]);
  const snap=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snap.present,false);
  assert.equal(snap.unknown,null);
  assert.equal(totalClicks(dom.body),0,'零指导时零动作');
  assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,order:0,kind:'clib',content:'x',label:'下一步'}),/guidance-root-drift/);
  assert.equal(totalClicks(dom.body),0,'漂移绑定仍然零动作');
});

test('guidance flow: unknown label, duplicate roots and disabled buttons stop honestly with zero clicks', () => {
  const unknown=clibGuideMask('一个从未见过的引导形状','稍后再说');
  const domUnknown=makeCtx([unknown.mask]);
  const snapUnknown=plain(domUnknown.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snapUnknown.unknown,'guidance-unknown-root-shape');
  assert.throws(()=>domUnknown.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,order:0,kind:'clib',content:'x',label:'下一步'}),/guidance-unknown-root-shape/);
  assert.equal(unknown.button.__clicks,undefined);

  const a=clibGuideMask('第一个引导','下一步');
  const b=clibGuideMask('第二个引导','我知道了');
  const domDup=makeCtx([a.mask,b.mask]);
  const snapDup=plain(domDup.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snapDup.unknown,'guidance-root-duplicate');
  assert.equal(a.button.__clicks,undefined);assert.equal(b.button.__clicks,undefined);
  assert.throws(()=>domDup.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,order:0,kind:'clib',content:'x',label:'下一步'}),/guidance-root-duplicate/);

  const aria=clibGuideMask('被禁用的引导内容','我知道了',{ariaDisabled:true});
  const domAria=makeCtx([aria.mask]);
  const snapAria=plain(domAria.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snapAria.present,true);
  assert.equal(snapAria.roots[0].disabled,true);
  assert.throws(()=>domAria.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,...snapAria.roots[0]}),/guidance-button-disabled/);
  assert.equal(aria.button.__clicks,undefined);

  const native=clibGuideMask('原生disabled的引导','下一步',{buttonDisabled:true});
  const domNative=makeCtx([native.mask]);
  const snapNative=plain(domNative.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snapNative.roots[0].disabled,true);
  assert.throws(()=>domNative.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,...snapNative.roots[0]}),/guidance-button-disabled/);
  assert.equal(native.button.__clicks,undefined);
});

test('guidance flow: off-route or wrong-aavid pages throw guidance-page-not-authorized before any action', () => {
  const m=clibGuideMask('任何引导','下一步');
  const wrongPath=makeCtx([m.mask],{pathname:'/uni-prom/overall'});
  assert.throws(()=>wrongPath.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}),/guidance-page-not-authorized/);
  const wrongAavid=makeCtx([m.mask],{search:'?aavid=9999999999999999'});
  assert.throws(()=>wrongAavid.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}),/guidance-page-not-authorized/);
  assert.equal(m.button.__clicks,undefined,'未授权页零动作');
});

test('guidance flow: content drift between snapshot and step refuses with zero clicks', () => {
  const m=clibGuideMask('原始引导文本','下一步');
  const dom=makeCtx([m.mask]);
  const snap=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:wf.BUSINESS.accountId}));
  assert.equal(snap.roots.length,1);
  m.body.__text='文本已被页面替换';
  assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'step',accountId:wf.BUSINESS.accountId,...snap.roots[0]}),/guidance-root-drift/);
  assert.equal(m.button.__clicks,undefined);
});

test('guidance phase: zero guidance means zero cookie writes and zero flag writes', async () => {
  let saveCalls=0,persistCalls=0;
  const page={evaluate:async()=>({present:false,unknown:null,roots:[]})};
  const phase=await rp.runGuidancePhase(page,{accountId:wf.BUSINESS.accountId,saveCookies:async()=>{saveCalls++;return {status:'saved'};},persistFlags:async()=>{persistCalls++;return {saved:true,count:1};}});
  assert.equal(phase.handled,0);
  assert.equal(saveCalls,0);assert.equal(persistCalls,0);
  assert.equal(phase.cookieStatus,'not-needed');
  assert.equal(phase.flagsSaved,false);
});

async function phaseWithOneGuidanceStep(cookieResult, flagsResult = { saved: true, count: 1 }) {
  const m=clibGuideMask('营销引擎更高效，低佣好素材优先拿量 含达人佣金出价：出价自动包含佣金成本，系统优先多投低佣高转素材，效果更可控','下一步');
  const dom=makeCtx([m.mask]);
  let saveCalls=0,persistCalls=0;
  const page=guidanceDomPage(m.mask)(dom);
  const phase=await rp.runGuidancePhase(page,{accountId:wf.BUSINESS.accountId,
    saveCookies:async()=>{saveCalls++;return cookieResult;},
    persistFlags:async()=>{persistCalls++;return flagsResult;}});
  return {phase,saveCalls,persistCalls,m};
}

test('guidance phase: cookie skipped/failed persists private flags independently; a real flags failure still fails closed', async () => {
  // AD-GUIDANCE-COOKIE-PERSIST: the private guidance file is an independent store;
  // the old coupled rule (skip persistence and fabricate flagsReason=cookie-not-saved
  // whenever the working-cookie write was not 'saved') is gone. flagsSaved=true now
  // means exactly one thing: the real atomic write + identical readback succeeded.
  for(const cookie of [{status:'skipped',reason:'live-cookie-session-unavailable'},{status:'failed',reason:'write-helper-threw'}]) {
    const h=await phaseWithOneGuidanceStep(cookie);
    assert.equal(h.phase.handled,1,JSON.stringify(cookie));
    assert.equal(h.m.button.__clicks,1);
    assert.equal(h.saveCalls,1,'一次完成只写一次 Cookie');
    assert.equal(h.persistCalls,1,'指导旗标独立于 Cookie 结果，耐久保存恰好尝试一次');
    assert.equal(h.phase.flagsSaved,true,'旗标真实回读成功即 saved，即使 Cookie 未保存');
    assert.equal(h.phase.flagsReason,null);
    assert.notEqual(String(h.phase.flagsReason),'cookie-not-saved','不再伪造 cookie-not-saved');
  }
  // 旗标自身写回失败：继续 fail-closed，携带确定性原因。
  const h2=await phaseWithOneGuidanceStep({status:'failed',reason:'write-helper-threw'},{saved:false,reason:'guidance-state-readback-mismatch'});
  assert.equal(h2.persistCalls,1);
  assert.equal(h2.phase.flagsSaved,false);
  assert.equal(h2.phase.flagsReason,'guidance-state-readback-mismatch');
});

test('guidance phase: cookie CAS conflict preserves newer cookie and persists private guidance state', async () => {
  const h=await phaseWithOneGuidanceStep({status:'failed',reason:'cookie-write-conflict',conflict:true});
  assert.equal(h.phase.handled,1);
  assert.equal(h.saveCalls,1);
  assert.equal(h.persistCalls,1,'冲突时不覆盖 Cookie，但保存账号隔离的指导状态');
  assert.equal(h.phase.conflict,true);
  assert.equal(h.phase.flagsSaved,true);
  assert.equal(h.phase.flagsReason,null);
});

test('guidance phase: saved cookie then allowed-key capture, atomic private write and exact readback', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-phase-'));
  const file=rp.guidanceFilePath(wf.BUSINESS.accountId,dir);
  const m=clibGuideMask('千川乘方重磅升级 提示内容','我知道了');
  const dom=makeCtx([m.mask],{}, {
    'qc_lite_c_guide_uni-creation-product-mission-upgrade-video':'1',
    'compeleted-fireflies':'{"ids":[7]}',
    'user-guide-achieved-tasks':'["task-a"]',
    ['UNI_PROM_GUIDE_FREQ_OVERALL_'+wf.BUSINESS.accountId]:'{"count":3}',
    'session_token':'SECRET-DO-NOT-PERSIST',
    'uid_auth':'SECRET-DO-NOT-PERSIST',
    'tt_workday_outside_2':'SECRET-DO-NOT-PERSIST',
  });
  const page=guidanceDomPage(m.mask)(dom);
  const phase=await rp.runGuidancePhase(page,{accountId:wf.BUSINESS.accountId,
    saveCookies:async()=>({status:'saved',count:92,bytes:24496,domains:18,conflict:false}),
    persistFlags:async()=>{
      const captured=await page.evaluate(rp.guidanceStorageCaptureInPage,wf.BUSINESS.accountId);
      return rp.persistPrivateGuidanceState(file,wf.BUSINESS.accountId,captured.values);
    }});
  assert.equal(phase.handled,1);
  assert.equal(phase.cookieStatus,'saved');
  assert.equal(phase.flagsSaved,true,JSON.stringify(phase));
  assert.equal(phase.flagCount,4,'仅四个白名单指导键');
  const written=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(written.version,1);
  assert.equal(written.accountId,String(wf.BUSINESS.accountId));
  assert.equal(written.origin,'https://qianchuan.jinritemai.com');
  const keys=written.values.map(v=>v.key).sort();
  assert.deepEqual(keys,['UNI_PROM_GUIDE_FREQ_OVERALL_'+wf.BUSINESS.accountId,'compeleted-fireflies','qc_lite_c_guide_uni-creation-product-mission-upgrade-video','user-guide-achieved-tasks']);
  const raw=fs.readFileSync(file,'utf8');
  assert.ok(!raw.includes('SECRET'),'cookie/auth 值绝不进入私有指导文件');
  const read=rp.readPrivateGuidanceState(file,wf.BUSINESS.accountId);
  assert.equal(read.ok,true);
  assert.equal(read.values.length,4);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('private guidance state: schema/key/duplicate/account boundaries refuse writes and preserve files', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-state-'));
  const file=rp.guidanceFilePath(wf.BUSINESS.accountId,dir);
  const acct=String(wf.BUSINESS.accountId);
  // incoming unknown key refuses
  let r=rp.persistPrivateGuidanceState(file,acct,[{key:'auth_token',value:'x'}]);
  assert.equal(r.saved,false);assert.equal(r.reason,'guidance-state-key-not-allowed');
  assert.equal(fs.existsSync(file),false,'拒绝时不创建文件');
  // incoming duplicate keys refuse
  r=rp.persistPrivateGuidanceState(file,acct,[{key:'compeleted-fireflies',value:'a'},{key:'compeleted-fireflies',value:'b'}]);
  assert.equal(r.saved,false);assert.equal(r.reason,'guidance-state-duplicate-key');
  // valid write then wrong-account existing file refuses overwrite and preserves bytes
  r=rp.persistPrivateGuidanceState(file,acct,[{key:'compeleted-fireflies',value:'first'}]);
  assert.equal(r.saved,true);
  const original=fs.readFileSync(file,'utf8');
  const foreign=JSON.parse(original);foreign.accountId='9999999999999999';
  fs.writeFileSync(file,JSON.stringify(foreign));
  const foreignBytes=fs.readFileSync(file,'utf8');
  r=rp.persistPrivateGuidanceState(file,acct,[{key:'compeleted-fireflies',value:'second'}]);
  assert.equal(r.saved,false);assert.equal(r.reason,'guidance-state-schema-invalid');
  assert.equal(fs.readFileSync(file,'utf8'),foreignBytes,'错账户文件必须原样保留');
  // corrupted JSON existing file refuses and preserves
  fs.writeFileSync(file,'{not json');
  r=rp.persistPrivateGuidanceState(file,acct,[{key:'compeleted-fireflies',value:'third'}]);
  assert.equal(r.saved,false);assert.equal(r.reason,'private-guidance-file-invalid-json');
  assert.equal(fs.readFileSync(file,'utf8'),'{not json');
  // valid existing keys are merged (unknown-change preserved), captured keys update
  fs.writeFileSync(file,original);
  r=rp.persistPrivateGuidanceState(file,acct,[{key:'compeleted-fireflies',value:'updated'},{key:'user-guide-achieved-tasks',value:'["t"]'}]);
  assert.equal(r.saved,true);
  const merged=rp.readPrivateGuidanceState(file,acct);
  assert.equal(merged.ok,true);
  const map=new Map(merged.values.map(v=>[v.key,v.value]));
  assert.equal(map.get('compeleted-fireflies'),'updated');
  assert.equal(map.get('user-guide-achieved-tasks'),'["t"]');
  assert.equal(map.size,2,'原文件的 compeleted-fireflies 被更新，新键并入，共两项');
  fs.rmSync(dir,{recursive:true,force:true});
});

test('private guidance keys: only qc_lite_c_guide_ prefix, firefly, achieved-tasks and exact-account freq are allowed', () => {
  const acct=String(wf.BUSINESS.accountId);
  assert.equal(rp.isAllowedGuidanceKey('qc_lite_c_guide_uni-creation-product-mission-upgrade-video',acct),true);
  assert.equal(rp.isAllowedGuidanceKey('qc_lite_c_guide_anything',acct),true);
  assert.equal(rp.isAllowedGuidanceKey('compeleted-fireflies',acct),true);
  assert.equal(rp.isAllowedGuidanceKey('user-guide-achieved-tasks',acct),true);
  assert.equal(rp.isAllowedGuidanceKey('UNI_PROM_GUIDE_FREQ_OVERALL_'+acct,acct),true);
  assert.equal(rp.isAllowedGuidanceKey('UNI_PROM_GUIDE_FREQ_OVERALL_9999999999999999',acct),false,'其它账户的 freq 键拒绝');
  assert.equal(rp.isAllowedGuidanceKey('completed-fireflies',acct),false,'拼写错误的键不放大');
  assert.equal(rp.isAllowedGuidanceKey('sessionid',acct),false);
  assert.equal(rp.isAllowedGuidanceKey('',acct),false);
});

test('guidance restore: valid private file injects before app scripts and restores only missing allowed keys', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-restore-'));
  const acct=String(wf.BUSINESS.accountId);
  const file=rp.guidanceFilePath(acct,dir);
  const registered=[];
  const context={addInitScript:(fn,arg)=>registered.push({fn,arg})};
  const install=await rp.installGuidanceRestore(context,acct,{baseDir:dir});
  assert.equal(install.registered,false);
  assert.equal(install.reason,'private-guidance-file-missing');
  assert.equal(registered.length,0,'缺文件时不注册');
  rp.persistPrivateGuidanceState(file,acct,[
    {key:'qc_lite_c_guide_uni-creation-product-mission-upgrade-video',value:'1'},
    {key:'compeleted-fireflies',value:'{"ids":[7]}'},
  ]);
  const ok=await rp.installGuidanceRestore(context,acct,{baseDir:dir});
  assert.equal(ok.registered,true);assert.equal(ok.count,2);
  assert.equal(registered.length,1,'有效文件恰好注册一次 init script');
  // 新 creation 文档在应用初始化前执行 init script：缺失键恢复
  const fresh=makeCtx([],{},{});
  fresh.run(registered[0].fn,registered[0].arg);
  assert.equal(fresh.store['qc_lite_c_guide_uni-creation-product-mission-upgrade-video'],'1');
  assert.equal(fresh.store['compeleted-fireflies'],'{"ids":[7]}');
  // 已存在更新的值不被覆盖
  const newer=makeCtx([],{},{'compeleted-fireflies':'live-newer'});
  newer.run(registered[0].fn,registered[0].arg);
  assert.equal(newer.store['compeleted-fireflies'],'live-newer');
  assert.equal(newer.store['qc_lite_c_guide_uni-creation-product-mission-upgrade-video'],'1','同批其它缺失键仍恢复');
  // 错误 aavid / 错误 origin 不写任何东西
  const wrongAavid=makeCtx([],{search:'?aavid=9999999999999999'},{});
  wrongAavid.run(registered[0].fn,registered[0].arg);
  assert.equal(Object.keys(wrongAavid.store).length,0);
  const wrongOrigin=makeCtx([],{origin:'https://qianchuan.jinritemai.com.evil.test'},{});
  wrongOrigin.run(registered[0].fn,registered[0].arg);
  assert.equal(Object.keys(wrongOrigin.store).length,0);
  const wrongPath=makeCtx([],{pathname:'/uni-prom/overall'},{});
  wrongPath.run(registered[0].fn,registered[0].arg);
  assert.equal(Object.keys(wrongPath.store).length,0);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('guidance restore: bad-format, wrong-account, unknown-key or duplicate-key private files refuse registration untouched', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-restore-reject-'));
  const acct=String(wf.BUSINESS.accountId);
  const file=rp.guidanceFilePath(acct,dir);
  const registered=[];
  const context={addInitScript:(fn,arg)=>registered.push({fn,arg})};
  const bad=[
    ['{not json','private-guidance-file-invalid-json'],
    [JSON.stringify({version:1,accountId:'9999999999999999',origin:'https://qianchuan.jinritemai.com',values:[]}),'guidance-state-schema-invalid'],
    [JSON.stringify({version:1,accountId:acct,origin:'https://evil.example',values:[]}),'guidance-state-schema-invalid'],
    [JSON.stringify({version:1,accountId:acct,origin:'https://qianchuan.jinritemai.com',values:[{key:'auth_token',value:'x'}]}),'guidance-state-key-not-allowed'],
    [JSON.stringify({version:1,accountId:acct,origin:'https://qianchuan.jinritemai.com',values:[{key:'compeleted-fireflies',value:'a'},{key:'compeleted-fireflies',value:'b'}]}),'guidance-state-duplicate-key'],
  ];
  for(const [content,reason] of bad) {
    fs.writeFileSync(file,content);
    const res=await rp.installGuidanceRestore(context,acct,{baseDir:dir});
    assert.equal(res.registered,false,content.slice(0,30));
    assert.equal(res.reason,reason);
    assert.equal(registered.length,0,'非法私有文件既不注入也不触碰');
    assert.equal(fs.readFileSync(file,'utf8'),content,'非法文件原样保留');
  }
  fs.rmSync(dir,{recursive:true,force:true});
});

test('run-plans nested tab tree: scroll-container --disabled-left/right ancestors are NOT category-disabled (live false positive fixed)', () => {
  const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0}));
  const navList=nestedDrawerTabList(chains);
  const scroll=El('div',{class:'ovui-tabs__nav-list-scroll-container ovui-tabs__nav-list-scroll-container--disabled-left ovui-tabs__nav-list-scroll-container--disabled-right',rect:[600,40]},[navList]);
  const nav=El('div',{class:'ovui-tabs__nav',rect:[600,50]},[scroll]);
  const tabsRoot=El('div',{class:'ovui-tabs oc-tabs-hide-line oc-tabs-default',rect:[600,60]},[nav]);
  const drawer=El('div',{class:'ovui-drawer__wrap ovui-drawer__wrap--right',rect:[600,500]},[
    tabsRoot,El('div',{rect:[600,40],text:'已选 0/30'}),El('button',{rect:[100,30],text:'下一步'}),
  ]);
  const ctx=makeCtx([drawer]);
  const result=plain(ctx.run(rp.clickDrawerTabInPage,'店铺新品'));
  assert.deepEqual(result,{clicked:true,alreadyActive:false},'横向滚动两端 class 不再误判分类禁用');
  assert.equal(chains[1].wrapper.__clicks,1,'恰好一次 owner click');
  assert.equal(totalClicks(drawer),1);
});

test('run-plans nested tab tree: true disabled evidence (native, inherited aria, exact token) still refuses with zero clicks', () => {
  const build=extra=>{
    const chains=['全部','店铺新品','破圈尖货','搜索趋势'].map((label,index)=>nestedTab(label,{active:index===0}));
    const navList=nestedDrawerTabList(chains,extra&&extra.attrs||{});
    if(extra&&extra.nativeDisabled)navList.disabled=true;
    const scroll=El('div',{class:'ovui-tabs__nav-list-scroll-container ovui-tabs__nav-list-scroll-container--disabled-left',rect:[600,40]},[navList]);
    const drawer=El('div',{class:'ovui-drawer__wrap ovui-drawer__wrap--right',rect:[600,500]},[
      El('div',{class:'ovui-tabs__nav',rect:[600,50]},[scroll]),El('div',{rect:[600,40],text:'已选 0/30'}),El('button',{rect:[100,30],text:'下一步'}),
    ]);
    return {chains,drawer};
  };
  const aria=build({attrs:{'aria-disabled':'true'}});
  const ctxAria=makeCtx([aria.drawer]);
  assert.throws(()=>ctxAria.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-disabled:店铺新品/);
  assert.equal(totalClicks(aria.drawer),0,'继承真实 aria-disabled 仍拒绝');
  const native=build({nativeDisabled:true});
  const ctxNative=makeCtx([native.drawer]);
  assert.throws(()=>ctxNative.run(rp.clickDrawerTabInPage,'店铺新品'),/category-tab-disabled:店铺新品/);
  assert.equal(totalClicks(native.drawer),0,'原生 disabled 仍拒绝');
});

test('run-plans openCreationPage handles live guidance right after identity confirmation without touching publish', async () => {
  const guideDir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-opencreation-'));
  try {
  const fixture=configureCreationFixture();
  const publishBtn=fixture[fixture.length-1];
  const m=clibGuideMask('达人自动投已就绪，合作达人素材自动拉取投放 单计划支持投多个抖音号，不用逐个建计划； 下一步'.replace(' 下一步',''),'下一步');
  const dom=makeCtx([...fixture,m.mask]);
  let stepClicks=0;
  const page={goto:async()=>{},evaluate:async(fn,arg)=>{
    const r=dom.run(fn,arg);
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step'&&r&&r.clicked){stepClicks++;m.mask.__rect=undefined;}
    return r;
  }};
  const context={newPage:async()=>page};
  const driver=rp.createRealDrivers({page:null,managerPage:{},context,dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},guidancePrivateDir:guideDir,projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.openCreationPage();
  assert.equal(result.header.originOk,true);
  assert.equal(result.header.accountId,String(wf.BUSINESS.accountId));
  assert.equal(result.header.commissionOptionPresent,true);
  assert.equal(result.guidance.handled,1,'身份确认后立即处理真实指导');
  // AD-GUIDANCE-COOKIE-PERSIST: no live cookie session means the working-cookie layer
  // honestly reports skipped; the PRIVATE guidance layer is independent, and here the
  // production persistFlags closure really writes + reads back its own file, so
  // flagsSaved=true is a durable fact, never a cookie-layer claim.
  assert.equal(result.guidance.flagsSaved,true,'独立旗标文件真实耐久保存');
  assert.equal(rp.readPrivateGuidanceState(rp.guidanceFilePath(wf.BUSINESS.accountId,guideDir),wf.BUSINESS.accountId).ok,true,'旗标可从私有文件回读');
  assert.equal(m.button.__clicks,1);
  assert.equal(stepClicks,1);
  assert.equal(publishBtn.__clicks,undefined,'发布按钮零动作');
  } finally { fs.rmSync(guideDir,{recursive:true,force:true}); }
});

test('run-plans configurePlan clears a mask-stage 下一步 before reading back ROI15/budget300 and never publishes', async () => {
  const fixture=configureCreationFixture();
  const publishBtn=fixture[fixture.length-1];
  const m=clibGuideMask('综合营销ROI 口径已升级，别照搬全域数值 分母比全域多了达人佣金成本，所以目标值会比净成交 ROI 低，建议参考系统建议出价设置。','我知道了');
  const dom=makeCtx([...fixture,m.mask]);
  const page={evaluate:async(fn,arg)=>{
    const r=dom.run(fn,arg);
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step'&&r&&r.clicked)m.mask.__rect=undefined;
    return r;
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.configurePlan({businessDate:'2026-10-10'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(m.button.__clicks,1,'配置阶段前指导被真实处理');
  const verified=dom.run(c.pageObserve).creation;
  assert.equal(verified.roi,'15');assert.equal(verified.budget,'300');
  assert.equal(verified.commissionChecked,true);assert.equal(verified.optionalDirectPayChecked,false);
  assert.equal(publishBtn.__clicks,undefined,'配置阶段绝不触碰发布');
});

// ═══════════════════════════════════════════════════════════════════════════
// R10 focused regressions: the five reproduced guidance gaps (transient empty
// between async steps, awaited addInitScript registration, strict aavid
// semantics, inherited disabled scope, real FIREFLY-CONTENT host lock) plus a
// driver-level delayed chained guidance run that never publishes. All exercise
// the REAL exported callbacks; nothing is stubbed with a canned safe snapshot.
// ═══════════════════════════════════════════════════════════════════════════

test('guidance flow: real runner survives transient empty snapshots between async steps and clicks each fresh root once', async () => {
  const built=[
    clibGuideMask('达人自动投已就绪，合作达人素材自动拉取投放 第一步','下一步'),
    clibGuideMask('营销引擎更高效，低佣好素材优先拿量 第二步','下一步'),
    clibGuideMask('综合营销ROI 口径已升级，别照搬全域数值 第三步','我知道了'),
  ];
  let index=0,gap=0;
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step'){
      const r=makeCtx(index<built.length?[built[index].mask]:[]).run(fn,arg);
      if(r&&r.clicked){index++;gap=index<built.length?2:0;}
      return r;
    }
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='snapshot'){
      if(gap>0){gap--;return plain(makeCtx([]).run(fn,arg));}
      return plain(makeCtx(index<built.length?[built[index].mask]:[]).run(fn,arg));
    }
    return makeCtx([]).run(fn,arg);
  }};
  const result=await rp.runGuidanceOnPage(page,wf.BUSINESS.accountId);
  assert.equal(result.handled.length,3,'transient zero-root reads must not finish the sequence early');
  assert.deepEqual(result.handled.map(h=>h.label),['下一步','下一步','我知道了']);
  built.forEach((b,i)=>assert.equal(b.button.__clicks,1,'step '+(i+1)+' exactly one real click'));
});

test('guidance restore: installGuidanceRestore awaits addInitScript and never claims success before registration resolves', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guide-restore-async-'));
  const withinTmp=()=>path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'guide-restore-async-');
  try{
    assert.ok(withinTmp(),'合成临时目录必须位于系统 tmp 内');
    const acct=String(wf.BUSINESS.accountId);
    const file=rp.guidanceFilePath(acct,dir);
    rp.persistPrivateGuidanceState(file,acct,[{key:'qc_lite_c_guide_synthetic',value:'1'}]);
    let release,registered=false;
    const pending=new Promise(resolve=>release=()=>{registered=true;resolve();});
    const result=rp.installGuidanceRestore({addInitScript:()=>pending},acct,{baseDir:dir});
    assert.ok(result&&typeof result.then==='function','registration must return an awaited promise, not early success');
    let completed=false;result.then(()=>{completed=true;});
    await Promise.resolve();await Promise.resolve();
    assert.equal(completed,false,'must not resolve before addInitScript completes');
    assert.equal(registered,false);
    release();
    const receipt=await result;
    assert.equal(registered,true);
    assert.equal(receipt.registered,true);
    assert.equal(receipt.count,1);
    await assert.rejects(()=>rp.installGuidanceRestore({addInitScript:()=>Promise.reject(new Error('init-script-rejected'))},acct,{baseDir:dir}),/init-script-rejected/,'registration rejection must propagate, never falsely succeed');
  }finally{
    assert.ok(withinTmp());
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('guidance flow: strict aavid semantics reject prefix collision, cross-parameter text and duplicate conflicting account', () => {
  const acct=String(wf.BUSINESS.accountId);
  const m=clibGuideMask('任意引导内容','下一步');
  for(const search of ['?aavid='+acct+'9','?other=aavid='+acct,'?aavid='+acct+'&aavid=9999999999999999','?aavid=9999999999999999']){
    const dom=makeCtx([m.mask],{search});
    assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}),/guidance-page-not-authorized/,search);
    assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,order:0,kind:'clib',content:'x',label:'下一步'}),/guidance-page-not-authorized/,search);
  }
  assert.equal(m.button.__clicks,undefined,'未授权 aavid 零动作');
  const okDom=makeCtx([clibGuideMask('正常引导','下一步').mask],{search:'?aavid='+acct});
  assert.equal(plain(okDom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct})).present,true,'恰好一个匹配 aavid 仍授权');
});

test('guidance restore: strict aavid semantics reject prefix/cross-parameter/duplicate before any localStorage write', () => {
  const acct=String(wf.BUSINESS.accountId);
  const entries=[{key:'qc_lite_c_guide_synthetic',value:'1'}];
  const runRestore=search=>{const dom=makeCtx([],{search},{});dom.run(rp.guidanceRestoreInitScript,{accountId:acct,origin:'https://qianchuan.jinritemai.com',entries});return dom.store;};
  assert.equal(Object.keys(runRestore('?aavid='+acct)).length,1,'恰好一个匹配 aavid 恢复缺失键');
  for(const search of ['?aavid='+acct+'9','?other=aavid='+acct,'?aavid='+acct+'&aavid=9999999999999999','?aavid=9999999999999999']){
    assert.equal(Object.keys(runRestore(search)).length,0,search+' 绝不写 localStorage');
  }
});

test('guidance flow: inherited aria-disabled or native disabled on the mask root/ancestor refuses with zero clicks', () => {
  const acct=String(wf.BUSINESS.accountId);
  const aria=clibGuideMask('被根 aria-disabled 的引导','下一步');
  aria.mask.setAttribute('aria-disabled','true');
  const domAria=makeCtx([aria.mask]);
  const snapAria=plain(domAria.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
  assert.equal(snapAria.present,true);
  assert.equal(snapAria.roots[0].disabled,true,'root-level aria-disabled reflected in snapshot');
  assert.throws(()=>domAria.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,...snapAria.roots[0]}),/guidance-button-disabled/);
  assert.equal(aria.button.__clicks,undefined,'disabled root ancestor zero clicks');

  const native=clibGuideMask('中间层原生 disabled 的引导','我知道了');
  native.body.disabled=true;
  const domNative=makeCtx([native.mask]);
  const snapNative=plain(domNative.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
  assert.equal(snapNative.roots[0].disabled,true,'inherited native disabled reflected');
  assert.throws(()=>domNative.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,...snapNative.roots[0]}),/guidance-button-disabled/);
  assert.equal(native.button.__clicks,undefined);
});

test('guidance flow: only a real FIREFLY-CONTENT open-shadow host is guidance; ordinary business shadow widget with same-shaped classes is excluded', () => {
  const acct=String(wf.BUSINESS.accountId);
  const notice=fireflyGuideNotice('千川乘方重磅升级 乘方是更高效的智能营销引擎','我知道了');
  const domReal=makeCtx([notice.host]);
  const snapReal=plain(domReal.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
  assert.equal(snapReal.present,true,'真实 FIREFLY-CONTENT 宿主仍被找到');
  assert.equal(snapReal.roots[0].kind,'firefly');
  assert.match(snapReal.roots[0].content,/千川乘方重磅升级/);

  const fake=ordinaryBusinessFireflyWidget('普通业务浮窗 下一步','下一步');
  const domFake=makeCtx([fake.host]);
  const snapFake=plain(domFake.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
  assert.equal(snapFake.present,false,'ordinary shadow host excluded from guidance');
  assert.equal(snapFake.unknown,null);
  assert.equal(fake.button.__clicks,undefined,'ordinary business button zero clicks');
  assert.throws(()=>domFake.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,order:0,kind:'firefly',content:'x',label:'下一步'}),/guidance-root-drift/);
  assert.equal(fake.button.__clicks,undefined);
});

test('guidance flow: a real FIREFLY-CONTENT host with an unexpected button shape is reported unknown, never silently completed', async () => {
  const acct=String(wf.BUSINESS.accountId);
  const weird=fireflyGuideNotice('千川乘方重磅升级 升级说明','稍后再说');
  const dom=makeCtx([weird.host]);
  const snap=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
  assert.equal(snap.present,false);
  assert.equal(snap.unknown,'guidance-unknown-root-shape','unknown real firefly shape must surface, not be ignored');
  assert.equal(weird.button.__clicks,undefined);
  assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,order:0,kind:'firefly',content:'x',label:'我知道了'}),/guidance-unknown-root-shape/);
  const page={evaluate:async(fn,arg)=>plain(dom.run(fn,arg))};
  await assert.rejects(()=>rp.runGuidanceOnPage(page,acct),/guidance-unknown-root-shape/,'bounded runner must stop on unknown, not report completed');
});

test('run-plans configurePlan completes delayed chained guidance after configuration and never publishes', async () => {
  const fixture=configureCreationFixture();
  const publishBtn=fixture[fixture.length-1];
  const first=clibGuideMask('达人自动投已就绪，合作达人素材自动拉取投放 第一步','下一步');
  const last=clibGuideMask('综合营销ROI 口径已升级，别照搬全域数值 最后一步','我知道了');
  const dom=makeCtx([...fixture]);
  let configDone=false,stage=0,gap=0; // stage 0 pending,1 first visible,2 gap,3 last visible,4 done
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='step'){
      const r=dom.run(fn,arg);
      if(r&&r.clicked){
        if(stage===1){first.mask.__rect=undefined;stage=2;gap=2;}
        else if(stage===3){last.mask.__rect=undefined;stage=4;}
      }
      return r;
    }
    if(fn===rp.guidanceActionInPage&&arg&&arg.mode==='snapshot'){
      if(configDone&&stage===0){first.mask.parent=dom.body;dom.body.__kids.push(first.mask);stage=1;}
      if(stage===2){
        if(gap>0){gap--;return plain(dom.run(fn,arg));}
        last.mask.parent=dom.body;dom.body.__kids.push(last.mask);stage=3;
      }
      return plain(dom.run(fn,arg));
    }
    const r=dom.run(fn,arg);
    if(r&&r.creation&&r.creation.roi==='15'&&r.creation.budget==='300')configDone=true;
    return r;
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline'});
  const result=await driver.configurePlan({businessDate:'2026-10-10'});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(first.button.__clicks,1,'配置后延迟串联第一步恰好一次');
  assert.equal(last.button.__clicks,1,'配置后延迟串联最后一步恰好一次');
  assert.equal(publishBtn.__clicks,undefined,'配置阶段绝不触碰发布');
});

// ═══════════════════════════════════════════════════════════════════════════
// R11 focused regression: a VISIBLE genuine FIREFLY-CONTENT popper whose control
// selector is absent or changed must be retained and reported unknown (zero
// clicks, zero cookie/flag writes), never silently dropped so the bounded runner
// falsely concludes guidance is complete. Real exported callbacks only.
// ═══════════════════════════════════════════════════════════════════════════
test('guidance flow: a visible genuine FIREFLY-CONTENT popper with no known control is retained as unknown and stops the runner with zero clicks/cookies/flags', async () => {
  const acct=String(wf.BUSINESS.accountId);
  for(const mode of ['missing','different']){
    const notice=fireflyUnknownControlNotice('千川乘方重磅升级 乘方是更高效的智能营销引擎',{mode});
    const dom=makeCtx([notice.host]);
    const snap=plain(dom.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:acct}));
    assert.equal(snap.present,false,mode+': no clickable known control');
    assert.equal(snap.unknown,'guidance-unknown-root-shape',mode+': visible genuine root must not disappear from snapshot');
    if(notice.button) assert.equal(notice.button.__clicks,undefined,mode+': unrecognized control zero clicks');
    assert.throws(()=>dom.run(rp.guidanceActionInPage,{mode:'step',accountId:acct,order:0,kind:'firefly',content:'x',label:'我知道了'}),/guidance-unknown-root-shape/,mode+': step refuses');
    let saveCalls=0,persistCalls=0;
    const page={evaluate:async(fn,arg)=>plain(dom.run(fn,arg))};
    await assert.rejects(()=>rp.runGuidancePhase(page,{accountId:acct,saveCookies:async()=>{saveCalls++;return {status:'saved'};},persistFlags:async()=>{persistCalls++;return {saved:true,count:1};}}),/guidance-unknown-root-shape/,mode+': bounded runner stops on unknown');
    assert.equal(saveCalls,0,mode+': saveCookies never called');
    assert.equal(persistCalls,0,mode+': persistFlags never called');
  }
  // a hidden genuine popper is NOT retained and must not false-report unknown
  const hidden=fireflyGuideNotice('千川乘方重磅升级 乘方是更高效的智能营销引擎','我知道了');
  hidden.popper.__rect=undefined;
  const domHidden=makeCtx([hidden.host]);
  const snapHidden=plain(domHidden.run(rp.guidanceActionInPage,{mode:'snapshot',accountId:String(wf.BUSINESS.accountId)}));
  assert.equal(snapHidden.present,false);
  assert.equal(snapHidden.unknown,null,'hidden popper must not false-report unknown');
});

// ═══════════════════════════════════════════════════════════════════════════
// R12 mixed-mode product catalog: native-scroll categories (cursor API, mode 3,
// no numeric pager) versus the numeric-pager category 全部. These exercise the
// REAL exported pure validators, the REAL native-scroll DOM callbacks, the REAL
// passive transport observer and the REAL createRealDrivers.browseProducts path
// against synthetic VM DOM + synthetic request/response transport. No browser,
// no network, no fetch is issued; opaque cursors never leave memory.
// ═══════════════════════════════════════════════════════════════════════════
function catalogIds(prefix,count){return Array.from({length:count},(_,i)=>prefix+String(i).padStart(5,'0'));}

function transportHarness(){
  const handlers={request:[],response:[]};
  const page={on:(e,h)=>handlers[e].push(h),removeListener:(e,h)=>{const i=handlers[e].indexOf(h);if(i>=0)handlers[e].splice(i,1);},count:()=>handlers.request.length+handlers.response.length};
  const acct=String(wf.BUSINESS.accountId);
  const t=rp.createCatalogTransport(()=>page,acct);
  t.attach();t.beginDrawerEpoch();
  const base=rp.CATALOG_ORIGIN+rp.CATALOG_PATH;
  async function exchange(o={}){
    const {tab='2',cursor='0',ids=[],hasMore=false,respCursor='OPAQUE',account=acct,keyword='',status=200,body}=o;
    const url=base+'?aavid='+account+'&tab='+tab+'&keyword='+keyword+'&cursor='+cursor;
    const req={method:()=>'GET',url:()=>url};
    handlers.request.forEach(h=>h(req));
    const respBody=body!==undefined?body:{status_code:0,data:{productListInfos:ids.map(id=>({productInfo:{id}})),pagination:{mode:3,hasMore,cursor:respCursor}}};
    handlers.response.forEach(h=>h({request:()=>req,status:()=>status,json:async()=>respBody}));
    await t.flush();
  }
  return {t,page,exchange,handlers,acct};
}

function makeCatalogHost(cfg={}){
  const acct=String(wf.BUSINESS.accountId);
  const base=rp.CATALOG_ORIGIN+rp.CATALOG_PATH;
  const native=cfg.native||{};
  const numeric=cfg.numeric||{};
  const flags=cfg.flags||{};
  const published=new Set(cfg.published||[]);
  const handlers={request:[],response:[]};
  let opened=false,active=null,activeTab=null,domIds=[],suppress=0;
  const selected=new Set();
  let batchIndex=0,numericPage=0,submitClicks=0,publishClicks=0,scrollSteps=0,selectCalls=0,respSeq=0,markerRestores=0;
  const restoreArgs=[];
  const cursorByTab={};
  function emit(tab,cursor,ids,hasMore,opts={}){
    const respCursor='OPAQUE-'+tab+'-'+(respSeq++);
    const url=base+'?aavid='+(opts.account||acct)+'&tab='+tab+'&keyword='+(opts.keyword||'')+'&cursor='+cursor;
    const req={method:()=>'GET',url:()=>url};
    handlers.request.forEach(h=>h(req));
    const body=opts.body!==undefined?opts.body:{status_code:0,data:{productListInfos:ids.map(id=>({productInfo:{id}})),pagination:{mode:3,hasMore,cursor:respCursor}}};
    handlers.response.forEach(h=>h({request:()=>req,status:()=>opts.status!==undefined?opts.status:200,json:async()=>body}));
    cursorByTab[tab]=respCursor;
  }
  function cards(){return domIds.map(id=>({id,text:'可投商品 ID: '+id,checked:selected.has(id),checkboxCount:1,disabled:false}));}
  const page={
    on:(e,h)=>{handlers[e].push(h);},
    removeListener:(e,h)=>{const i=handlers[e].indexOf(h);if(i>=0)handlers[e].splice(i,1);},
    count:()=>handlers.request.length+handlers.response.length,
    evaluate:async(fn,arg)=>{
      if(fn===rp.openPickerInPage){opened=true;return true;}
      if(fn===rp.drawerSnapshotInPage){
        if(!opened)return {ok:false,reason:'picker-not-open'};
        if(submitClicks>0)return {ok:false,reason:'closed'};
        if(suppress>0){suppress--;return {ok:true,cards:[],selectedCount:selected.size,remainingCapacity:30,activeTabs:active?[active]:[],rootText:'已选 '+selected.size+' / 30',pagerCount:0};}
        return {ok:true,cards:cards(),selectedCount:selected.size,remainingCapacity:30,activeTabs:active?[active]:[],rootText:'已选 '+selected.size+' / 30',pagerCount:0};
      }
      if(fn===rp.clickDrawerTabInPage){
        const cat=rp.normalizeCatalogCategory(arg);
        const wasActive=active===cat;
        active=cat;activeTab=rp.catalogTabForCategory(cat);
        if(native[cat]){
          batchIndex=0;domIds=native[cat].batches[0].ids.slice();suppress=flags.transientEmpty?1:0;
          const b0=native[cat].batches[0];
          emit(activeTab,rp.CATALOG_INITIAL_CURSOR,b0.ids,b0.hasMore,flags.firstBatchAnomaly||{});
        } else if(numeric[cat]){
          numericPage=0;domIds=numeric[cat].pages[0].slice();
        }
        return {clicked:!wasActive,alreadyActive:wasActive};
      }
      if(fn===rp.nativeScrollStateInPage)return {ok:true,scrollTop:0,scrollHeight:1230,clientHeight:670,cardCount:domIds.length};
      if(fn===rp.nativeScrollStepInPage){
        scrollSteps++;
        const cn=native[active];
        if(cn&&batchIndex+1<cn.batches.length){
          batchIndex++;
          const b=cn.batches[batchIndex];
          if(!flags.emitWithoutDom)domIds=domIds.concat(b.ids);
          if(flags.scrollEmits!==false)emit(activeTab,cursorByTab[activeTab],b.ids,b.hasMore);
        }
        return {ok:true,before:{scrollTop:0},after:{scrollTop:670},marker:cfg.markerNudge?{nudged:true,previous:{height:'',heightPriority:'',minHeight:'',minHeightPriority:''}}:{nudged:false}};
      }
      if(fn===rp.restoreNativeMarkerNudgeInPage){markerRestores++;restoreArgs.push(arg);if(flags.restoreUnconfirmed)return {restored:false,reason:'native-marker-token-absent'};return {restored:true};}
      if(fn===rp.selectNativeCardInPage){selectCalls++;selected.add(String(arg));return {id:String(arg),checked:true};}
      if(fn===rp.deselectNativeCardInPage){selected.delete(String(arg));return {id:String(arg),checked:false};}
      if(fn===rp.classifyAndCancelAutoPullInPage)return {kind:'none',productIds:[]};
      if(fn===rp.guidanceActionInPage)return flags.guideUnknown?{present:false,unknown:'guidance-unknown-root-shape',roots:[]}:{present:false,unknown:null,roots:[]};
      if(fn===c.pageObserve)return {observation:'obs-num-'+numericPage,url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage:flags.numericCurrentPage!=null?flags.numericCurrentPage:numericPage+1,pageCount:(numeric[active]&&numeric[active].pages.length)||1,modalPresent:true,inProductModal:true,items:[]},elements:[{text:'下一步',tag:'BUTTON',index:4}],creation:{accountId:acct,mainTableUnique:true}};
      if(fn===c.actionApply){if(arg&&/发布/.test(String(arg.expectedText||'')))publishClicks++;submitClicks++;return {clicked:true};}
      if(fn===c.pageApply){numericPage++;domIds=numeric[active].pages[numericPage].slice();return {paged:true};}
      if(fn===rp.readMainTableInPage)return submitClicks>0?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
      throw new Error('unexpected catalog evaluate '+(fn.name||String(fn).slice(0,30)));
    },
  };
  const order=cfg.order||['店铺新品','破圈尖货','搜索趋势','全部'];
  const dayState={lastSelected:[],attempted:[],cursor:{category:order[0],page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:published,attemptedSet:new Set(cfg.attempted||[]),hints:{},accountId:acct,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:cfg.nativeScrollTimeoutMs||600});
  return {page,driver,dayState,emit,state:()=>({opened,active,domIds:domIds.slice(),selected:[...selected],submitClicks,publishClicks,scrollSteps,selectCalls,batchIndex,numericPage,markerRestores,restoreArgs:restoreArgs.slice(),listeners:page.count()})};
}

test('catalog request validator: exact endpoint, unique exact account, unique tab, empty keyword, unique cursor', () => {
  const acct=String(wf.BUSINESS.accountId);
  const base=rp.CATALOG_ORIGIN+rp.CATALOG_PATH;
  const ok=rp.parseCatalogRequestUrl(base+'?aavid='+acct+'&tab=2&keyword=&cursor=0',acct);
  assert.equal(ok.ok,true);assert.equal(ok.tab,'2');assert.equal(ok.cursor,'0');
  const bad=[
    ['https://qianchuan.jinritemai.com.evil.test'+rp.CATALOG_PATH+'?aavid='+acct+'&tab=2&cursor=0','catalog-endpoint-mismatch'],
    [base+'/x?aavid='+acct+'&tab=2&cursor=0','catalog-endpoint-mismatch'],
    [base+'?aavid='+acct+'9&tab=2&cursor=0','catalog-account-mismatch'],
    [base+'?other=aavid='+acct+'&tab=2&cursor=0','catalog-account-mismatch'],
    [base+'?aavid='+acct+'&aavid=9999999999999999&tab=2&cursor=0','catalog-account-mismatch'],
    [base+'?aavid='+acct+'&tab=2&tab=15&cursor=0','catalog-tab-not-unique'],
    [base+'?aavid='+acct+'&cursor=0','catalog-tab-not-unique'],
    [base+'?aavid='+acct+'&tab=2&keyword=鞋&cursor=0','catalog-keyword-not-empty'],
    [base+'?aavid='+acct+'&tab=2&keyword=&keyword=&cursor=0','catalog-keyword-not-empty'],
    [base+'?aavid='+acct+'&tab=2&cursor=0&cursor=1','catalog-cursor-not-unique'],
    [base+'?aavid='+acct+'&tab=2','catalog-cursor-not-unique'],
    ['not-a-url','catalog-request-url-unparseable'],
  ];
  for(const [url,reason] of bad){const r=rp.parseCatalogRequestUrl(url,acct);assert.equal(r.ok,false,url);assert.equal(r.reason,reason,url);}
});

test('catalog response validator: native mode3 schema, unique 15-20 digit ids, boolean hasMore, string cursor', () => {
  const good={status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153040708'}},{productInfo:{id:'3846729111716365083'}}],pagination:{mode:3,hasMore:true,cursor:'OPAQUE-C1'}}};
  const ok=rp.parseCatalogResponseBody(good);
  assert.equal(ok.ok,true);assert.deepEqual(ok.ids,['3846738945153040708','3846729111716365083']);assert.equal(ok.hasMore,true);assert.equal(ok.mode,3);assert.equal(ok.cursor,'OPAQUE-C1');
  const emptyOk=rp.parseCatalogResponseBody({status_code:0,data:{productListInfos:[],pagination:{mode:3,hasMore:false,cursor:'OPAQUE-E'}}});
  assert.equal(emptyOk.ok,true);assert.deepEqual(emptyOk.ids,[]);assert.equal(emptyOk.hasMore,false,'empty native category is legal, not unknown');
  const bad=[
    [null,'catalog-response-body-invalid'],
    [{status_code:1,data:{productListInfos:[],pagination:{mode:3,hasMore:false,cursor:'x'}}},'catalog-response-status-code-not-zero'],
    [{status_code:0},'catalog-response-data-missing'],
    [{status_code:0,data:{pagination:{mode:3,hasMore:false,cursor:'x'}}},'catalog-response-rows-not-array'],
    [{status_code:0,data:{productListInfos:[{productInfo:{id:'123'}}],pagination:{mode:3,hasMore:false,cursor:'x'}}},'catalog-response-id-invalid'],
    [{status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153040708'}},{productInfo:{id:'3846738945153040708'}}],pagination:{mode:3,hasMore:false,cursor:'x'}}},'catalog-response-duplicate-id'],
    [{status_code:0,data:{productListInfos:[]}},'catalog-response-pagination-missing'],
    [{status_code:0,data:{productListInfos:[],pagination:{mode:2,hasMore:false,cursor:'x'}}},'catalog-response-mode-not-native'],
    [{status_code:0,data:{productListInfos:[],pagination:{mode:3,hasMore:'yes',cursor:'x'}}},'catalog-response-hasmore-not-boolean'],
    [{status_code:0,data:{productListInfos:[],pagination:{mode:3,hasMore:false,cursor:123}}},'catalog-response-cursor-not-string'],
  ];
  for(const [body,reason] of bad){const r=rp.parseCatalogResponseBody(body);assert.equal(r.ok,false,JSON.stringify(body));assert.equal(r.reason,reason,JSON.stringify(body));}
});

test('catalog category normalization, tab map, native classification and id union', () => {
  assert.equal(rp.normalizeCatalogCategory('破圈尖货 流量扶持'),'破圈尖货');
  assert.equal(rp.normalizeCatalogCategory('搜索趋势推荐'),'搜索趋势');
  assert.equal(rp.normalizeCatalogCategory(' 搜索趋势 '),'搜索趋势');
  assert.equal(rp.catalogTabForCategory('店铺新品'),'2');
  assert.equal(rp.catalogTabForCategory('破圈尖货'),'15');
  assert.equal(rp.catalogTabForCategory('搜索趋势'),'14');
  assert.equal(rp.catalogTabForCategory('全部'),'1');
  assert.equal(rp.catalogTabForCategory('未知'),null);
  assert.equal(rp.isNativeScrollCategory('店铺新品'),true);
  assert.equal(rp.isNativeScrollCategory('破圈尖货'),true);
  assert.equal(rp.isNativeScrollCategory('搜索趋势'),true);
  assert.equal(rp.isNativeScrollCategory('全部'),false);
  assert.equal(rp.isNativeScrollTab('2'),true);assert.equal(rp.isNativeScrollTab('1'),false);
  assert.deepEqual(rp.unionCatalogIds([{ids:['a','b']},{ids:['b','c']}]),['a','b','c']);
});

test('native scroll callbacks: unique .product-list geometry, exactly one viewport step, non-unique refusal', () => {
  const cards=catalogIds('38467389451530',10).map(id=>El('div',{class:'card-container',rect:[200,80],text:'商品 ID: '+id}));
  const list=El('div',{class:'product-list',rect:[600,670]},cards);
  list.scrollTop=0;list.clientHeight=670;list.scrollHeight=1230;
  const dom=makeCtx([list]);
  const st=plain(dom.run(rp.nativeScrollStateInPage));
  assert.equal(st.ok,true);assert.equal(st.scrollTop,0);assert.equal(st.clientHeight,670);assert.equal(st.scrollHeight,1230);assert.equal(st.cardCount,10);
  const step=plain(dom.run(rp.nativeScrollStepInPage));
  assert.equal(step.ok,true);assert.equal(step.before.scrollTop,0);
  assert.equal(step.after.loadingEdge,560,'loading edge is scrollHeight-clientHeight');
  assert.equal(step.after.scrollTop,560,'one native action lands on the loading edge, not a short viewport step');
  assert.equal(list.scrollTop,560,'exactly one native scroll to the loading edge, never a business click');
  const list2=El('div',{class:'product-list',rect:[600,670]},[]);list2.scrollTop=0;list2.clientHeight=670;list2.scrollHeight=670;
  const dup=makeCtx([list,list2]);
  assert.equal(plain(dup.run(rp.nativeScrollStateInPage)).ok,false);
  assert.throws(()=>dup.run(rp.nativeScrollStepInPage),/native-scroll-root-not-unique/);
});

test('native scroll reaches the true loading edge on the recorded second batch', () => {
  // Real captured geometry (r11-live-native-catalog-proof): first batch top0/height1230/client670,
  // second batch top560/height2460/client670. One viewport step from 560 stops at 1230, short of
  // the 1790 loading edge, so no new batch would ever fire. A single native scroll must reach 1790.
  const cards=catalogIds('38467389451530',20).map(id=>El('div',{class:'card-container',rect:[200,80],text:'商品 ID: '+id}));
  const list=El('div',{class:'product-list',rect:[600,670]},cards);
  list.scrollTop=560;list.clientHeight=670;list.scrollHeight=2460;
  const dom=makeCtx([list]);
  const step=plain(dom.run(rp.nativeScrollStepInPage));
  assert.equal(step.ok,true);
  assert.equal(step.after.loadingEdge,1790);
  assert.equal(step.after.scrollTop,1790,'second batch reaches 1790, not a fake always-allow 1230');
  assert.equal(list.scrollTop,1790);
});

test('native scroll lands on the loading edge for any larger accumulated height', () => {
  // Third batch grows taller: the single action must track scrollHeight-clientHeight each time,
  // never a fixed clientHeight step and never pretend the list is exhausted.
  const cards=catalogIds('38467389451530',30).map(id=>El('div',{class:'card-container',rect:[200,80],text:'商品 ID: '+id}));
  const list=El('div',{class:'product-list',rect:[600,670]},cards);
  list.scrollTop=1790;list.clientHeight=670;list.scrollHeight=4010;
  const dom=makeCtx([list]);
  const step=plain(dom.run(rp.nativeScrollStepInPage));
  assert.equal(step.after.loadingEdge,3340);
  assert.equal(step.after.scrollTop,3340);
  assert.equal(list.scrollTop,3340);
});

test('native scroll performs zero moves when already at the loading edge', () => {
  // At the bottom with no further native distance, the single assignment must not invent progress;
  // EOF is decided only by a bounded fresh response + new DOM ids, so here the scroll is a no-op.
  const cards=catalogIds('38467389451530',10).map(id=>El('div',{class:'card-container',rect:[200,80],text:'商品 ID: '+id}));
  const list=El('div',{class:'product-list',rect:[600,670]},cards);
  list.scrollTop=560;list.clientHeight=670;list.scrollHeight=1230;
  const dom=makeCtx([list]);
  const step=plain(dom.run(rp.nativeScrollStepInPage));
  assert.equal(step.ok,true);
  assert.equal(step.after.loadingEdge,560);
  assert.equal(step.after.scrollTop,560,'no downward move when already on the loading edge');
  assert.equal(list.scrollTop,560);
  assert.equal(step.marker.nudged,false,'no empty clipped marker sentinel => pure scroll, zero style change');
});

// ── R20/R21 native loading-marker clipped boundary narrow layout exception ────────────
// Field evidence (r19-native-marker-evidence.json, r20-native-marker-failures.json): at the loading
// edge the unique direct-last EMPTY sentinel (DIV, zero children, EMPTY textContent) has height 0
// and sits clipped 0<gap<1px past the root bottom, so the real component IntersectionObserver
// (threshold 0.8) never fires the fetch and progress stalls with hasMore true. We apply a bounded
// 5px temporary height/min-height ONLY in that exact shape, then RE-SCROLL to the new
// scrollHeight-clientHeight (the nudge grows the content; r20's fixed 2px without a second scroll
// left the marker outside the crop and could not reach ratio 0.8 for gap>=0.4). The harness
// simulates the real layout coupling: a nudged direct-last sentinel extends scrollHeight by
// exactly its inline height, so a source that never re-scrolls cannot pass these assertions.
function makeClippedNativeList({markerDisplay='block',markerTop=978.375,markerEmpty=true,atEdge=true,extraChild=false,markerText=null,markerOriginalHeight=null,markerOriginalPriority=''}={}) {
  const cards=catalogIds('38467389451530',140).slice(0,3).map(id=>El('div',{class:'card-container',rect:[200,80],text:'商品 ID: '+id}));
  const sentinel=El('div',{rect:[600,0],top:markerTop,display:markerDisplay,text:markerText},markerEmpty?[]:[El('span',{rect:[10,10]})]);
  if(markerOriginalHeight!=null){ sentinel.style.setProperty('height',markerOriginalHeight,markerOriginalPriority); sentinel.style.setProperty('min-height',markerOriginalHeight,''); }
  const kids=extraChild?[...cards,sentinel,El('div',{class:'card-container',rect:[200,80],top:markerTop+1})]:[...cards,sentinel];
  const list=El('div',{class:'product-list',rect:[600,670],top:308},kids);
  list.scrollTop=atEdge?16641:560; list.clientHeight=670;
  const baseScrollHeight=atEdge?17311:2460;
  Object.defineProperty(list,'scrollHeight',{configurable:true,get(){
    const h=parseFloat(sentinel.style.getPropertyValue('height'))||0;
    return baseScrollHeight+(kids[kids.length-1]===sentinel?h:0);
  }});
  return {list,sentinel};
}

test('R21 clipped 0.375px empty native marker gets a bounded 5px nudge AND a real second scroll to the new loading edge', () => {
  const {list,sentinel}=makeClippedNativeList({});
  const dom=makeCtx([list]);
  const step=plain(dom.run(rp.nativeScrollStepInPage));
  assert.equal(step.ok,true);
  assert.equal(step.marker.nudged,true,'exact 0-height clipped empty marker => nudge applied');
  assert.equal(sentinel.style.getPropertyValue('height'),'5px','marker temporarily 5px so the real observer crosses 0.8 for every admitted gap');
  assert.equal(sentinel.style.getPropertyValue('min-height'),'5px');
  assert.equal(list.scrollTop,16646,'after the style change the step must REALLY scroll to the new scrollHeight-clientHeight, not stay at the old edge');
  assert.equal(step.after.scrollTop,16646);
  assert.equal(step.after.loadingEdge,16646,'the reported loading edge tracks the grown content');
  assert.deepEqual(step.marker.previous,{height:'',heightPriority:'',minHeight:'',minHeightPriority:''},'previous inline values captured for exact restore');
  const r=plain(dom.run(rp.restoreNativeMarkerNudgeInPage,step.marker.previous));
  assert.equal(r.restored,true);
  assert.equal(sentinel.style.getPropertyValue('height'),'','restore removes ONLY our height/min-height, back to original empty');
  assert.equal(sentinel.style.getPropertyValue('min-height'),'');
});

test('R21 nudge never fires on hidden / non-empty-text / has-children / off-boundary / normal-not-at-edge markers and the plain scroll is unchanged', () => {
  const hidden=makeClippedNativeList({markerDisplay:'none'});
  const hs=plain(makeCtx([hidden.list]).run(rp.nativeScrollStepInPage));
  assert.equal(hs.marker.nudged,false,'display:none marker means no further load: must NOT be manipulated');
  assert.equal(hidden.sentinel.style.getPropertyValue('height'),'');
  const nonEmpty=makeClippedNativeList({markerEmpty:false});
  assert.equal(plain(makeCtx([nonEmpty.list]).run(rp.nativeScrollStepInPage)).marker.nudged,false,'non-empty last child is not the sentinel');
  const textOnly=makeClippedNativeList({markerText:'unrecognized footer'});
  const tos=plain(makeCtx([textOnly.list]).run(rp.nativeScrollStepInPage));
  assert.equal(tos.marker.nudged,false,'zero children but NON-EMPTY textContent is not the empty sentinel');
  assert.equal(textOnly.sentinel.style.getPropertyValue('height'),'','no temporary style may be applied to an unknown text marker');
  assert.equal(textOnly.sentinel.style.getPropertyValue('min-height'),'');
  const farGap=makeClippedNativeList({markerTop:979.5}); // gap 1.5px >= 1 => not the clip boundary
  assert.equal(plain(makeCtx([farGap.list]).run(rp.nativeScrollStepInPage)).marker.nudged,false,'gap must be 0<gap<1');
  const lastIsCard=makeClippedNativeList({extraChild:true});
  assert.equal(plain(makeCtx([lastIsCard.list]).run(rp.nativeScrollStepInPage)).marker.nudged,false,'a card as the last child => no empty sentinel at boundary');
  const notAtEdge=makeClippedNativeList({atEdge:false,extraChild:true});
  const ns=plain(makeCtx([notAtEdge.list]).run(rp.nativeScrollStepInPage));
  assert.equal(notAtEdge.list.scrollTop,1790,'normal not-yet-bottom list still scrolls to the true loading edge');
  assert.equal(ns.marker.nudged,false,'a card last child at the edge (no empty clipped sentinel) => zero nudge, plain scroll only');
});

test('R21 fractional gap 0.4375px inside the admitted band still nudges 5px and re-scrolls past the rounding trap', () => {
  const {list,sentinel}=makeClippedNativeList({markerTop:978.4375});
  const step=plain(makeCtx([list]).run(rp.nativeScrollStepInPage));
  assert.equal(step.marker.nudged,true,'0<gap<1 admits the narrow exception at 0.4375px too');
  assert.equal(sentinel.style.getPropertyValue('height'),'5px');
  assert.equal(list.scrollTop,16646,'re-scroll lands on the NEW edge; 2px at this gap produced ratio 0.78125 < 0.8 in the real browser');
  const r=plain(makeCtx([list]).run(rp.restoreNativeMarkerNudgeInPage,step.marker.previous));
  assert.equal(r.restored,true);
  assert.equal(sentinel.style.getPropertyValue('height'),'');
  assert.equal(sentinel.style.getPropertyValue('min-height'),'');
});

test('R21 restore returns the ORIGINAL inline height value and priority exactly, never a blanket clear', () => {
  const {list,sentinel}=makeClippedNativeList({markerOriginalHeight:'0px',markerOriginalPriority:'important'});
  const step=plain(makeCtx([list]).run(rp.nativeScrollStepInPage));
  assert.equal(step.marker.nudged,true,'a pre-existing inline height does not block the shape check (rect height is still 0 and clipped)');
  assert.deepEqual(step.marker.previous,{height:'0px',heightPriority:'important',minHeight:'0px',minHeightPriority:''});
  const r=plain(makeCtx([list]).run(rp.restoreNativeMarkerNudgeInPage,step.marker.previous));
  assert.equal(r.restored,true);
  assert.equal(sentinel.style.getPropertyValue('height'),'0px');
  assert.equal(sentinel.style.getPropertyPriority('height'),'important');
  assert.equal(sentinel.style.getPropertyValue('min-height'),'0px');
});

test('R21 restore keeps a later vShow display:none (fresh EOF) intact and clears only our height/min-height', () => {
  const {list,sentinel}=makeClippedNativeList({});
  const step=plain(makeCtx([list]).run(rp.nativeScrollStepInPage));
  assert.equal(step.marker.nudged,true);
  sentinel.__display='none'; // the component hides the sentinel once hasMore=false landed
  const r=plain(makeCtx([list]).run(rp.restoreNativeMarkerNudgeInPage,step.marker.previous));
  assert.equal(r.restored,true);
  assert.equal(sentinel.style.getPropertyValue('height'),'');
  assert.equal(sentinel.style.getPropertyValue('min-height'),'');
  assert.equal(sentinel.__display,'none','the restore must not undo the component display change');
});

test('R21 restore targets ONLY the direct-last empty sentinel and refuses any other same-token node', () => {
  const {list,sentinel}=makeClippedNativeList({extraChild:true});
  sentinel.style.setProperty('height','5px','');
  sentinel.style.setProperty('min-height','5px','');
  const r=plain(makeCtx([list]).run(rp.restoreNativeMarkerNudgeInPage,{height:'',heightPriority:'',minHeight:'',minHeightPriority:''}));
  assert.equal(r.restored,false);
  assert.equal(r.reason,'native-marker-token-absent');
  assert.equal(sentinel.style.getPropertyValue('height'),'5px','a same-token node that is NOT the direct-last child is never restored');
});

test('R20 nativeAdvance restores the temporary marker style on BOTH success and the bounded no-progress failure', async () => {
  // success path: the exact mixed host completes, and the one nudged native scroll is reverted.
  const storeA=catalogIds('38467389451530',10),storeB=catalogIds('38467389451540',10);
  const published=[...storeA,...storeB];
  const breakout=catalogIds('38005251957064',5);
  const allPage=catalogIds('38404143974366',30);
  const okHost=makeCatalogHost({
    order:['店铺新品','破圈尖货','搜索趋势','全部'],
    native:{'店铺新品':{tab:'2',batches:[{ids:storeA,hasMore:true},{ids:storeB,hasMore:false}]},'破圈尖货':{tab:'15',batches:[{ids:breakout,hasMore:false}]},'搜索趋势':{tab:'14',batches:[{ids:[],hasMore:false}]}},
    numeric:{'全部':{tab:'1',pages:[allPage]}},
    published, markerNudge:true,
  });
  const okResult=await okHost.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品','破圈尖货','搜索趋势','全部'],onProgress:async()=>{}});
  assert.equal(okResult.ok,true,JSON.stringify(okResult));
  assert.equal(okHost.state().markerRestores,1,'a nudged marker is restored exactly once on the success path');
  assert.equal(okHost.state().publishClicks,0,'restore never turns into a publish');

  // failure path: no fresh chained response lands. The browse path calls nativeAdvance with
  // {allowStall:true}, so ONE bounded retry is attempted and the category is then closed as
  // "no progress" — never as EOF (nativeEof stays false) and never as a hard throw that would
  // kill the whole run. The finally must still revert every nudged temporary marker.
  const failHost=makeCatalogHost({
    order:['店铺新品'],
    native:{'店铺新品':{tab:'2',batches:[{ids:storeA,hasMore:true},{ids:storeB,hasMore:false}]}},
    numeric:{}, published:[], flags:{scrollEmits:false}, markerNudge:true,
  });
  const failResult=await failHost.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}});
  assert.equal(failResult.ok,false,'no fresh batch is an honest bounded stop, never success');
  assert.equal(failResult.reason,'catalog-exhausted-or-safe-pagination-boundary');
  assert.equal(failResult.cursor.nativeEof,false,'no-progress is NOT an EOF proof');
  const failState=failHost.state();
  assert.ok(failState.scrollSteps>=2,'the bounded stall retry really scrolled again');
  assert.equal(failState.markerRestores,failState.scrollSteps,'every nudged scroll restores the temporary marker exactly once (finally)');
  assert.equal(failState.publishClicks,0,'no-progress path never publishes');
});

test('R21 nativeAdvance surfaces an UNCONFIRMED marker restore instead of swallowing it', async () => {
  const storeA=catalogIds('38467389451530',10),storeB=catalogIds('38467389451540',10);
  const host=makeCatalogHost({
    order:['店铺新品'],
    native:{'店铺新品':{tab:'2',batches:[{ids:storeA,hasMore:true},{ids:storeB,hasMore:false}]}},
    numeric:{}, published:[], flags:{restoreUnconfirmed:true}, markerNudge:true,
  });
  // The scroll itself succeeds, but the finally restore reports restored:false: we must NOT
  // claim the temporary marker was reverted. The failure surfaces and stops the workflow.
  await assert.rejects(host.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}}),/native-marker-restore-unconfirmed:native-marker-token-absent/);
  assert.equal(host.state().markerRestores,1,'the restore was attempted exactly once');
  assert.equal(host.state().publishClicks,0,'an unconfirmed restore never turns into a publish');
});

test('catalog transport: captures a valid native chain, keeps opaque cursor out of batches, ignores numeric tab, rejects late epoch, releases listeners', async () => {
  const h=transportHarness();
  await h.exchange({tab:'2',cursor:'0',ids:['3846738945153000001','3846738945153000002'],hasMore:true,respCursor:'OPAQUE-C1'});
  let b=h.t.batchesForTab('2');
  assert.equal(b.length,1);assert.deepEqual(b[0].ids,['3846738945153000001','3846738945153000002']);assert.equal(b[0].hasMore,true);assert.equal(b[0].mode,3);
  assert.equal(h.t.anomaly(),null);
  const s=JSON.stringify(b[0]);
  assert.ok(!s.includes('OPAQUE-C1'),'opaque response cursor never stored in a batch');
  assert.ok(!s.includes('http')&&!s.includes('aavid')&&!s.includes('cursor'),'no raw url/query/cursor leaks into batch metadata');
  await h.exchange({tab:'2',cursor:'OPAQUE-C1',ids:['3846738945153000003'],hasMore:false,respCursor:'OPAQUE-C2'});
  b=h.t.batchesForTab('2');assert.equal(b.length,2);assert.equal(h.t.lastBatchForTab('2').hasMore,false);
  assert.deepEqual(h.t.firstBatchForTab('2').ids,['3846738945153000001','3846738945153000002']);
  await h.exchange({tab:'1',cursor:'0',body:{status_code:0,data:{productListInfos:[{productInfo:{id:'3840414397436600001'}}],pagination:{currentPage:1}}}});
  assert.equal(h.t.batchesForTab('1').length,0,'numeric tab 1 never captured as native');
  assert.equal(h.t.anomaly(),null,'numeric tab response is not an anomaly');
  const lateReq={method:()=>'GET',url:()=>rp.CATALOG_ORIGIN+rp.CATALOG_PATH+'?aavid='+h.acct+'&tab=15&keyword=&cursor=0'};
  h.handlers.request.forEach(x=>x(lateReq));
  h.t.beginDrawerEpoch();
  h.handlers.response.forEach(x=>x({request:()=>lateReq,status:()=>200,json:async()=>({status_code:0,data:{productListInfos:[{productInfo:{id:'3800525195706400001'}}],pagination:{mode:3,hasMore:false,cursor:'X'}}})}));
  await h.t.flush();
  assert.equal(h.t.batchesForTab('15').length,0,'late previous-epoch response rejected');
  assert.equal(h.t.anomaly(),null);
  h.t.detach();assert.equal(h.page.count(),0,'listeners released without leak');
});

function raceHarness(){
  const handlers={request:[],response:[]};
  const page={on:(e,hh)=>handlers[e].push(hh),removeListener:(e,hh)=>{const i=handlers[e].indexOf(hh);if(i>=0)handlers[e].splice(i,1);},count:()=>handlers.request.length+handlers.response.length};
  const acct=String(wf.BUSINESS.accountId);
  const t=rp.createCatalogTransport(()=>page,acct);
  t.attach();t.beginDrawerEpoch();
  const base=rp.CATALOG_ORIGIN+rp.CATALOG_PATH;
  const urlOf=(tab,cursor)=>base+'?aavid='+acct+'&tab='+tab+'&keyword=&cursor='+cursor;
  function issueRequest(tab,cursor){const req={method:()=>'GET',url:()=>urlOf(tab,cursor)};handlers.request.forEach(h=>h(req));return req;}
  function deferred(){let resolve,reject;const p=new Promise((res,rej)=>{resolve=res;reject=rej;});p.catch(()=>{});return {p,resolve,reject};}
  function dispatch(req,jsonPromise,status=200){handlers.response.forEach(h=>h({request:()=>req,status:()=>status,json:()=>jsonPromise}));}
  return {t,page,handlers,acct,issueRequest,deferred,dispatch};
}

test('catalog transport: epoch reset during awaited JSON cannot write the new epoch (success late)', async () => {
  const h=raceHarness();
  const req=h.issueRequest('2','0');
  const d=h.deferred();
  h.dispatch(req,d.p);                 // processResponse passes the pre-await epoch check, then awaits JSON
  h.t.beginDrawerEpoch();              // epoch advances + requestMeta cleared while the body is in flight
  d.resolve({status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153000009'}}],pagination:{mode:3,hasMore:true,cursor:'LATE-C1'}}});
  await h.t.flush();
  assert.equal(h.t.batchesForTab('2').length,0,'late success body must not enter the new epoch');
  assert.equal(h.t.anomaly(),null,'late success body must not pollute the new epoch anomaly');
  // The fresh epoch cursor chain still starts at literally '0' and captures normally.
  const fresh=h.issueRequest('2','0');
  h.dispatch(fresh,Promise.resolve({status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153000001'}}],pagination:{mode:3,hasMore:false,cursor:'C1'}}}));
  await h.t.flush();
  assert.equal(h.t.batchesForTab('2').length,1,'new epoch collection still works after a rejected late body');
  assert.equal(h.t.anomaly(),null);
});

test('catalog transport: epoch reset during awaited JSON cannot write the new epoch (invalid + rejected body)', async () => {
  const h=raceHarness();
  const badReq=h.issueRequest('2','0');
  const bad=h.deferred();
  h.dispatch(badReq,bad.p);
  const rejReq=h.issueRequest('2','0');
  const rej=h.deferred();
  h.dispatch(rejReq,rej.p);            // both requests bind to the CURRENT epoch before the reset
  h.t.beginDrawerEpoch();              // epoch advances + requestMeta cleared while both bodies await
  bad.resolve({status_code:0,data:{productListInfos:[],pagination:{mode:9,hasMore:'x',cursor:'y'}}}); // invalid native shape
  rej.reject(new Error('body unavailable'));
  await h.t.flush();
  assert.equal(h.t.anomaly(),null,'late invalid body and late rejected JSON must not surface as new-epoch anomalies');
  assert.equal(h.t.batchesForTab('2').length,0);
  // A rejected JSON that genuinely belongs to the CURRENT epoch must still surface as an anomaly.
  const live=h.issueRequest('2','0');
  const liveD=h.deferred();
  h.dispatch(live,liveD.p);
  liveD.reject(new Error('unavailable'));
  await h.t.flush();
  assert.equal(h.t.anomaly(),'catalog-response-json-unparseable','in-epoch rejected JSON still recorded');
});

test('catalog transport: detach during awaited JSON stops writes, re-attach epoch captures cleanly', async () => {
  const h=raceHarness();
  const req=h.issueRequest('2','0');
  const d=h.deferred();
  h.dispatch(req,d.p);
  h.t.detach();                        // stop the collection while the body is still pending
  d.resolve({status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153000011'}}],pagination:{mode:3,hasMore:false,cursor:'D1'}}});
  await h.t.flush();
  assert.equal(h.t.batchesForTab('2').length,0,'detached in-flight body must not write after stop');
  assert.equal(h.t.anomaly(),null);
  h.t.attach();h.t.beginDrawerEpoch();  // re-attach starts a clean epoch
  const fresh=h.issueRequest('2','0');
  h.dispatch(fresh,Promise.resolve({status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153000001'}}],pagination:{mode:3,hasMore:true,cursor:'C1'}}}));
  await h.t.flush();
  assert.equal(h.t.batchesForTab('2').length,1,'re-attached epoch first cursor 0 captured normally');
  assert.equal(h.t.anomaly(),null);
});

test('catalog transport: strict rejections surface as anomalies and store no batch', async () => {
  const cases=[
    ['account',{account:'9999999999999999'},/catalog-account-mismatch/],
    ['keyword',{keyword:'鞋'},/catalog-keyword-not-empty/],
    ['http-status',{status:500},/catalog-http-status-not-200/],
    ['status-code',{body:{status_code:1,data:{productListInfos:[],pagination:{mode:3,hasMore:false,cursor:'x'}}}},/catalog-response-status-code-not-zero/],
    ['mode',{body:{status_code:0,data:{productListInfos:[],pagination:{mode:2,hasMore:false,cursor:'x'}}}},/catalog-response-mode-not-native/],
    ['hasmore',{body:{status_code:0,data:{productListInfos:[],pagination:{mode:3,cursor:'x'}}}},/catalog-response-hasmore-not-boolean/],
    ['cursor-type',{body:{status_code:0,data:{productListInfos:[],pagination:{mode:3,hasMore:false,cursor:5}}}},/catalog-response-cursor-not-string/],
    ['dup-id',{body:{status_code:0,data:{productListInfos:[{productInfo:{id:'3846738945153000001'}},{productInfo:{id:'3846738945153000001'}}],pagination:{mode:3,hasMore:false,cursor:'x'}}}},/catalog-response-duplicate-id/],
    ['bad-id',{body:{status_code:0,data:{productListInfos:[{productInfo:{id:'123'}}],pagination:{mode:3,hasMore:false,cursor:'x'}}}},/catalog-response-id-invalid/],
  ];
  for(const [name,opts,re] of cases){
    const h=transportHarness();
    await h.exchange(Object.assign({tab:'2',cursor:'0',ids:['3846738945153000001']},opts));
    assert.match(h.t.anomaly()||'',re,name);
    assert.equal(h.t.batchesForTab('2').length,0,name+' stores no batch');
  }
  const h=transportHarness();
  await h.exchange({tab:'2',cursor:'0',ids:['3846738945153000001'],hasMore:true,respCursor:'OPAQUE-C1'});
  assert.equal(h.t.anomaly(),null);
  await h.exchange({tab:'2',cursor:'STALE',ids:['3846738945153000002'],hasMore:false,respCursor:'OPAQUE-C2'});
  assert.match(h.t.anomaly()||'',/catalog-cursor-chain-broken/,'an old/non-chained cursor is rejected');
});

test('driver browseProducts: mixed native-scroll + numeric catalog dedups history, skips a legal empty category, fills 30 and submits without publishing', async () => {
  const storeA=catalogIds('38467389451530',10),storeB=catalogIds('38467389451540',10);
  const published=[...storeA,...storeB];
  const breakout=catalogIds('38005251957064',5);
  const allPage=catalogIds('38404143974366',30);
  const h=makeCatalogHost({
    order:['店铺新品','破圈尖货','搜索趋势','全部'],
    native:{'店铺新品':{tab:'2',batches:[{ids:storeA,hasMore:true},{ids:storeB,hasMore:false}]},'破圈尖货':{tab:'15',batches:[{ids:breakout,hasMore:false}]},'搜索趋势':{tab:'14',batches:[{ids:[],hasMore:false}]}},
    numeric:{'全部':{tab:'1',pages:[allPage]}},
    published,
  });
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品','破圈尖货','搜索趋势','全部'],onProgress:async()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.selectedIds.length,30);
  assert.equal(result.selectedIds.filter(id=>published.includes(id)).length,0,'20 historical native ids are deduped, never re-selected');
  assert.equal(result.selectedIds.filter(id=>breakout.includes(id)).length,5,'破圈尖货 EOF batch fully selected');
  assert.equal(result.selectedIds.filter(id=>allPage.includes(id)).length,25,'numeric 全部 backfills the remaining 25');
  const st=h.state();
  assert.equal(st.scrollSteps,1,'店铺新品 scrolled exactly once to its hasMore=false EOF');
  assert.equal(st.submitClicks,1,'one picker submit');
  assert.equal(st.publishClicks,0,'never publishes');
  assert.equal(st.listeners,0,'transport listeners released after browseProducts');
});

test('driver browseProducts: native scroll with no fresh chained response stops honestly, never EOF', async () => {
  const h=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids:catalogIds('38467389451530',10),hasMore:true},{ids:catalogIds('38467389451540',10),hasMore:false}]}},numeric:{},published:[],flags:{scrollEmits:false}});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}});
  assert.equal(result.ok,false,'未拿到新批次只收束本类目，绝不伪造成功');
  assert.equal(result.reason,'catalog-exhausted-or-safe-pagination-boundary');
  assert.equal(result.cursor.nativeEof,false,'没有 transport 证明 hasMore=false 时 nativeEof 必须保持 false');
  assert.ok(result.selectedIds.length<30,'不足 30 份不得被当作完整批次');
  const st=h.state();
  assert.equal(st.submitClicks,0,'不足 30 份绝不提交');
  assert.equal(st.publishClicks,0);
  assert.equal(st.listeners,0,'transport listeners released after browseProducts');
  assert.ok(st.scrollSteps>=2,'有界 stall 重试确实再次滚动过');
});

test('driver browseProducts: a native scroll response that lands zero new DOM ids never becomes EOF', async () => {
  const h=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids:catalogIds('38467389451530',10),hasMore:true},{ids:catalogIds('38467389451540',10),hasMore:false}]}},numeric:{},published:[],flags:{emitWithoutDom:true}});
  // The transport claims a fresh hasMore=false batch but its ids never landed in the DOM:
  // the EOF proof is invalid (accumulated ids ⊄ DOM), so the driver stops hard instead of
  // treating the empty viewport as an honest category end.
  await assert.rejects(h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}}),/native-eof-dom-mismatch/);
  const st=h.state();
  assert.equal(st.domIds.length,10,'DOM 没有真正增长，不得凭空累加 id');
  assert.equal(st.submitClicks,0);
  assert.equal(st.publishClicks,0);
});

test('driver browseProducts: an unknown guide overlay before a native scroll stops without advancing', async () => {
  const h=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids:catalogIds('38467389451530',10),hasMore:true},{ids:catalogIds('38467389451540',10),hasMore:false}]}},numeric:{},published:[],flags:{guideUnknown:true}});
  await assert.rejects(h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}}),/guidance-unknown-root-shape/);
  assert.equal(h.state().scrollSteps,0,'never scrolls past an unknown guide');
  assert.equal(h.state().publishClicks,0);
});

test('driver browseProducts: a first-batch transport anomaly stops the native switch with the specific reason', async () => {
  const cases=[
    ['account',{account:'9999999999999999'},/native-catalog-anomaly:catalog-account-mismatch/],
    ['keyword',{keyword:'鞋'},/native-catalog-anomaly:catalog-keyword-not-empty/],
    ['http-status',{status:500},/native-catalog-anomaly:catalog-http-status-not-200/],
    ['mode',{body:{status_code:0,data:{productListInfos:[],pagination:{mode:2,hasMore:false,cursor:'x'}}}},/native-catalog-anomaly:catalog-response-mode-not-native/],
  ];
  for(const [name,opts,re] of cases){
    const h=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids:catalogIds('38467389451530',3),hasMore:false}]}},numeric:{},published:[],flags:{firstBatchAnomaly:opts}});
    await assert.rejects(h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}}),re,name);
    assert.equal(h.state().publishClicks,0,name);
    assert.equal(h.state().selectCalls,0,name+' selects nothing on a rejected exchange');
  }
});

test('driver browseProducts: a transient empty DOM during a native switch is not a premature empty-category success', async () => {
  const ids=catalogIds('38467389451530',4);
  const h=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids,hasMore:false}]}},numeric:{},published:[],flags:{transientEmpty:true}});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}});
  assert.equal(result.ok,false,'only 4 real products exist, so 30 cannot be filled');
  assert.deepEqual(result.selectedIds.slice().sort(),ids.slice().sort(),'the real bound batch was used, not the transient empty');
});

test('driver browseProducts: a native category bound hasMore=false + empty ids + empty DOM is a legal zero-product skip', async () => {
  const allPage=catalogIds('38404143974366',30);
  const h=makeCatalogHost({order:['搜索趋势','全部'],native:{'搜索趋势':{tab:'14',batches:[{ids:[],hasMore:false}]}},numeric:{'全部':{tab:'1',pages:[allPage]}},published:[]});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['搜索趋势','全部'],onProgress:async()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.selectedIds.length,30);
  assert.equal(h.state().scrollSteps,0,'an empty native category never scrolls');
});

test('driver browseProducts: a subsequent plan rescans a native category from the top and dedups attempted ids', async () => {
  const storeA=catalogIds('38467389451530',10),storeB=catalogIds('38467389451540',10);
  const breakout=catalogIds('38005251957064',10);
  const h=makeCatalogHost({order:['店铺新品','破圈尖货'],native:{'店铺新品':{tab:'2',batches:[{ids:storeA,hasMore:true},{ids:storeB,hasMore:false}]},'破圈尖货':{tab:'15',batches:[{ids:breakout,hasMore:false}]}},numeric:{},published:[],attempted:[...storeA,...storeB]});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品','破圈尖货'],onProgress:async()=>{}});
  assert.equal(result.ok,false,'only 10 fresh products exist across both native categories');
  assert.equal(result.selectedIds.length,10);
  assert.equal(result.selectedIds.every(id=>breakout.includes(id)),true,'rescan from top dedups the 20 attempted store ids');
  assert.equal(h.state().scrollSteps,1,'店铺新品 still scrolled once to its EOF during the rescan');
});

test('driver switchCategory: the numeric category guard still requires currentPage 1 and stops otherwise', async () => {
  const h=makeCatalogHost({order:['全部'],native:{},numeric:{'全部':{tab:'1',pages:[catalogIds('38404143974366',30)]}},published:[],flags:{numericCurrentPage:2}});
  await assert.rejects(h.driver.browseProducts({selectedIds:[],needed:30,categories:['全部'],onProgress:async()=>{}}),/category-switch-page-state-unknown/);
  assert.equal(h.state().publishClicks,0);
});

// R26 root cause: browseProducts read the current product page exactly once and threw
// 'current-product-page-ids-missing-or-duplicate' on a TRANSIENT empty/duplicate DOM right after an
// open / category switch / page advance (the real 27->30 backfill on 全部/page1 hit exactly this:
// the stable DOM was 30 unique cards but the sampled read was blank-or-duplicate). The fix gives a
// transient blank/duplicate a BOUNDED settle to a real complete unique valid list while the SAME
// picker/category/page/footer/account identity holds, and stops IMMEDIATELY on any genuine drift
// (never waiting a drift out and never deduping cards or skipping unknown ids). This host reproduces
// those live shapes; `fault` picks which; drift faults only bite from read `driftFrom` so the initial
// pre-loop snapshot still passes and the stop is attributed to the settle itself.
function numericSettleHost(cfg={}) {
  const acct=String(wf.BUSINESS.accountId);
  const base=cfg.base||0;
  const capacity=30-base;
  const cat=cfg.cat||'全部';
  const cand=cfg.candidates||Array.from({length:30},(_,i)=>'384581162524855'+String(6100+i));
  const selected=new Set();
  let submitClicks=0,selectCalls=0,tabClicks=0,pageApplyCount=0,drawerReads=0,observeReads=0,closed=false;
  const fault=cfg.fault||'none';
  const badReads=cfg.badReads!=null?cfg.badReads:2;
  const driftFrom=cfg.driftFrom!=null?cfg.driftFrom:2;
  const cardArr=()=>cand.map(id=>({id,text:'可投商品 ID: '+id,checked:selected.has(id),checkboxCount:1,disabled:false}));
  const blank=()=>({ok:true,cards:[],selectedCount:selected.size,remainingCapacity:capacity,activeTabs:[cat],rootText:'已选 '+selected.size+' / 30',pagerCount:1});
  const dup=()=>{const c=cardArr();if(c.length)c.push({...c[0]});return {ok:true,cards:c,selectedCount:selected.size,remainingCapacity:capacity,activeTabs:[cat],rootText:'已选',pagerCount:1};};
  const good=()=>({ok:true,cards:cardArr(),selectedCount:selected.size,remainingCapacity:capacity,activeTabs:[cat],rootText:'已选 '+selected.size+' / 30',pagerCount:1});
  const partial=()=>{const c=cardArr();if(c.length)c[0]={...c[0],id:null,text:'可投商品 ID: 加载中'};return {ok:true,cards:c,selectedCount:selected.size,remainingCapacity:capacity,activeTabs:[cat],rootText:'已选',pagerCount:1};};
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.drawerSnapshotInPage){
      drawerReads++;
      if(closed)return {ok:false,reason:'closed'};
      if(drawerReads>=driftFrom){
        if(fault==='categoryDrift')return {ok:true,cards:cardArr(),selectedCount:selected.size,remainingCapacity:capacity,activeTabs:['其它'],rootText:'已选',pagerCount:1};
        if(fault==='footerDrift')return {ok:true,cards:cardArr(),selectedCount:selected.size,remainingCapacity:30,activeTabs:[cat],rootText:'已选',pagerCount:1};
        if(fault==='checkedDrift'){const g=good();g.cards.push({id:'399999999999999999',text:'可投商品 ID: 399999999999999999',checked:true,checkboxCount:1,disabled:false});g.selectedCount=selected.size+1;return g;}
      }
      if(fault==='permanentEmpty')return blank();
      if(fault==='permanentDuplicate')return dup();
      if(fault==='permanentPartialId')return partial();
      if(fault==='transientEmpty'&&drawerReads<=badReads)return blank();
      if(fault==='transientDuplicate'&&drawerReads<=badReads)return dup();
      if(fault==='transientPartialId'&&drawerReads<=badReads)return partial();
      return good();
    }
    if(fn===rp.clickDrawerTabInPage){tabClicks++;return {clicked:true};}
    if(fn===rp.selectNativeCardInPage){selectCalls++;selected.add(String(arg));return {id:String(arg),checked:true};}
    if(fn===rp.deselectNativeCardInPage){selected.delete(String(arg));return {id:String(arg),checked:false};}
    if(fn===rp.classifyAndCancelAutoPullInPage)return {kind:'none',productIds:[]};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:null,roots:[]};
    if(fn===c.pageObserve){
      observeReads++;
      const currentPage=(fault==='pageDrift'&&drawerReads>=driftFrom)?2:1;
      const creation=fault==='accountDrift'?{accountId:'9999999999999999',mainTableUnique:true}:{accountId:acct,mainTableUnique:true};
      return {observation:'obs-'+drawerReads,url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage,pageCount:1,modalPresent:true,inProductModal:true,items:[{kind:'next',index:0,disabled:true}]},elements:[{text:'下一步',tag:'BUTTON',index:4}],creation:cfg.creationOverride?cfg.creationOverride:creation};
    }
    if(fn===c.actionApply){submitClicks++;closed=true;return {clicked:true};}
    if(fn===c.pageApply){pageApplyCount++;return {paged:true};}
    if(fn===rp.readMainTableInPage)return closed?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
    throw new Error('unexpected numeric settle evaluate '+(fn.name||String(fn).slice(0,30)));
  }};
  const baseIds=Array.from({length:base},(_,i)=>'384581162524855'+String(5000+i));
  const dayState={lastSelected:baseIds.slice(),attempted:[],cursor:{category:cat,page:1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:acct,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:cfg.timeoutMs||800});
  return {page,driver,base:baseIds,state:()=>({submitClicks,selectCalls,tabClicks,pageApplyCount,drawerReads,observeReads}),run:()=>driver.browseProducts({selectedIds:baseIds.slice(),needed:30-baseIds.length,categories:[cat],cursor:dayState.cursor,onProgress:async()=>{}})};
}

test('R26 numeric transient empty list settles to the real unique page before selecting, then fills and commits once', async () => {
  const h=numericSettleHost({fault:'transientEmpty',badReads:2});
  const r=await h.run();
  assert.equal(r.ok,true);assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.tabClicks,0,'已active的分类绝不重点击tab');
  assert.equal(s.pageApplyCount,0,'一页足量绝不额外翻页');
  assert.equal(s.submitClicks,1,'一次picker提交');
});

test('R26 numeric transient duplicate list settles to unique ids without deduping a duplicate card', async () => {
  const h=numericSettleHost({fault:'transientDuplicate',badReads:2});
  const r=await h.run();
  assert.equal(r.ok,true);assert.equal(r.selectedIds.length,30);
  assert.equal(new Set(r.selectedIds).size,30,'绝不把重复卡去重后继续勾选');
  assert.equal(h.state().submitClicks,1);
});

test('R26 numeric base27/cap3 backfill closes through response->DOM settle (the real R25 failure)', async () => {
  const h=numericSettleHost({base:27,fault:'transientEmpty',badReads:2});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  assert.equal(r.selectedIds.filter(id=>h.base.includes(id)).length,27,'历史27不重选');
  const s=h.state();
  assert.equal(s.selectCalls,3,'仅补选剩余3，绝不重复历史');
  assert.equal(s.tabClicks,0);assert.equal(s.submitClicks,1);
});

test('R26 numeric permanently empty page times out with zero selection and zero commit', async () => {
  const h=numericSettleHost({fault:'permanentEmpty',timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-not-stable-empty-or-duplicate/);
  const s=h.state();assert.equal(s.selectCalls,0,'有界等待超时绝不勾选未知/空列表');assert.equal(s.submitClicks,0);
});

test('R26 numeric permanently duplicated page times out with zero selection and zero commit', async () => {
  const h=numericSettleHost({fault:'permanentDuplicate',timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-not-stable-empty-or-duplicate/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R26 numeric category/tab drift stops immediately with zero selection (never waited away)', async () => {
  const h=numericSettleHost({fault:'categoryDrift',driftFrom:2,timeoutMs:800});
  await assert.rejects(h.run(),/current-product-page-category-not-active/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.tabClicks,0,'漂移不重新点tab');
});

test('R26 numeric page-number drift stops immediately against the real observe currentPage', async () => {
  const h=numericSettleHost({fault:'pageDrift',driftFrom:2,timeoutMs:800});
  await assert.rejects(h.run(),/current-product-page-number-drift/);
  assert.equal(h.state().selectCalls,0);
});

test('R26 numeric account drift stops immediately against the real observe creation identity', async () => {
  const h=numericSettleHost({fault:'accountDrift',driftFrom:2,timeoutMs:800});
  await assert.rejects(h.run(),/current-product-page-account-drift/);
  assert.equal(h.state().selectCalls,0);
});

test('R26 numeric footer/capacity drift stops immediately with zero selection', async () => {
  const h=numericSettleHost({fault:'footerDrift',base:27,driftFrom:2,timeoutMs:800});
  await assert.rejects(h.run(),/current-product-page-footer-capacity-drift/);
  assert.equal(h.state().selectCalls,0);
});

test('R26 numeric unknown-checked drift stops immediately and never dedups/skips it', async () => {
  const h=numericSettleHost({fault:'checkedDrift',driftFrom:2,timeoutMs:800});
  await assert.rejects(h.run(),/current-product-page-checked-drift/);
  assert.equal(h.state().selectCalls,0);
});

test('R27 numeric transient one-card null-id settles to all 30 before selecting (never early-selects 29)', async () => {
  const h=numericSettleHost({fault:'transientPartialId',badReads:2});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30,'一张ID未渲染=null时必须等齐全部30，绝不提前只勾29漏1');
  assert.equal(new Set(r.selectedIds).size,30,'不丢弃null卡/不去重/不减所需30');
  const s=h.state();
  assert.equal(s.selectCalls,30,'等齐后才逐一勾选30');
  assert.equal(s.submitClicks,1,'确认完整后一次picker提交');
});

test('R27 numeric permanent one-card null-id times out with zero selection and zero commit', async () => {
  const h=numericSettleHost({fault:'permanentPartialId',timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-not-stable-empty-or-duplicate/,'永久一张ID=null→有界超时');
  const s=h.state();
  assert.equal(s.selectCalls,0,'未知null-id卡片绝不勾选');
  assert.equal(s.submitClicks,0,'不完整绝不提交');
});

// R28: settleProductPage.numeric 的主表条件补修。真实首次 All 选品的创建页在"添加商品"
// 之前根本没有主表(r27-live-empty-main-picker-proof.json: mainTableUnique=false,
// mainRootEvidence=[], productRowCount=0, rows=[], productIds=[], uniqueProductCount=0,
// originOk/pathOk=true, account精确)，R26新增的mainTableUnique guard把这个合法首次零计数
// 形状误判成,current-product-page-main-table-not-unique。仅当baseSelectedCount===0且上述
// 全部字段精确肯定成立时才允许list阶段继续；缺字段/冲突roots/非零外来product/base>0却
// 无主表/错误account一律照旧拒绝，绝不把所有false放行。
const acctForEmpty=()=>String(wf.BUSINESS.accountId);
function firstEmptyCreationShape(overrides={}){
  return Object.assign({
    originOk:true, pathOk:true, accountId:acctForEmpty(),
    mainTableUnique:false, mainRootEvidence:[], productRowCount:0, rows:[], productIds:[], uniqueProductCount:0,
  }, overrides);
}

test('R28 known-first-empty: 首次All选品无主表(base=0)精确零计数形状被放行,完成30选满并一次提交', async () => {
  const h=numericSettleHost({creationOverride:firstEmptyCreationShape()});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.selectCalls,30);assert.equal(s.submitClicks,1);
});

test('R28 missing-counts: 首次All选品缺任一零计数字段(undefined/非数组)一律拒绝,零选择零提交', async () => {
  const missing={originOk:true,pathOk:true,accountId:acctForEmpty(),mainTableUnique:false};
  const h=numericSettleHost({creationOverride:missing,timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R28 conflicting-roots: mainRootEvidence多于0个(冲突roots)不满足首次空形状,拒绝零动作', async () => {
  const h=numericSettleHost({creationOverride:firstEmptyCreationShape({mainRootEvidence:[{tag:'TABLE',cls:'a',rowCount:0},{tag:'TABLE',cls:'b',rowCount:0}]}),timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R28 foreign-product: 主表不唯一但已有非零外来product(productRowCount/productIds非空)一律拒绝', async () => {
  const h=numericSettleHost({creationOverride:firstEmptyCreationShape({productRowCount:3,rows:[{productId:'399999999999999999',manualAccounts:0},{productId:'399999999999999998',manualAccounts:0},{productId:'399999999999999997',manualAccounts:0}],productIds:['399999999999999999','399999999999999998','399999999999999997'],uniqueProductCount:3}),timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R28 backfill-empty: base>0却无主表(mainTableUnique=false零计数)一律拒绝,绝不放行补选', async () => {
  const h=numericSettleHost({base:27,creationOverride:firstEmptyCreationShape(),timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R28 wrong-account: 首次All选品无主表且account不符一律拒绝,零动作', async () => {
  const h=numericSettleHost({creationOverride:firstEmptyCreationShape({accountId:'9999999999999999'}),timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();assert.equal(s.selectCalls,0);assert.equal(s.submitClicks,0);
});

test('R28 origin-or-path-not-ok: 首次All选品无主表但originOk/pathOk非true一律拒绝,零动作', async () => {
  for(const shape of [firstEmptyCreationShape({originOk:false}),firstEmptyCreationShape({pathOk:false})]){
    const h=numericSettleHost({creationOverride:shape,timeoutMs:400});
    await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
    assert.equal(h.state().selectCalls,0);assert.equal(h.state().submitClicks,0);
  }
});

test('R28 a normal mainTableUnique=true page is unaffected by the empty-main-table exception', async () => {
  const h=numericSettleHost({creationOverride:{accountId:acctForEmpty(),mainTableUnique:true}});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
});

test('R26 native legal bound empty (hasMore=false+ids空+DOM空) is a skip, a transient empty under a non-empty batch is never one', async () => {
  const legal=makeCatalogHost({order:['搜索趋势','全部'],native:{'搜索趋势':{tab:'14',batches:[{ids:[],hasMore:false}]}},numeric:{'全部':{tab:'1',pages:[catalogIds('38404143974366',30)]}},published:[]});
  const legalResult=await legal.driver.browseProducts({selectedIds:[],needed:30,categories:['搜索趋势','全部'],onProgress:async()=>{}});
  assert.equal(legalResult.ok,true,JSON.stringify(legalResult));
  assert.equal(legal.state().scrollSteps,0,'合法空分类从不滚动');
  const transient=makeCatalogHost({order:['店铺新品'],native:{'店铺新品':{tab:'2',batches:[{ids:catalogIds('38467389451530',4),hasMore:false}]}},numeric:{},published:[],flags:{transientEmpty:true}});
  const trResult=await transient.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品'],onProgress:async()=>{}});
  assert.equal(trResult.ok,false,'非空批次下的短暂空绝不当作空分类成功');
  assert.deepEqual(trResult.selectedIds.slice().sort(),catalogIds('38467389451530',4).slice().sort(),'等待后使用真实绑定批次而非空DOM');
});

// ── R28 numericPickerPagingInPage: the real "全部" (All) ovui svg-only next pager ──
// Reproduces r27-numeric-pager-dom-readonly.json exactly: .pagination-wrapper >
// .ovui-pagination > ul.ovui-page-turner, current li.ovui-page-turner__item--active,
// the next step is a bare li.ovui-page-turner__item wrapping ONLY a
// div.ovui-page-turner__next-icon>svg (no text/role/title), and the prev-icon li
// carries ovui-page-turner__item--disabled on page 1 while the next li does not.
function numericOvuiPagerDom(cfg={}){
  const acct=String(cfg.accountId!=null?cfg.accountId:wf.BUSINESS.accountId);
  const nav=El('div',{class:'qc-page-navigator-container',rect:[900,40],text:'千川 乘方 ID：'+acct+' 伊人美'});
  const activeTabName=cfg.activeTab||'全部';
  const tabNames=['全部','店铺新品','破圈尖货','搜索趋势'];
  const tabs=tabNames.map(name=>El('div',{class:'product-drawer-header-tab-item'+(name===activeTabName?' active':''),rect:[100,30],text:name}));
  const checkedSet=new Set((cfg.checkedIds||[]).map(String));
  const cardIds=cfg.cardIds||Array.from({length:30},(_,i)=>'384581162524855'+String(1000+i));
  const cards=cardIds.map(id=>El('div',{class:'card-container',rect:[240,120],text:'商品 ID：'+id},[
    El('input',{attrs:{type:'checkbox'},checked:checkedSet.has(String(id)),rect:[12,12]}),
  ]));
  const footer=El('div',{text:`已选 ${checkedSet.size} / ${cfg.capacity!=null?cfg.capacity:30}`});
  const nextBtn=El('button',{rect:[80,28],text:'下一步'});

  const currentPage=cfg.currentPage!=null?cfg.currentPage:1;
  const mkNumLi=(n,active)=>El('li',{class:'ovui-page-turner__item'+(active?' ovui-page-turner__item--active':''),rect:[30,24],text:String(n)});
  const prevDisabled=cfg.prevDisabled!==false;
  const prevLi=El('li',{class:'ovui-page-turner__item'+(prevDisabled?' ovui-page-turner__item--disabled':''),rect:[30,24]},[El('div',{class:'ovui-icon ovui-page-turner__prev-icon',rect:[14,14]})]);
  const numberLis=[1,2,3,4,5].map(n=>mkNumLi(n,n===currentPage));
  const ellipsis=El('div',{class:'ovui-page-turner__next-ellipsis',rect:[20,24]},[El('span',{rect:[10,10],text:'...'})]);
  const lastNumLi=mkNumLi(60,false);

  const mkNextIconDiv=()=>El('div',{class:'ovui-icon ovui-page-turner__next-icon',rect:[14,14]});
  let nextLi=null,extraDupNext=null;
  if(cfg.next==='missing'){ nextLi=null; }
  else if(cfg.next==='disabled'){ nextLi=El('li',{class:'ovui-page-turner__item ovui-page-turner__item--disabled',rect:[30,24]},[mkNextIconDiv()]); }
  else if(cfg.next==='ariaDisabledOnly'){ nextLi=El('li',{class:'ovui-page-turner__item',attrs:{'aria-disabled':'true'},rect:[30,24]},[mkNextIconDiv()]); }
  else if(cfg.next==='duplicated'){ nextLi=El('li',{class:'ovui-page-turner__item',rect:[30,24]},[mkNextIconDiv()]); extraDupNext=El('li',{class:'ovui-page-turner__item',rect:[30,24]},[mkNextIconDiv()]); }
  else { nextLi=El('li',{class:'ovui-page-turner__item',rect:[30,24]},[mkNextIconDiv()]); }

  const turnerKids=[prevLi,...numberLis,ellipsis,lastNumLi];
  if(nextLi) turnerKids.push(nextLi);
  if(extraDupNext) turnerKids.push(extraDupNext);
  const turner=El('ul',{class:'ovui-page-turner',rect:[300,24]},turnerKids);
  const paginationWrapper=El('div',{class:'pagination-wrapper',rect:[800,40],text:`共 ${cfg.recordCount!=null?cfg.recordCount:1780} 条记录`},[
    El('div',{class:'ovui-pagination',rect:[800,40]},[turner]),
  ]);
  const drawerKids=[...tabs,...cards,footer,paginationWrapper,nextBtn];
  const drawer=El('div',{class:'product-drawer',attrs:{role:'dialog'},rect:[900,600]},drawerKids);
  const body=[nav,drawer];
  if(cfg.overlay) body.push(El('div',{class:'guide-overlay',attrs:{role:'dialog'},rect:[300,200],text:'新人引导 下一步'}));
  if(cfg.duplicateDrawer){
    const tabs2=['全部','店铺新品','破圈尖货','搜索趋势'].map(name=>El('div',{class:'product-drawer-header-tab-item'+(name==='全部'?' active':''),rect:[100,30],text:name}));
    body.push(El('div',{class:'product-drawer2',attrs:{role:'dialog'},rect:[900,600]},[...tabs2,El('div',{text:'已选 0 / 30'}),El('button',{rect:[80,28],text:'下一步'})]));
  }
  const locOverride={search:cfg.search!=null?cfg.search:('?aavid='+acct)};
  if(cfg.origin) locOverride.origin=cfg.origin;
  if(cfg.pathname) locOverride.pathname=cfg.pathname;
  const ctx=makeCtx(body,locOverride);
  return {nextLi,ctx};
}
function numericOvuiPagerPayload(extra={}){
  return Object.assign({mode:'next',expectedCurrentPage:1,expectedSelectedCount:0,expectedCapacity:30,selectedIds:[],accountId:String(wf.BUSINESS.accountId)},extra);
}

test('R28 numericPickerPagingInPage read mode: exact real ovui pager shape, no click ever', () => {
  const {ctx}=numericOvuiPagerDom();
  const r=plain(ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload({mode:'read'})));
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.mode,'read');assert.equal(r.clicked,false,'read模式绝不点击');
  assert.equal(r.currentPage,1);assert.equal(r.nextDisabled,false);
  assert.equal(r.footerSelectedCount,0);assert.equal(r.footerRemainingCapacity,30);
  assert.equal(r.recordCount,1780,'辅助读出1780条记录');
  assert.equal(r.maxVisiblePageNumber,60,'辅助读出最后数字60，仅证据不是总数');
  assert.equal(r.prevDisabled,true,'prev显式disabled');
});

test('R28 numericPickerPagingInPage next mode: all strict proofs match, clicks the unique next li exactly once', () => {
  const {ctx,nextLi}=numericOvuiPagerDom();
  const r=plain(ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload()));
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.clicked,true);assert.equal(r.currentPage,1);
  assert.equal(nextLi.__clicks,1,'只点唯一next LI一次');
});

test('R28 numericPickerPagingInPage boundary: explicit ovui-page-turner__item--disabled on the unique next li is a real boundary with zero clicks, never a success or an unknown stop', () => {
  const {ctx,nextLi}=numericOvuiPagerDom({next:'disabled'});
  const r=plain(ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload()));
  assert.equal(r.ok,true);assert.equal(r.boundary,true);assert.equal(r.clicked,false);
  assert.equal(nextLi.__clicks,undefined,'显式disabled边界绝不点击');
});

test('R28 numericPickerPagingInPage rejects an unknown disabled state (aria-disabled without the class token) with zero clicks, never as a boundary', () => {
  const {ctx,nextLi}=numericOvuiPagerDom({next:'ariaDisabledOnly'});
  const r=plain(ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload()));
  assert.equal(r.ok,false);assert.match(r.reason,/next-disabled-state-unknown/);
  assert.equal(nextLi.__clicks,undefined,'未知disabled绝不点击也不冒充边界');
});

test('R28 numericPickerPagingInPage rejects missing or duplicate next control with zero clicks', () => {
  const miss=numericOvuiPagerDom({next:'missing'});
  const rm=plain(miss.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload()));
  assert.equal(rm.ok,false);assert.match(rm.reason,/no-next-control/);
  const dup=numericOvuiPagerDom({next:'duplicated'});
  const rd=plain(dup.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload()));
  assert.equal(rd.ok,false);assert.match(rd.reason,/next-control-not-unique/);
  assert.equal(dup.nextLi.__clicks,undefined,'重复next绝不点击');
});

test('R28 numericPickerPagingInPage rejects wrong account, category drift, blocking overlay and duplicate drawer with zero clicks', () => {
  const wrongAcct=numericOvuiPagerDom({accountId:'9999999999999999'});
  assert.match(plain(wrongAcct.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/account-mismatch/);
  const catDrift=numericOvuiPagerDom({activeTab:'店铺新品'});
  assert.match(plain(catDrift.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/category-not-active/);
  const overlay=numericOvuiPagerDom({overlay:true});
  assert.match(plain(overlay.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/blocking-overlay-present/);
  const dupDrawer=numericOvuiPagerDom({duplicateDrawer:true});
  assert.match(plain(dupDrawer.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/drawer-not-unique/);
});

test('R28 numericPickerPagingInPage rejects checked-drift, footer/capacity/page mismatch and unauthorized origin/path with zero clicks', () => {
  const strangerCardId='399999999999999999';
  const stranger=numericOvuiPagerDom({cardIds:[strangerCardId,'3845811625248551001'],checkedIds:[strangerCardId]});
  assert.match(plain(stranger.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload({expectedSelectedCount:1,selectedIds:['3845811625248551001']})) ).reason,/checked-drift/,'一个真实已勾选卡片的id不在已知selectedIds内=checked-drift,先于其它计数检查触发');
  const stalePage=numericOvuiPagerDom({currentPage:1});
  assert.match(plain(stalePage.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload({expectedCurrentPage:5}))).reason,/current-page-mismatch/);
  const footerDrift=numericOvuiPagerDom({capacity:30});
  assert.match(plain(footerDrift.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload({expectedCapacity:29}))).reason,/footer-capacity-mismatch/);
  const badOrigin=numericOvuiPagerDom({origin:'https://evil.example.com'});
  assert.match(plain(badOrigin.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/creation-page-not-authorized/);
  const badPath=numericOvuiPagerDom({pathname:'/other/path'});
  assert.match(plain(badPath.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/creation-page-not-authorized/);
});

test('R28 numericPickerPagingInPage rejects a non-unique aavid and an unknown mode with zero clicks', () => {
  const dupAavid=numericOvuiPagerDom({search:'?aavid='+wf.BUSINESS.accountId+'&aavid=9999999999999999'});
  assert.match(plain(dupAavid.ctx.run(rp.numericPickerPagingInPage,numericOvuiPagerPayload())).reason,/aavid-not-unique/);
  const {ctx}=numericOvuiPagerDom();
  assert.match(plain(ctx.run(rp.numericPickerPagingInPage,{mode:'jump',accountId:String(wf.BUSINESS.accountId)})).reason,/mode-unknown/);
});

// R28: changePage() 的 All 适配集成验证。真实 ovui svg-next 分页无法被通用
// guard.resolvePageTarget 识别（"No observed next control"），必须只在分类为 全部
// 且非 native 时走 numericPickerPagingInPage 严格新证明；host 侧有界只读重验证
// 通过后才能写 cursor/继续选品，绝不冒充假 confirmed 或旧 pageNo+1。
// R29: 同一 host 参数化出"真实观察里存在 next 数字叶"的形态（cfg.leaf）。当该观察
// 里 currentPage+1 的 number 叶严格唯一且肯定 enabled 时，changePage 必须改用现有
// generic guard（resolvePageTarget+pageApply）点那一个数字叶，svg next 回调一次都不
// 调；缺数字时仍走 R28 svg 严格回退；重复/disabled/unknown 数字零动作，绝不绕过。
function numericOvuiPagerHost(cfg={}){
  const acct=String(wf.BUSINESS.accountId);
  const cat='全部';
  const baseIds=(cfg.baseIds||[]).map(String);
  const baseSet=new Set(baseIds);
  const page1Ids=cfg.page1Ids||Array.from({length:20},(_,i)=>'384581162524855'+String(1000+i));
  const page2Ids=cfg.page2Ids||Array.from({length:10},(_,i)=>'384581162524855'+String(2000+i));
  const pageCount=cfg.pageCount||2;
  const fault=cfg.fault||'none'; // none | stalePage | oldIds | nextNotProven | leafScopeNotProven | leafStalePage | leafOldIds | leafFooterDrift | leafCheckedDrift | leafAccountDrift | leafCategoryDrift
  const leafMode=cfg.leaf||'none'; // none | unique | duplicate | disabled | unknown
  // R30 parameterization: cfg.cold replays the real unrendered All window inside this offline
  // host. While cold, drawer reads report ok=true with 0 cards + kept footer, and pageObserve
  // reports currentPage 1 with ONLY the current number leaf — exactly the live early shape.
  // The host warms after cfg.cold.reads pageObserve reads (or never, with cold.permanent);
  // cold.cards selects the transient shape blank | duplicate | invalid, and cold.drift flips
  // one identity field from the cold read cold.driftAt onward to prove the wait stops at once.
  const cold=cfg.cold||null;
  const coldReadsBound=cold&&cold.reads!=null?cold.reads:3;
  const coldDriftAt=cold&&cold.driftAt!=null?cold.driftAt:3;
  let coldReads=0,coldSawWarm=false,firstWarmSnapshot=null;
  const coldActive=()=>!!cold&&(cold.permanent===true||coldReads<coldReadsBound);
  const coldDriftLive=()=>coldActive()&&!!(cold&&cold.drift)&&coldReads>=coldDriftAt;
  const mkLeaf=(p,index,disabled)=>({index,kind:'number',page:p,disabled,cls:'ovui-page-turner__item'});
  const capacity=wf.BUSINESS.productsPerPlan-baseIds.length;
  const checked=new Set((cfg.checkedIds||[]).map(String));
  const batchCount=()=>[...checked].filter(id=>!baseSet.has(id)).length;
  let page=1,submitClicks=0,selectCalls=0,nextClickCalls=0,leafClickCalls=0,readCalls=0,leafClicked=false,closed=false;
  const keepOldIds=()=>fault==='oldIds'||(fault==='leafOldIds'&&leafClicked);
  const page3Ids=cfg.page3Ids||Array.from({length:20},(_,i)=>'384581162524855'+String(3000+i));
  const domIds=()=>keepOldIds()?page1Ids.slice():(page===1?page1Ids.slice():page===2?page2Ids.slice():page3Ids.slice());
  const cards=()=>domIds().map(id=>({id,text:'可投商品 ID: '+id,checked:checked.has(id),checkboxCount:1,disabled:false}));
  const coldDrawerSnap=()=>{
    const drift=coldDriftLive();
    const coldCard=id=>({id,text:'可投商品 ID: '+id,checked:false,checkboxCount:1,disabled:false});
    let ck=cold.cards==='duplicate'?[coldCard('3845811625248558999'),coldCard('3845811625248558999')]:cold.cards==='invalid'?[coldCard('123')]:[];
    if(drift&&cold.drift==='checked')ck=ck.concat([{id:'399999999999999999991',text:'可投商品 ID: 399999999999999999991',checked:true,checkboxCount:1,disabled:false}]);
    return {ok:true,cards:ck,selectedCount:batchCount()+(drift&&cold.drift==='footer'?1:0),remainingCapacity:capacity,activeTabs:drift&&cold.drift==='category'?['店铺新品']:[cat],rootText:'已选 '+batchCount()+' / '+capacity,pagerCount:1};
  };
  const drawerSnap=()=>closed?{ok:false,reason:'closed'}:coldActive()?coldDrawerSnap():{ok:true,cards:cards(),selectedCount:batchCount(),remainingCapacity:capacity,activeTabs:fault==='leafCategoryDrift'&&leafClicked?['店铺新品']:[cat],rootText:'已选 '+batchCount()+' / '+capacity,pagerCount:1};
  const checkedIds=()=>[...checked];
  const leafItems=()=>{
    const mk=mkLeaf;
    if(leafMode==='duplicate')return [mk(1,8,false),mk(2,9,false),mk(2,11,false)];
    if(leafMode==='disabled')return [mk(1,8,false),mk(2,9,true)];
    if(leafMode==='unknown')return [mk(1,8,false),mk(2,9,'unknown')];
    // R30: the unique leaf set tracks the live current page so a multi-step restore proves
    // every advance uses its own observed currentPage+1 leaf exactly once.
    if(leafMode==='unique')return [mk(page,8,false),mk(page+1,9,false)];
    return [];
  };
  const pageObj={evaluate:async(fn,arg)=>{
    if(fn===rp.drawerSnapshotInPage)return drawerSnap();
    if(fn===rp.clickDrawerTabInPage)return {clicked:true};
    if(fn===rp.selectNativeCardInPage){selectCalls++;checked.add(String(arg));return {id:String(arg),checked:true};}
    if(fn===rp.deselectNativeCardInPage){checked.delete(String(arg));return {id:String(arg),checked:false};}
    if(fn===rp.classifyAndCancelAutoPullInPage)return {kind:'none',productIds:[]};
    if(fn===rp.guidanceActionInPage)return cfg.guide==='present'?{present:true,unknown:null,roots:[]}:cfg.guide==='unknown'?{present:false,unknown:'guide-shape-unknown',roots:[]}:{present:false,unknown:null,roots:[]};
    if(fn===c.pageObserve){
      coldReads++;
      if(cold&&!coldSawWarm&&!coldActive()){coldSawWarm=true;firstWarmSnapshot={coldReads,page,selectCalls,leafClickCalls,nextClickCalls,submitClicks,cursorPage:dayState.cursor.page};}
      const creation=cfg.creationOverride?cfg.creationOverride:{accountId:acct,mainTableUnique:true};
      if(coldActive()){
        const drift=coldDriftLive()?cold.drift:null;
        const coldCreation=drift==='account'?{accountId:'9999999999999999999',mainTableUnique:true}
          :drift==='main'?{accountId:acct,mainTableUnique:false,mainRootEvidence:['foreign-main-root'],productRowCount:1,rows:['3845811625248558881'],productIds:['3845811625248558881'],uniqueProductCount:1,originOk:true,pathOk:true}
          :creation;
        return {observation:'obs-cold-'+coldReads,url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage:drift==='page'?page+1:page,pageCount,modalPresent:true,inProductModal:true,items:[mkLeaf(page,8,false)]},elements:[{text:'下一步',tag:'BUTTON',index:4}],creation:coldCreation};
      }
      // items:[] is the exact real-observation shape pageObserve produces for this
      // ovui pager (svg-only next li is never a classified leaf) — this is what makes
      // guard.resolvePageTarget throw "No observed next control" and route the fallback.
      // R29 cfg.leaf adds the affirmatively observed currentPage+1 number leaf that the
      // real All pager does expose, so the generic guard can own that one click.
      return {observation:'obs-'+page,url:'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi',pagination:{currentPage:page,pageCount,modalPresent:true,inProductModal:true,items:leafItems()},elements:[{text:'下一步',tag:'BUTTON',index:4}],creation};
    }
    if(fn===rp.numericPickerPagingInPage){
      if(arg.mode==='next'){
        if(fault==='nextNotProven')return {ok:false,reason:'numeric-pager-next-control-not-unique',clicked:false};
        const current=page;
        if(fault!=='stalePage')page=page+1;
        nextClickCalls++;
        return {ok:true,mode:'next',clicked:true,currentPage:current,footerSelectedCount:batchCount(),footerRemainingCapacity:capacity,checkedIds:checkedIds(),accountId:acct};
      }
      if(arg.mode==='read'){
        readCalls++;
        if(fault==='leafScopeNotProven'&&!leafClicked)return {ok:false,reason:'numeric-pager-drawer-not-unique',clicked:false};
        const footerDrift=fault==='leafFooterDrift'&&leafClicked;
        const checkedDrift=fault==='leafCheckedDrift'&&leafClicked;
        const accountDrift=fault==='leafAccountDrift'&&leafClicked;
        return {ok:true,mode:'read',clicked:false,currentPage:page,footerSelectedCount:batchCount(),footerRemainingCapacity:footerDrift?capacity+1:capacity,checkedIds:checkedDrift?checkedIds().concat('399999999999999999'):checkedIds(),accountId:accountDrift?'9999999999999999':acct};
      }
      return {ok:false,reason:'numeric-pager-mode-unknown',clicked:false};
    }
    if(fn===c.actionApply){submitClicks++;closed=true;return {clicked:true};}
    if(fn===c.pageApply){
      if(leafMode!=='unique')throw new Error('generic pageApply must never be reached once the All-numeric fallback owns this page');
      if(!arg||arg.mode!=='click'||arg.expectKind!=='number'||arg.expectPage!==page+1)throw new Error('host generic pageApply received a non next-number instruction '+JSON.stringify(arg));
      leafClickCalls++;leafClicked=true;
      if(fault!=='leafStalePage')page=page+1;
      return {paged:true,mode:'click',index:arg.index,kind:'number'};
    }
    if(fn===rp.readMainTableInPage)return closed?{ok:true,rows:[]}:{ok:false,reason:'table-not-submitted'};
    throw new Error('unexpected numeric ovui pager host evaluate '+(fn.name||String(fn).slice(0,30)));
  }};
  const dayState={lastSelected:[],attempted:[],cursor:{category:cat,page:cfg.cursorPage||1,seenProductIds:[]}};
  const driver=rp.createRealDrivers({page:pageObj,managerPage:{},context:{},dayState,persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:acct,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:cfg.timeoutMs||1200});
  return {page:pageObj,dayState,driver,state:()=>({submitClicks,selectCalls,nextClickCalls,leafClickCalls,readCalls,page,closed,cursorPage:dayState.cursor.page,coldReads,firstWarmSnapshot}),run:()=>driver.browseProducts({selectedIds:baseIds.slice(),needed:capacity,categories:[cat],onProgress:async()=>{}})};
}

test('R28 changePage All-fallback: real ovui svg-next 1->2 new complete cards footer kept, fills 30, submits once, cursor written only after confirmed', async () => {
  const h=numericOvuiPagerHost();
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.nextClickCalls,1,'一次真实ovui next点击，绝不重复点击');
  assert.ok(s.readCalls>=1,'点击后必须有界只读重验证');
  assert.equal(s.selectCalls,30,'page1的20个加page2的10个共勾选30');
  assert.equal(s.submitClicks,1,'足30后一次picker提交');
  assert.equal(s.cursorPage,2,'cursor.page只有在确认前进到第2页之后才写入');
});

test('R28 changePage All-fallback: stale page number after a proven click times out, never a false confirmed and never re-clicks', async () => {
  const h=numericOvuiPagerHost({fault:'stalePage'});
  await assert.rejects(h.run(),/numeric-ovui-page-advance-timeout/);
  const s=h.state();
  assert.equal(s.nextClickCalls,1,'一次点击后只读等待，绝不因超时重点击');
  assert.ok(s.readCalls>=1,'等待期间只读轮询');
  assert.equal(s.submitClicks,0,'页码不动绝不提交');
  assert.equal(s.cursorPage,1,'未确认绝不写新页码cursor');
});

test('R28 changePage All-fallback: page advances but DOM keeps old ids times out, never accepts a stale card set', async () => {
  const h=numericOvuiPagerHost({fault:'oldIds'});
  await assert.rejects(h.run(),/numeric-ovui-page-advance-timeout/);
  const s=h.state();
  assert.equal(s.nextClickCalls,1);
  assert.equal(s.submitClicks,0,'旧ids未变更绝不提交');
  assert.equal(s.cursorPage,1,'未确认绝不写新页码cursor');
});

test('R28 changePage All-fallback: a strict-proof failure before any click stops immediately with zero clicks and zero reads', async () => {
  const h=numericOvuiPagerHost({fault:'nextNotProven'});
  await assert.rejects(h.run(),/numeric-ovui-page-advance-not-proven/);
  const s=h.state();
  assert.equal(s.nextClickCalls,0,'未证明零点击');
  assert.equal(s.readCalls,0,'零点击绝不进入等待轮询');
  assert.equal(s.submitClicks,0);
  assert.equal(s.cursorPage,1);
});

test('R28 both fixes together: first-ever All browse with no main table yet AND the real ovui svg-next pager closes the full 30-product loop', async () => {
  const h=numericOvuiPagerHost({creationOverride:firstEmptyCreationShape()});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.nextClickCalls,1);assert.equal(s.submitClicks,1);assert.equal(s.cursorPage,2);
});

// ── R29 ──────────────────────────────────────────────────────────────────────
// 同一 CNR6 稳定事件的窄补修：真实 All 分页里 currentPage+1 的数字叶本身就被通用
// 观察者观察到（root 实测仅一次 generic guard number2 就前进到 page2），所以 catch
// 到 "No observed next control" 时必须先用现有 guard.resolvePageTarget+guard.pageApply
// 点那一个严格唯一且肯定 enabled 的数字叶；只有该数字确实未被观察到才保留 R28 的
// svg 严格回退。重复/disabled/unknown 数字、证明不充分的同 scope 读取、guide 遮罩、
// 主表不符 base 一律零动作停止，绝不 fallback 绕过；paged:true 从不算成功。
const r29Base18=Array.from({length:18},(_,i)=>'384581162524855'+String(5000+i));
const r29Page2Twelve=Array.from({length:12},(_,i)=>'384581162524855'+String(7000+i));

test('R29 base18/cap12 cursor restore 1->2 prefers the observed number leaf through the guard, never touches the svg next, tops up to 30 and submits once', async () => {
  const h=numericOvuiPagerHost({baseIds:r29Base18,checkedIds:r29Base18.slice(0,13),page1Ids:r29Base18.slice(0,13),page2Ids:r29Page2Twelve,leaf:'unique',cursorPage:2});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30,'补选后正好30');
  assert.equal(r29Base18.every(id=>r.selectedIds.includes(id)),true,'原18个已知manual全保留');
  const s=h.state();
  assert.equal(s.leafClickCalls,1,'一次且仅一次 guard 数字叶点击');
  assert.equal(s.nextClickCalls,0,'观察到next数字叶时 svg next 回调零调用');
  assert.ok(s.readCalls>=1,'点击前同一scope与点击后重验证都用冻结read回调');
  assert.equal(s.submitClicks,1,'补满30后一次picker提交');
  assert.equal(s.cursorPage,2,'cursor 只在确认到第2页之后写入');
});

test('R29 base0 normal advance uses the unique enabled page-2 number leaf once (svg next zero calls) and completes the 30 loop', async () => {
  const h=numericOvuiPagerHost({leaf:'unique'});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.leafClickCalls,1);
  assert.equal(s.nextClickCalls,0,'数字叶路径不点svg');
  assert.equal(s.selectCalls,30,'page1的20个加page2的10个');
  assert.equal(s.submitClicks,1);
  assert.equal(s.cursorPage,2);
});

test('R29 first-ever plan base0 with the known-empty main table still advances through the observed number leaf and completes 30', async () => {
  const h=numericOvuiPagerHost({leaf:'unique',creationOverride:firstEmptyCreationShape()});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.leafClickCalls,1);assert.equal(s.nextClickCalls,0);
  assert.equal(s.submitClicks,1);assert.equal(s.cursorPage,2);
});

test('R29 with no observed next number leaf the R28 strict svg fallback still owns the advance (one svg click, zero guard pageApply)', async () => {
  const h=numericOvuiPagerHost();
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  const s=h.state();
  assert.equal(s.leafClickCalls,0,'未观察到数字叶绝不走generic pageApply');
  assert.equal(s.nextClickCalls,1,'缺数字时既有svg回退继续');
  assert.equal(s.submitClicks,1);assert.equal(s.cursorPage,2);
});

test('R29 a duplicated observed number leaf for page 2 is a zero-action stop that never routes around to the svg fallback', async () => {
  const h=numericOvuiPagerHost({leaf:'duplicate'});
  await assert.rejects(h.run(),/numeric-leaf-next-page-control-duplicate/);
  const s=h.state();
  assert.equal(s.leafClickCalls,0);
  assert.equal(s.nextClickCalls,0,'重复数字绝不fallback绕过');
  assert.equal(s.readCalls,0,'判定在读取之前，零动作');
  assert.equal(s.submitClicks,0);assert.equal(s.cursorPage,1);
});

test('R29 a disabled or unknown-state number leaf for page 2 stops with zero clicks and never routes around to the svg fallback', async () => {
  for(const leaf of ['disabled','unknown']){
    const h=numericOvuiPagerHost({leaf});
    await assert.rejects(h.run(),/numeric-leaf-next-page-control-disabled-or-unknown/,leaf);
    const s=h.state();
    assert.equal(s.leafClickCalls,0,leaf);
    assert.equal(s.nextClickCalls,0,leaf+'：disabled/unknown 数字绝不绕过到svg');
    assert.equal(s.submitClicks,0,leaf);assert.equal(s.cursorPage,1,leaf);
  }
});

test('R29 an insufficient same-scope read proof before the leaf click stops immediately with zero clicks and no svg fallback', async () => {
  const h=numericOvuiPagerHost({leaf:'unique',fault:'leafScopeNotProven'});
  await assert.rejects(h.run(),/numeric-leaf-scope-not-proven/);
  const s=h.state();
  assert.equal(s.readCalls,1,'证明不充分立即停止，不再重试读取');
  assert.equal(s.leafClickCalls,0);assert.equal(s.nextClickCalls,0);
  assert.equal(s.submitClicks,0);assert.equal(s.cursorPage,1);
});

test('R29 a present or unknown guide overlay at the leaf step is a zero-click stop', async () => {
  for(const guide of ['present','unknown']){
    const h=numericOvuiPagerHost({leaf:'unique',guide,timeoutMs:400});
    // R55: a KNOWN late overlay is no longer refused by an R29-private reason. It is routed
    // through the SAME real guidance phase, and only a phase that leaves the overlay still on
    // screen (here: a present shape with no actionable root) stops — with the shared
    // native-advance-guide-overlay-present reason and the same zero-click guarantee.
    if(guide==='present')await assert.rejects(h.run(),/native-advance-guide-overlay-present/,guide);
    else await assert.rejects(h.run(),/guide-shape-unknown/,guide);
    const s=h.state();
    assert.equal(s.leafClickCalls,0,guide);assert.equal(s.nextClickCalls,0,guide);
    assert.equal(s.submitClicks,0,guide);assert.equal(s.cursorPage,1,guide);
  }
});

test('R29 base18 top-up whose main table is not unique stops before the leaf click with zero clicks (main首屏例外只属于base0首次)', async () => {
  const h=numericOvuiPagerHost({baseIds:r29Base18,checkedIds:r29Base18.slice(0,13),page1Ids:r29Base18.slice(0,13),page2Ids:r29Page2Twelve,leaf:'unique',cursorPage:2,creationOverride:{accountId:String(wf.BUSINESS.accountId),mainTableUnique:false},timeoutMs:400});
  await assert.rejects(h.run(),/current-product-page-main-table-not-unique/);
  const s=h.state();
  assert.equal(s.leafClickCalls,0);assert.equal(s.nextClickCalls,0);assert.equal(s.submitClicks,0);
});

test('R29 after the leaf click a stale page, old ids, footer, checked, account or category drift never confirms, writes no cursor and never re-clicks', async () => {
  for(const fault of ['leafStalePage','leafOldIds','leafFooterDrift','leafCheckedDrift','leafAccountDrift','leafCategoryDrift']){
    const h=numericOvuiPagerHost({leaf:'unique',fault,timeoutMs:400});
    await assert.rejects(h.run(),/numeric-leaf-page-advance-timeout/,fault);
    const s=h.state();
    assert.equal(s.leafClickCalls,1,fault+'：一次叶点击后只读等待，绝不重点击');
    assert.equal(s.nextClickCalls,0,fault);
    assert.equal(s.submitClicks,0,fault+'：未确认绝不提交');
    assert.equal(s.cursorPage,1,fault+'：未确认绝不写新页码cursor');
  }
});

test('R29 numericPickerPagingInPage read proves the same All scope on a real DOM carrying the 1-5/60 number leaves while an unknown next icon is never used as proof', () => {
  const {ctx}=numericOvuiPagerDom({next:'ariaDisabledOnly'});
  const r=plain(ctx.run(rp.numericPickerPagingInPage,{mode:'read',expectedCurrentPage:1,expectedSelectedCount:0,expectedCapacity:30,selectedIds:[],accountId:String(wf.BUSINESS.accountId)}));
  assert.equal(r.ok,true,'同一scope读取成立');
  assert.equal(r.clicked,false,'read模式零点击');
  assert.equal(r.currentPage,1);
  assert.deepEqual(r.checkedIds,[]);
  assert.equal(r.footerSelectedCount,0);
  assert.equal(r.footerRemainingCapacity,30);
});

// ── R30 ──────────────────────────────────────────────────────────────────────
// 同一 CNR6 稳定事件的加载缺口窄补修：真实 All 窗在开窗/首次 cursor restore 后短暂
// 处于未渲染形态（ok=true、cards 0、footer保持、currentPage 1、数字只有当前页）。
// R29 在该 stale 观察上把还没出现的“2”判为 absent，过早进入严格 svg 证明并超时。
// R30 在 changePage 的 All catch 内先用既有有界只读 settleProductPage 等待就绪，
// 再以同一 currentPage 的 fresh observe+drawer 决定 target：有数字叶走 R29 数字叶
// 一次（svg 零调用），就绪后确实缺数字才保留 R28 svg。等待期间任何身份漂移立即停，
// 永久空/重复/invalid 到有界期限零动作停。native 三条路径与 generic next 不变。
test('R30 cold init: blank page1 then stable 30+number-2 completes the normal advance through exactly one number leaf, zero svg, one submit, zero actions during the wait', async () => {
  const h=numericOvuiPagerHost({leaf:'unique',cold:{reads:2},timeoutMs:3000});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.ok(s.coldReads>=2,'就绪等待真实轮询了冷窗，不是一次读取就跳过');
  assert.equal(s.firstWarmSnapshot.selectCalls,0,'就绪等待期间零选择');
  assert.equal(s.firstWarmSnapshot.leafClickCalls,0,'就绪等待期间零数字叶点击');
  assert.equal(s.firstWarmSnapshot.nextClickCalls,0,'就绪等待期间零分页点击');
  assert.equal(s.firstWarmSnapshot.submitClicks,0,'就绪等待期间零提交');
  assert.equal(s.leafClickCalls,1,'ready后数字路径恰好一次');
  assert.equal(s.nextClickCalls,0,'数字叶路径不碰svg');
  assert.equal(s.submitClicks,1,'补满30一次提交');
  assert.equal(s.cursorPage,2);
});

test('R30 cold first cursor restore: readiness settles inside changePage before any click, every advance takes its own fresh number leaf and svg stays zero', async () => {
  const h=numericOvuiPagerHost({leaf:'unique',cursorPage:2,pageCount:3,cold:{reads:3},timeoutMs:3000});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30,'restore后10+20补满30');
  const s=h.state();
  assert.equal(s.firstWarmSnapshot.page,1,'首次warm仍在第1页：恢复点击晚于就绪');
  assert.equal(s.firstWarmSnapshot.selectCalls,0);
  assert.equal(s.firstWarmSnapshot.leafClickCalls,0,'cursor restore 点击只在就绪后发生');
  assert.equal(s.firstWarmSnapshot.nextClickCalls,0,'就绪等待期间零svg');
  assert.equal(s.firstWarmSnapshot.submitClicks,0);
  assert.equal(s.leafClickCalls,2,'restore 1->2 与正常 2->3 各一次各自fresh数字叶');
  assert.equal(s.nextClickCalls,0,'svg next 零调用');
  assert.equal(s.submitClicks,1);
  assert.equal(s.cursorPage,3);
});

test('R30 base18/cap12 same delay: cold restore keeps footer0-cap12 and known-checked13 inside the wait, then one number leaf tops up to 30 and submits once', async () => {
  const h=numericOvuiPagerHost({baseIds:r29Base18,checkedIds:r29Base18.slice(0,13),page1Ids:r29Base18.slice(0,13),page2Ids:r29Page2Twelve,leaf:'unique',cursorPage:2,cold:{reads:3},timeoutMs:3000});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  assert.equal(r29Base18.every(id=>r.selectedIds.includes(id)),true,'原18个已知manual全保留');
  const s=h.state();
  assert.equal(s.firstWarmSnapshot.selectCalls,0,'等待期零选择：footer0-cap12/known13都按既有settle契约等待');
  assert.equal(s.firstWarmSnapshot.page,1);
  assert.equal(s.selectCalls,12,'就绪后只补page2的12个新卡');
  assert.equal(s.leafClickCalls,1);
  assert.equal(s.nextClickCalls,0);
  assert.equal(s.submitClicks,1);
  assert.equal(s.cursorPage,2);
});

test('R30 cold then genuinely no next number after readiness keeps the strict R28 svg proof (one svg click, zero guard pageApply, footer/capacity preserved, 30 and one submit)', async () => {
  const h=numericOvuiPagerHost({baseIds:r29Base18,checkedIds:r29Base18.slice(0,13),page1Ids:r29Base18.slice(0,13),page2Ids:r29Page2Twelve,cursorPage:2,cold:{reads:3},timeoutMs:3000});
  const r=await h.run();
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.leafClickCalls,0,'没有数字叶绝不走generic pageApply');
  assert.equal(s.nextClickCalls,1,'已稳定且确实缺数字时旧的严格svg回退继续拥有前进');
  assert.equal(s.submitClicks,1);
  assert.equal(s.cursorPage,2);
});

test('R30 a permanently blank/duplicate/invalid All page stops at the existing bound with zero clicks, zero selects, zero submits and no cursor move', async () => {
  for(const cards of ['blank','duplicate','invalid']){
    const h=numericOvuiPagerHost({leaf:'unique',cursorPage:2,cold:{permanent:true,cards},timeoutMs:400});
    await assert.rejects(h.run(),/current-product-page-not-stable-empty-or-duplicate/,cards);
    const s=h.state();
    assert.equal(s.leafClickCalls,0,cards);
    assert.equal(s.nextClickCalls,0,cards);
    assert.equal(s.selectCalls,0,cards);
    assert.equal(s.submitClicks,0,cards);
    assert.equal(s.cursorPage,2,cards+'：等待超时不改cursor');
  }
});

test('R30 account/category/page/footer/checked/main drift during the readiness wait stops immediately with zero actions and no cursor move', async () => {
  const cases=[
    ['account',/current-product-page-account-drift/],
    ['category',/current-product-page-category-not-active/],
    ['page',/current-product-page-number-drift/],
    ['footer',/current-product-page-footer-capacity-drift/],
    ['checked',/current-product-page-checked-drift/],
    ['main',/current-product-page-main-table-not-unique/],
  ];
  for(const [drift,re] of cases){
    const h=numericOvuiPagerHost({leaf:'unique',cursorPage:2,cold:{reads:9,drift,driftAt:3},timeoutMs:3000});
    await assert.rejects(h.run(),re,drift);
    const s=h.state();
    assert.ok(s.coldReads>=3,drift+'：漂移发生在等待窗口内而非首读');
    assert.equal(s.leafClickCalls,0,drift);
    assert.equal(s.nextClickCalls,0,drift);
    assert.equal(s.selectCalls,0,drift);
    assert.equal(s.submitClicks,0,drift);
    assert.equal(s.cursorPage,2,drift+'：漂移零动作停止，cursor不动');
  }
});

test('R30 mixed native+numeric catalog browse is behaviorally unchanged: native first batch, numeric backfill to 30, no All advance and no extra paging', async () => {
  const storeNew=catalogIds('38467389451530',10);
  const allPage=catalogIds('38404143974366',30);
  const h=makeCatalogHost({order:['店铺新品','全部'],native:{'店铺新品':{tab:'2',batches:[{ids:storeNew,hasMore:false}]}},numeric:{'全部':{tab:'1',pages:[allPage]}},published:[]});
  const result=await h.driver.browseProducts({selectedIds:[],needed:30,categories:['店铺新品','全部'],onProgress:async()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.selectedIds.length,30);
  const s=h.state();
  assert.equal(s.scrollSteps,0,'hasMore=false 原生分类不滚动，与修改前一致');
  assert.equal(s.numericPage,0,'单页30的全部从不进入分页动作，generic/native路径未被触碰');
});

// ═══════════════════════════════════════════════════════════════════════════
// R32 — min-1 manual target binding: at least ONE of the two approved targets
// per product qualifies; identity scope stays strictly the two candidates; zero /
// auto-pull / unknown still refuse; a definite 1 is never removed or re-top-upped.
// ═══════════════════════════════════════════════════════════════════════════

function r32Host({target='9zmao_fushi',foreign=false,finalManual=1,failedZero=false,withResult=false,timeoutMs=150}={}){
  const ids=Array.from({length:30},(_,i)=>'384581162524855'+String(5100+i));
  const rowId=foreign?'55555555':target;
  const mainRowsPre=ids.map(productId=>({productId,manualAccounts:0,manualEvidence:false,manualCountKnown:true,autoPullOnly:false,reviewFailed:false}));
  const mainRowsPost=ids.map(productId=>{
    const failed=failedZero&&productId===ids[29];
    return {productId,manualAccounts:failed?0:finalManual,manualEvidence:!failed,manualCountKnown:true,autoPullOnly:failed,reviewFailed:false};
  });
  let headerDone=false,committed=false,confirmed=0,modalConfirmed=0,resultAcks=0,applyCalls=0,selectAllCalls=0,navClicks=0;
  let probeActive=ids[0];
  const page={evaluate:async(fn,arg)=>{
    if(fn===rp.readMainTableInPage)return {ok:true,rows:committed?mainRowsPost:mainRowsPre};
    if(fn===rp.bindingDrawerSnapshotInPage){
      return {ok:true,rows:[{ids:[rowId],checked:headerDone,labelDisabled:false}],headerSelectAllCount:1,headerLabelDisabled:false,
        selectedCount:headerDone?1:0,totalCount:30,batchButtonCount:1,batchEnabled:true,panelProductIds:ids,activeProductIds:[probeActive]};
    }
    if(fn===rp.selectAllAccountsInPage){selectAllCalls++;if(foreign)throw new Error('account-drawer-does-not-show-exact-target-rows');headerDone=true;return {clicked:true};}
    if(fn===rp.applyBatchAccountsInPage){applyCalls++;return {clicked:true};}
    if(fn===rp.batchAddAllModalSnapshotInPage)return {ok:true,modalCount:1,productCount:29,accountCount:1,drawerSettled:headerDone};
    if(fn===rp.confirmBatchAddAllModalInPage){modalConfirmed++;return {clicked:true,productCount:29};}
    if(fn===rp.batchResultSnapshotInPage){
      if(!withResult)return {present:false,known:false,settled:false,rowCount:0,uniqueCount:0,outside:0,duplicate:false,ambiguous:0,anchorMismatch:false,failedIds:[],successCount:0};
      return {present:true,known:true,settled:true,rowCount:29,uniqueCount:29,outside:0,duplicate:false,ambiguous:0,anchorMismatch:false,failedIds:[ids[29]],successCount:28};
    }
    if(fn===rp.acknowledgeBatchResultInPage){resultAcks++;return {present:true,acked:true,failedIds:[ids[29]],successCount:28};}
    if(fn===rp.bindingOverlaySnapshotInPage)return {accountDrawerCount:1,blockingOverlayPresent:false};
    if(fn===rp.selectBindingDrawerPanelInPage){navClicks++;probeActive=String(arg);return {clicked:true,id:String(arg)};}
    if(fn===rp.confirmBatchAccountsApplyInPage){confirmed++;committed=true;return {clicked:true};}
    if(fn===rp.acceptPartialDraftWarningInPage)return {present:false};
    if(fn===rp.guidanceActionInPage)return {present:false,unknown:false,roots:[]};
    if(!fn.name)return {ok:true};
    throw new Error('unexpected r32 function '+fn.name);
  }};
  const driver=rp.createRealDrivers({page,managerPage:{},context:{},dayState:{lastSelected:[],cursor:{seenProductIds:[]}},persist:async()=>{},publishedIds:new Set(),attemptedSet:new Set(),hints:{},accountId:wf.BUSINESS.accountId,opened:{},projectRoot:__dirname,planNumber:1,runId:'offline',nativeScrollTimeoutMs:timeoutMs});
  return {driver,ids,bind:()=>driver.bindAccountsToAll({productIds:ids}),state:()=>({confirmed,modalConfirmed,applyCalls,selectAllCalls,resultAcks,navClicks})};
}

test('R32 one available target: single-row drawer is selected in ONE header action, batched, and every 1-account product is kept', async () => {
  const h=r32Host({target:'79863866'});
  const result=await h.bind();
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.batchApplied,true);
  const s=h.state();
  assert.equal(s.selectAllCalls,1,'一个可用目标只需一次表头选择动作');
  assert.equal(s.applyCalls,1);assert.equal(s.modalConfirmed,1,'独立批量确认模态恰好一次');assert.equal(s.confirmed,1,'草稿确定恰好一次');
  assert.equal(s.resultAcks,0,'全成功无结果浮窗不点我知道了');
  assert.equal(s.navClicks,31,'全30面板逐个证明后还原初始anchor一次');
  assert.equal(result.rows.length,30);
  assert.ok(result.rows.every(r=>r.manualAccounts===1),'每件商品1个手动账号即合格且保留');
  assert.deepEqual(result.accountIds.slice().sort(),['79863866','9zmao_fushi'].slice().sort(),'候选身份仍如实为两种获批目标');
  assert.equal(wf.evaluateReadiness(result.rows,30).ready,true,'1账号主表通过就绪门');
});

test('R32 identity scope: a foreign single account row refuses with ZERO select/apply/commit', async () => {
  const h=r32Host({foreign:true,timeoutMs:150});
  const result=await h.bind();
  assert.equal(result.ok,false);
  assert.equal(result.reason,'account-drawer-does-not-show-exact-two-target-accounts');
  const s=h.state();
  assert.equal(s.selectAllCalls,0);assert.equal(s.applyCalls,0);assert.equal(s.confirmed,0,'非目标身份绝不进入绑定');
});

test('R32 batch-result fail is not trusted over the main table: a definite 1-account product is kept, readiness stays ready', async () => {
  const h=r32Host({withResult:true,finalManual:1});
  const result=await h.bind();
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.partial,true);
  assert.deepEqual(result.failedIds,[h.ids[29]]);
  const kept=result.rows.find(r=>String(r.productId)===h.ids[29]);
  assert.equal(kept.manualAccounts,1,'"1个抖音号添加失败"但主表确定1的商品必须保留');
  assert.equal(wf.evaluateReadiness(result.rows,30).ready,true,'保留的1账号行不就绪失败也不触发补选');
  const plan=wf.planRemovalAndBackfill({rows:result.rows,capacity:30,catalogRemainingIds:['3840000000000000001'],attempted:[],published:[]});
  assert.deepEqual(plan.removeIds,[],'不因第二个账号失败而移除成功绑定1的商品');
});

test('R32 both targets failed (actual 0): row kept by the readback contract, then removal/backfill treats it as deficient', async () => {
  const h=r32Host({withResult:true,failedZero:true});
  const result=await h.bind();
  assert.equal(result.ok,true,JSON.stringify(result));
  const zero=result.rows.find(r=>String(r.productId)===h.ids[29]);
  assert.equal(zero.manualAccounts,0,'两目标皆失败的主表真实为0');
  const readiness=wf.evaluateReadiness(result.rows,30);
  assert.equal(readiness.ready,false);
  assert.deepEqual(readiness.deficientIds,[String(h.ids[29])],'0个手动账号是不合格不足行');
  const plan=wf.planRemovalAndBackfill({rows:result.rows,capacity:30,catalogRemainingIds:['3840000000000000001'],attempted:[String(h.ids[29])],published:[]});
  assert.deepEqual(plan.removeIds,[String(h.ids[29])]);
  assert.deepEqual(plan.backfillIds,['3840000000000000001'],'0账号原受控补选一个候选');
});

test('R32 header select-all DOM: 1-row drawer clicks once; enabled+disabled rows click once for the available target; all-disabled or foreign refuse with zero clicks', () => {
  const single=bindingDrawerRoot({ids:['9zmao_fushi'],checks:[false],footer:'当前商品已选：0/30'});
  const singleHeader=[...single.querySelectorAll('thead label')][0];
  assert.deepEqual(plain(makeCtx([single]).run(rp.selectAllAccountsInPage)),{clicked:true});
  assert.equal(singleHeader.__clicks,1,'单目标抽屉一次表头动作完成选择');

  // one enabled unchecked + one LABEL-disabled unchecked: the header selects the available one
  const enabled=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const dis=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const disCell=El('td',{},[El('label',{class:'ovui-checkbox ovui-checkbox--disabled',rect:[20,20]},[dis])]);
  const mixedRows=[
    El('tr',{rect:[400,32]},[El('td',{text:'ID: 79863866'}),El('td',{},[enabled])]),
    El('tr',{rect:[400,32]},[El('td',{text:'ID: 9zmao_fushi'}),disCell]),
  ];
  const mixedHeaderInput=El('input',{attrs:{type:'checkbox'},checked:false,rect:[12,12]});
  const mixedHeaderLabel=El('label',{class:'ovui-checkbox',rect:[20,20]},[mixedHeaderInput]);
  const mixed=El('div',{class:'dialog',attrs:{role:'dialog'},rect:[600,500],text:'为商品添加抖音号'},[
    El('thead',{},[El('tr',{},[El('th',{},[mixedHeaderLabel])])]),
    ...mixedRows,
    El('div',{text:'当前商品已选：0/30'}),
    El('button',{rect:[260,20],text:'将所选抖音号批量添加至所有商品'}),
    El('button',{rect:[80,32],text:'确定'}),
  ]);
  assert.deepEqual(plain(makeCtx([mixed]).run(rp.selectAllAccountsInPage)),{clicked:true},'一个目标不可用时仍允许一次表头动作选择剩余可用目标');
  assert.equal(mixedHeaderLabel.__clicks,1,'可用+禁用行只点一次表头');

  const foreign=bindingDrawerRoot({ids:['55555555'],checks:[false],footer:'当前商品已选：0/30'});
  const foreignHeader=[...foreign.querySelectorAll('thead label')][0];
  assert.throws(()=>makeCtx([foreign]).run(rp.selectAllAccountsInPage),/account-drawer-does-not-show-exact-target-rows/);
  assert.equal(foreignHeader.__clicks,undefined,'非目标身份行零点击');

  const allDis=bindingDrawerRoot({checks:[false,false],footer:'当前商品已选：0/30',disabledRows:true});
  const allDisHeader=[...allDis.querySelectorAll('thead label')][0];
  assert.throws(()=>makeCtx([allDis]).run(rp.selectAllAccountsInPage),/native-account-rows-label-disabled/);
  assert.equal(allDisHeader.__clicks,undefined,'全部禁用没有可选目标，零点击');
});

test('R32 batch modal DOM gates: 1-account settled drawer submits once; modal/drawer count mismatch and foreign rows refuse', () => {
  const drawer=bindingDrawerRoot({ids:['79863866'],checks:[true],footer:'当前商品已选：1/30'});
  const modal=batchModalRoot({accounts:'1'});
  const snap=plain(makeCtx([drawer,modal]).run(rp.batchAddAllModalSnapshotInPage));
  assert.deepEqual(snap,{ok:true,modalCount:1,productCount:29,accountCount:1,drawerSettled:true});
  const btn=[...modal.querySelectorAll('button')][0];
  assert.deepEqual(plain(makeCtx([drawer,modal]).run(rp.confirmBatchAddAllModalInPage,29)),{clicked:true,productCount:29});
  assert.equal(btn.__clicks,1,'单目标已选模态恰好一次确定');
  const mismatch=batchModalRoot({accounts:'2'});
  assert.throws(()=>makeCtx([drawer,mismatch]).run(rp.confirmBatchAddAllModalInPage,29),/batch-add-modal-account-count-mismatch/,'模态声称2而抽屉只 settled 1 必须拒绝');
  const foreignDrawer=bindingDrawerRoot({ids:['55555555'],checks:[true],footer:'当前商品已选：1/30'});
  assert.throws(()=>makeCtx([foreignDrawer,modal]).run(rp.confirmBatchAddAllModalInPage,29),/batch-add-modal-accounts-not-settled/,'非目标身份的1账号抽屉不得提交');
});

test('R32 classifyPublishOutcome: plan row with 1..10 accounts can succeed; 0 / 11 / unknown stay field-mismatch', () => {
  const base={found:true,uniqueRow:true,planName:'P',planId:'1878537802445003',productCount:30,roi:15,dailyBudget:300,commissionIncluded:true};
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:1,status:'投放中'},{planName:'P'}).outcome,'success','1个账号的真实回读可判成功');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:2,status:'审核中'},{planName:'P'}).outcome,'success');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:3,status:'投放中'},{planName:'P'}).outcome,'success');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:10,status:'投放中'},{planName:'P'}).outcome,'success');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:0,status:'投放中'},{planName:'P'}).reason,'field-mismatch:accountCount=0');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:11,status:'投放中'},{planName:'P'}).reason,'field-mismatch:accountCount=11');
  assert.equal(wf.classifyPublishOutcome({...base,accountCount:null,status:'投放中'},{planName:'P'}).outcome,'unknown','账号数未知绝不判成功');
});

test('R32 readiness/removal: auto-pull-only and unknown manual evidence still refuse; 1 is not deficient', () => {
  const okRow=id=>({productId:id,manualAccounts:1,manualEvidence:true,manualCountKnown:true,autoPullOnly:false,reviewFailed:false,ambiguous:false,idCount:1});
  const rows=Array.from({length:30},(_,i)=>okRow('384581162524855'+String(5000+i)));
  assert.equal(wf.evaluateReadiness(rows,30).ready,true);
  const autoOnly=rows.slice(0,29).concat([{productId:'3845811625248559998',manualAccounts:0,manualEvidence:true,manualCountKnown:true,autoPullOnly:true,reviewFailed:false,ambiguous:false,idCount:1}]);
  const rAuto=wf.evaluateReadiness(autoOnly,30);
  assert.equal(rAuto.ready,false,'仅自动拉取不算手动绑定');
  assert.deepEqual(rAuto.deficientIds,['3845811625248559998']);
  const unknown=rows.slice(0,29).concat([{productId:'3845811625248559997',manualAccounts:null,manualEvidence:false,manualCountKnown:false,autoPullOnly:false,reviewFailed:false,ambiguous:false,idCount:1}]);
  const rUnk=wf.evaluateReadiness(unknown,30);
  assert.equal(rUnk.ready,false,'证据未知不判就绪');
  assert.deepEqual(rUnk.unknownManualIds,['3845811625248559997']);
  assert.deepEqual(rUnk.deficientIds,[],'未知不当作不足行删除');
});


