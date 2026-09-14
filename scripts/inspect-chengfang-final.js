'use strict';

/**
 * 乘方商品页最后一轮只读精查：
 *  A. 计划行完整 DOM（列结构、开关位置与所在列、行 ID 载体）；
 *  B. 悬停开关上的 popover 内容（只读悬停，不点击）；
 *  C. 打开每页条数下拉（只读查看选项，含 100条/页？）；
 *  D. 表头全选框结构；
 *  E. 全店托管 / 商品自选 两视图下开关数量对比。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

async function openQianchuanChengfangShop() {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
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
  await t.evaluate(() => {
    const els = [...document.querySelectorAll('body *')].filter((el) => {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
      return own === '商品' && el.querySelectorAll('*').length <= 4;
    });
    const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (el) el.click();
  }).catch(() => {});
  await t.waitForTimeout(14000);
  return { browser, context, page, t };
}

const clickSubTab = (label) => `(() => {
  const els = [...document.querySelectorAll('body *')].filter((el) => {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
    return own === '${label}' && el.getBoundingClientRect().width > 0;
  });
  for (const el of els) {
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const cls = String(cur.className || '');
      const role = cur.getAttribute && cur.getAttribute('role');
      if (/tab|Tab|tabs|Tabs/.test(cls) || role === 'tab') {
        const r = cur.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { cur.click(); return true; }
      }
      cur = cur.parentElement;
    }
  }
  return false;
})()`;

async function dumpSwitches(t, label) {
  return t.evaluate((lb) => {
    const out = [];
    const walk = (root, depth) => {
      if (depth > 20) return;
      if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
      const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
      for (const el of nodes) {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        const cls = String(el.className || '');
        if (!/ovui-switch|oc-switch/.test(cls)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const row = el.closest('tr, [class*="row"]');
        const rowText = row ? (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150) : '';
        out.push({
          cls: cls.slice(0, 60),
          checked: cls.includes('ovui-switch--checked'),
          dataE2e: el.getAttribute('data-e2e') || '',
          parentCls: String((el.parentElement || {}).className || '').slice(0, 60),
          grandCls: String((el.parentElement && el.parentElement.parentElement || {}).className || '').slice(0, 60),
          rowText: rowText.slice(0, 120),
        });
      }
    };
    walk(document, 0);
    return { label: lb, count: out.length, items: out.slice(0, 12) };
  }, label).catch((e) => ({ error: String(e) }));
}

async function main() {
  const meta = { startedAt: new Date().toISOString(), steps: [] };
  const { browser, t } = await openQianchuanChengfangShop();
  try {
    // 当前视图（默认商品自选）开关 dump
    meta.steps.push({ step: 'switches-商品自选视图', data: await dumpSwitches(t, 'zixuan') });

    // 打开每页条数下拉（只读查看选项）
    const pageSizeOpts = await t.evaluate(() => {
      const sel = document.querySelector('[class*="page-select"] .ovui-input, .ovui-page-select .ovui-input, [data-e2e*="pagination_group_select"] input');
      if (!sel) return { found: false };
      const clickable = sel.closest('.ovui-select, .ovui-page-select, [class*="select"]');
      if (clickable) clickable.click();
      return { found: true, opened: true };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'open-pagesize-select', data: pageSizeOpts });
    await t.waitForTimeout(2500);
    const pageSizeOptions = await t.evaluate(() => {
      const out = [];
      const walk = (root, depth) => {
        if (depth > 15) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const cls = String(el.className || '');
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (/option|item|dropdown|select/i.test(cls) && /条\/页|^\d+$/.test(txt)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0) out.push({ cls: cls.slice(0, 60), text: txt.slice(0, 30) });
          }
        }
      };
      walk(document, 0);
      return out.slice(0, 20);
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'pagesize-options', data: pageSizeOptions });
    // 关闭下拉（按 Esc，纯 UI）
    await t.keyboard.press('Escape').catch(() => {});
    await t.waitForTimeout(1000);

    // 行结构：找到含 ID 的行，dump 其列
    const rowStructure = await t.evaluate(() => {
      const out = [];
      const idEl = [...document.querySelectorAll('body *')].find((el) => /ID：1843885552532505/.test(el.textContent || '') && el.children.length === 0);
      if (idEl) {
        let row = idEl;
        for (let i = 0; i < 8 && row; i++) {
          if (/tr|row/i.test(String(row.tagName + ' ' + (row.className || '')))) break;
          row = row.parentElement;
        }
        if (row) {
          const cells = [...row.querySelectorAll('td, [class*="cell"], [class*="col"]')];
          out.push({
            rowTag: row.tagName, rowCls: String(row.className || '').slice(0, 80),
            cellCount: cells.length,
            cells: cells.slice(0, 12).map((c) => ({
              cls: String(c.className || '').slice(0, 60),
              text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
              hasSwitch: !!c.querySelector('[class*="switch"]'),
            })),
          });
        }
      }
      return out;
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'row-structure', data: rowStructure });

    // 悬停开关 → popover 内容（只读）
    const hoverInfo = await t.evaluate(() => {
      const sw = document.querySelector('.switch-wrap, [class*="switch-wrap"]');
      if (!sw) return { found: false };
      sw.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      sw.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return { found: true, cls: String(sw.className || '') };
    }).catch((e) => ({ error: String(e) }));
    await t.waitForTimeout(2000);
    const popoverText = await t.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const pop = document.querySelector('[class*="popover"], [class*="popup"], [class*="dropdown"]');
      if (!pop) return { found: false };
      const r = pop.getBoundingClientRect();
      return { found: true, visible: r.width > 0 && r.height > 0, text: (pop.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200), cls: String(pop.className || '').slice(0, 60) };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'hover-switch', data: hoverInfo, popover: popoverText });

    // 切到全店托管子标签，再看开关
    const clicked = await t.evaluate(clickSubTab('全店托管')).catch(() => false);
    await t.waitForTimeout(12000);
    meta.steps.push({ step: 'switch-tab-全店托管', clicked });
    meta.steps.push({ step: 'switches-全店托管视图', data: await dumpSwitches(t, 'tuoguan') });

    // 表头全选框结构
    const headerCheckbox = await t.evaluate(() => {
      const cb = document.querySelector('.oc-checkbox .ovui-checkbox__input, [data-e2e="checkbox"]');
      return {
        found: !!cb,
        outer: cb ? (cb.outerHTML || '').slice(0, 160) : null,
        labelCls: cb && cb.closest('label') ? String(cb.closest('label').className || '').slice(0, 60) : null,
        headerCls: cb && cb.closest('th, [class*="header"]') ? String((cb.closest('th, [class*="header"]') || {}).className || '').slice(0, 60) : null,
      };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'header-checkbox', data: headerCheckbox });

    await t.screenshot({ path: path.join(OUT_DIR, `r7f-final-${Date.now()}.png`), fullPage: false }).catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, `r7f-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2).slice(0, 18000));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
