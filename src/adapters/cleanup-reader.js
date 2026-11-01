'use strict';
const { openChengfangShop, readChengfangAccountInPage, clickChengfangSubTab,
  collectChengfangPaginationInPage, clickChengfangFirstPageInPage, clickChengfangNextPageInPage } = require('./chengfang-reader');
const { dayNumber, moneyCents } = require('../engine/cleanup-preview');

// These selectors and date shortcuts come from saved read-only 2026-10-07 DOM
// evidence. No ad-row selection, delete/enable/pause or cookie writeback here.
function readMetricsInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const headers = [...document.querySelectorAll('th')].filter(visible).map(text);
  const indexes = ['计划', '整体消耗(元)', '整体成交订单数'].map(h => headers.indexOf(h));
  if (indexes.some(i => i < 0)) throw new Error('整体指标表头缺失');
  const rows = [...document.querySelectorAll('tr[data-row-key]')].filter(visible)
    .filter(tr => /^\d{12,20}$/.test(tr.getAttribute('data-row-key') || '')).map(tr => {
      const cells = [...tr.querySelectorAll('td')].map(text);
      if (cells.length !== headers.length) throw new Error('表头/行列不一致');
      return { planId: tr.getAttribute('data-row-key'), planName: cells[indexes[0]].split(/ID[:：]/)[0].trim(),
        costText: cells[indexes[1]], ordersText: cells[indexes[2]] };
    });
  return { range: [...document.querySelectorAll('.aurora-qc-picker-range input')].filter(visible).map(e => e.value), rows };
}
// 打开与选择分两次 evaluate：实测同一同步 evaluate 里打开控件后立即查菜单为 0 项
// （React/portal 尚未挂载）。openDateMenuInPage 是唯一的 picker.click 入口；选择
// 函数绝不再点控件，避免第二次点击把刚挂载的菜单收起（Playwright 单参数契约：
// 目标+参数对象两个入参，参数对象里合并 days/pollMs/timeoutMs）。
function openDateMenuInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const picker = [...document.querySelectorAll('.aurora-qc-picker-range')].filter(visible);
  if (picker.length !== 1) throw new Error('日期控件不唯一');
  picker[0].click();
  return true;
}
// 页内选择：菜单由外层 openDateMenuInPage 已打开，此处只对有界轮询等待异步挂载/
// 取消，并在同一 DOM 观察中点击唯一快捷项。重复项立即阻断，零项到期明确报错；
// 不猜区间、不改控件、不二次触发菜单。签名遵循 Playwright 单 arg 契约：
// 接受 { days, pollMs, timeoutMs } 一个对象参数。days 严格仅接受 15 或 30（数值），
// 拒绝字符串/浮点/其他数字，防止测试与真实调用点漂移。
function chooseObservedDateInPage(arg) {
  const opts = (arg && typeof arg === 'object') ? arg : {};
  if (!Number.isSafeInteger(opts.days) || (opts.days !== 15 && opts.days !== 30)) {
    throw new Error('日期快捷项参数非法');
  }
  const days = opts.days;
  const pollMs = Number.isSafeInteger(opts.pollMs) ? opts.pollMs : 100;
  const timeoutMs = Number.isSafeInteger(opts.timeoutMs) ? opts.timeoutMs : 5000;
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const picker = [...document.querySelectorAll('.aurora-qc-picker-range')].filter(visible);
  if (picker.length !== 1) throw new Error('日期控件不唯一');
  // 不在这里再次 click picker：外层已打开；这里再点会把它关闭（真实浏览器观察 2026-10-07）。
  const re = new RegExp('^(近|最近|过去)?' + days + '[天日]$');
  const find = () => {
    const leaves = [...document.querySelectorAll('[class*="picker"] li,[class*="picker"] button,[class*="picker"] span,[class*="picker"] div')]
      .filter(e => visible(e) && e.childElementCount === 0);
    const candidates = leaves.filter(e => re.test(text(e)));
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error('实际日期快捷项不唯一');
    return candidates[0];
  };
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let found;
      try { found = find(); } catch (e) { reject(e); return; }
      if (found) { const label = text(found); found.click(); resolve(label); return; }
      if (Date.now() - start >= timeoutMs) { reject(new Error('日期快捷菜单不存在/未挂载（等待超时）')); return; }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}
