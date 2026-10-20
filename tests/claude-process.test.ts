import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeArgs,claudeEnvironment,claudeLoggedIn,parseClaudeResult,resolveClaudeLaunch} from '../src/integrations/claude-process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAi,discoverModels} from '../src/integrations/ai';
import {TaskReasonError} from '../src/shared/task-reasons';
import type {SecretStore,Settings} from '../src/shared/types';

const emptySecrets={get:async()=>undefined,set:async()=>{},delete:async()=>{}} as SecretStore;

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const parseText=(text:string)=>JSON.parse(text) as {ok:boolean};

test('one structured answer runs in print mode with no tools, MCP servers, settings, skills or saved session',()=>{
  const args=claudeArgs({model:'',reasoningEffort:undefined},schema);
  for(const flag of ['-p','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'])assert.ok(args.includes(flag),flag);
  assert.equal(args[args.indexOf('--output-format')+1],'json');
  assert.equal(args[args.indexOf('--json-schema')+1],JSON.stringify(schema));
  assert.equal(args[args.indexOf('--tools')+1],'');
  assert.equal(args[args.indexOf('--setting-sources')+1],'');
  assert.equal(args.includes('--model'),false);assert.equal(args.includes('--effort'),false);
  const chosen=claudeArgs({model:' sonnet ',reasoningEffort:'high'},schema);
  assert.equal(chosen[chosen.indexOf('--model')+1],'sonnet');assert.equal(chosen[chosen.indexOf('--effort')+1],'high');
  // A Codex-only effort is not passed to Claude.
  assert.equal(claudeArgs({model:'',reasoningEffort:'ultra'},schema).includes('--effort'),false);
});

