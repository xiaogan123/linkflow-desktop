import {
  HTML2LINK_MAX_RESPONSE_BYTES,
  html2LinkHash,
  html2LinkRobotsUrl,
  parseHtml2LinkPublicUrl,
  validHtml2LinkIntent,
  type Html2LinkIntent,
  type Html2LinkOpaqueResponse,
  type Html2LinkPersistence,
  type Html2LinkReceipt,
} from '../integrations/html2link';
import {
  HTML2LINK_MAX_PUBLIC_HTML_BYTES,
  HTML2LINK_MAX_ROBOTS_BYTES,
  type Html2LinkPublicEvidence,
  type Html2LinkPublicEvidencePersistence,
} from '../integrations/html2link-verifier';
import {renderHtml2LinkArticle, type Html2LinkRenderedArticle} from '../integrations/html2link-article';
import type {ExecutionContext,ExecutionResult,Site,Task} from '../shared/types';
import type {State,Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
type StateStore=Pick<Store,'read'|'update'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'encryptSecrets'|'get'>;

export interface Html2LinkTaskReceipt extends Html2LinkIntent {
  stage:'submitting'|'opaque_response'|'api_receipt'|'published';
  slug?:string;
  publicUrl?:string;
}

export interface Html2LinkTask extends Task {html2link?:Html2LinkTaskReceipt}
export interface Html2LinkExecutionContext extends Omit<ExecutionContext,'task'> {
  task:Html2LinkTask;
  html2LinkPersistence?:Html2LinkPublicationPersistence;
}
export interface Html2LinkExecutionResult extends ExecutionResult {html2link?:Html2LinkTaskReceipt}
export interface Html2LinkPublicationPersistence extends Html2LinkPersistence,Html2LinkPublicEvidencePersistence {}

export interface Html2LinkPublicationSecret {
  version:1;
  kind:'html2link_publication';
  taskId:string;
  siteId:string;
  intent:Html2LinkIntent;
  opaqueResponse:Html2LinkOpaqueResponse;
  receipt?:Html2LinkReceipt;
  updateToken?:string;
  publicEvidence?:Html2LinkPublicEvidence;
}

export interface Html2LinkTaskIdentity {article:Html2LinkRenderedArticle;targetUrl:string;sourceHash:string;requestHash:string}

function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function sameIntent(a:Html2LinkIntent,b:Html2LinkIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function intentOf(task:Html2LinkTask):Html2LinkIntent|undefined{const value=task.html2link;return value?{operationId:value.operationId,sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:value.createdAt}:undefined}
function validUpdateToken(value:unknown):value is string{return typeof value==='string'&&value.length>=16&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(value)}
function headerPairs(value:unknown):value is Array<[string,string]>{return Array.isArray(value)&&value.length<=32&&value.every(item=>Array.isArray(item)&&item.length===2&&item.every(part=>typeof part==='string'&&part.length<=8192&&!/[\u0000\r\n]/u.test(part)))}
function strictBase64(value:unknown,maximum:number):value is string{if(typeof value!=='string')return false;const bytes=Buffer.from(value,'base64');return bytes.byteLength<=maximum&&bytes.toString('base64')===value}

export function html2LinkTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'language'>):Html2LinkTaskIdentity|undefined{
  if(!task.draft)return;
  try{
    const targetUrl=new URL(task.topicUrl??site.url).href;
    const article=renderHtml2LinkArticle({draft:task.draft,targetUrl,language:site.language});
    return {article,targetUrl,sourceHash:article.sourceHash,requestHash:article.requestHash};
  }catch{return}
}

function validOpaque(value:unknown):value is Html2LinkOpaqueResponse{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='bodyBase64,bodySha256,contentType,createdAt,kind,operationId,redirected,requestHash,responseType,responseUrl,sourceHash,status,version'
    ||v.version!==1||v.kind!=='html2link_opaque_response'||typeof v.operationId!=='string'||typeof v.sourceHash!=='string'||typeof v.requestHash!=='string'||typeof v.createdAt!=='string'
    ||!validHtml2LinkIntent(v as unknown as Html2LinkIntent)||!Number.isInteger(v.status)||Number(v.status)<100||Number(v.status)>599
    ||typeof v.contentType!=='string'||v.contentType.length>512||typeof v.responseUrl!=='string'||v.responseUrl.length>2048
    ||typeof v.redirected!=='boolean'||typeof v.responseType!=='string'||v.responseType.length>64||!strictBase64(v.bodyBase64,HTML2LINK_MAX_RESPONSE_BYTES)
    ||typeof v.bodySha256!=='string'||!HASH.test(v.bodySha256))return false;
  return html2LinkHash(Buffer.from(v.bodyBase64 as string,'base64'))===v.bodySha256;
}

