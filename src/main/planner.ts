import { randomUUID } from 'node:crypto';
import type { Channel, Site, Task, LinkResult } from '../shared/types';
import type { State } from './store';

export function dateKey(value:Date|string,timeZone:string):string{
  const p=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const part=(t:string)=>p.find(x=>x.type===t)!.value;return `${part('year')}-${part('month')}-${part('day')}`;
}
export function monthKey(value:Date|string,timeZone:string){return dateKey(value,timeZone).slice(0,7)}
export function liveThisMonth(siteId:string,tasks:Task[],now:Date,timeZone:string):number{
  return new Set(tasks.filter(t=>t.siteId===siteId&&t.firstLiveAt&&monthKey(t.firstLiveAt,timeZone)===monthKey(now,timeZone)).map(t=>t.sourceDomain)).size;
}
export function reservesSlot(t:Task,now:Date){return ['queued','running','needs_input','review'].includes(t.status)&&!t.firstLiveAt&&!(t.status==='review'&&t.reviewUntil&&new Date(t.reviewUntil)<=now)}
export function recoverInterrupted(state:State,now=new Date()){
  for(const t of state.tasks){
    const uncertain=!!t.submittedAt||['submitting','submitted','submission_uncertain'].includes(t.checkpoint||'');
    if(t.status==='running'||(uncertain&&['queued','failed'].includes(t.status))){
      const wasRunning=t.status==='running';t.status=uncertain?'needs_input':'queued';
      if(wasRunning&&!uncertain)t.attempts=Math.max(0,t.attempts-1);
      t.updatedAt=now.toISOString();t.message=t.status==='needs_input'?'上次提交中断，请先检查平台结果，确认后继续。':'已恢复上次未完成的任务。';
    }
  }
}
export function expireReviews(state:State,now:Date){for(const t of state.tasks){if(t.status==='review'&&t.reviewUntil&&new Date(t.reviewUntil)<=now){t.status='expired';t.message='审核超时，已释放名额；保留记录并继续低频核验。';t.updatedAt=now.toISOString();}}}
export type Match={channel:Channel;score:number;reason:string};
export function makePlan(state:State,site:Site,matches:Match[],now=new Date()):Task[]{
  if(site.status!=='ready')return [];
  expireReviews(state,now);
  const related=state.tasks.filter(t=>t.siteId===site.id);
  const available=Math.max(0,site.monthlyTarget-liveThisMonth(site.id,related,now,state.settings.timezone)-related.filter(t=>reservesSlot(t,now)).length);
  const used=new Set(related.map(t=>t.sourceDomain));
  const created:Task[]=[];
  for(const {channel,reason}of matches){
    if(created.length>=available)break;
    if(used.has(channel.domain)||channel.free==='unknown'||!['browser','api'].includes(channel.automation)||!channel.enabled||state.settings.channelOverrides[channel.id]===false)continue;
    // Space work through the remaining natural month without carrying missed months forward.
    let when=new Date(now.getTime()+created.length*7*86400000);
    while(monthKey(when,state.settings.timezone)!==monthKey(now,state.settings.timezone)&&when>now)when=new Date(when.getTime()-86400000);
    const t:Task={id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'queued',createdAt:now.toISOString(),scheduledAt:when.toISOString(),updatedAt:now.toISOString(),attempts:0,message:'已加入自动计划',reason};
    state.tasks.push(t);created.push(t);used.add(channel.domain);
  }
  return created;
}
export function nextTask(state:State,now=new Date()):Task|undefined{
  if(!state.settings.autoRun)return;
  return state.tasks.filter(t=>{
    const site=state.sites.find(s=>s.id===t.siteId&&s.status==='ready');
    if(!site||t.status!=='queued'||new Date(t.scheduledAt)>now||t.attempts>=state.settings.maxAttempts)return false;
    const room=site.monthlyTarget-liveThisMonth(t.siteId,state.tasks,now,state.settings.timezone);
    const reserved=state.tasks.filter(x=>x.siteId===site.id&&reservesSlot(x,now)).sort((a,b)=>Number(b.status!=='queued')-Number(a.status!=='queued')||a.scheduledAt.localeCompare(b.scheduledAt)||a.id.localeCompare(b.id));
    return reserved.slice(0,Math.max(0,room)).some(x=>x.id===t.id);
  }).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))[0];
}
export function markVerified(t:Task,now:Date,url:string,rel:string){t.status='live';t.publicUrl=url;t.firstLiveAt??=now.toISOString();t.verifiedAt=now.toISOString();t.lastCheckedAt=now.toISOString();t.updatedAt=now.toISOString();t.linkRel=rel;t.message='公开页面已核验，外链已生效。'}

export function applyLinkResult(task:Task,result:LinkResult,now=new Date()){
 task.lastCheckedAt=now.toISOString();task.linkCheck=result.outcome??(result.found?'found':'unreachable');
 if(result.found){if(task.checkpoint==='existing_link'){task.status='skipped';task.verifiedAt=now.toISOString();task.linkRel=result.rel;task.message='发现已有外链，保留来源记录，不计为本月新增。'}else markVerified(task,now,result.url,result.rel)}
 else{task.message=result.reason||'尚未在公开页面发现目标链接';if(task.status==='live'&&result.outcome==='absent')task.status='needs_input'}
}
