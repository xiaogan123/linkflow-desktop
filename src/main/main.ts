import { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray, nativeImage, safeStorage, systemPreferences, powerMonitor } from 'electron';
import { dirname, join } from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Store, defaultSettings } from './store';
import { Vault, encryptBackup, decryptBackup } from './vault';
import {connectBlogger,listBloggerBlogs,bindBloggerBlog,disconnectBlogger} from './blogger-management';
import { Controller } from './controller';
import { AddSite, EditSite, SettingsPatch, AccountInput, AccountRetry, getId, normalizeDomain, publicUrl, safeMessage } from './validation';
import { validateBackup } from './backup-validation';
import { recoverInterrupted, earliestPublicationAt, monthKey } from './planner';
import {publicationOpportunity,hasBloggerDraftReceipt} from '../shared/publication';
import {resumeDeferredTask} from './task-recovery';
import { IPC_COMMANDS, type Site, type Account } from '../shared/types';
import {CHANNELS} from '../integrations/catalog';
import {belongsToSource} from '../integrations/web';
import {eligibilityFor} from '../integrations/eligibility';
import {parseGscLinksCsv} from '../integrations/search-reports';
import { discoverModels, normalizeApiBase, scopedApiSecrets, testAi } from '../integrations/ai';
import { codexEnvironment, resolveCodexLaunch } from '../integrations/codex-process';
import { testMail, testMailbox } from '../integrations/mail';
import {deleteMailbox,prepareMailboxTest} from './mail-settings';
import { prepareSelfTest, runPackagedSelfTest } from './self-test';
import {bindAccount,unbindAccount,channelExecutionReadiness} from './account-bindings';
import {deleteCustomChannel,importChannelMetrics,saveCustomChannel} from '../integrations/channel-library';
import {openInPreferredBrowser} from './external-browser';
import {LocalBackups} from './maintenance';
import {UpdateManager} from './update-manager';
import {macApplicationPath} from './update-install';
import {resolveMacUpdateTarget} from './update-mac-target';
import {UPDATE_PUBLIC_KEY_SPKI_BASE64} from '../shared/update-trust';
import {importMailboxesAtomic,saveMailboxAtomic} from './mailbox-service';
import {saveAccountAtomic} from './account-service';
import {saveSettingsAtomic} from './settings-service';
import {loginItemReadOptions,withLoginItemPreference} from './login-item';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {channelDiscoveryFor} from '../integrations/channel-discovery';
import {isAllowedTaskUrl} from '../integrations/browser';
import {applySiteUpdate} from './site-service';
import {applyChannelPolicyDecision,canConfirmMissingPolicy} from './channel-policy';
import {saveTaskDraft} from './task-draft';

app.setName('外链助手');
const selfTest=prepareSelfTest();
if(process.env.LINKFLOW_DATA_DIR&&!app.isPackaged&&!selfTest)app.setPath('userData',process.env.LINKFLOW_DATA_DIR);
const single=app.requestSingleInstanceLock();
if(!single)app.quit();
let win:BrowserWindow|null=null,tray:Tray|null=null,quitting=false,restoring=false,updating=false,runtimeStarted=false,controller:Controller,localBackups:LocalBackups,updater:UpdateManager,maintenanceTimer:ReturnType<typeof setInterval>|undefined;
const activeCommands=new Set<symbol>();
let bloggerConnect:AbortController|undefined;
const root=join(__dirname,'..');
const file=join(root,'dist/index.html');
const devUrl=!app.isPackaged?process.env.LINKFLOW_DEV_URL:undefined;
let renderURL=devUrl||pathToFileURL(file).href;
const MailboxPayload=z.object({id:z.string().uuid().optional(),label:z.string().min(1).max(100),host:z.string().max(253),port:z.number().int().min(1).max(65535),user:z.email().max(254),secure:z.literal(true),password:z.string().max(1024).optional(),aliases:z.array(z.email().max(254)).max(1000).optional(),siteIds:z.array(z.string().uuid()).max(1000).optional()}).strict();

