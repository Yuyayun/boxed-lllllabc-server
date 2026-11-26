// Preserve the original error object while recording its native IDB origin.
// Business validation in a transaction callback is deliberately not marked.
const nativeErrors = new WeakSet(), boundaries = new WeakMap();
const businessCodes = new Set(['backup-version-changed', 'backup-conflict', 'backup-source-changed', 'backup-limit', 'cancelled', 'backup-client-upgrade-required']);
export function markIndexedDbError(error) {
  if (!error || typeof error !== 'object') error = new Error(String(error));
  nativeErrors.add(error); return error;
}
export function isIndexedDbFailure(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error) || businessCodes.has(error.code)) return false;
  seen.add(error);
  return nativeErrors.has(error) || ['backup-local-paused', 'backup-control-unavailable', 'backup-database-blocked', 'backup-database-timeout', 'backup-connection-closed', 'backup-operation-timeout', 'outcome-unknown'].includes(error.code)
    || isIndexedDbFailure(error.cause, seen);
}
export function idbBoundary(target) {
  if (boundaries.has(target)) return boundaries.get(target);
  const proxy = new Proxy(target, { get(object, key) {
    let value;
    try { value = Reflect.get(object, key, object); } catch (error) { throw markIndexedDbError(error); }
    if (typeof value !== 'function') return value;
    return (...args) => {
      let result;
      try { result = value.apply(object, args); } catch (error) { throw markIndexedDbError(error); }
      return key === 'objectStore' || key === 'index' ? idbBoundary(result) : result;
    };
  } });
  boundaries.set(target, proxy); return proxy;
}
