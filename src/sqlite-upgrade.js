import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DATA_STORES} from '../vendor/frontend/src/storage/transfer-format.js';
import {failure} from './errors.js';

const OLD='records_before_v3',NEW='records_upgrade_v4',JOURNAL='schema-upgrade-v4';
export const MAINTENANCE_TABLES={records:['store','primary_key'],records_next:['store','primary_key'],plugin_meta:['key'],transfer_rows:['id','kind','n']};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const tableSql=name=>`CREATE TABLE ${name} (store TEXT NOT NULL CHECK(store IN (${DATA_STORES.map(s=>`'${s}'`).join(',')})), primary_key TEXT NOT NULL, chat_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(store,primary_key)) STRICT`;
export function rawPage(db,table,keys,after){
  const filter=after?`WHERE (${keys.join(',')}) > (${keys.map(()=>'?').join(',')})`:'';
  const query=db.prepare(`SELECT * FROM ${table} ${filter} ORDER BY ${keys.join(',')} LIMIT 100`),rows=[];let bytes=0;
  for(const row of query.iterate(...(after??[]))){const size=Buffer.byteLength(JSON.stringify(row));if(rows.length&&bytes+size>2*1024*1024)break;if(size>9*1024*1024)throw failure('too-large','旧库单条记录超出升级预算，原库已保留。');rows.push(row);bytes+=size;}
  return rows;
}
const position=(row,keys)=>keys.map(key=>row[key]);
const put=(db,value)=>db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(JOURNAL,JSON.stringify(value));
const report=(repository,stage,count)=>repository.reportProgress?.({count},stage);
function transaction(repository,fn){repository.db.exec('BEGIN IMMEDIATE');try{const result=fn();repository.db.exec('COMMIT');return result;}catch(error){repository.rollback(error);}}
function fences(db,tables,drop=false){
  for(const table of tables)for(const action of ['INSERT','UPDATE','DELETE']){
    const name=`boxed_upgrade_fence_${table}_${action}`;
    if(drop){db.exec(`DROP TRIGGER IF EXISTS ${name}`);continue;}
    const condition=table==='plugin_meta'?` WHEN ${action==='INSERT'?`NEW.key<>'${JOURNAL}'`:action==='DELETE'?`OLD.key<>'${JOURNAL}'`:`NEW.key<>'${JOURNAL}' OR OLD.key<>'${JOURNAL}'`}`:'';
    db.exec(`CREATE TRIGGER ${name} BEFORE ${action} ON ${table}${condition} BEGIN SELECT RAISE(ABORT,'boxed schema upgrade in progress'); END`);
  }
}
async function manifest(db,table,keys,repository,stage,{skipJournal=false}={}){
  let after=null,count=0;const hash=createHash('sha256');
  while(true){const rows=rawPage(db,table,keys,after);if(!rows.length)break;
    for(const row of rows)if(!skipJournal||row.key!==JOURNAL){hash.update(JSON.stringify(row)+'\n');count++;}
    after=position(rows.at(-1),keys);report(repository,stage,count);await tick();
  }return {count,digest:hash.digest('hex')};
}
const equal=(a,b)=>a?.count===b?.count&&a?.digest===b?.digest;

