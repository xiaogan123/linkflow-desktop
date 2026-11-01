import type {State,Store} from './store';
import type {Vault} from './vault';
import type {Task} from '../shared/types';
import {dataEchoUploadUrl,DATAECHO_API,type DataEchoIntent,type DataEchoJournal,type DataEchoJournalSnapshot,type DataEchoStep} from '../integrations/dataecho';
import type {ConnectedResponse} from '../integrations/batch5-connected';

const keyFor=(taskId:string)=>`publication:${taskId}`;
const order:DataEchoStep[]=['create','upload_index','upload_robots','finalize'];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validIntent(value:unknown):value is DataEchoIntent{
  if(!object(value))return false;
  return value.version===1&&[value.taskId,value.siteId,value.accountId].every(v=>typeof v==='string'&&uuid.test(v))
    &&typeof value.name==='string'&&value.name.length>0&&value.name.length<=100
    &&typeof value.username==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value.username)
    &&typeof value.email==='string'&&/^\S+@\S+\.\S+$/.test(value.email)
    &&typeof value.sourceHash==='string'&&hash.test(value.sourceHash)
    &&typeof value.requestHash==='string'&&hash.test(value.requestHash)
    &&typeof value.createdAt==='string'&&Number.isFinite(Date.parse(value.createdAt));
}
function createdUrl(journal:DataEchoJournalSnapshot):string|undefined{
  const r=journal.steps.create?.response;if(!r||r.status!==201||r.url!==DATAECHO_API+'/publish')return;
  try{const v=JSON.parse(r.body);if(typeof v.slug==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v.slug)&&v.siteUrl===`https://${v.slug}.dataecho.ai/`&&!v.claimToken&&!v.claimUrl&&v.expiresAt==null)return v.siteUrl}catch{}
}
function validResponse(value:unknown):value is ConnectedResponse{
  return object(value)&&Number.isSafeInteger(value.status)&&Number(value.status)>=100&&Number(value.status)<=599
    &&typeof value.url==='string'&&(/^https:\/\/dataecho\.ai\/api\/v1\/publish(?:\/[a-z0-9-]+\/finalize)?$/.test(value.url)||dataEchoUploadUrl(value.url))&&value.url.length<=8192
    &&typeof value.contentType==='string'&&value.contentType.length<=256
    &&typeof value.robotsHeader==='string'&&value.robotsHeader.length<=512
    &&typeof value.body==='string'&&value.body.length<=256_000;
}
export function parseDataEchoPublicationJournal(raw:string|undefined):DataEchoJournalSnapshot|undefined{
  if(!raw||raw.length>1_800_000)return;
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{return}
  if(!object(parsed)||!validIntent(parsed.intent)||!object(parsed.steps))return;
  const steps=parsed.steps as Record<string,unknown>,keys=Object.keys(steps);if(keys.some(key=>!order.includes(key as DataEchoStep)))return;
  for(const [index,step] of order.entries()){
    const value=steps[step];if(value===undefined)continue;
    if(!object(value)||!['sending','response'].includes(String(value.stage))||value.stage==='response'&&!validResponse(value.response)
      ||value.stage==='sending'&&value.response!==undefined)return;
    if(order.slice(0,index).some(previous=>!object(steps[previous])||steps[previous].stage!=='response'))return;
  }
  return parsed as unknown as DataEchoJournalSnapshot;
}
export function dataEchoBackupMatches(task:Task,raw:string|undefined):boolean{
  const journal=parseDataEchoPublicationJournal(raw),intent=journal?.intent,summary=task.batch5;
  if(!journal||!intent||!summary||task.channelId!=='dataecho'||task.id!==intent.taskId||task.siteId!==intent.siteId||task.accountId!==intent.accountId
    ||summary.accountId!==intent.accountId||summary.channelId!=='dataecho'||summary.operationId!==intent.taskId||summary.sourceHash!==intent.sourceHash
    ||summary.requestHash!==intent.requestHash||summary.createdAt!==intent.createdAt)return false;
  const begun=order.some(step=>journal.steps[step]);
  if(summary.stage==='reserved')return !begun&&!task.submittedAt&&!task.publicUrl;
  if(!begun||task.submittedAt!==intent.createdAt)return false;
  if(summary.stage==='api_receipt'||summary.stage==='published')return journal.steps.finalize?.response?.status===200&&!!task.publicUrl&&task.publicUrl===createdUrl(journal);
  return !task.publicUrl;
}
type Storage=Pick<Store,'read'|'getCipher'|'updateWithCiphers'>;
type Secrets=Pick<Vault,'get'|'encryptSecrets'>;
export function createDataEchoPublicationJournal(store:Storage,vault:Secrets,taskId:string,authorize:(state:State,task:Task,intent:DataEchoIntent,step?:DataEchoStep)=>void):DataEchoJournal{
  const key=keyFor(taskId);
  const load=async()=>{const raw=await vault.get(key),value=parseDataEchoPublicationJournal(raw);if(raw&&!value)throw Error('dataecho_encrypted_journal_invalid');return value};
  const cipher=(value:DataEchoJournalSnapshot)=>{const raw=JSON.stringify(value),encrypted=vault.encryptSecrets({[key]:raw})[key];if(!encrypted||encrypted===raw)throw Error('dataecho_journal_not_encrypted');return encrypted};
  const identity=(state:State,intent:DataEchoIntent)=>{const task=state.tasks.find(item=>item.id===taskId),account=state.accounts.find(item=>item.id===intent.accountId),binding=state.accountBindings.find(item=>item.siteId===intent.siteId&&item.channelId==='dataecho');
    if(!task||task.siteId!==intent.siteId||task.channelId!=='dataecho'||task.accountId!==intent.accountId
      ||!account||account.channelId!=='dataecho'||account.email!==intent.email||account.username!==intent.username||account.retiredAt
      ||binding?.accountId!==intent.accountId)throw Error('dataecho_original_identity_changed');return task};
  const summary=(intent:DataEchoIntent,stage:NonNullable<Task['batch5']>['stage'],url?:string):NonNullable<Task['batch5']>=>({version:1,channelId:'dataecho',operationId:intent.taskId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,stage,accountId:intent.accountId,...(url?{publicUrl:url}:{})});
  return {
    load,
    async reserve(intent){if(!validIntent(intent)||intent.taskId!==taskId||store.getCipher(key))throw Error('dataecho_intent_exists');const next={intent,steps:{}} satisfies DataEchoJournalSnapshot,c=cipher(next);
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)||task.batch5||task.submittedAt||task.publicUrl)throw Error('dataecho_intent_exists');authorize(state,task,intent);task.batch5=summary(intent,'reserved');task.checkpoint='dataecho_reserved';}, {[key]:c},[],{[key]:undefined});},
    async arm(intent,step){const expected=store.getCipher(key),current=await load(),index=order.indexOf(step);
      if(!current||!expected||index<0||!same(current.intent,intent)||current.steps[step]
        ||order.slice(0,index).some(previous=>current.steps[previous]?.stage!=='response'))throw Error('dataecho_step_already_started');
      const next:DataEchoJournalSnapshot={intent,steps:{...current.steps,[step]:{stage:'sending'}}},c=cipher(next);
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId||task.publicUrl||task.firstLiveAt)throw Error('dataecho_step_state_changed');
        authorize(state,task,intent,step);task.batch5=summary(intent,'submitting');task.submittedAt=intent.createdAt;task.checkpoint=`dataecho_${step}_sending`;
      },{[key]:c},[],{[key]:expected});},
    async saveResponse(intent,step,response){const expected=store.getCipher(key),current=await load();
      if(!current||!expected||!same(current.intent,intent)||current.steps[step]?.stage!=='sending'||!validResponse(response))throw Error('dataecho_response_state_changed');
      const next:DataEchoJournalSnapshot={intent,steps:{...current.steps,[step]:{stage:'response',response}}},c=cipher(next);
      // A successful remote response must be encrypted even if the site pauses or the review is revoked mid-flight.
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId)throw Error('dataecho_response_identity_changed');
        task.batch5=summary(intent,'opaque_response');task.checkpoint=`dataecho_${step}_response`;
      },{[key]:c},[],{[key]:expected});},
    async markAccepted(intent,url){const expected=store.getCipher(key),current=await load();
      if(!current||!expected||!same(current.intent,intent)||current.steps.finalize?.stage!=='response'||url!==createdUrl(current))throw Error('dataecho_acceptance_state_changed');
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId)throw Error('dataecho_acceptance_identity_changed');
        task.batch5=summary(intent,'api_receipt',url);task.publicUrl=url;task.status='review';task.checkpoint='dataecho_public_accepted';
      },{},[],{[key]:expected});},
  };
}
