import {createHash,randomUUID} from 'node:crypto';
import type {Channel,Task} from '../shared/types';
import type {State,Store} from './store';
import type {Vault} from './vault';
import {articleReviewStillValid} from './article-review';
import {clawprintSingleArticleCandidate,currentArticlePublicationContext} from './article-publication-context';
import {connectedRequest,parseConnectedJson,type ConnectedResponse} from '../integrations/batch5-connected';
import {probeClawprintToken} from './clawprint-publisher';
import type {Batch5Dependencies} from '../integrations/batch5-contract';

const ORIGIN='https://clawprint.org',URL=`${ORIGIN}/api/register`;
const NAME=/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const TOKEN=/^[^\s\u0000-\u001f\u007f]{16,8192}$/;
const SHA=/^[a-f0-9]{64}$/;
const stamp=(now?:()=>Date)=>(now?.()??new Date()).toISOString();
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
type Stage='reserved'|'sending'|'opaque'|'ready';
interface Intent {version:1;accountId:string;taskId:string;siteId:string;name:string;bio:string;requestHash:string;createdAt:string}
interface Opaque {status:number;contentType:string;responseUrl:string;bodyBase64:string}
export interface ClawprintRegistrationJournal {version:1;stage:Stage;intent:Intent;opaque?:Opaque;verifiedAt?:string}
type Storage=Pick<Store,'read'|'getCipher'|'updateWithCiphers'>;
type Secrets=Pick<Vault,'get'|'encryptSecrets'>;
// A new signup is closed until its first real acceptance. The controller never sets this; only a saved original journal may continue.
export interface ClawprintOnboardingOptions {taskId:string;channel:Channel;signal:AbortSignal;assertAuthorized:(state:State,task:Task)=>void;dependencies?:Batch5Dependencies;now?:()=>Date;allowNewRegistration?:boolean}
export type ClawprintOnboardingResult={status:'ready';accountId:string;created:boolean}|{status:'pending'|'blocked';message:string};

export function parseClawprintRegistrationJournal(raw:string|undefined):ClawprintRegistrationJournal|undefined{
  if(!raw||raw.length>32_768)return;
  let value:unknown;try{value=JSON.parse(raw)}catch{return}
  if(!object(value)||value.version!==1||!['reserved','sending','opaque','ready'].includes(String(value.stage))||!object(value.intent))return;
  const i=value.intent;
  if(i.version!==1||![i.accountId,i.taskId,i.siteId].every(item=>typeof item==='string'&&/^[0-9a-f-]{36}$/i.test(item))
    ||typeof i.name!=='string'||!NAME.test(i.name)||typeof i.bio!=='string'||!i.bio||i.bio.length>300
    ||typeof i.requestHash!=='string'||!SHA.test(i.requestHash)||typeof i.createdAt!=='string'||!Number.isFinite(Date.parse(i.createdAt))
    ||hash(JSON.stringify({name:i.name,bio:i.bio}))!==i.requestHash)return;
  if(value.opaque!==undefined){const o=value.opaque;if(!object(o)||!Number.isSafeInteger(o.status)||Number(o.status)<100||Number(o.status)>599
    ||typeof o.contentType!=='string'||o.contentType.length>200||o.responseUrl!==URL||typeof o.bodyBase64!=='string'||o.bodyBase64.length>24_000
    ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(o.bodyBase64))return;
    if(Buffer.from(o.bodyBase64,'base64').toString('base64')!==o.bodyBase64)return;
  }
  if((value.stage==='reserved'||value.stage==='sending')&&value.opaque!==undefined||value.stage==='opaque'&&!value.opaque||value.stage==='ready'&&(!value.opaque||typeof value.verifiedAt!=='string'||!Number.isFinite(Date.parse(value.verifiedAt))))return;
  return value as unknown as ClawprintRegistrationJournal;
}
export function clawprintRegistrationBackupMatches(raw:string|undefined,token:string|undefined,rotated=false):boolean{
  const journal=parseClawprintRegistrationJournal(raw);if(!journal)return false;
  if(journal.stage!=='ready')return token===undefined;
  if(!journal.opaque||!token||!TOKEN.test(token))return false;
  if(rotated)return true;
  try{return fromOpaque(journal.opaque,journal.intent)?.token===token}catch{return false}
}

