'use strict';

/**
 * 乘方测试页面 fixture 生成器（供 chengfang-dom / chengfang-executor 测试）。
 *
 * 基于 2026-09-13 r9 只读实测结构：
 * - 子标签：.ovui-tabs__tab（商品自选/全店托管）
 * - 行：tr.ovui-tr，含 .oc-switch > .ovui-switch[--checked]、行文本 "名称 ID：<数字>"、.ad-status
 * - 分页：.ovui-page-total、.ovui-page-select input、li.ovui-page-turner__item（next-icon）
 * - 批量栏：.oc-promotion-batch-operation-bar（默认 display:none），按钮含
 *   data-auto-id="bar-groups-group-item-btn-pause/btn-open/btn-delete"（暂停/开启/删除）
 * - 表头全选框：th 内 label.ovui-checkbox[data-e2e="checkbox"]
 *
 * 页面内状态机模拟平台行为（全部为本地 fixture，点击只影响 fixture 数据）：
 * - checkbox 勾选/取消 → 批量栏显示与"已选N个"更新
 * - 表头全选框 → 按 scope 勾选当前页或跨全部页
 * - 批量暂停 → pauseEffect='ok' 时选中行 checked=false（shrink=true 时行从列表移除）；
 *   pauseEffect='first-noop' 模拟千川首次确认未落地、同会话第二次成功
 * - 批量开启 → enableEffect='ok' 时选中行 checked=true（shrink=true 时行从列表移除）；
 *   enableEffect='first-noop' 模拟首次确认未落地、同会话第二次成功；'noop' 恒不生效
 * - 行内开关点击 → 翻转 checked
 * - 每页条数切换（10/20/50/100）→ 重渲染
 * - 翻页（prev/next）→ 重渲染
 * - 所有业务点击写入 window.__CF.clickLog 供测试断言（删除必须零点击）
 */

function planRowHtml({ id, name, checked, status, selected }) {
  const sw = checked
    ? '<div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--checked ovui-switch--dark"><div class="ovui-switch__thumb"></div></div></div>'
    : '<div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--dark"><div class="ovui-switch__thumb"></div></div></div>';
  const cb = `<label class="ovui-checkbox"><input type="checkbox" class="row-cb" data-plan="${id}" ${selected ? 'checked' : ''}></label>`;
  return `<tr class="ovui-tr" data-plan="${id}">
    <td>${cb}</td>
    <td>${sw}</td>
    <td>${name} ID：${id}</td>
    <td><span class="ad-status">${status || '已暂停'}</span></td>
    <td><span class="oc-promotion-operation-action-item">编辑</span><span class="oc-promotion-operation-action-item">日志</span><span class="oc-promotion-operation-action-item">删除</span></td>
  </tr>`;
}

/**
 * 构建 fixture 页面 HTML + 状态机。
 * @param {object} opts
 * @param {object} opts.plans { '全店托管': [{id,name,checked}], '商品自选': [...] }
 * @param {object} opts.state  初始状态覆盖 { pageSize, shrink, pauseEffect, selectAllScope, view }
 * @param {string} [opts.navText] 导航文本（账户身份；默认与配置 accountId 一致）
 * @param {object} [opts.batchButtons] 批量栏按钮覆写（测试缺按钮/多候选）
 * @param {boolean} [opts.paginationMissing] 不渲染分页总数（模拟缺少数量的空态证据）
 */
