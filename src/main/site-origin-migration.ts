import type {Site,SiteStatus,Task} from '../shared/types';
import {canonicalPublicPageUrl} from '../shared/publication';
import {normalizePublicUrl} from '../integrations/web';
import {hasExternalAttempt} from './task-recovery';
import {normalizeDomain,publicUrl} from './validation';
import type {State} from './store';

export interface SiteOriginIdentity {domain:string;url:string;name:string;language:string}
export interface SiteOriginTaskSnapshot {taskId:string;site:SiteOriginIdentity}
export interface SiteOriginSiteSnapshot extends SiteOriginIdentity {id:string;status:SiteStatus;monthlyTarget:number;linkTargets?:Site['linkTargets'];topicOverrides?:Site['topicOverrides'];topics?:Site['topics'];topicsCheckedAt?:string;topicsAttemptedAt?:string;topicsError?:string;searchReports?:Site['searchReports']}
export interface SiteOriginRecoverySnapshot {id:string;siteId:string;channelId:string;accountId?:string;sourceDomain:string;status:Task['status'];createdAt:string;scheduledAt:string;updatedAt:string;attempts:number;message:string;topicUrl?:string;topicContentHash?:string;topicSwitchAttempts?:number;articleAttempts?:Task['articleAttempts'];draft?:Task['draft'];draftRevision?:number;articleRepairAttempts?:number;draftUpdatedAt?:string;articleApprovedAt?:string;articleReview?:Task['articleReview'];history?:Task['history'];cost?:Task['cost'];checkpoint?:string;reason?:string}
export interface SiteOriginRecoveryGrant {taskId:string;grantedAt:string;consumedAt?:string;before:SiteOriginRecoverySnapshot}
export interface SiteOriginMigration {
  version:1;
  siteId:string;
  migratedAt:string;
  before:SiteOriginSiteSnapshot;
  after:SiteOriginIdentity;
  telegraphTasks:SiteOriginTaskSnapshot[];
  recovery?:SiteOriginRecoveryGrant;
}

export interface SiteOriginMigrationInput {
  siteId:string;
  expectedDomain:string;
  expectedUrl:string;
  newUrl:string;
  operatorAuthorized:true;
  recoveryTaskId?:string;
  resumeStatus?:Extract<SiteStatus,'ready'>;
}

type MigrationState=Pick<State,'sites'|'tasks'|'accounts'|'accountBindings'|'siteOriginMigrations'>;
const exactDate=(value:string)=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const identity=(site:Pick<Site,'domain'|'url'|'name'|'language'>):SiteOriginIdentity=>({domain:site.domain,url:site.url,name:site.name,language:site.language});
const siteSnapshot=(site:Site):SiteOriginSiteSnapshot=>structuredClone({id:site.id,...identity(site),status:site.status,monthlyTarget:site.monthlyTarget,...(site.linkTargets?{linkTargets:site.linkTargets}:{}),...(site.topicOverrides?{topicOverrides:site.topicOverrides}:{}),...(site.topics?{topics:site.topics}:{}),...(site.topicsCheckedAt?{topicsCheckedAt:site.topicsCheckedAt}:{}),...(site.topicsAttemptedAt?{topicsAttemptedAt:site.topicsAttemptedAt}:{}),...(site.topicsError?{topicsError:site.topicsError}:{}),...(site.searchReports?{searchReports:site.searchReports}:{})});
const recoverySnapshot=(task:Task):SiteOriginRecoverySnapshot=>structuredClone({id:task.id,siteId:task.siteId,channelId:task.channelId,...(task.accountId?{accountId:task.accountId}:{}),sourceDomain:task.sourceDomain,status:task.status,createdAt:task.createdAt,scheduledAt:task.scheduledAt,updatedAt:task.updatedAt,attempts:task.attempts,message:task.message,...(task.topicUrl?{topicUrl:task.topicUrl}:{}),...(task.topicContentHash?{topicContentHash:task.topicContentHash}:{}),...(task.topicSwitchAttempts===undefined?{}:{topicSwitchAttempts:task.topicSwitchAttempts}),...(task.articleAttempts?{articleAttempts:task.articleAttempts}:{}),...(task.draft?{draft:task.draft}:{}),...(task.draftRevision===undefined?{}:{draftRevision:task.draftRevision}),...(task.articleRepairAttempts===undefined?{}:{articleRepairAttempts:task.articleRepairAttempts}),...(task.draftUpdatedAt?{draftUpdatedAt:task.draftUpdatedAt}:{}),...(task.articleApprovedAt?{articleApprovedAt:task.articleApprovedAt}:{}),...(task.articleReview?{articleReview:task.articleReview}:{}),...(task.history?{history:task.history}:{}),...(task.cost?{cost:task.cost}:{}),...(task.checkpoint?{checkpoint:task.checkpoint}:{}),...(task.reason?{reason:task.reason}:{})});
const exactIdentity=(left:SiteOriginIdentity,right:SiteOriginIdentity)=>left.domain===right.domain&&left.url===right.url&&left.name===right.name&&left.language===right.language;
const serializedWithoutConsumption=(value:SiteOriginMigration)=>JSON.stringify({...value,recovery:value.recovery?{...value.recovery,consumedAt:undefined}:undefined});
const MIGRATION_BLOCKER_MESSAGES={
  external:'该站有 Telegraph 以外的外部提交或发布记录，暂不能更换域名',
  batch5Identity:'该站已在 Rant 或 SlopIt 注册过发布账号，或注册请求可能已经发出；为避免旧来源重复注册，暂不能更换域名',
} as const;
const BATCH5_IDENTITY_CHANNELS=new Set(['rant','slopit']);
const BATCH5_IDENTITY_STAGES=new Set(['registered','reserved','request_unknown']);
const BATCH5_SAFE_STAGES=new Set(['rejected','not_sent']);

