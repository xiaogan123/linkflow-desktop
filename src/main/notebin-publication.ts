import {createHash} from 'node:crypto';
import {
  NOTEBIN_ORIGIN,
  NOTEBIN_NOTES_URL,
  inspectNotebinOpaqueResponse,
  notebinNoteRequest,
  notebinTokenFingerprint,
  sameNotebinIntent,
  validNotebinIntent,
  validNotebinSignupClaim,
  type NotebinContentApproval,
  type NotebinIdentityReceipt,
  type NotebinIntent,
  type NotebinKeyReceipt,
  type NotebinMintPersistence,
  type NotebinOpaqueResponse,
  type NotebinPowChallenge,
  type NotebinPublicationPersistence,
  type NotebinPublicationReceipt,
  type NotebinRecoveryEvidence,
  type NotebinRecoveryEvidenceBase,
  type NotebinRootIdentityBinding,
  type NotebinSignupClaim,
  type NotebinSignupPersistence,
  type NotebinSignupState,
} from '../integrations/notebin';
import {validNotebinRecoveryEvidence,type NotebinDraftIdentity} from '../integrations/notebin-publisher';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const ACCOUNT_ID=/^[A-Za-z0-9_-]{8,128}$/;

export interface NotebinIdentityJournal {
  localAccountId:string;
  rootBinding?:NotebinRootIdentityBinding;
  signup?:{
    claim:NotebinSignupClaim;
    challenge?:NotebinPowChallenge;
    intent?:NotebinIntent;
    stage:'claimed'|'challenge'|'intent'|'opaque_response'|'ready';
    receipt?:NotebinIdentityReceipt;
    rootKeyFingerprint?:string;
  };
  mint?:{
    intent:NotebinIntent;
    stage:'intent'|'opaque_response'|'ready'|'pending_readback';
    receipt?:NotebinKeyReceipt;
  };
}
export interface NotebinPublicationJournal {
  taskId:string;
  siteId:string;
  localAccountId:string;
  rootAccountId:string;
  intent:NotebinIntent;
  approval:NotebinContentApproval;
  stage:'intent'|'opaque_response'|'api_receipt'|'owned';
  receipt?:NotebinPublicationReceipt;
  recovery?:NotebinRecoveryEvidence;
  updatedAt:string;
}
export interface NotebinJournalState {
  identities:Record<string,NotebinIdentityJournal>;
  publications:Record<string,NotebinPublicationJournal>;
}
export interface NotebinNoteKeyReadbackBinding {
  localAccountId:string;
  rootAccountId:string;
  tokenFingerprint:string;
  keyId:string;
  audience:typeof NOTEBIN_ORIGIN;
  scopes:readonly ['note:read','note:create'];
  keyListResponseHash:string;
  verifiedAt:string;
  binding:'exact_readback';
}
export interface NotebinJournalStore {
  read():NotebinJournalState;
  update(mutator:(state:NotebinJournalState)=>void):void;
  updateWithCiphers(mutator:(state:NotebinJournalState)=>void,ciphers:Record<string,string>):void;
  getCipher(key:string):string|undefined;
}
export interface NotebinSecureVault {
  encryptSecrets(values:Record<string,string>):Record<string,string>;
  get(key:string):Promise<string|undefined>;
}

