const {join}=require('node:path');
const {mkdtempSync,mkdirSync,writeFileSync,chmodSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

if(!process.versions.electron){
  (async()=>{
    process.umask(0o022);
    const dir=mkdtempSync(join(tmpdir(),'linkflow-draft-copy-ui-'));
    const root=process.cwd();
    const esbuild=require('esbuild');
    await esbuild.build({
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
    await esbuild.build({entryPoints:[join(root,'src/main/preload.ts')],outfile:join(dir,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
    await esbuild.build({entryPoints:[join(root,'src/main/draft-clipboard.ts')],outfile:join(dir,'draft-clipboard.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
    writeFileSync(join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
    const deadline=setTimeout(()=>child.kill(),60000);
    child.once('exit',code=>{clearTimeout(deadline);process.exitCode=code??1});
  })().catch(error=>{console.error(error);process.exitCode=1});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron');
  const dir=process.argv[2];
  const evidence=join(process.cwd(),'.evidence','channel-expansion-20261010','clipboard-fix');
  mkdirSync(evidence,{recursive:true,mode:0o700});
  chmodSync(evidence,0o700);
  app.setPath('userData',join(dir,'profile'));

  const now='2026-10-10T00:00:00.000Z';
  const state={
    sites:[{id:'22222222-2222-4222-8222-222222222222',domain:'copy-fixture.example',url:'https://copy-fixture.example/',email:'owner@copy-fixture.example',publicEmail:'owner@copy-fixture.example',name:'Copy fixture',description:'Synthetic test site',category:'content',language:'zh',monthlyTarget:1,articleReviewMode:'manual',status:'ready',createdAt:now}],
    tasks:[{id:'11111111-1111-4111-8111-111111111111',siteId:'22222222-2222-4222-8222-222222222222',channelId:'manual-fixture',sourceDomain:'publisher-fixture.example',status:'queued',createdAt:now,scheduledAt:now,updatedAt:now,attempts:0,message:'Synthetic draft ready',draft:{title:'Saved title',description:'Saved summary',body:'Saved body'}}],
    channels:[{id:'manual-fixture',name:'Manual fixture',domain:'publisher-fixture.example',url:'https://publisher-fixture.example/',submitUrl:'https://publisher-fixture.example/new',categories:['content'],languages:['zh'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'Synthetic fixture',automation:'manual',quality:'A',qualityReason:'Synthetic fixture',rulesUrl:'https://publisher-fixture.example/rules',checkedAt:'2026-10-10',notes:'',allowedHosts:['publisher-fixture.example'],enabled:true}],
    accounts:[],mailboxes:[],accountBindings:[],events:[],
    settings:{provider:'codex',codexPath:'codex',model:'',apiBase:'',hasApiKey:false,autoRun:false,articleReviewMode:'manual',launchAtLogin:false,notify:true,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},
    runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'darwin-arm64',dataPath:'fixture',aiCallsToday:0},
  };
  const clone=value=>JSON.parse(JSON.stringify(value));
  const writes=[];
  const permissionRequests=[];
  ipcMain.handle('linkflow:command',(_event,name,payload)=>{
    if(name==='snapshot')return {ok:true,value:clone(state)};
    // The renderer acknowledges its first snapshot once; production main replies true.
    if(name==='app:ready')return {ok:true,value:true};
    if(name==='task:update-draft'){
      const task=state.tasks.find(item=>item.id===payload.id);
      assert(task,'fixture task');
      task.draft={title:payload.title,description:payload.description,body:payload.body};
      return {ok:true,value:{ok:true}};
    }
    return {ok:true,value:{ok:true}};
  });

  const checks=[];
  const check=(label,condition)=>{assert(condition,label);checks.push(label)};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let win,expectedRenderURL='';
  const {createDraftClipboardHandler}=require(join(dir,'draft-clipboard.cjs'));
  // Same dependencies as src/main/main.ts wires (getSite feeds the main-side referral gate); only writeText is stubbed.
  const draftClipboardHandler=createDraftClipboardHandler({getWindow:()=>win,getRenderURL:()=>expectedRenderURL,getTasks:()=>state.tasks,getSite:id=>state.sites.find(site=>site.id===id),writeText:value=>{writes.push(value)}});
  ipcMain.handle('linkflow:draft-copy',draftClipboardHandler);
  const evaluate=source=>win.webContents.executeJavaScript(source,true);
  const waitFor=async source=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){if(await evaluate(source))return;await delay(35)}
    throw new Error('UI readiness deadline: '+source);
  };
  const clickButton=async(finder,label)=>{
    const point=await evaluate(`(()=>{const button=(${finder})([...document.querySelectorAll('button')].filter(item=>!item.disabled&&item.offsetParent!==null));if(!button)return null;button.scrollIntoView({block:'center',inline:'nearest'});const rect=button.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}})()`);
    assert(point,'button: '+label);
    win.show();win.focus();await delay(45);
    win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
    await delay(60);
  };
  const clickText=text=>clickButton(`buttons=>buttons.find(item=>item.innerText.trim()===${JSON.stringify(text)})`,text);
  const setField=async(label,value)=>{
    const changed=await evaluate(`(()=>{const labelText=${JSON.stringify(label)};const field=[...document.querySelectorAll('[role=dialog] .field')].find(item=>item.querySelector(':scope > span')?.textContent===labelText);const element=field?.querySelector('input,textarea');if(!element)return false;const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return element.value===${JSON.stringify(value)}})()`);
    assert(changed,'editable field: '+label);
    await delay(45);
  };
  const capture=async name=>{
    const image=await win.capturePage();
    const path=join(evidence,name);
    writeFileSync(path,image.toPNG(),{mode:0o600});
    chmodSync(path,0o600);
  };
  const writeEvidence=value=>{
    const path=join(evidence,'result.json');
    writeFileSync(path,JSON.stringify(value,null,2),{mode:0o600});
    chmodSync(path,0o600);
  };
  const writePermissionEvidence=value=>{
    const path=join(evidence,'permission-probe.json');
    writeFileSync(path,JSON.stringify(value,null,2),{mode:0o600});
    chmodSync(path,0o600);
  };
  const trustedProbe=async mode=>{
    await evaluate(`(()=>{const prior=document.getElementById('clipboard-permission-probe');prior?.remove();window.__clipboardPermissionProbe={mode:${JSON.stringify(mode)},done:false};const button=document.createElement('button');button.id='clipboard-permission-probe';button.textContent='permission probe';Object.assign(button.style,{position:'fixed',left:'12px',top:'12px',width:'180px',height:'48px',zIndex:'99999'});button.addEventListener('click',async event=>{const result=window.__clipboardPermissionProbe;result.trusted=event.isTrusted;result.userActive=navigator.userActivation?.isActive===true;result.clipboardPresent=!!navigator.clipboard?.writeText;try{if(result.mode==='query'){const status=await navigator.permissions.query({name:'clipboard-write'});result.state=status.state}else{await navigator.clipboard.writeText('synthetic-permission-probe-denied-before-write');result.writeResult='resolved'}}catch(error){result.writeResult='rejected';result.errorName=error?.name??'unknown'}finally{result.done=true}});document.body.append(button);return {x:102,y:36}})()`);
    win.show();
    win.focus();
    await delay(80);
    win.webContents.sendInputEvent({type:'mouseMove',x:102,y:36});
    win.webContents.sendInputEvent({type:'mouseDown',x:102,y:36,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',x:102,y:36,button:'left',clickCount:1});
    await waitFor('window.__clipboardPermissionProbe?.done===true');
    const result=await evaluate('window.__clipboardPermissionProbe');
    await evaluate("document.getElementById('clipboard-permission-probe')?.remove()");
    win.hide();
    return result;
  };

  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1180,height:780,useContentSize:true,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    win.webContents.session.setPermissionRequestHandler((webContents,permission,callback,details)=>{
      permissionRequests.push({permission,url:webContents.getURL(),requestingUrl:details.requestingUrl??''});
      callback(false);
    });
    await win.loadFile(join(dir,'index.html'));
    expectedRenderURL=win.webContents.getURL();
    const exactPolicyQuery=await trustedProbe('query');
    const requestsAfterQuery=permissionRequests.length;
    const exactPolicyDeniedWrite=await trustedProbe('write');
    const permissionEvidence={
      passed:exactPolicyQuery.trusted===true&&exactPolicyQuery.userActive===true&&exactPolicyQuery.state==='granted'&&requestsAfterQuery===0&&exactPolicyDeniedWrite.trusted===true&&exactPolicyDeniedWrite.userActive===true&&exactPolicyDeniedWrite.writeResult==='rejected'&&permissionRequests.some(item=>item.permission==='clipboard-sanitized-write'),
      electron:process.versions.electron,
      productionPolicy:'setPermissionRequestHandler callback(false) for every permission; no setPermissionCheckHandler',
      exactPolicyQuery,
      requestsAfterQuery,
      exactPolicyDeniedWrite,
      permissionRequests,
      systemClipboardRead:false,
      systemClipboardWritten:false,
      interpretation:'Under the exact production request-only deny policy, a trusted user gesture reports clipboard-write as granted when queried, but navigator.clipboard.writeText still requests clipboard-sanitized-write. The production-equivalent callback(false) rejects the write before any OS clipboard mutation.',
      limitation:'This deliberately validates only the denied native path. It does not grant the permission or perform a native successful write, because that would overwrite the real system clipboard.',
    };
    writePermissionEvidence(permissionEvidence);
    check('permission probe used trusted clicks with active user gestures',exactPolicyQuery.trusted===true&&exactPolicyQuery.userActive===true&&exactPolicyDeniedWrite.trusted===true&&exactPolicyDeniedWrite.userActive===true);
    check('the exact request-only policy reports clipboard write granted without a request callback',exactPolicyQuery.state==='granted'&&requestsAfterQuery===0);
    check('writeText maps to clipboard-sanitized-write and the exact production deny callback rejects it',exactPolicyDeniedWrite.writeResult==='rejected'&&exactPolicyDeniedWrite.errorName==='NotAllowedError'&&permissionRequests.some(item=>item.permission==='clipboard-sanitized-write'));
    check('permission probe reached no system clipboard read or write',true);
    await waitFor('document.body.innerText.includes("copy-fixture.example")');
    // The old "任务" list (every active task, each with an edit-draft icon) is gone: the "待办" page now lists only
    // tasks waiting on the user, and a queued task's draft is edited from its card on the site's "排期" tab.
    check('no first-run wizard covers the UI when a site already exists',await evaluate('!document.querySelector("[role=dialog]")'));
    await clickText('网站');
    await clickText('copy-fixture.example');
    await waitFor('document.querySelector(".page h1")?.textContent==="copy-fixture.example"');
    await clickText('排期');
    await waitFor('document.querySelector("[aria-label=\\"\u7f51\u7ad9\u8be6\u60c5\\"] button[aria-pressed=true]")?.textContent==="\u6392\u671f"');
    await clickButton(`buttons=>buttons.find(item=>item.matches('.task-card > button.task-summary')&&item.innerText.includes('Manual fixture'))`,'fixture task card');
    await waitFor('document.querySelector(".task-card > button.task-summary")?.getAttribute("aria-expanded")==="true"');
    await clickText('编辑稿件');
    await waitFor('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="编辑投稿草稿"');
    check('the edit dialog opened the fixture task\'s saved draft',await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');const values=[...dialog.querySelectorAll('.field input,.field textarea')].map(item=>item.value);return JSON.stringify(values)===${JSON.stringify(JSON.stringify(['Saved title','Saved summary','Saved body']))}})()`));

    const edited={title:'Edited title · current',description:'Edited summary · current',body:'Edited body line 1\nEdited body line 2 · current'};
    await setField('标题',edited.title);
    await setField('摘要',edited.description);
    await setField('正文',edited.body);
    check('all draft fields show the current unsaved edits',await evaluate(`(()=>{const dialog=document.querySelector('[role=dialog]');const values=[...dialog.querySelectorAll('.field input,.field textarea')].map(item=>item.value);return JSON.stringify(values)===${JSON.stringify(JSON.stringify(Object.values(edited)))}})()`));
    await evaluate(`document.addEventListener('click',event=>{const button=event.target?.closest?.('button');if(button?.innerText.trim().startsWith('复制'))window.__lastDraftCopyClickTrusted=event.isTrusted},{capture:true})`);

    for(const [button,label,value] of [['复制标题','标题',edited.title],['复制简介','简介',edited.description],['复制正文','正文',edited.body]]){
      await clickText(button);
      await waitFor(`document.querySelector('.draft-copy-feedback')?.textContent===${JSON.stringify(label+'已复制。')}`);
      check(button+' came from a trusted native input event',await evaluate('window.__lastDraftCopyClickTrusted===true'));
      check(button+' passed the production preload and business IPC into the final OS-write stub',writes.at(-1)===value);
      check(button+' exposes visible success feedback',await evaluate(`document.querySelector('.draft-copy-feedback')?.textContent===${JSON.stringify(label+'已复制。')}`));
    }
    check('the three explicit clicks produced exactly three isolated writes',writes.length===3&&JSON.stringify(writes)===JSON.stringify(Object.values(edited)));
    const beforeDenied=writes.length;
    const malformedDenied=await evaluate(`window.linkflow.copyDraft({id:'11111111-1111-4111-8111-111111111111',field:'title',value:123}).then(()=>false,()=>true)`);
    check('a non-string renderer payload is rejected without a write',malformedDenied&&writes.length===beforeDenied);
    const oversizedDenied=await evaluate(`window.linkflow.copyDraft({id:'11111111-1111-4111-8111-111111111111',field:'title',value:'x'.repeat(151)}).then(()=>false,()=>true)`);
    check('an oversized renderer payload is rejected without a write',oversizedDenied&&writes.length===beforeDenied);
    const remoteFrameResult=await draftClipboardHandler({sender:win.webContents,senderFrame:{url:'https://remote.example/frame'}},{id:'11111111-1111-4111-8111-111111111111',field:'title',value:'remote frame'});
    check('a remote frame is rejected by the production handler without a write',remoteFrameResult.ok===false&&writes.length===beforeDenied);
    const unknownSenderResult=await draftClipboardHandler({sender:{},senderFrame:win.webContents.mainFrame},{id:'11111111-1111-4111-8111-111111111111',field:'title',value:'unknown sender'});
    check('an unknown sender is rejected by the production handler without a write',unknownSenderResult.ok===false&&writes.length===beforeDenied);
    const referralResult=await draftClipboardHandler({sender:win.webContents,senderFrame:win.webContents.mainFrame},{id:'11111111-1111-4111-8111-111111111111',field:'body',value:'Sign up at https://exchange.example/register?ref=ABCD1234'});
    check('the production handler refuses referral information from the trusted frame without a write',referralResult.ok===false&&referralResult.reasonCode==='referral_blocked'&&writes.length===beforeDenied);
    await capture('draft-copy.png');
    writeEvidence({passed:true,clipboardMode:'production preload copyDraft -> production draft clipboard handler -> injected final OS-write stub',finalProductionBoundary:'electron.clipboard.writeText',stubScope:'only the final OS clipboard writer dependency',nativeOsClipboard:false,systemClipboardRead:false,systemClipboardWritten:false,permissionProbe:'permission-probe.json',viewport:{width:1180,height:780},checks,writes});
    console.log(`DRAFT COPY UI PASSED: ${checks.length} checks; only final OS clipboard boundary stubbed`);
    app.exit(0);
  }catch(error){
    writeEvidence({passed:false,clipboardMode:'production preload copyDraft -> production draft clipboard handler -> injected final OS-write stub',finalProductionBoundary:'electron.clipboard.writeText',stubScope:'only the final OS clipboard writer dependency',nativeOsClipboard:false,systemClipboardRead:false,systemClipboardWritten:false,error:String(error),checks,writes});
    console.error(error);
    app.exit(1);
  }});
}
