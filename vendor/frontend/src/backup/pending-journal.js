import { hashCanonicalChat, stableStringify } from './canonicalize.js';
import { nativeMessageText, nativeMessageHash, nativeStateHash, sha256Text,sha256TextAsync,knownNativeHash,cacheNativeHash,cloneNativeChat } from './native-content.js';

export const PENDING_FORMAT = 1;
export function newOperationId() {
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  const bytes=new Uint8Array(16);
  if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(bytes);
  else for(let index=0;index<bytes.length;index++)bytes[index]=Math.floor(Math.random()*256);
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const contentEvents = new Set(['message_sent','message_received','message_edited','message_updated','message_deleted','message_swiped','message_swipe_deleted','message_reasoning_edited','message_reasoning_deleted','generation_ended','generation_stopped']);
const clone = value => structuredClone(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isJournalRecord = row => row?.pendingFormat === PENDING_FORMAT;
const fingerprintCache=new WeakMap();
const fingerprintText=record=>stableStringify(Object.fromEntries(Object.entries(record).filter(([key])=>!key.startsWith('verified'))));
export function pendingRecordFingerprint(record) {
  if (!record) return '';
  const text=fingerprintText(record),cached=fingerprintCache.get(record);
  if(cached?.text===text)return cached.hash;
  const hash=sha256Text(text);fingerprintCache.set(record,{text,hash});return hash;
}
export async function warmPendingRecords(records) {
  for(let offset=0;offset<records.length;offset+=64) {
    await Promise.all(records.slice(offset,offset+64).map(async record=>{const text=fingerprintText(record);if(fingerprintCache.get(record)?.text===text)return;fingerprintCache.set(record,{text,hash:await sha256TextAsync(text)});}));
    if(!globalThis.crypto?.subtle)await new Promise(resolve=>setTimeout(resolve,0));
  }
}
function snapshot(message, previous,deferHashes=false) {
  const text = nativeMessageText(message);
  if(previous?.text===text)return previous.ref===message?previous:{...previous,ref:message};
  const hash=knownNativeHash(message,text)??(deferHashes?null:sha256Text(text));
  const entry={ref:message,text,raw:JSON.parse(text),hash};
  if(hash){cacheNativeHash(message,text,hash);cacheNativeHash(entry.raw,text,hash);}
  return entry;
}
const stateHash = entries => nativeStateHash(entries.map(entry => entry.hash));
async function prepareEntries(entries) {
  for(let offset=0;offset<entries.length;offset+=64) {
    await Promise.all(entries.slice(offset,offset+64).map(entry=>{
      if(entry.hash)return undefined;
      return entry.ready??=(async()=>{entry.hash=await sha256TextAsync(entry.text);cacheNativeHash(entry.ref,entry.text,entry.hash);cacheNativeHash(entry.raw,entry.text,entry.hash);})();
    }));
    if(!globalThis.crypto?.subtle)await new Promise(resolve=>setTimeout(resolve,0));
  }
}

export function createPendingObserver({ readCurrent, uuid = newOperationId, now = () => new Date().toISOString(),deferHashes=false }) {
  let observed = null;
  function reset(current = readCurrent()) {
    observed = current?.ok ? { key: current.identity.chatKey, integrity:current.identity.meta?.chatIntegrity??'',streamId: uuid(), sequence: 0, entries: current.chat.map(message => snapshot(message,undefined,deferHashes)) } : null;
    if(deferHashes&&observed)prepareEntries(observed.entries).catch(()=>{});
  }
  function capture(trigger) {
    const current = readCurrent();
    if (!current?.ok) { observed = null; return { records: [], chatKey: null }; }
    const chatKey = current.identity.chatKey;
    const base = { chatKey, identity: clone(current.identity), records: [] };
    const loadOnly = !contentEvents.has(trigger.eventName) || trigger.args?.includes('first_message');
    if (loadOnly) { reset(current); return base; }
    const swipeTarget = eventMessageIndex(trigger, current.chat.length);
    const swipe = current.chat[swipeTarget];
    if (trigger.eventName === 'message_swiped' && Array.isArray(swipe?.swipes) && Number(swipe.swipe_id) >= swipe.swipes.length) return base;
    if (!observed || observed.key !== chatKey || observed.integrity!==(current.identity.meta?.chatIntegrity??'')) {
      reset(current);
      const entries=observed.entries;
      const captured={ ...base, records: [{ id: `${chatKey}:gap:${uuid()}`, chatKey, messageIndex: null, pendingFormat: PENDING_FORMAT,
        pendingType: 'observation_gap', kind: 'structural_change', nativeChatHash: deferHashes?null:stateHash(entries),
        canonicalChatHash: hashCanonicalChat(current.chat), hashVersion: 2, chatLength: current.chat.length, createdAt: now(), updatedAt: now() }] };
      if(deferHashes){captured.ready=prepareEntries(entries).then(()=>{captured.records[0].nativeChatHash=stateHash(entries);});captured.ready.catch(()=>{});}
      return captured;
    }
    const before = observed.entries;
    // Deletion must inspect surviving content too: a missed edit must not turn
    // into a fabricated pure delete. Ordinary known-index events reuse the rest.
    const scanAll = trigger.eventName === 'message_deleted' || swipeTarget === null;
    const byReference = scanAll ? new Map(before.map(entry => [entry.ref, entry])) : null;
    const after = current.chat.map((message, index) => scanAll ? snapshot(message, byReference.get(message),deferHashes)
      : index === swipeTarget || !before[index] || before[index].ref !== message ? snapshot(message, before[index],deferHashes) : before[index]);
    let start = 0;
    while (start < before.length && start < after.length && before[start].text === after[start].text) start++;
    let endBefore = before.length, endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1].text === after[endAfter - 1].text) { endBefore--; endAfter--; }
    if (start === before.length && start === after.length) { observed.entries = after; return base; }
    const operationId = uuid(), stamp = now();
    const inserted = after.slice(start, endAfter);
    const kind = !inserted.length && endBefore > start ? 'message_delete'
      : /swipe/.test(trigger.eventName) ? 'swipe_change'
      : endBefore === start && start === before.length ? 'new_message' : 'message_edit';
    const common = { chatKey,chatIntegrity:current.identity.meta?.chatIntegrity??'', messageIndex: null, pendingFormat: PENDING_FORMAT, operationId, createdAt: stamp, updatedAt: stamp };
    const parts = inserted.map((entry, partIndex) => ({ ...common, id: `${chatKey}:operation:${operationId}:part:${partIndex}`,
      pendingType: 'message_part', kind, partIndex, raw: clone(entry.raw), nativeHash: entry.hash }));
    const operation = { ...common, id: `${chatKey}:operation:${operationId}`, pendingType: 'operation', kind,
      streamId: observed.streamId, sequence: observed.sequence + 1, deleteStartIndex: start, deleteCount: endBefore - start,
      deletedHashes: [],
      beforeLength: before.length, afterLength: after.length, beforeNativeHash: null, afterNativeHash: null,
      insertIds: parts.map(part => part.id), hashVersion: 2, chatLength: after.length };
    const finalize=()=>{
      operation.deletedHashes=before.slice(start,endBefore).map(entry=>entry.hash);
      operation.beforeNativeHash=stateHash(before);operation.afterNativeHash=stateHash(after);
      parts.forEach((part,index)=>{part.nativeHash=inserted[index].hash;cacheNativeHash(part.raw,inserted[index].text,part.nativeHash);});
      operation.insertHashes=parts.map(part=>part.nativeHash);
    };
    observed = { ...observed, entries: after, sequence: operation.sequence };
    const captured={ ...base, records: [...parts, operation] };
    if(deferHashes){captured.ready=Promise.all([prepareEntries(before),prepareEntries(after)]).then(finalize);captured.ready.catch(()=>{});}
    else finalize();
    return captured;
  }
  return { reset, capture };
}

