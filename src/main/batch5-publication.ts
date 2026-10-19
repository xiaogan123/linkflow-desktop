import {Batch5IdentitySingleSiteError,Batch5RegistrationLimitError} from '../integrations/batch5-contract';
import {accountCreationBudgetExceeded} from './account-bindings';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Batch5AccountIntent,Batch5AccountOpaqueResponse,Batch5AccountPersistence,Batch5AccountReceipt,Batch5Intent,Batch5Persistence,Batch5RegistrationState} from '../integrations/batch5-contract';
import type {State,Store} from './store';
import type {Vault} from './vault';
import type {Task} from '../shared/types';
import {BATCH5_MESSAGES} from '../shared/batch5-messages';

export const BATCH5_IDS=['yeetmd','markdownpage','slopit','rant','whitewind','hackmd'] as const;
export const isBatch5Channel=(id:string):boolean=>(BATCH5_IDS as readonly string[]).includes(id);
const hash=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().datetime();
const intentSchema=z.object({version:z.literal(1),channelId:z.enum(BATCH5_IDS),operationId:z.string().min(1).max(128),siteId:z.string().uuid(),sourceHash:hash,requestHash:hash,createdAt:date}).strict();
export const batch5TaskSchema=intentSchema.omit({siteId:true}).extend({stage:z.enum(['reserved','submitting','opaque_response','api_receipt','published']),publicUrl:z.url().max(2048).optional(),remoteId:z.string().max(256).optional(),accountId:z.string().max(256).optional()});
const opaqueSchema=z.object({version:z.literal(1),intent:intentSchema,status:z.number().int().min(100).max(599),contentType:z.string().max(512),responseUrl:z.string().max(2048),bodyBase64:z.string().max(2_000_000),bodyComplete:z.boolean()}).strict();
const receiptSchema=z.object({version:z.literal(1),intent:intentSchema,publicUrl:z.url().max(2048),remoteId:z.string().max(256).optional(),rawResponse:z.string().max(1_500_000),secret:z.string().max(16384).optional()}).strict();
const journalSchema=z.object({version:z.literal(1),intent:intentSchema,sending:z.literal(true).optional(),opaque:opaqueSchema.optional(),receipt:receiptSchema.optional()}).strict();
const accountIntentSchema=z.object({version:z.literal(1),channelId:z.enum(['slopit','rant']),siteId:z.string().uuid(),operationId:z.string().min(1).max(128),requestHash:hash,createdAt:date,username:z.string().max(128).optional(),email:z.string().max(254).optional(),password:z.string().max(1024).optional()}).strict();
export const batch5RegistrationSchema=z.object({version:z.literal(1),channelId:z.enum(['slopit','rant']),operationId:z.string().min(1).max(128),createdAt:date,stage:z.enum(['reserved','sending','rate_limited','request_unknown','rejected','registered','not_sent']),sendGuardVersion:z.literal(1).optional(),sentAt:date.optional(),rateLimitCount:z.number().int().min(1).max(3).optional(),lastRateLimitedAt:date.optional()}).strict();
const accountReceiptSchema=z.object({version:z.literal(1),intent:accountIntentSchema,accountId:z.string().min(1).max(256),publicUrl:z.url().max(2048),secret:z.string().min(1).max(16384),rawResponse:z.string().max(128000)}).strict();
const accountOpaqueSchema=z.object({version:z.literal(1),intent:accountIntentSchema,status:z.number().int().min(100).max(599),contentType:z.string().max(512),responseUrl:z.string().max(2048),bodyBase64:z.string().max(200000),bodyComplete:z.boolean(),receivedAt:date.optional(),responseExact:z.boolean().optional()}).strict();
const accountJournalSchema=z.object({version:z.literal(1),intent:accountIntentSchema,registration:batch5RegistrationSchema.optional(),opaque:accountOpaqueSchema.optional(),receipt:accountReceiptSchema.optional()}).strict();
type AccountJournal=z.infer<typeof accountJournalSchema>;
type Journal=z.infer<typeof journalSchema>;
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
const fail=()=>new Error(BATCH5_MESSAGES.invalidJournal);
export function parseBatch5Journal(raw:string|undefined):Journal|undefined {
  try{const journal=journalSchema.parse(JSON.parse(raw??''));if(journal.receipt&&!same(journal.intent,journal.receipt.intent)||journal.opaque&&!same(journal.intent,journal.opaque.intent))return;return journal;}catch{return;}
}
export function parseBatch5AccountJournal(raw:string|undefined){
  try{
    const journal=accountJournalSchema.parse(JSON.parse(raw??''));
    if(journal.receipt&&!same(journal.intent,journal.receipt.intent)||journal.opaque&&!same(journal.intent,journal.opaque.intent))return;
    if(journal.registration&&!registrationEvidenceMatches(journal.registration,journal))return;
    return journal;
  }catch{return;}
}
function registrationEvidenceMatches(summary:Batch5RegistrationState,journal:AccountJournal):boolean {
  if(summary.channelId!==journal.intent.channelId||summary.operationId!==journal.intent.operationId||summary.createdAt!==journal.intent.createdAt)return false;
  if(summary.sendGuardVersion||summary.sentAt||summary.rateLimitCount||summary.lastRateLimitedAt){
    if(!journal.registration||!same(summary,journal.registration))return false;
  }
  if(summary.stage==='registered')return !!journal.receipt;
  if(summary.stage==='rejected'){
    if(journal.receipt||!journal.opaque)return false;
    if(summary.sendGuardVersion===1&&summary.rateLimitCount===3&&journal.opaque.status===429){
      // An exact HTTP 429 proves the request was refused even if its body broke
      // mid-read. Legacy 429 migration still requires a complete response.
      return journal.opaque.responseExact!==false&&journal.opaque.responseUrl===accountRegistrationUrl(journal.intent.channelId);
    }
    if(summary.sendGuardVersion===1&&[401,403,409].includes(journal.opaque.status)){
      return journal.opaque.responseExact!==false&&journal.opaque.responseUrl===accountRegistrationUrl(journal.intent.channelId);
    }
    return opaqueRegistrationStage(journal.opaque)==='rejected'&&(journal.opaque.status!==429||summary.sendGuardVersion!==1);
  }
  if(summary.stage==='rate_limited')return !!summary.sendGuardVersion&&!!journal.opaque&&journal.opaque.status===429&&journal.opaque.responseExact!==false&&!!summary.rateLimitCount&&summary.rateLimitCount<3&&!!summary.lastRateLimitedAt;
  if(summary.stage==='sending')return !!summary.sendGuardVersion&&!journal.opaque&&!journal.receipt;
  if(summary.stage==='not_sent')return !journal.opaque&&!journal.receipt&&journal.registration?.stage==='not_sent';
  if(summary.stage==='reserved'&&summary.sendGuardVersion)return !journal.opaque&&!journal.receipt;
  return true; // Conservative projections may lag a later saved response.
}
/** A display summary cannot manufacture proof that a one-shot signup was never sent or was rejected. */
export function batch5RegistrationBackupMatches(task:Task,raw:string|undefined,accountSecret:string|undefined):boolean {
  const summary=task.batch5Registration,journal=parseBatch5AccountJournal(raw);
  if(!summary||!journal||task.siteId!==journal.intent.siteId||task.channelId!==journal.intent.channelId||task.accountId!==batch5LocalAccountId(task.channelId,task.siteId)||!registrationEvidenceMatches(summary,journal))return false;
  return summary.stage!=='registered'||!!journal.receipt&&accountSecret===journal.receipt.secret;
}
function matches(task:Task,intent:Batch5Intent):boolean {
  const summary=task.batch5;
  return !!summary&&task.siteId===intent.siteId&&task.channelId===intent.channelId&&(summary.stage==='reserved'?!task.submittedAt:task.submittedAt===intent.createdAt)&&
    summary.operationId===intent.operationId&&summary.sourceHash===intent.sourceHash&&summary.requestHash===intent.requestHash&&summary.createdAt===intent.createdAt&&summary.channelId===intent.channelId;
}
export function batch5BackupMatches(task:Task,raw:string|undefined):boolean {
  const journal=parseBatch5Journal(raw);if(!journal||!matches(task,journal.intent))return false;
  if(task.batch5?.stage==='reserved')return !journal.sending&&!journal.opaque&&!journal.receipt&&!task.publicUrl;
  if(task.batch5?.stage==='opaque_response'&&!journal.opaque)return false;
  if(['api_receipt','published'].includes(task.batch5?.stage??''))return !!journal.receipt&&journal.receipt.publicUrl===task.publicUrl&&task.batch5?.publicUrl===task.publicUrl&&journal.receipt.remoteId===task.batch5?.remoteId;
  return !task.publicUrl;
}

