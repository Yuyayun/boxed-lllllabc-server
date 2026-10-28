import {transferId,recordText,DATA_STORES} from './transfer-format.js';
import {datasetId} from './dataset-layout.js';
import {INITIAL_CURSOR,initialSummary,advanceSummary,batchPacket,same,pageBudget,validateCursor} from './transfer-batch-format.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'transfer-conflict'});};
const number=value=>Number.isSafeInteger(value)&&value>=0;
function validSummary(value){return value?.version===2&&same(value.stores,DATA_STORES)&&number(value.count)&&number(value.bytes)&&/^[a-f0-9]{64}$/.test(value.digest)&&DATA_STORES.every(name=>number(value.counts?.[name]))&&DATA_STORES.reduce((sum,name)=>sum+value.counts[name],0)===value.count;}
// Recover receipts written by 1.0.0. The old backup rows remain the authority
// until their complete, bounded restoration has been read back and verified.
export function createLegacyRecovery({driver,onProgress=()=>{},hook=async()=>{}}){
  async function locked(tx,id,intent){
    await tx.validateLayout();const state=await tx.taskGet(id),lock=await tx.lockGet();
    if(!state){if(lock)fail('旧任务锁缺少登记，未猜测恢复结果。');return null;}
    if(state.version===3||state.id&&state.id!==id||!['source','target'].includes(state.role))fail('旧任务登记版本或身份不一致。');
    if(['finished','rolled-back'].includes(state.phase)){
      if(state.phase!==(intent==='finish'?'finished':'rolled-back'))fail('旧任务终态与恢复方向不一致。');
      if(lock)fail('旧任务终态仍存在数据锁，需保留现场核对。');return state;
    }
    if(lock!==id||datasetId(await tx.active())!==0)fail('旧任务数据区或持久锁不一致。');
    const r=state.recovery;
    if(r&&(r.version!==1||r.intent!==intent||r.revision!==await tx.revision()||!['inventory','clear','copy','verify','verify-active','count-active','cleanup'].includes(r.stage)))fail('旧任务恢复登记或修订已变化。');
    if(r){
      const restoring=intent==='rollback'&&state.role==='target'&&state.phase==='committed',verifyingActive=intent==='finish'&&state.role==='target'&&state.phase==='committed';
      const stages=restoring?['inventory','clear','copy','verify','cleanup']:verifyingActive?['verify-active','count-active','cleanup']:['cleanup'];
      if(r.restoring!==restoring||r.verifyingActive!==verifyingActive||!stages.includes(r.stage)||!number(r.revision)||!number(r.after)||!number(r.cleared)||!number(r.removed)||!validSummary(r.summary)||typeof r.verified!=='boolean')fail('旧任务恢复检查点损坏，未猜测进度。');validateCursor(r.cursor);
      if((restoring&&r.stage!=='inventory'||verifyingActive)&&(!validSummary(r.manifest)||r.summary.count>r.manifest.count)||['inventory','copy'].includes(r.stage)&&r.after!==r.summary.count)fail('旧任务回滚清单不完整。');
      if(verifyingActive&&!same(r.manifest,state.manifest??state.expected))fail('旧任务已启用清单已变化。');
      if(verifyingActive&&(!validSummary(r.countSummary)||r.countSummary.count>r.manifest.count||r.after!==r.summary.count))fail('旧任务已启用记录计数登记不完整。');
      if(restoring&&r.stage==='clear'&&!same(r.summary,r.manifest)||(restoring||verifyingActive)&&r.stage==='cleanup'&&(!r.verified||!same(r.summary,r.manifest)))fail('旧任务尚未完整核验，不能清理回滚副本。');
      if(verifyingActive&&r.stage==='cleanup'&&(r.countSummary.count!==r.manifest.count||r.countSummary.bytes!==r.manifest.bytes||!same(r.countSummary.counts,r.manifest.counts)))fail('旧任务已启用记录总量尚未完整核验。');
    }
    return state;
  }
  const save=(tx,id,state,recovery)=>tx.taskPut({...state,id,recovery});
  async function step(id,intent,options){
    transferId(id);if(!['rollback','finish'].includes(intent))fail('旧任务恢复方向无效。');const budget=pageBudget(options),empty=await initialSummary();
    const state=await driver.transaction('readwrite',async tx=>{
      const value=await locked(tx,id,intent);if(!value||['finished','rolled-back'].includes(value.phase))return value;
      if(!value.recovery){
        if(!(value.role==='source'?value.phase==='captured':['staging','checking','verified','committed'].includes(value.phase))||intent==='finish'&&value.role==='target'&&value.phase!=='committed')fail('旧任务不在可恢复阶段。');
        const restore=intent==='rollback'&&value.role==='target'&&value.phase==='committed';
        const verifyingActive=intent==='finish'&&value.role==='target'&&value.phase==='committed';
        if(verifyingActive&&!validSummary(value.manifest??value.expected))fail('旧任务已启用清单缺失，未猜测完成结果。');
        if(restore&&value.baseRevision+1!==await tx.revision())fail('旧目标提交后已变化，未覆盖现场。');
        await save(tx,id,value,{version:1,intent,restoring:restore,verifyingActive,verified:false,cleared:0,removed:0,revision:await tx.revision(),stage:restore?'inventory':verifyingActive?'verify-active':'cleanup',after:0,cursor:{...INITIAL_CURSOR},summary:empty,...(verifyingActive?{manifest:value.manifest??value.expected,countSummary:empty}:{})});
        return tx.taskGet(id);
      }return value;
    });
    if(!state||['finished','rolled-back'].includes(state.phase))return {done:true,state};
    const r=state.recovery;
    const read=fn=>driver.transaction('readonly',async tx=>{const current=await locked(tx,id,intent);if(!same(current,state))fail('旧恢复检查点已变化。');return fn(tx);});
    const write=fn=>driver.transaction('readwrite',async tx=>{const current=await locked(tx,id,intent);if(!same(current,state))fail('旧恢复检查点已变化。');return fn(tx);});
    if(r.stage==='inventory'||r.stage==='copy'){
      const rows=await read(tx=>tx.legacyPage(id,'backup',r.after,budget));
      const packet=rows.length?await batchPacket(id,1,rows):null,summary=packet?await advanceSummary(r.summary,packet.rows,packet.bytes):r.summary;
      await write(async tx=>{
        const actual=await tx.legacyPage(id,'backup',r.after,budget);if(!same(actual,rows))fail('旧回滚副本在读回后变化。');
        if(r.stage==='copy')for(const row of rows){await tx.add(0,row.store,row.key,row.value);if(recordText({...row,value:await tx.get(0,row.store,row.key)})!==recordText(row))fail('旧备份分批恢复后读回不一致。');}
        if(rows.length)await save(tx,id,state,{...r,after:rows.at(-1).n,summary});
        else if(r.stage==='inventory')await save(tx,id,state,{...r,stage:'clear',manifest:summary,cursor:{...INITIAL_CURSOR}});
        else{if(!same(summary,r.manifest))fail('旧回滚副本与最初清单不一致。');await save(tx,id,state,{...r,stage:'verify',after:0,summary:empty,cursor:{...INITIAL_CURSOR}});}
      });
    }else if(r.stage==='clear'){
      await write(async tx=>{const page=await tx.page(0,r.cursor,budget);for(const row of page.rows)await tx.remove(0,row.store,row.key);await save(tx,id,state,{...r,cleared:r.cleared+page.rows.length,cursor:page.cursor,...(page.done?{stage:'copy',after:0,summary:empty}:{})});});
    }else if(r.stage==='verify-active'){
      const rows=await read(tx=>tx.legacyPage(id,'data',r.after,budget)),packet=rows.length?await batchPacket(id,1,rows):null,summary=packet?await advanceSummary(r.summary,packet.rows,packet.bytes):r.summary;
      await write(async tx=>{
        if(!same(await tx.legacyPage(id,'data',r.after,budget),rows))fail('旧任务已启用校验副本发生变化。');
        for(const row of rows)if(recordText({...row,value:await tx.get(0,row.store,row.key)})!==recordText(row))fail('恢复后正式记录与旧校验副本不一致。');
        if(!rows.length&&!same(summary,r.manifest))fail('旧任务已启用内容与最初清单不一致。');
        await save(tx,id,state,{...r,summary,after:rows.at(-1)?.n??r.after,...(!rows.length?{stage:'count-active'}:{})});
      });
    }else if(['verify','count-active'].includes(r.stage)){
      const before=r.stage==='count-active'?r.countSummary:r.summary;
      const page=await read(tx=>tx.page(0,r.cursor,budget));const rows=page.rows.map((row,i)=>({...row,n:before.count+i+1}));const packet=rows.length?await batchPacket(id,1,rows):null,summary=packet?await advanceSummary(before,packet.rows,packet.bytes):before;
      await write(async tx=>{
        const actual=await tx.page(0,r.cursor,budget);if(!same(actual,page))fail('旧目标在验收期间变化。');
        if(r.stage==='verify')for(const row of rows){const backup=await tx.legacyRow(id,'backup',row.n);if(!backup||recordText(backup)!==recordText(row))fail('恢复后正式记录与旧校验副本不一致。');}
        if(page.done&&(r.stage==='verify'?!same(summary,r.manifest):summary.count!==r.manifest.count||summary.bytes!==r.manifest.bytes||!same(summary.counts,r.manifest.counts)))fail('旧任务恢复后的完整数量或内容不一致。');
        await save(tx,id,state,{...r,...(r.stage==='count-active'?{countSummary:summary}:{summary}),cursor:page.cursor,...(page.done?{stage:'cleanup',verified:true}:{})});
      });
    }else if(r.stage==='cleanup'){
      return write(async tx=>{
        const keys=await tx.legacyKeys(id,100);for(const key of keys)await tx.legacyDelete(id,key);
        if(keys.length){await save(tx,id,state,{...r,removed:r.removed+keys.length});return {done:false,state:await tx.taskGet(id)};}
        if(intent==='rollback'&&state.role==='target'&&state.phase==='committed')await tx.revisionPut(r.revision+1);
        const result={...state,id,phase:intent==='finish'?'finished':'rolled-back',recovery:{...r,stage:'done'}};await tx.taskPut(result);await tx.lockDelete();return {done:true,state:result};
      });
    }
    return {done:false,state:await driver.transaction('readonly',tx=>tx.taskGet(id))};
  }
  async function run(id,intent,options){while(true){const result=await step(id,intent,options);onProgress(result.state?.recovery);await hook(result.state?.recovery);if(result.done)return result.state;await new Promise(resolve=>setTimeout(resolve,0));}}
  return {step,run};
}
