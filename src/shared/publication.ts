import {SCHEDULING_DEFAULTS} from './scheduling';
import {BATCH9B_MESSAGES} from './batch9b-messages';
import type {CapacityBlockReason,Channel,Site,SiteTopic,Task} from './types';
import {isArticleTopicUrl} from './topic-policy';
import {TASK_REASON_MESSAGES,taskCooldownUntil,type TaskReasonCode} from './task-reasons';
import {publicIdentitySlug} from '../integrations/public-identity';

const REPEATABLE_ARTICLE_CHANNELS=new Set(['telegraph','github-gist','blogger','wordpress-com','leaflet','raindrop','bluesky','paragraph','nostr','paper-wf','hive','mataroa','verbose','prose','rentry','lucid-page','betterthanhtml','supanote','docs-md','html-app','deed-page','markdrop','draftmark','memorywiki','plopino','wordcell','vibedrop','notebin','shippage','berrry','agenthow','agentsgather','agentswiki','yeetmd','markdownpage','slopit','rant','whitewind','hackmd','katbin','pastemyst','pstrs','nextgen-slides','yourwebs','thethings','brewpage']);
function deterministicPostSlug(taskId:string,contentHash:string,site?:Pick<Site,'name'|'domain'|'url'>):string{
  // Two-argument calls retain the historical formula for stored receipts.
  if(!site)return `lf-${taskId.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32)}-${contentHash.slice(0,12)}`;
  return publicIdentitySlug(site,`${taskId}\u0000${contentHash}`,40);
}
export function verbosePostSlug(taskId:string,contentHash:string,site?:Pick<Site,'name'|'domain'|'url'>):string{
  return deterministicPostSlug(taskId,contentHash,site);
}
export function rentryPostSlug(taskId:string,contentHash:string,site?:Pick<Site,'name'|'domain'|'url'>):string{
  return deterministicPostSlug(taskId,contentHash,site);
}
export const PUBLICATION_GAP_MS=SCHEDULING_DEFAULTS.samePlatformGapDays*86400000;
/** A preparation-only attempt may release its source after seven days; ambiguous writes never do. */
export function expiredBatch5Preparation(task:Task,now:Date):boolean{
  if(task.checkpoint!=='batch5_prepare_exhausted'||task.submittedAt||task.publicUrl||task.firstLiveAt||task.batch5||hasUnresolvedExternalAttempt(task))return false;
  const registration=task.batch5Registration;
  if(registration&&(['sending','request_unknown'].includes(registration.stage)||registration.stage==='reserved'&&registration.sendGuardVersion!==1))return false;
  const at=Date.parse(task.updatedAt);
  return Number.isFinite(at)&&now.getTime()-at>=7*86400000;
}
const TRACKING_PARAMETER=/^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid)$/i;

export interface PublicationCounts {
  currentPages:number;
  monthlyPages:number;
  currentSources:number;
  monthlySources:number;
}

export interface PublicationOpportunity {
  allowed:boolean;
  repeat:boolean;
  topicUrl?:string;
  scheduledAt?:string;
  blockingReason?:CapacityBlockReason;
  nextAvailableAt?:string;
  reason:string;
}

export interface PublicationOpportunityContext {
  /** The current site/channel binding has a usable official API credential. */
  officialApiConnected?:boolean;
  /** This channel can safely create a new site-owned official API identity before publishing. */
  officialApiProvisionable?:boolean;
  /** Optional site-history key used when one site keeps its id across an origin migration. */
  topicKey?:(value:string|undefined)=>string|undefined;
}

export function sourceKey(value:string):string{
  return value.trim().toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
}

/** Normalize a real public page URL without manufacturing a page for legacy records. */
export function canonicalPublicPageUrl(value:string|undefined):string|undefined{
  if(!value)return;
  try{
    const url=new URL(value.trim());
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
    url.protocol=url.protocol.toLowerCase();
    url.hostname=url.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
    if((url.protocol==='https:'&&url.port==='443')||(url.protocol==='http:'&&url.port==='80'))url.port='';
    url.hash='';
    for(const key of [...url.searchParams.keys()])if(TRACKING_PARAMETER.test(key))url.searchParams.delete(key);
    url.searchParams.sort();
    if(url.pathname.length>1)url.pathname=url.pathname.replace(/\/+$/,'');
    return url.href;
  }catch{return undefined}
}

/** Soft preference only: a locale-prefixed path outranks script inference, but never changes eligibility. */
export function articleTopicLanguageScore(topic:SiteTopic,language:string):number{
  let path='',first='';try{path=decodeURIComponent(new URL(topic.url).pathname);first=path.split('/').filter(Boolean)[0]?.toLowerCase()??''}catch{path=topic.url}
  const normalized=language.toLowerCase().replace(/_/g,'-'),root=normalized.split('-')[0];
  if(first&&first===normalized)return 4;
  if(first&&(first===root||first.startsWith(root+'-')))return 3;
  const sample=`${topic.title??''} ${path}`;
  if(root==='zh')return /[\u3400-\u9fff]/u.test(sample)?2:0;
  if(root==='ja')return /[\u3040-\u30ff]/u.test(sample)?2:0;
  if(root==='ko')return /[\uac00-\ud7af]/u.test(sample)?2:0;
  if(['ru','uk','bg'].includes(root))return /[\u0400-\u04ff]/u.test(sample)?2:0;
  return /[a-z]/i.test(sample)?1:0;
}

