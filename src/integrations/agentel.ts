import {createHash,randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import {connectedRequest,noIndex,parseConnectedJson,type ConnectedResponse} from './batch5-connected';
import type {Batch5Dependencies} from './batch5-contract';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';

export const AGENTEL_ORIGIN='https://agentel.tech';
export const AGENTEL_API=`${AGENTEL_ORIGIN}/api/v1`;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID=/^(?:agent|update|post)_[a-zA-Z0-9-]{3,100}$/;
const KEY=/^[^\s\u0000-\u001f\u007f]{12,8192}$/;
const SHA=/^[a-f0-9]{64}$/;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export interface AgentelIdentity {name:string;slug:string;description:string;category:'coding';installationId:string}
export interface AgentelArticle {title:string;content:string;targetUrl:string;siteUrl:string}
export interface AgentelCredential {agentId:string;slug:string;apiKey:string}
export interface AgentelIntent {version:1;kind:'register'|'publish';operationId:string;siteId:string;taskId?:string;requestHash:string;createdAt:string;payload:AgentelIdentity|AgentelArticle;agentId?:string}
export interface AgentelOpaque {status:number;url:string;contentType:string;bodyBase64:string}
export interface AgentelJournal {version:1;stage:'reserved'|'sending'|'opaque'|'verified';intent:AgentelIntent;opaque?:AgentelOpaque;verifiedAt?:string}
/** Implementations must encrypt the whole journal and atomically reject a changed previous value. */
export interface AgentelEncryptedJournal {load():Promise<AgentelJournal|undefined>;save(next:AgentelJournal,previous:AgentelJournal|undefined):Promise<void>}
export interface AgentelRunOptions {journal:AgentelEncryptedJournal;siteId:string;taskId?:string;authorize:()=>Promise<void>|void;dependencies?:Batch5Dependencies;signal:AbortSignal;now?:()=>Date}
export type AgentelRunResult={status:'verified';credential?:AgentelCredential;publicUrl?:string}|{status:'unknown'|'blocked';reason:string};

function stamp(options:AgentelRunOptions){return (options.now?.()??new Date()).toISOString()}
function opaque(response:ConnectedResponse):AgentelOpaque{return {status:response.status,url:response.url,contentType:response.contentType,bodyBase64:Buffer.from(response.body,'utf8').toString('base64')}}
function responseFromOpaque(value:AgentelOpaque):ConnectedResponse|undefined{
  if(!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.url!=='string'||typeof value.contentType!=='string'
    ||typeof value.bodyBase64!=='string'||value.bodyBase64.length>512_000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bodyBase64))return;
  const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;
  try{return {status:value.status,url:value.url,contentType:value.contentType,body:new TextDecoder('utf-8',{fatal:true}).decode(bytes),robotsHeader:''}}catch{return}
}
function headers(key:string):HeadersInit{if(!KEY.test(key))throw Error('agentel_key_invalid');return {accept:'application/json',authorization:`Bearer ${key}`}}
export function validateAgentelIdentity(value:AgentelIdentity):AgentelIdentity{
  if(!value||typeof value.name!=='string'||value.name.trim().length<2||value.name.trim().length>80
    ||typeof value.slug!=='string'||value.slug.length>64||!SLUG.test(value.slug)
    ||typeof value.description!=='string'||value.description.trim().length<20||value.description.length>300
    ||value.category!=='coding'||typeof value.installationId!=='string'||!SLUG.test(value.installationId)||value.installationId.length>100
    ||!(/\b(?:agent|assistant)\b/i.test(value.name+' '+value.description)))throw Error('agentel_identity_invalid');
  return value;
}
/** No truncation: the complete public text must fit Agentel's documented 5,000-character Update limit. */
export function validateAgentelArticle(value:AgentelArticle):AgentelArticle{
  if(!value||typeof value.title!=='string'||!value.title.trim()||value.title.trim().length>120||typeof value.content!=='string'
    ||!value.content.trim()||value.content.trim().length>5000)throw Error('agentel_article_limit');
  const target=new URL(value.targetUrl),site=new URL(value.siteUrl);
  if(target.protocol!=='https:'||target.username||target.password||target.hash||site.protocol!=='https:'||site.hostname!==target.hostname
    ||target.href.length>2048||!SLUG.test(site.hostname.split('.')[0]??''))throw Error('agentel_target_invalid');
  if(value.content.split(target.href).length!==2)throw Error('agentel_target_count');
  return {...value,targetUrl:target.href,siteUrl:site.href};
}
function registrationResponse(response:ConnectedResponse,intent:AgentelIntent):AgentelCredential|undefined{
  if(response.status!==201&&response.status!==200||response.url!==`${AGENTEL_API}/agents/register`)return;
  const value=parseConnectedJson(response);if(!value||!object(value.agent)||!object(value.credential))return;
  const agent=value.agent,credential=value.credential,payload=intent.payload as AgentelIdentity;
  if(typeof agent.id!=='string'||!ID.test(agent.id)||agent.slug!==payload.slug||typeof credential.key!=='string'||!KEY.test(credential.key))return;
  return {agentId:agent.id,slug:payload.slug,apiKey:credential.key};
}
export async function probeAgentelIdentity(credential:AgentelCredential,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<boolean>{
  const response=await connectedRequest(`${AGENTEL_API}/me`,{method:'GET',headers:headers(credential.apiKey)},deps,signal,32_000);
  const value=parseConnectedJson(response);return response.status===200&&object(value?.agent)&&value.agent.id===credential.agentId&&value.agent.slug===credential.slug;
}
function intent(kind:AgentelIntent['kind'],payload:AgentelIdentity|AgentelArticle,options:AgentelRunOptions,agentId?:string):AgentelIntent{
  return {version:1,kind,operationId:randomUUID(),siteId:options.siteId,...(options.taskId?{taskId:options.taskId}:{}),requestHash:hash(JSON.stringify(payload)),createdAt:stamp(options),payload,...(agentId?{agentId}:{})};
}
function validJournal(value:AgentelJournal|undefined,kind:AgentelIntent['kind'],payload:AgentelIdentity|AgentelArticle,options:AgentelRunOptions,agentId?:string):value is AgentelJournal{
  const i=value?.intent;return !!i&&value?.version===1&&i.version===1&&i.kind===kind&&i.siteId===options.siteId&&i.taskId===options.taskId
    &&i.agentId===agentId&&typeof i.operationId==='string'&&/^[0-9a-f-]{36}$/.test(i.operationId)&&SHA.test(i.requestHash)
    &&i.requestHash===hash(JSON.stringify(payload))&&same(i.payload,payload)&&['reserved','sending','opaque','verified'].includes(value.stage)
    &&(value.stage==='reserved'||value.stage==='sending'?!value.opaque:!!value.opaque);
}
async function reserve(kind:AgentelIntent['kind'],payload:AgentelIdentity|AgentelArticle,options:AgentelRunOptions,agentId?:string):Promise<AgentelJournal>{
  const existing=await options.journal.load();if(existing){if(!validJournal(existing,kind,payload,options,agentId))throw Error('agentel_original_intent_mismatch');return existing}
  await options.authorize();const next:AgentelJournal={version:1,stage:'reserved',intent:intent(kind,payload,options,agentId)};
  await options.journal.save(next,undefined);return next;
}
async function dispatch(journal:AgentelJournal,url:string,body:string,options:AgentelRunOptions,key?:string):Promise<AgentelJournal|undefined>{
  if(journal.stage!=='reserved')return journal;
  await options.authorize();const sending:AgentelJournal={...journal,stage:'sending'};await options.journal.save(sending,journal);
  // If permission changes after arming the intent, leave it unknown; never reset or retry this POST.
  await options.authorize();
  let response:ConnectedResponse;try{response=await connectedRequest(url,{method:'POST',headers:{...(key?headers(key):{accept:'application/json'}),'content-type':'application/json','Idempotency-Key':journal.intent.operationId},body},options.dependencies??{},options.signal,192_000)}catch{return}
  const next:AgentelJournal={...sending,stage:'opaque',opaque:opaque(response)};
  await options.journal.save(next,sending);return next;
}
export async function runAgentelRegistration(identity:AgentelIdentity,options:AgentelRunOptions):Promise<AgentelRunResult>{
  validateAgentelIdentity(identity);if(options.taskId)throw Error('agentel_registration_task_id_unexpected');
  let journal:AgentelJournal;try{journal=await reserve('register',identity,options)}catch{return {status:'blocked',reason:'registration_intent_unavailable'}}
  if(journal.stage==='sending')return {status:'unknown',reason:'registration_unknown_get_only'};
  if(journal.stage==='reserved'){
    try{const next=await dispatch(journal,`${AGENTEL_API}/agents/register`,JSON.stringify(identity),options);if(!next)return {status:'unknown',reason:'registration_unknown_get_only'};journal=next}
    catch{return {status:'unknown',reason:'registration_permission_or_storage_changed'}}
  }
  const response=journal.opaque&&responseFromOpaque(journal.opaque);if(!response)return {status:'unknown',reason:'registration_response_missing'};
  const credential=registrationResponse(response,journal.intent);if(!credential)return {status:'unknown',reason:'registration_response_unverified'};
  if(journal.stage!=='verified')try{await options.authorize()}catch{return {status:'unknown',reason:'registration_authorization_changed_after_response'}}
  if(!await probeAgentelIdentity(credential,options.dependencies,options.signal).catch(()=>false))return {status:'unknown',reason:'registration_identity_unverified'};
  if(journal.stage!=='verified'){
    const ready:AgentelJournal={...journal,stage:'verified',verifiedAt:stamp(options)};
    try{await options.journal.save(ready,journal)}catch{return {status:'unknown',reason:'registration_receipt_unsaved'}}
  }
  return {status:'verified',credential};
}
function updateId(response:ConnectedResponse,agentId:string):string|undefined{
  if(response.status!==201&&response.status!==200)return;const value=parseConnectedJson(response),update=value?.update;
  if(!object(update)||typeof update.id!=='string'||!ID.test(update.id))return;
  if(update.agentId!==undefined&&update.agentId!==agentId)return;return update.id;
}
function normalized(value:string){return value.replace(/\s+/g,' ').trim()}
function renderedText(html:string):string{
  const $=load(html);$('br').replaceWith('\n');
  $('p,div,h1,h2,h3,h4,h5,h6,li,pre,blockquote,tr').each((_i,node)=>{$(node).append('\n')});
  return normalized($.root().text());
}
async function possibleOriginalUpdate(article:AgentelArticle,credential:AgentelCredential,options:AgentelRunOptions):Promise<boolean>{
  const response=await connectedRequest(`${AGENTEL_API}/agents/${credential.agentId}/updates?limit=20`,
    {method:'GET',headers:headers(credential.apiKey)},options.dependencies??{},options.signal,128_000);
  const value=parseConnectedJson(response);if(response.status!==200||!value||!Array.isArray(value.updates))return false;
  const matches=value.updates.filter(item=>object(item)&&item.title===article.title&&typeof item.content==='string'&&item.content.trim()===article.content.trim()
    &&typeof item.id==='string'&&ID.test(item.id)&&(!object(item.agent)||item.agent.id===credential.agentId));
  if(matches.length!==1)return false;
  return verifyAgentelPublic(`${AGENTEL_ORIGIN}/thread/${(matches[0] as Record<string,unknown>).id}`,article,options.dependencies,options.signal);
}
export async function verifyAgentelPublic(url:string,article:AgentelArticle,deps:Batch5Dependencies={},signal=new AbortController().signal):Promise<boolean>{
  const parsed=new URL(url);if(parsed.origin!==AGENTEL_ORIGIN||!/^\/thread\/(?:update|post)_[a-zA-Z0-9-]+$/.test(parsed.pathname))return false;
  const page=await connectedRequest(url,{method:'GET',headers:{accept:'text/html'}},deps,signal,256_000);
  if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noIndex(page)
    ||/(?:^|[:,\s])(?:none|noindex)(?=$|[,\s])/i.test(page.robotsHeader))return false;
  const $=load(page.body);applyDeclaredArticleVisibility($);
  const body=$('article.detail-main .feed-content-thread').first();
  if($('meta[name]').toArray().some(node=>/^(?:robots|googlebot|bingbot)$/i.test($(node).attr('name')??'')
    &&/(?:^|[,\s])(?:none|noindex)(?=$|[,\s])/i.test($(node).attr('content')??'')))return false;
  const title=$('article.detail-main h1').first();
  if(title.text().trim()!==article.title||!body.length||[title,body].some(node=>node.parents().addBack().toArray().some(element=>elementConcealed($,element)))
    ||body.find('*').toArray().some(element=>elementConcealed($,element))
    ||renderedText(body.html()??'')!==renderedText(marked.parse(article.content,{gfm:true,async:false})))return false;
  if(body.find('a[href]').filter((_index,node)=>$(node).attr('href')===article.targetUrl).length!==1)return false;
  const robots=await connectedRequest(`${AGENTEL_ORIGIN}/robots.txt`,{method:'GET'},deps,signal,16_384);
  return robots.status===200&&!/\bDisallow:\s*\/(?:thread\/|\s|$)/i.test(robots.body)&&/\bAllow:\s*\/thread\/\s*$/im.test(robots.body);
}
/** Read-only restart path. It parses the saved original response, GETs the public page and promotes the same journal; it holds no route to dispatch(). */
export async function recoverAgentelPublication(articleInput:AgentelArticle,credential:AgentelCredential,options:Omit<AgentelRunOptions,'authorize'>):Promise<AgentelRunResult>{
  const article=validateAgentelArticle(articleInput),recovery={...options,authorize:()=>{}};
  const journal=await options.journal.load();
  if(!validJournal(journal,'publish',article,recovery,credential.agentId)||journal.stage!=='opaque')return {status:'unknown',reason:'publication_recovery_not_applicable'};
  const response=journal.opaque&&responseFromOpaque(journal.opaque);if(!response||response.url!==`${AGENTEL_API}/agents/${credential.agentId}/updates`)return {status:'unknown',reason:'publication_response_missing'};
  const id=updateId(response,credential.agentId);if(!id)return {status:'unknown',reason:'publication_response_unverified'};
  const url=`${AGENTEL_ORIGIN}/thread/${id}`;
  if(!await verifyAgentelPublic(url,article,options.dependencies,options.signal).catch(()=>false))return {status:'unknown',reason:'publication_public_readback_missing'};
  try{await options.journal.save({...journal,stage:'verified',verifiedAt:stamp(recovery)},journal)}catch{return {status:'unknown',reason:'publication_receipt_unsaved'}}
  return {status:'verified',publicUrl:url};
}
export async function runAgentelPublication(articleInput:AgentelArticle,credential:AgentelCredential,options:AgentelRunOptions):Promise<AgentelRunResult>{
  const article=validateAgentelArticle(articleInput);
  if(!options.taskId||!ID.test(credential.agentId)||!SLUG.test(credential.slug)||!KEY.test(credential.apiKey))throw Error('agentel_publication_identity_invalid');
  if(!await probeAgentelIdentity(credential,options.dependencies,options.signal).catch(()=>false))return {status:'blocked',reason:'agentel_identity_unverified'};
  let journal:AgentelJournal;try{journal=await reserve('publish',article,options,credential.agentId)}catch{return {status:'blocked',reason:'publication_intent_unavailable'}}
  if(journal.stage==='sending'){
    const visible=await possibleOriginalUpdate(article,credential,options).catch(()=>false);
    return {status:'unknown',reason:visible?'publication_possible_match_read_only':'publication_unknown_get_only'};
  }
  if(journal.stage==='reserved'){
    try{const next=await dispatch(journal,`${AGENTEL_API}/agents/${credential.agentId}/updates`,JSON.stringify({type:'RESEARCH_NOTE',title:article.title,content:article.content,tags:['software']}),options,credential.apiKey);
      if(!next)return {status:'unknown',reason:'publication_unknown_get_only'};journal=next}
    catch{return {status:'unknown',reason:'publication_permission_or_storage_changed'}}
  }
  const response=journal.opaque&&responseFromOpaque(journal.opaque);if(!response||response.url!==`${AGENTEL_API}/agents/${credential.agentId}/updates`)return {status:'unknown',reason:'publication_response_missing'};
  const id=updateId(response,credential.agentId);if(!id){
    const visible=await possibleOriginalUpdate(article,credential,options).catch(()=>false);
    return {status:'unknown',reason:visible?'publication_possible_match_read_only':'publication_response_unverified'};
  }
  const url=`${AGENTEL_ORIGIN}/thread/${id}`;
  if(journal.stage!=='verified')try{await options.authorize()}catch{return {status:'unknown',reason:'publication_authorization_changed_after_response'}}
  if(!await verifyAgentelPublic(url,article,options.dependencies,options.signal).catch(()=>false))return {status:'unknown',reason:'publication_public_readback_missing'};
  if(journal.stage!=='verified'){
    const ready:AgentelJournal={...journal,stage:'verified',verifiedAt:stamp(options)};
    try{await options.journal.save(ready,journal)}catch{return {status:'unknown',reason:'publication_receipt_unsaved'}}
  }
  return {status:'verified',publicUrl:url};
}
