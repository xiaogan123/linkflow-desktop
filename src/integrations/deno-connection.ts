import {createHash} from 'node:crypto';
import type {Account} from '../shared/types';

const ORIGIN='https://api.deno.com';
const LIST_URL=`${ORIGIN}/v2/apps?limit=100`;
const MAX_BYTES=1024*1024;
const MAX_PAGES=5;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_LOWER=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const DECLARED_ORG_NOTE=/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

export interface DenoAppChoice {id:string;slug:string}
export interface DenoConnectionDependencies {fetch?:(url:string,init:RequestInit)=>Promise<Response>;signal?:AbortSignal;timeoutMs?:number}
export function validDenoToken(value:unknown):value is string{return typeof value==='string'&&value.length>=1&&value.length<=4096&&!/[\s\x00-\x1f\x7f]/.test(value)}
export function denoTokenFingerprint(token:string){return createHash('sha256').update(token).digest('hex')}
export function validDenoReadAccount(account:Account):boolean{
  const proof=account.denoReadAccess;
  return account.channelId==='deno'&&account.status==='unknown'&&account.source==='imported'&&account.credentialKind==='api_token'&&account.hasPassword&&!!proof&&proof.version===1&&UUID_LOWER.test(proof.appId)&&SLUG.test(proof.appSlug)&&DECLARED_ORG_NOTE.test(proof.declaredOrgSlug)&&/^[0-9a-f]{64}$/.test(proof.tokenFingerprint)&&account.username===proof.appId&&Number.isFinite(Date.parse(proof.checkedAt))&&!account.registeredAt&&!account.verifiedAt&&!account.publicationUrl&&!account.diagnostic&&!(account.registrationAttempts??0);
}
export function serializeDenoToken(token:string):string{if(!validDenoToken(token))throw Error('Deno 组织令牌格式无效');return JSON.stringify({version:1,token})}
export function validStoredDenoToken(value:string|undefined,account:Account):boolean{
  try{const data=JSON.parse(value??'');return data&&Object.keys(data).sort().join(',')==='token,version'&&data.version===1&&validDenoToken(data.token)&&validDenoReadAccount(account)&&denoTokenFingerprint(data.token)===account.denoReadAccess?.tokenFingerprint}catch{return false}
}

function appChoice(value:unknown):DenoAppChoice{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Deno 应用响应格式无法确认');
  const item=value as Record<string,unknown>;
  if(typeof item.id!=='string'||!UUID.test(item.id)||typeof item.slug!=='string'||(!SLUG.test(item.slug)||item.slug.slice(2,4)==='--'))throw Error('Deno 应用响应格式无法确认');
  return {id:item.id.toLowerCase(),slug:item.slug};
}

/** A fixed-host GET client. Link pagination accepts only same-origin /v2/apps cursor URLs. */
export async function readDenoApps(token:string,dependencies:DenoConnectionDependencies={}):Promise<DenoAppChoice[]>{
  if(!validDenoToken(token))throw Error('Deno 组织令牌格式无效');
  const request=new DenoReadSession(token,dependencies);
  try{
    const choices=new Map<string,DenoAppChoice>();let url=LIST_URL;
    for(let page=0;page<MAX_PAGES;page++){
      const response=await request.get(url);const body=response.body;
      if(!Array.isArray(body)||body.length>100)throw Error('Deno 应用列表格式无法确认');
      for(const item of body){const choice=appChoice(item),old=choices.get(choice.id);if(old&&old.slug!==choice.slug)throw Error('Deno 应用列表身份不一致');choices.set(choice.id,choice)}
      const next=nextListUrl(response.link);
      if(!next)return [...choices.values()];
      if(page===MAX_PAGES-1)throw Error('Deno 应用列表超过本次读取上限；请缩小组织应用数量后重试');
      url=next;
    }
    return [...choices.values()];
  }finally{request.close()}
}

