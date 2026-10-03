import type {ArticleReviewMode,Site, SiteCapacity, Task} from '../shared/types';
import {isUserActionTask,taskPresentation,taskWorkKind} from './presentation';

export type PlanningTone='green'|'blue'|'amber'|'red'|'muted';
export type PlanningState='global_paused'|'site_paused'|'analyzing'|'running'|'needs_input'|'system_retry'|'channel_wait'|'blocked'|'review'|'due'|'scheduled'|'target_met'|'source_shortage'|'unplanned';

export interface PlanningStatus {state:PlanningState; label:string; tone:PlanningTone; next:string; detail:string}
export interface PlanningContext {autoRun:boolean; now:Date; timeZone:string; capacity?:SiteCapacity;articleReviewMode?:ArticleReviewMode}

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
  const reviewMode=context.articleReviewMode??site.articleReviewMode??'manual';
  const status=(state:PlanningState,label:string,tone:PlanningTone,nextText:string,detail:string):PlanningStatus=>({state,label,tone,next:nextText,detail});
  const queuedNext=(state:PlanningState,label:string,tone:PlanningTone,detail:string)=>{const nextAt=next&&validDate(next.scheduledAt);return nextAt&&nextAt.getTime()<=now.getTime()?status(state==='scheduled'?'due':state,label,tone,'已到期，即将执行',detail):next?status(state,label,tone,formatScheduledAt(next.scheduledAt,now,context.timeZone),detail):undefined};
  if(site.status==='paused')return status('site_paused','网站已暂停','muted','网站计划已暂停','恢复该网站后，已排任务才会继续检查。');
  if(!context.autoRun)return status('global_paused','自动已暂停','muted','全局自动计划已暂停','恢复自动执行后，系统会继续检查已排任务。');
  if(site.status==='analyzing')return status('analyzing','分析中','blue','正在分析网站','分析完成后会立即建立可用任务，不必等到下月。');
  if(siteTasks.some(task=>task.status==='running'))return status('running','正在执行','blue','正在执行任务','当前任务完成或需要人工接续后，会更新下一步。');
  const userActions=siteTasks.filter(task=>isUserActionTask(task,reviewMode));
  const manualArticleReview=userActions.some(task=>task.checkpoint==='article_review'&&reviewMode==='manual');
  if(userActions.length&&next)return queuedNext('needs_input',manualArticleReview?'有稿件待人工审核':'有任务需要处理','amber',`另有 ${userActions.length} 项需要你处理；已排任务仍会按此时间执行。`)!;
  if(userActions.length){const first=taskPresentation(userActions[0],reviewMode);return status('needs_input',first.label,first.tone,manualArticleReview?'稿件等待人工确认':'等待你的操作',manualArticleReview?'核对稿件后才能继续；系统不会自行越过人工审核。':userActions[0].message||'完成账号、验证或人工提交后可继续。')}
  const systemWaiting=siteTasks.filter(task=>taskWorkKind(task,reviewMode)==='system_retry');
  const channelWaiting=siteTasks.filter(task=>taskWorkKind(task,reviewMode)==='channel_wait');
  const reviewing=siteTasks.filter(task=>task.status==='review');
  if(next){
    const nextPresentation=taskPresentation(next,reviewMode),passive=systemWaiting.filter(task=>task.id!==next.id).length+channelWaiting.length+reviewing.length;
    return queuedNext(nextPresentation.kind==='system_retry'?'system_retry':'scheduled',nextPresentation.kind==='system_retry'?nextPresentation.label:'已排计划','blue',passive?`另有 ${passive} 项由系统等待恢复或渠道结果；当前计划仍会按此时间推进。`:'已有任务已排入计划。')!;
  }
  if(systemWaiting.length){const first=systemWaiting[0];return status('system_retry','系统处理已暂停','muted','当前未安排自动重试',first.message||'当前任务不会自动重试；可查看具体问题，其他可执行渠道仍会继续。')}
  if(channelWaiting.length){const first=channelWaiting[0],presentation=taskPresentation(first,reviewMode);return status('channel_wait',presentation.label,'muted','当前未安排自动复查',first.message||'当前来源未发布且不会按记录日期自动复查；出现新证据后可重新评估。')}
  if(reviewing.length)return status('review','等待平台结果','blue','等待渠道确认','已提交任务正在等待平台结果，暂不重复创建相同来源。');
  const finished=new Set(siteTasks.flatMap(task=>{const firstLive=task.firstLiveAt&&validDate(task.firstLiveAt);return firstLive&&monthKey(firstLive,context.timeZone)===monthKey(now,context.timeZone)?[task.sourceDomain]:[]})).size;
  if(finished>=site.monthlyTarget)return status('target_met','本月完成','green','本月目标已达','本月首次核验已达到目标。');
  const capacity=context.capacity;
  if((capacity?.eligibleUnused===0&&Boolean(capacity.reason))||hasShortageMessage(site.error)||hasShortageMessage(capacity?.reason))return status('source_shortage','等待可用渠道','muted','暂无可排渠道',site.error||capacity?.reason||'当前没有尚未建立任务的可用渠道；系统会等待目录或执行条件变化。');
  if(site.error)return status('blocked','资料需处理','amber','网站资料需要处理',site.error);
  return status('unplanned','等待计划','muted','暂无已排任务','系统会在符合资格的渠道可用时建立任务。');
}
