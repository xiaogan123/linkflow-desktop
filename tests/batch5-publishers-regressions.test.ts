import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {marked} from 'marked';
import {load} from 'cheerio';
import {Batch5IdentitySingleSiteError,Batch5RegistrationLimitError} from '../src/integrations/batch5-contract';
import {batch5FailureResult} from '../src/integrations/batch5-publishers';
import {lockedBatch5,persistBatch5Receipt,type ConnectedContext} from '../src/integrations/batch5-connected';
import {accountCreationBudgetExceeded} from '../src/main/account-bindings';
import {hasBatch5AccountIdentity,createBatch5AccountPersistence,parseBatch5AccountJournal} from '../src/main/batch5-publication';
import {inspectBatch5RenderedBody,selectBatch5RenderedBody} from '../src/main/batch5-renderer';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState,Store} from '../src/main/store';
import type {Batch5AccountIntent,Batch5Intent,Batch5Receipt,Batch5TaskState} from '../src/integrations/batch5-contract';
import type {Account,Site,Task} from '../src/shared/types';

const at='2026-10-18T12:00:00.000Z';
const siteId=(n:number)=>`10000000-0000-4000-8000-00000000000${n}`;
const taskId=(n:number)=>`20000000-0000-4000-8000-00000000000${n}`;
const site=(n:number):Site=>({id:siteId(n),domain:`site${n}.example.com`,url:`https://site${n}.example.com/`,email:`owner${n}@example.com`,name:`Site ${n}`,description:'Independent guide',category:'finance',language:'zh-CN',monthlyTarget:1,status:'ready',createdAt:at});
const task=(n:number,channelId:'rant'|'slopit'):Task=>({id:taskId(n),siteId:siteId(n),channelId,sourceDomain:channelId==='rant'?'rant.li':'slopit.io',status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:''});
const accountIntent=(n:number,channelId:'rant'|'slopit',email?:string):Batch5AccountIntent=>({version:1,channelId,siteId:siteId(n),operationId:`registration-${n}`,requestHash:'a'.repeat(64),createdAt:at,username:`site${n}`,...(channelId==='rant'?{password:'synthetic-secret-password'}:{email})});

function fixture(channelId:'rant'|'slopit'='rant'){
  const directory=mkdtempSync(join(tmpdir(),'linkflow-b5-publishers-')),store=new Store(join(directory,'state.sqlite'));
  store.update(state=>{Object.assign(state,emptyState());state.settings.timezone='UTC';state.sites=[site(1),site(2)];state.tasks=[task(1,channelId),task(2,channelId)]});
  const vault={get:async(key:string)=>{const cipher=store.getCipher(key);return cipher?Buffer.from(cipher.slice(4),'base64url').toString():undefined},
    encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))};
  return {store,vault,close(){store.close();rmSync(directory,{recursive:true,force:true})}};
}

test('account reservation enforces the shared rolling 24-hour 2/6 cap inside the transaction',async()=>{
  const f=fixture();try{
    const channels=['mataroa','verbose','plopino','deed-page','slopit'];
    f.store.update(state=>{for(const [index,channelId] of channels.entries())state.accounts.push({
      id:`30000000-0000-4000-8000-00000000000${index}`,channelId,email:'',username:`writer${index}`,status:'unknown',hasPassword:false,
      credentialKind:'password',source:'generated',createdAt:'2026-10-18T11:30:00.000Z',registrationAttempts:1,
    } as Account)});
    const first=createBatch5AccountPersistence(f.store,f.vault,taskId(1),()=>{}),second=createBatch5AccountPersistence(f.store,f.vault,taskId(2),()=>{});
    assert.equal(accountCreationBudgetExceeded(f.store.read(),'rant',new Date(at)),false);
    await first.saveAccountIntent(accountIntent(1,'rant'));
    assert.equal(accountCreationBudgetExceeded(f.store.read(),'rant',new Date(at)),true);
    await assert.rejects(second.saveAccountIntent(accountIntent(2,'rant')),Batch5RegistrationLimitError);
    assert.equal(f.store.read().accounts.filter(value=>value.source==='generated').length,6);
    assert.equal(f.store.getCipher(`batch5:identity:rant:${siteId(2)}`),undefined);
  }finally{f.close()}
});

