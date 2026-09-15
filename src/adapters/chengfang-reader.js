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
 * 批量操作栏"开启"按钮精确定位（防误删/防误暂停）：
 * 限定在批量操作栏容器内，文本必须为"开启"；全部候选数 0 或 >1 → 拒绝（零点击）；
 * 唯一候选必须带可识别标记（data-auto-id 含 btn-open 或 data-e2e 以 _open 结尾），
 * 无标记的纯文本"开启"不可信（禁止模糊文本兜底）。绝不返回"删除"/"暂停"。
 */
function findChengfangBatchEnableButtonInPage() {
  const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
  let bar = null;
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) { bar = b; break; }
  }
  if (!bar) return { ok: false, reason: '未找到可见批量操作栏' };
  const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '开启');
  if (btns.length === 0) return { ok: false, reason: '批量操作栏内未找到"开启"按钮（删除/暂停不得被选中）' };
  if (btns.length > 1) return { ok: false, reason: `批量操作栏内出现 ${btns.length} 个"开启"候选，拒绝点击` };
  const b = btns[0];
  const autoId = b.getAttribute('data-auto-id') || '';
  const e2e = b.getAttribute('data-e2e') || '';
  if (!/btn-open$/.test(autoId) && !/_open$/.test(e2e)) {
    return { ok: false, reason: `唯一"开启"候选缺少可识别标记（autoId=${autoId || '-'} e2e=${e2e || '-'}），禁止模糊文本兜底` };
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
 * 弹窗分类（内部工具；不导出，供 danger 检测与确认提交共用）。
 *
 * 2026-09-15 修复（交接第 2 项）：正式控制器此前只能识别"删除/非预期"弹窗，无法提交
 * 合法业务确认弹窗，导致真实暂停/开启链路在弹窗处断掉。
 *
 * 严格原则：**只确认与当前动作、数量精确一致的弹窗**；未知结构一律阻断（不猜测、不兜底）。
 *
 * 实测已确认的合法弹窗（仅此三类，文本来自真实页面）：
 *   - 批量暂停：「确定要暂停 N 条计划吗？暂停后将停止投放，请谨慎操作。 取消 确定」
 *   - 托管关闭：「确定关闭乘方投放吗？」（另有"其他推商品计划需手动恢复"的提示，用户已同意）
 *   - 托管开启（2026-09-15 真机实测）：「为保证投放的唯一性，温馨提示您乘方投放时，
 *     受到互斥影响的放量投放-全域投放计划、标准投放计划将会暂停（如有）。同时小店随心推
 *     订单将被终止，终止后不可恢复。」按钮【再想想】【确定】；实测批量开启（商品自选）
 *     无确认弹窗（点击即生效），故 batch_enable 不声明文本句式——出现任何弹窗仍按未知阻断。
 *
 * 注意：本函数同时以文本形式内联进 page.evaluate 的执行体（浏览器序列化不支持闭包引用），
 * 因此必须保持**自包含**（不引用模块级常量/函数）。
 */
function classifyDialogText(text, expectedAction) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { kind: 'empty', text: '' };

  // 1) 删除确认：绝对禁止确认（最高优先级，先判）
  if (t.includes('删除')) return { kind: 'delete_confirm', text: t.slice(0, 200) };

  // 2) 批量暂停确认：文本必须精确匹配"确定要暂停 N 条计划吗"句式
  const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
  if (mPause) {
    const count = Number(mPause[1]);
    const okText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
    if (expectedAction === 'batch_pause') {
      return { kind: 'batch_pause_confirm', text: t.slice(0, 200), count, exactText: okText };
    }
    // 当前动作不是批量暂停，却弹出暂停确认 → 非预期，阻断
    return { kind: 'unexpected_confirm', text: t.slice(0, 200), count };
  }

  // 3) 全店托管关闭确认
  if (/确定关闭乘方投放吗/.test(t)) {
    if (expectedAction === 'shop_disable') {
      return { kind: 'shop_disable_confirm', text: t.slice(0, 200), count: null };
    }
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }

  // 3b) 全店托管开启确认（2026-09-15 真机实测：互斥提示，按钮【再想想】【确定】）。
  // 双锚点精确匹配，任一不满足 → 落入未知阻断；含"删除"字样已被上面分支拦截。
  if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
    if (expectedAction === 'shop_enable') {
      return { kind: 'shop_enable_confirm', text: t.slice(0, 200), count: null };
    }
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }

  // 4) 含"确定/确认"但结构未知：不得编造，一律阻断
  if (t.includes('确定') || t.includes('确认')) {
    return { kind: 'unknown_confirm', text: t.slice(0, 200) };
  }
  return { kind: 'other', text: t.slice(0, 200) };
}

