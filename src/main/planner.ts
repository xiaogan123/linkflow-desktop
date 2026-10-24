import {normalizeChannelLinkRel} from '../shared/channel-rel';
import {hasPendingManualReview} from '../shared/batch9b-policy';
import {nextLinkCheck} from './link-maintenance';
import {MAINTENANCE_MESSAGES} from '../shared/maintenance-messages';
import {channelIsTrial,claimChannelTrial,trialTaskAvailable} from './channel-trials';
import {SCHEDULING_DEFAULTS,SCHEDULING_MESSAGES,addScheduleDays,deferredReservation,findDeferredReservation,eligiblePlatforms,monthlyCapacity,nextPublishGap,planMonthlyReservations,platformDailyLimit,publicationGate,randomScheduleOnDay,samePlatformGapDays,scheduleOnPreferredHour,schedulingDay,selectWeightedPlatform,siteMonthTarget,type ScheduleEvent,type SchedulePlatform} from '../shared/scheduling';
export {estimateDailyAiLimit} from '../shared/scheduling';
import {isArticleTopicUrl} from '../shared/topic-policy';
import {canonicalPublicPageUrl,isRepeatableOfficialArticleChannel} from '../shared/publication';
import {taskTransition} from './task-state';
import {unusedSources} from '../shared/source-capacity';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {expiredBatch5Preparation,hasRecoverablePublisherDraftReceipt,hasUnresolvedExternalAttempt,isPendingPublisherRegistration,publicationCounts,publicationDates,publicationOpportunity,safelyUnsentBatch5Task,sourceKey,reservesSlot,reservesMonthlySlot,taskOccupiesSource} from '../shared/publication';
import { randomUUID } from 'node:crypto';
import type { CapacityBlockReason,Channel, Site, SiteCapacity, Task, LinkResult } from '../shared/types';
import type { State } from './store';
import {accountForSiteChannel,boundAccount,channelExecutionReadiness} from './account-bindings';
import {eligibilityFor} from '../integrations/eligibility';
import {hasActiveSiteOriginRecoveryGrant,migrationAwareTopicKey} from './site-origin-migration';
import {countFinanceAutomaticPlatforms} from '../shared/channel-metrics';
import type {FinancePlatformCount} from '../shared/types';
import {htmlAppPublicNoticeAccepted} from '../shared/html-app-notice';
import {matchChannels} from '../integrations/catalog';
import {SCHEDULING_NEW_MESSAGES} from '../shared/scheduling-messages';
import {activeFailedPlatformIds} from './temporary-retry';

const originTopicContext=(state:State,siteId:string)=>({topicKey:(value:string|undefined)=>migrationAwareTopicKey(state,siteId,value)});
const officialApiContext=(channelId:string,readiness:ReturnType<typeof channelExecutionReadiness>)=>({officialApiConnected:readiness.kind==='ready',officialApiProvisionable:readiness.kind==='autocreate'&&['telegraph','nostr','rant','slopit'].includes(channelId)});

// Keep only the current zone's formatter; dates and scheduling results are never cached.
let dayFormatter:{timeZone:string;format:Intl.DateTimeFormat}|undefined;
export function dateKey(value:Date|string,timeZone:string):string{
  if(dayFormatter?.timeZone!==timeZone)dayFormatter={timeZone,format:new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})};
  const p=dayFormatter.format.formatToParts(new Date(value));
  const part=(t:string)=>p.find(x=>x.type===t)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
export function monthKey(value:Date|string,timeZone:string){return dateKey(value,timeZone).slice(0,7)}
export function liveThisMonth(siteId:string,tasks:Task[],now:Date,timeZone:string):number{
  return publicationCounts(siteId,tasks,now,timeZone).monthlyPages;
}
export function currentLive(siteId:string,tasks:Task[]):number{return publicationCounts(siteId,tasks,new Date(),'UTC').currentPages}
export {reservesSlot,reservesMonthlySlot} from '../shared/publication';
export function recoverInterrupted(state:State,now=new Date()){
  for(const t of state.tasks){
    if(state.sites.find(site=>site.id===t.siteId)?.status==='paused')continue;
    // A recorded HTTP rejection is a final result even when the request journal
    // retains submittedAt. Reopening the app must not turn it into uncertainty.
    if(t.status==='failed'&&t.checkpoint==='batch5_rejected'&&['platform_rejected','platform_rate_limited','format_invalid','account_handoff'].includes(t.reasonCode??''))continue;
    const safeRetry=safelyUnsentBatch5Task(t),external=!safeRetry&&hasUnresolvedExternalAttempt(t),registration=isPendingPublisherRegistration(t);
    const registrationUnknown=!!t.batch5Registration&&(
      ['sending','request_unknown'].includes(t.batch5Registration.stage)||
      t.batch5Registration.stage==='reserved'&&t.batch5Registration.sendGuardVersion!==1);
    const uncertain=registrationUnknown||!safeRetry&&(t.reasonCode==='submission_unknown'||!!t.submittedAt||!!t.agentsGather||!!t.synthfolk||!!t.leaflet||!!t.wordpress||!!t.paper||!!t.hive||!!t.mataroa||!!t.verbose||!!t.prose||!!t.rentry||!!t.lucid||!!t.betterthanhtml||!!t.supanote||!!t.docsMd||!!t.deedPage||!!t.memoryWiki||!!t.shipPage||!!t.nostr||['submitting','submitted','submission_uncertain','paper_account_create_pending','mataroa_account_create_pending','verbose_account_create_pending'].includes(t.checkpoint||''));
    const migrationRecovery=(state.siteOriginMigrations??[]).find(record=>record.siteId===t.siteId)?.recovery;
    if(t.status==='running'&&!uncertain&&migrationRecovery?.consumedAt&&migrationRecovery.taskId===t.id&&t.attempts>migrationRecovery.before.attempts){
      Object.assign(t,taskTransition(t,{status:'failed',reasonCode:'unknown',checkpoint:'site_origin_migration_recovery_consumed'},now));t.updatedAt=now.toISOString();t.recoveryEligible=false;t.nextCheckAt=undefined;
      t.message='一次性网站迁移恢复已领取但在完成前中断；累计记录保留，不会再次自动恢复或重置重试次数。';continue;
    }
    const paidAiUncertain=t.status==='running'&&!uncertain&&((['article_review','article_repair_review'].includes(t.checkpoint??'')&&t.articleReview?.status==='running')||(!t.draft&&(t.cost?.aiCalls??0)>0));
    if(paidAiUncertain){
      const eligible=(t.cost?.aiCalls??0)<SCHEDULING_DEFAULTS.articleAiLimit&&(t.recoveryAttempts??0)<1;
      Object.assign(t,taskTransition(t,{status:'failed',reasonCode:eligible?'temporary_failure':'ai_task_limit',checkpoint:'system_wait'},now));t.updatedAt=now.toISOString();t.recoveryEligible=eligible;
      t.nextCheckAt=eligible?new Date(now.getTime()+24*3600000).toISOString():undefined;
      if(t.articleReview?.status==='running')t.articleReview={...t.articleReview,status:'failed',reasonCode:'ai_unavailable',reviewedAt:now.toISOString(),reason:'AI 调用在结果完整保存前中断；只允许原任务在剩余次数内恢复一次。'};
      t.message=eligible?'上次 AI 工作在结果保存前中断；未发布，不会新建任务或重复付费，明天仅恢复原任务一次且沿用已使用的 AI 次数。':'上次 AI 工作在结果保存前中断；未发布，任务的 AI 次数或恢复次数已用完。';continue;
    }
    if(t.status==='running'||(uncertain&&['queued','failed'].includes(t.status))){
      const wasRunning=t.status==='running';Object.assign(t,taskTransition(t,{status:uncertain?'needs_input':'queued',reasonCode:registrationUnknown||external?'submission_unknown':registration?'account_handoff':undefined,checkpoint:registrationUnknown?'batch5_account_pending':t.checkpoint},now));
      if(wasRunning&&!uncertain&&t.checkpoint!=='article_repair_review')t.attempts=Math.max(0,t.attempts-1);
      t.updatedAt=now.toISOString();t.message=registrationUnknown?SCHEDULING_NEW_MESSAGES.registrationUnknown:t.status==='needs_input'?'上次提交中断，请先检查平台结果，确认后继续。':'已恢复上次未完成的任务。';
    }
  }
}
function history(task:Task,at:string){task.history??=[];const last=task.history.at(-1);if(last?.status===task.status&&last.message===task.message&&last.linkCheck===task.linkCheck)return;task.history.push({at,status:task.status,message:task.message,linkCheck:task.linkCheck});task.history=task.history.slice(-50)}
export function expireReviews(state:State,now:Date){const paused=new Set(state.sites.filter(site=>site.status==='paused').map(site=>site.id));for(const t of state.tasks){if(paused.has(t.siteId))continue;if(t.status==='review'&&t.reviewUntil&&new Date(t.reviewUntil)<=now){t.status='expired';t.health=t.firstLiveAt?(t.linkCheck==='absent'?'missing':'unknown'):'unknown';t.message='审核期限已到，尚未确认公开外链；已释放本月名额，并保留记录供低频复查。';t.nextCheckAt=new Date(now.getTime()+7*86400000).toISOString();t.updatedAt=now.toISOString();history(t,t.updatedAt);}}}
export type Match={channel:Channel;score:number;reason:string};
const CROSS_PLATFORM_GAP_MS=SCHEDULING_DEFAULTS.minSiteGapDays*86400000;
function unfinishedBatch5Preparation(task:Task,maxAttempts:number):boolean{
  if(!['rant','slopit'].includes(task.channelId)||task.prepareAttempts===undefined||task.prepareAttempts>=Math.min(3,maxAttempts)||task.submittedAt||task.publicUrl||task.firstLiveAt||task.batch5)return false;
  const registration=task.batch5Registration;
  return !registration||registration.stage==='registered'||safelyUnsentBatch5Task(task);
}
export function continuesPendingRegistration(state:State,task:Task,channel:Channel,now=new Date()):boolean{
  if(task.checkpoint!=='account_registration_submitted'||task.submittedAt||channel.automation!=='browser'||!channel.emailRequired||!task.accountId)return false;
  const account=boundAccount(state,task);
  if(!account||account.id!==task.accountId||!account.hasPassword||account.credentialKind==='api_token'||['restricted','credentials_invalid'].includes(account.status))return false;
  if(task.waitingDeadlineAt&&Date.parse(task.waitingDeadlineAt)<=now.getTime())return false;
  const started=Date.parse(account.lastUsedAt??account.createdAt??task.createdAt);
  return Number.isFinite(started)&&now.getTime()-started<48*3600000;
}