interface SignupOpaqueSecret {version:1;kind:'notebin_signup_opaque';value:NotebinOpaqueResponse}
interface IdentitySecret {version:1;kind:'notebin_identity';rootAccountId:string;rootApiKey:string;rootKeyFingerprint:string}
interface MintOpaqueSecret {version:1;kind:'notebin_mint_opaque';value:NotebinOpaqueResponse}
interface NoteKeySecret {version:1;kind:'notebin_note_key';receipt:NotebinKeyReceipt;noteApiKey:string}
interface NoteKeyReadbackSecret {version:1;kind:'notebin_note_key_readback';receipt:NotebinKeyReceipt}
interface PublicationOpaqueSecret {version:1;kind:'notebin_publication_opaque';value:NotebinOpaqueResponse}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const exactDate=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const signupKey=(localAccountId:string)=>`notebin:identity:${localAccountId}:signup`;
const mintKey=(localAccountId:string)=>`notebin:identity:${localAccountId}:mint`;
const mintReadbackKey=(localAccountId:string)=>`notebin:identity:${localAccountId}:mint:readback`;
const publicationKey=(taskId:string)=>`publication:${taskId}`;
const vaultByStore=new WeakMap<NotebinJournalStore,NotebinSecureVault>();
function encrypted(vault:NotebinSecureVault,key:string,plain:string){const value=vault.encryptSecrets({[key]:plain})[key];if(!value||value===plain)throw Error('Notebin secret encryption unavailable');return value}
function opaqueEqual(a:NotebinOpaqueResponse,b:NotebinOpaqueResponse){return sameNotebinIntent(a,b)&&a.status===b.status&&a.contentType===b.contentType&&a.responseUrl===b.responseUrl&&a.redirected===b.redirected&&a.responseType===b.responseType&&a.bodySha256===b.bodySha256&&a.bodyBase64===b.bodyBase64}
export function notebinPublicationOpaqueMatchesIntent(value:NotebinOpaqueResponse,intent:NotebinIntent){return inspectNotebinOpaqueResponse(value).valid&&sameNotebinIntent(value,intent)&&(value.responseUrl===''||value.responseUrl===NOTEBIN_NOTES_URL)&&!value.redirected&&value.responseType!=='opaqueredirect'&&!(value.status>=300&&value.status<400)}
function sameClaim(a:NotebinSignupClaim,b:NotebinSignupClaim){return a.version===b.version&&a.operation===b.operation&&a.operationId===b.operationId&&a.localAccountId===b.localAccountId&&a.displayNameHash===b.displayNameHash&&a.createdAt===b.createdAt}
function clone<T>(value:T):T{return structuredClone(value)}

