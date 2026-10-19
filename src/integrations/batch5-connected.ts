import {createHash, randomUUID} from 'node:crypto';
import type {ExecutionContext, ExecutionResult, Task} from '../shared/types';
import type {Batch5Dependencies, Batch5Intent, Batch5OpaqueResponse, Batch5Persistence, Batch5Receipt, Batch5TaskState} from './batch5-contract';

export const hashBatch5 = (value:string):string => createHash('sha256').update(value,'utf8').digest('hex');

export type ConnectedContext = ExecutionContext & {
  batch5Persistence?:Batch5Persistence;
  batch5Dependencies?:Batch5Dependencies;
};

export function batch5State(context:ConnectedContext):Batch5TaskState|undefined {
  return (context.task as Task&{batch5?:Batch5TaskState}).batch5;
}

export function connectedDependencies(context:ConnectedContext, overrides?:Batch5Dependencies):Batch5Dependencies {
  return {...context.batch5Dependencies,...overrides};
}

export interface ConnectedResponse {
  status:number;
  url:string;
  contentType:string;
  robotsHeader:string;
  body:string;
}

/** Fixed-endpoint transport. Callers construct only audited URLs; redirects and cookies are disabled. */
export async function connectedRequest(
  url:string, init:RequestInit, deps:Batch5Dependencies, signal:AbortSignal, maxBytes=512*1024,
):Promise<ConnectedResponse>{
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal.aborted)throw Error('cancelled');
  signal.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,Math.min(Math.max(deps.timeoutMs??15000,100),30000));
  timeout.unref?.();
  try{
    const response=await (deps.fetch??fetch)(url,{...init,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(response.redirected||response.url&&response.url!==url)throw Error('redirect');
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw Error('response_too_large');
    const chunks:Uint8Array[]=[];let size=0;
    if(response.body){const reader=response.body.getReader();try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)throw Error('response_too_large');chunks.push(chunk.value)}}finally{void reader.cancel().catch(()=>undefined);reader.releaseLock()}}
    const bytes=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)));
    const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return {status:response.status,url,contentType:response.headers.get('content-type')??'',robotsHeader:response.headers.get('x-robots-tag')??'',body};
  }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort)}
}

export function parseConnectedJson(response:ConnectedResponse):Record<string,unknown>|undefined {
  if(!/^application\/json\b/i.test(response.contentType))return;
  try{const value:unknown=JSON.parse(response.body);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined}catch{return}
}

export function newBatch5Intent(context:ConnectedContext,request:string,source:string,createdAt:string):Batch5Intent {
  return {version:1,channelId:context.channel.id,operationId:randomUUID(),siteId:context.site.id,
    sourceHash:hashBatch5(source),requestHash:hashBatch5(request),createdAt};
}

export function stateFromIntent(intent:Batch5Intent,stage:Batch5TaskState['stage'],accountId:string,remoteId?:string,publicUrl?:string):Batch5TaskState {
  return {version:1,channelId:intent.channelId,operationId:intent.operationId,sourceHash:intent.sourceHash,
    requestHash:intent.requestHash,createdAt:intent.createdAt,stage,accountId,...(remoteId?{remoteId}:{}),...(publicUrl?{publicUrl}:{})};
}

export async function persistBatch5Intent(context:ConnectedContext,intent:Batch5Intent,accountId:string,remoteId?:string):Promise<Batch5TaskState>{
  const persistence=context.batch5Persistence;if(!persistence)throw Error('encrypted_journal_missing');
  await persistence.saveIntent(intent);
  const state=stateFromIntent(intent,'submitting',accountId,remoteId);
  context.checkpoint({batch5:state,checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
  return state;
}

export async function persistBatch5Response(persistence:Batch5Persistence,intent:Batch5Intent,response:ConnectedResponse):Promise<void>{
  const opaque:Batch5OpaqueResponse={version:1,intent,status:response.status,contentType:response.contentType,
    responseUrl:response.url,bodyBase64:Buffer.from(response.body,'utf8').toString('base64'),bodyComplete:true};
  await persistence.saveOpaqueResponse(opaque);
}

export async function persistBatch5Receipt(context:ConnectedContext,receipt:Batch5Receipt,accountId:string,remoteId:string):Promise<Batch5TaskState>{
  const persistence=context.batch5Persistence;if(!persistence)throw Error('encrypted_journal_missing');
  await persistence.saveReceipt(receipt);
  const current=persistence.currentTaskState?.()??batch5State(context);
  const stage=current?.stage==='published'?'published':'api_receipt';
  const state=stateFromIntent(receipt.intent,stage,accountId,remoteId,receipt.publicUrl);
  if(stage!=='published')context.checkpoint({batch5:state,checkpoint:'batch5_api_receipt',publicUrl:receipt.publicUrl,submittedAt:receipt.intent.createdAt} as Partial<Task>);
  return state;
}

export function lockedBatch5(context:ConnectedContext,message:string):ExecutionResult {
  return {status:'needs_input',message};
}

export function noIndex(response:ConnectedResponse):boolean {
  if(/(?:^|[,\s])noindex(?:[,\s]|$)/i.test(response.robotsHeader))return true;
  return /<meta\b[^>]*name\s*=\s*["']?(?:robots|googlebot|bingbot)["']?[^>]*content\s*=\s*["'][^"']*\bnoindex\b/i.test(response.body)
    ||/<meta\b[^>]*content\s*=\s*["'][^"']*\bnoindex\b[^"']*["'][^>]*name\s*=\s*["']?(?:robots|googlebot|bingbot)/i.test(response.body);
}
