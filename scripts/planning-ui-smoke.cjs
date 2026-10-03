const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-planning-ui-'));
    const root=process.cwd();
    await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('linkflow',{invoke:(name,payload)=>ipcRenderer.invoke('fixture',name,payload),onChange:(callback)=>{const handler=()=>callback();ipcRenderer.on('fixture-change',handler);return()=>ipcRenderer.removeListener('fixture-change',handler)}});`);
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const dir=process.argv[2],evidence=join(process.cwd(),'.evidence','planning-ui-2026-10-03');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));
  const stamp='2026-10-03T00:00:00.000Z',future='2026-10-03T01:00:00.000Z';
  const site=(id,domain,articleReviewMode='ai',extra={})=>({id,domain,url:`https://${domain}`,email:`owner@${domain}`,publicEmail:`owner@${domain}`,name:domain.split('.')[0],description:'Fixture site',category:'software',language:'zh',monthlyTarget:2,articleReviewMode,status:'ready',createdAt:stamp,qualifications:{software:`https://${domain}/product`},...extra});
  const channel=(id,name,automation,extra={})=>({id,name,domain:`${id}.example`,url:`https://${id}.example`,submitUrl:`https://${id}.example/new`,categories:['general'],languages:['zh'],kind:'article',emailRequired:false,accountRequired:automation!=='manual',articleRequired:true,free:'yes',freeNote:'fixture',automation,quality:'A',qualityReason:'fixture',requirements:automation==='manual'?[]:['software'],provenance:'built-in',rulesUrl:id==='telegraph'?'https://telegra.ph/api':`https://${id}.example/rules`,checkedAt:'2026-10-03',notes:'fixture',allowedHosts:[`${id}.example`],enabled:true,...extra});
  const review=(reasonCode,reason)=>({status:'failed',reasonCode,reason,reviewedAt:stamp,evidenceUrls:['https://evidence.example/policy'],draftRevision:1,contentHash:'a'.repeat(64),contextHash:'b'.repeat(64)});
  const task=(id,siteId,channelId,status,extra={})=>({id,siteId,channelId,sourceDomain:`${channelId}.example`,status,createdAt:stamp,scheduledAt:future,updatedAt:stamp,attempts:1,message:'fixture progress',draft:{title:`${id} draft`,description:'fixture',body:'fixture body'},...extra});
  const sites=[
    site('site-system','system.example'),
    site('site-policy','policy.example'),
    site('site-manual','manual.example','manual'),
    site('site-handoff','handoff.example'),
    site('site-no-auto','no-auto.example','ai',{category:'finance',qualifications:{},error:'当前可执行的自动渠道不足，还缺 2 个来源；等待账号或渠道条件不会阻塞其他可执行任务。'}),
  ];
  const channels=[
    channel('telegraph','Telegraph','api',{domain:'telegra.ph',allowedHosts:['telegra.ph'],evidenceSources:[{url:'https://telegra.ph/api',kind:'api',appliesTo:'telegraph',applicability:'verified'},{url:'https://telegram.org/blog/telegraph',kind:'product_guidance',appliesTo:'telegraph',applicability:'verified'}]}),
    channel('github-gist','GitHub Gist','api',{domain:'gist.github.com',allowedHosts:['gist.github.com']}),
    channel('github','GitHub','browser',{domain:'github.com',allowedHosts:['github.com']}),
    channel('manual-publication','Manual Publication','manual',{domain:'manual.example',allowedHosts:['manual.example'],requirements:[]}),
  ];
  const tasks=[
    task('task-retry','site-system','telegraph','queued',{checkpoint:'article_review',nextCheckAt:future,message:'公开证据暂时不可用，已安排有限次数的自动重试。',articleReview:review('evidence_fetch_failed','公开证据网络暂时不可用')}),
    task('task-system-wait','site-system','github-gist','failed',{checkpoint:'system_wait',nextCheckAt:'2026-10-04T01:00:00.000Z',message:'自动重试已达到安全上限；当前渠道暂停，其他可执行渠道会继续。',articleReview:review('ai_unavailable','AI provider unavailable')}),
    task('task-policy','site-policy','telegraph','failed',{checkpoint:'channel_wait',nextCheckAt:'2026-10-10T01:00:00.000Z',message:'渠道内容许可仍未确认，未发布；当前渠道等待新证据，其他可执行渠道会继续。',articleReview:review('policy_not_found','已核对接口说明，尚未找到适用内容政策；请决定是否例外。')}),
    task('task-manual','site-manual','manual-publication','needs_input',{checkpoint:'article_review',message:'稿件等待人工核对。'}),
    task('task-handoff','site-handoff','github','needs_input',{checkpoint:'account_handoff',message:'需要先连接并验证现有第三方账号；其他可执行渠道会继续。'}),
  ];
  const state={sites,tasks,channels,accounts:[],mailboxes:[],accountBindings:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:true,articleReviewMode:'ai',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'win32-x64',dataPath:dir,aiCallsToday:0},channelPolicyStatus:{'site-policy':{telegraph:'unconfirmed'}},capacity:sites.map(item=>({siteId:item.id,currentLive:0,firstVerifiedThisMonth:0,missing:0,eligibleUnused:item.id==='site-no-auto'?0:2,automaticUnused:item.id==='site-no-auto'?0:1,manualUnused:item.id==='site-no-auto'?0:1,monthsAtTarget:item.id==='site-no-auto'?0:1,reason:item.id==='site-no-auto'?'可用的未用来源不足以支持下一个完整月目标。':undefined}))};
  const actions=[];
  const clone=value=>JSON.parse(JSON.stringify(value));
  ipcMain.handle('fixture',(_event,name,payload)=>{if(name==='snapshot')return clone(state);actions.push({name,payload:clone(payload)});return {ok:true}});

  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(40)}throw new Error(`UI readiness deadline: ${source}`)};
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text}`);await delay(100)};
  const clickSite=async domain=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('.site-name')].find(item=>item.innerText.includes(${JSON.stringify(domain)}));if(!button)return false;button.click();return true})()`);assert(clicked,`site: ${domain}`);await delay(100)};
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("policy.example")');
    const overviewRows=await evaluate(`Object.fromEntries([...document.querySelectorAll('.site-row')].map(row=>[row.querySelector('.site-name strong').innerText,{status:row.querySelector('.badge').innerText,next:row.querySelector('.next-date').innerText}]))`);
    check('overview labels automatic retry as system work',overviewRows['system.example'].status==='系统将自动重试');
    check('overview labels policy gaps as channel evidence waiting',overviewRows['policy.example'].status==='等待渠道许可证据');
    check('stopped policy work does not advertise its stored date as an automatic recheck',overviewRows['policy.example'].next==='当前未安排自动复查');
    check('overview reserves human review wording for manual mode',overviewRows['manual.example'].status==='稿件待人工审核');
    check('overview identifies account handoff as a real user action',overviewRows['handoff.example'].status==='需要连接账号');
    check('overview explicitly waits for an available channel when automatic sources are absent',overviewRows['no-auto.example'].status==='等待可用渠道');
    check('overview human todo count excludes system and channel waits',await evaluate(`(()=>{const metric=[...document.querySelectorAll('.metric-splits > div')].find(item=>item.innerText.includes('需要你处理'));return metric?.querySelector('strong').innerText==='2'})()`));
    check('overview shortage copy does not request invented qualifications',await evaluate('document.body.innerText.includes("目标等待可用渠道")&&!document.body.innerText.includes("需补充资格或渠道")'));

    await clickText('任务');
    await waitFor('document.querySelectorAll(".work-identity").length===2');
    const metrics=await evaluate(`Object.fromEntries([...document.querySelectorAll('.task-kpi')].map(item=>[item.querySelector('small').innerText,item.querySelector('strong').innerText]))`);
    check('task metrics separate system, human and channel work',metrics['系统推进']==='2'&&metrics['需要你处理']==='2'&&metrics['等待渠道']==='1');
    check('default task view distinguishes scheduled retry from stopped system work',await evaluate(`(()=>{const text=[...document.querySelectorAll('.work-table .badge')].map(item=>item.innerText);return text.includes('系统将自动重试')&&text.includes('系统处理已暂停')&&!text.includes('等待渠道许可证据')&&!text.includes('稿件待人工审核')})()`));

    await clickText('等待渠道');
    await waitFor('document.querySelectorAll(".work-identity").length===1');
    check('channel filter shows policy wait without an audit label',await evaluate('document.querySelector(".work-table .badge").innerText==="等待渠道许可证据"&&!document.body.innerText.includes("渠道待确认")'));
    await evaluate('document.querySelector(".work-identity").click()');await delay(100);
    check('policy details show the concrete evidence gap with safe next ownership',await evaluate('document.querySelector(".inline-task-detail").innerText.includes("尚未找到适用的内容政策")&&document.querySelector(".inline-task-detail").innerText.includes("等待新证据")'));
    check('policy wait offers details without manual retry controls',await evaluate(`(()=>{const actions=document.querySelector('.expanded-actions')?.innerText??'';return actions.includes('查看具体问题')&&!actions.includes('重新 AI 核对')&&!actions.includes('受控重试')})()`));

    await clickText('需你处理');
    await waitFor('document.querySelectorAll(".work-identity").length===2');
    check('human filter contains only manual review and account handoff',await evaluate(`(()=>{const labels=[...document.querySelectorAll('.work-table .badge')].map(item=>item.innerText);return labels.includes('稿件待人工审核')&&labels.includes('需要连接账号')&&!labels.some(label=>label.includes('系统')||label.includes('渠道许可'))})()`));
    await clickText('全部');
    const ordered=await evaluate(`[...document.querySelectorAll('.work-identity strong')].map(item=>item.innerText)`);
    check('task sorting keeps runnable and human-progressable work ahead of passive waits',ordered[0]==='system.example'&&ordered.indexOf('manual.example')<ordered.lastIndexOf('system.example')&&ordered.at(-1)==='policy.example');

    await clickText('总览');await clickSite('no-auto.example');
    await waitFor('document.body.innerText.includes("当前没有可自动推进的新来源")');
    check('site tools say to wait for available channels without requiring qualification proof',await evaluate('document.body.innerText.includes("无需为了补足数量填写并不存在的资格")'));
    check('capacity copy distinguishes unassigned directory supply from execution readiness',await evaluate('document.body.innerText.includes("目录余量只统计尚未建立任务的适合来源")&&document.body.innerText.includes("以每项状态为准")'));

    await clickText('返回总览');await clickSite('policy.example');
    await waitFor('document.body.innerText.includes("不要求你决定例外")');
    check('Telegraph policy setting is optional and automatic flow waits for evidence',await evaluate('document.body.innerText.includes("自动流程会等待新证据，不要求你决定例外")&&document.body.innerText.includes("可选：渠道使用设置")'));
    check('Telegraph readiness says its official API identity is created automatically',await evaluate('document.body.innerText.includes("任务会自动创建官方 API 身份")'));
    await evaluate('document.querySelector(".task-summary").click()');await delay(100);
    check('site timeline preserves policy evidence details without a fake schedule or retry CTA',await evaluate(`(()=>{const card=document.querySelector('.task-card');return card.innerText.includes('等待渠道许可证据')&&card.innerText.includes('当前来源已停止')&&card.innerText.includes('自动复查')&&card.innerText.includes('未安排')&&![...card.querySelectorAll('button')].some(button=>button.innerText.includes('重新 AI 核对')||button.innerText.includes('受控重试'))})()`));

    await clickText('返回总览');await clickSite('manual.example');
    await evaluate('document.querySelector(".task-summary").click()');await delay(100);
    check('manual-mode draft remains an explicit human approval task',await evaluate('document.querySelector(".task-card").innerText.includes("稿件待人工审核")&&[...document.querySelectorAll(".task-card button")].some(button=>button.innerText.includes("已核对稿件，继续发布"))'));

    await capture('planning-statuses.png');
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1280,height:800},checks,actions},null,2));
    console.log(`PLANNING UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