test('rolling cap counts registrations across UTC midnight and protects both account channels',async()=>{
  const f=fixture('slopit');try{
    f.store.update(state=>{for(let index=0;index<2;index++)state.accounts.push({
      id:`40000000-0000-4000-8000-00000000000${index}`,channelId:'slopit',email:`writer${index}@example.com`,username:`writer${index}`,
      status:'unknown',hasPassword:false,credentialKind:'api_token',source:'generated',createdAt:'2026-10-17T23:30:00.000Z',registrationAttempts:1,
    } as Account)});
    const p=createBatch5AccountPersistence(f.store,f.vault,taskId(1),()=>{});
    await assert.rejects(p.saveAccountIntent(accountIntent(1,'slopit','new@example.com')),Batch5RegistrationLimitError);
    assert.equal(f.store.getCipher(`batch5:identity:slopit:${siteId(1)}`),undefined);
  }finally{f.close()}
});

test('typed single-site identity refusal and encrypted signup journal survive task changes',async()=>{
  const f=fixture('slopit');try{
    const first=createBatch5AccountPersistence(f.store,f.vault,taskId(1),()=>{}),second=createBatch5AccountPersistence(f.store,f.vault,taskId(2),()=>{});
    await first.saveAccountIntent(accountIntent(1,'slopit','shared@example.com'));
    assert.equal(hasBatch5AccountIdentity(f.store,siteId(1)),true);
    await assert.rejects(second.saveAccountIntent(accountIntent(2,'slopit','shared@example.com')),Batch5IdentitySingleSiteError);
    const intent=(await first.loadAccountIntent('slopit',siteId(1)))!,body=JSON.stringify({api_key:'synthetic-api-key-12345',blog_id:'blog123',blog_url:'https://sample.slopit.io/'});
    await first.saveAccountOpaqueResponse({version:1,intent,status:200,contentType:'application/json',responseUrl:'https://slopit.io/api/signup',bodyBase64:Buffer.from(body).toString('base64'),bodyComplete:true});
    assert.equal(JSON.stringify(f.store.read()).includes('synthetic-api-key-12345'),false);
    const journal=parseBatch5AccountJournal(await f.vault.get(`batch5:identity:slopit:${siteId(1)}`));
    assert.equal(Buffer.from(journal!.opaque!.bodyBase64,'base64').toString(),body);
    assert.equal(hasBatch5AccountIdentity(f.store,siteId(2)),false);
  }finally{f.close()}
});

test('failure mapping distinguishes unresolved registration, local format, account, and platform failures',()=>{
  const input={status:'needs_input' as const,message:'synthetic'};
  const failure=(failureKind:string)=>batch5FailureResult(Object.assign({},input,{failureKind}));
  assert.deepEqual(failure('unknown').reasonCode,'submission_unknown');
  assert.equal(failure('format_invalid').trialFailure,undefined);
  assert.equal(failure('format_invalid').reasonCode,'format_invalid');
  assert.equal(failure('account_handoff').reasonCode,'account_handoff');
  assert.equal(failure('provider_rejected').trialFailure,'synthetic');
});

test('backup accepts a stable registration failure operation ID and still accepts older tasks',()=>{
  const state=emptyState();state.sites=[site(1)];state.tasks=[{...task(1,'rant'),trialFailure:'synthetic refusal',trialFailureOperationId:'registration-1'}];
  assert.equal(validateBackup({state,secrets:{}}).state.tasks[0].trialFailureOperationId,'registration-1');
  delete state.tasks[0].trialFailureOperationId;
  assert.equal(validateBackup({state,secrets:{}}).state.tasks[0].trialFailureOperationId,undefined);
});

