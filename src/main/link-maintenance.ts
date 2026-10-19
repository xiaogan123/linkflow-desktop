import type {Channel,PlatformSurvival,Task} from '../shared/types';
import type {State} from './store';
import {MAINTENANCE_MESSAGES} from '../shared/maintenance-messages';
import {CHANNELS} from '../integrations/catalog';
import {channelIsTrial} from './channel-trials';

const DAY=86400000;
const RECEIPT_RECONCILE_LIMIT_CHANNELS=new Set(['tantive','shellbook','katbin','mdshare','pstrs','totpage','mdview','txtsbs','thethings','nextgen-slides','yourwebs','agentdrop','listed-startups','pastemyst','markdownpaste','slugpost','memorywiki']);
export function nextLinkCheck(task:Task,now=new Date(),archived=false):string {
  const first=Date.parse(task.firstLiveAt??task.submittedAt??task.createdAt);
  if(!archived&&Number.isFinite(first)){
    for(const days of [1,7,30])if(first+days*DAY>now.getTime())return new Date(first+days*DAY).toISOString();
  }
  return new Date(now.getTime()+30*DAY).toISOString();
}

/** Give every saved URL one upgrade check, interleaving platforms in small rounds. */
export function migrateLinkChecks(tasks:Task[],now=new Date()):void {
  const groups=new Map<string,Task[]>();
  for(const task of tasks){
    if(!task.publicUrl||task.linkRecheckVersion===1)continue;
    const group=groups.get(task.channelId)??[];group.push(task);groups.set(task.channelId,group);
  }
  let slot=0,remaining=true;
  while(remaining){
    remaining=false;
    for(const group of groups.values()){
      const task=group.shift();if(!task)continue;
      remaining=true;task.linkRecheckVersion=1;
      task.linkRecheckAt=new Date(now.getTime()+slot++*5*60000).toISOString();
    }
  }
}

function linkCheckDueAt(task:Task):number{
  const recheck=Date.parse(task.linkRecheckAt??''),last=Date.parse(task.lastCheckedAt??'');
  // Upgrade checks are one-shot. Once a later observation exists, the normal
  // cadence owns the next check even if an old migration timestamp survived.
  if(Number.isFinite(recheck)&&(!Number.isFinite(last)||last<recheck))return recheck;
  const scheduled=Date.parse(task.nextCheckAt??'');
  if(Number.isFinite(scheduled))return scheduled;
  return task.lastCheckedAt?Date.parse(nextLinkCheck(task,new Date(task.lastCheckedAt))):0;
}

function retentionByChannel(channels:readonly Channel[]):Map<string,number>{
  return new Map(channels.flatMap(channel=>channel.retentionDays===undefined?[]:[[channel.id,channel.retentionDays] as const]));
}

function temporaryPageExpired(task:Task,now:Date,retention:ReadonlyMap<string,number>):boolean{
  const days=retention.get(task.channelId),first=Date.parse(task.firstLiveAt??task.submittedAt??'');
  return days!==undefined&&Number.isFinite(first)&&first+days*DAY<=now.getTime();
}

export function dueLinkChecks(state:State,now=new Date(),limit=3,channels:readonly Channel[]=CHANNELS):Task[]{
  const available=new Set(state.sites.map(site=>site.id)),recent=new Set(state.tasks.filter(task=>task.publicUrl&&Date.parse(task.lastCheckedAt??'')>now.getTime()-15*60000).map(task=>task.channelId));
  const retention=retentionByChannel(channels);
  const trialChannels=new Set(channels.filter(channel=>channelIsTrial(channel,state.settings)).map(channel=>channel.id));
  const due=state.tasks.filter(task=>task.publicUrl&&available.has(task.siteId)&&task.status!=='running'&&
    !temporaryPageExpired(task,now,retention)&&
    !(task.firstLiveAt===undefined&&(task.reconcileAttempts??0)>=3&&RECEIPT_RECONCILE_LIMIT_CHANNELS.has(task.channelId)&&
      !(task.submittedAt&&trialChannels.has(task.channelId)))&&
    linkCheckDueAt(task)<=now.getTime())
    .sort((a,b)=>linkCheckDueAt(a)-linkCheckDueAt(b));
  const result:Task[]=[];
  for(const task of due){if(recent.has(task.channelId))continue;recent.add(task.channelId);result.push(task);if(result.length>=limit)break}
  return result;
}

