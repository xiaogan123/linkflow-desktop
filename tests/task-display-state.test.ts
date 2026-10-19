import {BATCH9B_MESSAGES} from '../src/shared/batch9b-messages';
import test from 'node:test';
import assert from 'node:assert/strict';
import {version} from '../package.json';
import {TASK_REASON_CODES,type TaskReasonCode} from '../src/shared/task-reasons';
import {createHumanAction,validHumanAction} from '../src/shared/human-action';
import type {Task} from '../src/shared/types';
import {demoSnapshot} from '../src/ui/demo';
import {
  canRetryTaskManually,compareHumanActionTasks,taskDisplayState,taskHumanActionDeadline,taskHumanActionGroup,
  taskHumanActionUrgent,taskReasonForDisplay,type TaskDisplayInput,type TaskDisplayStateName,
} from '../src/ui/presentation';

const now=new Date('2026-10-18T10:00:00.000Z');
const at=(milliseconds:number)=>new Date(now.getTime()+milliseconds).toISOString();
const hour=3_600_000;
const base=(extra:Partial<TaskDisplayInput>={}):TaskDisplayInput=>({
  id:'task-1',siteId:'site-1',channelId:'example-platform',sourceDomain:'platform.example.com',status:'queued',
  createdAt:at(-hour),scheduledAt:at(hour),updatedAt:at(-hour),attempts:1,message:'私人技术信息，不得出现在进展里',...extra,
});
// Simulate a previously saved snapshot with an incomplete humanAction shape.
const oldAction=(extra:Partial<TaskDisplayInput>,humanAction:{kind:string;deadline?:string;deadlineAt?:string;expiresAt?:string;createdAt?:string}):TaskDisplayInput=>
  ({...base(extra),humanAction} as unknown as TaskDisplayInput);
const reasons:Record<TaskReasonCode,string>={
  analysis_daily_limit:'今日网站分析次数已用完，明天继续。',
  ai_daily_limit:'今天的 AI 次数用完了，这篇改到 10月18日 写。',
  ai_rate_limited:'AI 服务暂时限制请求频率，1 小时 后再试。',
  ai_task_limit:'这篇用了 4 次 AI 仍没通过复核，先放弃，换一篇重写。',
  content_rejected:'AI 复核没通过：内容不符合要求。这个平台 45 天内不再给这个站发。',
  duplicate_content:'和已发过的文章太像，已换一个角度重写。',
  evidence_insufficient:'网站资料不够支撑这篇文章，已换一篇。',
  evidence_truncated:'这次没读全网站内容，不是稿件的问题，稍后重试。',
  format_repair_exhausted:BATCH9B_MESSAGES.formatStopped,
  format_invalid:'稿件格式不符合这个平台的要求，已重新整理。',
  platform_rejected:'平台拒绝了这篇文章。这个平台 30 天内不再给这个站发。',
  platform_rate_limited:'平台暂时限制发布频率，1 小时 后再试。',
  temporary_failure:'网络或服务暂时不可用，稍后自动重试。',
  human_required:'这一步需要你来完成：按提示完成这一步。',
  captcha_required:'注册需要你过一次人机验证，大约 30 秒。',
  phone_required:'这个平台注册要手机号验证，已跳过，改用其他平台。',
  agreement_required:'需要你确认一次平台条款。',
  account_handoff:'需要你连接一次platform.example.com账号。',
  manual_review:'稿子写好了，等你看一眼。',
  email_code_pending:'等验证邮件',
  human_timeout:'2 天没处理，已先跳过，改用其他平台；14 天后可再用这个平台。',
  channel_disabled:'这个平台已停用，已改用其他平台。',
  channel_ineligible:'这个平台不适合这个站，已改用其他平台。',
  user_skipped:'你跳过了这篇；30 天后可再用这个平台。',
  submission_unknown:'不确定这篇有没有发出去，外链助手正在检查原来的提交，不会重发。',
  invalid_topic:'选的文章页不适合写稿（比如注册页），已换一篇。',
  referral_blocked:'稿件里有邀请码或推荐链接，已删除；删不干净的这篇不发。',
  diversity_deferred:'今天同类文章已经够多，这篇改到之后发。',
  unknown:'这篇没做成，已改用其他平台。',
  platform_capacity:'平台不够用，这篇改到之后发。',
  schedule_missed:'错过了发布时间，已自动改期。',
  review_changes_requested:'AI 复核要求修改，正在重新整理稿件。',
};

