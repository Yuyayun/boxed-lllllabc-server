import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {SqliteWorker} from '../src/worker-client.js';
class WorkerFixture extends EventEmitter{
  constructor(){super();this.timers=[];queueMicrotask(()=>this.emit('message',{ready:true}));}
  postMessage(job){this.job=job;this.emit('message',{type:'started',id:job.id});if(job.operation==='_close')this.emit('message',{id:job.id,value:true});}
  terminate(){this.terminated=true;for(const timer of this.timers)clearInterval(timer);return Promise.resolve();}
  pulse(type){this.emit('message',{type,id:this.job?.id,metrics:{count:1}});}
}
test('有效工作持续推进可越过单次无进展期限，完成后线程仍可用',async()=>{
  const fake=new WorkerFixture(),worker=new SqliteWorker('unused',{timeoutMs:120,workerFactory:()=>fake});
  try{const task=worker.call('read',[],'owner');await delay(10);const timer=setInterval(()=>fake.pulse('progress'),20);fake.timers.push(timer);await delay(280);assert.equal(worker.pending.size,1);assert.ok(worker.progressSeq>3);assert.equal(worker.supervision().state,'working');fake.emit('message',{id:fake.job.id,value:'done'});assert.equal(await task,'done');assert.equal(fake.terminated,undefined);}finally{await worker.close();}
});
test('单纯心跳不能延长有效进度时限，超时保留队列直到确认，队列限额仍有效',async()=>{
  const fake=new WorkerFixture(),worker=new SqliteWorker('unused',{timeoutMs:100,maxQueued:1,workerFactory:()=>fake});
  try{const timer=setInterval(()=>fake.pulse('heartbeat'),10);fake.timers.push(timer);await assert.rejects(worker.call('read',[],'owner'),e=>e.code==='outcome-unknown');assert.equal(worker.progressSeq,0);assert.equal(worker.pending.size,1);assert.equal(Atomics.load(new Int32Array(fake.job.cancel),0),1);assert.equal(fake.terminated,undefined);assert.equal(worker.supervision().state,'no-progress');await assert.rejects(worker.call('read',[],'owner'),e=>e.code==='queue-full');fake.emit('message',{id:fake.job.id,error:{code:'cancelled',message:'cancelled'}});assert.equal(worker.pending.size,0);}finally{await worker.close();}
});

test('空闲只报告线程运行时间，不保留前一任务计时/阶段；第二任务独立计时',async()=>{
  const fake=new WorkerFixture(),worker=new SqliteWorker('unused',{workerFactory:()=>fake});
  try{await worker.ready;worker.startedAt-=3600000;let view=worker.supervision();assert.equal(view.state,'idle');assert.equal(view.elapsedMs,0);assert.ok(view.workerUptimeMs>=3600000);
    const first=worker.call('first',[],'owner');await delay(5);fake.pulse('progress');view=worker.supervision();assert.equal(view.stage,'first');assert.ok(view.elapsedMs<1000);fake.emit('message',{id:fake.job.id,value:true});await first;
    view=worker.supervision();assert.equal(view.state,'idle');assert.equal(view.stage,null);assert.equal(view.count,undefined);assert.equal(view.elapsedMs,0);
    const next=worker.call('second',[],'owner');await delay(5);view=worker.supervision();assert.equal(view.stage,'second');assert.ok(view.elapsedMs<1000);assert.equal(view.count,undefined);fake.emit('message',{id:fake.job.id,value:true});await next;
  }finally{await worker.close();}
});
test('清空任务在线程失败时仍保留真实操作类别，结束后释放日志上下文',async()=>{
  const fake=new WorkerFixture(),worker=new SqliteWorker('unused',{workerFactory:()=>fake}),events=[];worker.observe=entry=>events.push(entry);
  const task=worker.call('_batchTransfer',['begin',[{id:'clear-worker-fault',kind:'clear',from:'sqlite',to:'indexeddb'}]],'owner'),failed=assert.rejects(task,/injected/);
  try{await delay(5);worker.fail(Object.assign(new Error('injected worker exit'),{code:'worker-exit'}));await failed;assert.ok(events.some(entry=>entry.stage==='error'&&entry.kind==='clear'&&entry.to==='indexeddb'));assert.equal(worker.contexts.size,0);}finally{await worker.close();}
});
