import {load} from 'cheerio';
import {TXTSBS_AUTHOR,TXTSBS_ID,TXTSBS_MAX_CONTENT_BYTES,txtsbsHash,txtsbsPublicUrl,txtsbsRequest,txtsbsSiteAuthor,validTxtSbsIntent,type TxtSbsArticle,type TxtSbsIntent,type TxtSbsOpaqueResponse,type TxtSbsPersistence,type TxtSbsReceipt} from '../integrations/txtsbs';
import type {Site,Task} from '../shared/types';
import type {State,Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const UNSAFE='script,style,link,meta,base,iframe,object,embed,form,input,button,textarea,select,img,picture,video,audio,source,track,canvas,svg,math';
type StateStore=Pick<Store,'read'|'update'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'encryptSecrets'|'get'>;
export interface TxtSbsTaskIdentity extends TxtSbsArticle {targetUrl:string;sourceHash:string;requestHash:string}

function safeArticleFragment(content:string,targetUrl:string){
  const $=load(content,undefined,false),attributes=(element:unknown)=>element&&typeof element==='object'&&'attribs' in element?Object.keys((element as {attribs?:Record<string,string>}).attribs??{}):[];if(!content.trim()||Buffer.byteLength(content,'utf8')>TXTSBS_MAX_CONTENT_BYTES||$(UNSAFE).length||$('*').toArray().some(element=>attributes(element).some(name=>/^on/i.test(name)||['style','src','srcset','action','formaction','data','contenteditable'].includes(name.toLowerCase()))))return false;
  const links=$('a[href]').toArray();if(links.length!==1)return false;let href:string;try{href=new URL($(links[0]).attr('href')??'',targetUrl).href}catch{return false}if(href!==targetUrl||$(links[0]).attr('href')!==targetUrl)return false;
  if($('a').length!==1||!$(links[0]).text().trim()||$(links[0]).toArray().some(element=>attributes(element).some(name=>!['href','rel'].includes(name.toLowerCase()))))return false;
  return $('p,h2,h3,ul,ol,li,pre,code,strong,em,blockquote,a').length>0&&$.root().text().trim().length>0;
}
export function txtsbsTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>&Partial<Pick<Task,'txtsbs'|'publicationSnapshot'|'submittedAt'>>,site:Pick<Site,'url'|'name'>):TxtSbsTaskIdentity|undefined{
  const draft=task.draft;if(!draft||!draft.title||draft.title!==draft.title.trim()||[...draft.title].length>200||draft.description!==draft.description.trim()||Buffer.byteLength(draft.description,'utf8')>4000)return;
  let targetUrl:string;try{targetUrl=new URL(task.topicUrl??site.url).href;if(!targetUrl.startsWith('https://'))return}catch{return}
  if(!safeArticleFragment(draft.body,targetUrl))return;
  const article:TxtSbsArticle={title:draft.title,abstract:draft.description,author:txtsbsSiteAuthor({name:(task.submittedAt?task.publicationSnapshot?.siteName:undefined)||site.name}),content:draft.body,showDate:true,showSerp:true};
  if(!article.author)return;
  const saved=task.txtsbs;
  if(saved){
    for(const author of [TXTSBS_AUTHOR,'AI assistant involved in Linkflow development']){
      const legacy:TxtSbsArticle={...article,author},original=txtsbsRequest(legacy);
      if(saved.sourceHash===original.sourceHash&&saved.requestHash===original.requestHash)
        return {...legacy,targetUrl,sourceHash:original.sourceHash,requestHash:original.requestHash};
    }
  }
  const request=txtsbsRequest(article);return {...article,targetUrl,sourceHash:request.sourceHash,requestHash:request.requestHash};
}
function sameIntent(a:TxtSbsIntent,b:TxtSbsIntent){return a.operationId===b.operationId&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
function intentOf(task:Task):TxtSbsIntent|undefined{const saved=task.txtsbs;return saved?{operationId:saved.operationId,sourceHash:saved.sourceHash,requestHash:saved.requestHash,createdAt:saved.createdAt}:undefined}
function exactDate(value:string){return Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value}
function pendingBaseClean(task:Task){return !task.accountId&&!task.publicUrl&&!task.verifiedAt&&!task.firstLiveAt&&!task.linkCheck&&!task.linkRel&&!task.publicationMethod&&!task.lastCheckedAt&&!task.nextCheckAt&&!task.lostAt&&!task.reviewUntil&&!task.reviewKind&&task.consecutiveMissing===undefined}
function pendingClean(task:Task){return pendingBaseClean(task)&&task.reconcileAttempts===undefined&&!task.reconcileAfter}
function pendingPromotion(task:Task){if(!pendingBaseClean(task))return false;const attempts=task.reconcileAttempts;if(attempts===undefined)return !task.reconcileAfter;if(!Number.isInteger(attempts)||attempts<1||attempts>3)return false;return attempts<3?!!task.reconcileAfter&&exactDate(task.reconcileAfter):!task.reconcileAfter}
function current(state:State,taskId:string,siteId:string,intent:TxtSbsIntent){const task=state.tasks.find(value=>value.id===taskId),site=state.sites.find(value=>value.id===siteId);if(!task||!site||task.siteId!==siteId||task.channelId!=='txtsbs'||task.sourceDomain!=='txt.sbs'||task.accountId||state.accounts.some(value=>value.channelId==='txtsbs')||state.accountBindings.some(value=>value.channelId==='txtsbs'))throw Error('txt.sbs 任务绑定已改变');const identity=txtsbsTaskIdentity(task,site);if(!identity||identity.sourceHash!==intent.sourceHash||identity.requestHash!==intent.requestHash)throw Error('txt.sbs 原稿已改变');return {task,site,identity}}

export function parseTxtSbsOpaqueResponseSecret(value:string):TxtSbsOpaqueResponse|undefined{try{const v=JSON.parse(value) as Record<string,unknown>,keys='bodyBase64,bodyComplete,bodySha256,capturedAt,contentType,createdAt,kind,operationId,redirected,requestHash,responseType,responseUrl,sourceHash,status,version';if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys||v.version!==1||v.kind!=='txtsbs_opaque_response'||typeof v.operationId!=='string'||typeof v.sourceHash!=='string'||typeof v.requestHash!=='string'||typeof v.createdAt!=='string'||!validTxtSbsIntent(v as unknown as TxtSbsIntent)||typeof v.capturedAt!=='string'||!exactDate(v.capturedAt)||!Number.isInteger(v.status)||Number(v.status)<100||Number(v.status)>599||typeof v.contentType!=='string'||v.contentType.length>512||typeof v.responseUrl!=='string'||v.responseUrl.length>2048||typeof v.redirected!=='boolean'||typeof v.responseType!=='string'||v.responseType.length>64||typeof v.bodyBase64!=='string'||typeof v.bodySha256!=='string'||!HASH.test(v.bodySha256)||typeof v.bodyComplete!=='boolean')return;const bytes=Buffer.from(v.bodyBase64,'base64');if(bytes.length>256*1024||bytes.toString('base64')!==v.bodyBase64||txtsbsHash(bytes)!==v.bodySha256)return;return v as unknown as TxtSbsOpaqueResponse}catch{return}}