function validDate(value:string|undefined):Date|undefined{
  if(!value)return;
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date:undefined;
}

// Formatter construction is expensive in multi-site snapshots. Keep one zone, not dated results.
let calendarFormatter:{timeZone:string;format:Intl.DateTimeFormat}|undefined;
function dateParts(value:Date,timeZone:string):{year:number;month:number;day:number;hour:number;minute:number;second:number}{
  if(calendarFormatter?.timeZone!==timeZone)calendarFormatter={timeZone,format:new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})};
  const parts=calendarFormatter.format.formatToParts(value);
  const part=(kind:Intl.DateTimeFormatPartTypes)=>Number(parts.find(item=>item.type===kind)?.value??0);
  return {year:part('year'),month:part('month'),day:part('day'),hour:part('hour'),minute:part('minute'),second:part('second')};
}

function zonedTime(year:number,month:number,day:number,timeZone:string):Date{
  const wanted=Date.UTC(year,month-1,day,0,0,0);
  let guess=wanted;
  for(let index=0;index<3;index++){
    const observed=dateParts(new Date(guess),timeZone);
    const represented=Date.UTC(observed.year,observed.month-1,observed.day,observed.hour,observed.minute,observed.second);
    guess+=wanted-represented;
  }
  return new Date(guess);
}

export function nextNaturalMonthStart(now:Date,timeZone:string):Date{
  const {year,month}=dateParts(now,timeZone);
  return month===12?zonedTime(year+1,1,1,timeZone):zonedTime(year,month+1,1,timeZone);
}

function localMonthKey(value:Date|string,timeZone:string):string{
  const {year,month}=dateParts(new Date(value),timeZone);
  return `${year}-${String(month).padStart(2,'0')}`;
}

function isCountablePublication(task:Task):boolean{
  return task.checkpoint!=='existing_link'&&!!canonicalPublicPageUrl(task.publicUrl);
}

function isCurrentPublication(task:Task):boolean{
  return isCountablePublication(task)&&task.status==='live'&&task.health==='healthy'&&task.linkCheck==='found';
}

export function publicationCounts(siteId:string,tasks:Task[],now:Date,timeZone:string):PublicationCounts{
  const month=localMonthKey(now,timeZone),excluded=new Set<string>();
  for(const task of tasks){
    const page=task.siteId===siteId?canonicalPublicPageUrl(task.publicUrl):undefined;
    if(page&&task.checkpoint==='existing_link')excluded.add(page);
  }
  const pages=new Map<string,{earliest?:Date;monthlySource?:string;latestEvidence:number;currentSource?:string}>();
  for(const [index,task] of tasks.entries()){
    if(task.siteId!==siteId||task.temporaryPage)continue;
    const page=canonicalPublicPageUrl(task.publicUrl);
    if(!page||task.checkpoint==='existing_link'||excluded.has(page))continue;
    const source=sourceKey(task.sourceDomain);
    const record=pages.get(page)??{latestEvidence:Number.NEGATIVE_INFINITY};
    const firstLive=validDate(task.firstLiveAt);
    if(firstLive&&!task.recoveredAt&&(!record.earliest||firstLive.getTime()<record.earliest.getTime())){record.earliest=firstLive;record.monthlySource=source;}
    const evidence=validDate(task.lastCheckedAt)??validDate(task.verifiedAt)??validDate(task.updatedAt)??firstLive??validDate(task.createdAt);
    const evidenceOrder=evidence?.getTime()??Number.MIN_SAFE_INTEGER+index;
    if(evidenceOrder>=record.latestEvidence){record.latestEvidence=evidenceOrder;record.currentSource=isCurrentPublication(task)?source:undefined;}
    pages.set(page,record);
  }
  const current=[...pages.values()].filter(record=>record.currentSource),monthly=[...pages.values()].filter(record=>record.earliest&&localMonthKey(record.earliest,timeZone)===month);
  return {
    currentPages:current.length,
    monthlyPages:monthly.length,
    currentSources:new Set(current.map(record=>record.currentSource!)).size,
    monthlySources:new Set(monthly.map(record=>record.monthlySource!)).size,
  };
}

/** Public short posts are transparent distribution results, never labelled complete articles. */
export function publicationFormatCounts(siteId:string,tasks:Task[],now:Date,timeZone:string){
  const social=tasks.filter(task=>task.channelId==='bluesky'),other=tasks.filter(task=>task.channelId!=='bluesky');
  return {social:publicationCounts(siteId,social,now,timeZone),articlesAndProfiles:publicationCounts(siteId,other,now,timeZone)};
}

export function sourceMetrics(siteId:string,tasks:Task[],now:Date,timeZone:string):Pick<PublicationCounts,'currentSources'|'monthlySources'>{
  const {currentSources,monthlySources}=publicationCounts(siteId,tasks,now,timeZone);
  return {currentSources,monthlySources};
}

/** Failed/skipped work without submission evidence releases source capacity. */
export function taskOccupiesSource(task:Task):boolean{
  if(task.checkpoint==='existing_link')return true;
  return taskReservesTopic(task);
}

export function isRepeatableOfficialArticleChannel(channel:Channel):boolean{
  return channel.provenance==='built-in'&&channel.automation==='api'&&(channel.kind==='article'||channel.contentFormat==='social')&&channel.articleRequired===true&&REPEATABLE_ARTICLE_CHANNELS.has(channel.id);
}

