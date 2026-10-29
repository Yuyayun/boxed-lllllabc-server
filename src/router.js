import { authorize, databasePath } from './host.js';
import { SqliteWorker } from './worker-client.js';
import { failure, safeError } from './errors.js';
import { STORAGE_PROTOCOL, STORAGE_OPERATIONS, validateBatchCall, encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { RuntimeLog, validateLogEvent } from './runtime-log.js';
import {formatRuntimeLog} from '../vendor/frontend/src/storage/runtime-log-format.js';
import path from 'node:path';

export function installRoutes(router, { host, hostError, createWorker = (file) => new SqliteWorker(file) }) {
  let worker;
  let workerError;
  let logger,maintenance;
  const capabilities={batchTransfer:3,recovery:1,supervision:1,logs:1};
  const getLogger=()=>logger??=new RuntimeLog(path.dirname(databasePath(host)));
  let logHealth={available:true},lastTerminalProgress=0;
  const frontendLogActivity=new Map();
  const logFailed=()=>{if(logHealth.available)console.warn('[箱装辣白菜] 运行日志暂时无法写入；备份结果仍以任务登记为准。请检查服务器备份目录。');logHealth={available:false};};
  const recordLog=async (event,fromFrontend=false)=>{
    try{const result=await getLogger().record(event);logHealth={available:true};
      if(fromFrontend&&event.taskId){
        if(['completed','cancelled'].includes(event.stage))frontendLogActivity.delete(event.taskId);
        else{if(frontendLogActivity.size>=32)frontendLogActivity.delete(frontendLogActivity.keys().next().value);frontendLogActivity.set(event.taskId,Date.now());}
      }
      if(result&&(result.category==='error'||['registered','completed','cancelled','paused','recover'].includes(result.stage)||Date.now()-lastTerminalProgress>=5000)){
        console.log('[箱装辣白菜]',formatRuntimeLog(result));lastTerminalProgress=Date.now();
      }return result;
    }catch(error){logFailed();throw error;}
  };
  const writeLog=event=>recordLog(event).catch(()=>null);
  const getWorker = () => {
    if (workerError) throw workerError;
    try {
      if(!worker){worker=createWorker(databasePath(host));let lastDaily=0,lastTaskProgress=0;
        worker.observe=event=>{
          if(!event.taskId&&!event.errorCode){if(event.stage!=='finished'||Date.now()-lastDaily<60000)return;lastDaily=Date.now();}
          if(['inspect','status'].includes(event.operation)&&!event.errorCode)return;
          if(event.taskId&&!event.errorCode){
            if(event.stage==='progress'){
              // The frontend already records this task's aggregate progress.
              // Retain server-side fallback when it has been silent for two
              // logging intervals; heartbeat/UI supervision is unchanged.
              if(Date.now()-(frontendLogActivity.get(event.taskId)??-Infinity)<10000)return;
              if(Date.now()-lastTaskProgress<5000)return;lastTaskProgress=Date.now();
            }
            else if(event.stage==='started'?!['begin','commit','activate','beginAbort'].includes(event.operation):!['begin','commit','activate','beginAbort','release'].includes(event.operation))return;
          }
          void writeLog(event);
        };
      }
      return worker;
    }
    catch (error) { workerError = error; throw error; }
  };
  const route = (handler) => async (request, response) => {
    response.set('Cache-Control', 'no-store');
    let streaming=false,timer;
    const send=value=>{
      const data={protocol:STORAGE_PROTOCOL,capabilities,logHealth,...value};
      if(streaming){if(!response.destroyed){response.write(JSON.stringify({type:'result',...data})+'\n');response.end();}}
      else if(!response.destroyed)response.json(data);
    };
    try {
      if (hostError) throw hostError;
      const owner = await authorize(host, request);
      streaming=String(request.get('accept')??'').includes('application/x-ndjson');
      if(streaming){
        response.set('Content-Type','application/x-ndjson; charset=utf-8');response.set('X-Accel-Buffering','no');
        const beat=()=>{if(!response.destroyed&&!response.writableNeedDrain)response.write(JSON.stringify({type:'heartbeat',protocol:STORAGE_PROTOCOL,supervisor:worker?.supervision?.()??{state:'initializing',progressSeq:0}})+'\n');};
        beat();timer=setInterval(beat,1000);timer.unref();
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!response.writableEnded) abort(); };
      request.once('aborted', abort);
      response.once('close', close);
      try {
        const value = await handler(request, owner, controller.signal);
        if (!response.destroyed) send({ ok: true, ...value });
      } finally { request.removeListener('aborted', abort); response.removeListener('close', close); }
    } catch (error) {
      console.error('[boxed-lllllabc-server]', error.message);
      const safe = safeError(error);
      if(!String(request.url??'').includes('/logs'))await writeLog({stage:'error',operation:'request',errorCode:safe.code});
      if (!response.destroyed){if(!streaming)response.status(safe.status||503);send({ ok:false,code:safe.code,reason:safe.message });}
    }finally{clearInterval(timer);}
  };
  router.get('/logs',route(async request=>{
    const query=request.query??Object.fromEntries(new URL(request.url,'http://localhost').searchParams);
    if(Object.keys(query).some(key=>!['category','cursor','limit'].includes(key)))throw failure('invalid-request','日志查询参数无效。',400);
    return {value:await getLogger().page({category:query.category??'all',cursor:query.cursor,limit:query.limit===undefined?50:Number(query.limit)})};
  }));
  router.post('/logs/event',route(async request=>{
    const {protocol,...event}=request.body??{};
    if(protocol!==STORAGE_PROTOCOL||Buffer.byteLength(JSON.stringify(request.body))>4096)throw failure('invalid-request','日志事件参数无效。',400);
    try{validateLogEvent(event);}catch{throw failure('invalid-request','日志事件参数无效，不接受正文或自定义文本。',400);}
    await recordLog(event,true);return {value:true};
  }));
  router.post('/logs/cleanup',route(async request=>{
    const body=request.body;
    if(body?.protocol!==STORAGE_PROTOCOL||body.confirmed!==true||Object.keys(body).some(key=>!['protocol','confirmed','cursor'].includes(key)))throw failure('invalid-request','清理日志需要明确确认。',400);
    return {value:await getLogger().cleanup({manual:true,cursor:body.cursor??0,maxFiles:4})};
  }));
  let cleanupCursor=0;
  maintenance=setInterval(()=>{if(logger)void logger.cleanup({cursor:cleanupCursor,maxFiles:2}).then(result=>{cleanupCursor=result.cursor??0;}).catch(logFailed);},60000);maintenance.unref();
  router.get('/status', route(async (request, owner, signal) => ({
    pluginVersion: '1.0.1', state: 'connected',
    database: await getWorker().call('_status', [], owner, { signal, authorize: () => authorize(host, request) }),
  })));
  router.post('/operation', route(async (request, owner, signal) => {
    const body = request.body;
    if (body?.protocol !== STORAGE_PROTOCOL) throw failure('protocol-incompatible', '前后端存储协议不兼容，请升级对应插件。', 409);
    if (!body || Object.keys(body).some((key) => !['protocol','operation','args'].includes(key)) || !STORAGE_OPERATIONS.includes(body.operation)) throw failure('invalid-request', '只接受已定义的箱装备份操作，不接受路径或 SQL。', 400);
    if (Number(request.get('content-length') || 0) > 16 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) throw failure('too-large', '单次请求超过 16 MiB，请分批操作。', 413);
    let args;
    try { args = decodeStorageValue(body.args); } catch { throw failure('invalid-request', '备份数据无法无损解码。', 400); }
    if (!Array.isArray(args) || args.length > 3) throw failure('invalid-request', '操作参数格式无效。', 400);
    if (body.operation === 'deletePendingChangesIfUnchanged' && args.length !== 1) throw failure('invalid-request', '条件删除只接受原记录，不接受客户端保护规则。', 400);
    const result = await getWorker().call(body.operation, args, owner, { signal, authorize: () => authorize(host, request) });
    const value = encodeStorageValue(result);
    if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024) throw failure('too-large', '响应超过读取上限，请分批操作。', 413);
    return { value };
  }));
  router.post('/transfer', route(async (request, owner, signal) => {
    const body = request.body;
    if (body?.protocol !== STORAGE_PROTOCOL) throw failure('protocol-incompatible', '切换协议不兼容，请升级对应插件。', 409);
    if (Object.keys(body).some((key) => !['protocol','action','args'].includes(key)) || !['status','rollback','finish'].includes(body.action)) throw failure('invalid-request', '旧迁移接口仅用于既有任务的恢复与收尾，请使用新版分批迁移。', 400);
    if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) throw failure('too-large', '切换批次超过 16 MiB。', 413);
    let args;
    try { args = decodeStorageValue(body.args); } catch { throw failure('invalid-request', '切换数据无法无损解码。', 400); }
    if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some((key) => !['id','after','rows','manifest'].includes(key))) throw failure('invalid-request', '切换参数无效。', 400);
    const result = await getWorker().call('_transfer', [body.action,args], owner, { signal, authorize: () => authorize(host,request) });
    return { value: encodeStorageValue(result) };
  }));
  router.post('/batch-transfer', route(async (request, owner, signal) => {
    const body = request.body;
    if (body?.protocol !== STORAGE_PROTOCOL) throw failure('protocol-incompatible', '分批迁移协议不兼容，请更新配套前后端。', 409);
    if (!body || Object.keys(body).some(key => !['protocol','action','args'].includes(key))) throw failure('invalid-request', '分批迁移只接受已定义的方法和参数。', 400);
    if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) throw failure('too-large', '迁移请求超过 16 MiB。', 413);
    let args;
    try { args = decodeStorageValue(body.args); validateBatchCall(body.action, args, 'sqlite'); }
    catch { throw failure('invalid-request', '分批迁移方法、方向或参数无效。', 400); }
    const result = await getWorker().call('_batchTransfer', [body.action, args], owner, { signal, authorize: () => authorize(host, request) });
    const value = encodeStorageValue(result);
    if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024) throw failure('too-large', '迁移响应超过读取上限。', 413);
    return { value };
  }));
  return { close: async () => { clearInterval(maintenance);if (worker) await worker.close();if(logger)await logger.tail; } };
}
