import {createHash,randomUUID} from 'node:crypto';
import type {Store,State} from './store';
import type {Vault} from './vault';
import type {Account,Site,Task} from '../shared/types';
import {AGENTEL_API,type AgentelCredential,type AgentelEncryptedJournal,type AgentelIdentity,type AgentelJournal,type AgentelArticle} from '../integrations/agentel';

const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern=/^[^\s\u0000-\u001f\u007f]{12,8192}$/;
const agentId=/^agent_[A-Za-z0-9-]{3,100}$/;
const updateId=/^(?:update|post)_[A-Za-z0-9-]{3,100}$/;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keyFor=(kind:'register'|'publish',id:string)=>kind==='register'?`agentel:identity:${id}`:`publication:${id}`;

export function parseAgentelJournal(raw:string|undefined):AgentelJournal|undefined{
  if(!raw||raw.length>600_000)return;
  let value:unknown;try{value=JSON.parse(raw)}catch{return}
  if(!object(value)||value.version!==1||!['reserved','sending','opaque','verified'].includes(String(value.stage))||!object(value.intent))return;
  const i=value.intent;if(i.version!==1||!['register','publish'].includes(String(i.kind))||typeof i.operationId!=='string'||!uuid.test(i.operationId)
    ||typeof i.siteId!=='string'||!uuid.test(i.siteId)||i.kind==='register'&&i.taskId!==undefined||i.kind==='publish'&&(typeof i.taskId!=='string'||!uuid.test(i.taskId))
    ||typeof i.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(i.requestHash)||!object(i.payload)||sha(JSON.stringify(i.payload))!==i.requestHash
    ||typeof i.createdAt!=='string'||!Number.isFinite(Date.parse(i.createdAt))||i.kind==='publish'&&(!agentId.test(String(i.agentId))||typeof (i.payload as Record<string,unknown>).content!=='string')
    ||i.kind==='register'&&i.agentId!==undefined)return;
  if(value.stage==='reserved'||value.stage==='sending'){if(value.opaque!==undefined||value.verifiedAt!==undefined)return}
  else {const o=value.opaque;if(!object(o)||!Number.isSafeInteger(o.status)||Number(o.status)<100||Number(o.status)>599
    ||o.url!==(i.kind==='register'?`${AGENTEL_API}/agents/register`:`${AGENTEL_API}/agents/${i.agentId}/updates`)
    ||typeof o.contentType!=='string'||o.contentType.length>256||typeof o.bodyBase64!=='string'||o.bodyBase64.length>512_000
    ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(o.bodyBase64)
    ||Buffer.from(o.bodyBase64,'base64').toString('base64')!==o.bodyBase64)return;
    if(value.stage==='verified'&&(typeof value.verifiedAt!=='string'||!Number.isFinite(Date.parse(value.verifiedAt))))return;
  }
  return value as unknown as AgentelJournal;
}
export function parseAgentelCredential(raw:string|undefined):AgentelCredential|undefined{
  let value:unknown;try{value=JSON.parse(raw??'')}catch{return}
  if(!object(value)||value.version!==1||typeof value.agentId!=='string'||!agentId.test(value.agentId)
    ||typeof value.slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug)||typeof value.apiKey!=='string'||!keyPattern.test(value.apiKey))return;
  return {agentId:value.agentId,slug:value.slug,apiKey:value.apiKey};
}
function responseJson(journal:AgentelJournal):Record<string,unknown>|undefined{
  if(!journal.opaque)return;try{const value=JSON.parse(Buffer.from(journal.opaque.bodyBase64,'base64').toString('utf8'));return object(value)?value:undefined}catch{return}
}
function registrationCredential(journal:AgentelJournal):AgentelCredential|undefined{
  if(journal.intent.kind!=='register'||!journal.opaque||![200,201].includes(journal.opaque.status))return;
  const parsed=responseJson(journal),agent=parsed?.agent,credential=parsed?.credential,slug=(journal.intent.payload as AgentelIdentity).slug;
  if(!object(agent)||!object(credential)||!agentId.test(String(agent.id))||agent.slug!==slug||!keyPattern.test(String(credential.key)))return;
  return {agentId:agent.id as string,slug,apiKey:credential.key as string};
}
function publicationUrl(journal:AgentelJournal):string|undefined{
  if(journal.intent.kind!=='publish'||!journal.opaque||![200,201].includes(journal.opaque.status))return;
  const update=responseJson(journal)?.update;
  return object(update)&&typeof update.id==='string'&&updateId.test(update.id)&&(!update.agentId||update.agentId===journal.intent.agentId)?`https://agentel.tech/thread/${update.id}`:undefined;
}
export function agentelBackupMatches(task:Task,raw:string|undefined,account:Account|undefined,accountSecret:string|undefined):boolean{
  const journal=parseAgentelJournal(raw),credential=parseAgentelCredential(accountSecret),summary=task.batch5;
  if(!journal||journal.intent.kind!=='publish'||journal.intent.taskId!==task.id||journal.intent.siteId!==task.siteId||task.channelId!=='agentel'
    ||!task.accountId||!account||account.id!==task.accountId||account.channelId!=='agentel'||account.ownerSiteId!==task.siteId||account.username!==credential?.slug
    ||!credential||journal.intent.agentId!==credential.agentId||!summary||summary.accountId!==account.id||summary.operationId!==journal.intent.operationId
    ||summary.channelId!=='agentel'||summary.sourceHash!==sha((journal.intent.payload as AgentelArticle).content)
    ||summary.requestHash!==journal.intent.requestHash||summary.createdAt!==journal.intent.createdAt)return false;
  if(journal.stage==='verified'){const url=publicationUrl(journal);return !!url&&['api_receipt','published'].includes(summary.stage)&&summary.publicUrl===url&&task.publicUrl===url&&task.submittedAt===journal.intent.createdAt}
  if(journal.stage==='reserved')return summary.stage==='reserved'&&!task.submittedAt&&!task.publicUrl&&!summary.publicUrl;
  return summary.stage===(journal.stage==='sending'?'submitting':'opaque_response')&&task.submittedAt===journal.intent.createdAt&&!task.publicUrl&&!summary.publicUrl;
}
export function agentelRegistrationBackupMatches(account:Account,raw:string|undefined,secret:string|undefined):boolean{
  const journal=parseAgentelJournal(raw);if(!journal||journal.intent.kind!=='register'||journal.intent.siteId!==account.ownerSiteId||account.channelId!=='agentel'||account.username!==(journal.intent.payload as AgentelIdentity).slug)return false;
  if(journal.stage==='verified'){const credential=registrationCredential(journal),saved=parseAgentelCredential(secret);return !!credential&&!!saved&&same(credential,saved)&&account.status==='registered'&&account.hasPassword}
  return account.status==='unknown'&&!account.hasPassword&&!secret;
}