export function eventMessageIndex(trigger, length) {
  for (const value of trigger.args ?? []) {
    const index = value && typeof value === 'object' ? value.messageId : value;
    if ((typeof index === 'number' || typeof index === 'string' && index.trim()) && Number.isSafeInteger(Number(index)) && Number(index) >= 0 && Number(index) < length) return Number(index);
  }
  return trigger.eventName?.startsWith('generation_') && length ? length - 1 : null;
}

export function journalOperations(records, chatKey, {allowMissingParts=false}={}) {
  const rows = new Map(records.filter(row => row?.chatKey === chatKey).map(row => [row.id, row]));
  const operations = [];
  for (const row of rows.values()) {
    if (!isJournalRecord(row) || row.pendingType !== 'operation') continue;
    if (!validHash(row.beforeNativeHash) || !validHash(row.afterNativeHash)
      || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || typeof row.streamId !== 'string'
      || !Number.isSafeInteger(row.beforeLength) || row.beforeLength < 0 || !Number.isSafeInteger(row.afterLength) || row.afterLength < 0
      || !Number.isSafeInteger(row.deleteStartIndex) || !Number.isSafeInteger(row.deleteCount) || row.deleteStartIndex < 0 || row.deleteCount < 0
      || row.deleteStartIndex + row.deleteCount > row.beforeLength || !Array.isArray(row.insertIds)
      || !Array.isArray(row.deletedHashes) || row.deletedHashes.length !== row.deleteCount || !row.deletedHashes.every(validHash)
      || !Array.isArray(row.insertHashes)||row.insertHashes.length!==row.insertIds.length||!row.insertHashes.every(validHash)) return { ok: false, reason: '未保存变更的删除范围或校验信息不完整，原数据已保留。' };
    const parts = row.insertIds.map((id,index) => rows.get(id)??(allowMissingParts?{id,chatKey,pendingType:'message_part',operationId:row.operationId,partIndex:index,nativeHash:row.insertHashes[index],missing:true}:undefined));
    if (new Set(row.insertIds).size !== parts.length || parts.some((part, index) => !part || part.pendingType !== 'message_part'
      || part.operationId !== row.operationId || part.partIndex !== index || part.nativeHash!==row.insertHashes[index]
      || (!part.missing&&(!part.raw||nativeMessageHash(part.raw) !== part.nativeHash)))
      || row.beforeLength - row.deleteCount + parts.length !== row.afterLength) return { ok: false, reason: '未保存变更的消息副本尚未完整，原数据已保留。' };
    operations.push({ row, parts });
  }
  const used = new Set(operations.flatMap(operation => operation.row.insertIds));
  if ([...rows.values()].some(row => isJournalRecord(row) && row.pendingType === 'message_part' && !used.has(row.id))) return { ok: false, reason: '未保存变更缺少对应的操作记录，原数据已保留。' };
  return { ok: true, operations, rows };
}