test('all reason codes use approved mapped copy and never expose saved technical messages',()=>{
  assert.deepEqual(Object.keys(reasons).sort(),[...TASK_REASON_CODES].sort());
  for(const reasonCode of TASK_REASON_CODES){
    const task=base({reasonCode,cost:{aiCalls:4},status:'failed'});
    assert.equal(taskReasonForDisplay(task,now),reasons[reasonCode],reasonCode);
    const presentation=taskDisplayState(task,now);
    assert.doesNotMatch(JSON.stringify(presentation),/私人技术信息|不得出现在进展/);
    assert.equal(presentation.state,reasonCode==='submission_unknown'?'in_progress':'failed',reasonCode);
    // A stopped task never repeats a reason that promises an automatic retry.
    const stopped=['temporary_failure','platform_rate_limited','evidence_truncated','ai_rate_limited'].includes(reasonCode);
    const workStopped=['ai_daily_limit','format_invalid','diversity_deferred','platform_capacity','schedule_missed','review_changes_requested'].includes(reasonCode);
    if(reasonCode!=='submission_unknown')assert.equal(presentation.detail,stopped?'暂时性故障重试几次仍没成功，这篇已停下。':workStopped?'这篇已停下，不会再自动处理。':reasons[reasonCode],reasonCode);
  }
});

test('AI service rate limiting shows a bounded retry without adding a display state',()=>{
  const task=base({status:'failed',reasonCode:'ai_rate_limited',checkpoint:'system_wait',nextCheckAt:at(hour),recoveryEligible:true,recoveryAttempts:0});
  assert.equal(taskReasonForDisplay(task,now),reasons.ai_rate_limited);
  const retry=taskDisplayState(task,now);
  assert.equal(retry.state,'scheduled');
  assert.equal(retry.label,'已排期');
  assert.match(retry.detail,/发$/);
  // Once its one recovery is used, the task has stopped: it no longer says it will try again.
  assert.deepEqual(taskDisplayState({...task,recoveryAttempts:1},now),{state:'failed',label:'没做成',detail:'暂时性故障重试几次仍没成功，这篇已停下。',deadlineText:'已改用其他平台'});
});

test('scheduled boundary and unknown platform use one state function without changing a task',()=>{
  const task=base({channelId:'',sourceDomain:''});
  const saved=JSON.stringify(task);
  const before=taskDisplayState(task,new Date(Date.parse(task.scheduledAt)-1));
  assert.equal(before.state,'scheduled');
  assert.match(before.detail,/10月18日 \d{2}:\d{2} 发 · 发布前确定平台$/);
  assert.equal(taskDisplayState(task,task.scheduledAt).state,'in_progress');
  assert.equal(taskDisplayState(task,Date.parse(task.scheduledAt)+1).detail,'写稿中');
  assert.equal(JSON.stringify(task),saved);
  assert.deepEqual(taskDisplayState(task,now),taskDisplayState(task,now.getTime()));
  assert.equal(taskDisplayState(base({scheduledAt:'invalid'}),now).state,'in_progress');
  assert.equal(taskReasonForDisplay(base(),now),'');
  assert.equal(taskReasonForDisplay(base({status:'live',firstLiveAt:at(-hour)}),now),'');
  const selection=base({scheduling:{version:1,month:'2026-10',slot:1,target:2,effectiveTarget:2,reschedules:0,selectionAt:at(30*60_000)}});
  assert.match(taskDisplayState(selection,now).detail,/ · 发布前确定平台$/);
  assert.doesNotMatch(taskDisplayState(selection,at(30*60_000)).detail,/发布前确定平台/);
});

test('the five current steps all stay in progress and carry no generic publication action',()=>{
  const cases:[Partial<TaskDisplayInput>,string][]=[
    [{status:'running'},'写稿中'],
    [{status:'running',checkpoint:'article_review'},'AI 复核中'],
    [{status:'running',checkpoint:'example_publish'},'发布中'],
    [{status:'review'},'等平台结果'],
    [{status:'running',checkpoint:'waiting_email'},'等验证邮件'],
  ];
  for(const [extra,detail] of cases){
    assert.deepEqual(taskDisplayState(base(extra),now),{state:'in_progress',label:'进行中',detail});
  }
});

