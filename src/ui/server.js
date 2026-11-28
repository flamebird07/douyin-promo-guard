'use strict';

/**
 * 多店铺紧凑控制台（node:http，无额外依赖）。
 *
 * 店铺扫码登录（2026-11-17）：工具栏「扫码登录店铺」→ /api/shop/qr-login 启动无头会话，
 * 抖店登录二维码直接显示在网页弹窗（/api/shop/qr-login/status 持续透出最新二维码），
 * 手机扫码成功后 Cookie 落盘并自动发现建店。服务仅监听 127.0.0.1，无控制台账号门禁
 * （用户 2026-11-17 明确不需要界面登录账号）。
 *
 * 主信息（每店一行）：店铺名称 · 广告状态 · Cookie · 上次更新 · 广告费 · 订单数 · 阈值 · 操作。
 * 操作：立即更新（只读）· 修改（默认隐藏输入框）· 删除（确认后软删）。
 * 批量：开始监控 / 停止监控 作用于全部未删除店铺。
 * 安全：不展示 Cookie/令牌/密钥；立即更新零广告动作；删除后调度与手动接口再次校验活动列表。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scrubDeep } = require('../lib/log');

// ── 店铺扫码登录（2026-11-17，网页内嵌二维码）────────────────────────
// 服务仅监听 127.0.0.1，本机使用，无控制台账号门禁（用户 2026-11-17 明确不需要）。
// 复用 src/login/qr-login.js 的 WebQrLoginSession：无头浏览器取抖店登录二维码 →
// 网页弹窗直接展示（用户手机扫码，无需弹出浏览器）→ 登录成功后 Cookie 写入项目
// cookies/<店铺名>.json → 立即调 monitor.requestShopDiscovery({force:true})
// （"登录成功后接管新店"的官方入口），新店铺自动进入 config.shops 与页面列表。
// 同一时刻只允许一个扫码会话；多店铺 = 逐店重复扫码（同名店铺重复扫会覆盖刷新其 Cookie）。
// 绝不自动改阈值/开关；发现关闭（cookieSourceDir 未配置）时如实透出提示。
const { WebQrLoginSession } = require('../login/qr-login');
let qrLoginJob = null; // { phase:'running'|'success'|'failed', session, startedAt, finishedAt, shopName, addedShops, discoveryHint, reason }
const qrLoginRunId = { value: 0 };

function qrLoginJobView() {
  if (!qrLoginJob) return { active: false, phase: 'idle', qrDataUrl: null };
  return {
    active: qrLoginJob.phase === 'running',
    phase: qrLoginJob.phase,
    startedAt: qrLoginJob.startedAt,
    finishedAt: qrLoginJob.finishedAt || null,
    shopName: qrLoginJob.shopName || null,
    addedShops: qrLoginJob.addedShops || null,
    discoveryHint: qrLoginJob.discoveryHint || null,
    reason: qrLoginJob.reason || null,
    // 最新二维码（data:image/png;base64,...；scrubDeep 不影响 base64 数据）
    qrDataUrl: (qrLoginJob.session && qrLoginJob.session.qrDataUrl) || null,
  };
}

function startWebQrLogin(monitor, factory) {
  if (qrLoginJob && qrLoginJob.phase === 'running') {
    return { ok: false, reason: '已有扫码登录会话进行中（扫码或 10 分钟超时后结束），请稍候', job: qrLoginJobView() };
  }
  const session = factory((monitor.config && monitor.config.login) || {});
  const job = { phase: 'running', session, startedAt: new Date().toISOString(), finishedAt: null, shopName: null, addedShops: null, discoveryHint: null, reason: null };
  qrLoginJob = job;
  const runId = ++qrLoginRunId.value;
  (async () => {
    try {
      const r = await session.start(); // 阻塞至扫码成功并保存 Cookie
      if (runId !== qrLoginRunId.value) return;
      job.shopName = (r && r.shopName) || null;
      job.phase = 'success';
      job.finishedAt = new Date().toISOString();
      try {
        const disc = monitor.requestShopDiscovery({ force: true });
        job.addedShops = (disc && Array.isArray(disc.added)) ? disc.added : null;
        if (disc && Array.isArray(disc.scannedDirs) && disc.scannedDirs.length === 0) {
          job.discoveryHint = '未扫描任何 Cookie 目录（login.cookieSourceDir 未配置且项目 cookies/ 不存在）——Cookie 文件已保存，但新店铺不会自动加入列表，请检查配置';
        }
        // 登录成功即自动拉取一次只读数据（2026-11-19）：与「立即更新」同一链路
        // （零广告动作），新店入列后约 1–2 分钟数据自动出现，无需手动点更新。
        const names = (job.addedShops && job.addedShops.length) ? job.addedShops : (job.shopName ? [job.shopName] : []);
        for (const name of names) {
          try { monitor.refreshShopData(String(name)).catch(() => {}); } catch (_) { /* 忽略单个店失败 */ }
        }
      } catch (e) {
        job.discoveryHint = `自动发现新店失败（Cookie 已保存，可稍后点"扫描已有 Cookie"重试）: ${e.message}`;
      }
    } catch (e) {
      if (runId !== qrLoginRunId.value) return;
      job.phase = 'failed';
      job.finishedAt = new Date().toISOString();
      job.reason = e.message || String(e);
    } finally {
      await session.close().catch(() => {});
    }
  })();
  return { ok: true, started: true, job: qrLoginJobView() };
}

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
  <button id="btn-qrlogin" title="弹出本机浏览器，用抖音 App 扫码登录抖店；每扫一次登录一家店，Cookie 自动保存并把店铺加入列表">扫码登录店铺</button>
  <button id="btn-rediscover" class="ghost" title="重新扫描 Cookie 目录（项目 cookies/ 与 login.cookieSourceDir），把已有 Cookie 文件补录为店铺">扫描已有 Cookie</button>
  <span class="muted">批量作用于下方全部未删除店铺的超额巡查；<b>不影响</b>独立的每日 <span id="firstCheck"></span> 首查开启任务 · 立即更新只读，不触发广告开关 · 推广广告控制仅抖店</span>
