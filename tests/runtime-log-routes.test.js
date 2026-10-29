import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {routeFixture} from './route-fixture.js';
import {STORAGE_PROTOCOL} from '../vendor/frontend/src/storage/protocol.js';

test('日志目录写入失败对外可见，真实 SQLite 备份仍成功，修复日志后可恢复记录',async t=>{
  const lines=[],warnings=[],print=console.log,warn=console.warn;console.log=(...args)=>lines.push(args.join(' '));console.warn=(...args)=>warnings.push(args.join(' '));t.after(()=>{console.log=print;console.warn=warn;});
  const f=await routeFixture(t,{fault:true});let status;
  for(let i=0;i<30;i++){status=await f.call('/status');if(status.logHealth?.available===false)break;await delay(10);}assert.equal(status.ok,true);assert.equal(status.logHealth.available,false);assert.equal(warnings.length,1);
  const written=await f.operation('putChatMeta',[{chatKey:'retained',keep:true}]);assert.equal(written.ok,true);assert.equal(written.logHealth.available,false);
  assert.deepEqual((await f.operation('getChatMeta',['retained'])).value,{chatKey:'retained',keep:true});assert.equal(warnings.length,1);
  await fs.rmdir(f.faultPath);const event={protocol:STORAGE_PROTOCOL,taskId:'log-recovered',from:'indexeddb',to:'sqlite',kind:'switch',stage:'completed'};
  const recovered=await f.call('/logs/event',event);assert.equal(recovered.ok,true);assert.equal(recovered.logHealth.available,true);
  assert.equal((await f.call('/logs?category=all')).value.entries.some(row=>row.taskId==='log-recovered'),true);assert.ok(lines.some(line=>line.includes('切换备份位置')&&line.includes('任务完成')));
  let cursor=0;do{cursor=(await f.call('/logs/cleanup',{protocol:STORAGE_PROTOCOL,confirmed:true,cursor})).value.cursor;}while(cursor!==null);assert.deepEqual((await f.operation('getChatMeta',['retained'])).value,{chatKey:'retained',keep:true});
});

for(const code of ['EACCES','ENOSPC'])test(`日志实际写入步骤发生 ${code} 时，备份与日志结果分别反馈`,async t=>{
  const f=await routeFixture(t),open=fs.open.bind(fs);let failing=true;
  fs.open=async(...args)=>{if(failing&&String(args[0]).startsWith(f.storage)&&String(args[0]).endsWith('.jsonl'))throw Object.assign(new Error('injected log '+code),{code});return open(...args);};t.after(()=>{fs.open=open;});
  await f.call('/status');const written=await f.operation('putChatMeta',[{chatKey:'io-fault-'+code,keep:true}]);assert.equal(written.ok,true);
  let status;for(let i=0;i<30;i++){status=await f.call('/status');if(status.logHealth.available===false)break;await delay(10);}assert.equal(status.ok,true);assert.equal(status.logHealth.available,false);assert.equal((await f.operation('getChatMeta',['io-fault-'+code])).value.keep,true);
  failing=false;const result=await f.call('/logs/event',{protocol:STORAGE_PROTOCOL,taskId:'after-io-fault',from:'indexeddb',to:'sqlite',kind:'switch',stage:'completed'});assert.equal(result.ok,true);assert.equal(result.logHealth.available,true);
});

test('清空任务与日常保存错误的浏览器记录和终端说明一致，不把清空写成搬家',async t=>{
  const lines=[],print=console.log;console.log=(...args)=>lines.push(args.join(' '));t.after(()=>{console.log=print;});const f=await routeFixture(t);
  for(const stage of ['registered','completed'])assert.equal((await f.call('/logs/event',{protocol:STORAGE_PROTOCOL,taskId:'clear-old-storage',from:'sqlite',to:'indexeddb',kind:'clear',stage})).ok,true);
  const clear=(await f.call('/logs?category=cleanup')).value.entries;assert.equal(clear.length,2);assert.ok(clear.every(row=>row.scope==='cleanup'));assert.equal((await f.call('/logs?category=migration')).value.entries.length,0);
  assert.ok(lines.some(line=>line.includes('清空旧位置：浏览器本地备份')&&line.includes('已清空')));assert.ok(lines.filter(line=>line.includes('清空旧位置')).every(line=>!line.includes('切换备份位置')));
  const failed=await f.operation('putChatMeta',[{}]);assert.equal(failed.ok,false);
  const errors=(await f.call('/logs?category=error')).value.entries;assert.ok(errors.some(row=>row.operation==='putChatMeta'&&row.category==='error'));assert.ok(lines.some(line=>line.includes('保存聊天信息')&&line.includes('异常')));
});
