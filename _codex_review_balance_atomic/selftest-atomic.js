"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const proto = {
  nowFn() { return Date.parse("2026-10-31T12:00:00.000Z"); },
  _applyBalanceToLastData(target, stateRead) {
    if (!target) return;
    const bal = stateRead && stateRead.balance ? stateRead.balance : null;
    if (bal && bal.balanceCents != null) {
      target.balanceCents = bal.balanceCents;
      target.balanceAt = bal.balanceAt || null;
      target.balanceStatus = "ok";
      target.balanceReason = null;
    } else if (bal && bal.reason) {
      target.balanceCents = null;
      target.balanceAt = bal.balanceAt || null;
      target.balanceStatus = "error";
      target.balanceReason = String(bal.reason);
    } else {
      target.balanceCents = null;
      target.balanceAt = bal && bal.balanceAt ? bal.balanceAt : null;
      target.balanceStatus = "missing";
      target.balanceReason = "本轮未返回余额读数";
    }
  },
  _markShopDataRefreshing(rt) {
    rt.dataRefreshing = true;
    if (rt.lastData && typeof rt.lastData === "object") rt.lastData.refreshing = true;
  },
  _commitShopLastData(rt, candidate) {
    candidate.refreshing = false;
    rt.lastData = candidate;
    rt.lastDataAt = new Date(this.nowFn()).toISOString();
    rt.dataRefreshing = false;
  },
};

const rt = {
  lastData: { costCents: 27, orders: 1, balanceCents: 29973, balanceAt: "2026-10-31T11:40:03.000Z", balanceStatus: "ok", balanceReason: null, fetchedAt: "old" },
  lastDataAt: "2026-10-31T11:41:08.000Z",
  dataRefreshing: false,
};
const oldSnap = rt.lastData;
proto._markShopDataRefreshing(rt);
assert.strictEqual(rt.dataRefreshing, true);
assert.strictEqual(rt.lastData, oldSnap);
assert.strictEqual(rt.lastData.balanceCents, 29973);
assert.strictEqual(rt.lastData.costCents, 27);
assert.strictEqual(rt.lastData.refreshing, true);

const candidate = { costCents: 99, orders: 2, fetchedAt: "new", source: "promo-page" };
assert.strictEqual(rt.lastData.costCents, 27);
assert.notStrictEqual(rt.lastData.balanceCents, null);

proto._applyBalanceToLastData(candidate, { balance: { balanceCents: 29973, balanceAt: "2026-10-31T12:00:00.000Z" } });
proto._commitShopLastData(rt, candidate);
assert.strictEqual(rt.lastData.costCents, 99);
assert.strictEqual(rt.lastData.balanceCents, 29973);
assert.strictEqual(rt.lastData.balanceStatus, "ok");
assert.strictEqual(rt.lastData.balanceReason, null);
assert.strictEqual(rt.lastData.refreshing, false);
assert.strictEqual(rt.dataRefreshing, false);
assert.strictEqual(rt.lastDataAt, "2026-10-31T12:00:00.000Z");

const c0 = { costCents: 1 };
proto._applyBalanceToLastData(c0, { balance: { balanceCents: 0, balanceAt: "t" } });
assert.strictEqual(c0.balanceCents, 0);
assert.strictEqual(c0.balanceStatus, "ok");

const cFail = { costCents: 1 };
proto._applyBalanceToLastData(cFail, { balance: { balanceCents: null, reason: "未找到标签", balanceAt: "t" } });
assert.strictEqual(cFail.balanceCents, null);
assert.strictEqual(cFail.balanceStatus, "error");
assert.ok(String(cFail.balanceReason).includes("未找到"));

const cMiss = {};
proto._applyBalanceToLastData(cMiss, {});
assert.strictEqual(cMiss.balanceCents, null);
assert.strictEqual(cMiss.balanceStatus, "missing");

const srcPath = path.join(__dirname, "monitor-src-check.js");
// actual monitor path passed via argv
const monitorPath = process.argv[2];
const src = fs.readFileSync(monitorPath, "utf8");
assert.ok(!/rt\.lastData\s*=\s*this\._summarizeData/.test(src), "不得再直接 summarize 赋给 rt.lastData");
assert.ok(src.includes("const candidate = this._summarizeData(data)"));
assert.ok(src.includes("_markShopDataRefreshing(rt)"));
assert.ok(src.includes("this._applyBalanceToLastData(candidate, stateRead)"));
assert.ok(src.includes("_commitShopLastData(rt, candidate)"));
// rt.lastData = 仅应出现在 _commitShopLastData 体内（允许注释外）
const re = /^\s*rt\.lastData\s*=/gm;
const hits = [];
let m;
const lines = src.split(/\n/);
lines.forEach((line, i) => {
  if (/^\s*rt\.lastData\s*=/.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) hits.push(i + 1);
});
assert.deepStrictEqual(hits, [1624], "公开 lastData 赋值应只有 _commitShopLastData 一处, got " + JSON.stringify(hits));

console.log("PASS balance-atomic-commit selftest");