type RankedMatch={match:Match;index:number;readiness:ReturnType<typeof channelExecutionReadiness>;usedThisMonth:boolean;lastUsed:number;otherSitesThisMonth:number};
export interface CapacitySnapshotIndex {tasksBySite:ReadonlyMap<string,Task[]>;sourceSites:ReadonlyMap<string,ReadonlySet<string>>}
/** Precomputed from the same scheduler state for read-only snapshot capacity views. */
export function capacitySnapshotIndex(state:State,now:Date,timeZone:string):CapacitySnapshotIndex{
  const tasksBySite=new Map<string,Task[]>(),sourceSites=new Map<string,Set<string>>(),month=monthKey(now,timeZone);
  for(const task of state.tasks){
    const related=tasksBySite.get(task.siteId)??[];related.push(task);tasksBySite.set(task.siteId,related);
    if(task.checkpoint==='existing_link'||task.recoveredAt||(!reservesMonthlySlot(task,now,timeZone)&&!publicationDates([task]).some(date=>monthKey(date,timeZone)===month)))continue;
    const source=sourceKey(task.sourceDomain),sites=sourceSites.get(source)??new Set<string>();sites.add(task.siteId);sourceSites.set(source,sites);
  }
  return {tasksBySite,sourceSites};
}
function rankedMatches(state:State,site:Site,matches:Match[],_tasks:Task[],_now:Date,_timeZone:string,_sourceSites?:ReadonlyMap<string,ReadonlySet<string>>):RankedMatch[]{
  // A capacity view needs readiness only; random platform choice belongs to execution.
  return matches.map((match,index)=>({match,index,readiness:channelExecutionReadiness(state,site.id,match.channel),usedThisMonth:false,lastUsed:0,otherSitesThisMonth:0}));
}

export interface PublicationTimingOptions {excludeTaskId?:string;includeReservations?:boolean}
/**
 * Earliest policy-compliant publication time. Planning includes existing reservations;
 * execution validation can ignore them and use only fixed successful/submitted evidence.
 */
export function earliestPublicationAt(siteId:string,channelId:string,tasks:Task[],requestedAt:Date,options:PublicationTimingOptions={}):Date{
  const related=tasks.filter(task=>task.siteId===siteId&&task.id!==options.excludeTaskId&&task.checkpoint!=='existing_link');
  const globalAnchors=publicationDates(related).map(date=>date.getTime());
  const samePlatformAnchors=publicationDates(related.filter(task=>task.channelId===channelId)).map(date=>date.toISOString());
  for(const task of related){
    const submitted=Date.parse(task.submittedAt??'');
    if(Number.isFinite(submitted)){globalAnchors.push(submitted);if(task.channelId===channelId)samePlatformAnchors.push(new Date(submitted).toISOString())}
  }
  const crossAt=globalAnchors.length?Math.max(...globalAnchors)+CROSS_PLATFORM_GAP_MS:Number.NEGATIVE_INFINITY;
  const platformAt=samePlatformAnchors.length?Math.max(...samePlatformAnchors.map(at=>Date.parse(at)+samePlatformGapDays(siteId,channelId,at)*86400000)):Number.NEGATIVE_INFINITY;
  let candidate=Math.max(requestedAt.getTime(),crossAt,platformAt);
  if(options.includeReservations!==false){
    const reservations=related.filter(task=>!task.submittedAt&&!task.firstLiveAt&&reservesSlot(task,requestedAt)).map(task=>({at:Date.parse(task.scheduledAt),gap:task.channelId===channelId?samePlatformGapDays(siteId,channelId,task.scheduledAt)*86400000:CROSS_PLATFORM_GAP_MS})).filter(item=>Number.isFinite(item.at)).sort((a,b)=>a.at-b.at);
    for(const reservation of reservations){
      if(candidate>=reservation.at-reservation.gap&&candidate<reservation.at+reservation.gap)candidate=reservation.at+reservation.gap;
    }
  }
  return new Date(candidate);
}

function sharedDestinationKey(state:State,siteId:string,channelId:string,accountId?:string,receipt?:Task):string|undefined{
  // Beacon's reusable API key is an administrative owner credential, not one
  // public author/destination shared by every bound site. Each task creates its
  // own deterministic tenant page; use the site namespace for scheduler
  // ownership while the ordinary platform/day and same-site cadence gates stay
  // in eligiblePlatforms.
  if(channelId==='beacon')return `beacon:site:${siteId}`;
  if(channelId==='gitbook')return `gitbook:site:${siteId}`;
  if(channelId==='valtown')return `valtown:site:${siteId}`;
  if(channelId==='bitbucket'){const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId==='bitbucket')?.accountId,workspace=state.accounts.find(item=>item.id===id)?.bitbucket?.workspaceSlug;return workspace?`bitbucket:workspace:${workspace}`:'bitbucket:pending-workspace'}
