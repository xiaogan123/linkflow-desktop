import {unusedSources} from '../shared/source-capacity';
import {PUBLICATION_GAP_MS,hasBloggerDraftReceipt,isRepeatableOfficialArticleChannel,nextNaturalMonthStart,publicationCounts,publicationDates,publicationOpportunity,sourceKey,reservesSlot,reservesMonthlySlot} from '../shared/publication';
import { randomUUID } from 'node:crypto';
import type { CapacityBlockReason,Channel, Site, SiteCapacity, Task, LinkResult } from '../shared/types';
import type { State } from './store';
import {boundAccount,channelExecutionReadiness} from './account-bindings';

export function dateKey(value:Date|string,timeZone:string):string{
  const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
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
    const uncertain=!!t.submittedAt||['submitting','submitted','submission_uncertain'].includes(t.checkpoint||'');
    const paidAiUncertain=t.status==='running'&&!uncertain&&((['article_review','article_repair_review'].includes(t.checkpoint??'')&&t.articleReview?.status==='running')||(!t.draft&&(t.cost?.aiCalls??0)>0));
    if(paidAiUncertain){
      const eligible=(t.cost?.aiCalls??0)<6&&(t.recoveryAttempts??0)<1;
      t.status='failed';t.checkpoint='system_wait';t.updatedAt=now.toISOString();t.recoveryEligible=eligible;
      t.nextCheckAt=eligible?new Date(now.getTime()+24*3600000).toISOString():undefined;
      if(t.articleReview?.status==='running')t.articleReview={...t.articleReview,status:'failed',reasonCode:'ai_unavailable',reviewedAt:now.toISOString(),reason:'AI 调用在结果完整保存前中断；只允许原任务在预算内恢复一次。'};
      t.message=eligible?'上次 AI 工作在结果保存前中断；未发布，不会新建任务或重复付费，明天仅恢复原任务一次且沿用累计预算。':'上次 AI 工作在结果保存前中断；未发布，任务预算或恢复次数已用完。';continue;
    }
    if(t.status==='running'||(uncertain&&['queued','failed'].includes(t.status))){
      const wasRunning=t.status==='running';t.status=uncertain?'needs_input':'queued';
      if(wasRunning&&!uncertain&&t.checkpoint!=='article_repair_review')t.attempts=Math.max(0,t.attempts-1);
      t.updatedAt=now.toISOString();t.message=t.status==='needs_input'?'上次提交中断，请先检查平台结果，确认后继续。':'已恢复上次未完成的任务。';
    }
  }
}
function history(task:Task,at:string){task.history??=[];const last=task.history.at(-1);if(last?.status===task.status&&last.message===task.message&&last.linkCheck===task.linkCheck)return;task.history.push({at,status:task.status,message:task.message,linkCheck:task.linkCheck});task.history=task.history.slice(-50)}
export function expireReviews(state:State,now:Date){const paused=new Set(state.sites.filter(site=>site.status==='paused').map(site=>site.id));for(const t of state.tasks){if(paused.has(t.siteId))continue;if(t.status==='review'&&t.reviewUntil&&new Date(t.reviewUntil)<=now){t.status='expired';t.health=t.firstLiveAt?(t.linkCheck==='absent'?'missing':'unknown'):'unknown';t.message='审核期限已到，尚未确认公开外链；已释放本月名额，并保留记录供低频复查。';t.nextCheckAt=new Date(now.getTime()+7*86400000).toISOString();t.updatedAt=now.toISOString();history(t,t.updatedAt);}}}
export type Match={channel:Channel;score:number;reason:string};
const CROSS_PLATFORM_GAP_MS=7*24*60*60*1000;
const readinessRank={ready:0,autocreate:1,handoff_required:2,manual:3} as const;
export function continuesPendingRegistration(state:State,task:Task,channel:Channel,now=new Date()):boolean{
  if(task.checkpoint!=='account_registration_submitted'||task.submittedAt||channel.automation!=='browser'||!channel.emailRequired||!task.accountId)return false;
  const account=boundAccount(state,task);
  if(!account||account.id!==task.accountId||!account.hasPassword||account.credentialKind==='api_token'||['restricted','credentials_invalid'].includes(account.status))return false;
  const started=Date.parse(account.lastUsedAt??account.createdAt??task.createdAt);
  return Number.isFinite(started)&&now.getTime()-started<48*3600000;
}

