'use strict';

/**
 * 乘方控制页只读核实 v3（修正 evaluate 作用域问题，第七轮）。
 *
 * 关键修正：page.evaluate 内不得引用 Node 侧函数（上一版因此全部静默失败）。
 * 本轮：
 *  A. 主文档 body 文本全量 dump（含命中关键词上下文）；
 *  B. 全部 frame 文本 dump（列表可能在 iframe）；
 *  C. 递归穿透 Shadow DOM（修复 ShadowRoot.shadowRoot 恒为 undefined 的漏收集 bug）；
 *  D. 点击「商品」→ 观察「商品自选 / 全店托管」两个子标签（只读导航）；
 *  E. 定位：全选框、批量操作按钮（暂停/开启/删除 文案）、每页条数（100条/页）、
 *     总条数、分页控件、托管总开关；不做任何业务点击；
 *  F. 截图 + 脱敏证据 JSON。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

const pageSnap = `(kwList) => {
  const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
  const out = {
    url: location.href.slice(0, 180),
    title: document.title || '',
    bodyTextLen: (document.body ? document.body.innerText : '').length,
    bodyText: (document.body ? document.body.innerText : '').slice(0, 20000),
    hits: {},
    buttons: [], switches: [], checkboxes: [], pagers: [], rows: [], shadowHosts: [],
  };
  const bodyText = document.body ? document.body.innerText : '';
  for (const kw of kwList) {
    const i = bodyText.indexOf(kw);
    if (i >= 0) out.hits[kw] = clean(bodyText.slice(Math.max(0, i - 50), i + 110));
  }
  const note = (el) => {
    const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
    return {
      tag: el.tagName, cls: String(el.className || '').slice(0, 70),
      text: clean(own || el.innerText || '').slice(0, 40),
      aria: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
      role: el.getAttribute ? (el.getAttribute('role') || '') : '',
      checked: el.checked === true || String(el.className || '').includes('checked'),
    };
  };
  const isBtn = (el) => /button/i.test(el.tagName) || (el.getAttribute && (el.getAttribute('role') === 'button' || /button/.test(String(el.className || ''))));
  const isSw = (el) => el.getAttribute && (el.getAttribute('role') === 'switch' || /switch|toggle/i.test(String(el.className || '')));
  const isChk = (el) => (el.tagName === 'INPUT' && el.type === 'checkbox') || /checkbox/i.test(String(el.className || ''));
  const isPage = (el) => /page|pager|turner|pagination/i.test(String(el.className || '')) || /条\\/页|每页/.test(clean(el.textContent || ''));
  const isRow = (el) => /row|tr|item/i.test(String(el.className || '')) && clean(el.textContent || '').length > 6;
  const seen = new Set();
  const walk = (root, depth) => {
    if (depth > 25) return;
    if (root && root.shadowRoot) {
      out.shadowHosts.push({ tag: root.tagName, cls: String(root.className || '').slice(0, 50) });
      walk(root.shadowRoot, depth + 1);
    }
    const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    for (const el of nodes) {
      const key = el.__e2eKey || (el.__e2eKey = Math.random().toString(36).slice(2));
      if (seen.has(key)) continue;
      seen.add(key);
      if (el.children && el.children.length === 0) {
        if (isBtn(el)) out.buttons.push(note(el));
        if (isSw(el)) out.switches.push(note(el));
        if (isChk(el)) out.checkboxes.push(note(el));
        if (isPage(el)) out.pagers.push(note(el));
      } else if (isRow(el)) {
        out.rows.push(note(el));
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  out.buttons = out.buttons.slice(0, 150);
  out.switches = out.switches.slice(0, 60);
  out.checkboxes = out.checkboxes.slice(0, 80);
  out.pagers = out.pagers.slice(0, 60);
  out.rows = out.rows.slice(0, 200);
  out.shadowHosts = out.shadowHosts.slice(0, 50);
  return out;
}`;

const KEYWORDS = ['全店托管', '商品自选', '暂停', '开启', '删除', '100条', '全选', '条/页', '每页', '计划', '共', '启用'];

async function frameDump(page) {
  const out = [];
  for (const f of page.frames()) {
    try {
      const data = await f.evaluate(`(() => {
        const clean = (t) => String(t || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
        const txt = document.body ? document.body.innerText : '';
        const hits = {};
        for (const kw of ['全店托管','商品自选','暂停','开启','删除','100条','全选','条/页','共','启用']) {
          const i = txt.indexOf(kw);
          if (i >= 0) hits[kw] = clean(txt.slice(Math.max(0, i - 40), i + 100));
        }
        return { url: location.href.slice(0, 160), title: document.title || '', textLen: txt.length, text: txt.slice(0, 8000), hits };
      })()`).catch(() => null);
      if (data) out.push(data);
    } catch (_) {}
  }
  return out;
}

async function main() {
  const meta = { startedAt: new Date().toISOString(), steps: [] };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    if (!page.url().includes('fxg.jinritemai.com/ffa/mshop/homepage')) throw new Error(`登录失效：${page.url()}`);
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const t = popup && !popup.isClosed() ? popup : page;
    await t.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await t.waitForTimeout(10000);
    if (!t.url().includes('qianchuan.jinritemai.com')) throw new Error(`未到达千川（${t.url().slice(0, 120)}）`);

    try { await t.getByText('我知道了', { exact: true }).first().click({ timeout: 3000 }); } catch (_) {}
    try { await t.getByText('先不提醒', { exact: true }).first().click({ timeout: 2000 }); } catch (_) {}

    const acct = await t.evaluate(`(() => {
      const out = { accountId: null, accountName: null };
      const nameEl = document.querySelector('[class*="shop-name"]');
      if (nameEl) {
        const tx = (nameEl.textContent || '').trim();
        const m = /ID[:：]\\s*(\\d{8,20})/.exec(tx);
        if (m) out.accountId = m[1]; else if (tx && !/^ID/.test(tx)) out.accountName = tx;
      }
      if (!out.accountId) {
        const m = /ID[:：]\\s*(\\d{8,20})/.exec(document.body ? document.body.innerText : '');
        if (m) out.accountId = m[1];
      }
      return out;
    })()`).catch(() => null);
    meta.account = acct;
    meta.steps.push({ step: 'qianchuan-home', url: t.url().slice(0, 140) });

    // 进入乘方
    await t.evaluate(`(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    })()`).catch(() => {});
    await t.waitForTimeout(9000);
    await t.waitForFunction(`() => /overall/.test(location.href)`, { timeout: 15000 }).catch(() => {});
    await t.waitForTimeout(3000);
    meta.steps.push({ step: 'chengfang-landing', url: t.url().slice(0, 160), title: await t.title().catch(() => '') });
    await t.screenshot({ path: path.join(OUT_DIR, `r7c-landing-${Date.now()}.png`), fullPage: false }).catch(() => {});

    // 点「商品」标签（纯导航）
    await t.evaluate(`(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品' && el.querySelectorAll('*').length <= 4;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    })()`).catch(() => {});
    await t.waitForTimeout(14000);
    meta.steps.push({ step: 'tab-商品', url: t.url().slice(0, 160) });
    meta.steps.push({ step: 'snap-商品自选', snap: await t.evaluate(pageSnap, KEYWORDS).catch((e) => ({ evaluateError: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r7c-zixuan-${Date.now()}.png`), fullPage: false }).catch(() => {});
    meta.steps.push({ step: 'frames-商品自选', frames: await frameDump(t) });

    // 点「全店托管」子标签（只读导航，观察总开关）
    await t.evaluate(`(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '全店托管' && el.querySelectorAll('*').length <= 8;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    })()`).catch(() => {});
    await t.waitForTimeout(14000);
    meta.steps.push({ step: 'tab-全店托管', url: t.url().slice(0, 160) });
    meta.steps.push({ step: 'snap-全店托管', snap: await t.evaluate(pageSnap, KEYWORDS).catch((e) => ({ evaluateError: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r7c-tuoguan-${Date.now()}.png`), fullPage: false }).catch(() => {});
    meta.steps.push({ step: 'frames-全店托管', frames: await frameDump(t) });

    // 回到「商品自选」
    await t.evaluate(`(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品自选' && el.querySelectorAll('*').length <= 8;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    })()`).catch(() => {});
    await t.waitForTimeout(14000);
    meta.steps.push({ step: 'back-商品自选' });
    meta.steps.push({ step: 'snap-back-商品自选', snap: await t.evaluate(pageSnap, KEYWORDS).catch((e) => ({ evaluateError: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r7c-back-zixuan-${Date.now()}.png`), fullPage: false }).catch(() => {});

    fs.writeFileSync(path.join(OUT_DIR, `r7c-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2).slice(0, 20000));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
