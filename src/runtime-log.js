import fs from 'node:fs/promises';
import path from 'node:path';

const DAY=86400000,LINE_LIMIT=4096;
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
const CATEGORIES=new Set(['all','migration','cleanup','daily','error']);
const TERMINAL=new Set(['completed','cancelled']);
const DURABLE=new Set(['registered','completed','cancelled','paused','recover','committed','activated','error','timeout']);
const STAGES=new Set(['registered','inventory','source','source-check','source-checked','prepare','prepared','append','batch-verified','resume-batch','target-check','verified','committing','committed','commit-check','target-checked','before-control','activated','target-activated','finish-target','finish-source','release-source','release-target','completed','cancelled','paused','recover','error','started','finished','initializing','progress','timeout']);
const safeCode=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(value)?value:undefined;
export function validateLogEvent(event) {
  if(!event||Object.keys(event).some(k=>!['taskId','stage','from','to','kind','count','verified','batch','bytes','errorCode'].includes(k))||!ID.test(event.taskId)||!STAGES.has(event.stage)
    ||!['indexeddb','sqlite'].includes(event.from)||!['indexeddb','sqlite'].includes(event.to)||event.from===event.to||!['switch','clear'].includes(event.kind))throw new Error('运行日志事件参数无效。');
  for(const name of ['count','verified','batch','bytes'])if(event[name]!==undefined&&(!Number.isSafeInteger(event[name])||event[name]<0))throw new Error('运行日志数量参数无效。');
  if(event.errorCode!==undefined&&!safeCode(event.errorCode))throw new Error('运行日志错误代码无效。');
  return event;
}

