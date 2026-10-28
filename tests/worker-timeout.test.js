import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteWorker } from '../src/worker-client.js';
import { setTimeout as delay } from 'node:timers/promises';

test('工作线程等待写锁时主线程仍可运行，超时不报告成功且重开无损', async () => {
  const base = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, 'boxed-timeout-test-'));
  const file = path.join(directory, 'database.sqlite');
  const worker = new SqliteWorker(file);
  let lock;
  try {
    await worker.call('putChatMeta', [{ chatKey: 'retained' }], 'default-user');
    lock = new DatabaseSync(file); lock.exec('BEGIN IMMEDIATE');
    worker.timeoutMs = 100;
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 10);
    await assert.rejects(worker.call('putChatMeta', [{ chatKey: 'unknown-result' }], 'default-user'), /超时/);
    clearTimeout(timer); assert.equal(ticked, true);
    lock.exec('ROLLBACK'); lock.close(); lock = null;
    await worker.close();
    const reopened = new SqliteWorker(file);
    try { assert.deepEqual(await reopened.call('getChatMeta', ['retained'], 'default-user'), { chatKey: 'retained' }); }
    finally { await reopened.close(); }
  } finally {
    if (lock) { lock.exec('ROLLBACK'); lock.close(); }
    await worker.close();
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith('boxed-timeout-test-'));
    fs.rmSync(resolved, { recursive: true });
  }
});

test('分批迁移单次等待超时保留未知结果，但不杀死 SQLite 工作线程',async()=>{
  const base=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(base,'boxed-batch-timeout-')),file=path.join(directory,'db.sqlite');
  const worker=new SqliteWorker(file);let lock;
  try{
    await worker.call('putChatMeta',[{chatKey:'kept'}],'default-user');
    lock=new DatabaseSync(file);lock.exec('BEGIN IMMEDIATE');worker.timeoutMs=100;
    await assert.rejects(worker.call('_batchTransfer',['inspect',['timeout-test-123']],'default-user'),e=>e.code==='outcome-unknown');
    assert.equal(worker.closed,undefined);assert.equal(worker.pending.size,1);
    lock.exec('ROLLBACK');lock.close();lock=null;
    for(let i=0;i<50&&worker.pending.size;i++)await delay(10);
    assert.equal(worker.pending.size,0);worker.timeoutMs=15000;
    assert.deepEqual(await worker.call('getChatMeta',['kept'],'default-user'),{chatKey:'kept'});
  }finally{
    if(lock){lock.exec('ROLLBACK');lock.close();}await worker.close();const resolved=fs.realpathSync(directory);assert.equal(path.dirname(resolved),base);assert.ok(path.basename(resolved).startsWith('boxed-batch-timeout-'));fs.rmSync(resolved,{recursive:true});
  }
});
