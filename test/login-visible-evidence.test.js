'use strict';

/**
 * S6 回归（2026-10-26）：collectLoginExpiryEvidence 的登录正证据必须来自
 * **真实渲染可见**的元素。静态缺陷（已核读源码 src/adapters/qianchuan-reader.js
 * collectLoginExpiryEvidence 页内探针）：旧 visible 只查自身 computed style，
 * 隐藏祖先/收起容器内的控件被误判可见；loginForm 用 document.querySelector
 * 命中即 true，隐藏的 password 输入框也算登录表单 → 已登录页面上的隐藏登录
 * 残留被误判 AuthError（false login-expiry）。
 *
 * 本文件全部离线：真实导出的 collectLoginExpiryEvidence + fake page.evaluate
 * 把**源码里的实际回调函数**放进 vm 模拟 DOM 上下文执行（无真实浏览器、无网络、
 * 无 Cookie、无外部依赖；不比对源码字符串）。运行：node --test test/login-visible-evidence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { collectLoginExpiryEvidence } = require('../src/adapters/qianchuan-reader');

const QC_HOME = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
const QC_LOGIN = 'https://qianchuan.jinritemai.com/login/common';

// ── 最小 DOM fixture（真实元素语义，非源码字符串比对）───────────────

function makeEl(spec) {
  const el = {
    tagName: String(spec.tag || 'div').toUpperCase(),
    attributes: Object.assign({}, spec.attrs || {}),
    __style: Object.assign({ display: 'block', visibility: 'visible' }, spec.style || {}),
    __rect: Object.assign({ width: 100, height: 30 }, spec.rect || {}),
    parentElement: spec.parent || null,
    childNodes: spec.children || [],
    innerText: spec.text || '',
    textContent: spec.text || '',
    value: spec.value || '',
    type: spec.attrs && spec.attrs.type ? spec.attrs.type : '',
    getAttribute(name) { const v = this.attributes[name]; return v === undefined ? null : String(v); },
    hasAttribute(name) { return this.attributes[name] !== undefined; },
    getBoundingClientRect() { return Object.assign({}, this.__rect); },
    closest(sel) {
      let node = this.parentElement;
      while (node) {
        if (matchesSimple(node, splitCompound(sel).join(''))) return node;
        node = node.parentElement;
      }
      return null;
    },
  };
  for (const c of el.childNodes) if (c && !c.parentElement) c.parentElement = el;
  return el;
}

// 极简选择器：支持 tag / [attr] / [attr="v"] / [attr*="v"]，空格 = 祖先约束。
function splitCompound(sel) {
  const out = [];
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel))) out.push(m[0]);
  return out;
}

function matchesSimple(el, sel) {
  const parts = splitCompound(sel);
  for (const p of parts) {
    if (p.startsWith('[')) {
      const am = /^\[\s*([a-zA-Z0-9_-]+)\s*(?:([*^$]?=)\s*"([^"]*)")?\s*\]$/.exec(p);
      if (!am) return false;
      const [, attr, op, want] = am;
      const have = el.attributes[attr];
      if (have === undefined) return false;
      if (op === '=') { if (String(have) !== want) return false; }
      if (op === '*=') { if (!String(have).includes(want)) return false; }
    } else if (String(el.tagName).toLowerCase() !== p.toLowerCase()) return false;
  }
  return true;
}

function matchesSelector(el, selector) {
  const segments = String(selector).trim().split(/\s+/);
  if (!matchesSimple(el, segments[segments.length - 1])) return false;
  let need = segments.slice(0, -1);
  let node = el.parentElement;
  while (need.length && node) {
    if (matchesSimple(node, need[need.length - 1])) need = need.slice(0, -1);
    node = node.parentElement;
  }
  return need.length === 0;
}

function makeDom(rootNodes) {
  const all = [];
  const walk = (n) => { all.push(n); n.childNodes.forEach(walk); };
  rootNodes.forEach(walk);
  const document = {
    querySelector: (sel) => all.find((el) => sel.split(',').some(part => matchesSelector(el, part.trim()))) || null,
    querySelectorAll: (sel) => all.filter((el) => sel.split(',').some(part => matchesSelector(el, part.trim()))),
  };
  return { document, all };
}

/**
 * fake page：page.evaluate 把**源码传入的实际回调**放进 vm 上下文执行。
 * 现有旧协议（如 login-settle.test.js 的 evaluate: async () => null）返回预建
 * 语义结果；本文件按新协议执行真实回调，二者互不影响。
 */