test('rendered body comparison rejects sidebar links, changed prose, and duplicate bodies',()=>{
  const target='https://example.com/guide',url='https://hackmd.io/abcDEF123';
  const markdown=`Read the [source](${target}) for the full explanation.`;
  const wrap=(content:string)=>`<div data-batch5-article="">${content}</div>`;
  const page=(bodyHtml:string)=>({url,headHtml:`<link rel="canonical" href="${url}">`,bodyHtml,robots:[],refresh:false});
  const exact=wrap(String(marked.parse(markdown)));
  assert.equal(inspectBatch5RenderedBody(page(exact),target,'Example',markdown).found,true);
  assert.equal(inspectBatch5RenderedBody(page(`${wrap('<p>Changed prose.</p>')}<aside><a href="${target}">source</a></aside>`),target,'Example',markdown).found,false);
  assert.equal(inspectBatch5RenderedBody(page(exact+exact),target,'Example',markdown).found,false);
  assert.equal(inspectBatch5RenderedBody({...page(exact),robots:['noindex']},target,'Example',markdown).found,false);
});

test('HackMD fixture selects the unique live article body and ignores generated heading anchors',()=>{
  const html=readFileSync(join(import.meta.dirname,'fixtures','hackmd-public-page.html'),'utf8');
  const $=load(html);
  assert.equal($('.markdown-body').length,2);
  const article=selectBatch5RenderedBody(
    'hackmd',selector=>$(selector).toArray(),
    element=>!$(element).closest('[hidden],[aria-hidden="true"],[style*="display: none"]').length,
  );
  assert.ok(article);
  assert.equal($(article).attr('id'),'doc');
  assert.equal($(article).find('h1 > a.anchor[href="#example-guide"]').length,1);
  assert.equal($(article).find('h2 > a.anchor[href="#verify-the-source"]').length,1);
  const markdown='# Example Guide\n\n## Verify the source\n\nRead the [source guide](https://example.com/guide) before publishing.\n\nA "quoted" note -- with an ellipsis... and example.com.\n';
  const page={
    url:'https://hackmd.io/example-note',headHtml:$('head').html()??'',
    bodyHtml:$(article).attr('data-batch5-article','').prop('outerHTML')??'',robots:[],refresh:false,
  };
  assert.equal(inspectBatch5RenderedBody(page,'https://example.com/guide','Example Guide',markdown).found,true);
  $(article).append('<a href="https://example.com/extra">extra</a>');
  page.bodyHtml=$(article).prop('outerHTML')??'';
  assert.equal(inspectBatch5RenderedBody(page,'https://example.com/guide','Example Guide',markdown).found,false);
});

test('connected receipt replay preserves published phase and locked results omit stale task fields',async()=>{
  const intent:Batch5Intent={version:1,channelId:'hackmd',operationId:'op',siteId:siteId(1),sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:at};
  const receipt:Batch5Receipt={version:1,intent,publicUrl:'https://hackmd.io/abcDEF123',remoteId:'note-123456',rawResponse:'{}'};
  const published:Batch5TaskState={version:1,channelId:'hackmd',operationId:'op',sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:at,stage:'published'};
  const context={task:{checkpoint:'old',submittedAt:'2026-10-17T00:00:00.000Z',publicUrl:'https://hackmd.io/old',batch5:{...published,stage:'api_receipt'}},
    batch5Persistence:{saveReceipt:async()=>{},currentTaskState:()=>published},checkpoint:()=>{throw Error('published stage must not be checkpointed')}} as unknown as ConnectedContext;
  const state=await persistBatch5Receipt(context,receipt,'account-1','note-123456');
  assert.equal(state.stage,'published');
  const locked=lockedBatch5(context,'pending');
  assert.equal(Object.hasOwn(locked,'submittedAt'),false);assert.equal(Object.hasOwn(locked,'publicUrl'),false);assert.equal(Object.hasOwn(locked,'checkpoint'),false);
});
