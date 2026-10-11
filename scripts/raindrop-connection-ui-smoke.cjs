const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync,chmodSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

process.umask(0o022);

if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-raindrop-ui-'));
    const root=process.cwd();
    await require('esbuild').build({
      stdin:{
        contents:`
          import React,{useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {AccountsPage} from ${JSON.stringify(join(root,'src/ui/pages/AccountsPage.tsx'))};
          import ${JSON.stringify(join(root,'src/ui/styles.css'))};

          const now='2026-10-10T00:00:00.000Z';
          const accountId='71717171-7171-4717-8717-717171717171';
          const account={
            id:accountId,channelId:'raindrop',email:'',username:'9001',
            displayName:'Reading shelf',publicationUrl:'https://reading.raindrop.page/resources',
            createdAt:now,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported',
            raindrop:{version:1,ownerId:'9001',collectionId:'73',publicUrl:'https://reading.raindrop.page/resources',tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:now},
          };
          const channel={
            id:'raindrop',name:'Raindrop · 公开资源收藏',domain:'raindrop.page',
            url:'https://raindrop.io/',submitUrl:'https://app.raindrop.io/',
            categories:['general'],languages:['*'],kind:'community',contentFormat:'social',
            emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',
            automation:'api',quality:'C',qualityReason:'fixture',rulesUrl:'https://help.raindrop.io/terms',
            checkedAt:now,notes:'fixture',allowedHosts:['raindrop.page'],enabled:false,provenance:'built-in',
          };
          const initial={
            sites:[
              {id:'site-1',domain:'one.example',url:'https://one.example/',email:'owner@one.example',name:'One',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
              {id:'site-2',domain:'two.example',url:'https://two.example/',email:'owner@two.example',name:'Two',description:'fixture',category:'general',language:'zh',monthlyTarget:2,status:'ready',createdAt:now},
            ],
            tasks:[],channels:[channel],accounts:[account],mailboxes:[],
            accountBindings:[{id:'bind-1',siteId:'site-1',channelId:'raindrop',accountId,createdAt:now,updatedAt:now}],
            events:[],
            settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
            runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:true,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
          };
          const safeActions=[];
          let connectAttempts=0,cancelCount=0;
          const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
          function Harness(){
            const [data,setData]=useState(initial);
            const action=async(command,payload={})=>{
              const safePayload={...payload};
              if(Object.prototype.hasOwnProperty.call(safePayload,'token')){
                safePayload.tokenPresent=typeof safePayload.token==='string'&&safePayload.token.length>0;
                safePayload.tokenLength=typeof safePayload.token==='string'?safePayload.token.length:0;
                delete safePayload.token;
              }
              safeActions.push({command,payload:safePayload});
              if(command==='account:cancel-raindrop-connect'){cancelCount++;return {ok:true}}
              if(command==='account:raindrop-collections'){
                await pause(payload.token==='late-private-token'?500:90);
                if(payload.token==='fail-token')return undefined;
                return {ownerId:'9001',collections:[
                  {id:'73',title:'Existing public shelf',public:true,accessLevel:4,ownerId:'9001'},
                  {id:'74',title:'Private shelf',public:false,accessLevel:4,ownerId:'9001'},
                  {id:'75',title:'Shared shelf',public:true,accessLevel:3,ownerId:'9001'},
                  {id:'76',title:'Other owner',public:true,accessLevel:4,ownerId:'77'},
                ]};
              }
              if(command==='account:connect-raindrop'){
                connectAttempts++;
                await pause(90);
                if(connectAttempts===1)return undefined;
                const updated={...account,publicationUrl:payload.publicUrl,raindrop:{...account.raindrop,collectionId:payload.collectionId,publicUrl:payload.publicUrl,tokenVersion:2,connectedAt:now}};
                setData(current=>({...current,accounts:[updated],accountBindings:payload.siteIds.map((siteId,index)=>({id:'bind-'+index,siteId,channelId:'raindrop',accountId,createdAt:now,updatedAt:now}))}));
                return updated;
              }
              return {ok:true};
            };
            Object.assign(window,{__raindropFixture:{safeActions,startNew:()=>setData(current=>({...current,accounts:[],accountBindings:[]})),get connectAttempts(){return connectAttempts},get cancelCount(){return cancelCount}}});
            return <AccountsPage data={data} disabled={false} onImport={()=>{}} onEdit={()=>{}} onDelete={()=>{}} onAction={action} onSetup={()=>{}}/>;
          }
          createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
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
  const evidence=join(process.cwd(),'.evidence','raindrop-implementation-20261010','ui');
  mkdirSync(evidence,{recursive:true,mode:0o700});
  chmodSync(evidence,0o700);
  app.setPath('userData',join(dir,'profile'));
  const checks=[];
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let win;
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){if(await evaluate(source))return;await delay(35)}
    throw new Error('UI readiness deadline: '+source);
  };
  const nativeClick=async selectorSource=>{
    const ready=await evaluate(`(()=>{const target=(${selectorSource});if(!target||target.disabled)return false;target.scrollIntoView({block:'center',inline:'nearest'});return true})()`);
    assert(ready,'native click target');
    await delay(35);
    const point=await evaluate(`(()=>{const target=(${selectorSource});if(!target||target.disabled||target.offsetParent===null)return null;const rect=target.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
    assert(point,'native click target');
    win.show();win.focus();await delay(35);
    win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
    await delay(45);
  };
  const clickText=text=>nativeClick(`[...document.querySelectorAll('button')].find(item=>item.innerText.trim()===${JSON.stringify(text)})`);
  const clickLabel=label=>nativeClick(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')`);
  const setInput=async(label,value)=>{
    await nativeClick(`document.querySelector('input[aria-label=${JSON.stringify(label)}]')`);
    const changed=await evaluate(`(()=>{const input=document.querySelector('input[aria-label=${JSON.stringify(label)}]');if(!input)return false;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return input.value===${JSON.stringify(value)}})()`);
    assert(changed,'set input '+label);await delay(35);
  };
  const capture=async name=>{
    const path=join(evidence,name);
    writeFileSync(path,(await win.capturePage()).toPNG(),{mode:0o600});
    chmodSync(path,0o600);
  };
  const writeResult=value=>{
    const path=join(evidence,'result.json');
    writeFileSync(path,JSON.stringify(value,null,2),{mode:0o600});
    chmodSync(path,0o600);
  };

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1260,height:820,useContentSize:true,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    await win.loadFile(join(dir,'index.html'));
    await waitFor('document.body.innerText.includes("Reading shelf")');
    await clickLabel('更新 Reading shelf');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="更新 Raindrop 连接"');
    check('existing connection opens directly at the token step',await evaluate('document.querySelector("[role=dialog]").innerText.includes("当前 · 2. 粘贴个人 Test token")'));
    const initial=await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');const input=dialog.querySelector('input[aria-label="Raindrop 个人 Test token"]');return {type:input?.type,value:input?.value,text:dialog.innerText,html:dialog.outerHTML}})()`);
    check('saved token is never prefilled or rendered',initial.type==='password'&&initial.value===''&&!initial.text.includes('fixture-secret')&&!initial.html.includes('fixture-secret'));
    check('existing identity and collection are visible without developer terminology or a secret',initial.text.includes('合集 #73')&&!initial.text.includes('owner #9001'));

    await setInput('Raindrop 个人 Test token','fail-token');
    check('typed token stays confined to the password control and is not visible page text',await evaluate('!document.body.innerText.includes("fail-token")&&document.querySelector(\'input[aria-label="Raindrop 个人 Test token"]\')?.type==="password"'));
    await clickText('读取本人公开合集');
    await waitFor('document.querySelector("[role=alert]")?.innerText.includes("未能读取合集")');
    check('failed collection read stays recoverable in the same drawer',await evaluate(`document.querySelector("[role=dialog]")!==null&&document.querySelector('input[aria-label="Raindrop 个人 Test token"]')!==null`));

    await setInput('Raindrop 个人 Test token','valid-private-token');
    await clickText('读取本人公开合集');
    await waitFor(`document.querySelector('select[aria-label="Raindrop 公开合集"]')!==null`);
    const selection=await evaluate(`(()=>{const select=document.querySelector('select[aria-label="Raindrop 公开合集"]');const sites=[...document.querySelectorAll('.site-binding-option')].map(label=>({domain:label.innerText.trim(),checked:label.querySelector('input').checked}));const url=document.querySelector('input[aria-label="Raindrop 实际公开分享地址"]');return {options:[...select.options].map(item=>({value:item.value,text:item.textContent})),value:select.value,sites,url:url.value,text:document.querySelector('[role=dialog]').innerText}})()`);
    check('only the verified owner-level public collection is selectable',selection.options.length===1&&selection.options[0].value==='73');
    check('the existing collection and actual Public Page URL are preserved',selection.value==='73'&&selection.url==='https://reading.raindrop.page/resources');
    check('the old identity website binding is preselected without selecting another site',selection.sites.length===2&&selection.sites[0].domain==='one.example'&&selection.sites[0].checked===true&&selection.sites[1].checked===false);
    check('real-public-display and live-acceptance limits remain visible',selection.text.includes('匿名核对')&&selection.text.includes('首次真实发布')&&selection.text.includes('另行验收'));
    await capture('raindrop-ready.png');

    const before=await evaluate('window.__raindropFixture.connectAttempts');
    await nativeClick(`[...document.querySelectorAll('button')].find(item=>item.innerText.trim()==='复核并更新连接')`);
    await nativeClick(`[...document.querySelectorAll('button')].find(item=>item.innerText.trim()==='正在复核并保存…'||item.innerText.trim()==='复核并更新连接')`).catch(()=>{});
    await waitFor('document.querySelector("[role=alert]")?.innerText.includes("连接未保存")');
    check('rapid save attempts dispatch one atomic connect call',await evaluate('window.__raindropFixture.connectAttempts')===before+1);
    check('failed save preserves the selected collection, URL and site for retry',await evaluate(`document.querySelector('select[aria-label="Raindrop 公开合集"]')?.value==="73"&&document.querySelector('input[aria-label="Raindrop 实际公开分享地址"]')?.value==="https://reading.raindrop.page/resources"&&document.querySelector('.site-binding-option input')?.checked===true`));
    await clickText('复核并更新连接');
    await waitFor('document.querySelector("[role=dialog]")===null');
    const safe=await evaluate('window.__raindropFixture.safeActions');
    const connectActions=safe.filter(item=>item.command==='account:connect-raindrop');
    const lastConnect=connectActions.at(-1);
    check('successful retry sends the existing account, collection, URL and one selected site',connectActions.length===2&&lastConnect.payload.accountId==='71717171-7171-4717-8717-717171717171'&&lastConnect.payload.collectionId==='73'&&lastConnect.payload.publicUrl==='https://reading.raindrop.page/resources'&&JSON.stringify(lastConnect.payload.siteIds)===JSON.stringify(['site-1']));
    check('synthetic evidence records only token presence and length, never token bytes',!JSON.stringify(safe).includes('valid-private-token')&&safe.some(item=>item.payload.tokenPresent===true&&item.payload.tokenLength===19));

    await clickLabel('更新 Reading shelf');
    await waitFor('document.querySelector("[role=dialog]")!==null');
    await setInput('Raindrop 个人 Test token','cancel-private-token');
    const cancels=await evaluate('window.__raindropFixture.cancelCount');
    await clickText('取消');
    await waitFor('document.querySelector("[role=dialog]")===null');
    check('cancel closes the drawer and calls the backend cancellation path',await evaluate('window.__raindropFixture.cancelCount')>cancels);
    check('cancelled secret disappears from the live DOM and safe evidence',await evaluate('!document.body.innerText.includes("cancel-private-token")&&!document.documentElement.outerHTML.includes("cancel-private-token")&&!JSON.stringify(window.__raindropFixture.safeActions).includes("cancel-private-token")'));

    await evaluate('window.__raindropFixture.startNew()');
    await waitFor('!document.body.innerText.includes("Reading shelf")');
    await clickText('添加 / 连接账号');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="添加或连接账号"');
    await nativeClick(`[...document.querySelectorAll('[role=option]')].find(item=>item.innerText.includes('Raindrop'))`);
    await clickText('连接 Raindrop');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="连接 Raindrop 公开合集"');
    check('new connection opens at the human preparation step in StrictMode',await evaluate('document.querySelector("[role=dialog]")?.innerText.includes("当前 · 1. 准备本人账号与公开合集")'));
    await clickText('我已准备好账号、公开合集和 Test token');
    await setInput('Raindrop 个人 Test token','late-private-token');
    const lateCancels=await evaluate('window.__raindropFixture.cancelCount');
    await clickText('读取本人公开合集');
    await clickText('取消本次操作');
    await waitFor('document.querySelector("[role=dialog]")===null');
    await delay(160);
    check('late collection result cannot reopen or update the cancelled new connection',await evaluate('document.querySelector("[role=dialog]")===null&&document.querySelector(\'select[aria-label="Raindrop 公开合集"]\')===null'));
    check('new-flow cancellation clears the secret and reaches the backend cancellation path',await evaluate('window.__raindropFixture.cancelCount')>lateCancels&&await evaluate('!document.documentElement.outerHTML.includes("late-private-token")&&!JSON.stringify(window.__raindropFixture.safeActions).includes("late-private-token")'));

    const result={passed:true,mode:'isolated Electron StrictMode renderer with real AccountsPage/RaindropConnection and synthetic onAction; no DB, Vault or external request',checks,safeActions:await evaluate('window.__raindropFixture.safeActions'),viewport:{width:1260,height:820}};
    writeResult(result);
    console.log(`RAINDROP UI PASSED: ${checks.length} checks`);
    app.exit(0);
  }catch(error){
    writeResult({passed:false,error:String(error),checks});
    console.error(error);
    app.exit(1);
  }});
}
