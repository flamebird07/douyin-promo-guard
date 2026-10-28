/**
 * 票据管理服务
 * 重要：禁止清理2号、3号、4号表格的数据！只允许清理1号表格。
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { buildAnalyzerLaunchEnv } = require('./analyzer-shop-target');
const ISOLATION_DEPLOY_VERSION = '2026-09-15-isolation-v1';
let { ShopTracker, STATE } = (() => { try { return require('./isolation-runtime/completion'); } catch (e) { return {}; } })();
let RunDedup = (() => { try { return require('./isolation-runtime/runDedup').RunDedup; } catch (e) { return null; } })();
let prodAutoScheduler = (() => { try { return require('./isolation-runtime/prodAutoScheduler'); } catch (e) { return null; } })();
const ISOLATION_SCHED_VERSION = '2026-09-15-isolation-sched-v1';
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
// 「自动上架」同源代理（白名单转发到 fashion-imagegen 8000 后端）
const { handleAutoPublishRequest, setBackendStatusProvider } = require('./auto_publish_proxy');
// fashion-imagegen Python 后端的**统一启动管理**（2026-09-17）：
// 3443 启动时检查并按需拉起 8000；已运行且身份正确则复用（不重复进程）；
// 异常退出按退避 + 次数上限自动恢复。实现与设计约束见 fashion-backend-manager.js。
//
// 防御性加载：管理模块自身出问题（语法错误、缺文件）绝不能拖垮电商助手 ——
// 那会把"后端没起来"升级成"整个 3443 打不开"。加载失败时降级为"不管理后端"，
// 其余功能照常。
let FashionBackendManager = null;
let DEFAULT_PYTHON = null;
try {
    ({ FashionBackendManager, DEFAULT_PYTHON } = require('./fashion-backend-manager'));
} catch (err) {
    console.error('[fashion-backend] 统一启动管理模块加载失败，将继续运行但不再管理后端:',
        err && err.message);
}
const backendManager = FashionBackendManager ? new FashionBackendManager() : null;

// publish-service（自动上架 8010）统一起动管理（2026-09-18 迁出收尾）：
// 与 8000 生图后端同一套「复用优先 / 不夺权 / 退避恢复」机制。
// 激活条件（同时满足，切换前零行为变化）：
//   1. 上架代理上游显式设置（AUTO_PUBLISH_UPSTREAM / PUBLISH_SERVICE_UPSTREAM）
//      且指向本机 publish-service 端口（默认 8010，PUBLISH_SERVICE_PORT 可覆盖，
//      仅供隔离测试用临时端口）；
//   2. publish-service 根目录存在 app/server.py；
//   3. PUBLISH_SERVICE_MANAGED 未设为 0。
let publishServiceManager = null;
if (FashionBackendManager) {
    try {
        const explicitUpstream = process.env.AUTO_PUBLISH_UPSTREAM
            || process.env.PUBLISH_SERVICE_UPSTREAM || '';
        const svcPort = parseInt(process.env.PUBLISH_SERVICE_PORT, 10) || 8010;
        let up = null;
        try { up = new URL(explicitUpstream.replace(/\/+$/, '')); } catch (e) { up = null; }
        const svcRoot = process.env.PUBLISH_SERVICE_ROOT
            || path.join(__dirname, 'publish-service');
        const flag = (name, def) => {
            const v = process.env[name];
            if (v === undefined || v === '') return def;
            return !/^(0|false|no|off)$/i.test(String(v).trim());
        };
        if (up && /^(127\.0\.0\.1|localhost)$/.test(up.hostname)
            && parseInt(up.port, 10) === svcPort
            && flag('PUBLISH_SERVICE_MANAGED', true)
            && fs.existsSync(path.join(svcRoot, 'app', 'server.py'))) {
            publishServiceManager = new FashionBackendManager({
                root: svcRoot,
                host: up.hostname === 'localhost' ? '127.0.0.1' : up.hostname,
                port: svcPort,
                python: process.env.PUBLISH_SERVICE_PYTHON || DEFAULT_PYTHON,
                // run.py 为 publish-service 的托管入口（等价 python -m app.server）
                entry: process.env.PUBLISH_SERVICE_ENTRY || 'run.py',
                entryArgs: (process.env.PUBLISH_SERVICE_ENTRY_ARGS
                    || `--port ${svcPort}`).split(' ').map((x) => x.trim()).filter(Boolean),
                logTag: 'publish-service',
                managed: true,
                autoRestart: flag('PUBLISH_SERVICE_AUTO_RESTART', true),
                maxRestarts: parseInt(process.env.PUBLISH_SERVICE_MAX_RESTARTS, 10) || 3,
                startTimeoutMs: parseInt(process.env.PUBLISH_SERVICE_START_TIMEOUT_MS, 10) || 30000,
                probeIntervalMs: parseInt(process.env.PUBLISH_SERVICE_PROBE_INTERVAL_MS, 10) || 15000,
            });
        }
    } catch (err) {
        console.error('[publish-service] 管理器构造失败，将继续运行但不管理上架服务:',
            err && err.message);
    }
}

// 代理在 502 时附带后端管理器的诊断（未注入时行为不变）。
// 上游切到 8010 后诊断应来自 publish-service 管理器，而非 8000 生图管理器。
setBackendStatusProvider(() => {
    if (publishServiceManager) return publishServiceManager.describe();
    return backendManager
        ? backendManager.describe()
        : '统一启动管理模块未加载';
});
// 「推广值守」后端调度 + 有界日志（2026-09-15 接入真实操作模式）：见 watch-drill.js
const { createWatchDrill } = require('./watch-drill');
const { createShopLoginHandler, createLoginTargetsHandler } = require('./login-http');
// SHOP-LIFE-1（2026-10-02）：店铺列表删除持久状态（platform+shop 隔离；Cookie 扫描不复活；
// 用户主动登录解除排除）。文件损坏时保留原文件并显式报错。
const { createShopListState } = require('./shop-list-state');
// T2-UI-1（2026-10-05）：票据管理「档口核对」控制器（复用已验收 check-stall-continuity CLI）。
// require 时不发请求/不启子进程；仅在 API 被调用时才现读2号表或按参数数组 spawn。
const { createBillReconciliationController } = require('./bill-reconciliation');
// BR-S1（2026-10-18）：票据录入后台任务状态源 + 增量日志（只读 HTTP 接口）。
// 后台进程是唯一状态源；页面关闭/刷新/多标签只读恢复，不改变任务。普通日志仍写 bill.log。
const { createBillTaskState, createBillTaskApi } = require('./bill-task-state');

// 内部HTTPS调用用的agent（忽略自签名证书）

// ========== 票据录入系统路由 ==========
// (SQLite 鉴权与 CRUD 路由已删除：bill-routes/auth.js / bill-crud.js / bill-ocr.js)
// /api/bill/* 路由分支随下方 block 一并移除（见 F-P13）。

function readJsonBody(req) {
    return new Promise(resolve => {
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            if (bodySize > MAX_BODY) { resolve({ __tooLarge: true }); return; }
            try { resolve(JSON.parse(body)); } catch { resolve({}); }
        });
    });
}
// ========== 票据路由结束 ==========

// readJsonBody 超限检查辅助函数
function checkBodySize(body, res) {
    if (body && body.__tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求体过大' }));
        return true;
    }
    return false;
}

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3443;
// 项目独立运行，路径基于脚本所在目录
const WORKSPACE = __dirname;
const shopListState = createShopListState({ file: path.join(WORKSPACE, 'shop-list-removed.json') });
const COOKIES_DIR = path.join(__dirname, 'cookies');
// 「推广值守」实例（2026-09-15 接入真实操作模式）：复用推广控制 Monitor 的调度与乘方链路。
// 是否真实操作广告仍由推广控制 config.json 的 fail-closed 门槛决定
// （execution.realMode + monitor.chengfang.pauseEnabled/enableEnabled）；本实例不提供绕过入口。
// 2026-10-09 客户要求：watchDrill.boot() 现在自动启动推广值守（超额暂停巡查）一次；
// 页面打开/关闭/刷新只读，不改变后台值守状态；本次运行中人工停止后页面重开不恢复，下一次服务启动再次自动启动。
const watchDrill = createWatchDrill({
    persistFile: path.join(WORKSPACE, 'watch-drill-logs.jsonl'),
    // 飞书/Hermes 消息推送已于 2026-10-07 按用户要求整体取消：不再装配任何通知参数，
    // watch-drill 模块内也无发送代码路径（即便旧环境变量 WATCH_NOTIFY_ENABLED=1 也不会恢复发送）。
});
// 独立每日首次开启检查任务（2026-10-09：取消 07:00 固定开启、改 00:05 后检查）：
// 服务成功监听 HTTPS 3443 后由 bootOnListenSuccess 装配并登记（不依赖页面访问），
// 与"启动值守"完全分离——值守启停不影响每日 00:05 后的首查。恢复语义：配置开启且
// 未被用户独立停用 → 服务重启自动恢复。
// 2026-10-09 R1：boot 从模块初始化移到 HTTPS listen 成功回调——端口冲突/绑定错误/
// 初始化失败时不调用 boot → 不登记值守任务、不读广告、不派发动作、不留活动循环。
const { bootOnListenSuccess } = require('./server-boot');
// 店铺分析测试页点击“停止”时使用：存在该文件时，分析器在结束流程后停留在浏览器现场。
const DEBUG_STOP_FLAG_FILE = path.join(WORKSPACE, 'debug_stop_flag.txt');

// ========== 自动关机状态 ==========
// 用内存标志位记录关机计划，避免 check 接口产生副作用（旧的 /check-shutdown
// 实现会执行 shutdown /a，反而把已安排的关机取消了）
let shutdownScheduledAt = null; // 记录调度关机的时间戳（ms），null 表示未调度
const SHUTDOWN_DELAY_SEC = 60;  // 关机倒计时秒数，需与前端提示保持一致

// ========== 防止多实例运行（r13 硬化：判定与接管规则见 server-lock.js） ==========
// fail-closed 规则：锁内容不可解析 / 字段非法 / 外机持有 / 读取或 PID 存活查询异常
// → 一律拒绝启动，**既不删除锁文件，也不继续 boot**；只有「同一主机 + 正整数 PID +
// 存活查询明确 ESRCH」才算严格证明持有者已死，才允许删除并重建。时间戳陈旧永不构成
// 接管理由（2026-09-16 事故根因）。
const LOCK_FILE = process.env.BILL_LOCK_FILE || path.join(WORKSPACE, '.server.lock');
const { createServerLock } = require('./server-lock');
const serverLock = createServerLock({
    lockFile: LOCK_FILE,
    log: (m) => { try { console.error(m); } catch { /* 尽力而为 */ } },
});

function acquireLock() {
    const res = serverLock.acquire();
    if (res.ok) return;
    if (res.state === 'ALIVE') {
        console.error(`服务已在运行中 (PID: ${res.lock ? res.lock.pid : '未知'})，请先停止再启动`);
    } else {
        console.error(`单实例锁判定为 ${res.state}：${res.why || '状态不可判'}——fail-closed，拒绝启动（不删除锁、不继续启动）`);
    }
    process.exit(1);
}

function releaseLock() {
    // 从未取得锁（例如拒绝启动后退出）：只停心跳，绝不触碰他人/未知状态的锁文件。
    if (!serverLock.isOwner()) {
        serverLock.stopHeartbeat();
        return;
    }
    const r = serverLock.release();
    if (r.released !== true) console.error(`单实例锁未删除：${r.why || '未知原因'}`);
}

acquireLock();

// Auth warning at startup
if (!process.env.API_TOKEN) {
    console.warn('[安全警告] API_TOKEN 环境变量未设置，服务将以无认证模式运行');
}

