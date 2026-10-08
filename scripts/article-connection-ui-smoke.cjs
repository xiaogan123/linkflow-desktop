const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-article-connection-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};

          const now='2026-10-07T00:00:00.000Z';
          const site=(id,domain)=>({id,domain,url:'https://'+domain,email:'owner@'+domain,name:domain,description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now});
          const channel=(id,name,domain)=>({id,name,domain,url:'https://'+domain,submitUrl:'https://'+domain+'/new',categories:['general'],languages:['zh'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'A',qualityReason:'fixture',rulesUrl:'https://'+domain+'/rules',checkedAt:now,notes:'',allowedHosts:[domain],enabled:true});
          const initial={
            sites:[site('site-1','one.example'),site('site-2','two.example')],
            tasks:[],channels:[channel('mataroa','Mataroa','mataroa.blog'),channel('paper-wf','Paper.wf','paper.wf'),channel('hive','Hive','hive.blog'),channel('betterthanhtml','Better Than HTML','betterthanhtml.com'),{...channel('telegraph','Telegraph','telegra.ph'),enabled:false}],
            accounts:[],accountBindings:[],mailboxes:[],events:[],
            settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
            runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
          };
          const calls=[];
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          function Harness(){
            const [data,setData]=useState(initial);
            const [pending,setPending]=useState(false);
            window.linkflow={command:async(command,payload)=>{
              calls.push({command,payload});
              if(command==='account:connect-mataroa'||command==='account:connect-paper'||command==='account:connect-hive'){
                await pause(100);
                if(payload.credential==='fixture-fail')return undefined;
                const channelId=command==='account:connect-mataroa'?'mataroa':command==='account:connect-hive'?'hive':'paper-wf';
                const account={id:channelId+'-fixture-account',channelId,email:'',username:payload.username,displayName:payload.username,createdAt:now,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported'};
                setData(current=>({...current,
                  accounts:[account,...current.accounts.filter(item=>item.id!==account.id)],
                  accountBindings:[...current.accountBindings.filter(item=>item.accountId!==account.id),...payload.siteIds.map(siteId=>({id:channelId+'-'+siteId,siteId,channelId,accountId:account.id,createdAt:now,updatedAt:now}))],
                }));
                return account;
              }
              if(command==='account:reveal'){
                if(payload?.id!=='paper-wf-fixture-account')throw Error('Only Paper login password may be revealed');
                return {password:'synthetic-paper-login-password'};
              }
              if(command==='account:set-bindings')throw Error('Unexpected second binding command');
              return {ok:true};
            }};
            window.__articleFixture={calls};
            const action=async(command,payload)=>{
              setPending(true);
              try{return await window.linkflow.command(command,payload)}
              finally{setPending(false)}
            };
            return <AccountsPage data={data} disabled={pending} onImport={()=>{}} onEdit={()=>{}} onDelete={()=>{}} onAction={action} onSetup={()=>{}}/>;
          }
          createRoot(document.getElementById('root')).render(<Harness/>);
        `,
        resolveDir:root,loader:'tsx',
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
  const evidence=process.env.LINKFLOW_UI_EVIDENCE_DIR||join(process.cwd(),'.evidence','channel-expansion-2026-10-07','ui');
  mkdirSync(evidence,{recursive:true});
  app.setPath('userData',join(dir,'profile'));
  const checks=[];
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){if(await evaluate(source))return;await delay(35)}
    throw Error('UI readiness deadline: '+source);
  };
  const clickText=async label=>{
    const source='(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.innerText.trim()==='+JSON.stringify(label)+'&&!item.disabled);if(!button)return false;button.click();return true})()';
    assert(await evaluate(source),'button: '+label);
    await delay(35);
  };
  const inputInfo=label=>evaluate('(()=>{const input=[...document.querySelectorAll("input")].find(item=>item.getAttribute("aria-label")==='+JSON.stringify(label)+');return input?{type:input.type,autocomplete:input.autocomplete,value:input.value}:{missing:true}})()');
  const setInput=async(label,value)=>{
    const source='(()=>{const input=[...document.querySelectorAll("input")].find(item=>item.getAttribute("aria-label")==='+JSON.stringify(label)+');if(!input||input.disabled)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,'+JSON.stringify(value)+');input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));return true})()';
    assert(await evaluate(source),'input: '+label);
    await delay(35);
  };
  const selectHive=async()=>{
    const source='(()=>{const select=document.querySelector("[role=dialog] select");if(!select)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"hive");select.dispatchEvent(new Event("change",{bubbles:true}));return true})()';
    assert(await evaluate(source),'Hive selector');
    await delay(35);
  };
  const setCheckbox=async(text,checked)=>{
    const source='(()=>{const label=[...document.querySelectorAll("[role=dialog] label")].find(item=>item.innerText.includes('+JSON.stringify(text)+'));const input=label?.querySelector("input[type=checkbox]");if(!input||input.disabled)return false;if(input.checked!=='+JSON.stringify(checked)+')input.click();return input.checked==='+JSON.stringify(checked)+'})()';
    assert(await evaluate(source),'checkbox: '+text);
    await delay(35);
  };
  const submit=()=>evaluate('(()=>{const button=[...document.querySelectorAll("[role=dialog] button")].find(item=>item.innerText.trim()==="验证并连接");return button?{disabled:button.disabled,text:button.innerText.trim()}:{missing:true}})()');
  const doubleSubmit=()=>evaluate('(()=>{const button=[...document.querySelectorAll("[role=dialog] button")].find(item=>item.innerText.trim()==="验证并连接");if(!button||button.disabled)return false;button.click();button.click();return true})()');
  const callCount=command=>evaluate('window.__articleFixture.calls.filter(item=>item.command==='+JSON.stringify(command)+').length');
  const noSecretInDom=value=>evaluate('!document.documentElement.innerHTML.includes('+JSON.stringify(value)+')&&!document.body.innerText.includes('+JSON.stringify(value)+')');

  app.whenReady().then(async()=>{
    try{
      win=new BrowserWindow({width:1260,height:800,useContentSize:true,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
      await win.loadFile(join(dir,'index.html'));
      await waitFor('document.body.innerText.includes("更多全文渠道")');
      check('anonymous BTH appears as no-setup and never offers an account connection button',await evaluate('(()=>{const row=[...document.querySelectorAll(".connection-overview-row")].find(item=>item.querySelector("strong")?.textContent==="Better Than HTML");return !!row&&row.innerText.includes("无需首次连接")&&row.innerText.includes("无需注册账号")&&!row.querySelector("button")})()'));
      check('disabled Telegraph never claims automatic preparation or pending acceptance',await evaluate('(()=>{const row=[...document.querySelectorAll(".connection-overview-row")].find(item=>item.querySelector("strong")?.textContent==="Telegraph");return !!row&&row.innerText.includes("当前停用")&&row.innerText.includes("当前不执行")&&!row.innerText.includes("随任务自动准备")&&!row.innerText.includes("待验收启用")})()'));
      await clickText('更多全文渠道');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      check('Paper drawer opens through the accounts page',await evaluate('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="连接全文发布渠道"'));
      check('Paper submit starts disabled', (await submit()).disabled);
      let credential=await inputInfo('Paper.wf 凭据');
      check('Paper credential is masked, empty, and marked as new password',credential.type==='password'&&credential.autocomplete==='new-password'&&credential.value==='');
      await setInput('Paper.wf 账号名','paper-author');
      await setInput('Paper.wf 凭据','fixture-fail');
      await setCheckbox('one.example',true);
      check('Paper submit enables when required fields are present',!(await submit()).disabled);
      check('Paper rapid double click starts',await doubleSubmit());
      await waitFor('document.querySelector("[role=alert]")?.innerText.includes("连接尚未完成")');
      check('Paper double click dispatches one IPC command',await callCount('account:connect-paper')===1);
      credential=await inputInfo('Paper.wf 凭据');
      check('Paper failure clears credential and keeps visible error',credential.value===''&&await noSecretInDom('fixture-fail'));
      check('Paper IPC includes only selected website ID',await evaluate('(()=>{const p=window.__articleFixture.calls.find(item=>item.command==="account:connect-paper")?.payload;return p?.username==="paper-author"&&p?.siteIds.join(",")==="site-1"&&p?.accountId===undefined})()'));
      await setInput('Paper.wf 凭据','fixture-paper-success');
      await clickText('验证并连接');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check('Paper success closes drawer and adds account',await evaluate('document.body.innerText.includes("paper-author")')&&await noSecretInDom('fixture-paper-success'));
      check('Paper success uses one atomic IPC command',await callCount('account:connect-paper')===2&&await callCount('account:set-bindings')===0);

      await clickText('更多全文渠道');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      check('new drawer does not retain successful Paper credential',(await inputInfo('Paper.wf 凭据')).value==='');
      await selectHive();
      credential=await inputInfo('Hive 凭据');
      check('Hive posting key is masked, empty, and marked as new password',credential.type==='password'&&credential.autocomplete==='new-password'&&credential.value==='');
      await setInput('Hive 账号名','hive-author');
      await setInput('Hive 凭据','fixture-fail');
      await setCheckbox('two.example',true);
      check('Hive submit requires permanent-publication acknowledgement',(await submit()).disabled&&await evaluate('document.querySelector("[role=dialog]")?.innerText.includes("无法彻底删除")'));
      await setCheckbox('我了解文章及编辑历史',true);
      check('Hive submit enables only after acknowledgement',!(await submit()).disabled);
      check('Hive rapid double click starts',await doubleSubmit());
      await waitFor('document.querySelector("[role=alert]")?.innerText.includes("连接尚未完成")');
      check('Hive double click dispatches one IPC command',await callCount('account:connect-hive')===1);
      credential=await inputInfo('Hive 凭据');
      check('Hive failure clears posting key and shows error',credential.value===''&&await noSecretInDom('fixture-fail'));
      check('Hive IPC includes acknowledgement and selected site',await evaluate('(()=>{const p=window.__articleFixture.calls.find(item=>item.command==="account:connect-hive")?.payload;return p?.username==="hive-author"&&p?.acknowledgePermanent===true&&p?.siteIds.join(",")==="site-2"})()'));
      await setInput('Hive 凭据','fixture-hive-success');
      await clickText('验证并连接');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check('Hive success closes drawer and adds account',await evaluate('document.body.innerText.includes("hive-author")')&&await noSecretInDom('fixture-hive-success'));
      check('Hive success uses one atomic IPC command',await callCount('account:connect-hive')===2&&await callCount('account:set-bindings')===0);
      await clickText('更多全文渠道');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      await selectHive();
      check('new drawer does not retain successful Hive posting key',(await inputInfo('Hive 凭据')).value==='');
      await clickText('取消');
      await waitFor('document.querySelector("[role=dialog]")===null');
      check('Hive posting key has no generic reveal control',await evaluate('![...document.querySelectorAll("button")].some(item=>item.getAttribute("aria-label")==="查看 hive-author 的密码")'));
      check('Paper login password has a protected reveal control',await evaluate('[...document.querySelectorAll("button")].some(item=>item.getAttribute("aria-label")==="查看 paper-author 的密码")'));
      check('Paper password starts concealed',await noSecretInDom('synthetic-paper-login-password'));
      const revealClicked=await evaluate('(()=>{const button=[...document.querySelectorAll("button")].find(item=>item.getAttribute("aria-label")==="查看 paper-author 的密码");if(!button||button.disabled)return false;button.click();return true})()');
      check('Paper password reveal control is actionable',revealClicked);
      await waitFor('document.querySelector(".secret-reveal code")?.textContent==="synthetic-paper-login-password"');
      check('Paper reveal uses its account ID and shows synthetic login password',await callCount('account:reveal')===1&&await evaluate('window.__articleFixture.calls.find(item=>item.command==="account:reveal")?.payload?.id==="paper-wf-fixture-account"'));
      await evaluate('window.dispatchEvent(new Event("blur"))');
      await waitFor('document.querySelector(".secret-reveal")===null');
      check('Paper password is concealed after window blur',await noSecretInDom('synthetic-paper-login-password'));
      await clickText('连接已有账号');
      await waitFor('document.querySelector("[role=dialog]")!==null');
      check('Mataroa action opens the exact platform',!(await inputInfo('Mataroa 凭据')).missing);
      check('Mataroa password starts empty and masked',(await inputInfo('Mataroa 凭据')).value===''&&(await inputInfo('Mataroa 凭据')).type==='password');
      check('Mataroa states the newsletter requirement',await evaluate('document.querySelector("[role=dialog]").innerText.includes("关闭 Newsletter")'));
      await setInput('Mataroa 账号名','mataroa-author');
      await setInput('Mataroa 凭据','fixture-mataroa-success');
      await setCheckbox('one.example',true);
      await doubleSubmit();
      await waitFor('document.querySelector("[role=dialog]")===null');
      check('Mataroa uses one atomic connection with selected website',await callCount('account:connect-mataroa')===1&&await evaluate('window.__articleFixture.calls.find(x=>x.command==="account:connect-mataroa").payload.siteIds[0]==="site-1"'));
      check('Mataroa success clears the password',await noSecretInDom('fixture-mataroa-success'));
      const mataroaEdit=await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="更新 mataroa-author");if(!b)return false;b.click();return true})()');
      check('Mataroa repair reuses the same identity',mataroaEdit);
      await waitFor('document.querySelector("[role=dialog]")!==null');
      check('Mataroa repair keeps username and does not prefill secrets',(await inputInfo('Mataroa 账号名')).value==='mataroa-author'&&(await inputInfo('Mataroa 凭据')).value==='');
      await clickText('取消');
      const sanitized=await evaluate('window.__articleFixture.calls.map(item=>({command:item.command,keys:Object.keys(item.payload??{}).sort(),siteIds:item.payload?.siteIds,acknowledgePermanent:item.payload?.acknowledgePermanent}))');
      writeFileSync(join(evidence,'article-connection-ui-result.json'),JSON.stringify({passed:true,checks,calls:sanitized},null,2));
      console.log('ARTICLE CONNECTION UI PASSED: '+checks.length+' checks');
      app.quit();
    }catch(error){
      writeFileSync(join(evidence,'article-connection-ui-result.json'),JSON.stringify({passed:false,checks,error:String(error?.message??error)},null,2));
      console.error(error);
      app.exit(1);
    }
  });
}
