import { authorize, databasePath } from './host.js';
import { SqliteWorker } from './worker-client.js';
import { failure, safeError } from './errors.js';
import { STORAGE_PROTOCOL, STORAGE_OPERATIONS, encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { TRANSFER_ACTIONS } from './transfer.js';

export function installRoutes(router, { host, hostError, createWorker = (file) => new SqliteWorker(file) }) {
  let worker;
  let workerError;
  const getWorker = () => {
    if (workerError) throw workerError;
    try { return worker ??= createWorker(databasePath(host)); }
    catch (error) { workerError = error; throw error; }
  };
  const route = (handler) => async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (hostError) throw hostError;
      const owner = await authorize(host, request);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!response.writableEnded) abort(); };
      request.once('aborted', abort);
      response.once('close', close);
      try {
        const value = await handler(request, owner, controller.signal);
        if (!response.destroyed) response.json({ ok: true, protocol: STORAGE_PROTOCOL, ...value });
      } finally { request.removeListener('aborted', abort); response.removeListener('close', close); }
    } catch (error) {
      console.error('[boxed-lllllabc-server]', error.message);
      const safe = safeError(error);
      if (!response.destroyed) response.status(safe.status || 503).json({ ok: false, protocol: STORAGE_PROTOCOL, code: safe.code, reason: safe.message });
    }
  };
  router.get('/status', route(async (request, owner, signal) => ({
    pluginVersion: '1.0.0-dev.5', state: 'connected',
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
    if (Object.keys(body).some((key) => !['protocol','action','args'].includes(key)) || !TRANSFER_ACTIONS.includes(body.action)) throw failure('invalid-request', '切换请求无效，不接受路径或 SQL。', 400);
    if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024 * 1024) throw failure('too-large', '切换批次超过 16 MiB。', 413);
    let args;
    try { args = decodeStorageValue(body.args); } catch { throw failure('invalid-request', '切换数据无法无损解码。', 400); }
    if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some((key) => !['id','after','rows','manifest'].includes(key))) throw failure('invalid-request', '切换参数无效。', 400);
    const result = await getWorker().call('_transfer', [body.action,args], owner, { signal, authorize: () => authorize(host,request) });
    return { value: encodeStorageValue(result) };
  }));
  return { close: async () => { if (worker) await worker.close(); } };
}