// 分页页码归一化：真实 collector 常把 activePage 以字符串"1"/"2" 呈现；这里把
// 数值 1 / 字符串 "1" 归一到同一安全整数，非法（0/负/浮点/NaN/非数字串）立即阻断。
function normalizePageNo(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; }
  return null;
}
function createCleanupReader({ getConfig, openShop = openChengfangShop, maxPages = 50, dateMenuTimeoutMs = 5000, dateMenuPollMs = 100 }) {
  return async function read({ account, accountId, days, signal }) {
    if (days !== 15 && days !== 30) throw new Error('仅允许30/15天只读采集');
    const config = getConfig(), shops = (config.shops || []).filter(s => s.name === account && String(s.accountId) === accountId && s.enabled !== false);
    if (shops.length !== 1) throw new Error('清理账号配置非唯一/不匹配');
    const check = () => { if (signal?.aborted) throw new Error('只读采集已取消'); };
    let browser, target, closed = false;
    const closeOnce = () => { if (closed || !browser) return Promise.resolve(); closed = true; return browser.close().catch(() => {}); };
    const abort = () => closeOnce();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      check(); const opened = await openShop({ loginCfg: config.login, shopCfg: shops[0] }); browser = opened.browser; target = opened.target; check();
      const verify = async () => {
        check(); const identity = await target.evaluate(readChengfangAccountInPage);
        if (String(identity.accountId || '') !== accountId) throw new Error('只读逐页账号核验失败'); return identity;
      };
      await verify(); const tab = await target.evaluate(clickChengfangSubTab('商品自选'));
      if (!tab.clicked) throw new Error('商品自选切换失败'); await target.waitForTimeout(2000); check();
      // 打开与选择分两次 evaluate：先打开唯一可见日期控件，再在下一次 evaluate 内
      // 有界等待菜单挂载并点击唯一快捷项（菜单挂载是异步的，同步查会得到 0 项）。
      await target.evaluate(openDateMenuInPage);
      // 菜单轮询期间的 abort 必须能立即停止：把 evaluate 与 signal 竞速；signal 触发
      // 时 evaluate promise 会被浏览器 close 中止，但为了在纯 mock/离线场景也保证取消，
      // 显式 race 一个由 signal 触发的 reject。
      const abortPromise = new Promise((_, rej) => {
        if (!signal) return;
        if (signal.aborted) { rej(new Error('只读采集已取消')); return; }
        signal.addEventListener('abort', () => rej(new Error('只读采集已取消')), { once: true });
      });
      const label = await Promise.race([
        target.evaluate(chooseObservedDateInPage, { days, timeoutMs: dateMenuTimeoutMs, pollMs: dateMenuPollMs }),
        abortPromise,
      ]);
      await target.waitForTimeout(4000); check();
      const first = await target.evaluate(clickChengfangFirstPageInPage); if (first?.clicked) await target.waitForTimeout(3000);
      const sample = async () => { await verify(); return { ...await target.evaluate(readMetricsInPage), pagination: await target.evaluate(collectChengfangPaginationInPage) }; };
      let current = await sample(); await target.waitForTimeout(800);
      if (JSON.stringify(current) !== JSON.stringify(await sample())) throw new Error('日期刷新/首屏数据未稳定');
      const range = current.range;
      const startPage = normalizePageNo(current.pagination.activePage);
      if (startPage == null) throw new Error('分页页码非法（非正整数/非正整数字符串）');
      if (range.length !== 2 || dayNumber(range[1]) - dayNumber(range[0]) !== days - 1 || startPage !== 1) throw new Error('实际区间/分页起点未核实');
      const total = current.pagination.total, ids = new Set(), pages = new Set(), rows = [];
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('分页总数不可核实');
      let prevPage = null;
      for (let count = 0; count < maxPages; count++) {
        check();
        const pageNo = normalizePageNo(current.pagination.activePage);
        if (pageNo == null) throw new Error('分页页码非法（非正整数/非正整数字符串）');
        if (prevPage != null && pageNo !== prevPage + 1) throw new Error('分页页码非递增');
        prevPage = pageNo;
        if (JSON.stringify(current.range) !== JSON.stringify(range) || current.pagination.total !== total || pages.has(pageNo)) throw new Error('区间/总数漂移或分页重复');
        pages.add(pageNo);
        for (const row of current.rows) {
          if (ids.has(row.planId)) throw new Error('跨页重复计划ID'); ids.add(row.planId);
          const cost = row.costText.match(/^\d+(?:\.\d{1,2})?(?=\s|$)/)?.[0];
          const orders = row.ordersText.match(/^\d+(?=\s|$)/)?.[0];
          const cents = moneyCents(cost), n = orders === undefined ? NaN : Number(orders);
          if (cents === null || !Number.isSafeInteger(n)) throw new Error('整体金额/订单解析失败');
          rows.push({ planId: row.planId, planName: row.planName, overallCost: (cents / 100).toFixed(2), costCents: cents, overallOrderCount: n });
        }
        if (current.pagination.hasNext === false) break;
        if (current.pagination.hasNext !== true) throw new Error('末页状态未知');
        const next = await target.evaluate(clickChengfangNextPageInPage); if (!next?.clicked) throw new Error('下一页导航失败');
        await target.waitForTimeout(3000); current = await sample();
      }
      if (current.pagination.hasNext !== false || rows.length !== total) throw new Error('完整分页核验失败');
      const identity = await verify();
      return { identity, snapshot: { account, view: '商品自选', timezone: 'Asia/Shanghai', statisticsStart: range[0], statisticsEnd: range[1],
        dateShortcut: label, collectedAt: new Date().toISOString(), complete: true, accountVerified: true, refreshVerified: true,
        total, collectedRows: rows.length, sortedRows: rows } };
    } finally { signal?.removeEventListener('abort', abort); await closeOnce(); }
  };
}
module.exports = { createCleanupReader, readMetricsInPage, openDateMenuInPage, chooseObservedDateInPage, normalizePageNo };
