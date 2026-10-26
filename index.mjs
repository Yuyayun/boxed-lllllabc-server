import { loadHost } from './src/host.js';
import { installRoutes } from './src/router.js';
import { failure } from './src/errors.js';

export const info = { id: 'boxed-lllllabc', name: '箱装辣白菜 SQLite', description: '可选的单用户 SQLite 备份存储，不自动切换或迁移。' };
let service;
export async function init(router) {
  let host;
  let hostError;
  try { host = await loadHost(); }
  catch (error) { console.error('[boxed-lllllabc-server] Host integration unavailable:', error.message); hostError = failure('identity-unavailable', '当前酒馆接口无法可靠核实身份，SQLite 已禁用。', 403); }
  service = installRoutes(router, { host, hostError });
}
export async function exit() { await service?.close(); }