type RankedMatch={match:Match;index:number;readiness:ReturnType<typeof channelExecutionReadiness>;usedThisMonth:boolean;lastUsed:number};
function rankedMatches(state:State,site:Site,matches:Match[],tasks:Task[],now:Date,timeZone:string):RankedMatch[]{
  return matches.map((match,index)=>{
    const dates=publicationDates(tasks.filter(task=>task.channelId===match.channel.id));
    return {match,index,readiness:channelExecutionReadiness(state,site.id,match.channel),usedThisMonth:dates.some(date=>monthKey(date,timeZone)===monthKey(now,timeZone)),lastUsed:dates.reduce((latest,date)=>Math.max(latest,date.getTime()),Number.NEGATIVE_INFINITY)};
  }).sort((a,b)=>readinessRank[a.readiness.kind]-readinessRank[b.readiness.kind]||Number(a.usedThisMonth)-Number(b.usedThisMonth)||a.lastUsed-b.lastUsed||b.match.score-a.match.score||a.index-b.index);
}

export interface PublicationTimingOptions {excludeTaskId?:string;includeReservations?:boolean}
/**
 * Earliest policy-compliant publication time. Planning includes existing reservations;
 * execution validation can ignore them and use only fixed successful/submitted evidence.
 */
export function earliestPublicationAt(siteId:string,channelId:string,tasks:Task[],requestedAt:Date,options:PublicationTimingOptions={}):Date{
  const related=tasks.filter(task=>task.siteId===siteId&&task.id!==options.excludeTaskId&&task.checkpoint!=='existing_link');
  const globalAnchors=publicationDates(related).map(date=>date.getTime());
  const samePlatformAnchors=publicationDates(related.filter(task=>task.channelId===channelId)).map(date=>date.getTime());
  for(const task of related){
    const submitted=Date.parse(task.submittedAt??'');
    if(Number.isFinite(submitted)){globalAnchors.push(submitted);if(task.channelId===channelId)samePlatformAnchors.push(submitted)}
  }
  const crossAt=globalAnchors.length?Math.max(...globalAnchors)+CROSS_PLATFORM_GAP_MS:Number.NEGATIVE_INFINITY;
  const platformAt=samePlatformAnchors.length?Math.max(...samePlatformAnchors)+PUBLICATION_GAP_MS:Number.NEGATIVE_INFINITY;
  let candidate=Math.max(requestedAt.getTime(),crossAt,platformAt);
  if(options.includeReservations!==false){
    const reservations=related.filter(task=>!task.submittedAt&&!task.firstLiveAt&&reservesSlot(task,requestedAt)).map(task=>({at:Date.parse(task.scheduledAt),gap:task.channelId===channelId?PUBLICATION_GAP_MS:CROSS_PLATFORM_GAP_MS})).filter(item=>Number.isFinite(item.at)).sort((a,b)=>a.at-b.at);
    for(const reservation of reservations){
      if(candidate>=reservation.at-reservation.gap&&candidate<reservation.at+reservation.gap)candidate=reservation.at+reservation.gap;
    }
  }
  return new Date(candidate);
}

