import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import type {BrowserWindow} from 'electron';
import { classifyAccountPage, classifyControl, ensureAccount, isAllowedTaskUrl, isAllowedVerificationUrl, isDestructiveControl, isTaskVerificationUrl, loadTaskVerificationUrl, redactStructuredSecrets, redactTaskVerificationData, selectPublicUrl, taskBrowserLoadError, taskObservationScript, taskVerificationNeedsConfirmation, verifyPendingAccount } from '../src/integrations/browser';
import type {ExecutionContext,Account} from '../src/shared/types';

const control = (label: string, type = 'button') => ({ id: 0, tag: 'button', type, label, name: '', href: '', signature: '' });

test('navigation is limited to HTTPS channel hosts', () => {
  const hosts = ['example.com'];
  assert.equal(isAllowedTaskUrl('https://example.com/submit', hosts), true);
  assert.equal(isAllowedTaskUrl('https://app.example.com/submit', hosts), true);
  assert.equal(isAllowedTaskUrl('https://example.com.evil.test/', hosts), false);
  assert.equal(isAllowedTaskUrl('http://example.com/', hosts), false);
  assert.equal(isAllowedTaskUrl('https://user:pass@example.com/', hosts), false);
});

test('verification links cannot target another user-hosted platform subdomain',async()=>{
  assert.equal(isAllowedVerificationUrl('https://attacker.carrd.co/confirm?token=private',['carrd.co','carrd.com']),false);
  assert.equal(isAllowedVerificationUrl('https://attacker.prose.sh/verify?token=private',['prose.sh']),false);
  assert.equal(isAllowedVerificationUrl('https://attacker.mataroa.blog/verify?token=private',['mataroa.blog']),false);
  assert.equal(isAllowedVerificationUrl('https://carrd.co/confirm?token=private',['carrd.co']),true);
  const {window}=verificationWindow();
  await assert.rejects(loadTaskVerificationUrl(window,'https://attacker.carrd.co/confirm?token=private',['carrd.co'],new AbortController().signal),/允许/);
});

test('browser load errors explain blocked redirects without exposing URLs or credentials', () => {
  const blocked=taskBrowserLoadError(Object.assign(new Error("placeholder"),{code:"ERR_BLOCKED_BY_CLIENT",errno:-20}));
  assert.match(blocked.message,/允许域名/);
  assert.doesNotMatch(blocked.message,/accounts\.google|fixture-secret|https:/);
  const offline=taskBrowserLoadError(new Error("ERR_NAME_NOT_RESOLVED loading 'https://private.example/?password=fixture-secret'"));
  assert.match(offline.message,/检查网络/);
  assert.doesNotMatch(offline.message,/private\.example|fixture-secret|https:/);
});

test('paid paths and submissions are classified before clicking', () => {
  assert.equal(classifyControl(control('Upgrade to paid plan')), 'destructive');
  assert.equal(classifyControl(control('Publish listing')), 'submission');
  assert.equal(classifyControl({ ...control('Create account'), formHasInput: true }), 'registration');
  assert.equal(classifyControl(control('', 'submit')), 'uncertain');
  assert.equal(classifyControl({ ...control('Sign up'), tag: 'a', href: 'https://example.com/register' }), 'navigation');
  assert.equal(classifyControl({ ...control('Sign up'), formHasInput: true }), 'registration');
  assert.equal(classifyControl({ ...control('Publish listing'), tag: 'a', href: 'https://example.com/publish' }), 'submission');
  assert.equal(classifyControl(control('Continue')), 'uncertain');
});

test('destructive labels, paths and form targets require a human', () => {
  assert.equal(isDestructiveControl({ label: 'Delete account', name: '', href: '' }), true);
  assert.equal(isDestructiveControl({ label: 'Continue', name: '', href: 'https://example.com/reset-password' }), true);
  assert.equal(isDestructiveControl({ label: 'Continue', name: '', href: 'https://example.com/%64elete-account' }), true);
  assert.equal(isDestructiveControl({ label: 'Submit', name: '', href: '', formAction: 'https://example.com/billing' }), true);
  assert.equal(classifyControl({ ...control('Manage'), handlerHint: "fetch('/revoke-token',{method:'POST'})" }), 'destructive');
  assert.equal(isDestructiveControl({ label: 'Publish listing', name: '', href: 'https://example.com/publish' }), false);
});

