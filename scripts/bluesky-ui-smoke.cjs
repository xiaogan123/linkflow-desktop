const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-bluesky-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};

          const now='2026-10-06T00:00:00.000Z';
          const existingAccountId='10101010-1010-4010-8010-101010101010';
          const newAccountId='20202020-2020-4020-8020-202020202020';
          const stableDid='did:plc:stablefixtureidentity';
          const newDid='did:plc:newfixtureidentity';
          const channel=(id,name,automation)=>({
            id,name,domain:id+'.example',url:'https://'+id+'.example',
            submitUrl:'https://'+id+'.example/new',categories:['general'],
            languages:['zh'],kind:'article',emailRequired:false,accountRequired:true,
            articleRequired:true,free:'yes',freeNote:'fixture',automation,
            quality:'A',qualityReason:'fixture',rulesUrl:'https://'+id+'.example/rules',
            checkedAt:now,notes:'',allowedHosts:[id+'.example'],enabled:true,
          });
          const existingAccount={
            id:existingAccountId,channelId:'bluesky',email:'',
            username:stableDid,displayName:'@author.bsky.social',
            mailboxId:'mailbox-existing',createdAt:now,status:'registered',
            hasPassword:true,credentialKind:'api_token',source:'imported',
          };
          const initial={
            sites:[
              {id:'site-1',domain:'one.example',url:'https://one.example',email:'owner@one.example',name:'One',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
              {id:'site-2',domain:'two.example',url:'https://two.example',email:'owner@two.example',name:'Two',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
              {id:'site-3',domain:'three.example',url:'https://three.example',email:'owner@three.example',name:'Three',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'paused',createdAt:now},
            ],
            tasks:[],
            channels:[channel('bluesky','Bluesky','api'),channel('github','GitHub','browser')],
            accounts:[
              existingAccount,
              {id:'30303030-3030-4030-8030-303030303030',channelId:'github',email:'login@example.com',username:'password-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'password',source:'imported'},
            ],
            mailboxes:[{id:'mailbox-existing',label:'Existing mailbox',user:'owner@example.com'}],
            accountBindings:[{id:'binding-existing',siteId:'site-1',channelId:'bluesky',accountId:existingAccountId,createdAt:now,updatedAt:now}],
            events:[],
            settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
            runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
          };
          const actions=[];
          const returnedAccounts=[];
          const callbacks={imports:0,edits:0,deletes:0};
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

          function Harness(){
            const [data,setData]=useState(initial);
            const [pending,setPending]=useState(false);
            const action=async(command,payload)=>{
              actions.push({command,payload:payload===undefined?'__undefined__':payload});
              setPending(true);
              try{
                if(command==='account:connect-bluesky'){
                  await pause(100);
                  if(payload.handle==='failure.bsky.social')return undefined;
                  const prior=payload.accountId===existingAccountId?existingAccount:undefined;
                  const account={
                    ...(prior??{}),
                    id:prior?.id??newAccountId,
                    channelId:'bluesky',
                    email:'',
                    username:prior?.username??newDid,
                    displayName:'@'+payload.handle,
                    mailboxId:prior?.mailboxId,
                    createdAt:prior?.createdAt??now,
                    status:'registered',
                    hasPassword:true,
                    credentialKind:'api_token',
                    source:'imported',
                  };
                  returnedAccounts.push(account);
                  setData(current=>({
                    ...current,
                    accounts:[account,...current.accounts.filter(item=>item.id!==account.id)],
                  }));
                  return account;
                }
                if(command==='account:set-bindings'){
                  await pause(70);
                  setData(current=>({
                    ...current,
                    accounts:current.accounts.map(item=>item.id===payload.accountId?{...item,mailboxId:payload.mailboxId??undefined}:item),
                    accountBindings:[
                      ...current.accountBindings.filter(binding=>binding.accountId!==payload.accountId),
                      ...payload.siteIds.map(siteId=>({
                        id:'binding-'+payload.accountId+'-'+siteId,
                        siteId,channelId:'bluesky',accountId:payload.accountId,
                        createdAt:now,updatedAt:now,
                      })),
                    ],
                  }));
                  return {ok:true};
                }
                if(command==='external:open')return {ok:true};
                return {ok:true};
              }finally{
                setPending(false);
              }
            };
            Object.assign(window,{__blueskyFixture:{actions,returnedAccounts,callbacks,data}});
            return <AccountsPage
              data={data}
              disabled={pending}
              onImport={()=>callbacks.imports++}
              onEdit={()=>callbacks.edits++}
              onDelete={()=>callbacks.deletes++}
              onAction={action}
              onSetup={()=>{}}
            />;
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
    writeFileSync(
      join(dir,'index.html'),
      '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    const child=require('node:child_process').spawn(
      require('electron'),
      [__filename,dir],
      {stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}},
    );
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{
      clearTimeout(deadline);
      process.exitCode=code??1;
    });
  })().catch(error=>{
    console.error(error);
    process.exitCode=1;
  });
}else{
  const {app,BrowserWindow}=require('electron');
  const dir=process.argv[2];
  const evidence=join(process.cwd(),'.evidence','bluesky-ui-2026-10-06');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));

  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{
    assert(condition,label);
    checks.push(label);
  };
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      if(await evaluate(source))return;
      await delay(35);
    }
    throw new Error('UI readiness deadline: '+source);
  };
  const clickText=async text=>{
    const source='(()=>{const target='+JSON.stringify(text)+';const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()===target&&!item.disabled);if(!button)return false;button.click();return true})()';
    assert(await evaluate(source),'button: '+text);
    await delay(35);
  };
  const clickLabel=async label=>{
    const source='(()=>{const target='+JSON.stringify(label)+';const button=[...document.querySelectorAll("button")].find(item=>item.getAttribute("aria-label")===target&&!item.disabled);if(!button)return false;button.click();return true})()';
    assert(await evaluate(source),'button label: '+label);
    await delay(35);
  };
  const buttonInfo=label=>evaluate(
    '(()=>{const target='+JSON.stringify(label)+';const button=[...document.querySelectorAll("button")].find(item=>item.getAttribute("aria-label")===target);return button?{exists:true,disabled:button.disabled}:{exists:false,disabled:true}})()',
  );
  const inputInfo=label=>evaluate(
    '(()=>{const target='+JSON.stringify(label)+';const input=[...document.querySelectorAll("input")].find(item=>item.getAttribute("aria-label")===target);return input?{exists:true,value:input.value,type:input.type,autocomplete:input.autocomplete,disabled:input.disabled}:{exists:false}})()',
  );
  const setInput=async(label,value)=>{
    const source='(()=>{const target='+JSON.stringify(label)+';const input=[...document.querySelectorAll("input")].find(item=>item.getAttribute("aria-label")===target);if(!input||input.disabled)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;setter.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));return input.value==='+JSON.stringify(value)+'})()';
    assert(await evaluate(source),'input: '+label);
    await delay(35);
  };
  const siteStates=()=>evaluate(
    '[...document.querySelectorAll(".site-binding-option")].map(label=>({domain:label.innerText.trim(),checked:label.querySelector("input").checked,disabled:label.querySelector("input").disabled}))',
  );
  const setSite=async(domain,checked)=>{
    const source='(()=>{const target='+JSON.stringify(domain)+';const label=[...document.querySelectorAll(".site-binding-option")].find(item=>item.innerText.trim()===target);const input=label?.querySelector("input");if(!input||input.disabled)return false;if(input.checked!=='+JSON.stringify(checked)+')input.click();return input.checked==='+JSON.stringify(checked)+'})()';
    assert(await evaluate(source),'site checkbox: '+domain);
    await delay(35);
  };
  const actionCount=command=>evaluate(
    'window.__blueskyFixture.actions.filter(action=>action.command==='+JSON.stringify(command)+').length',
  );

  app.whenReady().then(async()=>{
    try{
      win=new BrowserWindow({
        width:1260,
        height:800,
        useContentSize:true,
        show:false,
        webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true},
      });
      await win.loadFile(join(dir,'index.html'));
      await waitFor('document.body.innerText.includes("author.bsky.social")');

      check(
        'stable Bluesky DID is not rendered in the account list',
        await evaluate('!document.body.innerText.includes("did:plc:stablefixtureidentity")'),
      );
      const blueskyReveal=await buttonInfo('查看 @author.bsky.social 的密码');
      const ordinaryReveal=await buttonInfo('查看 password-owner 的密码');
      check('Bluesky API identity has no generic password reveal',!blueskyReveal.exists);
      check('ordinary password identity keeps its password reveal',ordinaryReveal.exists);

      await clickText('连接 Bluesky');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      const blankSubmit=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==="验证并连接");return !!button&&button.disabled})()');
      check('new connection submit is disabled while required fields are empty',blankSubmit);
      const passwordField=await inputInfo('Bluesky 应用专用密码');
      check(
        'Bluesky uses a dedicated non-prefilled password field',
        passwordField.exists&&passwordField.type==='password'&&passwordField.autocomplete==='new-password'&&passwordField.value==='',
      );
      let sites=await siteStates();
      check(
        'new identity does not select any site by default',
        sites.length===3&&sites.every(site=>!site.checked),
      );
      await clickText('打开应用密码设置');
      check(
        'app-password help opens the exact official settings page',
        await evaluate('window.__blueskyFixture.actions.findLast(action=>action.command==="external:open")?.payload?.url==="https://bsky.app/settings/app-passwords"'),
      );
      writeFileSync(join(evidence,'bluesky-empty-drawer.png'),(await win.capturePage()).toPNG());

      const failurePassword='fixture-password-local-failure';
      await setInput('Bluesky 账号名称','failure.bsky.social');
      await setInput('Bluesky 应用专用密码',failurePassword);
      check(
        'typed app password is never displayed as page text',
        await evaluate('!document.body.innerText.includes("fixture-password-local-failure")'),
      );
      const connectsBeforeFailure=await actionCount('account:connect-bluesky');
      const doubleClicked=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==="验证并连接");if(!button||button.disabled)return false;button.click();button.click();return true})()');
      assert(doubleClicked,'double failure submit');
      await waitFor('document.querySelector("[role=alert]")?.innerText.includes("连接未完成")');
      check(
        'rapid failure submits dispatch only once',
        await actionCount('account:connect-bluesky')===connectsBeforeFailure+1,
      );
      check(
        'local connection failure does not bind sites',
        await actionCount('account:set-bindings')===0,
      );
      const clearedAfterFailure=await inputInfo('Bluesky 应用专用密码');
      check(
        'app password is cleared after local connection failure',
        clearedAfterFailure.value===''&&!await evaluate('document.documentElement.innerHTML.includes("fixture-password-local-failure")'),
      );
      check(
        'failed connection returns no account metadata',
        await evaluate('window.__blueskyFixture.returnedAccounts.length===0'),
      );

      const successPassword='fixture-password-new-success';
      await setInput('Bluesky 账号名称','fresh.bsky.social');
      await setInput('Bluesky 应用专用密码',successPassword);
      await setSite('two.example',true);
      await setSite('three.example',true);
      sites=await siteStates();
      check(
        'only explicitly checked sites are selected before connect',
        sites.find(site=>site.domain==='one.example')?.checked===false&&
          sites.find(site=>site.domain==='two.example')?.checked===true&&
          sites.find(site=>site.domain==='three.example')?.checked===true,
      );
      await clickText('验证并连接');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check(
        'new identity connect payload contains only the expected fields',
        await evaluate('(()=>{const action=window.__blueskyFixture.actions.find(item=>item.command==="account:connect-bluesky"&&item.payload.handle==="fresh.bsky.social");return !!action&&Object.keys(action.payload).sort().join(",")==="accountId,appPassword,handle"&&action.payload.accountId===undefined&&action.payload.appPassword==="fixture-password-new-success"})()'),
      );
      check(
        'multi-site binding submits the explicit sites and null mailbox',
        await evaluate('(()=>{const action=window.__blueskyFixture.actions.find(item=>item.command==="account:set-bindings"&&item.payload.accountId==="20202020-2020-4020-8020-202020202020");return !!action&&Object.keys(action.payload).sort().join(",")==="accountId,mailboxId,siteIds"&&action.payload.mailboxId===null&&action.payload.siteIds.join(",")==="site-2,site-3"})()'),
      );
      check(
        'new connection returns metadata without plaintext secrets',
        await evaluate('(()=>{const account=window.__blueskyFixture.returnedAccounts.find(item=>item.id==="20202020-2020-4020-8020-202020202020");return !!account&&!Object.prototype.hasOwnProperty.call(account,"password")&&!Object.prototype.hasOwnProperty.call(account,"appPassword")&&!Object.prototype.hasOwnProperty.call(account,"secret")})()'),
      );
      check(
        'new DID and submitted password are absent after the drawer closes',
        await evaluate('!document.body.innerText.includes("did:plc:newfixtureidentity")&&!document.documentElement.innerHTML.includes("fixture-password-new-success")&&document.body.innerText.includes("@fresh.bsky.social")'),
      );

      await clickLabel('更新 @author.bsky.social');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      const existingHandle=await inputInfo('Bluesky 账号名称');
      const existingPassword=await inputInfo('Bluesky 应用专用密码');
      check(
        'existing identity opens with its handle and no stored password',
        existingHandle.value==='author.bsky.social'&&existingPassword.value==='',
      );
      sites=await siteStates();
      check(
        'existing identity preselects only its current binding',
        sites.find(site=>site.domain==='one.example')?.checked===true&&
          sites.find(site=>site.domain==='two.example')?.checked===false&&
          sites.find(site=>site.domain==='three.example')?.checked===false,
      );
      const reconnectPassword='fixture-password-same-identity';
      await setSite('two.example',true);
      await setInput('Bluesky 应用专用密码',reconnectPassword);
      await clickText('验证并连接');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check(
        'reconnect targets the existing account identity',
        await evaluate('(()=>{const action=window.__blueskyFixture.actions.findLast(item=>item.command==="account:connect-bluesky");return action.payload.accountId==="10101010-1010-4010-8010-101010101010"&&action.payload.handle==="author.bsky.social"&&action.payload.appPassword==="fixture-password-same-identity"})()'),
      );
      check(
        'same-identity reconnect preserves account ID and stable DID',
        await evaluate('(()=>{const account=window.__blueskyFixture.returnedAccounts.findLast(item=>item.id==="10101010-1010-4010-8010-101010101010");return !!account&&account.username==="did:plc:stablefixtureidentity"&&!Object.prototype.hasOwnProperty.call(account,"password")&&!Object.prototype.hasOwnProperty.call(account,"appPassword")})()'),
      );
      check(
        'existing binding update preserves mailbox and sends the complete selected set',
        await evaluate('(()=>{const action=window.__blueskyFixture.actions.findLast(item=>item.command==="account:set-bindings");return action.payload.accountId==="10101010-1010-4010-8010-101010101010"&&action.payload.mailboxId==="mailbox-existing"&&action.payload.siteIds.join(",")==="site-1,site-2"})()'),
      );
      check(
        'reconnect leaves neither DID nor app password visible',
        await evaluate('!document.body.innerText.includes("did:plc:stablefixtureidentity")&&!document.documentElement.innerHTML.includes("fixture-password-same-identity")'),
      );
      check(
        'Bluesky flow never falls through to generic account editing',
        await evaluate('window.__blueskyFixture.callbacks.edits===0'),
      );

      writeFileSync(join(evidence,'bluesky-connected-accounts.png'),(await win.capturePage()).toPNG());
      const sanitized=await evaluate('({commands:window.__blueskyFixture.actions.map(action=>action.command),returnedAccounts:window.__blueskyFixture.returnedAccounts,callbacks:window.__blueskyFixture.callbacks})');
      writeFileSync(join(evidence,'result.json'),JSON.stringify({checks,...sanitized},null,2));
      console.log('BLUESKY UI PASSED: '+checks.length+' checks');
      console.log('Evidence: '+evidence);
      app.quit();
    }catch(error){
      console.error(error);
      app.exit(1);
    }
  });
}