function broadcast(){if(win&&!win.isDestroyed())win.webContents.send('linkflow:changed')}
function createWindow(){
  win=new BrowserWindow({width:1487,height:1058,minWidth:1050,minHeight:720,show:false,title:'外链助手 · LINKFLOW',backgroundColor:'#f8faff',titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',trafficLightPosition:{x:16,y:16},webPreferences:{preload:join(root,'dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==renderURL)event.preventDefault()});
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.on('close',event=>{if(!quitting&&tray){event.preventDefault();win?.hide()}});
  win.on('closed',()=>{win=null});
  const created=win;
  created.webContents.once('did-finish-load',()=>{
    if(!app.isPackaged||selfTest)return;
    void (async()=>{for(let i=0;i<100&&!created.isDestroyed();i++){
      if(await created.webContents.executeJavaScript('!!window.linkflow && !!document.querySelector("h1")').catch(()=>false)){await updater.acknowledgeStartup();return}
      await new Promise(done=>setTimeout(done,100));
    }})().catch(()=>{/* The updater retains the recovery copy if startup cannot be confirmed. */});
  });
  void created.loadURL(renderURL);created.once('ready-to-show',()=>created.show());
}
async function confirmSecret(){
  if(process.platform==='darwin'&&systemPreferences.canPromptTouchID()){await systemPreferences.promptTouchID('查看外链助手保存的密码');return;}
  const r=await dialog.showMessageBox(win!,{type:'question',title:'显示密码',message:'将在当前屏幕显示保存的密码。',buttons:['取消','显示密码'],defaultId:0,cancelId:0});if(r.response!==1)throw Error('已取消');
}
function forbidBusy(){if(controller.hasPendingWork())throw Error('请先暂停执行，等待当前操作结束后再修改。')}
function ensureRestoreIdle(){if(controller.store.read().settings.autoRun||controller.hasPendingWork())throw Error('恢复备份前请暂停自动执行，并等待分析或核验完成。')}
async function detectAi(){
  const s=controller.store.read().settings;
  if(s.provider==='api'){controller.runtime.aiReady=s.hasApiKey&&!!s.model;broadcast();return;}
  // Read only auth status. No inference call or key-file reading on startup.
  try{const launch=resolveCodexLaunch(s.codexPath);const ok=await new Promise<boolean>(resolve=>{let output='';const p=spawn(launch.command,[...launch.prefixArgs,'login','status'],{stdio:['ignore','pipe','pipe'],shell:false,env:codexEnvironment(process.env,launch.envAdditions)});const timeout=setTimeout(()=>{p.kill();resolve(false)},10000);p.stdout.on('data',d=>{output+=d.toString().slice(0,2000)});p.stderr.on('data',d=>{output+=d.toString().slice(0,2000)});p.on('error',()=>{clearTimeout(timeout);resolve(false)});p.on('close',code=>{clearTimeout(timeout);resolve(code===0&&!/not logged in/i.test(output))})});controller.runtime.aiReady=ok;}catch{controller.runtime.aiReady=false}broadcast();
}
async function command(name:string,p:unknown):Promise<unknown>{
  const {store,vault}=controller;
  if(restoring)throw Error('正在恢复备份，完成前不能执行其他操作');
  if(updating&&name!=='app:update-status'&&name!=='snapshot')throw Error('正在准备更新安装，请等待应用重启');
  if((name.startsWith('app:')&&name.endsWith('update'))||name==='app:update-status')z.object({}).strict().parse(p??{});
  switch(name){
    case 'snapshot':return controller.snapshot();
    case 'site:add':{
      const data=AddSite.parse(p),address=normalizeDomain(data.domain),state=store.read();if(state.sites.some(s=>s.domain===address.domain))throw Error('这个网站已经添加');
      const site:Site={id:randomUUID(),...address,email:data.email,publicEmail:data.email,name:address.domain,description:'',category:'general',language:'en',monthlyTarget:data.monthlyTarget,articleReviewMode:getArticleReviewMode(data,state.settings),status:'analyzing',createdAt:new Date().toISOString()};
      store.update(s=>s.sites.push(site));void controller.analyze(site.id);break;
    }
    case 'site:update':{forbidBusy();const input=EditSite.parse(p);let modeChanged=false;store.update(s=>{modeChanged=applySiteUpdate(s,input).reviewModeChanged});const state=store.read(),site=state.sites.find(item=>item.id===input.id);if(modeChanged&&site&&getArticleReviewMode(site,state.settings)==='ai')controller.resumeArticleReviews(input.id);controller.plan();if(modeChanged)void controller.tick();break;}
    case 'site:confirm-channel-policy':{
      forbidBusy();const d=z.object({id:z.string().uuid(),channelId:z.string().max(100)}).strict().parse(p),site=store.read().sites.find(item=>item.id===d.id),channel=controller.channels().find(item=>item.id===d.channelId);
      if(!site||!channel||!canConfirmMissingPolicy(channel))throw Error('网站或渠道不能进行此确认');
      const result=await dialog.showMessageBox(win!,{type:'question',title:'渠道使用确认',message:'是否允许 '+site.domain+' 使用 '+channel.name+'？',detail:'已核对官方接口与产品说明，但尚未找到适用的完整内容政策。确认仅适用于这个网站和当前渠道资料，有效期90天。每篇仍须独立AI审核事实、作者关系、佣金披露、独立价值和金融风险；明确违规、证据抓取失败或内容未知仍停止。平台可能删除内容或限制账号。此确认不表示AI已确认平台内容政策。',buttons:['取消','确认使用','撤回确认'],defaultId:0,cancelId:0});
      if(result.response===0)return;forbidBusy();const currentChannel=controller.channels().find(item=>item.id===d.channelId);if(!currentChannel)throw Error('渠道已不存在');
      store.update(state=>applyChannelPolicyDecision(state,d.id,currentChannel,result.response===1));if(result.response===1)void controller.tick();break;
    }
    case 'site:queue-channel':{
      forbidBusy();const d=z.object({id:z.string().uuid(),channelId:z.string().max(100)}).parse(p);const s=store.read(),site=s.sites.find(x=>x.id===d.id),channel=controller.channels().find(c=>c.id===d.channelId);
      if(!site||!channel)throw Error('网站或渠道不存在');if(site.status!=='ready')throw Error('请先完成网站分析并恢复计划');
      const fit=eligibilityFor(site,channel),candidate=channelDiscoveryFor(site,channel);if(channel.automation==='manual'?!candidate.canQueue:!fit.eligible)throw Error(channel.automation==='manual'?candidate.nextStep:fit.reason);if(channel.automation!=='manual'&&(channel.free==='unknown'||channel.free==='paid'))throw Error('该渠道不符合自动免费计划条件');
      const opportunity=publicationOpportunity(site,channel.automation==='manual'?{...channel,free:'yes'}:channel,s.tasks,new Date(),s.settings.timezone,{officialApiConnected:channelExecutionReadiness(s,site.id,channel).kind==='ready'});if(!opportunity.allowed)throw Error(opportunity.reason);
      const instant=new Date(),scheduled=earliestPublicationAt(site.id,channel.id,s.tasks,new Date(opportunity.scheduledAt??instant.toISOString()));if(monthKey(scheduled,s.settings.timezone)!==monthKey(instant,s.settings.timezone))throw Error('本月发布间隔已排满，最早可于 '+scheduled.toLocaleDateString('zh-CN',{timeZone:s.settings.timezone})+' 安排；系统将按新月目标继续。');
      const now=instant.toISOString();store.update(x=>x.tasks.push({id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.id==='blogger'&&site.blogger?new URL(site.blogger.url).hostname:channel.domain,status:channel.automation==='manual'?'needs_input':'queued',createdAt:now,scheduledAt:scheduled.toISOString(),...(opportunity.topicUrl?{topicUrl:opportunity.topicUrl}:{}),updatedAt:now,attempts:0,message:channel.automation==='manual'?(channel.free==='paid'?'付费渠道仅建立人工待办；软件不会付款或自动提交':'可生成材料，按平台规则人工提交'):'已加入计划',reason:channel.automation==='manual'?`${candidate.reason} ${candidate.nextStep}`:fit.reason,health:'pending',history:[],cost:{aiCalls:0}}));void controller.tick();break;
    }
    case 'site:adopt-gist':{forbidBusy();const d=z.object({id:z.string().uuid(),url:z.string().trim().max(2048),accountId:z.string().uuid().optional()}).parse(p);await controller.adoptGist(d.id,d.url,d.accountId);break;}
    case 'account:connect-blogger':{
      z.object({}).strict().parse(p??{});if(bloggerConnect)throw Error('Blogger连接正在进行');
      return controller.manageIdentity(async()=>{const abort=new AbortController();bloggerConnect=abort;
        try{const chosen=await dialog.showOpenDialog(win!,{title:'选择Google OAuth桌面客户端配置',properties:['openFile'],filters:[{name:'Google OAuth JSON',extensions:['json']}]});
          if(chosen.canceled||!chosen.filePaths[0]||abort.signal.aborted)return undefined;
          const info=await stat(chosen.filePaths[0]);if(!info.isFile()||info.size>65536)throw Error('客户端配置文件无效或过大');
          const config=await readFile(chosen.filePaths[0],'utf8');
          const result=await connectBlogger(store,vault,config,{signal:abort.signal,openExternal:url=>openInPreferredBrowser(url,store.read().settings.preferredBrowser,value=>shell.openExternal(value))});
          return result.account;
        }finally{if(bloggerConnect===abort)bloggerConnect=undefined}
      });
    }
    case 'account:cancel-blogger':z.object({}).strict().parse(p??{});bloggerConnect?.abort();return {cancelled:true};
    case 'account:blogger-blogs':{const d=z.object({accountId:z.string().uuid()}).strict().parse(p);return controller.manageIdentity(()=>listBloggerBlogs(store,vault,d.accountId));}
    case 'site:bind-blogger':{const d=z.object({siteId:z.string().uuid(),accountId:z.string().uuid(),blogId:z.string().regex(/^\d{1,64}$/)}).strict().parse(p);return controller.manageIdentity(()=>bindBloggerBlog(store,vault,d.siteId,d.accountId,d.blogId));}
    case 'account:disconnect-blogger':{const d=z.object({accountId:z.string().uuid()}).strict().parse(p);return controller.manageIdentity(async()=>{await disconnectBlogger(store,vault,d.accountId);return {disconnected:true}});}
    case 'account:connect-gist':{forbidBusy();const d=z.object({token:z.string().trim().min(8).max(512),accountId:z.string().uuid().optional()}).parse(p);return await controller.connectGist(d.token,d.accountId);}
    case 'search:save-key':{forbidBusy();const {key,enabled}=z.object({key:z.string().min(1).max(1024),enabled:z.boolean()}).parse(p);await vault.set('bingKey',key.trim());store.update(s=>{s.settings.hasBingKey=true;s.settings.monitorSearch=enabled});break;}
    case 'search:bing':await controller.checkSearch(getId(p));break;
    case 'search:import-gsc':{
      const id=getId(p),site=store.read().sites.find(s=>s.id===id);if(!site)throw Error('网站不存在');const file=await dialog.showOpenDialog(win!,{title:'选择 '+site.domain+' 的 GSC 外部链接来源 CSV',properties:['openFile'],filters:[{name:'GSC CSV',extensions:['csv']}]});if(file.canceled)return;
      const report=parseGscLinksCsv(await readFile(file.filePaths[0],'utf8'));
      const confirm=await dialog.showMessageBox(win!,{type:'question',message:'确认这是 '+site.domain+' 的 GSC 外部链接报告？',detail:'CSV 本身不包含可校验的网站归属。仅导入来源网页，不提交索引。',buttons:['取消','导入'],defaultId:0,cancelId:0});if(confirm.response!==1)return;
      store.update(s=>{const x=s.sites.find(s=>s.id===id);if(x)x.searchReports={...x.searchReports,gsc:report}});break;
    }
    case 'site:delete':controller.deleteSite(getId(p));break;
    case 'site:pause':{const d=z.object({id:z.string().uuid(),paused:z.boolean()}).parse(p);controller.sitePause(d.id,d.paused);break;}
    case 'site:analyze':forbidBusy();void controller.analyze(getId(p));break;
    case 'task:approve':{forbidBusy();const id=getId(p),state=store.read(),task=state.tasks.find(t=>t.id===id),site=task?state.sites.find(item=>item.id===task.siteId):undefined;if(!task?.draft?.body||!site||(task.submittedAt&&!hasBloggerDraftReceipt(task))||task.checkpoint!=='article_review')throw Error('当前没有待确认文章');const aiMode=getArticleReviewMode(site,state.settings)==='ai';controller.patch(id,{articleApprovedAt:new Date().toISOString(),articleReview:undefined,status:'queued',scheduledAt:new Date().toISOString(),message:aiMode?'人工已检查，仍需 AI 独立核对后才会发布':'文章已确认，等待发布'});void controller.tick();break;}
    case 'task:retry':{
      const id=getId(p),t=store.read().tasks.find(t=>t.id===id);if(!t)throw Error('任务不存在');if(t.status==='running')throw Error('任务正在执行');
      if(t.firstLiveAt)throw Error('此渠道已获得过外链，可核验现有结果，无需重复提交');
      if(t.submittedAt&&!hasBloggerDraftReceipt(t)||t.checkpoint==='submitting'){if(t.publicUrl){await controller.verify(id);break;}throw Error('已有提交记录。请打开平台检查结果，并填写公开结果网址后核验；不会重复投稿。');}
      if(t.deferredAt){store.update(state=>resumeDeferredTask(state.tasks,id,state.settings));void controller.tick();break;}
      if(t.attempts>=store.read().settings.maxAttempts)throw Error('已达重试上限，请检查原因或跳过此渠道。');
      controller.patch(id,{status:'queued',scheduledAt:new Date().toISOString(),message:'准备继续执行'});void controller.tick();break;
    }
    case 'task:skip':{const id=getId(p);if(controller.runtime.activeTaskId===id)throw Error('请先暂停当前任务');controller.patch(id,{status:'skipped',message:'已跳过，保留记录避免重复提交'});controller.plan();break;}
    case 'task:verify':await controller.verify(getId(p));break;
    case 'task:set-url':{
      const input=z.object({id:z.string().uuid(),url:z.string().max(2048)}).parse(p),u=publicUrl(input.url);const t=store.read().tasks.find(t=>t.id===input.id);if(!t)throw Error('任务不存在');
      if(t.channelId==='github-gist'){forbidBusy();await controller.adoptGist(t.siteId,u.href);break;}
      if(!belongsToSource(u.href,t.sourceDomain))throw Error('结果网址必须属于该外链渠道');controller.patch(input.id,{publicUrl:u.href,...(t.publicUrl!==u.href?{verifiedAt:undefined,lastCheckedAt:undefined,linkRel:undefined,linkCheck:undefined,status:'review' as const,reviewKind:'manual_url' as const,reviewUntil:new Date(Date.now()+30*86400000).toISOString(),nextCheckAt:new Date().toISOString(),health:'unknown' as const}: {})});await controller.verify(input.id);break;
    }
    case 'task:open':{
      const id=getId(p),state=store.read(),task=state.tasks.find(item=>item.id===id);
      if(!task)throw Error('任务不存在');
      const channel=controller.channels().find(item=>item.id===task.channelId);
      if(!channel)throw Error('任务关联的渠道已不存在');
      if(channel.automation!=='browser'){
        const url=publicUrl(channel.submitUrl);
        if(!isAllowedTaskUrl(url.href,channel.allowedHosts))throw Error('渠道提交地址不在允许的 HTTPS 域名内');
        await openInPreferredBrowser(url.href,state.settings.preferredBrowser,value=>shell.openExternal(value));
        return;
      }
      await controller.manualOpen(id);break;
    }
    case 'task:open-result':{const id=getId(p),task=store.read().tasks.find(item=>item.id===id);if(!task?.publicUrl)throw Error('任务还没有公开结果网址');const url=publicUrl(task.publicUrl);await openInPreferredBrowser(url.href,store.read().settings.preferredBrowser,value=>shell.openExternal(value));return;}
    case 'task:generate':{forbidBusy();await controller.generateDraft(getId(p));break;}
    case 'task:update-draft':{
      const d=z.object({id:z.string().uuid(),title:z.string().min(1).max(150),description:z.string().max(3000),body:z.string().max(30000)}).strict().parse(p);let queue=false;store.update(state=>{queue=saveTaskDraft(state,d.id,{title:d.title,description:d.description,body:d.body})});if(queue)void controller.tick();break;
    }
    case 'plan:run':store.update(s=>{s.settings.autoRun=true});void controller.tick();break;
    case 'plan:pause':controller.pause();break;
    case 'settings:save':{
      const input=SettingsPatch.parse(p);controller.assertSettingsWritable();if(input.apiBase)input.apiBase=normalizeApiBase(input.apiBase);
      if(!app.isPackaged&&input.launchAtLogin)throw Error('开机启动请在打包客户端中开启');
      if(input.apiBase)publicUrl(input.apiBase);
      const result=withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},input.launchAtLogin,()=>saveSettingsAtomic(store,vault,input));
      if(result.mailSecretChanged)controller.runtime.mailReady=false;
      const reviewModeSites=result.reviewModeSites;for(const id of reviewModeSites)controller.resumeArticleReviews(id);
      await detectAi();controller.plan();if(reviewModeSites.length)void controller.tick();break;
    }
    case 'settings:test-ai':{const result=await testAi(store.read().settings,vault);controller.runtime.aiReady=result.ok;broadcast();return result;}
    case 'settings:test-mail':{forbidBusy();const result=await testMail(store.read().settings,vault);controller.runtime.mailReady=result.ok;broadcast();return result;}
    case 'settings:discover-models':{
      const input=z.object({provider:z.enum(['codex','api']).optional(),apiBase:z.url().max(1024).optional(),apiKey:z.string().max(1024).optional(),codexPath:z.string().max(1024).optional(),model:z.string().max(120).optional()}).parse(p??{});
      const saved=store.read().settings,normalizedBase=input.apiBase?normalizeApiBase(input.apiBase):undefined,settings={...saved,...input,...(normalizedBase?{apiBase:normalizedBase}:{})};if(settings.provider==='api'&&!settings.apiBase)throw Error('请填写 API 地址');
      const secrets=scopedApiSecrets(saved.apiBase,settings.apiBase,input.apiKey,vault);
      const result=await discoverModels(settings,secrets);controller.aiModels=result;broadcast();return result;
    }
    case 'mailbox:save':{
      forbidBusy();const input=MailboxPayload.parse(p);saveMailboxAtomic(store,input,secrets=>vault.encryptSecrets(secrets));
      return controller.snapshot();
    }
    case 'mailbox:test':{
      forbidBusy();const input=z.object({id:z.string().uuid().optional(),label:z.string().max(100).optional(),host:z.string().max(253).optional(),port:z.number().int().min(1).max(65535).optional(),user:z.email().max(254).optional(),secure:z.literal(true).optional(),password:z.string().max(1024).optional(),aliases:z.array(z.email()).max(1000).optional()}).parse(p??{});
      const saved=input.id?store.read().mailboxes.find(item=>item.id===input.id):undefined;if(input.id&&!saved)throw Error('收件箱不存在');
      const preview=prepareMailboxTest(saved,input),stored=saved&&!preview.identityChanged?await vault.get('mailbox:'+saved.id):undefined,{mailbox,password,canMarkVerified}=prepareMailboxTest(saved,input,stored);const result=await testMailbox(mailbox,password);
      if(saved&&canMarkVerified)store.update(state=>{const current=state.mailboxes.find(item=>item.id===saved.id);if(current){current.updatedAt=new Date().toISOString();current.verifiedAt=result.ok?current.updatedAt:current.verifiedAt;current.lastError=result.ok?undefined:result.message}});if(canMarkVerified)controller.runtime.mailReady=result.ok;broadcast();return result;
    }
    case 'mailbox:delete':{forbidBusy();const id=getId(p);store.update(state=>deleteMailbox(state,id));await vault.delete('mailbox:'+id);return controller.snapshot();}
    case 'mailbox:import':{
      forbidBusy();const {items}=z.object({items:z.array(MailboxPayload).min(1).max(100)}).parse(p);importMailboxesAtomic(store,items,secrets=>vault.encryptSecrets(secrets));return controller.snapshot();
    }
    case 'account:save':{
      forbidBusy();const input=AccountInput.parse(p);if(input.channelId==='blogger')throw Error('请使用连接Blogger完成Google授权和博客绑定');if(input.channelId==='github-gist')throw Error('请使用连接 GitHub Gist 验证并保存令牌');if(!controller.channels().some(c=>c.id===input.channelId))throw Error('渠道不存在');
      const channel=controller.channels().find(item=>item.id===input.channelId)!;saveAccountAtomic(store,input,channel,secrets=>vault.encryptSecrets(secrets));break;
    }
    case 'account:bind':{forbidBusy();const d=z.object({accountId:z.string().uuid(),siteId:z.string().uuid(),channelId:z.string().max(100)}).parse(p),channel=controller.channels().find(item=>item.id===d.channelId);if(!channel)throw Error('渠道不存在');if(channel.id==='blogger')throw Error('请使用Blogger专用入口绑定博客');store.update(state=>bindAccount(state,d.accountId,d.siteId,channel));break;}
    case 'account:unbind':{forbidBusy();const d=z.object({accountId:z.string().uuid(),siteId:z.string().uuid(),channelId:z.string().max(100)}).parse(p);store.update(state=>unbindAccount(state,d.accountId,d.siteId,d.channelId));break;}
    case 'account:set-bindings':{
      forbidBusy();const d=z.object({accountId:z.string().uuid(),mailboxId:z.string().uuid().nullable(),siteIds:z.array(z.string().uuid()).max(1000)}).parse(p),state=store.read(),account=state.accounts.find(item=>item.id===d.accountId);if(!account)throw Error('账号不存在');if(d.mailboxId&&!state.mailboxes.some(item=>item.id===d.mailboxId))throw Error('收件箱不存在');const channel=controller.channels().find(item=>item.id===account.channelId);if(!channel)throw Error('渠道不存在');if(account.credentialKind==='oauth')throw Error('请使用Blogger专用入口管理授权和博客绑定');const selected=new Set(d.siteIds);if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('绑定的网站不存在');
      store.update(draft=>{const current=draft.accounts.find(item=>item.id===d.accountId);if(!current)throw Error('账号不存在');current.mailboxId=d.mailboxId??undefined;current.updatedAt=new Date().toISOString();for(const siteId of selected)bindAccount(draft,current.id,siteId,channel);draft.accountBindings=draft.accountBindings.filter(binding=>binding.accountId!==current.id||binding.channelId!==current.channelId||selected.has(binding.siteId));});break;
    }
    case 'account:retry':{
      forbidBusy();const {id}=AccountRetry.parse(p),account=store.read().accounts.find(a=>a.id===id);if(!account)throw Error('账号不存在');
      if(account.status==='restricted')throw Error('平台已报告账号或访问受限，不能自动规避或重试');
      if(account.status==='credentials_invalid')throw Error('请先编辑账号并更新密码');
      if(account.status==='unknown')throw Error('账号状态尚未确认，请先检查平台记录或导入正确凭据');
      if(account.status==='registered')throw Error('账号已注册，无需重试注册');
      if(account.status==='draft'&&account.source!=='generated')throw Error('只能重试本机生成且尚未创建的注册草稿');
      if(account.diagnostic&&!account.diagnostic.retryable&&account.status!=='draft')throw Error('该账号异常需要人工处理');
      const now=new Date().toISOString();store.update(s=>{const a=s.accounts.find(a=>a.id===id);if(a){a.updatedAt=now;a.diagnostic=undefined}const sites=new Set(s.accountBindings.filter(binding=>binding.accountId===id).map(binding=>binding.siteId));for(const task of s.tasks){if((task.accountId===id||!task.accountId&&sites.has(task.siteId)&&task.channelId===account.channelId)&&!task.submittedAt&&['needs_input','failed'].includes(task.status)){task.accountId=id;task.status='queued';task.scheduledAt=now;task.updatedAt=now;task.message=account.status==='needs_verification'?'准备继续验证账号':'准备重试未提交的注册草稿';}}});void controller.tick();break;
    }
    case 'account:reveal':{const id=getId(p);if(['api_token','oauth'].includes(store.read().accounts.find(a=>a.id===id)?.credentialKind??''))throw Error('API 令牌不支持明文显示，请通过连接入口更新');await confirmSecret();return {password:(await vault.get('account:'+id))||''};}
    case 'account:delete':{forbidBusy();const id=getId(p),state=store.read();if(state.accounts.find(a=>a.id===id)?.credentialKind==='oauth')throw Error('请使用Blogger专用入口断开授权，身份和历史记录会保留');if(state.tasks.some(task=>task.accountId===id))throw Error('该账号已归属历史任务，不能删除');if(state.accountBindings.some(binding=>binding.accountId===id))throw Error('该账号仍绑定网站，请先解除绑定');await vault.delete('account:'+id);store.update(s=>{s.accounts=s.accounts.filter(a=>a.id!==id)});break;}
    case 'channel:save':{forbidBusy();const d=z.object({channel:z.unknown()}).parse(p);store.update(state=>{state.customChannels=saveCustomChannel(state.customChannels??[],d.channel,CHANNELS)});break;}
    case 'channel:delete':{forbidBusy();const {id}=z.object({id:z.string().regex(/^custom-[0-9a-f-]{36}$/)}).parse(p);store.update(state=>{state.customChannels=deleteCustomChannel(state.customChannels??[],id,state.tasks.map(task=>task.channelId))});break;}
    case 'channel:import-metrics':{forbidBusy();const d=z.object({rows:z.array(z.unknown()).min(1).max(1000)}).parse(p);const channels=controller.channels();store.update(state=>{state.channelMetrics=importChannelMetrics(state.channelMetrics??{},d.rows,channels)});break;}
    case 'backup:export':{
      const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showSaveDialog(win!,{title:'导出加密备份',defaultPath:'Linkflow-备份.lfb',filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled||!path.filePath)return {ok:false,message:'已取消'};
      const buffer=encryptBackup({state:store.read(),secrets:await vault.exportSecrets()},passphrase);await writeFile(path.filePath,buffer,{mode:0o600});return {ok:true,message:'加密备份已保存，请妥善保管口令'};
    }
    case 'backup:import':{
      ensureRestoreIdle();restoring=true;try{const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showOpenDialog(win!,{title:'恢复加密备份',properties:['openFile'],filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled)return {ok:false,message:'已取消'};
      const data=validateBackup(decryptBackup(await readFile(path.filePaths[0]),passphrase));
      const confirm=await dialog.showMessageBox(win!,{type:'warning',message:'用备份替换本机数据？',detail:'当前数据会自动保存为同口令的恢复前备份。恢复后自动执行保持暂停。',buttons:['取消','恢复'],defaultId:0,cancelId:0});if(confirm.response!==1)return {ok:false,message:'已取消'};
      ensureRestoreIdle();controller.closeTaskBrowsers();
      await writeFile(join(app.getPath('userData'),'恢复前备份.lfb'),encryptBackup({state:store.read(),secrets:await vault.exportSecrets()},passphrase),{mode:0o600});
      ensureRestoreIdle();data.state.settings={...defaultSettings(),...data.state.settings,autoRun:false,launchAtLogin:false};recoverInterrupted(data.state);for(const site of data.state.sites)if(site.status==='analyzing')site.status='attention';withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},false,()=>store.restore(data.state,vault.encryptSecrets(data.secrets)));await detectAi();return {ok:true,message:'备份已恢复，检查资料后可恢复执行'};}finally{restoring=false}
    }
    case 'backup:auto-status':return localBackups.status();
    case 'backup:auto-configure':{const d=z.object({enabled:z.boolean(),keep:z.number().int().min(3).max(30).default(7)}).parse(p);const status=await localBackups.configure(d.enabled,d.keep);return d.enabled&&!controller.hasPendingWork()?localBackups.run(true):status;}
    case 'backup:auto-run':{forbidBusy();return localBackups.run(true);}
    case 'backup:auto-restore':{
      ensureRestoreIdle();restoring=true;try{const {id}=z.object({id:z.string().max(200)}).parse(p),payload=await localBackups.read(id) as {state?:unknown;ciphers?:unknown};if(!payload||typeof payload!=='object'||!payload.state||!payload.ciphers||typeof payload.ciphers!=='object'||Array.isArray(payload.ciphers))throw Error('本机备份结构无效');
      if(!vault.available())throw Error('系统钥匙串不可用，无法恢复本机备份');const secrets:Record<string,string>={};for(const [key,cipher]of Object.entries(payload.ciphers)){if(typeof cipher!=='string'||cipher.length>10000)throw Error('本机备份凭据结构无效');try{secrets[key]=safeStorage.decryptString(Buffer.from(cipher,'base64'))}catch{throw Error('本机备份与当前系统账号不匹配')}}
      const data=validateBackup({state:payload.state,secrets}),confirm=await dialog.showMessageBox(win!,{type:'warning',message:'恢复这份本机自动备份？',detail:'当前状态会先另存一份本机恢复点。恢复后自动执行与开机启动都保持关闭。',buttons:['取消','恢复'],defaultId:0,cancelId:0});if(confirm.response!==1)return {ok:false,message:'已取消'};
      ensureRestoreIdle();controller.closeTaskBrowsers();await localBackups.run(true);ensureRestoreIdle();data.state.settings={...defaultSettings(),...data.state.settings,autoRun:false,launchAtLogin:false};recoverInterrupted(data.state);for(const site of data.state.sites)if(site.status==='analyzing')site.status='attention';withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},false,()=>store.restore(data.state,vault.encryptSecrets(data.secrets)));await detectAi();return {ok:true,message:'本机备份已恢复，检查后再手动恢复执行'};}finally{restoring=false}
    }
    case 'app:update-status':return updater.status();
    case 'app:check-update':return updater.check();
    case 'app:recover-update':{
      forbidBusy();if(activeCommands.size)throw Error('请等待当前操作完成后再恢复更新');updating=true;controller.stop();
      try{return await updater.supersedeRecovery()}finally{updating=false;if(runtimeStarted)controller.start()}
    }
    case 'app:download-update':{const state=updater.status();if(!['available','failed'].includes(state.phase)||!state.targetVersion)throw Error('请重新检查可用更新');void updater.download().catch(()=>broadcast());return updater.status();}
    case 'app:cancel-update':return updater.cancel();
    case 'app:install-update':{
      forbidBusy();if(activeCommands.size)throw Error('请等待当前操作完成后再安装更新');updating=true;controller.stop();controller.closeTaskBrowsers();
      try{await updater.install();setTimeout(()=>{quitting=true;app.quit()},100);return updater.status()}
      catch(error){updating=false;if(runtimeStarted)controller.start();throw error}
    }
    case 'data:export':{
      const path=await dialog.showSaveDialog(win!,{title:'导出外链记录',defaultPath:'外链记录.csv',filters:[{name:'CSV',extensions:['csv']}]});if(path.canceled||!path.filePath)return {ok:false,message:'已取消'};
      const s=store.read(),cell=(v:unknown)=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'").replaceAll('"','""')+'"';
      const rows=[['网站','渠道','状态','公开结果网址','首次生效时间','链接属性','说明'],...s.tasks.map(t=>[s.sites.find(x=>x.id===t.siteId)?.domain,t.sourceDomain,t.status,t.publicUrl,t.firstLiveAt,t.linkRel,t.message])];await writeFile(path.filePath,'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),{mode:0o600});return {ok:true,message:'记录已导出'};
    }
    case 'external:open':{const {url}=z.object({url:z.string().max(2048)}).parse(p);const u=publicUrl(url);if(/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)||u.hostname.includes(':'))throw Error('仅可打开公开网页');await openInPreferredBrowser(u.href,store.read().settings.preferredBrowser,value=>shell.openExternal(value));return;}
    case 'app:quit':quitting=true;app.quit();return;
    default:throw Error('不支持的操作');
  }
  return controller.snapshot();
}