if(channelId==='rentry'||channelId==='lucid-page'||channelId==='betterthanhtml'||channelId==='supanote'||channelId==='docs-md'||channelId==='katbin'||channelId==='mdshare'||channelId==='pstrs'||channelId==='yourwebs'||channelId==='nextgen-slides'||channelId==='totpage'||channelId==='mdview'||channelId==='txtsbs'||channelId==='pastyx'||channelId==='agentdrop'||channelId==='pastemyst'||channelId==='markdownpaste'||channelId==='slugpost'||channelId==='html-app'||channelId==='memorywiki')return `${channelId}:workspace`;
  if(channelId==='agentboard'){
    const accounts=state.accounts.filter(item=>item.channelId==='agentboard');
    const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId)?.accountId??(accounts.length===1?accounts[0].id:undefined);
    return id?`agentboard:${id}`:'agentboard:pending-profile';
  }
  if(channelId==='blogger'){const blogId=receipt?.blogger?.blogId??state.sites.find(item=>item.id===siteId)?.blogger?.blogId;return blogId?`blogger:${blogId}`:undefined;}
  if(channelId==='wordpress-com'){
    const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId)?.accountId;
    const blogId=receipt?.wordpress?.blogId??state.accounts.find(item=>item.id===id&&item.channelId===channelId)?.username;
    return blogId?`wordpress-com:${blogId}`:undefined;
  }
  if(channelId==='leaflet'){
    const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId)?.accountId;
    const account=state.accounts.find(item=>item.id===id&&item.channelId===channelId),match=account?.publicationUrl?.match(/^https:\/\/leaflet\.pub\/p\/(did:(?:plc|web):[A-Za-z0-9:._%-]{1,240})$/);
    const did=receipt?.leaflet?.did??match?.[1];
    return did?`leaflet:${did}`:undefined;
  }
  if(channelId==='raindrop'){
    const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId)?.accountId;
    const binding=state.accounts.find(item=>item.id===id&&item.channelId===channelId)?.raindrop,ownerId=receipt?.raindrop?.ownerId??binding?.ownerId,collectionId=receipt?.raindrop?.collectionId??binding?.collectionId;
    return ownerId&&collectionId?`raindrop:${ownerId}:${collectionId}`:undefined;
  }
  if(channelId==='paragraph'){const publicationId=receipt?.paragraph?.publicationId??state.sites.find(item=>item.id===siteId)?.paragraph?.publicationId;return publicationId?`paragraph:${publicationId}`:undefined;}
  if(channelId==='nostr'){const pubkey=receipt?.nostr?.pubkey??accountForSiteChannel(state,siteId,channelId,accountId)?.username;return pubkey?`nostr:${pubkey}`:undefined;}
  if(['paper-wf','hive','mataroa','verbose','prose'].includes(channelId)){
    const username=channelId==='paper-wf'?receipt?.paper?.username:channelId==='hive'?receipt?.hive?.author:channelId==='mataroa'?receipt?.mataroa?.username:channelId==='verbose'?receipt?.verbose?.username:receipt?.prose?.username;
    const identity=username??accountForSiteChannel(state,siteId,channelId,accountId)?.username;
    return identity?`${channelId}:${identity.trim().toLowerCase()}`:undefined;
  }
  if(channelId!=='bluesky')return;
  const id=accountId??state.accountBindings.find(item=>item.siteId===siteId&&item.channelId===channelId)?.accountId;
  const did=receipt?.bluesky?.did??state.accounts.find(item=>item.id===id&&item.channelId===channelId)?.username;
  return did?`bluesky:${did}`:undefined;
}

/** Calendar-day platform and identity limits apply to every channel. */
export function socialPublicationAt(state:State,siteId:string,channelId:string,requestedAt:Date,options:PublicationTimingOptions={}):Date{
  const timeZone=state.sites.find(site=>site.id===siteId)?.timezone??state.settings.timezone;
  const current=options.excludeTaskId?state.tasks.find(task=>task.id===options.excludeTaskId):undefined;
  const identity=publicIdentityFor(state,siteId,channelId,current?.accountId,current);
  const events=scheduleEvents(state.tasks.filter(task=>task.id!==options.excludeTaskId&&(options.includeReservations!==false||!!task.firstLiveAt||!!task.submittedAt||!!task.scheduling?.attemptedAt)),state);
  let candidate=new Date(requestedAt);
  for(let offset=0;offset<SCHEDULING_DEFAULTS.maxLookaheadDays;offset++){
    const day=schedulingDay(candidate,timeZone),sameDay=events.filter(event=>event.channelId===channelId&&(!event.failed||event.attempted)&&schedulingDay(event.at,timeZone)===day);
    if(new Set(sameDay.map(event=>event.siteId)).size<platformDailyLimit(channelId)&&!sameDay.some(event=>event.identity===identity))return candidate;
    const nextDay=addScheduleDays(day,1);
    candidate=timeZone===state.settings.timezone?scheduleOnPreferredHour(nextDay,timeZone,state.settings.onlineHours):randomScheduleOnDay(nextDay,timeZone);
  }
  return candidate;
}

export function scheduleEvents(tasks:Task[],state?:State):ScheduleEvent[]{
  return tasks.filter(task=>task.checkpoint!=='existing_link').map(task=>{
    const registration=isPendingPublisherRegistration(task),unresolved=hasUnresolvedExternalAttempt(task);
    return {id:task.id,siteId:task.siteId,supplementary:task.temporaryPage||!!task.recoveredAt,recovered:!!task.recoveredAt,
      at:task.scheduling?.attemptedAt??(registration?undefined:task.submittedAt)??task.firstLiveAt??task.scheduledAt,
      channelId:task.channelId||undefined,identity:state&&task.channelId?taskPublicIdentity(state,task):task.scheduling?.publicIdentity,
      success:!!task.firstLiveAt,retained:task.firstLiveAt?!task.lostAt&&task.linkCheck!=='absent'&&task.health!=='missing':undefined,
      failed:!unresolved&&(['failed','skipped','expired'].includes(task.status)||task.reasonCode==='platform_rejected'),
      submitted:!registration&&(!!task.submittedAt||unresolved&&!task.firstLiveAt),attempted:!!task.scheduling?.attemptedAt};
  });
}

/**
 * How often a platform's pages actually reach Google, from spot checks of published pages (2026-10-20):
 * Telegraph 0 of 3 indexed after up to 23 days, among heavy spam; lucid.page 2 of 2 indexed within 4 days, listed in its sitemap.
 * Unmeasured platforms stay neutral.
 */