export function createTxtSbsPublicationPersistence(store:StateStore,vault:SecureVault,options:{taskId:string;siteId:string;expectedIntent?:TxtSbsIntent;assertSubmissionAuthorized:(snapshot:{state:State;task:Task;site:Site})=>true;now?:()=>Date}):TxtSbsPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId))throw Error('txt.sbs 保存参数无效');let claimed=options.expectedIntent?{...options.expectedIntent}:undefined;if(claimed&&!validTxtSbsIntent(claimed))throw Error('txt.sbs 恢复提交信息无效');const key=`publication:${options.taskId}`,stamp=()=> (options.now?.()??new Date()).toISOString();
  return {
    async persistIntent(intent){if(claimed||!validTxtSbsIntent(intent))throw Error('txt.sbs 不能重复提交');store.update(state=>{const {task,site}=current(state,options.taskId,options.siteId,intent);if(task.txtsbs||task.submittedAt||!pendingClean(task)||task.status==='live'||/(?:txtsbs|submitt|publish|receipt|uncertain)/i.test(task.checkpoint??''))throw Error('txt.sbs 任务已有提交记录');if(!state.settings.autoRun||task.status!=='running'||site.status!=='ready')throw Error('txt.sbs 任务已暂停');if(options.assertSubmissionAuthorized(structuredClone({state,task,site}))!==true)throw Error('txt.sbs 授权已改变');task.txtsbs={...intent,stage:'submitting'};task.submittedAt=intent.createdAt;task.checkpoint='txtsbs_create_submitting';task.status='review';task.health='pending';task.updatedAt=stamp();task.message='txt.sbs 单次表单提交信息已保存；结果不明时不会重发。'});claimed={...intent}},
    assertReadyToSubmit(intent){if(!claimed||!sameIntent(claimed,intent))throw Error('txt.sbs 提交信息不一致');const state=store.read(),{task,site}=current(state,options.taskId,options.siteId,intent);if(task.txtsbs?.stage!=='submitting'||task.submittedAt!==intent.createdAt||task.status!=='review'||!state.settings.autoRun||site.status!=='ready'||options.assertSubmissionAuthorized(structuredClone({state,task,site}))!==true)throw Error('txt.sbs 授权已改变');return true},
    async persistOpaqueResponse(value){if(!claimed||!sameIntent(claimed,value)||!parseTxtSbsOpaqueResponseSecret(JSON.stringify(value)))throw Error('txt.sbs 原始响应无效');if(store.getCipher(key)){const parsed=await vault.get(key),saved=parsed&&parseTxtSbsOpaqueResponseSecret(parsed);if(saved&&sameIntent(saved,value)&&saved.bodySha256===value.bodySha256&&saved.bodyComplete===value.bodyComplete)return;if(saved&&sameIntent(saved,value)&&!saved.bodyComplete&&value.bodyComplete)throw Error('txt.sbs 原始响应已经封存，禁止替换');throw Error('txt.sbs 原始响应已存在')}const serialized=JSON.stringify(value),cipher=vault.encryptSecrets({[key]:serialized})[key];if(!cipher||cipher===serialized)throw Error('txt.sbs 原始响应未加密');store.updateWithCiphers(state=>{const {task}=current(state,options.taskId,options.siteId,claimed!);const saved=task.txtsbs;if(!saved||!['submitting','opaque_response'].includes(saved.stage)||!sameIntent(intentOf(task)!,claimed!)||task.submittedAt!==claimed!.createdAt||!['review','needs_input','skipped'].includes(task.status)||task.health!=='pending'||!pendingPromotion(task)||store.getCipher(key))throw Error('txt.sbs 原始响应阶段无效');task.txtsbs={...saved,stage:'opaque_response'};task.checkpoint='txtsbs_opaque_response';task.updatedAt=stamp();task.message='txt.sbs 原始响应已加密保留；不会重新提交。'},{[key]:cipher})},
    async loadOpaqueResponse(){const value=await vault.get(key);return value?parseTxtSbsOpaqueResponseSecret(value):undefined},
    async promoteReceipt(receipt:TxtSbsReceipt){const expected=claimed;if(!expected||!sameIntent(expected,receipt)||!TXTSBS_ID.test(receipt.id)||receipt.publicUrl!==txtsbsPublicUrl(receipt.id))throw Error('txt.sbs 返回记录与原提交信息不一致');store.update(state=>{const {task}=current(state,options.taskId,options.siteId,expected),saved=task.txtsbs;if(!saved||!['submitting','opaque_response'].includes(saved.stage)||!sameIntent(intentOf(task)!,expected)||task.submittedAt!==expected.createdAt||!['review','needs_input'].includes(task.status)||task.health!=='pending'||!pendingPromotion(task)||!store.getCipher(key))throw Error('txt.sbs 返回记录阶段或加密原始响应无效');task.txtsbs={...saved,stage:'api_receipt',id:receipt.id};task.publicUrl=receipt.publicUrl;task.checkpoint='txtsbs_api_receipt';task.reconcileAttempts=undefined;task.reconcileAfter=undefined;task.updatedAt=stamp();task.message='txt.sbs 原始表单返回记录与管理密钥已加密保留；等待公开全文与抓取策略检查。'})},
  };
}

export const txtsbsPublicationTesting={intentOf,pendingClean,pendingPromotion,safeArticleFragment};
