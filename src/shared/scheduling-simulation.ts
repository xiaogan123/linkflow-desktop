import {deferredReservation,nextPublishGap,planMonthlyReservations,publicationGate,schedulingDay,seededSchedulingRandom,selectWeightedPlatform,type ScheduleEvent,type SchedulePlatform,type ScheduleSite} from './scheduling';
export interface ScheduleSimulation {events:ScheduleEvent[];reserved:number;deferred:number;released:number}
/** Offline harness; every decision delegates to the same functions used in production. */
export function simulateNetworkSchedule(sites:ScheduleSite[],platforms:SchedulePlatform[],start:Date,months=3,timeZone='UTC',seed='simulation'):ScheduleSimulation{
  const events:ScheduleEvent[]=[],random=seededSchedulingRandom(seed);let nextPublishAt:string|undefined,reserved=0,deferred=0,released=0;
  for(let monthIndex=0;monthIndex<months;monthIndex++){
    const current=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+monthIndex,1)),month=schedulingDay(current,timeZone).slice(0,7);
    const reservations=planMonthlyReservations(sites,platforms,events,current,timeZone),pending=reservations.map((slot,index)=>({...slot,id:`${month}-${index}`,reschedules:0}));reserved+=pending.length;
    const expectedMonthlyVolume=pending.length;
    while(pending.length){
      pending.sort((a,b)=>a.at.localeCompare(b.at));const slot=pending.shift()!,site=sites.find(item=>item.id===slot.siteId)!,zone=site.timezone??timeZone;
      let at=publicationGate(undefined,nextPublishAt,new Date(slot.at),zone);
      if(schedulingDay(at,zone).slice(0,7)!==month){released++;continue;}
      const candidates=platforms.map(platform=>({...platform,identity:`${platform.id}:site:${site.id}`}));
      const selected=selectWeightedPlatform({siteId:site.id,platforms:candidates,events,at,timeZone:zone,expectedMonthlyVolume,random});
      if(!selected){
        if(slot.reschedules>=2){released++;continue;}
        at=deferredReservation(site,platforms,events,at,zone,`${seed}|${slot.id}|${slot.reschedules}`);
        if(schedulingDay(at,zone).slice(0,7)!==month){released++;continue;}
        pending.push({...slot,at:at.toISOString(),reschedules:slot.reschedules+1});deferred++;continue;
      }
      events.push({id:slot.id,siteId:site.id,at:at.toISOString(),channelId:selected.id,identity:selected.identity,success:true,submitted:true});
      nextPublishAt=new Date(at.getTime()+nextPublishGap(random)).toISOString();
    }
  }
  return {events,reserved,deferred,released};
}
export function medianPlatformJaccard(events:ScheduleEvent[],siteIds:string[]):number{
  const sets=new Map(siteIds.map(id=>[id,new Set(events.filter(event=>event.siteId===id&&event.channelId).map(event=>event.channelId!))]));
  const pairs:number[]=[];
  for(let i=0;i<siteIds.length;i++)for(let j=i+1;j<siteIds.length;j++){
    const a=sets.get(siteIds[i])!,b=sets.get(siteIds[j])!,union=new Set([...a,...b]).size;
    if(union)pairs.push([...a].filter(id=>b.has(id)).length/union);
  }
  pairs.sort((a,b)=>a-b);return pairs.length?pairs[Math.floor(pairs.length/2)]:0;
}
