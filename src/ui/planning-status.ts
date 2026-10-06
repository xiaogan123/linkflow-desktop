import type {ArticleReviewMode,CapacityBlockReason,Site, SiteCapacity, Task} from '../shared/types';
import {publicationCounts,reservesMonthlySlot} from '../shared/publication';
import {isUserActionTask,taskAutomaticFollowupAt,taskHasAutomaticFollowup,taskPresentation,taskWorkKind} from './presentation';

export type PlanningTone='green'|'blue'|'amber'|'red'|'muted';
export type PlanningState='global_paused'|'site_paused'|'analyzing'|'running'|'needs_input'|'system_retry'|'channel_wait'|'blocked'|'review'|'due'|'scheduled'|'target_met'|'source_shortage'|'unplanned';

export interface PlanningStatus {state:PlanningState; label:string; tone:PlanningTone; next:string; detail:string}
export interface PlanningContext {autoRun:boolean; now:Date; timeZone:string; capacity?:SiteCapacity;articleReviewMode?:ArticleReviewMode;channelEnabled?:(task:Task)=>boolean}
export interface MonthlyPageProgress {verified:number;unverified:number;planned:number;unplanned:number}

const parts=(date:Date,timeZone:string)=>{
  try{return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]))}
  catch{return {year:String(date.getUTCFullYear()),month:String(date.getUTCMonth()+1).padStart(2,'0'),day:String(date.getUTCDate()).padStart(2,'0'),hour:String(date.getUTCHours()).padStart(2,'0'),minute:String(date.getUTCMinutes()).padStart(2,'0')}}
};
const key=(date:Date,timeZone:string)=>{const value=parts(date,timeZone);return `${value.year}-${value.month}-${value.day}`};
const validDate=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?undefined:date};
const bySchedule=(a:Task,b:Task)=>(validDate(a.scheduledAt)?.getTime()??Number.MAX_SAFE_INTEGER)-(validDate(b.scheduledAt)?.getTime()??Number.MAX_SAFE_INTEGER);
export const hasShortageMessage=(value?:string)=>Boolean(value&&/(渠道|来源|资格|可用).{0,8}(不足|短缺|没有|无)|不足.{0,8}(渠道|来源|资格|可用)/.test(value));

export function monthlyPageProgress(site:Site,tasks:Task[],now:Date,timeZone:string):MonthlyPageProgress{
  const verified=publicationCounts(site.id,tasks,now,timeZone).monthlyPages;
  const unverified=Math.max(0,site.monthlyTarget-verified);
  const reserved=tasks.filter(task=>task.siteId===site.id&&reservesMonthlySlot(task,now,timeZone)).length;
  const planned=Math.min(unverified,reserved);
  return {verified,unverified,planned,unplanned:unverified-planned};
}
export function remainingMonthlyPages(site:Site,tasks:Task[],now:Date,timeZone:string){return monthlyPageProgress(site,tasks,now,timeZone).unplanned}

