import {version as APP_VERSION} from '../../package.json';
import type {Channel,Snapshot,Site,Task} from '../shared/types';
import {createHumanAction,humanActionKind,HUMAN_ACTION_TIMEOUT_MS} from '../shared/human-action';
import {ensureWritingProfile} from '../shared/writing-profile';

const now=new Date();
const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
const at=(offset:number)=>new Date(now.getTime()+offset).toISOString();
const hour=3_600_000;
const day=24*hour;
const createdAt=new Date(now.getFullYear(),now.getMonth(),1).toISOString();
const demoCopy={
  siteNames:['设计手记','实用工具','内容日记','软件指南','产品观察','学习笔记','开发问答','创作档案','商业观察','投资知识','数据工具','生活问答','阅读清单','独立项目','效率笔记'],
  description:'示例网站，用来展示自动发布进度',
  platformNames:['示例直发平台','示例账号平台','示例邮箱平台','示例验证平台','示例授权平台','示例钱包平台','示例手动平台'],
  platformNote:'示例平台，用来展示发布方式',
  articleTitle:'怎样整理一个清楚易用的网站',
  articleSummary:'从读者的问题出发，整理网站内容。',
  articleBody:'先列出读者最常问的问题，再为每个问题提供清楚的说明和可以核对的资料。',
  mailbox:'演示收信邮箱',
  capacity:'平台不够用，这篇改到之后发。',
  modelReady:'已读取本机可用模型',
};
const siteKeys=['studio','tools','journal','software','product','learning','developer','creator','business','finance','data','answers','reading','projects','focus'];
const sites:Site[]=siteKeys.map((key,index)=>({
  id:`demo-${key}`,domain:`${key}.example.com`,url:`https://${key}.example.com`,
  email:`hello@${key}.example.com`,publicEmail:`hello@${key}.example.com`,
  ...(index<3?{mailboxId:'demo-mailbox'}:{}),name:demoCopy.siteNames[index],description:demoCopy.description,
  category:index===9?'finance':index===0?'design':index===1?'software':'content',language:'zh',monthlyTarget:index===9?4:2,
  articleReviewMode:index===2||index===7?'manual':'ai',status:index===11||index===14?'paused':index===9?'attention':'ready',createdAt,
  ...(index===9?{planStatus:{month,target:4,effectiveTarget:1,capacity:1,reasonCode:'platform_capacity' as const,message:demoCopy.capacity}}:{}),
}));
// Demo sites carry real writing profiles so the style tab shows actual content.
for(const site of sites)site.writingProfile=ensureWritingProfile(site,sites);
const channels:Channel[]=demoCopy.platformNames.map((name,index)=>({
  id:`demo-platform-${index+1}`,name,domain:`platform-${index+1}.example.com`,url:`https://platform-${index+1}.example.com`,submitUrl:`https://platform-${index+1}.example.com/publish`,
  categories:['general','software','finance','content','design'],languages:['zh','en'],kind:'article',emailRequired:index===2,
  accountRequired:index>0&&index<6,articleRequired:true,free:'yes',freeNote:demoCopy.platformNote,automation:index===6?'manual':index===3?'browser':'api',
  quality:index<2?'A':'B',qualityReason:demoCopy.platformNote,rulesUrl:`https://platform-${index+1}.example.com/terms`,checkedAt:createdAt,
  notes:demoCopy.platformNote,allowedHosts:[`platform-${index+1}.example.com`],enabled:true,
  ...(index<2?{metrics:[{provider:'ahrefs-dr',value:index===0?76:91,target:`platform-${index+1}.example.com`,linkScope:index===0?'same-host' as const:'platform-root' as const,asOf:month,version:'' as const,source:'https://metrics.example.com/demo'}]}:{}),
}));
const makeTask=(id:string,siteIndex:number,status:Task['status'],extra:Partial<Task>={}):Task=>({
  id,siteId:sites[siteIndex].id,channelId:channels[siteIndex%channels.length].id,sourceDomain:channels[siteIndex%channels.length].domain,
  status,createdAt,scheduledAt:at(-hour),updatedAt:at(-5*60_000),attempts:1,message:'',cost:{aiCalls:2},...extra,
});
const draft={title:demoCopy.articleTitle,description:demoCopy.articleSummary,body:demoCopy.articleBody};
const liveTask=(id:string,siteIndex:number,extra:Partial<Task>={})=>makeTask(id,siteIndex,'live',{
  firstLiveAt:at(-hour),verifiedAt:at(-hour),lastCheckedAt:at(-5*60_000),nextCheckAt:at(day),health:'healthy',linkCheck:'found',
  publicUrl:`https://platform-${siteIndex%channels.length+1}.example.com/article/${id}`,draft,...extra,
});
const makeHumanTask=(id:string,siteIndex:number,reasonCode:NonNullable<Task['reasonCode']>,deadlineOffset:number,extra:Partial<Task>={}):Task=>{
  const value=makeTask(id,siteIndex,'needs_input',{...extra,reasonCode});
  const action=createHumanAction(value,{kind:humanActionKind(reasonCode)},new Date(now.getTime()+deadlineOffset-HUMAN_ACTION_TIMEOUT_MS));
  return {...value,humanAction:action,waitingSince:action.since,waitingDeadlineAt:action.deadline};
};
const tasks:Task[]=[
  makeTask('demo-scheduled-1',0,'queued',{scheduledAt:at(day)}),
  makeTask('demo-scheduled-2',1,'queued',{scheduledAt:at(2*day),channelId:'',sourceDomain:''}),
  makeTask('demo-writing-1',2,'running'),
  makeTask('demo-reviewing-1',3,'running',{checkpoint:'article_review',draft}),
  makeTask('demo-platform-wait-1',4,'review',{reasonCode:'submission_unknown',submittedAt:at(-hour)}),
  makeTask('demo-platform-wait-2',5,'review',{reasonCode:'submission_unknown',submittedAt:at(-2*hour)}),
  makeHumanTask('demo-human-captcha',0,'captcha_required',8*60_000),
  makeHumanTask('demo-human-agreement',1,'agreement_required',day+20*hour),
  makeHumanTask('demo-human-account',2,'account_handoff',day),
  makeHumanTask('demo-human-review',7,'manual_review',20*hour,{checkpoint:'article_review',draft}),
  makeHumanTask('demo-human-publish',6,'human_required',30*hour,{checkpoint:'manual_submission',draft}),
  liveTask('demo-live-follow',0,{linkRel:''}),
  liveTask('demo-live-nofollow',1,{linkRel:'nofollow'}),
  liveTask('demo-live-ugc',3,{linkRel:'ugc nofollow'}),
  liveTask('demo-live-sponsored',4,{linkRel:'sponsored'}),
  liveTask('demo-recheck-1',5,{health:'missing',linkCheck:'absent',consecutiveMissing:1,lostAt:at(-hour)}),
  liveTask('demo-recheck-2',6,{health:'missing',linkCheck:'absent',consecutiveMissing:2,lostAt:at(-2*hour)}),
  makeTask('demo-failed-content',8,'failed',{reasonCode:'content_rejected'}),
  makeTask('demo-failed-ai',9,'failed',{reasonCode:'ai_task_limit',cost:{aiCalls:4}}),
  makeTask('demo-skipped-human',10,'skipped',{reasonCode:'human_timeout',deferredAt:at(-day)}),
  makeTask('demo-skipped-user',11,'skipped',{reasonCode:'user_skipped',deferredAt:at(-day)}),
  makeTask('demo-expired-1',12,'expired',{reasonCode:'channel_disabled'}),
  makeTask('demo-expired-2',13,'expired',{reasonCode:'channel_ineligible'}),
  liveTask('demo-lost-3',14,{status:'failed',health:'missing',linkCheck:'absent',consecutiveMissing:3,lostAt:at(-day)}),
];
sites[0].searchReports={gsc:{checkedAt:at(-hour),method:'csv',sources:[tasks.find(task=>task.id==='demo-live-follow')!.publicUrl!],complete:true,message:'',firstSeenAt:{[tasks.find(task=>task.id==='demo-live-follow')!.publicUrl!]:at(-hour)}}};

