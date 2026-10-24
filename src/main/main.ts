import {requestHereNowCode,resendHereNowCode,verifyHereNowCode,recoverHereNowVerifiedResponse} from './here-now-email';
import {transferIdentityOwner} from './account-retirement';
import {BATCH9B_MESSAGES} from '../shared/batch9b-messages';
import {RendererReadiness} from './renderer-readiness';
const rendererReadiness=new RendererReadiness();
import {connectHackMd} from './hackmd-management';
import {connectGitBookAccount} from './gitbook-connection';
import {connectValTownAccount} from './valtown-connection';
import {connectBitbucketAccount} from './bitbucket-connection';
import {taskRetryHasExternalAttempt} from './task-retry';
import {HUMAN_ACTION_IPC_COMMANDS} from '../shared/human-action';
import {assertHumanWaitOpen} from './task-state';
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray, nativeImage, safeStorage, systemPreferences, powerMonitor, clipboard } from 'electron';
import { claudeLoggedIn } from '../integrations/claude-process';
import type { UpdateState } from '../shared/update-types';
import { basename, dirname, join } from 'node:path';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Store, defaultSettings } from './store';
import {addSitesBatch} from './site-batch';
import {assertPortableBackupFits,Vault,encryptBackup,decryptBackup} from './vault';
import {connectBlogger,reconnectBlogger,listBloggerBlogs,bindBloggerBlog,bindBloggerBlogs,disconnectBlogger} from './blogger-management';
import {WordPressConnections} from './wordpress-management';
import {connectMarkest,MarkestConnectionInput} from './markest-management';
import {connectDeno,DenoConnectionInput} from './deno-management';
import {readDenoApps,validDenoToken} from '../integrations/deno-connection';
import {connectParagraph} from './paragraph-management';
import {accountLoginPassword,connectArticleAccount,connectPlopinoManagement,connectProseAccount,parseArticleConnectionInput} from './article-connections';
import {connectBluesky} from './bluesky-management';
import {connectLeaflet} from './leaflet-management';
import {connectRaindrop,discoverRaindropCollections} from './raindrop-management';
import {connectHereNow} from './here-now-management';
import {connectOpenAgentChat} from './openagentchat-account';
import {connectAgentsWiki} from './agentswiki-account';
import {connectColony} from './colony-account';
import {connectLargeLanguage,createLargeLanguageAccount} from './large-language-account';
import {connectSynthfolk} from './synthfolk-account';
import {recoverShiplyVerifiedResponse,requestShiplyCode,resendExpiredShiplyCode,verifyShiplyCode} from './shiply-management';
import { Controller,isConfirmedBetterThanHtmlResultUrl,isConfirmedSupanoteResultUrl,isConfirmedDocsMdResultUrl,isConfirmedKatbinResultUrl,isConfirmedMDShareResultUrl,isConfirmedPstrsResultUrl,isConfirmedNextgenSlidesResultUrl,isConfirmedYourwebsResultUrl,isConfirmedTotpageResultUrl,isConfirmedMDViewResultUrl,isConfirmedTxtSbsResultUrl,isConfirmedPastyXResultUrl,isConfirmedAgentDropResultUrl,isConfirmedPasteMystResultUrl,isConfirmedMarkdownPasteResultUrl,isConfirmedHtmlAppResultUrl,isConfirmedMemoryWikiResultUrl } from './controller';
import { AddSite, EditSite, SiteContentUpdate, SettingsPatch, AccountInput, AccountRetry, getId, normalizeDomain, publicUrl, safeMessage } from './validation';
import { validateBackup,validateLocalBackup } from './backup-validation';
import { recoverInterrupted, earliestPublicationAt, monthKey } from './planner';
import {publicationOpportunity,hasRecoverablePublisherDraftReceipt,hasUnresolvedExternalAttempt} from '../shared/publication';
import {resumeDeferredTask} from './task-recovery';
import { BITBUCKET_IPC_COMMANDS, HERE_NOW_IPC_COMMANDS, IPC_COMMANDS, PLOPINO_IPC_COMMANDS, SHIPLY_IPC_COMMANDS, VALTOWN_IPC_COMMANDS, type Site, type Account, type BloggerConnectionResult } from '../shared/types';
import {CHANNELS} from '../integrations/catalog';
import {belongsToSource} from '../integrations/web';
import {eligibilityFor} from '../integrations/eligibility';
import {assignGscFiles,gscDiscoveryNotice,mergeGscImport,parseGscLinksCsvFiles} from '../integrations/search-reports';
import { discoverModels, normalizeApiBase, scopedApiSecrets, testAi } from '../integrations/ai';
import { codexEnvironment, resolveCodexLaunch } from '../integrations/codex-process';
import { testMail, testMailbox } from '../integrations/mail';
import {deleteMailbox,prepareMailboxTest} from './mail-settings';
import { prepareSelfTest, runPackagedSelfTest } from './self-test';
import {bindAccount,unbindAccount,channelExecutionReadiness,setSelectedAccountSites} from './account-bindings';
import {ACCOUNT_IDENTITY_MESSAGES,identityRegistrationSettled,retireAccount} from './account-retirement';
import {deleteCustomChannel,importChannelMetrics} from '../integrations/channel-library';
import {openInPreferredBrowser} from './external-browser';
import {LocalBackups} from './maintenance';
import {UpdateManager} from './update-manager';
import {macApplicationPath} from './update-install';
import {resolveMacUpdateTarget} from './update-mac-target';
import {UPDATE_PUBLIC_KEY_SPKI_BASE64} from '../shared/update-trust';
import {importMailboxesAndTestAtomic,saveMailboxAndTestAtomic} from './mailbox-service';
import {saveAccountAtomic} from './account-service';
import {saveSettingsAtomic} from './settings-service';
import {loginItemReadOptions,withLoginItemPreference} from './login-item';
import {getArticleReviewMode} from '../shared/article-review-mode';
import {channelDiscoveryFor} from '../integrations/channel-discovery';
import {isAllowedTaskUrl} from '../integrations/browser';
import {applySiteUpdate,rerollSiteWritingProfile,updateSiteContent} from './site-service';
import {applyChannelPolicyDecision,canConfirmMissingPolicy} from './channel-policy';
import {saveTaskDraft} from './task-draft';
import {createDraftClipboardHandler} from './draft-clipboard';
import {acceptHtmlAppPublicNotice} from './html-app-publication';
import {activateSiteOriginRecoveryGrant,applySiteOriginMigration,migrationAwareTopicKey} from './site-origin-migration';
import {validHtmlAppPublicNoticeAcknowledgement} from '../shared/html-app-notice';
import {drainBrewPageLateResponses} from '../integrations/brewpage';
import {renderMemoryWikiArticle} from './memorywiki-renderer';
import {renderMDSharePage} from './mdshare-renderer';
import {drainMDShareLateResponses} from '../integrations/mdshare';
import {drainMDViewPendingOperations,mdviewPendingOperationCount} from '../integrations/mdview';
import {renderMDViewPage} from './mdview-renderer';
import {drainTxtSbsPendingOperations,txtsbsPendingOperationCount} from '../integrations/txtsbs';
import {renderTxtSbsPage} from './txtsbs-renderer';
import {renderTheThingsPage} from './thethings-renderer';
import {drainPastyXPendingOperations,pastyxPendingOperationCount} from '../integrations/pastyx';
import {renderPastyXPage} from './pastyx-renderer';
import {renderAgentDropPage} from './agentdrop-renderer';
import {renderOpenAgentChatPage} from './openagentchat-renderer';
import {drainOpenAgentChatPendingOperations,openAgentChatPendingOperationCount} from '../integrations/openagentchat';
import {renderAgentRiotPage} from './agentriot-renderer';
import {renderAgentboardPage} from './agentboard-renderer';
import {renderAgentNotepadPage} from './agentnotepad-renderer';
import {renderColonyPage} from './colony-renderer';
import {renderListedStartupsPage} from './listed-startups-renderer';
import {renderAgentHowPage} from './agenthow-renderer';
import {drainAgentHowPendingOperations} from '../integrations/agenthow';
import {renderAgentsWikiPage} from './agentswiki-renderer';
import {drainAgentsWikiPendingOperations} from '../integrations/agentswiki';
import {renderBerrryPage} from './berrry-renderer';
import {drainBerrryPendingOperations} from '../integrations/berrry';
import {renderLargeLanguagePage} from './large-language-renderer';
import {renderProductIndexPage} from './product-index-renderer';
import {renderSwarmMemoPage} from './swarmmemo-renderer';
import {drainSwarmMemoPendingOperations} from '../integrations/swarmmemo';
import {drainSynthfolkPendingOperations} from '../integrations/synthfolk';
import {renderSynthfolkPage} from './synthfolk-renderer';

app.setName('外链助手');
const selfTest=prepareSelfTest();
if(process.env.LINKFLOW_DATA_DIR&&!app.isPackaged&&!selfTest)app.setPath('userData',process.env.LINKFLOW_DATA_DIR);
const single=app.requestSingleInstanceLock();
if(!single)app.quit();
let win:BrowserWindow|null=null,tray:Tray|null=null,quitting=false,restoring=false,updating=false,runtimeStarted=false,quitDrainStarted=false,quitDrainComplete=false,controller:Controller,localBackups:LocalBackups,updater:UpdateManager,maintenanceTimer:ReturnType<typeof setInterval>|undefined,brewPageQuitDrain:Promise<void>|undefined,brewPageQuitDrained=false;
async function drainMDViewForQuit(){const drained=await drainMDViewPendingOperations(5000);if(!drained)console.error(`MDVIEW_QUIT_DRAIN_INCOMPLETE pending=${mdviewPendingOperationCount()}`)}
async function drainTxtSbsForQuit(){const drained=await drainTxtSbsPendingOperations(5000);if(!drained)console.error(`TXTSBS_QUIT_DRAIN_INCOMPLETE pending=${txtsbsPendingOperationCount()}`)}
async function drainPastyXForQuit(){const drained=await drainPastyXPendingOperations(5000);if(!drained)console.error(`PASTYX_QUIT_DRAIN_INCOMPLETE pending=${pastyxPendingOperationCount()}`)}
async function drainOpenAgentChatForQuit(){const drained=await drainOpenAgentChatPendingOperations(5000);if(!drained)console.error(`OPENAGENTCHAT_QUIT_DRAIN_INCOMPLETE pending=${openAgentChatPendingOperationCount()}`)}
const activeCommands=new Set<symbol>();
let bloggerConnect:AbortController|undefined;
let proseConnect:AbortController|undefined;
let markestConnect:AbortController|undefined;
let denoConnect:AbortController|undefined;
let raindropConnect:AbortController|undefined;
let hereNowConnect:AbortController|undefined;
let shiplyConnect:AbortController|undefined;
let wordpressConnections:WordPressConnections;
const root=join(__dirname,'..');
const file=join(root,'dist/index.html');
const devUrl=!app.isPackaged?process.env.LINKFLOW_DEV_URL:undefined;
let renderURL=devUrl||pathToFileURL(file).href;
const MailboxPayload=z.object({id:z.string().uuid().optional(),label:z.string().min(1).max(100),host:z.string().max(253),port:z.number().int().min(1).max(65535),user:z.email().max(254),secure:z.literal(true),password:z.string().max(1024).optional(),aliases:z.array(z.email().max(254)).max(1000).optional(),siteIds:z.array(z.string().uuid()).max(1000).optional()}).strict();

