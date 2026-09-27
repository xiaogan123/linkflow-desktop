import { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray, nativeImage, systemPreferences } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Store, defaultSettings } from './store';
import { Vault, encryptBackup, decryptBackup } from './vault';
import { Controller } from './controller';
import { AddSite, EditSite, SettingsPatch, AccountInput, AccountRetry, getId, normalizeDomain, publicUrl, safeMessage } from './validation';
import { validateBackup } from './backup-validation';
import { recoverInterrupted } from './planner';
import { IPC_COMMANDS, type Site, type Account } from '../shared/types';
import {matchChannels} from '../integrations/catalog';
import {eligibilityFor} from '../integrations/eligibility';
import {parseGscLinksCsv} from '../integrations/search-reports';
import { testAi } from '../integrations/ai';
import { codexEnvironment, resolveCodexLaunch } from '../integrations/codex-process';
import { testMail } from '../integrations/mail';
import {mailboxIdentityChanged} from './mail-settings';
import { prepareSelfTest, runPackagedSelfTest } from './self-test';

app.setName('外链助手');
const selfTest=prepareSelfTest();
if(process.env.LINKFLOW_DATA_DIR&&!app.isPackaged&&!selfTest)app.setPath('userData',process.env.LINKFLOW_DATA_DIR);
const single=app.requestSingleInstanceLock();
if(!single)app.quit();
let win:BrowserWindow|null=null,tray:Tray|null=null,quitting=false,controller:Controller;
const root=join(__dirname,'..');
const file=join(root,'dist/index.html');
const devUrl=!app.isPackaged?process.env.LINKFLOW_DEV_URL:undefined;
let renderURL=devUrl||pathToFileURL(file).href;