test('legacy display action aliases classify the four todo groups and choose their exact button',()=>{
  const cases:[string,string,string][]=[
    ['captcha','verification','去验证'],['verification','verification','去验证'],['agreement','verification','去确认'],
    ['account_handoff','account','去连接'],['connect-account','account','去连接'],
    ['manual_review','review','看稿'],['article_review','review','看稿'],
    ['manual_publish','manual_publish','去处理'],['manual_submission','manual_publish','去处理'],
  ];
  for(const [kind,group,action] of cases){
    const task=oldAction({status:'needs_input'},{kind,deadline:at(44*hour)});
    assert.equal(taskHumanActionGroup(task,now),group,kind);
    assert.deepEqual([taskDisplayState(task,now).state,taskDisplayState(task,now).action],['action_required',action],kind);
    assert.equal(taskDisplayState(task,now).deadlineText,group==='review'?'还剩 1 天 20 小时，到期放弃这篇':'还剩 1 天 20 小时，到期自动换平台',kind);
  }
  assert.equal(taskHumanActionGroup(base(),now),undefined);
});

test('real human actions use their typed reason and deadline',()=>{
  const source=base({status:'needs_input',reasonCode:'agreement_required'});
  const action=createHumanAction(source,{kind:'consent'},new Date(now.getTime()-47*hour));
  const task={...source,humanAction:action,waitingDeadlineAt:at(5*60_000)};
  assert.equal(validHumanAction(action),true);
  assert.equal(taskHumanActionGroup(task,now),'verification');
  assert.equal(taskDisplayState(task,now).action,'去确认');
  assert.equal(taskHumanActionDeadline(task),now.getTime()+hour);
  assert.equal(taskHumanActionUrgent(task,now),false);
  const account=base({status:'needs_input',humanAction:createHumanAction(source,{kind:'account_login'},now)});
  assert.equal(taskHumanActionGroup(account,now),'account');
  assert.equal(taskDisplayState(account,now).action,'去连接');
  const phone=base({status:'needs_input',humanAction:createHumanAction(source,{kind:'phone'},now)});
  assert.equal(taskDisplayState(phone,now).state,'failed');
});

test('automatic email waiting stays in progress while email confirmation and ambiguity need a person',()=>{
  const emailWait:NonNullable<Task['emailWait']>={kind:'code',recipient:'owner@example.com',since:now.toISOString(),nextPollAt:at(60_000),expiresAt:at(15*60_000),consumedMessageIds:[],continuation:'browser'};
  const automatic=base({status:'needs_input',checkpoint:'waiting_email',emailWait,reasonCode:undefined});
  assert.deepEqual(taskDisplayState(automatic,now),{state:'in_progress',label:'进行中',detail:'等验证邮件'});
  assert.equal(taskHumanActionGroup(automatic,now),undefined);
  assert.equal(taskHumanActionUrgent(automatic,now),false);
  for(const kind of ['email_confirmation','email_code_ambiguous'] as const){
    const pending=base({status:'needs_input',checkpoint:kind,reasonCode:'human_required'});
    pending.humanAction=createHumanAction(pending,{kind},now);
    assert.equal(taskDisplayState(pending,now).state,'action_required',kind);
    assert.equal(taskHumanActionGroup(pending,now),'verification',kind);
  }
});

test('reason-only human tasks and legacy structured reasons remain compatible',()=>{
  for(const [reasonCode,action] of Object.entries({human_required:'去处理',captcha_required:'去验证',agreement_required:'去确认',account_handoff:'去连接',manual_review:'看稿'})){
    const task=base({status:'needs_input',reasonCode:reasonCode as TaskReasonCode});
    assert.equal(taskDisplayState(task,now).state,'action_required');
    assert.equal(taskDisplayState(task,now).action,action);
  }
  const legacy={...base({status:'failed'}),reasonCode:'evidence_fetch_failed'} as unknown as TaskDisplayInput;
  assert.equal(taskReasonForDisplay(legacy,now),reasons.temporary_failure);
  const oldReview=base({status:'failed',articleReview:{status:'failed',reason:'不要显示这段服务错误',reasonCode:'evidence_invalid',evidenceUrls:[],draftRevision:1,contentHash:'',contextHash:''}});
  assert.equal(taskReasonForDisplay(oldReview,now),reasons.evidence_insufficient);
  assert.equal(taskDisplayState(base({status:'needs_input',checkpoint:'account_handoff'}),now).action,'去连接');
  assert.equal(taskDisplayState(base({status:'needs_input',reasonCode:'phone_required'}),now).state,'failed');
  assert.equal(taskDisplayState(base({status:'needs_input',reasonCode:'temporary_failure'}),now).state,'in_progress');
  assert.equal(taskDisplayState({...oldReview,status:'needs_input',checkpoint:'account_handoff'},now).action,'去连接');
  assert.equal(taskReasonForDisplay(base({reasonCode:'account_handoff',platformName:'示例平台'}),now),'需要你连接一次示例平台账号。');
  assert.deepEqual(taskDisplayState(base({status:'needs_input',checkpoint:'email_code_pending',reasonCode:'email_code_pending'}),now),{state:'in_progress',label:'进行中',detail:'等验证邮件'});
});