function taskReservesTopic(task:Task):boolean{
  if(task.reasonCode==='referral_blocked'&&!task.firstLiveAt&&!hasUnresolvedExternalAttempt(task))return false;
  return !!(task.firstLiveAt||(hasUnresolvedExternalAttempt(task)&&!isPendingPublisherRegistration(task))||!['failed','skipped'].includes(task.status));
}

const REGISTRATION_ONLY_CHECKPOINTS=new Set([
  'account_registration_retry','account_registration_submitted','account_registration_human','email_code_pending','account_verified',
  'paper_account_create_pending','mataroa_account_create_pending','verbose_account_create_pending',
  'plopino_account_create_pending','wordcell_token_create_pending','vibedrop_key_create_pending','notebin_account_create_pending',
  'agenthow_register_pending','berrry_register_pending','berrry_signin_pending',
  'agentswiki_registration_intent','agentswiki_registration_opaque_response','agentswiki_registration_unknown',
  'agentnotepad_account_ready','agentriot_account_ready','colony_account_ready','large-language_account_ready',
  'openagentchat_account_ready','shellbook_account_ready','swarmmemo_identity_pending',
  'shippage_account_pending','shippage_account_conflict','brewpage_owner_token_pending','brewpage_owner_token_opaque','brewpage_owner_ready',
]);

const PREPUBLICATION_CHECKPOINTS=new Set(['carcinus_preflight_clear','raindrop_prepared','colony_intent','swarmmemo_intent','tantive_preview_intent']);

function registrationOnlyCheckpoint(value:string|undefined):boolean{
  return !!value&&(REGISTRATION_ONLY_CHECKPOINTS.has(value)||/(?:^|_)(?:account|registration)_(?:create_)?(?:intent|pending|ready|retry|submitting|submitted|unknown|opaque_response)$/.test(value));
}

function hasDefinitePublicationReceipt(task:Task):boolean{
  if(task.carcinus&&task.carcinus.stage!=='preflight')return true;
  if(task.brewPage&&!['owner_token_pending','owner_token_opaque','ready'].includes(task.brewPage.stage))return true;
  if(task.raindrop&&task.raindrop.stage!=='prepared')return true;
  if(task.tantive&&!['intent','preview_response'].includes(task.tantive.stage))return true;
  if(task.colony&&task.colony.stage!=='intent')return true;
  if(task.swarmMemo&&task.swarmMemo.stage!=='intent')return true;
  if(task.notebinJournal)return true;
  return !!(task.carcinusExisting||task.theThings||task.agentHow||task.agentNotepad||task.agentboard||task.agentdrop||task.agentriot||task.agentsGather||task.agentsWiki||task.berrry||task.betterthanhtml||task.blogger||task.bluesky||task.deedPage||task.docsMd||task.draftmark||task.hereNow||task.hive||task.htmlApp||task.katbin||task.largeLanguage||task.leaflet||task.listedStartups||task.lucid||task.markdownPaste||task.markdrop||task.mataroa||task.mdshare||task.mdview||task.memoryWiki||task.nextgenSlides||task.nostr||task.notebin||task.openAgentChat||task.paper||task.paragraph||task.pastemyst||task.pastyx||task.plopino||task.productIndex||task.prose||task.pstrs||task.rentry||task.shareYourHtml||task.shareYourHtmlReadback||task.shellbook||task.shipPage||task.shiply||task.slugPost||task.supanote||task.synthfolk||task.totpage||task.txtsbs||task.verbose||task.vibedrop||task.wordcell||task.wordpress||task.yourwebs);
}

/** Account creation may be remote, but it is not evidence that an article was sent. */
export function isPendingPublisherRegistration(task:Task):boolean{
  if(!registrationOnlyCheckpoint(task.checkpoint)||task.reasonCode==='submission_unknown'||task.publicUrl||task.firstLiveAt)return false;
  // A legacy submittedAt with no typed registration reason may describe an
  // article write. Only structured registration/timeout metadata can disambiguate it.
  if(task.submittedAt&&!task.reasonCode)return false;
  return !hasDefinitePublicationReceipt(task);
}

/** A durable pre-send phase, or a definitive 429, proves this intent was not accepted. */
export function safelyUnsentBatch5Task(task:Task):boolean{
  if(task.submittedAt||task.publicUrl||task.firstLiveAt)return false;
  if(task.batch5?.stage==='reserved')return true;
  const registration=task.batch5Registration;
  return !!registration&&(
    registration.stage==='not_sent'||registration.stage==='rate_limited'||
    registration.stage==='reserved'&&registration.sendGuardVersion===1
  );
}

function publicationCheckpoint(value:string|undefined):boolean{
  if(!value||registrationOnlyCheckpoint(value)||PREPUBLICATION_CHECKPOINTS.has(value)||value==='manual_submission')return false;
  return /(?:^|_)(?:submitting|submitted|submission_unknown|submission_uncertain|publish_uncertain|publish_unknown|create_uncertain|create_unknown|upload_unknown|finalize_unknown|opaque_response|api_receipt|published|draft_created|create_accepted|ui_receipt|owned|live_unmanaged)$/.test(value);
}

/**
 * Conservatively identify a real or possibly completed article write. Account
 * registration and local preflight metadata are intentionally kept separate.
 */