export function emptyNotebinJournalState():NotebinJournalState{return {identities:{},publications:{}}}
export function bindNotebinRootIdentity(store:NotebinJournalStore,binding:NotebinRootIdentityBinding){
  if(!UUID.test(binding.localAccountId)||!ACCOUNT_ID.test(binding.rootAccountId)||!HASH.test(binding.rootKeyFingerprint)||!HASH.test(binding.whoamiResponseHash)||binding.keyListResponseHash!==undefined&&!HASH.test(binding.keyListResponseHash)||!exactDate(binding.verifiedAt)||binding.binding!=='exact_readback')throw Error('Notebin root readback binding invalid');
  store.update(state=>{const identity=state.identities[binding.localAccountId],signup=identity?.signup;if(!identity||signup?.stage!=='ready'||signup.receipt?.rootAccountId!==binding.rootAccountId||signup.rootKeyFingerprint!==binding.rootKeyFingerprint)throw Error('Notebin root readback does not match saved identity');if(identity.rootBinding&&JSON.stringify(identity.rootBinding)!==JSON.stringify(binding))throw Error('Notebin root readback binding conflict');identity.rootBinding=clone(binding)});
}
export function bindNotebinNoteKeyReadback(store:NotebinJournalStore,binding:NotebinNoteKeyReadbackBinding,explicitVault?:NotebinSecureVault){
  if(!UUID.test(binding.localAccountId)||!ACCOUNT_ID.test(binding.rootAccountId)||!ACCOUNT_ID.test(binding.keyId)||!HASH.test(binding.tokenFingerprint)||!HASH.test(binding.keyListResponseHash)||!exactDate(binding.verifiedAt)||binding.binding!=='exact_readback'||binding.audience!==NOTEBIN_ORIGIN||JSON.stringify(binding.scopes)!==JSON.stringify(['note:read','note:create']))throw Error('Notebin note key readback binding invalid');
  const vault=explicitVault??vaultByStore.get(store);if(!vault)throw Error('Notebin note key vault unavailable');const key=mintKey(binding.localAccountId),readbackKey=mintReadbackKey(binding.localAccountId),priorCipher=store.getCipher(key),snapshot=store.read(),identity=snapshot.identities[binding.localAccountId],mint=identity?.mint,current=mint?.receipt;if(!priorCipher||!identity||identity.rootBinding?.binding!=='exact_readback'||identity.rootBinding.rootAccountId!==binding.rootAccountId||!mint||!current)throw Error('Notebin note key readback does not match saved mint');
  if(mint.stage==='ready'&&current.binding==='exact_readback'){if(current.localAccountId!==binding.localAccountId||current.rootAccountId!==binding.rootAccountId||current.tokenFingerprint!==binding.tokenFingerprint||current.keyId!==binding.keyId||current.readbackResponseHash!==binding.keyListResponseHash||current.readbackVerifiedAt!==binding.verifiedAt)throw Error('Notebin note key readback conflict');return}
  if(mint.stage!=='pending_readback'||current.binding!=='pending_readback'||current.localAccountId!==binding.localAccountId||current.rootAccountId!==binding.rootAccountId||current.tokenFingerprint!==binding.tokenFingerprint||current.keyId!==undefined&&current.keyId!==binding.keyId||store.getCipher(readbackKey))throw Error('Notebin note key readback does not match saved mint');
  const receipt:NotebinKeyReceipt={...current,keyId:binding.keyId,binding:'exact_readback',readbackResponseHash:binding.keyListResponseHash,readbackVerifiedAt:binding.verifiedAt},serialized=JSON.stringify({version:1,kind:'notebin_note_key_readback',receipt} satisfies NoteKeyReadbackSecret),cipher=encrypted(vault,readbackKey,serialized);
  store.updateWithCiphers(state=>{const nextIdentity=state.identities[binding.localAccountId],nextMint=nextIdentity?.mint,next=nextMint?.receipt;if(!nextIdentity||nextIdentity.rootBinding?.binding!=='exact_readback'||nextIdentity.rootBinding.rootAccountId!==binding.rootAccountId||!nextMint||nextMint.stage!=='pending_readback'||!next||next.binding!=='pending_readback'||next.localAccountId!==binding.localAccountId||next.rootAccountId!==binding.rootAccountId||next.tokenFingerprint!==binding.tokenFingerprint||next.keyId!==undefined&&next.keyId!==binding.keyId||store.getCipher(key)!==priorCipher||store.getCipher(readbackKey))throw Error('Notebin note key readback does not match saved mint');nextMint.receipt=clone(receipt);nextMint.stage='ready'},{[readbackKey]:cipher});
}
export function parseNotebinSignupSecret(value:string):SignupOpaqueSecret|IdentitySecret|undefined{
  try{const parsed=JSON.parse(value) as SignupOpaqueSecret|IdentitySecret;if(!parsed||parsed.version!==1)return;if(parsed.kind==='notebin_signup_opaque')return inspectNotebinOpaqueResponse(parsed.value,64*1024).valid?parsed:undefined;if(parsed.kind==='notebin_identity'&&ACCOUNT_ID.test(parsed.rootAccountId)&&typeof parsed.rootApiKey==='string'&&parsed.rootApiKey.startsWith('pbca_live_')&&HASH.test(parsed.rootKeyFingerprint)&&notebinTokenFingerprint(parsed.rootApiKey)===parsed.rootKeyFingerprint)return parsed}catch{return}
}
export function parseNotebinMintSecret(value:string):MintOpaqueSecret|NoteKeySecret|undefined{
  try{const parsed=JSON.parse(value) as MintOpaqueSecret|NoteKeySecret;if(!parsed||parsed.version!==1)return;if(parsed.kind==='notebin_mint_opaque')return inspectNotebinOpaqueResponse(parsed.value,64*1024).valid?parsed:undefined;if(parsed.kind!=='notebin_note_key'||typeof parsed.noteApiKey!=='string'||!parsed.noteApiKey.startsWith('pbca_live_'))return;const receipt=parsed.receipt;if(!receipt||!UUID.test(receipt.localAccountId)||!ACCOUNT_ID.test(receipt.rootAccountId)||receipt.audience!==NOTEBIN_ORIGIN||JSON.stringify(receipt.scopes)!==JSON.stringify(['note:read','note:create'])||!HASH.test(receipt.tokenFingerprint)||notebinTokenFingerprint(parsed.noteApiKey)!==receipt.tokenFingerprint||!['exact_response','exact_readback','pending_readback'].includes(receipt.binding)||receipt.keyId!==undefined&&!ACCOUNT_ID.test(receipt.keyId)||!exactDate(receipt.createdAt)||!HASH.test(receipt.requestHash))return;if(receipt.binding==='exact_readback'&&(!receipt.keyId||!HASH.test(receipt.readbackResponseHash??'')||!exactDate(receipt.readbackVerifiedAt??''))||receipt.binding!=='exact_readback'&&(receipt.readbackResponseHash!==undefined||receipt.readbackVerifiedAt!==undefined))return;return parsed}catch{return}
}
export function parseNotebinNoteKeyReadbackSecret(value:string):NoteKeyReadbackSecret|undefined{try{const parsed=JSON.parse(value) as NoteKeyReadbackSecret,receipt=parsed?.receipt;if(parsed?.version!==1||parsed.kind!=='notebin_note_key_readback'||!receipt||receipt.binding!=='exact_readback'||!UUID.test(receipt.localAccountId)||!ACCOUNT_ID.test(receipt.rootAccountId)||receipt.audience!==NOTEBIN_ORIGIN||JSON.stringify(receipt.scopes)!==JSON.stringify(['note:read','note:create'])||!HASH.test(receipt.tokenFingerprint)||!ACCOUNT_ID.test(receipt.keyId??'')||!HASH.test(receipt.requestHash)||!exactDate(receipt.createdAt)||!HASH.test(receipt.readbackResponseHash??'')||!exactDate(receipt.readbackVerifiedAt??''))return;return parsed}catch{return}}
export function parseNotebinPublicationSecret(value:string):PublicationOpaqueSecret|undefined{try{const parsed=JSON.parse(value) as PublicationOpaqueSecret;return parsed?.version===1&&parsed.kind==='notebin_publication_opaque'&&inspectNotebinOpaqueResponse(parsed.value).valid?parsed:undefined}catch{return}}

