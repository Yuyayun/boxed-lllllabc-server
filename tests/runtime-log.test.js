import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RuntimeLog,validateLogEvent} from '../src/runtime-log.js';
const DAY=86400000;
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
