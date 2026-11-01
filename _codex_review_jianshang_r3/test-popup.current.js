test('ensureQianchuanAccountView：指针遮挡后浮层下仍识别并关闭唯一已证营销弹窗，下一轮再核验身份与切换', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    // 浮层遮挡：店铺视图/切换按钮不可见，但唯一结构匹配的安全营销弹窗可见
    { shopView: false, switchPresent: false, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({
    views,
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) {
        const e = new Error('button.click: Timeout 10000ms exceeded: element intercepts pointer events');
        e.name = 'TimeoutError';
        throw e;
      }
    },
  });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true, '遮挡关闭后恢复店铺视图并成功切换');
  assert.strictEqual(calls.closeClicks, 1, '唯一安全弹窗只关闭一次');
  assert.strictEqual(calls.switchClicks, 2, '首次被遮挡 + 关闭后成功切换（共 2 次）');
  assert.strictEqual(calls.businessClicks, 0, '绝不点击业务按钮（投放乘方/开启货款直投）');
});

test('ensureQianchuanAccountView：遮挡后下一轮仍是不安全弹窗 → DataGuardError 且零业务点击', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    // 不唯一/结构不符（例如多个关闭按钮）→ safe=false
    { shopView: false, switchPresent: false, popup: { present: true, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({
    views,
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) {
        const e = new Error('element intercepts pointer events');
        e.name = 'TimeoutError';
        throw e;
      }
    },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    (err) => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0, '不安全弹窗不点击关闭');
  assert.strictEqual(calls.businessClicks, 0, '零业务点击');
});

// ── 弹窗安全判定：真实页面内探针（VM 执行真实源码，非重写副本）────────────

class PopupNode {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.visible = attrs.visible !== false;
    this.clickCount = 0;
    this.classList = { contains: c => String(this.className).split(/\s+/).filter(Boolean).includes(c) };
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  click() { this.clickCount += 1; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  getBoundingClientRect() { return this.visible ? { width: 100, height: 40 } : { width: 0, height: 0 }; }
  contains(node) { return node === this || this.children.some(c => c.contains(node)); }
  querySelectorAll(sel) { return popupQueryAll(this, sel); }
}

function popupMatches(node, compound) {
  const tag = /^([a-zA-Z][\w-]*)/.exec(compound);
  if (tag && node.tagName !== tag[1].toUpperCase()) return false;
  for (const c of compound.match(/\.([\w-]+)/g) || []) {
    if (!node.classList.contains(c.slice(1))) return false;
  }
  const attrRe = /\[([\w-]+)(?:([*^$]?)=)"([^"]*)"\]/g;
  let m;
  while ((m = attrRe.exec(compound))) {
    const actual = node.getAttribute(m[1]);
    if (actual == null) return false;
    if (m[2] === '=' && actual !== m[3]) return false;
    if (m[2] === '*=' && !actual.includes(m[3])) return false;
  }
  return true;
}

