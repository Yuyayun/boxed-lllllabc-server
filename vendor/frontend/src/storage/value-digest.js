import { encodeStorageValue } from "./protocol.js";

function stable(node) {
  if (!Array.isArray(node)) return node;
  if (["object", "null-object"].includes(node[0])) {
    return [node[0], node[1].map(([key, value]) => [key, stable(value)])
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)];
  }
  return node.map(stable);
}
export function stableText(value) { return JSON.stringify(stable(encodeStorageValue(value))); }
export async function sha256(text) {
  if (!globalThis.crypto?.subtle?.digest) throw new Error("当前地址不支持浏览器内容校验，请通过 HTTPS 或 localhost 打开酒馆。");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const digestValue = (value) => sha256(stableText(value));