const capacityCopy:Record<CapacityBlockReason,{label:string;next:string;detail:string;tone:PlanningTone}>={
  topics_unknown:{label:'暂无机会 · 选题待取得',next:'等待网站选题',detail:'尚未取得可去重的真实页面；取得选题后会自动继续。',tone:'muted'},
  topics_exhausted:{label:'暂无机会 · 选题已用完',next:'等待网站新页面',detail:'已发现的真实页面都已用于发布；网站出现新页面后再继续。',tone:'muted'},
  cadence_wait:{label:'发布间隔未到',next:'下次时间待确认',detail:'当前平台的发布间隔未到，到期后会自动继续。',tone:'blue'},
  account_required:{label:'暂无机会 · 账号未连接',next:'需要连接可用账号',detail:'当前自动渠道还没有可用账号；连接后才能排期。',tone:'amber'},
  article_rejected:{label:'稿件核对未通过',next:'查看核对原因',detail:'稿件核对未通过，当前自动恢复已停止；其他可用渠道仍会继续。',tone:'amber'},
  invalid_topic:{label:'需要新的文章选题',next:'当前选题不可用于发文',detail:'已排除说明页和非文章页面；取得有效选题后才能继续。',tone:'muted'},
  cooldown:{label:'渠道冷却中',next:'恢复时间待确认',detail:'当前渠道正在冷却，到期后会重新评估。',tone:'muted'},
  budget_exhausted:{label:'自动处理额度不足',next:'当前没有自动后续',detail:'剩余 AI 调用额度不足以完成下一轮处理，已停止该任务的自动尝试。',tone:'muted'},
  no_automatic_channel:{label:'暂无机会 · 没有自动渠道',next:'当前无可自动发布的平台',detail:'当前没有同时符合免费、规则与自动执行条件的渠道。',tone:'muted'},
};

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
  const siteTasks=tasks.filter(task=>task.siteId===site.id),now=context.now;
  const reviewMode=context.articleReviewMode??site.articleReviewMode??'manual';
  const channelEnabled=(task:Task)=>context.channelEnabled?.(task)??true;
  const queued=siteTasks.filter(task=>task.status==='queued'&&channelEnabled(task)).sort(bySchedule),next=queued[0];
  const status=(state:PlanningState,label:string,tone:PlanningTone,nextText:string,detail:string):PlanningStatus=>({state,label,tone,next:nextText,detail});
  const queuedNext=(state:PlanningState,label:string,tone:PlanningTone,detail:string)=>{const nextAt=next&&validDate(next.scheduledAt);return nextAt&&nextAt.getTime()<=now.getTime()?status(state==='scheduled'?'due':state,label,tone,'已到期，即将执行',detail):next?status(state,label,tone,formatScheduledAt(next.scheduledAt,now,context.timeZone),detail):undefined};
  if(site.status==='paused')return status('site_paused','网站已暂停','muted','网站计划已暂停','恢复该网站后，已排任务才会继续检查。');
  if(site.status==='attention')return status('blocked','资料需处理','amber','网站资料需要处理',site.error||'网站分析未完成，请重新分析。');
  if(!context.autoRun)return status('global_paused','自动已暂停','muted','全局自动计划已暂停','恢复自动执行后，系统会继续检查已排任务。');
  if(site.status==='analyzing')return status('analyzing','分析中','blue','正在分析网站','分析完成后会立即建立可用任务，不必等到下月。');
  if(siteTasks.some(task=>task.status==='running'))return status('running','正在执行','blue','正在执行任务','当前任务完成或需要人工接续后，会更新下一步。');
  const userActions=siteTasks.filter(task=>isUserActionTask(task,reviewMode,channelEnabled(task)));
  const manualArticleReview=userActions.some(task=>task.checkpoint==='article_review'&&reviewMode==='manual');
  if(userActions.length&&next)return queuedNext('needs_input',manualArticleReview?'有稿件待人工审核':'有任务需要处理','amber',`另有 ${userActions.length} 项需要你处理；已排任务仍会按此时间执行。`)!;
  if(userActions.length){const first=taskPresentation(userActions[0],reviewMode,channelEnabled(userActions[0]));return status('needs_input',first.label,first.tone,manualArticleReview?'稿件等待人工确认':'等待你的操作',manualArticleReview?'核对稿件后才能继续；系统不会自行越过人工审核。':userActions[0].message||'完成账号、验证或人工提交后可继续。')}
  const systemWaiting=siteTasks.filter(task=>taskWorkKind(task,reviewMode,channelEnabled(task))==='system_retry');
  const channelWaiting=siteTasks.filter(task=>taskWorkKind(task,reviewMode,channelEnabled(task))==='channel_wait');
  const reviewing=siteTasks.filter(task=>task.status==='review');
  if(next){
    const nextPresentation=taskPresentation(next,reviewMode,channelEnabled(next)),passive=systemWaiting.filter(task=>task.id!==next.id).length+channelWaiting.length+reviewing.length;
    return queuedNext(nextPresentation.kind==='system_retry'?'system_retry':'scheduled',nextPresentation.kind==='system_retry'?nextPresentation.label:'已排计划','blue',passive?`另有 ${passive} 项由系统等待恢复或渠道结果；当前计划仍会按此时间推进。`:'已有任务已排入计划。')!;
  }
  const automaticSystem=systemWaiting.filter(task=>taskHasAutomaticFollowup(task,channelEnabled(task))).sort((a,b)=>(validDate(taskAutomaticFollowupAt(a,channelEnabled(a))??'')?.getTime()??0)-(validDate(taskAutomaticFollowupAt(b,channelEnabled(b))??'')?.getTime()??0));
  if(automaticSystem.length){const first=automaticSystem[0],presentation=taskPresentation(first,reviewMode,channelEnabled(first)),at=taskAutomaticFollowupAt(first,channelEnabled(first));return status('system_retry',presentation.label,'blue',at?formatScheduledAt(at,now,context.timeZone):'即将自动查询',first.message||'已安排自动恢复或结果查询，期间不会重复发布。')}
  const automaticChannel=channelWaiting.filter(task=>taskHasAutomaticFollowup(task,channelEnabled(task))).sort((a,b)=>(validDate(taskAutomaticFollowupAt(a,channelEnabled(a))??'')?.getTime()??0)-(validDate(taskAutomaticFollowupAt(b,channelEnabled(b))??'')?.getTime()??0));
  if(automaticChannel.length){const first=automaticChannel[0],presentation=taskPresentation(first,reviewMode,channelEnabled(first)),at=taskAutomaticFollowupAt(first,channelEnabled(first));return status('channel_wait',presentation.label,'blue',at?formatScheduledAt(at,now,context.timeZone):'已安排自动复查',first.message||'已安排后续检查，其他可执行任务会继续。')}
  if(reviewing.length)return status('review','等待平台结果','blue','等待渠道确认','已提交任务正在等待平台结果，暂不重复创建相同来源。');
  const counts=publicationCounts(site.id,tasks,now,context.timeZone);
  if(counts.monthlyPages>=site.monthlyTarget)return status('target_met','本月完成','green','本月目标已达','本月新发布且已核验的页面数已达到目标。');
  const progress=monthlyPageProgress(site,tasks,now,context.timeZone),gap=progress.unplanned,capacity=context.capacity;
  if(site.error&&!hasShortageMessage(site.error)&&!capacity)return status('blocked','资料需处理','amber','网站资料需要处理',site.error);
  if((capacity?.automaticPages??0)>0){const at=capacity?.nextAvailableAt&&validDate(capacity.nextAvailableAt);return status('unplanned','等待建立计划','blue',at?formatScheduledAt(at.toISOString(),now,context.timeZone):'即将检查可排机会',`本月还有 ${progress.unverified} 个页面尚未核验；${gap} 个尚待建立计划，当前有 ${capacity?.automaticPages} 个自动发布机会。`)}
  if(capacity?.blockingReason){const copy=capacityCopy[capacity.blockingReason],automaticTime=['cadence_wait','cooldown'].includes(capacity.blockingReason),at=automaticTime&&capacity.nextAvailableAt?validDate(capacity.nextAvailableAt):undefined;return status('source_shortage',copy.label,copy.tone,at?formatScheduledAt(at.toISOString(),now,context.timeZone):copy.next,capacity.reason||copy.detail)}
  if(!capacity&&hasShortageMessage(site.error))return status('source_shortage','等待可用渠道','muted','暂无可排渠道',site.error||'当前没有可排的自动发布机会。');
  if(systemWaiting.length){const first=systemWaiting[0];return status('system_retry','系统处理已暂停','muted','当前未安排自动重试',first.message||'当前任务不会自动重试；其他可执行渠道仍会继续。')}
  if(channelWaiting.length){const first=channelWaiting[0],presentation=taskPresentation(first,reviewMode,channelEnabled(first));return status('channel_wait',presentation.label,'muted','当前未安排自动复查',first.message||'当前来源未发布且未安排自动复查；出现新证据后可重新评估。')}
  if(site.error&&!capacity)return status('blocked','资料需处理','amber','网站资料需要处理',site.error);
  return status('unplanned','等待计划','muted','暂无已排任务',`本月还有 ${progress.unverified} 个页面尚未核验；${gap} 个尚待建立计划。`);
}