function current(state:State,options:ClawprintOnboardingOptions,requireReview=true):{task:Task;site:State['sites'][number]}{
  const task=state.tasks.find(item=>item.id===options.taskId),site=state.sites.find(item=>item.id===task?.siteId);
  if(!task||!site||task.channelId!=='clawprint'||options.channel.id!=='clawprint'||options.channel.enabled!==true
    ||options.channel.automation!=='api'||options.channel.singleSiteOnly!==true||site.status!=='ready'
    ||task.publicUrl||task.submittedAt||!clawprintSingleArticleCandidate(state.tasks,task,site,options.channel)
    ||!task.clawprintOriginalPurpose||!task.draft
    ||requireReview&&!articleReviewStillValid(task,site,options.channel,state.settings,state.accounts.find(item=>item.id===task.accountId),currentArticlePublicationContext(state.tasks,task)))throw Error('Clawprint 当前原创稿或复核资格无效');
  options.assertAuthorized(state,task);
  return {task,site};
}
function registration(value:ConnectedResponse,intent:Intent):{token:string;remoteId:number}|undefined{
  if(value.status!==200||value.url!==URL)return;
  const parsed=parseConnectedJson(value);
  if(!parsed||parsed.name!==intent.name||!Number.isSafeInteger(parsed.user_id)||Number(parsed.user_id)<=0
    ||typeof parsed.api_key!=='string'||!TOKEN.test(parsed.api_key))return;
  return {token:parsed.api_key,remoteId:parsed.user_id as number};
}
function fromOpaque(opaque:Opaque,intent:Intent):{token:string;remoteId:number}|undefined{
  const bytes=Buffer.from(opaque.bodyBase64,'base64');
  return registration({status:opaque.status,url:opaque.responseUrl,contentType:opaque.contentType,body:new TextDecoder('utf-8',{fatal:true}).decode(bytes),robotsHeader:''},intent);
}
function encrypted(vault:Secrets,key:string,value:string):string{
  const cipher=vault.encryptSecrets({[key]:value})[key];if(!cipher||cipher===value)throw Error('Clawprint 事务未加密');return cipher;
}
/** One owner, one durable signup dispatch. Existing token connections never enter this path. */
export async function reserveClawprintAccount(store:Storage,vault:Secrets,options:ClawprintOnboardingOptions):Promise<ClawprintOnboardingResult>{
  const initial=store.read(),{site}=current(initial,options,false),key=`clawprint:identity:${site.id}`;
  const existing=initial.accounts.filter(account=>account.channelId==='clawprint'&&!account.retiredAt);
  const owned=existing.find(account=>account.status==='registered'&&account.hasPassword&&account.credentialKind==='api_token'&&account.ownerSiteId===site.id);
  if(owned&&!initial.accountBindings.some(binding=>binding.accountId===owned.id&&binding.siteId===site.id&&binding.channelId==='clawprint'))return {status:'blocked',message:'Clawprint 账号已断开，请先重新连接'};
  if(owned)return {status:'ready',accountId:owned.id,created:false};
  let journal=parseClawprintRegistrationJournal(await vault.get(key));
  if(store.getCipher(key)&&!journal)return {status:'blocked',message:'Clawprint 原加密注册记录无效，保留现场等待人工核对'};
  if(!journal){
    if(existing.length||initial.accountBindings.some(binding=>binding.channelId==='clawprint'))return {status:'blocked',message:'Clawprint 已有发布账号，必须复用或核对原账号'};
    if(!options.allowNewRegistration)return {status:'blocked',message:'Clawprint 需先连接已注册的 API key；验收前不会自动开户'};
    const accountId=randomUUID(),name=`SoftwareAgent_${accountId.replaceAll('-','').slice(0,12)}`;
    const bio=`AI agent documenting software work for ${site.name} (${site.url}). Project relationship is disclosed in each article.`.slice(0,300);
    const intent:Intent={version:1,accountId,taskId:options.taskId,siteId:site.id,name,bio,requestHash:hash(JSON.stringify({name,bio})),createdAt:stamp(options.now)};
    journal={version:1,stage:'reserved',intent};const raw=JSON.stringify(journal),cipher=encrypted(vault,key,raw);
    store.updateWithCiphers(state=>{const {task,site:liveSite}=current(state,options,false);if(store.getCipher(key)||state.accounts.some(item=>item.channelId==='clawprint')||state.accountBindings.some(item=>item.channelId==='clawprint')||task.accountId)throw Error('Clawprint 已有发布账号');
      state.accounts.push({id:accountId,channelId:'clawprint',ownerSiteId:liveSite.id,email:'',username:name,displayName:name,createdAt:intent.createdAt,status:'unknown',hasPassword:false,source:'generated',credentialKind:'api_token',registrationAttempts:1});
      state.accountBindings.push({id:randomUUID(),siteId:liveSite.id,channelId:'clawprint',accountId,createdAt:intent.createdAt,updatedAt:intent.createdAt});task.accountId=accountId;task.checkpoint='clawprint_account_reserved';
    },{[key]:cipher},[],{[key]:undefined});
  }
  const intent=journal.intent;
  if(intent.siteId!==site.id||intent.taskId!==options.taskId)return {status:'blocked',message:'Clawprint 原账号事务归属不同任务，已停止'};
  return {status:'pending',message:'Clawprint 同一发布账号已加密保留，待原创稿复核通过后注册'};
}

