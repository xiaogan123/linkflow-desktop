import {unusedSources} from '../shared/source-capacity';
import { randomUUID } from 'node:crypto';
import type { Channel, Site, SiteCapacity, Task, LinkResult } from '../shared/types';
import type { State } from './store';
import {boundAccount,channelExecutionReadiness} from './account-bindings';

export function dateKey(value:Date|string,timeZone:string):string{
  const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const part=(t:string)=>p.find(x=>x.type===t)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
export function monthKey(value:Date|string,timeZone:string){return dateKey(value,timeZone).slice(0,7)}
export function liveThisMonth(siteId:string,tasks:Task[],now:Date,timeZone:string):number{
  return new Set(tasks.filter(t=>t.siteId===siteId&&t.firstLiveAt&&monthKey(t.firstLiveAt,timeZone)===monthKey(now,timeZone)).map(t=>t.sourceDomain)).size;
}
export function currentLive(siteId:string,tasks:Task[]):number{return new Set(tasks.filter(t=>t.siteId===siteId&&t.status==='live'&&t.health==='healthy'&&t.linkCheck==='found').map(t=>t.sourceDomain)).size}
const publicationCheckpoints=new Set(['submitting','submitted','submission_uncertain','telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published']);
export function reservesSlot(t:Task,now:Date){
  if(t.firstLiveAt)return false;
  if(t.status==='review')return !(t.reviewUntil&&new Date(t.reviewUntil)<=now);
  if(t.status==='needs_input')return !!t.submittedAt||!!t.publicUrl||publicationCheckpoints.has(t.checkpoint??'');
  return t.status==='queued'||t.status==='running';
}
export function recoverInterrupted(state:State,now=new Date()){
  for(const t of state.tasks){
    const uncertain=!!t.submittedAt||['submitting','submitted','submission_uncertain'].includes(t.checkpoint||'');
    const paidAiUncertain=t.status==='running'&&!uncertain&&((['article_review','article_repair_review'].includes(t.checkpoint??'')&&t.articleReview?.status==='running')||(!t.draft&&(t.cost?.aiCalls??0)>0));
    if(paidAiUncertain){t.status='failed';t.checkpoint='system_wait';t.updatedAt=now.toISOString();t.message='上次 AI 工作在结果保存前中断；未发布，也不会在没有新证据时自动重复付费调用。';continue}
    if(t.status==='running'||(uncertain&&['queued','failed'].includes(t.status))){
      const wasRunning=t.status==='running';t.status=uncertain?'needs_input':'queued';
      if(wasRunning&&!uncertain&&t.checkpoint!=='article_repair_review')t.attempts=Math.max(0,t.attempts-1);
      t.updatedAt=now.toISOString();t.message=t.status==='needs_input'?'上次提交中断，请先检查平台结果，确认后继续。':'已恢复上次未完成的任务。';
    }
  }
}
function history(task:Task,at:string){task.history??=[];const last=task.history.at(-1);if(last?.status===task.status&&last.message===task.message&&last.linkCheck===task.linkCheck)return;task.history.push({at,status:task.status,message:task.message,linkCheck:task.linkCheck});task.history=task.history.slice(-50)}
export function expireReviews(state:State,now:Date){for(const t of state.tasks){if(t.status==='review'&&t.reviewUntil&&new Date(t.reviewUntil)<=now){t.status='expired';t.health=t.firstLiveAt?(t.linkCheck==='absent'?'missing':'unknown'):'unknown';t.message='审核期限已到，尚未确认公开外链；已释放本月名额，并保留记录供低频复查。';t.nextCheckAt=new Date(now.getTime()+7*86400000).toISOString();t.updatedAt=now.toISOString();history(t,t.updatedAt);}}}
export type Match={channel:Channel;score:number;reason:string};
export function continuesPendingRegistration(state:State,task:Task,channel:Channel,now=new Date()):boolean{
  if(task.checkpoint!=='account_registration_submitted'||task.submittedAt||channel.automation!=='browser'||!channel.emailRequired||!task.accountId)return false;
  const account=boundAccount(state,task);
  if(!account||account.id!==task.accountId||!account.hasPassword||account.credentialKind==='api_token'||['restricted','credentials_invalid'].includes(account.status))return false;
  const started=Date.parse(account.lastUsedAt??account.createdAt??task.createdAt);
  return Number.isFinite(started)&&now.getTime()-started<48*3600000;
}
export function makePlan(state:State,site:Site,matches:Match[],now=new Date()):Task[]{
  if(site.status!=='ready')return [];
  expireReviews(state,now);
  const related=state.tasks.filter(t=>t.siteId===site.id);
  const available=Math.max(0,site.monthlyTarget-liveThisMonth(site.id,related,now,state.settings.timezone)-related.filter(t=>reservesSlot(t,now)).length);
  const used=new Set(related.map(t=>t.sourceDomain));
  let hasAccountHandoff=related.some(t=>t.checkpoint==='account_handoff'&&!t.firstLiveAt&&!t.submittedAt);
  const created:Task[]=[];
  const readinessRank={ready:0,autocreate:1,handoff_required:2,manual:3} as const;
  const ordered=matches.map((match,index)=>({match,index,readiness:channelExecutionReadiness(state,site.id,match.channel)})).sort((a,b)=>readinessRank[a.readiness.kind]-readinessRank[b.readiness.kind]||b.match.score-a.match.score||a.index-b.index);
  for(const {match:{channel,reason},readiness}of ordered){
    if(created.length>=available)break;
    if(used.has(channel.domain)||channel.free==='unknown'||!['browser','api'].includes(channel.automation)||!channel.enabled||state.settings.channelOverrides[channel.id]===false)continue;
    if(readiness.kind==='handoff_required'&&hasAccountHandoff)continue;
    // Space work through the remaining natural month without carrying missed months forward.
    let when=new Date(now.getTime()+created.length*7*86400000);
    while(monthKey(when,state.settings.timezone)!==monthKey(now,state.settings.timezone)&&when>now)when=new Date(when.getTime()-86400000);
    const handoff=readiness.kind==='handoff_required';
    const t:Task={id:randomUUID(),siteId:site.id,channelId:channel.id,...(readiness.account?{accountId:readiness.account.id}:{}),sourceDomain:channel.domain,status:handoff?'needs_input':'queued',createdAt:now.toISOString(),scheduledAt:when.toISOString(),updatedAt:now.toISOString(),attempts:0,message:handoff?'需要先连接并验证现有第三方账号；其他可执行渠道会继续。':'已加入自动计划',...(handoff?{checkpoint:'account_handoff'}:{}),reason};
    state.tasks.push(t);created.push(t);used.add(channel.domain);if(handoff)hasAccountHandoff=true;
  }
  return created;
}
export function nextTask(state:State,now=new Date(),channels:Channel[]=[]):Task|undefined{
  if(!state.settings.autoRun)return;
  const priority=(task:Task)=>{const channel=channels.find(item=>item.id===task.channelId);if(!channel)return 0;if(continuesPendingRegistration(state,task,channel,now))return 0;const kind=channelExecutionReadiness(state,task.siteId,channel,task.accountId).kind;return kind==='ready'?0:kind==='autocreate'?1:kind==='handoff_required'?2:3};
  return state.tasks.filter(t=>{
    const site=state.sites.find(s=>s.id===t.siteId&&s.status==='ready');
    if(!site||t.status!=='queued'||new Date(t.scheduledAt)>now||t.attempts>=state.settings.maxAttempts||(channels.length>0&&priority(t)>1))return false;
    const room=site.monthlyTarget-liveThisMonth(t.siteId,state.tasks,now,state.settings.timezone);
    const reserved=state.tasks.filter(x=>x.siteId===site.id&&reservesSlot(x,now)).sort((a,b)=>Number(b.status!=='queued')-Number(a.status!=='queued')||priority(a)-priority(b)||a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
    return reserved.slice(0,Math.max(0,room)).some(x=>x.id===t.id);
  }).sort((a,b)=>priority(a)-priority(b)||a.scheduledAt.localeCompare(b.scheduledAt))[0];
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

export function capacityFor(site:Site,tasks:Task[],matches:Match[],channels:Channel[],now=new Date(),timeZone='UTC'):SiteCapacity{
  const related=tasks.filter(task=>task.siteId===site.id);
  const remaining=unusedSources(site.id,tasks,matches.map(item=>item.channel));
  const automaticUnused=remaining.automatic,manualUnused=remaining.manual;
  const monthsAtTarget=site.monthlyTarget>0?Math.floor(remaining.total/site.monthlyTarget):null;
  return {siteId:site.id,currentLive:currentLive(site.id,tasks),firstVerifiedThisMonth:liveThisMonth(site.id,tasks,now,timeZone),missing:new Set(related.filter(task=>task.health==='missing').map(task=>task.sourceDomain)).size,eligibleUnused:remaining.total,automaticUnused,manualUnused,monthsAtTarget,reason:remaining.total<site.monthlyTarget?'可用的未用来源不足以支持下一个完整月目标。':undefined};
}
