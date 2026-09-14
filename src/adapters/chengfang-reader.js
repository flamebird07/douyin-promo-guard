'use strict';

/**
 * 乘方只读读取与暂停原语 v1（覆盖范围：乘方 = 全店托管 + 商品自选）。
 *
 * 页面证据（2026-09-13 只读实测，evidence/r7e、r7f、r8）：
 * - 入口：抖店首页"巨量千川" → 千川导航"乘方"（navigatormenu_overall）→
 *   https://qianchuan.jinritemai.com/uni-prom/overall?aavid=<账户ID>（标题"投放管理"）。
 * - 子标签：页面内"商品自选 / 全店托管"两个 ovui-tabs__tab（实测全店托管为默认激活）。
 *   商品自选视图实测 23 条"千川乘方"计划；全店托管视图实测 1 条全店托管计划（ID 184388555253250562）。
 * - 行结构：tr.ovui-tr > td；名称列含开关 .oc-switch > .ovui-switch.ovui-switch--checked；
 *   行文本含 "ID：<12-20位>"（全角冒号无空格）；状态列 .ad-status；行内动作 编辑/日志/删除。
 * - 分页：.ovui-page-total（"共 N 条记录"）；.ovui-page-select input（每页条数，实测 10条/页 默认，
 *   选项 10/20/50/100条/页）；翻页 li.ovui-page-turner__item（含 next-icon，禁用带 --disabled）。
 * - 批量操作栏：.oc-promotion-batch-operation-bar（默认 display:none），按钮
 *   data-auto-id="bar-groups-group-item-btn-pause"（暂停）、…-btn-delete（删除）、…-btn-open（开启）；
 *   文本分别为 暂停/删除/开启。防误删：本模块只允许暂停按钮，删除按钮仅识别标记、绝不返回可点击对象。
 * - 表头全选框：th 内 label.ovui-checkbox[data-e2e="checkbox"]（勾选当前页全部行 checkbox）。
 * - 账户：千川头部"伊人美 ID：1710242295996424"；cookie 来源"瑾漂亮潮流服饰.json"（电商助手只读）。
 *
 * 安全：真实页面只读导航 + 允许的 UI 切换（子标签/每页条数）；批量暂停原语仅供注入测试与
 * 演练计划使用，真实点击由上层 execute 门禁控制（默认关闭）。
 */

const path = require('path');
const { AuthError, DataGuardError } = require('../lib/errors');
const { openQianchuanHome, closeBrowser } = require('./qianchuan-reader');

const CHENGFANG_URL_MARKER = '/uni-prom/overall';
const SUB_TAB_OPTIONS = ['商品自选', '全店托管'];

// ── 纯 DOM 逻辑（页面 evaluate 与本地 fixture 测试共用同一函数）─────

/** 行文本内提取稳定计划ID（"ID：<12-20位>"，全角/半角冒号；多个候选拒绝）。 */
function resolveRowPlanIdFromText(rowText) {
  const matches = [];
  const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
  let m;
  while ((m = re.exec(rowText || ''))) matches.push(m[1]);
  const uniq = [...new Set(matches)];
  if (uniq.length === 0) return { ok: false, reason: '行内无计划ID文本' };
  if (uniq.length > 1) return { ok: false, reason: `行内出现多个候选ID: ${uniq.join(',')}，拒绝猜测` };
  return { ok: true, planId: uniq[0] };
}

/**
 * 收集当前页乘方计划行（自包含，evaluate 与 fixture 共用）。
 * 行判定：tr.ovui-tr 且（含投放开关 .oc-switch/.ovui-switch[data-e2e=switch] 或行文本含计划ID）；
 * 排除表头行（含 th）与汇总行（ovui-t-summary）。
 */
