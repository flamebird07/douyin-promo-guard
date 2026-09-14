'use strict';

/**
 * 乘方商品自选视图只读确认（只读导航，不点任何业务按钮）：
 *  A. 默认激活 tab 与列表（行数/每行 ID/开关 checked/分页 total）；
 *  B. 点击"商品自选"tab → 列表/分页/开关对比；
 *  C. 切换"100条/页"（允许的只读页面操作）→ 等待加载 → 列表/分页对比；
 *  D. 回到"全店托管"tab → 列表对比；
 *  E. 账户与店铺关联：千川头部账户名/ID + cookie 来源店铺名。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

const dumpList = `(() => {
  const out = { url: location.href.slice(0, 160), rows: [], pagination: {}, headerCheckbox: null, batchBar: null, account: null };
  // 账户（千川头部）
  const nav = document.querySelector('.qc-page-navigator-container, [class*="navigator"]');
  if (nav) out.account = (nav.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  // 分页 total
  const total = document.querySelector('.ovui-page-total, [data-e2e*="pagination_group_total"]');
  out.pagination.totalText = total ? (total.textContent || '').replace(/\\s+/g, ' ').trim() : null;
  // 每页条数当前值
  const sel = document.querySelector('.ovui-page-select .ovui-select__input input, .ovui-page-select input');
  out.pagination.pageSize = sel ? sel.value : null;
  // 表头全选框
  const thCb = document.querySelector('th .ovui-checkbox[data-e2e="checkbox"], th .ovui-checkbox');
  if (thCb) {
    const input = thCb.querySelector('input[type="checkbox"]');
    out.headerCheckbox = { inHeader: true, checked: input ? input.checked : null, labelCls: String(thCb.className || '') };
  }
  // 批量操作栏
  const bar = document.querySelector('.batch-action-bar, .oc-promotion-batch-operation-bar');
  if (bar) {
    out.batchBar = {
      display: getComputedStyle(bar).display,
      text: (bar.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      buttons: [...bar.querySelectorAll('button, [class*="button"]')].filter((b) => {
        const t = (b.textContent || '').trim();
        return t === '开启' || t === '暂停' || t === '删除';
      }).map((b) => ({
        text: b.textContent.trim(),
        e2e: (b.closest('[data-e2e]') || b).getAttribute('data-e2e') || '',
        autoId: b.getAttribute('data-auto-id') || '',
      })),
    };
  }
  // 行
  const rows = [...document.querySelectorAll('tr.ovui-tr, tr[class*="row"]')].filter((r) => r.querySelector('[class*="switch"]') || /ID：/.test(r.textContent || ''));
  rows.forEach((r) => {
    const tx = (r.textContent || '').replace(/\\s+/g, ' ').trim();
    const idM = tx.match(/ID：\\s*(\\d{10,})/);
    const sw = r.querySelector('.ovui-switch');
    const checked = sw ? sw.className.includes('ovui-switch--checked') : null;
    const cb = r.querySelector('input[type="checkbox"]');
    const ops = [...r.querySelectorAll('.oc-promotion-operation-action-item, [class*="operation"] span')]
      .map((s) => (s.textContent || '').trim()).filter((t) => /^(编辑|日志|删除|暂停|开启)$/.test(t));
    out.rows.push({
      id: idM ? idM[1] : null,
      name: tx.slice(0, 60),
      status: (r.querySelector('.ad-status') ? (r.querySelector('.ad-status').textContent || '').replace(/\\s+/g, ' ').trim() : ''),
      switchChecked: checked,
      switchCls: sw ? String(sw.className).slice(0, 60) : null,
      checkbox: cb ? { checked: cb.checked } : null,
      ops: [...new Set(ops)],
    });
  });
  out.pagination.rowCount = out.rows.length;
  return out;
})()`;

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
        if (r.width > 0 && r.height > 0) { cur.click(); return { clicked: true, cls: cls.slice(0, 60) }; }
      }
      cur = cur.parentElement;
    }
  }
  return { clicked: false };
})()`;

async function main() {
  const meta = {
    startedAt: new Date().toISOString(),
    cookieSource: path.basename(COOKIE_PATH),
    steps: [],
  };
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
    await t.evaluate(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品' && el.querySelectorAll('*').length <= 4;
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (el) el.click();
    }).catch(() => {});
    await t.waitForTimeout(14000);
    meta.steps.push({ step: 'landing', url: t.url().slice(0, 150), title: await t.title().catch(() => '') });

    // A. 默认视图
    meta.steps.push({ step: 'default-view', data: await t.evaluate(dumpList).catch((e) => ({ error: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r8-default-${Date.now()}.png`) }).catch(() => {});

    // B. 点击"商品自选"tab
    const zx = await t.evaluate(clickSubTab('商品自选')).catch(() => ({ clicked: false }));
    await t.waitForTimeout(12000);
    meta.steps.push({ step: 'click-商品自选', click: zx, data: await t.evaluate(dumpList).catch((e) => ({ error: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r8-zixuan-${Date.now()}.png`) }).catch(() => {});

    // C. 切换 100条/页（只读页面操作）
    const opened = await t.evaluate(() => {
      const sel = document.querySelector('.ovui-page-select .ovui-select__input, .ovui-page-select, [data-e2e*="pagination_group_select"]');
      if (!sel) return { opened: false, reason: 'no select' };
      const clickable = sel.closest('.ovui-select, [class*="select"]') || sel;
      clickable.click();
      return { opened: true };
    }).catch((e) => ({ error: String(e) }));
    await t.waitForTimeout(2500);
    const picked = await t.evaluate(() => {
      const opts = [...document.querySelectorAll('.ovui-option')];
      const target = opts.find((o) => (o.textContent || '').replace(/\\s+/g, '').includes('100条/页'));
      if (!target) return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
      target.click();
      return { picked: true };
    }).catch((e) => ({ error: String(e) }));
    await t.waitForTimeout(10000);
    meta.steps.push({ step: 'switch-100-per-page', opened, picked, data: await t.evaluate(dumpList).catch((e) => ({ error: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r8-100perpage-${Date.now()}.png`) }).catch(() => {});

    // D. 回到"全店托管"tab
    const qd = await t.evaluate(clickSubTab('全店托管')).catch(() => ({ clicked: false }));
    await t.waitForTimeout(12000);
    meta.steps.push({ step: 'click-全店托管', click: qd, data: await t.evaluate(dumpList).catch((e) => ({ error: String(e) })) });
    await t.screenshot({ path: path.join(OUT_DIR, `r8-tuoguan-${Date.now()}.png`) }).catch(() => {});

    fs.writeFileSync(path.join(OUT_DIR, `r8-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