export const demoSnapshot:Snapshot={
  sites,tasks,channels,
  accounts:[
    {id:'demo-account-1',channelId:channels[1].id,email:sites[1].email,username:'example-tools',createdAt,lastUsedAt:at(-hour),status:'registered',source:'imported',hasPassword:true},
    {id:'demo-account-2',channelId:channels[3].id,email:sites[2].email,username:'example-journal',createdAt,status:'needs_verification',source:'generated',hasPassword:true},
  ],
  mailboxes:[{id:'demo-mailbox',label:demoCopy.mailbox,host:'imap.example.com',port:993,user:'automation@example.com',secure:true,hasPassword:true,aliases:sites.slice(0,3).map(site=>site.email),createdAt,updatedAt:createdAt,verifiedAt:createdAt}],
  accountBindings:[{id:'demo-binding',siteId:sites[1].id,channelId:channels[1].id,accountId:'demo-account-1',createdAt,updatedAt:createdAt}],
  settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:true,articleReviewMode:'ai',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'imap.example.com',port:993,user:'',secure:true,hasPassword:false}},
  events:[],runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:APP_VERSION,platform:'demo',dataPath:'',aiCallsToday:3},
  capacity:sites.map((site,index)=>({
    siteId:site.id,currentLive:tasks.filter(task=>task.siteId===site.id&&task.status==='live'&&task.linkCheck==='found').length,
    firstVerifiedThisMonth:tasks.filter(task=>task.siteId===site.id&&task.firstLiveAt?.startsWith(month)).length,
    missing:tasks.filter(task=>task.siteId===site.id&&task.health==='missing').length,
    currentSources:1,monthlySources:1,eligiblePages:index===9?0:3,automaticPages:index===9?0:2,
    eligibleUnused:index===9?0:4,automaticUnused:index===9?0:3,manualUnused:1,monthsAtTarget:index===9?0:2,
    ...(index===9?{blockingReason:'account_required' as const,reason:demoCopy.capacity}:{}),
  })),
  aiModels:{provider:'codex',models:[{id:'gpt-6-sol',label:'GPT-6 Sol',source:'codex',isDefault:true,supportsReasoning:['low','medium','high']}],defaultModel:'gpt-6-sol',effectiveModel:'gpt-6-sol',source:'local-cli',discoveredAt:createdAt,message:demoCopy.modelReady},demo:true,
};
