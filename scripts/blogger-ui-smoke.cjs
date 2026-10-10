const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-blogger-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};
          const now='2026-10-04T00:00:00.000Z';
          const channel=(id,name)=>({id,name,domain:id+'.example',url:'https://'+id+'.example',submitUrl:'https://'+id+'.example/new',categories:['general'],languages:['zh'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:id==='github'?'browser':'api',quality:'A',qualityReason:'fixture',rulesUrl:'https://'+id+'.example/rules',checkedAt:now,notes:'',allowedHosts:[id+'.example'],enabled:true});
          const initial={
            sites:[
              {id:'site-1',domain:'one.example',url:'https://one.example',email:'owner@one.example',name:'One',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now,blogger:{blogId:'blog-oauth-existing',url:'https://fixture.blogspot.com/'}},
              {id:'site-2',domain:'two.example',url:'https://two.example',email:'owner@two.example',name:'Two',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
            ],
            tasks:[],channels:[channel('blogger','Blogger'),channel('github','GitHub')],
            accounts:[
              {id:'oauth-existing',channelId:'blogger',email:'owner@gmail.com',username:'existing-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'oauth',source:'imported'},
              {id:'oauth-empty',channelId:'blogger',email:'empty@gmail.com',username:'no-blog-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'oauth',source:'imported'},
              {id:'oauth-error',channelId:'blogger',email:'error@gmail.com',username:'retry-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'oauth',source:'imported'},
              {id:'password-account',channelId:'github',email:'login@example.com',username:'password-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'password',source:'imported'},
            ],
            mailboxes:[],accountBindings:[{id:'bind-existing',siteId:'site-1',channelId:'blogger',accountId:'oauth-existing',createdAt:now,updatedAt:now}],events:[],
            settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
            runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
          };
          const actions=[];
          const callbacks={imports:0,edits:0,deletes:0};
          let connectionCancelled=false;
          let connectionSerial=0;
          let errorReads=0;
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          function Harness(){
            const [data,setData]=useState(initial);
            const [pending,setPending]=useState(false);
            const action=async(command,payload)=>{
              actions.push({command,payload:payload===undefined?'__undefined__':payload});
              setPending(true);
              try{
                if(command==='account:connect-blogger'){
                  connectionCancelled=false;
                  const serial=++connectionSerial;
                  await pause(220);
                  if(connectionCancelled)return undefined;
                  const account={id:'oauth-connected-'+serial,channelId:'blogger',email:'connected'+serial+'@gmail.com',username:'connected-google-'+serial,createdAt:now,status:'registered',hasPassword:true,credentialKind:'oauth',source:'imported'};
                  setData(current=>({...current,accounts:[account,...current.accounts]}));
                  return {account,blogs:[{id:'blog-'+account.id,name:'Fixture Blog',url:'https://fixture.blogspot.com/'}]};
                }
                if(command==='account:cancel-blogger'){
                  connectionCancelled=true;
                  return {ok:true};
                }
                if(command==='account:reconnect-blogger'){
                  connectionCancelled=false;
                  await pause(180);
                  if(connectionCancelled)return undefined;
                  const account=data.accounts.find(account=>account.id===payload.accountId);
                  return account?{account,blogs:[{id:'blog-'+account.id,name:'Fixture Blog',url:'https://fixture.blogspot.com/'}]}:undefined;
                }
                if(command==='account:blogger-blogs'){
                  await pause(90);
                  if(payload.accountId==='oauth-empty')return [];
                  if(payload.accountId==='oauth-error'&&errorReads++===0)return undefined;
                  return [{id:'blog-'+payload.accountId,name:'Fixture Blog',url:'https://fixture.blogspot.com/'}];
                }
                if(command==='site:bind-blogger-batch'){
                  await pause(70);
                  setData(current=>({...current,
                    sites:current.sites.map(site=>payload.siteIds.includes(site.id)?{...site,blogger:{blogId:payload.blogId,url:'https://fixture.blogspot.com/'}}:site),
                    accountBindings:[...current.accountBindings.filter(binding=>!(payload.siteIds.includes(binding.siteId)&&binding.channelId==='blogger')),...payload.siteIds.map(siteId=>({id:'binding-'+siteId,siteId,channelId:'blogger',accountId:payload.accountId,createdAt:now,updatedAt:now}))],
                  }));
                  return {ok:true};
                }
                if(command==='account:disconnect-blogger'){
                  await pause(70);
                  setData(current=>({...current,accounts:current.accounts.map(account=>account.id===payload.accountId?{...account,status:'credentials_invalid',hasPassword:false}:account),accountBindings:current.accountBindings.filter(binding=>binding.accountId!==payload.accountId)}));
                  return {ok:true};
                }
                if(command==='external:open')return {ok:true};
                return {ok:true};
              }finally{setPending(false)}
            };
            Object.assign(window,{__bloggerFixture:{actions,callbacks,data}});
            return <AccountsPage data={data} disabled={pending} onImport={()=>callbacks.imports++} onEdit={()=>callbacks.edits++} onDelete={()=>callbacks.deletes++} onAction={action} onSetup={()=>{}}/>;
          }
          createRoot(document.getElementById('root')).render(<Harness/>);
        `,
        resolveDir:root,
        loader:'tsx',
      },
      outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic',
    });
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow}=require('electron');
  const dir=process.argv[2];
  const evidence=join(process.cwd(),'.evidence','blogger-ui-2026-10-04');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));
  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(35)}throw new Error('UI readiness deadline: '+source)};
  const clickText=async text=>{const clicked=await evaluate(`(()=>{const root=document.querySelector('[role=dialog]')??document;const button=[...root.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)}&&!item.disabled);if(!button)return false;button.click();return true})()`);assert(clicked,'button: '+text);await delay(35)};
  const clickLabel=async label=>{const clicked=await evaluate(`(()=>{const root=document.querySelector('[role=dialog]')??document;const button=root.querySelector('button[aria-label=${JSON.stringify(label)}]');if(!button||button.disabled)return false;button.click();return true})()`);assert(clicked,'button label: '+label);await delay(35)};
  const forceSelect=async(label,value)=>{const changed=await evaluate(`(()=>{const root=document.querySelector('[role=dialog]')??document;const element=root.querySelector('select[aria-label=${JSON.stringify(label)}]');if(!element)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);assert(changed,'force select: '+label);await delay(35)};
  const setCheckbox=async(label,checked)=>{const changed=await evaluate(`(()=>{const root=document.querySelector('[role=dialog]')??document;const element=root.querySelector('input[aria-label=${JSON.stringify(label)}]');if(!element||element.disabled)return false;if(element.checked!==${checked})element.click();return element.checked===${checked}})()`);assert(changed,'checkbox: '+label);await delay(35)};
  const actionCount=command=>evaluate(`window.__bloggerFixture.actions.filter(action=>action.command===${JSON.stringify(command)}).length`);
  const openBloggerFromGuide=async()=>{
    await clickText('添加 / 连接账号');
    await waitFor('document.querySelector(\'[role=dialog][aria-label="添加或连接账号"]\')');
    const selected=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog][aria-label="添加或连接账号"]');const option=[...dialog.querySelectorAll('button[role=option]')].find(item=>item.querySelector('strong')?.innerText.trim()==='Blogger');if(!option||option.disabled)return false;option.click();return true})()`);
    assert(selected,'select Blogger in account connection guide');
    await delay(35);
    const action=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog][aria-label="添加或连接账号"]');const button=dialog?.querySelector('.platform-selection button');if(!button||button.disabled)return '';const label=button.innerText.trim();if(!['授权 Blogger','管理或新增连接','处理原连接'].includes(label))return '';button.click();return label})()`);
    assert(action,'activate Blogger from account connection guide');
    await waitFor('document.querySelector(\'[role=dialog][aria-label="连接 Blogger 并绑定博客"]\')');
    await waitFor('(()=>{const button=document.querySelector(\'[role=dialog][aria-label="连接 Blogger 并绑定博客"] .blogger-primary\');return !!button&&!button.disabled})()');
    return action;
  };

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1260,height:800,useContentSize:true,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("existing-owner")');

    check('Blogger OAuth identity is labelled explicitly',await evaluate('document.body.innerText.includes("已连接的 Blogger OAuth 身份")&&document.body.innerText.includes("Google OAuth 身份无需保存密码")'));
    check('OAuth identity has no password reveal or generic account controls',await evaluate('!document.querySelector("button[aria-label=\\"查看 existing-owner 的密码\\"]")&&!document.querySelector("button[aria-label=\\"绑定 existing-owner\\"]")&&!document.querySelector("button[aria-label=\\"更新 existing-owner\\"]")&&!document.querySelector("button[aria-label=\\"移除 existing-owner\\"]")'));
    check('ordinary password identity keeps its existing controls',await evaluate('!!document.querySelector("button[aria-label=\\"查看 password-owner 的密码\\"]")&&!!document.querySelector("button[aria-label=\\"更新 password-owner\\"]")'));

    await openBloggerFromGuide();
    await waitFor('document.querySelector("[role=dialog]")?.innerText.includes("首次连接只需一次配置")');
    check('advanced client import stays collapsed when reusable identities exist',await evaluate('document.querySelector("[role=dialog] details").open===false'));
    const firstGuide=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');return {text:dialog.innerText,passwords:dialog.querySelectorAll('input[type=password]').length}})()`);
    check('connection guide explains one-time desktop config and system browser account selection',firstGuide.text.includes('启用 Blogger API')&&firstGuide.text.includes('桌面应用')&&firstGuide.text.includes('系统浏览器选择 Google 账号'));
    check('connection UI contains no plaintext credential fields or registration claim',firstGuide.passwords===0&&firstGuide.text.includes('不会自动注册账号'));
    await clickText('Google 官方设置步骤');
    const setupAction=await evaluate('window.__bloggerFixture.actions.findLast(action=>action.command==="external:open")');
    check('setup help opens the exact official desktop OAuth guide',setupAction.payload.url==='https://developers.google.com/workspace/guides/create-credentials#desktop-app');
    const openedDetails=await evaluate(`(()=>{const summary=document.querySelector('[role=dialog] details summary');if(!summary)return false;summary.click();return summary.parentElement.open})()`);
    assert(openedDetails,'open desktop client details');
    check('Testing notice is concise and tied to External Testing refresh tokens',await evaluate('document.querySelector("[role=dialog]").innerText.includes("External")&&document.querySelector("[role=dialog]").innerText.includes("Testing")&&document.querySelector("[role=dialog]").innerText.includes("7 天后失效")'));
    writeFileSync(join(evidence,'blogger-connect-drawer.png'),(await win.capturePage()).toPNG());
    const connectedBefore=await actionCount('account:connect-blogger');
    const readsBeforeConnect=await actionCount('account:blogger-blogs');
    const doubleClicked=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.includes('选择桌面客户端 JSON 并连接'));if(!button)return false;button.click();button.click();return true})()`);
    assert(doubleClicked,'double connect click');
    await waitFor('document.body.innerText.includes("等待浏览器授权…")');
    check('connect exposes a truthful loading state',await evaluate('document.body.innerText.includes("关闭本抽屉可取消本次连接")'));
    await waitFor('!!document.querySelector("select[aria-label=\\"Blogger 博客\\"]")');
    check('rapid connect clicks dispatch only once',await actionCount('account:connect-blogger')===connectedBefore+1);
    const connectAction=await evaluate('window.__bloggerFixture.actions.find(action=>action.command==="account:connect-blogger")');
    check('connect command carries no payload',connectAction.payload==='__undefined__');
    check('connect reuses the verified blog list without a second API read',await actionCount('account:blogger-blogs')===readsBeforeConnect);
    check('new identities do not preselect every site',await evaluate('[...document.querySelectorAll("fieldset input[type=checkbox]")].every(input=>!input.checked)'));
    await setCheckbox('绑定网站 two.example',true);
    await clickText('绑定所选网站');
    await waitFor('!document.querySelector("[role=dialog]")');
    const bindAction=await evaluate('window.__bloggerFixture.actions.find(action=>action.command==="site:bind-blogger-batch")');
    check('batch binding submits only explicitly selected sites with one identity and blog',bindAction.payload.siteIds.length===1&&bindAction.payload.siteIds[0]==='site-2'&&bindAction.payload.accountId==='oauth-connected-1'&&bindAction.payload.blogId==='blog-oauth-connected-1');

    const readsBeforeRace=await actionCount('account:blogger-blogs');
    await clickLabel('管理 existing-owner 的 Blogger 绑定');
    check('existing bindings are the only default site selections',await evaluate('document.querySelector("input[aria-label=\\"绑定网站 one.example\\"]").checked&&!document.querySelector("input[aria-label=\\"绑定网站 two.example\\"]").checked'));
    await forceSelect('Blogger 身份','oauth-empty');
    await delay(120);
    check('an out-of-order blog response cannot overwrite a newly selected identity',await evaluate('document.querySelector("select[aria-label=\\"Blogger 身份\\"]").value==="oauth-empty"&&!document.querySelector("select[aria-label=\\"Blogger 博客\\"]")'));
    check('managing an existing identity auto-loads exactly once',await actionCount('account:blogger-blogs')===readsBeforeRace+1);
    await clickText('读取博客列表');
    await waitFor('document.body.innerText.includes("还没有 Blogger 博客")');
    check('empty Blogger identity offers a manual external creation path',await evaluate('document.body.innerText.includes("去 Blogger 创建博客")&&!document.body.innerText.includes("自动创建 Blogger 博客")'));
    await clickText('去 Blogger 创建博客');
    const openAction=await evaluate('window.__bloggerFixture.actions.findLast(action=>action.command==="external:open")');
    check('creation button opens the official Blogger site',openAction.payload.url==='https://www.blogger.com/');
    await clickText('取消');
    await clickLabel('管理 no-blog-owner 的 Blogger 绑定');
    await waitFor('document.body.innerText.includes("还没有 Blogger 博客")');
    await clickText('取消');
    await openBloggerFromGuide();
    check('closing and reopening clears transient blog results',await evaluate('!document.querySelector("[role=dialog]").innerText.includes("还没有 Blogger 博客")'));
    await clickText('取消');

    await clickLabel('管理 retry-owner 的 Blogger 绑定');
    await waitFor('document.querySelector("[role=alert]")?.innerText.includes("暂未读取到博客列表")');
    check('blog loading failure stays recoverable in the drawer',await evaluate('document.querySelector("[role=dialog]")!==null&&document.body.innerText.includes("已有选择不会被提交")'));
    await clickText('读取博客列表');
    await waitFor('!!document.querySelector("select[aria-label=\\"Blogger 博客\\"]")');
    await clickText('取消');

    await clickLabel('管理 existing-owner 的 Blogger 绑定');
    await waitFor('!!document.querySelector("select[aria-label=\\"Blogger 博客\\"]")');
    const reconnectBefore=await actionCount('account:reconnect-blogger');
    const readsBeforeReconnect=await actionCount('account:blogger-blogs');
    await clickText('重新授权此身份');
    await waitFor('document.body.innerText.includes("等待浏览器授权…")');
    await waitFor('!!document.querySelector("select[aria-label=\\"Blogger 博客\\"]")&&!document.body.innerText.includes("等待浏览器授权…")');
    const reconnectAction=await evaluate('window.__bloggerFixture.actions.findLast(action=>action.command==="account:reconnect-blogger")');
    check('reconnect reuses the selected identity without asking for JSON again',await actionCount('account:reconnect-blogger')===reconnectBefore+1&&reconnectAction.payload.accountId==='oauth-existing');
    check('reconnect reuses the verified blog list without a second API read',await actionCount('account:blogger-blogs')===readsBeforeReconnect);
    await clickText('取消');

    await openBloggerFromGuide();
    await evaluate(`document.querySelector('[role=dialog] details summary').click()`);
    await clickText('选择桌面客户端 JSON 并连接');
    await waitFor('document.body.innerText.includes("取消连接")');
    await clickText('取消连接');
    await waitFor('!document.querySelector("[role=dialog]")');
    await delay(260);
    check('closing an active OAuth flow dispatches cancellation and leaves no half-created identity',await actionCount('account:cancel-blogger')===1&&await evaluate('!document.body.innerText.includes("connected-google-2")'));

    await clickLabel('断开 existing-owner 的 Blogger 授权');
    await waitFor('document.querySelector("[role=dialog]")?.innerText.includes("已公开的博客文章不会被删除")');
    const disconnectBefore=await actionCount('account:disconnect-blogger');
    await clickText('取消');
    check('disconnect confirmation can be cancelled without mutation',await actionCount('account:disconnect-blogger')===disconnectBefore&&await evaluate('document.body.innerText.includes("existing-owner")'));
    await clickLabel('断开 existing-owner 的 Blogger 授权');
    const disconnectDouble=await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.innerText.trim()==='确认断开');if(!button)return false;button.click();button.click();return true})()`);
    assert(disconnectDouble,'double disconnect click');
    await waitFor('!document.querySelector("[role=dialog]")');
    check('confirmed disconnect is guarded against duplicate clicks',await actionCount('account:disconnect-blogger')===disconnectBefore+1);
    check('OAuth identities never enter generic edit or delete callbacks',await evaluate('window.__bloggerFixture.callbacks.edits===0&&window.__bloggerFixture.callbacks.deletes===0'));

    const image=await win.capturePage();
    writeFileSync(join(evidence,'accounts-blogger.png'),image.toPNG());
    const actions=await evaluate('window.__bloggerFixture.actions');
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:true,checks,actions},null,2));
    console.log('BLOGGER UI PASSED: '+checks.length+' checks');
    app.exit(0);
  }catch(error){
    writeFileSync(join(evidence,'result.json'),JSON.stringify({passed:false,error:String(error),checks},null,2));
    console.error(error);
    app.exit(1);
  }});
}
