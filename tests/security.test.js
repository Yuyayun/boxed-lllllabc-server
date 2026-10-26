import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authorize, databasePath } from '../src/host.js';
import { encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';

const request=(handle='default-user')=>({protocol:'http',get:(name)=>name==='host'?'localhost:8000':undefined,user:{profile:{handle,enabled:true}},session:{handle}});
const host=(accounts=false,users=[])=>({csrfEnabled:()=>true,config:()=>accounts,defaultHandle:'default-user',users:async()=>users});
test('服务端默认用户与唯一启用账户须与会话一致，多账户及未知状态拒绝',async()=>{
  assert.equal(await authorize(host(),request()),'default-user');
  assert.equal(await authorize(host(true,[{handle:'one',enabled:true}]),request('one')),'one');
  await assert.rejects(authorize(host(true,[{handle:'one',enabled:true},{handle:'two',enabled:true}]),request('one')), /仅支持/);
  await assert.rejects(authorize(host(true,[{handle:'one',enabled:true}]),request('wrong')), /身份/);
  await assert.rejects(authorize(host(true,null),request('one')), /无法核实/);
  await assert.rejects(authorize(host(),{...request(),user:undefined}),/身份/);
});
test('CSRF 关闭与跨源请求拒绝，客户端 isSingleUser 无法开放权限',async()=>{
  await assert.rejects(authorize({...host(),csrfEnabled:()=>false},request()),/CSRF/);
  const cross={...request(),get:(name)=>name==='host'?'localhost:8000':name==='origin'?'https://evil.example':undefined};
  await assert.rejects(authorize(host(),cross),/同源/);
  await assert.rejects(authorize(host(true,[{handle:'one',enabled:true},{handle:'two',enabled:true}]),{...request('one'),body:{isSingleUser:true}}),/仅支持/);
});
test('数据库路径只能由服务端指定，不落在原生数据、扩展或插件内',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'boxed-path-test-'));
  const root=path.join(directory,'server');fs.mkdirSync(root);
  const dataRoot=path.join(root,'data');fs.mkdirSync(dataRoot);
  try {
    const base={root,dataRoot,config:(_key,fallback)=>fallback};
    assert.equal(databasePath(base),path.join(root,'boxed-lllllabc-storage','boxed-lllllabc.sqlite'));
    for(const wrong of [dataRoot,path.join(root,'public','extensions'),path.join(root,'plugins','x'),path.parse(root).root,root,'relative']) assert.throws(()=>databasePath({...base,config:()=>wrong}));
  } finally {
    const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('boxed-path-test-'));fs.rmSync(resolved,{recursive:true});
  }
});
test('无损协议保留 Date、undefined、BigInt、非有限数及稀疏数组；恶意或不支持值拒绝',()=>{
  const value={date:new Date(0),undefined:undefined,big:123n,nan:NaN,infinity:Infinity,negativeZero:-0,array:[,undefined,null], nested:{value:'中文'}};
  assert.deepEqual(decodeStorageValue(JSON.parse(JSON.stringify(encodeStorageValue(value)))),value);
  const malicious=decodeStorageValue(['object',[['__proto__',['object',[['polluted',['boolean',true]]]]]]]);
  assert.equal(Object.prototype.polluted,undefined);assert.equal(Object.hasOwn(malicious,'__proto__'),true);
  assert.throws(()=>decodeStorageValue(['object',[['x',['null']],['x',['null']]]]));
  assert.throws(()=>encodeStorageValue({bad:()=>{}}));const cycle={};cycle.self=cycle;assert.throws(()=>encodeStorageValue(cycle));
});