function predecessors(operation, operations) {
  const earlier = operations.filter(item => item.row.streamId === operation.row.streamId && item.row.sequence === operation.row.sequence - 1);
  if (earlier.length) return earlier.filter(item => item.row.afterNativeHash === operation.row.beforeNativeHash && item.row.afterLength === operation.row.beforeLength);
  return operations.filter(item => item !== operation && item.row.afterNativeHash === operation.row.beforeNativeHash && item.row.afterLength === operation.row.beforeLength
    && item.row.streamId !== operation.row.streamId);
}
function ancestors(operation, operations, found = new Set()) {
  const work = [operation];
  while(work.length) { const item=work.pop(); if(found.has(item.row.id))continue; found.add(item.row.id); work.push(...predecessors(item,operations)); }
  return found;
}
function supersededRows(operation, rows) {
  if (operation.row.kind !== 'restore' || !Array.isArray(operation.row.supersedes)) return [];
  return operation.row.supersedes.filter(item => rows.has(item.id) && pendingRecordFingerprint(rows.get(item.id)) === item.fingerprint).map(item => item.id);
}

export function recoverPendingJournal({ chat, chatKey, records }) {
  const inspected = journalOperations(records, chatKey);
  if (!inspected.ok) {
    const saved=confirmedJournalRecords(records,chatKey,chat),covered=new Set(saved.ids);
    if(saved.hash&&records.filter(isJournalRecord).every(row=>covered.has(row.id)))return {ok:true,targetChat:cloneNativeChat(chat),targetHash:saved.hash,coveredIds:saved.ids};
    return inspected;
  }
  const { operations, rows } = inspected;
  if (!operations.length) return { ok: false, reason: '缺少可重放的改动记录，原数据已保留。' };
  const base = chat.slice(), hashes = base.map(nativeMessageHash), hash = nativeStateHash(hashes);
  const seeds = [{ chat: base, hashes, hash, covered: new Set() }];
  for (const operation of operations) if (operation.row.afterNativeHash === hash && operation.row.afterLength === base.length) {
    const covered = ancestors(operation, operations);
    for (const id of supersededRows(operation, rows)) covered.add(id);
    seeds.push({ chat: base, hashes, hash, covered });
  }
  const work = seeds, complete = new Map(), visited = new Set();
  let branches = 0;
  while (work.length) {
    const state = work.pop();
    const token = state.hash + ':' + [...state.covered].sort().join('|');
    if (visited.has(token)) continue; visited.add(token);
    if (operations.every(operation => state.covered.has(operation.row.id))) {
      const prior = complete.get(state.hash);
      if (!prior || prior.covered.size < state.covered.size) complete.set(state.hash, state);
      continue;
    }
    const next = operations.filter(operation => !state.covered.has(operation.row.id) && operation.row.beforeNativeHash === state.hash && operation.row.beforeLength === state.chat.length);
    if (next.length > 1 && (branches += next.length - 1) > 64) return { ok: false, reason: '未保存变更存在多条无法区分的操作顺序，原数据已保留。' };
    for (const operation of next) {
      const target = state.chat.slice(), targetHashes = state.hashes.slice(), row = operation.row;
      target.splice(row.deleteStartIndex, row.deleteCount, ...operation.parts.map(part => part.raw));
      targetHashes.splice(row.deleteStartIndex, row.deleteCount, ...operation.parts.map(part => part.nativeHash));
      const targetHash = nativeStateHash(targetHashes);
      if (target.length !== row.afterLength || targetHash !== row.afterNativeHash) continue;
      const covered = new Set(state.covered); covered.add(row.id);
      for (const id of supersededRows(operation, rows)) covered.add(id);
      work.push({ chat: target, hashes: targetHashes, hash: targetHash, covered });
    }
  }
  if (complete.size !== 1) return { ok: false, reason: complete.size ? '无法唯一确认恢复后的聊天，原数据已保留。' : '当前聊天不能与这些改动安全接续，原数据已保留。' };
  const result = [...complete.values()][0];
  return { ok: true, targetChat: cloneNativeChat(result.chat,result.hashes), targetHash: result.hash,
    coveredIds: [...new Set([...result.covered, ...operations.filter(operation => result.covered.has(operation.row.id)).flatMap(operation => operation.row.insertIds)])] };
}