function buildChengfangFixtureHtml(opts = {}) {
  const plans = opts.plans || { '全店托管': [], '商品自选': [] };
  const init = Object.assign({ view: '全店托管', pageSize: 10, shrink: false, pauseEffect: 'ok', enableEffect: 'ok', switchEffect: 'ok', slowLandingMs: 2500, selectAllScope: 'page', crossPageClearable: false }, opts.state || {});
  const navText = opts.navText !== undefined ? opts.navText : '首页 乘方 全域投放 品牌投放 数据 工具 财务 营销学堂 成长伙伴 99+ 伊人美 ID：1710242295996424';
  const batchOpen = (opts.batchButtons && opts.batchButtons.open !== undefined) ? opts.batchButtons.open : `<button data-auto-id="bar-groups-group-item-btn-open">开启</button>`;
  const batchPause = (opts.batchButtons && opts.batchButtons.pause !== undefined) ? opts.batchButtons.pause : `<button data-auto-id="bar-groups-group-item-btn-pause">暂停</button>`;
  const batchDelete = (opts.batchButtons && opts.batchButtons.delete !== undefined) ? opts.batchButtons.delete : `<button data-auto-id="bar-groups-group-item-btn-delete">删除</button>`;
  const extraDialog = opts.dialog || '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="qc-page-navigator-container"><span>${navText}</span></div>
<div class="ovui-tabs">
  <div class="ovui-tabs__tab" data-view="全店托管"><span class="ovui-tabs__tab-btn">全店托管</span></div>
  <div class="ovui-tabs__tab" data-view="商品自选"><span class="ovui-tabs__tab-btn">商品自选</span></div>
</div>
<div id="list"></div>
<div class="ovui-page-select"><input class="ovui-select__input" readonly value="10条/页" style="width:120px"></div>
<div id="pagebar"></div>
<div class="oc-promotion-batch-operation-bar" id="batchbar" style="display:none">
  <span id="batchtext">已选 0 个</span>
  ${batchOpen}${batchPause}${batchDelete}
</div>
<div id="options" style="display:none">
  <div class="ovui-option">10条/页</div>
  <div class="ovui-option">20条/页</div>
  <div class="ovui-option">50条/页</div>
  <div class="ovui-option">100条/页</div>
</div>
${extraDialog}
<script>
// 尝试计数持久化到 sessionStorage：模拟平台侧"首次未落地"状态不因页面跳转（page.goto
// 恢复乘方管理页）而重置；每次测试新建 page（新 context）天然隔离。
var __cfAttempts = null;
try { __cfAttempts = JSON.parse(sessionStorage.getItem('__cfAttempts') || 'null'); } catch (e) {}
window.__CF = {
  view: '${init.view}',
  page: 1,
  pageSize: ${init.pageSize},
  shrink: ${init.shrink},
  pauseEffect: '${init.pauseEffect}',
  pauseAttempts: (__cfAttempts && __cfAttempts.pause) || 0,
  enableEffect: '${init.enableEffect}',
  switchEffect: '${init.switchEffect}',
  slowLandingMs: ${init.slowLandingMs || 2500},
  enableAttempts: (__cfAttempts && __cfAttempts.enable) || 0,
  selectAllScope: '${init.selectAllScope}',
  crossPageClearable: ${init.crossPageClearable},
  paginationMissing: ${!!opts.paginationMissing},
  clickLog: [],
  selected: [],
  plans: ${JSON.stringify(plans)},
  readCalls: 0
};
function __cfSaveAttempts() {
  try {
    sessionStorage.setItem('__cfAttempts', JSON.stringify({ pause: window.__CF.pauseAttempts, enable: window.__CF.enableAttempts }));
  } catch (e) {}
}
// 测试钩子：向指定视图新增计划（模拟页面上新增/被恢复投放的对象）
window.__CF.addPlan = function (view, plan) {
  if (!window.__CF.plans[view]) window.__CF.plans[view] = [];
  window.__CF.plans[view].push(Object.assign({ status: '投放中' }, plan));
  window.__CF.page = 1;
  window.__CF.selected = [];
  render();
};
// 测试钩子：按稳定 ID 直接设置开关状态（模拟人工恢复投放/平台侧变化）
window.__CF.setChecked = function (id, checked) {
  for (const view of Object.keys(window.__CF.plans)) {
    const p = window.__CF.plans[view].find((x) => String(x.id) === String(id));
    if (p) { p.checked = !!checked; }
  }
  render();
};
// 测试钩子：移除指定计划（模拟目标行消失 → 状态未知，绝不当作已落地）
window.__CF.removePlan = function (id) {
  for (const view of Object.keys(window.__CF.plans)) {
    window.__CF.plans[view] = window.__CF.plans[view].filter((x) => String(x.id) !== String(id));
  }
  render();
};
function planRowHtml(r) {
  var sw = r.checked
    ? '<div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--checked ovui-switch--dark"><div class="ovui-switch__thumb"></div></div></div>'
    : '<div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--dark"><div class="ovui-switch__thumb"></div></div></div>';
  var cb = '<label class="ovui-checkbox"><input type="checkbox" class="row-cb" data-plan="' + r.id + '"' + (r.selected ? ' checked' : '') + '></label>';
  return '<tr class="ovui-tr" data-plan="' + r.id + '">' +
    '<td>' + cb + '</td>' +
    '<td>' + sw + '</td>' +
    '<td>' + r.name + ' ID：' + r.id + '</td>' +
    '<td><span class="ad-status">' + (r.status || '已暂停') + '</span></td>' +
    '<td><span class="oc-promotion-operation-action-item">编辑</span><span class="oc-promotion-operation-action-item">日志</span><span class="oc-promotion-operation-action-item">删除</span></td>' +
    '</tr>';
}
function curPlans() { return window.__CF.plans[window.__CF.view] || []; }
function pages() { return Math.max(1, Math.ceil(curPlans().length / window.__CF.pageSize)); }
function pageRows() {
  const p = window.__CF.page, s = window.__CF.pageSize;
  return curPlans().slice((p - 1) * s, p * s);
}
function isSelected(id) { return window.__CF.selected.indexOf(String(id)) >= 0; }
function render() {
  const rows = pageRows();
  const html = ['<table>'];
  html.push('<tr class="ovui-tr"><th><label class="ovui-checkbox" data-e2e="checkbox"><input type="checkbox" id="selall"></label></th><th>计划</th><th>状态</th><th>操作</th></tr>');
  for (const r of rows) {
    html.push(planRowHtml({ id: r.id, name: r.name, checked: r.checked, status: r.status, selected: isSelected(r.id) }));
  }
  html.push('</table>');
  document.getElementById('list').innerHTML = html.join('');
  const selIn = document.querySelector('.ovui-select__input');
  selIn.value = window.__CF.pageSize + '条/页';
  const total = curPlans().length;
  const pg = [];
  if (!window.__CF.paginationMissing) pg.push('<div class="ovui-page-total">共 ' + total + ' 条记录</div>');
  pg.push('<ul>');
  pg.push('<li class="ovui-page-turner__item' + (window.__CF.page <= 1 ? ' --disabled' : '') + '" id="prevp"><span class="ovui-page-turner__prev-icon"></span></li>');
  for (let i = 1; i <= pages(); i++) {
    pg.push('<li class="ovui-page-turner__item' + (i === window.__CF.page ? ' --active' : '') + '">' + i + '</li>');
  }
  pg.push('<li class="ovui-page-turner__item' + (window.__CF.page >= pages() ? ' --disabled' : '') + '" id="nextp"><span class="ovui-page-turner__next-icon"></span></li>');
  pg.push('</ul>');
  document.getElementById('pagebar').innerHTML = pg.join('');
  // 批量栏
  const bar = document.getElementById('batchbar');
  if (window.__CF.selected.length > 0) {
    bar.style.display = 'flex';
    document.getElementById('batchtext').textContent = '已选 ' + window.__CF.selected.length + ' 个';
  } else {
    bar.style.display = 'none';
  }
  // 全选框状态
  const sa = document.getElementById('selall');
  if (sa) {
    const allChecked = rows.length > 0 && rows.every((r) => isSelected(r.id));
    sa.checked = allChecked;
  }
  bind();
}
function bind() {
  // 子标签
  document.querySelectorAll('.ovui-tabs__tab').forEach((tab) => {
    tab.onclick = () => { window.__CF.view = tab.getAttribute('data-view'); window.__CF.page = 1; window.__CF.selected = []; render(); };
  });
  // 行 checkbox
  document.querySelectorAll('.row-cb').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.getAttribute('data-plan');
      if (cb.checked) { if (window.__CF.selected.indexOf(id) < 0) window.__CF.selected.push(id); }
      else {
        // 跨页全选可清除：取消任一可见行勾选即退出跨页选择模式（模拟平台"清除跨页选择"行为）
        if (window.__CF.selectAllScope === 'cross' && window.__CF.crossPageClearable) window.__CF.selected = [];
        else window.__CF.selected = window.__CF.selected.filter((x) => x !== id);
      }
      render();
    };
  });
  // 表头全选框
  const sa = document.getElementById('selall');
  if (sa) {
    sa.onchange = () => {
      const rows = sa.checked ? (window.__CF.selectAllScope === 'cross' ? curPlans() : pageRows()) : [];
      window.__CF.selected = rows.map((r) => String(r.id));
      render();
    };
  }
  // 行内开关
  document.querySelectorAll('.oc-switch').forEach((sw, i) => {
    sw.onclick = () => {
      const tr = sw.closest('tr');
      const id = tr.getAttribute('data-plan');
      const plan = curPlans().find((x) => String(x.id) === id);
      if (plan) {
        // 2026-09-16：模拟平台异步落地——点击已派发，开关状态稍后才翻转。
        // 用于验证"托管开关绝不因异步落地/超时不明而反向切换"。
        if (window.__CF.switchEffect === 'slow-landing') {
          window.__CF.clickLog.push({ type: 'switch', id });
          window.__CF.selected = [];
          setTimeout(() => {
            const p2 = curPlans().find((x) => String(x.id) === id);
            if (p2) p2.checked = !p2.checked;
            render();
          }, window.__CF.slowLandingMs || 2500);
          render();
          return;
        }
        plan.checked = !plan.checked;
        window.__CF.clickLog.push({ type: 'switch', id });
      }
      window.__CF.selected = [];
      render();
    };
  });
  // 批量按钮
  const bar = document.getElementById('batchbar');
  bar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const autoId = b.getAttribute('data-auto-id') || '';
      const text = (b.textContent || '').trim();
      window.__CF.clickLog.push({ type: /btn-pause$/.test(autoId) ? 'pause' : (/btn-delete$/.test(autoId) ? 'delete' : (/btn-open$/.test(autoId) ? 'enable' : text)), ids: window.__CF.selected.slice() });
      if (/btn-pause$/.test(autoId)) { window.__CF.pauseAttempts += 1; __cfSaveAttempts(); }
      if (/btn-open$/.test(autoId)) { window.__CF.enableAttempts += 1; __cfSaveAttempts(); }
      const selSet = new Set(window.__CF.selected);
      const view = window.__CF.view;
      if (/btn-pause$/.test(autoId) && (window.__CF.pauseEffect === 'ok' || (window.__CF.pauseEffect === 'first-noop' && window.__CF.pauseAttempts >= 2))) {
        if (window.__CF.shrink) {
          window.__CF.plans[view] = curPlans().filter((p) => !selSet.has(String(p.id)));
        } else {
          for (const p of curPlans()) if (selSet.has(String(p.id))) p.checked = false;
        }
      }
      if (/btn-open$/.test(autoId) && (window.__CF.enableEffect === 'ok' || (window.__CF.enableEffect === 'first-noop' && window.__CF.enableAttempts >= 2))) {
        if (window.__CF.shrink) {
          window.__CF.plans[view] = curPlans().filter((p) => !selSet.has(String(p.id)));
        } else {
          for (const p of curPlans()) if (selSet.has(String(p.id))) p.checked = true;
        }
      }
      // 2026-09-16：模拟平台异步落地延迟——点击已成功派发，但开关稍后才变更
      // （与今晨生产首次开启失败同因）。slow-landingMs 默认 2500ms。
      if (/btn-open$/.test(autoId) && window.__CF.enableEffect === 'slow-landing') {
        const landed = new Set(selSet);
        setTimeout(() => {
          if (window.__CF.shrink) {
            window.__CF.plans[view] = curPlans().filter((p) => !landed.has(String(p.id)));
          } else {
            for (const p of curPlans()) if (landed.has(String(p.id))) p.checked = true;
          }
          render();
        }, window.__CF.slowLandingMs || 2500);
      }
      // 暂停侧同一语义（2026-09-16 本轮补齐暂停侧落地确认的回归用）
      if (/btn-pause$/.test(autoId) && window.__CF.pauseEffect === 'slow-landing') {
        const landed = new Set(selSet);
        setTimeout(() => {
          if (window.__CF.shrink) {
            window.__CF.plans[view] = curPlans().filter((p) => !landed.has(String(p.id)));
          } else {
            for (const p of curPlans()) if (landed.has(String(p.id))) p.checked = false;
          }
          render();
        }, window.__CF.slowLandingMs || 2500);
      }
      window.__CF.selected = [];
      window.__CF.page = 1;
      render();
    };
  });
  // 分页器
  const np = document.getElementById('nextp');
  if (np) {
    np.onclick = () => {
      if (window.__CF.page >= pages()) return;
      window.__CF.page += 1;
      window.__CF.selected = [];
      render();
    };
  }
  const pp = document.getElementById('prevp');
  if (pp) {
    pp.onclick = () => {
      if (window.__CF.page <= 1) return;
      window.__CF.page -= 1;
      window.__CF.selected = [];
      render();
    };
  }
  // 每页条数下拉
  const selIn = document.querySelector('.ovui-select__input');
  if (selIn) {
    selIn.onclick = () => { document.getElementById('options').style.display = 'block'; };
  }
  document.querySelectorAll('#options .ovui-option').forEach((o) => {
    o.onclick = () => {
      const size = parseInt(o.textContent, 10);
      window.__CF.pageSize = size;
      window.__CF.page = 1;
      window.__CF.selected = [];
      document.getElementById('options').style.display = 'none';
      render();
    };
  });
}
render();
</script>
</body></html>`;
}

module.exports = { buildChengfangFixtureHtml };