export interface QueuedScheduleChange {id:string;scheduledAt:string}
/** Persist this inside the controller's state transaction before planning/claiming work. */
export function reflowQueuedSchedules(state:State,channels:Channel[]=[],now=new Date()):QueuedScheduleChange[]{
  if(!state.settings.autoRun)return [];
  const changes:QueuedScheduleChange[]=[];
  for(const site of state.sites){
    if(site.status!=='ready')continue;
    const queued=state.tasks.filter(task=>task.siteId===site.id&&task.status==='queued'&&!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
    let prior:Date|undefined;const priorByChannel=new Map<string,Date>();
    for(const task of queued){
      const original=new Date(task.scheduledAt);if(!Number.isFinite(original.getTime()))continue;
      let actual=earliestPublicationAt(site.id,task.channelId,state.tasks,original,{excludeTaskId:task.id,includeReservations:false});
      if(original.getTime()<=now.getTime()&&monthKey(original,state.settings.timezone)!==monthKey(now,state.settings.timezone))actual=new Date(Math.max(actual.getTime(),now.getTime()));
      const channel=channels.find(item=>item.id===task.channelId);
      if(channel&&isRepeatableOfficialArticleChannel(channel)){
        const thisMonth=publicationDates(state.tasks.filter(item=>item.siteId===site.id&&item.channelId===task.channelId)).filter(date=>monthKey(date,state.settings.timezone)===monthKey(now,state.settings.timezone)).length;
        if(thisMonth>=2)actual=new Date(Math.max(actual.getTime(),nextNaturalMonthStart(now,state.settings.timezone).getTime()));
      }
      if(prior)actual=new Date(Math.max(actual.getTime(),prior.getTime()+CROSS_PLATFORM_GAP_MS));
      const samePlatformPrior=priorByChannel.get(task.channelId);
      if(samePlatformPrior)actual=new Date(Math.max(actual.getTime(),samePlatformPrior.getTime()+PUBLICATION_GAP_MS));
      if(actual.getTime()>original.getTime()){
        task.scheduledAt=actual.toISOString();task.updatedAt=now.toISOString();task.message='前一页面实际完成较晚，已按发布间隔顺延本任务。';
        changes.push({id:task.id,scheduledAt:task.scheduledAt});
      }
      prior=actual;priorByChannel.set(task.channelId,actual);
    }
  }
  return changes;
}

export function makePlan(state:State,site:Site,matches:Match[],now=new Date()):Task[]{
  if(site.status!=='ready')return [];
  expireReviews(state,now);
  const related=state.tasks.filter(t=>t.siteId===site.id);
  const available=Math.max(0,site.monthlyTarget-liveThisMonth(site.id,related,now,state.settings.timezone)-related.filter(t=>reservesMonthlySlot(t,now,state.settings.timezone)).length);
  const created:Task[]=[];
  const ordered=rankedMatches(state,site,matches,related,now,state.settings.timezone);
  const considered=new Set<string>();
  let nextPlanAt=now;
  for(const {match:{channel,reason},readiness}of ordered){
    if(created.length>=available)break;
    if(considered.has(channel.id)||channel.free==='unknown'||!['browser','api'].includes(channel.automation)||!channel.enabled||state.settings.channelOverrides[channel.id]===false)continue;
    considered.add(channel.id);
    // Keep historical handoffs visible, but do not create fresh blocked work.
    if(readiness.kind==='handoff_required'||readiness.kind==='manual')continue;
    const opportunity=publicationOpportunity(site,channel,state.tasks,now,state.settings.timezone,{officialApiConnected:readiness.kind==='ready'});
    if(!opportunity.allowed||!opportunity.scheduledAt)continue;
    const policyAt=earliestPublicationAt(site.id,channel.id,state.tasks,new Date(opportunity.scheduledAt));
    const when=new Date(Math.max(nextPlanAt.getTime(),policyAt.getTime()));
    if(monthKey(when,state.settings.timezone)!==monthKey(now,state.settings.timezone))continue;
    const t:Task={id:randomUUID(),siteId:site.id,channelId:channel.id,...(readiness.account?{accountId:readiness.account.id}:{}),sourceDomain:channel.id==='blogger'&&site.blogger?new URL(site.blogger.url).hostname:channel.domain,status:'queued',createdAt:now.toISOString(),scheduledAt:when.toISOString(),updatedAt:now.toISOString(),attempts:0,message:opportunity.repeat?'已按平台发布间隔加入自动计划':'已加入自动计划',reason:`${reason} ${opportunity.reason}`.trim(),...(opportunity.topicUrl?{topicUrl:opportunity.topicUrl}:{})};
    state.tasks.push(t);created.push(t);
    nextPlanAt=new Date(when.getTime()+CROSS_PLATFORM_GAP_MS);
  }
  return created;
}
export function nextTask(state:State,now=new Date(),channels:Channel[]=[]):Task|undefined{
  if(!state.settings.autoRun)return;
  const priority=(task:Task)=>{const channel=channels.find(item=>item.id===task.channelId);if(!channel)return 0;if(continuesPendingRegistration(state,task,channel,now))return 0;const kind=channelExecutionReadiness(state,task.siteId,channel,task.accountId).kind;return kind==='ready'?0:kind==='autocreate'?1:kind==='handoff_required'?2:3};
  const effective=new Map<string,number>();
  return state.tasks.filter(t=>{
    const site=state.sites.find(s=>s.id===t.siteId&&s.status==='ready');
    const planned=new Date(t.scheduledAt);
    const draftContinuation=hasBloggerDraftReceipt(t);
    if(!site||t.status!=='queued'||(t.submittedAt&&!draftContinuation)||t.publicUrl||t.firstLiveAt||!Number.isFinite(planned.getTime())||t.attempts>=state.settings.maxAttempts||(channels.length>0&&priority(t)>1))return false;
    const requested=planned.getTime()<=now.getTime()&&monthKey(planned,state.settings.timezone)!==monthKey(now,state.settings.timezone)?now:planned;
    const actual=earliestPublicationAt(site.id,t.channelId,state.tasks,requested,{excludeTaskId:t.id,includeReservations:false});
    const channel=channels.find(item=>item.id===t.channelId);
    if(channel&&isRepeatableOfficialArticleChannel(channel)){
      const platformPages=publicationDates(state.tasks.filter(item=>item.siteId===site.id&&item.channelId===t.channelId)).filter(date=>monthKey(date,state.settings.timezone)===monthKey(now,state.settings.timezone)).length;
      if(platformPages>=2)return false;
    }
    if(actual.getTime()>now.getTime())return false;
    effective.set(t.id,actual.getTime());
    const room=site.monthlyTarget-liveThisMonth(t.siteId,state.tasks,now,state.settings.timezone);
    const reserved=state.tasks.filter(x=>x.siteId===site.id&&reservesMonthlySlot(x,now,state.settings.timezone)).sort((a,b)=>Number(b.status!=='queued')-Number(a.status!=='queued')||priority(a)-priority(b)||a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
    return reserved.slice(0,Math.max(0,room)).some(x=>x.id===t.id);
  }).sort((a,b)=>priority(a)-priority(b)||(effective.get(a.id)??Number.MAX_SAFE_INTEGER)-(effective.get(b.id)??Number.MAX_SAFE_INTEGER)||a.scheduledAt.localeCompare(b.scheduledAt))[0];
}
export function markVerified(t:Task,now:Date,url:string,rel:string){t.status='live';t.publicUrl=url;t.firstLiveAt??=now.toISOString();t.verifiedAt=now.toISOString();t.lastCheckedAt=now.toISOString();t.updatedAt=now.toISOString();t.linkRel=rel;t.message='公开页面已核验，外链已生效。'}

export function applyLinkResult(task:Task,result:LinkResult,now=new Date()){
 task.lastCheckedAt=now.toISOString();task.linkCheck=result.outcome??(result.found?'found':'unreachable');
 if(result.found){task.health='healthy';task.consecutiveMissing=0;task.lostAt=undefined;task.reviewKind=undefined;task.nextCheckAt=new Date(now.getTime()+7*86400000).toISOString();if(task.checkpoint==='existing_link'){task.status='skipped';task.verifiedAt=now.toISOString();task.linkRel=result.rel;task.message='发现已有外链，保留来源记录，不计为本月新增。'}else markVerified(task,now,result.url,result.rel)}
 else{
   task.message=result.reason||'尚未在公开页面发现目标链接';
   task.health=result.outcome==='absent'?'missing':'unknown';
   if(task.firstLiveAt&&result.outcome==='absent'){
     task.status='needs_input';task.reviewKind='lost_link';task.lostAt??=now.toISOString();task.consecutiveMissing=(task.consecutiveMissing??0)+1;task.nextCheckAt=new Date(now.getTime()+7*86400000).toISOString();task.message='曾核验生效的外链当前未找到；已保留历史新增记录，并将低频自动复查。';
   }else task.nextCheckAt=new Date(now.getTime()+86400000).toISOString();
 }
 history(task,now.toISOString());
}

type CapacityCandidate={channel:Channel;opportunity:ReturnType<typeof publicationOpportunity>;readiness:ReturnType<typeof channelExecutionReadiness>;eligible:boolean;automatic:boolean};
function fallbackReadiness(channel:Channel):ReturnType<typeof channelExecutionReadiness>{
  if(channel.automation==='manual')return {kind:'manual'};
  if(!channel.accountRequired)return {kind:'ready'};
  if(channel.id==='telegraph'&&channel.automation==='api')return {kind:'autocreate'};
  return {kind:'handoff_required'};
}
function fittingSchedule(site:Site,candidates:CapacityCandidate[],predicate:(candidate:CapacityCandidate)=>boolean,limit:number,tasks:Task[],now:Date,timeZone:string):{scheduled:string[];deferredAt?:string}{
  let slot=now,deferredAt:string|undefined;const scheduled:string[]=[],simulated=[...tasks];
  for(const [index,candidate] of candidates.entries()){
    if(scheduled.length>=limit)break;
    if(!predicate(candidate))continue;
    const opportunity=publicationOpportunity(site,candidate.channel,simulated,now,timeZone,{officialApiConnected:candidate.readiness.kind==='ready'});
    if(!opportunity.allowed||!opportunity.scheduledAt)continue;
    const policyAt=earliestPublicationAt(site.id,candidate.channel.id,simulated,new Date(opportunity.scheduledAt));
    const when=new Date(Math.max(slot.getTime(),policyAt.getTime()));
    if(monthKey(when,timeZone)!==monthKey(now,timeZone)){const stamp=when.toISOString();if(!deferredAt||stamp<deferredAt)deferredAt=stamp;continue;}
    const stamp=when.toISOString();scheduled.push(stamp);slot=new Date(when.getTime()+CROSS_PLATFORM_GAP_MS);
    simulated.push({id:`capacity-${candidate.channel.id}-${index}`,siteId:site.id,channelId:candidate.channel.id,sourceDomain:candidate.channel.domain,status:candidate.channel.automation==='manual'?'needs_input':'queued',createdAt:now.toISOString(),scheduledAt:stamp,updatedAt:now.toISOString(),attempts:0,message:'capacity simulation',...(opportunity.topicUrl?{topicUrl:opportunity.topicUrl}:{})});
  }
  return {scheduled,...(deferredAt?{deferredAt}:{})};
}

export function capacityFor(site:Site,tasks:Task[],matches:Match[],channels:Channel[],now=new Date(),timeZone='UTC',state?:State):SiteCapacity{
  const related=tasks.filter(task=>task.siteId===site.id);
  const remaining=unusedSources(site.id,tasks,matches.map(item=>item.channel));
  const automaticUnused=remaining.automatic,manualUnused=remaining.manual;
  const monthsAtTarget=site.monthlyTarget>0?Math.floor(remaining.total/site.monthlyTarget):null;
  const counts=publicationCounts(site.id,tasks,now,timeZone),pending=related.filter(task=>reservesMonthlySlot(task,now,timeZone)).length,gap=Math.max(0,site.monthlyTarget-counts.monthlyPages-pending);
  void channels; // The matched channels are the site's qualified subset; `channels` remains for API compatibility.
  const ordered=state?rankedMatches(state,site,matches,related,now,timeZone):matches.map((match,index)=>({match,index,readiness:fallbackReadiness(match.channel),usedThisMonth:false,lastUsed:Number.NEGATIVE_INFINITY}));
  const seen=new Set<string>(),candidates:CapacityCandidate[]=[];
  for(const {match:{channel},readiness} of ordered){
    if(seen.has(channel.id)||!channel.enabled||channel.free==='paid'||channel.free==='unknown'||state?.settings.channelOverrides[channel.id]===false)continue;
    seen.add(channel.id);
    let opportunity=publicationOpportunity(site,channel,tasks,now,timeZone,{officialApiConnected:readiness.kind==='ready'});
    if(readiness.kind==='handoff_required'&&opportunity.allowed)opportunity={...opportunity,allowed:false,blockingReason:'account_required',reason:'渠道符合发布条件，但尚未连接可用账号。'};
    const eligible=readiness.kind!=='handoff_required';
    const automatic=eligible&&channel.automation!=='manual'&&(readiness.kind==='ready'||readiness.kind==='autocreate');
    candidates.push({channel,opportunity,readiness,eligible,automatic});
  }
  const eligibleSchedule=fittingSchedule(site,candidates,candidate=>candidate.eligible,gap,related,now,timeZone);
  const automaticSchedule=fittingSchedule(site,candidates,candidate=>candidate.automatic,gap,related,now,timeZone);
  const eligiblePages=eligibleSchedule.scheduled.length,automaticPages=automaticSchedule.scheduled.length;
  const priority:CapacityBlockReason[]=['budget_exhausted','invalid_topic','article_rejected','topics_unknown','topics_exhausted','cadence_wait','cooldown','account_required','no_automatic_channel'];
  const automaticBlocked=candidates.filter(candidate=>candidate.channel.automation!=='manual'&&!candidate.opportunity.allowed).map(candidate=>candidate.opportunity);
  const blocker=gap>0&&automaticPages===0?priority.map(reason=>automaticBlocked.find(item=>item.blockingReason===reason)).find((item):item is NonNullable<typeof item>=>!!item):undefined;
  const deferredAt=automaticBlocked.map(item=>item.nextAvailableAt).filter((value):value is string=>!!value).sort()[0];
  const nextAvailableAt=gap>0?(automaticSchedule.scheduled[0]??eligibleSchedule.scheduled[0]??automaticSchedule.deferredAt??eligibleSchedule.deferredAt??deferredAt):undefined;
  const noAutomaticReason=eligiblePages>0?'当前有可人工安排的页面机会，但暂无可新增自动排期。':'当前没有符合条件且可执行的页面机会。';
  const cadenceReason=automaticSchedule.deferredAt?'受跨平台 7 天发布间隔限制，下一个页面机会已超出本自然月；下月会重新评估。':undefined;
  const reason=gap===0?undefined:blocker?.reason??cadenceReason??(automaticPages===0?noAutomaticReason:undefined);
  const blockingReason=gap>0&&automaticPages===0?(blocker?.blockingReason??(automaticSchedule.deferredAt?'cadence_wait':'no_automatic_channel')):undefined;
  return {siteId:site.id,currentLive:counts.currentPages,firstVerifiedThisMonth:counts.monthlyPages,currentSources:counts.currentSources,monthlySources:counts.monthlySources,missing:new Set(related.filter(task=>task.health==='missing').map(task=>sourceKey(task.sourceDomain))).size,eligibleUnused:remaining.total,automaticUnused,manualUnused,eligiblePages,automaticPages,monthsAtTarget,...(blockingReason?{blockingReason}:{}),...(nextAvailableAt?{nextAvailableAt}:{}),...(reason?{reason}:{})};
}
