const test=require('node:test'),assert=require('node:assert/strict');
const {createCandidateBrowserFactory}=require('../src/login/candidate-browser.js');
test('duplicate acquisition must reject without closing the still-active browser owned by the first job',async()=>{
 let connected=true,closes=0;
 const browser={newContext:async()=>({}),isConnected:()=>connected,close:async()=>{closes++;connected=false;}};
 const factory=createCandidateBrowserFactory({injectedFactory:async()=>browser});
 const ownerA=await factory();assert.equal(ownerA,browser);assert.equal(ownerA.isConnected(),true);
 await assert.rejects(()=>factory(),/重复/);
 assert.equal(closes,0,'A duplicate borrower does not acquire ownership and must not close job A');
 assert.equal(ownerA.isConnected(),true,'Job A must survive the failed acquisition');
 await ownerA.close();assert.equal(closes,1);
});