test('the result envelope gives the structured output, falls back to JSON text, and reports failures in plain words',()=>{
  assert.deepEqual(parseClaudeResult(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:{ok:true},result:''}),parseText),{ok:true});
  assert.deepEqual(parseClaudeResult(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{"ok":true}'}),parseText),{ok:true});
  const failure=(()=>{try{parseClaudeResult(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Credit balance is too low'}),parseText)}catch(error){return error}})();
  assert.ok(failure instanceof TaskReasonError);assert.equal(failure.reasonCode,'temporary_failure');assert.match(failure.message,/本机 Claude 这次没有完成：Credit balance is too low/);
  const limited=(()=>{try{parseClaudeResult(JSON.stringify({type:'result',is_error:true,result:'Claude usage limit reached'}),parseText)}catch(error){return error}})();
  assert.ok(limited instanceof TaskReasonError);assert.equal(limited.reasonCode,'ai_rate_limited');
  assert.throws(()=>parseClaudeResult('not json',parseText),/没有返回可读的结果/);
});

test('the CLI is found on PATH or in the installers\' default places, never through a shell',()=>{
  const files=new Set(['/home/me/.local/bin/claude']);
  assert.deepEqual(resolveClaudeLaunch('claude',{platform:'darwin',pathEnv:'/usr/bin',home:'/home/me',exists:path=>files.has(path)}),{command:'/home/me/.local/bin/claude',prefixArgs:[]});
  assert.deepEqual(resolveClaudeLaunch('claude',{platform:'darwin',pathEnv:'/opt/tools:/usr/bin',home:'/home/me',exists:path=>path==='/opt/tools/claude'}),{command:'/opt/tools/claude',prefixArgs:[]});
  assert.throws(()=>resolveClaudeLaunch('claude',{platform:'darwin',pathEnv:'/usr/bin',home:'/home/me',exists:()=>false}),/未找到本机 Claude/);
  // Windows: the native exe directly, or npm's shim through Node with the package script.
  const win=new Set(['D:\\tools\\npm\\claude.cmd','D:\\tools\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js','D:\\tools\\nodejs\\node.exe']);
  const launch=resolveClaudeLaunch('claude',{platform:'win32',pathEnv:'D:\\tools\\npm;D:\\tools\\nodejs',home:'D:\\home',exists:path=>win.has(path.replace(/\//g,'\\'))});
  assert.match(launch.command.replace(/\//g,'\\'),/node\.exe$/);assert.match(launch.prefixArgs[0].replace(/\//g,'\\'),/claude-code\\cli\.js$/);
});

test('the child environment keeps the login profile and drops a parent Claude Code session\'s variables',()=>{
  const env=claudeEnvironment({HOME:'/home/me',PATH:'/usr/bin',CLAUDE_CONFIG_DIR:'/home/me/.claude',CLAUDECODE:'1',ANTHROPIC_BASE_URL:'http://127.0.0.1:1',CLAUDE_CODE_ACCOUNT_UUID:'x',SECRET_TOKEN:'y',https_proxy:'http://proxy:1'},'darwin',()=>({}));
  assert.equal(env.CLAUDE_CONFIG_DIR,'/home/me/.claude');assert.match(env.PATH!,/\/home\/me\/\.local\/bin/);assert.equal(env.https_proxy,'http://proxy:1');
  for(const key of ['CLAUDECODE','ANTHROPIC_BASE_URL','CLAUDE_CODE_ACCOUNT_UUID','SECRET_TOKEN'])assert.equal(env[key],undefined,key);
});

test('a relay or API-key sign-in reaches the CLI from the environment or the user\'s Claude settings, without the rest of that file',()=>{
  const own=claudeEnvironment({HOME:'/home/me',PATH:'/usr/bin',ANTHROPIC_AUTH_TOKEN:'relay-token',ANTHROPIC_BASE_URL:'https://relay.example',OTHER:'z'},'darwin',()=>({}));
  assert.equal(own.ANTHROPIC_AUTH_TOKEN,'relay-token');assert.equal(own.ANTHROPIC_BASE_URL,'https://relay.example');assert.equal(own.OTHER,undefined);
  const directory=mkdtempSync(join(tmpdir(),'local-ai-claude-settings-'));
  try{
    writeFileSync(join(directory,'settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://settings-relay.example',ANTHROPIC_AUTH_TOKEN:'settings-token',UNRELATED:'no'},hooks:{SessionStart:[]}}));
    const fromSettings=claudeEnvironment({HOME:'/home/me',PATH:'/usr/bin',CLAUDE_CONFIG_DIR:directory},'darwin');
    assert.equal(fromSettings.ANTHROPIC_BASE_URL,'https://settings-relay.example');assert.equal(fromSettings.ANTHROPIC_AUTH_TOKEN,'settings-token');assert.equal(fromSettings.UNRELATED,undefined);
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('the login check trusts a clean exit unless the answer says signed out',{skip:process.platform==='win32'},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'local-ai-claude-auth-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const fake=async(name:string,body:string)=>{const file=join(directory,name);await writeFile(file,`#!${process.execPath}\n${body}\n`);await chmod(file,0o700);return file};
  assert.equal(await claudeLoggedIn({claudePath:await fake('in',`process.stdout.write(JSON.stringify({loggedIn:true}))`)}),true);
  assert.equal(await claudeLoggedIn({claudePath:await fake('plain',`process.stdout.write('Logged in as someone')`)}),true);
  assert.equal(await claudeLoggedIn({claudePath:await fake('out',`process.stdout.write(JSON.stringify({loggedIn:false}))`)}),false);
  assert.equal(await claudeLoggedIn({claudePath:await fake('fail',`process.exitCode=1`)}),false);
});

test('the AI client routes to the local Claude CLI, sends the prompt on stdin and reads the structured answer', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'local-ai-claude-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = join(directory, 'record.json'), executable = join(directory, 'fake-claude');
  await writeFile(executable, `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),input,env:Object.keys(process.env)}));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'',structured_output:{ok:true}}))})\n`);
  await chmod(executable, 0o700);
  const settings = { provider: 'claude', claudePath: executable, codexPath: 'codex', model: 'sonnet', reasoningEffort: 'high' } as Settings;
  assert.deepEqual(await createAi(settings, emptySecrets).json<{ ok: boolean }>('Return ok.', {}, schema), { ok: true });
  const seen = JSON.parse(await readFile(record, 'utf8')) as { args: string[]; input: string; env: string[] };
  assert.equal(seen.args[0], '-p'); assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'sonnet'); assert.equal(seen.args[seen.args.indexOf('--effort') + 1], 'high');
  assert.match(seen.input, /Task: Return ok\./); assert.match(seen.input, /JSON Schema/);
  assert.equal(seen.env.includes('CLAUDECODE'), false);
  assert.equal((await discoverModels({ ...settings, claudePath: join(directory, 'missing') }, emptySecrets)).source, 'unavailable');
});