function popupQueryAll(root, sel) {
  const selectors = String(sel).split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  const walk = node => {
    for (const child of node.children) {
      if (selectors.some(s => popupMatches(child, s))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** 构造千川营销弹窗/未知对话框的 mock DOM（结构与真实探针选择器一致）。 */
function buildPopupDom(opts = {}) {
  const body = new PopupNode('body');
  const host = opts.inForm ? body.appendChild(new PopupNode('form')) : body;
  // 默认已知根 overall-release-modal-v2-wrap；opts.rootClass === false 表示故意省略。
  let rootHost = host;
  if (opts.rootClass !== false) {
    const rootCls = opts.rootClass === undefined ? 'overall-release-modal-v2-wrap' : opts.rootClass;
    rootHost = host.appendChild(new PopupNode('div', { class: rootCls }));
  }
  const wrap = rootHost.appendChild(new PopupNode('div', opts.dialog ? { role: 'dialog' } : {}));
  const content = wrap.appendChild(new PopupNode('div', { class: 'content' },
    opts.text === undefined ? '智能投放 让好内容更有生命力 了解详情' : opts.text));
  const closes = [];
  const closeCount = opts.closes === undefined ? 1 : opts.closes;
  for (let i = 0; i < closeCount; i += 1) {
    const closeAttrs = {
      class: 'close-button',
      visible: opts.closeVisible !== false,
    };
    if (opts.closeLabel !== null) closeAttrs['aria-label'] = opts.closeLabel === undefined ? '关闭' : opts.closeLabel;
    if (opts.closeType !== null) closeAttrs.type = opts.closeType === undefined ? 'button' : opts.closeType;
    const close = content.appendChild(new PopupNode('button', closeAttrs,
      opts.closeText === undefined ? '×' : opts.closeText));
    if (opts.withIcon !== false) {
      close.appendChild(new PopupNode('iconpark-icon', { name: 'oc-icon-close' }));
    }
    closes.push(close);
  }
  for (const label of (opts.business || ['投放乘方', '开启货款直投'])) {
    content.appendChild(new PopupNode('button', {}, label));
  }
  for (let i = 0; i < (opts.links || 0); i += 1) {
    content.appendChild(new PopupNode('a', { href: '#' }, '了解详情'));
  }
  if (opts.extra) content.appendChild(new PopupNode(opts.extra.tag, opts.extra.attrs || {}, opts.extra.text || ''));
  return { body, wrap, content, closes };
}

function runViewProbe(dom, arg) {
  const ctx = vm.createContext({
    document: {
      body: dom.body,
      querySelectorAll: sel => popupQueryAll(dom.body, sel),
    },
    location: { href: QC_ACCOUNT_URL },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  return vm.runInContext(`(${readQianchuanAccountViewInPage.toString()})(${JSON.stringify(arg || {})})`, ctx);
}

test('弹窗安全判定：已证营销弹窗（唯一×+两个业务CTA+至多1个链接）→ safe 且打上本次标记', () => {
  const dom = buildPopupDom({ dialog: true, links: 1 });
  const r = runViewProbe(dom, { tag: 'qc-tag-1' });
  assert.strictEqual(r.popup.present, true);
  assert.strictEqual(r.popup.safe, true, r.popup.reason);
  assert.strictEqual(r.popup.closeTag, 'qc-tag-1');
  assert.strictEqual(dom.closes[0].getAttribute('data-qc-popup-close'), 'qc-tag-1', '唯一关闭按钮被打标');
});

test('弹窗安全判定：无链接/无 dialog 的已知结构仍安全（不误杀实测结构）', () => {
  const dom = buildPopupDom({ links: 0, dialog: false });
  const r = runViewProbe(dom, { tag: 'qc-tag-2' });
  assert.strictEqual(r.popup.safe, true, r.popup.reason);
});

test('弹窗安全判定：业务确认框（取消/确定）→ 拒绝且零打标', () => {
  const dom = buildPopupDom({ business: ['取消', '确定'] });
  const r = runViewProbe(dom, { tag: 'qc-tag-3' });
  assert.strictEqual(r.popup.present, true);
  assert.strictEqual(r.popup.safe, false);
  assert.strictEqual(r.popup.reason, 'business-label');
  assert.strictEqual(dom.closes[0].hasAttribute('data-qc-popup-close'), false);
});

test('弹窗安全判定：多关闭按钮/隐藏关闭按钮/关闭按钮无标识 → 一律拒绝', () => {
  const multi = buildPopupDom({ closes: 2 });
  assert.strictEqual(runViewProbe(multi, { tag: 't' }).popup.reason, 'close-not-unique');

  const hidden = buildPopupDom({ closeVisible: false, dialog: true });
  assert.strictEqual(runViewProbe(hidden, { tag: 't' }).popup.reason, 'close-not-visible-unique');

  const blank = buildPopupDom({ closeText: '', closeLabel: '' });
  assert.strictEqual(runViewProbe(blank, { tag: 't' }).popup.reason, 'close-aria');

  const emptyAriaWithX = buildPopupDom({ closeText: '×', closeLabel: '' });
  assert.strictEqual(runViewProbe(emptyAriaWithX, { tag: 't' }).popup.reason, 'close-aria',
    '空 aria-label 即使有 × 也不安全');

  const textOnlyWord = buildPopupDom({ closeText: '关闭', closeLabel: '' });
  assert.strictEqual(runViewProbe(textOnlyWord, { tag: 't' }).popup.reason, 'close-aria');
});

test('弹窗安全判定：危险文本/额外控件/表单内关闭/第三个业务按钮 → 一律拒绝', () => {
  const danger = buildPopupDom({ text: '确认删除这 30 条计划？删除后不可恢复' });
  assert.strictEqual(runViewProbe(danger, { tag: 't' }).popup.reason, 'danger-text');

  const input = buildPopupDom({ extra: { tag: 'input', attrs: { type: 'text' } } });
  assert.strictEqual(runViewProbe(input, { tag: 't' }).popup.reason, 'unexpected-controls');

  const inForm = buildPopupDom({ inForm: true });
  assert.strictEqual(runViewProbe(inForm, { tag: 't' }).popup.reason, 'close-inside-form');

  const three = buildPopupDom({ business: ['投放乘方', '开启货款直投', '立即投放'] });
  assert.strictEqual(runViewProbe(three, { tag: 't' }).popup.reason, 'business-count');
});

test('弹窗安全判定：外部对话框不含该关闭按钮 / 缺本次标记 → 拒绝', () => {
  const dom = buildPopupDom({ dialog: true });
  const stray = dom.body.appendChild(new PopupNode('div', { role: 'dialog' }, '另一个对话框'));
  assert.ok(stray);
  assert.strictEqual(runViewProbe(dom, { tag: 't' }).popup.reason, 'dialog-not-owning-close');

  const ok = buildPopupDom({ dialog: true });
  assert.strictEqual(runViewProbe(ok, {}).popup.reason, 'close-tag-missing', '没有本次标记不得判安全');
});

test('弹窗安全判定：缺已知根/缺 type=button/缺 oc-icon-close → 一律拒绝', () => {

  const noRoot = buildPopupDom({ rootClass: false, dialog: true });

  assert.strictEqual(runViewProbe(noRoot, { tag: 't' }).popup.reason, 'root-not-known');



  const wrongRoot = buildPopupDom({ rootClass: 'random-modal-wrap', dialog: true });

  assert.strictEqual(runViewProbe(wrongRoot, { tag: 't' }).popup.reason, 'root-not-known');



  const noType = buildPopupDom({ closeType: null, dialog: true });

  assert.strictEqual(runViewProbe(noType, { tag: 't' }).popup.reason, 'close-type');



  const noIcon = buildPopupDom({ withIcon: false, dialog: true });

  assert.strictEqual(runViewProbe(noIcon, { tag: 't' }).popup.reason, 'close-icon');

});

// ── 弹窗原子关闭：判定与点击必须在同一次页面执行内（复核阻断项）────────────

test('弹窗原子关闭：同一次执行内复核并点击唯一已证关闭按钮，点击后移除标记', () => {
  const dom = buildPopupDom({ dialog: true });
  const observed = runViewProbe(dom, { tag: 'qc-tag-click' });
  assert.strictEqual(observed.popup.safe, true, observed.popup.reason);
  assert.strictEqual(dom.closes[0].getAttribute('data-qc-popup-close'), 'qc-tag-click', '观察快照打标');

  const closed = runViewProbe(dom, { tag: 'qc-tag-click', click: true });
  assert.strictEqual(closed.popup.clicked, true, closed.popup.reason);
  assert.strictEqual(dom.closes[0].clickCount, 1, '只点击一次');
  assert.strictEqual(dom.closes[0].hasAttribute('data-qc-popup-close'), false, '点击后移除标记');
});

test('弹窗原子关闭：节点被复用改写为业务按钮（标记仍在）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-reuse' });
  // 节点被改写成业务 CTA：去掉关闭 aria/图标，标记仍在 → 不得点击。
  dom.closes[0].ownText = '确认投放';
  dom.closes[0].removeAttribute('aria-label');
  dom.closes[0].children = [];
  const r = runViewProbe(dom, { tag: 'qc-tag-reuse', click: true });
  assert.strictEqual(r.popup.safe, false);
  assert.strictEqual(r.popup.reason, 'close-aria');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0, '零点击');
});

test('弹窗原子关闭：标记在两次快照之间丢失（重渲染）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-gone' });
  dom.closes[0].removeAttribute('data-qc-popup-close');
  const r = runViewProbe(dom, { tag: 'qc-tag-gone', click: true });
  assert.strictEqual(r.popup.reason, 'close-tag-mismatch');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0);
});

