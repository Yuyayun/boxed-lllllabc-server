import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SqliteRepository} from '../src/sqlite.js';
import {createTransferCoordinator} from '../vendor/frontend/src/storage/transfer-v3.js';
import {encodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';

const encode=value=>JSON.stringify(encodeStorageValue(value));
function readMeter(repo){
  const prepare=repo.db.prepare.bind(repo.db),rows={};let action='outside';
  repo.db.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get(target,key){
    const count=row=>{if(row&&Object.hasOwn(row,'payload'))rows[action]=(rows[action]??0)+1;};
    if(key==='iterate')return function*(...args){for(const row of target.iterate(...args)){count(row);yield row;}};
    if(key==='get'||key==='all')return(...args)=>{const value=target[key](...args);if(Array.isArray(value))value.forEach(count);else count(value);return value;};
    return typeof target[key]==='function'?target[key].bind(target):target[key];
  }});};
  return {rows,async run(name,fn){action=name;try{return await fn();}finally{action='outside';}}};
}
function fixture(t,{from='indexeddb',hook=async()=>{},oldCommit=false,lostReply=false}={}) {
  const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'boxed-read-budget-'));
  const source=new SqliteRepository(path.join(dir,'source.sqlite')),target=new SqliteRepository(path.join(dir,'target.sqlite'));
  const meters={source:readMeter(source),target:readMeter(target)};
  t.after(()=>{source.close();target.close();assert.equal(path.dirname(fs.realpathSync(dir)),root);fs.rmSync(dir,{recursive:true});});
  const to=from==='indexeddb'?'sqlite':'indexeddb',calls={source:{},target:{}};let state={active:from,previous:null,lastTransfer:null,journal:null},lost=false;
  const control={read:async()=>structuredClone(state),update:async fn=>(state=fn(structuredClone(state)))};
  const port=(repo,role)=>({batchVersion:3,status:async()=>({ok:true,database:{batchTransfer:3}}),batchTransfer:async(action,args)=>{
    calls[role][action]=(calls[role][action]??0)+1;
    const value=await meters[role].run(action,()=>repo.batchTransfer[action](...args));
    if(role==='target'&&action==='commit'){
      if(oldCommit){const receipt=await repo.batchTransfer.status(args[0]);receipt.auditDone=false;repo.db.prepare('UPDATE plugin_meta SET value=? WHERE key=?').run(JSON.stringify(receipt),'transfer:'+args[0]);}
      if(lostReply&&!lost){lost=true;throw Object.assign(new Error('lost commit reply'),{code:'outcome-unknown'});}
    }
    return value;
  }});
  const adapters={[from]:port(source,'source'),[to]:port(target,'target')};
  const coordinator=()=>createTransferCoordinator({control,adapters,locks:{request:async(_n,_o,fn)=>fn()},hook:stage=>hook(stage,{source,target,state}),budget:{limit:2,bytes:4096}});
  return {source,target,from,to,calls,control,coordinator,adapters,meters};
}
async function seed(f){for(let n=0;n<7;n++)await f.source.execute('putChatMeta',[{chatKey:'source-'+n,body:'synthetic-'+n}]);await f.target.execute('putChatMeta',[{chatKey:'old-target',keep:true}]);}
const rows=repo=>repo.db.prepare(`SELECT * FROM ${repo.activeDataset()===0?'records':'records_next'} ORDER BY store,primary_key`).all();
for(const from of ['indexeddb','sqlite'])test(`正常 ${from} 方向只完整复核来源一次、验收目标一次，每批仍读回`,async t=>{
  const f=fixture(t,{from});await seed(f);const expected=rows(f.source);
  assert.equal((await f.coordinator().switchTo(f.to,{confirmed:true})).ok,true);
  assert.equal(f.calls.source.startSourceCheck,1);assert.equal(f.calls.source.sourceCheckStep,4);
  assert.equal(f.calls.target.startSeal,1);assert.equal(f.calls.target.sealStep,4);assert.equal(f.calls.target.verifyBatch,4);
  // Each logical scan includes bounded look-ahead and the transactional
  // checkpoint reread. Count actual payload rows returned by SQLite as well.
  assert.ok(f.meters.source.rows.sourceCheckStep<=17);assert.ok(f.meters.target.rows.sealStep<=17);assert.equal(f.meters.target.rows.verifyBatch,14);assert.equal(f.meters.target.rows.commit??0,0);
  assert.deepEqual(rows(f.source),expected);assert.deepEqual(rows(f.target),expected);
});
test('旧端提交后使验收失效时仍完整读回；丢失提交响应后恢复也完整重验',async t=>{
  const old=fixture(t,{oldCommit:true});await seed(old);await old.coordinator().switchTo(old.to,{confirmed:true});assert.equal(old.calls.target.startSeal,2);
  const lost=fixture(t,{lostReply:true});await seed(lost);const expected=rows(lost.source);
  await assert.rejects(lost.coordinator().switchTo(lost.to,{confirmed:true}),/lost commit/);assert.equal((await lost.control.read()).active,lost.from);
  assert.equal((await lost.coordinator().recover({confirmed:true})).ok,true);assert.equal(lost.calls.target.startSeal,2);assert.deepEqual(rows(lost.target),expected);
});
for(const window of ['source','batch-verified'])test(`来源在 ${window} 后改变仍撤销，来源现值及原目标保留`,async t=>{
  let changed=false;const f=fixture(t,{hook:async(stage,{source,target,state})=>{
    if(changed||stage!==window)return;
    if(stage==='batch-verified'&&(await target.batchTransfer.status(state.journal.id)).verified<7)return;
    changed=true;source.db.prepare("UPDATE records SET payload=? WHERE store='chat_meta' AND primary_key=?").run(encode({chatKey:'source-0',changed:true}),JSON.stringify('source-0'));
  }});await seed(f);const before=rows(f.target);
  assert.equal((await f.coordinator().switchTo(f.to,{confirmed:true})).cancelled,true);assert.equal(changed,true);
  assert.deepEqual(rows(f.target),before);assert.equal((await f.source.execute('getChatMeta',['source-0'])).changed,true);
});
test('逐批验货后损坏目标仍被最终验收拦截；提交后修订变化不会启用',async t=>{
  let changed=false;const corrupt=fixture(t,{hook:async(stage,{target,state})=>{
    if(stage!=='batch-verified'||changed||(await target.batchTransfer.status(state.journal.id)).verified<7)return;
    changed=true;target.db.prepare("UPDATE records_next SET payload=? WHERE store='chat_meta' AND primary_key=?").run(encode({chatKey:'source-0',corrupt:true}),JSON.stringify('source-0'));
  }});await seed(corrupt);const old=rows(corrupt.target);assert.equal((await corrupt.coordinator().switchTo(corrupt.to,{confirmed:true})).cancelled,true);assert.deepEqual(rows(corrupt.target),old);
  const revision=fixture(t,{hook:async(stage,{target})=>{if(stage==='committed')target.db.prepare("UPDATE plugin_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();}});await seed(revision);
  await assert.rejects(revision.coordinator().switchTo(revision.to,{confirmed:true}));assert.equal((await revision.control.read()).active,revision.from);assert.ok((await revision.control.read()).journal);
});
test('日志接口故障不改变真实迁移结果，同一任务不反复等待失败日志',async t=>{
  const f=fixture(t);await seed(f);const expected=rows(f.source);let attempts=0;
  f.adapters.sqlite.logEvent=async()=>{attempts++;throw new Error('log unavailable');};
  assert.equal((await f.coordinator().switchTo(f.to,{confirmed:true})).ok,true);assert.equal(attempts,1);assert.deepEqual(rows(f.target),expected);assert.equal((await f.control.read()).journal,null);
});
test('最后来源核对之后修订发生变化，仍撤销目标提交并保留来源现值',async t=>{
  let changed=false;const f=fixture(t,{hook:async(stage,{source})=>{if(stage!=='source-checked'||changed)return;changed=true;source.db.prepare("UPDATE records SET payload=? WHERE primary_key=?").run(encode({chatKey:'source-0',changed:true}),JSON.stringify('source-0'));source.db.prepare("UPDATE plugin_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();}});await seed(f);const target=rows(f.target);
  assert.equal((await f.coordinator().switchTo(f.to,{confirmed:true})).cancelled,true);assert.deepEqual(rows(f.target),target);assert.equal((await f.source.execute('getChatMeta',['source-0'])).changed,true);
});
for(const when of ['initial','midway','status-error'])test(`容量检查 ${when} 失败时来源及旧目标保留，任务不假报成功`,async t=>{
  const f=fixture(t);await seed(f);const source=rows(f.source),target=rows(f.target);let calls=0;
  f.adapters[f.to].checkCapacity=async()=>{calls++;if(when==='initial'||when==='status-error'||calls===3)throw new Error(when==='status-error'?'status unavailable':'space insufficient');};
  await assert.rejects(f.coordinator().switchTo(f.to,{confirmed:true}));assert.equal((await f.control.read()).active,f.from);assert.ok((await f.control.read()).journal);assert.deepEqual(rows(f.source),source);assert.deepEqual(rows(f.target),target);
  assert.equal((await f.coordinator().abandon({confirmed:true})).cancelled,true);assert.deepEqual(rows(f.source),source);assert.deepEqual(rows(f.target),target);
});