test('public URL requires observed target link or a successful view-result link', () => {
  const submit = 'https://example.com/submit';
  assert.equal(selectPublicUrl({ current: 'https://example.com/listing/123', targetPresent: true, resultLinks: [], text: 'Example' }, submit, ['example.com']), 'https://example.com/listing/123');
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://example.com/listing/123'], text: 'Published successfully' }, submit, ['example.com']), 'https://example.com/listing/123');
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://evil.test/listing/123'], text: 'Published successfully' }, submit, ['example.com']), undefined);
  assert.equal(selectPublicUrl({ current: submit, targetPresent: false, resultLinks: ['https://example.com/listing/123'], text: 'Submission form' }, submit, ['example.com']), undefined);
});

const accountPage=(text:string,password=true,labels:string[]=[])=>({text,controls:[...(password?[{label:'Password',type:'password',formHasPassword:true}]:[]),...labels.map(label=>({label,type:'button'}))]});

test('account page evidence distinguishes recoverable registration from credential and platform restrictions',()=>{
  assert.equal(classifyAccountPage(accountPage('That username is already taken.')),'username_taken');
  assert.equal(classifyAccountPage(accountPage('This email is already registered.')),'email_exists');
  assert.equal(classifyAccountPage(accountPage('Incorrect password. Try again.')),'bad_password');
  assert.equal(classifyAccountPage(accountPage('Your account has been suspended.')),'restricted');
  assert.equal(classifyAccountPage(accountPage('Check your inbox. A verification email was sent.')),'verification_required');
  assert.equal(classifyAccountPage(accountPage('We could not complete your request.')),'unknown');
});

test('authenticated and verified evidence wins only when explicit',()=>{
  assert.equal(classifyAccountPage(accountPage('Dashboard',false,['My account','Log out'])),'authenticated');
  assert.equal(classifyAccountPage(accountPage('Your account has been suspended.',false,['My account','Log out'])),'restricted');
  assert.equal(classifyAccountPage(accountPage('Email has been verified',false)),'verified');
  assert.equal(classifyAccountPage(accountPage('Verification failed',false)),'unknown');
});

test('registration human outcomes leave the submitted checkpoint and do not re-enter mail waiting',async()=>{
  for(const scenario of [
    {text:'This email is already registered.',emailRequired:true,attempts:1},
    {text:'Registration failed.',emailRequired:true,attempts:1},
    {text:'That username is already taken.',emailRequired:true,attempts:2},
    {text:'We could not complete your request.',emailRequired:false,attempts:1},
  ]){
    const contents=new EventEmitter();let account={status:'draft',source:'generated',registrationAttempts:scenario.attempts} as Account;
    const window={isDestroyed:()=>false,webContents:Object.assign(contents,{executeJavaScriptInIsolatedWorld:async()=>({text:scenario.text,controls:[]})})} as unknown as BrowserWindow;
    let mailCalls=0;
    const context={task:{checkpoint:'account_registration_submitted'},channel:{emailRequired:scenario.emailRequired},getAccount:()=>account,saveAccount:async(value:Account)=>{account=value;},signupHooks:{awaitEmail:async()=>{mailCalls++;return undefined;}},site:{domain:'example.com'},signal:new AbortController().signal} as unknown as ExecutionContext;
    const result=await verifyPendingAccount(context,window);
    assert.equal(result&&result!=='retrying'?result.checkpoint:undefined,'account_registration_human');
    assert.equal(result&&result!=='retrying'?result.status:undefined,'needs_input');
    assert.equal(mailCalls,0);
  }
});