function collectChengfangRowsInPage() {
  // 状态词表内联（本函数会被 page.evaluate 序列化进浏览器执行，不能引用模块级常量）
  const STATUS_WORDS = ['投放中', '已暂停', '已终止', '已结束', '审核中', '已下线', '未投放', '投放完成', '预算不足', '已拒绝', '暂停中', '已删除'];
  const out = { rows: [], total: null, totalText: null };
  const bodyText = document.body ? document.body.innerText : '';
  const tm = /共\s*([\d,]+)\s*条记录|共\s*([\d,]+)\s*条计划/.exec(bodyText);
  if (tm) {
    out.total = Number(String(tm[1] || tm[2]).replace(/,/g, ''));
    out.totalText = tm[0].replace(/\s+/g, ' ');
  }
  const trs = document.querySelectorAll('tr.ovui-tr');
  let rowIndex = 0;
  for (const tr of trs) {
    if (String(tr.className || '').includes('ovui-t-summary')) continue;
    if (tr.querySelector('th')) continue;
    // 开关容器：外层 .oc-switch 包裹内层 .ovui-switch[data-e2e=switch]；
    // 选中态标记（--checked）在内层（2026-09-13 实测结构），须穿透检测，不能只看外层类。
    const sw = tr.querySelector('.oc-switch, .ovui-switch[data-e2e="switch"]');
    const rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim();
    const hasId = /ID[:：]\s*\d{12,20}/.test(rowText);
    if (!sw && !hasId) continue;
    const idMatches = [];
    const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
    let mm;
    while ((mm = re.exec(rowText))) idMatches.push(mm[1]);
    const uniqIds = [...new Set(idMatches)];
    const swCls = sw ? String(sw.className || '') : '';
    const checked =
      sw ? (
        swCls.includes('ovui-switch--checked') || swCls.includes('oc-switch--checked')
        || !!sw.querySelector('.ovui-switch--checked, .oc-switch--checked')
      ) : null;
    const statusEl = tr.querySelector('.ad-status, [class*="ad-status"]');
    let status = statusEl ? (statusEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!status) {
      for (const w of STATUS_WORDS) {
        if (rowText.includes(w)) { status = w; break; }
      }
    }
    const cb = tr.querySelector('input[type="checkbox"]');
    const ops = [...tr.querySelectorAll('.oc-promotion-operation-action-item')]
      .map((s) => (s.textContent || '').trim())
      .filter((t) => /^(编辑|日志|删除|暂停|开启)$/.test(t));
    out.rows.push({
      rowIndex,
      id: uniqIds.length === 1 ? uniqIds[0] : null,
      idError: uniqIds.length === 0 ? '行内无计划ID' : (uniqIds.length > 1 ? `行内多个候选ID: ${uniqIds.join(',')}` : null),
      name: rowText.slice(0, 60),
      status,
      switchChecked: checked,
      switchCls: swCls.slice(0, 60),
      checkboxChecked: cb ? cb.checked : null,
      ops: [...new Set(ops)],
      rowText: rowText.slice(0, 300),
    });
    rowIndex += 1;
  }
  return out;
}

/** 分页信息（自包含）。 */
function collectChengfangPaginationInPage() {
  const out = { total: null, totalText: null, pageSize: null, activePage: null, hasNext: null };
  const totalEl = document.querySelector('.ovui-page-total, [data-e2e*="pagination_group_total"]');
  if (totalEl) {
    const t = (totalEl.textContent || '').replace(/\s+/g, ' ').trim();
    out.totalText = t;
    const m = /(\d[\d,]*)/.exec(t);
    if (m) out.total = Number(m[1].replace(/,/g, ''));
  }
  const selInput = document.querySelector('.ovui-page-select input');
  out.pageSize = selInput ? selInput.value : null;
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    const txt = (li.textContent || '').trim();
    if (/^\d+$/.test(txt) && String(li.className || '').includes('--active')) out.activePage = txt;
    if (li.querySelector('.ovui-page-turner__next-icon')) {
      out.hasNext = !String(li.className || '').includes('--disabled');
    }
  }
  return out;
}

/** 切换子标签（商品自选/全店托管）：定位含该文本的 tab 祖先并点击。 */
const clickChengfangSubTab = (label) => `(() => {
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
  return { clicked: false, reason: '未找到目标子标签' };
})()`;

