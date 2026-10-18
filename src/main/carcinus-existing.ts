import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {CARCINUS_MAX_HTML_BYTES,CARCINUS_RETENTION,carcinusHash,carcinusPayload,carcinusPublicUrl,carcinusRequest,carcinusRestoreUrl,validCarcinusIntent,validCarcinusToken,type CarcinusDependencies,type CarcinusIntent,type CarcinusPayload,type CarcinusReceipt} from '../integrations/carcinus';
import {inspectCarcinusExistingPage,type CarcinusPublicPageExpectation} from '../integrations/carcinus-publisher';
import {isArticleTopicUrl} from '../shared/topic-policy';
import type {Account,CarcinusExistingAccountProof,CarcinusExistingPageReceipt,CarcinusPublicAcceptance,Site,Task} from '../shared/types';
import {carcinusReviewedMain,carcinusSiteIdentity} from './carcinus-publication';
import type {State,Store} from './store';
import type {Vault} from './vault';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EXPORT_KEYS='kind,payload,provenance,receipt,targetUrl,version,writeToken';
const PAYLOAD_KEYS='htmlTemplate,identity,isAssistantMemoryBackup,purpose';
const PROVENANCE_KEYS='manifestSha256,payloadFileSha256,resultSha256,reviewSha256';
const RECEIPT_KEYS='createdAt,identity,operationId,preflightCheckedAt,preflightStatus,publicUrl,requestHash,restoreUrl,sourceHash,tokenFingerprint';

export interface CarcinusExistingProvenance {payloadFileSha256:string;reviewSha256:string;manifestSha256:string;resultSha256:string}
export interface CarcinusExistingPageExport {version:1;kind:'linkflow_carcinus_existing_page';targetUrl:string;payload:CarcinusPayload;receipt:CarcinusReceipt;writeToken:string;provenance:CarcinusExistingProvenance}
export interface CarcinusExistingPageSecret {version:1;kind:'carcinus_existing_page_secret';targetUrl:string;payload:CarcinusPayload;receipt:CarcinusReceipt;provenance:CarcinusExistingProvenance}
export interface CarcinusExistingConnectionInput {siteId:string;exportJson:string}

