import {inspectTransferRow} from '../vendor/frontend/src/storage/transfer-format.js';
import {decodeStorageValue} from '../vendor/frontend/src/storage/protocol.js';
import {rawPage as page,MAINTENANCE_TABLES as TABLES} from './sqlite-upgrade.js';
export {upgradeLegacyDatabase,finishLegacyUpgrade} from './sqlite-upgrade.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const position=(row,keys)=>keys.map(key=>row[key]);
const report=(repository,stage,count)=>repository.reportProgress?.({count},stage);

export async function auditStorage(repository){
  const {db}=repository;let count=0;db.exec('BEGIN');
  try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
    if(tables.some(row=>!Object.hasOwn(TABLES,row.name)))throw new Error('发现未知数据库表，启动检查已停止，原库保留。');
    report(repository,'startup-audit',0);
    for(const {name} of tables){let after=null;
      while(true){const rows=page(db,name,TABLES[name],after);if(!rows.length)break;
        for(const row of rows)if(row.payload!==undefined){const value=decodeStorageValue(JSON.parse(row.payload));inspectTransferRow({n:1,store:row.store,key:JSON.parse(row.primary_key),value});if(row.chat_key!==(row.store==='snapshot_messages'?value.snapshotId:value.chatKey))throw new Error('启动检查发现记录聊天归属不一致。');}
        count+=rows.length;after=position(rows.at(-1),TABLES[name]);report(repository,'startup-audit',count);await tick();
      }
    }db.exec('COMMIT');report(repository,'startup-audit-complete',count);
  }catch(error){repository.rollback(error);}
}
