'use strict';

/**
 * 最小中文控制界面（node:http，无额外依赖）v2。
 *
 * 展示（用户要求）：
 * - 当天推广费、全店订单、每单成本（仅展示；判定用整数分运算）、统计日期、
 *   数据抓取时间与页面数据更新时间；
 * - 最近巡查 / 下次巡查 / 等待 08:00 状态；
 * - 全店关闭的 成功 / 失败 / 未知 数量；只有完整回读确认才显示"全店广告已关闭"。
 * 操作：启动/停止监控、立即轮询一次（真实关闭同样受 08:00 窗口限制）。
 */

const http = require('http');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>抖店推广超额自动关闭 · 控制台</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; margin: 24px; background: #f5f6f8; color: #222; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin: 24px 0 8px; border-left: 4px solid #4a7; padding-left: 8px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:10px; font-size:13px; margin-right:8px; }
  .dry { background:#e6f4ea; color:#1a7f37; } .real { background:#fde8e8; color:#b42318; }
  .off { background:#eee; color:#666; } .warn { background:#fff3cd; color:#8a6d3b; }
  table { border-collapse: collapse; width: 100%; background:#fff; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #fafafa; }
  button { padding: 6px 16px; margin-right: 8px; cursor: pointer; font-size: 14px; }
  .danger { background: #b42318; color: #fff; border: none; }
  .primary { background: #1a7f37; color: #fff; border: none; }
  ul.pending { color: #b42318; } .muted { color: #888; }
  pre { background:#fff; padding:8px; border:1px solid #ddd; white-space: pre-wrap; }
  .ok { color:#1a7f37; font-weight:bold; } .bad { color:#b42318; }
</style>
</head>
<body>
<h1>抖店推广超额自动关闭 · 控制台
  <span id="mode" class="badge off">加载中…</span>
  <span id="run" class="badge off"></span>
  <span id="phase" class="badge off"></span>
</h1>
<div>
  <button id="btn-start" class="primary">启动监控</button>
  <button id="btn-stop" class="danger">停止监控</button>
  <button id="btn-poll">立即轮询一次</button>
  <span class="muted">真实关闭仅在每日 08:00 后（Asia/Shanghai）执行，手动轮询同样受限</span>
  <div id="msg" class="muted"></div>
</div>

<h2>待配置项</h2>
<div id="pending"></div>

<h2>今日数据与调度</h2>
<table id="today"></table>

<h2>店铺状态</h2>
<table id="shops"></table>

<h2>规则配置（用户规则：当天推广费用 ÷ 当天全店订单数 &gt; 1 元/单 时关闭全部广告）</h2>
<table id="rules"></table>

<h2>触发记录（演练模式=将关闭而未关闭）</h2>
<table id="triggers"></table>

<h2>全店关闭执行记录</h2>
<div class="muted">只有清单完整且回读全部确认时才显示「全店广告已关闭」。</div>
<table id="actions"></table>

<h2>最近错误</h2>
<div id="errors"></div>

<script>
async function api(p, method) { const r = await fetch(p, { method: method || 'GET' }); return r.json(); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function rows(el, headers, data) {
  el.innerHTML = '<tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    data.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('');
}
async function refresh() {
  const s = await api('/api/status');
  const modeEl = document.getElementById('mode');
  modeEl.textContent = s.mode; modeEl.className = 'badge ' + (s.realMode ? 'real' : 'dry');
  const runEl = document.getElementById('run');
  runEl.textContent = s.monitor.running ? '监控运行中' : '监控已停止';
  runEl.className = 'badge ' + (s.monitor.running ? 'dry' : 'off');
  const phaseEl = document.getElementById('phase');
  phaseEl.textContent = s.monitor.waitingFor08 ? '等待 08:00（次日）' : (s.monitor.phase === 'waiting_window' ? '等待 08:00' : (s.monitor.phase === 'running' ? '巡查中' : s.monitor.phase));
  phaseEl.className = 'badge ' + (s.monitor.waitingFor08 || s.monitor.phase === 'waiting_window' ? 'warn' : 'off');

  document.getElementById('pending').innerHTML = s.ready
    ? '<span class="badge dry">配置齐全</span>'
    : '<ul class="pending">' + s.pending.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>';

  const todayRows = [
    ['当前时钟', esc(s.clock)],
    ['统计日期（上海）', esc(s.businessDate)],
    ['调度', '每日 ' + esc(s.monitor.dailyStartHour) + ':00 后 · 每 ' + esc(s.monitor.intervalMinutes) + ' 分钟 · 数据有效期上限 ' + esc(s.monitor.snapshotMaxAgeMinutes) + ' 分钟'],
    ['最近巡查', esc(s.monitor.lastCycleAt || '尚未巡查')],
    ['下次巡查', esc(s.monitor.nextRunAt || '—')],
    ['推广数据读取', s.promoReaderConnected ? '已接入' : '<b>尚未接入</b>（等待提供推广页面网址）'],
  ];
  if (s.monitor.mockDataSource) todayRows.push(['模拟数据', '<b>演练演示用 mock（真实模式拒绝）</b>']);
  rows(document.getElementById('today'), ['项目', '值'], todayRows);

  rows(document.getElementById('shops'), ['店铺', 'Cookie', '当天推广费', '全店订单', '每单成本（展示）', '统计日期', '超标', '今日批次', '最近错误'],
    s.shops.map(sh => {
      const t = sh.today;
      const b = sh.batchToday;
      return [
        esc((sh.name || '') + ' (' + sh.id + ')'),
        sh.cookieInfo && sh.cookieInfo.found
          ? '存在（' + sh.cookieInfo.cookieCount + ' 条' + (sh.cookieInfo.readOnly ? '，电商助手只读' : '，本项目') + (sh.cookieInfo.expired ? '，<b style="color:#b42318">已过期</b>' : '') + '）'
          : '<span class="bad">' + esc((sh.cookieInfo && sh.cookieInfo.error) || '不存在') + '</span>',
        t ? esc(t.costText) + (t.rawCostText ? ' <span class="muted">原始: ' + esc(t.rawCostText) + '</span>' : '') : '—',
        t ? esc(t.orders) : '—',
        t ? esc(t.perOrderText) : '—',
        t ? esc(t.businessDate) : '—',
        t ? (t.over ? '<span class="bad">超标</span>' : '未超标') : '—',
        b ? '批 ' + esc(b.runs) + ' 次：成功 ' + esc(b.totals.confirmed) + ' / 失败 ' + esc(b.totals.failed) + ' / 未知 ' + esc(b.totals.unknown) +
            (b.allClosedConfirmed ? ' <span class="ok">全店广告已关闭（回读确认）</span>' : '') : '—',
        esc(sh.lastError || (t && t.blockedReason) || '—'),
      ];
    }));

  rows(document.getElementById('rules'), ['类型', '阈值（分/单）', '比较符', '统计周期', '时区', '启用'],
    (s.rules || []).map(r => [
      esc(r.type), esc(r.thresholdCents) + ' 分（= ' + esc((r.thresholdCents / 100).toFixed(2)) + ' 元/单）',
      esc(r.comparator) + '（恰好相等不关闭）', esc(r.period || 'today'), esc(r.timezone || 'Asia/Shanghai'),
      r.enabled === false ? '否' : '是',
    ]));

  rows(document.getElementById('triggers'), ['时间', '店铺', '模式', '触发原因', '目标数', '说明'],
    s.triggers.map(t => [esc(t.ts), esc(t.shopId), esc(t.mode || ''), esc(t.reason), esc(t.targetCount != null ? t.targetCount : (t.targets || []).length), esc(t.note || (t.blocked ? '被阻止：' + t.blocked : ''))]));

  rows(document.getElementById('actions'), ['时间', '店铺', '结果', '成功/失败/未知/跳过', '目标数', '清单页数', '回读确认', '原因'],
    s.actions.map(a => [esc(a.ts), esc(a.shopId), esc(a.outcome),
      esc([a.counts.confirmed, a.counts.failed, a.counts.unknown, a.counts.skipped].join(' / ')),
      esc(a.targets != null ? a.targets : '—'), esc(a.inventoryPages != null ? a.inventoryPages : '—'),
      a.allClosedConfirmed ? '<span class="ok">全店广告已关闭</span>' : '<span class="muted">未全部确认</span>',
      esc(a.reason || a.error || '')]));

  document.getElementById('errors').innerHTML = s.recentErrors.length
    ? '<pre>' + esc(s.recentErrors.map(e => '[' + e.ts + '] ' + e.scope + ': ' + e.error).join('\\n')) + '</pre>'
    : '<span class="muted">无</span>';
}
document.getElementById('btn-start').onclick = async () => {
  const r = await api('/api/monitor/start', 'POST'); showMsg(r.ok ? '监控已启动' : '启动失败：' + r.reason); refresh();
};
document.getElementById('btn-stop').onclick = async () => {
  await api('/api/monitor/stop', 'POST'); showMsg('监控已停止（已发出的关闭请求将继续回读确认）'); refresh();
};
document.getElementById('btn-poll').onclick = async () => {
  showMsg('轮询中…');
  const r = await api('/api/poll', 'POST');
  showMsg(r.ok ? '轮询完成：' + JSON.stringify(r.results) : '轮询未执行：' + r.reason);
  refresh();
};
function showMsg(m) { document.getElementById('msg').textContent = m; }
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

function createUiServer(monitor, port) {
  const server = http.createServer((req, res) => {
    const send = (code, body, type) => {
      res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (req.url === '/' && req.method === 'GET') {
      return send(200, HTML, 'text/html; charset=utf-8');
    }
    if (req.url === '/api/status' && req.method === 'GET') {
      return send(200, JSON.stringify(monitor.getStatus()));
    }
    if (req.url === '/api/monitor/start' && req.method === 'POST') {
      const r = monitor.start();
      return send(200, JSON.stringify(r));
    }
    if (req.url === '/api/monitor/stop' && req.method === 'POST') {
      const r = monitor.stop();
      return send(200, JSON.stringify(r));
    }
    if (req.url === '/api/poll' && req.method === 'POST') {
      monitor.pollOnce('manual-ui').then((r) => send(200, JSON.stringify(r)));
      return;
    }
    send(404, JSON.stringify({ error: 'not found' }));
  });
  return { server, port };
}

module.exports = { createUiServer };
