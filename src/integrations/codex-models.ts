import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isReasoningEffort,type AiModelDiscovery,type AiModelOption,type Settings} from '../shared/types';
import {codexEnvironment,resolveCodexLaunch} from './codex-process';
const NORMAL_EXIT_GRACE_MS=400,FORCE_EXIT_GRACE_MS=1600,TREE_KILL_GRACE_MS=1600;
async function bounded(wait:Promise<void>,ms:number):Promise<boolean>{return new Promise(resolve=>{let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)},timer=setTimeout(()=>finish(false),ms);wait.then(()=>finish(true),()=>finish(false))})}
async function terminateWindowsTree(pid:number):Promise<boolean>{return new Promise(resolve=>{
 const root=process.env.SystemRoot;if(!root){resolve(false);return}const killer=spawn(join(root,'System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{stdio:'ignore',windowsHide:true,shell:false});let settled=false;
 const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(ok)};
 const timer=setTimeout(()=>{killer.kill('SIGKILL');finish(false)},TREE_KILL_GRACE_MS);
 killer.once('error',()=>finish(false));killer.once('close',code=>finish(code===0));
})}
async function terminateOwnedTree(child:ChildProcessWithoutNullStreams):Promise<boolean>{
 if(!child.pid)return child.exitCode!==null;
 if(process.platform==='win32')return terminateWindowsTree(child.pid);
 try{process.kill(-child.pid,'SIGKILL');return true}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH'}
}
async function closeOwnedProcess(child:ChildProcessWithoutNullStreams,closed:Promise<void>):Promise<void>{
 if(process.platform==='win32'){
  if(!child.pid){if(await bounded(closed,50))return;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();await bounded(closed,FORCE_EXIT_GRACE_MS);throw Error('Codex 模型发现子进程启动状态无法确认')}
  // A finished root PID must never be passed to taskkill because Windows may
  // already have reused it. If inherited stdio is still open, fail closed.
  if(child.exitCode!==null||child.signalCode!==null){if(await bounded(closed,50))return;child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();await bounded(closed,FORCE_EXIT_GRACE_MS);throw Error('Codex 模型发现子进程树状态无法确认')}
  // Terminate the owned tree while the root is still alive. Sending EOF first
  // could let a Node/npm shim exit and orphan a descendant that holds stdio.
  const treeStopped=await terminateOwnedTree(child);try{child.kill('SIGKILL')}catch{}
  const didClose=await bounded(closed,FORCE_EXIT_GRACE_MS);if(didClose&&treeStopped)return;
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();await bounded(closed,FORCE_EXIT_GRACE_MS);
  throw Error(treeStopped?'Codex 模型发现子进程未能安全关闭':'Codex 模型发现子进程树清理失败');
 }
 if(!child.stdin.destroyed)child.stdin.end();
 if(await bounded(closed,NORMAL_EXIT_GRACE_MS))return;
 const treeStopped=await terminateOwnedTree(child);
 try{child.kill('SIGKILL')}catch{}
 child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
 if(await bounded(closed,FORCE_EXIT_GRACE_MS)&&treeStopped)return;
 throw Error('Codex 模型发现子进程未能安全关闭');
}
export function parseCodexModels(rows:unknown[]):AiModelOption[]{
 const models=new Map<string,AiModelOption>();
 for(const raw of rows){if(!raw||typeof raw!=='object')continue;const row=raw as Record<string,unknown>;
  const id=typeof row.model==='string'?row.model:row.id;if(typeof id!=='string'||!id||id.length>120||!/^[a-z0-9._:/-]+$/i.test(id)||row.hidden===true)continue;
  const supported=Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts.flatMap(value=>value&&typeof value==='object'&&isReasoningEffort(value.reasoningEffort)?[value.reasoningEffort]:[]):[];
  models.set(id,{id,label:typeof row.displayName==='string'?row.displayName.slice(0,120):id,source:'codex',isDefault:row.isDefault===true,supportsReasoning:[...new Set(supported)],...(isReasoningEffort(row.defaultReasoningEffort)&&supported.includes(row.defaultReasoningEffort)?{defaultReasoningEffort:row.defaultReasoningEffort}:{})});
 }return [...models.values()].slice(0,500);
}
/** Only initialization and model listing are sent. No thread, turn, tools, or inference. */
export async function queryCodexModels(command:string,args:string[],env:NodeJS.ProcessEnv,timeoutMs=15000):Promise<AiModelOption[]>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-models-'));
 let child:ChildProcessWithoutNullStreams|undefined,closed:Promise<void>=Promise.resolve(),result:AiModelOption[]|undefined,primary:Error|undefined;
 try{result=await new Promise((resolve,reject)=>{
  let buffer='',bytes=0,settled=false,requestId=1,pages=0;const rows:unknown[]=[],seen=new Set<string>();
  const proc=child=spawn(command,args,{cwd:directory,env,stdio:['pipe','pipe','pipe'],shell:false,detached:true,windowsHide:true});
  // Windows holds the working directory until the process and its stdio close.
  closed=new Promise(resolveClose=>proc.once('close',()=>resolveClose()));
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(parseCodexModels(rows))};
  const timer=setTimeout(()=>finish(Error('Codex 模型列表读取超时')),timeoutMs);
  const send=(message:unknown)=>{if(!settled)proc.stdin.write(JSON.stringify(message)+'\n')};
  const next=(cursor?:string)=>{requestId++;pages++;send({id:requestId,method:'model/list',params:{limit:100,includeHidden:false,...(cursor?{cursor}:{})}})};
  proc.stdin.on('error',()=>finish(Error('Codex 模型发现连接已关闭')));
  proc.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)finish(Error('Codex 模型发现响应过大'))});
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data',(chunk:string)=>{
   bytes+=Buffer.byteLength(chunk);if(bytes>1024*1024){finish(Error('Codex 模型发现响应过大'));return}buffer+=chunk;
   for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;
    let message;try{message=JSON.parse(line)}catch{finish(Error('Codex 模型发现响应无效'));return}
    if(message.id!==requestId)continue;if(message.error){finish(Error('当前 Codex CLI 不支持模型发现，请更新 CLI 或手动填写模型'));return}
    if(requestId===1){send({method:'initialized',params:{}});next();continue}
    if(!Array.isArray(message.result?.data)){finish(Error('Codex 模型列表格式无效'));return}
    rows.push(...message.result.data);const cursor=message.result.nextCursor;
    if(cursor){if(typeof cursor!=='string'||cursor.length>2048||seen.has(cursor)||pages>=10||rows.length>500){finish(Error('Codex 模型列表分页无效或过大'));return}seen.add(cursor);next(cursor)}else finish();
   }
  });
  proc.on('error',()=>finish(Error('无法启动 Codex 模型发现服务')));
  proc.on('close',()=>{if(!settled)finish(Error('Codex 模型发现未完成'))});
  send({id:1,method:'initialize',params:{clientInfo:{name:'linkflow',title:'Linkflow',version:'1.1.0'}}});
 })}catch(error){primary=error instanceof Error?error:Error('Codex 模型发现失败')}
 let cleanup:Error|undefined;
 if(child)try{await closeOwnedProcess(child,closed)}catch{cleanup=Error('Codex 模型发现子进程清理未完成')}
 try{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})}catch{cleanup=Error('Codex 模型发现临时目录清理失败，请稍后重试')}
 if(primary)throw cleanup?Error(`${primary.message}；${cleanup.message}`):primary;
 if(cleanup)throw cleanup;
 return result??[];
}
export async function discoverLocalCodexModels(settings:Settings,reader?:()=>Promise<AiModelOption[]>):Promise<AiModelDiscovery>{
 const discoveredAt=new Date().toISOString();
 try{
  const launch=resolveCodexLaunch(settings.codexPath);
  const models=await (reader?reader():queryCodexModels(launch.command,[...launch.prefixArgs,'app-server','-c','features.hooks=false','-c','features.apps=false','-c','analytics.enabled=false','-c','model_provider="openai"'],codexEnvironment(process.env,launch.envAdditions)));
  if(!models.length)throw Error();
  return {provider:'codex',models,defaultModel:models.find(model=>model.isDefault)?.id,effectiveModel:settings.model||undefined,source:'local-cli',discoveredAt,message:`已从本机 Codex 读取 ${models.length} 个可选模型；列表不产生推理调用，执行时使用你保存的模型。`};
 }catch{return {provider:'codex',models:settings.model?[{id:settings.model,label:settings.model+'（手动配置，未验证）',source:'codex'}]:[],effectiveModel:settings.model||undefined,source:'unavailable',discoveredAt,message:'未能取得本机 Codex 模型列表。请检查 CLI 版本与登录，或在高级配置中填写模型并测试；不会自动改换模型。'}}
}