// ========== 全局错误处理 ==========
process.on('uncaughtException', (err) => {
    // EPIPE 非致命错误——仅管道断开（子进程已退出或 stdout 被关闭），不应杀死服务器
    if (err.code === 'EPIPE') {
        console.error('[警告] EPIPE (broken pipe)，忽略此错误，服务器继续运行');
        return;
    }
    console.error('未捕获异常:', err);
    try { log('服务异常: ' + err.message); } catch { process.stderr.write('服务异常: ' + err.message + '\n'); }
    releaseLock();
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('未处理的Promise拒绝:', reason);
});
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// 日志文件
const LOG_FILE = path.join(WORKSPACE, 'bill.log');
const SHOP_LOG_FILE = path.join(WORKSPACE, 'shop.log');  // 店铺商品分析日志（抖店+拼多多+自动化）
const DOUYIN_LOG_FILE = path.join(WORKSPACE, 'douyin.log'); // 旧日志文件，保留兼容

// Node v22 子进程 stderr 过滤：忽略 NODE_TLS_REJECT_UNAUTHORIZED RuntimeWarning 及其后续行
const STDERR_SKIP = /NODE_TLS_REJECT_UNAUTHORIZED|^\(node:\d+\)|DeprecationWarning|ExperimentalWarning|--trace-warnings|^\(Use `.+` to show where the warning was created\)$/;

// ========== 异步并发限制器 ==========
class ConcurrencyLimiter {
    constructor(max = 10) {
        this.max = max;
        this.active = 0;
        this.queue = [];
    }
    async run(fn) {
        if (this.active >= this.max) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            if (this.queue.length > 0) this.queue.shift()();
        }
    }
}
const fileLimiter = new ConcurrencyLimiter(10);

// 图片目录配置文件
const DIR_CONFIG_FILE = path.join(WORKSPACE, 'dir_config.json');