interface Options {siteId:string;accountId:string;taskId?:string;identity?:AgentelIdentity;article?:AgentelArticle;credential?:AgentelCredential;authorize:(state:State,task:Task|undefined,stage:AgentelJournal['stage'])=>void}
type Storage=Pick<Store,'read'|'getCipher'|'updateWithCiphers'>;
type Secrets=Pick<Vault,'get'|'encryptSecrets'>;
export function createAgentelEncryptedJournal(store:Storage,vault:Secrets,options:Options):AgentelEncryptedJournal{
  const kind=options.taskId?'publish':'register',key=keyFor(kind,options.taskId??options.siteId);
  const expectedPayload=options.taskId?options.article:options.identity;
  if(!expectedPayload||kind==='publish'&&(!options.credential||options.credential.slug.length<2))throw Error('agentel_original_payload_missing');
  const encrypt=(name:string,value:string)=>{const cipher=vault.encryptSecrets({[name]:value})[name];if(!cipher||cipher===value)throw Error('agentel_cipher_unavailable');return cipher};
  const owner=(state:State,original:AgentelJournal)=>{
    const account=state.accounts.find(a=>a.id===options.accountId),binding=state.accountBindings.find(b=>b.siteId===options.siteId&&b.channelId==='agentel');
    if(!account||account.channelId!=='agentel'||account.ownerSiteId!==options.siteId||account.username!==(kind==='register'?(expectedPayload as AgentelIdentity).slug:options.credential!.slug)
      ||binding?.accountId!==account.id||account.retiredAt||original.intent.siteId!==options.siteId||original.intent.taskId!==options.taskId||original.intent.kind!==kind
      ||original.intent.requestHash!==sha(JSON.stringify(expectedPayload))||!same(original.intent.payload,expectedPayload)||kind==='publish'&&original.intent.agentId!==options.credential!.agentId)throw Error('agentel_original_identity_changed');
    const task=options.taskId?state.tasks.find(t=>t.id===options.taskId):undefined;
    if(options.taskId&&(!task||task.channelId!=='agentel'||task.siteId!==options.siteId||task.accountId!==account.id))throw Error('agentel_original_task_changed');
    return {account,task};
  };
  return {
    load:async()=>{const raw=await vault.get(key),value=parseAgentelJournal(raw);if(raw&&!value)throw Error('agentel_original_journal_invalid');return value},
    save:async(next,previous)=>{
      if(next.intent.kind!==kind||next.intent.siteId!==options.siteId||next.intent.taskId!==options.taskId||next.intent.requestHash!==sha(JSON.stringify(expectedPayload))||!same(next.intent.payload,expectedPayload)
        ||!parseAgentelJournal(JSON.stringify(next))||previous&&!parseAgentelJournal(JSON.stringify(previous)))throw Error('agentel_journal_invalid');
      const current=await vault.get(key),saved=parseAgentelJournal(current),expected=store.getCipher(key);
      if(!same(saved,previous)||!!expected!==!!previous)throw Error('agentel_journal_cas_changed');
      const stage=next.stage,prior=previous?.stage;
      if(!((!prior&&stage==='reserved')||(prior==='reserved'&&stage==='sending')||(prior==='sending'&&stage==='opaque')||(prior==='opaque'&&stage==='verified'))
        ||previous&&(!same(previous.intent,next.intent)||prior==='opaque'&&(!next.opaque||!same(previous.opaque,next.opaque))))throw Error('agentel_journal_transition_invalid');
      const cipher=encrypt(key,JSON.stringify(next)),accountKey=`account:${options.accountId}`;
      const credential=stage==='verified'&&kind==='register'?registrationCredential(next):undefined;
      const url=stage==='verified'&&kind==='publish'?publicationUrl(next):undefined;
      if(stage==='verified'&&(kind==='register'&&!credential||kind==='publish'&&!url))throw Error('agentel_verified_response_invalid');
      const tokenCipher=credential?encrypt(accountKey,JSON.stringify({version:1,...credential})):undefined;
      const summary=(stage:AgentelJournal['stage'],url?:string):NonNullable<Task['batch5']>=>({version:1,channelId:'agentel',operationId:next.intent.operationId,sourceHash:sha((next.intent.payload as AgentelArticle).content),requestHash:next.intent.requestHash,createdAt:next.intent.createdAt,stage:stage==='reserved'?'reserved':stage==='sending'?'submitting':stage==='opaque'?'opaque_response':'api_receipt',accountId:options.accountId,...(url?{publicUrl:url}:{})});
      store.updateWithCiphers(state=>{
        let account:Account,task:Task|undefined;
        if(!previous&&kind==='register'){
          if(state.accounts.some(a=>a.channelId==='agentel'&&!a.retiredAt)||state.accountBindings.some(b=>b.channelId==='agentel')||!state.sites.some(s=>s.id===options.siteId&&s.status==='ready')||store.getCipher(key))throw Error('agentel_existing_identity');
          options.authorize(state,undefined,stage);const identity=expectedPayload as AgentelIdentity;account={id:options.accountId,channelId:'agentel',ownerSiteId:options.siteId,email:'',username:identity.slug,displayName:identity.name,publicationUrl:'https://agentel.tech/',createdAt:next.intent.createdAt,status:'unknown',hasPassword:false,source:'generated',credentialKind:'api_token',registrationAttempts:1};
          state.accounts.push(account);state.accountBindings.push({id:randomUUID(),siteId:options.siteId,channelId:'agentel',accountId:account.id,createdAt:next.intent.createdAt,updatedAt:next.intent.createdAt});
        }else ({account,task}=owner(state,next));
        if(store.getCipher(key)!==expected)throw Error('agentel_journal_cas_changed');
        if(stage==='reserved'&&kind==='publish'){if(!task||task.batch5||task.submittedAt||task.publicUrl||store.getCipher(key))throw Error('agentel_publication_started');options.authorize(state,task,stage);task.batch5=summary(stage);task.checkpoint='agentel_reserved'}
        if(stage==='sending'){if(kind==='register'&&account.status!=='unknown'||kind==='publish'&&(!task||task.submittedAt||task.publicUrl))throw Error('agentel_send_state_changed');options.authorize(state,task,stage);if(task){task.batch5=summary(stage);task.submittedAt=next.intent.createdAt;task.checkpoint='agentel_sending'}}
        if(stage==='opaque'){if(kind==='register'&&(account.status!=='unknown'||account.hasPassword)||kind==='publish'&&(!task||task.submittedAt!==next.intent.createdAt||task.publicUrl))throw Error('agentel_response_identity_changed');if(task){task.batch5=summary(stage);task.checkpoint='agentel_opaque'}}
        if(stage==='verified'){options.authorize(state,task,stage);if(kind==='register'){if(account.status!=='unknown'||account.hasPassword||store.getCipher(accountKey))throw Error('agentel_account_promotion_changed');Object.assign(account,{status:'registered',hasPassword:true,registeredAt:next.intent.createdAt,verifiedAt:next.verifiedAt,updatedAt:next.verifiedAt})}
          else {if(!task||task.submittedAt!==next.intent.createdAt||task.publicUrl)throw Error('agentel_publication_promotion_changed');task.batch5=summary(stage,url);task.publicUrl=url;task.status='review';task.checkpoint='agentel_public_verified'}}
      },{[key]:cipher,...(tokenCipher?{[accountKey]:tokenCipher}:{})},[],{[key]:expected,...(tokenCipher?{[accountKey]:undefined}:{})});
    },
  };
}