export function hasUnresolvedExternalAttempt(task:Task):boolean{
  if(task.reasonCode==='submission_unknown'||hasDefinitePublicationReceipt(task)||!!task.publicUrl||!!task.firstLiveAt)return true;
  if(isPendingPublisherRegistration(task))return false;
  const prepublication=PREPUBLICATION_CHECKPOINTS.has(task.checkpoint??'')||task.carcinus?.stage==='preflight'||task.raindrop?.stage==='prepared'||
    !!task.brewPage&&['owner_token_pending','owner_token_opaque','ready'].includes(task.brewPage.stage)||task.tantive?.stage==='intent'||task.tantive?.stage==='preview_response'||task.colony?.stage==='intent'||task.swarmMemo?.stage==='intent';
  return !!task.submittedAt&&!prepublication||publicationCheckpoint(task.checkpoint);
}

function hasRetainedEvidenceDraft(task:Task):boolean{
  return task.reasonCode==='evidence_truncated'&&!!task.draft&&!task.firstLiveAt&&!hasUnresolvedExternalAttempt(task);
}

function topicCandidates(site:Site,tasks:Task[],topicKey=canonicalPublicPageUrl):{known:boolean;available:string[];invalid:boolean;retained:boolean}{
  const known=Array.isArray(site.topics);
  if(!known)return {known:false,available:[],invalid:false,retained:false};
  const attempted=(task:Task)=>task.reasonCode==='evidence_truncated'&&!hasUnresolvedExternalAttempt(task)&&['failed','skipped','expired'].includes(task.status)?false:taskReservesTopic(task)||task.reasonCode==='referral_blocked'||(['failed','skipped','expired'].includes(task.status)&&!!(task.reasonCode||task.draft||task.articleReview));
  const used=new Set(tasks.filter(task=>task.siteId===site.id&&task.topicUrl&&attempted(task)).map(task=>topicKey(task.topicUrl)).filter((value):value is string=>!!value));
  for(const task of tasks.filter(task=>task.siteId===site.id))for(const attempt of task.articleAttempts??[]){const key=topicKey(attempt.topicUrl);if(key)used.add(key)}
  // A retained draft still owns its paid work. It is not a consumed topic, but
  // automatic planning must not start a fresh writer (on any channel) for it.
  const retainedDraftTopics=new Set(tasks.filter(task=>task.siteId===site.id&&hasRetainedEvidenceDraft(task))
    .map(task=>topicKey(task.topicUrl??task.writingEnvelope?.targetUrl??task.articleReview?.targetUrl??site.url)).filter((value):value is string=>!!value));
  let retained=false;
  const unique=new Map<string,{url:string;updated:number;index:number;language:number}>();
  let valid=0;
  for(const [index,topic] of (site.topics??[]).entries()){
    const canonical=canonicalPublicPageUrl(topic.url),key=topicKey(topic.url);
    const modified=validDate(topic.lastModified)?.getTime()??validDate(topic.discoveredAt)?.getTime()??0;
    if(canonical&&key&&isArticleTopicUrl(canonical,site)){valid++;if(retainedDraftTopics.has(key)){retained=true;continue}if(!used.has(key)&&!unique.has(key))unique.set(key,{url:canonical,updated:modified,index,language:articleTopicLanguageScore(topic,site.language)})}
  }
  return {known:true,available:[...unique.values()].sort((a,b)=>b.language-a.language||b.updated-a.updated||a.index-b.index).map(topic=>topic.url),invalid:(site.topics?.length??0)>0&&valid===0,retained};
}

function originalTaskCanRecover(task:Task):boolean{
  return task.recoveryEligible===true&&task.status==='failed'&&task.checkpoint==='system_wait'&&
    !!validDate(task.nextCheckAt)&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<SCHEDULING_DEFAULTS.articleAiLimit;
}

function structuredTerminalReason(task:Task):TaskReasonCode{
  if(task.reasonCode)return task.reasonCode;
  switch(task.articleReview?.reasonCode){
    case 'ai_daily_limit':return 'ai_daily_limit';
    case 'ai_task_limit':return 'ai_task_limit';
    case 'evidence_truncated':return 'evidence_truncated';
    case 'content_rejected':return 'content_rejected';
    case 'evidence_invalid':return 'evidence_insufficient';
    case 'input_too_long':return 'evidence_truncated';
    case 'format_invalid':return 'format_invalid';
    case 'invalid_topic':return 'invalid_topic';
    case 'ai_unavailable':case 'evidence_fetch_failed':return 'temporary_failure';
    case 'policy_unknown':case 'policy_not_found':return 'channel_ineligible';
  }
  if(task.checkpoint==='topic_recovery_budget')return 'ai_task_limit';
  if(task.checkpoint==='invalid_topic')return 'invalid_topic';
  if(task.checkpoint==='article_rejected')return 'content_rejected';
  return 'unknown';
}

function cooldownBlockReason(code:TaskReasonCode):CapacityBlockReason{
  if(code==='ai_task_limit')return 'budget_exhausted';
  if(code==='invalid_topic')return 'invalid_topic';
  if(code==='content_rejected'||code==='duplicate_content'||code==='evidence_insufficient'||code==='evidence_truncated'||code==='format_invalid')return 'article_rejected';
  return 'cooldown';
}

