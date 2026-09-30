import type {Site, SiteCapacity, Task} from '../shared/types';

export type PlanningTone='green'|'blue'|'amber'|'red'|'muted';
export type PlanningState='global_paused'|'site_paused'|'analyzing'|'running'|'needs_input'|'blocked'|'review'|'due'|'scheduled'|'target_met'|'source_shortage'|'unplanned';

export interface PlanningStatus {state:PlanningState; label:string; tone:PlanningTone; next:string; detail:string}
export interface PlanningContext {autoRun:boolean; now:Date; timeZone:string; capacity?:SiteCapacity}

const parts=(date:Date,timeZone:string)=>{
  try{return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]))}
  catch{return {year:String(date.getUTCFullYear()),month:String(date.getUTCMonth()+1).padStart(2,'0'),day:String(date.getUTCDate()).padStart(2,'0'),hour:String(date.getUTCHours()).padStart(2,'0'),minute:String(date.getUTCMinutes()).padStart(2,'0')}}
};
const key=(date:Date,timeZone:string)=>{const value=parts(date,timeZone);return `${value.year}-${value.month}-${value.day}`};
const monthKey=(date:Date,timeZone:string)=>{const value=parts(date,timeZone);return `${value.year}-${value.month}`};
const validDate=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?undefined:date};
const bySchedule=(a:Task,b:Task)=>(validDate(a.scheduledAt)?.getTime()??Number.MAX_SAFE_INTEGER)-(validDate(b.scheduledAt)?.getTime()??Number.MAX_SAFE_INTEGER);
export const hasShortageMessage=(value?:string)=>Boolean(value&&/(渠道|来源|资格|可用).{0,8}(不足|短缺|没有|无)|不足.{0,8}(渠道|来源|资格|可用)/.test(value));

export function formatScheduledAt(value:string,now:Date,timeZone:string){
  const date=validDate(value);if(!date)return '计划时间待确认';
  const valueParts=parts(date,timeZone),nowParts=parts(now,timeZone);
  const clock=`${valueParts.hour}:${valueParts.minute}`;
  return key(date,timeZone)===key(now,timeZone)?`今天 ${clock}`:`${Number(valueParts.month)}月${Number(valueParts.day)}日 ${clock}`;
}

export function monthlyReset(timeZone:string,now:Date){
  const current=parts(now,timeZone),month=Number(current.month),year=Number(current.year);
  const nextMonth=month===12?1:month+1, nextYear=month===12?year+1:year;
  return {date:`${nextYear}年${nextMonth}月1日`,label:'月度目标重置',detail:'这是月度统计的重置时间；新网站分析完成并有任务后会立即开始，无需等到这一天。'};
}

export function planningStatus(site:Site,tasks:Task[],context:PlanningContext):PlanningStatus{
  const siteTasks=tasks.filter(task=>task.siteId===site.id),queued=siteTasks.filter(task=>task.status==='queued').sort(bySchedule),next=queued[0],now=context.now;
  const status=(state:PlanningState,label:string,tone:PlanningTone,nextText:string,detail:string):PlanningStatus=>({state,label,tone,next:nextText,detail});
  const queuedNext=(state:PlanningState,label:string,tone:PlanningTone,detail:string)=>{const nextAt=next&&validDate(next.scheduledAt);return nextAt&&nextAt.getTime()<=now.getTime()?status(state==='scheduled'?'due':state,label,tone,'已到期，即将执行',detail):next?status(state,label,tone,formatScheduledAt(next.scheduledAt,now,context.timeZone),detail):undefined};
  if(site.status==='paused')return status('site_paused','网站已暂停','muted','网站计划已暂停','恢复该网站后，已排任务才会继续检查。');
  if(!context.autoRun)return status('global_paused','自动已暂停','muted','全局自动计划已暂停','恢复自动执行后，系统会继续检查已排任务。');
  if(site.status==='analyzing')return status('analyzing','分析中','blue','正在分析网站','分析完成后会立即建立可用任务，不必等到下月。');
  if(siteTasks.some(task=>task.status==='running'))return status('running','正在执行','blue','正在执行任务','当前任务完成或需要人工接续后，会更新下一步。');
  const waitingInput=siteTasks.filter(task=>task.status==='needs_input');
  const waitingArticleReview=waitingInput.some(task=>task.checkpoint==='article_review');
  if(waitingInput.length&&next)return queuedNext('needs_input',waitingArticleReview?'有待审核稿件':'有待处理任务','amber',`另有 ${waitingInput.length} 项任务等待${waitingArticleReview?'审核或确认':'补充信息'}；已排任务仍会按此时间执行。`)!;
  if(waitingInput.length)return status('needs_input',waitingArticleReview?'等待审核稿件':'需要处理','amber',waitingArticleReview?'稿件等待确认':'任务等待处理',waitingArticleReview?'核对稿件后才能继续；系统不会自行越过这一步。':'完成任务所需的验证或信息后可继续。');
  const blocked=siteTasks.filter(task=>task.status==='failed'||task.status==='expired'),reviewing=siteTasks.filter(task=>task.status==='review');
  if(next&&(blocked.length||reviewing.length))return queuedNext(blocked.length?'blocked':'review',blocked.length?'有受阻任务':'有待审核结果',blocked.length?'amber':'blue',`另有 ${blocked.length+reviewing.length} 项任务受阻或等待结果；已排任务仍会按此时间执行。`)!;
  if(blocked.length)return status('blocked','任务受阻','red','有任务需要处理','已有任务保留；处理该任务后再继续。');
  if(siteTasks.some(task=>task.status==='review'&&task.checkpoint==='article_review'))return status('review','等待审核稿件','blue','稿件等待确认','核对稿件后可继续发布；系统不会自行越过这一步。');
  if(siteTasks.some(task=>task.status==='review'))return status('review','等待审核','blue','等待审核或确认','已提交任务正在等待结果，暂不重复创建相同来源。');
  if(next)return queuedNext('scheduled','已排计划','blue','已有任务已排入计划。')!;
  const finished=new Set(siteTasks.flatMap(task=>{const firstLive=task.firstLiveAt&&validDate(task.firstLiveAt);return firstLive&&monthKey(firstLive,context.timeZone)===monthKey(now,context.timeZone)?[task.sourceDomain]:[]})).size;
  if(finished>=site.monthlyTarget)return status('target_met','本月完成','green','本月目标已达','本月首次核验已达到目标。');
  const capacity=context.capacity;
  if((capacity?.eligibleUnused===0&&Boolean(capacity.reason))||hasShortageMessage(site.error)||hasShortageMessage(capacity?.reason))return status('source_shortage','渠道待补','amber','暂无可排渠道',capacity?.reason||site.error||'当前没有符合资格且未使用的渠道；已有任务不会受影响。');
  if(site.error)return status('blocked','资料需处理','amber','网站资料需要处理',site.error);
  return status('unplanned','等待计划','muted','暂无已排任务','系统会在符合资格的渠道可用时建立任务。');
}
