'use strict';

/**
 * 只读核实"乘方"控制页面（第九轮，2026-09-13）。
 *
 * 允许的操作：进入乘方管理页、切换子标签（商品自选/全店托管）、切换每页条数（100条/页）、
 * 读取行/开关/分页/批量操作栏/表头全选框。保存脱敏证据（evidence/）。
 * 禁止：点击表头全选框、批量开启/暂停/删除、托管开关。
 *
 * 用法：node scripts/verify-chengfang-readonly.js
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { openChengfangShop, collectChengfangRowsInPage, collectChengfangPaginationInPage, readChengfangAccountInPage, readChengfangBatchBarInPage, clickChengfangSubTab, openChengfangPageSizeSelectInPage } = require('../src/adapters/chengfang-reader');

const PROJECT_ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'evidence');

function sanitizeText(t, max = 60) {
  return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max);
}

async function main() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  if (!shopCfg) throw new Error('未找到启用的店铺配置');

  const evidence = { startedAt: new Date().toISOString(), cookieSource: `${shopCfg.cookieFile}.json（电商助手只读）`, steps: [] };
  const push = (step, data) => evidence.steps.push({ step, ...data });

  const { browser, target } = await openChengfangShop({ loginCfg, shopCfg });
  try {
    const account = await target.evaluate(readChengfangAccountInPage);
    // 脱敏：账户ID属于敏感凭证的一部分，仅保留末4位；账户名保留
    evidence.account = {
      url: account.url,
      accountName: account.accountName,
      accountIdMasked: account.accountId ? `****${account.accountId.slice(-4)}` : null,
      hasChengfangNav: account.hasChengfangNav,
      hasSubTabs: account.hasSubTabs,
      navText: sanitizeText(account.navText, 120),
    };
    push('landing', { url: account.url.slice(0, 160), title: await target.title().catch(() => null) });

    const snap = async (label) => {
      const rows = await target.evaluate(collectChengfangRowsInPage);
      const pagination = await target.evaluate(collectChengfangPaginationInPage);
      const bar = await target.evaluate(readChengfangBatchBarInPage);
      const out = { rows: [], pagination: { totalText: pagination.totalText, pageSize: pagination.pageSize, activePage: pagination.activePage, hasNext: pagination.hasNext }, batchBar: { visible: bar.visible, selectedText: sanitizeText(bar.selectedText, 40), buttons: bar.buttons.map((b) => ({ text: b.text, autoId: b.autoId, e2e: b.e2e })) } };
      for (const r of rows.rows) {
        out.rows.push({
          idMasked: r.id ? `****${r.id.slice(-4)}` : null,
          idError: r.idError || null,
          name: sanitizeText(r.name, 70),
          status: sanitizeText(r.status, 40),
          switchChecked: r.switchChecked,
          switchCls: sanitizeText(r.switchCls, 60),
          ops: r.ops,
        });
      }
      out.pagination.rowCount = rows.rows.length;
      const headerCheckbox = await target.evaluate(() => {
        const label = document.querySelector('th .ovui-checkbox[data-e2e="checkbox"], th label.ovui-checkbox, th .ovui-checkbox');
        if (!label) return null;
        const input = label.querySelector('input[type="checkbox"]');
        return { inHeader: true, checked: input ? input.checked : null, disabled: input ? input.disabled : null };
      }).catch(() => null);
      out.headerCheckbox = headerCheckbox;
      push(label, out);
      return out;
    };

    // 全店托管（默认视图）
    await target.waitForTimeout(3000);
    const tuoguan = await snap('view-全店托管');

    // 商品自选
    const tabClick = await target.evaluate(clickChengfangSubTab('商品自选')).catch((e) => ({ error: String(e) }));
    push('click-商品自选', { click: tabClick });
    await target.waitForTimeout(6000);
    const zixuan10 = await snap('view-商品自选');

    // 切换 100条/页（允许的只读 UI 操作）
    const opened = await target.evaluate(openChengfangPageSizeSelectInPage).catch((e) => ({ error: String(e) }));
    push('open-page-size', { opened });
    await target.waitForTimeout(1200);
    const picked = await target.evaluate((s) => {
      const opts = [...document.querySelectorAll('.ovui-option')];
      const t = opts.find((o) => (o.textContent || '').replace(/\s+/g, '').includes(s));
      if (!t) return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
      t.click();
      return { picked: true };
    }, '100条/页').catch((e) => ({ error: String(e) }));
    push('pick-100-per-page', { picked });
    await target.waitForTimeout(8000);
    const zixuan100 = await snap('view-商品自选-100条/页');

    // 回全店托管确认未受影响
    const backClick = await target.evaluate(clickChengfangSubTab('全店托管')).catch((e) => ({ error: String(e) }));
    push('click-全店托管-back', { click: backClick });
    await target.waitForTimeout(6000);
    const tuoguan2 = await snap('view-全店托管-回读');

    // 截图证据
    if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const ts = Date.now();
    const png = path.join(EVIDENCE_DIR, `r9-chengfang-${ts}.png`);
    await target.screenshot({ path: png, timeout: 10000 }).catch(() => {});
    evidence.screenshots = [png];

    // 汇总
    evidence.summary = {
      accountOk: evidence.account.accountIdMasked ? true : false,
      tuoguanRows: tuoguan.rows.length,
      tuoguanSwitchOpen: tuoguan.rows.filter((r) => r.switchChecked === true).map((r) => r.idMasked),
      zixuanTotal: (zixuan100.pagination.totalText || '').match(/\d+/)?.[0] || null,
      zixuanRowsOn100: zixuan100.rows.length,
      zixuanSwitchOpenCount: zixuan100.rows.filter((r) => r.switchChecked === true).length,
      batchBarPausePresent: zixuan100.batchBar.buttons.some((b) => b.text === '暂停'),
      batchBarDeletePresent: zixuan100.batchBar.buttons.some((b) => b.text === '删除'),
      batchBarOpenPresent: zixuan100.batchBar.buttons.some((b) => b.text === '开启'),
      headerCheckboxPresent: zixuan100.headerCheckbox ? true : false,
      pageSizeAfterSwitch: zixuan100.pagination.pageSize,
    };

    const outFile = path.join(EVIDENCE_DIR, `r9-chengfang-${ts}.json`);
    fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence.summary, null, 2));
    console.log(`证据已保存: ${outFile}`);
    console.log(`截图: ${png}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`核实失败: ${e.reason || e.message}`);
  process.exit(1);
});
