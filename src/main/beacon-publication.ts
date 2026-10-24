import {createHash} from 'node:crypto';
import {
  BEACON_MAX_RESPONSE_BYTES,
  beaconPublicUrl,
  parseBeaconPublishResponse,
  renderBeaconArticle,
  validBeaconApiKey,
  validBeaconIntent,
  type BeaconApiKeyReceipt,
  type BeaconArticle,
  type BeaconOpaqueResponse,
  type BeaconPersistence,
  type BeaconPublicationReceipt,
  type BeaconPublishIntent,
  type BeaconVerification,
} from '../integrations/beacon';
import {publicIdentitySlug} from '../integrations/public-identity';
import {isArticleTopicUrl} from '../shared/topic-policy';
import type {Account,Channel,Site,Task} from '../shared/types';
import {bindAccount} from './account-bindings';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleReviewBindingHash,articleReviewTargetUrl} from './article-review';
import type {State,Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const exactDate=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);

type StateStore=Pick<Store,'read'|'update'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'get'|'encryptSecrets'>;
export const beaconAccountVaultKey=(accountId:string)=>{if(!UUID.test(accountId))throw Error('Beacon 账号标识无效');return `account:${accountId}`};
export const beaconPublicationVaultKey=(taskId:string)=>{if(!UUID.test(taskId))throw Error('Beacon 任务标识无效');return `publication:${taskId}`};

export interface BeaconAccountProof {version:1;stage:'ready';emailHash:string;apiKeyFingerprint:string;remoteAccountIdHash?:string;checkedAt:string}
export type BeaconProductAccount=Account&{beacon?:BeaconAccountProof};
export interface BeaconTaskReceipt extends Omit<BeaconPublishIntent,'apiKeyHash'> {accountId:string;stage:'submitting'|'opaque_response'|'api_receipt'|'published';versionId?:string}
export type BeaconProductTask=Task&{beacon?:BeaconTaskReceipt};
export interface BeaconAccountSecret {version:1;kind:'beacon_account';accountId:string;email:string;apiKey:string;apiKeySha256:string;remoteAccountId?:string;verifiedAt:string}

export interface BeaconPublicationBinding {
  version:1;taskId:string;siteId:string;accountId:string;slug:string;draftRevision:number;
  reviewHash:string;targetUrlHash:string;ownerHash:string;sourceHash:string;requestHash:string;
}
export interface BeaconPublicationSecret {version:1;kind:'beacon_publication';binding:BeaconPublicationBinding;intent:BeaconPublishIntent;opaque?:BeaconOpaqueResponse;receipt?:BeaconPublicationReceipt}
export interface BeaconTaskPersistence extends BeaconPersistence {
  loadSecret():Promise<BeaconPublicationSecret|undefined>;
  markPublished(receipt:BeaconPublicationReceipt,verification:Extract<BeaconVerification,{status:'usable'}>):Promise<void>;
}
export type BeaconChannelResolver=(state:Readonly<State>,channelId:'beacon')=>Channel|undefined;

function exactKeys(value:Record<string,unknown>,required:string[],optional:string[]=[]){
  const allowed=new Set([...required,...optional]);return required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.has(key));
}
export function parseBeaconAccountSecret(raw:string|undefined):BeaconAccountSecret|undefined{
  try{
    const value=JSON.parse(raw??'') as Record<string,unknown>;
    if(!value||typeof value!=='object'||Array.isArray(value)||!exactKeys(value,['version','kind','accountId','email','apiKey','apiKeySha256','verifiedAt'],['remoteAccountId'])||value.version!==1||value.kind!=='beacon_account'||typeof value.accountId!=='string'||!UUID.test(value.accountId)||typeof value.email!=='string'||value.email!==value.email.trim().toLowerCase()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)||!validBeaconApiKey(value.apiKey)||typeof value.apiKeySha256!=='string'||value.apiKeySha256!==sha(value.apiKey as string)||typeof value.verifiedAt!=='string'||!exactDate(value.verifiedAt)||value.remoteAccountId!==undefined&&(typeof value.remoteAccountId!=='string'||!value.remoteAccountId))return;
    return value as unknown as BeaconAccountSecret;
  }catch{return}
}
export function validBeaconAccount(account:Account|undefined):account is BeaconProductAccount&{beacon:BeaconAccountProof}{
  const proof=(account as BeaconProductAccount|undefined)?.beacon;
  return !!account&&!account.retiredAt&&account.channelId==='beacon'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&!!account.verifiedAt&&account.verifiedAt===proof?.checkedAt&&!!proof&&proof.version===1&&proof.stage==='ready'&&HASH.test(proof.emailHash)&&HASH.test(proof.apiKeyFingerprint)&&(!proof.remoteAccountIdHash||HASH.test(proof.remoteAccountIdHash))&&proof.emailHash===sha(account.email.trim().toLowerCase());
}

