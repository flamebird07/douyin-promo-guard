'use strict';

const path = require('path');
const { fork, execFile } = require('child_process');
const { loginSnapshot, commitShopLogin, analyzerLoginSnapshot } = require('./login-shop');
const { LoginFailure, MESSAGES, failureCode, shopRef, projectLoginTargets } = require('./login-target-gate');

// Only call for the still-live root that this handler forked. A PID is not a
// durable process handle: never retry taskkill after root exit (PID reuse), and
// never claim this is Job Object containment of detached/escaped descendants.
function terminateOwnedChild(child, { closed, processGroup = false, treeInGroup = false } = {}, deps = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid === process.pid
    || closed || child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ verified: false });
  }
  if ((deps.platform || process.platform) === 'win32') {
    return new Promise((resolve) => {
      (deps.execFile || execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, timeout: 10000,
      }, (error) => resolve({ verified: !error }));
    });
  }
  if (!processGroup) return Promise.resolve({ verified: false });
  try {
    (deps.kill || process.kill)(-child.pid, 'SIGKILL');
    // A detached fork establishes ONLY the worker's group. Playwright may
    // launch the browser in another group, so the default must fail closed.
    // Only a caller with a separately established whole-tree guarantee (e.g.
    // our leaf-only test fixture) may assert treeInGroup.
    return Promise.resolve({ verified: treeInGroup === true });
  } catch (_) {
    return Promise.resolve({ verified: false });
  }
}

