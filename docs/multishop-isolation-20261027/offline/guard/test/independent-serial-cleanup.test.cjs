'use strict';

/**
 * 隔离测试：同轮跨店有界并行 + 确认后广告状态即时更新。
 * 全部 mock + 临时目录，不访问真实广告页、不触发真实开关。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { deriveAdState } = require('../integrations/bill-manager/watch-drill');

function setupTwoShops(t, opts = {}) {
  const cookieDir = makeTempDir('pg-para-cookies-');
  const dataDir = makeTempDir('pg-para-data-');
  t.after(() => {
    assert.ok(path.resolve(cookieDir).startsWith(path.resolve(require('os').tmpdir())+path.sep)); fs.rmSync(cookieDir, { recursive: true, force: true });
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(require('os').tmpdir())+path.sep)); fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const shops = opts.shops || [
    { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
    { id: 'shop-c', name: '店C', cookieFile: '店C', enabled: true },
  ];
  // 仅写入配置内店铺的 Cookie，避免自动发现补进多余店
  for (const s of shops) {
    if (s.cookieFile) writeTempCookie(cookieDir, s.cookieFile);
  }
  const cfgResult = makeCfgResult({
    cookieDir,
    shops,
    monitor: { legacyWholeShopCloseEnabled: true },
    execution: opts.execution,
  });
  const clock = opts.clock || makeClock(shanghaiMs('2026-09-28', '10:00'));
  const controller = makeStatefulController({
    identity: { id: 'shop-a', name: '店A' },
    ads: [{ adId: 'ad-1', name: '甲', status: '投放中' }],
  });
  const reader = makeLinkedReader(controller, { costCents: 100, orders: 10, pageSource: 'mock' }, clock.nowFn);
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, dataDir, cookieDir, clock };
}


test('independent: shops must finish sequentially, peak work equals one',async t=>{const {monitor}=setupTwoShops(t);let active=0,peak=0;const events=[];monitor._pollShop=async shop=>{events.push('start:'+shop.id);peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,20));events.push('end:'+shop.id);active--;return{status:'ok'};};const r=await monitor.pollOnce('independent');assert.equal(r.results.length,3);assert.equal(peak,1);assert.deepEqual(events,['start:shop-a','end:shop-a','start:shop-b','end:shop-b','start:shop-c','end:shop-c']);});

test('independent: returning with pending owned cleanup must not start next shop',async t=>{const {monitor}=setupTwoShops(t);let startedB=false;monitor._pollShop=async shop=>{if(shop.id==='shop-a'){monitor._pendingReadGates.set(shop.id,{shopId:shop.id,phase:'terminal',status:'unknown'});return{status:'blocked'};}startedB=true;return{status:'ok'};};await monitor.pollOnce('independent-cleanup');assert.equal(startedB,false,'Next shop started while predecessor cleanup was still unproven');});

test('independent: previous cycle pending cleanup blocks new shops until proof',async t=>{const {monitor}=setupTwoShops(t);const started=[];monitor._pendingReadGates.set('shop-a',{shopId:'shop-a',phase:'terminal',status:'unknown'});monitor._pollShop=async shop=>{started.push(shop.id);return{status:'ok'};};await monitor.pollOnce('independent-prior-pending');assert.equal(started.some(id=>id!=='shop-a'),false,'Previous-cycle pending browser must not be bypassed');monitor._pendingReadGates.delete('shop-a');started.length=0;await monitor.pollOnce('independent-proof');assert.deepEqual(started,['shop-a','shop-b','shop-c']);});
test('independent: manual shop already processing must not overlap later patrol',async t=>{const {monitor}=setupTwoShops(t);monitor._tryAcquireShop('shop-a');const started=[];monitor._pollShop=async shop=>{started.push(shop.id);return{status:'ok'};};await monitor.pollOnce('independent-existing-manual');assert.deepEqual(started,[],'Patrol must not start another shop while a manual entry owns shop A');monitor._releaseShop('shop-a');await monitor.pollOnce('independent-manual-finished');assert.deepEqual(started,['shop-a','shop-b','shop-c']);});
test('independent: public manual enable must wait for another manual shop owner',async t=>{const {monitor}=setupTwoShops(t);monitor._tryAcquireShop('shop-a');let called=0;monitor._runShopEnablePhaseInner=async()=>{called++;return{status:'ok'};};const blocked=monitor.runManualEnableVerify('shop-b');assert.equal(blocked.code,'shop_busy');assert.equal(called,0);monitor._releaseShop('shop-a');const resumed=monitor.runManualEnableVerify('shop-b');assert.equal(resumed.started,true);await waitFor(()=>monitor.getManualEnableVerifyStatus()?.status==='done');assert.equal(called,1);});