function terminalBlock(task:Task,now:Date):PublicationOpportunity|undefined{
  if(task.checkpoint==='existing_link'||task.firstLiveAt)return;
  if(hasUnresolvedExternalAttempt(task))return {allowed:false,repeat:false,blockingReason:'cooldown',reason:'已有提交记录或外链尚未确认；为避免重复发布，不会建立替代任务。'};
  if(!['failed','skipped'].includes(task.status))return;
  if(originalTaskCanRecover(task))return {allowed:false,repeat:false,blockingReason:'cooldown',nextAvailableAt:validDate(task.nextCheckAt)!.toISOString(),reason:'原任务还有一次恢复机会；到期只恢复原任务，不新建替代任务。'};
  const code=structuredTerminalReason(task);
  if(['ai_daily_limit','platform_rate_limited','temporary_failure','channel_disabled','channel_ineligible'].includes(code))return;
  if(code==='submission_unknown')return {allowed:false,repeat:false,blockingReason:'cooldown',reason:TASK_REASON_MESSAGES.submission_unknown};
  const until=validDate(task.cooldownUntil)??validDate(taskCooldownUntil(code,validDate(task.updatedAt)??validDate(task.createdAt)??now));
  if(!until||until.getTime()<=now.getTime())return;
  return {allowed:false,repeat:false,blockingReason:cooldownBlockReason(code),nextAvailableAt:until.toISOString(),reason:TASK_REASON_MESSAGES[code]};
}

function activeBlock(task:Task,now:Date):PublicationOpportunity|undefined{
  if(task.firstLiveAt||['failed','skipped','expired'].includes(task.status))return;
  if(task.reasonCode==='referral_blocked'&&!hasUnresolvedExternalAttempt(task))return;
  if(task.checkpoint==='account_handoff')return {allowed:false,repeat:false,blockingReason:'account_required',reason:'已有账号接续记录，不会重复建立同平台等待任务。'};
  const next=validDate(task.scheduledAt);
  const future=next&&next.getTime()>now.getTime()?next:undefined;
  return {allowed:false,repeat:false,blockingReason:future?'cadence_wait':'cooldown',...(future?{nextAvailableAt:future.toISOString()}:{}),reason:'\u540c\u4e00\u5e73\u53f0\u5df2\u6709\u4e00\u4e2a\u672a\u5b8c\u6210\u4efb\u52a1\uff0c\u5b8c\u6210\u6216\u660e\u786e\u7ec8\u6b62\u524d\u4e0d\u91cd\u590d\u5efa\u7acb\u3002'};
}

interface PublicationEvent {at:Date;page?:string}
function publicationEvents(tasks:Task[]):PublicationEvent[]{
  const pages=new Map<string,Date>(),unknown:PublicationEvent[]=[];
  for(const task of tasks){
    if(task.checkpoint==='existing_link')continue;
    const at=validDate(task.firstLiveAt);if(!at)continue;
    const page=canonicalPublicPageUrl(task.publicUrl);
    if(!page){unknown.push({at});continue}
    const previous=pages.get(page);if(!previous||at.getTime()<previous.getTime())pages.set(page,at);
  }
  const known=[...pages.entries()].map<PublicationEvent>(([page,at])=>({page,at}));
  return [...known,...unknown];
}

/** Successful publication dates, de-duplicated by real page URL at its first live time. */
export function publicationDates(tasks:Task[]):Date[]{
  return publicationEvents(tasks).map(event=>new Date(event.at));
}

/**
 * Decide whether one channel may receive a new task. Both automatic planning and
 * the explicit queue command must use this function so historical tasks have one policy.
 */
