import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, win32 } from 'node:path';
import { TaskReasonError } from '../shared/task-reasons';
import type { AiModelDiscovery, AiModelOption, Settings } from '../shared/types';

export interface ClaudeLaunch { command: string; prefixArgs: string[] }
export interface ClaudeResolveOptions { platform?: NodeJS.Platform; pathEnv?: string; home?: string; exists?: (path: string) => boolean }

/** Where the official installers put the CLI when a desktop app does not inherit the shell's PATH. */
function knownLocations(platform: NodeJS.Platform, home: string): string[] {
  return platform === 'win32'
    ? [join(home, '.local', 'bin', 'claude.exe'), join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd')]
    : [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

/** Find the official Claude Code CLI without a shell: an absolute path, a PATH entry, or the installers' default places. */
export function resolveClaudeLaunch(configuredPath: string, options: ClaudeResolveOptions = {}): ClaudeLaunch {
  const platform = options.platform ?? process.platform, exists = options.exists ?? existsSync, home = options.home ?? homedir();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const requested = configuredPath.trim() || 'claude';
  const direct = isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const names = platform === 'win32' && !extname(requested) ? [`${requested}.exe`, `${requested}.cmd`] : [requested];
  let located: string | undefined;
  for (const name of names) {
    if (direct) { const path = resolve(name); if (exists(path)) { located = path; break } continue; }
    for (const part of pathEnv.split(platform === 'win32' ? ';' : ':')) {
      const directory = part.trim().replace(/^"|"$/g, ''); if (!directory) continue;
      const candidate = join(directory, name); if (exists(candidate)) { located = candidate; break; }
    }
    if (located) break;
  }
  if (!located && !direct && requested === 'claude') located = knownLocations(platform, home).find(exists);
  if (!located) throw new TaskReasonError('temporary_failure', '未找到本机 Claude 命令行；请安装 Claude Code 并登录，或在设置里填写 claude 的路径');
  if (platform !== 'win32' || extname(located).toLowerCase() === '.exe') return { command: located, prefixArgs: [] };
  // npm's claude.cmd is a shim for the package's cli.js; run that script with Node directly, never through a shell.
  if (extname(located).toLowerCase() !== '.cmd') throw new TaskReasonError('temporary_failure', 'Windows 上的 Claude 路径必须指向 claude.exe 或官方 npm 安装的 claude.cmd');
  const script = join(dirname(located), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  if (!exists(script)) throw new TaskReasonError('temporary_failure', '找不到 Claude Code 的 npm 入口；请重新安装 Claude Code');
  const sibling = join(dirname(located), 'node.exe');
  // Empty PATH segments would name a relative node.exe in the working directory; only real directories count.
  const node = exists(sibling) ? sibling : pathEnv.split(';').map(part => part.trim().replace(/^"|"$/g, '')).filter(part => part && win32.isAbsolute(part)).map(part => join(part, 'node.exe')).find(exists);
  if (!node) throw new TaskReasonError('temporary_failure', '未找到运行 Claude Code 所需的 Node.js');
  return { command: node, prefixArgs: [script] };
}

/** Variables that say how the CLI signs in: a relay service, an API key or a cloud provider. */
const LOGIN_VARIABLE = /^(?:ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX)|API_TIMEOUT_MS)$/;
/** The sign-in variables from the user's own Claude settings: calls skip that file (its hooks would join every prompt). */
function settingsLoginVariables(base: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const file = join(base.CLAUDE_CONFIG_DIR || join(base.HOME || base.USERPROFILE || homedir(), '.claude'), 'settings.json');
    const env = (JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> }).env ?? {};
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => LOGIN_VARIABLE.test(entry[0]) && typeof entry[1] === 'string'));
  } catch { return {}; }
}
/** Pass the login profile through, drop everything else (including a parent Claude Code session's own variables). */
export function claudeEnvironment(base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, settingsVariables: (base: NodeJS.ProcessEnv) => Record<string, string> = settingsLoginVariables): NodeJS.ProcessEnv {
  const keys = ['PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(keys.flatMap(key => base[key] ? [[key, base[key]!]] : []));
  // Inside a running Claude Code session these belong to that session, not to the user's own sign-in.
  if (!base.CLAUDECODE) for (const [key, value] of Object.entries(base)) if (LOGIN_VARIABLE.test(key) && value) env[key] = value;
  Object.assign(env, settingsVariables(base));
  env.PATH = platform === 'win32' ? (base.PATH || base.Path || '') : [join(base.HOME ?? homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', base.PATH || '/usr/bin:/bin'].join(':');
  return env;
}

const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_OUTPUT = 2_000_000;

/** Arguments for one structured answer: print mode, no tools, no MCP, no settings or skills, nothing saved. */
export function claudeArgs(settings: Pick<Settings, 'model' | 'reasoningEffort'>, schema: Record<string, unknown>): string[] {
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'];
  if (settings.model.trim()) args.push('--model', settings.model.trim());
  if (settings.reasoningEffort && CLAUDE_EFFORTS.has(settings.reasoningEffort)) args.push('--effort', settings.reasoningEffort);
  return args;
}

/** Read the CLI's JSON result: the validated structured output, or JSON text in the result as a fallback. */
export function parseClaudeResult<T>(stdout: string, parseText: (text: string) => T): T {
  let envelope: { type?: string; subtype?: string; is_error?: boolean; result?: unknown; structured_output?: unknown };
  try { envelope = JSON.parse(stdout.trim()) as typeof envelope; } catch { throw new TaskReasonError('format_invalid', '本机 Claude 没有返回可读的结果'); }
  if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success')) {
    const reason = typeof envelope.result === 'string' ? envelope.result.slice(0, 200) : envelope.subtype ?? '未知原因';
    const limited = /rate.?limit|usage limit|limit reached|too many requests|overloaded|额度|限额/i.test(reason);
    throw new TaskReasonError(limited ? 'ai_rate_limited' : 'temporary_failure', `本机 Claude 这次没有完成：${reason}`);
  }
  if (envelope.structured_output && typeof envelope.structured_output === 'object' && !Array.isArray(envelope.structured_output)) return envelope.structured_output as T;
  if (typeof envelope.result === 'string') return parseText(envelope.result);
  throw new TaskReasonError('format_invalid', '本机 Claude 没有返回结构化结果');
}

/** One structured AI answer from the local Claude Code CLI, the same way the Codex provider works. */
export async function claudeJson<T>(settings: Settings, prompt: string, schema: Record<string, unknown>, signal: AbortSignal, parseText: (text: string) => T): Promise<T> {
  // One fixed, empty working directory: the CLI keeps a record per directory, so a new one per call would pile up.
  const directory = join(tmpdir(), 'local-ai-claude');await mkdir(directory, { recursive: true });
  // The schema is also stated in the prompt, so an answer still parses if the CLI returns it as text.
  const input = `${prompt}\n\n只输出一个符合下面 JSON Schema 的 JSON 对象，不要输出其他文字：\n${JSON.stringify(schema)}`;
  return await new Promise<T>((resolvePromise, reject) => {
    let output = '', errorText = '', settled = false;
    const launch = resolveClaudeLaunch(settings.claudePath ?? 'claude');
    const child = spawn(launch.command, [...launch.prefixArgs, ...claudeArgs(settings, schema)], { cwd: directory, env: claudeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const finish = (error?: Error, value?: T) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); error ? reject(error) : resolvePromise(value!); };
    const abort = () => { child.kill('SIGKILL'); finish(new TaskReasonError('temporary_failure', 'AI 请求已取消或超时')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > MAX_OUTPUT) abort(); });
    child.stderr.on('data', (chunk: Buffer) => { errorText += chunk.toString('utf8'); if (errorText.length > MAX_OUTPUT) abort(); });
    child.on('error', error => finish(new TaskReasonError('temporary_failure', '无法启动本机 Claude', { cause: error })));
    child.on('close', code => {
      if (settled) return;
      // A failed run still prints its JSON envelope with the reason; use it before the exit code.
      if (output.trim()) { try { return finish(undefined, parseClaudeResult(output, parseText)); } catch (error) { if (code === 0) return finish(error as Error); if (error instanceof TaskReasonError && error.reasonCode !== 'format_invalid') return finish(error); } }
      finish(new TaskReasonError('temporary_failure', /not logged in|please run \/login|invalid api key|authentication_error|oauth token has expired/i.test(errorText) ? '本机 Claude 还没登录；请在终端运行 claude 完成登录' : `本机 Claude 失败（退出码 ${code}）；请检查所选模型和思考等级`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Read only the login state; no inference call. */
export async function claudeLoggedIn(settings: Pick<Settings, 'claudePath'>, timeoutMs = 10_000): Promise<boolean> {
  let launch: ClaudeLaunch; try { launch = resolveClaudeLaunch(settings.claudePath ?? 'claude'); } catch { return false; }
  return new Promise(resolvePromise => {
    let output = '';
    const child = spawn(launch.command, [...launch.prefixArgs, 'auth', 'status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], shell: false, env: claudeEnvironment(), windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolvePromise(false); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8').slice(0, 20_000); });
    child.on('error', () => { clearTimeout(timer); resolvePromise(false); });
    // A clean exit is signed in unless the answer says otherwise; older or newer versions may word it differently.
    child.on('close', code => { clearTimeout(timer); if (code !== 0) return resolvePromise(false); try { resolvePromise((JSON.parse(output) as { loggedIn?: unknown }).loggedIn !== false); } catch { resolvePromise(true); } });
  });
}

/** The CLI takes model aliases; the empty choice keeps the account's own default. */
export const CLAUDE_MODEL_OPTIONS: AiModelOption[] = [
  { id: 'opus', label: 'Claude Opus（最强）', source: 'claude', supportsReasoning: [...CLAUDE_EFFORTS] },
  { id: 'sonnet', label: 'Claude Sonnet（均衡）', source: 'claude', supportsReasoning: [...CLAUDE_EFFORTS] },
  { id: 'haiku', label: 'Claude Haiku（最快）', source: 'claude' },
];

export async function discoverClaudeModels(settings: Settings): Promise<AiModelDiscovery> {
  const discoveredAt = new Date().toISOString(), loggedIn = await claudeLoggedIn(settings);
  return { provider: 'claude', models: CLAUDE_MODEL_OPTIONS, effectiveModel: settings.model || undefined, source: loggedIn ? 'local-cli' : 'unavailable', discoveredAt,
    message: loggedIn ? '已找到本机 Claude，可直接选择模型；不选则用账号默认模型。' : '没有找到已登录的本机 Claude；请先安装 Claude Code 并在终端运行 claude 登录。' };
}