test('弹窗原子关闭：点击快照内结构变危险（多出第三个业务按钮）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-drift' });
  dom.content.appendChild(new PopupNode('button', {}, '立即投放'));
  const r = runViewProbe(dom, { tag: 'qc-tag-drift', click: true });
  assert.strictEqual(r.popup.reason, 'business-count');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0);
});

// ── 弹窗安全接线：判定/点击同节点、先于店铺视图、账户视图也必须处理 ──────────

test('简尚：浮窗先于店铺视图出现 → 先关闭已证弹窗再继续（不再空等到超时）', async () => {
  const views = [
    { shopView: false, switchPresent: false, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true);
  assert.strictEqual(calls.closeClicks, 1, '浮窗在店铺视图渲染前即被关闭');
  assert.strictEqual(calls.switchClicks, 1);
  assert.strictEqual(calls.businessClicks, 0);
});

test('账户视图出现未知弹窗 → 失败，不得直接返回成功（零业务点击）', async () => {
  const views = [
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: true, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});

test('原子关闭快照复核不通过（节点已不可证）→ 零点击失败，绝不退回结构选择器点击', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true } }];
  const { page, calls } = makeAccountViewStub({ views, closeCount: 0 });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭未执行/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0, '零关闭点击');
  assert.strictEqual(calls.switchClicks, 0, '弹窗未关闭绝不切换');
  assert.strictEqual(calls.businessClicks, 0);
});