const SEARCH_VISIBILITY:Readonly<Record<string,number>>={telegraph:.5,'lucid-page':1.3};
export function channelLinkQuality(channel:Channel,tasks:Task[]):number{
  const links=tasks.filter(task=>task.channelId===channel.id&&task.firstLiveAt),follow=links.some(task=>task.linkRel!==undefined&&!/nofollow|ugc|sponsored/i.test(task.linkRel));
  const base=follow||channel.linkRel==='follow'?SCHEDULING_DEFAULTS.linkQualityFollow
    :['nofollow','ugc','sponsored'].includes(channel.linkRel??'')||links.some(task=>/nofollow|ugc|sponsored/i.test(task.linkRel??''))?SCHEDULING_DEFAULTS.linkQualityNofollow
    :channel.quality==='A'?SCHEDULING_DEFAULTS.linkQualityA:channel.quality==='C'?SCHEDULING_DEFAULTS.linkQualityC:SCHEDULING_DEFAULTS.linkQualityUnknown;
  return base*(SEARCH_VISIBILITY[channel.id]??1);
}
/** A missing account never invents a shared public author for independent anonymous pages. */
function publicIdentityFor(state:State,siteId:string,channelId:string,accountId?:string,receipt?:Task):string{
  const destination=sharedDestinationKey(state,siteId,channelId,accountId,receipt);
  if(destination&&!destination.endsWith(':workspace')&&!destination.endsWith(':pending-profile'))return destination.toLowerCase();
  const account=accountForSiteChannel(state,siteId,channelId,accountId);
  const automaticActor=channelId==='agenthow'?receipt?.agentHow?.actorId??account?.agentHow?.actorId:
    channelId==='agentnotepad'?receipt?.agentNotepad?.agentId??account?.agentNotepad?.agentId:
    channelId==='agentriot'?receipt?.agentriot?.agentId??account?.agentriot?.agentId:undefined;
  if(automaticActor)return `${channelId}:actor:${automaticActor}`;
  if(account&&['github-gist','agentboard'].includes(channelId)&&account.username.trim())return `${channelId}:author:${account.username.trim().toLowerCase()}`;
  return account?`${channelId}:account:${account.id}`:`${channelId}:site:${siteId}`;
}
function taskPublicIdentity(state:State,task:Task):string{
  const resolved=publicIdentityFor(state,task.siteId,task.channelId,task.accountId,task),saved=task.scheduling?.publicIdentity;
  // Autocreated accounts and remote receipts may establish the author after the initial claim.
  // Preserve a known old author only when its local account has since been removed.
  return saved&&!saved.includes(':site:')&&resolved.includes(':site:')?saved:resolved;
}
function schedulingPlatforms(channels:Channel[],state?:State,now=new Date(),usable=(site:Site,channel:Channel)=>usableSitePlatform(state!,site,channel,now)):SchedulePlatform[]{
  return channels.map(channel=>{
    const trial=state?channelIsTrial(channel,state.settings):channel.trial;
    const activeTask=trial&&state?state.tasks.find(task=>task.id===state.settings.channelTrials?.[channel.id]?.activeTaskId&&task.channelId===channel.id):undefined;
    const ownerReady=activeTask&&state?.sites.some(site=>site.id===activeTask.siteId&&site.status==='ready');
    const eligibleSiteIds=activeTask?(ownerReady?[activeTask.siteId]:[]):state?.sites.filter(site=>site.status==='ready'&&usable(site,channel)).map(site=>site.id);
    return {id:channel.id,dailySites:platformDailyLimit(channel.id),...(trial?{monthlyLimit:1}:{}),...(state?{eligibleSiteIds}:{})};
  });
}
function hasAutomaticPlatformPrerequisite(state:State,siteId:string,channel:Channel,readiness:ReturnType<typeof channelExecutionReadiness>,taskId?:string,now=new Date()):boolean{
  if(channel.id==='html-app'&&!htmlAppPublicNoticeAccepted(state.settings.htmlAppPublicNotice))return true;
  if(channel.id==='paper-wf'&&readiness.kind!=='ready')return true;
  return state.tasks.some(task=>task.id!==taskId&&task.siteId===siteId&&task.channelId===channel.id&&task.checkpoint==='batch5_prepare_exhausted'&&!expiredBatch5Preparation(task,now));
}
function automaticPlatformCandidate(site:Site,channel:Channel):boolean{
  // Monthly financial-site reservations use the same repeatable capability
  // definition as their automatic-platform inventory. Explicit tasks keep
  // their original publisher and read-only recovery paths.
  return site.category!=='finance'||isRepeatableOfficialArticleChannel(channel);
}
/** Compute once per planning transaction so every site shares one network capacity ratio. */
function usableSitePlatform(state:State,site:Site,channel:Channel,now=new Date()):boolean{
  if(channel.retentionDays!==undefined||!automaticPlatformCandidate(site,channel)||!eligibilityFor(site,channel).eligible)return false;
  const readiness=channelExecutionReadiness(state,site.id,channel);if(!['ready','autocreate'].includes(readiness.kind))return false;
  if(hasAutomaticPlatformPrerequisite(state,site.id,channel,readiness,undefined,now))return false;
  const identity=publicIdentityFor(state,site.id,channel.id,readiness.account?.id);
  if(identityBoundElsewhere(state,site.id,channel.id,identity))return false;
  return !state.tasks.some(task=>task.siteId!==site.id&&task.channelId===channel.id&&(!!task.firstLiveAt||hasUnresolvedExternalAttempt(task))&&identity===publicIdentityFor(state,task.siteId,task.channelId,task.accountId,task));
}
export function availableNetworkPlatforms(state:State,channels:Channel[],now=new Date()):SchedulePlatform[]{
  const ready=state.sites.filter(site=>site.status==='ready');
  // Each site and platform pair is checked once: the filter below and the eligible site lists ask the same question.
  const checked=new Map<string,boolean>();
  const usable=(site:Site,channel:Channel)=>{const key=`${site.id}\n${channel.id}`;let value=checked.get(key);if(value===undefined){value=usableSitePlatform(state,site,channel,now);checked.set(key,value)}return value};
  // Unpromoted trials contribute one monthly planning slot across the network.
  return schedulingPlatforms(channels.filter(channel=>channel.retentionDays===undefined&&channel.enabled&&channel.free!=='paid'&&channel.free!=='unknown'&&state.settings.channelOverrides[channel.id]!==false&&['api','browser'].includes(channel.automation)&&(
    ready.some(site=>usable(site,channel))||channelIsTrial(channel,state.settings)&&ready.some(site=>state.tasks.some(task=>task.id===state.settings.channelTrials?.[channel.id]?.activeTaskId&&task.siteId===site.id))
  )),state,now,usable);
}
export interface QueuedScheduleChange {id:string;scheduledAt:string}
/** Wake-up recovery changes a missed task at most twice; submitted work is never moved. */
export function reflowQueuedSchedules(state:State,channels:Channel[]=[],now=new Date()):QueuedScheduleChange[]{
  if(!state.settings.autoRun)return [];
  const changes:QueuedScheduleChange[]=[];
  for(const task of state.tasks){
    const site=state.sites.find(item=>item.id===task.siteId&&item.status==='ready');
    if(!site||task.status!=='queued'||task.checkpoint==='ai_setup_required'||hasUnresolvedExternalAttempt(task))continue;
    const missed=now.getTime()-Date.parse(task.scheduledAt);if(!(missed>SCHEDULING_DEFAULTS.overdueAfterMs))continue;
    task.scheduling??={version:1,month:monthKey(task.scheduledAt,site.timezone??state.settings.timezone),slot:0,target:site.monthlyTarget,effectiveTarget:site.monthlyTarget,reschedules:0};
    if(task.scheduling.reschedules>=SCHEDULING_DEFAULTS.maxReschedules){
      Object.assign(task,taskTransition(task,{status:'skipped',reasonCode:'schedule_missed',checkpoint:'schedule_exhausted'},now));task.message=SCHEDULING_MESSAGES.reschedule_exhausted;task.updatedAt=now.toISOString();task.missedPublicationAt=now.toISOString();continue;
    }
    const when=deferredReservation(site,availableNetworkPlatforms(state,channels,now),scheduleEvents(state.tasks.filter(other=>other.id!==task.id)),now,state.settings.timezone,`${task.id}|missed|${task.scheduling.reschedules}`,undefined,state.settings.onlineHours);
    task.scheduling.reschedules++;task.scheduling.month=monthKey(when,site.timezone??state.settings.timezone);task.scheduledAt=when.toISOString();task.updatedAt=now.toISOString();task.missedPublicationAt=now.toISOString();task.reasonCode='schedule_missed';task.message=SCHEDULING_MESSAGES.missed_schedule;
    changes.push({id:task.id,scheduledAt:task.scheduledAt});
  }
  return changes;
}
/** Defer one content-conflicted task; unrelated sites and their reservations stay untouched. */
export function deferTaskSchedule(state:State,task:Task,channels:Channel[],now=new Date(),accept?:(at:Date)=>boolean):Date|undefined{
  const site=state.sites.find(item=>item.id===task.siteId&&item.status==='ready');
  if(!site||!['queued','running'].includes(task.status)||hasUnresolvedExternalAttempt(task))return;
  const platforms=availableNetworkPlatforms(state,channels);
  const events=scheduleEvents(state.tasks.filter(other=>other.id!==task.id),state);
  const when=findDeferredReservation(site,platforms,events,now,state.settings.timezone,`${task.id}|content-deferral|${task.scheduledAt}`,undefined,accept,state.settings.onlineHours);
  if(!when)return;
  Object.assign(task,taskTransition(task,{status:'queued',reasonCode:'diversity_deferred'},now));
  task.scheduledAt=when.toISOString();task.updatedAt=now.toISOString();task.message=SCHEDULING_MESSAGES.diversity_deferred;
  if(task.scheduling)task.scheduling.month=monthKey(when,site.timezone??state.settings.timezone);
  if(task.autoSchedule)task.autoSchedule.plannedAt=task.scheduledAt;
  return when;
}
/** Distribute every remaining AI task, including legacy tasks, over future capacity. */
export function deferAiLimitedTasks(state:State,channels:Channel[]=[],now=new Date()):QueuedScheduleChange[]{
  const changes:QueuedScheduleChange[]=[];
  for(const task of state.tasks){
    const site=state.sites.find(item=>item.id===task.siteId&&item.status==='ready');
    if(!site||!['queued','running'].includes(task.status)||hasUnresolvedExternalAttempt(task)||schedulingDay(task.scheduledAt,site.timezone??state.settings.timezone)!==schedulingDay(now,site.timezone??state.settings.timezone))continue;
    const when=deferredReservation(site,availableNetworkPlatforms(state,channels,now),scheduleEvents(state.tasks.filter(other=>other.id!==task.id)),now,state.settings.timezone,`${task.id}|ai-limit|${schedulingDay(now,state.settings.timezone)}`,state.settings.dailyAiLimit,state.settings.onlineHours);
    Object.assign(task,taskTransition(task,{status:'queued',reasonCode:'ai_daily_limit'},now));task.scheduledAt=when.toISOString();task.nextCheckAt=task.scheduledAt;task.updatedAt=now.toISOString();task.message=SCHEDULING_MESSAGES.ai_daily_limit;if(task.scheduling)task.scheduling.month=monthKey(when,site.timezone??state.settings.timezone);
    changes.push({id:task.id,scheduledAt:task.scheduledAt});
  }
  return changes;
}
/** Gate only actual publication; mailbox and link checks do not call this API. */
function expectedNetworkVolume(state:State,now:Date,timeZone:string):number{
  return Math.max(scheduleEvents(state.tasks,state).filter(event=>!event.failed&&!event.recovered&&schedulingDay(event.at,timeZone).slice(0,7)===monthKey(now,timeZone)).length,state.sites.filter(site=>site.status==='ready').reduce((sum,site)=>sum+(site.planStatus?.month===monthKey(now,site.timezone??timeZone)?site.planStatus.effectiveTarget:siteMonthTarget(site,now,timeZone)),0));
}
/** Check identity ownership before preparation or an implicit account binding mutates state. */
export function taskPlatformIdentityAvailable(state:State,task:Task,channel:Channel):boolean{
  if(!state.sites.some(site=>site.id===task.siteId)||task.channelId&&task.channelId!==channel.id)return false;
  const readiness=channelExecutionReadiness(state,task.siteId,channel,task.accountId);
  const account=readiness.account??accountForSiteChannel(state,task.siteId,channel.id,task.accountId);
  if(task.accountId&&(!account||account.id!==task.accountId))return false;
  // Some automatic publishers resolve a global account that an unbound site's
  // email-based lookup cannot see. Resolve it explicitly before comparing owners.
  const identity=publicIdentityFor(state,task.siteId,channel.id,account?.id??task.accountId,task);
  if(identityBoundElsewhere(state,task.siteId,channel.id,identity))return false;
  return !state.tasks.some(other=>other.id!==task.id&&other.siteId!==task.siteId&&other.channelId===channel.id&&
    (!!other.firstLiveAt||hasUnresolvedExternalAttempt(other))&&identity===taskPublicIdentity(state,other));
}
function identityBoundElsewhere(state:State,siteId:string,channelId:string,identity:string):boolean{
  return state.accountBindings.some(binding=>binding.channelId===channelId&&binding.siteId!==siteId&&identity===publicIdentityFor(state,binding.siteId,binding.channelId,binding.accountId));
}
export function publicationExecutionAt(state:State,task:Task,now=new Date()):Date{
  const other=state.tasks.filter(item=>item.id!==task.id),events=scheduleEvents(other,state).filter(event=>event.submitted||event.success||event.attempted);
  const attempts=events.filter(event=>event.submitted||event.success||event.attempted).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)),latest=attempts[0],previous=other.find(item=>item.id===latest?.id),timeZone=state.sites.find(site=>site.id===task.siteId)?.timezone??state.settings.timezone;
  let result=publicationGate(latest?.at,previous?.scheduling?.nextPublishAt,now,timeZone);
  if(!task.channelId)return result;
  const identity=publicIdentityFor(state,task.siteId,task.channelId,task.accountId,task),platform={id:task.channelId,dailySites:platformDailyLimit(task.channelId),identity};
  if(identityBoundElsewhere(state,task.siteId,task.channelId,identity)||events.some(event=>event.identity===identity&&event.siteId!==task.siteId))return new Date(now.getTime()+SCHEDULING_DEFAULTS.maxLookaheadDays*86400000);
  for(let i=0;i<SCHEDULING_DEFAULTS.maxLookaheadDays;i++){
    if(eligiblePlatforms({siteId:task.siteId,platforms:[platform],events,at:result,timeZone,expectedMonthlyVolume:expectedNetworkVolume(state,result,timeZone)}).length)return result;
    const nextDay=addScheduleDays(schedulingDay(result,timeZone),1);
    result=timeZone===state.settings.timezone?scheduleOnPreferredHour(nextDay,timeZone,state.settings.onlineHours):randomScheduleOnDay(nextDay,timeZone);
  }
  return result;
}

