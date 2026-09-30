'use strict';

/**
 * 配置门禁：千川账户 ID 可选（店铺归属 = Cookie 文件绑定）。
 * 启用千川费用/清单数据源时，任何店铺（含第一家）未配置 accountId 不得使整个
 * 值守配置变为不可启动；缺店铺 ID、缺 Cookie 文件等原有拒绝必须保持有效；
 * 显式填写非法 accountId 的格式校验按现状保留。
 * 全部使用临时配置文件与假店铺，不读取生产 config/config.json，不触碰真实 Cookie。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadConfigFrom } = require('../src/config');
const { makeTempDir } = require('./helpers');

const RULES = [{
  type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today',
  timezone: 'Asia/Shanghai', enabled: true,
}];

/** 写入一份除 shops 外其余必填齐全的临时配置；千川费用+清单数据源同时启用。 */
function writeCfg(dir, shops) {
  const p = path.join(dir, 'cfg.json');
  fs.writeFileSync(p, JSON.stringify({
    shops,
    rules: RULES,
    monitor: { costDataSource: 'qianchuan', adListDataSource: 'qianchuan', orderDataSource: 'compass' },
  }), 'utf-8');
  return p;
}

test('两家店均不填 accountId（千川数据源启用）→ 配置 ready，不因账户 ID 产生 pending', () => {
  const dir = makeTempDir('cfg-account-optional-');
  try {
    const p = writeCfg(dir, [
      { id: '假店甲', name: '假店甲', cookieFile: '假店甲', enabled: true },
      { id: '假店乙', name: '假店乙', cookieFile: '假店乙', enabled: true },
    ]);
    const r = loadConfigFrom(p);
    assert.strictEqual(r.ready, true, `应 ready，实际 pending：${JSON.stringify(r.pending)}`);
    assert.strictEqual(
      r.pending.filter((x) => /accountId/.test(x)).length, 0,
      '不得出现任何 accountId 相关 pending'
    );
    // 不伪造、不写回：合并结果中 accountId 保持未配置
    assert.strictEqual(r.config.shops[0].accountId, undefined);
    assert.strictEqual(r.config.shops[1].accountId, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缺店铺唯一标识（TODO 占位）→ 原有拒绝仍有效，ready=false', () => {
  const dir = makeTempDir('cfg-account-optional-');
  try {
    const p = writeCfg(dir, [
      { id: 'TODO-待填', name: '假店甲', cookieFile: '假店甲', enabled: true },
      { id: '假店乙', name: '假店乙', cookieFile: '假店乙', enabled: true },
    ]);
    const r = loadConfigFrom(p);
    assert.strictEqual(r.ready, false);
    assert.ok(
      r.pending.some((x) => /shops\[0\]\.id/.test(x)),
      `须逐店拒绝缺 ID，实际 pending：${JSON.stringify(r.pending)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('缺 cookieFile → 原有拒绝仍有效，ready=false', () => {
  const dir = makeTempDir('cfg-account-optional-');
  try {
    const p = writeCfg(dir, [
      { id: '假店甲', name: '假店甲', enabled: true },
      { id: '假店乙', name: '假店乙', cookieFile: '假店乙', enabled: true },
    ]);
    const r = loadConfigFrom(p);
    assert.strictEqual(r.ready, false);
    assert.ok(
      r.pending.some((x) => /shops\[0\]\.cookieFile/.test(x)),
      `须逐店拒绝缺 Cookie 文件，实际 pending：${JSON.stringify(r.pending)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('显式填写非法 accountId（非 8~20 位数字）→ 格式校验按现状保留拒绝', () => {
  const dir = makeTempDir('cfg-account-optional-');
  try {
    const p = writeCfg(dir, [
      { id: '假店甲', name: '假店甲', cookieFile: '假店甲', enabled: true, accountId: 'abc' },
      { id: '假店乙', name: '假店乙', cookieFile: '假店乙', enabled: true },
    ]);
    const r = loadConfigFrom(p);
    assert.strictEqual(r.ready, false);
    assert.ok(
      r.pending.some((x) => /shops\[0\]\.accountId/.test(x)),
      `非法格式仍须拒绝，实际 pending：${JSON.stringify(r.pending)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('显式填写合法格式 accountId（假 ID）→ 同样 ready，填写与否均不阻断', () => {
  const dir = makeTempDir('cfg-account-optional-');
  try {
    const p = writeCfg(dir, [
      { id: '假店甲', name: '假店甲', cookieFile: '假店甲', enabled: true, accountId: '1234567890123456' },
      { id: '假店乙', name: '假店乙', cookieFile: '假店乙', enabled: true },
    ]);
    const r = loadConfigFrom(p);
    assert.strictEqual(r.ready, true, `应 ready，实际 pending：${JSON.stringify(r.pending)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
