import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {isMailAuthenticationError,mailboxClientOptions,MAX_LINKS,resolveVerificationLink,resolveVerificationLinkDetailed,scanVerification,scanVerificationBatch,testMailbox,verificationCodes,type ScanMessage,type VerificationMailClient} from '../src/integrations/mail';
import {generateMailAlias,mailboxAutomationReady,mailboxUsageCounts,type EmailWait} from '../src/shared/mail-automation';
import {saveMailboxAndTestAtomic,saveMailboxAtomic,importMailboxesAndTestAtomic} from '../src/main/mailbox-service';
import {Store} from '../src/main/store';
import type {ExecutionContext,Mailbox} from '../src/shared/types';
import type {PublicFetchDependencies} from '../src/integrations/web';

const stamp='2026-10-18T10:00:00.000Z',now=new Date('2026-10-18T10:05:00.000Z');
const mailbox:Mailbox={id:'11111111-1111-4111-8111-111111111111',label:'Fixture',host:'imap.gmail.com',port:993,user:'owner@example.com',secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp};
function context(wait?:Partial<EmailWait>):ExecutionContext {
  return {mailbox,settings:{mail:mailbox},site:{email:'owner@example.com'},channel:{domain:'example-site.com',allowedHosts:['example-site.com']},task:{createdAt:stamp,...(wait?{emailWait:{kind:'code',recipient:'alias@example.com',since:stamp,nextPollAt:stamp,expiresAt:'2026-10-18T10:15:00.000Z',continuation:'signup',consumedMessageIds:[],...wait}}:{})},signal:new AbortController().signal,secrets:{get:async()=> 'fixture-password'},getAccount:()=>undefined} as unknown as ExecutionContext;
}
function sourceFor(subject:string,authentication='mx.google.com; dkim=pass header.d=example-site.com'):Buffer {
  return Buffer.from(`Received: from mail.example-site.com by mx.google.com with ESMTPS; ${stamp}\r\nAuthentication-Results: ${authentication}\r\nReceived: from origin.example-site.com by mail.example-site.com; ${stamp}\r\nSubject: ${subject}\r\n\r\n${subject}`);
}
function message(subject:string,extra:Partial<ScanMessage>={}):ScanMessage {
  return {envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner@example.com'}],date:stamp,subject},internalDate:stamp,source:sourceFor(subject),...extra};
}
function fixture(folders:Record<string,ScanMessage[]>,options:{specialPath?:string}={}) {
  const searched:Array<{folder:string;query:{to:string;since:Date}}>=[],opened:string[]=[],queries:unknown[]=[],released:string[]=[];
  let folder='';
  const client:VerificationMailClient={usable:true,connect:async()=>{},logout:async()=>{},on:()=>{},list:async()=>Object.keys(folders).filter(path=>path!=='INBOX').map(path=>({path,name:path,specialUse:path===options.specialPath?'\\Junk':undefined})),
    getMailboxLock:async(path)=>{folder=path;opened.push(path);return {release(){released.push(path)}}},search:async(query)=>{searched.push({folder,query});return (folders[folder]??[]).map((_entry,index)=>index+1)},
    fetch:async function*(range,query){queries.push(query);yield folders[folder][Number(range)-1]}};
  return {client,searched,opened,released,queries,dependencies:{createClient:()=>client,parse:async(source:Buffer)=>({subject:/^Subject: (.+)$/m.exec(source.toString())?.[1]})}};
}

test('numeric code extraction checks subject before plaintext and stripped HTML and deduplicates',()=>{
  assert.deepEqual(verificationCodes('Your verification code: 001234','OTP 001234','<p>验证码：<b>001234</b></p>').map(item=>item.code),['001234']);
  assert.deepEqual(verificationCodes('','123456 is your verification code','<script>OTP 999999</script><p>确认码：123456</p>').map(item=>item.code),['123456']);
  assert.deepEqual(verificationCodes('OTP: 4826').map(item=>item.code),['4826']);
  assert.deepEqual(verificationCodes('OKX验证码：4826').map(item=>item.code),['4826']);
  assert.deepEqual(verificationCodes('GitHub验证码：2026').map(item=>item.code),['2026']);
});
test('code extraction refuses date years, monetary amounts, phone/order numbers and unrelated numeric content',()=>{
  for(const text of ['Code: 2026年','Invoice code: 123456','Order code: 123456','Phone code: 123456','Code: $123456','Code: 123456 USD','OTP 12345678901','Call +1 212 555 6789','Number 123456','Code 123456.00'])assert.deepEqual(verificationCodes(text),[],text);
  assert.deepEqual(verificationCodes('Code: 2026').map(item=>item.code),['2026']);
  for(const text of ['Promo code: 123456','Referral code: 123456','Invite code: 123456','Coupon code: 123456','Reference code: 123456','Ticket code: 123456','Error code: 123456','邀请码：123456','优惠码：123456','兑换码：123456'])assert.deepEqual(verificationCodes(text),[],text);
});
test('case and ref only reject nearby case/reference code labels',()=>{
  for(const text of ['Case code: 123456','Ref code: 123456','Code 123456 is your case number'])assert.deepEqual(verificationCodes(text),[],text);
  for(const text of ['In case you need it, your code is 123456','Keep this ref for later. Your code is 123456'])assert.deepEqual(verificationCodes(text).map(item=>item.code),['123456'],text);
});
test('order and invoice context overrides generic code markers in either direction',()=>{
  const rejected=['Your order code is 123456','Order confirmation code: 123456','Code 123456 is your invoice number','Your invoice reference code is: 123456','订单确认码是 123456','确认码 123456 是您的订单号'];
  for(const text of rejected){
    assert.deepEqual(verificationCodes(text),[],text);
    assert.deepEqual(verificationCodes('',text),[],text);
    assert.deepEqual(verificationCodes('','',`<p>${text}</p>`),[],text);
  }
  assert.deepEqual(verificationCodes('Your order is complete. Verification code: 123456').map(item=>item.code),['123456']);
  assert.deepEqual(verificationCodes('Verification code: 123456. Your invoice is attached.').map(item=>item.code),['123456']);
});
test('different subject/body codes are reported as ambiguous with a source snippet',async()=>{
  const f=fixture({INBOX:[message('Verification code 123456')]});
  const result=await scanVerification(context(),{now,mode:'code',dependencies:{...f.dependencies,parse:async()=>({subject:'Verification code 123456',text:'验证码 654321'})}});
  assert.equal(result.kind,'ambiguous');if(result.kind==='ambiguous'){assert.deepEqual(result.candidates,['123456','654321']);assert.match(result.snippet,/123456/);assert.ok(result.messageId)}
});
test('scan uses recipient and since server search, discovers localized junk and deduplicates message IDs',async()=>{
  const matching=message('OTP 123456',{envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'alias@example.com'}],date:stamp}});
  const f=fixture({INBOX:[matching],Localized:[{...matching,source:sourceFor('OTP 654321')}]},{specialPath:'Localized'});
  const result=await scanVerification(context({mailboxId:mailbox.id}),{now,mode:'code',dependencies:{...f.dependencies,parse:async(source)=>({subject:source.toString(),messageId:'<same@example.com>'})}});
  assert.equal(result.kind,'code');if(result.kind==='code')assert.equal(result.code,'123456');
  assert.deepEqual(f.opened,['INBOX','Localized']);assert.deepEqual(f.released,f.opened);
  assert.equal(f.searched[0].query.to,'alias@example.com');assert.equal(f.searched[0].query.since.toISOString(),'2026-10-18T09:50:00.000Z');
  assert.ok(f.queries.every(value=>(value as {internalDate?:boolean}).internalDate===true));
});
test('INTERNALDATE window tolerates ten minutes, while Date and recipient still constrain code selection',async()=>{
  const accepted=message('OTP 123456',{internalDate:'2026-10-18T09:51:00.000Z'});
  const stale=message('OTP 654321',{internalDate:'2026-10-18T09:49:59.000Z'}),future=message('OTP 777777',{internalDate:'2026-10-18T10:15:01.000Z'}),missing=message('OTP 888888',{internalDate:undefined});
  const wrong=message('OTP 999999',{envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'another@example.com'}],date:stamp}});
  const f=fixture({INBOX:[accepted,stale,future,missing,wrong]});
  const result=await scanVerification(context(),{now,mode:'code',dependencies:f.dependencies});assert.equal(result.kind,'code');if(result.kind==='code')assert.equal(result.code,'123456');
});
test('consumed mail and a different bound mailbox never provide a new verification result',async()=>{
  const f=fixture({INBOX:[message('OTP 123456',{envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'alias@example.com'}]}})]});
  const dependencies={...f.dependencies,parse:async()=>({subject:'OTP 123456',messageId:'<consumed@example.com>'})};
  assert.deepEqual(await scanVerification(context({consumedMessageIds:['<consumed@example.com>']}),{now,dependencies}),{kind:'none'});
  assert.deepEqual(await scanVerification(context({mailboxId:'other'}),{now,dependencies}),{kind:'none'});
});
test('multiple distinct messages do not silently choose one verification code',async()=>{
  const f=fixture({INBOX:[message('OTP 123456'),message('OTP 654321')]});const result=await scanVerification(context(),{now,mode:'code',dependencies:f.dependencies});assert.equal(result.kind,'ambiguous');
});
test('late old code with a pre-request Date is ambiguous even when delivered after request',async()=>{
  const stale=message('OTP 123456',{internalDate:'2026-10-18T10:02:00.000Z',envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner@example.com'}],date:'2026-10-18T09:57:59.000Z'}});
  const fresh=message('OTP 654321',{internalDate:'2026-10-18T10:03:00.000Z',envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner@example.com'}],date:'2026-10-18T10:02:00.000Z'}});
  const f=fixture({INBOX:[stale,fresh]});
  const result=await scanVerification(context(),{now,mode:'code',dependencies:f.dependencies});
  assert.equal(result.kind,'ambiguous');if(result.kind==='ambiguous')assert.deepEqual(result.candidates,['123456','654321']);
});
test('Date header within two minutes of the request accepts same-second codes',async()=>{
  const f=fixture({INBOX:[message('OTP 123456',{internalDate:'2026-10-18T10:00:30.000Z',envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner@example.com'}],date:'2026-10-18T09:59:59.000Z'}})]});
  const result=await scanVerification(context({recipient:'owner@example.com',since:'2026-10-18T10:00:00.500Z'}),{now,mode:'code',dependencies:f.dependencies});
  assert.equal(result.kind,'code');if(result.kind==='code')assert.equal(result.code,'123456');
});
test('spoofed mail without aligned DKIM or DMARC cannot provide a code, including Junk',async()=>{
  const spoof=message('OTP 123456',{source:sourceFor('OTP 123456','mx.google.com; dkim=pass header.d=evil.example')});
  const junk=fixture({INBOX:[],Localized:[spoof]},{specialPath:'Localized'});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:junk.dependencies})).kind,'ambiguous');
  const inbox=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456','mx.google.com; dkim=fail header.d=example-site.com')})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:inbox.dependencies})).kind,'ambiguous');
  const aligned=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456','mx.google.com; dmarc=pass header.from=example-site.com')})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:aligned.dependencies})).kind,'code');
});
test('Gmail header.i supports DKIM but forged or unknown-provider Authentication-Results hand off',async()=>{
  const identity=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456','mx.google.com; dkim=pass header.i=@example-site.com')})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:identity.dependencies})).kind,'code');
  const forgedFirst=Buffer.concat([Buffer.from('Authentication-Results: mx.google.com; dkim=pass header.d=example-site.com\r\n'),sourceFor('OTP 123456')]);
  const forged=fixture({INBOX:[message('OTP 123456',{source:forgedFirst})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:forged.dependencies})).kind,'ambiguous');
  const wrongAuthserv=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456','mx.evil.example; dkim=pass header.d=example-site.com')})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:wrongAuthserv.dependencies})).kind,'ambiguous');
  for(const claim of [
    'mx.google.com; dkim=fail (dkim=pass header.d=example-site.com)',
    'mx.google.com; dkim=fail (note; dkim=pass header.d=example-site.com )',
    'mx.google.com; dkim=fail reason="dkim=pass header.d=example-site.com"',
    'mx.google.com; dkim=pass header.d=example-site.com header.d=evil.example',
    'mx.google.com; dkim=pass header.i=@example-site.com header.i=@evil.example',
    'mx.google.com; dmarc=pass header.from=example-site.com header.from=evil.example',
    'mx.google.com; dkim=pass header.d=sub.example-site.com header.i=@example-site.com',
  ]){
    const fake=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456',claim)})]});
    assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:fake.dependencies})).kind,'ambiguous',claim);
  }
  const suffix=Buffer.from('Received: from attacker.example by mx.google.com.attacker.example\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=example-site.com\r\nSubject: OTP 123456\r\n\r\nOTP 123456');
  const suffixFixture=fixture({INBOX:[message('OTP 123456',{source:suffix})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:suffixFixture.dependencies})).kind,'ambiguous');
  const quotedBy=Buffer.from('Received: from "by mx.google.com" by attacker.example\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=example-site.com\r\nSubject: OTP 123456\r\n\r\nOTP 123456');
  const quotedFixture=fixture({INBOX:[message('OTP 123456',{source:quotedBy})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:quotedFixture.dependencies})).kind,'ambiguous');
  const spoofedReceived=Buffer.from('Received: from sender.example by mx.google.com\r\nReceived: from fake.example by attacker.example\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=example-site.com\r\nSubject: OTP 123456\r\n\r\nOTP 123456');
  const received=fixture({INBOX:[message('OTP 123456',{source:spoofedReceived})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:received.dependencies})).kind,'ambiguous');
  const unknown=fixture({INBOX:[message('OTP 123456',{source:sourceFor('OTP 123456')})]});
  const qq=context();qq.mailbox={...mailbox,host:'imap.qq.com'};
  const qqResult=await scanVerification(qq,{now,mode:'code',dependencies:unknown.dependencies});
  assert.equal(qqResult.kind,'confirmation_required');
  if(qqResult.kind==='confirmation_required')assert.deepEqual(qqResult.candidate,{kind:'code',code:'123456'});
  const missing=fixture({INBOX:[message('OTP 123456',{source:Buffer.from('Subject: OTP 123456\r\n\r\nOTP 123456')})]});
  assert.equal((await scanVerification(context(),{now,mode:'code',dependencies:missing.dependencies})).kind,'ambiguous');
});
test('non-Gmail requires confirmation for a sole valid code and preserves real ambiguity and envelope checks',async()=>{
  for(const host of ['imap.qq.com','imap.163.com','imap.126.com','imap.mail.yahoo.com','imap.mail.me.com','imap.example.com']){
    const candidate=context();candidate.mailbox={...mailbox,host};
    const f=fixture({INBOX:[message('OTP 123456',{source:Buffer.from('Subject: OTP 123456\r\n\r\nOTP 123456')})]});
    const result=await scanVerification(candidate,{now,mode:'code',dependencies:f.dependencies});
    assert.equal(result.kind,'confirmation_required',host);
    if(result.kind==='confirmation_required'){assert.deepEqual(result.candidate,{kind:'code',code:'123456'});assert.ok(result.messageId);assert.match(result.snippet,/123456/)}
  }
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const multiple=fixture({INBOX:[message('OTP 123456'),message('OTP 654321')]});
  const result=await scanVerification(candidate,{now,mode:'code',dependencies:multiple.dependencies});
  assert.equal(result.kind,'ambiguous');if(result.kind==='ambiguous')assert.deepEqual(result.candidates,['654321','123456']);
  const stale=fixture({INBOX:[message('OTP 123456',{envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'owner@example.com'}],date:'2026-10-18T09:57:59.000Z'}})]});
  assert.equal((await scanVerification(candidate,{now,mode:'code',dependencies:stale.dependencies})).kind,'ambiguous');
  for(const envelope of [
    {from:[{address:'noreply@other.example.com'}],to:[{address:'owner@example.com'}],date:stamp},
    {from:[{address:'noreply@example-site.com'}],to:[{address:'other@example.com'}],date:stamp},
  ]){
    const invalid=fixture({INBOX:[message('OTP 123456',{envelope})]});
    assert.equal((await scanVerification(candidate,{now,mode:'code',dependencies:invalid.dependencies})).kind,'none');
  }
});
test('non-Gmail sole verification link requires confirmation while code plus link is ambiguous',async()=>{
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const url='https://example-site.com/verifyEmail?confirmation_token=abc123';
  const f=fixture({INBOX:[message('Confirm your email')]});
  const dependencies={...f.dependencies,parse:async()=>({subject:'Confirm your email',text:`Confirm ${url}`}),resolveLink:async(value:string)=>value};
  const result=await scanVerification(candidate,{now,mode:'link',dependencies});
  assert.equal(result.kind,'confirmation_required');if(result.kind==='confirmation_required')assert.deepEqual(result.candidate,{kind:'link',url});
  const both=await scanVerification(candidate,{now,mode:'either',dependencies:{...dependencies,parse:async()=>({subject:'OTP 123456',text:`Confirm ${url}`})}});
  assert.equal(both.kind,'ambiguous');if(both.kind==='ambiguous')assert.deepEqual(both.candidates,['123456',url]);
});
test('non-Gmail tracker mail creates a redacted confirmation without resolver or HEAD requests',async()=>{
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const homepage='https://example-site.com/help',tracker='https://tracking.example.net/click?token=fixture';
  const f=fixture({INBOX:[message('Confirm your email')]});
  let resolves=0,heads=0;
  const requestHead=async()=>{heads++;return {status:302,headers:{location:'https://example-site.com/verify?token=fixture'}}};
  const result=await scanVerification(candidate,{now,mode:'link',dependencies:{...f.dependencies,
    parse:async()=>({subject:'Confirm your email',text:`Confirm ${homepage} then ${tracker}`}),
    resolveLink:async()=>{resolves++;await requestHead();return 'https://example-site.com/verify?token=fixture'},
  }});
  assert.equal(result.kind,'confirmation_required');assert.equal(resolves,0);assert.equal(heads,0);
  if(result.kind==='confirmation_required'){
    assert.deepEqual(result.candidate,{kind:'link',url:tracker});
    assert.equal(result.snippet,'[已隐藏]');
  }
});
test('HTML-only mail keeps clean ordered tracker anchors and excludes resources before confirmation',async()=>{
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const logo='https://tracking.example.net/click?token=logo',verify='https://tracking.example.net/click?token=verify';
  const html=`<link href="https://cdn.example.net/mail.css" rel="stylesheet"><a href="${logo}"><img src="https://cdn.example.net/logo.png"></a><img src="https://tracking.example.net/open?token=pixel" width="1" height="1"><a href="${verify}">Verify email</a><a href="${verify}">Confirm</a>`;
  const f=fixture({INBOX:[message('Verify email',{source:Buffer.from(`Subject: Verify email\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`)})]});
  let resolves=0,heads=0;
  const result=await scanVerification(candidate,{now,mode:'link',dependencies:{createClient:()=>f.client,resolveLink:async()=>{resolves++;heads++;return undefined}}});
  assert.equal(resolves,0);assert.equal(heads,0);assert.equal(result.kind,'confirmation_required');
  if(result.kind==='confirmation_required'){
    assert.deepEqual(result.candidate,{kind:'link',url:logo,urls:[logo,verify]});
    assert.equal(result.snippet,'[已隐藏]');
  }
});
test('confirmation tracker candidates are deduplicated and bounded after resource exclusions',async()=>{
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const trackers=Array.from({length:MAX_LINKS+3},(_value,index)=>`https://tracking.example.net/click?token=fixture${index}`);
  const html='<img src="https://cdn.example.net/logo.png">'+trackers.flatMap(url=>[`<a href="${url}">Confirm email</a>`,`<a href="${url}">Confirm email again</a>`]).join('');
  const f=fixture({INBOX:[message('Confirm your email')]});
  const result=await scanVerification(candidate,{now,mode:'link',dependencies:{...f.dependencies,parse:async()=>({subject:'Confirm your email',html}),resolveLink:async()=>{throw Error('must not resolve before confirmation')}}});
  assert.equal(result.kind,'confirmation_required');
  if(result.kind==='confirmation_required')assert.deepEqual(result.candidate,{kind:'link',url:trackers[0],urls:trackers.slice(0,MAX_LINKS)});
});
test('an HTML brand link preserves a distinct plaintext verification URL',async()=>{
  const candidate=context();candidate.mailbox={...mailbox,host:'imap.qq.com'};
  const url='https://example-site.com/verify?token=fixture',f=fixture({INBOX:[message('Confirm your email')]});
  let resolves=0;
  for(const html of ['', '<a href="https://example-site.com/">Brand</a>']){
    const result=await scanVerification(candidate,{now,mode:'link',dependencies:{...f.dependencies,parse:async()=>({subject:'Confirm your email',text:`Confirm your email: ${url}`,html}),resolveLink:async()=>{resolves++;return undefined}}});
    assert.equal(result.kind,'confirmation_required');
    if(result.kind==='confirmation_required')assert.deepEqual(result.candidate,{kind:'link',url});
  }
  assert.equal(resolves,0);
});
test('scanner logs out before resolving links and retains INBOX candidates when Junk fails',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')],Localized:[]},{specialPath:'Localized'});
  let loggedOut=false,listened=false;
  f.client.on=()=>{listened=true};f.client.logout=async()=>{loggedOut=true};
  const originalLock=f.client.getMailboxLock;
  f.client.getMailboxLock=async(path,options)=>{if(path==='Localized')throw Error('Junk unavailable');return originalLock(path,options)};
  const url='https://example-site.com/verify?token=fixture';
  const result=await scanVerification(context(),{now,mode:'link',dependencies:{...f.dependencies,
    parse:async()=>({subject:'Confirm your email',text:`Confirm ${url}`}),
    resolveLink:async value=>{assert.equal(loggedOut,true);return value},
  }});
  assert.equal(listened,true);assert.equal(result.kind,'link');if(result.kind==='link')assert.equal(result.url,url);
});
test('scanner rejects denial anchor text even when its URL looks like confirmation',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});
  const deny='https://example-site.com/confirm?token=bad123',verify='https://example-site.com/confirm?token=good123';
  const result=await scanVerification(context(),{now,mode:'link',dependencies:{...f.dependencies,
    parse:async()=>({subject:'Confirm your email',html:`<a href="${deny}">Decline signup</a><a href="${verify}">Verify email</a>`}),
    resolveLink:async url=>url,
  }});
  assert.equal(result.kind,'link');if(result.kind==='link')assert.equal(result.url,verify);
});
test('scanner excludes stop and deactivation anchors even if their URL is a verify route',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});
  const stop='https://example-site.com/verify?token=stop123',deactivate='https://example-site.com/verify?token=deactivate123',safe='https://example-site.com/verify?token=good123';
  const result=await scanVerification(context(),{now,mode:'link',dependencies:{...f.dependencies,
    parse:async()=>({subject:'Confirm your email',html:`<a href="${stop}">Stop emails</a><a href="${deactivate}">停用账号</a><a href="${safe}">Verify email</a>`}),
    resolveLink:async url=>url,
  }});
  assert.equal(result.kind,'link');if(result.kind==='link')assert.equal(result.url,safe);
});
test('a code and a link in the same message remain ambiguous in either mode',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});
  const url='https://example-site.com/verify?token=abc123';
  const result=await scanVerification(context(),{now,mode:'either',dependencies:{...f.dependencies,
    parse:async()=>({subject:'OTP 123456',text:`Confirm ${url}`}),resolveLink:async value=>value,
  }});
  assert.equal(result.kind,'ambiguous');if(result.kind==='ambiguous')assert.deepEqual(result.candidates,['123456',url]);
});
test('authentication rejection during IMAP search is surfaced for immediate manual handoff',async()=>{
  const f=fixture({INBOX:[]});f.client.search=async()=>{throw Object.assign(Error('Authentication failed'),{serverResponseCode:'AUTHENTICATIONFAILED'})};
  await assert.rejects(scanVerification(context(),{now,mode:'code',dependencies:f.dependencies}),/Authentication failed/);
});
test('one mailbox batch uses one IMAP login and distributes only addressed candidates',async()=>{
  const first=context(),second=context({recipient:'alias@example.com'});
  first.task.id='first';second.task.id='second';
  const addressed=message('OTP 654321',{envelope:{from:[{address:'noreply@example-site.com'}],to:[{address:'alias@example.com'}],date:stamp}});
  const f=fixture({INBOX:[message('OTP 123456'),addressed]});let connects=0;
  f.client.connect=async()=>{connects++};
  const results=await scanVerificationBatch([first,second],{now,mode:'code',dependencies:f.dependencies});
  assert.equal(connects,1);assert.equal(results.get('first')?.kind,'code');assert.equal(results.get('second')?.kind,'code');
  assert.equal((results.get('first') as {code?:string}).code,'123456');assert.equal((results.get('second') as {code?:string}).code,'654321');
});
test('mail clients attach an error listener before connect and expose auth failures',async()=>{
  const emitter=new EventEmitter();
  const client=Object.assign(emitter,{usable:false,connect:async()=>{assert.equal(emitter.listenerCount('error'),1);const error=Object.assign(Error('Authentication failed'),{responseStatus:'NO'});emitter.emit('error',error);throw error},getMailboxLock:async()=>({release(){}}),logout:async()=>{}});
  const result=await testMailbox(mailbox,'fixture',()=>client);
  assert.equal(result.ok,false);assert.equal(isMailAuthenticationError(Error(result.message)),true);
  assert.equal(isMailAuthenticationError(Object.assign(Error('Command failed'),{authenticationFailed:true})),true);
  assert.equal(isMailAuthenticationError(Object.assign(Error('Command failed'),{responseText:'LOGIN Login error, check your authorization code'})),true);
});