export function createNotebinSignupPersistence(store:NotebinJournalStore,vault:NotebinSecureVault,options:{localAccountId:string;assertAuthorized:(snapshot:NotebinJournalState,intent:NotebinIntent)=>true;now?:()=>Date}):NotebinSignupPersistence{
  if(!UUID.test(options.localAccountId))throw Error('Notebin local account id invalid');const key=signupKey(options.localAccountId),stamp=()=> (options.now?.()??new Date()).toISOString();
  const journal=()=>store.read().identities[options.localAccountId]?.signup;
  return {
    async claimSignup(claim){if(!validNotebinSignupClaim(claim)||claim.localAccountId!==options.localAccountId)throw Error('Notebin signup claim invalid');let outcome:'claimed'|'existing'='claimed';store.update(state=>{const current=state.identities[options.localAccountId]??={localAccountId:options.localAccountId};if(current.signup){if(!sameClaim(current.signup.claim,claim))throw Error('Notebin signup claim conflict');outcome='existing';return}current.signup={claim:clone(claim),stage:'claimed'}});return outcome},
    async loadSignupState(){const current=journal();if(!current)return;let opaque:NotebinOpaqueResponse|undefined;if(current.stage==='opaque_response'){const secret=await vault.get(key),parsed=secret?parseNotebinSignupSecret(secret):undefined;if(parsed?.kind==='notebin_signup_opaque')opaque=parsed.value}return {claim:clone(current.claim),challenge:current.challenge&&clone(current.challenge),intent:current.intent&&clone(current.intent),opaque,receipt:current.receipt&&clone(current.receipt)}},
    async persistChallenge(claim,challenge){if(!validNotebinSignupClaim(claim)||!HASH.test(challenge.responseHash)||challenge.difficultyBits<1||challenge.expiresAt!==undefined&&(!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt<0))throw Error('Notebin challenge invalid');store.update(state=>{const current=state.identities[options.localAccountId]?.signup;if(!current||!sameClaim(current.claim,claim)||!['claimed','challenge'].includes(current.stage))throw Error('Notebin signup stage invalid');if(current.challenge){if(JSON.stringify(current.challenge)===JSON.stringify(challenge))return;const currentTime=(options.now?.()??new Date()).getTime();if(current.stage!=='challenge'||current.intent||current.challenge.expiresAt===undefined||current.challenge.expiresAt>currentTime||challenge.expiresAt!==undefined&&challenge.expiresAt<=currentTime)throw Error('Notebin challenge conflict')}current.challenge=clone(challenge);current.stage='challenge'})},
    async persistIntent(intent){if(!validNotebinIntent(intent)||intent.operation!=='signup'||intent.localAccountId!==options.localAccountId)throw Error('Notebin signup intent invalid');store.update(state=>{const current=state.identities[options.localAccountId]?.signup;if(!current||current.stage!=='challenge'||!current.challenge||current.intent)throw Error('Notebin signup intent stage invalid');current.intent=clone(intent);current.stage='intent'})},
    assertAuthorized(intent){const state=store.read(),current=state.identities[options.localAccountId]?.signup;if(!current?.intent||current.stage!=='intent'||!sameNotebinIntent(current.intent,intent))throw Error('Notebin signup authorization changed');if(options.assertAuthorized(clone(state),clone(intent))!==true)throw Error('Notebin signup authorization changed');return true},
    async persistOpaqueResponse(value){if(value.operation!=='signup'||value.localAccountId!==options.localAccountId||!inspectNotebinOpaqueResponse(value,64*1024).valid)throw Error('Notebin signup opaque invalid');const existing=store.getCipher(key);if(existing){const plain=await vault.get(key),parsed=plain?parseNotebinSignupSecret(plain):undefined;if(parsed?.kind==='notebin_signup_opaque'&&opaqueEqual(parsed.value,value))return;throw Error('Notebin signup secret already exists')}const plain=JSON.stringify({version:1,kind:'notebin_signup_opaque',value} satisfies SignupOpaqueSecret),cipher=encrypted(vault,key,plain);store.updateWithCiphers(state=>{const current=state.identities[options.localAccountId]?.signup;if(!current?.intent||current.stage!=='intent'||!sameNotebinIntent(current.intent,value)||store.getCipher(key))throw Error('Notebin signup opaque stage invalid');current.stage='opaque_response'}, {[key]:cipher})},
    async promoteIdentity(receipt,rootApiKey){if(receipt.localAccountId!==options.localAccountId||!ACCOUNT_ID.test(receipt.rootAccountId)||typeof rootApiKey!=='string'||!rootApiKey.startsWith('pbca_live_'))throw Error('Notebin identity receipt invalid');const fingerprint=notebinTokenFingerprint(rootApiKey),plain=JSON.stringify({version:1,kind:'notebin_identity',rootAccountId:receipt.rootAccountId,rootApiKey,rootKeyFingerprint:fingerprint} satisfies IdentitySecret),cipher=encrypted(vault,key,plain);store.updateWithCiphers(state=>{const current=state.identities[options.localAccountId]?.signup;if(!current?.intent||current.stage!=='opaque_response'||current.intent.requestHash!==receipt.signupRequestHash)throw Error('Notebin identity promotion stage invalid');current.receipt=clone(receipt);current.rootKeyFingerprint=fingerprint;current.stage='ready'}, {[key]:cipher})},
  };
}

