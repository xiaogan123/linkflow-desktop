const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-planning-ui-'));
    const root=process.cwd();
    await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
    writeFileSync(join(dir,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script>const NativeDate=Date,fixedNow=Date.parse('2026-09-30T01:00:00.000Z');function FixedDate(...args){if(new.target)return new NativeDate(...(args.length?args:[fixedNow]));return new NativeDate(fixedNow).toString()}FixedDate.now=()=>fixedNow;FixedDate.parse=NativeDate.parse;FixedDate.UTC=NativeDate.UTC;FixedDate.prototype=NativeDate.prototype;window.Date=FixedDate;</script><script src="ui.js"></script></body></html>`);
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
    site('site-repeat','repeat.example','ai',{topics:[{url:'https://repeat.example/new-guide',discoveredAt:stamp}]}),
  ];
  const channels=[
    channel('telegraph','Telegraph','api',{domain:'telegra.ph',allowedHosts:['telegra.ph'],evidenceSources:[{url:'https://telegra.ph/api',kind:'api',appliesTo:'telegraph',applicability:'verified'},{url:'https://telegram.org/blog/telegraph',kind:'product_guidance',appliesTo:'telegraph',applicability:'verified'}]}),
    channel('github-gist','GitHub Gist','api',{domain:'gist.github.com',allowedHosts:['gist.github.com']}),
    channel('github','GitHub','browser',{domain:'github.com',allowedHosts:['github.com']}),
    channel('manual-publication','Manual Publication','manual',{domain:'manual.example',allowedHosts:['manual.example'],requirements:[]}),
  ];
  const tasks=[
    task('task-retry','site-system','telegraph','queued',{checkpoint:'article_review',nextCheckAt:future,message:'公开证据暂时不可用，已安排有限次数的自动重试。',articleReview:review('evidence_fetch_failed','公开证据网络暂时不可用')}),
    task('task-system-wait','site-system','github-gist','failed',{checkpoint:'system_wait',nextCheckAt:'2026-10-04T01:00:00.000Z',recoveryAttempts:1,recoveryEligible:false,cost:{aiCalls:6},message:'自动重试已达到安全上限；当前渠道暂停，其他可执行渠道会继续。',articleReview:review('ai_unavailable','AI provider unavailable')}),
    task('task-policy','site-policy','telegraph','failed',{checkpoint:'channel_wait',nextCheckAt:'2026-10-10T01:00:00.000Z',message:'渠道内容许可仍未确认，未发布；当前渠道等待新证据，其他可执行渠道会继续。',articleReview:review('policy_not_found','已核对接口说明，尚未找到适用内容政策；请决定是否例外。')}),
    task('task-manual','site-manual','manual-publication','needs_input',{checkpoint:'article_review',message:'稿件等待人工核对。'}),
    task('task-handoff','site-handoff','github','needs_input',{checkpoint:'account_handoff',message:'需要先连接并验证现有第三方账号；其他可执行渠道会继续。'}),
    task('task-reconcile','site-system','telegraph','needs_input',{checkpoint:'telegraph_publish_uncertain',submittedAt:stamp,reconcileAttempts:2,reconcileAfter:future,message:'发布请求结果未知，系统会查询原结果，不会重发。'}),
    task('task-final-recovery','site-system','github-gist','failed',{checkpoint:'system_wait',nextCheckAt:future,recoveryAttempts:0,recoveryEligible:true,cost:{aiCalls:5},message:'已保留原稿，将进行最后一次预算内自动恢复。'}),
    task('task-deferred','site-manual','manual-publication','skipped',{checkpoint:'manual_submission',deferredAt:stamp,message:'等待人工处理超过两天，已保留原稿并搁置。'}),
    task('task-repeat-history','site-repeat','telegraph','live',{publicUrl:'https://telegra.ph/repeat-old-09-01',firstLiveAt:'2026-09-01T00:00:00.000Z',verifiedAt:'2026-09-01T00:05:00.000Z',lastCheckedAt:stamp,health:'healthy',linkCheck:'found',checkpoint:'telegraph_published'}),
    task('task-october','site-repeat','github-gist','queued',{scheduledAt:future,message:'已排入十月，不占用九月目标。'}),
  ];
  const apiAccountId='11111111-1111-4111-8111-111111111111';
  let state={sites,tasks,channels,accounts:[{id:apiAccountId,channelId:'telegraph',email:'owner@repeat.example',username:'fixture-api',createdAt:stamp,updatedAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'}],mailboxes:[],accountBindings:[{id:'22222222-2222-4222-8222-222222222222',siteId:'site-repeat',channelId:'telegraph',accountId:apiAccountId,createdAt:stamp,updatedAt:stamp}],events:[],settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:true,articleReviewMode:'ai',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'win32-x64',dataPath:dir,aiCallsToday:0},channelPolicyStatus:{'site-policy':{telegraph:'unconfirmed'}},capacity:sites.map(item=>({siteId:item.id,currentLive:item.id==='site-repeat'?1:0,firstVerifiedThisMonth:0,currentSources:item.id==='site-repeat'?1:0,monthlySources:0,missing:0,eligiblePages:item.id==='site-system'||item.id==='site-repeat'?1:0,automaticPages:item.id==='site-system'||item.id==='site-repeat'?1:0,eligibleUnused:item.id==='site-no-auto'?0:2,automaticUnused:item.id==='site-no-auto'?0:1,manualUnused:item.id==='site-no-auto'?0:1,monthsAtTarget:item.id==='site-no-auto'?0:1,...(item.id==='site-system'||item.id==='site-repeat'?{}:{blockingReason:'no_automatic_channel',reason:'当前没有符合条件且可执行的页面机会。'})}))};
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
    check('overview uses capacity reason when stopped policy work has no other page opportunity',overviewRows['policy.example'].status==='暂无机会 · 没有自动渠道');
    check('stopped policy work does not advertise its stored date as an automatic recheck',overviewRows['policy.example'].next==='当前无可自动发布的平台');
    check('overview reserves human review wording for manual mode',overviewRows['manual.example'].status==='稿件待人工审核');
    check('overview identifies account handoff as a real user action',overviewRows['handoff.example'].status==='需要连接账号');
    check('overview explicitly states no automatic channel when page opportunities are absent',overviewRows['no-auto.example'].status==='暂无机会 · 没有自动渠道');
    check('overview human todo count excludes system and channel waits',await evaluate('document.body.innerText.includes("查看全部 2 项")'));
    check('overview page-gap copy does not request invented qualifications',await evaluate('document.body.innerText.includes("页面尚未核验")&&document.body.innerText.includes("尚待建立计划")&&!document.body.innerText.includes("需补充资格或渠道")'));
    check('next-month queued work does not cover the current-month page gap',await evaluate('document.querySelector(".capacity-note").innerText.includes("本月还有 11 个页面尚未核验")&&document.querySelector(".capacity-note").innerText.includes("0 个已排期或在途，11 个尚待建立计划")'));

    await clickText('任务');
    await waitFor('document.querySelectorAll(".work-identity").length===5');
    const metrics=await evaluate(`Object.fromEntries([...document.querySelectorAll('.task-kpi')].map(item=>[item.querySelector('small').innerText,item.querySelector('strong').innerText]))`);
    check('task metrics separate system, human and channel work',metrics['系统推进']==='5'&&metrics['需要你处理']==='2'&&metrics['等待渠道']==='1');
    check('default task view distinguishes each truthful automatic state from stopped work',await evaluate(`(()=>{const text=[...document.querySelectorAll('.work-table .badge')].map(item=>item.innerText);return text.includes('系统将自动重试')&&text.includes('系统处理已暂停')&&text.includes('自动查询发布结果')&&text.includes('等待最后一次自动恢复')&&!text.includes('等待渠道许可证据')&&!text.includes('稿件待人工审核')})()`));
    const reconcileOpened=await evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.badge')?.innerText==='自动查询发布结果');if(!row)return false;row.querySelector('.work-identity').click();return true})()`);check('automatic reconciliation row is available',reconcileOpened);await delay(80);
    check('Telegraph reconciliation uses reconcileAfter instead of an empty nextCheckAt',await evaluate(`(()=>{const detail=document.querySelector('.row-expanded .inline-task-detail');const entries=Object.fromEntries([...detail.querySelectorAll('dt')].map(item=>[item.innerText,item.nextElementSibling?.innerText]));return entries['下一次检查']&&entries['下一次检查']!=='—'})()`));
    const recoveryOpened=await evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.badge')?.innerText==='等待最后一次自动恢复');if(!row)return false;row.querySelector('.work-identity').click();return true})()`);check('final recovery row is available',recoveryOpened);await delay(80);
    check('recoverable failed draft keeps its final-recovery label',await evaluate(`document.querySelector('.row-expanded .draft-preview')?.innerText.includes('等待最后一次自动恢复')===true`));

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
    check('task sorting keeps runnable and human-progressable work ahead of passive waits',ordered[0]==='system.example'&&ordered.indexOf('manual.example')<ordered.indexOf('policy.example'));

    await clickText('已搁置');
    await waitFor('document.querySelectorAll(".work-identity").length===1');
    check('deferred filter contains the preserved task',await evaluate('document.querySelector(".work-table .badge").innerText==="已搁置"'));
    await evaluate('document.querySelector(".work-identity").click()');await delay(80);
    check('deferred task offers original-draft recovery without regenerating it',await evaluate(`(()=>{const actions=document.querySelector('.expanded-actions')?.innerText??'';return actions.includes('恢复原稿')&&!actions.includes('重新准备材料')})()`));
    await clickText('恢复原稿');
    check('deferred recovery dispatches task retry for the same task',actions.some(item=>item.name==='task:retry'&&item.payload?.id==='task-deferred'));

    await clickText('渠道');
    await evaluate('(()=>{const e=document.querySelector("[aria-label=按网站筛选相关渠道]");e.value="site-repeat";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(100);
    const telegraphOpened=await evaluate(`(()=>{const button=[...document.querySelectorAll('.channel-identity')].find(item=>item.innerText.includes('Telegraph'));if(!button)return false;button.click();return true})()`);check('repeatable Telegraph channel is visible',telegraphOpened);await delay(80);
    check('Telegraph explicitly creates its API identity without first-time connection',await evaluate(`(()=>{const row=[...document.querySelectorAll('.channel-identity')].find(item=>item.innerText.includes('Telegraph'))?.closest('tr');return row?.querySelector('.channel-setup-note')?.innerText.includes('自动创建作者身份，无需首次连接')&&row?.querySelector('.onboarding-setup-note')?.innerText.includes('调用 API 自动创建作者身份并加密保存令牌')})()`));
    check('historical Telegraph result exposes the next publication opportunity',await evaluate(`(()=>{const action=document.querySelector('.channel-details-row:not([hidden]) .channel-task-action');return action?.innerText.includes('将按')&&[...action.querySelectorAll('button')].some(item=>item.innerText==='加入执行计划'&&!item.disabled)&&!action.innerText.includes('查看已有任务')})()`));

    await clickText('总览');await clickSite('no-auto.example');
    await waitFor('document.body.innerText.includes("当前暂无自动发布页面的机会")');
    check('site tools say to wait for available channels without requiring qualification proof',await evaluate('document.body.innerText.includes("无需为了补足数量填写并不存在的资格")'));
    check('capacity copy separates page opportunities from new-source diversity',await evaluate('document.body.innerText.includes("当前可排页面机会")&&document.body.innerText.includes("新来源余量另记")&&document.body.innerText.includes("不代表本月可发页面数")'));

    await clickText('返回总览');await clickSite('policy.example');
    await waitFor('document.body.innerText.includes("不要求你决定例外")');
    check('Telegraph policy setting is optional and automatic flow waits for evidence',await evaluate('document.body.innerText.includes("自动流程会等待新证据，不要求你决定例外")&&document.body.innerText.includes("可选：渠道使用设置")'));
    check('Telegraph site readiness prepares the API identity automatically without account handoff',await evaluate(`(()=>{const row=[...document.querySelectorAll('.site-tools .fit-row')].find(item=>item.querySelector('strong')?.innerText==='Telegraph');return row?.innerText.includes('官方 API')&&row.innerText.includes('任务会自动准备发布身份或本机凭据')&&!row.innerText.includes('需先连接并验证已有账号')})()`));
    await evaluate('document.querySelector(".task-summary").click()');await delay(100);
    check('site timeline preserves policy evidence details without a fake schedule or retry CTA',await evaluate(`(()=>{const card=document.querySelector('.task-card');return card.innerText.includes('等待渠道许可证据')&&card.innerText.includes('当前来源已停止')&&card.innerText.includes('自动后续')&&card.innerText.includes('未安排')&&![...card.querySelectorAll('button')].some(button=>button.innerText.includes('重新 AI 核对')||button.innerText.includes('受控重试'))})()`));

    await clickText('返回总览');await clickSite('manual.example');
    await evaluate('document.querySelector(".task-summary").click()');await delay(100);
    check('manual-mode draft remains an explicit human approval task',await evaluate('document.querySelector(".task-card").innerText.includes("稿件待人工审核")&&[...document.querySelectorAll(".task-card button")].some(button=>button.innerText.includes("已核对稿件，继续发布"))'));

    await capture('planning-statuses.png');
    await clickText('返回总览');
    const productionSites=['alpha.example','beta.example','gamma.example','delta.example','gan.example'].map((domain,index)=>site(`prod-${index+1}`,domain,'ai',{monthlyTarget:2,...(domain==='gan.example'?{error:'本月还差 1 个页面；其他可执行任务会继续。'}:{})}));
    const productionLive=productionSites.slice(0,4).map((item,index)=>task(`prod-live-${index+1}`,item.id,'github-gist','live',{scheduledAt:`2026-09-${String(index+2).padStart(2,'0')}T00:00:00.000Z`,publicUrl:`https://gist.github.com/fixture/live-${index+1}`,firstLiveAt:`2026-09-${String(index+2).padStart(2,'0')}T00:05:00.000Z`,verifiedAt:`2026-09-${String(index+2).padStart(2,'0')}T00:10:00.000Z`,lastCheckedAt:stamp,health:'healthy',linkCheck:'found'}));
    const productionQueued=productionSites.map((item,index)=>task(`prod-queued-${index+1}`,item.id,'telegraph','queued',{scheduledAt:`2026-09-30T0${index+2}:00:00.000Z`,message:'已按发布间隔排入自动计划。'}));
    const productionTasks=[...productionLive,...productionQueued];
    state={...state,sites:productionSites,tasks:productionTasks,accounts:[],accountBindings:[],channelPolicyStatus:{},capacity:productionSites.map((item,index)=>({siteId:item.id,currentLive:index<4?1:0,firstVerifiedThisMonth:index<4?1:0,currentSources:index<4?1:0,monthlySources:index<4?1:0,missing:0,eligiblePages:0,automaticPages:0,eligibleUnused:0,automaticUnused:0,manualUnused:0,monthsAtTarget:0}))};
    win.webContents.send('fixture-change');
    await waitFor('document.querySelector(".metric-number strong")?.innerText==="4"&&document.body.innerText.includes("gan.example")');
    check('4 of 10 overview separates six unverified pages from five planned and one unplanned',await evaluate('document.querySelector(".metric-number").innerText.includes("4")&&document.querySelector(".metric-number").innerText.includes("10")&&document.querySelector(".capacity-note").innerText.includes("本月还有 6 个页面尚未核验")&&document.querySelector(".capacity-note").innerText.includes("5 个已排期或在途，1 个尚待建立计划")&&!document.querySelector(".capacity-note").innerText.includes("本月还差 1 个已核验页面")'));
    const productionRows=await evaluate(`Object.fromEntries([...document.querySelectorAll('.site-row')].map(row=>[row.querySelector('.site-name strong').innerText,{status:row.querySelector('.badge').innerText,next:row.querySelector('.next-date').innerText}]))`);
    check('queued gan work remains scheduled despite its informational capacity text',productionRows['gan.example'].status==='已排计划'&&productionRows['gan.example'].next.includes('今天'));
    check('queued capacity text is not promoted to a cross-site user action',await evaluate('document.querySelector(".attention-main h2").innerText==="当前没有需要你处理的任务"'));
    await capture('monthly-progress.png');
    await clickSite('gan.example');
    check('queued capacity text does not offer website reanalysis',await evaluate(`![...document.querySelectorAll('.banner.warning button')].some(button=>button.innerText==='重新分析')`));

    await clickText('返回总览');
    const actionableSites=productionSites.map((item,index)=>index===0?{...item,status:'attention',error:'网站暂时无法读取，请检查域名和网络后重新分析。'}:index===1?{...item,articleReviewMode:'manual'}:item);
    const manualAction=task('prod-manual-review','prod-2','manual-publication','needs_input',{checkpoint:'article_review',message:'稿件等待人工核对。'});
    state={...state,sites:actionableSites,tasks:[...productionTasks,manualAction]};win.webContents.send('fixture-change');
    await waitFor('document.querySelector(".attention-main h2")?.innerText==="稿件待人工审核"');
    check('a real manual review remains a user action',await evaluate('document.querySelector(".attention-main").innerText.includes("查看全部 1 项")'));
    state={...state,tasks:productionTasks};win.webContents.send('fixture-change');
    await waitFor('document.querySelector(".attention-main h2")?.innerText==="网站资料需要处理"');
    check('a genuine analysis failure remains a cross-site action',await evaluate('document.querySelector(".attention-main").innerText.includes("alpha.example")&&document.querySelector(".attention-main").innerText.includes("网站暂时无法读取")'));
    await clickText('查看网站');await waitFor('[...document.querySelectorAll(".banner.warning button")].some(button=>button.innerText==="重新分析")');
    check('analysis failure detail retains the reanalysis action',await evaluate('document.querySelector(".banner.warning").innerText.includes("网站暂时无法读取")'));
    await capture('actionable-analysis.png');

    await clickText('返回总览');
    const humanSites=[site('site-show-empty','show-empty.example','manual'),site('site-show-draft','show-draft.example','manual'),site('site-generic-manual','generic-manual.example','manual')];
    const showChannel=channel('show-hn','Show HN','manual',{domain:'news.ycombinator.com',submitUrl:'https://news.ycombinator.com/submit',allowedHosts:['news.ycombinator.com'],kind:'community',articleRequired:false,requirements:['software']});
    const genericManual=channel('manual-publication','Manual Publication','manual',{domain:'manual.example',allowedHosts:['manual.example'],requirements:[]});
    const humanTasks=[
      task('task-show-empty','site-show-empty','show-hn','needs_input',{draft:undefined,sourceDomain:'news.ycombinator.com',message:'等待本人撰写原创投稿文字。'}),
      task('task-show-draft','site-show-draft','show-hn','needs_input',{sourceDomain:'news.ycombinator.com',message:'已保留本人草稿。'}),
      task('task-generic-manual','site-generic-manual','manual-publication','needs_input',{draft:undefined,message:'可准备人工提交材料。'}),
    ];
    state={...state,sites:humanSites,tasks:humanTasks,channels:[showChannel,genericManual],accounts:[],accountBindings:[],capacity:humanSites.map(item=>({siteId:item.id,currentLive:0,firstVerifiedThisMonth:0,currentSources:0,monthlySources:0,missing:1,eligiblePages:1,automaticPages:0,eligibleUnused:1,automaticUnused:0,manualUnused:1,monthsAtTarget:0}))};
    win.webContents.send('fixture-change');
    await waitFor('document.body.innerText.includes("show-empty.example")');
    await clickSite('show-empty.example');
    await evaluate('document.querySelector(".task-summary").click()');await delay(100);
    check('Show HN site card explains human authorship and hides generation',await evaluate(`(()=>{const card=document.querySelector('.task-card');const labels=[...card.querySelectorAll('button')].map(button=>button.innerText);return card.innerText.includes('本人手写的原创投稿文字')&&!labels.some(label=>label.includes('生成草稿')||label.includes('重新准备'))&&labels.some(label=>label.includes('打开渠道页面'))&&labels.some(label=>label.includes('编辑稿件'))&&labels.some(label=>label.includes('填写地址'))&&labels.some(label=>label.includes('核验'))})()`));
    await clickText('任务');await clickText('全部');
    await waitFor('document.querySelectorAll(".work-identity").length===3');
    const inspectHumanRow=async(domain,forbidden)=>{const opened=await evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.work-identity strong')?.innerText===${JSON.stringify(domain)});if(!row)return false;row.querySelector('.work-identity').click();return true})()`);assert(opened,`human-only row: ${domain}`);await delay(80);return evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.work-identity strong')?.innerText===${JSON.stringify(domain)});return row?.innerText.includes('本人手写的原创投稿文字')&&!row?.innerText.includes(${JSON.stringify(forbidden)})&&!!row?.querySelector('[aria-label="打开渠道页面"]')&&!!row?.querySelector('[aria-label="编辑稿件"]')&&!!row?.querySelector('[aria-label="核验公开链接"]')})()`)};
    check('Show HN task center hides new AI preparation but keeps manual controls',await inspectHumanRow('show-empty.example','AI 准备材料'));
    check('Show HN task center hides regeneration for an existing draft',await inspectHumanRow('show-draft.example','重新准备材料'));
    const genericOpened=await evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.work-identity strong')?.innerText==='generic-manual.example');if(!row)return false;row.querySelector('.work-identity').click();return true})()`);assert(genericOpened,'generic manual row');await delay(80);
    check('other manual channels retain AI preparation',await evaluate(`(()=>{const row=[...document.querySelectorAll('.work-table tbody tr')].find(item=>item.querySelector('.work-identity strong')?.innerText==='generic-manual.example');return row?.innerText.includes('AI 准备材料')})()`));
    await capture('show-hn-human-authored-only.png');
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1280,height:800},checks,actions},null,2));
    console.log(`PLANNING UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