// 页面登录入口的目标清单：只读投影值守配置行（id + 展示名）。配置不可读时如实 500，
// 页面必须据此拒绝发起登录——绝不允许回退到按店名猜目标。
function createLoginTargetsHandler(options) {
  const loadConfig = options.loadConfig || (() => require(path.join(options.guardDir, 'src', 'config'))
    .loadConfigFrom(options.configPath || path.join(options.guardDir, 'config', 'config.json')));
  return function handleLoginTargets(req, res) {
    let payload;
    let status = 200;
    try {
      const cfgResult = loadConfig();
      const shops = cfgResult && cfgResult.config ? cfgResult.config.shops : null;
      payload = { ok: true, targets: projectLoginTargets(shops) };
    } catch (_) {
      payload = { ok: false, error: '登录目标配置不可读，暂不能登录' };
      status = 500;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
}

function createShopLoginHandler(options) {
  let active = false;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || 720000;
  const stopGraceMs = options.stopGraceMs ?? 2000;
  const cleanupWaitMs = options.cleanupWaitMs ?? 15000;
  const log = options.log || (() => {});
  const setRunning = options.setRunning || (() => {});
  const owned = new WeakSet();
  const spawnLogin = options.spawnLogin || ((args) => {
    const child = fork(path.join(options.workspace, 'login-shop.js'), args, {
      cwd: options.workspace, silent: true, detached: process.platform !== 'win32',
    });
    owned.add(child);
    return child;
  });
  // Injected spawners must supply their own ownership-aware terminator. In
  // particular, a test double's made-up PID must never reach an OS kill API.
  const terminateChild = options.terminateChild || ((child, state) => owned.has(child)
    ? terminateOwnedChild(child, { ...state, processGroup: process.platform !== 'win32' })
    : Promise.resolve({ verified: false }));
  const loadConfig = options.loadConfig || (() => require(path.join(options.guardDir, 'src', 'config')).loadConfigFrom(options.configPath));
  const commit = options.commit || commitShopLogin;

  return function handleShopLogin(req, res) {
    const respond = (result, status = 200) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    };
    if (active) {
      req.resume();
      respond({ success: false, code: 'LOGIN_BUSY', message: MESSAGES.LOGIN_BUSY }, 409);
      return Promise.resolve();
    }
    active = true;
    setRunning(true);
    const deadline = now() + timeoutMs;
    const controller = new AbortController();
    let child = null;
    let candidate = null;
    let phase = 'pending';
    let targetShopId;
    let cfgResult;
    let initialConfigFingerprint;
    let analyzerSnapshot;
    let bytes = 0;
    const chunks = [];
    let stopTimer;
    let cleanupTimer;
    let childFailure = null;
    let closed = false;
    let cleaned = false;
    let terminationStarted = false;
    let terminationSettled = false;
    let terminationVerified = false;
    let timer;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const audit = (code) => log(JSON.stringify({ kind: 'login', code, shopRef: shopRef(targetShopId), takeover: false }));
    const finish = (result, release = true) => {
      if (phase === 'finished') return;
      phase = 'finished';
      candidate = null;
      chunks.length = 0;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      clearTimeout(cleanupTimer);
      req.removeListener('aborted', onDisconnect);
      req.removeListener('error', onDisconnect);
      res.removeListener('close', onClose);
      if (release) { active = false; setRunning(false); }
      audit(result.code);
      respond(result);
      resolveDone(result);
    };
    const failResult = (code) => ({ success: false, code, message: MESSAGES[code] || MESSAGES.LOGIN_FAILED });
    const cleanupFailed = () => finish({ success: false, code: 'LOGIN_CLEANUP_FAILED',
      message: '登录进程清理未确认；已阻止新登录，请核查残留进程', cleanupVerified: false }, false);
    const finishCancelled = () => {
      if (phase !== 'cancelled' || !closed) return;
      if (terminationStarted) {
        if (!terminationSettled) return;
        if (!terminationVerified) { cleanupFailed(); return; }
      } else if (!cleaned) return;
      finish(failResult(controller.signal.reason));
    };
    const terminate = () => {
      if (phase !== 'cancelled' || terminationStarted) return;
      terminationStarted = true;
      clearTimeout(stopTimer);
      // Keep waiting for BOTH close and this result, whichever arrives first.
      Promise.resolve().then(() => terminateChild(child, { closed })).then((result) => {
        if (phase !== 'cancelled') return;
        terminationSettled = true;
        terminationVerified = !!result && result.verified === true;
        finishCancelled();
      }, () => {
        terminationSettled = true;
        finishCancelled();
      });
    };
    const send = (message) => {
      if (!child.connected) return;
      try { child.send(message, () => {}); } catch (_) { /* grace/cleanup deadline still applies */ }
    };
    const cancel = (code) => {
      if (phase !== 'pending') return;
      phase = 'cancelled';
      controller.abort(code);
      candidate = null;
      chunks.length = 0;
      if (!child) { finish(failResult(code)); return; }
      clearTimeout(timer);
      cleanupTimer = setTimeout(cleanupFailed, stopGraceMs + cleanupWaitMs);
      if (cleaned) {
        send({ type: 'release' });
        finishCancelled();
      } else if (closed) {
        // Root already gone without a cleanup acknowledgement: do not target a
        // potentially recycled PID. Default terminator fails closed here.
        terminate();
      } else {
        send({ type: 'cancel' });
      }
      if (phase === 'cancelled' && !terminationStarted) stopTimer = setTimeout(terminate, stopGraceMs);
    };
    const onDisconnect = () => cancel('LOGIN_CANCELLED');
    const onClose = () => { if (!res.writableFinished) onDisconnect(); };
    req.once('aborted', onDisconnect);
    req.once('error', onDisconnect);
    res.once('close', onClose);
    timer = setTimeout(() => cancel('LOGIN_TIMEOUT'), timeoutMs);
    req.on('data', (chunk) => {
      if (phase !== 'pending') return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8192) { cancel('INVALID_REQUEST'); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => {
      if (phase !== 'pending') return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        chunks.length = 0;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LoginFailure('INVALID_REQUEST');
        if (Object.hasOwn(body, 'targetShopId')
          && (typeof body.targetShopId !== 'string' || !body.targetShopId.trim())) throw new LoginFailure('TARGET_REQUIRED');
        targetShopId = body.targetShopId;
        cfgResult = loadConfig();
        if (targetShopId) initialConfigFingerprint = loginSnapshot(cfgResult, targetShopId).configFingerprint;
        else analyzerSnapshot = analyzerLoginSnapshot(path.join(options.workspace, 'cookies'));
        if (req.aborted || res.destroyed) { cancel('LOGIN_CANCELLED'); return; }
        child = spawnLogin(['--prepare-only', ...(targetShopId ? ['--shop', targetShopId] : []), '--config', cfgResult.sourcePath]);
      } catch (error) {
        const code = error instanceof SyntaxError ? 'INVALID_REQUEST' : failureCode(error);
        finish(failResult(code));
        return;
      }
      // Cookie candidates use private IPC, never stdout, stderr or disk staging.
      if (child.stdout) child.stdout.resume();
      if (child.stderr) child.stderr.resume();
      child.on('message', (message) => {
        if (phase === 'finished') return;
        if (message && message.type === 'login-cleaned') {
          cleaned = true;
          // During taskkill, keep the root alive; do not race a cooperative
          // release against /PID lookup. Await the termination result instead.
          if (!terminationStarted) send({ type: 'release' });
          finishCancelled();
          return;
        }
        if (phase !== 'pending') return;
        if (message && message.type === 'login-prepared' && !candidate) candidate = message.candidate;
        else if (message && message.type === 'login-failed' && Object.hasOwn(MESSAGES, message.code)) childFailure = message.code;
        else if (message && message.type === 'login-cleanup-failed') cancel(childFailure || 'CHILD_FAILED');
        else cancel('CHILD_FAILED');
      });
      child.once('error', () => {
        childFailure = 'CHILD_FAILED';
        if (!child.pid) finish(failResult(childFailure));
        else cancel(childFailure);
      });
      child.once('close', (code) => {
        closed = true;
        if (phase === 'finished') return;
        if (phase === 'cancelled') {
          finishCancelled();
          if (!cleaned && !terminationStarted) terminate();
          return;
        }
        if (!cleaned) { cancel(childFailure || 'CHILD_FAILED'); return; }
        if (code !== 0 || childFailure || !candidate) { finish(failResult(childFailure || 'CHILD_FAILED')); return; }
        setImmediate(() => {
          if (phase !== 'pending') return;
          try {
            const check = () => {
              if (req.aborted || res.destroyed) throw new LoginFailure('LOGIN_CANCELLED');
              if (now() >= deadline) throw new LoginFailure('LOGIN_TIMEOUT');
              if (controller.signal.aborted) throw new LoginFailure(controller.signal.reason);
            };
            check();
            const result = commit({
              cfgResult, targetShopId, candidate, initialConfigFingerprint, analyzerSnapshot, signal: controller.signal,
              beforeCommit: () => { check(); phase = 'committing'; },
            });
            // COOKIE-FOUR-REPAIR-20261024：恢复 GitHub 原有接线——四份副本全部成功才
            // 允许值守接管（discovery/join）；缺份/失败 → join 零调用，如实回执。
            if (result && result.success) {
              if (!result.partial && typeof options.joinAfterLogin === 'function' && result.shopName) {
                try {
                  const j = options.joinAfterLogin(result.shopName);
                  if (j && typeof j === 'object') {
                    const { completion, ...publicJoin } = j;
                    if (completion && typeof completion.catch === 'function') completion.catch(() => {});
                    result.watch = publicJoin;
                  }
                } catch (error) {
                  result.watch = { attempted: true, joined: false, reason: '值守接管入口异常: ' + (error && error.message ? error.message : String(error)) };
                }
              } else if (result.partial) {
                result.watch = {
                  attempted: false, joined: false,
                  reason: '推广会话副本未全部保存，跳过值守接管（可重试同步，无需重新扫码）',
                };
              }
            }
            if (!targetShopId && result.success && options.restoreList) {
              try { result.listRestore = { ok: true, changed: options.restoreList(result.shopName) }; }
              catch (_) { result.listRestore = { ok: false, reason: '店铺列表恢复失败，登录已保存' }; }
            }
            finish(result);
          } catch (error) {
            finish(failResult(failureCode(error)));
          }
        });
      });
    });
    if (req.aborted || res.destroyed) cancel('LOGIN_CANCELLED');
    return done;
  };
}

module.exports = { createShopLoginHandler, createLoginTargetsHandler, terminateOwnedChild };