// 获取已保存的店铺列表
async function getShops() {
    try {
        const files = await fileLimiter.run(() => fsPromises.readdir(COOKIES_DIR));
        return files
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch (err) {
        return [];
    }
}

// ========== 店铺名编码校验与修复 ==========
// 检测店铺名是否包含乱码（U+FFFD替换字符）
function isShopNameGarbled(name) {
    if (!name) return true;
    if (name.includes('\ufffd') || name.includes('�')) return true;
    let latinExtCount = 0;
    for (const ch of name) {
        const code = ch.charCodeAt(0);
        if (code >= 0x00C0 && code <= 0x024F) latinExtCount++;
    }
    if (latinExtCount > 0 && latinExtCount / name.length > 0.3) return true;
    const mojibakePatterns = [
        /\u00C3[\u0080-\u00BF]/,
        /\u00C2[\u00A0-\u00BF]/,
        /\u00C3\u0083/,
        /\u00C3\u0082/,
    ];
    for (const pattern of mojibakePatterns) {
        if (pattern.test(name)) return true;
    }
    return false;
}

// 通过cookie文件名反向修复乱码的店铺名
// 如果传入的shopName是乱码，尝试从cookies目录中找到匹配的正确文件名
function repairShopName(garbledName) {
    if (!isShopNameGarbled(garbledName)) return garbledName; // 不需要修复
    try {
        const files = fs.readdirSync(COOKIES_DIR).filter(f => f.endsWith('.json'));
        if (files.length === 0) return garbledName;
        // 如果只有一个cookie文件，直接使用
        if (files.length === 1) {
            const correctName = files[0].replace('.json', '');
            shopLog(`[编码修复] 店铺名乱码 "${garbledName}" → 自动匹配唯一文件: ${correctName}`);
            return correctName;
        }
        // 多个文件时，用模糊匹配
        let bestMatch = null;
        let bestScore = 0;
        for (const file of files) {
            const fileName = file.replace('.json', '');
            // 计算字符集重叠度
            const setA = new Set(garbledName);
            const setB = new Set(fileName);
            let common = 0;
            for (const ch of setA) { if (setB.has(ch)) common++; }
            const score = common / Math.max(setA.size, setB.size);
            if (score > bestScore && score > 0.2) {
                bestScore = score;
                bestMatch = fileName;
            }
        }
        if (bestMatch) {
            shopLog(`[编码修复] 店铺名乱码 "${garbledName}" → 模糊匹配: ${bestMatch} (相似度: ${bestScore.toFixed(2)})`);
            return bestMatch;
        }
    } catch (e) {
        shopLog(`[编码修复] 修复失败: ${e.message}`);
    }
    return garbledName;
}


// 删除店铺cookie
function removeShop(shopName) {
    // 输入校验：仅允许中文、字母、数字、下划线、连字符，长度 1-100
    if (!shopName || !/^[\u4e00-\u9fa5a-zA-Z0-9_-]{1,100}$/.test(shopName)) {
        console.error('无效的店铺名称:', shopName);
        return false;
    }
    try {
        const safeName = `${shopName}.json`;
        // 检查抖店cookies目录
        const cookiePath = path.resolve(path.join(COOKIES_DIR, safeName));
        if (!cookiePath.startsWith(path.resolve(COOKIES_DIR))) return false;
        if (fs.existsSync(cookiePath)) {
            fs.unlinkSync(cookiePath);
            return true;
        }
        // 检查拼多多cookies目录
        const pddCookiesDir = path.join(WORKSPACE, 'pdd-cookies');
        const pddCookiePath = path.resolve(path.join(pddCookiesDir, safeName));
        if (!pddCookiePath.startsWith(path.resolve(pddCookiesDir))) return false;
        if (fs.existsSync(pddCookiePath)) {
            fs.unlinkSync(pddCookiePath);
            return true;
        }
    } catch (err) {
        console.error('删除店铺cookie失败:', err.message);
    }
    return false;
}

// 当前运行的子进程（按任务类型分开管理）
let billProcess = null;        // 票据录入/整理进程
let douyinProcess = null;      // 抖音单次分析进程
let douyinProcessHeaded = false; // 单次分析是否为可视（调试）模式：停止时保留浏览器便于观察
let douyinMultiProcess = null; // 抖音多次执行进程
let douyinMultiProcessHeaded = false; // 多次执行是否为可视（调试）模式：停止时保留浏览器（店铺商品分析是调试页面，停止不关浏览器）
let pddProcess = null;         // 拼多多进程
let pddProcessHeaded = false;  // 测试 tab 的拼多多可视进程：停止时保留浏览器便于观察
let isBillCheckRunning = false;
let billTaskKind = null; // entry可与核对并行；arrange改写2号表，仍保持互斥
let reconcileRunning = false;      // T2-UI-1 档口核对后台任务是否活跃（仅与整理互斥，录入可并行）
let isDouyinRunning = false;
let isDouyinMultiRunning = false;
let isAutoRunning = false;
let autoStatusDetail = { version: ISOLATION_DEPLOY_VERSION, shopStates: [], lastReason: null };     // 自动化流程运行中
let autoAbortController = null; // 自动化流程中止控制器
let autoShutdownRequested = false; // 用户是否勾选自动化完成后自动关机

// 读取指定日志文件的内容
async function getLogsFromFile(filePath, hours = 24, linesCount = 1000) {
    try {
        const content = await fileLimiter.run(() => fsPromises.readFile(filePath, 'utf8'));
        const lines = content.split('\n')
            .map(l => l.replace(/[\r]/g, '').trim())
            .filter(l => l);

        // 时间过滤
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        const filtered = lines.filter(line => {
            const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
            if (!m) return true;
            return new Date(m[1]).getTime() >= cutoff;
        });

        // 行数限制
        const recent = filtered.slice(-linesCount);
        return recent.map(line => line.length > 200 ? line.substring(0, 200) + '...' : line);
    } catch (err) {
        console.error('读取日志文件失败:', filePath, err.message);
    }
    return [];
}

// 读取票据日志（保持兼容）
function getLogs() {
    return getLogsFromFile(LOG_FILE);
}

// 写入日志到指定文件
function logToFile(msg, filePath) {
    const targetFile = filePath || LOG_FILE;
    const time = new Date().toISOString();
    // 过滤敏感信息（token、密码、secret、cookie）
    let safeMsg = typeof msg === 'string' ? msg : String(msg);
    safeMsg = safeMsg
        .replace(/(Bearer\s+)[^\s]{20,}/gi, '$1***')
        .replace(/((?:token|secret|password|passwd|pwd|app_secret|api_key|apikey)[=:\s"']+)[^\s"',}{]{8,}/gi, '$1***')
        .replace(/(cookie[=:\s"']+)[^\s"',}{]{8,}/gi, '$1***');
    // 清理消息中的特殊字符，确保JSON安全（保留换行符\n）
    const clean = safeMsg
        .replace(/[\r]/g, '')
        .replace(/\\/g, '/')
        .replace(/"/g, "'")
        .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')  // 保留0x0A(\n)
        .substring(0, 2000);  // 增加长度限制
    // 处理多行日志：每行都添加时间戳
    const lines = clean.split('\n');
    const logLines = lines.map(line => `[${time}] ${line}`);
    fs.appendFileSync(targetFile, logLines.join('\n') + '\n');
    // 日志轮转：超过5MB时截断（异步，不阻塞调用方）
    fsPromises.stat(targetFile).then(stats => {
        if (stats.size > 5 * 1024 * 1024) {
            return fsPromises.readFile(targetFile, 'utf8').then(content => {
                const keep = content.split('\n').slice(-1000);
                return fsPromises.writeFile(targetFile, keep.join('\n'));
            });
        }
    }).catch(() => {});
}

function log(msg) {
    console.log(msg);
    logToFile(msg, LOG_FILE);
}

// BR-S1：票据录入任务状态（独立运行文件，不含凭据/票据原文）。
// BILL_TASK_STATE_DIR 仅供隔离测试指向临时目录；生产默认 bill-manager/.bill-task-state。
const billTaskState = createBillTaskState({
    stateDir: process.env.BILL_TASK_STATE_DIR || path.join(WORKSPACE, '.bill-task-state'),
    log: (m) => { try { log(m); } catch { /* 日志失败不影响任务 */ } },
});
const handleBillTaskApi = createBillTaskApi(billTaskState, {
    getLegacy: () => ({
        billRunning: isBillCheckRunning,
        taskKind: billTaskKind,
        reconcileRunning,
    }),
});

// T2-UI-1「档口核对」控制器：允许票据录入并行，仅与整理互斥；日志复用票据日志通道（log）。
// 完成计数只信实时2号表读取，绝不凭缓存冒充完成；不加入旧 /stop 粗暴 kill（写结果未知不可任意重跑）。
const billReconcile = createBillReconciliationController({
    isArrangeRunning: () => isBillCheckRunning && billTaskKind === 'arrange',
    setReconcileRunning: (v) => { reconcileRunning = v; },
    log: (m) => log('[档口核对] ' + m),
});

function douyinLog(msg) {
    try { console.log(msg); } catch { /* stdout pipe 可能已断开，仅记录到文件 */ }
    logToFile(msg, DOUYIN_LOG_FILE);
}

function shopLog(msg) {
    try { console.log(msg); } catch { /* stdout pipe 可能已断开，仅记录到文件 */ }
    logToFile(msg, SHOP_LOG_FILE);
}

const loginGuardDir = process.env.PROMO_GUARD_DIR || path.resolve(WORKSPACE, '..', 'douyin-promo-guard');
const handleShopLogin = createShopLoginHandler({
    workspace: WORKSPACE,
    guardDir: loginGuardDir,
    configPath: path.join(loginGuardDir, 'config', 'config.json'),
    log: shopLog,
    setRunning: (running) => { isDouyinRunning = running; },
    restoreList: (shopName) => shopListState.removeRemoved('douyin', shopName),
    // COOKIE-FOUR-REPAIR-20261024：恢复 GitHub 原有接线——登录四份分发全部成功后，
    // 复用 watch-drill 既有 joinShopAfterLogin（discovery/join）同步推广店铺信息。
    joinAfterLogin: (shopName) => watchDrill.joinShopAfterLogin({ shopName, platform: 'douyin' }),
});
// 登录入口目标清单（DIAN-4 UI→HTTP）：只读投影值守配置行（精确 shopId + 展示名）。
// 配置不可读时如实 500，页面两个登录入口据此拒绝发起登录，绝不回退到按店名猜目标。
const handleLoginTargets = createLoginTargetsHandler({
    guardDir: loginGuardDir,
    configPath: path.join(loginGuardDir, 'config', 'config.json'),
});

// ========== 请求体大小限制 ==========
const MAX_BODY = 1024 * 1024; // 1MB

// ========== 认证中间件 ==========
function requireToken(req, res) {
    const token = process.env.API_TOKEN;
    if (!token) return true; // no token configured = open access
    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}`) return true;
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未授权' }));
    return false;
}

// ========== 输入验证 ==========
const SAFE_DIR_RE = /^[\w.\/\\-]+$/;
const MAX_DIR_LENGTH = 260; // Windows MAX_PATH

function validateDir(dir) {
    if (!dir || typeof dir !== 'string') return { valid: true, cleaned: '' }; // empty = default
    if (dir.length > MAX_DIR_LENGTH) return { valid: false, reason: '路径过长' };
    if (!SAFE_DIR_RE.test(dir)) return { valid: false, reason: '路径包含非法字符' };
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(WORKSPACE))) return { valid: false, reason: '路径越界' };
    return { valid: true, cleaned: dir };
}

function validateLogParams(hours, lines) {
    const h = Math.min(Math.max(parseInt(hours) || 24, 1), 720); // 1h ~ 30d
    const l = Math.min(Math.max(parseInt(lines) || 1000, 1), 5000);
    return { hours: h, lines: l };
}

// ========== 微信群抓取（随 3443 主服务启动，不再依赖独立服务）==========
const WXMON_DIR = path.resolve(WORKSPACE, '..', '..', 'weixin cli', 'wxrefinery');
const WXMON_GROUPS_FILE = path.join(WXMON_DIR, 'groups.json');
const WXMON_LOG_FILE = path.join(WXMON_DIR, 'logs.jsonl');
const WXMON_PYTHON_CANDIDATE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe');
const WXMON_PYTHON = process.env.WXMON_PYTHON || (fs.existsSync(WXMON_PYTHON_CANDIDATE) ? WXMON_PYTHON_CANDIDATE : 'python');
const WXMON_SUBSCRIBERS = new Map();

function loadWxmonGroups() {
    try {
        const config = JSON.parse(fs.readFileSync(WXMON_GROUPS_FILE, 'utf8'));
        return { groups: Array.isArray(config.groups) ? config.groups : [], default_window_hours: config.default_window_hours || 24 };
    } catch {
        return { groups: [], default_window_hours: 24 };
    }
}

function saveWxmonGroups(config) {
    const tmp = `${WXMON_GROUPS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, WXMON_GROUPS_FILE);
}

function sendWxmonJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function appendWxmonLog(jobId, level, message) {
    const entry = JSON.stringify({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), job: jobId, lvl: level, msg: message });
    try { fs.appendFileSync(WXMON_LOG_FILE, `${entry}\n`, 'utf8'); } catch { /* 日志不可写不影响抓取 */ }
    for (const [sid, stream] of WXMON_SUBSCRIBERS) {
        try { stream.write(`data: ${entry}\n\n`); } catch { WXMON_SUBSCRIBERS.delete(sid); }
    }
}

function runWxmonCommand(args) {
    return new Promise(resolve => {
        const child = spawn(WXMON_PYTHON, args, { cwd: WXMON_DIR, windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

async function runWxmonCapture(jobId, chat, windowHours) {
    appendWxmonLog(jobId, 'INFO', `开始抓取群「${chat}」${windowHours}h 窗口`);
    try {
        const variants = [...new Set([chat, chat.replaceAll('——', '—'), chat.replaceAll('—', '——')])];
        for (const variant of variants) {
            const capture = await runWxmonCommand(['../wx-bp/crawl_history.py', '--chat', variant, '--hours', String(windowHours)]);
            for (const line of `${capture.stdout}\n${capture.stderr}`.split(/\r?\n/)) if (line.trim()) appendWxmonLog(jobId, 'INFO', line.trim());
            if (capture.code !== 0 || !capture.stdout.includes('共回填')) continue;
            appendWxmonLog(jobId, 'INFO', '抓取完成，开始推送飞书');
            const upload = await runWxmonCommand(['core/feishu.py', '--once', '--table', 'tbl531ntOPvk9v5S']);
            for (const line of `${upload.stdout}\n${upload.stderr}`.split(/\r?\n/)) if (line.trim()) appendWxmonLog(jobId, 'INFO', line.trim());
            appendWxmonLog(jobId, upload.stdout.includes('本轮') ? 'OK' : 'WARN', upload.stdout.includes('本轮') ? `群「${chat}」处理完成` : '飞书推送未确认');
            return;
        }
        appendWxmonLog(jobId, 'ERROR', `群「${chat}」抓取失败（可能找不到匹配群）`);
    } catch (error) {
        appendWxmonLog(jobId, 'ERROR', `异常: ${error.message}`);
    }
}

// 串行任务队列: 一次只跑一个群, 避免并发进程争写同一解密缓存(malformed)
let wxmonRunning = false;
const wxmonQueue = [];
let wxmonCompleted = 0;       // 本批次完成的任务数
let wxmonSyncDone = false;    // 本批次是否已跑过 2号/3号 同步

function startWxmonJob(chat, windowHours) {
    const jobId = crypto.randomBytes(4).toString('hex');
    wxmonQueue.push({ jobId, chat, windowHours });
    wxmonSyncDone = false;    // 新任务入队 → 批次尚未同步
    void pumpWxmonQueue();
    return jobId;
}

async function pumpWxmonQueue() {
    if (wxmonRunning) return;
    const job = wxmonQueue.shift();
    if (!job) {
        // 队列清空: 本批次若有完成的任务, 自动触发 2号/3号 同步
        if (wxmonCompleted > 0 && !wxmonSyncDone) {
            wxmonSyncDone = true;
            void runBatchSync();
        }
        return;
    }
    wxmonRunning = true;
    try {
        await runWxmonCapture(job.jobId, job.chat, job.windowHours);
        wxmonCompleted++;
    } catch (error) {
        appendWxmonLog(job.jobId, 'ERROR', `任务异常: ${error.message}`);
    } finally {
        wxmonRunning = false;
        void pumpWxmonQueue();
    }
}

// 批次抓取完成后: 2号(外部来源同步) → 3号(生成审核 + 已确认回写2号)
async function runBatchSync() {
    appendWxmonLog('SYNC', 'INFO', '批次抓取完成, 开始同步2号表(档口信息)');
    try {
        const s2 = await runWxmonCommand(['../wx-bp/sync_stall_table.py']);
        for (const line of `${s2.stdout}\n${s2.stderr}`.split(/\r?\n/)) if (line.trim()) appendWxmonLog('SYNC', 'INFO', line.trim());
    } catch (error) {
        appendWxmonLog('SYNC', 'ERROR', `2号表同步异常: ${error.message}`);
    }
    appendWxmonLog('SYNC', 'INFO', '开始同步3号表(商品档口审核, 含已确认档口回写2号)——非生图3号');
    try {
        const s3 = await runWxmonCommand(['../wx-bp/sync_product_candidates.py']);
        for (const line of `${s3.stdout}\n${s3.stderr}`.split(/\r?\n/)) if (line.trim()) appendWxmonLog('SYNC', 'INFO', line.trim());
        appendWxmonLog('SYNC', 'OK', '2号/3号表同步完成');
    } catch (error) {
        appendWxmonLog('SYNC', 'ERROR', `3号表同步异常: ${error.message}`);
    }
}

async function handleWxmonRequest(req, res) {
    const url = new URL(req.url, `https://localhost:${HTTPS_PORT}`);
    const endpoint = url.pathname.slice('/api/wxmon'.length);
    if (req.method === 'GET' && endpoint === '/groups') return sendWxmonJson(res, 200, loadWxmonGroups());
    if (req.method === 'GET' && endpoint === '/groups/all') {
        const result = await runWxmonCommand(['legacy/list_all_groups.py']);
        try { return sendWxmonJson(res, 200, JSON.parse(result.stdout)); }
        catch { return sendWxmonJson(res, 500, [{ error: result.stderr || '读取微信群目录失败' }]); }
    }
    if (req.method === 'GET' && endpoint.startsWith('/logs/stream/')) {
        const sid = endpoint.slice('/logs/stream/'.length) || crypto.randomBytes(6).toString('hex');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        WXMON_SUBSCRIBERS.set(sid, res);
        try {
            const lines = fs.readFileSync(WXMON_LOG_FILE, 'utf8').trim().split(/\r?\n/).slice(-30);
            for (const line of lines) if (line) res.write(`data: ${line}\n\n`);
        } catch { /* 还没有历史日志 */ }
        const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* close handler removes it */ } }, 15000);
        req.on('close', () => { clearInterval(heartbeat); WXMON_SUBSCRIBERS.delete(sid); });
        return;
    }
    if (req.method !== 'POST') return sendWxmonJson(res, 404, { error: '接口不存在' });
    const data = await readJsonBody(req);
    if (checkBodySize(data, res)) return;
    const chat = String(data.chat || '').trim();
    const config = loadWxmonGroups();
    if (endpoint === '/groups/add') {
        if (!chat) return sendWxmonJson(res, 400, { error: '群名/关键字必填' });
        if (config.groups.some(group => group.chat === chat)) return sendWxmonJson(res, 409, { error: '该群已在列表中' });
        const hours = Math.min(Math.max(parseInt(data.window_hours, 10) || config.default_window_hours, 1), 720);
        config.groups.push({ chat, window_hours: hours, enabled: true });
        saveWxmonGroups(config);
        return sendWxmonJson(res, 200, { ok: true, groups: config.groups });
    }
    if (endpoint === '/groups/remove') {
        config.groups = config.groups.filter(group => group.chat !== chat);
        saveWxmonGroups(config);
        return sendWxmonJson(res, 200, { ok: true, groups: config.groups });
    }
    if (endpoint === '/groups/update') {
        for (const group of config.groups) if (group.chat === chat) {
            group.window_hours = Math.min(Math.max(parseInt(data.window_hours, 10) || group.window_hours, 1), 720);
            if (typeof data.enabled === 'boolean') group.enabled = data.enabled;
        }
        saveWxmonGroups(config);
        return sendWxmonJson(res, 200, { ok: true, groups: config.groups });
    }
    if (endpoint === '/groups/scan_all') {
        const jobs = config.groups.filter(group => group.enabled !== false).map(group => startWxmonJob(group.chat, group.window_hours || config.default_window_hours));
        return sendWxmonJson(res, 200, { ok: true, jobs });
    }
    if (endpoint === '/scan') {
        if (!chat) return sendWxmonJson(res, 400, { error: '群名/关键字必填' });
        const hours = Math.min(Math.max(parseInt(data.window_hours, 10) || config.default_window_hours, 1), 720);
        return sendWxmonJson(res, 200, { ok: true, job_id: startWxmonJob(chat, hours) });
    }
    return sendWxmonJson(res, 404, { error: '接口不存在' });
}

/**
 * fashion-imagegen 后端统一启动管理接口（2026-09-17）。
 *
 * 只暴露两件事，且都不触发任何真实业务：
 *   GET  /api/fashion-backend/status  —— 实时探测 + 状态快照（含明确中文诊断）
 *   POST /api/fashion-backend/ensure  —— 人工「重试启动后端」（清空退避预算后再确保可用）
 *
 * 刻意不提供：结束后端、改配置、关托管 —— 那些只允许本机 CLI
 * （node fashion-backend-manager.js stop|resume）执行，避免页面误操作。
 */
async function handleFashionBackendRequest(req, res) {
    const pathname = req.url.split('?')[0];
    const send = (code, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
    };
    if (!backendManager) {
        return send(503, { error: '统一启动管理模块未加载，无法查询/启动后端',
            describe: '统一启动管理模块未加载' });
    }
    try {
        if (req.method === 'GET' && pathname === '/api/fashion-backend/status') {
            try { await backendManager.probe(); } catch (e) { /* 探测异常也返回快照 */ }
            return send(200, { ...backendManager.status(), describe: backendManager.describe() });
        }
        if (req.method === 'POST' && pathname === '/api/fashion-backend/ensure') {
            const r = await backendManager.resetAndEnsure();
            try { await backendManager.probe(); } catch (e) { /* 同上 */ }
            return send(r.ok ? 200 : 503, {
                ...r, describe: backendManager.describe(), status: backendManager.status(),
            });
        }
        return send(405, { error: '接口不存在或方法不支持' });
    } catch (err) {
        return send(500, { error: '后端管理接口异常: ' + (err && err.message) });
    }
}

/**
 * publish-service（自动上架 8010）统一起动管理接口（2026-09-18）。
 * GET  /api/publish-service/status —— 实时探测 + 状态快照
 * POST /api/publish-service/ensure —— 人工重试启动（清空退避预算后再确保）
 * 上游未切换（仍指向 fashion 8000）时管理器不激活，此处返回明确的 503，
 * 不误报"服务故障"。停止/恢复只允许本机 CLI（PUBLISH_SERVICE_MANAGED 等）。
 */
async function handlePublishServiceRequest(req, res) {
    const pathname = req.url.split('?')[0];
    const send = (code, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
    };
    if (!publishServiceManager) {
        return send(503, {
            error: 'publish-service 管理未激活：上架代理上游仍指向 fashion 8000（未切换到 8010）',
            describe: '上游未切换，publish-service 不由本进程管理（属切换前的正常状态）',
        });
    }
    try {
        if (req.method === 'GET' && pathname === '/api/publish-service/status') {
            try { await publishServiceManager.probe(); } catch (e) { /* 探测异常也返回快照 */ }
            return send(200, { ...publishServiceManager.status(), describe: publishServiceManager.describe() });
        }
        if (req.method === 'POST' && pathname === '/api/publish-service/ensure') {
            const r = await publishServiceManager.resetAndEnsure();
            try { await publishServiceManager.probe(); } catch (e) { /* 同上 */ }
            return send(r.ok ? 200 : 503, {
                ...r, describe: publishServiceManager.describe(), status: publishServiceManager.status(),
            });
        }
        return send(405, { error: '接口不存在或方法不支持' });
    } catch (err) {
        return send(500, { error: '上架服务管理接口异常: ' + (err && err.message) });
    }
}

// 路由处理
async function handleRequest(req, res) {
    // 设置CORS和缓存控制
    const origin = req.headers.origin;
    const allowedOrigins = [
        `https://localhost:${HTTPS_PORT}`,
        `https://127.0.0.1:${HTTPS_PORT}`
    ];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // 安全响应头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // 健康检查（public）
    if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    // 认证检查（/ping 之后的所有路由都需要 token）
    if (!requireToken(req, res)) return;

    // BR-S1 票据后台任务只读面板：状态 + seq 增量日志；不会启动/停止任何任务。
    if (req.url.startsWith('/api/bill-task/')) {
        handleBillTaskApi(req, res);
        return;
    }

    // T2-UI-1 档口核对 API：放在其他服务分支之前；状态接口只读不启动，核对仅由按钮触发。
    if (req.url.startsWith('/api/bill-reconciliation/')) {
        await billReconcile.handleHttp(req, res);
        return;
    }

    // 微信群抓取 API：由 3443 进程直接处理，配置会保存在 wxmon/groups.json。
    if (req.url.startsWith('/api/wxmon/')) {
        await handleWxmonRequest(req, res);
        return;
    }

    // fashion-imagegen 后端统一启动管理（2026-09-17）：状态查询 / 人工重试启动。
    // 放在代理之前，避免 /api/fashion-backend/* 被当成上架代理路径。
    if (req.url.startsWith('/api/fashion-backend/')) {
        await handleFashionBackendRequest(req, res);
        return;
    }

    // publish-service（自动上架 8010）统一起动管理（2026-09-18）：同上，先于代理。
    if (req.url.startsWith('/api/publish-service/')) {
        await handlePublishServiceRequest(req, res);
        return;
    }

    // 自动上架 API（2026-09-11）：同源白名单代理到 fashion-imagegen 后端，
    // 业务逻辑全部在后端；本进程只做转发与访问控制，见 auto_publish_proxy.js。
    if (req.url.startsWith('/api/auto-publish/')) {
        await handleAutoPublishRequest(req, res);
        return;
    }

    // 推广值守 API（2026-09-15 接入真实操作模式）：调度与乘方读写复用推广控制 Monitor，
    // 是否真实操作广告由推广控制 config.json 的 fail-closed 门槛决定，见 watch-drill.js。
    if (req.url.startsWith('/api/watch-drill/')) {
        await watchDrill.serveHttp(req, res);
        return;
    }

    // 静态文件服务 - index.html
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(WORKSPACE, 'index.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading HTML');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(data);
        });
        return;
    }

    // 静态文件服务 - 日志轮询纯逻辑核心（index.html 引用；Node 单测同源）
    if (req.url === '/log-poll-core.js') {
        const jsPath = path.join(WORKSPACE, 'log-poll-core.js');
        fs.readFile(jsPath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading log-poll-core.js');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(data);
        });
        return;
    }

    // 查询进程状态
    if (req.url === '/get-process-status' && req.method === 'GET') {
        const shopRunning = isDouyinRunning || isDouyinMultiRunning || !!pddProcess;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            running: isAutoRunning || isBillCheckRunning || shopRunning || reconcileRunning,
            billRunning: isBillCheckRunning,
            billTaskKind, // entry | arrange | null：页面据此区分录入/整理，避免误显示录入
            reconcileRunning,
            shopRunning,
            douyinRunning: isDouyinRunning,  // 保留兼容
            autoRunning: isAutoRunning
        }));
        return;
    }

    // 停止票据进程（只杀票据，不影响商品分析）
    if (req.url === '/stop-bill' && req.method === 'POST') {
        let stopped = false;
        // 仅显式按钮触发；先记录停止请求，close 事件再落真实终态（不本地假装成功）。
        billTaskState.requestStop();
        if (isBillCheckRunning) {
            isBillCheckRunning = false;
            log('票据录入状态已重置');
            stopped = true;
        }
        if (billProcess) {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/T', '/F', '/PID', billProcess.pid.toString()], { windowsHide: true });
            } else {
                billProcess.kill('SIGTERM');
            }
            log('票据进程已终止');
            billProcess = null;
            stopped = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? '已停止票据进程' : '没有运行中的票据进程' }));
        return;
    }

    // 停止商品分析进程（只杀抖店/拼多多，不影响票据）
    // 【操作逻辑备注（2026-08-28 改回"真停止"，改动前先读完本段）】
    // 旧版本：可视(headed)模式点「停止」不杀进程，只写 debug_stop_flag + pause_flag 两个标记，
    //   让分析器"停在下一个检查点"并保留浏览器（调试停留）。存在的问题：
    //   ① 检查点之间有 15~30 秒的长等待，点停止后分析仍在跑，看起来"没停住"；
    //   ② 前端收到 debugHeld=true 后故意保持运行态按钮、暂停按钮变「继续」，按钮永远不恢复；
    //   ③ debug_stop_flag.txt 没有过期机制，跨次残留会让下一次运行卡死在"调试停止中"。
    // 现行为：「停止」= 立即 taskkill 终止整棵进程树（含浏览器），按钮恢复初始状态。
    //   抓取中要"保留现场观察页面"请用「暂停」按钮（分析器停在下一个检查点，浏览器保持打开）。
    if (req.url === '/stop-shop' && req.method === 'POST') {
        let stopped = false;
        const shopProcesses = [
            { proc: douyinProcess, name: '抖音' },
            { proc: douyinMultiProcess, name: '抖音多次' },
            { proc: pddProcess, name: '拼多多' }
        ];
        for (const { proc, name } of shopProcesses) {
            if (proc) {
                if (process.platform === 'win32') {
                    // /T 连带子进程一起杀（Playwright 的浏览器是 node 子进程的子进程）
                    spawn('taskkill', ['/T', '/F', '/PID', proc.pid.toString()], { windowsHide: true });
                } else {
                    proc.kill('SIGTERM');
                }
                shopLog(`${name}进程已终止`);
                stopped = true;
            }
        }
        // 进程已终止，残留的暂停/调试标记一并清掉，避免影响下一次运行
        try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}
        try { fs.unlinkSync(path.join(WORKSPACE, 'pause_flag.txt')); } catch (e) {}
        douyinProcess = null; douyinProcessHeaded = false;
        douyinMultiProcess = null; douyinMultiProcessHeaded = false;
        pddProcess = null; pddProcessHeaded = false;
        isDouyinRunning = false;
        isDouyinMultiRunning = false;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            success: stopped,
            debugHeld: false, // 字段保留兼容旧前端，2026-08-28 起恒为 false
            message: stopped ? '已停止商品分析进程' : '没有运行中的商品分析进程'
        }));
        return;
    }

    // 暂停/继续商品分析（调试页面专用：切换暂停标志文件，进程在循环间隙检查）
    const PAUSE_FLAG_FILE = path.join(WORKSPACE, 'pause_flag.txt');
    if (req.url === '/pause-shop' && req.method === 'POST') {
        let paused;
        try {
            if (fs.existsSync(PAUSE_FLAG_FILE)) {
                fs.unlinkSync(PAUSE_FLAG_FILE); // 已暂停 → 继续
                try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}
                paused = false;
            } else {
                fs.writeFileSync(PAUSE_FLAG_FILE, String(Date.now()), 'utf8'); // 暂停
                paused = true;
            }
            shopLog(paused ? '商品分析已暂停（浏览器保持打开）' : '商品分析已继续');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, paused, message: paused ? '已暂停' : '已继续' }));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: '切换暂停失败: ' + e.message }));
        }
        return;
    }

    // 查询暂停状态（前端按钮显示"暂停"还是"继续"）
    if (req.url === '/get-pause-status' && req.method === 'GET') {
        const paused = fs.existsSync(PAUSE_FLAG_FILE);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ paused }));
        return;
    }

    // 获取图片目录配置
    if (req.url === '/get-dir-config' && req.method === 'GET') {
        (async () => {
            let dir = '';
            try {
                await fsPromises.access(DIR_CONFIG_FILE);
                const raw = await fsPromises.readFile(DIR_CONFIG_FILE, 'utf-8');
                dir = JSON.parse(raw).dir || '';
            } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ dir }));
        })();
        return;
    }

    // 设置图片目录配置
    if (req.url === '/set-dir-config' && req.method === 'POST') {
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            body += chunk.toString('utf8');
        });
        req.on('end', async () => {
            if (bodySize > MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '请求体过大' }));
                return;
            }
            try {
                const { dir } = JSON.parse(body);
                const check = validateDir(dir);
                if (!check.valid) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, message: '无效的目录路径: ' + check.reason }));
                    return;
                }
                await fsPromises.writeFile(DIR_CONFIG_FILE, JSON.stringify({ dir: check.cleaned }, null, 2));
                log('图片目录已更新: ' + (check.cleaned || '默认'));
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: e.message }));
            }
        });
        return;
    }


    // 录入票据 - 使用 bill_image.py
    if (req.url === '/run-bill-check' && req.method === 'POST') {
        // 重复点击/多标签并发：isBillCheckRunning 与状态源双重拦截，只有一次能启动。
        if (isBillCheckRunning || billTaskState.isActive()) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        const begun = billTaskState.beginRun({ taskKind: 'entry' });
        if (!begun.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: begun.reason || '已有运行的进程' }));
            return;
        }
        isBillCheckRunning = true;
        billTaskKind = 'entry';

        // 立即返回响应，不等待请求体
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));

        // 消费请求体（避免连接泄漏）
        req.on('data', () => {});
        req.on('end', () => {});

        log('=== 开始录入票据 ===');

        // 读取目录配置
        let targetDir = '';
        try {
            if (fs.existsSync(DIR_CONFIG_FILE)) {
                const cfg = JSON.parse(fs.readFileSync(DIR_CONFIG_FILE, 'utf-8'));
                targetDir = cfg.dir || '';
            }
        } catch {}

        const billCheckPy = path.join(WORKSPACE, 'bill_image.py');
        const pyArgs = ['-u', billCheckPy];
        if (targetDir) pyArgs.push(targetDir);
        let py;
        try {
            py = spawn('python', pyArgs, {
                windowsHide: true,
                cwd: WORKSPACE,
                env: { ...process.env, PYTHONUNBUFFERED: '1' }
            });
        } catch (err) {
            isBillCheckRunning = false;
            billProcess = null;
            billTaskState.abortLaunch(new Error('进程启动失败: ' + err.message));
            log('[错误] 录入票据进程启动失败: ' + err.message);
            return;
        }
        billProcess = py;

        // 按行缓冲解析 worker stdout：__BILL_EVENT__ JSON 更新阶段，普通行仍写 bill.log。
        billTaskState.wireChild(py, {
            onLog: (msg) => log(msg),
            onStderr: (msg) => {
                // 过滤掉python warnings（普通日志已按来源进入 seq 通道）
                if (msg && !msg.includes('Warning') && !msg.includes('RequestsDependencyWarning')) {
                    log('[错误] ' + msg);
                }
            },
            onClose: (code, signal, snapshot) => {
                isBillCheckRunning = false;
                billProcess = null;
                log('=== 录入票据结束 (状态='
                    + (snapshot && snapshot.status ? snapshot.status : '未知')
                    + ', 退出码=' + (code == null ? '未知' : code)
                    + (signal ? ', signal=' + signal : '') + ') ===');
            },
        });
        return;
    }

    // 整理票据 - 使用 arrange2.js
    if (req.url === '/run-arrange' && req.method === 'POST') {
        // 与录入共用状态源：isBillCheckRunning 与 billTaskState 双重拦截，只有一次能启动。
        if (isBillCheckRunning || reconcileRunning || billTaskState.isActive()) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: reconcileRunning ? '档口核对运行中，请等待完成后再整理' : '已有运行的进程' }));
            return;
        }
        const begun = billTaskState.beginRun({ taskKind: 'arrange' });
        if (!begun.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: begun.reason || '已有运行的进程' }));
            return;
        }
        isBillCheckRunning = true;
        billTaskKind = 'arrange';

        // 立即返回响应，不等待请求体
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: '已启动' }));

        // 消费请求体（避免连接泄漏）
        req.on('data', () => {});
        req.on('end', () => {});

        log('=== 开始整理票据 ===');

        let node;
        try {
            node = spawn('node', [path.join(WORKSPACE, 'arrange2.js')], {
                windowsHide: true,
                cwd: WORKSPACE,
                env: { ...process.env, NODE_OPTIONS: '' }
            });
        } catch (err) {
            isBillCheckRunning = false;
            billProcess = null;
            billTaskState.abortLaunch(new Error('进程启动失败: ' + err.message));
            log('[错误] 整理票据进程启动失败: ' + err.message);
            return;
        }
        billProcess = node;

        // 整理脚本不发结构化 done：退出码语义由状态控制器保留（exit 0=completed，非0/signal=failed，用户停止=stopped）。
        // 原独立 stdout/stderr/close 监听移除，避免与 wireChild 的 seq 日志重复写两遍。
        billTaskState.wireChild(node, {
            onLog: (msg) => log(msg),
            onStderr: (msg) => {
                if (msg && !STDERR_SKIP.test(msg)) log('[错误] ' + msg);
            },
            onClose: (code, signal, snapshot) => {
                isBillCheckRunning = false;
                billProcess = null;
                log('=== 整理票据结束 (状态='
                    + (snapshot && snapshot.status ? snapshot.status : '未知')
                    + ', 退出码=' + (code == null ? '未知' : code)
                    + (signal ? ', signal=' + signal : '') + ') ===');
            },
        });
        return;
    }

    // 抖店商品信息获取 - 使用 douyin-shop-analyzer.js