test('deadline boundaries clamp countdowns, prefer explicit dates and sort urgent actions first',()=>{
  const task=oldAction({status:'needs_input',reasonCode:'manual_review',waitingDeadlineAt:at(2*hour)},{kind:'manual_review',deadline:at(10*60_000)});
  assert.equal(taskHumanActionDeadline(task),now.getTime()+10*60_000);
  assert.equal(taskHumanActionUrgent(task,new Date(now.getTime()-1)),false);
  assert.equal(taskHumanActionUrgent(task,now),true);
  assert.equal(taskDisplayState(task,at(10*60_000)).deadlineText,'还剩 0 分钟，到期放弃这篇');
  assert.equal(taskDisplayState(task,at(11*60_000)).deadlineText,'还剩 0 分钟，到期放弃这篇');
  assert.equal(taskDisplayState(task,at(9*60_000+1)).deadlineText,'还剩 1 分钟，到期放弃这篇');
  assert.equal(taskHumanActionDeadline(base({status:'needs_input',reasonCode:'captcha_required',waitingSince:now.toISOString()})),now.getTime()+10*60_000);
  assert.equal(taskHumanActionDeadline(base({status:'needs_input',reasonCode:'manual_review',waitingSince:now.toISOString()})),now.getTime()+48*hour);
  assert.equal(taskHumanActionDeadline(oldAction({status:'needs_input'},{kind:'captcha',deadlineAt:at(hour)})),now.getTime()+hour);
  assert.equal(taskHumanActionDeadline(oldAction({status:'needs_input'},{kind:'manual_review',createdAt:now.toISOString()})),now.getTime()+48*hour);
  const later=oldAction({...task,id:'later'},{kind:'manual_review',deadline:at(2*hour)});
  assert.ok(compareHumanActionTasks(task,later,now)<0);
  assert.deepEqual([later,task].sort((a,b)=>compareHumanActionTasks(a,b,now)).map(value=>value.id),[task.id,later.id]);
  assert.equal(taskHumanActionUrgent({...task,status:'skipped',reasonCode:'human_timeout'},now),false);
});

test('published states distinguish link attributes and require three consecutive missing checks',()=>{
  const task=base({status:'live',firstLiveAt:at(-hour),publicUrl:'https://platform.example.com/article',health:'healthy',linkCheck:'found'});
  assert.match(taskDisplayState(task,now).detail,/ · 属性待查$/);
  for(const linkRel of ['', 'follow'])assert.match(taskDisplayState({...task,linkRel},now).detail,/ · 可传权重$/);
  for(const linkRel of ['nofollow','ugc','sponsored','noopener nofollow noreferrer'])assert.match(taskDisplayState({...task,linkRel},now).detail,/ · 不传权重$/);
  for(const consecutiveMissing of [0,1,2]){
    const state=taskDisplayState({...task,status:'failed',health:'missing',linkCheck:'absent',nextCheckAt:at(24*hour),consecutiveMissing},now);
    assert.equal(state.state,'published_recheck');
    assert.equal(state.detail,'这次没检查到链接，10月19日再查');
  }
  for(const consecutiveMissing of [3,4])assert.deepEqual(taskDisplayState({...task,health:'missing',linkCheck:'absent',consecutiveMissing},now),{state:'failed',label:'没做成',detail:'外链找不到了'});
  assert.equal(taskDisplayState({...task,lostAt:at(-hour),consecutiveMissing:3},now).state,'published');
  assert.equal(taskDisplayState({...task,health:'unknown',linkCheck:'unreachable'},now).state,'published_recheck');
});