/** Persist immediately before an external publish attempt, even when its result is unknown. */
export function claimPublicationExecution(state:State,task:Task,now=new Date(),random:()=>number=Math.random):boolean{
  const when=publicationExecutionAt(state,task,now);if(when.getTime()>now.getTime())return false;
  const site=state.sites.find(item=>item.id===task.siteId);if(!site||site.status!=='ready'||!task.channelId)return false;
  task.scheduling??={version:1,month:monthKey(now,site.timezone??state.settings.timezone),slot:0,target:site.monthlyTarget,effectiveTarget:site.monthlyTarget,reschedules:0};
  task.scheduling.attemptedAt=now.toISOString();task.scheduling.publicIdentity=publicIdentityFor(state,task.siteId,task.channelId,task.accountId,task);task.scheduling.nextPublishAt=new Date(now.getTime()+nextPublishGap(random)).toISOString();return true;
}
/** A day reservation acquires a platform only when the controller is ready to run it. */
export function schedulableTaskMatches(state:State,task:Task,matches:Match[],now=new Date()){
  const site=state.sites.find(item=>item.id===task.siteId);
  if(!site)return [];
  const timeZone=site.timezone??state.settings.timezone;
  const otherTasks=state.tasks.filter(item=>item.id!==task.id);
  const topicContext=originTopicContext(state,site.id);
  const failedPlatforms=new Set(activeFailedPlatformIds(task,now));
  return matches.filter(({channel})=>automaticPlatformCandidate(site,channel)&&trialTaskAvailable(state,channel,task.id)&&channel.retentionDays===undefined&&channel.enabled&&channel.free!=='paid'&&channel.free!=='unknown'&&state.settings.channelOverrides[channel.id]!==false&&['api','browser'].includes(channel.automation)&&eligibilityFor(site,channel).eligible)
    .map(match=>({match,readiness:channelExecutionReadiness(state,site.id,match.channel)}))
    .filter(item=>['ready','autocreate'].includes(item.readiness.kind))
    .filter(({match,readiness})=>!hasAutomaticPlatformPrerequisite(state,site.id,match.channel,readiness,task.id,now)&&!failedPlatforms.has(match.channel.id))
    .filter(({match,readiness})=>taskPlatformIdentityAvailable(state,task,match.channel)&&publicationOpportunity(site,match.channel,otherTasks,now,timeZone,{...officialApiContext(match.channel.id,readiness),...topicContext}).allowed);
}