</div>
<div id="msg" class="muted"></div>

<h2 style="font-size:15px;border-left:4px solid #4a7;padding-left:8px;">店铺列表</h2>
<table id="shops">
  <thead>
    <tr>
      <th>店铺名称</th>
      <th>广告状态</th>
      <th title="本项目 cookies/ 或 login.cookieSourceDir 里的 Cookie 登录文件">Cookie</th>
      <th>取数状态</th>
      <th>广告费</th>
      <th>订单数</th>
      <th title="广告费 ÷ 订单数">费比</th>
      <th title="账户级数据，仅展示、不参与自动开关判定">千川可用余额</th>
      <th>当前阈值</th>
      <th title="操作→修改里保存的目标 ROI（缺省 15）">目标 ROI</th>
      <th title="操作→修改里保存的每店每日计划条数（整数 1..10，缺省回落全局默认 3）">每日计划</th>
      <th title="该店此刻的真实在途状态：值守巡查处理中 / 读取数据中 / 每日开启广告处理中 / 登录接管处理中；无在途即空闲">当前动作</th>
      <th title="计划发布（账本真实投影）：已成功/目标份数 + 最近一份状态与卡点原因。未配置发布则显示未启用">计划发布</th>
      <th style="width:220px;">操作</th>
    </tr>
  </thead>
  <tbody id="shopBody"><tr><td colspan="14" class="muted">加载中…</td></tr></tbody>
</table>

<details>
  <summary>更多：调度摘要 / 最近错误（已压缩事件、批次、过程明细）</summary>
  <div id="sched" class="muted" style="margin:8px 0;"></div>
  <div id="errors" class="muted"></div>
</details>

<div id="qr-mask" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:100;">
  <div style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); background:#fff; border-radius:8px; padding:20px 24px; width:420px; max-width:92vw; box-shadow:0 4px 20px rgba(0,0,0,.2);">
    <h3 style="margin:0 0 8px; font-size:15px;">扫码登录抖店</h3>
    <div style="text-align:center; margin:6px 0;">
      <img id="qr-img" style="width:220px; height:220px; display:none; border:1px solid #e2e2e2; border-radius:6px;" alt="抖店登录二维码">
      <div id="qr-loading" class="muted" style="width:220px; height:220px; line-height:220px; margin:0 auto; border:1px dashed #ccc; border-radius:6px; font-size:13px;">正在获取二维码…</div>
    </div>
    <div id="qr-body" class="muted" style="min-height:40px; font-size:13px; line-height:1.6; text-align:center;">打开手机「抖店App」扫上方二维码；二维码过期会自动刷新。</div>
    <div style="text-align:right; margin-top:10px;"><button id="qr-close" class="ghost">关闭</button></div>
  </div>
