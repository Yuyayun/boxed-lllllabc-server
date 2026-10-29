import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeLog,validateLogEvent} from '../src/runtime-log.js';
const DAY=86400000;
async function cleanAll(log,options={}){let cursor=0,total=0;for(let n=0;n<500;n++){const value=await log.cleanup({...options,cursor,maxFiles:1});total+=value.removed;cursor=value.cursor;if(cursor===null)return total;}throw new Error('清理游标没有结束');}
async function fixture(run){const root=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(root,'boxed-log-test-'));try{await run(dir);}finally{const real=await fs.realpath(dir);assert.equal(path.dirname(real),root);assert.ok(path.basename(real).startsWith('boxed-log-test-'));await fs.rm(real,{recursive:true});}}
async function all(log,category='all'){let cursor,rows=[];for(let n=0;n<100;n++){const result=await log.page({category,cursor,limit:7,bytes:4096});rows.push(...result.entries);cursor=result.cursor;if(!cursor)return rows;}throw new Error('日志游标没有结束');}
test('分段轮换、重启和反向分页不遗漏、不重复，正文密钥不入日志',()=>fixture(async dir=>{
  const log=new RuntimeLog(dir,{maxFileBytes:8192});for(let n=0;n<160;n++)await log.record({taskId:'rotation-test',stage:n%5===0?'error':'inventory',count:n,errorCode:n%5===0?'injected':undefined,payload:'PRIVATE_BODY',token:'PRIVATE_TOKEN'});
  const reopened=new RuntimeLog(dir,{maxFileBytes:8192}),rows=await all(reopened);assert.equal(rows.length,160);assert.equal(new Set(rows.map(x=>x.seq)).size,160);assert.deepEqual(rows.map(x=>x.seq),Array.from({length:160},(_,i)=>160-i));assert.equal((await all(reopened,'error')).length,32);assert.equal((await all(reopened,'migration')).length,160);
  const files=await fs.readdir(dir);assert.ok(files.filter(x=>x.endsWith('.jsonl')).length>1);for(const file of files){const raw=await fs.readFile(path.join(dir,file),'utf8');assert.doesNotMatch(raw,/PRIVATE_/);}
}));
test('七天正常、三十天异常整任务保留，恢复成功仍按异常，未结束永不按年龄删除',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1);const log=new RuntimeLog(dir,{now:()=>now});
  await log.record({taskId:'normal-task',stage:'inventory'});await log.record({taskId:'normal-task',stage:'completed'});
  await log.record({taskId:'recover-task',stage:'error',errorCode:'disk-full'});await log.record({taskId:'recover-task',stage:'recover'});await log.record({taskId:'recover-task',stage:'completed'});
  await log.record({taskId:'pending-task',stage:'inventory'});await log.record({stage:'finished',operation:'putChatMeta'});
  now+=8*DAY;await log.cleanup();let rows=await all(log);assert.equal(rows.some(x=>x.taskId==='normal-task'),false);assert.equal(rows.some(x=>x.scope==='daily'),false);assert.equal(rows.filter(x=>x.taskId==='recover-task').length,3);assert.equal(rows.filter(x=>x.taskId==='pending-task').length,1);
  now+=23*DAY;await log.cleanup();rows=await all(log);assert.deepEqual(rows.map(x=>x.taskId),['pending-task']);
  await log.record({taskId:'new-done-task',stage:'completed'});await log.cleanup({manual:true});assert.deepEqual((await all(log)).map(x=>x.taskId),['pending-task']);
}));
test('断裂末行可保留并继续写入，非法分页和自定义文本拒绝',()=>fixture(async dir=>{
  const log=new RuntimeLog(dir);await log.record({taskId:'pending-task',stage:'inventory'});await fs.appendFile(log.file(0),'{"torn":');const reopened=new RuntimeLog(dir);await reopened.record({taskId:'pending-task',stage:'completed'});assert.deepEqual((await all(reopened)).map(x=>x.seq),[2,1]);
  await assert.rejects(reopened.page({cursor:'../outside'}),/游标/);await assert.rejects(reopened.page({limit:1000}),/分页/);
  assert.throws(()=>validateLogEvent({taskId:'pending-task',from:'indexeddb',to:'sqlite',kind:'switch',stage:'inventory',text:'body'}),/参数/);
}));

test('普通进度不逐条刷盘，完成/异常立即留存，重启仍可读取全部已写日志',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1),syncs=0;const open=fs.open.bind(fs);fs.open=async(...args)=>{const h=await open(...args);if(String(args[0]).startsWith(dir)){const sync=h.sync.bind(h);h.sync=async()=>{syncs++;return sync();};}return h;};
  try{const log=new RuntimeLog(dir,{now:()=>now});for(let n=0;n<60;n++)await log.record({taskId:'flush-task',stage:'inventory',count:n});assert.ok(syncs<=3);await log.record({taskId:'flush-task',stage:'paused'});assert.equal(syncs,6);await log.record({taskId:'flush-task',stage:'error',errorCode:'disk-full'});assert.equal(syncs,9);await log.record({taskId:'flush-task',stage:'completed'});assert.equal(syncs,12);assert.equal((await all(new RuntimeLog(dir))).length,63);}finally{fs.open=open;}
}));

