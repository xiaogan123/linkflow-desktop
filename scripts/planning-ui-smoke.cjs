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
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,TZ:'Asia/Singapore'}});
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
    task('task-final-recovery','site-system','github-gist','failed',{checkpoint:'system_wait',nextCheckAt:future,recoveryAttempts:0,recoveryEligible:true,cost:{aiCalls:2},message:'已保留原稿，将进行最后一次预算内自动恢复。'}),
    task('task-deferred','site-manual','manual-publication','skipped',{checkpoint:'manual_submission',deferredAt:stamp,message:'等待人工处理超过两天，已保留原稿并搁置。'}),
    task('task-repeat-history','site-repeat','telegraph','live',{publicUrl:'https://telegra.ph/repeat-old-09-01',firstLiveAt:'2026-09-01T00:00:00.000Z',verifiedAt:'2026-09-01T00:05:00.000Z',lastCheckedAt:stamp,health:'healthy',linkCheck:'found',checkpoint:'telegraph_published'}),
    task('task-october','site-repeat','github-gist','queued',{scheduledAt:future,message:'已排入十月，不占用九月目标。'}),
  ];
  const apiAccountId='11111111-1111-4111-8111-111111111111';
  let state={sites,tasks,channels,accounts:[{id:apiAccountId,channelId:'telegraph',email:'owner@repeat.example',username:'fixture-api',createdAt:stamp,updatedAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'}],mailboxes:[],accountBindings:[{id:'22222222-2222-4222-8222-222222222222',siteId:'site-repeat',channelId:'telegraph',accountId:apiAccountId,createdAt:stamp,updatedAt:stamp}],events:[],settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:true,articleReviewMode:'ai',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'win32-x64',dataPath:dir,aiCallsToday:0},channelPolicyStatus:{'site-policy':{telegraph:'unconfirmed'}},schedulablePlatformIds:{'site-system':['telegraph'],'site-repeat':['telegraph']},capacity:sites.map(item=>({siteId:item.id,currentLive:item.id==='site-repeat'?1:0,firstVerifiedThisMonth:0,currentSources:item.id==='site-repeat'?1:0,monthlySources:0,missing:0,eligiblePages:item.id==='site-system'||item.id==='site-repeat'?1:0,automaticPages:item.id==='site-system'||item.id==='site-repeat'?1:0,eligibleUnused:item.id==='site-no-auto'?0:2,automaticUnused:item.id==='site-no-auto'?0:1,manualUnused:item.id==='site-no-auto'?0:1,monthsAtTarget:item.id==='site-no-auto'?0:1,...(item.id==='site-system'||item.id==='site-repeat'?{}:{blockingReason:'no_automatic_channel',reason:'当前没有符合条件且可执行的页面机会。'})}))};
  const actions=[];
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  // The renderer reports readiness once after its first snapshot; main answers true.
  let readyCalls=0;
  ipcMain.handle('fixture',(_event,name,payload)=>{if(name==='snapshot')return clone(state);if(name==='app:ready'){readyCalls+=1;return true}actions.push({name,payload:clone(payload)});return {ok:true}});

  const checks=[],failures=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  // Every check must pass; a failed one is recorded and the run continues so one report lists all failures.
  const check=(label,condition)=>{if(condition)checks.push(label);else failures.push(label)};
  const J=JSON.stringify;
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(40)}throw new Error(`UI readiness deadline: ${source}`)};
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('main button')].find(item=>item.innerText.trim()===${J(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text}`);await delay(100)};
  const clickNav=async label=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('.nav .nav-item')].find(item=>item.querySelector('span')?.innerText.trim().startsWith(${J(label)}));if(!button)return false;button.click();return true})()`);assert(clicked,`navigation: ${label}`);await delay(120)};
  const clickTab=async label=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('.workspace-tabs button')].find(item=>item.innerText.trim()===${J(label)});if(!button)return false;button.click();return true})()`);assert(clicked,`tab: ${label}`);await delay(100)};
  const clickSite=async domain=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('.overview .work-table button.inline-link')].find(item=>item.innerText.trim()===${J(domain)});if(!button)return false;button.click();return true})()`);assert(clicked,`site: ${domain}`);await delay(120)};
  const mainText=()=>evaluate(`document.querySelector('main').innerText`);
  const overviewRows=()=>evaluate(`Object.fromEntries([...document.querySelectorAll('.overview .work-table tbody tr')].map(row=>{const cells=[...row.querySelectorAll('td')].map(cell=>cell.innerText.trim());return [cells[0],{month:cells[1],next:cells[2],status:cells[3]}]}))`);
  const attentionItems=()=>evaluate(`[...document.querySelectorAll('.attention-panel .attention-item')].map(item=>({site:item.querySelector('strong')?.innerText.trim(),detail:item.querySelector('p')?.innerText.trim(),action:item.querySelector('button')?.innerText.trim()}))`);
  const stats=()=>evaluate(`Object.fromEntries([...document.querySelectorAll('.dashboard-stats .stat')].map(item=>[item.querySelector('span').innerText.trim(),item.querySelector('strong').innerText.trim()]))`);
  const todoCards=()=>evaluate(`[...document.querySelectorAll('.todo-page .todo-card')].map(card=>({title:card.querySelector('.todo-title strong')?.innerText.trim(),group:card.closest('.todo-group')?.querySelector('h2')?.innerText.trim(),text:card.innerText,buttons:[...card.querySelectorAll('button')].map(button=>button.innerText.trim())}))`);
  const todoGroups=()=>evaluate(`[...document.querySelectorAll('.todo-page .todo-group h2')].map(item=>item.innerText.trim())`);
  // Site schedule tab: one task card per task, identified by platform name and display badge; opened to read its details.
  const openCard=async(platform,badge)=>{
    const find=`[...document.querySelectorAll('.task-card')].find(item=>item.querySelector('.task-main strong')?.innerText.trim()===${J(platform)}&&item.querySelector('.task-summary .badge')?.innerText.trim()===${J(badge)})`;
    const found=await evaluate(`(()=>{const card=${find};if(!card)return false;const summary=card.querySelector('.task-summary');if(summary.getAttribute('aria-expanded')!=='true')summary.click();return true})()`);
    if(!found)return undefined;await delay(100);
    return evaluate(`(()=>{const card=${find};if(!card)return undefined;return {text:card.innerText,entries:Object.fromEntries([...card.querySelectorAll('.task-detail dt')].map(item=>[item.innerText.trim(),item.nextElementSibling?.innerText.trim()])),buttons:[...card.querySelectorAll('.task-actions button')].map(button=>button.innerText.trim())}})()`);
  };
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("policy.example")');
    // Dates below are rendered in the renderer's local zone; the child process runs with the fixture's zone.
    assert.equal(await evaluate(`new Date(${J(future)}).getHours()`),9,'renderer runs in Asia/Singapore');

    const rows=await overviewRows(),items=await attentionItems(),overviewText=await mainText();
    check('overview keeps automatic retry work out of user actions and shows its next automatic time',rows['system.example']?.status==='平台不够'&&rows['system.example'].next==='10月3日 09:00');
    check('overview uses capacity reason when stopped policy work has no other page opportunity',rows['policy.example']?.status==='平台不够');
    check('stopped policy work does not advertise its stored date as an automatic recheck',rows['policy.example']?.next==='等待排期'&&!overviewText.includes('10月10日'));
    check('overview reserves human review wording for manual mode',rows['manual.example']?.status==='要你处理'&&items.some(item=>item.site==='manual.example'&&item.detail==='稿子写好了，等你看一眼。'&&item.action==='看稿')&&items.filter(item=>item.action==='看稿').length===1);
    check('overview identifies account handoff as a real user action',rows['handoff.example']?.status==='要你处理'&&items.some(item=>item.site==='handoff.example'&&item.detail.includes('连接')&&item.action==='去连接'));
    check('overview explicitly states no automatic channel when page opportunities are absent',rows['no-auto.example']?.status==='平台不够'&&await evaluate(`[...document.querySelectorAll('.overview .banner.warning')].some(item=>item.innerText.includes('平台不够用')&&[...item.querySelectorAll('button')].some(button=>button.innerText.trim()==='看原因'))`));
    check('overview human todo count excludes system and channel waits',items.length===2&&new Set(items.map(item=>item.site)).size===2&&items.every(item=>['manual.example','handoff.example'].includes(item.site))&&overviewText.includes('2 件事要你处理')&&await evaluate(`document.querySelector('.nav .todo-count')?.innerText.trim()==='2'&&[...document.querySelectorAll('.attention-panel button')].some(button=>button.innerText.trim()==='全部 2 件待办')`));
    check('overview page-gap copy does not request invented qualifications',overviewText.includes('平台不够用')&&!overviewText.includes('资格'));
    const firstStats=await stats();
    check('next-month queued work does not cover the current-month page gap',firstStats['本月新增外链']==='1/12'&&overviewText.includes('9 月已拿到 1 / 12 条')&&rows['repeat.example']?.month==='1/2 条'&&await evaluate(`(()=>{const bar=document.querySelector('.dashboard-stats progress');return bar?.value===1&&bar.max===12})()`));

    await clickText('全部 2 件待办');
    await waitFor('document.querySelectorAll(".todo-page .todo-card").length===2');
    let todos=await todoCards();
    check('overview attention card opens the human to-do list',todos.map(item=>item.title).sort().join('|')==='handoff.example · GitHub|manual.example · Manual Publication');
    await clickNav('总览');await clickNav('待办');
    await waitFor('document.querySelectorAll(".todo-page .todo-card").length===2');
    const sidebarTodos=await todoCards();
    await clickNav('总览');await clickText('全部 2 件待办');
    await waitFor('document.querySelectorAll(".todo-page .todo-card").length===2');
    todos=await todoCards();
    check('overview attention card and sidebar navigation open the same human to-do list',sidebarTodos.map(item=>item.title).join('|')===todos.map(item=>item.title).join('|'));
    check('to-do list separates human work from system and platform waits',await evaluate(`document.querySelector('.todo-page').innerText.includes('2 件事要你处理')`)&&!todos.some(item=>/system\.example|policy\.example|repeat\.example|no-auto\.example/.test(item.title)));
    check('to-do list orders human work by its action group',(await todoGroups()).join('|')==='要你连接账号|要你看稿'&&todos[0]?.buttons.includes('去连接')&&todos[1]?.buttons.includes('看稿'));

    await clickNav('总览');await clickSite('system.example');await clickTab('排期');
    check('site schedule lists the runnable automatic work',await evaluate(`(()=>{const labels=[...document.querySelectorAll('.work-table tbody tr')].map(row=>row.innerText.replace(/\\s+/g,' ').trim());return labels.includes('10月3日 09:00 Telegraph 已排期')&&labels.includes('10月3日 09:00 Telegraph 进行中')&&labels.length===2})()`));
    const badges=await evaluate(`[...document.querySelectorAll('.task-card')].map(card=>card.querySelector('.task-main strong').innerText.trim()+':'+card.querySelector('.task-summary .badge').innerText.trim())`);
    check('default task view distinguishes each truthful automatic state from stopped work',badges.join('|')==='Telegraph:已排期|GitHub Gist:没做成|Telegraph:进行中|GitHub Gist:已排期');
    const retryCard=await openCard('Telegraph','已排期');
    check('automatic retry keeps its scheduled automatic follow-up',!!retryCard&&retryCard.text.includes('10月3日 09:00 发')&&retryCard.entries['下次自动操作']==='10月3日');
    const stoppedCard=await openCard('GitHub Gist','没做成');
    check('stopped system work shows no automatic follow-up',!!stoppedCard&&stoppedCard.entries['自动后续']==='未安排'&&!('下次自动操作' in stoppedCard.entries)&&!/自动重试|稍后重试/.test(stoppedCard.text.replace(/技术详情[\s\S]*$/,'')));
    const reconcileCard=await openCard('Telegraph','进行中');
    check('automatic reconciliation row is available',!!reconcileCard&&reconcileCard.text.includes('等平台结果')&&!reconcileCard.text.replace(/技术详情[\s\S]*$/,'').includes('需要你来完成'));
    check('Telegraph reconciliation uses reconcileAfter instead of an empty nextCheckAt',!!reconcileCard&&!!reconcileCard.entries['下次自动操作']&&reconcileCard.entries['下次自动操作']!=='—');
    const recoveryCard=await openCard('GitHub Gist','已排期');
    check('final recovery row is available',!!recoveryCard&&!recoveryCard.text.replace(/技术详情[\s\S]*$/,'').includes('没做成'));
    check('recoverable failed draft keeps its final-recovery schedule',!!recoveryCard&&recoveryCard.text.includes('10月3日 09:00 发')&&recoveryCard.entries['下次自动操作']==='10月3日'&&!recoveryCard.buttons.includes('恢复原稿'));

    await clickNav('总览');await clickSite('policy.example');await clickTab('排期');
    const policyCard=await openCard('Telegraph','没做成');
    check('channel filter shows policy wait without an audit label',!!policyCard&&!policyCard.text.includes('待确认')&&!policyCard.text.includes('要你处理'));
    check('policy details show the concrete evidence gap with safe next ownership',!!policyCard&&policyCard.text.includes('已改用其他平台')&&policyCard.text.includes('https://evidence.example/policy'));
    check('policy wait offers details without manual retry controls',!!policyCard&&!policyCard.buttons.some(label=>label.includes('重新 AI 复核')||label.includes('受控重试')||label.includes('追加 1 次 AI 复核')));
    check('site timeline preserves policy evidence details without a fake schedule or retry CTA',!!policyCard&&policyCard.entries['自动后续']==='未安排'&&!('下次自动操作' in policyCard.entries)&&await evaluate(`document.querySelector('main').innerText.includes('未来 30 天还没有排期。')`));
    await clickTab('设置');
    await waitFor('document.querySelector("main").innerText.includes("不要求你决定例外")');
    check('Telegraph policy setting is optional and automatic flow waits for evidence',await evaluate('document.querySelector("main").innerText.includes("自动流程会等待新证据，不要求你决定例外")&&document.querySelector("main").innerText.includes("可选：平台使用设置")'));
    check('Telegraph site readiness prepares the API identity automatically without account handoff',await evaluate(`(()=>{const row=[...document.querySelectorAll('.site-tools .fit-row')].find(item=>item.querySelector('strong')?.innerText==='Telegraph');return row?.innerText.includes('官方 API')&&row.innerText.includes('外链助手会自动准备发布账号')&&!row.innerText.includes('需先连接并验证已有账号')})()`));

    await clickNav('总览');await clickSite('no-auto.example');await clickTab('设置');
    await waitFor('document.querySelector("main").innerText.includes("当前暂无自动发布外链的机会")');
    check('site tools say to wait for available channels without requiring qualification proof',await evaluate('document.querySelector("main").innerText.includes("无需为了补足数量填写并不存在的资格")'));
    check('capacity copy separates page opportunities from new-source diversity',await evaluate('document.querySelector("main").innerText.includes("当前可安排外链")&&document.querySelector("main").innerText.includes("可选平台另记为")&&document.querySelector("main").innerText.includes("不代表本月可发外链数")'));

    await clickNav('总览');await clickSite('manual.example');await clickTab('排期');
    const reviewCard=await openCard('Manual Publication','要你处理');
    check('manual-mode draft remains an explicit human approval task',!!reviewCard&&reviewCard.text.includes('稿子写好了，等你看一眼。')&&reviewCard.buttons.includes('已核对稿件，继续发布'));
    const deferredCard=await openCard('Manual Publication','没做成');
    check('deferred task stays out of the to-do list as unfinished work',!!deferredCard&&todos.filter(item=>item.title.startsWith('manual.example · ')).length===1);
    check('deferred task offers original-draft recovery without regenerating it',!!deferredCard&&deferredCard.buttons.includes('恢复原稿')&&!deferredCard.buttons.some(label=>label.includes('生成草稿')||label.includes('重新准备材料')));
    await clickText('恢复原稿');
    check('deferred recovery dispatches task retry for the same task',actions.some(item=>item.name==='task:retry'&&item.payload?.id==='task-deferred'));
    await capture('planning-statuses.png');

    await clickNav('平台与账号');
    await evaluate('(()=>{const e=document.querySelector("[aria-label=看哪个网站]");e.value="site-repeat";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(120);
    const telegraphRow=await evaluate(`(()=>{const row=[...document.querySelectorAll('.platform-table tbody tr')].find(item=>item.querySelector('td button')?.innerText.trim()==='Telegraph');if(!row)return undefined;return {group:row.closest('.platform-group')?.querySelector('.group-head strong')?.innerText.trim(),text:row.innerText,buttons:[...row.querySelectorAll('button')].map(button=>button.innerText.trim())}})()`);
    check('repeatable Telegraph channel is visible',!!telegraphRow&&await evaluate(`document.querySelector('.platforms-page').innerText.includes('适合 repeat.example')`));
    const telegraphOpened=await evaluate(`(()=>{const button=[...document.querySelectorAll('.platform-table td button')].find(item=>item.innerText.trim()==='Telegraph');if(!button)return false;button.click();return true})()`);await delay(120);
    const drawer=await evaluate(`(()=>{const body=document.querySelector('.side-drawer .platform-detail');if(!body)return undefined;const entries=Object.fromEntries([...body.querySelectorAll('.detail-list dt')].map(item=>[item.innerText.trim(),item.nextElementSibling?.innerText.trim()]));const action=body.querySelector('.channel-task-action');return {entries,recent:[...body.querySelectorAll('.recent-links li')].map(item=>item.innerText),action:action?.innerText??'',buttons:[...(action?.querySelectorAll('button')??[])].map(button=>({label:button.innerText.trim(),disabled:button.disabled}))}})()`);
    check('Telegraph explicitly creates its API identity without first-time connection',telegraphOpened&&telegraphRow?.group==='软件自动建号'&&telegraphRow.text.includes('自动建号')&&telegraphRow.text.includes('在用')&&!telegraphRow.buttons.some(label=>label==='连接'||label==='去验证')&&drawer?.entries['连接']?.includes('任务需要时自动建立发布账号'));
    check('historical Telegraph result exposes the next publication opportunity',!!drawer&&drawer.recent.some(item=>item.includes('repeat.example'))&&drawer.action.includes('30 天间隔')&&drawer.action.includes('下次可排：10月1日 08:00')&&drawer.buttons.some(item=>item.label==='加入执行计划'&&item.disabled)&&!drawer.buttons.some(item=>item.label==='查看已有任务'));
    await evaluate(`document.querySelector('.side-drawer [aria-label="关闭"]')?.click()`);await delay(80);

    await clickNav('总览');
    const productionSites=['alpha.example','beta.example','gamma.example','delta.example','gan.example'].map((domain,index)=>site(`prod-${index+1}`,domain,'ai',{monthlyTarget:2,...(domain==='gan.example'?{error:'本月还差 1 个页面；其他可执行任务会继续。'}:{})}));
    const productionLive=productionSites.slice(0,4).map((item,index)=>task(`prod-live-${index+1}`,item.id,'github-gist','live',{scheduledAt:`2026-09-${String(index+2).padStart(2,'0')}T00:00:00.000Z`,publicUrl:`https://gist.github.com/fixture/live-${index+1}`,firstLiveAt:`2026-09-${String(index+2).padStart(2,'0')}T00:05:00.000Z`,verifiedAt:`2026-09-${String(index+2).padStart(2,'0')}T00:10:00.000Z`,lastCheckedAt:stamp,health:'healthy',linkCheck:'found'}));
    const productionQueued=productionSites.map((item,index)=>task(`prod-queued-${index+1}`,item.id,'telegraph','queued',{scheduledAt:`2026-09-30T0${index+2}:00:00.000Z`,message:'已按发布间隔排入自动计划。'}));
    const productionTasks=[...productionLive,...productionQueued];
    state={...state,sites:productionSites,tasks:productionTasks,accounts:[],accountBindings:[],channelPolicyStatus:{},schedulablePlatformIds:Object.fromEntries(productionSites.map(item=>[item.id,['telegraph']])),capacity:productionSites.map((item,index)=>({siteId:item.id,currentLive:index<4?1:0,firstVerifiedThisMonth:index<4?1:0,currentSources:index<4?1:0,monthlySources:index<4?1:0,missing:0,eligiblePages:0,automaticPages:0,eligibleUnused:0,automaticUnused:0,manualUnused:0,monthsAtTarget:0}))};
    win.webContents.send('fixture-change');
    await waitFor('[...document.querySelectorAll(".dashboard-stats .stat strong")][0]?.innerText==="4/10"&&document.body.innerText.includes("gan.example")');
    const productionRows=await overviewRows(),productionText=await mainText();
    check('4 of 10 overview counts only verified pages while every site keeps its planned work',productionText.includes('9 月已拿到 4 / 10 条')&&Object.keys(productionRows).length===5&&Object.values(productionRows).every(row=>row.next!=='等待排期')&&productionRows['gan.example']?.month==='0/2 条'&&['alpha.example','beta.example','gamma.example','delta.example'].every(domain=>productionRows[domain]?.month==='1/2 条')&&!productionText.includes('本月还差 1 个'));
    check('queued gan work remains scheduled despite its informational capacity text',productionRows['gan.example']?.next==='9月30日 14:00'&&productionRows['gan.example'].status!=='要你处理');
    check('queued capacity text is not promoted to a cross-site user action',(await attentionItems()).length===0&&productionText.includes('不用你处理')&&productionText.includes('没有要你处理的事')&&!productionText.includes('件待办'));
    await capture('monthly-progress.png');
    await clickSite('gan.example');
    const ganLinks=await evaluate(`[...document.querySelectorAll('main button')].map(button=>button.innerText.trim())`);
    await clickTab('设置');
    const ganSettings=await evaluate(`[...document.querySelectorAll('main button')].map(button=>button.innerText.trim())`);
    check('queued capacity text does not offer website reanalysis',![...ganLinks,...ganSettings].some(label=>label.includes('重新分析'))&&!(await mainText()).includes('本月还差 1 个页面'));

    await clickNav('总览');
    const actionableSites=productionSites.map((item,index)=>index===0?{...item,status:'attention',error:'网站暂时无法读取，请检查域名和网络后重新分析。'}:index===1?{...item,articleReviewMode:'manual'}:item);
    const manualAction=task('prod-manual-review','prod-2','manual-publication','needs_input',{checkpoint:'article_review',message:'稿件等待人工核对。'});
    state={...state,sites:actionableSites,tasks:[...productionTasks,manualAction],schedulablePlatformIds:Object.fromEntries(actionableSites.filter(item=>item.status==='ready').map(item=>[item.id,['telegraph']]))};win.webContents.send('fixture-change');
    // The analysis failure on alpha and the manual review on beta are the two things to handle; the 待办 page lists the review only.
    await waitFor('document.querySelector("main").innerText.includes("2 件事要你处理")');
    const reviewItems=await attentionItems(),review=reviewItems.filter(item=>item.action==='看稿');
    check('a real manual review remains a user action',(await overviewRows())['beta.example']?.status==='要你处理'&&reviewItems.length===2&&review.length===1&&review[0].site==='beta.example'&&reviewItems.some(item=>item.site==='alpha.example'&&item.action==='重新分析')&&(await mainText()).includes('全部 1 件待办'));
    state={...state,tasks:productionTasks};win.webContents.send('fixture-change');
    await waitFor(`(()=>{const row=[...document.querySelectorAll('.overview .work-table tbody tr')].find(item=>item.querySelector('td')?.innerText.trim()==='beta.example');return !!row&&!row.innerText.includes('要你处理')})()`);
    check('a genuine analysis failure remains a cross-site action',await evaluate(`(()=>{const panel=document.querySelector('.attention-panel')?.innerText??'';return panel.includes('alpha.example')&&panel.includes('网站暂时无法读取')})()`));
    await clickSite('alpha.example');
    const reanalyze=`[...document.querySelectorAll('main button')].find(button=>button.innerText.includes('重新分析')&&!button.disabled)`;
    let reanalysisOffered=await evaluate(`!!${reanalyze}&&document.querySelector('main').innerText.includes('网站暂时无法读取')`);
    if(!reanalysisOffered){await clickTab('设置');reanalysisOffered=await evaluate(`!!${reanalyze}&&document.querySelector('main').innerText.includes('网站暂时无法读取')`)}
    if(reanalysisOffered){await evaluate(`${reanalyze}.click()`);await delay(100)}
    check('analysis failure detail retains the reanalysis action',reanalysisOffered&&actions.some(item=>item.name==='site:analyze'&&item.payload?.id==='prod-1'));
    await capture('actionable-analysis.png');

    await clickNav('总览');
    const humanSites=[site('site-show-empty','show-empty.example','manual'),site('site-show-draft','show-draft.example','manual'),site('site-generic-manual','generic-manual.example','manual')];
    const showChannel=channel('show-hn','Show HN','manual',{domain:'news.ycombinator.com',submitUrl:'https://news.ycombinator.com/submit',allowedHosts:['news.ycombinator.com'],kind:'community',articleRequired:false,requirements:['software']});
    const genericManual=channel('manual-publication','Manual Publication','manual',{domain:'manual.example',allowedHosts:['manual.example'],requirements:[]});
    const humanTasks=[
      task('task-show-empty','site-show-empty','show-hn','needs_input',{draft:undefined,sourceDomain:'news.ycombinator.com',message:'等待本人撰写原创投稿文字。'}),
      task('task-show-draft','site-show-draft','show-hn','needs_input',{sourceDomain:'news.ycombinator.com',message:'已保留本人草稿。'}),
      task('task-generic-manual','site-generic-manual','manual-publication','needs_input',{draft:undefined,message:'可准备人工提交材料。'}),
    ];
    state={...state,sites:humanSites,tasks:humanTasks,channels:[showChannel,genericManual],accounts:[],accountBindings:[],schedulablePlatformIds:Object.fromEntries(humanSites.map(item=>[item.id,[]])),capacity:humanSites.map(item=>({siteId:item.id,currentLive:0,firstVerifiedThisMonth:0,currentSources:0,monthlySources:0,missing:1,eligiblePages:1,automaticPages:0,eligibleUnused:1,automaticUnused:0,manualUnused:1,monthsAtTarget:0}))};
    win.webContents.send('fixture-change');
    await waitFor('document.body.innerText.includes("show-empty.example")');
    await clickSite('show-empty.example');await clickTab('排期');
    const showCard=await openCard('Show HN','要你处理');
    check('Show HN site card explains human authorship and hides generation',!!showCard&&showCard.text.includes('本人手写的原创投稿文字')&&!showCard.buttons.some(label=>label.includes('生成草稿')||label.includes('重新准备'))&&['打开平台页面','编辑稿件','填写地址','检查链接'].every(label=>showCard.buttons.includes(label)));
    await clickNav('待办');
    await waitFor('document.querySelectorAll(".todo-page .todo-card").length===3');
    const inspectTodo=async domain=>{const opened=await evaluate(`(()=>{const card=[...document.querySelectorAll('.todo-page .todo-card')].find(item=>item.querySelector('.todo-title strong')?.innerText.trim().startsWith(${J(domain+' · ')}));const button=card&&[...card.querySelectorAll('button')].find(item=>item.innerText.trim()==='去发布');if(!button)return false;button.click();return true})()`);assert(opened,`human-only to-do: ${domain}`);await delay(100);return (await todoCards()).find(item=>item.title.startsWith(`${domain} · `))};
    const aiPreparation=label=>label.includes('生成草稿')||label.includes('AI 准备材料')||label.includes('重新准备材料');
    const emptyTodo=await inspectTodo('show-empty.example');
    check('Show HN task center hides new AI preparation but keeps manual controls',!!emptyTodo&&!emptyTodo.buttons.some(aiPreparation)&&['编辑稿件','打开平台','填写地址'].every(label=>emptyTodo.buttons.includes(label)));
    const draftTodo=await inspectTodo('show-draft.example');
    check('Show HN task center hides regeneration for an existing draft',!!draftTodo&&draftTodo.text.includes('task-show-draft draft')&&!draftTodo.buttons.some(aiPreparation)&&['编辑稿件','打开平台','填写地址'].every(label=>draftTodo.buttons.includes(label)));
    // A human-authored-only platform must not be presented as software-written work without the authorship notice.
    check('Show HN task center tells the user the text must be written by hand',[emptyTodo,draftTodo].every(item=>!!item&&(item.text.includes('本人手写的原创投稿文字')||!item.group.includes('软件写好'))));
    await clickNav('总览');await clickSite('generic-manual.example');await clickTab('排期');
    const genericCard=await openCard('Manual Publication','要你处理');
    check('other manual channels retain AI preparation',!!genericCard&&genericCard.buttons.includes('生成草稿')&&!genericCard.text.includes('本人手写的原创投稿文字'));
    await capture('show-hn-human-authored-only.png');
    check('renderer signals app:ready once after the first snapshot',readyCalls===1);
    if(failures.length)throw new Error(`${failures.length} planning UI check(s) failed:\n- ${failures.join('\n- ')}`);
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1280,height:800},checks,actions},null,2));
    console.log(`PLANNING UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,failures,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