// Log metadata is an index for retention only, never a recovery journal. All
// filenames are generated here; the API accepts no filesystem paths or text.
export class RuntimeLog {
  constructor(directory,{now=()=>Date.now(),maxFileBytes=2*1024*1024}={}) {
    this.directory=directory;this.now=now;this.maxFileBytes=Math.max(8192,maxFileBytes);this.tail=Promise.resolve();this.state=null;this.initialized=false;this.metaCache=new Map();this.lastSyncAt=-Infinity;
  }
  serial(fn){const run=this.tail.then(fn);this.tail=run.catch(()=>{});return run;}
  file(part){return path.join(this.directory,`boxed-lllllabc-log-${String(part).padStart(8,'0')}.jsonl`);}
  metaFile(group){if(!/^(task-[a-zA-Z0-9_-]{8,80}|daily-\d{4}-\d{2}-\d{2})$/.test(group))throw new Error('日志组无效。');return path.join(this.directory,`boxed-lllllabc-log-${group}.meta.json`);}
  async atomic(file,value,durable=true){const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o600});if(durable){const h=await fs.open(temporary,'r+');try{await h.sync();}finally{await h.close();}}await fs.rename(temporary,file);}
  async stat(file){try{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw new Error('日志文件类型无效。');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async init(){
    if(this.initialized)return;
    await fs.mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'boxed-lllllabc-log-state.json');
    try{await this.stat(file);this.state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,part:0,seq:0,date:new Date(this.now()).toISOString().slice(0,10)};}
    if(this.state.version!==1||!Number.isSafeInteger(this.state.part)||this.state.part<0||!Number.isSafeInteger(this.state.seq)||this.state.generation!==undefined&&(!Number.isSafeInteger(this.state.generation)||this.state.generation<0))throw new Error('日志索引损坏，未覆盖原日志。');
    // An append can reach disk before the tiny index rename. Reconcile the
    // bounded current segment instead of duplicating sequence numbers.
    while(await this.stat(this.file(this.state.part+1))){this.state.part++;await new Promise(resolve=>setImmediate(resolve));}
    const current=await this.stat(this.file(this.state.part));
    if(current){if(current.size>this.maxFileBytes+LINE_LIMIT)throw new Error('日志分段超过配置上限。');const text=await fs.readFile(this.file(this.state.part),'utf8');for(const line of text.split('\n')){try{const item=JSON.parse(line);if(Number.isSafeInteger(item.seq))this.state.seq=Math.max(this.state.seq,item.seq);}catch{/* Torn final log line is diagnostic data, never a state checkpoint. */}}if(text&&!text.endsWith('\n'))await fs.appendFile(this.file(this.state.part),'\n');}
    this.initialized=true;
  }
  async getMeta(group){
    if(this.metaCache.has(group))return this.metaCache.get(group);
    let value;try{const file=this.metaFile(group);await this.stat(file);value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;value=null;}
    if(this.metaCache.size>=128)this.metaCache.delete(this.metaCache.keys().next().value);this.metaCache.set(group,value);return value;
  }
  record(input){return this.serial(async()=>{
    await this.init();const time=this.now(),timestamp=new Date(time).toISOString(),taskId=ID.test(input.taskId??'')?input.taskId:undefined;
    const scope=taskId?(input.kind==='clear'?'cleanup':'migration'):'daily',group=taskId?'task-'+taskId:'daily-'+timestamp.slice(0,10);
    const error=!!input.errorCode||['error','timeout'].includes(input.stage),stage=STAGES.has(input.stage)?input.stage:'progress';
    const entry={seq:++this.state.seq,timestamp,category:error?'error':scope,scope,...(taskId?{taskId}:{}),stage};
    for(const name of ['operation','errorCode','from','to','kind']){const value=safeCode(input[name]);if(value)entry[name]=value;}
    for(const name of ['count','verified','batch','bytes','elapsedMs','progressSeq','sqliteCode'])if(Number.isSafeInteger(input[name])&&input[name]>=0)entry[name]=input[name];
    const previous=await this.getMeta(group),meta=previous??{version:1,group,startedAt:timestamp,endedAt:null,hadError:false,status:taskId?'pending':'completed'};
    meta.hadError ||= error||stage==='recover';meta.lastSeq=entry.seq;
    if(!taskId||TERMINAL.has(stage)){meta.endedAt=timestamp;meta.status=taskId?stage:'completed';}
    // Write sticky error/pending retention before the entry. An interruption
    // cannot leave earlier task context eligible for seven-day deletion.
    let durable=!previous||error||taskId&&DURABLE.has(stage)||time-this.lastSyncAt>=1000;
    let line=JSON.stringify(entry)+'\n';if(Buffer.byteLength(line)>LINE_LIMIT)throw new Error('日志条目超过上限。');
    const size=(await this.stat(this.file(this.state.part)))?.size??0;
    if(size&& (size+Buffer.byteLength(line)>this.maxFileBytes||this.state.date!==timestamp.slice(0,10))){this.state.part++;this.state.date=timestamp.slice(0,10);durable=true;}
    // Progress may lose its last second on power loss. Important outcomes flush
    // retention metadata before the line, then the line and segment index.
    await this.atomic(this.metaFile(group),meta,durable);this.metaCache.set(group,meta);
    const h=await fs.open(this.file(this.state.part),'a',0o600);try{await h.write(line);if(durable)await h.sync();}finally{await h.close();}
    if(durable){await this.atomic(path.join(this.directory,'boxed-lllllabc-log-state.json'),this.state);this.lastSyncAt=time;}return entry;
  });}
  page({category='all',cursor,limit=50,bytes=65536}={}){return this.serial(async()=>{
    await this.init();if(!CATEGORIES.has(category)||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(bytes)||bytes<4096||bytes>131072)throw new Error('日志分页参数无效。');
    let p=this.state.part,o=null;
    if(cursor){let value;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('日志游标无效。');}p=value.p;o=value.o;if(!Number.isSafeInteger(p)||p<0||p>this.state.part||o!==null&&(!Number.isSafeInteger(o)||o<0))throw new Error('日志游标无效。');if((value.g??0)!==(this.state.generation??0))return {entries:[],cursor:null,stale:true};}
    const entries=[];let used=0,scanned=0,segments=0;
    while(p>=0&&scanned<bytes&&segments++<16){
      const stat=await this.stat(this.file(p));if(!stat){p--;o=null;continue;}if(o===null)o=stat.size;if(o>stat.size)return {entries:[],cursor:null,stale:true};
      if(!o){p--;o=null;continue;}
      const start=Math.max(0,o-(bytes-scanned)-LINE_LIMIT),length=o-start,buffer=Buffer.alloc(length),h=await fs.open(this.file(p),'r');
      try{await h.read(buffer,0,length,start);}finally{await h.close();}
      let end=length;
      while(end>0&&entries.length<limit&&scanned<bytes){
        if(buffer[end-1]===10)end--;const previous=buffer.lastIndexOf(10,end-1),begin=previous+1;
        if(begin===0&&start>0)break;
        const raw=buffer.subarray(begin,end),lineStart=start+begin;o=lineStart;scanned+=raw.length+1;end=begin;
        let item;try{item=JSON.parse(raw.toString('utf8'));}catch{continue;}
        // Older writers labeled every task as migration. Correct that view
        // from its recorded kind without rewriting historical log files.
        if(item.kind==='clear'){item.scope='cleanup';if(item.category!=='error')item.category='cleanup';}
        if(category!=='all'&&!(category==='error'?item.category==='error':item.scope===category))continue;
        const size=Buffer.byteLength(JSON.stringify(item));if(entries.length&&used+size>bytes){o=lineStart+raw.length+1;break;}
        entries.push(item);used+=size;
      }
      if(entries.length>=limit||scanned>=bytes||used>=bytes)break;
      if(start===0&&end===0){p--;o=null;}else if(o===0){p--;o=null;}else if(end>0){break;}
    }
    const next=p<0?null:Buffer.from(JSON.stringify({p,o,g:this.state.generation??0})).toString('base64url');return {entries,cursor:next,scannedBytes:scanned};
  });}
  cleanup({cursor=0,maxFiles=4,manual=false}={}){return this.serial(async()=>{
    await this.init();if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>8||typeof manual!=='boolean')throw new Error('日志清理参数无效。');
    if(cursor===0){
      // Freeze the sweep boundary. New entries are written beyond it, and their
      // larger lastSeq keeps a reused group from losing its metadata.
      const active=await this.stat(this.file(this.state.part)),date=new Date(this.now()).toISOString().slice(0,10);
      if(active?.size&&(manual||this.state.date!==date)){this.state.part++;this.state.date=date;await this.atomic(path.join(this.directory,'boxed-lllllabc-log-state.json'),this.state);}
      this.sweep={part:0,end:this.state.part,cutoff:this.state.seq,retained:new Set(),manual,next:0};
    }else if(!this.sweep||this.sweep.next!==cursor||this.sweep.manual!==manual){
      // A restart or interleaved sweep invalidates only the log cleanup cursor.
      // Restart at zero; never guess that unvisited segments have been cleaned.
      return {removed:0,files:0,cursor:0,restarted:true,unfinishedPreserved:true};
    }
    const sweep=this.sweep,eligible=meta=>{
      const ended=meta?.endedAt&&Date.parse(meta.endedAt);
      return meta&&TERMINAL.has(meta.status)&&Number.isFinite(ended)&&(manual||this.now()-ended>(meta.hadError?30:7)*DAY);
    };
    let removed=0,files=0,metadataRemoved=0,changed=false;
    for(;sweep.part<sweep.end&&files<maxFiles;sweep.part++,files++){
      const part=sweep.part;
      const file=this.file(part),stat=await this.stat(file);if(!stat)continue;if(stat.size>this.maxFileBytes+LINE_LIMIT)throw new Error('日志分段超过上限，未清理。');
      const lines=(await fs.readFile(file,'utf8')).split('\n'),keep=[];
      for(const line of lines){
        if(!line)continue;let item;try{item=JSON.parse(line);}catch{keep.push(line);sweep.unknown=true;continue;}
        const group=ID.test(item.taskId??'')?'task-'+item.taskId:'daily-'+String(item.timestamp).slice(0,10),meta=await this.getMeta(group);
        if(eligible(meta))removed++;else{keep.push(line);sweep.retained.add(group);}
      }
      if(stat.size&&keep.length===lines.filter(Boolean).length)continue;
      // Persist invalidation before changing a visible segment. If the process
      // stops immediately after unlink/rename, a reopened reader still knows
      // that old offsets cannot be reused.
      if(!changed){this.state.generation=(this.state.generation??0)+1;await this.atomic(path.join(this.directory,'boxed-lllllabc-log-state.json'),this.state);changed=true;}
      if(!keep.length)await fs.unlink(file);
      else{const temporary=file+'.tmp';await fs.writeFile(temporary,keep.join('\n')+'\n',{encoding:'utf8',mode:0o600});const h=await fs.open(temporary,'r+');try{await h.sync();}finally{await h.close();}await fs.rename(temporary,file);}
      await new Promise(resolve=>setImmediate(resolve));
    }
    if(sweep.part===sweep.end){
      if(!sweep.metadata){
        // The open segment was intentionally not rewritten. Its references
        // count too, even when retention metadata is older than its contents.
        const openFile=this.file(sweep.end),openStat=await this.stat(openFile);
        if(openStat){if(openStat.size>this.maxFileBytes+LINE_LIMIT)throw new Error('日志分段超过上限，未回收元数据。');for(const line of (await fs.readFile(openFile,'utf8')).split('\n')){if(!line)continue;try{const item=JSON.parse(line);sweep.retained.add(ID.test(item.taskId??'')?'task-'+item.taskId:'daily-'+String(item.timestamp).slice(0,10));}catch{sweep.unknown=true;}}}
        sweep.metadata=(await fs.readdir(this.directory)).filter(name=>/^boxed-lllllabc-log-(?:task-[a-zA-Z0-9_-]{8,80}|daily-\d{4}-\d{2}-\d{2})\.meta\.json$/.test(name)).sort();
      }sweep.metaIndex??=0;
      for(let n=0;n<maxFiles&&sweep.metaIndex<sweep.metadata.length;n++,sweep.metaIndex++){
        const name=sweep.metadata[sweep.metaIndex],group=name.slice('boxed-lllllabc-log-'.length,-'.meta.json'.length),meta=await this.getMeta(group);
        if(!sweep.unknown&&!sweep.retained.has(group)&&eligible(meta)&&Number.isSafeInteger(meta.lastSeq)&&meta.lastSeq<=sweep.cutoff){await fs.unlink(this.metaFile(group));this.metaCache.delete(group);metadataRemoved++;}
      }
      if(sweep.metaIndex===sweep.metadata.length){this.sweep=null;return {removed,files,metadataRemoved,cursor:null,unfinishedPreserved:true};}
      sweep.next=sweep.end+1+sweep.metaIndex;
    }else sweep.next=sweep.part;
    return {removed,files,metadataRemoved,cursor:sweep.next,unfinishedPreserved:true};
  });}
}