/**
 * 弹窗分类的浏览器内联版本（与 classifyDialogText 保持逐字一致，供 page.evaluate 序列化使用）。
 * 二者必须同步修改；此处为避免闭包引用导致的 ReferenceError 而独立定义。
 */
function classifyDialogTextInPage(text, expectedAction) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { kind: 'empty', text: '' };
  if (t.includes('删除')) return { kind: 'delete_confirm', text: t.slice(0, 200) };
  const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
  if (mPause) {
    const count = Number(mPause[1]);
    const okText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
    if (expectedAction === 'batch_pause') return { kind: 'batch_pause_confirm', text: t.slice(0, 200), count, exactText: okText };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200), count };
  }
  if (/确定关闭乘方投放吗/.test(t)) {
    if (expectedAction === 'shop_disable') return { kind: 'shop_disable_confirm', text: t.slice(0, 200), count: null };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }
  if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
    if (expectedAction === 'shop_enable') return { kind: 'shop_enable_confirm', text: t.slice(0, 200), count: null };
    return { kind: 'unexpected_confirm', text: t.slice(0, 200) };
  }
  if (t.includes('确定') || t.includes('确认')) return { kind: 'unknown_confirm', text: t.slice(0, 200) };
  return { kind: 'other', text: t.slice(0, 200) };
}

/** 可见弹窗候选（内部工具；自包含，须可被 page.evaluate 序列化）。 */
function visibleChengfangDialogElsInPage() {
  return [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
}

/**
 * 非预期弹窗检测：可见的 dialog/modal/confirm 类元素。
 * 文本含"删除"→ 删除确认（绝对禁止确认）；含"确定/确认"但非当前动作的合法弹窗 → 阻断。
 * 返回 { kind, text, count? }[]；调用方据 expectedAction 判定是否可确认。
 * 自包含：不引用模块级函数（page.evaluate 序列化限制）。
 */
function detectChengfangDangerDialogInPage(expectedAction) {
  const out = [];
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let c;
    if (t.includes('删除')) c = { kind: 'delete_confirm', text: t.slice(0, 200) };
    else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) {
        c = (expectedAction === 'batch_pause')
          ? { kind: 'batch_pause_confirm', text: t.slice(0, 200), count: Number(mPause[1]) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200), count: Number(mPause[1]) };
      } else if (/确定关闭乘方投放吗/.test(t)) {
        c = (expectedAction === 'shop_disable')
          ? { kind: 'shop_disable_confirm', text: t.slice(0, 200) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200) };
      } else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
        c = (expectedAction === 'shop_enable')
          ? { kind: 'shop_enable_confirm', text: t.slice(0, 200) }
          : { kind: 'unexpected_confirm', text: t.slice(0, 200) };
      } else if (t.includes('确定') || t.includes('确认')) {
        c = { kind: 'unknown_confirm', text: t.slice(0, 200) };
      } else {
        c = { kind: 'other', text: t.slice(0, 200) };
      }
    }
    if (c.kind === 'other' || c.kind === 'empty') continue;
    out.push(c);
  }
  return out;
}