/** Confirms the selected UUID is listed and GET by UUID returns the same identity. */
export async function checkDenoSelectedApp(token:string,selectedId:string,dependencies:DenoConnectionDependencies={}):Promise<DenoAppChoice>{
  if(!validDenoToken(token)||!UUID.test(selectedId))throw Error('Deno 连接资料格式无效');
  const list=await readDenoApps(token,dependencies),selected=list.find(item=>item.id===selectedId.toLowerCase());
  if(!selected)throw Error('所选 Deno 应用不在该令牌可读取的列表中');
  const request=new DenoReadSession(token,dependencies);
  try{
    const detail=appChoice((await request.get(`${ORIGIN}/v2/apps/${selected.id}`)).body);
    if(detail.id!==selected.id||detail.slug!==selected.slug)throw Error('Deno 应用详情与列表身份不一致');
    // The revisions endpoint is read to establish present state; it does not prove publishing eligibility.
    const revisions=(await request.get(`${ORIGIN}/v2/apps/${selected.id}/revisions?limit=30`)).body;
    if(!Array.isArray(revisions)||revisions.length>30||revisions.some(item=>!item||typeof item!=='object'||Array.isArray(item)||typeof (item as {id?:unknown}).id!=='string'||!(item as {id:string}).id||String((item as {id:string}).id).length>256))throw Error('Deno revision 列表格式无法确认');
    if(revisions.length){
      const revisionId=(revisions[0] as {id:string}).id;
      const revision=(await request.get(`${ORIGIN}/v2/revisions/${encodeURIComponent(revisionId)}`)).body;
      if(!revision||typeof revision!=='object'||Array.isArray(revision)||(revision as {id?:unknown}).id!==revisionId)throw Error('Deno revision 详情与列表身份不一致');
    }
    return detail;
  }finally{request.close()}
}

function nextListUrl(link:string|null):string|undefined{
  if(!link)return undefined;
  const parts=link.split(',');const next=parts.find(part=>/;\s*rel="?next"?\s*$/i.test(part.trim()));
  if(!next)return undefined;
  const match=/^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i.exec(next);
  if(!match)throw Error('Deno 应用列表分页链接无效');
  const url=new URL(match[1],ORIGIN);
  if(url.origin!==ORIGIN||url.pathname!=='/v2/apps'||url.username||url.password||url.hash||url.searchParams.getAll('cursor').length!==1||!url.searchParams.get('cursor')||url.searchParams.getAll('limit').length>1||[...url.searchParams.keys()].some(key=>key!=='cursor'&&key!=='limit'))throw Error('Deno 应用列表分页链接无效');
  if(url.searchParams.has('limit')&&url.searchParams.get('limit')!=='100')throw Error('Deno 应用列表分页限制意外变化');
  return url.href;
}

class DenoReadSession{
  private controller=new AbortController();private timeout:ReturnType<typeof setTimeout>;private reader?:ReadableStreamDefaultReader<Uint8Array>;private timedOut=false;
  private abort=()=>this.controller.abort();
  constructor(private token:string,private dependencies:DenoConnectionDependencies){
    if(dependencies.signal?.aborted)throw Error('Deno 连接已取消');
    dependencies.signal?.addEventListener('abort',this.abort,{once:true});
    this.timeout=setTimeout(()=>{this.timedOut=true;this.controller.abort()},Math.min(30_000,Math.max(1,dependencies.timeoutMs??15_000)));
  }
  async get(url:string):Promise<{body:unknown;link:string|null}>{
    if(this.controller.signal.aborted)throw Error(this.timedOut?'Deno 只读请求超时':'Deno 连接已取消');
    const abort=new Promise<never>((_,reject)=>this.controller.signal.addEventListener('abort',()=>reject(Error(this.timedOut?'Deno 只读请求超时':'Deno 连接已取消')),{once:true}));
    const work=async()=>{
      let response:Response;
      try{response=await (this.dependencies.fetch??fetch)(url,{method:'GET',headers:{Authorization:`Bearer ${this.token}`,Accept:'application/json'},redirect:'manual',credentials:'omit',cache:'no-store',signal:this.controller.signal})}
      catch{throw Error('Deno 只读请求失败，请检查网络或组织令牌')}
      if(response.status===401||response.status===403)throw Error('Deno 组织令牌无效或没有应用读取权限');
      if(response.status===429)throw Error('Deno 暂时限制请求，请稍后再试');
      if(response.status!==200||response.redirected||(response.url&&response.url!==url)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw Error('Deno 未返回可确认的只读响应');
      const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))throw Error('Deno 只读响应超出限制');
      if(!response.body)throw Error('Deno 只读响应为空');
      this.reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const part=await this.reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw Error('Deno 只读响应超出限制');chunks.push(part.value)}}catch{throw Error('Deno 只读响应读取失败或超过限制')}
      let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('Deno 只读响应格式无法确认')}
      this.reader=undefined;return {body,link:response.headers.get('link')};
    };
    return Promise.race([work(),abort]);
  }
  close(){clearTimeout(this.timeout);this.dependencies.signal?.removeEventListener('abort',this.abort);void this.reader?.cancel().catch(()=>{});this.controller.abort()}
}