type StateStore=Pick<Store,'read'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'get'|'encryptSecrets'>;
export function createBatch5Persistence(store:StateStore,vault:SecureVault,taskId:string,authorize:()=>void):Batch5Persistence {
  const key=`publication:${taskId}`;
  const read=async()=>{const raw=await vault.get(key);if(raw&&!parseBatch5Journal(raw))throw fail();return parseBatch5Journal(raw);};
  const write=(journal:Journal,expected:string|undefined)=>{
    const raw=JSON.stringify(journal),ciphers=vault.encryptSecrets({[key]:raw});if(!ciphers[key]||ciphers[key]===raw)throw fail();
    store.updateWithCiphers(state=>{
      const task=state.tasks.find(value=>value.id===taskId);if(!task||task.siteId!==journal.intent.siteId||task.channelId!==journal.intent.channelId)throw fail();
      if(!task.batch5){if(task.submittedAt||task.publicUrl||task.firstLiveAt)throw fail();authorize();}
      else if(!matches(task,journal.intent))throw fail();
      const {siteId:_,...intent}=journal.intent;
      const stage=journal.receipt?'api_receipt':journal.opaque?'opaque_response':journal.sending?'submitting':'reserved';
      if(task.batch5?.stage==='reserved'&&stage==='submitting')authorize();
      task.batch5={...intent,stage:task.batch5?.stage==='published'?'published':stage,...(journal.receipt?{publicUrl:journal.receipt.publicUrl,remoteId:journal.receipt.remoteId}:{}),...(task.accountId?{accountId:task.accountId}:{})};
      if(stage==='submitting'&&!task.trialSendStartedAt)task.trialSendStartedAt=new Date().toISOString();
      task.submittedAt=stage==='reserved'?undefined:journal.intent.createdAt;task.publicUrl=journal.receipt?.publicUrl;if(stage!=='reserved'&&!['needs_input','skipped','expired'].includes(task.status))task.status='review';task.health='pending';task.checkpoint=`batch5_${stage}`;task.updatedAt=new Date().toISOString();
      task.message=journal.receipt?BATCH5_MESSAGES.receiptSaved:BATCH5_MESSAGES.intentSaved;
    },ciphers,[],{[key]:expected});
  };
  return {
    async saveIntent(value){const intent=intentSchema.parse(value);if(store.getCipher(key))throw fail();authorize();write({version:1,intent,sending:true},undefined);},
    async reserveIntent(value){const intent=intentSchema.parse(value);if(store.getCipher(key))throw fail();authorize();write({version:1,intent},undefined);},
    async markSending(value){const intent=intentSchema.parse(value),journal=await read(),expected=store.getCipher(key);if(!expected||!journal||!same(journal.intent,intent)||journal.sending||journal.opaque||journal.receipt||store.read().tasks.find(task=>task.id===taskId)?.batch5?.stage!=='reserved')throw fail();authorize();write({...journal,sending:true},expected);},
    async loadIntent(){return (await read())?.intent;},
    async assertReadyToSubmit(intent){const journal=await read();if(!journal||!same(journal.intent,intent)||journal.receipt||journal.opaque)throw fail();authorize();},
    async saveOpaqueResponse(value){const expected=store.getCipher(key),journal=await read(),opaque=opaqueSchema.parse(value);if(!journal||!same(journal.intent,opaque.intent)||journal.receipt||store.read().tasks.find(task=>task.id===taskId)?.batch5?.stage==='reserved')throw fail();if(journal.opaque&&same(journal.opaque,opaque))return;if(journal.opaque?.bodyComplete)throw fail();write({...journal,opaque},expected);},
    async loadOpaqueResponse(){return (await read())?.opaque;},
    async saveReceipt(value){const expected=store.getCipher(key),journal=await read(),receipt=receiptSchema.parse(value);if(!journal||!same(journal.intent,receipt.intent)||store.read().tasks.find(task=>task.id===taskId)?.batch5?.stage==='reserved')throw fail();if(journal.receipt){if(same(journal.receipt,receipt))return;throw fail();}write({...journal,receipt},expected);},
    async loadReceipt(){return (await read())?.receipt;},
    currentTaskState(){return store.read().tasks.find(value=>value.id===taskId)?.batch5;},
  };
}

