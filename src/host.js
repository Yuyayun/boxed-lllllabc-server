import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { failure } from './errors.js';

export async function loadHost() {
  const root = process.cwd();
  const users = await import(pathToFileURL(path.join(root, 'src/users.js')));
  const { getConfigValue } = await import(pathToFileURL(path.join(root, 'src/util.js')));
  const { DEFAULT_USER } = await import(pathToFileURL(path.join(root, 'src/constants.js')));
  if (typeof users.getAllEnabledUsers !== 'function' || typeof getConfigValue !== 'function' || !globalThis.DATA_ROOT) throw failure('identity-unavailable', '当前酒馆版本不提供可靠的账户接口，SQLite 已禁用。');
  return {
    root, dataRoot: path.resolve(globalThis.DATA_ROOT), defaultHandle: DEFAULT_USER.handle,
    config: getConfigValue,
    users: users.getAllEnabledUsers,
    csrfEnabled: () => globalThis.COMMAND_LINE_ARGS?.disableCsrf === false && !getConfigValue('disableCsrfProtection', false),
  };
}

export async function authorize(host, request) {
  if (!host.csrfEnabled()) throw failure('security-unavailable', '酒馆 CSRF 保护未启用，SQLite 服务已拒绝操作。', 403);
  const origin = request.get('origin');
  if ((origin && origin !== `${request.protocol}://${request.get('host')}`) || request.get('sec-fetch-site') === 'cross-site') throw failure('forbidden', 'SQLite 请求必须来自当前酒馆同源页面。', 403);
  const enabled = await host.users();
  if (!Array.isArray(enabled)) throw failure('identity-unavailable', '无法核实启用账户，SQLite 已拒绝操作。', 403);
  if (enabled.length > 1) throw failure('multi-user', '仅支持默认用户或单个启用账户；当前 SQLite 不可用。', 403);
  const handle = request.user?.profile?.handle;
  if (host.config('enableUserAccounts', false)) {
    if (enabled.length !== 1 || !enabled[0]?.enabled || enabled[0].handle !== handle || request.session?.handle !== handle || !request.user?.profile?.enabled) throw failure('identity-unavailable', '当前登录身份与唯一启用账户不符。', 403);
  } else if (enabled.length !== 0 || handle !== host.defaultHandle || !request.user?.profile?.enabled) {
    throw failure('identity-unavailable', '无法核实默认用户身份。', 403);
  }
  return handle;
}

const inside = (candidate, root) => candidate === root || (!path.relative(root, candidate).startsWith('..' + path.sep) && !path.isAbsolute(path.relative(root, candidate)) && path.relative(root, candidate) !== '..');
function canonical(candidate) {
  const rest = [];
  while (!fs.existsSync(candidate)) { rest.unshift(path.basename(candidate)); const parent = path.dirname(candidate); if (parent === candidate) break; candidate = parent; }
  return path.resolve(fs.realpathSync(candidate), ...rest);
}
export function databasePath(host) {
  const configured = host.config('boxedLllllabc.databaseDirectory', path.resolve(host.dataRoot, '..', 'boxed-lllllabc-storage'));
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw failure('database-unavailable', 'SQLite 目录必须由服务器配置为独立绝对路径。');
  const directory = canonical(configured);
  for (const forbidden of [host.dataRoot, path.join(host.root, 'public'), path.join(host.root, 'plugins'), path.join(host.root, 'node_modules')]) {
    if (inside(directory, canonical(forbidden))) throw failure('database-unavailable', 'SQLite 数据目录不能位于聊天、扩展或插件目录内。');
  }
  if (directory === path.parse(directory).root || directory === canonical(host.root)) throw failure('database-unavailable', '请为 SQLite 配置专用目录。');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'boxed-lllllabc.sqlite');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw failure('database-unavailable', 'SQLite 文件不能为链接。');
  return file;
}