test('an opened verification link with unknown result becomes a registration human checkpoint',async()=>{
  const contents=new EventEmitter();let current='https://example.com/signup',account={status:'draft',source:'generated',registrationAttempts:1} as Account;
  const window=Object.assign(new EventEmitter(),{isDestroyed:()=>false,webContents:Object.assign(contents,{
    getURL:()=>current,
    executeJavaScriptInIsolatedWorld:async()=>({text:current.includes('/verify')?'No confirmed status yet.':'Check your inbox. A verification email was sent.',controls:[]}),
  }),loadURL:async(url:string)=>{current=url;}}) as unknown as BrowserWindow;
  const context={task:{checkpoint:'account_registration_submitted'},channel:{emailRequired:true,allowedHosts:['example.com']},getAccount:()=>account,saveAccount:async(value:Account)=>{account=value;},signupHooks:{awaitEmail:async()=> 'https://example.com/verify?token=private'},site:{domain:'example.com'},signal:new AbortController().signal} as unknown as ExecutionContext;
  const result=await verifyPendingAccount(context,window);
  assert.equal(result&&result!=='retrying'?result.checkpoint:undefined,'account_registration_human');
  assert.equal(result&&result!=='retrying'?result.status:undefined,'needs_input');
});

test('an email-exists diagnostic survives an inconclusive manual recheck without reading mail',async()=>{
  const contents=new EventEmitter();let text='This email is already registered.',account={status:'draft',source:'generated',registrationAttempts:1} as Account;
  let mailCalls=0;
  const window={isDestroyed:()=>false,webContents:Object.assign(contents,{executeJavaScriptInIsolatedWorld:async()=>({text,controls:[]})})} as unknown as BrowserWindow;
  const context={task:{checkpoint:'account_registration_submitted'},channel:{emailRequired:true},getAccount:()=>account,saveAccount:async(value:Account)=>{account=value;},signupHooks:{awaitEmail:async()=>{mailCalls++;return undefined;}},site:{domain:'example.com'},signal:new AbortController().signal} as unknown as ExecutionContext;
  const first=await verifyPendingAccount(context,window);assert.equal(first&&first!=='retrying'?first.checkpoint:undefined,'account_registration_human');
  assert.equal(account.diagnostic?.code,'email_exists');
  text='No conclusive account status.';
  const second=await verifyPendingAccount(context,window,true);
  assert.equal(second&&second!=='retrying'?second.checkpoint:undefined,'account_registration_human');
  assert.equal(account.diagnostic?.code,'email_exists');assert.equal(mailCalls,0);
});

test('browser identity uses an alias only when the mailbox is verified and healthy',async()=>{
  const mailbox={id:'mailbox',host:'imap.gmail.com',user:'owner@gmail.com',hasPassword:true,verifiedAt:'2026-10-18T00:00:00.000Z'};
  for(const [candidate,alias] of [[mailbox,true],[{...mailbox,verifiedAt:undefined},false],[{...mailbox,lastError:'Authentication failed'},false]] as const){
    let saved:Account|undefined;
    const context={getAccount:()=>undefined,saveAccount:async(value:Account)=>{saved=value;},channel:{id:'mock-local'},site:{id:'site',domain:'example.com',publicEmail:'owner@example.com',email:'owner@example.com'},mailbox:candidate} as unknown as ExecutionContext;
    await ensureAccount(context);
    assert(saved);
    if(alias)assert.match(saved.email,/^owner\+lf[a-z0-9]+@gmail\.com$/);
    else assert.equal(saved.email,'owner@example.com');
  }
});

test('structured secret redaction handles JSON-sensitive passwords before serialization',()=>{
  const password='quote" and slash\\ fixture';
  const redacted=redactStructuredSecrets({text:`Error echoed ${password}`,controls:[{label:password,nested:{value:password}}]},[password]);
  assert.equal(redacted.text,'Error echoed [redacted]');
  assert.equal(redacted.controls[0].label,'[redacted]');
  assert.equal(redacted.controls[0].nested.value,'[redacted]');
  assert.equal(JSON.stringify(redacted).includes(password),false);
});