</div>

<script>
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
// Cookie 到期时间（epoch ms）：只返回「文件内最晚到期时间」这一事实值，无有效日期返回 null；
// 不推断登录是否有效、不把历史时间标成未来。缺日期既可能是会话型，也可能是缺少抖站域，
// 因此不在此断言会话型，由调用方按「无固定到期时间」中性呈现。
function fmtCookieExpire(ms) {
  if (ms == null || !isFinite(Number(ms)) || Number(ms) <= 0) return null;
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return null;
  return '文件内最晚到期时间：' + d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
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
function feeRatio(costCents, orders) {
  if (!Number.isSafeInteger(costCents) || costCents < 0 || !Number.isSafeInteger(orders) || orders <= 0) return '—';
  return (costCents / orders / 100).toFixed(2) + ' 元/单';
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
  var thrEl = box.querySelector('.ethr');
  var thrYuan = thrEl ? parseFloat(thrEl.value) : NaN;
  var roiEl = box.querySelector('.eroi');
  var roiVal = roiEl ? parseFloat(roiEl.value) : NaN;
  var planEl = box.querySelector('.eplans');
  var planVal = planEl ? parseInt(planEl.value, 10) : NaN;
  var body = { shopId: id };
  if (!isNaN(thrYuan) && thrYuan > 0) body.thresholdCents = Math.round(thrYuan * 100);
  if (!isNaN(roiVal) && roiVal > 0) body.targetRoi = roiVal;
  if (!isNaN(planVal) && planVal >= 1 && planVal <= 10) body.plansPerShopPerDay = planVal;
  var r = await api('/api/shop/update', 'POST', body);
  if (r.ok) {
    var parts = ['已保存：' + (r.displayName || id), '阈值 ' + ((r.thresholdCents || 0) / 100).toFixed(2) + ' 元/单',
      '目标 ROI ' + r.targetRoi, '每日计划 ' + r.plansPerShopPerDay + ' 条'];
    showMsg(parts.join('，') + '（已落盘）', 'ok');
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
    var thrEl = box.querySelector('.ethr');
    var roiEl = box.querySelector('.eroi');
    var planEl = box.querySelector('.eplans');
    editState[id] = {
      open: true,
      thresholdYuan: thrEl ? thrEl.value : '',
      targetRoi: roiEl ? roiEl.value : '',
      plansPerShopPerDay: planEl ? planEl.value : '',
    };
  });
  if (!rows || rows.length === 0) {
    body.innerHTML = '<tr><td colspan="14" class="muted">暂无活动店铺</td></tr>';
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
    td1.appendChild(b);
    // 店铺 ID 仅在与名称不同时才显示（2026-11-19：自动发现店 id=店名，重复展示没有信息量）
    if (s.id && s.id !== (s.displayName || s.name || s.id)) {
      var div = document.createElement('div');
      div.className = 'muted';
      div.textContent = s.id;
      td1.appendChild(div);
    }
    var td2 = document.createElement('td');
    td2.innerHTML = adBadge(s.adState);
    // Cookie 登录文件状态（只读元信息：是否找到/是否过期；绝不展示 Cookie 内容）
    var tdCookie = document.createElement('td');
    var ci = s.cookieInfo || null;
    if (s.requiresLogin) {
      // 2026-11-27：平台已不认本店登录会话（读取时停在登录页）。文件时间戳未过期不等于能登录，
      // 此时不得再显示绿色「有效」。
      var cDead = document.createElement('span');
      cDead.className = 'badge unknown';
      cDead.title = s.readHint || '登录已失效，请重新登录';
      cDead.textContent = '会话失效';
      tdCookie.appendChild(cDead);
    } else if (ci && ci.found) {
      // 2026-11-28：文案只描述「文件到期状态」这一只读事实，按三态区分：
      // 文件已过期 / 文件未到期 / 无固定到期时间（无可显示日期）；不据此推断平台登录
      // 是否有效（登录态以 requiresLogin 徽标为最高优先级），也不断言一定是会话型
      //（缺少抖站域时同样取不到日期，故只如实报「无固定到期时间」）。
      var expText = fmtCookieExpire(ci.maxExpires);
      var cBadge = document.createElement('span');
      cBadge.className = 'badge ' + (expText ? (ci.expired ? 'unknown' : 'on') : 'off');
      cBadge.textContent = expText ? (ci.expired ? '文件已过期' : '文件未到期') : '无固定到期时间';
      cBadge.title = expText
        ? (ci.expired
          ? 'Cookie 文件内最晚到期时间已过；不代表平台登录态'
          : 'Cookie 文件内最晚到期时间未过；不代表平台登录态一定有效')
        : 'Cookie 文件内无可用固定到期时间；不代表平台登录态一定有效';
      tdCookie.appendChild(cBadge);
      // 到期时间（只读元信息）：仅在取到有效日期时追加，避免与「无固定到期时间」徽标重复；
      // 明确标注为「文件内最晚到期时间」。
      if (expText) {
        var cExp = document.createElement('div');
        cExp.className = 'muted';
        cExp.style.fontSize = '11px';
        cExp.textContent = expText;
        tdCookie.appendChild(cExp);
      }
      if (ci.readOnly === true) {
        var cRo = document.createElement('div');
        cRo.className = 'muted';
        cRo.style.fontSize = '11px';
        cRo.textContent = '只读来源';
        tdCookie.appendChild(cRo);
      }
    } else {
      var cMiss = document.createElement('span');
      cMiss.className = 'badge off';
      cMiss.textContent = '缺失';
      tdCookie.appendChild(cMiss);
    }
    var td3 = document.createElement('td');
    var rh = s.readHistory || {};
    var success = document.createElement('div');
    success.textContent = rh.lastSuccessAt ? '上次成功 ' + fmtTime(rh.lastSuccessAt) : '暂无成功记录';
    td3.appendChild(success);
    if (!s.lastDataAt && rh.lastSuccessAt) {
      var waiting = document.createElement('div');
      waiting.className = 'muted';
      waiting.textContent = '服务启动后尚无新读数';
      td3.appendChild(waiting);
    }
    var failure = rh.lastFailure;
    if (failure) {
      var recovered = rh.lastOutcome === 'success';
      var detail = document.createElement('div');
      detail.className = recovered ? 'muted' : 'bad';
      detail.style.maxWidth = '32ch';
      detail.style.overflowWrap = 'anywhere';
      detail.textContent = (recovered ? '上次失败（后续已成功）' : '最近失败') + ' ' + fmtTime(failure.at) + ' · ' + failure.reason;
      td3.appendChild(detail);
    }
    var scan = document.createElement('div');
    scan.className = s.requiresLogin ? 'bad' : 'muted';
    if (s.requiresLogin) {
      scan.textContent = s.readHint || '登录已失效，请重新登录';
    } else if (failure && !recovered) {
      scan.textContent = failure.requiresLogin ? '上次确认登录失效，等待本次复核' : '暂未确认需要扫码';
    } else if (rh.lastSuccessAt) {
      scan.textContent = '暂无扫码要求';
    } else {
      scan.textContent = '登录状态待取数核验';
    }
    td3.appendChild(scan);
    var td4 = document.createElement('td');
    td4.textContent = s.costText || yuan(s.costCents);
    var td5 = document.createElement('td');
    td5.textContent = s.orders == null ? '—' : (s.orders + ' 单');
    var td6 = document.createElement('td');
    td6.textContent = feeRatio(s.costCents, s.orders);
    var tdBal = document.createElement('td');
    tdBal.textContent = s.balanceCents != null ? (s.balanceCents / 100).toFixed(2) + ' 元' : '未知';
    // balanceAt 为 UTC ISO；上海 = UTC+8（无夏令时），行内可见小字显示本机读取时间
    if (s.balanceCents != null && s.balanceAt) {
      var balD = new Date(String(s.balanceAt));
      if (!isNaN(balD.getTime())) {
        var balSh = new Date(balD.getTime() + 8 * 3600 * 1000);
        var balP = function (x) { return ('0' + x).slice(-2); };
        var balSmall = document.createElement('div');
        balSmall.style.fontSize = '11px';
        balSmall.style.color = '#888';
        balSmall.textContent = balP(balSh.getUTCMonth() + 1) + '-' + balP(balSh.getUTCDate()) + ' ' + balP(balSh.getUTCHours()) + ':' + balP(balSh.getUTCMinutes()) + ' 读取';
        tdBal.appendChild(balSmall);
      }
    }
    var td7 = document.createElement('td');
    td7.textContent = thr;
    // 目标 ROI / 每日计划条数列（2026-11-20）：操作→修改保存的两值直接在行内展示
    var tdRoi = document.createElement('td');
    tdRoi.textContent = (s.targetRoi != null ? String(s.targetRoi) : '—');
    var tdPlans = document.createElement('td');
    tdPlans.textContent = (s.plansPerShopPerDay != null ? (s.plansPerShopPerDay + ' 条') : '—');
    if (s.plansPerShopPerDaySaved == null && s.plansPerShopPerDay != null) {
      var pSmall = document.createElement('div');
      pSmall.className = 'muted';
      pSmall.style.fontSize = '11px';
      pSmall.textContent = '默认';
      tdPlans.appendChild(pSmall);
    }
    // 当前动作列（2026-11-20）：引擎租约在途文本（巡查/读取/开启/登录接管），无在途即「空闲」；
    // 登录失效（2026-11-27）：红色具体文案 + 原因提示，不以「空闲」掩盖需要重新登录
    var tdAct = document.createElement('td');
    var actBusy = s.activity && s.activity !== '空闲' && !s.requiresLogin;
    tdAct.textContent = s.activity || '空闲';
    if (s.requiresLogin) {
      tdAct.style.color = '#b42318';
      tdAct.title = s.readHint || '登录已失效，请重新登录';
    } else if (actBusy) {
      tdAct.style.color = '#1a7f37';
      tdAct.style.fontWeight = 'bold';
    }
    // 计划发布列（2026-11-21）：账本投影 已成功/目标 + 最近一份状态与卡点原因
    var tdPub = document.createElement('td');
    var pp = s.planPublish || null;
    if (!pp || pp.enabled !== true) {
      tdPub.textContent = '未启用';
      tdPub.className = 'muted';
    } else {
      var pubMain = document.createElement('div');
      var okN = Number(pp.success) || 0;
      var tgt = pp.target != null ? pp.target : '—';
      pubMain.textContent = pp.restToday ? '今日停发一天' : okN + '/' + tgt + ' 份';
      if (pp.target != null && okN >= pp.target) pubMain.className = 'ok';
      tdPub.appendChild(pubMain);
      var rest = pp.restToday || pp.restTomorrow;
      if (rest) {
        var restLine = document.createElement('div');
        restLine.textContent = rest.restDate + ' 停发 · 商品目录已到第 ' + rest.page + ' 页';
        tdPub.appendChild(restLine);
      }
      if (pp.readError) {
        var errorLine = document.createElement('div');
        errorLine.textContent = '发布数据读取异常：' + pp.readError;
        tdPub.appendChild(errorLine);
      }
      if (pp.lastPlanId) {
        var idLine = document.createElement('div');
        idLine.textContent = '成功计划 ID：' + pp.lastPlanId;
        tdPub.appendChild(idLine);
      }
      if (pp.lastStatus) {
        var stWord = { success: '成功', unknown: '未知（不重放）', failed: '失败', 'failed-permanent': '失败（封存）', unsubmitted: '待重试', 'in-progress': '进行中', in_progress: '进行中', 'preparation-stopped': '已收口', preparation_stopped: '已收口' }[pp.lastStatus] || pp.lastStatus;
        var pubLine = document.createElement('div');
        pubLine.style.fontSize = '11px';
        if (pp.lastStatus === 'success') pubLine.className = 'ok';
        else if (pp.lastStatus === 'unknown' || pp.lastStatus === 'failed' || pp.lastStatus === 'failed-permanent') pubLine.className = 'bad';
        else pubLine.className = 'muted';
        var when = '';
        if (pp.lastAt) {
          var d = new Date(String(pp.lastAt));
          if (!isNaN(d.getTime())) when = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(5, 16).replace('T', ' ');
        }
        pubLine.textContent = '最近一份：' + stWord + (when ? ' · ' + when : '');
        tdPub.appendChild(pubLine);
        if (pp.reason) {
          var reasonMap = {
            'read-only-recovery-required': '前一日遗留未决，需只读恢复（当日不重试）',
            'catalog-response-json-unparseable': '商品目录接口响应异常',
            'catalog-http-status-not-200': '商品目录接口状态异常',
            'scheduled-shop-missing': '发布配置缺该店',
          };
          var friendly = reasonMap[String(pp.reason)] || null;
          if (!friendly) {
            for (var k in reasonMap) { if (String(pp.reason).indexOf(k) >= 0) { friendly = reasonMap[k] + '（' + k.slice(0, 24) + '…）'; break; } }
          }
          var pubReason = document.createElement('div');
          pubReason.className = 'muted';
          pubReason.style.fontSize = '11px';
          pubReason.title = String(pp.reason);
          pubReason.textContent = '卡点：' + (friendly || String(pp.reason).slice(0, 60));
          tdPub.appendChild(pubReason);
        }
      }
    }
    var td8 = document.createElement('td');

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
    d2.appendChild(l2); d2.appendChild(in2);
    // 目标 ROI（正数，支持小数；缺省合同默认 15）
    var lRoi = document.createElement('label');
    lRoi.textContent = '目标 ROI';
    var inRoi = document.createElement('input');
    inRoi.className = 'eroi';
    inRoi.type = 'number';
    inRoi.step = '0.1';
    inRoi.min = '0.1';
    inRoi.placeholder = String(s.targetRoi != null ? s.targetRoi : 15);
    inRoi.value = (editState[s.id] && editState[s.id].targetRoi) != null ? editState[s.id].targetRoi : '';
    // 每店每日计划条数（整数 1..10；缺省回落全局默认 3）
    var lPlans = document.createElement('label');
    lPlans.textContent = '每日计划条数(1-10)';
    var inPlans = document.createElement('input');
    inPlans.className = 'eplans';
    inPlans.type = 'number';
    inPlans.step = '1';
    inPlans.min = '1';
    inPlans.max = '10';
    inPlans.placeholder = String(s.plansPerShopPerDay != null ? s.plansPerShopPerDay : 3);
    inPlans.value = (editState[s.id] && editState[s.id].plansPerShopPerDay) != null ? editState[s.id].plansPerShopPerDay : '';
    d2.appendChild(lRoi); d2.appendChild(inRoi);
    d2.appendChild(lPlans); d2.appendChild(inPlans);
    d2.appendChild(btnSave); d2.appendChild(btnCancel);
    editBox.appendChild(d2);
    if (editState[s.id] && editState[s.id].open) editBox.classList.add('open');

    td8.appendChild(btnRefresh);
    td8.appendChild(opsWrap);
    td8.appendChild(editBox);
    [td1, td2, tdCookie, td3, td4, td5, td6, tdBal, td7, tdRoi, tdPlans, tdAct, tdPub, td8].forEach(function(td) { tr.appendChild(td); });
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
    document.getElementById('firstCheck').textContent = s.monitor.firstCheckTime || '';
    renderShops(s.shopRows || []);
    document.getElementById('sched').textContent =
      '调度：每日首查 ' + (s.monitor.firstCheckTime || '—') + ' · 巡查间隔 ' + s.monitor.intervalMinutes + ' 分钟'
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

// ── 店铺扫码登录（二维码直显网页；多店铺 = 逐店重复扫码）────────────
function setQrBody(html) { document.getElementById('qr-body').innerHTML = html; }
function showQrImage(dataUrl) {
  var img = document.getElementById('qr-img');
  var loading = document.getElementById('qr-loading');
  if (dataUrl) {
    img.src = dataUrl;
    img.style.display = 'inline-block';
    loading.style.display = 'none';
  } else {
    img.style.display = 'none';
    loading.style.display = 'block';
  }
}
var qrPollTimer = null;
function stopQrPoll() {
  if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
}
function startQrPoll() {
  stopQrPoll();
  qrPollTimer = setInterval(async function() {
    if (document.getElementById('qr-mask').style.display !== 'block') return;
    try {
      var r = await api('/api/shop/qr-login/status');
      var j = r && r.job;
      if (!j || j.phase === 'idle') return;
      if (j.phase === 'running') {
        showQrImage(j.qrDataUrl);
        setQrBody('打开手机「<b>抖店App</b>」扫上方二维码登录（10 分钟超时；二维码过期自动刷新）。'
          + '多店铺请逐店重复扫码；同名店铺重复扫会刷新其 Cookie。');
      } else if (j.phase === 'success') {
        showQrImage(null);
        var extra = (j.addedShops && j.addedShops.length)
          ? '已自动加入店铺列表：<b>' + esc(j.addedShops.join('、')) + '</b>'
          : '该店铺已在列表中（同名店铺已刷新 Cookie）';
        setQrBody('<span class="ok">✔ 登录成功：' + esc(j.shopName || '未知店铺') + '</span><br>' + extra
          + '<br>正在自动拉取店铺数据（广告费/订单，约 1–2 分钟），完成后列表自动更新。'
          + '<br>可以继续点「扫码登录店铺」登录下一家店。'
          + (j.discoveryHint ? '<br><span class="bad">' + esc(j.discoveryHint) + '</span>' : ''));
        stopQrPoll();
        refresh();
      } else if (j.phase === 'failed') {
        showQrImage(null);
        setQrBody('<span class="bad">✘ 登录失败：</span>' + esc(j.reason || '未知')
          + (j.discoveryHint ? '<br>' + esc(j.discoveryHint) : ''));
        stopQrPoll();
      }
    } catch (e) { /* 单次轮询失败忽略，下轮重试 */ }
  }, 2000);
}
document.getElementById('qr-close').onclick = function() {
  document.getElementById('qr-mask').style.display = 'none';
  stopQrPoll();
};
document.getElementById('btn-qrlogin').onclick = async function() {
  var r = await api('/api/shop/qr-login', 'POST');
  document.getElementById('qr-mask').style.display = 'block';
  if (r && r.ok) {
    showQrImage(null);
    setQrBody('正在打开抖店登录页获取二维码…');
    startQrPoll();
  } else {
    showQrImage(null);
    setQrBody('<span class="bad">' + esc((r && r.reason) || '启动失败') + '</span>');
    if (r && r.job && r.job.active) startQrPoll(); // 已有会话进行中 → 展示其实时状态
  }
};
document.getElementById('btn-rediscover').onclick = async function() {
  var r = await api('/api/shops/rediscover', 'POST');
  if (r && r.ok) {
    var n = (r.added && r.added.length) ? ('新增 ' + r.added.length + ' 家：' + r.added.join('、')) : '无新增店铺';
    showMsg('扫描完成（' + n + '）' + (r.persisted === false ? '；配置落盘失败，进程内稍后自动重试' : ''), (r.added && r.added.length) ? 'ok' : '');
  } else {
    showMsg('扫描失败：' + ((r && r.reason) || '未知'), 'bad');
  }
  refresh();
};

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;


// ── 计划发布状态投影（2026-11-21 主控制页「计划发布」列）──────────────
// 数据源 = plan-publisher 真实账本 + 发布策略配置（每店当日已成功份数/目标/最近一份
// 状态与卡点原因）。只读展示，绝不推断、绝不把 unknown 说成成功。
const PUBLISHER_DIR = path.join(__dirname, '..', '..', 'plan-publisher');

function shanghaiTodayStr(nowMs) {
  return new Date((nowMs == null ? Date.now() : nowMs) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const publisher = require('../../plan-publisher/run-plans.cjs');

function dailyReceipts(paths, date) {
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  const state = read(paths.stateFile);
  if (state.businessDate !== date) return [];
  const attempts = read(paths.attemptsFile);
  const published = new Set((read(paths.publishedFile).plans || []).filter(p => p.date === date).map(p => p.planId));
  const receipts = [];
  for (const plan of state.plans || []) {
    if (plan.status !== 'success' || !plan.planId || !published.has(plan.planId)) continue;
    for (const [id, first] of Object.entries(attempts.consumed || {})) {
      const final = attempts.finalConsumed?.[id];
      if (first.runId && first.runId === final?.runId && plan.manifestHash &&
          [first, final].every(r => r.status === 'success' && r.businessDate === date &&
            r.manifestHash === plan.manifestHash && r.planNumber === plan.planNumber)) {
        receipts.push({ planNumber: plan.planNumber, planId: plan.planId, at: first.at });
        break;
      }
    }
  }
  return receipts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function readPlanPublishStatus(nowMs, publisherDir = PUBLISHER_DIR) {
  const empty = { configured: false, autoConfirm: false, byShop: {} };
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(publisherDir, 'daily-plan-config.json'), 'utf-8'));
  } catch (_) {
    return empty; // 未配置发布（fail-closed 不触发）→ 列显示「未启用」
  }
  const today = shanghaiTodayStr(nowMs);
  let dayShops = {};
  try {
    const led = JSON.parse(fs.readFileSync(path.join(publisherDir, 'daily-plan-data', 'ledger.json'), 'utf-8'));
    dayShops = (led.days && led.days[today] && led.days[today].shops) || {};
  } catch (_) { /* 无账本 → 各店按未运行显示 */ }
  const byShop = {};
  for (const s of (Array.isArray(cfg.shops) ? cfg.shops : [])) {
    if (!s || s.deleted === true) continue;
    const name = String(s.name || s.id);
    const d = dayShops[s.id] || dayShops[name] || null;
    const entries = d && d.entries ? Object.values(d.entries) : [];
    const last = entries.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
    const target = Number.isInteger(s.plansPerShopPerDay) ? s.plansPerShopPerDay
      : (Number.isInteger(cfg.plansPerShopPerDay) ? cfg.plansPerShopPerDay : 3);
    byShop[name] = {
      enabled: cfg.enabled === true,
      autoConfirm: cfg.autoConfirm === true,
      target,
      success: d && Number.isInteger(d.plans) ? d.plans : 0,
      overall: d ? d.status : '未运行',
      lastStatus: last ? last.status : null,
      reason: (last && last.reason) || (d && d.error) || null,
      lastAt: (last && last.at) || (d && d.lastAt) || null,
    };
    const status = byShop[name];
    const stateRoot = cfg.stateRoot || publisherDir;
    try {
      const scoped = publisher.resolvePublisherStatePaths(s, stateRoot);
      if (!scoped.ok) throw new Error(scoped.reason);
      const receipts = scoped.paths ? dailyReceipts(scoped.paths, today) : [];
      const latest = receipts.at(-1);
      if (latest) {
        const count = new Set(receipts.map(r => r.planNumber)).size;
        status.success = Math.max(count, status.success);
        status.lastPlanId = latest.planId;
        if (count >= target || !last || Date.parse(latest.at) >= Date.parse(last.at)) {
          Object.assign(status, { overall: count >= target ? 'success' : 'partial', lastStatus: 'success', reason: null, lastAt: latest.at });
        }
      }
      status.restToday = publisher.readCatalogRest(s, today, stateRoot);
      status.restTomorrow = publisher.readCatalogRest(s, publisher.nextBusinessDate(today), stateRoot);
      if (status.restToday) status.overall = 'catalog-rest-day';
    } catch (error) {
      status.readError = String(error.message);
    }
    if (s.id) byShop[s.id] = status;
  }
  return { configured: true, enabled: cfg.enabled === true, autoConfirm: cfg.autoConfirm === true, byShop };
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); }
    });
  });
}

