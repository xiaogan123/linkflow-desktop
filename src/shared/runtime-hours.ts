import {addScheduleDays,schedulingDay,schedulingMinute} from './scheduling';

export interface OnlineHourRecord {day:string;mask:number}
export interface OnlineHourSettings {timezone:string;onlineHours?:OnlineHourRecord[]}
export interface MissedPublication {missedPublicationAt?:string}

/** One bit per local hour; retain only the current day and the preceding thirteen. */
export function recordOnlineHour(settings:OnlineHourSettings,now:Date):boolean{
  const day=schedulingDay(now,settings.timezone),hour=Math.floor(schedulingMinute(now,settings.timezone)/60);
  const earliest=addScheduleDays(day,-13),records=(settings.onlineHours??[])
    .filter(record=>record.day>=earliest&&record.day<=day&&Number.isInteger(record.mask)&&record.mask>=0&&record.mask<=0xffffff)
    .map(record=>({...record}));
  const current=records.find(record=>record.day===day);
  const bit=1<<hour,changed=!current||!(current.mask&bit);
  if(current)current.mask|=bit;else records.push({day,mask:bit});
  settings.onlineHours=records.sort((a,b)=>a.day.localeCompare(b.day));
  return changed;
}

/** True when every local hour from `from` up to `to` was recorded as online; a gap means the app was closed or asleep.
 * The hour containing `to` counts as online: the caller is running now, and the tick may not have recorded that hour yet. */
export function onlineThroughout(settings:OnlineHourSettings,from:Date,to:Date):boolean{
  const masks=new Map((settings.onlineHours??[]).map(record=>[record.day,record.mask]));
  const slot=(moment:Date)=>({day:schedulingDay(moment,settings.timezone),hour:Math.floor(schedulingMinute(moment,settings.timezone)/60)});
  const current=slot(to);
  for(let at=from.getTime();at<=to.getTime();at+=3600000){
    const {day,hour}=slot(new Date(at));
    if(day===current.day&&hour===current.hour)return true;
    if(!((masks.get(day)??0)&(1<<hour)))return false;
  }
  return true;
}

export function onlineHoursLast7Days(settings:OnlineHourSettings,now:Date):number{
  const today=schedulingDay(now,settings.timezone),earliest=addScheduleDays(today,-6);
  return (settings.onlineHours??[]).filter(record=>record.day>=earliest&&record.day<=today)
    .reduce((total,record)=>total+bitCount(record.mask&0xffffff),0);
}

function bitCount(value:number):number{let count=0;for(let bits=value;bits;bits&=bits-1)count++;return count}

export function missedPublicationsLast7Days(tasks:readonly MissedPublication[],now:Date):number{
  const earliest=now.getTime()-7*86400000;
  return tasks.filter(task=>{const at=Date.parse(task.missedPublicationAt??'');return Number.isFinite(at)&&at>=earliest&&at<=now.getTime()}).length;
}

/** Recent observed hours guide future scheduling without storing a minute-level usage history. */
export function preferredOnlineHours(records:readonly OnlineHourRecord[]|undefined):number[]{
  const latest=records?.reduce((day,record)=>record.day>day?record.day:day,'')??'';
  if(!latest)return [];
  const earliest=addScheduleDays(latest,-6),weights=Array<number>(24).fill(0);
  for(const record of records??[])if(record.day>=earliest&&record.day<=latest)
    for(let hour=9;hour<23;hour++)if(record.mask&(1<<hour))weights[hour]++;
  return weights.flatMap((weight,hour)=>Array<number>(weight).fill(hour));
}
