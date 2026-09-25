'use strict';

/**
 * 多店铺紧凑控制台（node:http，无额外依赖）。
 *
 * 主信息（每店一行）：店铺名称 · 广告状态 · 上次更新 · 广告费 · 订单数 · 阈值 · 操作。
 * 操作：立即更新（只读）· 修改（默认隐藏输入框）· 删除（确认后软删）。
 * 批量：开始监控 / 停止监控 作用于全部未删除店铺。
 * 安全：不展示 Cookie/令牌/密钥；立即更新零广告动作；删除后调度与手动接口再次校验活动列表。
 */

const http = require('http');
const { scrubDeep } = require('../lib/log');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>抖店推广值守 · 多店铺控制台</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 20px; background: #f5f6f8; color: #222; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:10px; font-size:12px; margin-right:6px; }
  .on { background:#e6f4ea; color:#1a7f37; }
  .off { background:#eee; color:#666; }
  .mixed { background:#fff3cd; color:#8a6d3b; }
  .unknown { background:#fde8e8; color:#b42318; }
  .dry { background:#e6f4ea; color:#1a7f37; }
  .real { background:#fde8e8; color:#b42318; }
  .warn { background:#fff3cd; color:#8a6d3b; }
  table { border-collapse: collapse; width: 100%; background:#fff; font-size: 13px; }
  th, td { border: 1px solid #e2e2e2; padding: 6px 8px; text-align: left; vertical-align: middle; }
  th { background: #fafafa; font-weight: 600; }
  button { padding: 4px 10px; margin: 0 2px; cursor: pointer; font-size: 12px; border: 1px solid #ccc; background:#fff; border-radius: 4px; }
  button.primary { background: #1a7f37; color: #fff; border: none; }
  button.danger { background: #b42318; color: #fff; border: none; }
  button.ghost { background:#f7f7f7; }
  .muted { color: #888; font-size: 12px; }
  .ok { color:#1a7f37; font-weight:bold; }
  .bad { color:#b42318; }
  #msg { margin: 8px 0; min-height: 18px; font-size: 13px; }
  .toolbar { margin-bottom: 10px; }
  .edit-box { display:none; background:#f8fafc; border-top:1px dashed #ddd; padding:8px; }
  .edit-box.open { display:block; }
  .edit-box label { font-size: 12px; color:#555; margin-right: 6px; }
  .edit-box input { padding: 3px 6px; font-size: 12px; width: 110px; margin-right: 8px; }
  .ops-wrap { position: relative; display: inline-block; }
  .ops-menu { display:none; position:absolute; right:0; top:100%; z-index:10; background:#fff; border:1px solid #ccc; border-radius:6px; min-width:100px; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .ops-menu.open { display:block; }
  .ops-menu button { display:block; width:100%; margin:0; border:none; border-radius:0; text-align:left; padding:8px 12px; }
  .ops-menu button:hover { background:#f5f5f5; }
  details { margin-top: 16px; }
  summary { cursor:pointer; font-size:13px; color:#555; }
  pre { background:#fff; padding:8px; border:1px solid #ddd; white-space:pre-wrap; font-size:12px; max-height:200px; overflow:auto; }
</style>
</head>
<body>
<h1>抖店推广值守 · 多店铺控制台
  <span id="mode" class="badge off">加载中…</span>
  <span id="run" class="badge off"></span>
</h1>
<div class="toolbar">
  <button id="btn-start" class="primary">开始监控</button>
  <button id="btn-stop" class="danger">停止监控</button>
  <span class="muted">批量作用于下方全部未删除店铺的超额巡查；<b>不影响</b>独立的每日 07:00 自动开启任务 · 立即更新只读，不触发广告开关 · 推广广告控制仅抖店</span>
</div>
<div id="msg" class="muted"></div>

<h2 style="font-size:15px;border-left:4px solid #4a7;padding-left:8px;">店铺列表</h2>
<table id="shops">
  <thead>
    <tr>
      <th>店铺名称</th>
      <th>广告状态</th>
      <th>上次数据更新</th>
      <th>广告费</th>
      <th>订单数</th>
      <th>当前阈值</th>
      <th style="width:220px;">操作</th>
    </tr>
  </thead>
  <tbody id="shopBody"><tr><td colspan="7" class="muted">加载中…</td></tr></tbody>
</table>

<details>
  <summary>更多：调度摘要 / 最近错误（已压缩事件、批次、过程明细）</summary>
  <div id="sched" class="muted" style="margin:8px 0;"></div>
  <div id="errors" class="muted"></div>
</details>

<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function adBadge(st) {
  var map = { on: ['开启', 'on'], off: ['暂停', 'off'], mixed: ['混合', 'mixed'], unknown: ['未知', 'unknown'] };
  var m = map[st] || map.unknown;
  return '<span class="badge ' + m[1] + '">' + m[0] + '</span>';
}
function yuan(cents) {
  if (cents == null) return '—';
  return (cents / 100).toFixed(2) + ' 元';
}
async function api(p, method, body) {
  var o = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) o.body = JSON.stringify(body);
  var r = await fetch(p, o);
  return r.json();
}
function showMsg(m, cls) {
  var el = document.getElementById('msg');
  el.textContent = m || '';
  el.className = 'muted' + (cls ? ' ' + cls : '');
}

var openMenuId = null;
function toggleOps(id) {
  var m = document.getElementById('ops-' + id);
  var wasOpen = openMenuId === id;
  document.querySelectorAll('.ops-menu.open').forEach(function(x){ x.classList.remove('open'); });
  if (!wasOpen && m) { m.classList.add('open'); openMenuId = id; }
  else openMenuId = null;
}
function closeOps() {
  document.querySelectorAll('.ops-menu.open').forEach(function(x){ x.classList.remove('open'); });
  openMenuId = null;
}
document.addEventListener('click', function(e) {
  if (!e.target.closest || !e.target.closest('.ops-wrap')) closeOps();
});

function openEdit(id) {
  closeOps();
  var box = document.getElementById('edit-' + id);
  if (box) box.classList.add('open');
}
function closeEdit(id) {
  var box = document.getElementById('edit-' + id);
  if (box) box.classList.remove('open');
}

async function saveEdit(id) {
  var box = document.getElementById('edit-' + id);
  if (!box) return;
  var nameEl = box.querySelector('.ename');
  var thrEl = box.querySelector('.ethr');
  var displayName = nameEl ? nameEl.value : '';
  var thrYuan = thrEl ? parseFloat(thrEl.value) : NaN;
  var body = { shopId: id };
  if (displayName) body.displayName = displayName;
  if (!isNaN(thrYuan) && thrYuan > 0) body.thresholdCents = Math.round(thrYuan * 100);
  var r = await api('/api/shop/update', 'POST', body);
  if (r.ok) {
    showMsg('已保存：' + (r.displayName || id) + '，阈值 ' + ((r.thresholdCents || 0) / 100).toFixed(2) + ' 元/单（已落盘）', 'ok');
    closeEdit(id);
    refresh();
  } else {
    showMsg('保存失败：' + (r.reason || '未知') + (r.rolledBack ? '（内存已回滚）' : ''), 'bad');
  }
}

async function doRefreshShop(id) {
  closeOps();
  showMsg('正在更新 ' + id + '（只读）…');
  var r = await api('/api/shop/refresh', 'POST', { shopId: id });
  if (r.ok) {
    showMsg('已更新 ' + id + '（只读，零广告动作）', 'ok');
  } else {
    showMsg('更新失败：' + (r.reason || '未知'), 'bad');
  }
  refresh();
}

async function doDeleteShop(id, name) {
  closeOps();
  var label = name || id;
  if (!confirm('确定删除店铺「' + label + '」？\\n删除后停止值守/轮询/自动启停/手动操作；历史状态与 Cookie 文件保留。\\n不影响其他店铺的在途任务。')) return;
  var r = await api('/api/shop/delete', 'POST', { shopId: id });
  if (r.ok) {
    showMsg('已删除 ' + label + '（历史与 Cookie 已保留）', 'ok');
  } else {
    showMsg('删除失败：' + (r.reason || '未知') + (r.rolledBack ? '（内存已回滚）' : ''), 'bad');
  }
  refresh();
}

function renderShops(rows) {
  var body = document.getElementById('shopBody');
  // 刷新前记录正在填写的编辑框（避免清空用户输入）
  var editState = {};
  document.querySelectorAll('.edit-box.open').forEach(function(box) {
    var id = box.getAttribute('data-shop-id');
    if (!id) return;
    var nameEl = box.querySelector('.ename');
    var thrEl = box.querySelector('.ethr');
    editState[id] = {
      open: true,
      displayName: nameEl ? nameEl.value : '',
      thresholdYuan: thrEl ? thrEl.value : '',
    };
  });
  if (!rows || rows.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="muted">暂无活动店铺</td></tr>';
    return;
  }
  // 用 DOM 构建 + data-id / data-name，不用字符串拼 onclick（防引号注入）
  body.innerHTML = '';
  rows.forEach(function(s) {
    var tr = document.createElement('tr');
    var thr = s.thresholdCents != null ? (s.thresholdCents / 100).toFixed(2) + ' 元/单' : '—';
    var td1 = document.createElement('td');
    var b = document.createElement('b');
    b.textContent = s.displayName || s.name || s.id;
    var div = document.createElement('div');
    div.className = 'muted';
    div.textContent = s.id;
    td1.appendChild(b); td1.appendChild(div);
    var td2 = document.createElement('td');
    td2.innerHTML = adBadge(s.adState);
    var td3 = document.createElement('td');
    td3.textContent = fmtTime(s.lastDataAt);
    var td4 = document.createElement('td');
    td4.textContent = s.costText || yuan(s.costCents);
    var td5 = document.createElement('td');
    td5.textContent = s.orders == null ? '—' : (s.orders + ' 单');
    var td6 = document.createElement('td');
    td6.textContent = thr;
    var td7 = document.createElement('td');

    var btnRefresh = document.createElement('button');
    btnRefresh.className = 'ghost';
    btnRefresh.textContent = '立即更新';
    btnRefresh.setAttribute('data-act', 'refresh');
    btnRefresh.setAttribute('data-id', s.id);

    var opsWrap = document.createElement('div');
    opsWrap.className = 'ops-wrap';
    var btnOps = document.createElement('button');
    btnOps.className = 'ghost';
    btnOps.textContent = '操作';
    btnOps.setAttribute('data-act', 'toggle-ops');
    btnOps.setAttribute('data-id', s.id);
    var opsMenu = document.createElement('div');
    opsMenu.className = 'ops-menu';
    opsMenu.id = 'ops-' + s.id;
    var btnEdit = document.createElement('button');
    btnEdit.textContent = '修改';
    btnEdit.setAttribute('data-act', 'edit');
    btnEdit.setAttribute('data-id', s.id);
    var btnDel = document.createElement('button');
    btnDel.textContent = '删除';
    btnDel.setAttribute('data-act', 'delete');
    btnDel.setAttribute('data-id', s.id);
    btnDel.setAttribute('data-name', s.displayName || s.name || s.id);
    opsMenu.appendChild(btnEdit);
    opsMenu.appendChild(btnDel);
    opsWrap.appendChild(btnOps);
    opsWrap.appendChild(opsMenu);

    var editBox = document.createElement('div');
    editBox.className = 'edit-box';
    editBox.id = 'edit-' + s.id;
    editBox.setAttribute('data-shop-id', s.id);
    var l1 = document.createElement('label');
    l1.textContent = '展示名称';
    var in1 = document.createElement('input');
    in1.className = 'ename';
    in1.maxLength = 100;
    in1.value = (editState[s.id] && editState[s.id].displayName) != null
      ? editState[s.id].displayName
      : (s.displayName || s.name || '');
    var d1 = document.createElement('div');
    d1.appendChild(l1); d1.appendChild(in1);
    var l2 = document.createElement('label');
    l2.textContent = '阈值(元/单)';
    var in2 = document.createElement('input');
    in2.className = 'ethr';
    in2.type = 'number';
    in2.step = '0.01';
    in2.min = '0.01';
    in2.value = (editState[s.id] && editState[s.id].thresholdYuan) != null && editState[s.id].thresholdYuan !== ''
      ? editState[s.id].thresholdYuan
      : (s.thresholdCents != null ? String(s.thresholdCents / 100) : '');
    var btnSave = document.createElement('button');
    btnSave.className = 'primary';
    btnSave.textContent = '保存';
    btnSave.setAttribute('data-act', 'save');
    btnSave.setAttribute('data-id', s.id);
    var btnCancel = document.createElement('button');
    btnCancel.className = 'ghost';
    btnCancel.textContent = '取消';
    btnCancel.setAttribute('data-act', 'cancel-edit');
    btnCancel.setAttribute('data-id', s.id);
    var d2 = document.createElement('div');
    d2.style.marginTop = '6px';
    d2.appendChild(l2); d2.appendChild(in2); d2.appendChild(btnSave); d2.appendChild(btnCancel);
    editBox.appendChild(d1);
    editBox.appendChild(d2);
    if (editState[s.id] && editState[s.id].open) editBox.classList.add('open');

    td7.appendChild(btnRefresh);
    td7.appendChild(opsWrap);
    td7.appendChild(editBox);
    [td1, td2, td3, td4, td5, td6, td7].forEach(function(td) { tr.appendChild(td); });
    body.appendChild(tr);
  });
}

// 事件委托：data-act / data-id，避免内联 onclick 与引号注入
document.getElementById('shopBody').addEventListener('click', function(e) {
  var t = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!t) return;
  var act = t.getAttribute('data-act');
  var id = t.getAttribute('data-id') || '';
  var name = t.getAttribute('data-name') || '';
  if (act === 'refresh') doRefreshShop(id);
  else if (act === 'toggle-ops') toggleOps(id);
  else if (act === 'edit') openEdit(id);
  else if (act === 'delete') doDeleteShop(id, name);
  else if (act === 'save') saveEdit(id);
  else if (act === 'cancel-edit') closeEdit(id);
});

async function refresh() {
  try {
    var s = await api('/api/status');
    var modeEl = document.getElementById('mode');
    modeEl.textContent = s.mode;
    modeEl.className = 'badge ' + (s.realMode ? 'real' : 'dry');
    var runEl = document.getElementById('run');
    runEl.textContent = s.monitor.running ? '监控运行中' : '监控已停止';
    runEl.className = 'badge ' + (s.monitor.running ? 'dry' : 'off');
    renderShops(s.shopRows || []);
    document.getElementById('sched').textContent =
      '调度：每日 ' + s.monitor.dailyStartHour + ':00 后 · 每 ' + s.monitor.intervalMinutes + ' 分钟'
      + ' ｜ 最近巡查 ' + fmtTime(s.monitor.lastCycleAt)
      + ' ｜ 下次 ' + fmtTime(s.monitor.nextRunAt)
      + (s.ready ? '' : ' ｜ 待配置：' + (s.pending || []).join('；'));
    document.getElementById('errors').innerHTML = (s.recentErrors && s.recentErrors.length)
      ? '<pre>' + esc(s.recentErrors.slice(0, 20).map(function(e){ return '[' + e.ts + '] ' + e.scope + ': ' + e.error; }).join('\\n')) + '</pre>'
      : '<span class="muted">无</span>';
  } catch (e) {
    showMsg('刷新失败：' + e.message, 'bad');
  }
}

document.getElementById('btn-start').onclick = async function() {
  var r = await api('/api/monitor/start', 'POST');
  if (r.ok) {
    var n = (r.activeShopCount != null) ? ('（活动店铺 ' + r.activeShopCount + ' 家）') : '';
    showMsg('监控已启动' + n + (r.alreadyRunning ? '（已在运行）' : ''), 'ok');
  } else {
    showMsg('启动失败：' + r.reason, 'bad');
  }
  refresh();
};
document.getElementById('btn-stop').onclick = async function() {
  var r = await api('/api/monitor/stop', 'POST');
  showMsg('监控已停止（已发出的关闭请求将继续回读确认）', r && r.ok ? '' : 'bad');
  refresh();
};

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); }
    });
  });
}

function createUiServer(monitor, port) {
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type) => {
      res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
      res.end(body);
    };
    // 出站统一脱敏（2026-09-24）：状态/原因文本可能携带上游错误里的疑似凭证，
    // 展示边界整包递归脱敏（值级 *** 标记，保留业务文案），原值不得出站。
    const sendJson = (code, obj) => send(code, JSON.stringify(scrubDeep(obj)));
    const url = (req.url || '').split('?')[0];

    if (url === '/' && req.method === 'GET') {
      return send(200, HTML, 'text/html; charset=utf-8');
    }
    if (url === '/api/status' && req.method === 'GET') {
      return sendJson(200, monitor.getStatus());
    }
    if (url === '/api/monitor/start' && req.method === 'POST') {
      const r = monitor.start();
      // 批量语义：作用于全部未删除店铺；如实报告活动店铺数
      try { r.activeShopCount = (monitor._activeShops ? monitor._activeShops() : (monitor.config.shops || [])).length; } catch (_) { /* 忽略 */ }
      return sendJson(200, r);
    }
    if (url === '/api/monitor/stop' && req.method === 'POST') {
      const r = monitor.stop();
      return sendJson(200, r);
    }
    if (url === '/api/poll' && req.method === 'POST') {
      // 保留兼容：全量只读巡查入口仍可用；真实关闭语义不变
      monitor.pollOnce('manual-ui').then((r) => sendJson(200, r));
      return;
    }
    if (url === '/api/shop/refresh' && req.method === 'POST') {
      const body = await readBody(req);
      const shopId = body && body.shopId;
      if (!shopId) return sendJson(200, { ok: false, reason: '缺少 shopId' });
      const r = await monitor.refreshShopData(String(shopId));
      return sendJson(200, r);
    }
    if (url === '/api/shop/update' && req.method === 'POST') {
      const body = await readBody(req);
      const shopId = body && body.shopId;
      if (!shopId) return sendJson(200, { ok: false, reason: '缺少 shopId' });
      const r = monitor.updateShop(String(shopId), {
        displayName: body.displayName,
        name: body.name,
        thresholdCents: body.thresholdCents,
      });
      return sendJson(200, r);
    }
    if (url === '/api/shop/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const shopId = body && body.shopId;
      if (!shopId) return sendJson(200, { ok: false, reason: '缺少 shopId' });
      const r = monitor.deleteShop(String(shopId));
      return sendJson(200, r);
    }
    sendJson(404, { error: 'not found' });
  });
  return { server, port };
}

module.exports = { createUiServer };
