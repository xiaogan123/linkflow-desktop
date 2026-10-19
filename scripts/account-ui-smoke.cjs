const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-account-ui-'));
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
  const evidence=join(process.cwd(),'.evidence','account-ui-2026-10-03');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));

  const channel=(id,name,automation)=>({
    id,name,domain:`${id}.example`,url:`https://${id}.example`,submitUrl:`https://${id}.example/new`,
    categories:['general'],languages:['zh'],kind:'profile',emailRequired:automation!=='api',accountRequired:true,
    articleRequired:false,free:'yes',freeNote:'隔离 UI fixture',automation,quality:'A',qualityReason:'隔离 UI fixture',
    rulesUrl:`https://${id}.example/rules`,checkedAt:'2026-10-03',notes:'',allowedHosts:[`${id}.example`],enabled:true,
  });
  const now='2026-10-03T00:00:00.000Z';
  const state={
    sites:[{id:'site-1',domain:'owner.example',url:'https://owner.example',email:'owner@owner.example',publicEmail:'owner@owner.example',name:'Owner',description:'隔离 UI 测试网站',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now}],
    tasks:[],
    channels:[
      channel('github-gist','GitHub Gist','api'),
      channel('telegraph','Telegraph','api'),
      channel('shiply','Shiply.now','api'),
      channel('product-hunt','Product Hunt','browser'),
      channel('github','GitHub','browser'),
    ],
    accounts:[
      {id:'telegraph-api',channelId:'telegraph',email:'owner@owner.example',username:'telegraph-author',mailboxId:'mailbox-1',createdAt:now,status:'registered',hasPassword:true,credentialKind:'api_token',source:'generated'},
      {id:'gist-api',channelId:'github-gist',email:'',username:'gist-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'},
      {id:'github-password',channelId:'github',email:'login@example.com',username:'github-user',mailboxId:'mailbox-1',createdAt:now,status:'registered',hasPassword:true,credentialKind:'password',source:'imported'},
      {id:'shiply-pending',channelId:'shiply',email:'owner@owner.example',username:'shiply-owner',createdAt:now,updatedAt:'2026-10-03T00:20:00.001Z',status:'needs_verification',hasPassword:false,credentialKind:'api_token',source:'generated',shiply:{version:1,emailHash:'2c595b7ddd8d967fcf46f63af51c81f6181fe0efd4fdc236f2a45696b2edeaf0',previousRequestedAt:now,requestedAt:'2026-10-03T00:20:00.001Z',stage:'code_sent'}},
    ],
    mailboxes:[{id:'mailbox-1',label:'主收件箱',host:'imap.example.com',port:993,user:'inbox@example.com',secure:true,hasPassword:true,aliases:[],createdAt:now,updatedAt:now}],
    accountBindings:[{id:'binding-telegraph',siteId:'site-1',channelId:'telegraph',accountId:'telegraph-api',createdAt:now,updatedAt:now}],
    events:[],
    settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'imap.example.com',port:993,user:'inbox@example.com',secure:true,hasPassword:true}},
    runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'win32-x64',dataPath:dir,aiCallsToday:0},
  };
  const storedCredentials={
    'telegraph-api':'telegraph-token-original',
    'gist-api':'gist-token-original',
    'github-password':'github-password-original',
  };
  const actions=[];
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const replaceBindings=payload=>{
    const account=state.accounts.find(item=>item.id===payload.accountId);
    if(!account)throw new Error('fixture account missing');
    account.mailboxId=payload.mailboxId??undefined;
    state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==payload.accountId);
    for(const siteId of payload.siteIds){
      state.accountBindings.push({id:`binding-${payload.accountId}-${siteId}`,siteId,channelId:account.channelId,accountId:account.id,createdAt:now,updatedAt:now});
    }
  };
  ipcMain.handle('fixture',(_event,name,payload)=>{
    if(name==='snapshot')return clone(state);
    // The renderer acknowledges its first snapshot once; main answers true.
    if(name==='app:ready')return true;
    if(name==='app:update-status')return {phase:'idle',currentVersion:'1.2.29'};
    actions.push({name,payload:clone(payload)});
    if(name==='account:resend-shiply-code'){
      const account=state.accounts.find(item=>item.id===payload.accountId&&item.channelId==='shiply');
      if(!account?.shiply)throw new Error('fixture Shiply identity missing');
      const requestedAt=new Date().toISOString();
      account.shiply={...account.shiply,previousRequestedAt:account.shiply.requestedAt,requestedAt,stage:'code_sent'};
      account.updatedAt=requestedAt;
      return clone(account);
    }
    if(name==='account:set-bindings'){
      replaceBindings(payload);
      return {ok:true};
    }
    if(name==='account:save'){
      if(payload.id){
        const account=state.accounts.find(item=>item.id===payload.id);
        if(!account)throw new Error('fixture account missing');
        Object.assign(account,{channelId:payload.channelId,email:payload.email,username:payload.username,mailboxId:payload.mailboxId??undefined});
        replaceBindings({accountId:account.id,mailboxId:payload.mailboxId,siteIds:payload.siteIds});
      }else{
        const id=`imported-${state.accounts.length}`;
        state.accounts.push({id,channelId:payload.channelId,email:payload.email,username:payload.username,mailboxId:payload.mailboxId??undefined,createdAt:now,status:'registered',hasPassword:!!payload.password,credentialKind:'password',source:'imported'});
        replaceBindings({accountId:id,mailboxId:payload.mailboxId,siteIds:payload.siteIds});
      }
      return {ok:true};
    }
    if(name==='account:reveal')return {password:storedCredentials[payload.id]};
    return {ok:true};
  });

  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(40)}throw new Error(`UI readiness deadline: ${source}`)};
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,`button: ${text}`);await delay(100)};
  const clickLabel=async label=>{const clicked=await evaluate(`(()=>{const button=document.querySelector('button[aria-label=${JSON.stringify(label)}]');if(!button||button.disabled)return false;button.click();return true})()`);assert(clicked,`button label: ${label}`);await delay(100)};
  const setInput=async(selector,value)=>{const changed=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);assert(changed,`input: ${selector}`);await delay(40)};
  const setSelect=async(selector,value)=>{const changed=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);assert(changed,`select: ${selector}`);await delay(40)};
  const capture=async name=>{const image=await win.capturePage();writeFileSync(join(evidence,name),image.toPNG())};

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1180,height:760,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("owner.example")');
    await clickText('平台与账号');
    await waitFor('!!document.querySelector("[role=group][aria-label=\\"平台与账号\\"] button[aria-pressed]")');
    await clickText('我的账号');
    await waitFor('document.body.innerText.includes("telegraph-author")');
    check('account management is the 我的账号 tab of the 平台与账号 page',await evaluate(`(()=>{const nav=document.querySelector('button.nav-item[aria-current=page]'),tabs=[...document.querySelectorAll('[role=group][aria-label="平台与账号"] button')];return nav?.innerText.trim()==='平台与账号'&&tabs.find(item=>item.innerText.trim()==='我的账号')?.getAttribute('aria-pressed')==='true'&&tabs.find(item=>item.innerText.trim()==='平台')?.getAttribute('aria-pressed')==='false'})()`));

    // The always-visible connection summary moved into the guided "连接账号" drawer: Telegraph is explained there.
    check('accounts tab offers the guided account entry',await evaluate(`[...document.querySelectorAll('button')].some(button=>button.innerText.trim()==='连接账号'&&!button.disabled)`));
    await clickText('连接账号');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="添加或连接账号"');
    const telegraphOption=await evaluate(`(()=>{const option=[...document.querySelectorAll('[role=dialog] [role=listbox] [role=option]')].find(item=>item.querySelector('strong')?.textContent==='Telegraph');if(!option)return null;option.click();return option.querySelector('small')?.textContent??''})()`);
    check('guided entry lists Telegraph as prepared automatically by tasks',typeof telegraphOption==='string'&&telegraphOption.includes('任务自动准备'));
    await waitFor('!!document.querySelector("[role=dialog] .platform-selection")');
    check('guided entry explains automatic Telegraph accounts and offers no connect action',await evaluate(`(()=>{const section=document.querySelector('[role=dialog] .platform-selection');return section?.querySelector('h3')?.textContent==='Telegraph'&&section.textContent.includes('任务自动准备')&&section.textContent.includes('任务需要时自动建立发布账号')&&section.textContent.includes('无需导入账号')&&section.querySelectorAll('button').length===0})()`));
    await evaluate(`document.querySelector('[role=dialog][aria-label="添加或连接账号"] button[aria-label="关闭"]').click()`);
    await waitFor('!document.querySelector("[role=dialog]")');
    check('Telegraph API identity is identified as task-created',await evaluate(`[...document.querySelectorAll('.accounts-table tbody tr')].some(row=>row.textContent.includes('telegraph-author')&&row.textContent.includes('任务自动创建的 API 发布账号'))`));
    check('API identities never expose the password reveal action',await evaluate('!document.querySelector("button[aria-label=\\"查看 telegraph-author 的密码\\"]")&&!document.querySelector("button[aria-label=\\"查看 gist-owner 的密码\\"]")'));
    check('ordinary password account keeps its reveal action',await evaluate('!!document.querySelector("button[aria-label=\\"查看 github-user 的密码\\"]")'));

    await clickLabel('查看 shiply-owner 的 Shiply 发布账号');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="连接 Shiply.now 邮箱发布账号"');
    check('an expired later Shiply code exposes another explicit same-identity renewal',await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]'),button=[...dialog.querySelectorAll('button')].find(item=>item.innerText.trim()==='为原发布账号请求新验证码');return dialog.innerText.includes('当前验证码已明确过期；可为同一发布账号手动请求新验证码。')&&!!button&&!button.disabled})()`));
    await clickText('为原发布账号请求新验证码');
    const shiplyRenewal=actions.findLast(item=>item.name==='account:resend-shiply-code');
    check('Shiply renewal sends only the existing account id',shiplyRenewal?.payload.accountId==='shiply-pending'&&Object.keys(shiplyRenewal.payload).join(',')==='accountId');
    check('the fresh Shiply code hides another renewal until it expires',await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');return ![...dialog.querySelectorAll('button')].some(item=>item.innerText.trim()==='为原发布账号请求新验证码')&&!dialog.innerText.includes('当前验证码已明确过期')})()`));
    await clickText('关闭');

    await clickText('连接账号');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="添加或连接账号"');
    await clickText('导入普通账号');
    await waitFor('!!document.querySelector("[role=dialog] select")');
    const initial=await evaluate(`(()=>{const select=document.querySelector('[role=dialog] select');return {value:select.value,label:select.selectedOptions[0]?.textContent,options:[...select.options].map(option=>({value:option.value,label:option.textContent}))}})()`);
    check('ordinary import requires an explicit platform choice',initial.value===''&&initial.label==='先选择平台');
    check('import list excludes Gist and Telegraph API identities',initial.options.map(option=>option.value).join(',')===',product-hunt,github');
    await setSelect('[role=dialog] select','github');
    await clickText('取消');
    await clickText('连接账号');
    await clickText('导入普通账号');
    const reopened=await evaluate(`(()=>{const select=document.querySelector('[role=dialog] select');return {value:select.value,label:select.selectedOptions[0]?.textContent}})()`);
    check('cancel and reopen resets to no selected platform',reopened.value===''&&reopened.label==='先选择平台');
    check('import dialog redirects dedicated connection types to the account guide',await evaluate('document.querySelector("[role=dialog]").innerText.includes("API、OAuth、SSH 或只读平台")'));
    await setSelect('[role=dialog] select','product-hunt');
    await setInput('[role=dialog] input[type=email]','new@example.com');
    await setInput('[role=dialog] .form-grid input:not([type=email])','new-user');
    await setInput('[role=dialog] input[type=password]','new-password');
    await clickText('保存账号');
    await waitFor('!document.querySelector("[role=dialog]")');
    const imported=actions.find(item=>item.name==='account:save'&&!item.payload.id);
    check('submitted channel matches the explicit selection',imported?.payload.channelId==='product-hunt');

    const telegraphCredentialBefore=storedCredentials['telegraph-api'];
    const telegraphBefore=clone(state.accounts.find(item=>item.id==='telegraph-api'));
    const telegraphSaveCount=actions.filter(item=>item.name==='account:save'&&item.payload.id==='telegraph-api').length;
    await clickLabel('用于 telegraph-author');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="编辑发布账号设置"');
    const telegraphDialog=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');return {text:dialog.innerText,passwords:dialog.querySelectorAll('input[type=password]').length,emails:dialog.querySelectorAll('input[type=email]').length,channelOptions:[...dialog.querySelectorAll('option')].map(option=>option.value)}})()`);
    check('Telegraph edit is binding-only with no password or login fields',telegraphDialog.passwords===0&&telegraphDialog.emails===0&&telegraphDialog.text.includes('此处只管理网站与收件箱关联')&&telegraphDialog.text.includes('不会覆盖已保存的密钥')&&telegraphDialog.text.includes('保存关联不代表平台当前可发布'));
    check('Telegraph binding dialog has no account channel choices',!telegraphDialog.channelOptions.includes('telegraph')&&!telegraphDialog.channelOptions.includes('product-hunt'));
    await clickText('保存关联');
    await waitFor('!document.querySelector("[role=dialog]")');
    const telegraphBinding=actions.findLast(item=>item.name==='account:set-bindings'&&item.payload.accountId==='telegraph-api');
    const telegraphAfter=state.accounts.find(item=>item.id==='telegraph-api');
    check('Telegraph submission uses only the binding command',!!telegraphBinding&&actions.filter(item=>item.name==='account:save'&&item.payload.id==='telegraph-api').length===telegraphSaveCount);
    check('Telegraph binding payload contains no credential or login fields',!['password','token','channelId','email','username'].some(key=>Object.prototype.hasOwnProperty.call(telegraphBinding.payload,key)));
    check('stored Telegraph API credential and identity remain unchanged',storedCredentials['telegraph-api']===telegraphCredentialBefore&&telegraphAfter.credentialKind===telegraphBefore.credentialKind&&telegraphAfter.username===telegraphBefore.username&&telegraphAfter.channelId===telegraphBefore.channelId);

    await clickLabel('更新 gist-owner');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="更新 GitHub Gist 发布账号"');
    check('Gist retains its dedicated token connection flow',await evaluate('document.querySelector("[role=dialog]").innerText.includes("Gists 读写令牌")&&document.querySelector("[role=dialog] input[type=password]")!==null'));
    await clickText('取消');

    const normalCredentialBefore=storedCredentials['github-password'];
    await clickLabel('更新 github-user');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="编辑账号与关联"');
    const normalDialog=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');const channel=dialog.querySelector('select');return {channel:channel?.value,email:dialog.querySelector('input[type=email]')?.value,hasPassword:!!dialog.querySelector('input[type=password]')}})()`);
    check('ordinary password account keeps editable login fields',normalDialog.channel==='github'&&normalDialog.email==='login@example.com'&&normalDialog.hasPassword);
    await clickText('保存账号');
    await waitFor('!document.querySelector("[role=dialog]")');
    const normalSave=actions.findLast(item=>item.name==='account:save'&&item.payload.id==='github-password');
    check('ordinary account still submits through account save',normalSave?.payload.channelId==='github'&&normalSave.payload.email==='login@example.com');
    check('blank password preserves the ordinary saved credential',!Object.prototype.hasOwnProperty.call(normalSave.payload,'password')&&storedCredentials['github-password']===normalCredentialBefore);

    await capture('accounts.png');
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,viewport:{width:1180,height:760},checks,actions},null,2));
    console.log(`ACCOUNT UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks,actions},null,2));
    console.error(error);
    app.exit(1);
  }});
}