export function batch5LocalAccountId(channelId:string,siteId:string):string {
  const h=createHash('sha256').update(`batch5:${channelId}:${siteId}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function accountRegistrationUrl(channelId:string):string|undefined {
  return channelId==='slopit'?'https://slopit.io/api/signup':channelId==='rant'?'https://rant.li/api/auth/signup':undefined;
}
function registrationState(intent:Batch5AccountIntent,stage:Batch5RegistrationState['stage'],previous?:Batch5RegistrationState,rateLimitedAt?:string,sendingAt?:string):Batch5RegistrationState {
  if(intent.channelId!=='slopit'&&intent.channelId!=='rant')throw fail();
  const rateLimitCount=rateLimitedAt?(previous?.rateLimitCount??0)+1:previous?.rateLimitCount;
  return batch5RegistrationSchema.parse({version:1,channelId:intent.channelId,operationId:intent.operationId,createdAt:intent.createdAt,stage,...(previous?.sendGuardVersion?{sendGuardVersion:1}:{}) ,...(sendingAt||previous?.sentAt?{sentAt:sendingAt??previous?.sentAt}:{}),...(rateLimitCount?{rateLimitCount}:{}),...(rateLimitedAt||previous?.lastRateLimitedAt?{lastRateLimitedAt:rateLimitedAt??previous?.lastRateLimitedAt}:{})});
}
function registrationMatches(task:Task,intent:Batch5AccountIntent):boolean {
  const summary=task.batch5Registration;
  return !!summary&&task.siteId===intent.siteId&&task.channelId===intent.channelId&&summary.channelId===intent.channelId&&summary.operationId===intent.operationId&&summary.createdAt===intent.createdAt;
}
function opaqueRegistrationStage(opaque:Batch5AccountOpaqueResponse,guarded=false):Batch5RegistrationState['stage'] {
  const exact=opaque.responseExact!==false&&opaque.responseUrl===accountRegistrationUrl(opaque.intent.channelId);
  const rejected=exact&&(guarded&&[401,403,409].includes(opaque.status)||opaque.bodyComplete&&opaque.status>=400&&opaque.status<500&&opaque.status!==408);
  return rejected?'rejected':'request_unknown';
}
const safelyDeletableRegistration=(stage:Batch5RegistrationState['stage'])=>stage==='rejected'||stage==='rate_limited'||stage==='not_sent';
function safeAccountIdentity(state:State,ciphers:Readonly<Record<string,string|undefined>>,channelId:string,siteId:string):boolean {
  const localId=batch5LocalAccountId(channelId,siteId),summaries=state.tasks.filter(task=>task.siteId===siteId&&task.channelId===channelId&&task.batch5Registration).map(task=>task.batch5Registration!);
  const account=state.accounts.find(value=>value.id===localId),bindings=state.accountBindings.filter(value=>value.accountId===localId);
  return summaries.length>0&&summaries.every(value=>value.channelId===channelId&&safelyDeletableRegistration(value.stage))&&
    !!account&&account.channelId===channelId&&account.status==='unknown'&&!account.hasPassword&&!account.registeredAt&&!account.publicationUrl&&!ciphers[`account:${localId}`]&&
    bindings.length===1&&bindings[0].siteId===siteId&&bindings[0].channelId===channelId;
}
function originHost(value:string):string|undefined {
  try{return new URL(value.includes('://')?value:`https://${value}`).hostname.toLowerCase().replace(/\.$/,'').replace(/^www\./,'');}catch{return;}
}
/** Old releases allowed migration before first publication; retain their original signup lock. */
function hasHistoricalOriginIdentity(state:State,store:Pick<Store,'getCipher'>,channelId:string,siteId:string):boolean {
  const site=state.sites.find(value=>value.id===siteId);
  if(!site)return true;
  const hosts=new Set([originHost(site.domain),originHost(site.url)].filter((value):value is string=>!!value));
  return (state.siteOriginMigrations??[]).some(record=>{
    if(record.siteId===siteId||![record.before.domain,record.before.url].some(value=>{const host=originHost(value);return !!host&&hosts.has(host);}))return false;
    if(!store.getCipher(`batch5:identity:${channelId}:${record.siteId}`))return false;
    const accountKey=`account:${batch5LocalAccountId(channelId,record.siteId)}`;
    return !safeAccountIdentity(state,{[accountKey]:store.getCipher(accountKey)},channelId,record.siteId);
  });
}
export interface Batch5AccountDeletionPlan {blocked:boolean;cipherKeys:string[];accountIds:string[]}
/** Synchronous deletion preflight. Missing summaries and all unknown/registered outcomes remain protected. */
export function batch5AccountDeletionPlan(store:Pick<Store,'read'|'getCipher'>,siteId:string):Batch5AccountDeletionPlan {
  const state=store.read(),channels=['slopit','rant'].filter(channelId=>!!store.getCipher(`batch5:identity:${channelId}:${siteId}`));
  const ciphers=Object.fromEntries(channels.flatMap(channelId=>{
    const localId=batch5LocalAccountId(channelId,siteId);return [[`batch5:identity:${channelId}:${siteId}`,store.getCipher(`batch5:identity:${channelId}:${siteId}`)],[`account:${localId}`,store.getCipher(`account:${localId}`)]];
  }));
  if(channels.some(channelId=>!safeAccountIdentity(state,ciphers,channelId,siteId)))return {blocked:true,cipherKeys:[],accountIds:[]};
  return {blocked:false,cipherKeys:channels.map(channelId=>`batch5:identity:${channelId}:${siteId}`),accountIds:channels.map(channelId=>batch5LocalAccountId(channelId,siteId))};
}
/** A signup journal survives removal of the task; deleting its site would orphan the identity. */
export function hasBatch5AccountIdentity(store:Pick<Store,'getCipher'>,siteId:string):boolean {
  return ['slopit','rant'].some(channelId=>!!store.getCipher(`batch5:identity:${channelId}:${siteId}`));
}
export function createBatch5AccountPersistence(store:StateStore,vault:SecureVault,taskId:string,authorize:()=>void):Batch5AccountPersistence {
  const current=()=>{const state=store.read(),task=state.tasks.find(value=>value.id===taskId);if(!task||!['slopit','rant'].includes(task.channelId))throw fail();return {state,task};};
  const keyFor=(channelId:string,siteId:string)=>{const {task}=current();if(task.channelId!==channelId||task.siteId!==siteId)throw fail();return `batch5:identity:${channelId}:${siteId}`;};
  const read=async(channelId:string,siteId:string)=>{const raw=await vault.get(keyFor(channelId,siteId));if(raw&&!parseBatch5AccountJournal(raw))throw fail();return parseBatch5AccountJournal(raw);};
  const writeSummary=(state:State,intent:Batch5AccountIntent,registration:Batch5RegistrationState,replaced?:Batch5AccountIntent)=>{
    const task=state.tasks.find(value=>value.id===taskId);if(!task||task.siteId!==intent.siteId||task.channelId!==intent.channelId)throw fail();
    if(task.batch5Registration&&!registrationMatches(task,replaced??intent))throw fail();
    const related=state.tasks.filter(value=>value.siteId===intent.siteId&&value.channelId===intent.channelId&&value.batch5Registration);
    if(related.some(value=>!registrationMatches(value,replaced??intent)))throw fail();
    const localId=batch5LocalAccountId(intent.channelId,intent.siteId);
    if(!state.accounts.some(value=>value.id===localId&&value.channelId===intent.channelId)||!state.accountBindings.some(value=>value.accountId===localId&&value.siteId===intent.siteId&&value.channelId===intent.channelId))throw fail();
    for(const value of [...related,task]){if(value.accountId&&value.accountId!==localId)throw fail();value.accountId=localId;}
    for(const value of related)value.batch5Registration=registration;
    task.batch5Registration=registration;
    if(!task.batch5){
      task.checkpoint=registration.stage==='rejected'?'batch5_account_rejected':registration.stage==='not_sent'?'batch5_account_not_sent':registration.stage==='registered'?'batch5_account_ready':registration.stage==='rate_limited'?'batch5_account_rate_limited':'batch5_account_pending';
    }
  };
  const mark=async(intent:Batch5AccountIntent,stage:Batch5RegistrationState['stage'],at?:string)=>{
    const parsed=accountIntentSchema.parse(intent),key=keyFor(parsed.channelId,parsed.siteId),expected=store.getCipher(key);if(!expected)throw fail();
    const journal=await read(parsed.channelId,parsed.siteId);if(!journal||!same(parsed,journal.intent))throw fail();
    const before=journal.registration?.stage;
    if(stage==='not_sent'&&(before!=='reserved'||journal.opaque||journal.receipt))throw fail();
    if(stage==='sending'){
      if(journal.registration?.sendGuardVersion!==1||!['reserved','rate_limited'].includes(before??''))throw fail();
      if(before==='rate_limited'){
        const last=Date.parse(journal.registration.lastRateLimitedAt??''),now=Date.parse(at??'');
        if(!journal.opaque||journal.opaque.status!==429||!Number.isFinite(now)||!Number.isFinite(last)||now-last<86_400_000||journal.registration.rateLimitCount!>=3)throw fail();
      }else if(journal.opaque)throw fail();
      authorize();
    }
    if(stage==='request_unknown'&&before==='not_sent'||stage==='registered'&&!journal.receipt)throw fail();
    const registration=registrationState(parsed,stage,journal.registration,undefined,stage==='sending'?at??new Date().toISOString():undefined);
    const updated={...journal,registration,...(stage==='sending'?{opaque:undefined}:{})},raw=JSON.stringify(updated);
    if(!parseBatch5AccountJournal(raw))throw fail();
    const ciphers=vault.encryptSecrets({[key]:raw});if(!ciphers[key]||ciphers[key]===raw)throw fail();
    store.updateWithCiphers(state=>writeSummary(state,parsed,registration),ciphers,[],{[key]:expected});
  };
  const commit=(intent:Batch5AccountIntent,opaque:Batch5AccountOpaqueResponse|undefined,receipt:Batch5AccountReceipt|undefined,expected:string|undefined,previous?:AccountJournal)=>{
    const rateLimitCount=opaque?.status===429&&opaque.responseExact!==false&&opaque.responseUrl===accountRegistrationUrl(intent.channelId)&&previous?.registration?.stage==='sending'?(previous.registration.rateLimitCount??0)+1:undefined;
    const stage=receipt?'registered':rateLimitCount?(rateLimitCount>=3?'rejected':'rate_limited'):opaque?opaqueRegistrationStage(opaque,previous?.registration?.sendGuardVersion===1):'reserved';
    const registration=expected?registrationState(intent,stage,previous?.registration,rateLimitCount?opaque?.receivedAt??new Date().toISOString():undefined):batch5RegistrationSchema.parse({...registrationState(intent,'reserved'),sendGuardVersion:1});
    const key=keyFor(intent.channelId,intent.siteId),localId=batch5LocalAccountId(intent.channelId,intent.siteId),raw=JSON.stringify({version:1,intent,registration,...(opaque?{opaque}:{}),...(receipt?{receipt}:{})});
    const clear:Record<string,string>={[key]:raw};if(receipt)clear[`account:${localId}`]=receipt.secret;
    const ciphers=vault.encryptSecrets(clear);if(Object.entries(clear).some(([k,value])=>!ciphers[k]||ciphers[k]===value))throw fail();
    store.updateWithCiphers(state=>{
      const task=state.tasks.find(value=>value.id===taskId);if(!task||task.siteId!==intent.siteId||task.channelId!==intent.channelId)throw fail();
      let account=state.accounts.find(value=>value.id===localId);
      if(!expected){authorize();if(account||state.accountBindings.some(binding=>binding.channelId===intent.channelId&&binding.siteId===intent.siteId))throw fail();
        if(hasHistoricalOriginIdentity(state,store,intent.channelId,intent.siteId))throw new Batch5IdentitySingleSiteError(BATCH5_MESSAGES.identitySingleSite);
        if(intent.channelId==='slopit'&&state.accounts.some(value=>value.channelId==='slopit'&&value.email.toLowerCase()===intent.email?.toLowerCase()))throw new Batch5IdentitySingleSiteError(BATCH5_MESSAGES.identitySingleSite);
        if(accountCreationBudgetExceeded(state,intent.channelId,new Date(intent.createdAt)))throw new Batch5RegistrationLimitError(BATCH5_MESSAGES.registrationLimit);
        account={id:localId,channelId:intent.channelId,email:intent.email??'',username:intent.username??'',status:'unknown',hasPassword:false,source:'generated',credentialKind:intent.channelId==='rant'?'password':'api_token',createdAt:intent.createdAt,registrationAttempts:1};state.accounts.push(account);
        state.accountBindings.push({id:localId,siteId:intent.siteId,channelId:intent.channelId,accountId:localId,createdAt:intent.createdAt,updatedAt:intent.createdAt});
      }
      if(!account||state.accountBindings.find(binding=>binding.accountId===localId)?.siteId!==intent.siteId)throw fail();
      task.accountId=localId;
      if(receipt){account.username=receipt.accountId;account.publicationUrl=receipt.publicUrl;account.status='registered';account.hasPassword=true;account.registeredAt=intent.createdAt;}
      writeSummary(state,intent,registration);
      if(!expected)task.message=BATCH5_MESSAGES.accountPending;
    },ciphers,[],{[key]:expected});
  };
  return {
    async saveAccountIntent(value){const intent=accountIntentSchema.parse(value),key=keyFor(intent.channelId,intent.siteId);if(store.getCipher(key))throw fail();commit(intent,undefined,undefined,undefined);},
    async replaceUnsentAccountIntent(previous,next){
      const oldIntent=accountIntentSchema.parse(previous),intent=accountIntentSchema.parse(next),key=keyFor(oldIntent.channelId,oldIntent.siteId),expected=store.getCipher(key),journal=await read(oldIntent.channelId,oldIntent.siteId);
      if(!expected||!journal||!same(journal.intent,oldIntent)||journal.registration?.stage!=='not_sent'||journal.opaque||journal.receipt||oldIntent.channelId!==intent.channelId||oldIntent.siteId!==intent.siteId||oldIntent.requestHash!==intent.requestHash||oldIntent.username!==intent.username||oldIntent.email!==intent.email||oldIntent.password!==intent.password||oldIntent.operationId===intent.operationId||Date.parse(intent.createdAt)<Date.parse(oldIntent.createdAt))throw fail();
      const registration=batch5RegistrationSchema.parse({...registrationState(intent,'reserved'),sendGuardVersion:1}),raw=JSON.stringify({version:1,intent,registration}),ciphers=vault.encryptSecrets({[key]:raw});if(!ciphers[key]||ciphers[key]===raw)throw fail();
      store.updateWithCiphers(state=>writeSummary(state,intent,registration,oldIntent),ciphers,[],{[key]:expected});
    },
    async reviveLegacyRateLimit(value,observedAt){
      const intent=accountIntentSchema.parse(value),now=date.parse(observedAt),key=keyFor(intent.channelId,intent.siteId),expected=store.getCipher(key),journal=await read(intent.channelId,intent.siteId);
      const previous=journal?.registration??store.read().tasks.find(task=>task.id===taskId)?.batch5Registration;
      const opaque=journal?.opaque,localId=batch5LocalAccountId(intent.channelId,intent.siteId);
      if(!expected||!journal||!same(journal.intent,intent)||!intent.username||intent.channelId==='rant'&&!intent.password||intent.channelId==='slopit'&&!intent.email||!previous||previous.stage!=='rejected'||previous.sendGuardVersion||previous.rateLimitCount||journal.receipt||!opaque||!same(opaque.intent,intent)||opaque.status!==429||!opaque.bodyComplete||opaque.responseExact===false||opaque.responseUrl!==accountRegistrationUrl(intent.channelId)||store.getCipher(`account:${localId}`))throw fail();
      const rateTime=opaque.receivedAt??now;
      if(Date.parse(rateTime)>Date.parse(now)||Date.parse(rateTime)<Date.parse(intent.createdAt))throw fail();
      const registration=batch5RegistrationSchema.parse({version:1,channelId:intent.channelId,operationId:intent.operationId,createdAt:intent.createdAt,stage:'rate_limited',sendGuardVersion:1,rateLimitCount:1,lastRateLimitedAt:rateTime});
      const raw=JSON.stringify({...journal,registration}),ciphers=vault.encryptSecrets({[key]:raw});if(!ciphers[key]||ciphers[key]===raw||!parseBatch5AccountJournal(raw))throw fail();
      store.updateWithCiphers(state=>{
        const account=state.accounts.find(value=>value.id===localId),binding=state.accountBindings.find(value=>value.siteId===intent.siteId&&value.channelId===intent.channelId);
        const summaries=state.tasks.filter(task=>task.siteId===intent.siteId&&task.channelId===intent.channelId&&task.batch5Registration).map(task=>task.batch5Registration!);
        if(!account||account.status!=='unknown'||account.hasPassword||account.registeredAt||account.publicationUrl||binding?.accountId!==localId||!summaries.length||summaries.some(summary=>summary.stage!=='rejected'||summary.sendGuardVersion||summary.rateLimitCount||summary.operationId!==intent.operationId||summary.createdAt!==intent.createdAt))throw fail();
        writeSummary(state,intent,registration);
        const trial=state.settings.channelTrials?.[intent.channelId],matchingFailures=state.tasks.filter(task=>task.siteId===intent.siteId&&task.channelId===intent.channelId&&task.trialFailureOperationId===intent.operationId);
        if(trial?.evaluatedFailureOperationIds?.includes(intent.operationId)&&matchingFailures.length){
          if(trial.failures<1)throw fail();
          trial.evaluatedFailureOperationIds=trial.evaluatedFailureOperationIds.filter(operationId=>operationId!==intent.operationId);
          trial.failures--;
          if(trial.failures===0)trial.reason=undefined;
          if(trial.failures<2&&trial.disabledAt&&trial.autoDisabledOverride===true){
            trial.disabledAt=undefined;trial.autoDisabledOverride=undefined;
            if(state.settings.channelOverrides[intent.channelId]===false)delete state.settings.channelOverrides[intent.channelId];
          }
        }
        for(const task of matchingFailures){task.trialFailure=undefined;task.trialFailureOperationId=undefined;}
      },ciphers,[],{[key]:expected});
    },
    async loadAccountIntent(channelId,siteId){return (await read(channelId,siteId))?.intent;},
    async assertReadyToRegister(intent){const journal=await read(intent.channelId,intent.siteId);if(!journal||!same(journal.intent,intent)||journal.receipt||journal.registration?.stage!=='reserved'&&journal.registration?.stage!=='rate_limited'||journal.registration.stage==='reserved'&&journal.opaque||journal.registration.stage==='rate_limited'&&journal.opaque?.status!==429)throw fail();authorize();},
    async saveAccountOpaqueResponse(value){const opaque=accountOpaqueSchema.parse(value),key=keyFor(opaque.intent.channelId,opaque.intent.siteId),expected=store.getCipher(key),journal=await read(opaque.intent.channelId,opaque.intent.siteId);if(!journal||!same(journal.intent,opaque.intent)||journal.receipt)throw fail();if(journal.opaque){if(same(journal.opaque,opaque))return;throw fail();}commit(opaque.intent,opaque,undefined,expected,journal);},
    async loadAccountOpaqueResponse(channelId,siteId){return (await read(channelId,siteId))?.opaque;},
    async saveAccountReceipt(value){const receipt=accountReceiptSchema.parse(value),key=keyFor(receipt.intent.channelId,receipt.intent.siteId),expected=store.getCipher(key),journal=await read(receipt.intent.channelId,receipt.intent.siteId);if(!journal||!same(journal.intent,receipt.intent))throw fail();if(journal.receipt){if(same(journal.receipt,receipt))return;throw fail();}commit(receipt.intent,journal.opaque,receipt,expected,journal);},
    async loadAccountReceipt(channelId,siteId){return (await read(channelId,siteId))?.receipt;},
    async loadAccountRegistration(channelId,siteId){
      const journal=await read(channelId,siteId);if(!journal)return;
      if(journal.registration)return journal.registration;
      const summaries=store.read().tasks.filter(task=>task.siteId===siteId&&task.channelId===channelId&&task.batch5Registration).map(task=>task.batch5Registration!);
      if(!summaries.length)return;const first=summaries[0];return summaries.every(value=>same(value,first))&&registrationEvidenceMatches(first,journal)?first:undefined;
    },
    async markAccountRegistration(intent,stage,at){await mark(intent,stage,at);},
  };
}

export function assertBatch5Transition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void {
  const stages=['reserved','submitting','opaque_response','api_receipt','published'];
  for(const task of next.tasks){if(!task.batch5)continue;batch5TaskSchema.parse(task.batch5);if(!matches(task,{...task.batch5,siteId:task.siteId})||!nextCiphers[`publication:${task.id}`])throw fail();}
  for(const before of previous.tasks){if(!before.batch5)continue;const after=next.tasks.find(value=>value.id===before.id),key=`publication:${before.id}`;if(!after?.batch5||!matches(after,{...before.batch5,siteId:before.siteId})||stages.indexOf(after.batch5.stage)<stages.indexOf(before.batch5.stage)||!nextCiphers[key]||before.publicUrl&&after.publicUrl!==before.publicUrl)throw fail();}
  const allowedRegistrationStages:Record<Batch5RegistrationState['stage'],readonly Batch5RegistrationState['stage'][]>= {
    reserved:['reserved','sending','request_unknown','rejected','registered','not_sent'],
    sending:['sending','rate_limited','request_unknown','rejected','registered'],
    rate_limited:['rate_limited','sending','rejected'],
    request_unknown:['request_unknown','rejected','registered'],
    rejected:['rejected'],registered:['registered'],not_sent:['not_sent'],
  };
  for(const task of next.tasks){
    const summary=task.batch5Registration;if(!summary)continue;batch5RegistrationSchema.parse(summary);
    const key=`batch5:identity:${summary.channelId}:${task.siteId}`,localId=batch5LocalAccountId(summary.channelId,task.siteId);
    if(task.channelId!==summary.channelId||task.accountId!==localId||!nextCiphers[key])throw fail();
  }
  for(const before of previous.tasks){
    const summary=before.batch5Registration;if(!summary)continue;
    const after=next.tasks.find(value=>value.id===before.id),key=`batch5:identity:${summary.channelId}:${before.siteId}`;
    if(!after){if(nextCiphers[key])throw fail();continue;}
    const current=after.batch5Registration;
    const replaced=summary.stage==='not_sent'&&current?.stage==='reserved'&&current.sendGuardVersion===1&&current.operationId!==summary.operationId;
    const legacy429Upgrade=summary.stage==='rejected'&&summary.sendGuardVersion!==1&&summary.rateLimitCount===undefined&&current?.stage==='rate_limited'&&current.sendGuardVersion===1&&current.rateLimitCount===1&&!!current.lastRateLimitedAt&&previousCiphers[key]!==nextCiphers[key];
    if(!current||after.siteId!==before.siteId||after.channelId!==before.channelId||current.channelId!==summary.channelId||!replaced&&(current.operationId!==summary.operationId||current.createdAt!==summary.createdAt||!allowedRegistrationStages[summary.stage].includes(current.stage)&&!legacy429Upgrade||!legacy429Upgrade&&summary.sendGuardVersion!==1&&current.sendGuardVersion===1||(current.rateLimitCount??0)<(summary.rateLimitCount??0)))throw fail();
  }
  for(const [key,cipher] of Object.entries(previousCiphers)){
    if(!key.startsWith('batch5:identity:')||!cipher||nextCiphers[key])continue;
    const match=/^batch5:identity:(slopit|rant):([0-9a-f-]{36})$/.exec(key);if(!match)throw fail();
    const [,channelId,siteId]=match,localId=batch5LocalAccountId(channelId,siteId);
    if(!safeAccountIdentity(previous,previousCiphers,channelId,siteId)||next.sites.some(site=>site.id===siteId)||next.tasks.some(task=>task.siteId===siteId)||next.accountBindings.some(binding=>binding.siteId===siteId||binding.accountId===localId)||next.accounts.some(account=>account.id===localId)||nextCiphers[`account:${localId}`])throw fail();
  }
}