test('跨分段清理删除空正文及孤立元数据，保留异常和未结束组，旧分页游标失效',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1);const log=new RuntimeLog(dir,{now:()=>now,maxFileBytes:8192});
  for(let n=0;n<180;n++)await log.record({taskId:'expired-task',stage:'inventory',count:n});await log.record({taskId:'expired-task',stage:'completed'});
  await log.record({taskId:'retained-error',stage:'error',errorCode:'disk-full'});await log.record({taskId:'retained-error',stage:'completed'});await log.record({taskId:'unfinished-task',stage:'inventory'});
  const cursor=(await log.page({limit:2})).cursor;
  await fs.writeFile(log.metaFile('task-orphan-task'),JSON.stringify({version:1,group:'task-orphan-task',endedAt:new Date(now).toISOString(),hadError:false,status:'completed',lastSeq:1}));
  now+=8*DAY;await cleanAll(log);
  const remaining=await all(log);assert.equal(remaining.some(x=>x.taskId==='expired-task'),false);assert.equal(remaining.filter(x=>x.taskId==='retained-error').length,2);assert.equal(remaining.filter(x=>x.taskId==='unfinished-task').length,1);
  const names=await fs.readdir(dir);assert.equal(names.includes(path.basename(log.metaFile('task-expired-task'))),false);assert.equal(names.includes(path.basename(log.metaFile('task-orphan-task'))),false);assert.equal(names.includes(path.basename(log.metaFile('task-retained-error'))),true);
  for(const name of names.filter(x=>x.endsWith('.jsonl')))assert.ok((await fs.stat(path.join(dir,name))).size>0);
  assert.equal((await log.page({cursor})).stale,true);
}));

test('分批清理期间新增同组记录不会丢元数据；清理重启重新扫描而不猜测引用',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1);let log=new RuntimeLog(dir,{now:()=>now,maxFileBytes:8192});for(let n=0;n<140;n++)await log.record({taskId:'concurrent-task',stage:'inventory',count:n});await log.record({taskId:'concurrent-task',stage:'completed'});
  now+=8*DAY;const first=await log.cleanup({manual:true,maxFiles:1});assert.notEqual(first.cursor,null);
  await log.record({taskId:'concurrent-task',stage:'completed',count:999});let cursor=first.cursor;
  for(let n=0;n<100&&cursor!==null;n++)cursor=(await log.cleanup({manual:true,cursor,maxFiles:1})).cursor;
  assert.equal(cursor,null);assert.equal((await all(log)).at(0).count,999);assert.ok(await fs.stat(log.metaFile('task-concurrent-task')));
  const next=await log.cleanup({manual:true,maxFiles:1});log=new RuntimeLog(dir,{now:()=>now,maxFileBytes:8192});if(next.cursor!==null)assert.equal((await log.cleanup({manual:true,cursor:next.cursor,maxFiles:1})).restarted,true);
  await cleanAll(log,{manual:true});assert.equal((await all(log)).length,0);assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.meta.json')).length,0);
}));
test('当前未封口分段仍有引用时，不把旧元数据误认为孤立',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1);const log=new RuntimeLog(dir,{now:()=>now});await log.record({taskId:'open-segment-task',stage:'completed'});now+=8*DAY;
  // A stale/reconstructed date index must not substitute for checking refs.
  log.state.date=new Date(now).toISOString().slice(0,10);await cleanAll(log);assert.ok(await fs.stat(log.metaFile('task-open-segment-task')));assert.equal((await all(log)).length,1);
}));
test('旧版误分类的清空日志也能按真实操作筛选，不改写历史正文',()=>fixture(async dir=>{
  const log=new RuntimeLog(dir);await log.record({taskId:'legacy-clear-task',from:'sqlite',to:'indexeddb',kind:'clear',stage:'completed'});
  const file=log.file(0),old=(await fs.readFile(file,'utf8')).replaceAll('"scope":"cleanup"','"scope":"migration"').replaceAll('"category":"cleanup"','"category":"migration"');await fs.writeFile(file,old);
  const current=new RuntimeLog(dir);assert.equal((await all(current,'migration')).length,0);const cleared=await all(current,'cleanup');assert.equal(cleared.length,1);assert.equal(cleared[0].scope,'cleanup');assert.equal(await fs.readFile(file,'utf8'),old);
}));
test('删除分段后立即中断，重启后旧分页仍明确失效，元数据可在下一轮回收',()=>fixture(async dir=>{
  let now=Date.UTC(2026,0,1);const log=new RuntimeLog(dir,{now:()=>now,maxFileBytes:8192});for(let n=0;n<90;n++)await log.record({taskId:'cleanup-crash-task',stage:'inventory',count:n});await log.record({taskId:'cleanup-crash-task',stage:'completed'});const cursor=(await log.page({limit:1})).cursor;now+=8*DAY;
  const unlink=fs.unlink.bind(fs);let crashed=false;fs.unlink=async file=>{await unlink(file);if(!crashed&&String(file).endsWith('.jsonl')){crashed=true;throw new Error('injected after unlink');}};
  try{await assert.rejects(log.cleanup({maxFiles:1}),/injected/);}finally{fs.unlink=unlink;}
  assert.equal(crashed,true);const reopened=new RuntimeLog(dir,{now:()=>now,maxFileBytes:8192});assert.equal((await reopened.page({cursor})).stale,true);await cleanAll(reopened);assert.equal((await all(reopened)).length,0);assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.meta.json')).length,0);
}));
test('损坏的日志索引连续调用均报不可用，不因首次失败后缓存了对象而覆盖现场',()=>fixture(async dir=>{
  const file=path.join(dir,'boxed-lllllabc-log-state.json'),raw=JSON.stringify({version:1,part:0,seq:0,date:'2026-01-01',generation:-1});await fs.writeFile(file,raw);const log=new RuntimeLog(dir);
  for(let n=0;n<2;n++)await assert.rejects(log.record({taskId:'bad-index-task',stage:'completed'}),/索引损坏/);assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal((await fs.readdir(dir)).filter(x=>x.endsWith('.jsonl')).length,0);
}));