/** Runtime channel metric projected from the scheduler's exact task predicate. */
export function runtimeFinancePlatformCount(state:State,site:Site,channels:Channel[],now=new Date(),projection:{matches?:Match[];acceptedChannelIds?:ReadonlySet<string>}={}):FinancePlatformCount{
  const task:Task={id:`finance-platform-count:${site.id}`,siteId:site.id,channelId:'',sourceDomain:'',status:'queued',createdAt:now.toISOString(),scheduledAt:now.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'runtime metric'};
  const matches=projection.matches??matchChannels(site,channels);
  const schedulable=new Set(schedulableTaskMatches(state,task,matches,now).map(item=>item.match.channel.id));
  const acceptedChannelIds=projection.acceptedChannelIds??new Set(state.tasks.filter(item=>item.firstLiveAt&&item.linkCheck==='found'&&item.linkIndexable===true).map(item=>item.channelId));
  const discoveredChannelIds=new Set(matches.map(item=>item.channel.id));
  return countFinanceAutomaticPlatforms(site,channels,{
    trialStates:state.settings.channelTrials,
    acceptedChannelIds,
    discoveredChannelIds,
    htmlAppPublicNoticeAccepted:htmlAppPublicNoticeAccepted(state.settings.htmlAppPublicNotice),
    readiness:channel=>channelExecutionReadiness(state,site.id,channel).kind,
    runtime:{schedulable:channel=>schedulable.has(channel.id)},
  });
}
export function selectTaskPlatform(state:State,task:Task,matches:Match[],now=new Date()):Channel|undefined{
  const site=state.sites.find(item=>item.id===task.siteId);if(!site)return;
  const activeFailures=activeFailedPlatformIds(task,now);
  if(activeFailures.length!==(task.failedPlatformIds?.length??0)){
    task.failedPlatformIds=activeFailures.length?activeFailures:undefined;
    task.failedPlatformAt=activeFailures.length?Object.fromEntries(activeFailures.map(id=>[id,task.failedPlatformAt?.[id]??task.updatedAt??task.createdAt])):undefined;
  }
  if(task.channelId){const channel=matches.find(match=>match.channel.id===task.channelId)?.channel;if(!channel||activeFailures.includes(channel.id)||!trialTaskAvailable(state,channel,task.id))return;const when=publicationExecutionAt(state,task,now);if(when.getTime()>now.getTime()){task.scheduledAt=when.toISOString();task.updatedAt=now.toISOString();task.reasonCode='platform_capacity';task.message=SCHEDULING_MESSAGES.platform_wait;return;}if(!claimChannelTrial(state,channel,task))return;return channel;}
  const timeZone=site.timezone??state.settings.timezone,events=scheduleEvents(state.tasks.filter(item=>item.id!==task.id),state);
  let qualified=schedulableTaskMatches(state,task,matches,now);
  if(!qualified.length&&activeFailures.length){
    const withoutExclusions={...task,failedPlatformIds:undefined,failedPlatformAt:undefined};
    const recovered=schedulableTaskMatches(state,withoutExclusions,matches,now);
    if(recovered.length){task.failedPlatformIds=undefined;task.failedPlatformAt=undefined;qualified=recovered;}
  }
  const fresh=qualified.filter(({match:{channel},readiness})=>{
    const source=sourceKey(channelSourceDomain(site,channel,readiness.account));
    return !state.tasks.some(other=>other.id!==task.id&&other.siteId===site.id&&!other.recoveredAt&&sourceKey(other.sourceDomain)===source&&
      (reservesMonthlySlot(other,now,timeZone)||publicationDates([other]).some(date=>monthKey(date,timeZone)===monthKey(now,timeZone))));
  });
  const candidates=fresh.length?fresh:qualified;
  const platforms=candidates.map(({match:{channel},readiness})=>({id:channel.id,dailySites:platformDailyLimit(channel.id),linkQuality:channelLinkQuality(channel,state.tasks),identity:publicIdentityFor(state,site.id,channel.id,readiness.account?.id)})).filter(platform=>!identityBoundElsewhere(state,site.id,platform.id,platform.identity));
  const expected=Math.max(events.filter(event=>!event.failed&&!event.recovered&&schedulingDay(event.at,timeZone).slice(0,7)===monthKey(now,timeZone)).length+1,state.sites.filter(item=>item.status==='ready').reduce((sum,item)=>sum+(item.planStatus?.effectiveTarget??siteMonthTarget(item,now,state.settings.timezone)),0));
  const selected=selectWeightedPlatform({siteId:site.id,platforms,events,at:now,timeZone,expectedMonthlyVolume:expected});
  if(!selected){task.scheduledAt=deferredReservation(site,platforms,events,now,timeZone,`${task.id}|platform|${task.attempts}`,undefined,state.settings.onlineHours).toISOString();task.updatedAt=now.toISOString();task.reasonCode='platform_capacity';task.message=SCHEDULING_MESSAGES.platform_wait;return;}
  const chosen=candidates.find(item=>item.match.channel.id===selected.id)!,opportunity=publicationOpportunity(site,chosen.match.channel,state.tasks.filter(item=>item.id!==task.id),now,timeZone,{...officialApiContext(chosen.match.channel.id,chosen.readiness),...originTopicContext(state,site.id)});
  if(!claimChannelTrial(state,chosen.match.channel,task))return;
  task.channelId=selected.id;task.temporaryPage=chosen.match.channel.retentionDays!==undefined;task.sourceDomain=channelSourceDomain(site,chosen.match.channel,chosen.readiness.account);task.accountId=chosen.readiness.account?.id;task.topicUrl=opportunity.topicUrl??task.topicUrl;
  task.scheduling??={version:1,month:monthKey(task.scheduledAt,timeZone),slot:0,target:site.monthlyTarget,effectiveTarget:site.monthlyTarget,reschedules:0};task.scheduling.selectionAt=now.toISOString();task.scheduling.publicIdentity=selected.identity;task.updatedAt=now.toISOString();return chosen.match.channel;
}

export interface QueuedSourceChange {id:string;fromChannelId:string;toChannelId:string;scheduledAt:string}
function channelSourceDomain(site:Site,channel:Channel,account?:{publicationUrl?:string}):string{
  if(channel.id==='blogger'&&site.blogger)return new URL(site.blogger.url).hostname;
  if(['paper-wf','hive','mataroa','verbose'].includes(channel.id)&&account?.publicationUrl){
    try{const url=new URL(account.publicationUrl);if(url.protocol==='https:'&&url.hostname.toLowerCase()===channel.domain.toLowerCase()&&!url.username&&!url.password)return url.hostname.toLowerCase()}catch{/* Invalid account identity is blocked by readiness. */}
  }
  return channel.domain;
}
/** Older plans bind a source early; repair only untouched duplicates. New plans select at execution. */
export function rebalanceQueuedSources(state:State,site:Site,matches:Match[],now=new Date()):QueuedSourceChange[]{
  if(!state.settings.autoRun||site.status!=='ready'||getArticleReviewMode(site,state.settings)!=='ai')return [];
  const timeZone=site.timezone??state.settings.timezone,month=monthKey(now,timeZone),changes:QueuedSourceChange[]=[];
  const pristine=(task:Task)=>task.status==='queued'&&!!task.channelId&&task.autoSchedule?.kind==='planner'&&task.attempts===0&&
    !task.draft&&!task.articleReview&&!task.articleApprovedAt&&!task.articleAttempts?.length&&!task.checkpoint&&!task.reasonCode&&!task.history?.length&&
    !task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&!hasUnresolvedExternalAttempt(task)&&
    !Object.values(task.cost??{}).some(value=>typeof value==='number'&&value>0);
  const queued=state.tasks.filter(task=>task.siteId===site.id&&pristine(task)&&monthKey(task.scheduledAt,timeZone)===month)
    .sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
  for(const task of queued){
    const original=matches.find(item=>item.channel.id===task.channelId)?.channel;
    if(!original||original.kind!=='article'||!original.articleRequired||original.contentFormat==='social')continue;
    const source=sourceKey(task.sourceDomain),withoutTask=state.tasks.filter(other=>other.id!==task.id);
    const duplicate=withoutTask.some(other=>other.siteId===site.id&&sourceKey(other.sourceDomain)===source&&
      !other.recoveredAt&&(reservesMonthlySlot(other,now,timeZone)||publicationDates([other]).some(date=>monthKey(date,timeZone)===month)));
    if(!duplicate)continue;
    const alternatives=schedulableTaskMatches(state,{...task,channelId:''},matches,new Date(task.scheduledAt));
    for(const {match:{channel,reason},readiness} of alternatives){
      if(channel.id===task.channelId||channel.kind!=='article'||!channel.articleRequired||channel.contentFormat==='social')continue;
      const candidateSource=channelSourceDomain(site,channel,readiness.account),candidateKey=sourceKey(candidateSource);
      if(candidateKey===source||withoutTask.some(other=>other.siteId===site.id&&sourceKey(other.sourceDomain)===candidateKey&&taskOccupiesSource(other)))continue;
      const candidateTask={...task,channelId:channel.id,accountId:readiness.account?.id};
      if(!taskPlatformIdentityAvailable(state,candidateTask,channel))continue;
      const opportunity=publicationOpportunity(site,channel,withoutTask,now,timeZone,{...officialApiContext(channel.id,readiness),...originTopicContext(state,site.id)});
      if(!opportunity.allowed||!opportunity.scheduledAt)continue;
      const requested=new Date(Math.max(Date.parse(task.scheduledAt),Date.parse(opportunity.scheduledAt)));
      const policyAt=earliestPublicationAt(site.id,channel.id,withoutTask,requested);
      const simulated={...state,tasks:[...withoutTask,candidateTask]};
      const when=socialPublicationAt(simulated,site.id,channel.id,policyAt,{excludeTaskId:task.id});
      if(!Number.isFinite(when.getTime())||when.getTime()<Date.parse(task.scheduledAt)||monthKey(when,timeZone)!==month)continue;
      const fromChannelId=task.channelId;
      task.channelId=channel.id;task.accountId=readiness.account?.id;task.sourceDomain=candidateSource;task.scheduledAt=when.toISOString();task.updatedAt=now.toISOString();
      task.topicUrl=opportunity.topicUrl;task.suitabilityReason=reason;
      task.message='尚未开始的重复来源排期已改为新的可执行文章来源。';
      task.autoSchedule={kind:'planner',channelId:channel.id,sourceDomain:candidateSource,...(readiness.account?{accountId:readiness.account.id}:{}),baseAt:opportunity.scheduledAt,plannedAt:task.scheduledAt,reservationTaskIds:[],appliedReleaseIds:[]};
      changes.push({id:task.id,fromChannelId,toChannelId:channel.id,scheduledAt:task.scheduledAt});
      break;
    }
  }
  return changes;
}