export async function upgradeLegacyDatabase(repository){
  const {db,file}=repository;
  const existing=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
  if(existing.some(row=>!Object.hasOwn(MAINTENANCE_TABLES,row.name)))throw failure('database-unavailable','旧库包含未知表，未开始升级或覆盖原文件。');
  const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all(),triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();
  const version=db.prepare('PRAGMA user_version').get().user_version,appId=db.prepare('PRAGMA application_id').get().application_id;
  const size=['','-wal'].reduce((sum,suffix)=>sum+(fs.existsSync(file+suffix)?fs.statSync(file+suffix).size:0),0);
  try{const space=fs.statfsSync(file);if(space.bavail*space.bsize<size*4+32*1024*1024)throw failure('database-unavailable','旧库升级所需备份、数据区和 WAL 空间不足，原库未改写。');}catch(error){if(error.code==='database-unavailable')throw error;}
  const backup=`${file}.before-v3-${randomUUID()}.bak`,partial=backup+'.pending';let copy;
  // A write fence makes the logical backup a consistent snapshot, including
  // live WAL. No large writes are made to the source in this transaction.
  db.exec('BEGIN IMMEDIATE');
  try{
    copy=new DatabaseSync(partial);copy.exec('PRAGMA synchronous=FULL');
    for(const row of existing)copy.exec(row.sql);for(const row of indexes)copy.exec(row.sql);
    const manifests={};let count=0;
    for(const {name} of existing){
      const keys=MAINTENANCE_TABLES[name],hash=createHash('sha256');let after=null,n=0;
      while(true){
        const rows=rawPage(db,name,keys,after);if(!rows.length)break;const columns=Object.keys(rows[0]),insert=copy.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        copy.exec('BEGIN');try{for(const row of rows)insert.run(...columns.map(key=>row[key]));copy.exec('COMMIT');}catch(error){copy.exec('ROLLBACK');throw error;}
        if(JSON.stringify(rows)!==JSON.stringify(rawPage(copy,name,keys,after)))throw new Error('旧库一致备份分批读回不一致。');
        for(const row of rows)hash.update(JSON.stringify(row)+'\n');n+=rows.length;count+=rows.length;after=position(rows.at(-1),keys);report(repository,'upgrade-backup',count);await tick();
      }manifests[name]={count:n,digest:hash.digest('hex')};
    }
    for(const row of triggers)copy.exec(row.sql);copy.exec(`PRAGMA application_id=${appId}; PRAGMA user_version=${version}`);copy.close();copy=null;fs.renameSync(partial,backup);
    report(repository,'upgrade-backup-complete',count);await tick();
    db.exec(tableSql(NEW));db.exec(`CREATE INDEX upgrade_by_chat ON ${NEW}(store,chat_key,primary_key); CREATE INDEX upgrade_snapshot_page ON ${NEW}(store,chat_key,CAST(json_extract(primary_key,'$[1]') AS INTEGER)) WHERE store='snapshot_messages'`);
    db.exec('CREATE TABLE IF NOT EXISTS plugin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT');
    const tables=existing.map(row=>row.name);if(!tables.includes('plugin_meta'))tables.push('plugin_meta');fences(db,tables);
    put(db,{version:1,stage:'copy',backup:path.basename(backup),manifests,sourceVersion:version,tables,after:null,copied:0,removed:0});db.exec('COMMIT');repository.upgradePending=false;repository.maintenancePending=true;
  }catch(error){try{copy?.close();}finally{try{db.exec('ROLLBACK');}catch{}}throw error;}
}

