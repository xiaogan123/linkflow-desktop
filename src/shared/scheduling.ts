/** Scheduling policy is shared by the planner, execution gate and offline simulation. */
import {preferredOnlineHours,type OnlineHourRecord} from './runtime-hours';
export const SCHEDULING_DEFAULTS={
  importSitesPerDay:7,importMinDays:3,importMaxDays:21,
  firstMonthTarget:1,minSiteGapDays:3,samePlatformGapDays:30,
  publishStartMinute:9*60,publishEndMinute:23*60,overdueAfterMs:2*3600000,
  rescheduleMinDays:1,rescheduleMaxDays:3,maxReschedules:2,
  platformDailySites:1,independentPublicationDailySites:2,identityDailyPosts:1,
  platformMonthlyFloor:3,platformMonthlyShare:.25,
  publishGapMinMinutes:25,publishGapMaxMinutes:90,
  articleAiLimit:3,aiCallsPerArticle:2.5,aiSafetyMargin:1.1,
  affinityPreferredWeight:1000,affinityOtherBase:.01,affinityOtherRange:.01,minPreferredPlatforms:3,
  linkQualityFollow:1.5,linkQualityUnknown:1,linkQualityNofollow:.75,linkQualityA:1.2,linkQualityC:.9,
  historyPriorSuccesses:1,historyPriorAttempts:2,maxLookaheadDays:366,
} as const;
export const SCHEDULING_MESSAGES={
  planned:'已预留发布日期，执行前选择平台。',
  platform_capacity:'本月每站约 {effective} 条（目标 {target} 条），原因：可用平台不足。',
  missed_schedule:'错过排期，已随机改到之后有容量的日期。',
  reschedule_exhausted:'错过排期的改期次数已用完，本次名额已释放。',
  ai_daily_limit:'今日 AI 次数已用完，已分散到之后有容量的日期。',
  platform_wait:'当天暂无符合发布限制的平台，已顺延。',
  publishing_interval:'等待随机发布间隔。',
  diversity_deferred:'本任务已改到之后有容量的日期，等待调整内容。',
} as const;
export interface SchedulingMetadata {
  version:1;month:string;slot:number;target:number;effectiveTarget:number;reschedules:number;
  selectionAt?:string;publicIdentity?:string;nextPublishAt?:string;attemptedAt?:string;
}
export interface PlanCapacityStatus {month:string;target:number;effectiveTarget:number;capacity:number;reasonCode?:'platform_capacity';message:string}
export interface ScheduleSite {id:string;createdAt:string;monthlyTarget:number;timezone?:string}
export interface ScheduleEvent {supplementary?:boolean;recovered?:boolean;id:string;siteId:string;at:string;channelId?:string;identity?:string;success?:boolean;retained?:boolean;failed?:boolean;submitted?:boolean;attempted?:boolean}
export interface SchedulePlatform {id:string;dailySites?:number;monthlyLimit?:number;eligibleSiteIds?:readonly string[];linkQuality?:number;identity?:string}
export interface DayReservation {siteId:string;at:string;month:string;slot:number;target:number;effectiveTarget:number}
const DAY_MS=86400000;
export function schedulingHash(value:string):number{
  let result=2166136261;for(let i=0;i<value.length;i++){result^=value.charCodeAt(i);result=Math.imul(result,16777619)}return result>>>0;
}
export function seededSchedulingRandom(seed:string):()=>number{
  let x=schedulingHash(seed);return ()=>{x+=0x6D2B79F5;let t=x;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296};
}
const dayFormatters=new Map<string,Intl.DateTimeFormat>(),minuteFormatters=new Map<string,Intl.DateTimeFormat>();
export function schedulingDay(value:Date|string,timeZone:string):string{
  let formatter=dayFormatters.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});dayFormatters.set(timeZone,formatter)}
  const parts=formatter.formatToParts(new Date(value));
  const get=(name:string)=>parts.find(part=>part.type===name)!.value;return `${get('year')}-${get('month')}-${get('day')}`;
}
export function schedulingMinute(value:Date|string,timeZone:string):number{
  let formatter=minuteFormatters.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});minuteFormatters.set(timeZone,formatter)}
  const parts=formatter.formatToParts(new Date(value));
  return Number(parts.find(part=>part.type==='hour')!.value)*60+Number(parts.find(part=>part.type==='minute')!.value);
}
function dayNumber(day:string):number{return Math.floor(Date.parse(`${day}T00:00:00Z`)/DAY_MS)}
export function addScheduleDays(day:string,days:number):string{return new Date((dayNumber(day)+days)*DAY_MS).toISOString().slice(0,10)}
/** Convert a local calendar minute using the timezone's actual offset (including DST). */
export function localScheduleTime(day:string,minute:number,timeZone:string):Date{
  const target=Date.parse(`${day}T00:00:00Z`)+minute*60000;let stamp=target;
  for(let i=0;i<4;i++){
    const currentDay=schedulingDay(new Date(stamp),timeZone),currentMinute=schedulingMinute(new Date(stamp),timeZone);
    const observed=dayNumber(currentDay)*DAY_MS+currentMinute*60000,correction=target-observed;
    if(!correction)break;stamp+=correction;
  }
  return new Date(stamp);
}
export function randomScheduleOnDay(day:string,timeZone:string,random:()=>number=Math.random):Date{
  const span=SCHEDULING_DEFAULTS.publishEndMinute-SCHEDULING_DEFAULTS.publishStartMinute;
  let minute=SCHEDULING_DEFAULTS.publishStartMinute+Math.floor(random()*span);if(minute%60===0)minute++;
  return localScheduleTime(day,minute,timeZone);
}
export function scheduleOnPreferredHour(day:string,timeZone:string,onlineHours:readonly OnlineHourRecord[]|undefined,random:()=>number=Math.random):Date{
  const hours=preferredOnlineHours(onlineHours);
  if(!hours.length)return randomScheduleOnDay(day,timeZone,random);
  const hour=hours[Math.floor(random()*hours.length)],minute=hour*60+1+Math.floor(random()*59);
  return localScheduleTime(day,minute,timeZone);
}
export function isPublishingTime(now:Date,timeZone:string):boolean{
  const minute=schedulingMinute(now,timeZone);return minute>=SCHEDULING_DEFAULTS.publishStartMinute&&minute<SCHEDULING_DEFAULTS.publishEndMinute&&minute%60!==0;
}
export function schedulingMonthInfo(now:Date,timeZone:string):{month:string;firstDay:string;lastDay:string;days:number}{
  const month=schedulingDay(now,timeZone).slice(0,7),[year,monthIndex]=month.split('-').map(Number),days=new Date(Date.UTC(year,monthIndex,0)).getUTCDate();
  return {month,firstDay:`${month}-01`,lastDay:`${month}-${String(days).padStart(2,'0')}`,days};
}
export function importSpreadDays(siteCount:number):number{return Math.max(SCHEDULING_DEFAULTS.importMinDays,Math.min(SCHEDULING_DEFAULTS.importMaxDays,Math.ceil(siteCount/SCHEDULING_DEFAULTS.importSitesPerDay)))}
export function siteMonthTarget(site:ScheduleSite,now:Date,timeZone:string):number{
  const zone=site.timezone??timeZone;
  return schedulingDay(site.createdAt,zone).slice(0,7)===schedulingDay(now,zone).slice(0,7)?Math.min(SCHEDULING_DEFAULTS.firstMonthTarget,site.monthlyTarget):Math.max(0,Math.floor(site.monthlyTarget));
}
export function monthlyCapacity(sites:ScheduleSite[],platforms:SchedulePlatform[],now:Date,timeZone:string):{capacity:number;target:number;ratio:number;targets:Map<string,number>}{
  const {days,month}=schedulingMonthInfo(now,timeZone),dailyCapacity=platforms.reduce((sum,p)=>sum+Math.min(p.monthlyLimit??Infinity,(p.dailySites??platformDailyLimit(p.id))*days),0);
  // With at most four platforms, the actual-volume quota cannot advance beyond three posts per platform.
  const floorCapacity=platforms.reduce((sum,p)=>sum+Math.min(p.monthlyLimit??Infinity,SCHEDULING_DEFAULTS.platformMonthlyFloor),0);
  const capacity=platforms.length<=1/SCHEDULING_DEFAULTS.platformMonthlyShare?Math.min(dailyCapacity,floorCapacity):dailyCapacity;
  const targets=new Map(sites.map(site=>[site.id,platforms.some(platform=>!platform.eligibleSiteIds||platform.eligibleSiteIds.includes(site.id))?siteMonthTarget(site,now,timeZone):0]));
  const target=[...targets.values()].reduce((a,b)=>a+b,0),ratio=target>0?Math.min(1,capacity/target):1;
  if(ratio<1){
    // Largest remainders give every site the same scale, with stable hash ties.
    const shares=sites.map(site=>{const desired=targets.get(site.id)!*ratio;return {id:site.id,value:Math.floor(desired),remainder:desired%1,hash:schedulingHash(`${site.id}|${month}|capacity`)}});
    let left=capacity-shares.reduce((sum,share)=>sum+share.value,0);
    for(const share of [...shares].sort((a,b)=>b.remainder-a.remainder||a.hash-b.hash))if(left-->0)share.value++;
    for(const share of shares)targets.set(share.id,share.value);
  }
  const calendarLimit=Math.floor((days+2)/SCHEDULING_DEFAULTS.minSiteGapDays);
  for(const [id,value] of targets)targets.set(id,Math.min(value,calendarLimit));
  return {capacity,target,ratio,targets};
}
/** Reserve days only. Platforms are deliberately absent from the returned records. */
export function planMonthlyReservations(sites:ScheduleSite[],platforms:SchedulePlatform[],events:ScheduleEvent[],now:Date,timeZone:string,onlySiteId?:string,effectiveOverride?:number,onlineHours?:readonly OnlineHourRecord[]):DayReservation[]{
  const info=schedulingMonthInfo(now,timeZone),capacity=monthlyCapacity(sites,platforms,now,timeZone),result:DayReservation[]=[],loads=new Map<string,number>();
  const plannedTotal=[...capacity.targets.values()].reduce((a,b)=>a+b,0),firstDayLimit=Math.floor(plannedTotal/info.days*1.5);
  for(const event of events)if(!event.failed){const day=schedulingDay(event.at,timeZone);loads.set(day,(loads.get(day)??0)+1)}
  const order=sites.filter(site=>!onlySiteId||site.id===onlySiteId).sort((a,b)=>schedulingHash(`${a.id}|${info.month}|order`)-schedulingHash(`${b.id}|${info.month}|order`));
  for(const site of order){
    const zone=site.timezone??timeZone,local=schedulingMonthInfo(now,zone),target=siteMonthTarget(site,now,timeZone),effective=onlySiteId===site.id&&effectiveOverride!==undefined?Math.min(effectiveOverride,capacity.targets.get(site.id)??0):capacity.targets.get(site.id)??0;
    const existing=events.filter(event=>event.siteId===site.id&&!event.failed),monthEvents=existing.filter(event=>!event.supplementary&&schedulingDay(event.at,zone).startsWith(local.month));
    if(monthEvents.length>=effective)continue;
    const importDay=schedulingDay(site.createdAt,zone),spread=importSpreadDays(sites.filter(item=>schedulingDay(item.createdAt,zone)===importDay).length);
    const random=seededSchedulingRandom(`${site.id}|${local.month}|days`),anchors=existing.map(event=>Date.parse(event.at));
    let plannedForSite=0;
    for(let slot=0;slot<effective;slot++){
      if(monthEvents.length+plannedForSite>=effective)break;
      const importWindowEnd=addScheduleDays(importDay,spread);
      const openingWindowTouchesMonth=importWindowEnd>=local.firstDay;
      const initialWindow=slot===0&&!existing.length&&openingWindowTouchesMonth&&schedulingDay(now,zone)<=importWindowEnd;
      const lateFirstPost=slot===0&&!existing.length&&openingWindowTouchesMonth&&schedulingDay(now,zone)>importWindowEnd;
      const segmentStart=initialWindow?addScheduleDays(importDay,1):lateFirstPost?schedulingDay(now,zone):addScheduleDays(local.firstDay,Math.floor(slot*local.days/effective));
      const segmentEnd=initialWindow?importWindowEnd:lateFirstPost?local.lastDay:addScheduleDays(local.firstDay,Math.floor((slot+1)*local.days/effective)-1);
      if(monthEvents.some(event=>{const day=schedulingDay(event.at,zone);return day>=segmentStart&&day<=segmentEnd}))continue;
      const first=Math.max(dayNumber(segmentStart),dayNumber(schedulingDay(now,zone))),last=Math.min(dayNumber(segmentEnd),dayNumber(local.lastDay));
      if(last<first)continue;
      const choices:Array<{day:string;at:Date;noise:number;load:number}>=[];
      for(let number=first;number<=last;number++){
        const day=addScheduleDays(local.firstDay,number-dayNumber(local.firstDay));
        let at=onlineHours&&zone===timeZone?scheduleOnPreferredHour(day,zone,onlineHours,random):randomScheduleOnDay(day,zone,random);
        for(const anchor of anchors)if(anchor<=at.getTime()&&at.getTime()-anchor<SCHEDULING_DEFAULTS.minSiteGapDays*DAY_MS)at=new Date(anchor+SCHEDULING_DEFAULTS.minSiteGapDays*DAY_MS);
        if(at.getTime()<=now.getTime()||schedulingDay(at,zone)!==day||!isPublishingTime(at,zone)||anchors.some(anchor=>Math.abs(at.getTime()-anchor)<SCHEDULING_DEFAULTS.minSiteGapDays*DAY_MS))continue;
        if(day===local.firstDay&&(loads.get(day)??0)>=firstDayLimit)continue;
        choices.push({day,at,noise:random(),load:loads.get(day)??0});
      }
      // Balance across the segment, with random hash order breaking equal loads.
      const averageGap=local.days/Math.max(1,effective),lowerGap=averageGap*.7,upperGap=averageGap*1.3;
      const lastAnchor=anchors.length?Math.max(...anchors):undefined;
      const evenlySpaced=lastAnchor===undefined?choices:choices.filter(choice=>{
        const gap=(choice.at.getTime()-lastAnchor)/DAY_MS;
        return gap>=lowerGap&&gap<=upperGap;
      });
      const chosen=(evenlySpaced.length?evenlySpaced:choices).sort((a,b)=>a.load-b.load||a.noise-b.noise)[0];if(!chosen)continue;
      const at=chosen.at;if(at.getTime()<=now.getTime())continue;
      result.push({siteId:site.id,at:at.toISOString(),month:local.month,slot,target,effectiveTarget:effective});plannedForSite++;anchors.push(at.getTime());loads.set(chosen.day,(loads.get(chosen.day)??0)+1);
    }
  }
  return result;
}
export function platformDailyLimit(id:string):number{return ['blogger','wordpress-com','paragraph','leaflet','paper-wf','mataroa','verbose','prose'].includes(id)?SCHEDULING_DEFAULTS.independentPublicationDailySites:SCHEDULING_DEFAULTS.platformDailySites}
/** Stable per site/platform/last-publication variation inside the 30–45 day policy range. */
export function samePlatformGapDays(siteId:string,channelId:string,previousAt:string):number{
  return SCHEDULING_DEFAULTS.samePlatformGapDays+schedulingHash(`${siteId}|${channelId}|${previousAt.slice(0,10)}|gap`)%16;
}
export interface PlatformSelectionInput {siteId:string;platforms:SchedulePlatform[];events:ScheduleEvent[];at:Date;timeZone:string;/** Compatibility hint; actual publication evidence determines quotas and concentration. */expectedMonthlyVolume:number;random?:()=>number}
function actualMonthlyEvents(input:PlatformSelectionInput):ScheduleEvent[]{
  const month=schedulingDay(input.at,input.timeZone).slice(0,7);
  return input.events.filter(event=>event.success&&!event.failed&&!event.recovered&&event.channelId&&schedulingDay(event.at,input.timeZone).slice(0,7)===month);
}
export function eligiblePlatforms(input:PlatformSelectionInput):SchedulePlatform[]{
  const day=schedulingDay(input.at,input.timeZone),all=input.events.filter(event=>(!event.failed||event.attempted||event.success)&&event.channelId),monthEvents=actualMonthlyEvents(input);
  const publications=all.filter(event=>event.success||event.submitted&&!event.failed);
  const possibleThisMonth=publications.filter(event=>!event.recovered&&schedulingDay(event.at,input.timeZone).slice(0,7)===day.slice(0,7));
  const monthlyLimit=Math.max(SCHEDULING_DEFAULTS.platformMonthlyFloor,Math.floor((monthEvents.length+1)*SCHEDULING_DEFAULTS.platformMonthlyShare));
  return input.platforms.filter(platform=>{
    if(publications.some(event=>event.siteId===input.siteId&&Math.abs(input.at.getTime()-Date.parse(event.at))<SCHEDULING_DEFAULTS.minSiteGapDays*DAY_MS))return false;
    const events=all.filter(event=>event.channelId===platform.id),sameDay=events.filter(event=>(event.success||event.submitted||event.attempted)&&schedulingDay(event.at,input.timeZone)===day);
    if(new Set(sameDay.map(event=>event.siteId)).size>=(platform.dailySites??platformDailyLimit(platform.id)))return false;
    if(possibleThisMonth.filter(event=>event.channelId===platform.id).length>=monthlyLimit)return false;
    if(publications.some(event=>event.channelId===platform.id&&event.siteId===input.siteId&&Math.abs(input.at.getTime()-Date.parse(event.at))<samePlatformGapDays(input.siteId,platform.id,event.at)*DAY_MS))return false;
    if(platform.identity){
      const identityEvents=all.filter(event=>event.identity===platform.identity);
      if(identityEvents.some(event=>event.siteId!==input.siteId))return false;
      if(identityEvents.filter(event=>(event.success||event.submitted||event.attempted)&&schedulingDay(event.at,input.timeZone)===day).length>=SCHEDULING_DEFAULTS.identityDailyPosts)return false;
    }
    return true;
  });
}
function successRate(events:ScheduleEvent[]):number{const attempted=events.filter(event=>event.success||event.failed||event.submitted);return (attempted.filter(event=>event.success&&event.retained!==false).length+SCHEDULING_DEFAULTS.historyPriorSuccesses)/(attempted.length+SCHEDULING_DEFAULTS.historyPriorAttempts)}
function platformOverlapTooHigh(input:PlatformSelectionInput,platform:SchedulePlatform):boolean{
  const start=input.at.getTime()-90*DAY_MS,end=input.at.getTime(),bySite=new Map<string,Set<string>>();
  for(const event of input.events){
    const at=Date.parse(event.at);
    if(!event.channelId||(!event.success&&!event.submitted)||event.failed||!Number.isFinite(at)||at<start||at>end)continue;
    const used=bySite.get(event.siteId)??new Set<string>();used.add(event.channelId);bySite.set(event.siteId,used);
  }
  const selected=new Set(bySite.get(input.siteId));selected.add(platform.id);
  for(const [siteId,used] of bySite){
    if(siteId===input.siteId||!used.size)continue;
    const intersection=[...selected].filter(id=>used.has(id)).length;
    if(intersection/(selected.size+used.size-intersection)>.5)return true;
  }
  return false;
}
export function selectWeightedPlatform(input:PlatformSelectionInput):SchedulePlatform|undefined{
  const eligible=eligiblePlatforms(input);if(!eligible.length)return;
  const distinct=eligible.filter(platform=>!platformOverlapTooHigh(input,platform));
  const candidates=distinct.length?distinct:eligible;
  const monthly=actualMonthlyEvents(input),random=input.random??Math.random;
  const affinities=[...input.platforms].sort((a,b)=>schedulingHash(`${input.siteId}|${a.id}|affinity`)-schedulingHash(`${input.siteId}|${b.id}|affinity`));
  const preferred=new Set(affinities.slice(0,Math.max(SCHEDULING_DEFAULTS.minPreferredPlatforms,Math.round(Math.sqrt(input.platforms.length)))).map(item=>item.id));
  const weighted=candidates.map(platform=>{
    const history=input.events.filter(event=>event.channelId===platform.id),siteHistory=history.filter(event=>event.siteId===input.siteId),concentration=monthly.filter(event=>event.channelId===platform.id).length/Math.max(1,monthly.length);
    const affinity=preferred.has(platform.id)?SCHEDULING_DEFAULTS.affinityPreferredWeight:SCHEDULING_DEFAULTS.affinityOtherBase+(schedulingHash(`${input.siteId}|${platform.id}|weight`)%100)/100*SCHEDULING_DEFAULTS.affinityOtherRange;
    return {platform,weight:(platform.linkQuality??SCHEDULING_DEFAULTS.linkQualityUnknown)*successRate(history)*successRate(siteHistory)*Math.max(.01,1-concentration)*affinity};
  });
  let draw=random()*weighted.reduce((sum,item)=>sum+item.weight,0);for(const item of weighted){draw-=item.weight;if(draw<0)return item.platform}return weighted.at(-1)!.platform;
}
export function nextPublishGap(random:()=>number=Math.random):number{return (SCHEDULING_DEFAULTS.publishGapMinMinutes+Math.floor(random()*(SCHEDULING_DEFAULTS.publishGapMaxMinutes-SCHEDULING_DEFAULTS.publishGapMinMinutes+1)))*60000}
export function publicationGate(lastAttemptAt:string|undefined,nextPublishAt:string|undefined,now:Date,timeZone:string):Date{
  const saved=Date.parse(nextPublishAt??''),attempted=Date.parse(lastAttemptAt??'');
  // Retain a longer persisted wait, but never shorten the minimum attempt interval.
  let result=new Date(Math.max(now.getTime(),Number.isFinite(saved)?saved:0,
    Number.isFinite(attempted)?attempted+SCHEDULING_DEFAULTS.publishGapMinMinutes*60000:0));
  if(!isPublishingTime(result,timeZone)){
    const currentMinute=schedulingMinute(result,timeZone);
    if(currentMinute>=SCHEDULING_DEFAULTS.publishStartMinute&&currentMinute<SCHEDULING_DEFAULTS.publishEndMinute&&currentMinute%60===0)return new Date(result.getTime()+60000);
    const day=schedulingDay(result,timeZone),minute=schedulingMinute(result,timeZone);
    result=localScheduleTime(minute>=SCHEDULING_DEFAULTS.publishEndMinute?addScheduleDays(day,1):day,SCHEDULING_DEFAULTS.publishStartMinute+1,timeZone);
    if(result.getTime()<now.getTime())result=new Date(now.getTime()+60000);
  }
  return result;
}
/** Bounded search shared by single-task, wake-up and daily-budget deferrals. */
export function findDeferredReservation(site:ScheduleSite,platforms:SchedulePlatform[],events:ScheduleEvent[],now:Date,timeZone:string,seed:string,dailyAiLimit?:number,accept?:(at:Date)=>boolean,onlineHours?:readonly OnlineHourRecord[]):Date|undefined{
  const zone=site.timezone??timeZone,random=seededSchedulingRandom(seed),today=schedulingDay(now,zone);
  const offset=SCHEDULING_DEFAULTS.rescheduleMinDays+Math.floor(random()*(SCHEDULING_DEFAULTS.rescheduleMaxDays-SCHEDULING_DEFAULTS.rescheduleMinDays+1));
  const networkCapacity=platforms.reduce((sum,platform)=>sum+(platform.dailySites??platformDailyLimit(platform.id)),0);
  const aiCapacity=dailyAiLimit===undefined?Infinity:Math.max(1,Math.floor(dailyAiLimit/SCHEDULING_DEFAULTS.aiCallsPerArticle));
  if(networkCapacity<=0||aiCapacity<=0)return;
  const anchors=events.filter(event=>event.siteId===site.id&&!event.failed).map(event=>Date.parse(event.at));
  const gap=SCHEDULING_DEFAULTS.minSiteGapDays*DAY_MS;
  for(let i=0;i<SCHEDULING_DEFAULTS.maxLookaheadDays;i++){
    const day=addScheduleDays(today,offset+i),onDay=events.filter(event=>!event.failed&&schedulingDay(event.at,zone)===day);
    if(onDay.length>=Math.min(networkCapacity,aiCapacity))continue;
    let at=onlineHours&&zone===timeZone?scheduleOnPreferredHour(day,zone,onlineHours,random):randomScheduleOnDay(day,zone,random);
    for(const anchor of anchors)if(anchor<=at.getTime()&&at.getTime()-anchor<gap)at=new Date(anchor+gap);
    if(schedulingDay(at,zone)!==day||!isPublishingTime(at,zone)||anchors.some(anchor=>Math.abs(at.getTime()-anchor)<gap))continue;
    if(accept&&!accept(new Date(at)))continue;
    return at;
  }
}
/** Compatibility wrapper for existing callers that must retain an explicit queued date. */
export function deferredReservation(site:ScheduleSite,platforms:SchedulePlatform[],events:ScheduleEvent[],now:Date,timeZone:string,seed:string,dailyAiLimit?:number,onlineHours?:readonly OnlineHourRecord[]):Date{
  const available=findDeferredReservation(site,platforms,events,now,timeZone,seed,dailyAiLimit,undefined,onlineHours);
  if(available)return available;
  const zone=site.timezone??timeZone,today=schedulingDay(now,zone);
  return onlineHours&&zone===timeZone?scheduleOnPreferredHour(addScheduleDays(today,SCHEDULING_DEFAULTS.maxLookaheadDays),zone,onlineHours,seededSchedulingRandom(seed+'|capacity-wait')):randomScheduleOnDay(addScheduleDays(today,SCHEDULING_DEFAULTS.maxLookaheadDays),zone,seededSchedulingRandom(seed+'|capacity-wait'));
}

export function estimateDailyAiLimit(siteCount:number,monthlyTarget:number,daysInMonth=30,newSites=0):number{
  const articles=Math.max(0,siteCount)*Math.max(0,monthlyTarget)/Math.max(1,daysInMonth),analysis=Math.max(0,newSites)/Math.max(1,importSpreadDays(newSites));
  return Math.ceil((articles*SCHEDULING_DEFAULTS.aiCallsPerArticle+analysis)*SCHEDULING_DEFAULTS.aiSafetyMargin);
}