export function createNotebinMintPersistence(store:NotebinJournalStore,vault:NotebinSecureVault,options:{localAccountId:string;rootAccountId:string;assertAuthorized:(snapshot:NotebinJournalState,intent:NotebinIntent)=>true}):NotebinMintPersistence{
  if(!UUID.test(options.localAccountId)||!ACCOUNT_ID.test(options.rootAccountId))throw Error('Notebin mint binding invalid');const key=mintKey(options.localAccountId);vaultByStore.set(store,vault);
  return {
    async claimIntent(intent){if(!validNotebinIntent(intent)||intent.operation!=='mint'||intent.localAccountId!==options.localAccountId||intent.rootAccountId!==options.rootAccountId)throw Error('Notebin mint intent invalid');let outcome:'claimed'|'existing'='claimed';store.update(state=>{const identity=state.identities[options.localAccountId],signup=identity?.signup;if(!identity||signup?.stage!=='ready'||signup.receipt?.rootAccountId!==options.rootAccountId||identity.rootBinding?.binding!=='exact_readback'||identity.rootBinding.rootAccountId!==options.rootAccountId||identity.rootBinding.rootKeyFingerprint!==signup.rootKeyFingerprint)throw Error('Notebin root identity not ready');if(identity.mint){if(!sameNotebinIntent(identity.mint.intent,intent))throw Error('Notebin mint intent conflict');outcome='existing';return}identity.mint={intent:clone(intent),stage:'intent'}});return outcome},
    async loadOpaqueResponse(){const current=store.read().identities[options.localAccountId]?.mint;if(current?.stage!=='opaque_response')return;const plain=await vault.get(key),parsed=plain?parseNotebinMintSecret(plain):undefined;return parsed?.kind==='notebin_mint_opaque'?parsed.value:undefined},
    assertAuthorized(intent){const state=store.read(),current=state.identities[options.localAccountId]?.mint;if(!current||current.stage!=='intent'||!sameNotebinIntent(current.intent,intent))throw Error('Notebin mint authorization changed');if(options.assertAuthorized(clone(state),clone(intent))!==true)throw Error('Notebin mint authorization changed');return true},
    async persistOpaqueResponse(value){if(value.operation!=='mint'||value.localAccountId!==options.localAccountId||value.rootAccountId!==options.rootAccountId||!inspectNotebinOpaqueResponse(value,64*1024).valid)throw Error('Notebin mint opaque invalid');const existing=store.getCipher(key);if(existing){const plain=await vault.get(key),parsed=plain?parseNotebinMintSecret(plain):undefined;if(parsed?.kind==='notebin_mint_opaque'&&opaqueEqual(parsed.value,value))return;throw Error('Notebin mint secret already exists')}const plain=JSON.stringify({version:1,kind:'notebin_mint_opaque',value} satisfies MintOpaqueSecret),cipher=encrypted(vault,key,plain);store.updateWithCiphers(state=>{const current=state.identities[options.localAccountId]?.mint;if(!current||current.stage!=='intent'||!sameNotebinIntent(current.intent,value)||store.getCipher(key))throw Error('Notebin mint opaque stage invalid');current.stage='opaque_response'}, {[key]:cipher})},
    async promoteKey(receipt,noteApiKey){if(receipt.localAccountId!==options.localAccountId||receipt.rootAccountId!==options.rootAccountId||receipt.audience!==NOTEBIN_ORIGIN||notebinTokenFingerprint(noteApiKey)!==receipt.tokenFingerprint)throw Error('Notebin note key receipt invalid');const plain=JSON.stringify({version:1,kind:'notebin_note_key',receipt,noteApiKey} satisfies NoteKeySecret),cipher=encrypted(vault,key,plain);store.updateWithCiphers(state=>{const current=state.identities[options.localAccountId]?.mint;if(!current||current.stage!=='opaque_response'||current.intent.requestHash!==receipt.requestHash)throw Error('Notebin key promotion stage invalid');current.receipt=clone(receipt);current.stage=receipt.binding==='pending_readback'?'pending_readback':'ready'}, {[key]:cipher})},
  };
}