/**
 * 读取当前可见的业务确认弹窗（含按钮句柄定位信息；不点击）。
 * 供 clickBatchPause/clickBatchEnable/托管关闭的"点击 → 检测弹窗 → 提交确认"闭环。
 * 仅返回与 expectedAction 精确一致的弹窗；未知/删除/不匹配 → 由调用方阻断。
 * 自包含：不引用模块级函数。
 */
function readChengfangConfirmDialogInPage(expectedAction) {
  const out = { found: false, kind: null, text: '', count: null, buttons: [], okCandidateCount: 0, cancelCandidateCount: 0, exactText: false };
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let kind = null; let count = null; let exactText = false;
    if (t.includes('删除')) {
      kind = 'delete_confirm';
    } else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) {
        count = Number(mPause[1]);
        exactText = t.includes('暂停后将停止投放') && t.includes('请谨慎操作');
        kind = (expectedAction === 'batch_pause') ? 'batch_pause_confirm' : 'unexpected_confirm';
      } else if (/确定关闭乘方投放吗/.test(t)) {
        kind = (expectedAction === 'shop_disable') ? 'shop_disable_confirm' : 'unexpected_confirm';
      } else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) {
        kind = (expectedAction === 'shop_enable') ? 'shop_enable_confirm' : 'unexpected_confirm';
      } else if (t.includes('确定') || t.includes('确认')) {
        kind = 'unknown_confirm';
      } else {
        kind = 'other';
      }
    }
    if (kind === 'other') continue;
    out.found = true;
    out.kind = kind;
    out.text = t.slice(0, 200);
    out.count = count;
    out.exactText = exactText;
    const btns = [...el.querySelectorAll('button')];
    for (const b of btns) {
      const bt = (b.textContent || '').replace(/\s+/g, '').trim();
      if (!bt) continue;
      const isOk = bt === '确定' || bt === '确认' || bt === '确认暂停' || bt === '确认关闭';
      const isCancel = bt === '取消';
      out.buttons.push({ text: bt, isOk, isCancel, e2e: b.getAttribute('data-e2e') || '', autoId: b.getAttribute('data-auto-id') || '' });
      if (isOk) out.okCandidateCount += 1;
      if (isCancel) out.cancelCandidateCount += 1;
    }
    break;
  }
  return out;
}

/**
 * 点击确认弹窗中的"确定"（唯一候选；二次定位核验）。
 * 严格条件：可见弹窗文本须与 expectedAction 精确一致；弹窗内"确定"类候选恰好 1 个。
 * 任何不满足 → 返回 { ok:false, reason }，零点击。自包含：不引用模块级函数。
 *
 * 参数为单对象 { action, expectedCount }（page.evaluate 只接受单个参数，且数组会被视为
 * 多参数展开，故必须用对象承载）。
 */
function clickChengfangConfirmOkInPage({ action, expectedCount }) {
  const expectedAction = action;
  const wantKind = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
    : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
      : (expectedAction === 'batch_enable' ? 'batch_enable_confirm'
        : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : null)));
  if (!wantKind) return { ok: false, reason: `动作 ${expectedAction} 无确认弹窗结构定义，零点击` };
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    let kind = null; let count = null;
    if (t.includes('删除')) kind = 'delete_confirm';
    else {
      const mPause = /确定要暂停\s*(\d+)\s*条计划吗/.exec(t);
      if (mPause) { count = Number(mPause[1]); kind = (expectedAction === 'batch_pause') ? 'batch_pause_confirm' : 'unexpected_confirm'; }
      else if (/确定关闭乘方投放吗/.test(t)) kind = (expectedAction === 'shop_disable') ? 'shop_disable_confirm' : 'unexpected_confirm';
      else if (t.includes('为保证投放的唯一性') && t.includes('受到互斥影响') && t.includes('乘方投放')) kind = (expectedAction === 'shop_enable') ? 'shop_enable_confirm' : 'unexpected_confirm';
      else if (t.includes('确定') || t.includes('确认')) kind = 'unknown_confirm';
      else kind = 'other';
    }
    if (kind !== wantKind) continue;
    if (expectedCount != null && count != null && count !== expectedCount) {
      return { ok: false, reason: `弹窗数量不匹配：期望 ${expectedCount}，弹窗 ${count}，零点击` };
    }
    const okBtns = [...el.querySelectorAll('button')].filter((b) => {
      const bt = (b.textContent || '').replace(/\s+/g, '').trim();
      return bt === '确定' || bt === '确认' || bt === '确认暂停' || bt === '确认关闭';
    });
    if (okBtns.length !== 1) return { ok: false, reason: `"确定"候选数为 ${okBtns.length}（要求恰好 1 个），零点击` };
    okBtns[0].click();
    return { ok: true, kind: wantKind, count };
  }
  return { ok: false, reason: `未找到与动作 ${expectedAction} 匹配的确认弹窗，零点击` };
}