function hasBatch5IdentityLock(state:MigrationState,siteId:string):boolean{
  const tasks=state.tasks.filter(task=>task.siteId===siteId&&BATCH5_IDENTITY_CHANNELS.has(task.channelId));
  if(tasks.some(task=>!!task.batch5Registration&&task.batch5Registration.channelId===task.channelId&&BATCH5_IDENTITY_STAGES.has(task.batch5Registration.stage)))return true;
  return state.accountBindings.some(binding=>{
    if(binding.siteId!==siteId||!BATCH5_IDENTITY_CHANNELS.has(binding.channelId))return false;
    const account=state.accounts.find(value=>value.id===binding.accountId&&value.channelId===binding.channelId);
    if(account?.source!=='generated'||account.registrationAttempts!==1)return false;
    return !tasks.some(task=>task.channelId===binding.channelId&&task.accountId===account.id&&task.batch5Registration?.channelId===binding.channelId&&BATCH5_SAFE_STAGES.has(task.batch5Registration.stage));
  });
}

function mappedUrl(value:string|undefined,from:SiteOriginIdentity,to:SiteOriginIdentity):string|undefined{
  if(!value)return;
  try{
    const parsed=publicUrl(value),source=publicUrl(from.url);
    if(parsed.origin!==source.origin)return;
    const target=publicUrl(to.url);
    target.pathname=parsed.pathname;target.search=parsed.search;target.hash='';
    return target.href;
  }catch{return}
}

function pristineFutureTask(task:Task):boolean{
  return task.status==='queued'&&task.attempts===0&&(task.cost?.aiCalls??0)===0&&!hasExternalAttempt(task)&&!task.draft&&!task.articleReview&&!task.articleApprovedAt
    &&!(task.articleAttempts?.length)&&!(task.topicSwitchAttempts??0)&&!(task.recoveryAttempts??0)&&!task.recoveryEligible;
}