function broadcast(){if(win&&!win.isDestroyed())win.webContents.send('linkflow:changed')}
function createWindow(){
  win=new BrowserWindow({width:1487,height:1058,minWidth:1050,minHeight:720,show:false,title:'外链助手 · LINKFLOW',backgroundColor:'#f8faff',titleBarStyle:process.platform==='darwin'?'hiddenInset':'default',trafficLightPosition:{x:16,y:16},webPreferences:{preload:join(root,'dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:!app.isPackaged}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==renderURL)event.preventDefault()});
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.on('close',event=>{if(!quitting&&tray){event.preventDefault();win?.hide()}});
  win.on('closed',()=>{win=null});
  void win.loadURL(renderURL);win.once('ready-to-show',()=>win?.show());
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
  switch(name){
    case 'snapshot':return controller.snapshot();
    case 'site:add':{
      const data=AddSite.parse(p),address=normalizeDomain(data.domain);if(store.read().sites.some(s=>s.domain===address.domain))throw Error('这个网站已经添加');
      const site:Site={id:randomUUID(),...address,email:data.email,name:address.domain,description:'',category:'general',language:'en',monthlyTarget:data.monthlyTarget,status:'analyzing',createdAt:new Date().toISOString()};
      store.update(s=>s.sites.push(site));void controller.analyze(site.id);break;
    }
    case 'site:update':{forbidBusy();const input=EditSite.parse(p);store.update(s=>{const site=s.sites.find(x=>x.id===input.id);if(!site)throw Error('网站不存在');Object.assign(site,input);for(const task of s.tasks.filter(t=>t.siteId===site.id&&!t.submittedAt)){task.articleApprovedAt=undefined;if(['name','description','category','language','email'].some(k=>k in input))task.draft=undefined}});controller.plan();break;}
    case 'site:queue-channel':{
      forbidBusy();const d=z.object({id:z.string().uuid(),channelId:z.string().max(100)}).parse(p);const s=store.read(),site=s.sites.find(x=>x.id===d.id),channel=controller.channels().find(c=>c.id===d.channelId);
      if(!site||!channel)throw Error('网站或渠道不存在');if(site.status!=='ready')throw Error('请先完成网站分析并恢复计划');
      if(!matchChannels(site,[channel]).length||channel.free==='unknown')throw Error(eligibilityFor(site,channel).reason+'；分类、语言或费用不符合条件');
      if(s.tasks.some(t=>t.siteId===site.id&&t.sourceDomain===channel.domain))throw Error('该来源已有任务，请查看已有记录');
      const now=new Date().toISOString();store.update(x=>x.tasks.push({id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:channel.automation==='manual'?'needs_input':'queued',createdAt:now,scheduledAt:now,updatedAt:now,attempts:0,message:channel.automation==='manual'?'可生成材料，按平台规则人工提交':'已加入计划',reason:eligibilityFor(site,channel).reason}));break;
    }
    case 'site:adopt-gist':{forbidBusy();const d=z.object({id:z.string().uuid(),url:z.string().trim().max(2048)}).parse(p);await controller.adoptGist(d.id,d.url);break;}
    case 'account:connect-gist':{forbidBusy();const d=z.object({token:z.string().trim().min(8).max(512)}).parse(p);await controller.connectGist(d.token);break;}
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
    case 'task:approve':{forbidBusy();const id=getId(p),task=store.read().tasks.find(t=>t.id===id);if(!task?.draft?.body||task.submittedAt||task.checkpoint!=='article_review')throw Error('当前没有待确认文章');controller.patch(id,{articleApprovedAt:new Date().toISOString(),status:'queued',scheduledAt:new Date().toISOString(),message:'文章已确认，等待发布'});void controller.tick();break;}
    case 'task:retry':{
      const id=getId(p),t=store.read().tasks.find(t=>t.id===id);if(!t)throw Error('任务不存在');if(t.status==='running')throw Error('任务正在执行');
      if(t.firstLiveAt)throw Error('此渠道已获得过外链，可核验现有结果，无需重复提交');
      if(t.submittedAt||t.checkpoint==='submitting'){if(t.publicUrl){await controller.verify(id);break;}throw Error('已有提交记录。请打开平台检查结果，并填写公开结果网址后核验；不会重复投稿。');}
      if(t.attempts>=store.read().settings.maxAttempts)throw Error('已达重试上限，请检查原因或跳过此渠道。');
      controller.patch(id,{status:'queued',scheduledAt:new Date().toISOString(),message:'准备继续执行'});void controller.tick();break;
    }
    case 'task:skip':{const id=getId(p);if(controller.runtime.activeTaskId===id)throw Error('请先暂停当前任务');controller.patch(id,{status:'skipped',message:'已跳过，保留记录避免重复提交'});controller.plan();break;}
    case 'task:verify':await controller.verify(getId(p));break;
    case 'task:set-url':{
      const input=z.object({id:z.string().uuid(),url:z.string().max(2048)}).parse(p),u=publicUrl(input.url);const t=store.read().tasks.find(t=>t.id===input.id);if(!t)throw Error('任务不存在');
      if(t.channelId==='github-gist'){forbidBusy();await controller.adoptGist(t.siteId,u.href);break;}
      if(u.hostname!==t.sourceDomain&&!u.hostname.endsWith('.'+t.sourceDomain))throw Error('结果网址必须属于该外链渠道');controller.patch(input.id,{publicUrl:u.href,...(t.publicUrl!==u.href?{verifiedAt:undefined,lastCheckedAt:undefined,linkRel:undefined,linkCheck:undefined,status:'review' as const}: {})});await controller.verify(input.id);break;
    }
    case 'task:open':await controller.manualOpen(getId(p));break;
    case 'task:generate':{forbidBusy();await controller.generateDraft(getId(p));break;}
    case 'task:update-draft':{
      const d=z.object({id:z.string().uuid(),title:z.string().min(1).max(150),description:z.string().max(3000),body:z.string().max(30000)}).parse(p);const task=store.read().tasks.find(t=>t.id===d.id);if(!task)throw Error('任务不存在');if(task.status==='running'||task.submittedAt)throw Error('正在执行或已提交的材料不能修改');controller.patch(d.id,{articleApprovedAt:undefined,draft:{title:d.title,description:d.description,body:d.body}});break;
    }
    case 'plan:run':store.update(s=>{s.settings.autoRun=true});void controller.tick();break;
    case 'plan:pause':controller.pause();break;
    case 'settings:save':{
      const input=SettingsPatch.parse(p);if(input.provider||input.apiKey||input.mailPassword||input.codexPath||input.apiBase||input.model||input.mail)forbidBusy();
      if(!app.isPackaged&&input.launchAtLogin)throw Error('开机启动请在打包客户端中开启');
      const previous=store.read().settings;
      const nextMail={...previous.mail,...input.mail};
      nextMail.host=nextMail.host.trim().toLowerCase().replace(/\.$/,'');nextMail.user=nextMail.user.trim();
      const mailChanged=mailboxIdentityChanged(previous.mail,nextMail);
      const apiChanged=input.apiBase!==undefined&&input.apiBase!==previous.apiBase;
      if(input.apiBase)publicUrl(input.apiBase);
      // Changing a destination must never forward the old destination's secret.
      if(apiChanged&&!input.apiKey)await vault.delete('apiKey');
      if(mailChanged&&!input.mailPassword)await vault.delete('mailPassword');
      if(input.apiKey)await vault.set('apiKey',input.apiKey);
      if(input.mailPassword)await vault.set('mailPassword',nextMail.host==='imap.gmail.com'?input.mailPassword.replace(/\s/g,''):input.mailPassword);
      const {apiKey,mailPassword,...safe}=input;
      if(mailChanged||mailPassword)controller.runtime.mailReady=false;
      store.update(s=>{s.settings={...s.settings,...safe,hasBingKey:previous.hasBingKey,hasApiKey:!!apiKey||(!apiChanged&&previous.hasApiKey),mail:{...nextMail,hasPassword:!!mailPassword||(!mailChanged&&previous.mail.hasPassword)}};});
      if(input.launchAtLogin!==undefined)app.setLoginItemSettings({openAtLogin:input.launchAtLogin});
      await detectAi();controller.plan();break;
    }
    case 'settings:test-ai':{const result=await testAi(store.read().settings,vault);controller.runtime.aiReady=result.ok;broadcast();return result;}
    case 'settings:test-mail':{forbidBusy();const result=await testMail(store.read().settings,vault);controller.runtime.mailReady=result.ok;broadcast();return result;}
    case 'account:save':{
      forbidBusy();const input=AccountInput.parse(p);if(input.channelId==='github-gist')throw Error('请使用连接 GitHub Gist 验证并保存令牌');if(!controller.channels().some(c=>c.id===input.channelId))throw Error('渠道不存在');
      const old=input.id?store.read().accounts.find(a=>a.id===input.id):undefined;if(input.id&&!old)throw Error('账号不存在');
      if(store.read().accounts.some(a=>a.id!==input.id&&a.channelId===input.channelId&&a.email.toLowerCase()===input.email.toLowerCase()))throw Error('该渠道已有此邮箱账号');
      const now=new Date().toISOString(),identityChanged=!!old&&(old.channelId!==input.channelId||old.email.toLowerCase()!==input.email.toLowerCase()||old.username!==input.username);
      if(old?.credentialKind==='api_token'&&(identityChanged||input.password))throw Error('API 作者身份与令牌不可作为普通密码修改，请保留原账号。');
      const repairedCredentials=old?.status==='credentials_invalid'&&!!input.password;
      const status=old?.status==='restricted'&&!identityChanged?'restricted':!old||identityChanged||repairedCredentials?'unknown':old.status;
      const account:Account={...old,id:old?.id||randomUUID(),channelId:input.channelId,email:input.email,username:input.username,createdAt:old?.createdAt||now,updatedAt:now,status,source:old?.source||'imported',hasPassword:!!input.password||old?.hasPassword||false,diagnostic:status==='restricted'?old?.diagnostic:undefined};
      if(input.password)await vault.set('account:'+account.id,input.password);store.update(s=>{s.accounts=s.accounts.filter(a=>a.id!==account.id);s.accounts.push(account)});break;
    }
    case 'account:retry':{
      forbidBusy();const {id}=AccountRetry.parse(p),account=store.read().accounts.find(a=>a.id===id);if(!account)throw Error('账号不存在');
      if(account.status==='restricted')throw Error('平台已报告账号或访问受限，不能自动规避或重试');
      if(account.status==='credentials_invalid')throw Error('请先编辑账号并更新密码');
      if(account.status==='unknown')throw Error('账号状态尚未确认，请先检查平台记录或导入正确凭据');
      if(account.status==='registered')throw Error('账号已注册，无需重试注册');
      if(account.status==='draft'&&account.source!=='generated')throw Error('只能重试本机生成且尚未创建的注册草稿');
      if(account.diagnostic&&!account.diagnostic.retryable&&account.status!=='draft')throw Error('该账号异常需要人工处理');
      const now=new Date().toISOString();store.update(s=>{const a=s.accounts.find(a=>a.id===id);if(a){a.updatedAt=now;a.diagnostic=undefined}for(const task of s.tasks){const site=s.sites.find(site=>site.id===task.siteId);if(task.channelId===account.channelId&&site?.email.toLowerCase()===account.email.toLowerCase()&&!task.submittedAt&&['needs_input','failed'].includes(task.status)){task.status='queued';task.scheduledAt=now;task.updatedAt=now;task.message=account.status==='needs_verification'?'准备继续验证账号':'准备重试未提交的注册草稿';}}});void controller.tick();break;
    }
    case 'account:reveal':{const id=getId(p);if(store.read().accounts.find(a=>a.id===id)?.credentialKind==='api_token')throw Error('API 令牌不支持明文显示，请通过连接入口更新');await confirmSecret();return {password:(await vault.get('account:'+id))||''};}
    case 'account:delete':{forbidBusy();const id=getId(p);await vault.delete('account:'+id);store.update(s=>{s.accounts=s.accounts.filter(a=>a.id!==id)});break;}
    case 'backup:export':{
      const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showSaveDialog(win!,{title:'导出加密备份',defaultPath:'Linkflow-备份.lfb',filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled||!path.filePath)return {ok:false,message:'已取消'};
      const buffer=encryptBackup({state:store.read(),secrets:await vault.exportSecrets()},passphrase);await writeFile(path.filePath,buffer,{mode:0o600});return {ok:true,message:'加密备份已保存，请妥善保管口令'};
    }
    case 'backup:import':{
      ensureRestoreIdle();const {passphrase}=z.object({passphrase:z.string().min(12).max(256)}).parse(p);const path=await dialog.showOpenDialog(win!,{title:'恢复加密备份',properties:['openFile'],filters:[{name:'加密备份',extensions:['lfb']}]});if(path.canceled)return {ok:false,message:'已取消'};
      const data=validateBackup(decryptBackup(await readFile(path.filePaths[0]),passphrase));
      const confirm=await dialog.showMessageBox(win!,{type:'warning',message:'用备份替换本机数据？',detail:'当前数据会自动保存为同口令的恢复前备份。恢复后自动执行保持暂停。',buttons:['取消','恢复'],defaultId:0,cancelId:0});if(confirm.response!==1)return {ok:false,message:'已取消'};
      ensureRestoreIdle();
      await writeFile(join(app.getPath('userData'),'恢复前备份.lfb'),encryptBackup({state:store.read(),secrets:await vault.exportSecrets()},passphrase),{mode:0o600});
      ensureRestoreIdle();data.state.settings={...defaultSettings(),...data.state.settings,autoRun:false,launchAtLogin:false};recoverInterrupted(data.state);for(const site of data.state.sites)if(site.status==='analyzing')site.status='attention';store.restore(data.state,vault.encryptSecrets(data.secrets));app.setLoginItemSettings({openAtLogin:false});await detectAi();return {ok:true,message:'备份已恢复，检查资料后可恢复执行'};
    }
    case 'data:export':{
      const path=await dialog.showSaveDialog(win!,{title:'导出外链记录',defaultPath:'外链记录.csv',filters:[{name:'CSV',extensions:['csv']}]});if(path.canceled||!path.filePath)return {ok:false,message:'已取消'};
      const s=store.read(),cell=(v:unknown)=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'").replaceAll('"','""')+'"';
      const rows=[['网站','渠道','状态','公开结果网址','首次生效时间','链接属性','说明'],...s.tasks.map(t=>[s.sites.find(x=>x.id===t.siteId)?.domain,t.sourceDomain,t.status,t.publicUrl,t.firstLiveAt,t.linkRel,t.message])];await writeFile(path.filePath,'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),{mode:0o600});return {ok:true,message:'记录已导出'};
    }
    case 'external:open':{const {url}=z.object({url:z.string().max(2048)}).parse(p);const u=publicUrl(url);if(/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)||u.hostname.includes(':'))throw Error('仅可打开公开网页');await shell.openExternal(u.href);return;}
    case 'app:quit':quitting=true;app.quit();return;
    default:throw Error('不支持的操作');
  }
  return controller.snapshot();
}

app.on('second-instance',()=>{if(!win)createWindow();else{win.show();win.focus()}});
app.whenReady().then(async()=>{
  if(!single)return;await mkdir(app.getPath('userData'),{recursive:true,mode:0o700});
  const store=new Store(join(app.getPath('userData'),'linkflow.sqlite'));const vault=new Vault(store);controller=new Controller(store,vault,app.getPath('userData'));store.onChange=broadcast;controller.runtime.version=app.getVersion();
  if(selfTest)store.update(s=>{s.settings.autoRun=false;s.settings.provider='api';s.settings.hasApiKey=false});
  controller.onNotice=(title,body)=>{if(Notification.isSupported())new Notification({title,body}).show()};
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'外链助手',submenu:[{role:'about'},{type:'separator'},{label:'显示主窗口',click:()=>win?.show()},{label:'退出',accelerator:'CommandOrControl+Q',click:()=>{quitting=true;app.quit()}}]},{role:'editMenu'},{role:'windowMenu'}]));
  const iconPath=join(root,'assets/tray.png');if(existsSync(iconPath)){const icon=nativeImage.createFromPath(iconPath).resize({width:18,height:18});tray=new Tray(icon);tray.setToolTip('外链助手');tray.setContextMenu(Menu.buildFromTemplate([{label:'显示外链助手',click:()=>{if(!win)createWindow();win?.show()}},{label:'暂停自动执行',click:()=>controller.pause()},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit()}}]));tray.on('click',()=>win?.show());}
  ipcMain.handle('linkflow:command',async(event,name,payload)=>{
    try{if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||!IPC_COMMANDS.includes(name)||event.senderFrame.url!==renderURL)throw Error('无权调用此操作');
      if(JSON.stringify(payload??{}).length>100000)throw Error('输入内容过大');return {ok:true,value:await command(name,payload)};
    }catch(e){return {ok:false,error:safeMessage(e)}}
  });
  createWindow();if(selfTest){void runPackagedSelfTest(win!,controller);return;}await detectAi();controller.start();
});
app.on('activate',()=>{if(!win)createWindow();else win.show()});
app.on('before-quit',()=>{quitting=true;controller?.stop()});
app.on('window-all-closed',()=>{if(!tray){quitting=true;app.quit()}});