/** 是否存在可见的删除确认弹窗（删除零点击守卫；在任何点击前调用）。自包含。 */
function hasChengfangDeleteDialogInPage() {
  const cands = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="confirm"], [class*="popconfirm"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  for (const el of cands) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.includes('删除')) return { found: true, text: t.slice(0, 200) };
  }
  return { found: false };
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
 * 行内投放开关句柄解析（内部工具；不导出）。
 *
 * 2026-09-15 修复（交接第 1 项）：实测真实点击目标是**内层** `.ovui-switch[data-e2e="switch"]`。
 * 外层 `.oc-switch` 只是容器/包装（点击它不改变投放状态）；历史 `wrappers[0].click()`
 * 点击外层即为「首次点击不落地」的已知成因之一。
 *
 * 严格条件（任一不满足即拒绝，零点击）：
 *   - 行文本必须含精确 `ID：<planId>` 或 `ID:<planId>`（全等核验，非模糊包含）
 *   - 行内 `.oc-switch` 容器恰好 1 个
 *   - 该容器内 `.ovui-switch[data-e2e="switch"]` 内层开关恰好 1 个
 * 返回 { ok, el } 或 { ok:false, reason }。
 */
function resolveChengfangRowSwitchHandle(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  // 全等核验：优先取行内"ID：xxx"精确标注（避免 123 命中 12345）
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];

  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };

  // 内层实际开关：优先精确 data-e2e=switch；退化也只接受 ovui-switch 类名（仍是内层）。
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) {
    el = inner[0];
  } else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) {
    return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  }
  return { ok: true, el, wrapperCount: wrappers.length, innerCount };
}

/**
 * 行内投放开关解析（浏览器内联版；与 resolveChengfangRowSwitchHandle 逻辑逐字一致）。
 * page.evaluate 序列化不支持闭包引用模块级函数，故独立自包含定义；二者须同步修改。
 *
 * 严格条件（任一不满足即拒绝，零点击）：
 *   - 行文本必须含精确 `ID：<planId>` 或 `ID:<planId>`（全等核验，非模糊包含）
 *   - 行内 `.oc-switch` 容器恰好 1 个
 *   - 该容器内 `.ovui-switch[data-e2e="switch"]`（退化 `.ovui-switch`）内层开关恰好 1 个
 * 返回 { ok, el } 或 { ok:false, reason }。
 */
function resolveChengfangRowSwitchHandleInPage(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  return { ok: true, el, wrapperCount: wrappers.length, innerCount };
}

/**
 * 定位指定计划行内的投放开关（不点击）。
 * 供 clickRowSwitch 的"定位 → 最终检查(beforeDispatch) → 实际点击"两段式。
 * 自包含（可被 page.evaluate 序列化）。
 */
function locateChengfangRowSwitchInPage(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝定位开关' };
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  const cls = String(el.className || '');
  const beforeChecked = cls.includes('ovui-switch--checked') || !!el.querySelector('.ovui-switch--checked');
  return { ok: true, wrapperCount: wrappers.length, innerCount, beforeChecked, checkedAttr: el.getAttribute('aria-checked') || null };
}