function assertRecord(state:MigrationState,record:SiteOriginMigration):void{
  if(record.version!==1||!exactDate(record.migratedAt)||record.siteId!==record.before.id)throw Error('网站来源迁移记录无效');
  const site=state.sites.find(value=>value.id===record.siteId);
  if(!site||site.domain!==record.after.domain||site.url!==record.after.url)throw Error('网站来源迁移记录与当前站点不一致');
  if(record.before.domain===record.after.domain||record.before.url===record.after.url)throw Error('网站来源迁移必须改变来源域名');
  const normalized=normalizeDomain(record.after.url),guarded=normalizePublicUrl(record.after.url);
  if(guarded.protocol!=='https:'||normalized.domain!==record.after.domain||normalized.url!==record.after.url)throw Error('网站来源迁移目标不是规范公开 HTTPS 根地址');
  const telegraphIds=new Set<string>();
  for(const frozen of record.telegraphTasks){
    if(telegraphIds.has(frozen.taskId)||!exactIdentity(frozen.site,identity(record.before)))throw Error('Telegraph 旧来源快照无效');
    const task=state.tasks.find(value=>value.id===frozen.taskId);
    if(!task||task.siteId!==record.siteId||task.channelId!=='telegraph'||!hasExternalAttempt(task))throw Error('Telegraph 旧来源快照没有对应的外部历史任务');
    telegraphIds.add(frozen.taskId);
  }
  if(record.recovery){
    const grant=record.recovery,before=grant.before,current=state.tasks.find(task=>task.id===grant.taskId);
    if(grant.taskId!==before.id||before.siteId!==record.siteId||hasExternalAttempt(before)||!exactDate(grant.grantedAt)||grant.grantedAt!==record.migratedAt||grant.consumedAt!==undefined&&!exactDate(grant.consumedAt)||!current||current.siteId!==record.siteId)throw Error('网站迁移恢复许可无效');
    if((current.cost?.aiCalls??0)<(before.cost?.aiCalls??0)||current.topicSwitchAttempts!==before.topicSwitchAttempts||current.attempts<before.attempts)throw Error('网站迁移不能清零任务成本、换题或重试记录');
  }
}

export function assertSiteOriginMigrationState(state:MigrationState):void{
  const records=state.siteOriginMigrations??[],ids=new Set<string>();
  for(const record of records){if(ids.has(record.siteId))throw Error('同一站点只能保留一条更换域名记录');ids.add(record.siteId);assertRecord(state,record)}
}

export function assertSiteOriginMigrationTransition(previous:MigrationState,next:MigrationState,allowImported=false):void{
  assertSiteOriginMigrationState(next);
  for(const after of next.siteOriginMigrations??[]){
    if((previous.siteOriginMigrations??[]).some(value=>value.siteId===after.siteId))continue;
    const site=previous.sites.find(value=>value.id===after.siteId),external=previous.tasks.filter(task=>task.siteId===after.siteId&&hasExternalAttempt(task));
    if(!site&&allowImported)continue;
    if(hasBatch5IdentityLock(previous,after.siteId))throw Error(MIGRATION_BLOCKER_MESSAGES.batch5Identity);
    if(!site||JSON.stringify(siteSnapshot(site))!==JSON.stringify(after.before)||external.some(task=>task.channelId!=='telegraph')||external.length!==after.telegraphTasks.length||external.some(task=>!after.telegraphTasks.some(frozen=>frozen.taskId===task.id)))throw Error('网站来源迁移前置快照或外部历史不一致');
    if(after.recovery){const task=previous.tasks.find(value=>value.id===after.recovery!.taskId);if(!task||JSON.stringify(recoverySnapshot(task))!==JSON.stringify(after.recovery.before))throw Error('网站迁移恢复任务快照不一致')}
  }
  for(const before of previous.siteOriginMigrations??[]){
    const after=(next.siteOriginMigrations??[]).find(value=>value.siteId===before.siteId);
    if(!after||serializedWithoutConsumption(after)!==serializedWithoutConsumption(before))throw Error('网站来源迁移快照不能删除或改写');
    if(before.recovery?.consumedAt&&after.recovery?.consumedAt!==before.recovery.consumedAt)throw Error('网站迁移恢复许可的使用记录不能回退');
    if(!before.recovery?.consumedAt&&after.recovery?.consumedAt&&Date.parse(after.recovery.consumedAt)<Date.parse(after.recovery.grantedAt))throw Error('网站迁移恢复许可时间无效');
  }
}