export function makePlan(state:State,site:Site,matches:Match[],now=new Date(),networkPlatforms?:SchedulePlatform[]):Task[]{
  if(site.status!=='ready')return [];
  expireReviews(state,now);
  rebalanceQueuedSources(state,site,matches,now);
  const usable=matches.filter(({channel})=>channel.retentionDays===undefined&&channel.enabled&&channel.free!=='paid'&&channel.free!=='unknown'&&['browser','api'].includes(channel.automation)&&state.settings.channelOverrides[channel.id]!==false&&eligibilityFor(site,channel).eligible).filter(({channel})=>usableSitePlatform(state,site,channel,now));
  const platforms=(networkPlatforms??schedulingPlatforms(usable.map(match=>match.channel),state,now)).map(platform=>matches.some(({channel})=>channel.id===platform.id&&channelIsTrial(channel,state.settings))?{...platform,monthlyLimit:1}:platform),sites=state.sites.filter(item=>item.status==='ready');
  const capacity=monthlyCapacity(sites,platforms,now,state.settings.timezone),timeZone=site.timezone??state.settings.timezone;
  const occupied=state.tasks.filter(task=>task.siteId===site.id&&!task.temporaryPage&&!task.recoveredAt&&(!!task.firstLiveAt||reservesMonthlySlot(task,now,timeZone)||hasUnresolvedExternalAttempt(task))&&monthKey(task.submittedAt??task.firstLiveAt??task.scheduledAt,timeZone)===monthKey(now,timeZone)).length;
  const target=siteMonthTarget(site,now,state.settings.timezone),effective=Math.min(target,Math.max(occupied,Math.min(capacity.targets.get(site.id)??0,usable.filter(({channel})=>!channelIsTrial(channel,state.settings)||trialTaskAvailable(state,channel,'')).length+occupied)));
  site.planStatus={month:monthKey(now,site.timezone??state.settings.timezone),target,effectiveTarget:effective,capacity:capacity.capacity,...(effective<target?{reasonCode:'platform_capacity' as const}:{}),message:effective<target?SCHEDULING_MESSAGES.platform_capacity.replace('{effective}',String(effective)).replace('{target}',String(target)):SCHEDULING_MESSAGES.planned};
  if(!usable.length)return [];
  const events=scheduleEvents(state.tasks.filter(task=>task.firstLiveAt||reservesSlot(task,now)||hasUnresolvedExternalAttempt(task)||['failed','skipped','expired'].includes(task.status))),reservations=planMonthlyReservations(sites,platforms,events,now,state.settings.timezone,site.id,effective,state.settings.onlineHours).filter(item=>item.siteId===site.id),created:Task[]=[];
  for(const slot of reservations){
    // Verify a real topic/source opportunity without reserving a particular platform.
    if(!usable.some(({channel})=>{const ready=channelExecutionReadiness(state,site.id,channel);const opportunity=publicationOpportunity(site,channel,state.tasks,new Date(slot.at),site.timezone??state.settings.timezone,{...officialApiContext(channel.id,ready),...originTopicContext(state,site.id)});return opportunity.allowed}))continue;
    const task:Task={id:randomUUID(),siteId:site.id,channelId:'',sourceDomain:'',status:'queued',createdAt:now.toISOString(),scheduledAt:slot.at,updatedAt:now.toISOString(),attempts:0,message:SCHEDULING_MESSAGES.planned,scheduling:{version:1,month:slot.month,slot:slot.slot,target:slot.target,effectiveTarget:slot.effectiveTarget,reschedules:0}};
    state.tasks.push(task);created.push(task);
  }
  return created;
}
export function nextTask(state:State,now=new Date(),channels:Channel[]=[]):Task|undefined{
  if(!state.settings.autoRun)return;
  const priority=(task:Task)=>{if(!task.channelId)return 0;const channel=channels.find(item=>item.id===task.channelId);if(!channel)return 0;if(continuesPendingRegistration(state,task,channel,now))return 0;const kind=channelExecutionReadiness(state,task.siteId,channel,task.accountId).kind;return kind==='ready'?0:kind==='autocreate'?1:kind==='handoff_required'?2:3};
  const due=state.tasks.filter(task=>{
    const site=state.sites.find(item=>item.id===task.siteId&&item.status==='ready'),planned=Date.parse(task.scheduledAt),draftContinuation=hasRecoverablePublisherDraftReceipt(task);
    if(!task.draft&&hasPendingManualReview(state.tasks,task.siteId,task.id))return false;
    const safeRetry=safelyUnsentBatch5Task(task),preparationRetry=unfinishedBatch5Preparation(task,state.settings.maxAttempts);
    const independentRetry=(task.temporaryBackoffCount??0)>0&&(task.temporaryBackoffCount??0)<=3&&
      ['temporary_failure','ai_rate_limited'].includes(task.reasonCode??'')&&!hasUnresolvedExternalAttempt(task);
    const deterministicRecovery=task.recoveryAttempts===1&&!task.draft&&
      ['format_invalid','evidence_insufficient','evidence_truncated'].includes(task.reasonCode??'')&&!hasUnresolvedExternalAttempt(task);
    if(!site||task.channelId&&channels.some(channel=>channel.id===task.channelId&&!trialTaskAvailable(state,channel,task.id))||task.status!=='queued'||task.reasonCode==='human_timeout'||task.reasonCode==='submission_unknown'&&!draftContinuation&&!safeRetry||hasUnresolvedExternalAttempt(task)&&!draftContinuation&&!safeRetry||task.publicUrl||task.firstLiveAt||!Number.isFinite(planned)||planned>now.getTime()||task.attempts>=state.settings.maxAttempts&&!hasActiveSiteOriginRecoveryGrant(state,task)&&!safeRetry&&!preparationRetry&&!independentRetry&&!deterministicRecovery||channels.length>0&&priority(task)>1)return false;
    const target=site.planStatus?.month===monthKey(now,site.timezone??state.settings.timezone)?Math.min(site.planStatus.effectiveTarget,siteMonthTarget(site,now,state.settings.timezone)):siteMonthTarget(site,now,state.settings.timezone);
    const waiting=state.tasks.filter(item=>item.siteId===site.id&&item.status!=='queued'&&reservesMonthlySlot(item,now,site.timezone??state.settings.timezone)).length;
    return (task.temporaryPage||liveThisMonth(site.id,state.tasks,now,site.timezone??state.settings.timezone)+waiting<target)&&(!task.channelId||publicationExecutionAt(state,task,now).getTime()<=now.getTime());
  }).sort((a,b)=>priority(a)-priority(b)||a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
  return due[0];
}

export function markVerified(t:Task,now:Date,url:string,rel:string){Object.assign(t,taskTransition(t,{status:'live',reasonCode:undefined},now));t.publicUrl=url;t.firstLiveAt??=now.toISOString();t.verifiedAt=now.toISOString();t.lastCheckedAt=now.toISOString();t.linkRecheckAt=undefined;t.updatedAt=now.toISOString();t.linkRel=normalizeChannelLinkRel(rel)??'unknown';t.message='外链已检查。'}

export function applyLinkResult(task:Task,result:LinkResult,now=new Date()){
 const priorStatus=task.status,priorMessage=task.message;task.linkRecheckAt=undefined;task.linkObservation=undefined;
 task.linkCheckReason=result.reasonCode;task.linkMatchedOrigin=result.matchedOrigin;task.linkUsesLegacyOrigin=result.usesLegacyOrigin;task.linkIndexable=result.indexable??(result.found?true:undefined);task.linkCheckFinalUrl=result.url;
 if(result.found)result={...result,rel:normalizeChannelLinkRel(result.rel)??'unknown'};
 if(result.found&&result.rel!=='unknown')task.linkRel=result.rel;
 task.updatedAt=now.toISOString();task.lastCheckedAt=now.toISOString();task.linkCheck=result.outcome??(result.found?'found':'unreachable');task.linkRecheckVersion=1;
 if(result.found){
   if(!task.firstLiveAt&&task.checkpoint!=='existing_link'&&['failed','skipped','expired'].includes(priorStatus)){
     const original=Date.parse(task.submittedAt??task.scheduling?.attemptedAt??task.createdAt);
     task.firstLiveAt=new Date(Math.min(now.getTime(),Number.isFinite(original)?original:now.getTime())).toISOString();
     task.recoveredAt=now.toISOString();
   }
   task.health='healthy';task.consecutiveMissing=0;task.lostAt=undefined;task.reviewKind=undefined;
   if(task.checkpoint==='existing_link'){task.status='skipped';task.verifiedAt=now.toISOString();task.linkRel=result.rel;}else markVerified(task,now,result.url,result.rel);
   if(result.reasonCode==='legacy_origin')task.message=result.reason;
 }else{
   task.message=result.reason||MAINTENANCE_MESSAGES.lostLink;
   task.health=result.outcome==='absent'?'missing':'unknown';
   if(task.firstLiveAt&&result.outcome==='absent'){
     Object.assign(task,taskTransition(task,{status:'live',reasonCode:undefined},now));
     task.reviewKind=undefined;task.lostAt??=now.toISOString();task.consecutiveMissing=(task.consecutiveMissing??0)+1;task.message=MAINTENANCE_MESSAGES.lostLink;
   }else if(['failed','skipped','expired'].includes(priorStatus)){task.status=priorStatus;task.message=priorMessage;}
 }
 task.nextCheckAt=nextLinkCheck(task,now);
 history(task,now.toISOString());
}

type CapacityCandidate={channel:Channel;opportunity:ReturnType<typeof publicationOpportunity>;readiness:ReturnType<typeof channelExecutionReadiness>;eligible:boolean;automatic:boolean};
function fallbackReadiness(channel:Channel):ReturnType<typeof channelExecutionReadiness>{
  if(channel.automation==='manual')return {kind:'manual'};
  if(!channel.accountRequired)return {kind:'ready'};
  if(['telegraph','shippage'].includes(channel.id)&&channel.automation==='api')return {kind:'autocreate'};
  return {kind:'handoff_required'};
}
function fittingSchedule(site:Site,candidates:CapacityCandidate[],predicate:(candidate:CapacityCandidate)=>boolean,limit:number,tasks:Task[],now:Date,timeZone:string,state?:State,networkPlatforms?:SchedulePlatform[]):{scheduled:string[];deferredAt?:string}{
  const usable=candidates.filter(candidate=>predicate(candidate)&&candidate.opportunity.allowed),platforms=networkPlatforms??schedulingPlatforms(usable.map(candidate=>candidate.channel),state);
  if(!platforms.length)return {scheduled:[]};
  const sites=state?state.sites.filter(item=>item.status==='ready'):[site],events=scheduleEvents(state?.tasks??tasks,state),reservations=planMonthlyReservations(sites,platforms,events,now,timeZone,site.id,usable.length+events.filter(event=>event.siteId===site.id&&!event.failed&&!event.recovered&&monthKey(event.at,site.timezone??timeZone)===monthKey(now,site.timezone??timeZone)).length).filter(slot=>slot.siteId===site.id).slice(0,limit);
  const onlyTopicChannels=usable.every(candidate=>candidate.channel.articleRequired);
  let count=reservations.length;
  if(onlyTopicChannels){
    const related=(state?.tasks??tasks).filter(task=>task.siteId===site.id),key=state?originTopicContext(state,site.id).topicKey:canonicalPublicPageUrl;
    const used=new Set(related.flatMap(task=>[...(task.topicUrl&&(reservesSlot(task,now)||hasUnresolvedExternalAttempt(task)||task.reasonCode||task.draft||task.articleReview)?[key(task.topicUrl)]:[]),...(task.articleAttempts??[]).map(attempt=>key(attempt.topicUrl))]).filter(Boolean));
    const available=new Set((site.topics??[]).filter(topic=>isArticleTopicUrl(topic.url,site)).map(topic=>key(topic.url)).filter(topic=>topic&&!used.has(topic)));
    count=Math.min(count,available.size);
  }
  return {scheduled:reservations.slice(0,count).map(slot=>slot.at)};
}

/** `network` is availableNetworkPlatforms for the same state, computed once by a caller that asks for many sites. */
export function capacityFor(site:Site,tasks:Task[],matches:Match[],channels:Channel[],now=new Date(),timeZone='UTC',state?:State,index?:CapacitySnapshotIndex,network?:SchedulePlatform[]):SiteCapacity{
  const related=index?.tasksBySite.get(site.id)??tasks.filter(task=>task.siteId===site.id);
  const remaining=unusedSources(site.id,related,matches.map(item=>item.channel));
  const automaticUnused=remaining.automatic,manualUnused=remaining.manual;
  const monthsAtTarget=site.monthlyTarget>0?Math.floor(remaining.total/site.monthlyTarget):null;
  const counts=publicationCounts(site.id,related,now,timeZone),pending=related.filter(task=>reservesMonthlySlot(task,now,timeZone)).length,gap=Math.max(0,siteMonthTarget(site,now,timeZone)-counts.monthlyPages-pending);
  const networkPlatforms=network??(state?availableNetworkPlatforms(state,channels):undefined);
  const ordered=state?rankedMatches(state,site,matches,related,now,timeZone,index?.sourceSites):matches.map((match,index)=>({match,index,readiness:fallbackReadiness(match.channel),usedThisMonth:false,lastUsed:Number.NEGATIVE_INFINITY}));
  const seen=new Set<string>(),candidates:CapacityCandidate[]=[];
  for(const {match:{channel},readiness} of ordered){
    if(channel.retentionDays!==undefined||!eligibilityFor(site,channel).eligible||seen.has(channel.id)||!channel.enabled||channel.free==='paid'||channel.free==='unknown'||state?.settings.channelOverrides[channel.id]===false)continue;
    seen.add(channel.id);
    let opportunity=publicationOpportunity(site,channel,related,now,timeZone,{...officialApiContext(channel.id,readiness),...(state?originTopicContext(state,site.id):{})});
    if(readiness.kind==='handoff_required'&&opportunity.allowed)opportunity={...opportunity,allowed:false,blockingReason:'account_required',reason:'平台符合发布条件，但尚未连接可用账号。'};
    const eligible=readiness.kind!=='handoff_required';
    const automatic=eligible&&channel.automation!=='manual'&&(readiness.kind==='ready'||readiness.kind==='autocreate');
    candidates.push({channel,opportunity,readiness,eligible,automatic});
  }
  const eligibleSchedule=fittingSchedule(site,candidates,candidate=>candidate.eligible,gap,related,now,timeZone,state,networkPlatforms);
  const automaticSchedule=fittingSchedule(site,candidates,candidate=>candidate.automatic,gap,related,now,timeZone,state,networkPlatforms);
  const eligiblePages=eligibleSchedule.scheduled.length,automaticPages=automaticSchedule.scheduled.length;
  const priority:CapacityBlockReason[]=['budget_exhausted','invalid_topic','article_rejected','topics_unknown','topics_exhausted','cadence_wait','cooldown','account_required','no_automatic_channel'];
  const automaticBlocked=candidates.filter(candidate=>candidate.channel.automation!=='manual'&&!candidate.opportunity.allowed).map(candidate=>candidate.opportunity);
  const blocker=gap>0&&automaticPages===0?priority.map(reason=>automaticBlocked.find(item=>item.blockingReason===reason)).find((item):item is NonNullable<typeof item>=>!!item):undefined;
  const deferredAt=automaticBlocked.map(item=>item.nextAvailableAt).filter((value):value is string=>!!value).sort()[0];
  const nextAvailableAt=gap>0?(automaticSchedule.scheduled[0]??eligibleSchedule.scheduled[0]??automaticSchedule.deferredAt??eligibleSchedule.deferredAt??deferredAt):undefined;
  const noAutomaticReason=eligiblePages>0?'当前有可人工安排的页面机会，但暂无可新增自动排期。':'当前没有符合条件且可执行的页面机会。';
  const cadenceReason=automaticSchedule.deferredAt?SCHEDULING_MESSAGES.platform_wait:undefined;
  const reason=gap===0?undefined:blocker?.reason??cadenceReason??(automaticPages===0?noAutomaticReason:undefined);
  const blockingReason=gap>0&&automaticPages===0?(blocker?.blockingReason??(automaticSchedule.deferredAt?'cadence_wait':'no_automatic_channel')):undefined;
  return {siteId:site.id,currentLive:counts.currentPages,firstVerifiedThisMonth:counts.monthlyPages,currentSources:counts.currentSources,monthlySources:counts.monthlySources,missing:new Set(related.filter(task=>task.health==='missing').map(task=>sourceKey(task.sourceDomain))).size,eligibleUnused:remaining.total,automaticUnused,manualUnused,eligiblePages,automaticPages,monthsAtTarget,...(blockingReason?{blockingReason}:{}),...(nextAvailableAt?{nextAvailableAt}:{}),...(reason?{reason}:{})};
}
