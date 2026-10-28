import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteRepository } from '../src/sqlite.js';
import { createTransferCoordinator } from '../vendor/frontend/src/storage/transfer-v3.js';
import { validateStorageControl } from '../vendor/frontend/src/storage/control.js';
import { encodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';

const encode=value=>JSON.stringify(encodeStorageValue(value));
function setup(t,{hook=async()=>{},validate=async()=>{}}={}) {
  const root=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(root,'boxed-recovery-')),repos=[];
  const open=name=>{const repo=new SqliteRepository(path.join(directory,name+'.sqlite'));repos.push(repo);return repo;};
  t.after(()=>{repos.forEach(repo=>repo.close());assert.equal(path.dirname(fs.realpathSync(directory)),root);assert.ok(path.basename(directory).startsWith('boxed-recovery-'));fs.rmSync(directory,{recursive:true});});
  let source=open('source'),target=open('target'),value={active:'indexeddb',previous:null,lastTransfer:null,journal:null},resumes=0;
  const control={read:async()=>structuredClone(validateStorageControl(value)),update:async fn=>(value=structuredClone(validateStorageControl(fn(structuredClone(value)))))};
  const locks={request:async(_name,_options,fn)=>fn()};
  const adapters={indexeddb:{batchVersion:3,status:async()=>({ok:true}),batchTransfer:(action,args)=>source.batchTransfer[action](...args)},sqlite:{batchVersion:3,status:async()=>({ok:true,database:{batchTransfer:3}}),batchTransfer:(action,args)=>target.batchTransfer[action](...args)}};
  const coordinator=()=>createTransferCoordinator({control,adapters,locks,hook,validate,budget:{limit:2,bytes:700},resume:async()=>{resumes++;}});
  return {control,adapters,coordinator,get source(){return source;},get target(){return target;},get resumes(){return resumes;},reopen(){source.close();target.close();source=open('source');target=open('target');}};
}
async function seed(f) {
  await f.source.execute('putChatMeta',[{chatKey:'source',marker:'keep',date:new Date(0),optional:undefined}]);
  await f.source.execute('putFullMessages',[{chatKey:'source',messages:Array.from({length:6},(_,i)=>({chatKey:'source',messageIndex:i,raw:{mes:'body-'+i+'中'.repeat(70)}}))}]);
  await f.target.execute('putChatMeta',[{chatKey:'old-target',keep:true}]);
}
const area=(repo,dataset=repo.activeDataset())=>repo.db.prepare(`SELECT * FROM ${dataset===0?'records':'records_next'} ORDER BY store,primary_key`).all();
const crash=()=>Object.assign(new Error('simulated-process-exit'),{simulateCrash:true});

test('双阶段控制记录与目标提交成功，分批收尾保留来源、清理旧目标并释放两端锁',async t=>{
  const f=setup(t);await seed(f);const before=area(f.source);
  const result=await f.coordinator().switchTo('sqlite',{confirmed:true});assert.equal(result.ok,true);
  const state=await f.control.read();assert.equal(state.active,'sqlite');assert.equal(state.journal,null);assert.equal(state.previous,'indexeddb');
  assert.deepEqual(area(f.source),before);assert.deepEqual(area(f.target),before);assert.equal(area(f.target,0).length,0);
  assert.equal((await f.source.batchTransfer.inspect(state.lastTransfer)).lock,null);assert.equal((await f.target.batchTransfer.inspect(state.lastTransfer)).lock,null);
  assert.equal((await f.target.execute('getFullMessages',['source'])).length,6);
  assert.equal(f.resumes,1);
  const cleared=await f.coordinator().clearInactive('indexeddb',{confirmed:true});assert.equal(cleared.ok,true);
  assert.equal((await f.control.read()).active,'sqlite');assert.equal((await f.control.read()).previous,null);
  assert.equal(area(f.source).length,0);assert.deepEqual(area(f.target),before);
});

for(const stage of ['registered','inventory','source','prepare','prepared','append','batch-verified','verified','committing','committed','target-checked','before-control','activated','target-activated','finish-target','finish-source','release-source','release-target']) {
  test(`中断窗口 ${stage}：重开后核对登记，正确续搬、撤销或收尾`,async t=>{
    let stopped=false;const f=setup(t,{hook:async name=>{if(name===stage&&!stopped){stopped=true;throw crash();}}});await seed(f);
    const beforeSource=area(f.source),beforeTarget=area(f.target);
    await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}),/simulated/);assert.equal(stopped,true);
    assert.ok((await f.control.read()).journal);f.reopen();const next=f.coordinator();
    await assert.rejects(next.recover(),e=>e.code==='recovery-required');assert.equal(f.resumes,0);
    const result=await next.recover({confirmed:true}),state=await f.control.read();
    assert.equal(state.journal,null);assert.deepEqual(area(f.source),beforeSource);
    if(['registered','inventory'].includes(stage)){assert.equal(result.cancelled,true);assert.equal(state.active,'indexeddb');assert.deepEqual(area(f.target),beforeTarget);}
    else {assert.equal(result.ok,true);assert.equal(state.active,'sqlite');assert.deepEqual(area(f.target),beforeSource);}
    assert.equal(f.resumes,1);
  });
}