// 共享函数：启动抖店分析进程
function startDouyinAnalyzer(targetCount, shopName, shippingFee, insurance, silent = false, opts = {}) {
    return new Promise((resolve) => {
        if (isDouyinRunning) {
            resolve({ success: false, message: '已有运行的进程' });
            return;
        }
        isDouyinRunning = true;
        // 编码修复：如果店铺名是乱码，尝试从cookie文件名反向修复
        shopName = repairShopName(shopName);
        const safetyTimer = setTimeout(() => {
            if (isDouyinRunning && !douyinProcess) {
                isDouyinRunning = false;
                shopLog('[安全] 超时重置 isDouyinRunning');
            }
        }, 10000);

        const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
        if (fs.existsSync(markerFile)) { try { fs.unlinkSync(markerFile); } catch (e) {} }
        try { fs.unlinkSync(path.join(WORKSPACE, 'pause_flag.txt')); } catch (e) {}
        try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}

        shopLog(`=== ${silent ? '[静默]' : '[可视]'} 开始获取抖店商品信息 (目标${targetCount}个) [${shopName}] ===`);

        const shopNameFile = path.join(WORKSPACE, 'current_shop.txt');
        fs.writeFileSync(shopNameFile, shopName, 'utf8'); console.log('[DEBUG-SHOP] Writing:', shopName, 'hex:', Buffer.from(shopName).toString('hex').substring(0,20));

        const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
        fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));

        const douyinScript = path.join(WORKSPACE, 'douyin-shop-analyzer.js');
        const runId = opts.runId || (prodAutoScheduler ? prodAutoScheduler.newSingleRunId() : 'prod' + Date.now().toString(36));
        const stateFile = opts.stateFile || path.join(WORKSPACE, 'run_dedup_' + runId + '.json');
        const shareState = !!opts.runId;
        autoStatusDetail = { version: ISOLATION_DEPLOY_VERSION, runId, stateFile, shop: shopName, startedAt: new Date().toISOString(), shopStates: autoStatusDetail.shopStates || [], lastReason: null };
        const node = spawn('node', [douyinScript, targetCount.toString(), silent ? '--headless' : '--headed'], {
            windowsHide: true,
            cwd: WORKSPACE,
            // D16：把本次任务店铺名冻结进子进程 env（新对象，不改 process.env）。
            // 子进程不再依赖可被另一个任务改写的 current_shop.txt。
            env: buildAnalyzerLaunchEnv(
                { ...process.env, AUTO_RUN_ID: runId, STATE_FILE: stateFile },
                shopName
            )
        });
        douyinProcess = node;
        douyinProcessHeaded = !silent;
        // ========== 子进程管道错误处理（防止 EPIPE 崩溃服务器）==========
        node.on('error', (err) => {
            if (err.code === 'EPIPE') {
                shopLog(`[警告] 子进程管道断开 (EPIPE)，子进程可能已退出`);
            } else {
                shopLog(`[错误] 子进程异常: ${err.message}`);
            }
        });
        node.stdout.on('error', (err) => {
            if (err.code !== 'EPIPE') shopLog(`[错误] 子进程 stdout 错误: ${err.message}`);
        });
        node.stderr.on('error', (err) => {
            if (err.code !== 'EPIPE') shopLog(`[错误] 子进程 stderr 错误: ${err.message}`);
        });
        clearTimeout(safetyTimer);
        let analyzerResult = null;

        node.stdout.on('data', (data) => {
            const raw = data.toString();
            const lines = raw.split('\n');
            for (const line of lines) {
                const msg = line.trim();
                if (!msg) continue;
                shopLog(msg);
                // 解析结构化结果
                if (msg.startsWith('RESULT:')) {
                    try {
                        analyzerResult = JSON.parse(msg.substring('RESULT:'.length));
                    } catch (e) {}
                }
                if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                    const idx = msg.indexOf('COOKIE_EXPIRED:');
                    const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                    if (expiredShop) {
                        const safeName = expiredShop.replace(/[\/:*?"<>|]/g, '_');
                        const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                        try {
                            // 守卫：店铺名包含乱码时不删除Cookie（避免编码损坏导致误删）
                            if (!expiredShop.includes('�') && expiredShop.length > 2 && fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            } else {
                                shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${expiredShop})`);
                            }
                        } catch (e) {
                            shopLog(`删除cookie失败: ${e.message}`);
                        }
                    }
                }
            }
        });

        node.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                const msg = line.trim();
                if (msg && !STDERR_SKIP.test(msg)) shopLog('[错误] ' + msg);
            }
        });

        node.on('close', (code) => {
            if (douyinProcess === node) { douyinProcess = null; douyinProcessHeaded = false; isDouyinRunning = false; }
            try { fs.unlinkSync(path.join(WORKSPACE, 'pause_flag.txt')); } catch (e) {}
            const mf = path.join(WORKSPACE, 'cookie_expired.txt');
            if (fs.existsSync(mf)) {
                try {
                    const es = fs.readFileSync(mf, 'utf-8').trim();
                    fs.unlinkSync(mf);
                    if (es) {
                        const sn = es.replace(/[\/:*?"<>|]/g, '_');
                        const cf = path.join(COOKIES_DIR, sn + '.json');
                        // 守卫：店铺名包含乱码时不删除Cookie（避免编码损坏导致误删）
                        if (!es.includes('�') && es.length > 2 && fs.existsSync(cf)) {
                            fs.unlinkSync(cf);
                            shopLog(`Cookie已过期，自动删除店铺: ${es}`);
                        } else {
                            shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${es})`);
                        }
                    }
                } catch (e) { shopLog(`标记文件处理异常: ${e.message}`); }
            }
            shopLog('=== 抖店商品信息获取结束 ===');
            const cookieExpired = analyzerResult && analyzerResult.cookieExpired;
            resolve({ success: true, finished: analyzerResult ? analyzerResult.finished : false, hitZeroOrder: analyzerResult ? analyzerResult.hitZeroOrder : false, cookieExpired: !!cookieExpired, result: analyzerResult });
        });
    });
}

