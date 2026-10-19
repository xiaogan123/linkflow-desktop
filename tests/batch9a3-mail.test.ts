import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {Controller,type ControllerServices} from '../src/main/controller';
import {emailValueKey} from '../src/main/email-waits';
import {Store} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {MAX_LINKS,resolveVerificationLinkDetailed,scanVerification,type VerificationMailClient} from '../src/integrations/mail';
import type {Account,Channel,Mailbox,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const accountId='33333333-3333-4333-8333-333333333333',mailboxId='44444444-4444-4444-8444-444444444444';
const trackers=['logo','verify','fallback'].map(token=>`https://tracking.example.net/click?token=${token}`);
const resolvedUrl='https://platform.example.com/verify?token=fixture';

function fixture(resolveMailLink:NonNullable<ControllerServices['resolveMailLink']>,candidateUrls=trackers){
  const now=new Date(),stamp=new Date(now.getTime()-60_000).toISOString(),store=new Store(':memory:');
  const channel:Channel={id:'fixture-browser',name:'Fixture',domain:'platform.example.com',url:'https://platform.example.com/',submitUrl:'https://platform.example.com/signup',categories:['general'],languages:['*'],kind:'article',emailRequired:true,accountRequired:true,articleRequired:true,free:'yes',freeNote:'fixture',automation:'browser',quality:'C',qualityReason:'fixture',rulesUrl:'https://platform.example.com/rules',checkedAt:'2026-10-19',notes:'fixture',allowedHosts:['platform.example.com'],enabled:true};
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Fixture',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,mailboxId};
  const account:Account={id:accountId,channelId:channel.id,email:site.email,username:'fixture',mailboxId,status:'unknown',hasPassword:true,source:'generated',createdAt:stamp,registrationAttempts:1};
  const mailbox:Mailbox={id:mailboxId,label:'Fixture',host:'imap.qq.com',port:993,user:site.email,secure:true,hasPassword:true,aliases:[],createdAt:stamp,updatedAt:stamp,verifiedAt:stamp};
  const wait:NonNullable<Task['emailWait']>={kind:'link',recipient:site.email,since:stamp,nextPollAt:stamp,expiresAt:new Date(now.getTime()+600_000).toISOString(),mailboxId,consumedMessageIds:[],continuation:'browser'};
  const task:Task={id:taskId,siteId,channelId:channel.id,sourceDomain:channel.domain,status:'needs_input',checkpoint:'waiting_email',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'fixture',accountId,emailWait:wait};
  const html=`<link href="https://cdn.example.net/mail.css" rel="stylesheet"><img src="https://tracking.example.net/open?token=pixel" width="1" height="1"><p>Confirm your email</p>${candidateUrls.map((url,index)=>`<a href="${url}">${index===0?'<img src="https://cdn.example.net/logo.png">':'Verify email'}</a>`).join('')}<a href="${candidateUrls[1]}">Confirm email again</a>`;
  const source=Buffer.from(`Message-ID: <tracker-message@example.com>\r\nSubject: Verify email\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`);
  const client:VerificationMailClient={usable:true,connect:async()=>{},logout:async()=>{},list:async()=>[],getMailboxLock:async()=>({release(){}}),search:async()=>[1],fetch:async function*(){yield {source,internalDate:now,envelope:{from:[{address:'noreply@platform.example.com'}],to:[{address:site.email}],date:now,subject:'Verify email'}}}};
  const encryptionKey=randomBytes(32),key=emailValueKey(taskId);
  const encrypt=(value:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64')};
  const decrypt=(value:string)=>{const data=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',encryptionKey,data.subarray(0,12));decipher.setAuthTag(data.subarray(-16));return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]).toString()};
  const vault={ready:true,available:()=>true,get:async(value:string)=>value===`mailbox:${mailboxId}`?'fixture-password':store.getCipher(value)?decrypt(store.getCipher(value)!):undefined,encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,encrypt(value)]))} as unknown as Vault;
  store.update(state=>{state.sites=[site];state.tasks=[task];state.accounts=[account];state.mailboxes=[mailbox];state.settings.autoRun=true});
  const controller=new Controller(store,vault,'fixture',{channelCatalog:[channel],resolveMailLink,scanMail:context=>scanVerification(context,{dependencies:{createClient:()=>client,resolveLink:resolveMailLink}})});
  controller.runtime.busy=true;
  return {store,controller,key,delivery:async()=>JSON.parse((await vault.get(key))!),backup:async()=>({state:store.read(),secrets:{[key]:(await vault.get(key))!,[`mailbox:${mailboxId}`]:'fixture-password',[`account:${accountId}`]:'fixture-password'}}),restore:(backup:ReturnType<typeof validateBackup>)=>store.restore(backup.state,vault.encryptSecrets(backup.secrets)),poll:()=>(controller as unknown as {emailWaits:{poll():Promise<void>}}).emailWaits.poll(),close(){controller.stop();store.close()}};
}