export function createNotebinPublicationPersistence(store:NotebinJournalStore,vault:NotebinSecureVault,options:{taskId:string;siteId:string;localAccountId:string;rootAccountId:string;approval:NotebinContentApproval;identity?:NotebinDraftIdentity;assertAuthorized:(snapshot:NotebinJournalState,intent:NotebinIntent)=>true;now?:()=>Date}):NotebinPublicationPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId)||!UUID.test(options.localAccountId)||!ACCOUNT_ID.test(options.rootAccountId)||options.approval.version!==1||!HASH.test(options.approval.sourceHash)||!HASH.test(options.approval.requestHash)||!exactDate(options.approval.approvedAt)||options.identity&&(options.identity.sourceHash!==options.approval.sourceHash||options.identity.requestHash!==options.approval.requestHash))throw Error('Notebin publication binding invalid');const key=publicationKey(options.taskId),stamp=()=> (options.now?.()??new Date()).toISOString();
  return {
    async claimIntent(intent){if(!validNotebinIntent(intent)||intent.operation!=='publish'||intent.localAccountId!==options.localAccountId||intent.rootAccountId!==options.rootAccountId||intent.sourceHash!==options.approval.sourceHash||intent.requestHash!==options.approval.requestHash)throw Error('Notebin publication intent invalid');let outcome:'claimed'|'existing'='claimed';store.update(state=>{const identity=state.identities[options.localAccountId],mint=identity?.mint;if(!identity||!mint?.receipt||mint.stage!=='ready'||!['exact_response','exact_readback'].includes(mint.receipt.binding)||mint.receipt.rootAccountId!==options.rootAccountId||mint.receipt.tokenFingerprint!==intent.noteKeyFingerprint)throw Error('Notebin note key binding changed');const current=state.publications[options.taskId];if(current){if(!sameNotebinIntent(current.intent,intent)||current.siteId!==options.siteId)throw Error('Notebin publication intent conflict');outcome='existing';return}if(options.assertAuthorized(clone(state),clone(intent))!==true)throw Error('Notebin publication authorization changed');state.publications[options.taskId]={taskId:options.taskId,siteId:options.siteId,localAccountId:options.localAccountId,rootAccountId:options.rootAccountId,intent:clone(intent),approval:clone(options.approval),stage:'intent',updatedAt:stamp()}});return outcome},
    async loadOpaqueResponse(){const current=store.read().publications[options.taskId];if(current?.stage!=='opaque_response')return;const plain=await vault.get(key),parsed=plain?parseNotebinPublicationSecret(plain):undefined;return parsed?.value},
    assertAuthorized(intent){const state=store.read(),current=state.publications[options.taskId];if(!current||current.stage!=='intent'||!sameNotebinIntent(current.intent,intent)||options.assertAuthorized(clone(state),clone(intent))!==true)throw Error('Notebin publication authorization changed');return true},
    async persistOpaqueResponse(value){if(value.operation!=='publish'||value.localAccountId!==options.localAccountId||value.rootAccountId!==options.rootAccountId||!notebinPublicationOpaqueMatchesIntent(value,value))throw Error('Notebin publication opaque invalid');const existing=store.getCipher(key);if(existing){const plain=await vault.get(key),parsed=plain?parseNotebinPublicationSecret(plain):undefined;if(parsed&&opaqueEqual(parsed.value,value))return;throw Error('Notebin publication opaque already exists')}const plain=JSON.stringify({version:1,kind:'notebin_publication_opaque',value} satisfies PublicationOpaqueSecret),cipher=encrypted(vault,key,plain);store.updateWithCiphers(state=>{const current=state.publications[options.taskId];if(!current||!sameNotebinIntent(current.intent,value)||store.getCipher(key))throw Error('Notebin publication opaque stage invalid');if(current.stage==='intent'){current.stage='opaque_response';current.updatedAt=stamp()}else if((current.stage==='api_receipt'||current.stage==='owned')&&current.recovery?.originalStage==='intent'&&current.receipt){current.recovery.originalStage='opaque_response';current.updatedAt=stamp()}else throw Error('Notebin publication opaque stage invalid')}, {[key]:cipher})},
    async preserveReceipt(receipt){if(receipt.operationId!==store.read().publications[options.taskId]?.intent.operationId||receipt.localAccountId!==options.localAccountId||receipt.rootAccountId!==options.rootAccountId||receipt.sourceHash!==options.approval.sourceHash||receipt.requestHash!==options.approval.requestHash||receipt.noteKeyFingerprint!==store.read().publications[options.taskId]?.intent.noteKeyFingerprint)throw Error('Notebin receipt binding invalid');store.update(state=>{const current=state.publications[options.taskId];if(!current||current.recovery||!['intent','opaque_response','api_receipt'].includes(current.stage)||!sameNotebinIntent(current.intent,{...current.intent,operationId:receipt.operationId,requestHash:receipt.requestHash,sourceHash:receipt.sourceHash,noteKeyFingerprint:receipt.noteKeyFingerprint}))throw Error('Notebin receipt stage invalid');if(current.receipt&&JSON.stringify(current.receipt)!==JSON.stringify(receipt))throw Error('Notebin receipt conflict');current.receipt=clone(receipt);current.stage='api_receipt';current.updatedAt=stamp()})},
    async preserveRecoveredReceipt(receipt,evidence:NotebinRecoveryEvidenceBase){
      const detail=evidence.detail,request=!options.identity&&typeof detail?.title==='string'&&typeof detail.description==='string'&&typeof detail.markdown==='string'?notebinNoteRequest(detail.title,detail.description,detail.markdown):undefined,identity=options.identity??(request?{title:detail.title as string,description:detail.description as string,markdown:detail.markdown as string,sourceHash:request.sourceHash,requestHash:request.requestHash,sourceBytes:request.sourceBytes}:undefined),snapshot=store.read(),saved=snapshot.publications[options.taskId];if(!identity||identity.sourceHash!==options.approval.sourceHash||identity.requestHash!==options.approval.requestHash||!saved||!['intent','opaque_response','api_receipt','owned'].includes(saved.stage)||!validNotebinRecoveryEvidence(evidence,saved.intent,identity,receipt)||receipt.ownership!=='pending'||receipt.retention!=='no_scheduled_expiry'||receipt.expiresAt!==null)throw Error('Notebin recovery proof invalid');
      if(saved.stage==='api_receipt'||saved.stage==='owned'){const existing=saved.recovery,expected={...evidence,originalStage:existing?.originalStage} as NotebinRecoveryEvidence;if(!existing||JSON.stringify(existing)!==JSON.stringify(expected)||!saved.receipt||JSON.stringify({...saved.receipt,ownership:'pending'})!==JSON.stringify(receipt))throw Error('Notebin recovery proof conflict');return}
      const originalStage=saved.stage,priorCipher=store.getCipher(key);if(originalStage==='intent'){if(priorCipher)throw Error('Notebin transport-unknown recovery has an unexpected response cipher')}else{if(!priorCipher)throw Error('Notebin opaque recovery is missing its original response');const plain=await vault.get(key),parsed=plain?parseNotebinPublicationSecret(plain):undefined;if(!parsed||!notebinPublicationOpaqueMatchesIntent(parsed.value,saved.intent))throw Error('Notebin opaque recovery response is not bound to the original intent')}
      const recovery:NotebinRecoveryEvidence={...clone(evidence),originalStage};store.update(state=>{const current=state.publications[options.taskId];if(!current||current.stage!==originalStage||current.receipt||current.recovery||!sameNotebinIntent(current.intent,saved.intent)||store.getCipher(key)!==priorCipher)throw Error('Notebin recovery stage changed');current.receipt=clone(receipt);current.recovery=clone(recovery);current.stage='api_receipt';current.updatedAt=stamp()})
    },
    async promoteOwned(receipt){if(receipt.ownership!=='owned_list_match'||receipt.retention!=='no_scheduled_expiry'||receipt.expiresAt!==null)throw Error('Notebin owned receipt incomplete');store.update(state=>{const current=state.publications[options.taskId];if(!current||current.stage!=='api_receipt'||!current.receipt||current.receipt.itemId!==receipt.itemId||current.receipt.requestHash!==receipt.requestHash)throw Error('Notebin owned promotion stage invalid');if(options.assertAuthorized(clone(state),clone(current.intent))!==true)throw Error('Notebin publication authorization changed');current.receipt=clone(receipt);current.stage='owned';current.updatedAt=stamp()})},
  };
}