export async function onboardClawprintAccount(store:Storage,vault:Secrets,options:ClawprintOnboardingOptions):Promise<ClawprintOnboardingResult>{
  const reserved=await reserveClawprintAccount(store,vault,options);
  if(reserved.status==='ready'||reserved.status==='blocked')return reserved;
  const state=store.read(),{site}=current(state,options),key=`clawprint:identity:${site.id}`;
  let journal=parseClawprintRegistrationJournal(await vault.get(key));
  if(!journal||journal.intent.taskId!==options.taskId)return {status:'blocked',message:'Clawprint 加密注册记录缺失或归属不符'};
  const intent=journal.intent;
  if(journal.stage==='ready')return {status:'blocked',message:'Clawprint 原注册记录已完成，但本地账号状态不一致'};
  if(journal.stage==='reserved'){
    const next:ClawprintRegistrationJournal={...journal,stage:'sending'},raw=JSON.stringify(next),cipher=encrypted(vault,key,raw),expected=store.getCipher(key);
    store.updateWithCiphers(state=>{const {task}=current(state,options);if(task.accountId!==intent.accountId||!state.accounts.some(a=>a.id===intent.accountId&&a.channelId==='clawprint'&&a.status==='unknown')||store.getCipher(key)!==expected)throw Error('Clawprint 注册授权已改变');task.checkpoint='clawprint_account_sending';}, {[key]:cipher},[],{[key]:expected});
    journal=next;
    let response:ConnectedResponse;
    try{response=await connectedRequest(URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify({name:intent.name,bio:intent.bio})},options.dependencies??{},options.signal,16_384)}
    catch{return {status:'pending',message:'Clawprint 单次注册结果不明；原账号与加密意图已保留，不会重发'}};
    const opaque:Opaque={status:response.status,contentType:response.contentType,responseUrl:response.url,bodyBase64:Buffer.from(response.body,'utf8').toString('base64')};
    const saved:ClawprintRegistrationJournal={...journal,stage:'opaque',opaque},savedRaw=JSON.stringify(saved),savedCipher=encrypted(vault,key,savedRaw),prior=store.getCipher(key);
    try{store.updateWithCiphers(state=>{const task=state.tasks.find(item=>item.id===intent.taskId),account=state.accounts.find(item=>item.id===intent.accountId),binding=state.accountBindings.find(item=>item.siteId===intent.siteId&&item.channelId==='clawprint');
      if(prior!==cipher||store.getCipher(key)!==prior||!task||task.siteId!==intent.siteId||task.channelId!=='clawprint'||task.accountId!==intent.accountId
        ||!account||account.channelId!=='clawprint'||account.ownerSiteId!==intent.siteId||account.username!==intent.name||account.status!=='unknown'||account.hasPassword||account.registrationAttempts!==1
        ||binding?.accountId!==intent.accountId)throw Error('Clawprint 原响应保存条件已改变');task.checkpoint='clawprint_account_opaque';},{[key]:savedCipher},[],{[key]:prior});journal=saved}
    catch{return {status:'pending',message:'Clawprint 注册响应保存不明；不会重新注册'}};
  }
  if(journal.stage!=='opaque'||!journal.opaque)return {status:'pending',message:'Clawprint 原注册结果待核对；不会重新注册'};
  let receipt:{token:string;remoteId:number}|undefined;try{receipt=fromOpaque(journal.opaque,intent)}catch{}
  if(!receipt)return {status:'pending',message:'Clawprint 原注册响应未确认成功；不会重新注册'};
  try{current(store.read(),options)}catch{return {status:'pending',message:'Clawprint 原注册响应已加密保留；恢复原稿与授权后再只读核对'}}
  try{const identity=await probeClawprintToken(receipt.token,options.dependencies,options.signal);if(identity.name!==intent.name||identity.userId!==receipt.remoteId)throw Error('identity_mismatch')}
  catch{return {status:'pending',message:'Clawprint 原账号尚未通过只读核对；不会重新注册'}};
  const verifiedAt=stamp(options.now),ready:ClawprintRegistrationJournal={...journal,stage:'ready',verifiedAt};
  const journalCipher=encrypted(vault,key,JSON.stringify(ready)),accountKey=`account:${intent.accountId}`,tokenCipher=encrypted(vault,accountKey,receipt.token),prior=store.getCipher(key);
  try{store.updateWithCiphers(state=>{const {task}=current(state,options),account=state.accounts.find(item=>item.id===intent.accountId),binding=state.accountBindings.find(item=>item.siteId===site.id&&item.channelId==='clawprint');if(task.accountId!==intent.accountId||!account||account.status!=='unknown'||account.hasPassword||account.username!==intent.name||account.ownerSiteId!==intent.siteId||account.source!=='generated'||account.registrationAttempts!==1||binding?.accountId!==intent.accountId||store.getCipher(key)!==prior||store.getCipher(accountKey))throw Error('Clawprint 原账号提升条件已改变');
    Object.assign(account,{status:'registered',hasPassword:true,registeredAt:intent.createdAt,verifiedAt,updatedAt:verifiedAt,publicationUrl:`${ORIGIN}/u/${encodeURIComponent(intent.name)}`});task.checkpoint='clawprint_account_ready';
  },{[key]:journalCipher,[accountKey]:tokenCipher},[],{[key]:prior,[accountKey]:undefined})}
  catch{return {status:'pending',message:'Clawprint 已核实原账号，但加密保存未完成；只可从原响应恢复'}};
  return {status:'ready',accountId:intent.accountId,created:true};
}
