import {nativeMessageHash,nativeStateHash} from './native-content.js';

// 1.0.5 could cache a user's message before native saveReply added its empty
// extra.reasoning default. Reconstruct only that exact historical view, then
// require the original whole-state SHA-256 and every operation hash as usual.
// Never drop nonempty reasoning, body, swipes, extension fields or records.
export function nativeDefaultSeeds(operations,chat,hashes) {
  const possible=new Map();
  for(let index=0;index<chat.length;index++) {
    const message=chat[index];
    if(message?.is_user!==true||!message.extra||message.extra.reasoning!=='')continue;
    const extra={...message.extra};delete extra.reasoning;
    possible.set(index,nativeMessageHash({...message,extra}));
  }
  if(!possible.size)return [];
  const payloadHashes=new Set(operations.flatMap(operation=>operation.parts.map(part=>part.nativeHash)));
  const known=new Set([...possible].filter(([,hash])=>payloadHashes.has(hash)).map(([index])=>index));
  const contextual=new Set(known);
  for(const {row,parts} of operations) {
    // Covers an already-retired user record followed by a new AI message.
    // The original whole-state hash below must still prove the exact position.
    if(row.kind==='new_message'&&row.deleteCount===0&&row.deleteStartIndex===row.beforeLength&&parts.length
      &&chat[row.deleteStartIndex]?.is_user===false&&possible.has(row.deleteStartIndex-1))contextual.add(row.deleteStartIndex-1);
  }
  const tips=new Map();
  for(const operation of operations) {
    const previous=tips.get(operation.row.streamId);
    if(!previous||operation.row.sequence>previous.row.sequence)tips.set(operation.row.streamId,operation);
  }
  // A longer saved prefix proves append-only history, not a deletion that was
  // later undone. Exact-length seeds retain the existing structural checks.
  const prefixSafe=operations.every(({row})=>row.kind!=='restore'&&row.afterLength>=row.beforeLength
    &&(row.deleteCount===0||row.afterLength===row.beforeLength));
  const seeds=[],views=[known,contextual].filter((set,index,array)=>set.size&&(!index||set.size!==array[0].size));
  for(const positions of views) {
    const projected=hashes.slice();for(const index of positions)projected[index]=possible.get(index);
    for(const operation of [...tips.values()].slice(0,64)) {
      const row=operation.row,length=row.afterLength;
      if(row.kind==='restore'||row.snapshotSaveProof||length>chat.length||length<chat.length&&!prefixSafe)continue;
      const after=projected.slice(0,length);
      if(nativeStateHash(after)===row.afterNativeHash)seeds.push({operation,hashes:after,positions:after.map((_,index)=>index)});
    }
  }
  return seeds;
}