export async function loadNotebinIdentitySecret(vault:NotebinSecureVault,localAccountId:string){const value=await vault.get(signupKey(localAccountId));const parsed=value?parseNotebinSignupSecret(value):undefined;return parsed?.kind==='notebin_identity'?parsed:undefined}
export async function loadNotebinNoteKeySecret(vault:NotebinSecureVault,localAccountId:string){const value=await vault.get(mintKey(localAccountId)),parsed=value?parseNotebinMintSecret(value):undefined;if(parsed?.kind!=='notebin_note_key')return;const readbackValue=await vault.get(mintReadbackKey(localAccountId));if(readbackValue===undefined)return parsed;const readback=parseNotebinNoteKeyReadbackSecret(readbackValue);if(!readback||parsed.receipt.binding!=='pending_readback'||readback.receipt.localAccountId!==parsed.receipt.localAccountId||readback.receipt.rootAccountId!==parsed.receipt.rootAccountId||readback.receipt.tokenFingerprint!==parsed.receipt.tokenFingerprint||readback.receipt.requestHash!==parsed.receipt.requestHash||readback.receipt.createdAt!==parsed.receipt.createdAt||parsed.receipt.keyId!==undefined&&parsed.receipt.keyId!==readback.receipt.keyId)return;return {...parsed,receipt:readback.receipt}}
export const notebinPublicationTesting={sha256,signupKey,mintKey,mintReadbackKey,publicationKey,opaqueEqual};