export function platformSurvival(tasks:Task[],now=new Date(),channels:readonly Channel[]=CHANNELS,since?:Date):Record<string,PlatformSurvival>{
  const groups=new Map<string,Map<string,Task>>();
  const temporary=new Set(channels.filter(channel=>channel.retentionDays!==undefined).map(channel=>channel.id));
  for(const task of tasks){
    const first=Date.parse(task.firstLiveAt??'');
    if(!task.publicUrl||!Number.isFinite(first)||first>now.getTime()-30*DAY||since&&first<Date.parse(since.toISOString())||task.temporaryPage||temporary.has(task.channelId))continue;
    const group=groups.get(task.channelId)??new Map<string,Task>(),previous=group.get(task.publicUrl);
    if(!previous||Date.parse(task.lastCheckedAt??task.updatedAt)>Date.parse(previous.lastCheckedAt??previous.updatedAt))group.set(task.publicUrl,task);
    groups.set(task.channelId,group);
  }
  return Object.fromEntries([...groups].map(([id,group])=>{
    // Deduplicate first, then classify the newest observation. Otherwise an old
    // healthy row for the same URL could survive a later unreachable read.
    const sample=[...group.values()].filter(task=>task.lostAt
      ?task.linkCheck!=='unreachable'&&task.linkCheck!=='invalid'&&task.health!=='unknown'
      :task.linkCheck==='found'&&task.health==='healthy');
    const alive=sample.filter(task=>!task.lostAt).length;
    return [id,{sampleSize:sample.length,lostCount:sample.length-alive,survivalRate:sample.length?alive/sample.length:1}];
  }));
}

export function reconcilePlatformSurvival(state:State,now=new Date(),channels:readonly Channel[]=CHANNELS):void {
  const saved=state.settings.platformSurvival??={},temporary=new Set(channels.filter(channel=>channel.retentionDays!==undefined).map(channel=>channel.id));
  const allMetrics=platformSurvival(state.tasks,now,channels);
  const ids=new Set([...Object.keys(allMetrics),...Object.keys(saved)]);
  for(const id of ids){
    if(temporary.has(id))continue;
    const previous=saved[id];
    // Keep the evidence that caused an active pause stable for its todo. Later
    // recoveries or inconclusive reads must not turn it into a "0 lost" reason.
    if(previous?.pausedAt)continue;
    const metric=previous?.resumedAt
      ?platformSurvival(state.tasks,now,channels,new Date(previous.resumedAt))[id]??{sampleSize:0,lostCount:0,survivalRate:1}
      :allMetrics[id];
    if(!metric)continue;
    saved[id]={...previous,...metric};
    // An explicit recovery starts a new cohort. Its old sample cannot undo the
    // recovery, while five mature post-resume observations can pause again.
    if(metric.sampleSize>=5&&metric.survivalRate<.7&&!previous?.pausedAt){
      saved[id].pausedAt=now.toISOString();state.settings.channelOverrides[id]=false;
    }
  }
}

export function platformSurvivalTodos(state:State,channels:Channel[]){
  return Object.entries(state.settings.platformSurvival??{}).flatMap(([channelId,metric])=>metric.pausedAt?[{
    channelId,pausedAt:metric.pausedAt,message:MAINTENANCE_MESSAGES.platformPaused(channels.find(channel=>channel.id===channelId)?.name??channelId,metric.sampleSize,metric.lostCount),
  }]:[]);
}
