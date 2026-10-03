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
  const clone=value=>JSON.parse(JSON.stringify(value));
  ipcMain.handle('fixture',(_event,name,payload)=>{
    if(name==='snapshot')return clone(state);
    if(name==='site:add'){
      actions.push({name,payload:clone(payload)});
      state.sites.push(site(`created-${state.sites.length}`,payload.domain,payload.articleReviewMode));
      state.sites.at(-1).email=payload.email;
      state.sites.at(-1).publicEmail=payload.email;
      state.sites.at(-1).monthlyTarget=payload.monthlyTarget;
      return {ok:true};
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
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text}`);await delay(100)};
  const clickSite=async domain=>{const clicked=await evaluate(`(()=>{const target=[...document.querySelectorAll('.site-name')].find(item=>item.innerText.includes(${JSON.stringify(domain)}));if(!target)return false;target.click();return true})()`);assert(clicked,`site: ${domain}`);await delay(100)};
  const clickTask=async domain=>{const clicked=await evaluate(`(()=>{const target=[...document.querySelectorAll('.work-identity')].find(item=>item.innerText.includes(${JSON.stringify(domain)}));if(!target)return false;target.click();return true})()`);assert(clicked,`task: ${domain}`);await delay(100)};
  const setValue=async(selector,value)=>{const changed=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);assert(changed,`input: ${selector}`);await delay(50)};
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};
  const checkDialogLayout=async saveText=>{
    const result=await evaluate(`(()=>{const dialog=document.querySelector('.dialog');const button=[...dialog.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(saveText)});dialog.scrollTop=dialog.scrollHeight;const rect=button.getBoundingClientRect();return {dialogHorizontal:dialog.scrollWidth<=dialog.clientWidth+1,pageHorizontal:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1,saveVisible:rect.top>=0&&rect.bottom<=innerHeight}})()`);
    check(`${saveText} remains reachable at 1050x720`,result.dialogHorizontal&&result.pageHorizontal&&result.saveVisible);
  };

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1050,height:720,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("manual.example")');

    await clickText('添加网站');
    check('new site defaults to current global AI mode',await evaluate('document.querySelector("input[name=add-site-review-mode][value=ai]")?.checked===true'));
    check('add dialog gives two clear clickable modes',await evaluate('document.querySelectorAll("input[name=add-site-review-mode]").length===2&&document.body.innerText.includes("无需逐篇人工确认")&&document.body.innerText.includes("人工审核")'));
    await evaluate('document.querySelector(".site-review-mode").scrollIntoView({block:"center"})');
    await capture('add-site-review-mode.png');
    await checkDialogLayout('分析并开始');
    await setValue('input[placeholder="example.com"]','created.example');
    await setValue('input[placeholder="hello@example.com"]','owner@created.example');
    await clickText('分析并开始');
    await waitFor('!document.querySelector("[role=dialog]")');
    const add=actions.find(item=>item.name==='site:add');
    check('new site sends an explicit AI mode payload',add?.payload.articleReviewMode==='ai'&&add.payload.domain==='created.example');

    const beforeCancel=actions.length;
    await clickText('添加网站');
    await evaluate('document.querySelector("input[name=add-site-review-mode][value=manual]").click()');
    await clickText('取消');
    check('cancel does not mutate publication permission',actions.length===beforeCancel);
    await clickText('添加网站');
    check('reopening add resets the cancelled choice to the global default',await evaluate('document.querySelector("input[name=add-site-review-mode][value=ai]")?.checked===true'));
    await clickText('取消');
    await evaluate('document.querySelector(".banner.success button")?.click()');
    await delay(50);

    await clickSite('legacy.example');
    await clickText('编辑网站');
    check('legacy site edit preselects its effective inherited mode',await evaluate('document.querySelector("input[name=edit-site-review-mode][value=ai]")?.checked===true'));
    check('AI edit explains pending drafts and pause behavior',await evaluate('document.body.innerText.includes("现有待审稿")&&document.body.innerText.includes("暂停时仍会等待恢复")'));
    await evaluate('document.querySelector(".site-review-mode").scrollIntoView({block:"center"})');
    await capture('edit-site-review-mode.png');
    await checkDialogLayout('保存');
    await evaluate('document.querySelector("input[name=edit-site-review-mode][value=manual]").click()');
    await clickText('保存');
    await waitFor('!document.querySelector("[role=dialog]")');
    const edit=actions.findLast(item=>item.name==='site:update'&&item.payload.id==='site-legacy');
    check('edit sends the explicitly switched manual mode',edit?.payload.articleReviewMode==='manual');
    check('site details show the current effective mode',await evaluate('document.body.innerText.includes("人工审核 · 逐篇确认")'));

    await clickText('任务');
    await clickText('需你处理');
    await waitFor('document.querySelectorAll(".work-identity").length===1');
    await clickTask('manual.example');
    check('manual site task exposes only the human review route',await evaluate('document.body.innerText.includes("稿件待人工审核")&&document.body.innerText.includes("查看并人工审核")&&!document.body.innerText.includes("重新 AI 核对")'));
    await clickText('查看并人工审核');
    check('manual TaskCard offers approval and no AI retry',await evaluate('[...document.querySelectorAll(".task-actions button")].some(item=>item.innerText.includes("已核对稿件，继续发布"))&&![...document.querySelectorAll(".task-actions button")].some(item=>item.innerText.includes("重新 AI 核对"))'));

    await clickText('任务');
    await waitFor('document.querySelectorAll(".work-identity").length===1');
    await clickTask('auto.example');
    check('AI site task remains scheduled system work',await evaluate('document.body.innerText.includes("等待 AI 审核")&&document.body.innerText.includes("查看 AI 审核详情")&&!document.body.innerText.includes("重新 AI 核对")'));
    await clickText('查看 AI 审核详情');
    check('AI TaskCard leaves the queued review to the system',await evaluate('![...document.querySelectorAll(".task-actions button")].some(item=>item.innerText.includes("重新 AI 核对")||item.innerText.includes("已核对稿件，继续发布"))'));

    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1050,height:720},checks,actions},null,2));
    console.log(`SITE REVIEW UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
