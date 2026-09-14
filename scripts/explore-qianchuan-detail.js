'use strict';

/**
 * 千川第二层探查（只读）：
 * 1. 首页 summaryCard（账户整体消耗）的日期口径与数值节点结构；
 * 2. 账户身份元素（ID/名称）与店铺绑定线索、切换器（多账户检测）；
 * 3. "更新于"时间戳的归属位置；
 * 4. "全域投放"广告列表：表头/行结构/计划ID/状态词/开关/分页。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  const meta = { startedAt: new Date().toISOString(), steps: [] };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();
    await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const t = popup && !popup.isClosed() ? popup : page;
    await t.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await t.waitForTimeout(9000);
    meta.steps.push({ step: 'qianchuan-home', url: t.url() });

    // 1) summaryCard 区域结构与日期线索
    meta.summary = await t.evaluate(() => {
      const out = { cards: [], dateRangeTexts: [], updateMarks: [] };
      for (const el of document.querySelectorAll('[class*="summaryCard"]')) {
        out.cards.push({
          cls: String(el.className || '').slice(0, 60),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w || r.width), h: Math.round(r.height) }; })(),
        });
      }
      // 页面顶部区域（y<250）的日期/时间相关文本
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        const r = el.getBoundingClientRect();
        if (!own || r.width === 0 || r.y > 260) continue;
        if (/更新于|数据更新/.test(own)) out.updateMarks.push({ text: own.slice(0, 60), cls: String(el.className || '').slice(0, 70), y: Math.round(r.y) });
        if (/\d{4}-\d{2}-\d{2}/.test(own) || /^今日$/.test(own) || /今日\s*\d/.test(own)) out.dateRangeTexts.push({ text: own.slice(0, 60), cls: String(el.className || '').slice(0, 70), y: Math.round(r.y) });
      }
      out.updateMarks = out.updateMarks.slice(0, 6);
      out.dateRangeTexts = out.dateRangeTexts.slice(0, 10);
      return out;
    }).catch(() => null);

    // 2) 账户身份元素与切换器
    meta.account = await t.evaluate(() => {
      const out = { idTexts: [], shopNameHits: [], switcherCandidates: [] };
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        const r = el.getBoundingClientRect();
        if (!own || r.width === 0) continue;
        if (/ID[：:]\s*\d+/.test(own) && own.length <= 50) {
          out.idTexts.push({ text: own.slice(0, 50), cls: String(el.className || '').slice(0, 70), y: Math.round(r.y) });
        }
        if (own.includes('瑾漂亮潮流服饰')) out.shopNameHits.push({ text: own.slice(0, 60), y: Math.round(r.y) });
        if ((own.includes('切换') || own.includes('账户')) && own.length <= 30 && r.y < 120) out.switcherCandidates.push({ text: own, cls: String(el.className || '').slice(0, 70), y: Math.round(r.y) });
      }
      out.idTexts = out.idTexts.slice(0, 5);
      out.shopNameHits = out.shopNameHits.slice(0, 5);
      out.switcherCandidates = out.switcherCandidates.slice(0, 8);
      return out;
    }).catch(() => null);
    await t.screenshot({ path: path.join(OUT_DIR, `qc-home-${Date.now()}.png`) }).catch(() => {});

    // 3) 进入"全域投放"广告列表
    const navPopup = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    let list = null;
    try {
      await t.getByText('全域投放', { exact: false }).first().click({ timeout: 10000 });
      const np = await navPopup;
      await t.waitForTimeout(2000);
      const lt = np && !np.isClosed() ? np : t;
      await lt.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
      await lt.waitForTimeout(9000);
      meta.steps.push({ step: '全域投放', url: lt.url() });
      // 列表结构证据
      list = await lt.evaluate(() => {
        const out = { url: location.href, headers: [], statusWords: [], idLike: [], switches: [], pager: null };
        // 表头
        for (const el of document.querySelectorAll('th, [class*="header"] [class*="cell"], [class*="thead"] *')) {
          const own = (el.textContent || '').trim();
          if (own && own.length <= 12 && !out.headers.includes(own)) out.headers.push(own);
        }
        out.headers = out.headers.slice(0, 25);
        // 状态词与 ID 类文本（前几行区域）
        const body = document.body.innerText;
        const statusRe = /(投放中|已暂停|已结束|审核中|已下线|未投放|投放完成|预算不足|已拒绝|暂停中)/g;
        out.statusWords = [...new Set(body.match(statusRe) || [])].slice(0, 12);
        const idRe = /\b\d{12,20}\b/g;
        out.idLike = [...new Set(body.match(idRe) || [])].slice(0, 10);
        // 开关组件
        out.switches = document.querySelectorAll('[class*="switch"], [role="switch"]').length;
        // 分页
        const pagerEl = document.querySelector('[class*="pagination"], [class*="pager"]');
        out.pager = pagerEl ? (pagerEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null;
        return out;
      }).catch(() => null);
      if (lt !== t) {
        await lt.screenshot({ path: path.join(OUT_DIR, `qc-ads-${Date.now()}.png`) }).catch(() => {});
      } else {
        await t.screenshot({ path: path.join(OUT_DIR, `qc-ads-${Date.now()}.png`) }).catch(() => {});
      }
    } catch (e) {
      meta.steps.push({ step: '全域投放-failed', error: String(e.message).slice(0, 150) });
    }
    meta.adList = list;

    fs.writeFileSync(path.join(OUT_DIR, `qc-detail-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