// Bursts of writes (a tick touching many tasks) reach the renderer as one refresh about every 300 ms.
// A new version is announced once per version as a system notification too, so a window hidden in the tray still learns of it.
// The version is remembered across restarts; a window in front already shows the in-app reminder, and "notify me" off means no notice.
let versionNotice:Notification|undefined;
const announcedVersionFile=()=>join(app.getPath('userData'),'update-announced.json');
function notifyNewVersion(state:UpdateState){
  if(state.phase!=='available'||!state.targetVersion)return;
  let announced:string|undefined;try{announced=(JSON.parse(readFileSync(announcedVersionFile(),'utf8')) as {version?:string}).version}catch{/* none yet */}
  if(announced===state.targetVersion)return;
  try{writeFileSync(announcedVersionFile(),JSON.stringify({version:state.targetVersion}),{mode:0o600})}catch{/* still announce this run */}
  if(win&&!win.isDestroyed()&&win.isVisible()&&win.isFocused())return;
  if(controller&&!controller.store.read().settings.notify||!Notification.isSupported())return;
  versionNotice=new Notification({title:`外链助手有新版本 ${state.targetVersion}`,body:'打开“设置 → 更新”即可下载并安装，网站和稿件都会保留。'});
  versionNotice.on('click',()=>{if(win&&!win.isDestroyed()){win.show();win.focus()}});
  versionNotice.show();
}
let broadcastTimer:ReturnType<typeof setTimeout>|undefined;
function broadcast(){
  if(broadcastTimer)return;
  broadcastTimer=setTimeout(()=>{broadcastTimer=undefined;if(win&&!win.isDestroyed())win.webContents.send('linkflow:changed')},300);
}
function createWindow(){
  win=new BrowserWindow({width:1487,height:1058,minWidth:960,minHeight:540,show:false,title:'外链助手 · LINKFLOW',backgroundColor:'#f8faff',titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',trafficLightPosition:{x:16,y:16},webPreferences:{preload:join(root,'dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==renderURL)event.preventDefault()});
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.on('close',event=>{if(!quitting&&tray){event.preventDefault();win?.hide()}});
  // Coming back to the window is a natural moment to look for a new version (still at most once every two hours).
  win.on('focus',()=>{if(runtimeStarted&&!updating&&!quitting&&updater)void updater.checkIfDue().catch(()=>{})});
  win.on('closed',()=>{win=null});
  const created=win;
  rendererReadiness.reset();
  created.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)rendererReadiness.reset()});
  void created.loadURL(renderURL);created.once('ready-to-show',()=>created.show());
}
async function confirmSecret(){
  if(process.platform==='darwin'&&systemPreferences.canPromptTouchID()){await systemPreferences.promptTouchID('查看外链助手保存的密码');return;}
  const r=await dialog.showMessageBox(win!,{type:'question',title:'显示密码',message:'将在当前屏幕显示保存的密码。',buttons:['取消','显示密码'],defaultId:0,cancelId:0});if(r.response!==1)throw Error('已取消');
}
function forbidBusy(){if(controller.hasPendingWork())throw Error('请先暂停执行，等待当前操作结束后再修改。')}
/** An id from a payload before it is parsed, only to know which work to wait for; parsing still validates it. */
function payloadId(p:unknown,key='id'):string|undefined{const value=(p as Record<string,unknown>|undefined)?.[key];return typeof value==='string'?value:undefined}
function payloadIds(p:unknown,key:string):string[]{const value=(p as Record<string,unknown>|undefined)?.[key];return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[]}
function ensureRestoreIdle(){if(controller.store.read().settings.autoRun||controller.hasPendingWork())throw Error('恢复备份前请暂停自动执行，并等待分析或检查完成。')}
async function detectAi(){
  const s=controller.store.read().settings;
  if(s.provider==='api'){controller.runtime.aiReady=s.hasApiKey&&!!s.model;broadcast();return;}
  if(s.provider==='claude'){controller.runtime.aiReady=await claudeLoggedIn(s);broadcast();return;}
  // Read only auth status. No inference call or key-file reading on startup.
  try{const launch=resolveCodexLaunch(s.codexPath);const ok=await new Promise<boolean>(resolve=>{let output='';const p=spawn(launch.command,[...launch.prefixArgs,'login','status'],{stdio:['ignore','pipe','pipe'],shell:false,env:codexEnvironment(process.env,launch.envAdditions)});const timeout=setTimeout(()=>{p.kill();resolve(false)},10000);p.stdout.on('data',d=>{output+=d.toString().slice(0,2000)});p.stderr.on('data',d=>{output+=d.toString().slice(0,2000)});p.on('error',()=>{clearTimeout(timeout);resolve(false)});p.on('close',code=>{clearTimeout(timeout);resolve(code===0&&!/not logged in/i.test(output))})});controller.runtime.aiReady=ok;}catch{controller.runtime.aiReady=false}broadcast();
}
async function command(name:string,p:unknown):Promise<unknown>{
  const {store,vault}=controller;
  if(name==='account:delete'){const id=getId(p),account=store.read().accounts.find(value=>value.id===id);if(account?.channelId==='agentswiki')throw Error('Agents Wiki 发布账号、API key 与原发布记录必须保留用于找回，不能在外链助手中删除')}
  if(restoring)throw Error('正在恢复备份，完成前不能执行其他操作');
  if(updating&&name!=='app:update-status'&&name!=='snapshot')throw Error('正在准备更新安装，请等待外链助手重启');
  if((name.startsWith('app:')&&name.endsWith('update'))||name==='app:update-status')z.object({}).strict().parse(p??{});
  switch(name){
    case 'snapshot':{const snapshot=controller.snapshot();rendererReadiness.snapshotDelivered();return snapshot}
    case 'app:ready':{if(!rendererReadiness.acknowledge())return false;if(app.isPackaged&&!selfTest)await updater.acknowledgeStartup();return true}
    case 'site:add':{
      const data=AddSite.parse(p),address=normalizeDomain(data.domain),state=store.read();if(state.sites.some(s=>s.domain===address.domain))throw Error('这个网站已经添加');
      const site:Site={id:randomUUID(),...address,email:data.email,publicEmail:data.email,name:address.domain,description:'',category:'general',language:'en',monthlyTarget:data.monthlyTarget,articleReviewMode:getArticleReviewMode(data,state.settings),status:'analyzing',createdAt:new Date().toISOString()};
      store.update(s=>s.sites.push(site));void controller.analyze(site.id);break;
    }
    case 'site:add-batch':{
      const result=await addSitesBatch(store,p,{analyze:id=>{void controller.analyze(id)}});
      controller.plan();void controller.tick();return result;
    }
    case 'site:archive':controller.archiveSite(getId(p));break;
    case 'site:restore':controller.restoreSite(getId(p));break;
    case 'site:dismiss-proposal':{const id=getId(p);store.update(state=>{const site=state.sites.find(item=>item.id===id);if(site)site.analysisProposal=undefined});break;}
    case 'site:reroll-writing-profile':{await controller.waitForIdle({siteIds:[payloadId(p)]});const id=getId(p);let profile:Site['writingProfile'];store.update(state=>{profile=rerollSiteWritingProfile(state,id)});return profile;}
    case 'site:content-update':{await controller.waitForIdle({siteIds:[payloadId(p)]});const input=SiteContentUpdate.parse(p);store.update(state=>updateSiteContent(state,input));break;}
    case 'site:update':{await controller.waitForIdle({siteIds:[payloadId(p)]});const input=EditSite.parse(p);let modeChanged=false;store.update(s=>{modeChanged=applySiteUpdate(s,input).reviewModeChanged});const state=store.read(),site=state.sites.find(item=>item.id===input.id);if(modeChanged&&site&&getArticleReviewMode(site,state.settings)==='ai')controller.resumeArticleReviews(input.id);controller.plan();if(modeChanged)void controller.tick();break;}
    case 'site:confirm-channel-policy':{
      await controller.waitForIdle({siteIds:[payloadId(p)]});const d=z.object({id:z.string().uuid(),channelId:z.string().max(100)}).strict().parse(p),site=store.read().sites.find(item=>item.id===d.id),channel=controller.channels().find(item=>item.id===d.channelId);
      if(!site||!channel||!canConfirmMissingPolicy(channel))throw Error('网站或平台不能进行此确认');
      const result=await dialog.showMessageBox(win!,{type:'question',title:'平台使用确认',message:'是否允许 '+site.domain+' 使用 '+channel.name+'？',detail:'已核对官方接口与产品说明，但尚未找到适用的完整内容政策。确认仅适用于这个网站和当前平台资料，有效期90天。每篇仍须 AI 复核事实、作者关系、佣金披露、独立价值和金融风险；明确违规、证据抓取失败或内容未知仍停止。平台可能删除内容或限制账号。此确认不表示AI已确认平台内容政策。',buttons:['取消','确认使用','撤回确认'],defaultId:0,cancelId:0});
      if(result.response===0)return;await controller.waitForIdle({siteIds:[d.id]});const currentChannel=controller.channels().find(item=>item.id===d.channelId);if(!currentChannel)throw Error('平台已不存在');
      store.update(state=>applyChannelPolicyDecision(state,d.id,currentChannel,result.response===1));if(result.response===1)void controller.tick();break;
    }
    case 'site:queue-channel':{
      await controller.waitForIdle({siteIds:[payloadId(p)]});const d=z.object({id:z.string().uuid(),channelId:z.string().max(100)}).parse(p);const s=store.read(),site=s.sites.find(x=>x.id===d.id),channel=controller.channels().find(c=>c.id===d.channelId);
      if(!site||!channel)throw Error('网站或平台不存在');if(site.status!=='ready')throw Error('请先完成网站分析并恢复计划');
      const fit=eligibilityFor(site,channel),candidate=channelDiscoveryFor(site,channel);if(channel.automation==='manual'?!candidate.canQueue:!fit.eligible)throw Error(channel.automation==='manual'?candidate.nextStep:fit.reason);if(channel.automation!=='manual'&&(channel.free==='unknown'||channel.free==='paid'))throw Error('该平台不符合自动免费计划条件');
      const opportunity=publicationOpportunity(site,channel.automation==='manual'?{...channel,free:'yes'}:channel,s.tasks,new Date(),s.settings.timezone,{officialApiConnected:channelExecutionReadiness(s,site.id,channel).kind==='ready',topicKey:value=>migrationAwareTopicKey(s,site.id,value)});if(!opportunity.allowed)throw Error(opportunity.reason);
      const instant=new Date(),scheduled=earliestPublicationAt(site.id,channel.id,s.tasks,new Date(opportunity.scheduledAt??instant.toISOString()));if(monthKey(scheduled,s.settings.timezone)!==monthKey(instant,s.settings.timezone))throw Error('本月发布间隔已排满，最早可于 '+scheduled.toLocaleDateString('zh-CN',{timeZone:s.settings.timezone})+' 安排；外链助手会按新月目标继续。');
      const now=instant.toISOString();store.update(x=>x.tasks.push({id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.id==='blogger'&&site.blogger?new URL(site.blogger.url).hostname:channel.domain,status:channel.automation==='manual'?'needs_input':'queued',...(channel.automation==='manual'?{reasonCode:'human_required' as const,waitingSince:now,waitingDeadlineAt:new Date(instant.getTime()+48*3600000).toISOString()}:{}),createdAt:now,scheduledAt:scheduled.toISOString(),...(opportunity.topicUrl?{topicUrl:opportunity.topicUrl}:{}),updatedAt:now,attempts:0,message:channel.automation==='manual'?(channel.free==='paid'?'付费平台仅建立人工待办；外链助手不会付款或自动提交':'可生成材料，按平台规则人工提交'):'已加入计划',suitabilityReason:channel.automation==='manual'?`${candidate.reason} ${candidate.nextStep}`:fit.reason,health:'pending',history:[],cost:{aiCalls:0}}));void controller.tick();break;
    }
    case 'site:adopt-gist':{const d=z.object({id:z.string().uuid(),url:z.string().trim().max(2048),accountId:z.string().uuid().optional()}).parse(p);await controller.adoptGist(d.id,d.url,d.accountId);break;}
    case 'account:connect-blogger':{
      z.object({}).strict().parse(p??{});if(bloggerConnect)throw Error('Blogger连接正在进行');
      return controller.manageIdentity(async()=>{const abort=new AbortController();bloggerConnect=abort;
        try{const chosen=await dialog.showOpenDialog(win!,{title:'选择Google OAuth桌面客户端配置',properties:['openFile'],filters:[{name:'Google OAuth JSON',extensions:['json']}]});
          if(chosen.canceled||!chosen.filePaths[0]||abort.signal.aborted)return undefined;
          const info=await stat(chosen.filePaths[0]);if(!info.isFile()||info.size>65536)throw Error('客户端配置文件无效或过大');
          const config=await readFile(chosen.filePaths[0],'utf8');
          const result=await connectBlogger(store,vault,config,{signal:abort.signal,openExternal:url=>openInPreferredBrowser(url,store.read().settings.preferredBrowser,value=>shell.openExternal(value))});
          const response:BloggerConnectionResult={account:result.account,guidance:result.guidance,blogs:result.blogs.map(({id,name,url})=>({id,name,url}))};
          return response;
        }finally{if(bloggerConnect===abort)bloggerConnect=undefined}
      });
    }
    case 'account:reconnect-blogger':{
      const d=z.object({accountId:z.string().uuid()}).strict().parse(p);if(bloggerConnect)throw Error('Blogger连接正在进行');
      return controller.manageIdentity(async()=>{const abort=new AbortController();bloggerConnect=abort;
        try{const result=await reconnectBlogger(store,vault,d.accountId,{signal:abort.signal,openExternal:url=>openInPreferredBrowser(url,store.read().settings.preferredBrowser,value=>shell.openExternal(value))});const response:BloggerConnectionResult={account:result.account,guidance:result.guidance,blogs:result.blogs.map(({id,name,url})=>({id,name,url}))};return response;}
        finally{if(bloggerConnect===abort)bloggerConnect=undefined}
      });
    }
    case 'account:cancel-blogger':z.object({}).strict().parse(p??{});bloggerConnect?.abort();return {cancelled:true};
    case 'account:blogger-blogs':{const d=z.object({accountId:z.string().uuid()}).strict().parse(p);return controller.manageIdentity(()=>listBloggerBlogs(store,vault,d.accountId));}
    case 'site:bind-blogger':{const d=z.object({siteId:z.string().uuid(),accountId:z.string().uuid(),blogId:z.string().regex(/^\d{1,64}$/)}).strict().parse(p);return controller.manageIdentity(()=>bindBloggerBlog(store,vault,d.siteId,d.accountId,d.blogId));}
    case 'site:bind-blogger-batch':{const d=z.object({siteIds:z.array(z.string().uuid()).min(1).max(100),accountId:z.string().uuid(),blogId:z.string().regex(/^\d{1,64}$/)}).strict().parse(p);return controller.manageIdentity(()=>bindBloggerBlogs(store,vault,d.siteIds,d.accountId,d.blogId));}
    case 'account:disconnect-blogger':{const d=z.object({accountId:z.string().uuid()}).strict().parse(p);return controller.manageIdentity(async()=>{await disconnectBlogger(store,vault,d.accountId);return {disconnected:true}});}
    case 'account:connect-paper':
    case 'account:connect-hive':
    case 'account:connect-mataroa':{
      const channelId=name==='account:connect-hive'?'hive':name==='account:connect-mataroa'?'mataroa':'paper-wf';
      const input=parseArticleConnectionInput(channelId,p);
      return controller.manageIdentity(()=>connectArticleAccount(store,vault,input));
    }
    case 'account:connect-plopino':{
      const input=z.object({email:z.string().email().max(254),password:z.string().min(6).max(128),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);
      return controller.manageIdentity(()=>connectPlopinoManagement(store,vault,input));
    }
    case 'account:connect-openagentchat':{const input=z.object({token:z.string().trim().min(16).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectOpenAgentChat(store,vault,input));}
    case 'account:connect-agentswiki':{const input=z.object({apiKey:z.string().trim().min(35).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectAgentsWiki(store,vault,input));}
    case 'account:connect-colony':{const input=z.object({token:z.string().trim().min(16).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectColony(store,vault,input));}
    case 'account:create-large-language':{const declared=z.string().trim().min(1).max(120).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));const input=z.object({displayName:declared.refine(value=>value.length<=80),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional(),responsibleHuman:declared,producerType:z.enum(['model','system']),producerName:declared}).strict().parse(p);return controller.manageIdentity(()=>createLargeLanguageAccount(store,vault,input));}
    case 'account:connect-large-language':{const declared=z.string().trim().min(1).max(120).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));const input=z.object({token:z.string().trim().min(16).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional(),responsibleHuman:declared,producerType:z.enum(['model','system']),producerName:declared}).strict().parse(p);return controller.manageIdentity(()=>connectLargeLanguage(store,vault,input));}
    case 'account:connect-synthfolk':{const input=z.object({apiKey:z.string().trim().min(16).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectSynthfolk(store,vault,input,{renderPage:renderSynthfolkPage}));}
    case 'account:connect-markest':{
      const d=MarkestConnectionInput.safeParse(p);if(!d.success)throw Error('Markest 连接资料格式无效');
      if(markestConnect)throw Error('Markest 读取验证正在进行');
      const abort=new AbortController();markestConnect=abort;
      try{return await controller.manageIdentity(()=>connectMarkest(store,vault,d.data,{signal:abort.signal}))}
      finally{if(markestConnect===abort)markestConnect=undefined}
    }
    case 'account:cancel-markest':z.object({}).strict().parse(p??{});markestConnect?.abort();return {cancelled:!!markestConnect};
    case 'account:list-deno-apps':{
      const d=z.object({token:z.string().min(1).max(4096)}).strict().parse(p);if(!validDenoToken(d.token))throw Error('Deno 组织令牌格式无效');
      if(denoConnect)throw Error('Deno 只读验证正在进行');const abort=new AbortController();denoConnect=abort;
      try{return await controller.manageIdentity(()=>readDenoApps(d.token,{signal:abort.signal}))}
      finally{if(denoConnect===abort)denoConnect=undefined}
    }
    case 'account:connect-deno':{
      const d=DenoConnectionInput.safeParse(p);if(!d.success)throw Error('Deno 连接资料格式无效');
      if(denoConnect)throw Error('Deno 只读验证正在进行');const abort=new AbortController();denoConnect=abort;
      try{return await controller.manageIdentity(()=>connectDeno(store,vault,d.data,{signal:abort.signal}))}
      finally{if(denoConnect===abort)denoConnect=undefined}
    }
    case 'account:cancel-deno':z.object({}).strict().parse(p??{});denoConnect?.abort();return {cancelled:!!denoConnect};
    case 'account:connect-prose':{
      const d=z.object({privateKey:z.string().min(1).max(16_384),passphrase:z.string().max(4096).optional(),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);
      if(proseConnect)throw Error('Prose SSH 登录验证正在进行');
      const channel=controller.channels().find(item=>item.id==='prose');if(!channel)throw Error('Prose 连接目录尚未就绪');
      const abort=new AbortController();proseConnect=abort;
      try{return await controller.manageIdentity(()=>connectProseAccount(store,vault,d,channel,{signal:abort.signal}))}
      finally{if(proseConnect===abort)proseConnect=undefined}
    }
    case 'account:cancel-prose':z.object({}).strict().parse(p??{});proseConnect?.abort();return {cancelled:!!proseConnect};
    case 'account:wordpress-status':z.object({}).strict().parse(p??{});return wordpressConnections.status();
    case 'account:authorize-wordpress':z.object({}).strict().parse(p??{});return wordpressConnections.authorize({openExternal:url=>openInPreferredBrowser(url,store.read().settings.preferredBrowser,value=>shell.openExternal(value))});
    case 'account:cancel-wordpress':z.object({}).strict().parse(p??{});wordpressConnections.cancel();return {cancelled:true};
    case 'account:connect-wordpress':{
      const d=z.object({sessionId:z.string().uuid(),blogId:z.string().regex(/^\d{1,32}$/),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);
      return controller.manageIdentity(()=>wordpressConnections.connect(d));
    }
    case 'account:connect-paragraph':{const d=z.object({apiKey:z.string().trim().min(8).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectParagraph(store,vault,d.apiKey,d.siteIds,d.accountId));}
    case 'account:connect-hackmd':{const d=z.object({token:z.string().min(16).max(8192),accountId:z.string().uuid().optional(),siteIds:z.array(z.string().uuid()).length(1)}).strict().parse(p);return controller.manageIdentity(()=>connectHackMd(store,vault,d));}
    case 'account:connect-gitbook':{const d=z.object({token:z.string().trim().min(16).max(4096),accountId:z.string().uuid().optional(),siteIds:z.array(z.string().uuid()).min(1).max(1000),organizationId:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional(),siteId:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional(),spaceId:z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional()}).strict().parse(p);return controller.manageIdentity(()=>connectGitBookAccount(store,vault,d));}
    case 'account:connect-valtown':{const d=z.object({token:z.string().trim().min(16).max(4096),siteIds:z.array(z.string().uuid()).min(1).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectValTownAccount(store,vault,d));}
    case 'account:connect-bitbucket':{const evidence=z.object({version:z.literal(1),workspaceId:z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),plan:z.literal('Free'),users:z.number().int().min(1).max(5),paymentAdded:z.literal(false),paidTrialSelected:z.literal(false),checkedAt:z.string().datetime(),stateSha256:z.string().regex(/^[a-f0-9]{64}$/),screenshotSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();const d=z.object({token:z.string().trim().min(16).max(4096),workspaceSlug:z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),projectUuid:z.string().regex(/^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i),freePlanEvidence:evidence,siteIds:z.array(z.string().uuid()).length(1),accountId:z.string().uuid().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectBitbucketAccount(store,vault,d));}
    case 'account:connect-leaflet':{const d=z.object({handle:z.string().trim().min(3).max(253),appPassword:z.string().min(1).max(128),accountId:z.string().uuid().optional(),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);return controller.manageIdentity(()=>connectLeaflet(store,vault,d));}
    case 'account:raindrop-collections':{
      const d=z.object({token:z.string().min(16).max(8192)}).strict().parse(p);if(raindropConnect)throw Error('Raindrop 连接正在进行');const abort=new AbortController();raindropConnect=abort;
      try{return await controller.manageIdentity(()=>discoverRaindropCollections(d.token,{signal:abort.signal}))}
      finally{if(raindropConnect===abort)raindropConnect=undefined}
    }
    case 'account:connect-raindrop':{
      const d=z.object({token:z.string().min(16).max(8192),collectionId:z.string().regex(/^[1-9][0-9]*$/),publicUrl:z.string().trim().max(2048),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);if(raindropConnect)throw Error('Raindrop 连接正在进行');const abort=new AbortController();raindropConnect=abort;
      try{return await controller.manageIdentity(()=>connectRaindrop(store,vault,d,{signal:abort.signal}))}
      finally{if(raindropConnect===abort)raindropConnect=undefined}
    }
    case 'account:cancel-raindrop-connect':z.object({}).strict().parse(p??{});raindropConnect?.abort();return {cancelled:!!raindropConnect};
    case 'account:connect-here-now':{
      const d=z.object({apiKey:z.string().min(20).max(8192).optional(),existingSiteUrl:z.string().trim().url().max(2048).optional(),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional()}).strict().parse(p);if(!d.apiKey&&!d.accountId)throw Error('新建 here.now 连接需要命名 API key');if(hereNowConnect)throw Error('here.now 账号验证正在进行');const abort=new AbortController();hereNowConnect=abort;
      try{return await controller.manageIdentity(()=>connectHereNow(store,vault,d,{signal:abort.signal}))}
      finally{if(hereNowConnect===abort)hereNowConnect=undefined}
    }
    case 'account:cancel-here-now':z.object({}).strict().parse(p??{});hereNowConnect?.abort();return {cancelled:!!hereNowConnect};
    case 'account:request-here-now-code':{
      const d=z.object({email:z.string().trim().email().max(254),siteId:z.string().uuid().optional()}).strict().parse(p);if(hereNowConnect)throw Error('here.now 邮箱连接正在进行');const abort=new AbortController();hereNowConnect=abort;
      try{return await controller.manageIdentity(()=>requestHereNowCode(store,d.email,{signal:abort.signal,siteId:d.siteId}))}
      finally{if(hereNowConnect===abort)hereNowConnect=undefined}
    }
    case 'account:resend-here-now-code':{
      const d=z.object({accountId:z.string().uuid()}).strict().parse(p);if(hereNowConnect)throw Error('here.now 邮箱连接正在进行');const abort=new AbortController();hereNowConnect=abort;
      try{return await controller.manageIdentity(()=>resendHereNowCode(store,d.accountId,{signal:abort.signal}))}
      finally{if(hereNowConnect===abort)hereNowConnect=undefined}
    }
    case 'account:verify-here-now-code':{
      const d=z.object({accountId:z.string().uuid(),code:z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);if(hereNowConnect)throw Error('here.now 邮箱连接正在进行');const abort=new AbortController();hereNowConnect=abort;
      try{return await controller.manageIdentity(()=>verifyHereNowCode(store,vault,d,{signal:abort.signal}))}
      finally{if(hereNowConnect===abort)hereNowConnect=undefined}
    }
    case 'account:recover-here-now-verify':{
      const d=z.object({accountId:z.string().uuid(),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);if(hereNowConnect)throw Error('here.now 邮箱连接正在进行');const abort=new AbortController();hereNowConnect=abort;
      try{return await controller.manageIdentity(()=>recoverHereNowVerifiedResponse(store,vault,d,{signal:abort.signal}))}
      finally{if(hereNowConnect===abort)hereNowConnect=undefined}
    }
    case 'account:request-shiply-code':{
      const d=z.object({email:z.string().trim().email().max(254),siteId:z.string().uuid().optional()}).strict().parse(p);if(shiplyConnect)throw Error('Shiply 邮箱账号连接正在进行');const abort=new AbortController();shiplyConnect=abort;
      try{return await controller.manageIdentity(()=>requestShiplyCode(store,d.email,{signal:abort.signal,siteId:d.siteId}))}
      finally{if(shiplyConnect===abort)shiplyConnect=undefined}
    }
    case 'account:resend-shiply-code':{
      const d=z.object({accountId:z.string().uuid()}).strict().parse(p);if(shiplyConnect)throw Error('Shiply 邮箱账号连接正在进行');const abort=new AbortController();shiplyConnect=abort;
      try{return await controller.manageIdentity(()=>resendExpiredShiplyCode(store,d.accountId,{signal:abort.signal}))}
      finally{if(shiplyConnect===abort)shiplyConnect=undefined}
    }
    case 'account:verify-shiply-code':{
      const d=z.object({accountId:z.string().uuid(),code:z.string().regex(/^\d{6}$/),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);if(shiplyConnect)throw Error('Shiply 邮箱账号连接正在进行');const abort=new AbortController();shiplyConnect=abort;
      try{return await controller.manageIdentity(()=>verifyShiplyCode(store,vault,d,{signal:abort.signal}))}
      finally{if(shiplyConnect===abort)shiplyConnect=undefined}
    }
    case 'account:recover-shiply-verify':{
      const d=z.object({accountId:z.string().uuid(),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);return controller.manageIdentity(()=>recoverShiplyVerifiedResponse(store,vault,d));
    }
    case 'account:connect-bluesky':{const d=z.object({handle:z.string().trim().min(3).max(253),appPassword:z.string().min(1).max(128),accountId:z.string().uuid().optional(),siteIds:z.array(z.string().uuid()).max(1000),mailboxId:z.string().uuid().nullable().optional()}).strict().parse(p);return controller.manageIdentity(()=>connectBluesky(store,vault,d.handle.replace(/^@/,''),d.appPassword,{},d.accountId,{siteIds:d.siteIds,mailboxId:d.mailboxId}));}
    case 'account:connect-gist':{const d=z.object({token:z.string().trim().min(8).max(512),accountId:z.string().uuid().optional()}).parse(p);return await controller.connectGist(d.token,d.accountId);}
    case 'account:connect-product-index':{const d=z.object({token:z.string().trim().min(8).max(512),accountId:z.string().uuid().optional(),siteIds:z.array(z.string().uuid()).max(1000)}).strict().parse(p);return await controller.connectProductIndex(d);}
    case 'account:connect-carcinus-existing':{const d=z.object({siteId:z.string().uuid(),exportJson:z.string().min(1).max(600_000)}).strict().parse(p);return await controller.connectCarcinusExistingPage(d);}
    case 'search:save-key':{const {key,enabled}=z.object({key:z.string().min(1).max(1024),enabled:z.boolean()}).parse(p);await vault.set('bingKey',key.trim());store.update(s=>{s.settings.hasBingKey=true;s.settings.monitorSearch=enabled});break;}
    case 'search:bing':await controller.checkSearch(getId(p));break;
    case 'search:import-gsc-batch':{
      const file=await dialog.showOpenDialog(win!,{title:'选择 Google 报告 CSV（可以一次选多个，来自不同 Google 账号也行）',properties:['openFile','multiSelections'],filters:[{name:'CSV',extensions:['csv']}]});if(file.canceled)return {imported:[],unassigned:[],cancelled:true};
      if(!file.filePaths.length||file.filePaths.length>20)throw Error('一次最多选 20 个 CSV 文件');
      const fileStats=await Promise.all(file.filePaths.map(path=>stat(path)));if(fileStats.some(value=>!value.isFile())||fileStats.reduce((bytes,value)=>bytes+value.size,0)>2_000_000)throw Error('所选 CSV 文件合计超过 2 MB');
      const files=await Promise.all(file.filePaths.map(async path=>({name:basename(path),csv:await readFile(path,'utf8')}))),before=store.read();
      const {bySite,unassigned}=assignGscFiles(files,before.sites.map(site=>({id:site.id,publishedUrls:before.tasks.filter(task=>task.siteId===site.id&&task.publicUrl).map(task=>task.publicUrl!)})));
      const imported:Array<{siteId:string;domain:string;sources:number}>=[];const backupSecrets=vault.exportSecrets();
      try{store.update(s=>{for(const [siteId,csvs] of bySite){const x=s.sites.find(item=>item.id===siteId);if(!x)continue;const report=parseGscLinksCsvFiles(csvs);const merged=mergeGscImport(x.searchReports?.gsc,report,s.tasks.filter(task=>task.siteId===siteId&&task.publicUrl).map(task=>task.publicUrl!));x.searchReports={...x.searchReports,gsc:merged.report};imported.push({siteId,domain:x.domain,sources:report.sources.length})}assertPortableBackupFits({state:s,secrets:backupSecrets})})}finally{for(const key of Object.keys(backupSecrets))backupSecrets[key]=''}
      return {imported,unassigned};
    }
    case 'search:import-gsc':{
      const id=getId(p),site=store.read().sites.find(s=>s.id===id);if(!site)throw Error('网站不存在');const expected={domain:site.domain,url:site.url,createdAt:site.createdAt};const file=await dialog.showOpenDialog(win!,{title:'选择 '+site.domain+' 的 GSC 外部链接来源 CSV',properties:['openFile','multiSelections'],filters:[{name:'GSC CSV',extensions:['csv']}]});if(file.canceled)return;
      if(!file.filePaths.length||file.filePaths.length>20)throw Error('请选择 1 至 20 个 GSC CSV 文件');
      const fileStats=await Promise.all(file.filePaths.map(path=>stat(path)));if(fileStats.some(value=>!value.isFile())||fileStats.reduce((bytes,value)=>bytes+value.size,0)>2_000_000)throw Error('所选 CSV 文件合计超过 2 MB');
      const csvs=await Promise.all(file.filePaths.map(path=>readFile(path,'utf8'))),report=parseGscLinksCsvFiles(csvs);
      const confirm=await dialog.showMessageBox(win!,{type:'question',message:'确认这是 '+site.domain+' 的 GSC 外部链接报告？',detail:'CSV 本身不包含可校验的网站归属。仅导入来源网页，不提交索引。',buttons:['取消','导入'],defaultId:0,cancelId:0});if(confirm.response!==1)return;
      let newlyDiscovered:string[]=[];const backupSecrets=vault.exportSecrets();
      try{store.update(s=>{const x=s.sites.find(s=>s.id===id);if(!x||x.domain!==expected.domain||x.url!==expected.url||x.createdAt!==expected.createdAt)throw Error('网站资料已变化，请重新选择对应资源并导入');const merged=mergeGscImport(x.searchReports?.gsc,report,s.tasks.filter(task=>task.siteId===id&&task.publicUrl).map(task=>task.publicUrl!));newlyDiscovered=merged.newlyDiscovered;x.searchReports={...x.searchReports,gsc:merged.report};assertPortableBackupFits({state:s,secrets:backupSecrets})})}finally{for(const key of Object.keys(backupSecrets))backupSecrets[key]=''}
      const notice=gscDiscoveryNotice(store.read().settings.notify,expected.domain,newlyDiscovered);if(notice)try{controller.onNotice?.(notice.title,notice.body)}catch{/* Notification failure must not roll back a committed import. */}break;
    }
    case 'site:delete':controller.deleteSite(getId(p));break;
    case 'site:pause':{const d=z.object({id:z.string().uuid(),paused:z.boolean()}).parse(p);controller.sitePause(d.id,d.paused);break;}
    case 'site:migrate-origin':{
      await controller.waitForIdle({siteIds:[payloadId(p)]});const d=z.object({id:z.string().uuid(),expectedDomain:z.string().min(3).max(253),expectedUrl:z.url().max(2048),newUrl:z.string().trim().min(1).max(2048),recoveryTaskId:z.string().uuid().optional(),operatorAuthorized:z.literal(true)}).strict().parse(p),site=store.read().sites.find(value=>value.id===d.id);
      if(!site||site.status!=='paused'||site.domain!==d.expectedDomain||site.url!==d.expectedUrl)throw Error('网站必须保持暂停且来源未改变，才能迁移');
      const preview=structuredClone(store.read()),previewRecord=applySiteOriginMigration(preview,{siteId:d.id,expectedDomain:d.expectedDomain,expectedUrl:d.expectedUrl,newUrl:d.newUrl,operatorAuthorized:true,recoveryTaskId:d.recoveryTaskId,resumeStatus:'ready'},new Date());if(d.recoveryTaskId)activateSiteOriginRecoveryGrant(preview,d.id,d.recoveryTaskId,new Date());
      const recovery=previewRecord.recovery?.before,channelName=recovery?controller.channels().find(value=>value.id===recovery.channelId)?.name??recovery.channelId:undefined;
      const confirm=await dialog.showMessageBox(win!,{type:'warning',title:'迁移网站来源',message:`确认把 ${site.url} 迁移到 ${previewRecord.after.url}？`,detail:`迁移会保留同一网站记录、每月目标、历史外链、账号绑定和发布间隔。旧 Telegraph 外链继续按旧来源检查；当前搜索报告会归档并重新获取。${recovery?`将只恢复所选 ${channelName} 原任务一次；原尝试 ${recovery.attempts} 次、AI 调用 ${recovery.cost?.aiCalls??0} 次及换题记录全部保留。`:'不会自动恢复旧失败任务。'} 迁移成功后只恢复这个网站的计划，不改变全局自动执行或其他网站。`,buttons:['取消','确认迁移并恢复网站'],defaultId:0,cancelId:0});
      if(confirm.response!==1)return {cancelled:true};
      await controller.waitForIdle({siteIds:[d.id]});const now=new Date();store.update(state=>{applySiteOriginMigration(state,{siteId:d.id,expectedDomain:d.expectedDomain,expectedUrl:d.expectedUrl,newUrl:d.newUrl,operatorAuthorized:true,recoveryTaskId:d.recoveryTaskId,resumeStatus:'ready'},now);if(d.recoveryTaskId)activateSiteOriginRecoveryGrant(state,d.id,d.recoveryTaskId,now)});controller.plan();void controller.tick();return {ok:true};
    }
    case 'site:analyze':await controller.waitForIdle({siteIds:[payloadId(p)]});void controller.analyze(getId(p));break;
    case 'task:approve':{await controller.waitForIdle({taskIds:[payloadId(p)]});const id=getId(p),state=store.read(),task=state.tasks.find(t=>t.id===id),site=task?state.sites.find(item=>item.id===task.siteId):undefined;if(!task?.draft?.body||!site||(hasUnresolvedExternalAttempt(task)&&!hasRecoverablePublisherDraftReceipt(task))||((task.submittedAt||task.agentboard||task.agentsWiki||task.paper||task.hive||task.mataroa||task.verbose||task.prose||task.rentry||task.lucid||task.wordpress||task.leaflet||task.raindrop||task.supanote||task.docsMd||task.katbin||task.pstrs||task.agentdrop||task.listedStartups||task.productIndex||task.totpage||task.mdview||task.txtsbs||task.pastyx||task.nextgenSlides||task.yourwebs||task.pastemyst||task.markdownPaste||task.htmlApp||task.memoryWiki)&&!hasRecoverablePublisherDraftReceipt(task))||task.checkpoint!=='article_review')throw Error('当前没有待确认文章');assertHumanWaitOpen(task);const aiMode=getArticleReviewMode(site,state.settings)==='ai';controller.patch(id,{articleApprovedAt:new Date().toISOString(),articleReview:undefined,status:'queued',scheduledAt:new Date().toISOString(),message:aiMode?'人工已检查，仍需 AI 独立核对后才会发布':'文章已确认，等待发布'});void controller.tick();break;}
    case 'task:review-once':{
      await controller.waitForIdle({taskIds:[payloadId(p)]});if(activeCommands.size>1)throw Error('另一个操作正在进行，请勿重复点击追加审核');
      const id=getId(p),summary=controller.oneReviewRetrySummary(id);
      const confirm=await dialog.showMessageBox(win!,{type:'warning',title:'追加一次 AI 复核',message:`确认给 ${summary.siteDomain} 的 ${summary.channelName} 稿件追加一次 AI 复核？`,detail:BATCH9B_MESSAGES.reviewRetryDetail(summary.draftRevision),buttons:['取消','确认追加 1 次审核'],defaultId:0,cancelId:0});
      if(confirm.response!==1)return {cancelled:true};
      await controller.waitForIdle({taskIds:[payloadId(p)]});if(activeCommands.size>1)throw Error('另一个操作正在进行，本次确认未执行');
      return controller.reviewArticleOnce(id);
    }
    case 'task:retry':{
      const id=getId(p),t=store.read().tasks.find(t=>t.id===id);if(!t)throw Error('任务不存在');if(t.status==='running')throw Error('任务正在执行');assertHumanWaitOpen(t);
      if(t.firstLiveAt)throw Error('此平台已获得过外链，可检查现有结果，无需重复提交');
      if(t.checkpoint==='verbose_account_create_pending'&&!t.deferredAt)throw Error('Verbose 一次性令牌注册结果未明，原发布账号不可重注册');
      if(taskRetryHasExternalAttempt(t)){if(t.publicUrl){await controller.verify(id);break;}throw Error(t.channelId==='agentboard'?'已有 Agentboard 固定发布账号或单次主帖操作记录；只会查询原结果，不会重新注册、换主页或重复提交。':t.channelId==='agentswiki'?'已有 Agents Wiki 单次发布的提交信息；只会按原 agent、原加密响应与公开接口恢复，绝不重复提交。':t.channelId==='mataroa'?'已有 Mataroa 投稿的提交信息；原账号检查最多三次，不会重新投稿。':t.channelId==='verbose'?'已有 Verbose 投稿的提交信息；仅按原作者与 slug 检查，不会重新投稿。':t.channelId==='prose'?'已有 Prose 原文件返回记录；仅按原发布账号与固定文件名检查，不会重新上传。':t.channelId==='supanote'?'已有 Supanote 单次提交信息；缺少公开 ID 时停止查询且不会重新投稿。':t.channelId==='docs-md'?'已有 Docs MD 单次提交信息；缺少公开 ID 时停止查询且不会重新投稿。':t.channelId==='nextgen-slides'?'已有 NextgenSlides 单次提交信息；缺少完整服务端标识时停止查询且不会重新提交。':t.channelId==='yourwebs'?'已有 Yourwebs 单次提交信息；缺少完整服务端标识时停止查询且不会重新提交。':t.channelId==='memorywiki'?'已有 Memory.wiki 单次创建计划；缺少公开 ID 时停止查询且绝不会重发。':t.channelId==='totpage'?'已有 Totpage 单次提交信息；缺少完整服务端标识时停止查询且不会重新提交。':t.channelId==='mdview'?'已有 MDView 单次提交信息；缺少完整文档标识时停止查询且不会重新提交。':t.channelId==='txtsbs'?'已有 txt.sbs 单次表单提交信息；缺少完整页面标识时停止查询且不会重新提交。':t.channelId==='pastyx'?'已有 PastyX 单次投稿的提交信息和加密编辑密钥；缺少完整页面标识时停止查询且不会重新提交。':t.channelId==='agentdrop'?'已有 AgentDrop 单次提交信息；缺少完整服务端标识时停止查询且不会重新提交。':t.channelId==='product-index'?'已有 AI Product Index 单次 issue 操作记录；只会按同一 GitHub 发布账号和逐字相同正文找回，不会重复提交。':t.channelId==='html-app'?'已有 ht-ml.app 单次创建计划；缺少 site id 时停止查询且不会重新发布。':'已有提交记录。请打开平台检查结果，并填写外链网址后检查；不会重复投稿。');}
      if(t.deferredAt){store.update(state=>resumeDeferredTask(state.tasks,id,state.settings));void controller.tick();break;}
      if(t.attempts>=store.read().settings.maxAttempts)throw Error('已达重试上限，请检查原因或跳过此平台。');
      controller.patch(id,{status:'queued',scheduledAt:new Date().toISOString(),message:'准备继续执行'});void controller.tick();break;
    }
    case 'task:skip':{const id=getId(p);if(controller.runtime.activeTaskId===id)throw Error('请先暂停当前任务');controller.patch(id,{status:'skipped',reasonCode:'user_skipped',message:'已跳过，保留记录避免重复提交'});controller.plan();break;}
    case 'task:verify':await controller.verify(getId(p),{manualRecovery:true});break;
    case 'task:remove-referral':{await controller.waitForIdle({taskIds:[payloadId(p)]});const result=await controller.removePublicReferral(getId(p));if(!result.ok)throw Error(result.message);return result;}
    case 'task:acknowledge-remote':{await controller.waitForIdle({taskIds:[payloadId(p)]});controller.acknowledgeRemoteContent(getId(p));break;}
    case 'task:set-url':{
      const input=z.object({id:z.string().uuid(),url:z.string().max(2048)}).parse(p),u=publicUrl(input.url);const t=store.read().tasks.find(t=>t.id===input.id);if(!t)throw Error('任务不存在');
      if(t.channelId==='github-gist'){await controller.waitForIdle({taskIds:[t.id]});await controller.adoptGist(t.siteId,u.href);break;}
      if(t.channelId==='listed-startups')throw Error('Listed Startups 只检查原来那一次提交成功记录对应的产品页；不接受手动填写');
      if(t.channelId==='product-index')throw Error('AI Product Index 仅检查原 GitHub issue 工作流绑定的公开页；不接受手动代填');
      if(t.channelId==='leaflet'){
        if(t.leaflet?.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||t.leaflet.url!==u.href)throw Error('仅检查原 Leaflet 返回记录确认的文章；未知结果会按原作者和稿件检查');
      }
      if(t.channelId==='raindrop'){
        if(t.raindrop?.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||u.href!==store.read().accounts.find(account=>account.id===t.accountId)?.raindrop?.publicUrl)throw Error('仅检查原 Raindrop 账号、合集和内容返回记录已确认的公开页；不接受手动代填');
      }
      if(t.channelId==='wordpress-com'){
        if(t.wordpress?.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||t.wordpress.url!==u.href)throw Error('仅检查原博客返回记录中已确认的文章；未知结果将按原博客和原稿检查');
      }else if(t.channelId==='mataroa'){
        const receipt=t.mataroa;
        if(!receipt?.slug||u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||u.hostname!==`${receipt.username}.mataroa.blog`||![`/blog/${receipt.slug}/`,`/p/${receipt.slug}/`].includes(u.pathname))throw Error('请等待原账号检查找回 Mataroa 结果，不接受其他页面代替原投稿');
      }else if(t.channelId==='verbose'){
        const receipt=t.verbose;
        if(!receipt||receipt.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||u.href!==`https://verbose.blog/${receipt.username}/${receipt.slug}`)throw Error('Verbose 仅检查已由原账号检查原记录确认的同一文章；不接受手动代填发布结果');
      }else if(t.channelId==='prose'){
        const receipt=t.prose;
        if(!receipt||receipt.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||u.href!==`https://${receipt.username}.prose.sh/${receipt.filename.slice(0,-3)}`)throw Error('Prose 仅检查原发布账号、固定文件名和完整正文已确认的同一文章；不接受手动代填发布结果');
      }else if(t.channelId==='rentry'||t.channelId==='lucid-page'){
        const receipt=t.channelId==='rentry'?t.rentry:t.lucid,origin=t.channelId==='rentry'?'https://rentry.co':'https://lucid.page';
        if(!receipt?.slug||receipt.stage!=='published'||!t.submittedAt||t.publicUrl!==u.href||u.href!==`${origin}/${receipt.slug}`)throw Error('仅检查原投稿记录中的完整文章，不接受其他页面代替结果');
      }else if(t.channelId==='betterthanhtml'){
        if(!isConfirmedBetterThanHtmlResultUrl(t,u.href))throw Error('Better Than HTML 仅检查原返回记录已确认的同一 Workshop 文章；未知结果不接受手动代填');
      }else if(t.channelId==='supanote'){
        if(!isConfirmedSupanoteResultUrl(t,u.href))throw Error('Supanote 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='docs-md'){
        if(!isConfirmedDocsMdResultUrl(t,u.href))throw Error('Docs MD 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='katbin'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedKatbinResultUrl(t,u.href,site))throw Error('Katbin 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='mdshare'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedMDShareResultUrl(t,u.href,site))throw Error('MDShare 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='pastemyst'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedPasteMystResultUrl(t,u.href,site))throw Error('PasteMyst 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='pstrs'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedPstrsResultUrl(t,u.href,site))throw Error('PST.RS 仅检查平台原始返回记录绑定的同一公开 Markdown；未知结果不接受手动代填');
      }else if(t.channelId==='nextgen-slides'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedNextgenSlidesResultUrl(t,u.href,site))throw Error('NextgenSlides 仅检查平台原始返回记录绑定的同一服务端分配网页；未知结果不接受手动代填');
      }else if(t.channelId==='yourwebs'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedYourwebsResultUrl(t,u.href,site))throw Error('Yourwebs 仅检查平台原始返回记录绑定的同一服务端分配网页；未知结果不接受手动代填');
      }else if(t.channelId==='totpage'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedTotpageResultUrl(t,u.href,site))throw Error('Totpage 仅检查平台原始返回记录绑定的同一服务端分配网页；未知结果不接受手动代填');
      }else if(t.channelId==='mdview'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedMDViewResultUrl(t,u.href,site))throw Error('MDView 仅检查平台原始返回记录绑定的同一 30 天有限期文档；未知结果不接受手动代填');
      }else if(t.channelId==='txtsbs'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedTxtSbsResultUrl(t,u.href,site))throw Error('txt.sbs 仅检查原表单返回记录绑定的同一公开页面；未知结果不接受手动代填');
      }else if(t.channelId==='pastyx'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedPastyXResultUrl(t,u.href,site))throw Error('PastyX 仅检查平台原始返回记录绑定的同一公开页面；未知结果不接受手动代填');
      }else if(t.channelId==='agentdrop'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedAgentDropResultUrl(t,u.href,site))throw Error('AgentDrop 仅检查平台原始返回记录绑定的同一服务端分配网页；未知结果不接受手动代填');
      }else if(t.channelId==='markdownpaste'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedMarkdownPasteResultUrl(t,u.href,site))throw Error('Markdown Pastebin 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='memorywiki'){
        const site=store.read().sites.find(item=>item.id===t.siteId);if(!site||!isConfirmedMemoryWikiResultUrl(t,u.href,site))throw Error('Memory.wiki 仅检查原加密平台返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='html-app'){
        if(!isConfirmedHtmlAppResultUrl(t,u.href))throw Error('ht-ml.app 仅检查平台原始返回记录绑定的同一公开文章；未知结果不接受手动代填');
      }else if(t.channelId==='notebin'){
        if(t.notebin?.stage!=='owned'||t.notebin.ownership!=='owned_list_match'||t.notebin.retention!=='no_scheduled_expiry'||t.notebin.expiresAt!==null||t.notebinJournal?.stage!=='owned'||t.notebin.publicUrl!==u.href||t.notebin.viewUrl!==u.href||t.notebinJournal.receipt?.publicUrl!==u.href||t.publicUrl!==u.href)throw Error('Notebin 仅检查原专用密钥和 owned list 已确认的同一公开笔记；未知结果不接受手工代填');
      }else if(!belongsToSource(u.href,t.sourceDomain))throw Error('结果网址必须属于对应平台');controller.patch(input.id,{publicUrl:u.href,...(t.publicUrl!==u.href?{verifiedAt:undefined,lastCheckedAt:undefined,linkRel:undefined,linkCheck:undefined,status:'review' as const,reviewKind:'manual_url' as const,reviewUntil:new Date(Date.now()+30*86400000).toISOString(),nextCheckAt:new Date().toISOString(),health:'unknown' as const}: {})});await controller.verify(input.id);break;
    }
    case 'human-action:open': await controller.openHumanAction(getId(p));break;
    case 'human-action:done': await controller.doneHumanAction(getId(p));break;
    case 'human-action:skip': controller.skipHumanAction(getId(p));break;
    case 'task:open':{
      const id=getId(p),state=store.read(),task=state.tasks.find(item=>item.id===id);
      if(!task)throw Error('任务不存在');
      const channel=controller.channels().find(item=>item.id===task.channelId);
      if(!channel)throw Error('任务关联的平台已不存在');
      if(channel.automation!=='browser'){
        const url=publicUrl(channel.submitUrl);
        if(!isAllowedTaskUrl(url.href,channel.allowedHosts))throw Error('平台提交地址不在允许的 HTTPS 域名内');
        await openInPreferredBrowser(url.href,state.settings.preferredBrowser,value=>shell.openExternal(value));
        return;
      }
      await controller.manualOpen(id);break;
    }
    case 'task:open-result':{const id=getId(p),task=store.read().tasks.find(item=>item.id===id);if(!task?.publicUrl)throw Error('任务还没有外链网址');const url=publicUrl(task.publicUrl);await openInPreferredBrowser(url.href,store.read().settings.preferredBrowser,value=>shell.openExternal(value));return;}
    case 'task:generate':{await controller.waitForIdle({taskIds:[payloadId(p)]});await controller.generateDraft(getId(p));break;}
    case 'task:update-draft':{
      const d=z.object({id:z.string().uuid(),title:z.string().min(1).max(150),description:z.string().max(3000),body:z.string().max(30000)}).strict().parse(p);let queue=false;store.update(state=>{queue=saveTaskDraft(state,d.id,{title:d.title,description:d.description,body:d.body})});if(queue)void controller.tick();break;
    }
    case 'plan:run':store.update(s=>{s.settings.autoRun=true});void controller.tick();break;
    case 'plan:pause':controller.pause();break;
    case 'ahrefs.saveAndTest':{
      const {apiKey}=z.object({apiKey:z.string().max(1024)}).strict().parse(p);
      return controller.saveAhrefsAndTest(apiKey);
    }
    case 'settings:save':{
      const input=SettingsPatch.parse(p);if(input.apiBase)input.apiBase=normalizeApiBase(input.apiBase);
      if(!app.isPackaged&&input.launchAtLogin)throw Error('开机启动请在正式版外链助手中开启');
      if(input.apiBase)publicUrl(input.apiBase);
      const result=withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},input.launchAtLogin,()=>saveSettingsAtomic(store,vault,input));
      if(result.ahrefsChanged)controller.ahrefs.resetAfterKeyChange();
      if(result.mailSecretChanged)controller.runtime.mailReady=false;
      const reviewModeSites=result.reviewModeSites;for(const id of reviewModeSites)controller.resumeArticleReviews(id);
      await detectAi();controller.plan();if(reviewModeSites.length)void controller.tick();break;
    }
    case 'channel:enable-trial':{
      const {id}=z.object({id:z.string().min(1).max(100)}).strict().parse(p);
      controller.enableStoppedChannelTrial(id);
      controller.plan();void controller.tick();break;
    }
    case 'channel:accept-html-app-public-notice':{
      if(!validHtmlAppPublicNoticeAcknowledgement(p))throw Error('ht-ml.app 公开发布告知确认无效');
      acceptHtmlAppPublicNotice(store,p);controller.plan();void controller.tick();break;
    }
    case 'settings:adopt-ai-limit':return controller.applyRecommendedDailyAiLimit();
    case 'settings:test-ai':{const result=await testAi(store.read().settings,vault);controller.runtime.aiReady=result.ok;broadcast();return result;}
    case 'settings:test-mail':{const result=await testMail(store.read().settings,vault);controller.runtime.mailReady=result.ok;broadcast();return result;}
    case 'settings:discover-models':{
      const input=z.object({provider:z.enum(['codex','api','claude']).optional(),apiBase:z.url().max(1024).optional(),apiKey:z.string().max(1024).optional(),codexPath:z.string().max(1024).optional(),claudePath:z.string().max(1024).optional(),model:z.string().max(120).optional()}).parse(p??{});
      const saved=store.read().settings,normalizedBase=input.apiBase?normalizeApiBase(input.apiBase):undefined,settings={...saved,...input,...(normalizedBase?{apiBase:normalizedBase}:{})};if(settings.provider==='api'&&!settings.apiBase)throw Error('请填写 API 地址');
      const secrets=scopedApiSecrets(saved.apiBase,settings.apiBase,input.apiKey,vault);
      const result=await discoverModels(settings,secrets);controller.aiModels=result;broadcast();return result;
    }
    case 'mailbox:save':{
      const input=MailboxPayload.parse(p);await saveMailboxAndTestAtomic(store,input,secrets=>vault.encryptSecrets(secrets),{getPassword:key=>vault.get(key)});
      return controller.snapshot();
    }
    case 'mailbox:test':{
      const input=z.object({id:z.string().uuid().optional(),label:z.string().max(100).optional(),host:z.string().max(253).optional(),port:z.number().int().min(1).max(65535).optional(),user:z.email().max(254).optional(),secure:z.literal(true).optional(),password:z.string().max(1024).optional(),aliases:z.array(z.email()).max(1000).optional()}).parse(p??{});
      const saved=input.id?store.read().mailboxes.find(item=>item.id===input.id):undefined;if(input.id&&!saved)throw Error('收件箱不存在');
      const preview=prepareMailboxTest(saved,input),stored=saved&&!preview.identityChanged?await vault.get('mailbox:'+saved.id):undefined,{mailbox,password,canMarkVerified}=prepareMailboxTest(saved,input,stored);const result=await testMailbox(mailbox,password);
      if(saved&&canMarkVerified)store.update(state=>{const current=state.mailboxes.find(item=>item.id===saved.id);if(current){current.updatedAt=new Date().toISOString();current.verifiedAt=result.ok?current.updatedAt:current.verifiedAt;current.lastError=result.ok?undefined:result.message}});if(canMarkVerified)controller.runtime.mailReady=result.ok;broadcast();return result;
    }
    case 'mailbox:delete':{const id=getId(p);store.update(state=>deleteMailbox(state,id));await vault.delete('mailbox:'+id);return controller.snapshot();}
    case 'mailbox:import':{
      const {items}=z.object({items:z.array(MailboxPayload).min(1).max(100)}).parse(p);await importMailboxesAndTestAtomic(store,items,secrets=>vault.encryptSecrets(secrets),{getPassword:key=>vault.get(key)});return controller.snapshot();
    }
    case 'account:save':{
      await controller.waitForIdle({accountIds:[payloadId(p)]});const input=AccountInput.parse(p);if(['verbose','rentry','lucid-page','vibedrop','notebin','berrry','agenthow','swarmmemo','openagentchat','agentriot','shellbook','agentnotepad','colony','large-language'].includes(input.channelId))throw Error('此平台由任务自动准备，不接受手工账号导入');if(['paper-wf','hive','mataroa','wordpress-com','leaflet','raindrop','prose','markest','deno','here-now','shiply'].includes(input.channelId))throw Error('请使用对应平台的连接入口验证账号');if(input.channelId==='blogger')throw Error('请使用连接Blogger完成Google授权和博客绑定');if(input.channelId==='github-gist')throw Error('请使用连接 GitHub Gist 验证并保存令牌');if(!controller.channels().some(c=>c.id===input.channelId))throw Error('平台不存在');
      if(input.channelId==='agentswiki')throw Error('请使用 Agents Wiki 专用 API key 验证与导入入口');
      const channel=controller.channels().find(item=>item.id===input.channelId)!;saveAccountAtomic(store,input,channel,secrets=>vault.encryptSecrets(secrets));break;
    }
    case 'account:transfer-owner':{await controller.waitForIdle({accountIds:[payloadId(p,'accountId')],siteIds:[payloadId(p,'fromSiteId'),payloadId(p,'toSiteId')]});const d=z.object({accountId:z.string().uuid(),fromSiteId:z.string().uuid(),toSiteId:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(p);store.update(state=>transferIdentityOwner(state,d.accountId,d.toSiteId,d));break;}
    case 'account:bind':{await controller.waitForIdle({accountIds:[payloadId(p,'accountId')],siteIds:[payloadId(p,'siteId')]});const d=z.object({accountId:z.string().uuid(),siteId:z.string().uuid(),channelId:z.string().max(100)}).parse(p),channel=controller.channels().find(item=>item.id===d.channelId);if(!channel)throw Error('平台不存在');if(channel.id==='blogger')throw Error('请使用Blogger专用入口绑定博客');store.update(state=>bindAccount(state,d.accountId,d.siteId,channel));break;}
    case 'account:unbind':{await controller.waitForIdle({accountIds:[payloadId(p,'accountId')],siteIds:[payloadId(p,'siteId')]});const d=z.object({accountId:z.string().uuid(),siteId:z.string().uuid(),channelId:z.string().max(100)}).parse(p);store.update(state=>unbindAccount(state,d.accountId,d.siteId,d.channelId));break;}
    case 'account:set-bindings':{
      await controller.waitForIdle({accountIds:[payloadId(p,'accountId')],siteIds:payloadIds(p,'siteIds')});const d=z.object({accountId:z.string().uuid(),mailboxId:z.string().uuid().nullable(),siteIds:z.array(z.string().uuid()).max(1000)}).parse(p),state=store.read(),account=state.accounts.find(item=>item.id===d.accountId);if(!account)throw Error('账号不存在');if(d.mailboxId&&!state.mailboxes.some(item=>item.id===d.mailboxId))throw Error('收件箱不存在');const channel=controller.channels().find(item=>item.id===account.channelId);if(!channel)throw Error('平台不存在');if(account.credentialKind==='oauth')throw Error('请使用Blogger专用入口管理授权和博客绑定');const selected=new Set(d.siteIds);if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('绑定的网站不存在');
      if(account.channelId==='agentswiki')throw Error('请使用 Agents Wiki 专用入口重新核对原 agent 和 API key 后更新网站绑定');
      store.update(draft=>{const current=draft.accounts.find(item=>item.id===d.accountId);if(!current)throw Error('账号不存在');current.mailboxId=d.mailboxId??undefined;current.updatedAt=new Date().toISOString();setSelectedAccountSites(draft,current.id,selected,channel);if(current.channelId==='mataroa')current.mataroaExcludedSiteIds=draft.sites.filter(site=>!selected.has(site.id)).map(site=>site.id);if(current.channelId==='verbose')current.verboseExcludedSiteIds=draft.sites.filter(site=>!selected.has(site.id)).map(site=>site.id);if(current.channelId==='rentry')current.rentryExcludedSiteIds=draft.sites.filter(site=>!selected.has(site.id)).map(site=>site.id);});break;
    }
    case 'account:retry':{
      await controller.waitForIdle({accountIds:[payloadId(p)]});const {id}=AccountRetry.parse(p),account=store.read().accounts.find(a=>a.id===id);if(!account)throw Error('账号不存在');
      if(account.channelId==='agentswiki')throw Error('Agents Wiki 单次注册前记录只能由原任务和原加密响应恢复；不能手工重试或重建发布账号');
      if(account.status==='restricted')throw Error('平台已报告账号或访问受限，不能自动规避或重试');
      if(account.status==='credentials_invalid')throw Error('请先编辑账号并更新密码');
      if(account.status==='unknown')throw Error('账号状态尚未确认，请先检查平台记录或导入正确登录信息');
      if(account.status==='registered')throw Error('账号已注册，无需重试注册');
      if(account.channelId==='notebin')throw Error('Notebin PoW 发布账号操作记录只能由原任务恢复；不能手工重试或重建发布账号');
      if(account.channelId==='shiply')throw Error('请从 Shiply 发布账号入口继续；仅原 code_sent 明确过期且无不明结果时可重发一次');
      if(account.status==='draft'&&account.source!=='generated')throw Error('只能重试本机生成且尚未创建的注册草稿');
      if(account.channelId==='verbose'&&(account.registrationAttempts??0)>0)throw Error('Verbose 注册只返回一次性令牌，已尝试的原发布账号不能自动重注册');
      if(account.diagnostic&&!account.diagnostic.retryable&&account.status!=='draft')throw Error('该账号异常需要人工处理');
      const now=new Date().toISOString();store.update(s=>{const a=s.accounts.find(a=>a.id===id);if(a){a.updatedAt=now;a.diagnostic=undefined}const sites=new Set(s.accountBindings.filter(binding=>binding.accountId===id).map(binding=>binding.siteId));for(const task of s.tasks){if((task.accountId===id||!task.accountId&&sites.has(task.siteId)&&task.channelId===account.channelId)&&!task.submittedAt&&!task.paper&&!task.hive&&!task.mataroa&&!task.verbose&&!task.prose&&!task.rentry&&!task.lucid&&!task.wordpress&&!task.leaflet&&!['paper_account_create_pending','mataroa_account_create_pending','verbose_account_create_pending'].includes(task.checkpoint??'')&&['needs_input','failed'].includes(task.status)){task.accountId=id;task.status='queued';task.scheduledAt=now;task.updatedAt=now;task.message=account.status==='needs_verification'?'准备继续验证账号':'准备重试未提交的注册草稿';}}});void controller.tick();break;
    }
    case 'account:reveal':{const id=getId(p),account=store.read().accounts.find(a=>a.id===id);if(!account)throw Error('账号不存在');if(!['paper-wf','mataroa'].includes(account.channelId)&&['api_token','oauth'].includes(account.credentialKind??''))throw Error('API 令牌不支持明文显示，请通过连接入口更新');await confirmSecret();return {password:accountLoginPassword(account,await vault.get('account:'+id))};}
    case 'account:delete':{
      await controller.waitForIdle({accountIds:[payloadId(p)]});
      const id=getId(p),state=store.read(),account=state.accounts.find(a=>a.id===id);
      if(account&&['colony','notebin','agenthow','rentry','verbose','paper-wf','mataroa','berrry','swarmmemo','openagentchat','agentriot','shellbook','agentnotepad','large-language','agentswiki','synthfolk','agentboard','valtown','bitbucket'].includes(account.channelId)){
        if(!identityRegistrationSettled(state,account))throw Error(ACCOUNT_IDENTITY_MESSAGES.registrationPending);
        if(account.channelId==='valtown'&&state.tasks.some(task=>task.accountId===account.id&&task.channelId==='valtown'&&!task.firstLiveAt&&!['skipped','expired'].includes(task.status)&&(!!task.submittedAt||!!task.valtown)))throw Error('Val Town 原发布仍待只读恢复或验收，处理完成前不能退役连接。');
        if(account.channelId==='bitbucket'&&state.tasks.some(task=>task.accountId===account.id&&task.channelId==='bitbucket'&&!task.firstLiveAt&&!['skipped','expired'].includes(task.status)&&(!!task.submittedAt||!!task.bitbucket)))throw Error('Bitbucket 原私有仓库或 root 提交仍待只读恢复/验收，处理完成前不能退役连接。');
        store.update(draft=>retireAccount(draft,id));
        break;
      }
      if(account?.credentialKind==='oauth')throw Error('此账号使用平台授权；请在对应平台的应用授权设置中撤销，发布账号和历史任务保留');if(account?.channelId==='berrry')throw Error('Berrry 应用发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='agenthow')throw Error('AgentHow 发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='swarmmemo')throw Error('SwarmMemo Ed25519 发布账号与原签名发布前记录必须保留用于找回，不能在外链助手中删除');if(account?.channelId==='openagentchat')throw Error('OpenAgentChat 发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='synthfolk')throw Error('Synthfolk 公开发布账号、一次性 API key 与原注册响应必须保留用于找回，不能在外链助手中删除');if(account?.channelId==='agentriot')throw Error('AgentRiot 发布账号、token 与固定发布前记录必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='shellbook')throw Error('Shellbook 发布账号、token 与固定发布前记录必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='agentnotepad')throw Error('AgentNotepad 发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='colony')throw Error('Colony 发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='large-language')throw Error('LargeLanguage 发布账号与 token 必须保留用于原发布恢复，不能在外链助手中删除');if(account?.channelId==='notebin')throw Error('Notebin PoW 根发布账号及专用密钥必须保留用于原返回记录找回，不能在外链助手中删除');if(account?.channelId==='shiply')throw Error('Shiply 邮箱账号、加密原始响应和 API key 必须保留用于原发布恢复，不能在外链助手中删除');if(state.tasks.some(task=>task.accountId===id))throw Error('该账号已归属历史任务，不能删除');if(state.accountBindings.some(binding=>binding.accountId===id))throw Error('该账号仍绑定网站，请先解除绑定');store.updateWithCiphers(s=>{s.accounts=s.accounts.filter(a=>a.id!==id)},{},['account:'+id]);break;}
    case 'channel:save':{const d=z.object({channel:z.unknown()}).parse(p);controller.saveCustomChannel(d.channel);break;}
    case 'channel:delete':{forbidBusy();const {id}=z.object({id:z.string().regex(/^custom-[0-9a-f-]{36}$/)}).parse(p);store.update(state=>{state.customChannels=deleteCustomChannel(state.customChannels??[],id,state.tasks.map(task=>task.channelId))});break;}
    case 'channel:import-metrics':{const d=z.object({rows:z.array(z.unknown()).min(1).max(1000)}).parse(p);const channels=controller.channels();store.update(state=>{state.channelMetrics=importChannelMetrics(state.channelMetrics??{},d.rows,channels)});break;}
    case 'backup:export':{
      const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showSaveDialog(win!,{title:'导出加密备份',defaultPath:'Linkflow-备份.lfb',filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled||!path.filePath)return {ok:false,message:'已取消'};
      if(controller.hasPendingWork()||activeCommands.size>1)throw Error('请等待当前操作完成后再导出备份');
      const buffer=encryptBackup({state:store.read(),secrets:vault.exportSecrets()},passphrase);await writeFile(path.filePath,buffer,{mode:0o600});return {ok:true,message:'加密备份已保存，请妥善保管口令'};
    }
    case 'backup:import':{
      ensureRestoreIdle();restoring=true;wordpressConnections.cancel();try{const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showOpenDialog(win!,{title:'恢复加密备份',properties:['openFile'],filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled)return {ok:false,message:'已取消'};
      const data=validateBackup(decryptBackup(await readFile(path.filePaths[0]),passphrase));
      const confirm=await dialog.showMessageBox(win!,{type:'warning',message:'用备份替换本机数据？',detail:'当前数据会自动保存为同口令的恢复前备份。恢复后自动执行保持暂停。',buttons:['取消','恢复'],defaultId:0,cancelId:0});if(confirm.response!==1)return {ok:false,message:'已取消'};
      ensureRestoreIdle();controller.closeTaskBrowsers();
      await writeFile(join(app.getPath('userData'),'恢复前备份.lfb'),encryptBackup({state:store.read(),secrets:await vault.exportSecrets()},passphrase),{mode:0o600});
      ensureRestoreIdle();data.state.settings={...defaultSettings(),...data.state.settings,autoRun:false,launchAtLogin:false};recoverInterrupted(data.state);for(const site of data.state.sites)if(site.status==='analyzing')site.status='attention';withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},false,()=>{controller.ahrefs.invalidatePending();store.restore(data.state,vault.prepareRestoredSecrets(data.secrets))});await detectAi();return {ok:true,message:'备份已恢复，检查资料后可恢复执行'};}finally{restoring=false}
    }
    case 'backup:auto-status':return localBackups.status();
    case 'backup:auto-configure':{const d=z.object({enabled:z.boolean(),keep:z.number().int().min(3).max(30).default(7)}).parse(p);const status=await localBackups.configure(d.enabled,d.keep);return d.enabled&&!controller.hasPendingWork()?localBackups.run(true):status;}
    case 'backup:auto-run':{forbidBusy();return localBackups.run(true);}
    case 'backup:auto-restore':{
      ensureRestoreIdle();restoring=true;wordpressConnections.cancel();try{const {id}=z.object({id:z.string().max(200)}).parse(p),payload=await localBackups.read(id) as {state?:unknown;ciphers?:unknown};if(!payload||typeof payload!=='object'||!payload.state||!payload.ciphers||typeof payload.ciphers!=='object'||Array.isArray(payload.ciphers))throw Error('本机备份结构无效');
      if(!vault.available())throw Error('系统钥匙串不可用，无法恢复本机备份');const data=validateLocalBackup(payload,cipher=>safeStorage.decryptString(cipher)),confirm=await dialog.showMessageBox(win!,{type:'warning',message:'恢复这份本机自动备份？',detail:'当前状态会先另存一份本机恢复点。恢复后自动执行与开机启动都保持关闭。',buttons:['取消','恢复'],defaultId:0,cancelId:0});if(confirm.response!==1)return {ok:false,message:'已取消'};
      ensureRestoreIdle();controller.closeTaskBrowsers();await localBackups.run(true);ensureRestoreIdle();data.state.settings={...defaultSettings(),...data.state.settings,autoRun:false,launchAtLogin:false};recoverInterrupted(data.state);for(const site of data.state.sites)if(site.status==='analyzing')site.status='attention';withLoginItemPreference({packaged:app.isPackaged,platform:process.platform,read:()=>app.getLoginItemSettings(loginItemReadOptions(process.platform,process.execPath)),write:(openAtLogin,enabled)=>app.setLoginItemSettings({openAtLogin,...(enabled===undefined?{}:{enabled})})},false,()=>{controller.ahrefs.invalidatePending();store.restore(data.state,vault.prepareRestoredSecrets(data.secrets))});await detectAi();return {ok:true,message:'本机备份已恢复，检查后再手动恢复执行'};}finally{restoring=false}
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
      const rows=[['网站','平台','状态','外链网址','首次生效时间','链接属性','说明'],...s.tasks.map(t=>[s.sites.find(x=>x.id===t.siteId)?.domain,t.sourceDomain,t.status,t.publicUrl,t.firstLiveAt,t.linkRel,t.message])];await writeFile(path.filePath,'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),{mode:0o600});return {ok:true,message:'记录已导出'};
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
  const store=new Store(join(app.getPath('userData'),'linkflow.sqlite'));const vault=new Vault(store);controller=new Controller(store,vault,app.getPath('userData'),{memoryWikiDependencies:{renderArticle:renderMemoryWikiArticle},mdshareDependencies:{renderPage:renderMDSharePage},mdviewDependencies:{renderPage:renderMDViewPage},txtsbsDependencies:{renderPage:renderTxtSbsPage},theThingsDependencies:{renderPage:renderTheThingsPage},pastyxDependencies:{renderPage:renderPastyXPage},agentdropDependencies:{renderPage:renderAgentDropPage},listedStartupsDependencies:{renderPage:renderListedStartupsPage},productIndexDependencies:{renderPage:renderProductIndexPage},openAgentChatDependencies:{renderPage:renderOpenAgentChatPage},agentboardDependencies:{renderPage:renderAgentboardPage},agentriotDependencies:{renderPage:renderAgentRiotPage},agentNotepadDependencies:{renderPage:renderAgentNotepadPage},colonyDependencies:{renderPage:renderColonyPage},agentHowDependencies:{renderPage:renderAgentHowPage},agentsWikiDependencies:{renderPage:renderAgentsWikiPage},berrryDependencies:{renderPage:renderBerrryPage},swarmMemoDependencies:{renderPage:renderSwarmMemoPage},synthfolkDependencies:{renderPage:renderSynthfolkPage},largeLanguageDependencies:{renderPage:renderLargeLanguagePage}});wordpressConnections=new WordPressConnections(store,vault);store.onChange=broadcast;controller.runtime.version=app.getVersion();
  localBackups=new LocalBackups(join(app.getPath('userData'),'automatic-backups'),{encrypt:clear=>{if(!vault.available())throw Error('系统钥匙串不可用');return safeStorage.encryptString(clear)},decrypt:cipher=>{if(!vault.available())throw Error('系统钥匙串不可用');return safeStorage.decryptString(cipher)},snapshot:()=>({state:store.read(),ciphers:store.allCiphers()})});
  const runtimeApplicationPath=process.platform==='darwin'?(macApplicationPath(process.execPath)??''):dirname(process.execPath),runtimeHelperPath=join(root,'dist-electron/update-helper.cjs');
  const macTarget=process.platform==='darwin'&&app.isPackaged&&!selfTest?await resolveMacUpdateTarget({runningApplicationPath:runtimeApplicationPath,runningExecutablePath:process.execPath,runningHelperPath:runtimeHelperPath,homeDirectory:app.getPath('home'),currentVersion:app.getVersion()}):undefined;
  const updateApplicationPath=process.platform==='darwin'?(macTarget?.applicationPath??runtimeApplicationPath):dirname(process.execPath),updateExecutablePath=process.platform==='darwin'?(macTarget?.executablePath??process.execPath):process.execPath,updateHelperPath=process.platform==='darwin'?(macTarget?.helperPath??runtimeHelperPath):runtimeHelperPath;
  updater=new UpdateManager({currentVersion:app.getVersion(),platform:process.platform,arch:process.arch,packaged:app.isPackaged&&!selfTest,
    unsupportedReason:process.platform==='darwin'&&app.isPackaged&&!selfTest&&!macTarget?'请先将外链助手移到“应用程序”文件夹，重新打开后再更新':undefined,
    updatesDirectory:join(app.getPath('userData'),'updates'),applicationPath:updateApplicationPath,executablePath:updateExecutablePath,runtimeApplicationPath,runtimeExecutablePath:process.execPath,
    helperPath:updateHelperPath,publicKey:Buffer.from(UPDATE_PUBLIC_KEY_SPKI_BASE64,'base64'),emit:state=>{if(win&&!win.isDestroyed())win.webContents.send('linkflow:update',state);notifyNewVersion(state)}});
  await updater.initialize();
  if(selfTest)store.update(s=>{s.settings.autoRun=false;s.settings.provider='api';s.settings.hasApiKey=false});
  controller.onNotice=(title,body)=>{if(Notification.isSupported())new Notification({title,body}).show()};
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'外链助手',submenu:[{role:'about'},{type:'separator'},{label:'显示主窗口',click:()=>win?.show()},{label:'退出',accelerator:'CommandOrControl+Q',click:()=>{quitting=true;app.quit()}}]},{role:'editMenu'},{role:'windowMenu'}]));
  const iconPath=join(root,'assets/tray.png');if(existsSync(iconPath)){const icon=nativeImage.createFromPath(iconPath).resize({width:18,height:18});tray=new Tray(icon);tray.setToolTip('外链助手');tray.setContextMenu(Menu.buildFromTemplate([{label:'显示外链助手',click:()=>{if(!win)createWindow();win?.show()}},{label:'暂停自动执行',click:()=>controller.pause()},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit()}}]));tray.on('click',()=>win?.show());}
  ipcMain.handle('linkflow:command',async(event,name,payload)=>{
    const operation=Symbol();let tracked=false;
    try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||![...IPC_COMMANDS,...HERE_NOW_IPC_COMMANDS,...PLOPINO_IPC_COMMANDS,...SHIPLY_IPC_COMMANDS,...VALTOWN_IPC_COMMANDS,...BITBUCKET_IPC_COMMANDS,...HUMAN_ACTION_IPC_COMMANDS].includes(name as never)||event.senderFrame.url!==renderURL)throw Error('无权调用此操作');
      if(JSON.stringify(payload??{}).length>100000)throw Error('输入内容过大');
      if(!['snapshot','app:update-status','app:install-update','app:recover-update'].includes(name)){activeCommands.add(operation);tracked=true}
      return {ok:true,value:await command(name,payload)};
    }catch(e){return {ok:false,error:safeMessage(e)}}finally{if(tracked)activeCommands.delete(operation)}
  });
  ipcMain.handle('linkflow:draft-copy',createDraftClipboardHandler({
    getWindow:()=>win,
    getRenderURL:()=>renderURL,
    getTasks:()=>controller.store.read().tasks,
    getSite:id=>store.read().sites.find(site=>site.id===id),
    writeText:value=>clipboard.writeText(value),
  }));
  powerMonitor.on('resume',()=>{if(runtimeStarted&&!updating&&!quitting){void controller.tick();void updater.checkIfDue().catch(()=>{})}});
  createWindow();if(selfTest){void runPackagedSelfTest(win!,controller,()=>rendererReadiness.wait());return;}void updater.checkIfDue().catch(()=>{});await detectAi();runtimeStarted=true;if(!updating&&!quitting)controller.start();maintenanceTimer=setInterval(()=>{if(!updating&&!quitting)void updater.checkIfDue().catch(()=>{});if(!updating&&!controller.hasPendingWork())void localBackups.run().catch(()=>broadcast())},10*60_000);maintenanceTimer.unref();
});
app.on('activate',()=>{if(!win)createWindow();else win.show()});
app.on('before-quit',event=>{quitting=true;bloggerConnect?.abort();proseConnect?.abort();shiplyConnect?.abort();hereNowConnect?.abort();wordpressConnections?.cancel();if(maintenanceTimer)clearInterval(maintenanceTimer);controller?.stop();if(!brewPageQuitDrained){event.preventDefault();brewPageQuitDrain??=drainBrewPageLateResponses(15000).then(()=>undefined).finally(()=>{brewPageQuitDrained=true;updater?.dispose();app.quit()});return}updater?.dispose();if(quitDrainComplete)return;event.preventDefault();if(quitDrainStarted)return;quitDrainStarted=true;void Promise.allSettled([drainMDShareLateResponses(5000),drainMDViewForQuit(),drainTxtSbsForQuit(),drainBerrryPendingOperations(),drainAgentHowPendingOperations(),drainAgentsWikiPendingOperations(),drainSwarmMemoPendingOperations(),drainOpenAgentChatPendingOperations(5000),drainSynthfolkPendingOperations(),drainPastyXForQuit(),drainOpenAgentChatForQuit()]).finally(()=>{quitDrainComplete=true;app.quit()})});
app.on('window-all-closed',()=>{if(!tray){quitting=true;app.quit()}});