for(const mutation of ['modify','insert','delete'])for(const stage of ['batch-verified','committed']) {
  test(`来源 ${mutation}（不更新修订号）发生在 ${stage} 重启间隙，禁止旧清单续搬并保留当前来源和旧目标`,async t=>{
    let stopped=false;const f=setup(t,{hook:async name=>{if(name===stage&&!stopped){stopped=true;throw crash();}}});await seed(f);const beforeTarget=area(f.target);
    await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}));f.reopen();
    if(mutation==='modify')f.source.db.prepare("UPDATE records SET payload=? WHERE store='chat_meta'").run(encode({chatKey:'source',changedWhileClosed:true}));
    if(mutation==='insert')f.source.db.prepare('INSERT INTO records VALUES(?,?,?,?)').run('chat_meta',JSON.stringify('a-before-cursor'),'a-before-cursor',encode({chatKey:'a-before-cursor'}));
    if(mutation==='delete')f.source.db.prepare("DELETE FROM records WHERE store='full_messages' AND primary_key=?").run(JSON.stringify(['source',0]));
    const changed=area(f.source);const result=await f.coordinator().recover({confirmed:true});assert.equal(result.cancelled,true);
    assert.deepEqual(area(f.source),changed);assert.deepEqual(area(f.target),beforeTarget);assert.equal((await f.control.read()).active,'indexeddb');
  });
}

test('暂停后正常写入仍被锁定，明确放弃只清理暂存；已经启用时拒绝撤销',async t=>{
  let current,paused=false;const f=setup(t,{hook:async name=>{if(name==='batch-verified'&&!paused){paused=true;current.requestPause();}}});await seed(f);
  const beforeSource=area(f.source),beforeTarget=area(f.target);current=f.coordinator();
  await assert.rejects(current.switchTo('sqlite',{confirmed:true}),e=>e.code==='paused');
  await assert.rejects(f.source.execute('putChatMeta',[{chatKey:'blocked'}]),/暂停/);
  await assert.rejects(current.abandon(),/确认/);assert.equal((await current.abandon({confirmed:true})).cancelled,true);
  assert.deepEqual(area(f.source),beforeSource);assert.deepEqual(area(f.target),beforeTarget);
  let stopped=false;const g=setup(t,{hook:async name=>{if(name==='activated'&&!stopped){stopped=true;throw crash();}}});await seed(g);
  await assert.rejects(g.coordinator().switchTo('sqlite',{confirmed:true}));await assert.rejects(g.coordinator().abandon({confirmed:true}),/已经正式启用/);
  assert.equal((await g.coordinator().recover({confirmed:true})).ok,true);
});

test('目标提交响应丢失后能核对实际结果再启用，不误回滚或重复搬运',async t=>{
  const f=setup(t);await seed(f);const expected=area(f.source),original=f.adapters.sqlite.batchTransfer;let dropped=false,appends=0;
  f.adapters.sqlite.batchTransfer=async(action,args)=>{
    if(action==='append')appends++;const result=await original(action,args);
    if(action==='commit'&&!dropped){dropped=true;throw Object.assign(new Error('response-lost'),{code:'outcome-unknown'});}return result;
  };
  await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}),/response-lost/);const count=appends;
  assert.equal((await f.control.read()).active,'indexeddb');assert.equal(f.target.activeDataset(),1);
  assert.equal((await f.coordinator().recover({confirmed:true})).ok,true);assert.equal(appends,count);assert.deepEqual(area(f.target),expected);
});

test('已确认批次损坏在续搬前被发现，目标提交后的坏内容也会回退原目标',async t=>{
  for(const stage of ['batch-verified','committed']){
    let stopped=false;const f=setup(t,{hook:async name=>{if(name===stage&&!stopped){stopped=true;throw crash();}}});await seed(f);const old=area(f.target);
    await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}));
    f.target.db.prepare("UPDATE records_next SET payload=? WHERE store='chat_meta'").run(encode({chatKey:'source',corrupt:true}));
    const result=await f.coordinator().recover({confirmed:true});assert.equal(result.cancelled,true);assert.deepEqual(area(f.target),old);
  }
});

test('控制已启用后来源变化继续收尾，不回滚正式目标；提交后当前聊天变化则回退',async t=>{
  let stopped=false;const f=setup(t,{hook:async name=>{if(name==='activated'&&!stopped){stopped=true;throw crash();}}});await seed(f);const expected=area(f.source);
  await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}));
  f.source.db.prepare("UPDATE records SET payload=? WHERE store='chat_meta'").run(encode({chatKey:'source',changedAfterActivation:true}));const changed=area(f.source);
  assert.equal((await f.coordinator().recover({confirmed:true})).ok,true);assert.deepEqual(area(f.target),expected);assert.deepEqual(area(f.source),changed);
  let checks=0;const g=setup(t,{validate:async()=>{if(++checks===2)throw new Error('当前聊天已变化');}});await seed(g);const old=area(g.target);
  assert.equal((await g.coordinator().switchTo('sqlite',{confirmed:true})).cancelled,true);assert.deepEqual(area(g.target),old);
});

for(const stage of ['finish-target','finish-source'])test(`撤销在 ${stage} 中断后按登记继续清理，不重写正式备份`,async t=>{
  let initial=true,aborting=false,stopped=false;const f=setup(t,{hook:async name=>{
    if(name==='batch-verified'&&initial){initial=false;throw crash();}
    if(aborting&&name===stage&&!stopped){stopped=true;throw crash();}
  }});await seed(f);const source=area(f.source),target=area(f.target);
  await assert.rejects(f.coordinator().switchTo('sqlite',{confirmed:true}));aborting=true;
  await assert.rejects(f.coordinator().abandon({confirmed:true}),/simulated/);assert.equal((await f.control.read()).journal.phase,'aborting');
  f.reopen();assert.equal((await f.coordinator().recover({confirmed:true})).cancelled,true);
  assert.deepEqual(area(f.source),source);assert.deepEqual(area(f.target),target);
});