/** 打开每页条数下拉（只读 UI）。 */
function openChengfangPageSizeSelectInPage() {
  const sel = document.querySelector('.ovui-page-select .ovui-select__input, .ovui-page-select, [data-e2e*="pagination_group_select"]');
  if (!sel) return { opened: false, reason: '未找到每页条数下拉' };
  const clickable = sel.closest('.ovui-select, [class*="select"]') || sel;
  clickable.click();
  return { opened: true };
}

/** 选择每页条数选项（如"100条/页"）。 */
function pickChengfangPageSizeInPage(text) {
  const opts = [...document.querySelectorAll('.ovui-option')];
  const target = opts.find((o) => (o.textContent || '').replace(/\s+/g, '').includes(text));
  if (!target) {
    return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
  }
  target.click();
  return { picked: true };
}

/** 勾选表头全选框（th 内 label.ovui-checkbox[data-e2e="checkbox"]）。仅勾选，不触碰批量按钮。 */
function clickChengfangHeaderSelectAllInPage() {
  const label = document.querySelector('th .ovui-checkbox[data-e2e="checkbox"], th label.ovui-checkbox, th .ovui-checkbox');
  if (!label) return { clicked: false, reason: '未找到表头全选框' };
  const input = label.querySelector('input[type="checkbox"]');
  if (input && !input.disabled) input.click();
  else label.click();
  return { clicked: true };
}

/** 读取当前页选中行集合（行内 checkbox:checked → 行稳定ID）。自包含。 */
function readSelectedChengfangRowIdsInPage() {
  const out = { selectedIds: [], selectedCount: 0, checkedRows: [] };
  const trs = document.querySelectorAll('tr.ovui-tr');
  for (const tr of trs) {
    if (String(tr.className || '').includes('ovui-t-summary')) continue;
    if (tr.querySelector('th')) continue;
    const cb = tr.querySelector('input[type="checkbox"]');
    if (!cb || !cb.checked) continue;
    const rowText = (tr.textContent || '').replace(/\s+/g, ' ').trim();
    const idMatches = [];
    const re = /ID[:：]\s*(\d{12,20})(?!\d)/g;
    let mm;
    while ((mm = re.exec(rowText))) idMatches.push(mm[1]);
    const uniqIds = [...new Set(idMatches)];
    if (uniqIds.length === 1) out.selectedIds.push(uniqIds[0]);
    out.checkedRows.push({ id: uniqIds.length === 1 ? uniqIds[0] : null, text: rowText.slice(0, 80) });
  }
  out.selectedCount = out.checkedRows.length;
  return out;
}

/**
 * 批量操作栏"暂停"按钮精确定位（防误删核心）：
 * 限定在批量操作栏容器内，文本必须为"暂停"；全部候选数 0 或 >1 → 拒绝（零点击）；
 * 唯一候选必须带可识别标记（data-auto-id 含 btn-pause 或 data-e2e 以 _pause 结尾），
 * 无标记的纯文本"暂停"不可信（禁止模糊文本兜底）。绝不返回"删除"/"开启"。
 */
function findChengfangBatchPauseButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return { ok: false, reason: '未找到可见批量操作栏' };
  const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '暂停');
  if (btns.length === 0) return { ok: false, reason: '批量操作栏内未找到"暂停"按钮（删除/开启不得被选中）' };
  if (btns.length > 1) return { ok: false, reason: `批量操作栏内出现 ${btns.length} 个"暂停"候选，拒绝点击` };
  const b = btns[0];
  const autoId = b.getAttribute('data-auto-id') || '';
  const e2e = b.getAttribute('data-e2e') || '';
  if (!/btn-pause$/.test(autoId) && !/_pause$/.test(e2e)) {
    return { ok: false, reason: `唯一"暂停"候选缺少可识别标记（autoId=${autoId || '-'} e2e=${e2e || '-'}），禁止模糊文本兜底` };
  }
  return { ok: true, e2e, autoId, tag: b.tagName };
}