export function publicationOpportunity(site:Site,channel:Channel,tasks:Task[],now:Date,timeZone:string,context:PublicationOpportunityContext={}):PublicationOpportunity{
  if(!channel.enabled||channel.free==='paid'||channel.free==='unknown')return {allowed:false,repeat:false,blockingReason:'no_automatic_channel',reason:'该平台当前不符合免费发布条件。'};
  const related=tasks.filter(task=>task.siteId===site.id&&!expiredBatch5Preparation(task,now)),sameChannel=related.filter(task=>task.channelId===channel.id),sameSource=related.filter(task=>sourceKey(task.sourceDomain)===sourceKey(channel.domain));
  if(channel.id==='carcinus'&&tasks.some(task=>task.channelId==='carcinus'))return {allowed:false,repeat:false,blockingReason:'cooldown',reason:'Carcinus 只使用一个固定发布账号，对应一张固定公开页；保留原任务和原管理状态，不会建立第二个任务。'};
  if(channel.id==='carcinus'){
    const topics=topicCandidates(site,related,context.topicKey),topicUrl=topics.available[0];
    if(!topicUrl&&topics.retained)return {allowed:false,repeat:false,blockingReason:'article_rejected',reason:BATCH9B_MESSAGES.retainedEvidenceDraft};
    if(!topicUrl)return {allowed:false,repeat:false,blockingReason:topics.invalid?'invalid_topic':topics.known?'topics_exhausted':'topics_unknown',reason:topics.invalid?'已缓存的页面都不是可用的文章选题正文，未建立需要付费生成的任务。':topics.known?'没有尚未用于其他发布任务的真实主题页。':'尚未获得可去重的真实主题页，不建立文章发布任务。'};
    return {allowed:true,repeat:false,topicUrl,scheduledAt:now.toISOString(),reason:'Carcinus 仅为第一张固定公开页选择一个未使用的真实主题页；后续不再调度第二篇。'};
  }
  const repeatable=isRepeatableOfficialArticleChannel(channel),events=publicationEvents(sameChannel);
  const latestSuccess=events.map(event=>event.at.getTime()).sort((a,b)=>b-a)[0];
  const relevantSameChannel=sameChannel.filter(task=>{
    if(task.firstLiveAt||hasUnresolvedExternalAttempt(task)||!['failed','skipped'].includes(task.status)||latestSuccess===undefined)return true;
    const activity=validDate(task.submittedAt)??validDate(task.createdAt);
    return !!activity&&activity.getTime()>latestSuccess;
  });

  const terminalBlocks=relevantSameChannel.map(task=>terminalBlock(task,now)).filter((block):block is PublicationOpportunity=>!!block);
  const terminal=terminalBlocks.find(block=>block.blockingReason==='budget_exhausted')
    ??terminalBlocks.find(block=>!block.nextAvailableAt)
    ??terminalBlocks.sort((a,b)=>Date.parse(b.nextAvailableAt!)-Date.parse(a.nextAvailableAt!))[0];
  if(terminal)return {...terminal,repeat:false};
  for(const task of relevantSameChannel){const block=activeBlock(task,now);if(block)return {...block,repeat:false};}

  if(!repeatable){
    // These article channels have no independently selectable next topic. Keep
    // the existing paid draft as the work item instead of resetting its budget.
    if(channel.articleRequired&&related.some(hasRetainedEvidenceDraft))return {allowed:false,repeat:false,blockingReason:'article_rejected',reason:BATCH9B_MESSAGES.retainedEvidenceDraft};
    if(sameSource.some(task=>taskOccupiesSource(task)))return {allowed:false,repeat:false,reason:'\u8d44\u6599\u9875\u548c\u76ee\u5f55\u6765\u6e90\u53ea\u5efa\u7acb\u4e00\u6b21\uff0c\u8bf7\u7ee7\u7eed\u67e5\u770b\u539f\u8bb0\u5f55\u3002'};
    const released=sameSource.find(task=>['failed','skipped'].includes(task.status));
    if(released){const block=terminalBlock(released,now);if(block)return block;}
    return {allowed:true,repeat:false,scheduledAt:now.toISOString(),reason:'\u8be5\u6765\u6e90\u5c1a\u672a\u5efa\u7acb\u53ef\u6267\u884c\u8bb0\u5f55\u3002'};
  }

  const repeat=events.length>0||sameChannel.some(task=>taskOccupiesSource(task));
  if(repeat&&context.officialApiConnected!==true&&context.officialApiProvisionable!==true)return {allowed:false,repeat:true,blockingReason:'account_required',reason:'同平台再次发布只允许使用当前已连接的官方文章接口账号。'};
  const topics=topicCandidates(site,related,context.topicKey);
  let topicUrl:string|undefined;
  let topicBlock:PublicationOpportunity|undefined;
  if(topics.available.length)topicUrl=topics.available[0];
  else if(topics.retained)topicBlock={allowed:false,repeat,blockingReason:'article_rejected',reason:BATCH9B_MESSAGES.retainedEvidenceDraft};
  else topicBlock={allowed:false,repeat,blockingReason:topics.invalid?'invalid_topic':topics.known?'topics_exhausted':'topics_unknown',reason:topics.invalid?'已缓存的页面都不是可用的文章选题正文，未建立需要付费生成的任务。':topics.known?'\u6ca1\u6709\u5c1a\u672a\u7528\u4e8e\u5176\u4ed6\u53d1\u5e03\u4efb\u52a1\u7684\u771f\u5b9e\u4e3b\u9898\u9875\u3002':'\u5c1a\u672a\u83b7\u5f97\u53ef\u53bb\u91cd\u7684\u771f\u5b9e\u4e3b\u9898\u9875\uff0c\u4e0d\u5efa\u7acb\u6587\u7ae0\u53d1\u5e03\u4efb\u52a1\u3002'};

  if(topicBlock)return topicBlock;
  const lastEvent=events.map(event=>event.at).sort((a,b)=>b.getTime()-a.getTime())[0];
  const cadenceAt=lastEvent?new Date(lastEvent.getTime()+PUBLICATION_GAP_MS):now;
  const nextMonth=nextNaturalMonthStart(now,timeZone);
  const scheduledAt=new Date(Math.max(now.getTime(),cadenceAt.getTime()));
  if(scheduledAt.getTime()>=nextMonth.getTime())return {allowed:false,repeat:true,blockingReason:'cadence_wait',nextAvailableAt:scheduledAt.toISOString(),reason:'\u4e0b\u6b21\u7b26\u5408 30 \u5929\u95f4\u9694\u7684\u65f6\u95f4\u5df2\u8d85\u51fa\u672c\u81ea\u7136\u6708\uff0c\u672c\u6708\u4e0d\u518d\u5efa\u4efb\u52a1\u3002'};
  return {allowed:true,repeat,topicUrl,scheduledAt:scheduledAt.toISOString(),reason:repeat?'\u5df2\u4e3a\u4e0d\u540c\u771f\u5b9e\u4e3b\u9898\u9875\u9884\u7559\u5e73\u53f0\u53d1\u5e03\u95f4\u9694\u3002':'\u5e73\u53f0\u9996\u4e2a\u4efb\u52a1\u53ef\u7acb\u5373\u5f00\u59cb\u3002'};
}