// A saved final state also proves its connected predecessors. No comparison
// against the current page is allowed to substitute for this target proof.
export function confirmedJournalRecords(records, chatKey, backendChat,{snapshotIds=new Set()}={}) {
  const inspected = journalOperations(records, chatKey,{allowMissingParts:true});
  if (!inspected.ok) return { ids: [], hash: null };
  const hashes = backendChat.map(nativeMessageHash), hash = nativeStateHash(hashes), ids = new Set(), proofs = new Map();
  const work = inspected.operations.filter(operation => operation.row.afterNativeHash === hash && operation.row.afterLength === backendChat.length)
    .map(operation => ({ operation, hashes, positions: hashes.map((_, index) => index) }));
  const visited = new Set();
  while(work.length) {
    const {operation,hashes:after,positions}=work.pop(),row=operation.row;
    if(row.snapshotSaveProof&&!snapshotIds.has(row.id))continue;
    if(visited.has(row.id))continue;
    if(nativeStateHash(after)!==row.afterNativeHash || operation.parts.some((part,index)=>after[row.deleteStartIndex+index]!==part.nativeHash))continue;
    const before=after.slice(),beforePositions=positions.slice();
    before.splice(row.deleteStartIndex,operation.parts.length,...row.deletedHashes);
    beforePositions.splice(row.deleteStartIndex,operation.parts.length,...row.deletedHashes.map(()=>null));
    if(nativeStateHash(before)!==row.beforeNativeHash)continue;
    visited.add(row.id); ids.add(row.id);
    const historical=[];
    for(let i=0;i<operation.parts.length;i++) {
      const part=operation.parts[i],index=positions[row.deleteStartIndex+i];
      const copies=index===null?[]:[{messageIndex:index,nativeHash:part.nativeHash}];
      proofs.set(part.id,{historical:copies,via:row.id});ids.add(part.id);historical.push(...copies);
    }
    proofs.set(row.id,{historical,via:row.id});
    for(const id of supersededRows(operation,inspected.rows)){ids.add(id);proofs.set(id,{historical:[],via:row.id,superseded:true});}
    for(const legacy of records) if(!isJournalRecord(legacy)&&Number.isInteger(legacy.messageIndex)&&legacy.message?.raw
      && legacy.updatedAt && legacy.updatedAt<row.createdAt && before[legacy.messageIndex]===nativeMessageHash(legacy.message.raw)) {
      const index=beforePositions[legacy.messageIndex];
      ids.add(legacy.id);proofs.set(legacy.id,{historical:index===null?[]:[{messageIndex:index,nativeHash:before[legacy.messageIndex]}],via:row.id,superseded:true});
    }
    for(const previous of predecessors(operation,inspected.operations)) work.push({operation:previous,hashes:before,positions:beforePositions});
  }
  return { ids: [...ids], hash, proofs };
}