function validReceipt(value:unknown,intent:Html2LinkIntent):value is Html2LinkReceipt{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='createdAt,operationId,publicUrl,requestHash,slug,sourceHash'||typeof v.slug!=='string')return false;
  const parsed=parseHtml2LinkPublicUrl(v.publicUrl);
  return !!parsed&&parsed.slug===v.slug&&sameIntent(v as unknown as Html2LinkIntent,intent);
}

function validEvidence(value:unknown,receipt:Html2LinkReceipt):value is Html2LinkPublicEvidence{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='checkedAt,kind,pageBodyBase64,pageBodySha256,pageContentType,pageHeaders,pageStatus,publicUrl,robotsBodyBase64,robotsBodySha256,robotsContentType,robotsHeaders,robotsStatus,robotsUrl,version'
    ||v.version!==1||v.kind!=='html2link_public_evidence'||typeof v.checkedAt!=='string'||!exactDate(v.checkedAt)||v.publicUrl!==receipt.publicUrl
    ||!Number.isInteger(v.pageStatus)||Number(v.pageStatus)<100||Number(v.pageStatus)>599||typeof v.pageContentType!=='string'||v.pageContentType.length>512||!headerPairs(v.pageHeaders)
    ||!strictBase64(v.pageBodyBase64,HTML2LINK_MAX_PUBLIC_HTML_BYTES)||typeof v.pageBodySha256!=='string'||!HASH.test(v.pageBodySha256)
    ||v.robotsUrl!==html2LinkRobotsUrl(receipt.publicUrl)||!Number.isInteger(v.robotsStatus)||Number(v.robotsStatus)<100||Number(v.robotsStatus)>599
    ||typeof v.robotsContentType!=='string'||v.robotsContentType.length>512||!headerPairs(v.robotsHeaders)||!strictBase64(v.robotsBodyBase64,HTML2LINK_MAX_ROBOTS_BYTES)
    ||typeof v.robotsBodySha256!=='string'||!HASH.test(v.robotsBodySha256))return false;
  return html2LinkHash(Buffer.from(v.pageBodyBase64 as string,'base64'))===v.pageBodySha256
    &&html2LinkHash(Buffer.from(v.robotsBodyBase64 as string,'base64'))===v.robotsBodySha256;
}

export function parseHtml2LinkPublicationSecret(value:string):Html2LinkPublicationSecret|undefined{
  try{
    const parsed=JSON.parse(value) as Record<string,unknown>;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return;
    const allowed=['intent','kind','opaqueResponse','publicEvidence','receipt','siteId','taskId','updateToken','version'];
    if(Object.keys(parsed).some(key=>!allowed.includes(key))||parsed.version!==1||parsed.kind!=='html2link_publication'||typeof parsed.taskId!=='string'||!UUID.test(parsed.taskId)||typeof parsed.siteId!=='string'||!UUID.test(parsed.siteId))return;
    const intent=parsed.intent as Html2LinkIntent;if(!intent||!validHtml2LinkIntent(intent)||!validOpaque(parsed.opaqueResponse)||!sameIntent(intent,parsed.opaqueResponse as Html2LinkOpaqueResponse))return;
    const hasReceipt=parsed.receipt!==undefined||parsed.updateToken!==undefined;
    if(hasReceipt&&(!validReceipt(parsed.receipt,intent)||!validUpdateToken(parsed.updateToken)))return;
    if(parsed.publicEvidence!==undefined&&(!hasReceipt||!validEvidence(parsed.publicEvidence,parsed.receipt as Html2LinkReceipt)))return;
    return parsed as unknown as Html2LinkPublicationSecret;
  }catch{return}
}

