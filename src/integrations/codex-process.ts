import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

export interface CodexLaunch { command: string; prefixArgs: string[]; envAdditions: Record<string, string> }
export interface CodexResolveOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  pathEnv?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
}

function packageEntry(script: string, exists: (path: string) => boolean, readText: (path: string) => string): string {
  if (basename(script).toLowerCase() !== 'codex.js' || basename(dirname(script)).toLowerCase() !== 'bin') throw new Error('Codex 入口不是已知 npm 包结构');
  const root = dirname(dirname(script));
  const manifest = join(root, 'package.json');
  if (!exists(script) || !exists(manifest)) throw new Error('Codex npm 包入口不存在');
  let packageInfo: { name?: string; bin?: Record<string, string> };
  try { packageInfo = JSON.parse(readText(manifest)); } catch { throw new Error('Codex npm 包清单不可读取'); }
  if (packageInfo.name !== '@openai/codex' || packageInfo.bin?.codex !== 'bin/codex.js') throw new Error('Codex npm 包清单不匹配');
  return root;
}

function nativeWindowsBinary(packageRoot: string, arch: string, exists: (path: string) => boolean): string | undefined {
  const target = arch === 'arm64' ? ['aarch64-pc-windows-msvc', 'codex-win32-arm64'] : arch === 'x64' ? ['x86_64-pc-windows-msvc', 'codex-win32-x64'] : undefined;
  if (!target) return undefined;
  const [triple, packageName] = target;
  const nodeModules = dirname(dirname(packageRoot));
  const candidates = [
    join(packageRoot, 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe'),
    join(nodeModules, '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe'),
    join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
  ];
  return candidates.find(exists);
}

function findOnPath(name: string, pathEnv: string, exists: (path: string) => boolean, platform: NodeJS.Platform): string | undefined {
  for (const part of pathEnv.split(platform === 'win32' ? ';' : ':')) {
    const directory = part.trim().replace(/^"|"$/g, '');
    if (directory) {
      const candidate = join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Resolve npm's Windows .cmd shim to an executable without invoking a shell. */
export function resolveCodexLaunch(configuredPath: string, options: CodexResolveOptions = {}): CodexLaunch {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const requested = configuredPath.trim() || 'codex';
  if (platform !== 'win32') return { command: requested, prefixArgs: [], envAdditions: {} };

  const direct = isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const suffix = extname(requested).toLowerCase();
  const candidates = suffix ? [requested] : [`${requested}.exe`, `${requested}.cmd`, `${requested}.js`];
  let located: string | undefined;
  for (const candidate of candidates) {
    const location = direct ? resolve(candidate) : findOnPath(candidate, pathEnv, exists, platform);
    if (location && exists(location)) { located = location; break; }
  }
  if (!located) throw new Error('未找到 Codex CLI；请安装官方 Codex CLI 或填写 codex.exe 路径');
  const extension = extname(located).toLowerCase();
  if (extension === '.exe') return { command: located, prefixArgs: [], envAdditions: {} };
  if (extension !== '.cmd' && extension !== '.js') throw new Error('Windows Codex 路径必须指向 exe 或官方 npm 入口');
  const script = extension === '.cmd' ? join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : located;
  const packageRoot = packageEntry(script, exists, readText);
  const native = nativeWindowsBinary(packageRoot, arch, exists);
  if (native) return { command: native, prefixArgs: [], envAdditions: {} };
  const siblingNode = join(dirname(located), 'node.exe');
  const node = (exists(siblingNode) ? siblingNode : undefined) ?? findOnPath('node.exe', pathEnv, exists, platform) ?? (basename(execPath).toLowerCase() === 'node.exe' ? execPath : undefined);
  if (node) return { command: node, prefixArgs: [script], envAdditions: {} };
  if (!execPath.toLowerCase().endsWith('.exe')) throw new Error('未找到可执行 Codex npm 入口的 Node 程序');
  return { command: execPath, prefixArgs: [script], envAdditions: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Keep auth profile paths while avoiding unrelated environment secrets and hooks. */
export function codexEnvironment(base: NodeJS.ProcessEnv = process.env, additions: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const keys = ['PATH', 'PATHEXT', 'HOME', 'USER', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'CODEX_HOME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(keys.flatMap(key => base[key] ? [[key, base[key]!]] : []));
  if (platform === 'win32') env.PATH = base.PATH || base.Path || '';
  else env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', base.PATH || '/usr/bin:/bin'].join(':');
  return { ...env, ...additions };
}