/** Saves only a verification result produced by the low-level Beacon OTP boundary. */
export function saveVerifiedBeaconAccount(store:Pick<Store,'read'|'updateWithCiphers'|'getCipher'>,vault:Pick<Vault,'encryptSecrets'>,input:{accountId:string;receipt:BeaconApiKeyReceipt;apiKey:string;siteIds:string[];channel:Channel;verifiedAt?:string}):BeaconProductAccount{
  if(!UUID.test(input.accountId)||input.channel.id!=='beacon'||input.channel.domain!=='beacon.host'||input.channel.accountRequired!==true||!validBeaconIntent(input.receipt)||input.receipt.kind!=='verify_otp'||!validBeaconApiKey(input.apiKey)||input.receipt.apiKeySha256!==sha(input.apiKey))throw Error('Beacon 已验证账号资料无效');
  const email=input.receipt.email.trim().toLowerCase(),verifiedAt=input.verifiedAt??new Date().toISOString();if(!exactDate(verifiedAt)||input.receipt.accountEmail&&input.receipt.accountEmail.trim().toLowerCase()!==email)throw Error('Beacon 已验证账号绑定无效');
  const before=store.read(),selected=[...new Set(input.siteIds)];if(!selected.length||selected.some(siteId=>!before.sites.some(site=>site.id===siteId)))throw Error('Beacon 绑定网站无效');
  const existing=before.accounts.find(item=>item.id===input.accountId),conflicts=before.accounts.filter(item=>!item.retiredAt&&item.channelId==='beacon'&&item.id!==input.accountId);if(conflicts.length||existing&&existing.channelId!=='beacon')throw Error('本机已有另一个 Beacon 发布账号');
  const secret:BeaconAccountSecret={version:1,kind:'beacon_account',accountId:input.accountId,email,apiKey:input.apiKey,apiKeySha256:sha(input.apiKey),...(input.receipt.accountId?{remoteAccountId:input.receipt.accountId}:{}),verifiedAt};
  const raw=JSON.stringify(secret),key=beaconAccountVaultKey(input.accountId),priorCipher=store.getCipher(key),cipher=vault.encryptSecrets({[key]:raw})[key];if(!cipher||cipher===raw)throw Error('Beacon API key 未加密');
  const proof:BeaconAccountProof={version:1,stage:'ready',emailHash:sha(email),apiKeyFingerprint:secret.apiKeySha256,...(secret.remoteAccountId?{remoteAccountIdHash:sha(secret.remoteAccountId)}:{}),checkedAt:verifiedAt};
  const account:BeaconProductAccount={...existing,id:input.accountId,channelId:'beacon',email,username:secret.remoteAccountId??email,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',createdAt:existing?.createdAt??input.receipt.createdAt,updatedAt:verifiedAt,registeredAt:existing?.registeredAt??input.receipt.createdAt,verifiedAt,diagnostic:undefined,beacon:proof};
  store.updateWithCiphers(state=>{const current=state.accounts.find(item=>item.id===input.accountId);if(existing?JSON.stringify(current)!==JSON.stringify(existing):!!current)throw Error('Beacon 验证期间账号已改变');if(state.accounts.some(item=>!item.retiredAt&&item.channelId==='beacon'&&item.id!==input.accountId))throw Error('本机已有另一个 Beacon 发布账号');state.accounts=state.accounts.filter(item=>item.id!==input.accountId);state.accounts.push(account);for(const siteId of selected)bindAccount(state,input.accountId,siteId,input.channel,new Date(verifiedAt))},{[key]:cipher},[],{[key]:priorCipher});
  return account;
}

export async function loadBeaconAccountAccess(store:Pick<Store,'read'|'getCipher'>,vault:Pick<Vault,'get'>,accountId:string):Promise<{account:BeaconProductAccount&{beacon:BeaconAccountProof};apiKey:string}>{
  const account=store.read().accounts.find(item=>item.id===accountId);if(!validBeaconAccount(account))throw Error('Beacon 发布账号未验证');const raw=await vault.get(beaconAccountVaultKey(accountId)),secret=parseBeaconAccountSecret(raw);if(!secret||secret.accountId!==accountId||secret.email!==account.email.toLowerCase()||secret.apiKeySha256!==account.beacon.apiKeyFingerprint||secret.verifiedAt!==account.beacon.checkedAt||sha(secret.remoteAccountId??'')!==(account.beacon.remoteAccountIdHash??sha('')))throw Error('Beacon 加密 API key 与账号证明不一致');return {account,apiKey:secret.apiKey};
}

export function beaconTaskSlug(task:Pick<Task,'id'>,site:Pick<Site,'name'|'url'|'domain'>){return publicIdentitySlug(site,task.id,48)}
export function beaconTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'language'>,slug:string):{article:BeaconArticle;targetUrl:string}|undefined{
  if(!task.draft)return;try{const targetUrl=task.topicUrl??site.url,article=renderBeaconArticle({draft:task.draft,targetUrl,language:site.language,slug});return {article,targetUrl}}catch{return}
}
export function parseBeaconTaskReceipt(value:unknown,apiKeyHash:string):BeaconTaskReceipt|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value)||!HASH.test(apiKeyHash))return;const receipt=value as Record<string,unknown>;
  if(!exactKeys(receipt,['kind','operationId','slug','publicUrl','sourceHash','markdownHash','targetUrlHash','requestHash','createdAt','accountId','stage'],['versionId'])||receipt.kind!=='publish'||typeof receipt.accountId!=='string'||!UUID.test(receipt.accountId)||!['submitting','opaque_response','api_receipt','published'].includes(String(receipt.stage))||receipt.versionId!==undefined&&(typeof receipt.versionId!=='string'||!receipt.versionId)||['api_receipt','published'].includes(String(receipt.stage))!==!!receipt.versionId)return;
  const intent={kind:'publish',operationId:receipt.operationId,slug:receipt.slug,publicUrl:receipt.publicUrl,sourceHash:receipt.sourceHash,markdownHash:receipt.markdownHash,targetUrlHash:receipt.targetUrlHash,requestHash:receipt.requestHash,apiKeyHash,createdAt:receipt.createdAt} as BeaconPublishIntent;
  return validBeaconIntent(intent)?value as BeaconTaskReceipt:undefined;
}
export function beaconIntentFromTask(task:BeaconProductTask,apiKeyHash:string):BeaconPublishIntent|undefined{
  const value=parseBeaconTaskReceipt(task.beacon,apiKeyHash);if(!value)return;return {kind:'publish',operationId:value.operationId,slug:value.slug,publicUrl:value.publicUrl,sourceHash:value.sourceHash,markdownHash:value.markdownHash,targetUrlHash:value.targetUrlHash,requestHash:value.requestHash,apiKeyHash,createdAt:value.createdAt};
}
function sameIntent(left:BeaconPublishIntent,right:BeaconPublishIntent){return left.kind===right.kind&&left.operationId===right.operationId&&left.slug===right.slug&&left.publicUrl===right.publicUrl&&left.sourceHash===right.sourceHash&&left.markdownHash===right.markdownHash&&left.targetUrlHash===right.targetUrlHash&&left.requestHash===right.requestHash&&left.apiKeyHash===right.apiKeyHash&&left.createdAt===right.createdAt}
function validOpaque(value:BeaconOpaqueResponse,intent:BeaconPublishIntent){const record=value as unknown as Record<string,unknown>;if(!exactKeys(record,['version','kind','stage','operationId','requestHash','status','contentType','responseUrl','redirected','responseType','bodyBase64','bodySha256','recordedAt'])||value.version!==1||value.kind!=='beacon_opaque_response'||value.stage!=='publish'||value.operationId!==intent.operationId||value.requestHash!==intent.requestHash||!Number.isInteger(value.status)||value.status<100||value.status>599||typeof value.contentType!=='string'||value.contentType.length>512||typeof value.responseUrl!=='string'||value.responseUrl.length>2048||typeof value.redirected!=='boolean'||typeof value.responseType!=='string'||typeof value.bodyBase64!=='string'||!HASH.test(value.bodySha256)||!exactDate(value.recordedAt))return false;const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=BEACON_MAX_RESPONSE_BYTES&&bytes.toString('base64')===value.bodyBase64&&sha(bytes)===value.bodySha256}
export function parseBeaconPublicationSecret(raw:string|undefined):BeaconPublicationSecret|undefined{
  try{const value=JSON.parse(raw??'') as BeaconPublicationSecret,root=value as unknown as Record<string,unknown>,binding=value?.binding as unknown as Record<string,unknown>,intent=value?.intent as unknown as Record<string,unknown>,receipt=value?.receipt as unknown as Record<string,unknown>|undefined;if(!value||!exactKeys(root,['version','kind','binding','intent'],['opaque','receipt'])||value.version!==1||value.kind!=='beacon_publication'||!value.binding||!exactKeys(binding,['version','taskId','siteId','accountId','slug','draftRevision','reviewHash','targetUrlHash','ownerHash','sourceHash','requestHash'])||!exactKeys(intent,['kind','operationId','slug','publicUrl','sourceHash','markdownHash','targetUrlHash','requestHash','apiKeyHash','createdAt'])||!validBeaconIntent(value.intent)||value.intent.kind!=='publish'||value.binding.version!==1||!UUID.test(value.binding.taskId)||!UUID.test(value.binding.siteId)||!UUID.test(value.binding.accountId)||!Number.isSafeInteger(value.binding.draftRevision)||value.binding.draftRevision<0||![value.binding.reviewHash,value.binding.targetUrlHash,value.binding.ownerHash,value.binding.sourceHash,value.binding.requestHash].every(item=>HASH.test(item))||value.binding.slug!==value.intent.slug||value.binding.sourceHash!==value.intent.sourceHash||value.binding.requestHash!==value.intent.requestHash||value.opaque&&!validOpaque(value.opaque,value.intent)||value.receipt&&(!receipt||!exactKeys(receipt,['kind','operationId','slug','publicUrl','sourceHash','markdownHash','targetUrlHash','requestHash','apiKeyHash','createdAt','versionId','anonymous','expiresAt'])||!sameIntent(value.receipt,value.intent)||value.receipt.anonymous!==false||value.receipt.expiresAt!==null||typeof value.receipt.versionId!=='string'||!value.receipt.versionId))return;return value}catch{return}
}