function transport(routes:Record<string,string|undefined>,resolved:string[]=[],requested:string[]=[]) {
  return {resolve:async(host:string)=>{resolved.push(host);return [{address:'8.8.8.8',family:4}]},
    request:async()=>{throw Error('GET must not be used for mail links')},
    requestHead:async(url:URL)=>{requested.push(url.href);const next=routes[url.href];return next?{status:302,headers:{location:next}}:{status:200,headers:{}}}};
}
test('tracking links resolve through HEAD Location and stop before terminal verification request',async()=>{
  const requested:string[]=[],resolved:string[]=[],start='https://tracker.example.com/click',terminal='https://login.example-site.com/verify?token=fixture';
  const result=await resolveVerificationLink(start,['example-site.com'],undefined,transport({[start]:'https://tracker.example.com/next','https://tracker.example.com/next':terminal},resolved,requested));
  assert.equal(result,terminal);assert.deepEqual(requested,[start,'https://tracker.example.com/next']);assert.equal(resolved.includes('login.example-site.com'),true);
});
test('unrecognized platform routes never receive HEAD, even when branded as trackers',async()=>{
  const start='https://links.example-site.com/ls/click?upn=fixture',terminal='https://example-site.com/confirm?token=fixture',requested:string[]=[];
  assert.equal(await resolveVerificationLink(start,['example-site.com'],undefined,transport({[start]:terminal},[],requested)),undefined);
  assert.deepEqual(requested,[]);
  for(const path of ['/news','/register?token=abc123','/verify?no_token=abc123']){
    assert.equal(await resolveVerificationLink(`https://example-site.com${path}`,['example-site.com'],undefined,transport({},[],requested)),undefined);
  }
  assert.deepEqual(requested,[]);
  const tracker='https://tracker.example.com/click';
  assert.equal(await resolveVerificationLink(tracker,['example-site.com'],undefined,transport({[tracker]:start,[start]:terminal},[],requested)),undefined);
  assert.deepEqual(requested,[tracker]);
});
test('direct recognized platform verification links receive DNS validation only',async()=>{
  const requested:string[]=[],resolved:string[]=[],url='https://example-site.com/verifyEmail?token=fixture';
  assert.equal(await resolveVerificationLink(url,['example-site.com'],undefined,transport({},resolved,requested)),url);
  assert.deepEqual(requested,[]);assert.deepEqual(resolved,['example-site.com']);
});
test('tracking links reject unsafe schemes, hosts, reset routes and chains exceeding three hops',async()=>{
  const start='https://tracker.example.com/click';
  for(const next of ['http://example-site.com/verify','https://127.0.0.1/verify','https://example-site.com/reset-password'])assert.equal(await resolveVerificationLink(start,['example-site.com'],undefined,transport({[start]:next})),undefined);
  const calls:string[]=[];const routes={[start]:'https://tracker.example.com/one','https://tracker.example.com/one':'https://tracker.example.com/two','https://tracker.example.com/two':'https://tracker.example.com/three','https://tracker.example.com/three':'https://example-site.com/verify'};
  assert.equal(await resolveVerificationLink(start,['example-site.com'],undefined,transport(routes,[],calls)),undefined);assert.equal(calls.length,3);
});
test('deterministically negative tracking URLs are cached across polling rounds',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});
  const url='https://tracker.example.com/unresolved-6c';let requests=0;
  const dependencies={...f.dependencies,parse:async()=>({subject:'Confirm your email',text:`Confirm ${url}`,messageId:'<cache-6c@example.com>'}),resolveLink:async()=>{requests++;return {kind:'negative' as const}}};
  assert.equal((await scanVerification(context(),{now,mode:'link',dependencies})).kind,'none');
  assert.equal((await scanVerification(context(),{now:new Date(now.getTime()+60_000),mode:'link',dependencies})).kind,'none');
  assert.equal(requests,1);
});
test('DNS and HEAD failures remain transient, while completed negative redirects are deterministic',async()=>{
  const start='https://tracker.example.com/classify',terminal='https://example-site.com/verify?token=abc123';
  const dns=transport({[start]:terminal});dns.resolve=async()=>{throw Error('DNS timeout')};
  assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,dns),{kind:'transient'});
  const head=transport({[start]:terminal});head.requestHead=async()=>{throw Error('HEAD timeout')};
  assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,head),{kind:'transient'});
  const terminalDns=transport({[start]:terminal});terminalDns.resolve=async(host)=>{if(host==='example-site.com')throw Error('DNS timeout');return [{address:'8.8.8.8',family:4}]};
  assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,terminalDns),{kind:'transient'});
  for(const status of [408,425,429,500,503]){
    const unavailable={...transport({}),requestHead:async()=>({status,headers:{}})};
    assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,unavailable),{kind:'transient'},String(status));
  }
  assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,transport({})),{kind:'negative'});
  assert.deepEqual(await resolveVerificationLinkDetailed(start,['example-site.com'],undefined,transport({[start]:'https://example-site.com/reset-password'})),{kind:'negative'});
});
test('transient DNS or HEAD failures and unknown resolver failures are retried next poll',async()=>{
  for(const failure of ['DNS','HEAD','throw','undefined']){
    const f=fixture({INBOX:[message('Confirm your email')]});
    const start=`https://tracker.example.com/retry-${failure}`,terminal='https://example-site.com/verify?token=retry123';let attempts=0;
    const dependencies={...f.dependencies,parse:async()=>({subject:'Confirm your email',text:`Confirm ${start}`,messageId:`<retry-${failure}@example.com>`}),resolveLink:async()=>{
      attempts++;
      if(attempts>1)return terminal;
      if(failure==='throw')throw Error('HEAD timeout');
      if(failure==='undefined')return;
      const deps=transport({[start]:terminal});
      if(failure==='DNS')deps.resolve=async()=>{throw Error('DNS timeout')};
      else deps.requestHead=async()=>{throw Error('HEAD timeout')};
      return resolveVerificationLinkDetailed(start,['example-site.com'],undefined,deps);
    }};
    assert.equal((await scanVerification(context(),{now,mode:'link',dependencies})).kind,'none',failure);
    assert.equal((await scanVerification(context(),{now:new Date(now.getTime()+60_000),mode:'link',dependencies})).kind,'link',failure);
    assert.equal(attempts,2,failure);
  }
});
test('a full negative-link cache evicts oldest entries and continues resolving new candidates',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});let batch=0,urls:string[]=[],requests=0;
  const url=(index:number)=>`https://tracker.example.com/capacity-${index}`;
  const dependencies={...f.dependencies,parse:async()=>({subject:'Confirm your email',text:urls.join(' '),messageId:`<capacity-${batch}@example.com>`}),resolveLink:async()=>{requests++;return {kind:'negative' as const}}};
  for(batch=0;batch<342;batch++){
    urls=Array.from({length:12},(_item,index)=>url(batch*12+index));
    assert.equal((await scanVerification(context(),{now,mode:'link',dependencies})).kind,'none');
  }
  assert.equal(requests,4104);
  batch=0;urls=[url(8)];
  await scanVerification(context(),{now,mode:'link',dependencies});assert.equal(requests,4104,'entry within retained 4096 remains cached');
  urls=[url(0)];
  await scanVerification(context(),{now,mode:'link',dependencies});assert.equal(requests,4105,'oldest entry was evicted');
  batch=343;urls=['https://tracker.example.com/capacity-new'];
  const terminal='https://example-site.com/verify?token=new123';
  const result=await scanVerification(context(),{now,mode:'link',dependencies:{...dependencies,resolveLink:async()=>{requests++;return terminal}}});
  assert.equal(result.kind,'link');assert.equal(requests,4106);
});
test('public DNS protection refuses a private resolved tracker without issuing HTTP',async()=>{
  let called=false;assert.equal(await resolveVerificationLink('https://tracker.example.com/click',['example-site.com'],undefined,{resolve:async()=>[{address:'10.0.0.1',family:4}],request:async()=>{called=true;throw Error('must not request')}}),undefined);assert.equal(called,false);
});
test('terminal allowed hostname is refused when DNS resolves privately without consuming link',async()=>{
  const start='https://tracker.example.com/click',terminal='https://example-site.com/verify?token=abc123',requested:string[]=[];
  const deps=transport({[start]:terminal},[],requested);deps.resolve=async(host)=>[{address:host==='example-site.com'?'127.0.0.1':'8.8.8.8',family:4}];
  assert.equal(await resolveVerificationLink(start,['example-site.com'],undefined,deps),undefined);assert.deepEqual(requested,[start]);
});
test('163/126 omit branded IMAP client ID and Outlook keeps OAuth-required limitation',()=>{
  for(const host of ['imap.163.com','imap.126.com'])assert.equal(mailboxClientOptions({...mailbox,host},'fixture').clientInfo,undefined);
  assert.throws(()=>mailboxClientOptions({...mailbox,host:'outlook.office365.com'},'fixture'),/OAuth/);
});
test('aliases are stable per website/platform and stay conservative on QQ and unknown providers',()=>{
  const gmail={host:'imap.gmail.com',user:'owner@gmail.com'},one=generateMailAlias(gmail,'site-one','platform-one');assert.ok(one?.startsWith('owner+lf'));assert.equal(one,generateMailAlias(gmail,'site-one','platform-one'));assert.notEqual(one,generateMailAlias(gmail,'site-one','platform-two'));assert.notEqual(one,generateMailAlias(gmail,'site-two','platform-one'));
  assert.equal(generateMailAlias({host:'outlook.office365.com',user:'owner@outlook.com'},'site','platform'),undefined);
  for(const input of [{host:'imap.qq.com',user:'owner@qq.com'},mailbox,{host:'imap.163.com',user:'owner@163.com'}])assert.equal(generateMailAlias(input,'site','platform'),undefined);
});
test('mailbox automation requires a successful current test and a supported provider',()=>{
  assert.equal(mailboxAutomationReady(mailbox),true);
  assert.equal(mailboxAutomationReady({...mailbox,verifiedAt:undefined}),false);
  assert.equal(mailboxAutomationReady({...mailbox,lastError:'Authentication failed'}),false);
  assert.equal(mailboxAutomationReady({...mailbox,host:'outlook.office365.com'}),false);
});
test('usage counts distinct websites and platforms without multiplying shared binding rows',()=>{
  const counts=mailboxUsageCounts('mail',[{id:'one',mailboxId:'mail'}],[{id:'a',mailboxId:'mail',channelId:'first'},{id:'b',mailboxId:'mail',channelId:'first'},{id:'retired',mailboxId:'mail',channelId:'old',retiredAt:stamp}],[{accountId:'a',siteId:'one',channelId:'first'},{accountId:'b',siteId:'two',channelId:'first'}]);assert.deepEqual(counts,{siteCount:2,platformCount:1,accountCount:2});
});
const input={label:'Fixture',host:'imap.example.com',port:993,user:'owner@example.com',secure:true as const,password:'fixture-secret'};
test('save tests exact connection first and atomically persists verification and encrypted secret',async()=>{
  const store=new Store(':memory:');try{
    const result=await saveMailboxAndTestAtomic(store,input,values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,'cipher:'+value])),{now:()=>now,test:async(mail,password)=>{assert.equal(store.read().mailboxes.length,0);assert.equal(mail.host,input.host);assert.equal(password,input.password);return {ok:true,message:'ok'}}});
    const saved=store.read().mailboxes[0];assert.equal(result.ok,true);assert.equal(saved.verifiedAt,now.toISOString());assert.equal(saved.hasPassword,true);assert.equal('password' in saved,false);assert.equal(store.getCipher('mailbox:'+saved.id),'cipher:fixture-secret');
  }finally{store.close()}
});
test('failed save test keeps honest unverified config and no raw credential',async()=>{
  const store=new Store(':memory:');try{const result=await saveMailboxAndTestAtomic(store,input,values=>Object.fromEntries(Object.keys(values).map(key=>[key,'cipher'])),{test:async()=>({ok:false,message:'fixture failure'})});const saved=store.read().mailboxes[0];assert.equal(result.ok,false);assert.equal(saved.verifiedAt,undefined);assert.equal(saved.lastError,'fixture failure');assert.equal('password' in saved,false)}finally{store.close()}
});
test('saving a replacement password without a connection test revokes prior automation readiness',async()=>{
  const store=new Store(':memory:');try{
    const first=await saveMailboxAndTestAtomic(store,input,values=>values,{test:async()=>({ok:true,message:'ok'})});
    assert.equal(mailboxAutomationReady(store.read().mailboxes[0]),true);
    saveMailboxAtomic(store,{...input,id:first.id,password:'replacement'},values=>values);
    const saved=store.read().mailboxes[0];
    assert.equal(saved.hasPassword,true);assert.equal(saved.verifiedAt,undefined);assert.equal(mailboxAutomationReady(saved),false);
  }finally{store.close()}
});
test('unchanged saved identity can test old secret; identity changes never reuse it',async()=>{
  const store=new Store(':memory:');try{
    const first=await saveMailboxAndTestAtomic(store,input,values=>values,{test:async()=>({ok:true,message:'ok'})});let observed='';
    await saveMailboxAndTestAtomic(store,{...input,id:first.id,password:undefined},values=>values,{getPassword:async()=> 'stored-secret',test:async(_mail,password)=>{observed=password;return {ok:true,message:'ok'}}});assert.equal(observed,'stored-secret');
    await saveMailboxAndTestAtomic(store,{...input,id:first.id,password:undefined,host:'imap.other.example.com'},values=>values,{getPassword:async()=>{throw Error('must not read prior secret')},test:async(_mail,password)=>{observed=password;return {ok:false,message:'missing'}}});assert.equal(observed,'');assert.equal(store.getCipher('mailbox:'+first.id),undefined);
  }finally{store.close()}
});
test('async connection result cannot overwrite a newer mailbox edit or credential',async()=>{
  const store=new Store(':memory:');try{
    const first=await saveMailboxAndTestAtomic(store,input,values=>values,{test:async()=>({ok:true,message:'ok'})});
    await assert.rejects(()=>saveMailboxAndTestAtomic(store,{...input,id:first.id,label:'Stale'},values=>values,{test:async()=>{store.update(state=>{state.mailboxes[0].label='Newer'});return {ok:true,message:'ok'}}}),/改变/);assert.equal(store.read().mailboxes[0].label,'Newer');
  }finally{store.close()}
});
test('batch import tests every connection but commits no partial state if encryption fails',async()=>{
  const store=new Store(':memory:');try{let tests=0;await assert.rejects(()=>importMailboxesAndTestAtomic(store,[input,{...input,user:'other@example.com'}],()=>{throw Error('encrypt failure')},{test:async()=>{tests++;return {ok:true,message:'ok'}}}),/encrypt failure/);assert.equal(tests,2);assert.equal(store.read().mailboxes.length,0);assert.deepEqual(store.allCiphers(),{})}finally{store.close()}
});
test('9a3 follow-up: a bare verification link inside a compact HTML list is not glued to the next item',async()=>{
  const f=fixture({INBOX:[message('Confirm your email')]});
  const verify='https://example-site.com/verify?token=abc123';
  const result=await scanVerification(context(),{now,mode:'link',dependencies:{...f.dependencies,
    parse:async()=>({subject:'Confirm your email',html:`<ul><li>${verify}</li><li>Note</li></ul><table><tr><th>Link</th></tr><tr><td>${verify}</td></tr></table>`}),
    resolveLink:async url=>url,
  }});
  assert.equal(result.kind,'link');if(result.kind==='link')assert.equal(result.url,verify);
});
