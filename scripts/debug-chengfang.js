'use strict';

/** 调试：乘方页 evaluate 与 Shadow DOM 结构（只读）。 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const t = popup && !popup.isClosed() ? popup : page;
    await t.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await t.waitForTimeout(10000);
    try { await t.getByText('我知道了', { exact: true }).first().click({ timeout: 3000 }); } catch (_) {}
    await t.evaluate(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    }).catch(() => {});
    await t.waitForTimeout(9000);
    // 点「商品」
    await t.evaluate(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品' && el.querySelectorAll('*').length <= 4;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    }).catch(() => {});
    await t.waitForTimeout(14000);

    const test1 = await t.evaluate(() => ({ bodyTextLen: (document.body ? document.body.innerText : '').length, href: location.href.slice(0, 80) })).catch((e) => ({ error: String(e) }));
    console.log('test1 basic evaluate:', JSON.stringify(test1));

    const test2 = await t.evaluate(() => {
      const hosts = [];
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root.shadowRoot) hosts.push({ tag: root.tagName, cls: String(root.className || '').slice(0, 60) });
        for (const el of root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : []) {
          if (el.shadowRoot) hosts.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60) });
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      };
      walk(document, 0);
      return { shadowHosts: hosts.slice(0, 40), bodyTextLen: (document.body ? document.body.innerText : '').length };
    }).catch((e) => ({ error: String(e) }));
    console.log('test2 shadow hosts:', JSON.stringify(test2).slice(0, 2000));

    if (test2 && test2.shadowHosts && test2.shadowHosts.length) {
      const test3 = await t.evaluate(() => {
        const out = [];
        const walk = (root, depth) => {
          if (depth > 20) return;
          if (root.shadowRoot) {
            const st = (root.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim();
            out.push({ tag: root.tagName, cls: String(root.className || '').slice(0, 60), shadowTextLen: st.length, shadowText: st.slice(0, 400) });
            walk(root.shadowRoot, depth + 1);
          }
          for (const el of root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : []) {
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          }
        };
        walk(document, 0);
        return out.slice(0, 30);
      }).catch((e) => ({ error: String(e) }));
      console.log('test3 shadow text:', JSON.stringify(test3).slice(0, 5000));
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