export function applySiteOriginMigration(state:MigrationState,input:SiteOriginMigrationInput,now=new Date()):SiteOriginMigration{
  if(input.operatorAuthorized!==true)throw Error('网站来源迁移需要操作员明确授权');
  const stamp=now.toISOString();if(!exactDate(stamp))throw Error('网站来源迁移时间无效');
  const site=state.sites.find(value=>value.id===input.siteId);if(!site)throw Error('网站不存在');
  if((state.siteOriginMigrations??[]).some(value=>value.siteId===site.id))throw Error('该站点已经更换过一次域名');
  if(site.domain!==input.expectedDomain||site.url!==input.expectedUrl)throw Error('网站来源已改变，请重新核对后再迁移');
  const parsed=publicUrl(input.newUrl),guarded=normalizePublicUrl(parsed.href),next=normalizeDomain(guarded.href);
  if(guarded.protocol!=='https:'||guarded.pathname!=='/'||guarded.search||guarded.hash)throw Error('网站迁移目标必须是公开 HTTPS 根地址');
  if(next.domain===site.domain||next.url===site.url)throw Error('新旧网站来源相同');
  if(state.sites.some(value=>value.id!==site.id&&(value.domain===next.domain||value.url===next.url)))throw Error('新网站来源已被其他站点使用');
  const tasks=state.tasks.filter(task=>task.siteId===site.id),external=tasks.filter(hasExternalAttempt);
  if(hasBatch5IdentityLock(state,site.id))throw Error(MIGRATION_BLOCKER_MESSAGES.batch5Identity);
  if(external.some(task=>task.channelId!=='telegraph'))throw Error(MIGRATION_BLOCKER_MESSAGES.external);
  if(input.resumeStatus&&(site.status!=='paused'||input.resumeStatus!=='ready'))throw Error('只有已暂停站点可在迁移成功后恢复为就绪');
  const before=siteSnapshot(site),after:SiteOriginIdentity={...identity(site),domain:next.domain,url:next.url};
  let recovery:SiteOriginRecoveryGrant|undefined;
  if(input.recoveryTaskId){
    const task=tasks.find(value=>value.id===input.recoveryTaskId);
    if(!task||task.status!=='failed'||hasExternalAttempt(task)||!task.topicUrl||!mappedUrl(task.topicUrl,identity(before),after))throw Error('获准恢复的任务必须是原站未提交的失败任务');
    recovery={taskId:task.id,grantedAt:stamp,before:recoverySnapshot(task)};
  }
  const record:SiteOriginMigration={version:1,siteId:site.id,migratedAt:stamp,before,after,telegraphTasks:external.map(task=>({taskId:task.id,site:identity(before)})),...(recovery?{recovery}:{})};
  // Current content configuration follows the new origin; the before snapshot stays immutable.
  const mapCurrentUrl=(value:string)=>{
    const exact=mappedUrl(value,identity(before),after);if(exact)return exact;
    try{
      const parsed=publicUrl(value),oldOrigin=publicUrl(before.url);
      // The content editor accepts the same site's www alias. Do not widen task migration.
      if(parsed.hostname.replace(/^www\./,'')!==oldOrigin.hostname.replace(/^www\./,''))return value;
      const target=publicUrl(after.url);target.pathname=parsed.pathname;target.search=parsed.search;target.hash='';
      return target.href;
    }catch{return value}
  };
  if(site.linkTargets)site.linkTargets=site.linkTargets.map(mapCurrentUrl);
  if(site.topicOverrides)site.topicOverrides={
    added:site.topicOverrides.added.map(topic=>({...topic,url:mapCurrentUrl(topic.url)})),
    excluded:site.topicOverrides.excluded.map(mapCurrentUrl),
  };
  site.domain=next.domain;site.url=next.url;
  delete site.topics;delete site.topicsCheckedAt;delete site.topicsAttemptedAt;delete site.topicsError;delete site.searchReports;
  if(input.resumeStatus)site.status=input.resumeStatus;
  for(const task of tasks){
    const replacement=mappedUrl(task.topicUrl,identity(before),after);if(!replacement)continue;
    // Evidence taken from the old domain no longer matches the remapped topic; it is gathered again before the next draft.
    if(pristineFutureTask(task)){task.topicUrl=replacement;task.topicContentHash=undefined;task.evidenceSnapshot=undefined;task.factManifest=undefined;task.updatedAt=stamp;continue}
    if(task.id!==input.recoveryTaskId)continue;
    task.history=[...(task.history??[]),{at:stamp,status:task.status,message:task.message,linkCheck:task.linkCheck}].slice(-50);
    task.topicUrl=replacement;task.topicContentHash=undefined;task.evidenceSnapshot=undefined;task.factManifest=undefined;task.draft=undefined;task.draftUpdatedAt=undefined;task.articleReview=undefined;task.articleApprovedAt=undefined;
    task.status='failed';task.checkpoint='site_origin_migration_recovery';task.updatedAt=stamp;task.message='网站来源已迁移；原任务、稿件快照、累计成本、重试和换题记录均已保留，等待一次显式迁移恢复。';
  }
  state.siteOriginMigrations??=[];state.siteOriginMigrations.push(record);assertSiteOriginMigrationState(state);return record;
}

