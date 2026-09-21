'use strict';

/**
 * compactUrls 单元测试（2026-09-21）。
 *
 * 背景：千川管理页地址携带大量 utm/埋点查询参数，Playwright 错误消息原样带出后
 * 单条日志可达数千字符，严重干扰阅读（09-21 08:34 值守日志实录）。
 * 规则：短 URL（≤100 字符）原样保留；长 URL 压缩为
 * 「scheme://host/path?…（参数已省略，原 URL 共 N 字符）」，尾部标点回接。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { compactUrls } = require('../src/lib/log');

test('短 URL（≤100 字符）原样保留', () => {
  const s = '点击"巨量千川"后未到达千川（当前: https://fxg.jinritemai.com/ffa/mshop/homepage/index）';
  assert.strictEqual(compactUrls(s), s);
});

test('长 URL 压缩为 host/path + 省略说明，其余文字不受影响', () => {
  const longUrl = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1710242295996424&awemeId=&utm_source=qianchuan-origin-entrance&utm_medium=doudian-pc&dut=2026-09-21%2008%3A32&x=1';
  const out = compactUrls(`批量暂停后无法恢复乘方管理页回读：page.goto: net::ERR_ABORTED at ${longUrl}`);
  assert.ok(!out.includes('utm_source'), '埋点参数必须被省略');
  assert.ok(out.includes('https://qianchuan.jinritemai.com/uni-prom/overall?…'), '保留可定位的 host/path');
  assert.ok(/原 URL 共 \d+ 字符/.test(out), '标注原始长度');
  assert.ok(out.startsWith('批量暂停后无法恢复乘方管理页回读：page.goto: net::ERR_ABORTED at '), 'URL 前文字不变');
});

test('长 URL 后跟中文标点/句读时标点保留、不吞进 URL', () => {
  const longUrl = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1&utm_source=x&utm_medium=y&utm_campaign=z&more=' + 'a'.repeat(60);
  const out = compactUrls(`读取失败（${longUrl}，已停止）`);
  assert.ok(out.endsWith('，已停止）'), `尾部文字必须保留，实际：${out}`);
  assert.ok(!out.includes('utm_source'), '参数必须省略');
});

test('一段文本含多个长 URL 时逐个压缩', () => {
  const u1 = 'https://a.example.com/path?utm_source=x&utm_medium=y&utm_campaign=z&pad=' + '1'.repeat(40);
  const u2 = 'https://b.example.com/p2?a=1&utm_term=q&utm_content=w&utm_campaign=pad&pad=' + '2'.repeat(40);
  const out = compactUrls(`${u1} 与 ${u2}`);
  assert.ok(out.includes('https://a.example.com/path?…') && out.includes('https://b.example.com/p2?…'), `两个 URL 都要压缩，实际：${out}`);
});

test('无 URL 文本原样返回；非字符串输入安全字符串化', () => {
  assert.strictEqual(compactUrls('普通日志，无地址。'), '普通日志，无地址。');
  assert.ok(compactUrls(null) === 'null' || compactUrls(null) === '');
  assert.ok(compactUrls(123) === '123');
});
