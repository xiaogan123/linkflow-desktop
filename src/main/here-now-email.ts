import {randomUUID} from 'node:crypto';
import {CHANNELS} from '../integrations/catalog';
import {inspectHereNowIdentity} from '../integrations/here-now-account';
import {fetchHereNowBounded,HERE_NOW_ORIGIN,hereNowSha256,validHereNowApiKey,type HereNowDependencies} from '../integrations/here-now';
import type {Account} from '../shared/types';
import {bindAccount} from './account-bindings';
import {taskTransition} from './task-state';
import {mailboxAutomationReady} from '../shared/mail-automation';
import {parseShiplyVerifyOpaque} from './shiply-management';
import type {Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'update'|'updateWithCiphers'|'getCipher'>;
type AtomicVault=Pick<Vault,'get'|'encryptSecrets'>;
// Local waiting limit, not a claim about the server's undocumented code TTL.
export const HERE_NOW_EMAIL_WAIT_MS=10*60_000;
export const HERE_NOW_KEY_NAME='site-publishing';
export const hereNowVerifyKey=(id:string)=>`here-now:identity:${id}:verify`;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const endpoint=(step:string)=>`${HERE_NOW_ORIGIN}/api/auth/agent/${step}`;
const requestInit=(body:unknown):RequestInit=>({method:'POST',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json','content-type':'application/json','x-herenow-client':'linkflow/email'},body:JSON.stringify(body)});

function markCodePending(state:ReturnType<Store['read']>,account:Account,now:Date):void{
  const journal=account.hereNowEmail,site=state.sites.find(value=>value.id===journal?.siteId);
  if(!journal||journal.stage!=='code_sent'||!site||!mailboxAutomationReady(state.mailboxes.find(value=>value.id===(account.mailboxId??site.mailboxId))))return;
  for(const task of state.tasks){
    if(task.channelId!=='here-now'||task.siteId!==site.id||task.accountId&&task.accountId!==account.id||task.hereNow||task.submittedAt||task.publicUrl||task.firstLiveAt||!['queued','needs_input'].includes(task.status)||task.deferredAt)continue;
    const expiredWait=task.emailWait?.continuation==='here-now'&&Date.parse(task.emailWait.expiresAt)<=now.getTime();
    const expiredConfirmation=task.emailConfirmation?.wait.continuation==='here-now'&&Date.parse(task.emailConfirmation.wait.expiresAt)<=now.getTime();
    const expiredHandoff=task.checkpoint==='email_verification_human'&&['account_login','email_code_ambiguous'].includes(task.humanAction?.kind??'')&&(!task.humanAction?.expiresAt||Date.parse(task.humanAction.expiresAt)<=now.getTime());
    if(!expiredWait&&!expiredConfirmation&&!expiredHandoff&&![undefined,'account_handoff','email_code_pending'].includes(task.checkpoint))continue;
    if(task.humanAction&&!expiredConfirmation&&!expiredHandoff)continue;
    Object.assign(task,taskTransition(task,{status:'needs_input',accountId:account.id,checkpoint:'email_code_pending',reasonCode:'email_code_pending',emailWait:undefined,emailConfirmation:undefined,emailWaitRegisteredAt:undefined,humanAction:undefined}));
  }
}

export async function requestHereNowCode(store:StateStore,emailInput:string,deps:HereNowDependencies&{siteId?:string}={}):Promise<Account>{
  const email=emailInput.trim().toLowerCase(),before=store.read();
  if(email.length>254||!EMAIL.test(email))throw Error('here.now 邮箱无效');
  if(deps.signal?.aborted)throw Error('here.now 邮箱连接已取消');
  if(deps.siteId&&!before.sites.some(site=>site.id===deps.siteId))throw Error('所选网站不存在');
  const id=randomUUID(),stamp=(deps.now?.()??new Date()).toISOString();
  const account:Account={id,channelId:'here-now',email,username:email,credentialKind:'api_token',status:'needs_verification',hasPassword:false,source:'imported',createdAt:stamp,updatedAt:stamp,mailboxId:before.sites.find(site=>site.id===deps.siteId)?.mailboxId,
    hereNowEmail:{version:1,emailHash:hereNowSha256(email),requestedAt:stamp,siteId:deps.siteId,keyName:HERE_NOW_KEY_NAME,stage:'requesting'}};
  store.update(state=>{if(state.accounts.some(value=>value.channelId==='here-now'&&value.email.trim().toLowerCase()===email))throw Error('here.now 同邮箱已有连接记录；不会重新请求验证码');state.accounts.push(account)});
  try{
    const url=endpoint('request-code'),{response}=await fetchHereNowBounded(url,requestInit({email}),deps,8192);
    if(response.status!==200||response.redirected||response.url!==url)throw Error('request rejected');
    store.update(state=>{const saved=state.accounts.find(value=>value.id===id);if(saved?.hereNowEmail?.stage!=='requesting'||saved.email!==email)throw Error('here.now 连接已变化');saved.hereNowEmail.stage='code_sent';saved.updatedAt=(deps.now?.()??new Date()).toISOString();markCodePending(state,saved,deps.now?.()??new Date())});
  }catch{
    store.update(state=>{const saved=state.accounts.find(value=>value.id===id);if(saved?.hereNowEmail?.stage==='requesting')saved.hereNowEmail.stage='request_unknown'});
    throw Error('here.now 验证码请求结果不明；已保留原连接，不会自动重发');
  }
  return store.read().accounts.find(value=>value.id===id)!;
}

/** Explicit renewal after the local wait ends; never retry an uncertain request. */
export async function resendHereNowCode(store:StateStore,accountId:string,deps:HereNowDependencies={}):Promise<Account>{
  const before=store.read(),account=before.accounts.find(value=>value.id===accountId&&value.channelId==='here-now'),journal=account?.hereNowEmail,now=deps.now?.()??new Date(),requested=Date.parse(journal?.requestedAt??'');
  const publication=before.tasks.some(task=>task.channelId==='here-now'&&(task.accountId===accountId||task.hereNow?.accountId===accountId)&&(!!task.hereNow||!!task.submittedAt||!!task.publicUrl||!!task.firstLiveAt||!!task.publicationMethod||!!store.getCipher(`publication:${task.id}`)));
  if(deps.signal?.aborted||!account||account.status!=='needs_verification'||account.hasPassword||account.verifiedAt||account.registeredAt||account.hereNow||!journal||journal.stage!=='code_sent'||journal.keyName!==HERE_NOW_KEY_NAME||journal.emailHash!==hereNowSha256(account.email)||!Number.isFinite(requested)||now.getTime()-requested<=HERE_NOW_EMAIL_WAIT_MS||journal.previousRequestedAt!==undefined&&!(Date.parse(journal.previousRequestedAt)<requested)||store.getCipher(`account:${accountId}`)||store.getCipher(hereNowVerifyKey(accountId))||publication)throw Error('here.now 仅允许原账号在本地十分钟等待结束、未验证且没有不明结果时重新取码');
  const requestedAt=now.toISOString();
  store.update(state=>{const saved=state.accounts.find(value=>value.id===accountId);if(JSON.stringify(saved)!==JSON.stringify(account))throw Error('here.now 原连接已变化');saved!.hereNowEmail={...journal,previousRequestedAt:journal.requestedAt,requestedAt,stage:'requesting'};saved!.updatedAt=requestedAt});
  try{
    const url=endpoint('request-code'),{response}=await fetchHereNowBounded(url,requestInit({email:account.email}),deps,8192);
    if(response.status!==200||response.redirected||response.url!==url)throw Error('request rejected');
    store.update(state=>{const saved=state.accounts.find(value=>value.id===accountId);if(saved?.hereNowEmail?.stage!=='requesting'||saved.hereNowEmail.requestedAt!==requestedAt||saved.email!==account.email)throw Error('here.now 原连接已变化');saved.hereNowEmail.stage='code_sent';markCodePending(state,saved,now)});
  }catch{
    store.update(state=>{const saved=state.accounts.find(value=>value.id===accountId);if(saved?.hereNowEmail?.stage==='requesting'&&saved.hereNowEmail.requestedAt===requestedAt)saved.hereNowEmail.stage='request_unknown'});
    throw Error('here.now 重新取码结果不明；已保留本次和前次请求时间，不会自动重试');
  }
  return store.read().accounts.find(value=>value.id===accountId)!;
}

export function parseHereNowVerifyOpaque(raw:string,emailHash:string){return parseShiplyVerifyOpaque(raw,emailHash)}
export function parseHereNowVerifySecret(raw:string,emailHash:string):{apiKey:string}|undefined{
  try{
    const opaque=parseHereNowVerifyOpaque(raw,emailHash);
    if(!opaque||opaque.status!==200||opaque.redirected||opaque.responseUrl!==endpoint('verify-code')||opaque.contentType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(opaque.bytes));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.hasOwn(value,'keyMintError')||!validHereNowApiKey(value.apiKey)||Object.hasOwn(value,'email')&&(typeof value.email!=='string'||hereNowSha256(value.email.trim().toLowerCase())!==emailHash)||Object.hasOwn(value,'keyReused')&&typeof value.keyReused!=='boolean')return;
    return {apiKey:value.apiKey};
  }catch{return}
}

export async function recoverHereNowVerifiedResponse(store:StateStore,vault:AtomicVault,input:{accountId:string;siteIds:string[]},deps:HereNowDependencies={}):Promise<Account>{
  const before=store.read(),account=before.accounts.find(value=>value.id===input.accountId&&value.channelId==='here-now'),journal=account?.hereNowEmail;
  if(!account||!journal||journal.stage!=='verify_opaque'||journal.emailHash!==hereNowSha256(account.email)||journal.keyName!==HERE_NOW_KEY_NAME)throw Error('here.now 原验证响应不存在或邮箱已改变');
  if(input.siteIds.some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站不存在');
  const raw=await vault.get(hereNowVerifyKey(account.id)),parsed=raw&&parseHereNowVerifySecret(raw,journal.emailHash);
  if(!parsed)throw Error('here.now 命名 key 未能安全确认；原响应已加密保留，不会重发验证码');
  const identity=await inspectHereNowIdentity(parsed.apiKey,undefined,deps);
  if(identity.email!==account.email)throw Error('here.now 验证邮箱与个人账户不一致');
  const key=`account:${account.id}`,ciphers=vault.encryptSecrets({[key]:parsed.apiKey});
  if(!ciphers[key]||ciphers[key]===parsed.apiKey)throw Error('here.now 命名 key 未加密');
  store.updateWithCiphers(state=>{
    const saved=state.accounts.find(value=>value.id===account.id);
    if(deps.signal?.aborted||JSON.stringify(saved)!==JSON.stringify(account))throw Error('here.now 验证期间连接已变化');
    if(state.accounts.some(value=>value.id!==account.id&&value.channelId==='here-now'&&(value.email.trim().toLowerCase()===identity.email||value.hereNow?.accountId===identity.accountId)))throw Error('here.now 个人账户连接不唯一');
    const stamp=(deps.now?.()??new Date()).toISOString();
    Object.assign(saved!,{username:identity.accountId,displayName:identity.displayName,status:'registered',source:'imported',hasPassword:true,updatedAt:stamp,verifiedAt:stamp,registeredAt:stamp,
      hereNow:{version:1,checkedAt:stamp,accountId:identity.accountId,keyFingerprint:identity.keyFingerprint,identity:'verified_personal'},hereNowEmail:{...journal,stage:'ready'}});
    const channel=CHANNELS.find(value=>value.id==='here-now')!;
    for(const siteId of input.siteIds)bindAccount(state,account.id,siteId,channel);
  },ciphers);
  return store.read().accounts.find(value=>value.id===account.id)!;
}

export async function verifyHereNowCode(store:StateStore,vault:AtomicVault,input:{accountId:string;code:string;siteIds:string[]},deps:HereNowDependencies={}):Promise<Account>{
  if(!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(input.code))throw Error('here.now 需要 ABCD-2345 格式的邮箱验证码');
  const account=store.read().accounts.find(value=>value.id===input.accountId&&value.channelId==='here-now'),journal=account?.hereNowEmail,age=(deps.now?.()??new Date()).getTime()-Date.parse(journal?.requestedAt??'');
  if(!account||!journal||journal.stage!=='code_sent'||journal.emailHash!==hereNowSha256(account.email)||journal.keyName!==HERE_NOW_KEY_NAME||journal.previousRequestedAt!==undefined&&!(Date.parse(journal.previousRequestedAt)<Date.parse(journal.requestedAt))||!Number.isFinite(age)||age<0||age>=HERE_NOW_EMAIL_WAIT_MS||deps.signal?.aborted)throw Error('here.now 验证码状态已变化或已超过本地十分钟等待上限');
  if(input.siteIds.some(id=>!store.read().sites.some(site=>site.id===id)))throw Error('所选网站不存在');
  store.update(state=>{const saved=state.accounts.find(value=>value.id===account.id);if(JSON.stringify(saved)!==JSON.stringify(account))throw Error('here.now 连接已变化');saved!.hereNowEmail!.stage='verifying'});
  let response:Response,bytes:Uint8Array;
  try{({response,bytes}=await fetchHereNowBounded(endpoint('verify-code'),requestInit({email:account.email,code:input.code,keyName:HERE_NOW_KEY_NAME}),deps,8192))}
  catch{store.update(state=>{const saved=state.accounts.find(value=>value.id===account.id);if(saved?.hereNowEmail?.stage==='verifying')saved.hereNowEmail.stage='verify_unknown'});throw Error('here.now 验证结果不明；不会重发一次性验证码')}
  const raw=JSON.stringify({version:1,status:response.status,responseUrl:response.url,redirected:response.redirected,contentType:response.headers.get('content-type')??'',bodyBase64:Buffer.from(bytes).toString('base64'),bodyHash:hereNowSha256(bytes),emailHash:journal.emailHash}),key=hereNowVerifyKey(account.id),ciphers=vault.encryptSecrets({[key]:raw});
  if(!ciphers[key]||ciphers[key]===raw)throw Error('here.now 原始验证响应未加密');
  store.updateWithCiphers(state=>{const saved=state.accounts.find(value=>value.id===account.id);if(saved?.hereNowEmail?.stage!=='verifying'||saved.email!==account.email)throw Error('here.now 连接已变化');saved.hereNowEmail.stage='verify_opaque'},ciphers);
  return recoverHereNowVerifiedResponse(store,vault,input,deps);
}
