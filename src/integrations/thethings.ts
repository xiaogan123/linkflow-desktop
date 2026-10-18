import {createHash} from 'node:crypto';
import {openAgentChatStreamingMutation,parseOpenAgentChatOpaque,type OpenAgentChatDependencies,type OpenAgentChatOpaqueResponse} from './openagentchat';

export const THETHINGS_ORIGIN='https://thethings.ai';
export const THETHINGS_CREATE=`${THETHINGS_ORIGIN}/api/scratch/publish`;
const OP=/^thethings_[a-f0-9]{32}$/;
const HASH=/^[a-f0-9]{64}$/;
const SLUG=/^[a-z0-9][a-z0-9_-]{5,127}$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const theThingsHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export interface TheThingsIntent {version:1;operationId:string;sourceHash:string;requestHash:string;createdAt:string}
export interface TheThingsReceipt extends TheThingsIntent {slug:string;publicUrl:string}
export interface TheThingsCreated {receipt:TheThingsReceipt;claimUrl:string;notice:string}
export interface TheThingsPersistence {
  loadPriorRaw():Promise<string|undefined>;
  persistIntent(intent:TheThingsIntent):Promise<void>;
  assertAuthorized(intent:TheThingsIntent):true;
  persistOpaque(intent:TheThingsIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
  persistCreated(value:TheThingsCreated):Promise<void>;
}
export function theThingsPublicUrl(slug:string){if(!SLUG.test(slug))throw Error('TheThings 匿名页面标识无效');return `${THETHINGS_ORIGIN}/p/scratch/${slug}`}
export function validTheThingsIntent(value:unknown):value is TheThingsIntent {
  if(!object(value)||Object.keys(value).sort().join(',')!=='createdAt,operationId,requestHash,sourceHash,version'||value.version!==1||typeof value.operationId!=='string'||!OP.test(value.operationId)||typeof value.sourceHash!=='string'||!HASH.test(value.sourceHash)||typeof value.requestHash!=='string'||!HASH.test(value.requestHash)||typeof value.createdAt!=='string')return false;
  const time=Date.parse(value.createdAt);return Number.isFinite(time)&&new Date(time).toISOString()===value.createdAt;
}
function validText(value:string,min:number,max:number){return typeof value==='string'&&value.length>=min&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value)}
export function theThingsRequest(title:string,summary:string,html:string){
  if(!validText(title,3,180)||!validText(summary,10,500)||typeof html!=='string'||!html.startsWith('<!doctype html>\n')||Buffer.byteLength(html)>120_000)throw Error('TheThings 需要审核后的完整文章');
  // The anonymous endpoint always exposes the page in discovery. Do not offer a private flag.
  const body=JSON.stringify({content:html,content_type:'text/html',title,summary});
  return {body,sourceHash:theThingsHash(html),requestHash:theThingsHash(`POST\n${THETHINGS_CREATE}\ncontent-type:application/json\n\n${body}`)};
}
export function parseTheThingsCreated(opaque:OpenAgentChatOpaqueResponse,intent:TheThingsIntent):TheThingsCreated|undefined {
  if(!validTheThingsIntent(intent)||opaque.requestUrl!==THETHINGS_CREATE||![200,201].includes(opaque.status))return;
  const value=parseOpenAgentChatOpaque(opaque,THETHINGS_CREATE,opaque.status);
  if(!object(value)||typeof value.url!=='string'||typeof value.claim_url!=='string'||value.claim_url.length>4096||typeof value.notice!=='string'||value.notice.length<1||value.notice.length>4000)return;
  let page:URL,claim:URL;try{page=new URL(value.url);claim=new URL(value.claim_url)}catch{return}
  const slug=page.pathname.slice('/p/scratch/'.length);
  if(!page.pathname.startsWith('/p/scratch/')||!SLUG.test(slug)||value.url!==theThingsPublicUrl(slug)||claim.origin!==THETHINGS_ORIGIN||claim.username||claim.password||claim.hash||claim.pathname==='/'||claim.href!==value.claim_url)return;
  return {receipt:{...intent,slug,publicUrl:page.href},claimUrl:claim.href,notice:value.notice};
}
export async function createTheThingsPage(input:{operationId:string;reviewed:true;title:string;summary:string;html:string},persistence:TheThingsPersistence,deps:OpenAgentChatDependencies={}) {
  if(input.reviewed!==true||!OP.test(input.operationId))throw Error('TheThings 提交授权无效');
  const request=theThingsRequest(input.title,input.summary,input.html);
  // A corrupt or empty old journal is still evidence of a prior attempt.
  if(await persistence.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
  if(deps.signal?.aborted)return {status:'not_started' as const};
  const intent:TheThingsIntent={version:1,operationId:input.operationId,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
  try{await persistence.persistIntent(intent)}catch{return {status:'not_started' as const}};
  const opaque=await openAgentChatStreamingMutation(THETHINGS_CREATE,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:request.body},value=>persistence.persistOpaque(intent,value),()=>persistence.assertAuthorized(intent),deps);
  if(!opaque)return {status:'unknown' as const,intent};
  const created=parseTheThingsCreated(opaque,intent);if(!created)return {status:'unknown' as const,intent};
  try{await persistence.persistCreated(created);return {status:'created' as const,receipt:created.receipt}}
  catch{return {status:'persistence_unknown' as const,intent}}
}
