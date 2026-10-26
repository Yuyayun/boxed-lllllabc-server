import { encodeStorageValue, decodeStorageValue } from '../vendor/frontend/src/storage/protocol.js';
import { transferId, DATA_STORES, TRANSFER_PAGE_BYTES, digestRow, validateTransferRow, recordText, readTransferManifest, sameManifest } from '../vendor/frontend/src/storage/transfer-format.js';

export const TRANSFER_ACTIONS = ['status','source','prepare','append','page','seal','check','commit','rollback','finish'];
export function installTransfer(repository) {
  const db = repository.db;
  const meta = (key) => { const row = db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const put = (key, value) => db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); repository.checkCancelled(); db.exec('COMMIT'); return result; }
    catch (error) { repository.rollback(error); }
  };
  const lock = (id, acquire = false) => {
    const current = meta('transfer-lock');
    if (current && current !== id) throw new Error('另一项存储操作尚未完成，已暂停读写。');
    if (!current && !acquire) throw new Error('切换任务锁已失效。');
    if (acquire) put('transfer-lock', id);
  };
  const key = (id) => `transfer:${id}`;
  const receipt = (id) => meta(key(id));
  const save = (id, value) => put(key(id), value);
  const encode = (v) => JSON.stringify(encodeStorageValue(v));
  const decode = (v) => decodeStorageValue(JSON.parse(v));
  const snapshot = (id, kind) => db.prepare(`INSERT INTO transfer_rows(id,kind,n,store,primary_key,chat_key,payload)
    SELECT ?,?,row_number() OVER(ORDER BY CASE store ${DATA_STORES.map((s,i)=>`WHEN '${s}' THEN ${i}`).join(' ')} END,primary_key),store,primary_key,chat_key,payload FROM records`).run(id,kind);
  const restore = (id, kind) => {
    db.exec('DELETE FROM records');
    db.prepare('INSERT INTO records SELECT store,primary_key,chat_key,payload FROM transfer_rows WHERE id=? AND kind=?').run(id,kind);
  };
  repository.transfer = async (action, args = {}) => {
    if (!TRANSFER_ACTIONS.includes(action)) throw new Error('切换操作无效。');
    const id = transferId(args.id);
    if (action === 'status') return receipt(id);
    if (action === 'source' || action === 'prepare') return transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
      if (tables.some(({name}) => !['records','plugin_meta','transfer_rows'].includes(name))) throw new Error('发现未知数据库表，已保留全部数据并停止切换。');
      lock(id, true);
      const old = receipt(id);
      if (old) {
        if (action === 'source' ? old.role !== 'source' || old.phase !== 'captured' : old.role !== 'target' || old.phase !== 'staging' || !sameManifest(old.expected, args.manifest)) throw new Error('切换任务阶段冲突。');
        return old;
      }
      if (action === 'source') snapshot(id, 'data');
      const result = action === 'source'
        ? { role: 'source', phase: 'captured', written: db.prepare('SELECT count(*) AS n FROM records').get().n }
        : { role: 'target', phase: 'staging', written: 0, expected: args.manifest, baseRevision: meta('revision') || 0 };
      save(id,result); return result;
    });
    if (action === 'page') {
      lock(id);
      if (!Number.isSafeInteger(args.after) || args.after < 0) throw new Error('分页游标无效。');
      const rows = []; let bytes = 0;
      // Node 22.14 iterators do not retain their owning statement across GC.
      // Keep the statement reachable while encoding a potentially large page.
      repository.transferPageStatement ??= db.prepare("SELECT * FROM transfer_rows WHERE id=? AND kind='data' AND n>? ORDER BY n LIMIT 100");
      for (const row of repository.transferPageStatement.iterate(id,args.after)) {
        const value = { n: row.n, store: row.store, key: JSON.parse(row.primary_key), value: decode(row.payload) };
        const size = Buffer.byteLength(recordText(value));
        if (rows.length && bytes + size > TRANSFER_PAGE_BYTES) break;
        rows.push(value); bytes += size;
      }
      return Promise.all(rows.map(async(row)=>({...row,digest:await digestRow(row)})));
    }
    if (action === 'check') {
      const batch = await repository.transfer('page',args);
      return transaction(() => {
        lock(id); const state = receipt(id);
        if (!(state?.role === 'source' && state.phase === 'captured' || state?.role === 'target' && state.phase === 'committed')) throw new Error('正式数据不在可复核阶段。');
        if (db.prepare('SELECT count(*) AS n FROM records').get().n !== state.written) throw new Error('正式数据数量与校验副本不一致。');
        for (const row of batch) {
          const old = db.prepare('SELECT payload FROM records WHERE store=? AND primary_key=?').get(row.store,JSON.stringify(row.key));
          if (!old || recordText({...row,value:decode(old.payload)}) !== recordText(row)) throw new Error('正式记录与校验副本不一致。');
        }
        return { after:batch.at(-1)?.n ?? args.after,done:batch.length===0 };
      });
    }
    if (action === 'append') {
      if (!Array.isArray(args.rows) || !args.rows.length || args.rows.length > 100) throw new Error('切换批次无效。');
      for (const row of args.rows) { validateTransferRow(row); if (row.digest !== await digestRow(row)) throw new Error('传输摘要不一致。'); }
      return transaction(() => {
        lock(id); const state = receipt(id);
        if (state?.role !== 'target' || state.phase !== 'staging') throw new Error('目标不在暂存阶段。');
        for (const row of args.rows) {
          if (row.n <= state.written) {
            const old = db.prepare("SELECT * FROM transfer_rows WHERE id=? AND kind='data' AND n=?").get(id,row.n);
            if (!old || recordText({ store:old.store,key:JSON.parse(old.primary_key),value:decode(old.payload) }) !== recordText(row)) throw new Error('重复批次内容不一致。');
            continue;
          }
          if (row.n !== state.written + 1) throw new Error('切换批次序号不连续。');
          db.prepare("INSERT INTO transfer_rows VALUES(?,'data',?,?,?,?,?)").run(id,row.n,row.store,JSON.stringify(row.key),row.value.chatKey,encode(row.value));
          state.written = row.n;
        }
        save(id,state); return { written:state.written };
      });
    }
    if (action === 'seal') {
      transaction(() => {
        lock(id); const state = receipt(id);
        if (!state || !['captured','staging','checking','verified'].includes(state.phase)) throw new Error('无法校验当前阶段。');
        if (state.role === 'target') { state.phase = 'checking'; save(id,state); }
      });
      const manifest = await readTransferManifest((after) => repository.transfer('page',{id,after}));
      transaction(() => {
        lock(id); const state = receipt(id);
        if (state.role === 'target' && !sameManifest(state.expected,manifest)) throw new Error('目标读回校验不一致。');
        state.manifest = manifest; state.phase = state.role === 'target' ? 'verified' : 'captured'; save(id,state);
      });
      return manifest;
    }
    return transaction(() => {
      const state = receipt(id);
      if (['rollback','finish'].includes(action) && (!state || ['rolled-back','finished'].includes(state.phase))) return state;
      lock(id);
      if (action === 'commit') {
        if (state?.phase === 'committed') return state;
        if (state?.role !== 'target' || state.phase !== 'verified' || state.baseRevision !== (meta('revision') || 0)) throw new Error('目标数据或校验阶段已变化。');
        snapshot(id,'backup'); restore(id,'data'); put('revision',state.baseRevision+1); state.phase='committed'; save(id,state); return state;
      }
      if (action === 'rollback' && state.role === 'target' && state.phase === 'committed') { restore(id,'backup'); put('revision',(meta('revision') || 0)+1); }
      if (action === 'finish' && state.role === 'target' && state.phase !== 'committed') throw new Error('目标尚未提交。');
      db.prepare('DELETE FROM transfer_rows WHERE id=?').run(id);
      db.prepare("DELETE FROM plugin_meta WHERE key='transfer-lock'").run();
      state.phase = action === 'finish' ? 'finished' : 'rolled-back'; save(id,state); return state;
    });
  };
}
