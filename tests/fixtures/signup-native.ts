/** Standalone fixture only. No production entrypoint or user profile is loaded. */
import {app,BrowserWindow,session,net} from 'electron';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runSignupScript,type SignupExecutionInput,type SignupScript} from '../../src/integrations/signup-executor';
import {signupBrowserPort,taskActionScript,taskObservationScript} from '../../src/integrations/browser';
import mock from '../../src/integrations/signup-scripts/mock-local.json';

const config=JSON.parse(process.argv[2]) as {dir:string;origin:string;resultPath:string};
app.setPath('userData',path.join(config.dir,'profile'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const ses=session.fromPartition('signup-local-test');let external=0;
  ses.protocol.handle('https',request=>{
    const url=new URL(request.url);
    if(url.hostname!=='example.com'){external++;throw Error('External request forbidden');}
    return net.fetch(config.origin+url.pathname);
  });
  const make=()=>new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let window=make(),port=signupBrowserPort(window,['example.com']),ready=false;
  const secrets=new Map<string,string>();
  let consented=true;
  const makeInput=():SignupExecutionInput=>({taskId:'mock-task',identity:{id:'mock-account',username:'example_user',email:'owner@example.com',password:async()=> 'mock-password'},financialContent:false,browser:port,hooks:{persist:async()=>{},awaitEmail:async()=>ready?'123456':undefined,hasSiteOwnerSignupConsent:()=>consented},secrets:{set:async(key,value)=>{secrets.set(key,value);}},signal:new AbortController().signal});
  // Without owner consent the first irreversible submit is held and nothing is dispatched.
  consented=false;
  const held=await runSignupScript(mock as SignupScript,makeInput());
  assert.equal(held.status,'human');assert.equal(held.state.humanReason,'consent_required');assert.equal(await window.webContents.executeJavaScript('window.dispatches'),0);
  consented=true;
  const first=await runSignupScript(mock as SignupScript,makeInput());
  assert.equal(first.status,'waiting_email');assert.equal(await window.webContents.executeJavaScript('window.dispatches'),1);
  const restarted={...makeInput(),browser:{...port,runtimeId:'different-runtime'},state:first.state};
  const unknown=await runSignupScript(mock as SignupScript,restarted);
  assert.equal(unknown.state.humanReason,'window_lost');assert.equal(await window.webContents.executeJavaScript('window.dispatches'),1);
  ready=true;const done=await runSignupScript(mock as SignupScript,{...makeInput(),state:first.state});
  assert.equal(done.status,'done');assert.equal(secrets.get('signup:mock-task:api_key'),'mock-local-api-key');
  if(!window.isDestroyed())await new Promise<void>(resolve=>window.once('closed',()=>resolve()));
  window=make();port=signupBrowserPort(window,['example.com']);
  await window.loadURL('https://example.com/signup');
  await window.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<div class="g-recaptcha" style="width:20px;height:20px">Captcha</div>')`);
  const captchaScript={...mock,steps:mock.steps.slice(1)} as SignupScript;
  const captcha=await runSignupScript(captchaScript,makeInput());
  assert.equal(captcha.state.humanReason,'captcha');assert.equal(await window.webContents.executeJavaScript('window.dispatches'),0);window.destroy();
  window=make();port=signupBrowserPort(window,['example.com']);
  await window.loadURL('https://example.com/signup');
  await window.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend','<form id="external-form" action="https://outside.example/register"><input name="action" value="register" type="hidden"><input id="external-email" type="email"><button id="external-submit">Register external</button></form>');document.querySelector('#external-form').onsubmit=e=>{e.preventDefault();window.dispatches++;};void 0;`);
  const isolated=async<T>(code:string)=>await window.webContents.executeJavaScriptInIsolatedWorld(999,[{code}]) as T;
  assert.equal(await isolated(`document.querySelector('#external-form').action instanceof HTMLInputElement`),true);
  assert.equal(await port.probeIrreversible('#external-submit'),'unsafe');
  assert.equal(await port.act('irreversible','#external-submit'),false);
  assert.equal(await port.act('fill','#external-email','owner@example.com',undefined,'identity.email'),false);
  const observed=await isolated<{controls:Array<{id:number;label:string;tag:string;type:string;name:string;href:string;formAction?:string;signature:string}>}>(taskObservationScript([]));
  const externalControl=observed.controls.find(control=>control.label==='Register external');assert(externalControl);
  assert.equal(externalControl.formAction,'https://outside.example/register');
  assert.equal(await isolated(taskActionScript(externalControl,{kind:'click',id:externalControl.id,ref:'none',option:0,purpose:'register',reason:''},['example.com'])),false);
  assert.equal(await window.webContents.executeJavaScript('window.dispatches'),0);window.destroy();
  window=make();port=signupBrowserPort(window,['example.com']);ready=false;
  const manualWait=await runSignupScript(mock as SignupScript,makeInput());assert.equal(manualWait.status,'waiting_email');
  await window.webContents.executeJavaScript(`document.querySelector('#code').value='123456';document.querySelector('#verify-form').requestSubmit();`);
  assert.equal(await window.webContents.executeJavaScript('window.verifications'),1);
  const finalActions:string[]=[];
  const manuallyDone=await runSignupScript(mock as SignupScript,{...makeInput(),browser:{...port,runtimeId:'replacement-after-manual',act:async(...args)=>{finalActions.push(args[0]);return port.act(...args);}},state:manualWait.state});
  assert.equal(manuallyDone.status,'done');assert.equal(secrets.get('signup:mock-task:api_key'),'mock-local-api-key');
  assert.deepEqual(finalActions,['extract']);
  assert.equal(external,0);
  await writeFile(config.resultPath,JSON.stringify({passed:true,externalRequests:external,scenarios:6}));
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