function verificationWindow(load?:(url:string,contents:EventEmitter)=>Promise<string>){
  const events=new EventEmitter(),contents=new EventEmitter();let current='https://example.com/register',destroyed=false;
  const window=Object.assign(events,{webContents:Object.assign(contents,{getURL:()=>current}),isDestroyed:()=>destroyed,loadURL:async(url:string)=>{current=load?await load(url,contents):url;},close:()=>{destroyed=true;events.emit('closed')}});
  return {window:window as unknown as BrowserWindow,contents,close:window.close};
}

test('mail action paths, queries, fragments and encoding are redacted only from the outgoing copy',async()=>{
  const {window,contents}=verificationWindow(),signal=new AbortController().signal;
  const secret='mail/Action+7=XYZ',encoded=encodeURIComponent(secret),query='querySecret_987',fragment='fragmentSecret_456';
  const link=`https://example.com/confirm-email/${encoded}?code=${query}#proof=${fragment}`;
  await loadTaskVerificationUrl(window,link,['example.com'],signal);
  const data={url:link,text:`${secret} ${encoded} ${encodeURIComponent(encoded)} ${query} ${fragment}`,controls:[{label:secret,href:link,formAction:link,signature:`input|${link}`,options:[query]}]};
  const before=structuredClone(data),safe=JSON.stringify(redactTaskVerificationData(window,data));
  for(const value of [secret,encoded,encodeURIComponent(encoded),query,fragment])assert(!safe.includes(value),value);
  assert.deepEqual(data,before);assert.equal(data.controls[0].signature,`input|${link}`);
  assert.equal(redactTaskVerificationData(window,'https://example.com/articles/overview'),'https://example.com/articles/overview');
  assert.equal(contents.listenerCount('did-redirect-navigation'),0);
});

test('new verification paths require confirmation and known query secrets remain protected',async()=>{
  const initial='initialSecret_123',redirected='redirectSecret_456',landing='landingSecret_789';
  const {window,contents}=verificationWindow(async(_url,contents)=>{
    contents.emit('did-redirect-navigation',{},`https://example.com/callback/${redirected}`,false,true);
    return `https://example.com/activated?proof=${landing}`;
  });
  await loadTaskVerificationUrl(window,`https://example.com/activate/${initial}`,['example.com'],new AbortController().signal);
  const safe=redactTaskVerificationData(window,{text:`${initial} ${redirected} ${landing}`,href:`https://example.com/callback/${redirected}`});
  for(const value of [initial,landing])assert(!JSON.stringify(safe).includes(value));
  assert.equal(taskVerificationNeedsConfirmation(window),true);
  assert.equal(redactTaskVerificationData(window,'dashboard callback appears'),'dashboard callback appears');
  assert.equal(contents.listenerCount('did-redirect-navigation'),0);
});

test('failed mail navigation returns fixed errors while keeping same-window observations protected',async()=>{
  for(const cause of ['ERR_BLOCKED_BY_CLIENT (-20)','ERR_NAME_NOT_RESOLVED']){
    const token='failedSecret_123',link=`https://example.com/verify/${token}`;
    const {window,contents,close}=verificationWindow(async()=>{throw new Error(`${cause} ${link}`)});
    await assert.rejects(loadTaskVerificationUrl(window,link,['example.com'],new AbortController().signal),error=>error instanceof Error&&!error.message.includes(token)&&!error.message.includes('https:'));
    assert.equal(redactTaskVerificationData(window,token),'[redacted]');
    assert.equal(contents.listenerCount('did-redirect-navigation'),0);
    close();assert.equal(redactTaskVerificationData(window,token),token);
  }
});

test('aborted verification navigation clears task-local secrets and listeners without waiting for the page',async()=>{
  const controller=new AbortController(),token='cancelSecret_123';
  const {window,contents}=verificationWindow(async()=>new Promise<string>(()=>{}));
  const pending=loadTaskVerificationUrl(window,`https://example.com/verify/${token}`,['example.com'],controller.signal);
  controller.abort();await assert.rejects(pending,/任务已取消/);
  assert.equal(contents.listenerCount('did-redirect-navigation'),0);assert.equal(redactTaskVerificationData(window,token),token);
});

