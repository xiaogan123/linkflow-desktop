import {
  agentriotHash,
  isAgentRiotOpaqueProgress,
  validAgentRiotAccountSecret,
  validAgentRiotPageSecret,
  type AgentRiotAccountSecret,
  type AgentRiotPageSecret,
  type AgentRiotPersistence,
  type AgentRiotPublicationIntent,
} from '../integrations/agentriot';
import type {Account,AgentRiotTaskReceipt,Site,Task} from '../shared/types';
import type {State,Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'encryptSecrets'|'get'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAgentRiotAccountSecret(value:string|undefined):AgentRiotAccountSecret|undefined{if(!value)return;try{const parsed=JSON.parse(value);return validAgentRiotAccountSecret(parsed)?parsed:undefined}catch{return}}
export function parseAgentRiotPageSecret(value:string|undefined):AgentRiotPageSecret|undefined{if(!value)return;try{const parsed=JSON.parse(value);return validAgentRiotPageSecret(parsed)?parsed:undefined}catch{return}}

function sameAccountIntent(a:AgentRiotAccountSecret,b:AgentRiotAccountSecret){return a.operationId===b.operationId&&a.requestHash===b.requestHash&&a.installationId===b.installationId&&a.name===b.name&&a.tagline===b.tagline&&a.description===b.description&&a.createdAt===b.createdAt}
function samePageIntent(a:AgentRiotPageSecret,b:AgentRiotPageSecret){return a.operationId===b.operationId&&a.requestHash===b.requestHash&&a.sourceHash===b.sourceHash&&a.agentSlug===b.agentSlug&&a.createdAt===b.createdAt&&JSON.stringify(a.payload)===JSON.stringify(b.payload)}
function sameReceipt(a:AgentRiotTaskReceipt,b:AgentRiotPublicationIntent){return a.operationId===b.operationId&&a.accountId===b.accountId&&a.agentId===b.agentId&&a.agentSlug===b.agentSlug&&a.agentName===b.agentName&&a.targetUrl===b.targetUrl&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function taskAndSite(state:State,taskId:string,siteId:string){const task=state.tasks.find(value=>value.id===taskId),site=state.sites.find(value=>value.id===siteId);if(!task||!site||task.siteId!==site.id||task.channelId!=='agentriot'||task.sourceDomain!=='agentriot.com')throw Error('AgentRiot task binding changed');return {task,site}}
function accountIntentMatches(account:Account,secret:AgentRiotAccountSecret):boolean{const proof=account.agentriot;return account.channelId==='agentriot'&&!!account.id&&proof?.operationId===secret.operationId&&proof.requestHash===secret.requestHash&&proof.agentName===secret.name&&proof.tagline===secret.tagline&&proof.description===secret.description&&proof.installationIdHash===agentriotHash(secret.installationId)}
function encrypt(vault:SecureVault,key:string,value:string){const cipher=vault.encryptSecrets({[key]:value})[key];if(!cipher||cipher===value)throw Error('AgentRiot secret was not encrypted');return cipher}

export function createAgentRiotPersistence(store:StateStore,vault:SecureVault,options:{taskId:string;siteId:string;assertPublicationIntent:(snapshot:{state:State;task:Task;site:Site;account:Account},receipt:AgentRiotPublicationIntent)=>true;now?:()=>Date}):AgentRiotPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId))throw Error('AgentRiot persistence parameters invalid');
  const accountKey=(id:string)=>`account:${id}`,publicationKey=`publication:${options.taskId}`,stamp=()=> (options.now?.()??new Date()).toISOString();
  return {
    async persistAccountOpaque(accountId,secret){
      if(!UUID.test(accountId)||!validAgentRiotAccountSecret(secret)||!secret.opaqueResponse||secret.apiKey)throw Error('AgentRiot registration response invalid');
      const key=accountKey(accountId),beforeCipher=store.getCipher(key),beforePlain=beforeCipher===undefined?undefined:await vault.get(key);if(beforeCipher===undefined||store.getCipher(key)!==beforeCipher)throw Error('AgentRiot registration response changed while read');const before=parseAgentRiotAccountSecret(beforePlain);if(!before||!sameAccountIntent(before,secret))throw Error('AgentRiot registration intent changed');if(before.opaqueResponse){if(JSON.stringify(before)===JSON.stringify(secret))return;if(!isAgentRiotOpaqueProgress(before.opaqueResponse,secret.opaqueResponse))throw Error('AgentRiot registration response is not monotonic')}
      const serialized=JSON.stringify(secret),cipher=encrypt(vault,key,serialized);
      store.updateWithCiphers(state=>{const {task}=taskAndSite(state,options.taskId,options.siteId),account=state.accounts.find(value=>value.id===accountId);if(task.accountId!==accountId||!account||!accountIntentMatches(account,secret)||!['intent','opaque_response'].includes(account.agentriot!.stage)||account.status==='registered')throw Error('AgentRiot registration state changed');account.agentriot={...account.agentriot!,stage:'opaque_response'};account.status='unknown';account.updatedAt=stamp()},{[key]:cipher},[],{[key]:beforeCipher});
    },
    async persistPublicationIntent(secret,receipt){
      if(!validAgentRiotPageSecret(secret)||secret.opaqueResponse||secret.recoveryEvidence||receipt.stage!=='submitting'||secret.operationId!==receipt.operationId||secret.requestHash!==receipt.requestHash||secret.sourceHash!==receipt.sourceHash||secret.agentSlug!==receipt.agentSlug||secret.createdAt!==receipt.createdAt)throw Error('AgentRiot publication intent invalid');
      const serialized=JSON.stringify(secret),cipher=encrypt(vault,publicationKey,serialized);
      store.updateWithCiphers(state=>{const {task,site}=taskAndSite(state,options.taskId,options.siteId),account=state.accounts.find(value=>value.id===receipt.accountId);if(store.getCipher(publicationKey)!==undefined||task.agentriot||task.submittedAt||task.publicUrl||task.firstLiveAt||task.status!=='running'||task.accountId!==receipt.accountId||!account||options.assertPublicationIntent({state,task,site,account},receipt)!==true)throw Error('AgentRiot publication authorization changed');task.agentriot={...receipt};task.submittedAt=receipt.createdAt;task.checkpoint='agentriot_update_submitting';task.updatedAt=stamp()},{[publicationKey]:cipher},[],{[publicationKey]:undefined});
    },
    async persistPublicationOpaque(secret){
      if(!validAgentRiotPageSecret(secret)||!secret.opaqueResponse||secret.recoveryEvidence)throw Error('AgentRiot publication response invalid');const beforeCipher=store.getCipher(publicationKey),beforePlain=beforeCipher===undefined?undefined:await vault.get(publicationKey);if(beforeCipher===undefined||store.getCipher(publicationKey)!==beforeCipher)throw Error('AgentRiot publication response changed while read');const before=parseAgentRiotPageSecret(beforePlain);if(!before||!samePageIntent(before,secret))throw Error('AgentRiot publication intent changed');if(before.opaqueResponse){if(JSON.stringify(before)===JSON.stringify(secret))return;if(!isAgentRiotOpaqueProgress(before.opaqueResponse,secret.opaqueResponse))throw Error('AgentRiot publication response is not monotonic')}
      const serialized=JSON.stringify(secret),cipher=encrypt(vault,publicationKey,serialized);
      store.updateWithCiphers(state=>{const {task}=taskAndSite(state,options.taskId,options.siteId),receipt=task.agentriot;if(!receipt||!sameReceipt(receipt,{operationId:secret.operationId,accountId:receipt.accountId,agentId:receipt.agentId,agentSlug:secret.agentSlug,agentName:receipt.agentName,targetUrl:receipt.targetUrl,sourceHash:secret.sourceHash,requestHash:secret.requestHash,createdAt:secret.createdAt,stage:'submitting'})||!['submitting','opaque_response'].includes(receipt.stage)||task.submittedAt!==secret.createdAt||task.status==='live')throw Error('AgentRiot publication response stage changed');task.agentriot={...receipt,stage:'opaque_response'};task.checkpoint='agentriot_update_opaque_response';task.updatedAt=stamp()},{[publicationKey]:cipher},[],{[publicationKey]:beforeCipher});
    },
    async persistRecoveryEvidence(secret){
      if(!validAgentRiotPageSecret(secret)||!secret.recoveryEvidence)throw Error('AgentRiot recovery evidence invalid');const beforeCipher=store.getCipher(publicationKey),beforePlain=beforeCipher===undefined?undefined:await vault.get(publicationKey);if(beforeCipher===undefined||store.getCipher(publicationKey)!==beforeCipher)throw Error('AgentRiot recovery evidence changed while read');const before=parseAgentRiotPageSecret(beforePlain);if(!before||!samePageIntent(before,secret)||JSON.stringify(before.opaqueResponse)!==JSON.stringify(secret.opaqueResponse))throw Error('AgentRiot recovery intent changed');if(before.recoveryEvidence){if(JSON.stringify(before)===JSON.stringify(secret))return;throw Error('AgentRiot recovery evidence is immutable')}
      const serialized=JSON.stringify(secret),cipher=encrypt(vault,publicationKey,serialized);
      store.updateWithCiphers(state=>{const {task}=taskAndSite(state,options.taskId,options.siteId),receipt=task.agentriot;if(!receipt||receipt.operationId!==secret.operationId||receipt.requestHash!==secret.requestHash||receipt.sourceHash!==secret.sourceHash||receipt.agentSlug!==secret.agentSlug||receipt.createdAt!==secret.createdAt||!['submitting','opaque_response','api_receipt'].includes(receipt.stage)||task.submittedAt!==secret.createdAt||task.status==='live')throw Error('AgentRiot recovery evidence stage changed');task.checkpoint='agentriot_get_recovery_evidence_pending';task.updatedAt=stamp()},{[publicationKey]:cipher},[],{[publicationKey]:beforeCipher});
    },
  };
}

export const agentRiotPersistenceTesting={sameAccountIntent,samePageIntent,sameReceipt,accountIntentMatches};