export function createRestoreJournal({chat,targetChat,chatKey,chatIntegrity='',pending,coveredIds=pending.map(row=>row.id)}) {
  const current={ok:true,chat,identity:{chatKey,meta:{chatIntegrity}}};
  const observer=createPendingObserver({readCurrent:()=>current});observer.reset();
  current.chat=targetChat;
  let records=observer.capture({eventName:'message_updated',args:[]}).records;
  if(!records.length) {
    const operationId=newOperationId(),stamp=new Date().toISOString(),hash=nativeStateHash(chat.map(nativeMessageHash));
    records=[{id:`${chatKey}:operation:${operationId}`,chatKey,messageIndex:null,pendingFormat:PENDING_FORMAT,pendingType:'operation',operationId,
      streamId:operationId,sequence:1,deleteStartIndex:0,deleteCount:0,deletedHashes:[],insertIds:[],insertHashes:[],beforeLength:chat.length,afterLength:chat.length,
      beforeNativeHash:hash,afterNativeHash:hash,chatLength:chat.length,createdAt:stamp,updatedAt:stamp,hashVersion:2}];
  }
  const covered=new Set(coveredIds);
  return records.map(row=>({...row,kind:'restore',...(row.pendingType==='operation'?{supersedes:pending.filter(record=>covered.has(record.id)).map(record=>({id:record.id,fingerprint:pendingRecordFingerprint(record)}))}:{})}));
}