const publicationCheckpoints=new Set(['submitting','submitted','submission_uncertain','carcinus_preflight_clear','carcinus_create_submitting','carcinus_create_unknown','carcinus_opaque_response','carcinus_api_receipt','carcinus_published','carcinus_live_unmanaged','raindrop_prepared','raindrop_submitting','raindrop_api_receipt','raindrop_published','telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published','wordpress_publish_submitting','wordpress_published','leaflet_create_submitting','leaflet_create_accepted','leaflet_published','paper_account_create_pending','paper_publish_submitting','paper_published','hive_publish_submitting','hive_published','mataroa_account_create_pending','mataroa_publish_submitting','mataroa_published','verbose_account_create_pending','verbose_publish_submitting','verbose_published','prose_publish_submitting','prose_published','rentry_publish_submitting','rentry_published','lucid_publish_submitting','lucid_published','betterthanhtml_publish_submitting','betterthanhtml_published','supanote_publish_submitting','supanote_api_receipt','supanote_published','docs_md_share_submitting','docs_md_api_receipt','docs_md_published','html_app_create_submitting','html_app_api_receipt','html_app_published','notebin_account_create_pending','notebin_note_create_submitting','notebin_note_opaque_response','notebin_note_api_receipt','notebin_note_owned']);
export function reservesSlot(t:Task,now:Date){
  if(t.firstLiveAt)return false;
  if(t.status==='review')return !(t.reviewUntil&&new Date(t.reviewUntil)<=now);
  if(t.status==='needs_input')return t.reasonCode==='manual_review'&&!!t.draft||!!t.submittedAt||!!t.publicUrl||publicationCheckpoints.has(t.checkpoint??'');
  return t.status==='queued'||t.status==='running';
}
/** A future-month reservation must not consume this month's target. Overdue queued work rolls into the current month under the same task id. */
export function reservesMonthlySlot(t:Task,now:Date,timeZone:string):boolean{
  if(t.temporaryPage||t.recoveredAt||!reservesSlot(t,now))return false;
  const value=t.submittedAt??t.scheduledAt,date=new Date(value);
  if(!Number.isFinite(date.getTime()))return false;
  if(t.status==='queued'&&date.getTime()<=now.getTime()&&localMonthKey(date,timeZone)!==localMonthKey(now,timeZone))return true;
  return localMonthKey(date,timeZone)===localMonthKey(now,timeZone);
}

/** A positively identified remote draft may resume the same post after review. */
export function hasBloggerDraftReceipt(task:Task):boolean{return task.channelId==='blogger'&&!!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&task.blogger?.stage==='draft'&&!!task.blogger.postId}

/** A confirmed remote draft can continue only under its original publication identity. */
export function hasRecoverablePublisherDraftReceipt(task:Task):boolean{
  return hasBloggerDraftReceipt(task)||task.channelId==='paragraph'&&!!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&task.paragraph?.stage==='draft'&&!!task.paragraph.postId;
}