/**
 * 读取批量操作栏当前状态（自包含）：
 * 返回 { visible, selectedText, selectedCount, buttons }；"已选N个" 用于
 * 点击前核验所选范围（与 readSelectedChengfangRowIdsInPage 交叉核对）。
 */
function readChengfangBatchBarInPage() {
  const out = { visible: false, selectedText: null, selectedCount: null, buttons: [] };
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return out;
  out.visible = true;
  const text = (bar.textContent || '').replace(/\s+/g, ' ').trim();
  out.selectedText = text.slice(0, 60);
  const m = /已选\s*(\d+)\s*个/.exec(text);
  if (m) out.selectedCount = Number(m[1]);
  for (const b of bar.querySelectorAll('button')) {
    const t = (b.textContent || '').trim();
    if (!t) continue;
    out.buttons.push({
      text: t,
      e2e: b.getAttribute('data-e2e') || '',
      autoId: b.getAttribute('data-auto-id') || '',
    });
  }
  return out;
}

/** 批量操作栏"删除"按钮识别（仅标记，绝不返回可点击句柄）。 */
function findChengfangBatchDeleteButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
  const out = [];
  for (const bar of bars) {
    for (const b of bar.querySelectorAll('button')) {
      const t = (b.textContent || '').trim();
      if (t === '删除' || /_delete$/.test(b.getAttribute('data-e2e') || '')
        || b.getAttribute('data-auto-id') === 'bar-groups-group-item-btn-delete') {
        out.push({ text: t, e2e: b.getAttribute('data-e2e') || '', autoId: b.getAttribute('data-auto-id') || '' });
      }
    }
  }
  return out;
}

/**
 * 非预期弹窗检测：可见的 dialog/modal/confirm 类元素。
 * 文本含"删除"→ 删除确认（绝对禁止确认）；含"确定/确认"但无"删除" → 非预期弹窗（同样停止）。
 */
function detectChengfangDangerDialogInPage() {
  const out = [];
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (t.includes('删除')) out.push({ kind: 'delete_confirm', text: t.slice(0, 120) });
    else if (t.includes('确定') || t.includes('确认')) out.push({ kind: 'unexpected_confirm', text: t.slice(0, 120) });
  }
  return out;
}

/** 翻页到下一页（事件绑在 li 上；点到内部 svg 不翻页——实测踩坑）。 */
function clickChengfangNextPageInPage() {
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    if (!li.querySelector('.ovui-page-turner__next-icon')) continue;
    if (String(li.className || '').includes('--disabled')) return { clicked: false, atEnd: true };
    li.click();
    return { clicked: true };
  }
  return { clicked: false, reason: '未找到分页器' };
}

/** 回到第一页（分页导航，只读 UI；供全量回读的扫描起点，避免从非首页开始漏扫）。 */
function clickChengfangFirstPageInPage() {
  const lis = document.querySelectorAll('li.ovui-page-turner__item');
  for (const li of lis) {
    const txt = (li.textContent || '').trim();
    if (/^\d+$/.test(txt) && txt === '1') {
      if (String(li.className || '').includes('--active')) return { clicked: false, alreadyFirst: true };
      li.click();
      return { clicked: true };
    }
  }
  return { clicked: false, reason: '未找到分页器' };
}

/**
 * 定位指定计划行内的投放开关（不点击）。
 * 供 clickRowSwitch 的"定位 → 最终检查(beforeDispatch) → 实际点击"两段式：确保在
 * 最后一次异步页面检查之后、DOM 点击派发之前重新校验停止/时段/跨日/当前许可与账户身份。
 * 精确定位：行文本必须含该 planId；行内投放开关恰好一个才返回，0 个或多个一律拒绝。
 */
function locateChengfangRowSwitchInPage(planId) {
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const target = trs.find((tr) => (tr.textContent || '').includes(`ID：${planId}`) || (tr.textContent || '').includes(`ID:${planId}`));
  if (!target) return { ok: false, reason: `未找到计划ID ${planId} 所在行` };
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${planId} 行内未找到投放开关` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${planId} 行内出现 ${wrappers.length} 个开关，拒绝点击` };
  const before = String(wrappers[0].className || '');
  const beforeChecked = before.includes('ovui-switch--checked') || before.includes('oc-switch--checked')
    || !!wrappers[0].querySelector('.ovui-switch--checked, .oc-switch--checked');
  return { ok: true, wrapperCount: wrappers.length, beforeChecked };
}