interface Snapshot {state:State;task:BeaconProductTask;site:Site;channel:Channel;account:BeaconProductAccount&{beacon:BeaconAccountProof};article:BeaconArticle;binding:BeaconPublicationBinding}
function channel(resolver:BeaconChannelResolver,state:State){const value=resolver(structuredClone(state),'beacon');if(!value||value.id!=='beacon'||value.domain!=='beacon.host'||value.kind!=='article'||value.automation!=='api'||!value.articleRequired||!value.accountRequired||value.emailRequired!==true||value.enabled!==true||state.settings.channelOverrides.beacon===false)throw Error('Beacon 当前平台配置无效');return value}
function snapshot(store:StateStore,options:{taskId:string;siteId:string;accountId:string;slug:string;resolveChannel:BeaconChannelResolver;assertSubmissionAuthorized:(snapshot:{state:State;task:Task;site:Site;channel:Channel;account:Account})=>true;now?:()=>Date},intent?:BeaconPublishIntent):Snapshot{
  const state=store.read(),task=state.tasks.find(item=>item.id===options.taskId) as BeaconProductTask|undefined,site=state.sites.find(item=>item.id===options.siteId),account=state.accounts.find(item=>item.id===options.accountId),currentChannel=channel(options.resolveChannel,state);
  if(!task||!site||task.siteId!==site.id||task.channelId!=='beacon'||task.sourceDomain!=='beacon.host'||task.accountId!==options.accountId||site.status!=='ready'||!state.settings.autoRun||!validBeaconAccount(account))throw Error('Beacon 任务、站点或账号绑定已改变');
  const bindings=state.accountBindings.filter(item=>item.siteId===site.id&&item.channelId==='beacon');if(bindings.length!==1||bindings[0].accountId!==account.id)throw Error('Beacon 所有者绑定已改变');
  if(task.topicUrl&&(!isArticleTopicUrl(task.topicUrl,site)||!site.topics?.some(topic=>topic.url===task.topicUrl)))throw Error('Beacon 审核目标链接已改变');
  const review=task.articleReview,targetUrl=articleReviewTargetUrl(task,site),termsHash=currentChannel.termsCache?.conclusionHash;
  const now=(options.now?.()??new Date()).toISOString(),draftUpdatedAt=task.draftUpdatedAt;
  if(review?.status!=='passed'||review.reviewContractVersion!==ARTICLE_REVIEW_CONTRACT_VERSION||review.reasonCode!=='passed'||review.bindingVersion!==2||review.targetUrl!==targetUrl||review.termsHash!==termsHash||(review.bindingHash??review.contextHash)!==articleReviewBindingHash(task,site,currentChannel)||!review.checks||Object.values(review.checks).some(value=>value!=='pass')||!review.reviewedAt||!exactDate(review.reviewedAt)||review.reviewedAt>now||!!draftUpdatedAt&&(!exactDate(draftUpdatedAt)||review.reviewedAt<draftUpdatedAt))throw Error('Beacon 当前稿件没有有效的精确审核');
  const identity=beaconTaskIdentity(task,site,options.slug);if(!identity)throw Error('Beacon 当前审核稿无法安全渲染');
  const ownerHash=sha(JSON.stringify({accountId:account.id,emailHash:account.beacon.emailHash,apiKeyFingerprint:account.beacon.apiKeyFingerprint,remoteAccountIdHash:account.beacon.remoteAccountIdHash??null,checkedAt:account.beacon.checkedAt,bindingId:bindings[0].id,siteId:site.id}));
  const binding:BeaconPublicationBinding={version:1,taskId:task.id,siteId:site.id,accountId:account.id,slug:options.slug,draftRevision:task.draftRevision??0,reviewHash:sha(JSON.stringify(review)),targetUrlHash:sha(identity.targetUrl),ownerHash,sourceHash:identity.article.sourceHash,requestHash:identity.article.requestHash};
  if(intent&&(intent.slug!==options.slug||intent.publicUrl!==beaconPublicUrl(options.slug)||intent.sourceHash!==binding.sourceHash||intent.requestHash!==binding.requestHash||intent.targetUrlHash!==binding.targetUrlHash||intent.apiKeyHash!==account.beacon.apiKeyFingerprint))throw Error('Beacon 原提交信息与当前稿件或账号不一致');
  if(options.assertSubmissionAuthorized(structuredClone({state,task,site,channel:currentChannel,account}))!==true)throw Error('Beacon 发布授权已改变');
  return {state,task,site,channel:currentChannel,account,article:identity.article,binding};
}

