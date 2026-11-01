import type {State,Store} from './store';
import type {Vault} from './vault';
import type {Task} from '../shared/types';
import {host0ReservedSlug,type Host0Intent,type Host0Journal,type Host0JournalSnapshot,type Host0Step} from '../integrations/host0';
import type {ConnectedResponse} from '../integrations/batch5-connected';

const keyFor=(taskId:string)=>`publication:${taskId}`;
const order:Host0Step[]=['create_app','create_deployment','upload_index','upload_robots','finalize','publicize'];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hash=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validIntent(value:unknown):value is Host0Intent{
  if(!object(value))return false;
  return value.version===1&&[value.taskId,value.siteId,value.accountId].every(v=>typeof v==='string'&&uuid.test(v))
    &&typeof value.slug==='string'&&value.slug===host0ReservedSlug(value.taskId as string)
    &&typeof value.name==='string'&&value.name.length>0&&value.name.length<=100
    &&typeof value.email==='string'&&/^\S+@\S+\.\S+$/.test(value.email)
    &&typeof value.sourceHash==='string'&&hash.test(value.sourceHash)
    &&typeof value.requestHash==='string'&&hash.test(value.requestHash)
    &&typeof value.createdAt==='string'&&Number.isFinite(Date.parse(value.createdAt));
}
function validResponse(value:unknown):value is ConnectedResponse{
  return object(value)&&Number.isSafeInteger(value.status)&&Number(value.status)>=100&&Number(value.status)<=599
    &&typeof value.url==='string'&&value.url.startsWith('https://host0.ai/api/v1/')&&value.url.length<=512
    &&typeof value.contentType==='string'&&value.contentType.length<=256
    &&typeof value.robotsHeader==='string'&&value.robotsHeader.length<=512
    &&typeof value.body==='string'&&value.body.length<=256_000;
}
export function parseHost0PublicationJournal(raw:string|undefined):Host0JournalSnapshot|undefined{
  if(!raw||raw.length>1_800_000)return;
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{return}
  if(!object(parsed)||!validIntent(parsed.intent)||!object(parsed.steps))return;
  const steps=parsed.steps as Record<string,unknown>,keys=Object.keys(steps);if(keys.some(key=>!order.includes(key as Host0Step)))return;
  for(const [index,step] of order.entries()){
    const value=steps[step];if(value===undefined)continue;
    if(!object(value)||!['sending','response'].includes(String(value.stage))||value.stage==='response'&&!validResponse(value.response)
      ||value.stage==='sending'&&value.response!==undefined)return;
    if(order.slice(0,index).some(previous=>!object(steps[previous])||steps[previous].stage!=='response'))return;
  }
  return parsed as unknown as Host0JournalSnapshot;
}
export function host0BackupMatches(task:Task,raw:string|undefined):boolean{
  const journal=parseHost0PublicationJournal(raw),intent=journal?.intent,summary=task.batch5;
  if(!journal||!intent||!summary||task.channelId!=='host0'||task.id!==intent.taskId||task.siteId!==intent.siteId||task.accountId!==intent.accountId
    ||summary.channelId!=='host0'||summary.operationId!==intent.taskId||summary.sourceHash!==intent.sourceHash
    ||summary.requestHash!==intent.requestHash||summary.createdAt!==intent.createdAt)return false;
  const begun=order.some(step=>journal.steps[step]);
  if(summary.stage==='reserved')return !begun&&!task.submittedAt&&!task.publicUrl;
  if(!begun||task.submittedAt!==intent.createdAt)return false;
  if(summary.stage==='api_receipt'||summary.stage==='published')return !!journal.steps.publicize?.response&&task.publicUrl===`https://${intent.slug}.host0.app/`;
  return !task.publicUrl;
}
type Storage=Pick<Store,'read'|'getCipher'|'updateWithCiphers'>;
type Secrets=Pick<Vault,'get'|'encryptSecrets'>;
export function createHost0PublicationJournal(store:Storage,vault:Secrets,taskId:string,authorize:(state:State,task:Task,intent:Host0Intent,step?:Host0Step)=>void):Host0Journal{
  const key=keyFor(taskId);
  const load=async()=>{const raw=await vault.get(key),value=parseHost0PublicationJournal(raw);if(raw&&!value)throw Error('host0_encrypted_journal_invalid');return value};
  const cipher=(value:Host0JournalSnapshot)=>{const raw=JSON.stringify(value),encrypted=vault.encryptSecrets({[key]:raw})[key];if(!encrypted||encrypted===raw)throw Error('host0_journal_not_encrypted');return encrypted};
  const identity=(state:State,intent:Host0Intent)=>{const task=state.tasks.find(item=>item.id===taskId),account=state.accounts.find(item=>item.id===intent.accountId),binding=state.accountBindings.find(item=>item.siteId===intent.siteId&&item.channelId==='host0');
    if(!task||task.siteId!==intent.siteId||task.channelId!=='host0'||task.accountId!==intent.accountId
      ||!account||account.channelId!=='host0'||account.email!==intent.email||account.username!==intent.email||account.retiredAt
      ||binding?.accountId!==intent.accountId)throw Error('host0_original_identity_changed');return task};
  const summary=(intent:Host0Intent,stage:NonNullable<Task['batch5']>['stage'],url?:string):NonNullable<Task['batch5']>=>({version:1,channelId:'host0',operationId:intent.taskId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,stage,accountId:intent.accountId,...(url?{publicUrl:url}:{})});
  return {
    load,
    async reserve(intent){if(!validIntent(intent)||intent.taskId!==taskId||store.getCipher(key))throw Error('host0_intent_exists');const next={intent,steps:{}} satisfies Host0JournalSnapshot,c=cipher(next);
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)||task.batch5||task.submittedAt||task.publicUrl)throw Error('host0_intent_exists');authorize(state,task,intent);task.batch5=summary(intent,'reserved');task.checkpoint='host0_reserved';}, {[key]:c},[],{[key]:undefined});},
    async arm(intent,step){const current=await load(),expected=store.getCipher(key),index=order.indexOf(step);
      if(!current||!expected||index<0||!same(current.intent,intent)||current.steps[step]
        ||order.slice(0,index).some(previous=>current.steps[previous]?.stage!=='response'))throw Error('host0_step_already_started');
      const next:Host0JournalSnapshot={intent,steps:{...current.steps,[step]:{stage:'sending'}}},c=cipher(next);
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId||task.publicUrl||task.firstLiveAt)throw Error('host0_step_state_changed');
        authorize(state,task,intent,step);task.batch5=summary(intent,'submitting');task.submittedAt=intent.createdAt;task.checkpoint=`host0_${step}_sending`;
      },{[key]:c},[],{[key]:expected});},
    async saveResponse(intent,step,response){const current=await load(),expected=store.getCipher(key);
      if(!current||!expected||!same(current.intent,intent)||current.steps[step]?.stage!=='sending'||!validResponse(response))throw Error('host0_response_state_changed');
      const next:Host0JournalSnapshot={intent,steps:{...current.steps,[step]:{stage:'response',response}}},c=cipher(next);
      // A successful remote response must be encrypted even if the site pauses or the review is revoked mid-flight.
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId)throw Error('host0_response_identity_changed');
        task.batch5=summary(intent,'opaque_response');task.checkpoint=`host0_${step}_response`;
      },{[key]:c},[],{[key]:expected});},
    async markAccepted(intent,url){const current=await load(),expected=store.getCipher(key);
      if(!current||!expected||!same(current.intent,intent)||current.steps.publicize?.stage!=='response'||url!==`https://${intent.slug}.host0.app/`)throw Error('host0_acceptance_state_changed');
      store.updateWithCiphers(state=>{const task=identity(state,intent);if(store.getCipher(key)!==expected||task.batch5?.operationId!==intent.taskId)throw Error('host0_acceptance_identity_changed');
        task.batch5=summary(intent,'api_receipt',url);task.publicUrl=url;task.status='review';task.checkpoint='host0_public_accepted';
      },{},[],{[key]:expected});},
  };
}
