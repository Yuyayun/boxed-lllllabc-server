import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {SqliteRepository} from '../src/sqlite.js';
import {emptyManifest} from '../vendor/frontend/src/storage/transfer-format.js';
import {encodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';
function fixture(t){const root=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'boxed-legacy-recovery-')),file=path.join(dir,'db.sqlite');let repo=new SqliteRepository(file);t.after(()=>{repo.close();assert.equal(path.dirname(fs.realpathSync(dir)),root);fs.rmSync(dir,{recursive:true});});return {get repo(){return repo;},reopen(){repo.close();repo=new SqliteRepository(file);return repo;}};}
async function seed(f){for(let i=0;i<13;i++)await f.repo.execute('putChatMeta',[{chatKey:'old-'+String(i).padStart(3,'0'),note:'中文',date:new Date(0),extra:undefined}]);await f.repo.transfer('prepare',{id:'legacy-test-123',manifest:await emptyManifest()});await f.repo.transfer('seal',{id:'legacy-test-123'});await f.repo.transfer('commit',{id:'legacy-test-123'});}
for(const stage of ['inventory','clear','copy','verify','cleanup'])test(`旧目标回滚在 ${stage} 中断后重开按检查点继续，原副本保留到核验通过`,async t=>{
  const f=fixture(t);await seed(f);let hit=false;
  for(let i=0;i<100;i++){const result=await f.repo.batchTransfer.legacyRecovery.step('legacy-test-123','rollback',{limit:2,bytes:500});if(result.state.recovery.stage===stage){hit=true;break;}}
  assert.equal(hit,true);assert.equal(f.repo.db.prepare("SELECT count(*) AS n FROM transfer_rows WHERE kind='backup'").get().n,13);
  f.reopen();await assert.rejects(f.repo.execute('putChatMeta',[{chatKey:'blocked'}]),/暂停/);await f.repo.transfer('rollback',{id:'legacy-test-123'});
  assert.equal(f.repo.status().counts.find(x=>x.store==='chat_meta').count,13);assert.equal((await f.repo.execute('getChatMeta',['old-000'])).note,'中文');assert.equal(f.repo.db.prepare('SELECT count(*) AS n FROM transfer_rows').get().n,0);assert.equal((await f.repo.transfer('status',{id:'legacy-test-123'})).phase,'rolled-back');await f.repo.transfer('rollback',{id:'legacy-test-123'});
});
test('旧目标已激活只收尾，不回写备份；恢复方向、修订或副本变化拒绝猜测',async t=>{
  const f=fixture(t);await seed(f);await f.repo.transfer('finish',{id:'legacy-test-123'});assert.deepEqual(f.repo.status().counts,[]);await assert.rejects(f.repo.transfer('rollback',{id:'legacy-test-123'}),/终态/);
});
test('恢复副本在清点后被改动时停止，不清理权威副本或释放锁',async t=>{
  const f=fixture(t);await seed(f);let result;do{result=await f.repo.batchTransfer.legacyRecovery.step('legacy-test-123','rollback',{limit:2});}while(result.state.recovery.stage!=='clear');
  f.repo.db.prepare("UPDATE transfer_rows SET payload=? WHERE kind='backup' AND n=1").run(JSON.stringify(encodeStorageValue({chatKey:'old-000',note:'changed'})));
  await assert.rejects(f.repo.transfer('rollback',{id:'legacy-test-123'}),/清单|副本|原始|解码/);assert.ok(f.repo.db.prepare("SELECT 1 FROM plugin_meta WHERE key='transfer-lock'").get());assert.equal(f.repo.db.prepare("SELECT count(*) AS n FROM transfer_rows WHERE kind='backup'").get().n,13);
});