export function siteContextForTask(state:MigrationState,task:Task):Site|undefined{
  const current=state.sites.find(site=>site.id===task.siteId);if(!current)return;
  const record=(state.siteOriginMigrations??[]).find(value=>value.siteId===task.siteId),frozen=record?.telegraphTasks.find(value=>value.taskId===task.id);
  return frozen?{...current,...frozen.site}:current;
}

export function migrationAwareTopicKey(state:MigrationState,siteId:string,value:string|undefined):string|undefined{
  const canonical=canonicalPublicPageUrl(value);if(!canonical)return;
  const record=(state.siteOriginMigrations??[]).find(item=>item.siteId===siteId);if(!record)return canonical;
  try{const url=new URL(canonical),before=new URL(record.before.url),after=new URL(record.after.url);if(url.origin!==before.origin&&url.origin!==after.origin)return canonical;url.protocol=before.protocol;url.host=before.host;return canonicalPublicPageUrl(url.href)}catch{return canonical}
}

function exactRecoveryBinding(record:SiteOriginMigration,task:Task,status:'failed'|'queued'):boolean{
  const grant=record.recovery,expectedTopic=grant?mappedUrl(grant.before.topicUrl,identity(record.before),record.after):undefined;
  return !!grant&&grant.taskId===task.id&&task.siteId===record.siteId&&task.status===status&&!hasExternalAttempt(task)&&
    task.channelId===grant.before.channelId&&task.accountId===grant.before.accountId&&task.sourceDomain===grant.before.sourceDomain&&
    task.topicUrl===expectedTopic&&task.checkpoint==='site_origin_migration_recovery'&&task.attempts===grant.before.attempts&&
    (task.cost?.aiCalls??0)===(grant.before.cost?.aiCalls??0)&&task.topicSwitchAttempts===grant.before.topicSwitchAttempts&&
    task.draftRevision===grant.before.draftRevision&&task.articleRepairAttempts===grant.before.articleRepairAttempts&&
    JSON.stringify(task.articleAttempts??[])===JSON.stringify(grant.before.articleAttempts??[])&&!task.draft&&!task.articleReview&&!task.articleApprovedAt;
}

export function consumeSiteOriginRecoveryGrant(state:MigrationState,siteId:string,taskId:string,now=new Date()):void{
  const record=(state.siteOriginMigrations??[]).find(value=>value.siteId===siteId),grant=record?.recovery;
  if(!record||!grant||grant.taskId!==taskId||grant.consumedAt)throw Error('没有可用的网站迁移恢复许可');
  const task=state.tasks.find(value=>value.id===taskId);
  if(!task||!exactRecoveryBinding(record,task,'failed'))throw Error('任务上下文已改变，网站迁移恢复许可失效');
  grant.consumedAt=now.toISOString();
}

/** Use the operator's migration decision once, on the preserved task and budget. */
export function activateSiteOriginRecoveryGrant(state:MigrationState,siteId:string,taskId:string,now=new Date()):void{
  consumeSiteOriginRecoveryGrant(state,siteId,taskId,now);
  const task=state.tasks.find(value=>value.id===taskId)!;
  const stamp=now.toISOString();
  Object.assign(task,{status:'queued',scheduledAt:stamp,updatedAt:stamp,nextCheckAt:undefined,recoveryEligible:false,message:'已使用一次性网站迁移恢复许可；将在新来源的同路径重新取得正文，并沿用原任务的累计成本、重试和换题记录。'});
}

/** The scheduler may bypass the ordinary attempt ceiling only until it claims this task once. */
export function hasActiveSiteOriginRecoveryGrant(state:MigrationState,task:Task):boolean{
  const record=(state.siteOriginMigrations??[]).find(value=>value.siteId===task.siteId);
  return !!record?.recovery?.consumedAt&&exactRecoveryBinding(record,task,'queued');
}