test('unknown submitted results never expose a retry while legacy safety helpers keep their contract',()=>{
  for(const status of ['needs_input','failed','skipped'] as const){
    const task=base({status,reasonCode:'submission_unknown',submittedAt:at(-hour),checkpoint:'submitting'});
    assert.deepEqual(taskDisplayState(task,now),{state:'in_progress',label:'进行中',detail:'等平台结果'});
    assert.equal(canRetryTaskManually(task),false);
  }
  for(const reasonCode of ['human_timeout','user_skipped'] as const){
    const task=base({status:'skipped',reasonCode});
    assert.equal(taskDisplayState(task,now).action,undefined);
    assert.notEqual(taskDisplayState(task,now).deadlineText,'可以恢复');
  }
  assert.equal(taskDisplayState(base({status:'skipped',reasonCode:'user_skipped',deferredAt:at(-hour)}),now).action,'恢复');
  assert.equal(taskDisplayState(base({status:'failed',reasonCode:'channel_disabled'}),now).deadlineText,'已改用其他平台');
  const recovery=base({status:'failed',reasonCode:'temporary_failure',checkpoint:'system_wait',nextCheckAt:at(hour),recoveryEligible:true,recoveryAttempts:0,cost:{aiCalls:2}});
  assert.equal(taskDisplayState(recovery,now).state,'scheduled');
  assert.equal(taskDisplayState({...recovery,recoveryAttempts:1},now).state,'failed');
});

test('demo has fifteen private-safe example websites, all six states, todo groups and weight evidence',()=>{
  assert.equal(demoSnapshot.sites.length,15);
  assert.equal(new Set(demoSnapshot.sites.map(site=>site.domain)).size,15);
  for(const site of demoSnapshot.sites)assert.match(site.domain,/\.example\.com$/);
  const counts=new Map<TaskDisplayStateName,number>();
  const statuses=new Map<Task['status'],number>();
  const groups=new Set<string>();
  for(const task of demoSnapshot.tasks){
    if(task.humanAction){assert.equal(validHumanAction(task.humanAction),true);assert.equal(task.humanAction.platform,task.channelId)}
    const state=taskDisplayState(task,new Date());
    counts.set(state.state,(counts.get(state.state)??0)+1);
    statuses.set(task.status,(statuses.get(task.status)??0)+1);
    const group=taskHumanActionGroup(task,new Date());
    if(group)groups.add(group);
  }
  assert.equal(counts.size,6);
  for(const [state,count] of counts)assert.ok(count>=2,`${state}: ${count}`);
  for(const [status,count] of statuses)assert.ok(count>=2,`${status}: ${count}`);
  assert.deepEqual([...groups].sort(),['account','manual_publish','review','verification']);
  assert.ok(demoSnapshot.tasks.some(task=>task.linkRel===''));
  assert.ok(demoSnapshot.tasks.some(task=>task.linkRel==='nofollow'));
  assert.ok(demoSnapshot.tasks.some(task=>task.linkRel==='sponsored'));
  assert.ok(demoSnapshot.tasks.some(task=>task.linkRel?.includes('ugc')));
  assert.ok(demoSnapshot.channels.some(channel=>channel.metrics?.some(metric=>metric.linkScope==='same-host')));
  assert.ok(demoSnapshot.channels.some(channel=>channel.metrics?.some(metric=>metric.linkScope==='platform-root')));
  assert.ok(demoSnapshot.channels.some(channel=>!channel.metrics?.length));
  assert.ok(demoSnapshot.sites.some(site=>site.planStatus&&site.planStatus.effectiveTarget<site.planStatus.target));
  assert.equal(demoSnapshot.runtime.version,version);
  const allUrls=JSON.stringify(demoSnapshot).match(/https?:\/\/[^\s"\\]+/g)??[];
  for(const url of allUrls)assert.ok(new URL(url).hostname.endsWith('.example.com'),url);
});

test('a failed recheck overrides the stale found result without inventing a future check date',()=>{
 const task=base({status:'live',firstLiveAt:at(-hour),health:'unknown',linkCheck:'found'});
 assert.deepEqual(taskDisplayState(task,now),{state:'published_recheck',label:'已发布·待复查',detail:'这次没检查到链接，等待下次检查'});
});

test('expired publications do not reuse an older positive readback as current evidence',()=>{
 const task=base({status:'expired',checkpoint:'yourwebs_expired',firstLiveAt:at(-hour),health:'pending',linkCheck:'found',linkRel:''});
 assert.deepEqual(taskDisplayState(task,now),{state:'failed',label:'没做成',detail:'外链已到期'});
});
