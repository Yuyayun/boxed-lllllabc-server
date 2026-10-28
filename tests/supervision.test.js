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
