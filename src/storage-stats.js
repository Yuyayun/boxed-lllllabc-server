import {DATA_STORES} from '../vendor/frontend/src/storage/transfer-format.js';
const READY='stats-v1-ready',prefix='stats-v1:';
const yieldTurn=()=>new Promise(resolve=>setImmediate(resolve));
export function installStorageStats(repository){
  const {db}=repository;
  const names=[0,1].flatMap(bank=>['insert','delete','update'].map(action=>`boxed_stats_${bank}_${action}`));
  if(names.every(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)))return;
  // Fixed triggers update just the changed record, in its existing transaction.
  // They also cover inactive-bank writes and rollback, without rescanning data.
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const [bank,table] of [[0,'records'],[1,'records_next']]){
      const key=`'${prefix}${bank}:' || `;
      for(const [action,ref,sign] of [['insert','NEW',1],['delete','OLD',-1]])db.exec(`CREATE TRIGGER IF NOT EXISTS boxed_stats_${bank}_${action} AFTER ${action} ON ${table} BEGIN
        INSERT INTO plugin_meta(key,value) VALUES(${key}${ref}.store,json_object('count',${sign},'bytes',${sign}*length(CAST(${ref}.payload AS BLOB))))
        ON CONFLICT(key) DO UPDATE SET value=json_object('count',json_extract(value,'$.count')+${sign},'bytes',json_extract(value,'$.bytes')+${sign}*length(CAST(${ref}.payload AS BLOB))); END;`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS boxed_stats_${bank}_update AFTER UPDATE ON ${table} BEGIN
        INSERT INTO plugin_meta(key,value) VALUES(${key}OLD.store,json_object('count',-1,'bytes',-length(CAST(OLD.payload AS BLOB)))) ON CONFLICT(key) DO UPDATE SET value=json_object('count',json_extract(value,'$.count')-1,'bytes',json_extract(value,'$.bytes')-length(CAST(OLD.payload AS BLOB)));
        INSERT INTO plugin_meta(key,value) VALUES(${key}NEW.store,json_object('count',1,'bytes',length(CAST(NEW.payload AS BLOB)))) ON CONFLICT(key) DO UPDATE SET value=json_object('count',json_extract(value,'$.count')+1,'bytes',json_extract(value,'$.bytes')+length(CAST(NEW.payload AS BLOB))); END;`);
    }
    if(!db.prepare('SELECT 1 FROM plugin_meta WHERE key=?').get(READY)&&!db.prepare('SELECT 1 FROM records LIMIT 1').get()&&!db.prepare('SELECT 1 FROM records_next LIMIT 1').get())db.prepare('INSERT INTO plugin_meta VALUES(?,?)').run(READY,'1');
    db.exec('COMMIT');
  }catch(error){repository.rollback(error);}
}
export async function initializeStorageStats(repository){
  const {db}=repository;if(db.prepare('SELECT 1 FROM plugin_meta WHERE key=?').get(READY))return;
  // Domain requests wait for this bounded scan. Keep a stable write fence, yield
  // between pages, and publish only complete counts; a crash restarts safely.
  db.exec('BEGIN IMMEDIATE');
  try{
    const totals=[];let count=0;
    for(const [bank,table] of [[0,'records'],[1,'records_next']])for(const store of DATA_STORES){
      let after='',bytes=0,rows=0;
      const page=db.prepare(`SELECT primary_key,length(CAST(payload AS BLOB)) AS bytes FROM ${table} WHERE store=? AND primary_key>? ORDER BY primary_key LIMIT 100`);
      while(true){const result=page.all(store,after);if(!result.length)break;for(const row of result){after=row.primary_key;bytes+=row.bytes;rows++;count++;}repository.reportProgress?.({count},'storage-statistics');await yieldTurn();}
      totals.push([prefix+bank+':'+store,JSON.stringify({count:rows,bytes})]);
    }
    const put=db.prepare('INSERT INTO plugin_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');for(const row of totals)put.run(...row);put.run(READY,'1');db.exec('COMMIT');repository.reportProgress?.({count},'storage-statistics-complete');
  }catch(error){repository.rollback(error);}
}
export function readStorageStats(repository){
  const {db}=repository;if(!db.prepare('SELECT 1 FROM plugin_meta WHERE key=?').get(READY))return null;
  const bank=repository.activeDataset(),read=db.prepare('SELECT value FROM plugin_meta WHERE key=?');return DATA_STORES.map(store=>({store,...JSON.parse(read.get(prefix+bank+':'+store)?.value??'{"count":0,"bytes":0}')})).filter(row=>row.count>0);
}
