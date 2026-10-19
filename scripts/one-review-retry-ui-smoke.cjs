const {join}=require('node:path');
const {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-one-review-ui-'));
    const root=process.cwd();
    await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('linkflow',{invoke:(name,payload)=>ipcRenderer.invoke('fixture',name,payload),onChange:(callback)=>{const handler=()=>callback();ipcRenderer.on('fixture-change',handler);return()=>ipcRenderer.removeListener('fixture-change',handler)}});`);
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);rmSync(dir,{recursive:true,force:true});process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const dir=process.argv[2];
  const evidence=process.env.ONE_REVIEW_SMOKE_EVIDENCE||join(process.cwd(),'.evidence','one-review-retry-ui-smoke');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));

  const stamp='2026-10-17T01:00:00.000Z';
  const site={id:'11111111-1111-4111-8111-111111111111',domain:'site.synthetic.example',url:'https://site.synthetic.example',email:'owner@synthetic.example',publicEmail:'public@synthetic.example',name:'Synthetic Site',description:'Isolated native UI fixture.',category:'content',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp};
  const channel={id:'synthetic-review',name:'Synthetic Review',domain:'channel.synthetic.example',url:'https://channel.synthetic.example',submitUrl:'https://channel.synthetic.example/submit',categories:['content'],languages:['en'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'Isolated fixture',automation:'api',quality:'C',qualityReason:'Isolated fixture',rulesUrl:'https://channel.synthetic.example/rules',checkedAt:'2026-10-17',notes:'',allowedHosts:['channel.synthetic.example'],enabled:true};
  const task={id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'Restored review requires one new independent review.',checkpoint:'article_review',draftRevision:3,draft:{title:'Synthetic draft',description:'Synthetic summary',body:'Synthetic article body.'},cost:{aiCalls:2},articleReview:{status:'failed',reason:'Restored approval is expired; a new review is required.',reasonCode:'passed',reviewContractVersion:4,reviewedAt:stamp,evidenceUrls:[],draftRevision:3,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)}};
  const state={sites:[site],tasks:[task],channels:[channel],accounts:[],mailboxes:[],accountBindings:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'synthetic-review-model',apiBase:'https://api.synthetic.example/v1',hasApiKey:false,autoRun:false,articleReviewMode:'ai',launchAtLogin:false,notify:false,timezone:'UTC',maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'mail.synthetic.example',port:993,user:'fixture@synthetic.example',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:process.platform,dataPath:dir,aiCallsToday:0}};
  const clone=value=>JSON.parse(JSON.stringify(value));
  const actions=[];
  let oneShotInvocations=0,oneShotCommits=0,duplicateRejections=0,inFlight=false;
  ipcMain.handle('fixture',async(_event,name,payload)=>{
    if(name==='snapshot')return clone(state);
    if(name==='app:update-status')return {phase:'idle',currentVersion:'fixture'};
    if(name==='app:ready')return true;
    if(name!=='task:review-once')return {ok:true};
    actions.push({name,payload:clone(payload)});
    oneShotInvocations++;
    if(oneShotInvocations===1)return {cancelled:true};
    if(inFlight){duplicateRejections++;return {duplicateRejected:true}}
    inFlight=true;
    await new Promise(resolve=>setTimeout(resolve,220));
    task.oneReviewRetry={version:1,purpose:'independent_article_review',operationTokenHash:'c'.repeat(64),grantedAt:stamp,siteId:task.siteId,channelId:task.channelId,accountId:null,draftRevision:3,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64),provider:'codex',model:'synthetic-review-model',status:'consumed',consumedAt:'2026-10-17T01:01:00.000Z'};
    task.cost.aiCalls=3;
    task.status='failed';
    task.message='The sole synthetic review call was consumed and stopped.';
    task.updatedAt='2026-10-17T01:01:00.000Z';
    oneShotCommits++;
    inFlight=false;
    return {status:'failed'};
  });

  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(40)}throw Error(`UI readiness deadline: ${source}`)};
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text}`);await delay(100)};
  const reviewOnceLabel='追加 1 次 AI 复核';
  const reviewButtonsJs=`[...document.querySelectorAll('button')].filter(item=>item.innerText.trim()===${JSON.stringify(reviewOnceLabel)})`;
  const clickReviewTwice=()=>evaluate(`(()=>{const button=${reviewButtonsJs}[0];if(!button||button.disabled)return false;button.click();button.click();return true})()`);
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};

  app.whenReady().then(async()=>{try{
    const mainSource=readFileSync(join(process.cwd(),'src/main/main.ts'),'utf8');
    const messageSource=readFileSync(join(process.cwd(),'src/shared/batch9b-messages.ts'),'utf8');
    const reviewOnceEntry=mainSource.slice(mainSource.indexOf("case 'task:review-once'"),mainSource.indexOf("case 'task:retry'"));
    const retryDetail=(messageSource.match(/reviewRetryDetail:\(revision:number\)=>`([^`]*)`/)||[])[1]||'';
    check('main confirmation preserves the two prior calls and discloses one possible paid call (counted as call three)',reviewOnceEntry.includes('detail:BATCH9B_MESSAGES.reviewRetryDetail(summary.draftRevision)')&&retryDetail.includes('原有 2 次调用记录会保留')&&retryDetail.includes('再调用一次复核')&&retryDetail.includes('可能产生费用')&&retryDetail.includes('请求开始即计为第 3 次')&&retryDetail.includes('失败或中断也不能再次追加'));
    check('main confirmation has explicit cancel and confirm choices',mainSource.includes("buttons:['取消','确认追加 1 次审核']")&&mainSource.includes('if(confirm.response!==1)return {cancelled:true}'));
    check('main entry guards overlapping commands before and after confirmation',(reviewOnceEntry.match(/activeCommands\.size>1/g)||[]).length===2);

    win=new BrowserWindow({width:1180,height:760,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("site.synthetic.example")');
    // The one-shot action lives on the task card in the site's 排期 tab (网站 → site → 排期 → 其他任务 → expand the task).
    await clickText('网站');
    await clickText('site.synthetic.example');
    await clickText('排期');
    await waitFor('!!document.querySelector(".task-card .task-summary")');
    await evaluate('document.querySelector(".task-card .task-summary").click()');
    await waitFor(`${reviewButtonsJs}.length>0`);
    check('restored needs-input review exposes the explicit one-shot action',await evaluate(`${reviewButtonsJs}.length===1&&!${reviewButtonsJs}[0].disabled`));
    check('ordinary AI retry is absent',await evaluate('![...document.querySelectorAll("button")].some(button=>button.innerText.includes("重新 AI 复核"))'));
    await evaluate(`${reviewButtonsJs}[0].scrollIntoView({block:'center'})`);
    await capture('one-review-action.png');

    await evaluate(`${reviewButtonsJs}[0].click()`);
    await delay(180);
    check('cancel leaves the two-call task and authorization untouched',oneShotInvocations===1&&oneShotCommits===0&&task.cost.aiCalls===2&&!task.oneReviewRetry);
    check('cancel does not show a false completion notice',await evaluate('!document.querySelector("[role=status].banner.success")?.innerText.includes("追加 AI 复核已完成")'));
    check('cancel keeps the one-shot action available for the still-unspent authorization',await evaluate(`${reviewButtonsJs}.length===1`));

    check('rapid repeat click reaches at most one committed operation',await clickReviewTwice());
    await waitFor(`${reviewButtonsJs}.length===0&&!!document.querySelector("[role=status].banner.success")`);
    check('confirmed action reports completion only after the committed call',await evaluate('document.querySelector("[role=status].banner.success").innerText.includes("追加 AI 复核已完成")'));
    check('confirmed action consumes exactly call three once',oneShotCommits===1&&task.cost.aiCalls===3&&task.oneReviewRetry?.status==='consumed');
    check('repeat click never creates a second grant or a second committed call',oneShotInvocations<=3&&oneShotCommits===1&&(oneShotInvocations===2||duplicateRejections===1));
    if(!await evaluate('!!document.querySelector(".task-card.selected .task-detail")'))await evaluate('document.querySelector(".task-card .task-summary")?.click()');
    await delay(100);
    check('consumed history remains visible while the action is removed',await evaluate(`(()=>{const detail=document.querySelector('.task-card.selected .task-detail');if(!detail)return false;const term=[...detail.querySelectorAll('dt')].find(item=>item.innerText.trim()==='追加审核');return term?.nextElementSibling?.innerText.trim()==='已使用'&&${reviewButtonsJs}.length===0})()`));
    await evaluate('document.querySelector(".task-card.selected .task-actions")?.scrollIntoView({block:"center"})');
    await capture('one-review-consumed.png');

    const result={passed:true,viewport:{width:1180,height:760},checks,actions,oneShotInvocations,oneShotCommits,duplicateRejections};
    writeFileSync(join(evidence,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
    console.log(`ONE REVIEW RETRY UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions,oneShotInvocations,oneShotCommits,duplicateRejections},null,2),{mode:0o600});
    console.error(error);
    app.exit(1);
  }});
}
