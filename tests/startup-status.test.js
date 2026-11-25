import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFixture} from './route-fixture.js';
import {formatRuntimeLog} from '../vendor/frontend/src/storage/runtime-log-format.js';

test('欢迎页状态检查等待初始化时持续返回心跳，只在完成后给出连接结果',async t=>{
  let finish;
  const gate=new Promise(resolve=>{finish=resolve;});t.after(()=>finish());
  const operations=[];
  const worker={
    supervision:()=>({state:'initializing',stage:'startup-audit',count:100}),
    async call(operation){operations.push(operation);await gate;return {readable:true,writable:true};},
    close:async()=>{},
  };
  const f=await routeFixture(t,{createWorker:()=>worker}),controller=new AbortController();
  t.after(()=>controller.abort());
  const response=await f.request('/status',{signal:controller.signal,headers:{Accept:'application/x-ndjson'}});
  assert.match(response.headers.get('content-type'),/application\/x-ndjson/);
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
  while(!text.includes('startup-audit'))text+=decoder.decode((await reader.read()).value);
  assert.match(text,/"type":"heartbeat"/);assert.doesNotMatch(text,/"type":"result"/);
  finish();while(true){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value);}
  const result=text.trim().split('\n').map(line=>JSON.parse(line)).find(frame=>frame.type==='result');
  assert.equal(result.ok,true);assert.equal(result.database.writable,true);assert.deepEqual(operations,['_status']);
});

test('欢迎页检查断连传递取消并明确记录检查失败，下一次检查仍可连接',async t=>{
  let cancelled;
  const aborted=new Promise(resolve=>{cancelled=resolve;}),operations=[];
  let first=true;
  const worker={
    async call(operation,_args,_owner,{signal}){
      operations.push(operation);
      if(!first)return {readable:true,writable:true};first=false;
      return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{
        cancelled();reject(Object.assign(new Error('请求已取消。'),{code:'cancelled',status:409}));
      },{once:true}));
    },close:async()=>{},
  };
  const f=await routeFixture(t,{createWorker:()=>worker}),controller=new AbortController();
  t.after(()=>controller.abort());
  const response=await f.request('/status',{signal:controller.signal,headers:{Accept:'application/x-ndjson'}});
  const reader=response.body.getReader();await reader.read();controller.abort();
  try{await reader.cancel();}catch{/* Aborted response bodies may already be closed. */}
  await aborted;
  const errors=(await f.call('/logs?category=all')).value.entries;
  assert.ok(errors.some(row=>row.operation==='_status'&&row.errorCode==='cancelled'));
  assert.ok(errors.every(row=>row.severity==='notice'));
  assert.equal((await f.call('/logs?category=error')).value.entries.length,0);
  assert.ok(errors.every(row=>row.operation==='_status'));
  const message=errors.map(entry=>formatRuntimeLog(entry)).join('\n');
  assert.match(message,/检查服务器存储.*本次连接检查已取消/);assert.doesNotMatch(message,/日常备份操作/);
  assert.equal((await f.call('/status')).ok,true);assert.deepEqual(operations,['_status','_status']);
});