export const remoteIntentCheckpoints=new Set([
  'account_registration_submitted','account_registration_human','email_code_pending','submitting','submitted','submission_uncertain',
  'telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published',
  'blogger_insert_submitting','blogger_draft_created','blogger_publish_submitting','blogger_published',
  'wordpress_publish_submitting','wordpress_published',
  'raindrop_prepared','raindrop_submitting','raindrop_api_receipt','raindrop_published',
  'leaflet_create_submitting','leaflet_create_accepted','leaflet_published',
  'bluesky_create_submitting','bluesky_create_accepted','bluesky_published',
  'paragraph_insert_submitting','paragraph_draft_created','paragraph_publish_submitting','paragraph_published','nostr_publish_submitting','nostr_published',
  'paper_account_create_pending','paper_publish_submitting','paper_published','hive_publish_submitting','hive_published',
  'mataroa_account_create_pending','mataroa_publish_submitting','mataroa_published',
  'verbose_account_create_pending','verbose_publish_submitting','verbose_published',
  'prose_publish_submitting','prose_published',
  'rentry_publish_submitting','rentry_published','lucid_publish_submitting','lucid_published','betterthanhtml_publish_submitting','betterthanhtml_published',
  'supanote_publish_submitting','supanote_api_receipt','supanote_published',
  'docs_md_share_submitting','docs_md_api_receipt','mdshare_create_submitting','mdshare_opaque_response','mdshare_api_receipt','mdshare_published','katbin_create_submitting','katbin_opaque_response','katbin_api_receipt','pstrs_create_submitting','pstrs_opaque_response','pstrs_partial_response','pstrs_api_receipt','pstrs_published','agentdrop_create_submitting','agentdrop_opaque_response','agentdrop_api_receipt','agentdrop_published','totpage_create_submitting','totpage_opaque_response','totpage_api_receipt','totpage_published','mdview_create_submitting','mdview_opaque_response','mdview_api_receipt','mdview_published','txtsbs_create_submitting','txtsbs_opaque_response','txtsbs_api_receipt','txtsbs_published','pastyx_create_submitting','pastyx_opaque_response','pastyx_api_receipt','pastyx_published','nextgenSlides_create_submitting','nextgenSlides_opaque_response','nextgenSlides_api_receipt','nextgenSlides_published','yourwebs_create_submitting','yourwebs_opaque_response','yourwebs_api_receipt','yourwebs_published','yourwebs_expired','shippage_create_submitting','shippage_opaque_response','shippage_api_receipt','shippage_published','pastemyst_create_submitting','pastemyst_opaque_response','pastemyst_api_receipt','markdownpaste_create_submitting','markdownpaste_opaque_response','markdownpaste_api_receipt','slugpost_create_submitting','slugpost_opaque_response','slugpost_ui_receipt','slugpost_published','docs_md_published',
  'memorywiki_create_submitting','memorywiki_opaque_response','memorywiki_api_receipt','memorywiki_published',
  'deed_page_create_submitting','deed_page_opaque_response','deed_page_api_receipt','deed_page_published',
  'brewpage_owner_token_pending','brewpage_owner_token_opaque','brewpage_owner_ready','brewpage_create_submitting','brewpage_opaque_response','brewpage_api_receipt','brewpage_published',
  'here_now_create_unknown','here_now_opaque_response','here_now_api_receipt','here_now_finalize_unknown','here_now_published',
  'shiply_submitting','shiply_create_unknown','shiply_opaque_response','shiply_staged','shiply_upload_unknown','shiply_uploaded','shiply_finalize_unknown','shiply_api_receipt','shiply_published',
  'carcinus_preflight_clear','carcinus_create_submitting','carcinus_create_unknown','carcinus_opaque_response','carcinus_api_receipt','carcinus_published','carcinus_live_unmanaged',
  'plopino_account_create_pending','plopino_upload_submitting','plopino_opaque_response','plopino_api_receipt','plopino_published',
  'notebin_account_create_pending','notebin_note_create_submitting','notebin_note_opaque_response','notebin_note_api_receipt','notebin_note_owned',
  'openagentchat_page_submitting','openagentchat_page_opaque_response','openagentchat_page_api_receipt','openagentchat_published',
  'shellbook_post_submitting','shellbook_post_opaque_response','shellbook_post_api_receipt','shellbook_published',
  'agentriot_update_submitting','agentriot_update_opaque_response','agentriot_update_api_receipt','agentriot_published',
  'agentnotepad_publish_submitting','agentnotepad_publish_opaque_response','agentnotepad_publish_api_receipt','agentnotepad_published',
  'colony_intent','colony_submitting','colony_opaque_response','colony_api_receipt','colony_published',
  'agenthow_register_pending','agenthow_note_submitting','agenthow_note_opaque_response','agenthow_note_api_receipt','agenthow_published',
  'agentswiki_registration_intent','agentswiki_registration_opaque_response','agentswiki_registration_unknown','agentswiki_article_submitting','agentswiki_article_opaque_response','agentswiki_article_api_receipt','agentswiki_published',
  'agentsgather_submitting','agentsgather_opaque_response','agentsgather_api_receipt','agentsgather_published',
  'berrry_register_pending','berrry_signin_pending','berrry_app_submitting','berrry_app_opaque_response','berrry_app_api_receipt','berrry_published',
  'large-language_submitting','large-language_opaque_response','large-language_api_receipt','large-language_published',
  'swarmmemo_identity_pending','swarmmemo_intent','swarmmemo_submitting','swarmmemo_opaque_response','swarmmemo_api_receipt','swarmmemo_published',
  'thethings_submitting','thethings_opaque_response','thethings_api_receipt','thethings_published',
  'synthfolk_registration_submitting','synthfolk_registration_opaque_response','synthfolk_profile_api_receipt','synthfolk_profile_published','synthfolk_registration_unmanaged',
  'agentboard_submitting','agentboard_opaque_response','agentboard_api_receipt','agentboard_published',
]);

/** Anything that may already exist on the platform: a submission, a receipt or a registration in flight. */
export function hasRemotePublicationIntent(task:Task):boolean{
  if(task.channelId==='plopino'&&task.checkpoint==='plopino_account_create_pending'&&!task.submittedAt&&!task.plopino)return false;
  if(task.channelId==='notebin'&&task.checkpoint==='notebin_account_create_pending'&&!task.submittedAt&&!task.notebin&&!task.notebinJournal)return false;
  return !!(task.submittedAt||task.publicUrl||task.firstLiveAt||task.agentsGather||task.agentboard||task.agentsWiki||task.synthfolk||task.carcinus||task.theThings||task.swarmMemo||task.berrry||task.agentHow||task.openAgentChat||task.agentriot||task.shellbook||task.agentNotepad||task.colony||task.largeLanguage||task.brewPage||task.notebin||task.notebinJournal||task.plopino||task.blogger||task.leaflet||task.wordpress||task.raindrop||task.bluesky||task.paragraph||task.nostr||task.paper||task.hive||task.mataroa||task.verbose||task.prose||task.rentry||task.lucid||task.betterthanhtml||task.supanote||task.docsMd||task.katbin||task.mdshare||task.pstrs||task.nextgenSlides||task.pstrs||task.yourwebs||task.pstrs||task.totpage||task.mdview||task.txtsbs||task.pastyx||task.pstrs||task.agentdrop||task.listedStartups||task.productIndex||task.shipPage||task.pastemyst||task.markdownPaste||task.slugPost||task.deedPage||task.markdrop||task.draftmark||task.memoryWiki||task.hereNow||task.shiply||task.shareYourHtml||remoteIntentCheckpoints.has(task.checkpoint??''));
}
