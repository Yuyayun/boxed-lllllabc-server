import { stableText } from './value-digest.js';

export const backupVersionKey = store => `backup-store-revision:${store}`;
export const BACKUP_EPOCH_KEY = 'backup-scope-epoch';
export function fullWriteGuard(meta = {}) {
  return stableText({ state: meta.fullBackupState ?? null, incident: meta.fullBackupIncident ?? null });
}
export const sameBackupVersion = (left, right) => stableText(left) === stableText(right);
export const isBackupVersionConflict = error => error?.code === 'backup-version-changed';
