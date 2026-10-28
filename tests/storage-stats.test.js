import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {SqliteRepository} from '../src/sqlite.js';
function fixture(t){const base=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'boxed-stats-test-')),repo=new SqliteRepository(path.join(dir,'db.sqlite'));t.after(()=>{repo.close();const real=fs.realpathSync(dir);assert.equal(path.dirname(real),base);assert.ok(path.basename(real).startsWith('boxed-stats-test-'));fs.rmSync(real,{recursive:true});});return repo;}
const expected=repo=>repo.prepare('SELECT store,count(*) AS count,sum(length(CAST(payload AS BLOB))) AS bytes FROM records GROUP BY store ORDER BY store').all().map(x=>({...x}));
const check=repo=>assert.deepEqual(repo.status().counts.sort((a,b)=>a.store.localeCompare(b.store)),expected(repo));
test('增量统计覆盖插入、覆盖、回滚、删除、不同数据区与重开',async t=>{
  const repo=fixture(t);await repo.execute('putChatMeta',[{chatKey:'a',note:'中文'}]);check(repo);await repo.execute('putChatMeta',[{chatKey:'a',note:'longer中文'}]);check(repo);
  repo.db.exec('BEGIN');repo.db.exec('DELETE FROM records');repo.db.exec('ROLLBACK');check(repo);
  repo.db.exec('INSERT INTO records_next SELECT * FROM records');repo.db.exec("INSERT INTO plugin_meta VALUES('active-dataset','1')");check(repo);repo.db.exec('DELETE FROM records_next');check(repo);
  repo.close();repo.db=null;const reopened=new SqliteRepository(repo.file);try{check(reopened);}finally{reopened.close();}
});
test('已有数据首次统计分页汇报，完成前不把未知统计当零，重建失败不发布半份结果',async t=>{
  const repo=fixture(t);for(let i=0;i<230;i++)await repo.execute('putChatMeta',[{chatKey:String(i),note:'body'}]);repo.db.exec("DELETE FROM plugin_meta WHERE key LIKE 'stats-v1%'");assert.equal(repo.status().counts,null);
  let pages=0;repo.reportProgress=()=>{if(++pages===2)throw new Error('injected');};await assert.rejects(repo.initialize(),/injected/);assert.equal(repo.status().countsReady,false);
  pages=0;repo.reportProgress=()=>{pages++;};await repo.initialize();assert.ok(pages>=4);check(repo);assert.equal(repo.status().countsReady,true);
  const original=repo.db.prepare.bind(repo.db);repo.db.prepare=sql=>{assert.doesNotMatch(sql,/length\(CAST\(payload|GROUP BY store/);return original(sql);};repo.status();
});
