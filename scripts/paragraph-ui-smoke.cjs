const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-paragraph-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};

          const now='2026-10-07T00:00:00.000Z';
          const existingAccountId='41414141-4141-4414-8414-414141414141';
          const newAccountId='42424242-4242-4424-8424-424242424242';
          const channel=(id,name,automation,domain)=>({
            id,name,domain,url:'https://'+domain,
            submitUrl:'https://'+domain+'/new',categories:['general'],
            languages:['zh'],kind:'article',emailRequired:false,accountRequired:true,
            articleRequired:true,free:'yes',freeNote:'fixture',automation,
            quality:'A',qualityReason:'fixture',rulesUrl:'https://'+domain+'/rules',
            checkedAt:now,notes:'',allowedHosts:[domain],enabled:true,
          });
          const existingAccount={
            id:existingAccountId,channelId:'paragraph',email:'owner@one.example',
            username:'publication-existing-id',displayName:'@existing-publication',
            publicationUrl:'https://paragraph.com/@existing-publication',
            createdAt:now,status:'registered',hasPassword:true,
            credentialKind:'api_token',source:'imported',
          };
          const initial={
            sites:[
              {id:'site-1',domain:'one.example',url:'https://one.example',email:'owner@one.example',name:'One',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now,paragraph:{publicationId:'publication-existing-id'}},
              {id:'site-2',domain:'two.example',url:'https://two.example',email:'owner@two.example',name:'Two',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
              {id:'site-3',domain:'three.example',url:'https://three.example',email:'owner@three.example',name:'Three',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'paused',createdAt:now},
            ],
            tasks:[],
            channels:[
              channel('paragraph','Paragraph','api','paragraph.com'),
              channel('github','GitHub','browser','github.com'),
            ],
            accounts:[
              existingAccount,
              {id:'43434343-4343-4434-8434-434343434343',channelId:'github',email:'login@example.com',username:'password-owner',createdAt:now,status:'registered',hasPassword:true,credentialKind:'password',source:'imported'},
            ],
            mailboxes:[],
            accountBindings:[{id:'binding-existing',siteId:'site-1',channelId:'paragraph',accountId:existingAccountId,createdAt:now,updatedAt:now}],
            events:[],
            settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
            runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
          };
          const actions=[];
          const returnedAccounts=[];
          const callbacks={imports:0,edits:0,deletes:0};
          const logs=[];
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

          function Harness(){
            const [data,setData]=useState(initial);
            const [pending,setPending]=useState(false);
            const action=async(command,payload)=>{
              actions.push({command,payload:payload===undefined?'__undefined__':payload});
              logs.push({command,status:'started'});
              setPending(true);
              try{
                if(command==='account:connect-paragraph'){
                  await pause(100);
                  if(payload.apiKey==='paragraph-failure-key'){
                    logs.push({command,status:'rejected'});
                    return undefined;
                  }
                  const prior=payload.accountId===existingAccountId?existingAccount:undefined;
                  const account={
                    ...(prior??{}),
                    id:prior?.id??newAccountId,
                    channelId:'paragraph',
                    email:prior?.email??'owner@two.example',
                    username:prior?.username??'publication-fresh-id',
                    displayName:prior?.displayName??'@fresh-publication',
                    publicationUrl:prior?.publicationUrl??'https://paragraph.com/@fresh-publication',
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
                    accountBindings:[
                      ...current.accountBindings.filter(binding=>binding.accountId!==account.id),
                      ...payload.siteIds.map(siteId=>({
                        id:'binding-'+account.id+'-'+siteId,
                        siteId,channelId:'paragraph',accountId:account.id,
                        createdAt:now,updatedAt:now,
                      })),
                    ],
                  }));
                  logs.push({command,status:'connected'});
                  return account;
                }
                if(command==='external:open'){
                  logs.push({command,status:'opened'});
                  return {ok:true};
                }
                logs.push({command,status:'completed'});
                return {ok:true};
              }finally{
                setPending(false);
              }
            };
            Object.assign(window,{__paragraphFixture:{actions,returnedAccounts,callbacks,logs,data}});
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
  const evidence=join(process.cwd(),'.evidence','paragraph-ui-2026-10-07');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));

  const checks=[];
  const consoleMessages=[];
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
    'window.__paragraphFixture.actions.filter(action=>action.command==='+JSON.stringify(command)+').length',
  );
  const openNewParagraph=async()=>{
    await clickText('添加 / 连接账号');
    await waitFor('document.querySelector(".account-guide-drawer")!==null');
    const picked=await evaluate('(()=>{const option=[...document.querySelectorAll(".account-guide-drawer [role=option]")].find(item=>item.querySelector("strong")?.textContent==="Paragraph");if(!option)return false;option.click();return true})()');
    assert(picked,'Paragraph platform option');
    await waitFor('document.querySelector(".account-guide-drawer .platform-selection")?.innerText.includes("Paragraph")');
    const opened=await evaluate('(()=>{const button=[...document.querySelectorAll(".account-guide-drawer .platform-selection button")].find(item=>item.innerText.trim()==="管理或新增连接"&&!item.disabled);if(!button)return false;button.click();return true})()');
    assert(opened,'guided Paragraph connection action');
    await waitFor('document.querySelector(".side-drawer.narrow")?.getAttribute("aria-label")==="连接 Paragraph"');
    await waitFor('document.querySelector(".account-guide-drawer")===null');
  };

  app.whenReady().then(async()=>{
    try{
      win=new BrowserWindow({
        width:1260,
        height:800,
        useContentSize:true,
        show:false,
        webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true},
      });
      win.webContents.on('console-message',(_event,...args)=>{
        const details=args.find(value=>value&&typeof value==='object'&&typeof value.message==='string');
        const message=details?.message??args.find(value=>typeof value==='string')??'';
        consoleMessages.push(String(message));
      });
      await win.loadFile(join(dir,'index.html'));
      await waitFor('document.body.innerText.includes("@existing-publication")');

      check(
        'Paragraph connection entry is discoverable on the accounts page',
        await evaluate('[...document.querySelectorAll("button")].some(button=>button.innerText.trim()==="添加 / 连接账号"&&!button.disabled)'),
      );
      const paragraphReveal=await buttonInfo('\u67e5\u770b @existing-publication \u7684\u5bc6\u7801');
      const ordinaryReveal=await buttonInfo('\u67e5\u770b password-owner \u7684\u5bc6\u7801');
      check('Paragraph API identity has no generic password reveal',!paragraphReveal.exists);
      check('ordinary password identity keeps its password reveal',ordinaryReveal.exists);

      await openNewParagraph();
      check(
        'Paragraph drawer opens with its accessible dialog label',
        await evaluate('document.querySelector(".side-drawer.narrow")?.getAttribute("aria-label")==="连接 Paragraph"'),
      );
      await clickLabel('\u5173\u95ed');
      await waitFor('document.querySelector(".side-drawer.narrow")===null');
      check('Paragraph drawer closes from its close control',true);

      await openNewParagraph();
      const blankSubmit=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==="\u9a8c\u8bc1\u5e76\u8fde\u63a5");return !!button&&button.disabled})()');
      check('new connection submit is disabled while the API key is empty',blankSubmit);
      const keyField=await inputInfo('Paragraph API key');
      check(
        'Paragraph uses a dedicated non-prefilled password input',
        keyField.exists&&keyField.type==='password'&&keyField.autocomplete==='new-password'&&keyField.value==='',
      );
      let sites=await siteStates();
      check(
        'new Paragraph identity does not select any site by default',
        sites.length===3&&sites.every(site=>!site.checked),
      );
      check(
        'an empty selection keeps explicit site-selection guidance visible',
        await evaluate('document.querySelector("[role=dialog]")?.innerText.includes("\u9009\u62e9\u8981\u5f15\u7528\u7684\u7f51\u7ad9")&&document.querySelector("[role=dialog]")?.innerText.includes("\u5173\u8054\u54ea\u4e9b\u7f51\u7ad9")'),
      );
      writeFileSync(join(evidence,'paragraph-empty-drawer.png'),(await win.capturePage()).toPNG());

      const failureKey='paragraph-failure-key';
      await setSite('two.example',true);
      await setInput('Paragraph API key',failureKey);
      check(
        'typed Paragraph key is never displayed as page text',
        await evaluate('!document.body.innerText.includes("paragraph-failure-key")'),
      );
      const connectsBeforeFailure=await actionCount('account:connect-paragraph');
      const doubleClicked=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==="\u9a8c\u8bc1\u5e76\u8fde\u63a5");if(!button||button.disabled)return false;button.click();button.click();return true})()');
      assert(doubleClicked,'double failure submit');
      await waitFor('document.querySelector("[role=alert]")?.innerText.includes("\u672a\u5b8c\u6210\u8fde\u63a5")');
      check(
        'rapid failed saves dispatch one atomic Paragraph command',
        await actionCount('account:connect-paragraph')===connectsBeforeFailure+1&&await actionCount('account:set-bindings')===0,
      );
      check(
        'failed save keeps the Paragraph drawer open',
        await evaluate('document.querySelector("[role=dialog]")!==null'),
      );
      const clearedAfterFailure=await inputInfo('Paragraph API key');
      check(
        'failed save clears the key without exposing it in HTML or logs',
        clearedAfterFailure.value===''&&await evaluate('!document.documentElement.innerHTML.includes("paragraph-failure-key")&&!JSON.stringify(window.__paragraphFixture.logs).includes("paragraph-failure-key")')&&!consoleMessages.some(message=>message.includes(failureKey)),
      );
      check(
        'failed atomic payload includes the selected site set',
        await evaluate('(()=>{const action=window.__paragraphFixture.actions.find(item=>item.command==="account:connect-paragraph");return !!action&&Object.keys(action.payload).sort().join(",")==="accountId,apiKey,siteIds"&&action.payload.accountId===undefined&&action.payload.siteIds.join(",")==="site-2"})()'),
      );
      check(
        'failed connection returns no account metadata',
        await evaluate('window.__paragraphFixture.returnedAccounts.length===0'),
      );

      const successKey='paragraph-success-key';
      await setSite('three.example',true);
      await setInput('Paragraph API key',successKey);
      sites=await siteStates();
      check(
        'only explicitly checked sites are selected before connect',
        sites.find(site=>site.domain==='one.example')?.checked===false&&
          sites.find(site=>site.domain==='two.example')?.checked===true&&
          sites.find(site=>site.domain==='three.example')?.checked===true,
      );
      await clickText('\u9a8c\u8bc1\u5e76\u8fde\u63a5');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check(
        'successful save closes the drawer and renders the returned account',
        await evaluate('document.body.innerText.includes("@fresh-publication")'),
      );
      check(
        'successful save remains one atomic command with the complete site set',
        await evaluate('(()=>{const action=window.__paragraphFixture.actions.findLast(item=>item.command==="account:connect-paragraph");return action.payload.accountId===undefined&&action.payload.apiKey==="paragraph-success-key"&&action.payload.siteIds.join(",")==="site-2,site-3"&&window.__paragraphFixture.actions.every(item=>item.command!=="account:set-bindings")})()'),
      );
      check(
        'new connection returns metadata without plaintext secrets',
        await evaluate('(()=>{const account=window.__paragraphFixture.returnedAccounts.find(item=>item.id==="42424242-4242-4424-8424-424242424242");return !!account&&!Object.prototype.hasOwnProperty.call(account,"password")&&!Object.prototype.hasOwnProperty.call(account,"apiKey")&&!Object.prototype.hasOwnProperty.call(account,"secret")})()'),
      );
      check(
        'new account shows both selected site bindings',
        await evaluate('(()=>{const row=[...document.querySelectorAll("tbody tr")].find(item=>item.innerText.includes("@fresh-publication"));return !!row&&row.innerText.includes("two.example")&&row.innerText.includes("three.example")})()'),
      );
      check(
        'successful key enters neither visible HTML nor fixture or renderer logs',
        await evaluate('!document.documentElement.innerHTML.includes("paragraph-success-key")&&!JSON.stringify(window.__paragraphFixture.logs).includes("paragraph-success-key")')&&!consoleMessages.some(message=>message.includes(successKey)),
      );

      await clickLabel('\u66f4\u65b0 @existing-publication');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      const existingKey=await inputInfo('Paragraph API key');
      check(
        'existing identity opens in update mode without its stored key',
        existingKey.value===''&&await evaluate('document.querySelector("[role=dialog]")?.innerText.includes("\u66f4\u65b0 Paragraph \u8fde\u63a5")'),
      );
      sites=await siteStates();
      check(
        'existing identity preselects only its current binding',
        sites.find(site=>site.domain==='one.example')?.checked===true&&
          sites.find(site=>site.domain==='two.example')?.checked===false&&
          sites.find(site=>site.domain==='three.example')?.checked===false,
      );
      const editKey='paragraph-edit-key';
      await setSite('two.example',true);
      await setInput('Paragraph API key',editKey);
      await clickText('\u9a8c\u8bc1\u5e76\u8fde\u63a5');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check(
        'edit targets the existing account and carries the complete binding set',
        await evaluate('(()=>{const action=window.__paragraphFixture.actions.findLast(item=>item.command==="account:connect-paragraph");return action.payload.accountId==="41414141-4141-4414-8414-414141414141"&&action.payload.apiKey==="paragraph-edit-key"&&action.payload.siteIds.join(",")==="site-1,site-2"})()'),
      );
      check(
        'edit preserves account ID, publication identity, and existing bindings',
        await evaluate('(()=>{const account=window.__paragraphFixture.returnedAccounts.findLast(item=>item.id==="41414141-4141-4414-8414-414141414141");const row=[...document.querySelectorAll("tbody tr")].find(item=>item.innerText.includes("@existing-publication"));return !!account&&account.username==="publication-existing-id"&&!!row&&row.innerText.includes("one.example")&&row.innerText.includes("two.example")})()'),
      );
      check(
        'edit returns no secret metadata and leaks no key to HTML or logs',
        await evaluate('(()=>{const account=window.__paragraphFixture.returnedAccounts.findLast(item=>item.id==="41414141-4141-4414-8414-414141414141");return !!account&&!Object.prototype.hasOwnProperty.call(account,"apiKey")&&!Object.prototype.hasOwnProperty.call(account,"password")&&!document.documentElement.innerHTML.includes("paragraph-edit-key")&&!JSON.stringify(window.__paragraphFixture.logs).includes("paragraph-edit-key")})()')&&!consoleMessages.some(message=>message.includes(editKey)),
      );
      check(
        'Paragraph flow never falls through to generic account editing',
        await evaluate('window.__paragraphFixture.callbacks.edits===0'),
      );

      writeFileSync(join(evidence,'paragraph-connected-accounts.png'),(await win.capturePage()).toPNG());
      const sanitized=await evaluate(`({
        commands:window.__paragraphFixture.actions.map(action=>action.command),
        payloadShapes:window.__paragraphFixture.actions.map(action=>({
          command:action.command,
          keys:action.payload&&typeof action.payload==='object'?Object.keys(action.payload).sort():[],
          accountId:action.payload?.accountId,
          siteIds:action.payload?.siteIds,
        })),
        returnedAccounts:window.__paragraphFixture.returnedAccounts,
        callbacks:window.__paragraphFixture.callbacks,
        logs:window.__paragraphFixture.logs,
      })`);
      writeFileSync(join(evidence,'result.json'),JSON.stringify({checks,...sanitized},null,2));
      console.log('PARAGRAPH UI PASSED: '+checks.length+' checks');
      console.log('Evidence: '+evidence);
      app.quit();
    }catch(error){
      writeFileSync(join(evidence,'result.json'),JSON.stringify({checks,error:String(error?.message??error)},null,2));
      console.error(error);
      app.exit(1);
    }
  });
}
