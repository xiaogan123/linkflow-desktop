import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AiModelDiscovery,AiModelOption,ReasoningEffort,Settings} from '../shared/types';
import {codexEnvironment,resolveCodexLaunch} from './codex-process';
const efforts=new Set<ReasoningEffort>(['low','medium','high','xhigh','max','ultra']);
export function parseCodexModels(rows:unknown[]):AiModelOption[]{
 const models=new Map<string,AiModelOption>();
 for(const raw of rows){if(!raw||typeof raw!=='object')continue;const row=raw as Record<string,unknown>;
  const id=typeof row.model==='string'?row.model:row.id;if(typeof id!=='string'||!id||id.length>120||!/^[a-z0-9._:/-]+$/i.test(id)||row.hidden===true)continue;
  const supported=Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts.flatMap(value=>value&&typeof value==='object'&&efforts.has(value.reasoningEffort)?[value.reasoningEffort as ReasoningEffort]:[]):[];
  models.set(id,{id,label:typeof row.displayName==='string'?row.displayName.slice(0,120):id,source:'codex',isDefault:row.isDefault===true,supportsReasoning:[...new Set(supported)]});
 }return [...models.values()].slice(0,500);
}
/** Only initialization and model listing are sent. No thread, turn, tools, or inference. */
export async function queryCodexModels(command:string,args:string[],env:NodeJS.ProcessEnv,timeoutMs=15000):Promise<AiModelOption[]>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-models-'));
 try{return await new Promise((resolve,reject)=>{
  let buffer='',bytes=0,settled=false,requestId=1,pages=0;const rows:unknown[]=[],seen=new Set<string>();
  const child=spawn(command,args,{cwd:directory,env,stdio:['pipe','pipe','pipe'],shell:false});
  const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();child.kill('SIGKILL');error?reject(error):resolve(parseCodexModels(rows))};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('Codex 模型列表读取超时'))},timeoutMs);
  const send=(message:unknown)=>{if(!settled)child.stdin.write(JSON.stringify(message)+'\n')};
  const next=(cursor?:string)=>{requestId++;pages++;send({id:requestId,method:'model/list',params:{limit:100,includeHidden:false,...(cursor?{cursor}:{})}})};
  child.stdin.on('error',()=>finish(Error('Codex 模型发现连接已关闭')));
  child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024)finish(Error('Codex 模型发现响应过大'))});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{
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
  child.on('error',()=>finish(Error('无法启动 Codex 模型发现服务')));
  child.on('close',()=>{if(!settled)finish(Error('Codex 模型发现未完成'))});
  send({id:1,method:'initialize',params:{clientInfo:{name:'linkflow',title:'Linkflow',version:'1.1.0'}}});
 })}finally{await rm(directory,{recursive:true,force:true})}
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