function pendingBaseClean(task:Task){return !task.accountId&&!task.publicUrl&&!task.verifiedAt&&!task.firstLiveAt&&!task.linkCheck&&!task.linkRel&&!task.publicationMethod&&!task.lastCheckedAt&&!task.nextCheckAt&&!task.lostAt&&!task.reviewUntil&&!task.reviewKind&&task.consecutiveMissing===undefined}
function pendingClean(task:Task){return pendingBaseClean(task)&&task.reconcileAttempts===undefined&&!task.reconcileAfter}
function pendingPromotion(task:Task){if(!pendingBaseClean(task))return false;const attempts=task.reconcileAttempts;if(attempts===undefined)return !task.reconcileAfter;if(!Number.isInteger(attempts)||attempts<1||attempts>3)return false;return attempts<3?!!task.reconcileAfter&&exactDate(task.reconcileAfter):!task.reconcileAfter}
function localTask(task:Task){return task as Html2LinkTask}
function current(state:State,taskId:string,siteId:string,intent:Html2LinkIntent){
  const base=state.tasks.find(value=>value.id===taskId),site=state.sites.find(value=>value.id===siteId),task=base&&localTask(base);
  if(!task||!site||task.siteId!==siteId||task.channelId!=='html2link'||task.sourceDomain!=='html2link.dev'||task.accountId||state.accounts.some(value=>value.channelId==='html2link')||state.accountBindings.some(value=>value.channelId==='html2link'))throw Error('HTML2Link 任务绑定已改变');
  const identity=html2LinkTaskIdentity(task,site);if(!identity||identity.sourceHash!==intent.sourceHash||identity.requestHash!==intent.requestHash)throw Error('HTML2Link 原稿已改变');
  return {task,site,identity};
}
function synchronousAuthorization(value:true|PromiseLike<unknown>):true{if(value!==true){if(value&&typeof (value as PromiseLike<unknown>).then==='function')void Promise.resolve(value).catch(()=>undefined);throw Error('HTML2Link 同步授权检查未通过')}return true}

