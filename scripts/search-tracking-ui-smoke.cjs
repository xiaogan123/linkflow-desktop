const {join}=require('node:path');
const {mkdtempSync,writeFileSync,mkdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');
if(!process.versions.electron){
  (async()=>{
    const dir=mkdtempSync(join(tmpdir(),'linkflow-tracking-ui-')),root=process.cwd();
    // Fixture: site-0 carries a 20000-source GSC report, site-1 has only a historical GSC finding plus a failed Bing check that retained its old sample,
    // site-2 has no report at all, site-3 has no GSC report but a failed Bing check whose retained sample contains its own published page.
    // Every task is a live published page, so it carries firstLiveAt like real live tasks do.
    await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify(join(root,'src/ui/App.tsx'))};import {demoSnapshot} from ${JSON.stringify(join(root,'src/ui/demo.ts'))};import ${JSON.stringify(join(root,'src/ui/styles.css'))};
      window.fixtureCount=50;window.fixtureSnapshot=()=>{const stamp='2026-01-01T00:00:00.000Z';const failedBing=url=>({checkedAt:stamp,method:'api',complete:false,error:true,message:'Synthetic request failed',sources:[url]});const sites=Array.from({length:window.fixtureCount},(_,i)=>({...demoSnapshot.sites[0],id:'site-'+i,domain:'site-'+i+'.example',url:'https://site-'+i+'.example',name:'Fixture '+i,status:'ready',searchReports:i===2?{}:i===3?{bing:failedBing('https://source.example/3')}:{gsc:{checkedAt:stamp,method:'csv',complete:false,message:'Synthetic source report',sources:i===0?Array.from({length:20000},(_,j)=>'https://source.example/'+j):[],firstSeenAt:i===1?{'https://source.example/1':stamp}:{}},bing:i===1?failedBing('https://source.example/1'):undefined}}));return {...demoSnapshot,sites,tasks:sites.map((site,i)=>({...demoSnapshot.tasks[0],id:'task-'+i,siteId:site.id,publicUrl:'https://source.example/'+i,status:'live',linkCheck:i===1?'absent':'found',firstLiveAt:stamp,verifiedAt:stamp,lastCheckedAt:stamp,updatedAt:stamp})),accounts:[],mailboxes:[],capacity:[],runtime:{...demoSnapshot.runtime,version:'1.2.35',busy:false},settings:{...demoSnapshot.settings,autoRun:false,hasBingKey:false}}};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},outfile:join(dir,'ui.js'),bundle:true,platform:'browser',jsx:'automatic'});
    writeFileSync(join(dir,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
    writeFileSync(join(dir,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('linkflow',{invoke:(name,payload)=>ipcRenderer.invoke('fixture',name,payload),onChange:callback=>{const listener=()=>callback();ipcRenderer.on('fixture-change',listener);return()=>ipcRenderer.removeListener('fixture-change',listener)},onUpdate:()=>()=>{}});`);
    const child=require('node:child_process').spawn(require('electron'),[__filename,dir],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}}),timer=setTimeout(()=>child.kill(),60000);child.once('exit',code=>{clearTimeout(timer);process.exitCode=code??1});
  })().catch(error=>{console.error(error.message);process.exitCode=1});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron'),dir=process.argv[2],checks=[],calls=[],timings=[];
  app.setPath('userData',join(dir,'profile'));let win,importCalls=0;
  const evaluate=js=>win.webContents.executeJavaScript(js,true),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),check=(label,value)=>{assert(value,label);checks.push(label)};
  const waitFor=async(js,timeout=3000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(js))return true;await delay(40)}return false};
  const waitCall=async(name,timeout=3000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(calls.some(call=>call.name===name))return true;await delay(40)}return false};
  // Click a visible, enabled button whose text is exactly `text`, optionally inside `scope` (the sidebar and the site page both have buttons such as 外链 / 设置).
  const click=async(text,scope='body')=>{assert(await evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});const b=root&&[...root.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.click();return true})()`),'click '+text+' in '+scope);await delay(80)};
  const nav=text=>click(text,'nav[aria-label="主导航"]');
  const select=async(label,value)=>{assert(await evaluate(`(()=>{const el=document.querySelector('select[aria-label="'+${JSON.stringify(label)}+'"]');if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),'select '+label);await delay(80)};
  const search=async value=>evaluate(`new Promise(resolve=>{const start=performance.now(),el=document.querySelector('input[aria-label="搜索外链"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})`);
  const ROWS='.links-page .work-table>tbody>tr';
  const rowCount=()=>evaluate(`document.querySelectorAll(${JSON.stringify(ROWS)}).length`);
  // Cell texts of the links-page table row whose first cell is exactly `domain`, or null.
  const row=domain=>evaluate(`(()=>{const tr=[...document.querySelectorAll(${JSON.stringify(ROWS)})].find(tr=>tr.cells[0]&&tr.cells[0].innerText.trim()===${JSON.stringify(domain)});return tr?[...tr.cells].map(td=>td.innerText.trim()):null})()`);
  const pressed=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('[aria-label="外链视图"] button')].find(b=>b.innerText.trim()===${JSON.stringify(label)});return !!b&&b.getAttribute('aria-pressed')==='true'})()`);
  const statusText=()=>evaluate(`(document.querySelector('.links-page [role="status"]')||{}).innerText||''`);
  const errorText=()=>evaluate(`(document.querySelector('[role="alert"]')||{}).innerText||''`);
  ipcMain.handle('fixture',async(_event,name,payload)=>{calls.push({name,payload});if(name==='snapshot')return evaluate('window.fixtureSnapshot()');if(name==='app:ready')return true;if(name==='app:update-status')return {phase:'idle',currentVersion:'1.2.35'};if(name==='search:import-gsc-batch')return ++importCalls===1?{imported:[],unassigned:[],cancelled:true}:{imported:[{siteId:'site-0',domain:'site-0.example',sources:20000}],unassigned:['other-property.csv']};if(name==='task:verify')return {ok:true};throw Error('Unexpected fixture action '+name)});
  app.whenReady().then(async()=>{try{
    win=new BrowserWindow({width:1360,height:950,show:false,webPreferences:{preload:join(dir,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});await win.loadFile(join(dir,'index.html'));await delay(250);
    check('first snapshot loads without an unexpected IPC failure',await waitFor('!!document.querySelector(\'nav[aria-label="主导航"]\')&&!document.querySelector(\'[role="alert"]\')'));
    for(const count of [50,100]){
      if(count===100){await nav('总览');await evaluate('window.fixtureCount=100');win.webContents.send('fixture-change');await delay(150)}
      const ms=await evaluate(`new Promise(resolve=>{const start=performance.now();[...document.querySelectorAll('nav[aria-label="主导航"] button')].find(b=>b.innerText.trim()==='外链').click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)))})`);timings.push({sites:count,openMs:ms});
      check(count+' sites render the links page within 5 seconds',ms<5000);
      check(count+' sites render exactly one row per published link and none for the 20000 report sources',await rowCount()===count);
      check(count+' sites summary counts every link and excludes the missing one from active links',await evaluate(`document.querySelector('.links-page').innerText.includes(${JSON.stringify(`共 ${count} 条 · 现在有效 ${count-1} 条`)})`));
    }
    const site1=await row('site-1.example');check('historical GSC finding survives sample absence and current HTML failure',!!site1&&site1[4].includes('找不到了')&&site1[6]==='已出现');
    const site3=await row('site-3.example');check('failed Bing request does not expose its retained sample as a Google finding',!!site3&&site3[4].includes('有效')&&site3[6]==='—');
    const unmatchedMs=await search('/19999');check('an imported report source that is not a published link is not listed as a link',await rowCount()===0&&await evaluate('document.querySelector(".links-page").innerText.includes("没有符合条件的外链。")'));
    const searchMs=await search('source.example/42');timings.push({sites:100,searchMs,unmatchedMs});check('link URL search responds and isolates the matching published page',searchMs<5000&&unmatchedMs<5000&&await rowCount()===1&&!!await row('site-42.example'));
    await search('');check('clearing the search restores every link',await rowCount()===100);
    await select('按网站筛选','site-2');check('site filter isolates the selected site',await rowCount()===1&&!!await row('site-2.example'));
    await click('site-2.example','.links-page');await click('设置','[aria-label="网站详情"]');check('missing report is not presented as a successful empty import on the site page',await evaluate('(()=>{const t=document.querySelector(".site-tools").innerText;return t.includes("尚未导入 Google 报告")&&!t.includes("已发布外链曾被报告")&&!t.includes("导入失败")})()'));
    await click('查看该站追踪','.site-tools');check('per-site tracking entry opens the links page preselected to that site',await evaluate('document.querySelector(\'select[aria-label="按网站筛选"]\').value==="site-2"')&&await rowCount()===1&&!!await row('site-2.example'));
    await select('按网站筛选','all');
    const before=calls.length;await click('Google 报告','[aria-label="外链视图"]');check('Google report view switches by pressed button without refetching',await pressed('Google 报告')&&!await pressed('全部外链')&&calls.length===before);
    check('Google report view lists one row per site',await rowCount()===100);
    const g0=await row('site-0.example'),g1=await row('site-1.example'),g2=await row('site-2.example'),g3=await row('site-3.example');
    check('20000-source report is summarized to the published links it contains',!!g0&&g0[1].includes('1月1日')&&g0[2]==='1');
    check('historical GSC finding is counted in the Google report view',!!g1&&g1[2]==='1');
    check('missing report is not presented as a successful empty import',!!g2&&g2[1]==='还没导入'&&g2[2]==='0');
    check('failed Bing request is not presented as an imported Google report',!!g3&&g3[1]==='还没导入'&&g3[2]==='0');
    await click('导入报告','.links-page');check('cancelled batch import calls the batch importer without a site and reports nothing',calls.filter(call=>call.name==='search:import-gsc-batch').length===1&&calls.find(call=>call.name==='search:import-gsc-batch').payload===undefined&&!await statusText()&&!await errorText());
    await click('导入报告','.links-page');check('batch import reports imported sites and files it could not assign',await waitFor(`(document.querySelector('.links-page [role="status"]')||{}).innerText?.includes('已导入 1 个网站的 Google 报告。')&&document.querySelector('.links-page [role="status"]').innerText.includes('other-property.csv')`));
    await click('全部外链','[aria-label="外链视图"]');check('all-links view is restored by its pressed button',await pressed('全部外链')&&await rowCount()===100);
    await click('site-1.example','.links-page');check('site page link table agrees with the links page',await evaluate('(()=>{const tr=document.querySelector(".work-table>tbody>tr");return !!tr&&tr.innerText.includes("找不到了")&&tr.innerText.includes("已出现")})()'));
    await click('排期','[aria-label="网站详情"]');assert(await evaluate('(()=>{const cards=document.querySelectorAll(".task-card");if(cards.length!==1)return false;cards[0].querySelector(".task-summary").click();return true})()'),'open the only task card of site-1');await delay(80);
    await click('检查链接','.task-card');check('verification remains bound to the displayed task',await waitCall('task:verify')&&calls.some(call=>call.name==='task:verify'&&call.payload.id==='task-1')&&!calls.some(call=>call.name==='task:verify'&&call.payload.id!=='task-1'));
    check('renderer reports ready exactly once',calls.filter(call=>call.name==='app:ready').length===1);
    check('link and report views never call AI, publication or background scans',calls.every(call=>['snapshot','app:ready','app:update-status','search:import-gsc-batch','task:verify'].includes(call.name)));
    await nav('外链');const output=join(process.cwd(),'.evidence/search-tracking');mkdirSync(output,{recursive:true,mode:0o700});writeFileSync(join(output,'tracking.png'),(await win.webContents.capturePage()).toPNG());writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,checks,timings,platform:process.platform,windowsNative:process.platform==='win32',fixtureOnly:true},null,2));console.log(JSON.stringify({passed:true,checks:checks.length,timings,platform:process.platform}));app.exit(0);
  }catch(error){console.error(error.stack);app.exit(1)}});
}