/**
 * 点击指定计划行内的投放开关（全店托管总开关用；execute 门禁控制，绝不用于删除）。
 * 精确定位：行文本必须含该 planId；行内投放开关（.oc-switch/.ovui-switch[data-e2e=switch]）
 * 恰好一个才点击，0 个或多个候选一律拒绝（防误点其他行/其他控件）。
 */
function clickChengfangRowSwitchByPlanId(planId) {
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const target = trs.find((tr) => (tr.textContent || '').includes(`ID：${planId}`) || (tr.textContent || '').includes(`ID:${planId}`));
  if (!target) return { ok: false, reason: `未找到计划ID ${planId} 所在行` };
  // 开关容器为外层 .oc-switch（内层 .ovui-switch 是其子元素）；行内必须恰好一个容器。
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${planId} 行内未找到投放开关` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${planId} 行内出现 ${wrappers.length} 个开关，拒绝点击` };
  const before = String(wrappers[0].className || '');
  const beforeChecked = before.includes('ovui-switch--checked') || before.includes('oc-switch--checked')
    || !!wrappers[0].querySelector('.ovui-switch--checked, .oc-switch--checked');
  wrappers[0].click();
  return { ok: true, beforeChecked };
}

/**
 * 设置指定计划行内复选框（全选后精确校正：取消勾选非目标行）。
 * 精确定位：行文本必须含该 planId；行内复选框恰好一个；禁用则拒绝。
 * 参数为单对象 { planId, checked }（evaluate 只接受单个参数，保持自包含）。
 * 返回后由上层以 readSelection 回读核验实际选中集合（以回读为准）。
 */
function setChengfangRowCheckboxByPlanId({ planId, checked }) {
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const target = trs.find((tr) => (tr.textContent || '').includes(`ID：${planId}`) || (tr.textContent || '').includes(`ID:${planId}`));
  if (!target) return { ok: false, reason: `未找到计划ID ${planId} 所在行` };
  const cbs = [...target.querySelectorAll('input[type="checkbox"]')];
  if (cbs.length === 0) return { ok: false, reason: `计划ID ${planId} 行内未找到复选框` };
  if (cbs.length > 1) return { ok: false, reason: `计划ID ${planId} 行内出现 ${cbs.length} 个复选框，拒绝操作` };
  const cb = cbs[0];
  if (cb.disabled) return { ok: false, reason: `计划ID ${planId} 复选框不可用` };
  if (cb.checked !== checked) cb.click();
  return { ok: true, want: checked };
}

/** 账户与页面身份（自包含）。 */
function readChengfangAccountInPage() {
  const out = {
    url: location.href.slice(0, 160),
    accountId: null,
    accountName: null,
    hasChengfangNav: false,
    hasSubTabs: false,
    navText: '',
  };
  const nav = document.querySelector('.qc-page-navigator-container, [class*="navigator"]');
  const navText = nav ? (nav.textContent || '') : '';
  out.navText = navText.replace(/\s+/g, ' ').trim().slice(0, 200);
  const m = /ID[:：]\s*(\d{8,20})/.exec(navText);
  if (m) out.accountId = m[1];
  const nameM = /([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})\s*ID[:：]\s*\d{8,20}/.exec(navText.replace(/\s+/g, ' '));
  if (nameM) out.accountName = nameM[1];
  out.hasChengfangNav = navText.includes('乘方');
  const bodyText = document.body ? document.body.innerText : '';
  out.hasSubTabs = bodyText.includes('商品自选') && bodyText.includes('全店托管');
  return out;
}

// ── 页面驱动（真实页面；browserFactory 可注入供测试）────────────────