/** Reserves a provisional local identity before article review; this function never calls Agentel. */
export async function reserveAgentelAccount(store:Storage,vault:Secrets,options:Options):Promise<{status:'ready';accountId:string}|{status:'pending';accountId:string}> {
  if(options.taskId||!options.identity)throw Error('agentel_registration_options_invalid');
  const state=store.read(),existing=state.accounts.filter(a=>a.channelId==='agentel'&&!a.retiredAt);
  const ready=existing.find(a=>a.ownerSiteId===options.siteId&&a.status==='registered'&&a.hasPassword&&a.credentialKind==='api_token');
  if(ready){if(!state.accountBindings.some(b=>b.siteId===options.siteId&&b.channelId==='agentel'&&b.accountId===ready.id))throw Error('agentel_original_binding_missing');return {status:'ready',accountId:ready.id}};
  if(existing.length){const account=existing.find(a=>a.id===options.accountId&&a.ownerSiteId===options.siteId&&a.status==='unknown'&&a.registrationAttempts===1);
    const raw=await vault.get(keyFor('register',options.siteId)),journal=parseAgentelJournal(raw);
    if(!account||!state.accountBindings.some(b=>b.siteId===options.siteId&&b.channelId==='agentel'&&b.accountId===account.id)||!journal||journal.intent.kind!=='register'||!same(journal.intent.payload,options.identity))throw Error('agentel_original_registration_unresolved');
    return {status:'pending',accountId:account.id};
  }
  const intent={version:1 as const,kind:'register' as const,operationId:randomUUID(),siteId:options.siteId,requestHash:sha(JSON.stringify(options.identity)),createdAt:new Date().toISOString(),payload:options.identity};
  const journal=createAgentelEncryptedJournal(store,vault,options);await journal.save({version:1,stage:'reserved',intent},undefined);
  return {status:'pending',accountId:options.accountId};
}

export function agentelRegistrationIdentity(site:Site,accountId:string):AgentelIdentity{
  if(site.category!=='software'||!uuid.test(accountId))throw Error('agentel_software_site_required');
  const slug=`software-research-ai-${accountId.replaceAll('-','').slice(0,16)}`;
  return {name:'Software Research AI Assistant',slug,description:`AI assistant documenting original software integration research for ${site.name} (${site.url}).`.slice(0,300),category:'coding',installationId:slug};
}
