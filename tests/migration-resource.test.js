import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {SqliteRepository} from '../src/sqlite.js';
test('预检后空间突降导致真实 SQLITE_FULL 时，批次与进度回滚，旧目标/来源保留并能安全撤销',async t=>{
  const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'boxed-resource-')),source=new SqliteRepository(path.join(dir,'source.sqlite')),target=new SqliteRepository(path.join(dir,'target.sqlite'));
  t.after(()=>{source.close();target.close();assert.equal(path.dirname(fs.realpathSync(dir)),root);assert.ok(path.basename(dir).startsWith('boxed-resource-'));fs.rmSync(dir,{recursive:true});});
  await source.execute('putChatMeta',[{chatKey:'source'}]);await source.execute('putFullMessages',[{chatKey:'source',messages:[{messageIndex:0,raw:{mes:'synthetic'.repeat(200000)}}]}]);await target.execute('putChatMeta',[{chatKey:'old-target',keep:true}]);
  const before=target.db.prepare('SELECT * FROM records').all(),id='resource-test-123';await source.batchTransfer.begin({id,role:'source',from:'indexeddb',to:'sqlite'});const packet=await source.batchTransfer.sourceNext(id,0);await target.batchTransfer.begin({id,role:'target',from:'indexeddb',to:'sqlite'});while((await target.batchTransfer.prepareStep(id)).phase==='preparing'){}
  target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const previous=target.db.prepare('PRAGMA max_page_count').get().max_page_count,pages=target.db.prepare('PRAGMA page_count').get().page_count;target.db.exec(`PRAGMA max_page_count=${pages}`);
  await assert.rejects(target.batchTransfer.append(id,packet),error=>error.errcode===13||/full/i.test(error.message));assert.deepEqual(target.db.prepare('SELECT * FROM records').all(),before);assert.equal((await target.batchTransfer.status(id)).verified,0);assert.equal((await target.batchTransfer.status(id)).writtenBatch,0);assert.equal(target.db.prepare('SELECT count(*) AS n FROM records_next').get().n,0);assert.equal(source.db.prepare("SELECT count(*) AS n FROM records WHERE store='full_messages'").get().n,1);
  target.db.exec(`PRAGMA max_page_count=${previous}`);for(const repo of [target,source]){await repo.batchTransfer.beginAbort(id);while(!['rolled-back','finished'].includes((await repo.batchTransfer.finishStep(id)).phase)){}await repo.batchTransfer.release(id);}assert.deepEqual(await target.execute('getChatMeta',['old-target']),{chatKey:'old-target',keep:true});assert.equal((await source.execute('getFullMessages',['source'])).length,1);
});
