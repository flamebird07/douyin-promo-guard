'use strict';

const path = require('path');
const billDir = path.resolve(__dirname, '..', '..', '..', 'bill-manager');
const { prepareShopLogin, commitShopLogin } = require(path.join(billDir, 'login-shop'));
const { LoginFailure } = require(path.join(billDir, 'login-target-gate'));

async function runQrLogin(loginCfg, opts = {}) {
  if (!opts.cfgResult || opts.cfgResult.config.login !== loginCfg) throw new LoginFailure('TARGET_INVALID');
  const controller = new AbortController();
  const now = opts.now || Date.now;
  const deadline = Math.min(opts.deadline == null ? Infinity : opts.deadline, now() + 720000);
  const cancel = () => controller.abort('LOGIN_CANCELLED');
  const timer = setTimeout(() => controller.abort('LOGIN_TIMEOUT'), Math.max(0, deadline - now()));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const args = { ...opts, signal, deadline, now };
    const candidate = await prepareShopLogin(args);
    return commitShopLogin({ ...args, candidate });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

module.exports = { runQrLogin };
