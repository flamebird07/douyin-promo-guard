const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=path.join(__dirname,'..');
const {openQianchuanHome}=require(path.join(root,'src/adapters/qianchuan-reader.js'));
const {createDefaultCandidateVerifier}=require(path.join(root,'src/login/session.js'));
function browser(c){let connected=true;const pg={goto:async()=>{},url:()=> 'https://fxg.jinritemai.com/login/common',isClosed:()=>false,evaluate:async()=>null,waitForTimeout:async()=>{},getByText:()=>({count:async()=>0,first:()=>({waitFor:async()=>{throw Error('not attached')}})}),locator:()=>({first:()=>({textContent:async()=>'',isVisible:async()=>false,count:async()=>0})}),on(){},off(){}};return{newContext:async()=>{c.contexts++;return{addCookies:async()=>{c.added++;},newPage:async()=>pg,cookies:async()=>[],close:async()=>{}}},isConnected:()=>connected,close:async()=>{connected=false;c.closed++;}};}
test('independent: cancellation inside an active restore must prevent the next candidate launch',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'isolation-cancel-inner-')),name='SYNTHETIC_ONLY',token={cancelled:false,reason:null},c={contexts:0,added:0,closed:0},calls={all:0,after:0};
 fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify([{name:'sessionid',value:'FAKE-ONLY',domain:'.jinritemai.com',path:'/',expires:4102444800}]));
 try{await assert.rejects(()=>openQianchuanHome({cookieWorkDir:dir,edgePath:null},{id:name,name,compassShopName:name,cookieFile:name+'.json',accountId:'FAKE_ACCOUNT'},{browserFactory:async()=>{calls.all++;if(token.cancelled)calls.after++;return browser(c);},cancelToken:token,settleTimeoutMs:3,settleIntervalMs:1,readinessTimeoutMs:3,readinessIntervalMs:1,restoreRunner:async(_cfg,_shop,p)=>{const a=await p.candidateBrowserFactory();await a.close();token.cancelled=true;token.reason='read-deadline';try{const b=await p.candidateBrowserFactory();await b.close();}catch{}return{ok:false,reason:'synthetic no promotion'};}}));
 assert.equal(calls.after,0,'The active restore factory must not launch a new process after cancellation');
 }finally{const resolved=path.resolve(dir),tempRoot=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(tempRoot)||!path.basename(resolved).startsWith('isolation-cancel-inner-'))throw Error('Refusing cleanup outside owned test directory');fs.rmSync(resolved,{recursive:true,force:true});}
});
test('independent: cancellation during candidate launch is not login-invalid and must not inject cookies',async()=>{
 const token={cancelled:false,reason:null},c={contexts:0,added:0,closed:0};let now=0;
 const verify=createDefaultCandidateVerifier({}, {cancelToken:token,candidateBrowserFactory:async()=>{token.cancelled=true;token.reason='read-deadline';return browser(c);},verifySettleTimeoutMs:3,verifySettleIntervalMs:1,verifyNowFn:()=>now,verifySleep:async ms=>{now+=ms}});
 const result=await verify({cookies:[{name:'sessionid',value:'FAKE-ONLY',domain:'.jinritemai.com',path:'/'}],expectedShopNames:['SYNTHETIC_ONLY']});
 assert.equal(result.classification,'verify-error','Cancellation is not evidence of platform login failure');assert.equal(result.stopChain,true);assert.equal(c.added,0);assert.equal(c.closed,1);
});
