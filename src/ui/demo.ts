import {CHANNELS} from '../integrations/catalog';
import type {Snapshot, Site, Task} from '../shared/types';

const month = new Date().toISOString().slice(0,7);
const sites:Site[] = [
  {id:'demo-studio',domain:'studio.example',url:'https://studio.example',email:'hello@studio.example',publicEmail:'hello@studio.example',mailboxId:'demo-mailbox',name:'Studio',description:'独立设计工作室',category:'design',language:'zh',monthlyTarget:2,status:'ready',createdAt:month+'-01'},
  {id:'demo-tools',domain:'tools.example',url:'https://tools.example',email:'hello@tools.example',publicEmail:'hello@tools.example',mailboxId:'demo-mailbox',name:'Tools',description:'实用在线工具',category:'software',language:'zh',monthlyTarget:2,status:'ready',createdAt:month+'-01'},
  {id:'demo-journal',domain:'journal.example',url:'https://journal.example',email:'hello@journal.example',publicEmail:'hello@journal.example',name:'Journal',description:'内容创作网站',category:'content',language:'zh',monthlyTarget:2,status:'attention',createdAt:month+'-01'},
];
const task = (id:string,siteId:string,status:Task['status'],sourceDomain:string,live=false):Task => ({id,siteId,channelId:'demo-directory',sourceDomain,status,createdAt:month+'-03',scheduledAt:month+'-05',updatedAt:month+'-05',attempts:1,checkpoint:status==='needs_input'?'account_registration_submitted':undefined,message:status==='needs_input'?'请前往邮箱完成验证':'演示任务',firstLiveAt:live?month+'-06':undefined,publicUrl:live?'https://'+sourceDomain+'/example':undefined});
export const demoSnapshot:Snapshot = {
  sites,
  tasks:[task('d1','demo-studio','live','catalog.example',true),task('d2','demo-studio','review','listing.example'),task('d3','demo-tools','live','directory.example',true),task('d4','demo-tools','live','community.example',true),task('d5','demo-journal','needs_input','profiles.example')],
  channels:CHANNELS,
  accounts:[{id:'demo-account-github',channelId:'github',email:'hello@tools.example',username:'tools-studio',createdAt:month+'-02',lastUsedAt:month+'-05',status:'registered',source:'generated',hasPassword:true},{id:'demo-account-dev',channelId:'substack',email:'hello@journal.example',username:'journal-studio',createdAt:month+'-03',status:'needs_verification',source:'generated',hasPassword:true}],
  mailboxes:[{id:'demo-mailbox',label:'演示验证邮箱',host:'imap.example.test',port:993,user:'automation@example.test',secure:true,hasPassword:true,aliases:['hello@studio.example','hello@tools.example'],createdAt:month+'-01',updatedAt:month+'-01',verifiedAt:month+'-02'}],
  accountBindings:[{id:'demo-binding',siteId:'demo-tools',channelId:'github',accountId:'demo-account-github',createdAt:month+'-02',updatedAt:month+'-02'}],
  settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:true,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'imap.gmail.com',port:993,user:'',secure:true,hasPassword:false}},
  events:[],runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'1.1.0',platform:'demo',dataPath:'',aiCallsToday:3},capacity:[{siteId:'demo-studio',currentLive:1,firstVerifiedThisMonth:1,missing:1,eligibleUnused:2,automaticUnused:1,manualUnused:1,monthsAtTarget:2},{siteId:'demo-tools',currentLive:2,firstVerifiedThisMonth:2,missing:0,eligibleUnused:3,automaticUnused:1,manualUnused:2,monthsAtTarget:3},{siteId:'demo-journal',currentLive:0,firstVerifiedThisMonth:0,missing:2,eligibleUnused:1,automaticUnused:1,manualUnused:0,monthsAtTarget:0,reason:'当前资格下还缺 1 个新来源'}],aiModels:{provider:'codex',models:[{id:'gpt-6-sol',label:'GPT-6 Sol',source:'codex',isDefault:true,supportsReasoning:['low','medium','high']}],defaultModel:'gpt-6-sol',effectiveModel:'gpt-6-sol',source:'local-cli',discoveredAt:month+'-02',message:'已读取本机 Codex 可用模型'},demo:true
};