function startPddAnalyzer(targetCount, shopName, shippingFee, insurance, silent = false) {
    return new Promise((resolve) => {
        if (pddProcess) {
            resolve({ success: false, message: '已有运行的拼多多进程' });
            return;
        }
        // 编码修复：如果店铺名是乱码，尝试从cookie文件名反向修复
        shopName = repairShopName(shopName);
        const safetyTimer = setTimeout(() => {
            if (!pddProcess) {
                shopLog('[安全] 超时重置 PDD 进程状态');
            }
        }, 10000);

        shopLog(`=== ${silent ? '[静默]' : '[可视]'} 开始获取拼多多商品 (目标${targetCount}个) [${shopName}] ===`);

        const shopNameFile = path.join(WORKSPACE, 'current_shop_pdd.txt');
        fs.writeFileSync(shopNameFile, shopName, 'utf8'); console.log('[DEBUG-SHOP] Writing:', shopName, 'hex:', Buffer.from(shopName).toString('hex').substring(0,20));

        const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
        fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));
        try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}

        const pddScript = path.join(WORKSPACE, 'pdd-shop-analyzer.js');
        const node = spawn('node', [pddScript, targetCount.toString(), silent ? '--headless' : '--headed'], {
            windowsHide: true,
            cwd: WORKSPACE
        });
        pddProcess = node;
        pddProcessHeaded = !silent;
        clearTimeout(safetyTimer);
        let analyzerResult = null;
        let sawResultLine = false;
        let invalidResult = false;
        let stdoutBuffer = '';

        const processLine = (line) => {
            const msg = line.trim();
            if (!msg) return;
            shopLog(msg);
            if (msg.startsWith('RESULTS:')) {
                // backward compat with typo - ignore
            } else if (msg.startsWith('RESULT:')) {
                sawResultLine = true;
                try {
                    analyzerResult = JSON.parse(msg.substring('RESULT:'.length));
                } catch (e) {
                    invalidResult = true;
                    shopLog(`[解析] RESULT解析失败: ${e.message}`);
                }
            }
        };

        node.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop();
            lines.forEach(processLine);
        });

        node.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                const msg = line.trim();
                if (msg && !STDERR_SKIP.test(msg)) shopLog('[PDD错误] ' + msg);
            }
        });

        node.on('close', (code) => {
            if (pddProcess === node) { pddProcess = null; pddProcessHeaded = false; }
            // Flush remaining buffer
            if (stdoutBuffer.trim()) processLine(stdoutBuffer);
            // Check marker file (fallback only)
            const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
            let markerCookieExpired = false;
            try {
                if (fs.existsSync(markerFile)) {
                    markerCookieExpired = true;
                    const expiredShop = fs.readFileSync(markerFile, 'utf8').trim();
                    if (expiredShop) {
                        if (!expiredShop.includes('�') && expiredShop.length > 2) {
                            removeShop(expiredShop);
                            shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                        } else {
                            shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${expiredShop})`);
                        }
                    }
                    fs.unlinkSync(markerFile);
                }
            } catch (e) {}
            // Structured result classification
            const cookieExpired = analyzerResult?.cookieExpired === true || markerCookieExpired;
            const success = code === 0 && analyzerResult?.success === true && !cookieExpired;
            let errorCode = null;
            if (!sawResultLine && !analyzerResult) errorCode = 'MISSING_RESULT';
            else if (sawResultLine && invalidResult && !analyzerResult) errorCode = 'INVALID_RESULT';
            else if (analyzerResult && analyzerResult.success !== true && !analyzerResult.errorCode) errorCode = 'ANALYZER_FAILED';
            else if (analyzerResult?.errorCode) errorCode = analyzerResult.errorCode;
            shopLog(`=== 拼多多商品获取结束${cookieExpired ? ' (Cookie已过期)' : ''} ===`);
            resolve({ success, finished: success && analyzerResult?.finished === true, hitZeroOrder: analyzerResult?.hitZeroOrder || false, cookieExpired, errorCode, writeCount: analyzerResult?.writeCount || 0, totalProducts: analyzerResult?.totalProducts || 0, result: analyzerResult });
        });
    });
}

    if (req.url === '/run-douyin-analyzer' && req.method === 'POST') {
        // 先读取参数并启动子进程，再回复前端。否则前端首次状态轮询会早于
        // isDouyinRunning/douyinProcess 的设置，从而误判任务已结束。
        const chunks = [];
        let bodySize = 0;
        req.on('data', chunk => { bodySize += chunk.length; if (bodySize > MAX_BODY) { req.destroy(); return; } chunks.push(chunk); });
        req.on('end', () => {
            if (bodySize > MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '请求体过大' }));
                return;
            }
            let targetCount = 10, shopName = '', shippingFee = 2.4, insurance = 4.01, silent = false;
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                targetCount = parseInt(parsed.targetCount) || 10;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.4;
                insurance = parseFloat(parsed.insurance) || 4.01;
                silent = parsed.silent === true;
            } catch (e) {}
            if (isDouyinRunning) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
                return;
            }
            // Promise 在此同步完成状态设置和 spawn；不等待任务结束，避免请求被长任务占用。
            startDouyinAnalyzer(targetCount, shopName, shippingFee, insurance, silent)
                .catch(err => shopLog('[错误] 抖店分析任务异常: ' + err.message));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: '已启动' }));
        });
        return;
    }

    // 抖店商品信息多次执行
    if (req.url === '/run-douyin-multi' && req.method === 'POST') {
        if (isDouyinMultiRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
            return;
        }
        // 清理旧的cookie过期标记
        const markerFile2 = path.join(WORKSPACE, 'cookie_expired.txt');
        if (fs.existsSync(markerFile2)) { try { fs.unlinkSync(markerFile2); } catch (e) {} }
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            if (bodySize > MAX_BODY) return;
            let targetCount = 10;
            let intervalMinutes = 0;
            let shopName = '';
            let shippingFee = 2.4;
            let insurance = 4.01;
            let silent = false;
            try {
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                intervalMinutes = parseInt(parsed.intervalMinutes) || 0;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.4;
                insurance = parseFloat(parsed.insurance) || 4.01;
                silent = parsed.silent === true;
            } catch (e) {}
            shopLog(`=== ${silent ? '[静默]' : '[可视]'} 开始多次获取抖店商品信息 (目标${targetCount}个, 间隔${intervalMinutes}分钟) [${shopName}] ===`);

            // 将店铺名写入临时文件（避免编码问题）
            const shopNameFile = path.join(WORKSPACE, 'current_shop.txt');
            fs.writeFileSync(shopNameFile, shopName, 'utf8'); console.log('[DEBUG-SHOP] Writing:', shopName, 'hex:', Buffer.from(shopName).toString('hex').substring(0,20));

            // 将费用配置写入临时文件
            const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));
            try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}

            const douyinScript = path.join(WORKSPACE, 'douyin-shop-analyzer.js');
            const node = spawn('node', [douyinScript, targetCount.toString(), intervalMinutes.toString(), 'multi', silent ? '--headless' : '--headed'], {
                windowsHide: true,
                cwd: WORKSPACE,
                // D16：多店多次执行同样冻结本次店铺名；显式空串也是权威值，
                // 绝不回退读取另一任务写在 current_shop.txt 里的店名。
                env: buildAnalyzerLaunchEnv(process.env, shopName)
            });
            douyinMultiProcess = node;
            douyinMultiProcessHeaded = !silent;
            isDouyinMultiRunning = true;

            node.stdout.on('data', (data) => {
                const raw = data.toString();
                const lines = raw.split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (!msg) continue;
                    shopLog(msg);
                    if (msg.indexOf('COOKIE_EXPIRED:') !== -1) {
                        const idx = msg.indexOf('COOKIE_EXPIRED:');
                        const expiredShop = msg.substring(idx + 'COOKIE_EXPIRED:'.length).trim();
                        // shopLog(`[DEBUG] 检测到过期信号, 店铺=${expiredShop}`);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            try {
                                // 守卫：店铺名包含乱码时不删除Cookie（避免编码损坏导致误删）
                                if (!expiredShop.includes('�') && expiredShop.length > 2 && fs.existsSync(cookieFile)) {
                                    fs.unlinkSync(cookieFile);
                                    shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                                } else {
                                    shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${expiredShop})`);
                                }
                            } catch (e) {
                                shopLog(`删除cookie失败: ${e.message}`);
                            }
                        }
                    }
                }
            });

            node.stderr.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    const msg = line.trim();
                    if (msg && !STDERR_SKIP.test(msg)) shopLog('[错误] ' + msg);
                }
            });

            node.on('close', (code) => {
                if (douyinMultiProcess === node) { douyinMultiProcess = null; douyinMultiProcessHeaded = false; isDouyinMultiRunning = false; }
                // 检查cookie过期标记文件
                const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
                if (fs.existsSync(markerFile)) {
                    try {
                        const expiredShop = fs.readFileSync(markerFile, 'utf-8').trim();
                        fs.unlinkSync(markerFile);
                        if (expiredShop) {
                            const safeName = expiredShop.replace(/[\\/:*?"<>|]/g, '_');
                            const cookieFile = path.join(COOKIES_DIR, safeName + '.json');
                            // 守卫：店铺名包含乱码时不删除Cookie（避免编码损坏导致误删）
                            if (!expiredShop.includes('�') && expiredShop.length > 2 && fs.existsSync(cookieFile)) {
                                fs.unlinkSync(cookieFile);
                                shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            } else {
                                shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${expiredShop})`);
                            }
                        }
                    } catch (e) {}
                }
                shopLog('=== 抖店商品信息多次执行结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: code === 0,
                    message: code === 0 ? '完成' : '失败'
                }));
            });
        });
        return;
    }

    // 自动化运行期间同步"完成后自动关机"设置
    if (req.url === '/update-auto-shutdown' && req.method === 'POST') {
        const chunks = [];
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (bodySize > MAX_BODY) return;
            if (!isAutoRunning) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '当前没有运行中的自动化流程' }));
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                autoShutdownRequested = parsed.enabled === true;
                log('[自动关机] 设置变更: enabled=' + autoShutdownRequested);
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '请求参数格式错误' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, autoShutdownRequested }));
        });
        return;
    }

    // 自动化流程：轮换执行多个店铺
    if (req.url === '/run-auto-process' && req.method === 'POST') {
        if (isAutoRunning) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: '已有自动化流程在运行' }));
            return;
        }

        // 消费请求体
        const chunks = [];
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (bodySize > MAX_BODY) return;

            let shops = [];
            let targetCount = 10;
            let intervalMinutes = 0;
            let shippingFee = 2.4;
            let insurance = 4.01;
            let platformFee = 0.6;
            let silent = false;

            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                shops = parsed.shops || [];
                targetCount = parseInt(parsed.targetCount) || 10;
                intervalMinutes = parseInt(parsed.intervalMinutes) || 0;
                shippingFee = parseFloat(parsed.shippingFee) || 2.4;
                insurance = parseFloat(parsed.insurance) || 4.01;
                platformFee = parseFloat(parsed.platformFee) || 0.6;
                autoShutdownRequested = parsed.autoShutdownRequested === true;
                silent = parsed.silent === true;
            } catch (e) {}

            if (shops.length === 0) {
                autoShutdownRequested = false; // 无效请求，清理标志防止残留
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '没有店铺配置' }));
                return;
            }

            // 设置运行状态
            isAutoRunning = true;
            autoAbortController = new AbortController();
            const prodAbort = { aborted: false };
            const abortProxy = new Proxy(prodAbort, {
              get(t, p) {
                if (p === 'aborted') return t.aborted || (autoAbortController && autoAbortController.signal.aborted);
                return t[p];
              },
              set(t, p, v) { t[p] = v; return true; },
            });

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: '自动化流程已启动', shopCount: shops.length }));

            shopLog(`[自动化] 启动（调度 ${ISOLATION_SCHED_VERSION}），${shops.length}店，每轮${targetCount}条`);

            try {
                if (!prodAutoScheduler) throw new Error('prodAutoScheduler missing');
                const scheduleResult = await prodAutoScheduler.runProductionAutoSchedule({
                    shops: shops.map((s) => ({ shopName: repairShopName(s.shopName), platform: s.platform || 'douyin' })),
                    targetCount,
                    intervalMinutes,
                    autoShutdown: autoShutdownRequested,
                    getAutoShutdownRequested: () => autoShutdownRequested,
                    silent,
                    workspace: WORKSPACE,
                    maxRounds: 50,
                    abortSignal: abortProxy,
                    version: ISOLATION_SCHED_VERSION,
                    logFn: (m) => shopLog(m),
                    shutdownFn: () => {
                        log(`=== ${SHUTDOWN_DELAY_SEC}秒后自动关机 ===`);
                        spawn('shutdown', ['-s', '-t', String(SHUTDOWN_DELAY_SEC)], { windowsHide: true });
                        shutdownScheduledAt = Date.now();
                    },
                    startAnalyzer: async ({ shop, runId, stateFile, targetCount: tc, silent: sl }) => {
                        if ((shop.platform || 'douyin') === 'pinduoduo') {
                            return startPddAnalyzer(tc, shop.shopName, shippingFee, insurance, sl);
                        }
                        return startDouyinAnalyzer(tc, shop.shopName, shippingFee, insurance, sl, { runId, stateFile });
                    },
                });
                autoStatusDetail = {
                    ...(scheduleResult.status || {}),
                    analyzerVersion: ISOLATION_DEPLOY_VERSION,
                    schedulerVersion: ISOLATION_SCHED_VERSION,
                    allSuccess: scheduleResult.allSuccess,
                    shouldAutoShutdown: scheduleResult.shouldAutoShutdown,
                    lastReason: scheduleResult.lastReason,
                    trackers: scheduleResult.trackers,
                };
                shopLog(`[自动化] 调度结束 reason=${scheduleResult.lastReason} allSuccess=${scheduleResult.allSuccess} shutdown=${scheduleResult.shouldAutoShutdown}`);
            } catch (e) {
                shopLog('[自动化] 调度异常: ' + e.message);
                autoStatusDetail.lastReason = 'scheduler_error:' + e.message;
            }
            autoShutdownRequested = false;
            isAutoRunning = false;
            autoAbortController = null;
            // 关机已由 runProductionAutoSchedule.shutdownFn 在全部 NORMAL_COMPLETE 时触发
        });
        return;
    }

    // 停止自动化流程
    if (req.url === '/stop-auto-process' && req.method === 'POST') {
        if (!isAutoRunning) {
            // 幂等：已停止不作为错误
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, alreadyStopped: true, message: '没有运行中的自动化流程' }));
            return;
        }

        isAutoRunning = false;
        autoShutdownRequested = false;
        autoStatusDetail.lastReason = 'cancelled_by_user';
        autoStatusDetail.finishedAt = new Date().toISOString();
        autoStatusDetail.stopping = true;
        if (autoAbortController) {
            autoAbortController.abort();
        }

        // 重置商品分析运行状态（循环侧也会在取消路径退出，不续开下一轮）
        if (isDouyinRunning) {
            isDouyinRunning = false;
            shopLog('[自动化] 商品获取状态已重置');
        }
        if (isDouyinMultiRunning) {
            isDouyinMultiRunning = false;
            shopLog('[自动化] 商品多次执行状态已重置');
        }

        // 终止商品分析子进程
        const stopProcesses = [
            { proc: douyinProcess, name: '抖音' },
            { proc: douyinMultiProcess, name: '抖音多次' },
            { proc: pddProcess, name: '拼多多' }
        ];
        let killed = 0;
        for (const { proc, name } of stopProcesses) {
            if (proc) {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/T', '/F', '/PID', proc.pid.toString()], { windowsHide: true });
                } else {
                    proc.kill('SIGTERM');
                }
                killed += 1;
                shopLog('[自动化] ' + name + '进程已终止');
            }
        }
        // 不立即置null：taskkill异步，close事件处理器负责清理引用和状态
        // douyinProcess / douyinMultiProcess / pddProcess 由各自的 close 事件置 null

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: '自动化流程已停止', killedProcesses: killed, stopping: true }));
        return;
    }

    // 获取自动化流程状态
    if (req.url === '/get-auto-status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            running: isAutoRunning,
            analyzerVersion: ISOLATION_DEPLOY_VERSION,
            schedulerVersion: typeof ISOLATION_SCHED_VERSION !== 'undefined' ? ISOLATION_SCHED_VERSION : null,
            autoDetail: typeof autoStatusDetail === 'object' ? autoStatusDetail : null,
        }));
        return;
    }
    if (req.url === '/get-deploy-version' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            analyzerVersion: ISOLATION_DEPLOY_VERSION,
            schedulerVersion: typeof ISOLATION_SCHED_VERSION !== 'undefined' ? ISOLATION_SCHED_VERSION : null,
            deployedAt: '2026-09-15T04:36:04.476Z',
        }));
        return;
    }

    // 获取已保存的店铺列表
    if (req.url === '/get-shops' && req.method === 'GET') {
        getShops().then(shops => {
            // SHOP-LIFE-1：列表删除持久状态——普通 Cookie 扫描不复活已删除项（douyin 平台）。
            // 补修 #2：删除记录不可读时明确报错（500），不用全量/空列表冒充成功。
            try {
                const filtered = shopListState.filterShops('douyin', shops);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ shops: filtered }));
            } catch (e) {
                console.error('[列表] 删除记录不可读:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '店铺删除记录不可读：' + (e && e.message ? e.message : String(e)) }));
            }
        });
        return;
    }

    // SHOP-LIFE-1：列表删除（持久、软删除）——只记录排除状态，绝不物理删除 Cookie
    //（物理删除仍走 /remove-shop）；删除持久化失败必须报错，不得假报成功。
    if (req.url === '/remove-shop-list-entry' && req.method === 'POST') {
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => { bodySize += chunk.length; if (bodySize > MAX_BODY) { req.destroy(); return; } body += chunk.toString('utf8'); });
        req.on('end', () => {
            if (bodySize > MAX_BODY) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ success: false, error: '请求体过大' })); return; }
            let shopName = null, platform = 'douyin';
            try {
                const parsed = JSON.parse(body);
                shopName = parsed && typeof parsed.shopName === 'string' ? parsed.shopName.trim() : null;
                platform = parsed && typeof parsed.platform === 'string' && parsed.platform ? parsed.platform : 'douyin';
            } catch (e) { /* 保持 null */ }
            if (!shopName || shopName.length > 100) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: '缺少有效店铺名' }));
                return;
            }
            try {
                shopListState.addRemoved(platform, shopName);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, persisted: true, platform, shopName }));
            } catch (e) {
                console.error('列表删除持久化失败:', e.message);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, error: '删除记录持久化失败：' + (e && e.message ? e.message : String(e)) }));
            }
        });
        return;
    }

    // 登录入口目标清单（只读；页面必须从这里取精确 shopId 作为 targetShopId）
    if (req.url === '/login-targets' && req.method === 'GET') {
        handleLoginTargets(req, res);
        return;
    }

    // 登录新店铺
    if (req.url === '/login-new-shop' && req.method === 'POST') {
        void handleShopLogin(req, res);
        return;
    }

    // 删除失效店铺
    if (req.url === '/remove-shop' && req.method === 'POST') {
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            if (bodySize > MAX_BODY) {
                res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: '请求体过大' }));
                return;
            }
            try {
                const parsed = JSON.parse(body);
                const removed = removeShop(parsed.shopName);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: removed }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    // ========== 拼多多相关接口 ==========
    // 获取拼多多店铺列表（使用独立的cookies目录）
    if (req.url === '/get-pdd-shops' && req.method === 'GET') {
        const pddCookiesDir = path.join(WORKSPACE, 'pdd-cookies');
        (async () => {
            try {
                await fsPromises.mkdir(pddCookiesDir, { recursive: true });
                const files = await fileLimiter.run(() => fsPromises.readdir(pddCookiesDir));
                const shops = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
                // SHOP-LIFE-1：列表删除持久状态（pinduoduo 平台隔离，与 douyin 同名店铺互不影响）。
                // 补修 #2：删除记录不可读时明确报错（500）。
                try {
                    const filtered = shopListState.filterShops('pinduoduo', shops);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ shops: filtered }));
                } catch (e) {
                    console.error('[列表] 删除记录不可读(pdd):', e.message);
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: '店铺删除记录不可读：' + (e && e.message ? e.message : String(e)) }));
                }
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ shops: [] }));
            }
        })();
        return;
    }

    // 登录新拼多多店铺
    if (req.url === '/login-new-pdd-shop' && req.method === 'POST') {
        isDouyinRunning = true;
        shopLog('=== 开始登录拼多多店铺 ===');
        // 消费请求体（避免连接泄漏）
        req.on('data', () => {});
        req.on('end', () => {});
        const pddLoginScript = path.join(WORKSPACE, 'pdd-login-shop.js');
        if (!fs.existsSync(pddLoginScript)) {
            isDouyinRunning = false;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: '拼多多登录脚本不存在，请先创建 pdd-login-shop.js' }));
            return;
        }
        const node = spawn('node', [pddLoginScript], { windowsHide: true, cwd: WORKSPACE });
        let shopName = '';
        // LOGIN-HTTP-1：与 /login-new-shop 相同的长请求加固（响应仅一次/断连不杀子进程/child once/兜底超时）
        let responded = false;
        let childSettled = false;
        const safeRespondPdd = (payload) => {
            if (responded) return;
            responded = true;
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(payload));
        };
        res.on('close', () => { responded = true; });
        const pddLoginServerTimer = setTimeout(() => {
            if (childSettled || responded) return;
            // 与抖店一致：这里只结束 HTTP 等待，子进程状态由 error/close 终态收尾。
            shopLog('[登录] 服务端等待超时（12分钟）：拼多多登录子进程未终止，继续运行到自身终态；结果以日志为准');
            safeRespondPdd({ success: false, message: '登录等待超时（12分钟）：扫码/验证未完成；子进程未终止，结果以日志为准' });
        }, 720000);
        if (typeof pddLoginServerTimer.unref === 'function') pddLoginServerTimer.unref();
        node.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) shopLog(msg);
        });
        node.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) {
                if (msg.startsWith('SHOP_NAME:')) {
                    shopName = msg.replace('SHOP_NAME:', '');
                } else if (!STDERR_SKIP.test(msg)) {
                    shopLog('[错误] ' + msg);
                }
            }
        });
        node.on('error', (err) => {
            if (childSettled) return;
            childSettled = true;
            clearTimeout(pddLoginServerTimer);
            isDouyinRunning = false;
            const reason = (err && err.message) ? err.message : String(err);
            shopLog('[错误] 拼多多登录子进程启动失败: ' + reason);
            shopLog('=== 登录拼多多店铺结束 ===');
            safeRespondPdd({ success: false, message: '登录子进程启动失败: ' + reason });
        });
        node.on('close', (code) => {
            if (childSettled) return;
            childSettled = true;
            clearTimeout(pddLoginServerTimer);
            isDouyinRunning = false;
            shopLog('=== 登录拼多多店铺结束 ===');
            if (code === 0 && shopName) {
                // SHOP-LIFE-1 补修 #5：拼多多主动登录成功同样解除分析列表排除（listRestore 随响应返回）；
                // 拼多多绝不进入推广值守（无 watch 字段）。失败如实返回，不掩盖登录成功。
                let listRestore = { ok: true, changed: false };
                try {
                    listRestore = { ok: true, changed: shopListState.removeRemoved('pinduoduo', shopName) };
                } catch (e) {
                    listRestore = { ok: false, changed: false, reason: '列表排除记录解除失败：' + (e && e.message ? e.message : String(e)) };
                    shopLog('[列表] 拼多多' + listRestore.reason);
                }
                safeRespondPdd({ success: true, shopName, listRestore });
            } else {
                safeRespondPdd({ success: false, message: '登录失败或超时' });
            }
        });
        return;
    }

    // 拼多多商品获取
    if (req.url === '/run-pdd-analyzer' && req.method === 'POST') {
        // 智能检查：如果标志为true但进程不存在，重置标志
        if (isDouyinRunning) {
            if (pddProcess) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '已有运行的进程' }));
                return;
            } else {
                shopLog('[修复] 检测到标志未重置，强制重置 isDouyinRunning');
                isDouyinRunning = false;
            }
        }
        isDouyinRunning = true;
        // 防止卡死：如果10秒内进程还没启动，重置标志
        const pddSafetyTimer = setTimeout(() => {
            if (isDouyinRunning && !pddProcess) {
                isDouyinRunning = false;
                shopLog('[安全] 超时重置 isDouyinRunning (PDD)');
            }
        }, 10000);
        let body = '';
        let bodySize = 0;
        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY) { req.destroy(); return; }
            body += chunk.toString('utf8');
        });
        req.on('end', () => {
            if (bodySize > MAX_BODY) return;
            let targetCount = 10, shopName = '', shippingFee = 2.4, insurance = 4.01, silent = false;
            try {
                const parsed = JSON.parse(body);
                targetCount = parseInt(parsed.targetCount) || 1;
                shopName = parsed.shopName || '';
                shippingFee = parseFloat(parsed.shippingFee) || 2.4;
                insurance = parseFloat(parsed.insurance) || 4.01;
                silent = parsed.silent === true;
            } catch {}
            shopLog(`=== ${silent ? '[静默]' : '[可视]'} 开始获取拼多多商品 (目标${targetCount}个) [${shopName}] ===`);
            const pddScript = path.join(WORKSPACE, 'pdd-shop-analyzer.js');
            if (!fs.existsSync(pddScript)) {
                isDouyinRunning = false;
                shopLog('[错误] 拼多多脚本不存在: pdd-shop-analyzer.js');
                shopLog('=== 拼多多商品获取结束 ===');
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, message: '拼多多脚本不存在' }));
                return;
            }
            // 将店铺名写入临时文件
            const shopNameFile = path.join(WORKSPACE, 'current_shop_pdd.txt');
            fs.writeFileSync(shopNameFile, shopName, 'utf8'); console.log('[DEBUG-SHOP] Writing:', shopName, 'hex:', Buffer.from(shopName).toString('hex').substring(0,20));
            const feeConfigFile = path.join(WORKSPACE, 'fee_config.json');
            fs.writeFileSync(feeConfigFile, JSON.stringify({ shippingFee, insurance }));
            try { fs.unlinkSync(DEBUG_STOP_FLAG_FILE); } catch (e) {}
            const node = spawn('node', [pddScript, targetCount.toString(), silent ? '--headless' : '--headed'], { windowsHide: true, cwd: WORKSPACE });
            pddProcess = node;
            pddProcessHeaded = !silent;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, message: '已启动' }));
            let analyzerResult = null;
            let sawResultLine = false;
            let invalidResult = false;
            let stdoutBuffer = '';

            const processLine = (line) => {
                const msg = line.trim();
                if (!msg) return;
                shopLog(msg);
                if (msg.startsWith('RESULT:')) {
                    sawResultLine = true;
                    try {
                        analyzerResult = JSON.parse(msg.substring('RESULT:'.length));
                    } catch (e) {
                        invalidResult = true;
                        shopLog(`[解析] RESULT解析失败: ${e.message}`);
                    }
                }
            };

            node.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop();
                lines.forEach(processLine);
            });
            node.stderr.on('data', (data) => { const msg = data.toString().trim(); if (msg && !STDERR_SKIP.test(msg)) shopLog('[错误] ' + msg); });
            node.on('close', (code) => {
                clearTimeout(pddSafetyTimer);
                if (pddProcess === node) { pddProcess = null; pddProcessHeaded = false; isDouyinRunning = false; }
                if (stdoutBuffer.trim()) processLine(stdoutBuffer);
                const markerFile = path.join(WORKSPACE, 'cookie_expired.txt');
                let markerCookieExpired = false;
                try {
                    if (fs.existsSync(markerFile)) {
                        markerCookieExpired = true;
                        const expiredShop = fs.readFileSync(markerFile, 'utf8').trim();
                        if (expiredShop) {
                            if (!expiredShop.includes('�') && expiredShop.length > 2) {
                                removeShop(expiredShop);
                                shopLog(`Cookie已过期，自动删除店铺: ${expiredShop}`);
                            } else {
                                shopLog(`跳过删除Cookie：店铺名疑似编码损坏 (${expiredShop})`);
                            }
                        }
                        fs.unlinkSync(markerFile);
                    }
                } catch (e) {
                    shopLog(`标记文件处理异常: ${e.message}`);
                }
                try { fs.unlinkSync(path.join(WORKSPACE, 'pause_flag.txt')); } catch (e) {}
                const cookieExpired = analyzerResult?.cookieExpired === true || markerCookieExpired;
                const success = code === 0 && analyzerResult?.success === true && !cookieExpired;
                let errorCode = null;
                if (!sawResultLine && !analyzerResult) errorCode = 'MISSING_RESULT';
                else if (sawResultLine && invalidResult && !analyzerResult) errorCode = 'INVALID_RESULT';
                else if (analyzerResult && analyzerResult.success !== true && !analyzerResult.errorCode) errorCode = 'ANALYZER_FAILED';
                else if (analyzerResult?.errorCode) errorCode = analyzerResult.errorCode;
                shopLog(`=== 拼多多商品获取结束${cookieExpired ? ' (Cookie已过期)' : ''} ===`);
                if (analyzerResult) {
                    shopLog(`  RESULT: ${JSON.stringify(analyzerResult)}`);
                }
            });
        });
        return;
    }

    // 获取日志（票据）
    if (req.url.startsWith('/get-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const { hours, lines } = validateLogParams(url.searchParams.get('hours'), url.searchParams.get('lines'));
        getLogsFromFile(LOG_FILE, hours, lines).then(logs => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ logs }));
        });
        return;
    }

    // 获取抖店/拼多多日志（旧接口，保留兼容）
    if (req.url.startsWith('/get-douyin-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const { hours, lines } = validateLogParams(url.searchParams.get('hours'), url.searchParams.get('lines'));
        getLogsFromFile(DOUYIN_LOG_FILE, hours, lines).then(logs => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ logs }));
        });
        return;
    }

    // 获取店铺商品分析日志（新接口，抖店+拼多多+自动化共用）
    if (req.url.startsWith('/get-shop-logs') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const { hours, lines } = validateLogParams(url.searchParams.get('hours'), url.searchParams.get('lines'));
        getLogsFromFile(SHOP_LOG_FILE, hours, lines).then(logs => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ logs }));
        });
        return;
    }

    // 定时关机（60秒后）
    if (req.url === '/schedule-shutdown' && req.method === 'POST') {
        // 消费请求体（避免连接泄漏）
        req.on('data', () => {});
        req.on('end', () => {});
        log(`=== ${SHUTDOWN_DELAY_SEC}秒后自动关机 ===`);
        spawn('shutdown', ['-s', '-t', String(SHUTDOWN_DELAY_SEC)], { windowsHide: true });
        shutdownScheduledAt = Date.now(); // 记录调度时间
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // 检查关机状态（只读，不产生副作用）
    if (req.url === '/check-shutdown' && req.method === 'GET') {
        if (shutdownScheduledAt) {
            // 根据调度时间计算剩余秒数；若已超过延迟时间，说明早已关机或被外部取消
            const elapsed = Math.floor((Date.now() - shutdownScheduledAt) / 1000);
            const remaining = SHUTDOWN_DELAY_SEC - elapsed;
            if (remaining > 0) {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    shutdownScheduled: true,
                    shutdownTime: `${remaining}秒后`
                }));
            } else {
                // 倒计时已过但服务还在运行，说明关机被外部取消，清理标志位
                shutdownScheduledAt = null;
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ shutdownScheduled: false }));
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ shutdownScheduled: false }));
        }
        return;
    }

    // 取消关机
    if (req.url === '/cancel-shutdown' && req.method === 'POST') {
        // 消费请求体（避免连接泄漏）
        req.on('data', () => {});
        req.on('end', () => {});
        spawn('shutdown', ['/a'], { windowsHide: true });
        shutdownScheduledAt = null; // 清理标志位
        log('=== 已取消自动关机 ===');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // ========== 票据录入系统路由 ==========
    // (原 /bill-ui.html / /bill-ui / /api/bill/* 路由分支已整体移除；详见 drop-sqlite-secondary-ui-20260827)

    // 404
    res.writeHead(404);
    res.end('Not Found');
}

// ========== TLS 证书加载 ==========
function loadTLSCerts() {
    const certPath = process.env.TLS_CERT_PATH;
    const keyPath = process.env.TLS_KEY_PATH;

    if (certPath && keyPath) {
        try {
            return {
                cert: fs.readFileSync(certPath),
                key: fs.readFileSync(keyPath)
            };
        } catch (err) {
            console.warn('[TLS] 读取指定证书失败，将生成自签名证书:', err.message);
        }
    }

    // 自动生成自签名证书
    const selfSignedDir = path.join(WORKSPACE, '.tls');
    const selfCert = path.join(selfSignedDir, 'cert.pem');
    const selfKey = path.join(selfSignedDir, 'key.pem');

    try {
        if (fs.existsSync(selfCert) && fs.existsSync(selfKey)) {
            return {
                cert: fs.readFileSync(selfCert),
                key: fs.readFileSync(selfKey)
            };
        }
    } catch {}

    try {
        fs.mkdirSync(selfSignedDir, { recursive: true });
        execSync(
            `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${selfKey}" -out "${selfCert}" -days 365 -subj "/CN=localhost"`,
            { stdio: 'pipe' }
        );
        logToFile('[TLS] 已生成自签名证书 (.tls/cert.pem)', LOG_FILE);
        return {
            cert: fs.readFileSync(selfCert),
            key: fs.readFileSync(selfKey)
        };
    } catch (err) {
        console.error('[TLS] 无法生成自签名证书:', err.message);
        return null;
    }
}

// ========== HTTPS 服务器 ==========
const tlsCerts = loadTLSCerts();

if (tlsCerts) {
    const httpsServer = https.createServer(tlsCerts, handleRequest);

    httpsServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            // 2026-09-16 修复：端口被占用时**必须退出**。旧实现只打印一行就继续运行，
            // 留下一个既不能提供服务、又登记了进程内每日 07:00 任务的僵尸实例。
            console.error(`HTTPS 端口 ${HTTPS_PORT} 已被占用，服务退出（不留僵尸进程）`);
            releaseLock();
            process.exit(1);
        } else {
            console.error('HTTPS 服务器错误:', err);
        }
    });

    httpsServer.listen(HTTPS_PORT, () => {
        logToFile(`票据管理 HTTPS 服务已启动: https://localhost:${HTTPS_PORT}`, LOG_FILE);
        // 2026-10-09 R1：只有 HTTPS 主服务成功监听后才启动推广值守。
        // 端口冲突/绑定错误时 httpsServer.on('error') 捕获并 process.exit(1)，
        // 本回调不执行 → boot 不被调用 → 零值守任务/零广告读取/零广告动作。
        // TLS 证书不可用时走 else 分支（无 HTTPS 服务），本回调也不执行。
        bootOnListenSuccess(watchDrill);
    });
} else {
    console.warn('[HTTPS] TLS 证书不可用，仅启动 HTTP');
}

// ========== 统一启动：fashion-imagegen Python 后端（2026-09-17） ==========
// 这是「启动电商助手时，检查并启动 Python 后端」的唯一入口。任何启动方式
// （start-server.js / node server.js / 开机自启 vbs）都会走到这里。
//
// 设计要点：
// - 不阻塞 3443 自身可用：3443 先服务，后端就地检查/拉起，结果进状态接口与
//   批量上架页面的错误提示；后端起不来不该让整个电商助手打不开。
// - 复用优先：后端已在跑且身份正确（health + worker.lock/本机记录三方对齐）→ 复用。
// - 身份不明（8000 被别的服务占用）→ 停手并报冲突，不 kill、不重复拉起。
// - 维护标志（data/backend-maintenance.flag）存在时完全停手，人工维护不被打断。
if (!backendManager) {
    console.error('[fashion-backend] 统一启动管理不可用，本次不检查/拉起 8000 后端');
} else {
    backendManager.startMonitoring();
    backendManager.ensureRunning('3443-startup').then((r) => {
        logToFile(`[fashion-backend] 启动检查: ${JSON.stringify(r)}`, LOG_FILE);
        if (r.ok) {
            console.log(`[fashion-backend] 后端就绪（${r.reused ? '复用已运行实例' : '本次拉起'}，pid=${r.pid}）`);
        } else {
            console.error(`[fashion-backend] 后端未就绪 reason=${r.reason} ${r.error || ''}`
                + ` | ${backendManager.describe()}`);
        }
    }).catch((e) => {
        console.error('[fashion-backend] 启动检查异常:', e && e.message);
    });
}

// publish-service（8010）与 8000 同构：3443 先服务，上架服务就地检查/拉起。
// 管理器未激活 = 上游未切换，属正常状态，不打错误日志（见上方激活条件）。
if (publishServiceManager) {
    publishServiceManager.startMonitoring();
    publishServiceManager.ensureRunning('3443-startup').then((r) => {
        logToFile(`[publish-service] 启动检查: ${JSON.stringify(r)}`, LOG_FILE);
        if (r.ok) {
            console.log(`[publish-service] 上架服务就绪（${r.reused ? '复用已运行实例' : '本次拉起'}，pid=${r.pid}）`);
        } else {
            console.error(`[publish-service] 上架服务未就绪 reason=${r.reason} ${r.error || ''}`
                + ` | ${publishServiceManager.describe()}`);
        }
    }).catch((e) => {
        console.error('[publish-service] 启动检查异常:', e && e.message);
    });
}

// 确保退出时清理锁文件
process.on('exit', releaseLock);
// 3443 退出只停"看护"，不结束后端进程：电商助手关掉后，8000 应继续为已排定的
// 批次与飞书侧服务，避免把后端生命周期绑在 Node 进程上。
process.on('exit', () => {
    try { backendManager?.stopMonitoring(); } catch { /* 忽略 */ }
    try { publishServiceManager?.stopMonitoring(); } catch { /* 忽略 */ }
});
// 允许自签名证书的HTTPS请求（不输出警告）
