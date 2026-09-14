'use strict';

/**
 * 乘方商品页：精确定位「商品自选/全店托管」标签并验证视图切换（只读导航），
 * 同时抓取批量操作栏（开启/暂停/删除）完整 DOM 结构。
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

    // 1) 定位含「商品自选 / 全店托管」文本的元素及其祖先链
    const tabInfo = await t.evaluate(() => {
      const dump = (label) => {
        const els = [...document.querySelectorAll('body *')].filter((el) => {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
          return own === label && el.getBoundingClientRect().width > 0;
        });
        return els.slice(0, 6).map((el) => {
          const chain = [];
          let cur = el;
          for (let i = 0; i < 5 && cur; i++) {
            chain.push(String(cur.tagName) + '.' + String(cur.className || '').split(' ').slice(0, 4).join('.'));
            cur = cur.parentElement;
          }
          return { tag: el.tagName, cls: String(el.className || '').slice(0, 80), chain, outer: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 200) };
        });
      };
      return { zixuan: dump('商品自选'), tuoguan: dump('全店托管') };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'tab-element-candidates', data: tabInfo });

    // 2) 用祖先链找到真正的 tab（含 tab 类名或 role=tab 的祖先），点击它
    const clickTab = await t.evaluate((label) => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === label && el.getBoundingClientRect().width > 0;
      });
      for (const el of els) {
        let cur = el;
        for (let i = 0; i < 6 && cur; i++) {
          const cls = String(cur.className || '');
          const role = cur.getAttribute && cur.getAttribute('role');
          if (/tab|Tab|tabs|Tabs|item|Item/.test(cls) || role === 'tab') {
            const r = cur.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              cur.click();
              return { clicked: true, targetTag: cur.tagName, targetCls: cls.slice(0, 80), via: 'ancestor-tab' };
            }
          }
          cur = cur.parentElement;
        }
      }
      return { clicked: false, reason: '未找到 tab 祖先' };
    }, '全店托管').catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'click-tab-全店托管-via-ancestor', data: clickTab });
    await t.waitForTimeout(12000);

    // 3) 验证视图是否变化：对比关键文本与总开关/开关类元素
    const after = await t.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const switches = [];
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const cls = String(el.className || '');
          if (/switch|toggle/i.test(cls) || (el.getAttribute && el.getAttribute('role') === 'switch')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0) {
              switches.push({
                cls: cls.slice(0, 70), checked: String(cls).includes('checked') || (el.getAttribute && el.getAttribute('aria-checked')) === 'true',
                parentCls: String((el.parentElement || {}).className || '').slice(0, 60),
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                outer: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 260),
              });
            }
          }
        }
      };
      walk(document, 0);
      return {
        url: location.href.slice(0, 140),
        hasQdtgTabText: body.includes('全店托管'),
        hasZxTabText: body.includes('商品自选'),
        hasEnableCard: body.includes('启用全店托管'),
        hasPaused: body.includes('已暂停'),
        hasEdit: body.includes('编辑'),
        hasDelete: body.includes('删除'),
        bodyLen: body.length,
        switches: switches.slice(0, 20),
      };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'after-click-全店托管', data: after });
    await t.screenshot({ path: path.join(OUT_DIR, `r7e-tuoguan-${Date.now()}.png`), fullPage: false }).catch(() => {});

    // 4) 批量操作栏完整 outerHTML（含 开启/暂停/删除 按钮结构）
    const batchBar = await t.evaluate(() => {
      const el = document.querySelector('.batch-action-bar') || document.querySelector('[class*="batch-action-bar"]');
      if (!el) return { found: false, hint: '未找到 batch-action-bar' };
      return {
        found: true,
        display: getComputedStyle(el).display,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        html: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 3000),
      };
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'batch-action-bar', data: batchBar });

    // 5) 行操作区（编辑/日志/删除）outerHTML
    const rowActions = await t.evaluate(() => {
      const out = [];
      const walk = (root, depth) => {
        if (depth > 20) return;
        if (root && root.shadowRoot) walk(root.shadowRoot, depth + 1);
        const nodes = root && root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!/^(编辑|日志|删除)$/.test(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 70), text: txt, outer: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300) });
        }
      };
      walk(document, 0);
      return out.slice(0, 20);
    }).catch((e) => ({ error: String(e) }));
    meta.steps.push({ step: 'row-actions', data: rowActions });

    fs.writeFileSync(path.join(OUT_DIR, `r7e-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2).slice(0, 18000));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
