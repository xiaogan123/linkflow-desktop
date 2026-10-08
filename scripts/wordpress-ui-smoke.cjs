const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-wordpress-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};

          const now='2026-10-08T00:00:00.000Z';
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          const site=(id,domain)=>({id,domain,url:'https://'+domain,email:'owner@'+domain,name:domain,description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now});
          const wordpress={id:'wordpress-com',name:'WordPress.com',domain:'wordpress.com',url:'https://wordpress.com/',submitUrl:'https://wordpress.com/start/',categories:['content'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'conditional',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',rulesUrl:'https://wordpress.com/support/user-guidelines/',checkedAt:now,notes:'fixture',allowedHosts:['wordpress.com'],enabled:false};
          const base={sites:[site('site-1','one.example'),site('site-2','two.example')],tasks:[],channels:[wordpress],accounts:[],accountBindings:[],mailboxes:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0}};
          let configured=false;
          let lateAuthorize=false;
          const actions=[];
          const blogs=[{id:'1001',url:'https://research-notes.wordpress.com/',name:'Research Notes'},{id:'2002',url:'https://field-notes.wordpress.com/',name:'Field Notes'}];

          function Harness(){
            const [data,setData]=useState(base);
            const [pending,setPending]=useState(false);
            const action=async(command,payload)=>{
              actions.push({command,payload});
              setPending(true);
              try{
                if(command==='account:wordpress-status'){
                  await pause(20);
                  return {configured,callback:'http://127.0.0.1:43129/oauth/wordpress/callback'};
                }
                if(command==='account:authorize-wordpress'){
                  await pause(lateAuthorize?230:100);
                  return {sessionId:lateAuthorize?'late-session':'session-'+actions.filter(item=>item.command==='account:authorize-wordpress').length,blogs,expiresAt:'2026-10-08T01:00:00.000Z'};
                }
                if(command==='account:cancel-wordpress'){
                  await pause(10);
                  return 'cancelled';
                }
                if(command==='account:connect-wordpress'){
                  await pause(80);
                  const blog=blogs.find(item=>item.id===payload.blogId);
                  const account={id:payload.accountId??'wordpress-fixture-account',channelId:'wordpress-com',email:'',username:blog.id,displayName:blog.name,publicationUrl:blog.url,credentialKind:'oauth',status:'registered',hasPassword:true,source:'imported',createdAt:now};
                  setData(current=>({...current,accounts:[account,...current.accounts.filter(item=>item.id!==account.id)],accountBindings:[...current.accountBindings.filter(item=>item.accountId!==account.id),...payload.siteIds.map(siteId=>({id:'wp-'+siteId,siteId,channelId:'wordpress-com',accountId:account.id,createdAt:now,updatedAt:now}))]}));
                  return account;
                }
                return {ok:true};
              }finally{setPending(false)}
            };
            Object.assign(window,{__wordpressFixture:{actions,setConfigured:value=>{configured=value},setLate:value=>{lateAuthorize=value}}});
            return <AccountsPage data={data} disabled={pending} onImport={()=>{}} onEdit={()=>{}} onDelete={()=>{}} onAction={action} onSetup={()=>{}}/>;
          }
          createRoot(document.getElementById('root')).render(<Harness/>);
        `,
        resolveDir:root,
        loader:'tsx',
      },
      outfile:join(dir,'ui.js'),
      bundle:true,
      platform:'browser',
      jsx:'automatic',
    });
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow}=require('electron');
  const dir=process.argv[2];
  const evidence=join(process.cwd(),'.evidence','channel-batch-2026-10-08','wordpress-ui');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));
  const checks=[];
  const consoleMessages=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{const deadline=Date.now()+8000;while(Date.now()<deadline){if(await evaluate(source))return;await delay(30)}throw Error('UI readiness deadline: '+source)};
  const clickText=async text=>{const ok=await evaluate('(()=>{const text='+JSON.stringify(text)+';const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()===text&&!item.disabled);if(!button)return false;button.click();return true})()');assert(ok,'button: '+text);await delay(25)};
  const clickLabel=async label=>{const ok=await evaluate('(()=>{const label='+JSON.stringify(label)+';const button=[...document.querySelectorAll("button")].find(item=>item.getAttribute("aria-label")===label&&!item.disabled);if(!button)return false;button.click();return true})()');assert(ok,'button label: '+label);await delay(25)};
  const actionCount=command=>evaluate('window.__wordpressFixture.actions.filter(item=>item.command==='+JSON.stringify(command)+').length');

  app.whenReady().then(async()=>{
    try{
      win=new BrowserWindow({width:1260,height:820,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      win.webContents.on('console-message',(_event,...args)=>{const details=args.find(value=>value&&typeof value==='object'&&typeof value.message==='string');const message=details?.message??args.find(value=>typeof value==='string')??'';consoleMessages.push(String(message))});
      await win.loadFile(join(dir,'index.html'));
      await waitFor('document.body.innerText.includes("WordPress.com")');

      check('disabled catalog row remains marked pending acceptance',await evaluate('document.body.innerText.includes("浏览器授权和真实公开发布尚待验收")&&document.body.innerText.includes("待验收启用")'));
      await clickText('查看连接状态');
      await waitFor('document.body.innerText.includes("WordPress.com 浏览器授权待接入验收")');
      check('unconfigured product OAuth disables authorization',await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.includes("待接入验收"));return !!button&&button.disabled})()'));
      check('drawer never asks for or renders a token input',await evaluate('!document.querySelector("[role=dialog] input[type=password]")&&!/access[_ -]?token|client[_ -]?secret/i.test(document.querySelector("[role=dialog]").innerText)'));
      await clickText('取消');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check('closing an unavailable connection clears the main-process session',await actionCount('account:cancel-wordpress')===1);

      await evaluate('window.__wordpressFixture.setConfigured(true)');
      await clickText('查看连接状态');
      await waitFor('[...document.querySelectorAll("button")].some(item=>item.innerText.trim()==="在浏览器授权 WordPress.com"&&!item.disabled)');
      const doubleStarted=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==="在浏览器授权 WordPress.com");button.click();button.click();return true})()');
      check('authorization action is available after product configuration',doubleStarted);
      await waitFor(`document.querySelector('select[aria-label="WordPress.com 博客"]')!==null`);
      check('busy guard collapses a double click into one authorization',await actionCount('account:authorize-wordpress')===1);
      check('authorized response exposes only the two synthetic public blogs',await evaluate(`document.querySelectorAll('select[aria-label="WordPress.com 博客"] option').length===2`));
      const selected=await evaluate(`(()=>{const select=document.querySelector('select[aria-label="WordPress.com 博客"]');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set;setter.call(select,"2002");select.dispatchEvent(new Event("change",{bubbles:true}));const site=document.querySelector('input[aria-label="关联网站 two.example"]');site.click();return select.value==="2002"&&site.checked})()`);
      check('authorized blog and website can be selected explicitly',selected);
      await clickText('连接所选博客');
      await waitFor('document.querySelector("[role=dialog]")===null&&document.body.innerText.includes("Field Notes")');
      const payload=await evaluate('window.__wordpressFixture.actions.find(item=>item.command==="account:connect-wordpress").payload');
      check('connect sends only session, blog and selected site identity',JSON.stringify(payload)===JSON.stringify({sessionId:'session-1',blogId:'2002',siteIds:['site-2']}));
      check('rendered page and IPC payload contain no synthetic credential field',await evaluate('!document.body.innerText.includes("late-session")')&&!Object.keys(payload).some(key=>/token|secret|credential/i.test(key)));

      await clickLabel('管理 Field Notes 的 WordPress.com 连接');
      await waitFor('[...document.querySelectorAll("button")].some(item=>item.innerText.trim()==="重新授权原博客"&&!item.disabled)');
      await clickText('重新授权原博客');
      await waitFor(`document.querySelector('select[aria-label="WordPress.com 博客"]')!==null`);
      check('repair exposes only the original blog and locks the selector',await evaluate(`(()=>{const select=document.querySelector('select[aria-label="WordPress.com 博客"]');return select.disabled&&select.value==="2002"&&select.options.length===1})()`));
      check('repair restores the original website binding',await evaluate(`document.querySelector('input[aria-label="关联网站 two.example"]').checked`));
      await clickText('取消');
      await waitFor('document.querySelector("[role=dialog]")===null');

      await evaluate('window.__wordpressFixture.setLate(true)');
      await clickText('查看连接状态');
      await waitFor('[...document.querySelectorAll("button")].some(item=>item.innerText.trim()==="在浏览器授权 WordPress.com"&&!item.disabled)');
      await clickText('在浏览器授权 WordPress.com');
      await waitFor('[...document.querySelectorAll("button")].some(item=>item.innerText.trim()==="取消授权")');
      await clickText('取消授权');
      await waitFor('document.querySelector("[role=dialog]")===null');
      await delay(280);
      check('cancelled authorization late response cannot reopen or mutate the closed drawer',await evaluate('document.querySelector("[role=dialog]")===null')&&await actionCount('account:cancel-wordpress')===3);
      await clickText('查看连接状态');
      await waitFor('[...document.querySelectorAll("button")].some(item=>item.innerText.trim()==="在浏览器授权 WordPress.com"&&!item.disabled)');
      check('a new drawer does not inherit blogs from the cancelled late response',await evaluate(`document.querySelector('select[aria-label="WordPress.com 博客"]')===null`));
      await clickText('取消');

      const sanitized=await evaluate('window.__wordpressFixture.actions.map(item=>({command:item.command,keys:Object.keys(item.payload??{}).sort(),blogId:item.payload?.blogId,siteIds:item.payload?.siteIds,accountId:item.payload?.accountId}))');
      writeFileSync(join(evidence,'wordpress-ui-result.json'),JSON.stringify({passed:true,checks,actions:sanitized,consoleMessages},null,2));
      console.log('WORDPRESS UI PASSED: '+checks.length+' checks');
      app.quit();
    }catch(error){
      writeFileSync(join(evidence,'wordpress-ui-result.json'),JSON.stringify({passed:false,checks,error:String(error?.stack??error?.message??error),consoleMessages},null,2));
      console.error(error);
      app.exit(1);
    }
  });
}