test('verification protection is isolated by window and closing never alters ordinary page paths',async()=>{
  const first=verificationWindow(),second=verificationWindow(),token='isolatedSecret_123';
  await loadTaskVerificationUrl(first.window,`https://example.com/verify/${token}`,['example.com'],new AbortController().signal);
  assert.equal(redactTaskVerificationData(second.window,token),token);
  first.close();assert.equal(redactTaskVerificationData(first.window,token),token);
  assert.equal(redactTaskVerificationData(second.window,'https://example.com/profile/settings'),'https://example.com/profile/settings');
});

test('disallowed verification origins are rejected before navigation or secret retention',async()=>{
  let calls=0;const {window}=verificationWindow(async(url)=>{calls++;return url});
  await assert.rejects(loadTaskVerificationUrl(window,'https://other.example/verify/otherSecret_123',['example.com'],new AbortController().signal),/允许/);
  assert.equal(calls,0);assert.equal(redactTaskVerificationData(window,'otherSecret_123'),'otherSecret_123');
});


test('ordinary verification landings do not taint unrelated public URLs',async()=>{
  for(const route of ['/', '/app']){
    const {window,close}=verificationWindow(async()=>`https://example.com${route}`);
    const link='https://example.com/verify/fixtureMailCredential_123';
    await loadTaskVerificationUrl(window,link,['example.com'],new AbortController().signal);
    for(const value of ['https://example.com/articles/real-public','https://example.com/app/articles/real-public','app appears applied'])assert.equal(redactTaskVerificationData(window,value),value);
    assert.equal(isTaskVerificationUrl(window,'https://example.com/app/articles/real-public'),false);
    assert.equal(isTaskVerificationUrl(window,link),true);
    assert.equal(isTaskVerificationUrl(window,'https://example.com/articles/fixtureMailCredential_123'),true);
    assert.equal(isTaskVerificationUrl(window,'https://example.com/articles?proof=fixtureMailCredential_123'),true);
    assert.equal(taskVerificationNeedsConfirmation(window),route!=='/');
    close();assert.equal(taskVerificationNeedsConfirmation(window),false);
  }
});

test('complete observed fields are masked before limits without changing raw DOM signatures',()=>{
  const token='fixtureMailCredential_123456789', password='fixturePassword_987654321';
  const label='l'.repeat(155)+token, name='n'.repeat(95)+token, option='o'.repeat(95)+token;
  const href='https://example.com/'+ 'p'.repeat(478)+token;
  const el={tagName:'SELECT',innerText:label,labels:null,form:null,href:'',options:[{text:option}],selectedIndex:0,
    getBoundingClientRect:()=>({width:100,height:20}),getAttribute:(key:string)=>key==='name'?name:null,hasAttribute:()=>false};
  const body='b'.repeat(4990)+token+' '+password;
  const observation=vm.runInNewContext(taskObservationScript([token,password]),{document:{body:{innerText:body},querySelectorAll:(selector:string)=>selector.startsWith('a,button')?[el]:[]},location:{href},URL,getComputedStyle:()=>({visibility:'visible',display:'block'})});
  assert.equal(observation.text,body.slice(0,5000));
  assert.equal(observation.controls[0].signature,['select','',name.slice(0,100),label.slice(0,160),'','',''].join('|'));
  const serialized=JSON.stringify(observation.model);
  assert(!serialized.includes(token.slice(0,5)));assert(!serialized.includes(password));
  assert.equal(observation.model.text,'b'.repeat(4990)+'[redacted]');
  assert.equal(observation.model.controls[0].label,( 'l'.repeat(155)+'[redacted]').slice(0,160));
  assert.equal(observation.model.controls[0].name,( 'n'.repeat(95)+'[redacted]').slice(0,100));
  assert.equal(observation.model.controls[0].options[0],( 'o'.repeat(95)+'[redacted]').slice(0,100));
  assert.equal(observation.model.url,('https://example.com/'+'p'.repeat(478)+'[redacted]').slice(0,500));
});