test('关闭快照发现弹窗已自行消失 → 本轮零点击，下一轮重新观察后继续', async () => {
  const views = [
    { shopView: false, switchPresent: false, popup: { present: true, safe: true, clickGone: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true);
  assert.strictEqual(calls.closeClicks, 0, '自行消失时不得再点关闭');
  assert.strictEqual(calls.switchClicks, 1);
  assert.strictEqual(calls.businessClicks, 0);
});

test('判定通过但缺本次标记 → 零点击失败（不接受“结构像”就点）', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, tagMissing: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
});

test('关闭后同一弹窗仍在 → 立即失败，不二次关闭', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: true, safe: true } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭后仍存在/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 1, '只关闭一次');
  assert.strictEqual(calls.switchClicks, 0, '弹窗未消失绝不切换');
});

test('残留已知根（关闭钮与 dialog 皆无）→ present 仍为 true，不得判消失', () => {
  const dom = buildPopupDom({ dialog: false, closes: 0 });
  const r = runViewProbe(dom, { tag: 't' });
  assert.strictEqual(r.popup.present, true, 'known-root 残留必须算仍在');
  assert.strictEqual(r.popup.safe, false);
});

test('关闭 evaluate 返回 undefined → fail-closed，不得当自行消失', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, clickUndefined: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭结果异常/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.switchClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});

test('关闭 evaluate 返回畸形（无 popup）→ fail-closed', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, clickMalformed: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭结果异常/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.switchClicks, 0);
});

test('空店名 + accountContent=true → 缺少目标店铺名，不得成功返回', async () => {
  const views = [
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /缺少目标店铺名/.test(err.message)
  );
  assert.strictEqual(calls.switchClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});
