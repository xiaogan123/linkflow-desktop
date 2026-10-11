import {renderShareYourHtmlArticle} from '../integrations/shareyourhtml-article';
import {htmlAppIdentity,htmlAppPublicUrl,type HtmlAppIntent,type HtmlAppPersistence,type HtmlAppReceipt} from '../integrations/html-app';
import type {Site,Task} from '../shared/types';
import {HTML_APP_PUBLIC_NOTICE_VERSION,HTML_APP_TERMS_URL,htmlAppPublicNoticeAccepted,validHtmlAppPublicNoticeAcknowledgement,type HtmlAppPublicNoticeAcknowledgement} from '../shared/html-app-notice';
import type {State,Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OP=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/,HASH=/^[a-f0-9]{64}$/,SITE=/^[a-z0-9][a-z0-9-]{3,63}$/;
type StateStore=Pick<Store,'read'|'update'|'updateWithCiphers'|'getCipher'>;
type Encryptor=Pick<Vault,'encryptSecrets'>;
type NoticeStore=Pick<Store,'update'>;
export interface HtmlAppTaskIdentity{html:string;targetUrl:string;sourceHash:string;requestHash:string}
export interface HtmlAppSecret{version:1;taskId:string;operationId:string;siteId:string;publicUrl:string;sourceHash:string;requestHash:string;updateKey:string}

export function acceptHtmlAppPublicNotice(store:NoticeStore,acknowledgement:HtmlAppPublicNoticeAcknowledgement,options:{now?:()=>Date}={}){
  if(!validHtmlAppPublicNoticeAcknowledgement(acknowledgement))throw Error('ht-ml.app 公开发布告知确认无效');
  const acceptedAt=(options.now?.()??new Date()).toISOString();let resumed=0;
  store.update(state=>{
    state.settings.htmlAppPublicNotice={version:HTML_APP_PUBLIC_NOTICE_VERSION,acceptedAt,termsUrl:HTML_APP_TERMS_URL};
    for(const task of state.tasks){
      if(task.channelId!=='html-app'||task.status!=='needs_input'||task.checkpoint!=='html_app_public_notice'||task.submittedAt||task.htmlApp)continue;
      task.status='queued';task.checkpoint=undefined;task.scheduledAt=acceptedAt;task.nextCheckAt=undefined;task.updatedAt=acceptedAt;task.message='ht-ml.app 公开发布告知已确认；原任务将按正常审核与发布闸继续。';resumed++;
    }
  });
  return {acceptedAt,resumed};
}

export function htmlAppTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'language'>):HtmlAppTaskIdentity|undefined{
  if(!task.draft)return;
  try{const targetUrl=task.topicUrl??site.url;const rendered=renderShareYourHtmlArticle({draft:task.draft,targetUrl,language:site.language,slug:'html-app-publication',allowLinkFragments:true}),identity=htmlAppIdentity(rendered.html);return {html:rendered.html,targetUrl,sourceHash:identity.sourceHash,requestHash:identity.requestHash}}catch{return}
}
function validIntent(value:HtmlAppIntent){return OP.test(value.operationId)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
function binding(state:State,taskId:string,siteId:string,intent:Pick<HtmlAppIntent,'sourceHash'|'requestHash'>){
  const task=state.tasks.find(item=>item.id===taskId),site=state.sites.find(item=>item.id===siteId);
  if(!task||!site||task.siteId!==siteId||task.channelId!=='html-app'||task.sourceDomain!=='ht-ml.app'||task.accountId||state.accounts.some(a=>a.channelId==='html-app')||state.accountBindings.some(b=>b.channelId==='html-app'))throw Error('ht-ml.app 任务绑定已改变');
  const identity=htmlAppTaskIdentity(task,site);if(!identity||identity.sourceHash!==intent.sourceHash||identity.requestHash!==intent.requestHash)throw Error('ht-ml.app 原稿已改变');
  return {task,site};
}
function pendingClean(task:Task){return !task.verifiedAt&&!task.firstLiveAt&&!task.linkCheck&&!task.linkRel&&!task.publicationMethod&&!task.lastCheckedAt&&!task.nextCheckAt&&!task.lostAt&&!task.reviewUntil&&!task.reviewKind&&task.consecutiveMissing===undefined&&task.reconcileAttempts===undefined&&!task.reconcileAfter}
export function parseHtmlAppPublicationSecret(value:string):HtmlAppSecret|undefined{
  try{const v=JSON.parse(value) as Record<string,unknown>;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='operationId,publicUrl,requestHash,siteId,sourceHash,taskId,updateKey,version'||v.version!==1||typeof v.taskId!=='string'||!UUID.test(v.taskId)||typeof v.operationId!=='string'||!OP.test(v.operationId)||typeof v.siteId!=='string'||!SITE.test(v.siteId)||v.publicUrl!==htmlAppPublicUrl(v.siteId)||typeof v.sourceHash!=='string'||!HASH.test(v.sourceHash)||typeof v.requestHash!=='string'||!HASH.test(v.requestHash)||typeof v.updateKey!=='string'||v.updateKey.length<16||v.updateKey.length>8192||/[\s\u0000-\u001f\u007f]/.test(v.updateKey))return;return v as unknown as HtmlAppSecret}catch{return}
}
export function createHtmlAppPublicationPersistence(store:StateStore,vault:Encryptor,options:{taskId:string;siteId:string;expectedIntent?:HtmlAppIntent;assertSubmissionAuthorized:(snapshot:{state:State;task:Task;site:Site})=>true;now?:()=>Date}):HtmlAppPersistence{
  if(!UUID.test(options.taskId)||!UUID.test(options.siteId))throw Error('ht-ml.app 任务参数无效');
  let claimed=options.expectedIntent?{...options.expectedIntent}:undefined;if(claimed&&!validIntent(claimed))throw Error('ht-ml.app 恢复意图无效');
  const key=`publication:${options.taskId}`,stamp=()=> (options.now?.()??new Date()).toISOString();
  const authorize=(intent:HtmlAppIntent)=>{const state=store.read(),{task,site}=binding(state,options.taskId,options.siteId,intent);if(!htmlAppPublicNoticeAccepted(state.settings.htmlAppPublicNotice))throw Error('ht-ml.app 公开发布告知尚未确认');if(options.assertSubmissionAuthorized(structuredClone({state,task,site}))!==true)throw Error('ht-ml.app 授权已改变');return true as const};
  return {
    async persistIntent(intent){
      if(claimed||!validIntent(intent))throw Error('ht-ml.app 禁止重复意图');
      store.update(state=>{const {task,site}=binding(state,options.taskId,options.siteId,intent);if(task.htmlApp||task.submittedAt||task.publicUrl||!pendingClean(task)||task.status==='live'||/(?:html_app|submitt|publish|receipt|uncertain)/i.test(task.checkpoint??''))throw Error('ht-ml.app 任务已有提交记录');if(!state.settings.autoRun||task.status!=='running'||site.status!=='ready')throw Error('ht-ml.app 任务已暂停');if(!htmlAppPublicNoticeAccepted(state.settings.htmlAppPublicNotice))throw Error('ht-ml.app 公开发布告知尚未确认');if(options.assertSubmissionAuthorized(structuredClone({state,task,site}))!==true)throw Error('ht-ml.app 授权已改变');task.htmlApp={...intent,stage:'submitting'};task.submittedAt=intent.createdAt;task.checkpoint='html_app_create_submitting';task.status='review';task.health='pending';task.updatedAt=stamp();task.message='ht-ml.app 单次创建意图已保存；结果不明时不会重发。'});claimed={...intent};
    },
    assertReadyToSubmit(intent){if(!claimed||JSON.stringify(claimed)!==JSON.stringify(intent))throw Error('ht-ml.app 意图不一致');return authorize(intent)},
    async persistCreatedAtomically(value){
      const expected=claimed;if(!expected||value.receipt.operationId!==expected.operationId||value.receipt.sourceHash!==expected.sourceHash||value.receipt.requestHash!==expected.requestHash||value.receipt.createdAt!==expected.createdAt||value.receipt.publicUrl!==htmlAppPublicUrl(value.receipt.siteId)||store.getCipher(key))throw Error('ht-ml.app 回执不一致');
      const serialized=JSON.stringify({version:1,taskId:options.taskId,operationId:expected.operationId,siteId:value.receipt.siteId,publicUrl:value.receipt.publicUrl,sourceHash:expected.sourceHash,requestHash:expected.requestHash,updateKey:value.updateKey} satisfies HtmlAppSecret);const ciphers=vault.encryptSecrets({[key]:serialized});if(!ciphers[key]||ciphers[key]===serialized)throw Error('ht-ml.app 凭据未加密');
      store.updateWithCiphers(state=>{if(store.getCipher(key))throw Error('ht-ml.app 凭据已存在');const {task}=binding(state,options.taskId,options.siteId,expected),saved=task.htmlApp;if(!saved||saved.stage!=='submitting'||saved.operationId!==expected.operationId||saved.createdAt!==expected.createdAt||task.submittedAt!==expected.createdAt||task.checkpoint!=='html_app_create_submitting'||task.status!=='review'||task.health!=='pending'||!pendingClean(task))throw Error('ht-ml.app 回执阶段无效');task.htmlApp={...saved,stage:'api_receipt',siteId:value.receipt.siteId};task.publicUrl=value.receipt.publicUrl;task.checkpoint='html_app_api_receipt';task.updatedAt=stamp();task.message='ht-ml.app API 回执与加密更新凭据已原子保存；公开页尚未验收。'},ciphers);
    },
  };
}
