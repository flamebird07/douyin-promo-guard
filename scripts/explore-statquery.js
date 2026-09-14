'use strict';

/** 捕获千川首页 statQuery 分项与小时级消耗分布（只读），用于区分"延迟记账 vs 当前在投"。 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');

async function main() {
  const b = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
  await ctx.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
  const out = [];
  ctx.on('response', async (res) => {
    try {
      const u = res.url();
      if (!/statQuery/.test(u)) return;
      const body = await res.text().catch(() => '');
      if (!body || body.length < 100) return;
      const j = JSON.parse(body);
      const rows = (j && j.data && j.data.StatsData && j.data.StatsData.Rows) || [];
      const parsed = rows.map((r) => ({
        dim: Object.fromEntries(Object.entries(r.Dimensions || {}).map(([k, v]) => [k, v.ValueStr !== undefined ? v.ValueStr : v.Value])),
        metrics: Object.fromEntries(Object.entries(r.Metrics || {}).filter(([k]) => /cost|order/i.test(k)).map(([k, v]) => [k, v.ValueStr !== undefined ? v.ValueStr : v.Value])),
      }));
      out.push({ url: u.slice(0, 110), reqFrom: (/reqFrom=([^&]+)/.exec(u) || [])[1], rowCount: rows.length, rows: parsed.slice(0, 26) });
    } catch (_) {}
  });
  const page = await ctx.newPage();
  await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const pop = ctx.waitForEvent('page', { timeout: 25000 }).catch(() => null);
  await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 15000 });
  const p2 = await pop;
  await page.waitForTimeout(2000);
  const t = p2 && !p2.isClosed() ? p2 : page;
  await t.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await t.waitForTimeout(12000);
  const file = path.join(OUT_DIR, `r6-statquery-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  // 摘要打印
  for (const o of out) {
    console.log('---', o.reqFrom || o.url, 'rows=' + o.rowCount);
    for (const r of o.rows.slice(0, 26)) {
      console.log('   ', JSON.stringify(r.dim), JSON.stringify(r.metrics));
    }
  }
  await b.close().catch(() => {});
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