function createUiServer(monitor, port, opts) {
  // 扫码登录会话工厂可注入（测试用假会话，不起真实浏览器）
  const qrSessionFactory = (opts && typeof opts.qrSessionFactory === 'function')
    ? opts.qrSessionFactory
    : (loginCfg) => new WebQrLoginSession(loginCfg);
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type) => {
      res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
      res.end(body);
    };
    // 出站统一脱敏（2026-09-24）：状态/原因文本可能携带上游错误里的疑似凭证，
    // 展示边界整包递归脱敏（值级 *** 标记，保留业务文案），原值不得出站。
    const sendJson = (code, obj) => send(code, JSON.stringify(scrubDeep(obj)));
    const url = (req.url || '').split('?')[0];

    if (url === '/api/shop/qr-login' && req.method === 'POST') {
      return sendJson(200, startWebQrLogin(monitor, qrSessionFactory));
    }
    if (url === '/api/shop/qr-login/status' && req.method === 'GET') {
      return sendJson(200, { ok: true, job: qrLoginJobView() });
    }
    if (url === '/api/shops/rediscover' && req.method === 'POST') {
      if (typeof monitor.requestShopDiscovery !== 'function') {
        return sendJson(200, { ok: false, reason: '当前 monitor 不支持 Cookie 店铺发现' });
      }
      return sendJson(200, monitor.requestShopDiscovery({ force: true }));
    }
    if (url === '/' && req.method === 'GET') {
      return send(200, HTML, 'text/html; charset=utf-8');
    }
    if (url === '/api/status' && req.method === 'GET') {
      const st = monitor.getStatus();
      // 计划发布状态（2026-11-21）：账本真实投影按店合并进 shopRows（planPublish 字段）
      try {
        const pub = readPlanPublishStatus();
        st.planPublishByShop = pub;
        for (const row of (st.shopRows || [])) {
          row.planPublish = pub.byShop[row.id] || pub.byShop[row.name] || pub.byShop[row.displayName] || { configured: pub.configured, enabled: false, autoConfirm: pub.autoConfirm, target: null, success: 0, overall: '未运行', lastStatus: null, reason: null, lastAt: null };
        }
      } catch (_) { /* 投影失败不阻塞状态 */ }
      return sendJson(200, st);
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
        targetRoi: body.targetRoi,
        plansPerShopPerDay: body.plansPerShopPerDay,
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

module.exports = { createUiServer, readPlanPublishStatus };
