import test from 'node:test';
import { SqliteRepository } from '../src/sqlite.js';
import { backupVersionCases } from './contracts/backup-version-contract.js';
import * as batches from '../vendor/frontend/src/storage/backup-batches.js';
import { createBatchCleanupPlan } from '../vendor/frontend/src/backup/batch-cleanup.js';

for (const { name, run } of backupVersionCases({ ...batches, createBatchCleanupPlan })) {
  test(name, async () => {
    const repo = new SqliteRepository(':memory:');
    const session = { capabilities: { boundedBackup: 1 }, testMode: 'sqlite' };
    let queue = Promise.resolve();
    for (const name of [...Object.keys(repo.operations), ...Object.keys(repo.largeBackupOperations)]) {
      session[name] = (...args) => {
        const operation = queue.then(() => repo.execute(name, args));
        queue = operation.catch(() => {});
        return operation;
      };
    }
    try { await run(session); } finally { repo.close(); }
  });
}