async function openChengfangShop(p) {
  const { browser, target } = await openQianchuanHome(p.loginCfg, p.shopCfg, p);
  try {
    await target.waitForTimeout(2000);
    try { await target.getByText('我知道了', { exact: true }).first().click({ timeout: 3000 }); } catch (_) {}
    let st = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await target.evaluate(() => {
        const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
        if (el) el.click();
      }).catch(() => {});
      await target.waitForTimeout(9000);
      await target.waitForFunction(() => /uni-prom\/overall/.test(location.href), { timeout: 20000 }).catch(() => {});
      st = await target.evaluate(readChengfangAccountInPage);
      if (st && /uni-prom\/overall/.test(st.url)) break;
    }
    if (!st || !/uni-prom\/overall/.test(st.url)) {
      throw new DataGuardError(`导航"乘方"未到达管理页（当前 ${st ? st.url.slice(0, 80) : '未知'}）`);
    }
    // 乘方页先呈现营销目标标签（"直播/商品"），点击"商品"后才出现
    // "商品自选/全店托管"子标签（2026-09-13 实测）。若子标签已存在则跳过。
    const deadlineTab = Date.now() + 15000;
    let hasTabs = false;
    while (Date.now() < deadlineTab) {
      const check = await target.evaluate(readChengfangAccountInPage);
      if (check && check.hasSubTabs) { st = check; hasTabs = true; break; }
      await target.evaluate(() => {
        const els = [...document.querySelectorAll('body *')].filter((el) => {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
          return own === '商品' && el.querySelectorAll('*').length <= 4;
        });
        const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (el) el.click();
      }).catch(() => {});
      await target.waitForTimeout(2000);
    }
    if (!hasTabs) {
      // 子标签（商品自选/全店托管）异步渲染，轮询等待（最长 40s）
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        const check = await target.evaluate(readChengfangAccountInPage);
        if (check && check.hasSubTabs) { st = check; hasTabs = true; break; }
        await target.waitForTimeout(2000);
      }
    }
    if (!hasTabs) {
      throw new DataGuardError('乘方页未找到"商品自选/全店托管"子标签（点击"商品"后仍未出现），拒绝继续');
    }
    return { browser, target, account: st };
  } catch (e) {
    await closeBrowser(browser);
    throw e;
  }
}

