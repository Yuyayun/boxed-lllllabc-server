import fs from 'node:fs/promises';
import path from 'node:path';

const DAY=86400000,LINE_LIMIT=4096;
const ID=/^[a-zA-Z0-9_-]{8,80}$/;
const CATEGORIES=new Set(['all','migration','daily','error']);
const TERMINAL=new Set(['completed','cancelled']);
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
    this.directory=directory;this.now=now;this.maxFileBytes=Math.max(8192,maxFileBytes);this.tail=Promise.resolve();this.state=null;this.metaCache=new Map();
  }
  serial(fn){const run=this.tail.then(fn);this.tail=run.catch(()=>{});return run;}
  file(part){return path.join(this.directory,`boxed-lllllabc-log-${String(part).padStart(8,'0')}.jsonl`);}
  metaFile(group){if(!/^(task-[a-zA-Z0-9_-]{8,80}|daily-\d{4}-\d{2}-\d{2})$/.test(group))throw new Error('日志组无效。');return path.join(this.directory,`boxed-lllllabc-log-${group}.meta.json`);}
  async atomic(file,value){const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o600});const h=await fs.open(temporary,'r+');try{await h.sync();}finally{await h.close();}await fs.rename(temporary,file);}
  async stat(file){try{const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink())throw new Error('日志文件类型无效。');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async init(){
    if(this.state)return;
    await fs.mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'boxed-lllllabc-log-state.json');
    try{await this.stat(file);this.state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,part:0,seq:0,date:new Date(this.now()).toISOString().slice(0,10)};}
    if(this.state.version!==1||!Number.isSafeInteger(this.state.part)||this.state.part<0||!Number.isSafeInteger(this.state.seq))throw new Error('日志索引损坏，未覆盖原日志。');
    // An append can reach disk before the tiny index rename. Reconcile the
    // bounded current segment instead of duplicating sequence numbers.
    while(await this.stat(this.file(this.state.part+1))){this.state.part++;await new Promise(resolve=>setImmediate(resolve));}
    const current=await this.stat(this.file(this.state.part));
    if(current){if(current.size>this.maxFileBytes+LINE_LIMIT)throw new Error('日志分段超过配置上限。');const text=await fs.readFile(this.file(this.state.part),'utf8');for(const line of text.split('\n')){try{const item=JSON.parse(line);if(Number.isSafeInteger(item.seq))this.state.seq=Math.max(this.state.seq,item.seq);}catch{/* Torn final log line is diagnostic data, never a state checkpoint. */}}if(text&&!text.endsWith('\n'))await fs.appendFile(this.file(this.state.part),'\n');}
  }
  async getMeta(group){
    if(this.metaCache.has(group))return this.metaCache.get(group);
    let value;try{const file=this.metaFile(group);await this.stat(file);value=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;value=null;}
    if(this.metaCache.size>=128)this.metaCache.delete(this.metaCache.keys().next().value);this.metaCache.set(group,value);return value;
  }
  record(input){return this.serial(async()=>{
    await this.init();const time=this.now(),timestamp=new Date(time).toISOString(),taskId=ID.test(input.taskId??'')?input.taskId:undefined;
    const scope=taskId?'migration':'daily',group=taskId?'task-'+taskId:'daily-'+timestamp.slice(0,10);
    const error=!!input.errorCode||['error','timeout'].includes(input.stage),stage=STAGES.has(input.stage)?input.stage:'progress';
    const entry={seq:++this.state.seq,timestamp,category:error?'error':scope,scope,...(taskId?{taskId}:{}),stage};
    for(const name of ['operation','errorCode','from','to','kind']){const value=safeCode(input[name]);if(value)entry[name]=value;}
    for(const name of ['count','verified','batch','bytes','elapsedMs','progressSeq','sqliteCode'])if(Number.isSafeInteger(input[name])&&input[name]>=0)entry[name]=input[name];
    const meta=await this.getMeta(group)??{version:1,group,startedAt:timestamp,endedAt:null,hadError:false,status:taskId?'pending':'completed'};
    meta.hadError ||= error||stage==='recover';meta.lastSeq=entry.seq;
    if(!taskId||TERMINAL.has(stage)){meta.endedAt=timestamp;meta.status=taskId?stage:'completed';}
    // Write sticky error/pending retention before the entry. An interruption
    // cannot leave earlier task context eligible for seven-day deletion.
    await this.atomic(this.metaFile(group),meta);this.metaCache.set(group,meta);
    let line=JSON.stringify(entry)+'\n';if(Buffer.byteLength(line)>LINE_LIMIT)throw new Error('日志条目超过上限。');
    const size=(await this.stat(this.file(this.state.part)))?.size??0;
    if(size&& (size+Buffer.byteLength(line)>this.maxFileBytes||this.state.date!==timestamp.slice(0,10))){this.state.part++;this.state.date=timestamp.slice(0,10);}
    const h=await fs.open(this.file(this.state.part),'a',0o600);try{await h.write(line);await h.sync();}finally{await h.close();}
    await this.atomic(path.join(this.directory,'boxed-lllllabc-log-state.json'),this.state);return entry;
  });}
  page({category='all',cursor,limit=50,bytes=65536}={}){return this.serial(async()=>{
    await this.init();if(!CATEGORIES.has(category)||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(bytes)||bytes<4096||bytes>131072)throw new Error('日志分页参数无效。');
    let p=this.state.part,o=null;
    if(cursor){let value;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('日志游标无效。');}p=value.p;o=value.o;if(!Number.isSafeInteger(p)||p<0||p>this.state.part||o!==null&&(!Number.isSafeInteger(o)||o<0))throw new Error('日志游标无效。');}
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
        if(category!=='all'&&!(category==='error'?item.category==='error':item.scope===category))continue;
        const size=Buffer.byteLength(JSON.stringify(item));if(entries.length&&used+size>bytes){o=lineStart+raw.length+1;break;}
        entries.push(item);used+=size;
      }
      if(entries.length>=limit||scanned>=bytes||used>=bytes)break;
      if(start===0&&end===0){p--;o=null;}else if(o===0){p--;o=null;}else if(end>0){break;}
    }
    const next=p<0?null:Buffer.from(JSON.stringify({p,o})).toString('base64url');return {entries,cursor:next,scannedBytes:scanned};
  });}
  cleanup({cursor=0,maxFiles=4,manual=false}={}){return this.serial(async()=>{
    await this.init();if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>8||typeof manual!=='boolean')throw new Error('日志清理参数无效。');
    // Close the current segment; never rewrite a file receiving new entries.
    const active=await this.stat(this.file(this.state.part)),date=new Date(this.now()).toISOString().slice(0,10);if(active?.size&&(manual||this.state.date!==date)){this.state.part++;this.state.date=date;await this.atomic(path.join(this.directory,'boxed-lllllabc-log-state.json'),this.state);}
    let removed=0,files=0,part=cursor;
    for(;part<this.state.part&&files<maxFiles;part++,files++){
      const file=this.file(part),stat=await this.stat(file);if(!stat)continue;if(stat.size>this.maxFileBytes+LINE_LIMIT)throw new Error('日志分段超过上限，未清理。');
      const lines=(await fs.readFile(file,'utf8')).split('\n'),keep=[];
      for(const line of lines){
        if(!line)continue;let item;try{item=JSON.parse(line);}catch{keep.push(line);continue;}
        const group=ID.test(item.taskId??'')?'task-'+item.taskId:'daily-'+String(item.timestamp).slice(0,10),meta=await this.getMeta(group);
        const ended=meta?.endedAt&&Date.parse(meta.endedAt),eligible=meta&&TERMINAL.has(meta.status)&&Number.isFinite(ended)&&(manual||this.now()-ended>(meta.hadError?30:7)*DAY);
        if(eligible)removed++;else keep.push(line);
      }
      if(keep.length===lines.filter(Boolean).length)continue;
      const temporary=file+'.tmp';await fs.writeFile(temporary,keep.length?keep.join('\n')+'\n':'',{encoding:'utf8',mode:0o600});await fs.rename(temporary,file);
      await new Promise(resolve=>setImmediate(resolve));
    }
    return {removed,files,cursor:part<this.state.part?part:null,unfinishedPreserved:true};
  });}
}
