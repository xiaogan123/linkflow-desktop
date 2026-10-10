const {join}=require('node:path');
const {mkdtempSync,writeFileSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-leaflet-ui-'));
    await require('esbuild').build({stdin:{contents:`
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {AccountsPage} from './src/ui/pages/AccountsPage';import {CHANNELS} from './src/integrations/catalog';import './src/ui/styles.css';
      const actions=[],at='2026-10-08T00:00:00Z';let fail=false;
      const sites=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map((id,i)=>({id,domain:'site'+i+'.example.com',name:'Fixture',url:'https://site'+i+'.example.com/',email:'owner@example.com',category:'content',description:'Fixture',language:'en',status:'ready',monthlyTarget:2,createdAt:at}));
      function Harness(){const [data,setData]=useState({sites,accounts:[],accountBindings:[],tasks:[],mailboxes:[],channels:CHANNELS});
        const action=async(command,payload)=>{actions.push({command,payload});if(command==='account:connect-leaflet'){await new Promise(r=>setTimeout(r,100));if(fail)return undefined;const account={id:payload.accountId??'33333333-3333-4333-8333-333333333333',channelId:'leaflet',username:payload.handle,displayName:'@'+payload.handle,publicationUrl:'https://leaflet.pub/p/did:plc:abcdefghijklmnopqrstuvwx',credentialKind:'api_token',email:'',hasPassword:true,status:'registered',source:'imported',createdAt:at};setData(current=>({...current,accounts:[account],accountBindings:payload.siteIds.map(siteId=>({id:siteId,siteId,channelId:'leaflet',accountId:account.id}))}));return account}return {ok:true}};
        Object.assign(window,{__leafletFixture:{actions,setFail:value=>{fail=value}}});
        return <AccountsPage data={data} disabled={false} onImport={()=>{}} onEdit={()=>{}} onDelete={()=>{}} onSetup={()=>{}} onAction={action}/>;
      }createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:process.cwd(),loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script></html>');
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const timeout=setTimeout(()=>child.kill(),60000);child.once('exit',code=>{clearTimeout(timeout);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow}=require('electron'),dir=process.argv[2],checks=[];
  app.setPath('userData',join(dir,'profile'));let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true),pause=ms=>new Promise(r=>setTimeout(r,ms));
  const check=(label,result)=>{assert(result,label);checks.push(label)};
  const waitFor=async source=>{const end=Date.now()+5000;while(Date.now()<end){if(await evaluate(source))return;await pause(20)}throw Error('UI timeout: '+source)};
  const click=async label=>{assert(await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.innerText.trim()==='+JSON.stringify(label)+'&&!b.disabled);if(!b)return false;b.click();return true})()'));await pause(20)};
  const input=async(label,value)=>evaluate('(()=>{const el=document.querySelector('+JSON.stringify('[aria-label="'+label+'"]')+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');
  const openLeaflet=async()=>{
    await click('添加 / 连接账号');await waitFor('document.querySelector(".account-guide-drawer")!==null');
    const picked=await evaluate('(()=>{const option=[...document.querySelectorAll(".account-guide-drawer [role=option]")].find(item=>item.querySelector("strong")?.textContent==="Leaflet");if(!option)return false;option.click();return true})()');assert(picked,'Leaflet platform option');
    await waitFor('document.querySelector(".account-guide-drawer .platform-selection")?.innerText.includes("Leaflet")');
    const opened=await evaluate('(()=>{const button=[...document.querySelectorAll(".account-guide-drawer .platform-selection button")].find(item=>item.innerText.trim()==="连接 Leaflet"&&!item.disabled);if(!button)return false;button.click();return true})()');assert(opened,'guided Leaflet connection action');
    await waitFor('document.querySelector(".side-drawer.narrow")?.getAttribute("aria-label")==="连接 Leaflet"');await waitFor('document.querySelector(".account-guide-drawer")===null');
  };
  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1320,height:920,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
    await win.loadFile(join(dir,'index.html'));await waitFor('document.body.innerText.includes("添加 / 连接账号")');
    check('Leaflet remains a pending acceptance connection',await evaluate('(()=>{const row=[...document.querySelectorAll(".connection-overview-row")].find(item=>item.querySelector("strong")?.textContent==="Leaflet");return !!row&&row.textContent.includes("当前未启用")&&row.textContent.includes("真实授权和公开全文发布尚待验收")&&row.querySelector("button")?.textContent.includes("连接 Leaflet")})()'));
    await openLeaflet();
    check('full article and existing account requirements are explicit',await evaluate('document.querySelector("[role=dialog]").innerText.includes("完整文章")&&document.querySelector("[role=dialog]").innerText.includes("不会自动注册账号")'));
    check('disabled candidate does not promise immediate publication',await evaluate('document.querySelector("[role=dialog]").innerText.includes("不参与自动任务")'));
    check('credential field is masked',await evaluate('document.querySelector("input[aria-label=\\"Leaflet 应用专用密码\\"]").type==="password"'));
    check('empty form cannot connect',await evaluate('[...document.querySelectorAll("button")].find(b=>b.innerText==="验证并连接").disabled'));
    await click('打开应用密码设置');check('credential settings use the known external destination',await evaluate('window.__leafletFixture.actions[0].payload.url==="https://bsky.app/settings/app-passwords"'));
    await input('Leaflet 账号名称','author.bsky.social');await input('Leaflet 应用专用密码','aaaa-bbbb-cccc-dddd');
    await evaluate('document.querySelector("[role=dialog] input[type=checkbox]").click()');
    await evaluate('window.__leafletFixture.setFail(true)');await click('验证并连接');await waitFor('!!document.querySelector("[role=alert]")');
    check('failure keeps form and selected sites',await evaluate('!!document.querySelector("[role=dialog]")&&document.querySelector("[role=dialog] input[type=checkbox]").checked'));
    check('failure clears the password',await evaluate('document.querySelector("input[aria-label=\\"Leaflet 应用专用密码\\"]").value===""'));
    await evaluate('window.__leafletFixture.setFail(false)');await input('Leaflet 应用专用密码','aaaa-bbbb-cccc-dddd');
    await evaluate('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.innerText==="验证并连接");b.click();b.click()})()');
    await waitFor('!document.querySelector("[role=dialog]")');
    check('double click sends one connection attempt',await evaluate('window.__leafletFixture.actions.filter(a=>a.command==="account:connect-leaflet").length===2'));
    check('only explicitly selected website is bound',await evaluate('window.__leafletFixture.actions.filter(a=>a.command==="account:connect-leaflet")[1].payload.siteIds.length===1'));
    check('saved credentials are not displayed as account metadata',await evaluate('!document.body.innerText.includes("aaaa-bbbb-cccc-dddd")&&document.body.innerText.includes("@author.bsky.social")'));
    await evaluate('document.querySelector("button[title=\\"更新 Leaflet 连接\\"]").click()');await waitFor('!!document.querySelector("[role=dialog]")');
    check('repair preserves account handle and has no password prefill',await evaluate('document.querySelector("input[aria-label=\\"Leaflet 账号名称\\"]").value==="author.bsky.social"&&document.querySelector("input[aria-label=\\"Leaflet 应用专用密码\\"]").value===""'));
    const evidence=join(process.cwd(),'.evidence','opus-high-expansion-2026-10-08','leaflet-ui');mkdirSync(evidence,{recursive:true});
    writeFileSync(join(evidence,'checks.json'),JSON.stringify({checks,passed:checks.length,failed:0,syntheticIPC:true,realAuth:false,realPublication:false},null,2));writeFileSync(join(evidence,'screen.png'),(await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({passed:checks.length,failed:0}));app.exit(0);
  }catch(error){console.error(error);app.exit(1)}});
}