/**
 * 点击指定计划行内的投放开关（全店托管总开关用；execute 门禁控制，绝不用于删除）。
 * 2026-09-15 修复：点击**内层** `.ovui-switch[data-e2e="switch"]`，不再点外层 `.oc-switch`。
 * 自包含（可被 page.evaluate 序列化）。
 */
function clickChengfangRowSwitchByPlanId(planId) {
  const want = String(planId == null ? '' : planId).trim();
  if (!want) return { ok: false, reason: '计划ID为空，拒绝点击开关' };
  const trs = [...document.querySelectorAll('tr.ovui-tr')];
  const marked = [];
  for (const tr of trs) {
    const txt = tr.textContent || '';
    const m = /ID[:：]\s*([0-9]{6,24})/.exec(txt);
    if (m && m[1] === want) marked.push(tr);
  }
  if (marked.length === 0) return { ok: false, reason: `未找到计划ID ${want} 所在行（ID 全等核验）` };
  if (marked.length > 1) return { ok: false, reason: `计划ID ${want} 匹配到 ${marked.length} 行，拒绝点击` };
  const target = marked[0];
  const wrappers = [...target.querySelectorAll('.oc-switch')];
  if (wrappers.length === 0) return { ok: false, reason: `计划ID ${want} 行内未找到投放开关容器` };
  if (wrappers.length > 1) return { ok: false, reason: `计划ID ${want} 行内出现 ${wrappers.length} 个开关容器，拒绝点击` };
  const inner = [...wrappers[0].querySelectorAll('.ovui-switch[data-e2e="switch"]')];
  let el = null;
  let innerCount = inner.length;
  if (innerCount === 1) el = inner[0];
  else {
    const byClass = [...wrappers[0].querySelectorAll('.ovui-switch')];
    innerCount = byClass.length;
    if (innerCount === 1) el = byClass[0];
  }
  if (!el) return { ok: false, reason: `计划ID ${want} 行内层实际开关数量为 ${innerCount}（要求恰好 1 个），拒绝点击` };
  const cls = String(el.className || '');
  const beforeChecked = cls.includes('ovui-switch--checked') || !!el.querySelector('.ovui-switch--checked');
  const beforeAria = el.getAttribute('aria-checked');
  el.click();
  return { ok: true, beforeChecked, beforeAria, target: 'inner-ovui-switch' };
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

  /**
   * 确认弹窗提交闭环（内部）：点击业务按钮后调用。
   * - 无可见弹窗：返回 { submitted:false, reason:'no-dialog' }（如实报告，不编造）
   * - 有弹窗且类型/数量与 expectedAction 精确一致 → 经 beforeDispatch 再校验后点"确定"
   * - 删除弹窗/未知弹窗/类型或数量不符 → 抛 DataGuardError（阻断，绝不点确定）
   */
  /**
   * 确认弹窗提交闭环（内部）：点击业务按钮后调用。
   * - 无可见弹窗：返回 { submitted:false, reason:'no-dialog' }（如实报告，不编造）
   * - 有弹窗且类型/数量与 expectedAction 精确一致 → 经 beforeDispatch 再校验后点"确定"
   * - 删除弹窗/未知弹窗/类型或数量不符 → 抛 DataGuardError（阻断，绝不点确定）
   *
   * 等待策略（fail-closed 与延迟的平衡）：
   *   - 首选**立即**读取一次（点击后同步渲染的弹窗此刻已在 DOM，正常路径零延迟）；
   *   - 仅当首读为空时，才在 timeoutMs 内短轮询补齐（应对异步渲染）；
   *   - 任何时刻读到弹窗即立即处理，不再白等。
   */
  const submitConfirmIfPresent = async ({ page, expectedAction, expectedCount, timeoutMs = 800 }) => {
    const KNOWN_ACTIONS = ['batch_pause', 'batch_enable', 'shop_disable', 'shop_enable'];
    const deadline = Date.now() + timeoutMs;
    let dlg = null;
    while (true) {
      // 删除弹窗优先拦截（零点击守卫），无论动作。
      // fail-closed：读取异常绝不当作"无弹窗"，必须抛 DataGuardError 阻断提交。
      let del;
      try {
        del = await page.evaluate(hasChengfangDeleteDialogInPage);
      } catch (e) {
        throw new DataGuardError(`删除弹窗检测失败，停止提交（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (del && del.found) {
        throw new DataGuardError(`检测到删除确认弹窗，停止提交（绝不确认删除）：${del.text}`);
      }
      let raw;
      try {
        raw = await page.evaluate(readChengfangConfirmDialogInPage, expectedAction);
      } catch (e) {
        throw new DataGuardError(`确认弹窗读取失败，停止提交（读取异常）：${e.reason || e.message}`);
      }
      if (raw && raw.found) { dlg = raw; break; }
      if (Date.now() >= deadline) break;
      await sleep(300);
    }
    if (!dlg) return { submitted: false, reason: 'no-dialog' };

    // 未实测/无确认语义的动作：一旦出现任何确认弹窗即阻断（不编造结构）
    if (!KNOWN_ACTIONS.includes(expectedAction)) {
      throw new DataGuardError(`动作 ${expectedAction} 的确认弹窗结构未实测，检测到弹窗即阻断（不盲点确定）：${dlg.kind}:${dlg.text}`);
    }
    const wantKind = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
      : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
        : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : 'batch_enable_confirm'));
    if (dlg.kind !== wantKind) {
      throw new DataGuardError(`确认弹窗类型与当前动作不符，停止提交：期望 ${wantKind}，实际 ${dlg.kind}（${dlg.text}）`);
    }
    if (expectedCount != null && dlg.count != null && dlg.count !== expectedCount) {
      throw new DataGuardError(`确认弹窗数量与当前动作不符，停止提交：期望 ${expectedCount}，弹窗 ${dlg.count}`);
    }
    if (dlg.okCandidateCount !== 1) {
      throw new DataGuardError(`确认弹窗"确定"候选数为 ${dlg.okCandidateCount}（要求恰好 1 个），停止提交`);
    }
    // 提交前再次执行最终门禁：停止/跨日/许可关闭 → 不点确定（避免"点了暂停按钮后却在此刻被停"）
    await fireBeforeDispatch({ page });
    const r = await page.evaluate(clickChengfangConfirmOkInPage, { action: expectedAction, expectedCount }).catch((e) => ({ ok: false, reason: String(e) }));
    if (!r || r.ok !== true) {
      throw new DataGuardError(`确认弹窗提交失败：${(r && r.reason) || '未点击确定'}`);
    }
    await sleep(1500);
    return { submitted: true, kind: wantKind, count: r.count == null ? dlg.count : r.count };
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
     * 点击批量"暂停"并完成确认闭环（防误删：只接受精确定位且带标记的唯一"暂停"按钮）。
     *
     * 闭环步骤（2026-09-15 修复，交接第 2 项）：
     *   1. 点击前：检测删除弹窗/非预期弹窗（expectedAction='batch_pause'）→ 有则阻断
     *   2. 定位唯一"暂停"按钮 → beforeDispatch 最终门禁 → 派发点击
     *   3. 点击后：读取确认弹窗，必须为 batch_pause_confirm 且数量精确等于 expectedCount
     *      未知/删除/数量不符 → 阻断（不点确定）
     *   4. beforeDispatch 再执行一次 → 点击弹窗"确定"（唯一候选）
     * @param {object} o { page, expectedCount }
     */
    async clickBatchPause({ page, expectedCount = null }) {
      // 检测失败必须阻断点击（抛 DataGuardError，绝不 catch 成"无弹窗"）
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_pause');
      } catch (e) {
        throw new DataGuardError(`弹窗检测失败，停止点击批量"暂停"（检测异常）：${e.reason || e.message}`);
      }
      const blocking = danger.filter((d) => d.kind !== 'batch_pause_confirm');
      if (blocking.length > 0) {
        throw new DataGuardError(`检测到阻断性弹窗，停止点击：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
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
      // 确认闭环：真实页面点击后会弹出确认，必须提交；未弹窗视为不需要确认（如实返回）
      return await submitConfirmIfPresent({ page, expectedAction: 'batch_pause', expectedCount });
    },

    /**
     * 点击批量"开启"并完成确认闭环（防误删：只接受精确定位且带标记的唯一"开启"按钮）。
     * 开启弹窗结构未实测 → 若出现确认弹窗且无法精确匹配 batch_enable_confirm，一律阻断
     * （不编造、不盲点确定）。
     * @param {object} o { page, expectedCount }
     */
    async clickBatchEnable({ page, expectedCount = null }) {
      // 检测失败必须阻断点击（抛 DataGuardError，绝不 catch 成"无弹窗"）
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_enable');
      } catch (e) {
        throw new DataGuardError(`弹窗检测失败，停止点击批量"开启"（检测异常）：${e.reason || e.message}`);
      }
      const blocking = danger.filter((d) => d.kind !== 'batch_enable_confirm');
      if (blocking.length > 0) {
        throw new DataGuardError(`检测到阻断性弹窗，停止点击：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
      }
      const found = await page.evaluate(findChengfangBatchEnableButtonInPage).catch((e) => ({ error: String(e) }));
      if (!found || found.ok !== true) {
        throw new DataGuardError(`批量"开启"按钮无法唯一定位，零点击：${(found && found.reason) || '定位失败'}`);
      }
      // 最终检查（贴近点击）：最后一次页面检查（定位/弹窗检测）完成后、DOM 点击派发前。
      await fireBeforeDispatch({ page });
      // 二次定位并点击（与 findChengfangBatchEnableButtonInPage 同一严格条件），结果回传核验
      const clicked = await page.evaluate(() => {
        const bars = document.querySelectorAll('.oc-promotion-batch-operation-bar, .batch-action-bar');
        let bar = null;
        for (const b of bars) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { bar = b; break; }
        }
        if (!bar) return false;
        const btns = [...bar.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '开启');
        if (btns.length !== 1) return false;
        const b = btns[0];
        const autoId = b.getAttribute('data-auto-id') || '';
        const e2e = b.getAttribute('data-e2e') || '';
        if (!/btn-open$/.test(autoId) && !/_open$/.test(e2e)) return false;
        b.click();
        return true;
      }).catch((e) => ({ error: String(e) }));
      if (clicked !== true) {
        throw new DataGuardError('批量"开启"按钮二次定位不一致，零点击');
      }
      await sleep(1500);
      await submitConfirmIfPresent({ page, expectedAction: 'batch_enable', expectedCount });
    },

    /**
     * 点击指定计划行内投放开关（全店托管总开关用；严格单候选定位）。
     * 点击前检测删除/非预期弹窗；点击后若有确认弹窗则走 exact 提交闭环。
     * @param {object} o { page, planId, expectAction }
     *   expectAction: 'shop_disable'（关闭托管，实测弹窗「确定关闭乘方投放吗？」）
     *               | 'shop_enable'（开启托管，弹窗结构未实测→出现未知确认弹窗即阻断）
     *               | null（默认，无确认弹窗语义）
     */
    async clickRowSwitch({ page, planId, expectAction = null }) {
      // 点击前：先查删除弹窗（零点击守卫），再查与动作匹配的确认弹窗。
      // fail-closed：两处检测的 page.evaluate 异常都必须在**任何业务点击派发之前**抛
      // DataGuardError（此时零业务点击），绝不 catch 成"无弹窗"后继续点击。
      let del0;
      try {
        del0 = await page.evaluate(hasChengfangDeleteDialogInPage);
      } catch (e) {
        throw new DataGuardError(`点击前删除弹窗检测失败，零点击阻断（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (del0 && del0.found) {
        throw new DataGuardError(`点击前行内开关前检测到删除确认弹窗，停止：${del0.text}`);
      }
      let danger;
      try {
        danger = await page.evaluate(detectChengfangDangerDialogInPage, expectAction);
      } catch (e) {
        throw new DataGuardError(`点击前危险弹窗检测失败，零点击阻断（读取异常，绝不视为无弹窗）：${e.reason || e.message}`);
      }
      if (!Array.isArray(danger)) {
        throw new DataGuardError('点击前危险弹窗检测返回非列表，零点击阻断（无法确认无弹窗）');
      }
      {
        // 与当前动作精确一致的确认弹窗（托管关闭/托管开启实测句式）不算阻断
        const isExpectedConfirm = (d) => (expectAction === 'shop_disable' && d.kind === 'shop_disable_confirm')
          || (expectAction === 'shop_enable' && d.kind === 'shop_enable_confirm');
        const blocking = danger.filter((d) => !isExpectedConfirm(d));
        if (blocking.length > 0) {
          throw new DataGuardError(`检测到阻断性弹窗，停止点击行内开关：${blocking.map((d) => `${d.kind}:${d.text}`).join('；')}`);
        }
      }
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
      // 托管关闭实测有确认弹窗；开启弹窗未实测 → 出现未知确认弹窗时 submitConfirmIfPresent 会阻断
      const act = expectAction === 'shop_disable' ? 'shop_disable'
        : (expectAction === 'shop_enable' ? 'shop_enable' : 'row_toggle');
      const sub = await submitConfirmIfPresent({ page, expectedAction: act, expectedCount: null });
      return { clicked: true, beforeChecked: r.beforeChecked, confirm: sub };
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

    /**
     * 检测阻断性弹窗（删除/未知/与当前动作不符）。expectedAction 可选；
     * 未传时任何"确定/确认"弹窗都视为阻断（保守）。
     */
    async detectDanger({ page, expectedAction = null }) {
      // 检测失败必须抛出（执行器据此停止后续点击）；绝不 catch 成"无弹窗"
      const list = await page.evaluate(detectChengfangDangerDialogInPage, expectedAction);
      if (!Array.isArray(list)) return [];
      if (!expectedAction) return list.filter((d) => d.kind !== 'other' && d.kind !== 'empty');
      const allow = expectedAction === 'batch_pause' ? 'batch_pause_confirm'
        : (expectedAction === 'shop_disable' ? 'shop_disable_confirm'
          : (expectedAction === 'batch_enable' ? 'batch_enable_confirm'
            : (expectedAction === 'shop_enable' ? 'shop_enable_confirm' : null)));
      return list.filter((d) => d.kind !== allow);
    },

    /** 读取当前确认弹窗（只读；供执行器记录/审计）。 */
    async readConfirmDialog({ page, expectedAction = null }) {
      return page.evaluate(readChengfangConfirmDialogInPage, expectedAction);
    },

    /** 是否存在可见删除确认弹窗（零点击守卫；执行器任意点击前调用）。 */
    async hasDeleteDialog({ page }) {
      return page.evaluate(hasChengfangDeleteDialogInPage);
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
  findChengfangBatchEnableButtonInPage,
  findChengfangBatchDeleteButtonInPage,
  readChengfangBatchBarInPage,
  clickChengfangRowSwitchByPlanId,
  locateChengfangRowSwitchInPage,
  resolveChengfangRowSwitchHandle,
  setChengfangRowCheckboxByPlanId,
  detectChengfangDangerDialogInPage,
  classifyDialogText,
  readChengfangConfirmDialogInPage,
  clickChengfangConfirmOkInPage,
  hasChengfangDeleteDialogInPage,
  clickChengfangNextPageInPage,
  clickChengfangFirstPageInPage,
  readChengfangAccountInPage,
  openChengfangShop,
  createChengfangController,
  closeBrowser,
  CHENGFANG_URL_MARKER,
  SUB_TAB_OPTIONS,
};