test('batch9a3 HTML-only mail encrypts all tracker candidates with zero requests and resolves the verification button after confirmation',async()=>{
  const resolves:string[]=[],heads:string[]=[],dns:string[]=[];
  const f=fixture(async(value,hosts,signal)=>{
    resolves.push(value);
    return resolveVerificationLinkDetailed(value,hosts,signal,{resolve:async(host)=>{dns.push(host);return [{address:'8.8.8.8',family:4}]},request:async()=>{throw Error('GET is forbidden')},requestHead:async(url)=>{heads.push(url.href);return {status:302,headers:{location:url.href===trackers[0]?'https://platform.example.com/':resolvedUrl}}}});
  });
  try{
    await f.poll();const pending=f.store.read().tasks[0];
    assert.equal(pending.checkpoint,'email_confirmation');assert.equal(pending.humanAction?.kind,'email_confirmation');
    assert.deepEqual(resolves,[]);assert.deepEqual(heads,[]);assert.deepEqual(dns,[]);
    assert.deepEqual((await f.delivery()).urls,trackers);assert.equal((await f.delivery()).value,trackers[0]);
    assert.equal(JSON.stringify(f.store.read()).includes('tracking.example.net'),false);
    for(const tracker of trackers)assert.equal(f.store.getCipher(f.key)?.includes(tracker),false);
    await f.controller.doneHumanAction(taskId);const saved=f.store.read().tasks[0];
    assert.deepEqual(resolves,trackers.slice(0,2));assert.deepEqual(heads,trackers.slice(0,2));
    assert.equal(saved.status,'queued');assert.equal(saved.checkpoint,'account_registration_submitted');assert.equal(saved.humanAction,undefined);
    assert.equal((await f.delivery()).value,resolvedUrl);assert.equal((await f.delivery()).urls,undefined);
  }finally{f.close()}
});

test('batch9a3 every failed tracker is tried before manual handoff and the encrypted candidates are removed',async()=>{
  for(const failure of ['transient','exception'] as const){
    const calls:string[]=[];
    const f=fixture(async(value)=>{
      calls.push(value);
      if(value===trackers[0])return {kind:'resolved',url:'https://other.example.com/verify?token=fixture'};
      if(value===trackers[1])return {kind:'resolved',url:'https://platform.example.com/reset-password?token=fixture'};
      if(failure==='exception')throw Error('fixture transport failure');
      return {kind:'transient'};
    });
    try{
      await f.poll();assert.deepEqual(calls,[]);
      await f.controller.doneHumanAction(taskId);const saved=f.store.read().tasks[0];
      assert.deepEqual(calls,trackers);assert.equal(saved.status,'needs_input');assert.equal(saved.checkpoint,'email_verification_human');
      assert.equal(saved.humanAction?.kind,'account_login');assert.equal(saved.emailWait,undefined);assert.equal(saved.emailConfirmation,undefined);
      assert.equal(f.store.getCipher(f.key),undefined);
    }finally{f.close()}
  }
});

test('batch9a3 pending tracker arrays survive backup restore including bounded deliveries over 16KB',async()=>{
  const candidates=Array.from({length:MAX_LINKS},(_value,index)=>`https://tracking.example.net/click?token=${index}${'a'.repeat(1500)}`),calls:string[]=[];
  let confirmed=false;
  const f=fixture(async(value)=>{assert.equal(confirmed,true);calls.push(value);return value===candidates[1]?{kind:'resolved',url:resolvedUrl}:{kind:'negative'}},candidates);
  try{
    await f.poll();const backup=await f.backup();assert.ok(backup.secrets[f.key].length>16384);
    const restored=validateBackup(backup);
    assert.equal(restored.state.tasks[0].checkpoint,'email_confirmation');
    assert.deepEqual(JSON.parse(restored.secrets[f.key]).urls,candidates);
    assert.equal(JSON.stringify(restored.state).includes('tracking.example.net'),false);
    const legacy=structuredClone(backup),delivery=JSON.parse(legacy.secrets[f.key]);delete delivery.urls;legacy.secrets[f.key]=JSON.stringify(delivery);
    assert.equal(JSON.parse(validateBackup(legacy).secrets[f.key]).value,candidates[0]);
    for(const urls of [[...candidates,'https://tracking.example.net/click?token=extra'],[candidates[0],candidates[0]],[candidates[0],'https://user:password@tracking.example.net/click']]){
      const invalid=structuredClone(backup);invalid.secrets[f.key]=JSON.stringify({...JSON.parse(invalid.secrets[f.key]),urls});
      assert.throws(()=>validateBackup(invalid));
    }
    const unrelated=structuredClone(backup);unrelated.secrets[`account:${accountId}`]='x'.repeat(16385);
    assert.throws(()=>validateBackup(unrelated));
    const oversized=structuredClone(backup);oversized.secrets[f.key]=' '.repeat((MAX_LINKS+1)*4096+1024)+oversized.secrets[f.key];
    assert.throws(()=>validateBackup(oversized));
    f.restore(restored);confirmed=true;await f.controller.doneHumanAction(taskId);
    assert.deepEqual(calls,candidates.slice(0,2));assert.equal(f.store.read().tasks[0].status,'queued');
    assert.equal((await f.delivery()).value,resolvedUrl);assert.equal((await f.delivery()).urls,undefined);
  }finally{f.close()}
});
