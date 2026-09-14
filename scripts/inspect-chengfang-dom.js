'use strict';

/**
 * 乘方商品页 DOM 结构精读（只读，不点击业务元素）。
 * 目标：计划列表的复选框、批量操作栏（暂停/开启/删除）、分页控件（含100条/页）、
 *       行操作按钮、托管总开关的 DOM 结构证据。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

async function main() {
  const meta = { startedAt: new Date().toISOString(), steps: [] };
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
    try { await t.getByText('先不提醒', { exact: true }).first().click({ timeout: 2000 }); } catch (_) {}

    await t.evaluate(() => {
      const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
      if (el) el.click();
    }).catch(() => {});
    await t.waitForTimeout(9000);
    await t.evaluate(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品' && el.querySelectorAll('*').length <= 4;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    }).catch(() => {});
    await t.waitForTimeout(14000);

    // 1) 复选框相关 DOM
    const checkboxes = await t.evaluate(() => {
      const out = [];
      const seen = new Set();
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const cls = String(el.className || '');
          const isCb = (el.tagName === 'INPUT' && el.type === 'checkbox') || /checkbox/i.test(cls);
          if (!isCb) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const key = cls.slice(0, 40);
          if (seen.has(key)) continue;
          seen.add(key);
          const outer = el.outerHTML ? el.outerHTML.replace(/\s+/g, ' ').slice(0, 300) : '';
          out.push({
            tag: el.tagName, cls: cls.slice(0, 80), checked: el.checked === true, inputType: el.type || null,
            title: (el.getAttribute('title') || '').slice(0, 40),
            ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 40),
            parentCls: String((el.closest && el.closest('[class]') || {}).className || el.parentElement && el.parentElement.className || '').slice(0, 80),
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            outer: outer.slice(0, 200),
          });
        }
      };
      walk(document, 0);
      return out;
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'checkboxes', data: checkboxes });

    // 2) 分页区 / 每页条数 DOM
    const pagers = await t.evaluate(() => {
      const out = [];
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const cls = String(el.className || '');
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/page|pager|turner|pagination/i.test(cls)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (txt.length > 120) continue;
          const outer = el.outerHTML ? el.outerHTML.replace(/\s+/g, ' ').slice(0, 500) : '';
          out.push({ cls: cls.slice(0, 80), text: txt.slice(0, 100), outer: outer.slice(0, 380), rect: { w: Math.round(rect.width), h: Math.round(rect.height) } });
        }
      };
      walk(document, 0);
      return out.slice(0, 30);
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'pagers', data: pagers });

    // 3) 行操作按钮（编辑/日志/删除…）与工具栏按钮
    const actionBtns = await t.evaluate(() => {
      const out = [];
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const cls = String(el.className || '');
          if (!/button|btn|action|operation|table-cell|toolbar|header/i.test(cls)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
          const txt = own || (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 40) continue;
          if (!/编辑|日志|删除|暂停|开启|恢复|批量|全选|新建|投放|导出|更多|查看|诊断|去设置|了解详情|我知道了|先不提醒|启用/.test(txt)) continue;
          out.push({ tag: el.tagName, cls: cls.slice(0, 70), text: txt.slice(0, 30), outer: (el.outerHTML ? el.outerHTML.replace(/\s+/g, ' ').slice(0, 220) : '') });
        }
      };
      walk(document, 0);
      return out.slice(0, 60);
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'action-buttons', data: actionBtns });

    // 4) 表格区外层结构（找总条数/计划列表容器）
    const tableInfo = await t.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      const totalM = /共\s*(\d+)\s*条记录|共(\d+)条计划/.exec(txt);
      return { totalText: totalM ? totalM[0] : null, planCount: totalM ? totalM[1] : null, has100PerPage: /100\s*条\s*\/\s*页|100条\/页/.test(txt), pageSizeText: (txt.match(/[\d]+\s*条\/页/g) || []) };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'table-info', data: tableInfo });

    await t.screenshot({ path: path.join(OUT_DIR, `r7d-table-${Date.now()}.png`), fullPage: false }).catch(() => {});

    fs.writeFileSync(path.join(OUT_DIR, `r7d-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2).slice(0, 16000));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