function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function exactKeys(value:Record<string,unknown>,keys:string){return Object.keys(value).sort().join(',')===keys}
function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function stable(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function uuidFrom(value:string){const hex=createHash('sha256').update(value).digest('hex').slice(0,32),variant=(parseInt(hex[16],16)&3|8).toString(16);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${variant}${hex.slice(17,20)}-${hex.slice(20)}`}
function normalizeProvenance(value:Record<string,unknown>):CarcinusExistingProvenance|undefined{
  if(!exactKeys(value,PROVENANCE_KEYS))return;
  const out={payloadFileSha256:value.payloadFileSha256,reviewSha256:value.reviewSha256,manifestSha256:value.manifestSha256,resultSha256:value.resultSha256};
  return Object.values(out).every(item=>typeof item==='string'&&HASH.test(item))?out as CarcinusExistingProvenance:undefined;
}
function normalizeReceipt(value:Record<string,unknown>):CarcinusReceipt|undefined{
  if(!exactKeys(value,RECEIPT_KEYS))return;
  const intent:CarcinusIntent={operationId:value.operationId as string,identity:value.identity as string,sourceHash:value.sourceHash as string,requestHash:value.requestHash as string,createdAt:value.createdAt as string,preflightCheckedAt:value.preflightCheckedAt as string,preflightStatus:value.preflightStatus as 404};
  if(!validCarcinusIntent(intent)||typeof value.publicUrl!=='string'||typeof value.restoreUrl!=='string'||typeof value.tokenFingerprint!=='string'||!HASH.test(value.tokenFingerprint))return;
  if(value.publicUrl!==carcinusPublicUrl(intent.identity)||value.restoreUrl!==carcinusRestoreUrl(intent.identity))return;
  return {...intent,publicUrl:value.publicUrl,restoreUrl:value.restoreUrl,tokenFingerprint:value.tokenFingerprint};
}
function normalizePayload(value:Record<string,unknown>):CarcinusPayload|undefined{
  if(!exactKeys(value,PAYLOAD_KEYS)||typeof value.identity!=='string'||typeof value.purpose!=='string'||typeof value.htmlTemplate!=='string'||value.isAssistantMemoryBackup!==false)return;
  if(!value.purpose||value.purpose!==value.purpose.trim()||value.purpose.length>1000||/[\u0000-\u001f\u007f]/.test(value.purpose))return;
  return {identity:value.identity,purpose:value.purpose,htmlTemplate:value.htmlTemplate,isAssistantMemoryBackup:false};
}

function existingTemplateEvidence(html:string,targetUrl:string,publicUrl:string){
  const current=carcinusReviewedMain(html,targetUrl,true);
  if(current?.canonical===publicUrl)return {htmlTemplate:html,main:current};
  if(typeof html!=='string'||Buffer.from(html,'utf8').toString('utf8')!==html||Buffer.byteLength(html,'utf8')>CARCINUS_MAX_HTML_BYTES||CONTROL.test(html)||html.includes('<!--')||/[\s{](?:url\s*\(|@import)/i.test(html))return;
  const $=load(html,{xmlMode:false}),styles=$('style');
  if(styles.length!==1||$('head > style').length!==1||Object.keys(styles[0].attribs??{}).length)return;
  if(/url\s*\(|@import|\\/i.test(styles.text()))return;
  styles.remove();
  const normalized=$.html(),main=carcinusReviewedMain(normalized,targetUrl,true);
  if(!main||main.canonical!==publicUrl)return;
  return {htmlTemplate:normalized,main};
}

export function parseCarcinusExistingPageExport(input:string|unknown):CarcinusExistingPageExport|undefined{
  let raw:unknown=input;if(typeof input==='string'){if(Buffer.byteLength(input,'utf8')>600_000)return;try{raw=JSON.parse(input)}catch{return}}
  if(!record(raw)||!exactKeys(raw,EXPORT_KEYS)||raw.version!==1||raw.kind!=='linkflow_carcinus_existing_page'||typeof raw.targetUrl!=='string'||typeof raw.writeToken!=='string'||!record(raw.payload)||!record(raw.receipt)||!record(raw.provenance))return;
  const payload=normalizePayload(raw.payload),receipt=normalizeReceipt(raw.receipt),provenance=normalizeProvenance(raw.provenance);if(!payload||!receipt||!provenance||!validCarcinusToken(raw.writeToken)||carcinusHash(raw.writeToken)!==receipt.tokenFingerprint||payload.identity!==receipt.identity)return;
  let target:URL;try{target=new URL(raw.targetUrl)}catch{return}if(target.protocol!=='https:'||target.username||target.password||target.hash||target.href!==raw.targetUrl)return;
  const evidence=existingTemplateEvidence(payload.htmlTemplate,raw.targetUrl,receipt.publicUrl),request=carcinusRequest(payload);if(!evidence||request.sourceHash!==receipt.sourceHash||request.requestHash!==receipt.requestHash)return;
  return {version:1,kind:'linkflow_carcinus_existing_page',targetUrl:raw.targetUrl,payload,receipt,writeToken:raw.writeToken,provenance};
}

export function carcinusExistingSecret(value:CarcinusExistingPageExport):CarcinusExistingPageSecret{return {version:1,kind:'carcinus_existing_page_secret',targetUrl:value.targetUrl,payload:value.payload,receipt:value.receipt,provenance:value.provenance}}
export function serializeCarcinusExistingSecret(value:CarcinusExistingPageSecret){return JSON.stringify(value)}
export function parseCarcinusExistingPageSecret(input:string|unknown):CarcinusExistingPageSecret|undefined{
  let value:unknown=input;if(typeof input==='string'){if(Buffer.byteLength(input,'utf8')>600_000)return;try{value=JSON.parse(input)}catch{return}}
  if(!record(value)||!exactKeys(value,'kind,payload,provenance,receipt,targetUrl,version')||value.version!==1||value.kind!=='carcinus_existing_page_secret'||typeof value.targetUrl!=='string'||!record(value.payload)||!record(value.receipt)||!record(value.provenance))return;
  const payload=normalizePayload(value.payload),receipt=normalizeReceipt(value.receipt),provenance=normalizeProvenance(value.provenance);if(!payload||!receipt||!provenance||payload.identity!==receipt.identity)return;
  const evidence=existingTemplateEvidence(payload.htmlTemplate,value.targetUrl,receipt.publicUrl),request=carcinusRequest(payload);if(!evidence||request.sourceHash!==receipt.sourceHash||request.requestHash!==receipt.requestHash)return;
  return {version:1,kind:'carcinus_existing_page_secret',targetUrl:value.targetUrl,payload,receipt,provenance};
}

export function carcinusExistingProvenanceSha256(value:CarcinusExistingProvenance){return carcinusHash(stable(value))}
export function carcinusExistingSecretSha256(value:CarcinusExistingPageSecret){return carcinusHash(serializeCarcinusExistingSecret(value))}
export function carcinusExistingAccountId(identity:string){return uuidFrom(`carcinus-existing-account:${identity}`)}
export function carcinusExistingTaskId(identity:string){return uuidFrom(`carcinus-existing-task:${identity}`)}

export function validCarcinusExistingAccount(account:Account|undefined):account is Account&{carcinus:CarcinusExistingAccountProof}{
  const proof=account?.carcinus;
  return !!account&&account.channelId==='carcinus'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.source==='imported'&&account.email===''&&account.registrationAttempts===0&&proof?.version===3&&proof.stage==='existing_managed'&&proof.identity===account.username&&proof.publicUrl===account.publicationUrl&&proof.publicUrl===carcinusPublicUrl(proof.identity)&&proof.restoreUrl===carcinusRestoreUrl(proof.identity)&&UUID.test(proof.siteId)&&[proof.siteIdentitySha256,proof.targetUrlSha256,proof.payloadSha256,proof.provenanceSha256,proof.secretSha256,proof.tokenFingerprint].every(value=>HASH.test(value))&&exactDate(proof.checkedAt);
}

export function carcinusExistingExpectation(secret:CarcinusExistingPageSecret):CarcinusPublicPageExpectation|undefined{const evidence=existingTemplateEvidence(secret.payload.htmlTemplate,secret.targetUrl,secret.receipt.publicUrl);if(!evidence)return;return {identity:secret.payload.identity,htmlTemplate:evidence.htmlTemplate,targetUrl:secret.targetUrl,mainSha256:evidence.main.mainSha256,publicUrl:secret.receipt.publicUrl,restoreUrl:secret.receipt.restoreUrl}}

export function validCarcinusExistingAcceptance(value:CarcinusPublicAcceptance,secret:CarcinusExistingPageSecret):boolean{
  const expected=carcinusExistingExpectation(secret),main=expected&&carcinusReviewedMain(expected.htmlTemplate,expected.targetUrl,true),rel=[...new Set(value.rel)].sort();
  return !!expected&&!!main&&exactDate(value.checkedAt)&&value.httpStatus===200&&HASH.test(value.publicHtmlSha256)&&value.reviewedMainSha256===expected.mainSha256&&value.reviewedMainMatches===true&&value.titlePresent===(value.title!==null)&&(value.title===null||value.title===main.title)&&value.canonicalPresent===(value.canonical!==null)&&(value.canonical===null||value.canonical===expected.publicUrl)&&value.targetUrl===expected.targetUrl&&value.nativeAnchorCount===1&&JSON.stringify(value.rel)===JSON.stringify(rel)&&value.rel.every(item=>/^[a-z0-9_-]{1,64}$/.test(item))&&value.robotsStatus===200&&value.robotsAllowed===true&&value.metaNoindex===false&&value.xRobotsNoindex===false&&[200,404].includes(value.restoreStatus)&&value.identityBinding===(value.restoreStatus===200?'restore_and_reviewed_main':'reviewed_main')&&value.retention===CARCINUS_RETENTION;
}

export function validCarcinusExistingReceipt(value:CarcinusExistingPageReceipt,secret:CarcinusExistingPageSecret):boolean{
  const evidence=existingTemplateEvidence(secret.payload.htmlTemplate,secret.targetUrl,secret.receipt.publicUrl),request=carcinusRequest(secret.payload),payloadSha256=carcinusHash(JSON.stringify(carcinusPayload(secret.payload)));
  return value.version===1&&value.kind==='existing_page'&&value.stage==='verified'&&!!evidence&&value.identity===secret.payload.identity&&value.operationId===secret.receipt.operationId&&value.sourceHash===request.sourceHash&&value.requestHash===request.requestHash&&value.createdAt===secret.receipt.createdAt&&value.preflightCheckedAt===secret.receipt.preflightCheckedAt&&value.preflightStatus===404&&value.publicUrl===secret.receipt.publicUrl&&value.restoreUrl===secret.receipt.restoreUrl&&value.tokenFingerprint===secret.receipt.tokenFingerprint&&value.targetUrlSha256===carcinusHash(secret.targetUrl)&&value.mainSha256===evidence.main.mainSha256&&value.payloadSha256===payloadSha256&&value.provenanceSha256===carcinusExistingProvenanceSha256(secret.provenance)&&value.secretSha256===carcinusExistingSecretSha256(secret)&&validCarcinusExistingAcceptance(value.acceptance,secret);
}

export function validCarcinusExistingStateReceipt(value:CarcinusExistingPageReceipt):boolean{
  const rel=[...new Set(value.acceptance.rel)].sort();
  return value.version===1&&value.kind==='existing_page'&&value.stage==='verified'&&validCarcinusIntent(value)&&value.publicUrl===carcinusPublicUrl(value.identity)&&value.restoreUrl===carcinusRestoreUrl(value.identity)&&[value.tokenFingerprint,value.targetUrlSha256,value.mainSha256,value.payloadSha256,value.provenanceSha256,value.secretSha256,value.acceptance.publicHtmlSha256].every(item=>HASH.test(item))&&value.acceptance.httpStatus===200&&value.acceptance.reviewedMainMatches===true&&value.acceptance.reviewedMainSha256===value.mainSha256&&carcinusHash(value.acceptance.targetUrl)===value.targetUrlSha256&&value.acceptance.nativeAnchorCount===1&&JSON.stringify(value.acceptance.rel)===JSON.stringify(rel)&&value.acceptance.rel.every(item=>/^[a-z0-9_-]{1,64}$/.test(item))&&value.acceptance.robotsStatus===200&&value.acceptance.robotsAllowed===true&&value.acceptance.metaNoindex===false&&value.acceptance.xRobotsNoindex===false&&[200,404].includes(value.acceptance.restoreStatus)&&value.acceptance.identityBinding===(value.acceptance.restoreStatus===200?'restore_and_reviewed_main':'reviewed_main')&&value.acceptance.retention===CARCINUS_RETENTION&&exactDate(value.acceptance.checkedAt)&&value.acceptance.titlePresent===(value.acceptance.title!==null)&&value.acceptance.canonicalPresent===(value.acceptance.canonical!==null)&&(value.acceptance.canonical===null||value.acceptance.canonical===value.publicUrl);
}

export function carcinusExistingBindingMatches(task:Task,account:Account,site:Site,secret:CarcinusExistingPageSecret):boolean{
  const proof=account.carcinus,receipt=task.carcinusExisting;
  return validCarcinusExistingAccount(account)&&proof?.version===3&&!!receipt&&validCarcinusExistingReceipt(receipt,secret)&&task.channelId==='carcinus'&&task.sourceDomain==='carcinus.org'&&task.siteId===site.id&&task.accountId===account.id&&task.publicUrl===receipt.publicUrl&&task.topicUrl===secret.targetUrl&&task.checkpoint==='existing_link'&&task.publicationMethod==='external'&&!task.submittedAt&&!task.firstLiveAt&&proof.identity===receipt.identity&&proof.siteId===site.id&&proof.siteIdentitySha256===carcinusSiteIdentity(site)&&proof.targetUrlSha256===receipt.targetUrlSha256&&proof.payloadSha256===receipt.payloadSha256&&proof.provenanceSha256===receipt.provenanceSha256&&proof.secretSha256===receipt.secretSha256&&proof.tokenFingerprint===receipt.tokenFingerprint&&proof.publicUrl===receipt.publicUrl&&proof.restoreUrl===receipt.restoreUrl;
}

function importConflict(state:State){return state.accounts.some(value=>value.channelId==='carcinus'||!!value.carcinus)||state.accountBindings.some(value=>value.channelId==='carcinus')||state.tasks.some(value=>value.channelId==='carcinus'||!!value.carcinus||!!value.carcinusInput||!!value.carcinusExisting)}

export async function connectCarcinusExistingPage(store:Store,vault:Vault,input:CarcinusExistingConnectionInput,deps:CarcinusDependencies={}):Promise<Account>{
  if(!UUID.test(input.siteId))throw Error('Carcinus 网站选择无效');const imported=parseCarcinusExistingPageExport(input.exportJson);if(!imported)throw Error('Carcinus 既有页面导出记录无效');const before=store.read(),site=before.sites.find(value=>value.id===input.siteId);if(!site)throw Error('网站不存在');if(!isArticleTopicUrl(imported.targetUrl,site))throw Error('Carcinus 原目标不属于所选网站的文章页');if(importConflict(before))throw Error('Carcinus 已有身份、页面或任务记录；不会导入第二个对象');
  const secret=carcinusExistingSecret(imported),expectation=carcinusExistingExpectation(secret);if(!expectation)throw Error('Carcinus 原 HTML 或唯一目标链接无效');const inspected=await inspectCarcinusExistingPage(expectation,deps);if(inspected.status!=='found')throw Error(inspected.status==='invalid'?'Carcinus 公开页与原 canonical 内容、目标链接或抓取状态不一致':'Carcinus 公开页只读核验暂不可用；未保存连接');
  const checkedAt=inspected.acceptance.checkedAt,accountId=carcinusExistingAccountId(imported.payload.identity),taskId=carcinusExistingTaskId(imported.payload.identity),accountKey=`account:${accountId}`,publicationKey=`publication:${taskId}`,serialized=serializeCarcinusExistingSecret(secret),main=existingTemplateEvidence(imported.payload.htmlTemplate,imported.targetUrl,imported.receipt.publicUrl)!.main;
  const receipt:CarcinusExistingPageReceipt={version:1,kind:'existing_page',identity:imported.payload.identity,operationId:imported.receipt.operationId,sourceHash:imported.receipt.sourceHash,requestHash:imported.receipt.requestHash,createdAt:imported.receipt.createdAt,preflightCheckedAt:imported.receipt.preflightCheckedAt,preflightStatus:404,publicUrl:imported.receipt.publicUrl,restoreUrl:imported.receipt.restoreUrl,tokenFingerprint:imported.receipt.tokenFingerprint,targetUrlSha256:carcinusHash(imported.targetUrl),mainSha256:main.mainSha256,payloadSha256:carcinusHash(JSON.stringify(carcinusPayload(imported.payload))),provenanceSha256:carcinusExistingProvenanceSha256(imported.provenance),secretSha256:carcinusExistingSecretSha256(secret),stage:'verified',acceptance:inspected.acceptance};
  const account:Account={id:accountId,channelId:'carcinus',email:'',username:imported.payload.identity,publicationUrl:imported.receipt.publicUrl,createdAt:checkedAt,updatedAt:checkedAt,registeredAt:imported.receipt.createdAt,verifiedAt:checkedAt,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',registrationAttempts:0,carcinus:{version:3,identity:imported.payload.identity,siteId:site.id,siteIdentitySha256:carcinusSiteIdentity(site),targetUrlSha256:receipt.targetUrlSha256,payloadSha256:receipt.payloadSha256,provenanceSha256:receipt.provenanceSha256,secretSha256:receipt.secretSha256,publicUrl:receipt.publicUrl,restoreUrl:receipt.restoreUrl,stage:'existing_managed',tokenFingerprint:receipt.tokenFingerprint,checkedAt}};
  const task:Task={id:taskId,siteId:site.id,channelId:'carcinus',accountId,sourceDomain:'carcinus.org',status:'skipped',createdAt:imported.receipt.createdAt,scheduledAt:imported.receipt.createdAt,updatedAt:checkedAt,attempts:0,message:'已导入并只读核验既有 Carcinus 页面；保留来源记录，不计为本月新增。没有注册身份、发送 POST 或建立新 publication。',topicUrl:imported.targetUrl,publicUrl:receipt.publicUrl,verifiedAt:checkedAt,lastCheckedAt:checkedAt,health:'healthy',linkCheck:'found',linkRel:inspected.rel,publicationMethod:'external',checkpoint:'existing_link',history:[{at:checkedAt,status:'skipped',message:'既有 Carcinus 页面与原 canonical 内容、唯一目标链接和抓取状态已只读核验；未新增发布。',linkCheck:'found'}],cost:{aiCalls:0},carcinusExisting:receipt};
  const encrypted=vault.encryptSecrets({[accountKey]:imported.writeToken,[publicationKey]:serialized});if(!encrypted[accountKey]||!encrypted[publicationKey]||encrypted[accountKey]===imported.writeToken||encrypted[publicationKey]===serialized)throw Error('Carcinus 既有页面凭据未能加密');const siteSnapshot=stable({id:site.id,url:site.url,domain:site.domain,name:site.name});
  store.updateWithCiphers(state=>{const currentSite=state.sites.find(value=>value.id===site.id);if(!currentSite||stable({id:currentSite.id,url:currentSite.url,domain:currentSite.domain,name:currentSite.name})!==siteSnapshot||importConflict(state))throw Error('Carcinus 网站或唯一对象状态已改变');state.accounts.push(account);state.tasks.push(task);state.accountBindings.push({id:uuidFrom(`carcinus-existing-binding:${site.id}:${account.id}`),siteId:site.id,channelId:'carcinus',accountId:account.id,createdAt:checkedAt,updatedAt:checkedAt})},encrypted,[],{[accountKey]:undefined,[publicationKey]:undefined});
  return account;
}
