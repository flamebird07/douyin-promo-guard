'use strict';

/**
 * 消耗门槛（D55 已取消 50 元门槛）：页面渲染合同（离线 HTML 提取 + VM，不启动浏览器/服务）。
 *
 * 直接提取 app/index.html 中真实 shopRowHtml 函数体渲染；
 * 行数据由真实 watch-drill buildShopRows 投影生成，验证：
 * - 同店同日 roiTooLow=true → 明确可见「ROI设置过低」+「费比超标（无消耗门槛）」；
 * - roiTooLow=false（费比恢复 / 数据失效）→ 无提示；
 * - 跨日 → 即使昨日 true，今天也不残留；
 * - 只提示，不自动修改 ROI 输入值。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 安装到 bill-manager 后 app/tests 上两级的默认 guard 目录不存在：显式
// PROMO_GUARD_DIR 优先；未显式指定时保留隔离目录的默认相对路径。
const GUARD_DIR = process.env.PROMO_GUARD_DIR || path.join(__dirname, '..', '..', 'guard');
process.env.PROMO_GUARD_DIR = GUARD_DIR;
const PUBLISHER_STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ui-pub-'));
fs.writeFileSync(path.join(PUBLISHER_STUB, 'shop-profile.cjs'), 'module.exports = {};\n');
process.env.PUBLISHER_DIR = PUBLISHER_STUB;

const { buildShopRows } = require('../watch-drill');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

// index.html 的 shopRowHtml 行内函数引用页面级快照/工具（s / fmtTime / deleteBlocked）。
// 这里只为 VM 独立渲染注入最小桩，保持与生产完全相同的函数体，不改变其任何行为或断言。
const VM_SNAPSHOT = { businessDate: null, planPublishing: null };
const vmFmtTime = (v) => (v == null ? '' : String(v));
const vmDeleteBlocked = () => false;

function extractShopRowHtml() {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const start = html.indexOf('// R41-VM-TEST:SHOP_ROW_HTML_START');
  const end = html.indexOf('// R41-VM-TEST:SHOP_ROW_HTML_END');
  assert.ok(start > 0 && end > start, 'index.html 必须保留 SHOP_ROW_HTML 测试标记');
  const body = html.slice(start, end);
  const fn = new Function('r', 'idx', 'esc', 's', 'fmtTime', 'deleteBlocked', body);
  return (r, idx, escFn) => fn(r, idx, escFn || esc, VM_SNAPSHOT, vmFmtTime, vmDeleteBlocked);
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function row(over = {}) {
  return {
    id: 'shop-a',
    name: '甲店',
    displayName: '甲店',
    platform: 'douyin',
    platformLabel: '抖店',
    adControl: true,
    adState: { state: 'on', on: true, note: '投放中' },
    requiresLogin: false,
    costCents: 5001,
    orders: 1,
    feeRatio: null,
    balanceCents: null,
    balanceAt: null,
    thresholdCents: 100,
    targetRoi: 15,
    plansPerShopPerDay: 3,
    identityPending: false,
    lastError: null,
    today: null,
    roiTooLow: false,
    spendFloorCents: 0,
    ...over,
  };
}

test('页面：roiTooLow=true 明确可见「ROI设置过低」及原因，且不改 ROI 输入', () => {
  const render = extractShopRowHtml();
  const html = render(row({ roiTooLow: true }), 0, esc);
  assert.match(html, /ROI设置过低/);
  assert.match(html, /费比超标（无消耗门槛）/);
  assert.doesNotMatch(html, /50\s*元/);
  assert.match(html, /class="wd-roi-low"/);
  assert.match(html, /目标ROI 15/);
  assert.match(html, /class="wd-roi"[^>]*value="15"/, 'ROI 输入值必须保持已保存值');
  assert.doesNotMatch(html, /disabled/, '提示不得禁用 ROI 编辑');
});

test('页面：费比恢复 / 坏数据（roiTooLow=false）不显示提示', () => {
  const render = extractShopRowHtml();
  for (const cost of [5000, 4999, 5001, null]) {
    const html = render(row({ costCents: cost, roiTooLow: false }), 0, esc);
    assert.doesNotMatch(html, /ROI设置过低/, `cost=${cost}`);
    assert.doesNotMatch(html, /费比超标（无消耗门槛）/, `cost=${cost}`);
  }
});

test('页面合同：buildShopRows 跨日清除提示后再渲染，页面无陈旧警告', () => {
  const render = extractShopRowHtml();
  const status = {
    businessDate: '2026-10-17',
    shops: [{
      id: 'shop-a', name: '甲店', displayName: '甲店', platform: 'douyin', lastAdState: 'on',
      today: { businessDate: '2026-10-16', costCents: 5001, orders: 1, roiTooLow: true },
    }],
  };
  const rows = buildShopRows(status);
  const html = render(rows[0], 0, esc);
  assert.doesNotMatch(html, /ROI设置过低/, '昨日 true 不得在今天残留');
});

test('页面合同：同店同日 buildShopRows=true 时渲染提示（真实投影→HTML）', () => {
  const render = extractShopRowHtml();
  const status = {
    businessDate: '2026-10-17',
    shops: [{
      id: 'shop-a', name: '甲店', displayName: '甲店', platform: 'douyin', lastAdState: 'on',
      today: {
        businessDate: '2026-10-17', costCents: 5001, orders: 1,
        roiTooLow: true, spendProtected: false, pauseEligible: true, spendFloorCents: 0,
      },
    }],
  };
  const rows = buildShopRows(status);
  assert.strictEqual(rows[0].roiTooLow, true);
  const html = render(rows[0], 0, esc);
  assert.match(html, /ROI设置过低/);
  assert.match(html, /费比超标（无消耗门槛）/);
  assert.doesNotMatch(html, /50\s*元/);
});
