import {createHash} from 'node:crypto';
import type {Account} from '../shared/types';

const LIST_URL='https://marke.st/api/v1/pastes';
const MAX_BYTES=1024*1024;
export interface MarkestConnectionDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number}
export function validMarkestKey(value:unknown):value is string{return typeof value==='string'&&/^mk_live_[a-fA-F0-9]{48}$/.test(value)}
export function markestKeyFingerprint(key:string):string{return createHash('sha256').update(key).digest('hex')}
export function validMarkestReadAccount(account:Account):boolean {
  const proof=account.markestReadAccess;
  return account.channelId==='markest'&&account.status==='unknown'&&account.source==='imported'&&account.credentialKind==='api_token'&&account.hasPassword&&!!proof&&proof.version===1&&proof.identity==='user_declared'&&/^[a-f0-9]{64}$/.test(proof.keyFingerprint)&&account.username==='local-key:'+proof.keyFingerprint&&Number.isFinite(Date.parse(proof.checkedAt))&&!account.registeredAt&&!account.verifiedAt&&!account.publicationUrl&&!account.diagnostic&&!(account.registrationAttempts??0);
}
export function serializeMarkestKey(apiKey:string):string {if(!validMarkestKey(apiKey))throw Error('Markest key 格式无效');return JSON.stringify({version:1,apiKey})}
export function validStoredMarkestKey(value:string|undefined,account:Account):boolean {
  try{const x=JSON.parse(value??'');return !!x&&Object.keys(x).sort().join(',')==='apiKey,version'&&x.version===1&&validMarkestKey(x.apiKey)&&validMarkestReadAccount(account)&&markestKeyFingerprint(x.apiKey)===account.markestReadAccess?.keyFingerprint}catch{return false}
}

/** Only proves list access. Never returns or persists the user's private paste list. */
export async function checkMarkestReadAccess(apiKey:string,dependencies:MarkestConnectionDependencies={}):Promise<void>{
  if(!validMarkestKey(apiKey))throw Error('Markest key 格式无效');
  if(dependencies.signal?.aborted)throw Error('Markest 连接已取消');
  const controller=new AbortController();let timedOut=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const cancel=()=>controller.abort();dependencies.signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.min(15_000,Math.max(1,dependencies.timeoutMs??15_000)));
  let stop=()=>{};
  const aborted=new Promise<never>((_,reject)=>{stop=()=>reject(Error(timedOut?'Markest 读取验证超时':'Markest 连接已取消'));controller.signal.addEventListener('abort',stop,{once:true});});
  const work=async()=>{
    let response:Response;
    try{response=await (dependencies.fetch??fetch)(LIST_URL,{method:'GET',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json'},redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal})}
    catch{throw Error('Markest 读取验证失败，请检查网络或 key 权限')}
    if(controller.signal.aborted)throw Error('Markest 连接已取消');
    if(response.status===401||response.status===403)throw Error('Markest key 无效或没有列表读取权限');
    if(response.status===429)throw Error('Markest 暂时限制请求，请稍后再试');
    if(response.status!==200||response.redirected||(response.url&&response.url!==LIST_URL)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw Error('Markest 未返回可确认的列表响应');
    const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw Error('Markest 列表响应超出读取限制');
    if(!response.body)throw Error('Markest 列表响应为空');
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw Error('Markest 列表响应超出读取限制');chunks.push(part.value)}}
    catch{throw Error('Markest 列表响应读取失败或超过限制')}
    let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('Markest 列表响应格式无法确认')}
    if(!data||typeof data!=='object'||!Array.isArray((data as {pastes?:unknown}).pastes))throw Error('Markest 列表响应格式无法确认');
    const {pastes,total}=data as {pastes:unknown[];total:unknown};
    if(!Number.isSafeInteger(total)||Number(total)<pastes.length||pastes.some(item=>!item||typeof item!=='object'||Array.isArray(item)||typeof (item as {id?:unknown}).id!=='string'||!(item as {id:string}).id))throw Error('Markest 列表响应格式无法确认');
  };
  try{await Promise.race([work(),aborted]);if(controller.signal.aborted)throw Error('Markest 连接已取消')}
  finally{clearTimeout(timer);dependencies.signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',stop);void reader?.cancel().catch(()=>{});controller.abort()}
}