export async function finishLegacyUpgrade(repository){
  const {db,file}=repository,row=db.prepare('SELECT value FROM plugin_meta WHERE key=?').get(JOURNAL),state=row&&JSON.parse(row.value);
  if(!state)throw new Error('旧库升级缺少登记，保留原表等待核对。');
  if(state.version!==1||!['copy','checking','cleanup'].includes(state.stage)||!Array.isArray(state.tables)||state.tables.some(t=>!Object.hasOwn(MAINTENANCE_TABLES,t))||typeof state.backup!=='string'||!state.backup.startsWith(path.basename(file)+'.before-v3-')||path.basename(state.backup)!==state.backup||!state.backup.endsWith('.bak'))throw new Error('旧库升级登记无效，保留原表等待核对。');
  if(!Number.isInteger(state.sourceVersion)||state.sourceVersion<0||state.sourceVersion>2||!state.manifests||!Object.keys(state.manifests).length||Object.entries(state.manifests).some(([table,m])=>!state.tables.includes(table)||!Number.isSafeInteger(m?.count)||m.count<0||!/^[a-f0-9]{64}$/.test(m?.digest))||![state.copied,state.removed].every(n=>Number.isSafeInteger(n)&&n>=0)||state.copied>(state.manifests.records?.count??0)||db.prepare('PRAGMA user_version').get().user_version!==(state.stage==='cleanup'?4:state.sourceVersion))throw new Error('旧库升级清单或检查点不完整，未猜测进度。');
  const backupPath=path.join(path.dirname(file),state.backup);if(!fs.existsSync(backupPath)||fs.lstatSync(backupPath).isSymbolicLink())throw new Error('旧库升级备份不可用，未清理原表。');
  const backup=new DatabaseSync(backupPath,{readOnly:true});
  try{if(backup.prepare('PRAGMA application_id').get().application_id!==0x424f5844||backup.prepare('PRAGMA user_version').get().user_version!==state.sourceVersion)throw new Error('旧库升级备份身份不符。');for(const [table,expected] of Object.entries(state.manifests)){
    if(!Object.hasOwn(MAINTENANCE_TABLES,table))throw new Error('旧库升级清单包含未知表。');
    if(!equal(await manifest(backup,table,MAINTENANCE_TABLES[table],repository,'upgrade-backup-recheck'),expected))throw new Error('旧库升级备份内容变化，未继续清理原表。');
    if(state.stage!=='cleanup'&&!equal(await manifest(db,table,MAINTENANCE_TABLES[table],repository,'upgrade-source-recheck',{skipJournal:table==='plugin_meta'}),expected))throw new Error('旧库来源在升级期间变化，保留原表和备份。');
  }}finally{backup.close();}
  if(state.stage==='cleanup'&&(!equal(await manifest(db,'records',MAINTENANCE_TABLES.records,repository,'upgrade-target-recheck'),state.manifests.records??{count:0,digest:createHash('sha256').digest('hex')})||state.copied!==(state.manifests.records?.count??0)))throw new Error('旧库已启用内容与验收清单不符，未清理原表。');
  if(state.stage==='copy'){
    while(true){const rows=state.manifests.records?rawPage(db,'records',MAINTENANCE_TABLES.records,state.after):[];
      transaction(repository,()=>{
        const insert=db.prepare(`INSERT INTO ${NEW}(store,primary_key,chat_key,payload) VALUES(?,?,?,?)`),read=db.prepare(`SELECT * FROM ${NEW} WHERE store=? AND primary_key=?`);
        for(const record of rows){insert.run(record.store,record.primary_key,record.chat_key,record.payload);if(JSON.stringify(read.get(record.store,record.primary_key))!==JSON.stringify(record))throw new Error('旧库新结构分批读回不一致。');}
        if(rows.length){state.after=position(rows.at(-1),MAINTENANCE_TABLES.records);state.copied+=rows.length;}else state.stage='checking';put(db,state);
      });report(repository,'upgrade-copy-verified',state.copied);await tick();if(!rows.length)break;
    }
  }
  if(state.stage==='checking'){
    const expected=state.manifests.records??{count:0,digest:createHash('sha256').digest('hex')};
    if(!equal(await manifest(db,NEW,MAINTENANCE_TABLES.records,repository,'upgrade-target-check'),expected))throw new Error('旧库新结构完整校验不一致，未启用新表。');
    transaction(repository,()=>{
      fences(db,state.tables,true);for(const bank of [0,1])for(const action of ['insert','delete','update'])db.exec(`DROP TRIGGER IF EXISTS boxed_stats_${bank}_${action}`);
      if(state.manifests.records)db.exec(`ALTER TABLE records RENAME TO ${OLD}`);db.exec(`ALTER TABLE ${NEW} RENAME TO records`);
      db.exec("DELETE FROM plugin_meta WHERE key LIKE 'stats-v1%'");
      db.exec('CREATE TABLE IF NOT EXISTS transfer_rows(id TEXT NOT NULL,kind TEXT NOT NULL,n INTEGER NOT NULL,store TEXT NOT NULL,primary_key TEXT NOT NULL,chat_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,kind,n),UNIQUE(id,kind,store,primary_key)) STRICT');
      if(!state.manifests.records_next){db.exec(tableSql('records_next'));db.exec("CREATE INDEX next_by_chat ON records_next(store,chat_key,primary_key);CREATE INDEX next_snapshot_page ON records_next(store,chat_key,CAST(json_extract(primary_key,'$[1]') AS INTEGER)) WHERE store='snapshot_messages'");}
      state.stage='cleanup';put(db,state);db.exec('PRAGMA user_version=4');
    });report(repository,'upgrade-activated',state.copied);await tick();
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(OLD))while(true){
    const rows=rawPage(db,OLD,MAINTENANCE_TABLES.records,null);if(!rows.length)break;
    transaction(repository,()=>{const remove=db.prepare(`DELETE FROM ${OLD} WHERE store=? AND primary_key=?`);for(const record of rows)remove.run(record.store,record.primary_key);state.removed+=rows.length;put(db,state);});report(repository,'upgrade-cleanup',state.removed);await tick();
  }
  transaction(repository,()=>{db.exec(`DROP TABLE IF EXISTS ${OLD}`);db.prepare('DELETE FROM plugin_meta WHERE key=?').run(JOURNAL);});repository.maintenancePending=false;
}