export function createHtml2LinkPublicationPersistence(store:StateStore,vault:SecureVault,options:{taskId:string;siteId:string;expectedIntent?:Html2LinkIntent;assertSubmissionAuthorized:(snapshot:{state:State;task:Task;site:Site})=>true;now?:()=>Date}):Html2LinkPublicationPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId))throw Error('HTML2Link 保存参数无效');
  let claimed=options.expectedIntent?{...options.expectedIntent}:undefined;if(claimed&&!validHtml2LinkIntent(claimed))throw Error('HTML2Link 恢复提交信息无效');
  const key=`publication:${options.taskId}`,stamp=()=> (options.now?.()??new Date()).toISOString();
  const authorize=(intent:Html2LinkIntent)=>{const state=store.read(),{task,site}=current(state,options.taskId,options.siteId,intent),saved=task.html2link;if(!saved||saved.stage!=='submitting'||!sameIntent(intentOf(task)!,intent)||task.submittedAt!==intent.createdAt||task.status!=='review'||task.health!=='pending'||!state.settings.autoRun||site.status!=='ready')throw Error('HTML2Link 授权已改变');return synchronousAuthorization(options.assertSubmissionAuthorized(structuredClone({state,task,site}))) as true};
  const readSecret=async()=>{const value=await vault.get(key);return value?parseHtml2LinkPublicationSecret(value):undefined};
  return {
    secretStorage:'encrypted',
    async persistIntent(intent){
      if(claimed||!validHtml2LinkIntent(intent))throw Error('HTML2Link 不能重复提交');
      store.update(state=>{const {task,site}=current(state,options.taskId,options.siteId,intent);if(task.html2link||task.submittedAt||!pendingClean(task)||task.status==='live'||/(?:html2link|submitt|publish|receipt|uncertain)/i.test(task.checkpoint??'')||store.getCipher(key))throw Error('HTML2Link 任务已有提交记录');if(!state.settings.autoRun||task.status!=='running'||site.status!=='ready')throw Error('HTML2Link 任务已暂停');synchronousAuthorization(options.assertSubmissionAuthorized(structuredClone({state,task,site})));task.html2link={...intent,stage:'submitting'};task.submittedAt=intent.createdAt;task.checkpoint='html2link_create_submitting';task.status='review';task.health='pending';task.updatedAt=stamp();task.message='HTML2Link 单次上传计划已保存；结果不明时不会重发。'});
      claimed={...intent};
    },
    assertReadyToSubmit(intent){if(!claimed||!sameIntent(claimed,intent))throw Error('HTML2Link 提交信息不一致');return authorize(intent)},
    async persistOpaqueResponse(value){
      if(!claimed||!sameIntent(claimed,value)||!validOpaque(value))throw Error('HTML2Link 原始响应无效');
      const existingCipher=store.getCipher(key);
      if(existingCipher){const existing=await readSecret();if(existing&&sameIntent(existing.intent,value)&&existing.opaqueResponse.bodySha256===value.bodySha256&&JSON.stringify(existing.opaqueResponse)===JSON.stringify(value))return;throw Error('HTML2Link 原始响应已存在')}
      const secret:Html2LinkPublicationSecret={version:1,kind:'html2link_publication',taskId:options.taskId,siteId:options.siteId,intent:{...claimed},opaqueResponse:value};
      const serialized=JSON.stringify(secret),cipher=vault.encryptSecrets({[key]:serialized})[key];if(!cipher||cipher===serialized)throw Error('HTML2Link 原始响应未加密');
      store.updateWithCiphers(state=>{const {task}=current(state,options.taskId,options.siteId,claimed!);const saved=task.html2link;if(!saved||!['submitting','opaque_response'].includes(saved.stage)||!sameIntent(intentOf(task)!,claimed!)||task.submittedAt!==claimed!.createdAt||!['review','needs_input','skipped'].includes(task.status)||task.health!=='pending'||!pendingPromotion(task)||store.getCipher(key))throw Error('HTML2Link 原始响应阶段无效');task.html2link={...saved,stage:'opaque_response'};task.checkpoint='html2link_opaque_response';task.updatedAt=stamp();task.message='HTML2Link 完整上传响应已加密保留；严格解析前不会重发。'},{[key]:cipher},[],{[key]:undefined});
    },
    async loadOpaqueResponse(){return (await readSecret())?.opaqueResponse},
    async promoteReceipt(value){
      const expected=claimed;if(!expected||!sameIntent(expected,value.receipt)||!validReceipt(value.receipt,expected)||!validUpdateToken(value.updateToken))throw Error('HTML2Link 返回记录与原提交信息不一致');
      const previousCipher=store.getCipher(key),secret=await readSecret();if(!previousCipher||!secret||!sameIntent(secret.intent,expected))throw Error('HTML2Link 加密原始响应不存在');
      if(secret.receipt){if(JSON.stringify(secret.receipt)===JSON.stringify(value.receipt)&&secret.updateToken===value.updateToken)return;throw Error('HTML2Link 返回记录已存在')}
      const next:Html2LinkPublicationSecret={...secret,receipt:value.receipt,updateToken:value.updateToken};const serialized=JSON.stringify(next),cipher=vault.encryptSecrets({[key]:serialized})[key];if(!cipher||cipher===serialized)throw Error('HTML2Link 更新密钥未加密');
      store.updateWithCiphers(state=>{const {task,site}=current(state,options.taskId,options.siteId,expected),saved=task.html2link,recovering=task.status==='needs_input'&&state.settings.autoRun&&site.status==='ready';if(!saved||!['submitting','opaque_response'].includes(saved.stage)||!sameIntent(intentOf(task)!,expected)||task.submittedAt!==expected.createdAt||!(task.status==='review'||recovering)||task.health!=='pending'||!pendingPromotion(task)||store.getCipher(key)!==previousCipher)throw Error('HTML2Link 返回记录阶段无效');task.html2link={...saved,slug:value.receipt.slug,publicUrl:value.receipt.publicUrl,stage:'api_receipt'};task.publicUrl=value.receipt.publicUrl;task.checkpoint='html2link_api_receipt';task.reconcileAttempts=undefined;task.reconcileAfter=undefined;task.updatedAt=stamp();task.message='HTML2Link 平台返回记录、完整原响应和更新密钥已加密保存；等待公开页验收。'},{[key]:cipher},[],{[key]:previousCipher});
    },
    async persistPublicEvidence(value){
      const previousCipher=store.getCipher(key),secret=await readSecret();if(!previousCipher||!secret?.receipt||!validEvidence(value,secret.receipt))throw Error('HTML2Link 公开证据与原返回记录不一致');
      if(secret.publicEvidence&&JSON.stringify(secret.publicEvidence)===JSON.stringify(value))return;
      const next:Html2LinkPublicationSecret={...secret,publicEvidence:value},serialized=JSON.stringify(next),cipher=vault.encryptSecrets({[key]:serialized})[key];if(!cipher||cipher===serialized)throw Error('HTML2Link 公开证据未加密');
      store.updateWithCiphers(state=>{const {task}=current(state,options.taskId,options.siteId,secret.intent),saved=task.html2link;if(!saved||!['api_receipt','published'].includes(saved.stage)||saved.slug!==secret.receipt!.slug||saved.publicUrl!==secret.receipt!.publicUrl||task.publicUrl!==secret.receipt!.publicUrl||task.submittedAt!==secret.intent.createdAt||store.getCipher(key)!==previousCipher)throw Error('HTML2Link 公开证据阶段无效');task.updatedAt=stamp()},{[key]:cipher},[],{[key]:previousCipher});
    },
  };
}

export const html2LinkPublicationTesting={sameIntent,intentOf,pendingClean,pendingPromotion,validOpaque,validEvidence};