/** 乘方控制器（真实页面版）：身份核验 + 视图读取 + 暂停原语。 */
function createChengfangController(p) {
  const nowFn = p.nowFn || (() => Date.now());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadWaitMs = p.loadWaitMs || 10000;
  const tabWaitMs = p.tabWaitMs || 8000;
  // 接近真实点击的最终检查钩子（由执行器注册）：在每次实际业务点击派发前调用。
  // 要求：定位/弹窗检测等最后一次异步页面检查完成之后、DOM click 派发之前执行；
  // 抛错 → 控制器不派发点击（零点击停止）。
  let beforeDispatch = p.beforeDispatch || null;
  const fireBeforeDispatch = async ({ page }) => {
    if (!beforeDispatch) return;
    try {
      await beforeDispatch({ page });
    } catch (e) {
      throw new DataGuardError(`点击前最终检查拦截：${e.reason || e.message}`);
    }
  };

  return {
    connected: true,
    source: 'promo-page',
    kind: 'chengfang',
    setBeforeDispatch(fn) { beforeDispatch = fn; return this; },
    async verifyIdentity({ page, shopCfg }) {
      const st = await page.evaluate(readChengfangAccountInPage).catch(() => null);
      if (!st) return { ok: false, reason: '乘方页身份读取失败' };
      if (!/uni-prom\/overall/.test(st.url)) {
        return { ok: false, reason: `未在乘方管理页（当前 ${st.url.slice(0, 80)}）` };
      }
      if (!st.hasSubTabs) {
        return { ok: false, reason: '乘方页未找到"商品自选/全店托管"子标签' };
      }
      if (shopCfg.accountId) {
        const cfgAcc = String(shopCfg.accountId).trim();
        if (!st.accountId || st.accountId !== cfgAcc) {
          return { ok: false, reason: `账户不匹配：配置 ${cfgAcc}，页面 ${st.accountId || '(空)'}` };
        }
      }
      return {
        ok: true,
        pageShopId: String(shopCfg.id || ''),
        pageShopName: shopCfg.name || null,
        pageAccountId: st.accountId,
        pageAccountName: st.accountName,
        pageUrl: st.url,
      };
    },

    /** 读取指定子标签视图（含行与分页）。 */
    async readView({ page, tab }) {
      const rows = await page.evaluate(collectChengfangRowsInPage).catch((e) => ({ error: String(e) }));
      const pagination = await page.evaluate(collectChengfangPaginationInPage).catch(() => null);
      return { tab, rows, pagination };
    },

    async switchView({ page, tab }) {
      const r = await page.evaluate(clickChengfangSubTab(tab)).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) {
        throw new DataGuardError(`切换子标签"${tab}"失败：${(r && r.reason) || '未找到目标标签'}`);
      }
      await sleep(tabWaitMs);
    },

    async switchPageSize({ page, size }) {
      const opened = await page.evaluate(openChengfangPageSizeSelectInPage).catch((e) => ({ error: String(e) }));
      if (!opened || opened.opened !== true) {
        throw new DataGuardError(`打开每页条数下拉失败：${(opened && opened.reason) || '控件未找到'}`);
      }
      await sleep(1500);
      const picked = await page.evaluate((s) => {
        const opts = [...document.querySelectorAll('.ovui-option')];
        const target = opts.find((o) => (o.textContent || '').replace(/\s+/g, '').includes(s));
        if (!target) return { picked: false, available: opts.map((o) => (o.textContent || '').trim()).slice(0, 10) };
        target.click();
        return { picked: true };
      }, size).catch((e) => ({ error: String(e) }));
      if (!picked || picked.picked !== true) {
        throw new DataGuardError(`选择"${size}"失败：${(picked && picked.available) ? `可用选项 ${picked.available.join('/')}` : (picked && picked.reason) || '选项未找到'}`);
      }
      await sleep(loadWaitMs);
    },

    async selectAllInPage({ page }) {
      const r = await page.evaluate(clickChengfangHeaderSelectAllInPage).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) {
        throw new DataGuardError(`勾选表头全选框失败：${(r && r.reason) || '全选框未找到'}`);
      }
      await sleep(500);
    },

    async readSelection({ page }) {
      return page.evaluate(readSelectedChengfangRowIdsInPage).catch(() => ({ selectedIds: [], selectedCount: 0, checkedRows: [] }));
    },

    async readBatchBar({ page }) {
      return page.evaluate(readChengfangBatchBarInPage).catch(() => ({ visible: false, selectedCount: null, buttons: [] }));
    },

    /**
     * 点击批量"暂停"（防误删：只接受精确定位且带标记的唯一"暂停"按钮；删除/开启绝不点击）。
     * 点击前先检测非预期弹窗；定位失败/候选非唯一 → 抛 DataGuardError（零点击）。
     * 返回 {clicked:true} 或抛 DataGuardError。
     */
    async clickBatchPause({ page }) {
      // 检测失败必须阻断点击（抛 DataGuardError，绝不 catch 成"无弹窗"）
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage);
      } catch (e) {
        throw new DataGuardError(`弹窗检测失败，停止点击批量"暂停"（检测异常）：${e.reason || e.message}`);
      }
      if (danger.length > 0) {
        throw new DataGuardError(`检测到非预期弹窗，停止点击：${danger.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      }
      const found = await page.evaluate(findChengfangBatchPauseButtonInPage).catch((e) => ({ error: String(e) }));
      if (!found || found.ok !== true) {
        throw new DataGuardError(`批量"暂停"按钮无法唯一定位，零点击：${(found && found.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：最后一次页面检查（定位/弹窗检测）完成后、DOM 点击派发前。
      // 停止/时段/跨日/当前许可或账户身份变化 → 抛 DataGuardError，不派发点击。
      await fireBeforeDispatch({ page });
      // 二次定位并点击（与 findChengfangBatchPauseButtonInPage 同一严格条件），结果回传核验
      const clicked = await page.evaluate(() => {
        const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
        let bar = null;
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { bar = b; break; }
        }
        if (!bar) return false;
        const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '暂停');
        if (btns.length !== 1) return false;
        const b = btns[0];
        const autoId = b.getAttribute('data-auto-id') || '';
        const e2e = b.getAttribute('data-e2e') || '';
        if (!/btn-pause$/.test(autoId) && !/_pause$/.test(e2e)) return false;
        b.click();
        return true;
      }).catch((e) => ({ error: String(e) }));
      if (clicked !== true) {
        throw new DataGuardError('批量"暂停"按钮二次定位不一致，零点击');
      }
      await sleep(1500);
    },

    /** 点击指定计划行内投放开关（全店托管总开关用；严格单候选定位）。 */
    async clickRowSwitch({ page, planId }) {
      const loc = await page.evaluate(locateChengfangRowSwitchInPage, planId).catch((e) => ({ ok: false, reason: String(e) }));
      if (!loc || loc.ok !== true) {
        throw new DataGuardError(`点击计划 ${planId} 行内开关失败（定位）：${(loc && loc.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：定位完成后、DOM 点击派发前。
      // 停止/时段/跨日/当前许可或账户身份变化 → 抛 DataGuardError，不派发点击。
      await fireBeforeDispatch({ page });
      const r = await page.evaluate(clickChengfangRowSwitchByPlanId, planId).catch((e) => ({ error: String(e) }));
      if (!r || r.ok !== true) {
        throw new DataGuardError(`点击计划 ${planId} 行内开关失败（二次定位不一致）：${(r && r.reason) || '定位失败'}`);
      }
      await sleep(1500);
    },

    /** 精确校正指定计划行内复选框（全选后取消非目标行；以 readSelection 回读核验）。 */
    async setRowCheckbox({ page, planId, checked }) {
      const r = await page.evaluate(setChengfangRowCheckboxByPlanId, { planId, checked }).catch((e) => ({ error: String(e) }));
      if (!r || r.ok !== true) {
        throw new DataGuardError(`校正计划 ${planId} 行内复选框失败：${(r && r.reason) || '定位失败'}`);
      }
      await sleep(300);
    },

    async clickNextPage({ page }) {
      const r = await page.evaluate(clickChengfangNextPageInPage).catch((e) => ({ error: String(e) }));
      if (!r || r.clicked !== true) return r;
      await sleep(loadWaitMs);
      return { clicked: true };
    },

    async detectDanger({ page }) {
      // 检测失败必须抛出（执行器据此停止后续点击）；绝不 catch 成"无弹窗"
      return page.evaluate(detectChengfangDangerDialogInPage);
    },

    /** 回到第一页（全量回读扫描起点；只读分页导航）。 */
    async ensureFirstPage({ page }) {
      const r = await page.evaluate(clickChengfangFirstPageInPage).catch((e) => ({ error: String(e) }));
      if (r && r.clicked === true) await sleep(loadWaitMs);
    },
  };
}

module.exports = {
  resolveRowPlanIdFromText,
  collectChengfangRowsInPage,
  collectChengfangPaginationInPage,
  clickChengfangSubTab,
  openChengfangPageSizeSelectInPage,
  pickChengfangPageSizeInPage,
  clickChengfangHeaderSelectAllInPage,
  readSelectedChengfangRowIdsInPage,
  findChengfangBatchPauseButtonInPage,
  findChengfangBatchDeleteButtonInPage,
  readChengfangBatchBarInPage,
  clickChengfangRowSwitchByPlanId,
  locateChengfangRowSwitchInPage,
  setChengfangRowCheckboxByPlanId,
  detectChengfangDangerDialogInPage,
  clickChengfangNextPageInPage,
  clickChengfangFirstPageInPage,
  readChengfangAccountInPage,
  openChengfangShop,
  createChengfangController,
  closeBrowser,
  CHENGFANG_URL_MARKER,
  SUB_TAB_OPTIONS,
};
