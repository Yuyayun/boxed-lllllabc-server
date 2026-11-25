import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {SqliteWorker} from '../src/worker-supervisor.js';
import {LogReporter} from '../src/log-reporter.js';
import {validateLogEvent} from '../src/runtime-log.js';
import {routeFixture} from './route-fixture.js';
import {STORAGE_PROTOCOL,encodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';
import {formatRuntimeLog} from '../vendor/frontend/src/storage/runtime-log-format.js';

class Probe extends EventEmitter{
 constructor(){super();queueMicrotask(()=>this.emit('message',{ready:true}));}
 postMessage({id,operation}){queueMicrotask(()=>{this.emit('message',{id,type:'started'});this.emit('message',operation==='_batchTransfer'?{id,error:{code:'database-unavailable',message:'SECRET_BODY'}}:{id,value:{writable:true}});});}
 terminate(){return Promise.resolve(0);}
}
const supervised=()=>{const probe=new Probe(),worker=new SqliteWorker('unused',{workerFactory:()=>probe});return {worker,probe};};
function quiet(t){const rows={lines:[],warnings:[],errors:[]},original={log:console.log,warn:console.warn,error:console.error};console.log=(...args)=>rows.lines.push(args.join(' '));console.warn=(...args)=>rows.warnings.push(args.join(' '));console.error=(...args)=>rows.errors.push(args.join(' '));t.after(()=>Object.assign(console,{log:original.log,warn:original.warn,error:original.error}));return rows;}
function memoryReporter(options={}){const rows=[];return {rows,reporter:new LogReporter(()=>({record:async row=>{rows.push(row);return {...row,timestamp:'2026-11-25T00:00:00Z',category:row.severity==='error'?'error':'daily'};}}),options)};}

test('空闲线程退出留一条根因，之后重试不重复伪造退出事件；主动关闭不报故障',async()=>{
 const {worker,probe}=supervised(),events=[];worker.observe=event=>events.push(event);await worker.ready;probe.emit('exit',17);
 assert.equal(events.length,1);assert.equal(events[0].operation,'worker');assert.equal(events[0].workerExitCode,17);assert.equal(events[0].affectedCount,0);
 await assert.rejects(worker.call('_status',[],'owner'),error=>error.code==='database-unavailable');worker.fail(new Error('again'));await worker.close();assert.equal(events.length,1);
 const normal=supervised();await normal.worker.ready;normal.worker.observe=event=>events.push(event);await normal.worker.close();assert.equal(events.filter(event=>event.errorCode).length,1);
});
test('重启后第一次核对清空就报错，也保留清空类别',async t=>{
 quiet(t);const {worker}=supervised(),f=await routeFixture(t,{createWorker:()=>worker}),taskId='clear-after-restart';
 await f.call('/logs/event',{protocol:STORAGE_PROTOCOL,taskId,kind:'clear',from:'sqlite',to:'indexeddb',stage:'recover'});
 assert.equal((await f.call('/batch-transfer',{protocol:STORAGE_PROTOCOL,action:'inspect',args:encodeStorageValue([taskId])})).ok,false);
 const rows=(await f.call('/logs?category=all')).value.entries;assert(rows.every(row=>row.scope==='cleanup'));assert(rows.every(row=>!formatRuntimeLog(row).includes('切换备份位置')));
});
test('日志文件不可写时仍有一条关键终端错误兜底，重复故障不刷屏',async t=>{
 const consoleRows=quiet(t),{worker}=supervised(),f=await routeFixture(t,{fault:true,createWorker:()=>worker});
 for(let n=0;n<20;n++)await f.call('/batch-transfer',{protocol:STORAGE_PROTOCOL,action:'inspect',args:encodeStorageValue(['same-failed-task'])});
 for(let n=0;n<50&&!consoleRows.errors.length;n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(consoleRows.warnings.length,1);assert.equal(consoleRows.errors.length,1);assert.match(consoleRows.errors[0],/未能写入文件/);assert.doesNotMatch(consoleRows.errors.join(''),/SECRET_BODY/);
});
test('一万次状态检查和批次明细不占成功采样，备份完成仍每分钟最多一条',async t=>{
 quiet(t);let now=1000000;const {rows,reporter}=memoryReporter({now:()=>now});
 for(let n=0;n<10000;n++){await reporter.record({operation:'_status',stage:'finished'});await reporter.record({operation:'appendBackupWrite',stage:'finished'});}
 for(let n=0;n<1000;n++)await reporter.record({operation:'commitBackupWrite',stage:'finished',backupState:'committed'});
 assert.equal(rows.length,1);assert.equal(rows[0].operation,'commitBackupWrite');now+=60000;await reporter.record({operation:'commitBackupWrite',stage:'finished'});assert.equal(rows.length,2);
});
test('一万条同类错误合为首次记录，下一条记录带合并数量，所有缓存有界',async t=>{
 quiet(t);let now=1000000;const {rows,reporter}=memoryReporter({now:()=>now});
 for(let n=0;n<10000;n++)await reporter.record({operation:'getBackupPage',stage:'error',errorCode:'database-unavailable',requestId:'request-'+n});
 assert.equal(rows.length,1);now+=60000;await reporter.record({operation:'getBackupPage',stage:'error',errorCode:'database-unavailable'});assert.equal(rows.length,2);assert.equal(rows[1].suppressedCount,9999);
 for(let n=0;n<400;n++){now+=60000;await reporter.record({operation:'getBackupPage',stage:'error',errorCode:'code-'+n,chatRef:n.toString(16).padStart(16,'0')});}
 assert(reporter.seen.size<=256);assert.equal(reporter.pending.size,0);
});
test('大量不同错误也有总量上限，必要线程故障仍能留下',async t=>{
 quiet(t);const {rows,reporter}=memoryReporter({now:()=>1000000});
 for(let n=0;n<1000;n++)await reporter.record({operation:'getBackupPage',stage:'error',errorCode:'code-'+n});
 assert.equal(rows.length,60);await reporter.record({operation:'worker',stage:'error',errorCode:'worker-exit',workerExitCode:9});assert.equal(rows.length,61);assert.equal(rows.at(-1).suppressedCount,940);
 await reporter.record({kind:'restore',recoveryId:'essential-result',stage:'restore-confirmed'});assert.equal(rows.length,62);assert.equal(rows.at(-1).operation,'restore');
});
test('恢复阶段同编号只记一次，诊断数据按日分组且不接收正文',async t=>{
 quiet(t);const f=await routeFixture(t),event={protocol:STORAGE_PROTOCOL,kind:'restore',recoveryId:'recovery-contract',chatRef:'1234567890abcdef',recoverySource:'pending',storageMode:'sqlite'};
 for(const stage of ['restore-started','restore-submitted','restore-confirmed'])for(let n=0;n<20;n++)assert.equal((await f.call('/logs/event',{...event,stage})).ok,true);
 const rows=(await f.call('/logs?category=all')).value.entries;assert.equal(rows.length,3);assert(rows.every(row=>row.scope==='daily'&&!row.taskId));assert.equal(new Set(rows.map(row=>row.recoveryId)).size,1);
 assert(rows.every(row=>formatRuntimeLog(row).includes('恢复聊天内容')));
 assert.throws(()=>validateLogEvent({...event,protocol:undefined,stage:'restore-started',body:'SECRET'}));
});
test('取消和版本变化作为提示；真正的数据库故障才进入错误页',async t=>{
 quiet(t);const worker={call:async()=>({}),close:async()=>{}},f=await routeFixture(t,{createWorker:()=>worker});await f.call('/status');
 for(const errorCode of ['cancelled','backup-version-changed','database-unavailable'])worker.observe({operation:'getBackupPage',stage:'error',errorCode});
 const errors=(await f.call('/logs?category=error')).value.entries;assert.equal(errors.length,1);assert.equal(errors[0].errorCode,'database-unavailable');
 const all=(await f.call('/logs?category=all')).value.entries;assert.equal(all.filter(row=>row.severity==='notice').length,2);
});
test('正常请求与恢复均显示短关联号，未知任务不猜成迁移',()=>{
 const first=formatRuntimeLog({operation:'restore',kind:'restore',stage:'restore-submitted',recoveryId:'first-audit-task',chatRef:'1234567890abcdef'});
 const second=formatRuntimeLog({operation:'restore',kind:'restore',stage:'restore-submitted',recoveryId:'second-audit-task',chatRef:'1234567890abcdef'});
 assert.notEqual(first,second);assert.match(first,/恢复#|聊天#/);assert.doesNotMatch(first,/first-audit-task|核对完成/);
 assert.match(formatRuntimeLog({taskId:'unknown-task',stage:'error'}),/类型待核对/);
});