export function createBeaconPublicationPersistence(store:StateStore,vault:SecureVault,options:{taskId:string;siteId:string;accountId:string;slug:string;resolveChannel:BeaconChannelResolver;expectedIntent?:BeaconPublishIntent;assertSubmissionAuthorized:(snapshot:{state:State;task:Task;site:Site;channel:Channel;account:Account})=>true;now?:()=>Date}):BeaconTaskPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId)||!UUID.test(options.accountId))throw Error('Beacon 保存参数无效');
  let claimed=options.expectedIntent?{...options.expectedIntent}:undefined,claimedBinding:BeaconPublicationBinding|undefined;if(claimed&&(!validBeaconIntent(claimed)||claimed.kind!=='publish'))throw Error('Beacon 恢复提交信息无效');
  const publicationKey=beaconPublicationVaultKey(options.taskId),accountKey=beaconAccountVaultKey(options.accountId),accountCipher=store.getCipher(accountKey);let publicationCipher=store.getCipher(publicationKey);const stamp=()=> (options.now?.()??new Date()).toISOString();
  const read=async()=>{const raw=await vault.get(publicationKey),parsed=parseBeaconPublicationSecret(raw);if(raw&&!parsed)throw Error('Beacon 加密发布记录无效');return parsed};
  const current=(intent:BeaconPublishIntent)=>snapshot(store,options,intent);
  const write=(secret:BeaconPublicationSecret,expected:string|undefined,stage:BeaconTaskReceipt['stage'])=>{const raw=JSON.stringify(secret),cipher=vault.encryptSecrets({[publicationKey]:raw})[publicationKey];if(!cipher||cipher===raw)throw Error('Beacon 发布记录未加密');store.updateWithCiphers(state=>{const task=state.tasks.find(item=>item.id===options.taskId) as BeaconProductTask|undefined;if(!task||task.siteId!==options.siteId||task.accountId!==options.accountId)throw Error('Beacon 任务绑定已改变');const saved=task.beacon;if(saved&&!sameIntent(beaconIntentFromTask(task,secret.intent.apiKeyHash)!,secret.intent))throw Error('Beacon 原提交信息已改变');const {apiKeyHash:_,...safeIntent}=secret.intent;task.beacon={...safeIntent,accountId:options.accountId,stage,...(secret.receipt?{versionId:secret.receipt.versionId}:{})};task.submittedAt=secret.intent.createdAt;task.status=stage==='published'?'live':'review';task.health=stage==='published'?'healthy':'pending';task.checkpoint=`beacon_${stage}`;task.updatedAt=stamp();task.message=stage==='submitting'?'Beacon 单次发布计划已加密保存；未知结果只会读取找回。':stage==='opaque_response'?'Beacon 原始响应已加密保存；严格解析前不会重发。':stage==='api_receipt'?'Beacon 所有者发布记录已保存；等待公开全文验收。':'Beacon 所有者页面、完整正文、目标链接与抓取策略已验收。';if(secret.receipt)task.publicUrl=secret.receipt.publicUrl}, {[publicationKey]:cipher},[],{[publicationKey]:expected,[accountKey]:accountCipher});publicationCipher=cipher};
  return {
    secretStorage:'encrypted',
    async persistIntent(intent){if(claimed||publicationCipher||!accountCipher||!validBeaconIntent(intent)||intent.kind!=='publish')throw Error('Beacon 不能重复建立发布计划');const trusted=current(intent),secret:BeaconPublicationSecret={version:1,kind:'beacon_publication',binding:trusted.binding,intent};write(secret,undefined,'submitting');claimed={...intent};claimedBinding=trusted.binding},
    assertReadyToSubmit(intent){if(intent.kind!=='publish'||!claimed||!claimedBinding||!sameIntent(claimed,intent)||store.getCipher(publicationKey)!==publicationCipher||store.getCipher(accountKey)!==accountCipher)throw Error('Beacon 提交信息或账号密钥已改变');const trusted=current(intent);if(!publicationCipher||!same(claimedBinding,trusted.binding))throw Error('Beacon 提交授权已改变');return true},
    async persistOpaqueResponse(opaque){if(!claimed||!sameIntent(claimed,{...claimed,operationId:opaque.operationId,requestHash:opaque.requestHash})||!validOpaque(opaque,claimed))throw Error('Beacon 原始响应无效');const secret=await read(),expected=publicationCipher;if(!secret||!claimedBinding||!sameIntent(secret.intent,claimed)||!same(secret.binding,claimedBinding)||store.getCipher(publicationKey)!==publicationCipher||store.getCipher(accountKey)!==accountCipher)throw Error('Beacon 原提交记录无效');if(secret.opaque){if(secret.opaque.bodySha256===opaque.bodySha256&&same(secret.opaque,opaque))return;throw Error('Beacon 原始响应已存在')}write({...secret,opaque},expected,'opaque_response')},
    async loadOpaqueResponse(stage,operationId){if(stage!=='publish'||!claimed||operationId!==claimed.operationId)return;const secret=await read();return secret&&sameIntent(secret.intent,claimed)?secret.opaque:undefined},
    async promotePublication(receipt){if(!claimed||!sameIntent(claimed,receipt))throw Error('Beacon 返回记录与原提交信息不一致');const secret=await read(),expected=publicationCipher,parsed=secret?.opaque?parseBeaconPublishResponse(secret.opaque,claimed):undefined;if(!secret||!sameIntent(secret.intent,claimed)||!same(secret.binding,current(claimed).binding)||parsed&&('diagnostic' in parsed||!same(parsed,receipt)))throw Error('Beacon 加密原始响应或 GET 找回记录无法证明返回记录');if(secret.receipt){if(same(secret.receipt,receipt))return;throw Error('Beacon 返回记录已存在')}write({...secret,receipt},expected,'api_receipt')},
    async promoteOtpSent(){throw Error('Beacon 发布保存边界不接受验证码发送')},
    async promoteApiKey(){throw Error('Beacon 发布保存边界不接受账号密钥')},
    async loadSecret(){return read()},
    async markPublished(receipt,verification){if(!claimed||!sameIntent(claimed,receipt)||verification.status!=='usable'||!sameIntent(verification.receipt,receipt))throw Error('Beacon 公开验收记录无效');const secret=await read();if(!secret?.receipt||!same(secret.receipt,receipt)||!same(secret.binding,current(claimed).binding))throw Error('Beacon 发布记录或绑定已改变');store.updateWithCiphers(state=>{const task=state.tasks.find(item=>item.id===options.taskId) as BeaconProductTask|undefined;if(!task?.beacon||!['api_receipt','published'].includes(task.beacon.stage)||!sameIntent(beaconIntentFromTask(task,claimed!.apiKeyHash)!,claimed!))throw Error('Beacon 公开验收阶段无效');task.beacon={...task.beacon,stage:'published',versionId:receipt.versionId};task.publicUrl=receipt.publicUrl;task.status='live';task.health='healthy';task.checkpoint='beacon_published';task.verifiedAt=stamp();task.firstLiveAt=task.firstLiveAt??task.verifiedAt;task.lastCheckedAt=task.verifiedAt;task.linkCheck='found';task.linkRel=verification.rel;task.updatedAt=task.verifiedAt;task.message='Beacon 所有者页面、完整正文、目标链接与抓取策略已验收；不代表搜索收录。'}, {},[],{[publicationKey]:publicationCipher,[accountKey]:accountCipher})},
  };
}

export function beaconPublicationBackupMatches(task:BeaconProductTask,account:Account|undefined,raw:string|undefined):boolean{
  const proof=validBeaconAccount(account)?account.beacon:undefined,journal=parseBeaconPublicationSecret(raw),intent=proof?beaconIntentFromTask(task,proof.apiKeyFingerprint):undefined;if(!journal||!intent||!sameIntent(journal.intent,intent)||journal.binding.taskId!==task.id||journal.binding.siteId!==task.siteId||journal.binding.accountId!==task.accountId)return false;
  if(task.beacon?.stage==='submitting')return !journal.opaque&&!journal.receipt;
  if(task.beacon?.stage==='opaque_response')return !!journal.opaque&&!journal.receipt;
  return !!journal.receipt&&journal.receipt.publicUrl===task.publicUrl&&journal.receipt.versionId===task.beacon?.versionId;
}

export const beaconPublicationTesting={sameIntent,snapshot};
