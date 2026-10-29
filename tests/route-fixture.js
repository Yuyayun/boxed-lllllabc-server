import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {installRoutes} from '../src/router.js';
import {STORAGE_PROTOCOL,encodeStorageValue,decodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';

export async function routeFixture(t,{fault=false}={}){
  const temporary=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temporary,'boxed-route-log-')),storage=path.join(root,'storage');await fs.mkdir(storage);
  const faultPath=path.join(storage,'boxed-lllllabc-log-state.json');if(fault)await fs.mkdir(faultPath);
  const handlers=new Map(),nonce=randomUUID(),host={root:path.join(root,'host'),dataRoot:path.join(root,'data'),defaultHandle:'default-user',users:async()=>[],csrfEnabled:()=>true,config:(key,fallback)=>key==='boxedLllllabc.databaseDirectory'?storage:fallback};
  const routes=installRoutes({get:(key,handler)=>handlers.set('GET '+key,handler),post:(key,handler)=>handlers.set('POST '+key,handler)},{host});
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers['x-boxed-test']!==nonce){res.writeHead(403).end();return;}
      const url=new URL(req.url,'http://localhost'),handler=handlers.get(req.method+' '+url.pathname);if(!handler){res.writeHead(404).end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
      req.get=name=>req.headers[name.toLowerCase()];req.protocol='http';req.user={profile:{handle:'default-user',enabled:true}};req.session={handle:'default-user'};req.query=Object.fromEntries(url.searchParams);
      res.set=(name,value)=>res.setHeader(name,value);res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};await handler(req,res);
    }catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await routes.close();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(await fs.realpath(root)),temporary);await fs.rm(root,{recursive:true});});
  const call=async(route,body)=>{const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Boxed-Test':nonce},...(body?{body:JSON.stringify(body)}:{})});return response.json();};
  const operation=async(operation,args)=>{const result=await call('/operation',{protocol:STORAGE_PROTOCOL,operation,args:encodeStorageValue(args)});return {...result,value:result.value===undefined?undefined:decodeStorageValue(result.value)};};
  return {root,storage,faultPath,call,operation};
}
