import { buildBackupCatalog, summarizeBackupCatalog } from "../backup/catalog.js";
import { inspectBackupCatalogData } from "./health.js";
import { STORES } from "../db/schema.js";

export const CATALOG_STORES = [STORES.chatMeta, STORES.recentMessages, STORES.pendingChanges, STORES.fullMessages, STORES.historicalChanges];
const fields = ["chatMeta", "recentMessages", "pendingChanges", "fullMessages", "historicalChanges"];

// Keep a consistent transaction, but retain raw message bodies for one chat only.
// Only compact summaries cross the server boundary; no truncated raw dataset.
export async function readCatalogByChat(stores, driver, requestToPromise) {
  const keys = new Set(), seen = CATALOG_STORES.map(() => 0);
  for (const name of CATALOG_STORES) for (const key of await driver.keys(stores.get(name))) keys.add(key);
  const chats = []; let invalid = 0;
  for (const key of keys) {
    driver.check?.();
    const rows = await Promise.all(CATALOG_STORES.map(async (name, index) => {
      const store = stores.get(name);
      if (index === 0) { const meta = await requestToPromise(store.get(key)); return meta === undefined ? [] : [meta]; }
      return requestToPromise(store.index("by_chat").getAll(key));
    }));
    rows.forEach((records, index) => { seen[index] += records.length; });
    const data = Object.fromEntries(fields.map((field, index) => [field, rows[index]]));
    const catalog = buildBackupCatalog(inspectBackupCatalogData(data));
    chats.push(...catalog.chats); invalid += catalog.invalidRecordCount;
  }
  // Records lacking an indexable chat identity must block cleanup, not disappear.
  for (let index = 0; index < CATALOG_STORES.length; index++) invalid += Math.max(0, await driver.count(stores.get(CATALOG_STORES[index])) - seen[index]);
  if (new Set(chats.map(chat => chat.chatKey)).size !== chats.length) throw new Error("备份目录出现重复归属，请检查数据后重试。");
  return summarizeBackupCatalog(chats, invalid);
}

export async function readBackupCatalog(session, buildCatalog = buildBackupCatalog) {
  return session.getBackupCatalog ? session.getBackupCatalog() : buildCatalog(await session.getBackupCatalogData());
}