app.on('second-instance',()=>{if(!win)createWindow();else{win.show();win.focus()}});
app.whenReady().then(async()=>{
  if(!single)return;await mkdir(app.getPath('userData'),{recursive:true,mode:0o700});
  const store=new Store(join(app.getPath('userData'),'linkflow.sqlite'));const vault=new Vault(store);controller=new Controller(store,vault,app.getPath('userData'));store.onChange=broadcast;controller.runtime.version=app.getVersion();
  localBackups=new LocalBackups(join(app.getPath('userData'),'automatic-backups'),{encrypt:clear=>{if(!vault.available())throw Error('系统钥匙串不可用');return safeStorage.encryptString(clear)},decrypt:cipher=>{if(!vault.available())throw Error('系统钥匙串不可用');return safeStorage.decryptString(cipher)},snapshot:()=>({state:store.read(),ciphers:store.allCiphers()})});
  const runtimeApplicationPath=process.platform==='darwin'?(macApplicationPath(process.execPath)??''):dirname(process.execPath),runtimeHelperPath=join(root,'dist-electron/update-helper.cjs');
  const macTarget=process.platform==='darwin'&&app.isPackaged&&!selfTest?await resolveMacUpdateTarget({runningApplicationPath:runtimeApplicationPath,runningExecutablePath:process.execPath,runningHelperPath:runtimeHelperPath,homeDirectory:app.getPath('home'),currentVersion:app.getVersion()}):undefined;
  const updateApplicationPath=process.platform==='darwin'?(macTarget?.applicationPath??runtimeApplicationPath):dirname(process.execPath),updateExecutablePath=process.platform==='darwin'?(macTarget?.executablePath??process.execPath):process.execPath,updateHelperPath=process.platform==='darwin'?(macTarget?.helperPath??runtimeHelperPath):runtimeHelperPath;
  updater=new UpdateManager({currentVersion:app.getVersion(),platform:process.platform,arch:process.arch,packaged:app.isPackaged&&!selfTest,
    unsupportedReason:process.platform==='darwin'&&app.isPackaged&&!selfTest&&!macTarget?'请先将应用移到“应用程序”文件夹并重新打开，再使用应用内更新':undefined,
    updatesDirectory:join(app.getPath('userData'),'updates'),applicationPath:updateApplicationPath,executablePath:updateExecutablePath,runtimeApplicationPath,runtimeExecutablePath:process.execPath,
    helperPath:updateHelperPath,publicKey:Buffer.from(UPDATE_PUBLIC_KEY_SPKI_BASE64,'base64')});
  await updater.initialize();
  if(selfTest)store.update(s=>{s.settings.autoRun=false;s.settings.provider='api';s.settings.hasApiKey=false});
  controller.onNotice=(title,body)=>{if(Notification.isSupported())new Notification({title,body}).show()};
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'外链助手',submenu:[{role:'about'},{type:'separator'},{label:'显示主窗口',click:()=>win?.show()},{label:'退出',accelerator:'CommandOrControl+Q',click:()=>{quitting=true;app.quit()}}]},{role:'editMenu'},{role:'windowMenu'}]));
  const iconPath=join(root,'assets/tray.png');if(existsSync(iconPath)){const icon=nativeImage.createFromPath(iconPath).resize({width:18,height:18});tray=new Tray(icon);tray.setToolTip('外链助手');tray.setContextMenu(Menu.buildFromTemplate([{label:'显示外链助手',click:()=>{if(!win)createWindow();win?.show()}},{label:'暂停自动执行',click:()=>controller.pause()},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit()}}]));tray.on('click',()=>win?.show());}
  ipcMain.handle('linkflow:command',async(event,name,payload)=>{
    const operation=Symbol();let tracked=false;
    try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!IPC_COMMANDS.includes(name)||event.senderFrame.url!==renderURL)throw Error('无权调用此操作');
      if(JSON.stringify(payload??{}).length>100000)throw Error('输入内容过大');
      if(!['snapshot','app:update-status','app:install-update','app:recover-update'].includes(name)){activeCommands.add(operation);tracked=true}
      return {ok:true,value:await command(name,payload)};
    }catch(e){return {ok:false,error:safeMessage(e)}}finally{if(tracked)activeCommands.delete(operation)}
  });
  powerMonitor.on('resume',()=>{if(runtimeStarted&&!updating&&!quitting)void controller.tick()});
  createWindow();if(selfTest){void runPackagedSelfTest(win!,controller);return;}await detectAi();runtimeStarted=true;if(!updating&&!quitting)controller.start();maintenanceTimer=setInterval(()=>{if(!updating&&!controller.hasPendingWork())void localBackups.run().catch(()=>broadcast())},10*60_000);maintenanceTimer.unref();
});
app.on('activate',()=>{if(!win)createWindow();else win.show()});
app.on('before-quit',()=>{quitting=true;bloggerConnect?.abort();if(maintenanceTimer)clearInterval(maintenanceTimer);controller?.stop();updater?.dispose()});
app.on('window-all-closed',()=>{if(!tray){quitting=true;app.quit()}});
