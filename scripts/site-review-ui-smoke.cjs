const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-site-review-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};createRoot(document.getElementById('root')).render(<App/>);`,
        resolveDir:root,
        loader:'tsx',
      },
      outfile:join(dir,'ui.js'),
      bundle:true,
      platform:'browser',
      jsx:'automatic',
    });
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('linkflow',{invoke:(name,payload)=>ipcRenderer.invoke('fixture',name,payload),onChange:(callback)=>{const handler=()=>callback();ipcRenderer.on('fixture-change',handler);return()=>ipcRenderer.removeListener('fixture-change',handler)}});`);
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const dir=process.argv[2];
  const evidence=join(process.cwd(),'.evidence','site-review-mode-2026-10-01');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));

  const channel={id:'article-api',name:'文章 API',domain:'publisher.example',url:'https://publisher.example',submitUrl:'https://publisher.example/new',categories:['general'],languages:['zh'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'测试渠道',automation:'api',quality:'A',qualityReason:'隔离 UI fixture',rulesUrl:'https://publisher.example/rules',checkedAt:'2026-10-01',notes:'',allowedHosts:['publisher.example'],enabled:true};
  const site=(id,domain,articleReviewMode)=>({id,domain,url:`https://${domain}`,email:`hello@${domain}`,publicEmail:`hello@${domain}`,name:domain.split('.')[0],description:'隔离 UI 测试网站',category:'general',language:'zh',monthlyTarget:2,...(articleReviewMode?{articleReviewMode}:{}),status:'ready',createdAt:'2026-10-01T00:00:00.000Z'});
  const task=(id,siteId)=>({id,siteId,channelId:channel.id,sourceDomain:channel.domain,status:id.endsWith('ai')?'queued':'needs_input',createdAt:'2026-10-01T00:00:00.000Z',scheduledAt:'2026-10-01T00:00:00.000Z',updatedAt:`2026-10-01T00:00:0${id.endsWith('ai')?2:1}.000Z`,attempts:1,message:'稿件等待审核',checkpoint:'article_review',draft:{title:`${siteId} 稿件`,description:'摘要',body:'正文'}});
  const state={
    sites:[site('site-manual','manual.example','manual'),site('site-ai','auto.example','ai'),site('site-legacy','legacy.example')],
    tasks:[task('task-manual','site-manual'),task('task-ai','site-ai')],
    channels:[channel],accounts:[],mailboxes:[],accountBindings:[],events:[],
    settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'ai',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'imap.gmail.com',port:993,user:'defaults@example.com',secure:true,hasPassword:false}},
    runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:dir,aiCallsToday:0},
  };
  const actions=[];
  // Read-only calls the renderer makes on its own (startup acknowledgement, update polling); they never change a site.
  const readOnly=new Set(['app:ready','app:update-status']);
  const mutations=()=>actions.filter(item=>!readOnly.has(item.name));
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  ipcMain.handle('fixture',(_event,name,payload)=>{
    if(name==='snapshot')return clone(state);
    if(name==='app:ready'){actions.push({name});return true}
    if(name==='site:add-batch'){
      actions.push({name,payload:clone(payload)});
      const siteIds=[];
      for(const domain of payload.domains){
        const created=site(`created-${state.sites.length}`,domain,payload.articleReviewMode);
        created.email=payload.contactEmail;created.publicEmail=payload.contactEmail;created.monthlyTarget=payload.monthlyTarget;
        state.sites.push(created);siteIds.push(created.id);
      }
      return {added:siteIds.length,duplicates:0,errors:[],siteIds,rolloutDays:1};
    }
    if(name==='site:update'){
      actions.push({name,payload:clone(payload)});
      const current=state.sites.find(item=>item.id===payload.id);
      if(!current)throw new Error('fixture site missing');
      Object.assign(current,payload);
      return {ok:true};
    }
    actions.push({name,payload:clone(payload)});
    return {ok:true};
  });

  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(40)}throw new Error(`UI readiness deadline: ${source}`)};
  // Click an enabled button whose visible text is exactly `text`, optionally only inside `scope`.
  const clickText=async(text,scope='body')=>{const clicked=await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});if(!root)return false;const button=[...root.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text} in ${scope}`);await delay(100)};
  // Sidebar entries; the 待办 entry carries a count badge after its label.
  const clickNav=async label=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('nav .nav-item')].find(item=>item.querySelector('span')?.firstChild?.textContent.trim()===${JSON.stringify(label)});if(!button)return false;button.click();return true})()`);assert(clicked,`nav: ${label}`);await delay(100)};
  const clickSite=async domain=>{const clicked=await evaluate(`(()=>{const target=[...document.querySelectorAll('button.inline-link')].find(item=>item.innerText.trim()===${JSON.stringify(domain)});if(!target)return false;target.click();return true})()`);assert(clicked,`site: ${domain}`);await delay(100)};
  const clickSiteTab=async label=>clickText(label,'[role=group][aria-label="网站详情"]');
  const setValue=async(selector,value)=>{const changed=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);assert(changed,`input: ${selector}`);await delay(50)};
  // The add dialog's publishing mode is a <select> inside the field labelled 发布方式.
  const addModeSelect='[...document.querySelectorAll("[role=dialog] label.field")].find(item=>item.querySelector("span")?.innerText.trim()==="发布方式")?.querySelector("select")';
  const chooseAddMode=async value=>{const changed=await evaluate(`(()=>{const element=${addModeSelect};if(!element)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);assert(changed,`add mode: ${value}`);await delay(50)};
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};
  const checkDialogLayout=async saveText=>{
    const result=await evaluate(`(()=>{const dialog=document.querySelector('.dialog');const button=[...dialog.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(saveText)});if(!button)return {missing:true};dialog.scrollTop=dialog.scrollHeight;const rect=button.getBoundingClientRect();return {dialogHorizontal:dialog.scrollWidth<=dialog.clientWidth+1,pageHorizontal:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1,saveVisible:rect.top>=0&&rect.bottom<=innerHeight}})()`);
    check(`${saveText} remains reachable at 1050x720`,!result.missing&&result.dialogHorizontal&&result.pageHorizontal&&result.saveVisible);
  };
  const taskCardText=`[...document.querySelectorAll('.task-card')].find(card=>card.querySelector('.task-main small')?.innerText.includes(${JSON.stringify(channel.domain)}))`;
  const taskActionTexts=`[...(${taskCardText}?.querySelectorAll('.task-actions button')??[])].map(item=>item.innerText.trim())`;
  const aiRetryLabels=['重新 AI 复核','追加 1 次 AI 复核'];

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1050,height:720,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("manual.example")');
    // Slow CI runners can paint before the ready acknowledgement lands; wait for it, then a moment more to catch a duplicate.
    for(let waited=0;waited<50&&!actions.some(item=>item.name==='app:ready');waited++)await delay(100);await delay(300);
    check('renderer acknowledges startup once after the first snapshot',actions.filter(item=>item.name==='app:ready').length===1);
    check('first-run guide stays closed when sites already exist',!(await evaluate('!!document.querySelector("[role=dialog]")')));

    await clickText('添加网站');
    check('new site defaults to current global AI mode',await evaluate(`${addModeSelect}?.value==="ai"`));
    check('add dialog gives two clear selectable modes',await evaluate(`(()=>{const select=${addModeSelect};if(!select)return false;const options=[...select.options].map(item=>[item.value,item.textContent.trim()]);return JSON.stringify(options)===JSON.stringify([["ai","全自动（推荐）"],["manual","每篇我先看"]])&&document.querySelector("[role=dialog]").innerText.includes("每篇我先看：稿子写好后等你确认，48 小时没看就放弃这篇。")})()`));
    await evaluate(`${addModeSelect}.scrollIntoView({block:"center"})`);
    await capture('add-site-review-mode.png');
    await setValue('[role=dialog] textarea[placeholder="example.com"]','created.example');
    await setValue('[role=dialog] input[type=email]','owner@created.example');
    await checkDialogLayout('添加 1 个网站');
    await clickText('添加 1 个网站','[role=dialog]');
    await waitFor('document.querySelector("[role=dialog] .batch-result")?.innerText.includes("已添加 1 个网站")');
    const add=actions.find(item=>item.name==='site:add-batch');
    check('new site sends an explicit AI mode payload',JSON.stringify(add?.payload)===JSON.stringify({domains:['created.example'],monthlyTarget:2,articleReviewMode:'ai',siteType:'auto',contactEmail:'owner@created.example'}));
    await clickText('完成','[role=dialog]');
    await waitFor('!document.querySelector("[role=dialog]")');

    const beforeCancel=mutations().length;
    await clickText('添加网站');
    await chooseAddMode('manual');
    check('add dialog accepts the manual choice before cancelling',await evaluate(`${addModeSelect}?.value==="manual"`));
    await clickText('取消','[role=dialog]');
    await waitFor('!document.querySelector("[role=dialog]")');
    check('cancel does not mutate publication permission',mutations().length===beforeCancel);
    await clickText('添加网站');
    check('reopening add resets the cancelled choice to the global default',await evaluate(`${addModeSelect}?.value==="ai"`));
    await clickText('取消','[role=dialog]');
    await waitFor('!document.querySelector("[role=dialog]")');

    await clickNav('网站');
    await waitFor('[...document.querySelectorAll("button.inline-link")].some(item=>item.innerText.trim()==="created.example")');
    check('websites table lists each site with its effective mode',await evaluate(`(()=>{const mode=domain=>[...document.querySelectorAll('.sites-page tbody tr')].find(row=>row.querySelector('button.inline-link')?.innerText.trim()===domain)?.children[2]?.innerText.trim();return mode('created.example')==='全自动'&&mode('auto.example')==='全自动'&&mode('manual.example')==='每篇我先看'&&mode('legacy.example')==='全自动'})()`));
    await clickSite('legacy.example');
    await clickSiteTab('设置');
    check('legacy site settings show its inherited effective mode',await evaluate('document.body.innerText.includes("发布方式：全自动")'));
    await clickText('编辑网站','main');
    check('legacy site edit preselects its effective inherited mode',await evaluate('document.querySelector("input[name=edit-site-review-mode][value=ai]")?.checked===true'));
    check('edit dialog offers both modes and explains the manual consequence',await evaluate('(()=>{const box=document.querySelector("[role=dialog] .site-review-mode");return !!box&&box.querySelectorAll("input[name=edit-site-review-mode]").length===2&&box.innerText.includes("全自动（推荐）")&&box.innerText.includes("每篇我先看：稿子写好后等你确认，48 小时没看就放弃这篇。")})()'));
    await evaluate('document.querySelector(".site-review-mode").scrollIntoView({block:"center"})');
    await capture('edit-site-review-mode.png');
    await checkDialogLayout('保存');
    await evaluate('document.querySelector("input[name=edit-site-review-mode][value=manual]").click()');
    await clickText('保存','[role=dialog]');
    await waitFor('!document.querySelector("[role=dialog]")');
    const edit=actions.findLast(item=>item.name==='site:update'&&item.payload.id==='site-legacy');
    check('edit sends the explicitly switched manual mode',edit?.payload.articleReviewMode==='manual');
    await waitFor('document.body.innerText.includes("发布方式：每篇我先看")');
    check('site details show the current effective mode',await evaluate('document.body.innerText.includes("发布方式：每篇我先看")&&!document.body.innerText.includes("发布方式：全自动")'));
    await evaluate('document.querySelector(".banner.success button")?.click()');
    await delay(50);

    await clickNav('待办');
    await waitFor('document.querySelectorAll(".todo-card").length>0');
    check('manual site task exposes only the human review route',await evaluate(`(()=>{const cards=[...document.querySelectorAll('.todo-card')];if(cards.length!==1)return false;const card=cards[0],group=card.closest('.todo-group');return card.innerText.includes('manual.example')&&group?.querySelector('h2')?.innerText.trim()==='要你看稿'&&card.innerText.includes('稿子写好了，等你看一眼。')&&card.innerText.includes('到期放弃这篇')&&[...card.querySelectorAll('button')].some(item=>item.innerText.trim()==='看稿')&&!document.body.innerText.includes('auto.example')&&!${JSON.stringify(aiRetryLabels)}.some(label=>document.body.innerText.includes(label))})()`));
    await clickText('看稿','.todo-card');
    check('manual review card shows the draft with approval and no AI retry',await evaluate(`(()=>{const card=document.querySelector('.todo-card');const buttons=[...card.querySelectorAll('.todo-expanded button')].map(item=>item.innerText.trim());return card.innerText.includes('site-manual 稿件')&&buttons.includes('确认稿件')&&!buttons.some(label=>${JSON.stringify(aiRetryLabels)}.includes(label))})()`));
    await clickText('确认稿件','.todo-card');
    check('approving from the to-do list targets the manual task',actions.some(item=>item.name==='task:approve'&&item.payload?.id==='task-manual'));
    await clickText('查看网站','.todo-card');
    await waitFor(`${taskCardText}?.querySelector('.task-actions')`);
    check('manual TaskCard offers approval and no AI retry',await evaluate(`(()=>{const labels=${taskActionTexts};return document.body.innerText.includes('manual.example')&&labels.includes('已核对稿件，继续发布')&&!labels.some(label=>${JSON.stringify(aiRetryLabels)}.includes(label))&&${taskCardText}.querySelector('.article-review-status')?.textContent.includes('请核对稿件并确认，确认前不会发布。')})()`));

    await clickNav('网站');
    await clickSite('auto.example');
    await clickSiteTab('排期');
    await waitFor(`!!${taskCardText}`);
    check('AI site task remains scheduled system work',await evaluate(`(()=>{const card=${taskCardText};return card.querySelector('.badge')?.innerText.trim()==='进行中'&&!card.innerText.includes('要你处理')})()`));
    await evaluate(`${taskCardText}.querySelector('.task-summary').click()`);
    await waitFor(`${taskCardText}?.querySelector('.task-actions')`);
    check('AI TaskCard leaves the queued review to the system',await evaluate(`(()=>{const card=${taskCardText},labels=${taskActionTexts};return card.querySelector('.task-detail')?.innerText.includes('AI 复核中')&&card.querySelector('.article-review-status')?.textContent.includes('保存的稿件将经过 AI 复核；通过后才继续发布。')&&!labels.includes('已核对稿件，继续发布')&&!labels.some(label=>${JSON.stringify(aiRetryLabels)}.includes(label))})()`));

    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1050,height:720},checks,actions},null,2));
    console.log(`SITE REVIEW UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