function makePage(url, rootNodes) {
  const { document } = makeDom(rootNodes);
  const ctx = vm.createContext({
    document,
    getComputedStyle: (el) => ({ display: el.__style.display, visibility: el.__style.visibility }),
    location: { href: url },
  });
  const emptyLocator = { count: async () => 0, isVisible: async () => false, nth() { return this; }, first() { return this; } };
  return {
    url: () => url,
    evaluate: async (fn) => vm.runInContext(`(${fn.toString()})()`, ctx),
    getByRole: () => emptyLocator,
    getByText: () => emptyLocator,
    locator: () => emptyLocator,
  };
}

// ── 用例 ──────────────────────────────────────────────────────────

test('隐藏的匹配 password 输入框不得成为登录表单正证据', async () => {
  const hiddenPwd = makeEl({ tag: 'input', attrs: { type: 'password' }, style: { display: 'none' } });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [hiddenPwd]));
  assert.strictEqual(ev.loginFormVisible, false, '隐藏 password 输入框必须被忽略');
  assert.strictEqual(ev.loginControlVisible, false);
  assert.strictEqual(ev.loginDialogVisible, false);
  assert.strictEqual(ev.loginUrl, false);
});

test('隐藏祖先内的登录按钮/登录 dialog 不得成为正证据（自身样式正常也不行）', async () => {
  const btn = makeEl({ tag: 'button', text: '扫码登录' });
  const hiddenWrap = makeEl({ tag: 'div', style: { display: 'none' }, children: [btn] });
  const dlg = makeEl({ tag: 'div', attrs: { role: 'dialog' }, text: '请先登录' });
  const collapsedDlgWrap = makeEl({ tag: 'div', style: { visibility: 'hidden' }, children: [dlg] });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [hiddenWrap, collapsedDlgWrap]));
  assert.strictEqual(ev.loginControlVisible, false, 'display:none 祖先内的按钮必须被忽略');
  assert.strictEqual(ev.loginDialogVisible, false, 'visibility:hidden 祖先内的 dialog 必须被忽略');
  assert.strictEqual(ev.loginFormVisible, false);
});

test('真实可见的 password 输入框仍被识别为登录表单', async () => {
  const pwd = makeEl({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [pwd]));
  assert.strictEqual(ev.loginFormVisible, true);
});

test('第一个匹配隐藏、后面的可见 → 仍命中（遍历全部候选）', async () => {
  const hiddenPwd = makeEl({ tag: 'input', attrs: { type: 'password' }, style: { display: 'none' } });
  const visiblePwd = makeEl({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [hiddenPwd, visiblePwd]));
  assert.strictEqual(ev.loginFormVisible, true, '不得因第一个候选隐藏而漏掉后面的可见表单');
});

test('零布局（0×0）控件不得成为正证据', async () => {
  const zeroPwd = makeEl({ tag: 'input', attrs: { type: 'password' }, rect: { width: 0, height: 0 } });
  const zeroBtn = makeEl({ tag: 'button', text: '立即登录', rect: { width: 0, height: 0 } });
  const zeroDlg = makeEl({ tag: 'div', attrs: { role: 'dialog' }, text: '手机号登录', rect: { width: 0, height: 0 } });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [zeroPwd, zeroBtn, zeroDlg]));
  assert.strictEqual(ev.loginFormVisible, false);
  assert.strictEqual(ev.loginControlVisible, false);
  assert.strictEqual(ev.loginDialogVisible, false);
});

test('真实可见的登录按钮与登录 dialog 仍被识别', async () => {
  const btn = makeEl({ tag: 'button', text: '扫码登录', rect: { width: 120, height: 40 } });
  const dlg = makeEl({ tag: 'div', attrs: { role: 'dialog' }, text: '请先登录后继续操作', rect: { width: 360, height: 240 } });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [btn, dlg]));
  assert.strictEqual(ev.loginControlVisible, true);
  assert.strictEqual(ev.loginDialogVisible, true);
});

test('真实 /login 地址仍是登录正证据（快速路径，不依赖 DOM）', async () => {
  const ev = await collectLoginExpiryEvidence(makePage(QC_LOGIN, []));
  assert.strictEqual(ev.loginUrl, true);
});

test('普通段落/帮助文本与隐藏登录组件不得造成认证失败误判', async () => {
  const helpText = makeEl({ tag: 'p', text: '遇到问题？请参考扫码登录教程' });
  const hiddenWidget = makeEl({ tag: 'div', attrs: { class: 'login-form' }, style: { display: 'none' }, children: [
    makeEl({ tag: 'input', attrs: { type: 'password' } }),
  ] });
  const ev = await collectLoginExpiryEvidence(makePage(QC_HOME, [helpText, hiddenWidget]));
  assert.strictEqual(ev.loginUrl, false);
  assert.strictEqual(ev.loginFormVisible, false, '隐藏 login-form 容器内的输入框必须被忽略');
  assert.strictEqual(ev.loginControlVisible, false, '普通段落文本不参与判定');
  assert.strictEqual(ev.loginDialogVisible, false);
});

