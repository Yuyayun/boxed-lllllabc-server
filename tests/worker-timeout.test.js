import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteWorker } from '../src/worker-client.js';

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
