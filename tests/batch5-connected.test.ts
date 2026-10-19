import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {runWhiteWindTask,verifyWhiteWindPublication,whiteWindRkey} from '../src/integrations/whitewind';
import {runHackMdTask,verifyHackMdPublication} from '../src/integrations/hackmd';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Receipt,Batch5Persistence} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-18T12:00:00.000Z',TARGET='https://example.com/guide',DID='did:plc:examplewriter1234567890';
const BODY=`A complete educational article explains source selection, evidence checks, and practical limitations. Read the [example guide](${TARGET}) for the original context.\n\nThe second paragraph documents uncertainty and avoids unverified trading claims. The author may benefit from referrals, and readers should make independent decisions.`;
const TITLE='A source checking guide';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

class Journal implements Batch5Persistence {
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;
  task?:Task;
  intents=0;receipts=0;readyChecks=0;blockMutation=false;
  async saveIntent(value:Batch5Intent){if(this.intent&&JSON.stringify(this.intent)!==JSON.stringify(value))throw Error('different_intent');this.intent=structuredClone(value);this.intents++}
  async reserveIntent(value:Batch5Intent){await this.saveIntent(value);if(this.task){this.task.batch5={version:1,channelId:value.channelId,operationId:value.operationId,sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:value.createdAt,stage:'reserved',accountId:this.task.accountId};this.task.checkpoint='batch5_reserved'}}
  async markSending(value:Batch5Intent){if(this.blockMutation||this.task?.batch5?.stage!=='reserved'||this.intent?.operationId!==value.operationId)throw Error('not authorized');this.task.batch5.stage='submitting';this.task.submittedAt=value.createdAt;this.task.checkpoint='batch5_submitting'}
  currentTaskState(){return this.task?.batch5}
  async loadIntent(){return this.intent}
  async saveReceipt(value:Batch5Receipt){this.receipt=structuredClone(value);this.receipts++}
  async loadReceipt(){return this.receipt}
  async saveOpaqueResponse(value:Batch5OpaqueResponse){this.opaque=structuredClone(value)}
  async loadOpaqueResponse(){return this.opaque}
  async assertReadyToSubmit(value:Batch5Intent){this.readyChecks++;assert.equal(value.operationId,this.intent?.operationId);if(this.blockMutation)throw Error('authorization_changed')}
}

function fixture(id:'whitewind'|'hackmd'){
  const site:Site={id:'site-1',domain:'example.com',url:'https://example.com/',email:'',name:'Example',description:'Educational material',
    category:'finance',language:'zh-CN',monthlyTarget:2,status:'ready',createdAt:NOW};
  const channel:Channel={id,name:id,domain:id==='whitewind'?'whtwnd.com':'hackmd.io',url:id==='whitewind'?'https://whtwnd.com/':'https://hackmd.io/',
    submitUrl:'https://example.com/',categories:['finance'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,
    free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'',rulesUrl:'https://example.com/terms',checkedAt:'2026-10-18',notes:'',allowedHosts:[],enabled:true};
  const account:Account={id:'account-1',channelId:id==='whitewind'?'bluesky':'hackmd',email:'',username:id==='whitewind'?DID:'hackmd-user-1',
    credentialKind:'api_token',hasPassword:true,status:'registered',createdAt:NOW};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:`${id}-task-1`,siteId:site.id,channelId:id,accountId:account.id,sourceDomain:channel.domain,status:'running',
    createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,
    draft:{title:TITLE,description:'Reliable context for public information.',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),
    contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const secrets=new Map<string,string>([[`account:${account.id}`,id==='whitewind'
    ?JSON.stringify({version:1,appPassword:'abcd-efgh-ijkl-mnop',handle:'writer.bsky.social',did:DID})
    :'hackmd-test-token-123456789']]);
  const journal=new Journal(),checkpoints:Partial<Task>[]=[];journal.task=task;
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},
    getAccount:()=>account,saveAccount:async()=>undefined,
    checkpoint:partial=>{checkpoints.push(structuredClone(partial));Object.assign(task,partial)},log:()=>undefined,
    batch5Persistence:journal};
  return {context,task,journal,checkpoints};
}

test('WhiteWind saves intent before createRecord, reads original and verifies visible public link',async()=>{
  const f=fixture('whitewind');let record:Record<string,unknown>|undefined,rkey='',createCalls=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
    if(url.endsWith('/com.atproto.repo.createRecord')){assert.ok(f.journal.intent);assert.equal(f.task.batch5?.stage,'submitting');
      createCalls++;const body=JSON.parse(String(init.body));rkey=body.rkey;record=body.record;
      assert.equal(body.collection,'com.whtwnd.blog.entry');assert.equal(body.validate,false);assert.equal(body.record.visibility,'public');
      return json({uri:`at://${DID}/com.whtwnd.blog.entry/${rkey}`,cid:'bafyWhiteWindRecordCid'},201)}
    if(url.includes('/com.atproto.repo.getRecord?'))return json({uri:`at://${DID}/com.whtwnd.blog.entry/${rkey}`,cid:'bafyWhiteWindRecordCid',value:record});
    throw Error(`Unexpected ${url}`)
  },renderPage:async(url,target,title,markdown)=>{assert.equal(url,`https://whtwnd.com/writer.bsky.social/${rkey}`);assert.equal(target,TARGET);assert.equal(title,TITLE);assert.equal(markdown,BODY);return {found:true,indexable:true,rel:'nofollow'}}};
  const created=await runWhiteWindTask(f.context);assert.equal(created.status,'review');assert.equal(createCalls,1);
  assert.equal(f.journal.readyChecks,1);
  assert.equal(f.journal.receipt?.remoteId,rkey);assert.ok(f.journal.opaque?.bodyBase64);
  assert.equal(whiteWindRkey(f.journal.intent!),rkey);
  const checked=await verifyWhiteWindPublication(f.context);assert.equal(checked.found,true);assert.equal(checked.rel,'nofollow');
  assert.equal(f.task.batch5?.stage,'api_receipt');
  assert.equal(f.checkpoints.some(value=>value.checkpoint==='batch5_published'),false);
});

test('WhiteWind 429 and unknown outcome never trigger a second createRecord',async()=>{
  const limited=fixture('whitewind');let creates=0,reads=0;
  limited.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url)=>{
    if(url.endsWith('com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
    if(url.endsWith('com.atproto.repo.createRecord')){creates++;return json({error:'RateLimitExceeded'},429)}
    if(url.includes('com.atproto.repo.getRecord?')){reads++;return json({error:'RecordNotFound'},404)}
    throw Error(url)
  }};
  const first=await runWhiteWindTask(limited.context),second=await runWhiteWindTask(limited.context);
  assert.equal(first.reasonCode,'platform_rate_limited');assert.equal(second.reasonCode,'submission_unknown');assert.equal(creates,1);assert.equal(reads,1);
  const unknown=fixture('whitewind');let remote:Record<string,unknown>|undefined,key='',sent=0;
  unknown.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
    if(url.endsWith('com.atproto.repo.createRecord')){sent++;const body=JSON.parse(String(init.body));key=body.rkey;remote=body.record;throw Error('connection dropped after commit')}
    if(url.includes('com.atproto.repo.getRecord?'))return json({uri:`at://${DID}/com.whtwnd.blog.entry/${key}`,cid:'bafyWhiteWindRecordCid',value:Object.fromEntries(Object.entries(remote??{}).reverse())});
    throw Error(url)
  }};
  assert.equal((await runWhiteWindTask(unknown.context)).reasonCode,'submission_unknown');
  assert.equal((await runWhiteWindTask(unknown.context)).status,'review');assert.equal(sent,1);
});

test('WhiteWind noindex public page does not finish verification',async()=>{
  const f=fixture('whitewind');let record:Record<string,unknown>|undefined,key='';
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
    if(url.endsWith('com.atproto.repo.createRecord')){const body=JSON.parse(String(init.body));key=body.rkey;record=body.record;return json({uri:`at://${DID}/com.whtwnd.blog.entry/${key}`,cid:'bafyWhiteWindRecordCid'},201)}
    if(url.includes('com.atproto.repo.getRecord?'))return json({uri:`at://${DID}/com.whtwnd.blog.entry/${key}`,cid:'bafyWhiteWindRecordCid',value:record});
    throw Error(url)
  },renderPage:async()=>({found:true,indexable:false,rel:''})};
  await runWhiteWindTask(f.context);const result=await verifyWhiteWindPublication(f.context);
  assert.equal(result.found,false);assert.equal(result.outcome,'invalid');assert.equal(f.task.batch5?.stage,'api_receipt');
});

const HACK_NOTE={id:'hackmd-note-123456789',shortId:'public-note-123456789',title:TITLE,content:BODY,readPermission:'guest',writePermission:'owner'};

test('HackMD creates guest-readable note once, reads exact content and verifies rendered link',async()=>{
  const f=fixture('hackmd');let creates=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url==='https://api.hackmd.io/v1/notes'&&init.method==='POST'){assert.ok(f.journal.intent);creates++;
      assert.equal(JSON.parse(String(init.body)).readPermission,'guest');return json(HACK_NOTE,201)}
    if(url.endsWith(`/notes/${HACK_NOTE.id}`))return json(HACK_NOTE);
    throw Error(url)
  },renderPage:async(url,target,title,markdown)=>{assert.equal(url,`https://hackmd.io/${HACK_NOTE.shortId}`);assert.equal(target,TARGET);assert.equal(title,TITLE);assert.equal(markdown,BODY);return {found:true,indexable:true,rel:''}}};
  assert.equal((await runHackMdTask(f.context)).status,'review');assert.equal(creates,1);
  assert.equal(f.journal.readyChecks,1);
  assert.equal(f.journal.receipt?.remoteId,HACK_NOTE.id);assert.ok(f.journal.opaque?.bodyBase64);
  assert.equal((await verifyHackMdPublication(f.context)).found,true);assert.equal(f.task.batch5?.stage,'api_receipt');
  assert.equal(f.checkpoints.some(value=>value.checkpoint==='batch5_published'),false);
});

test('HackMD 429, unknown result and restart recovery use only GET after original POST',async()=>{
  const limited=fixture('hackmd');let creates=0,reads=0;
  limited.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(init.method==='POST'){creates++;return json({error:'rate limit'},429)}
    reads++;return json([])
  }};
  assert.equal((await runHackMdTask(limited.context)).reasonCode,'platform_rate_limited');
  assert.equal((await runHackMdTask(limited.context)).reasonCode,'submission_unknown');assert.equal(creates,1);assert.equal(reads,1);
  const f=fixture('hackmd');let sent=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(init.method==='POST'){sent++;throw Error('socket reset after commit')}
    if(url==='https://api.hackmd.io/v1/notes')return json([HACK_NOTE]);
    if(url.endsWith(`/notes/${HACK_NOTE.id}`))return json(HACK_NOTE);
    throw Error(url)
  }};
  assert.equal((await runHackMdTask(f.context)).reasonCode,'submission_unknown');
  assert.equal((await runHackMdTask(f.context)).status,'review');assert.equal(sent,1);
});

test('HackMD visible link with noindex does not pass first-publication acceptance',async()=>{
  const f=fixture('hackmd');f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(init.method==='POST')return json(HACK_NOTE,201);
    if(url.endsWith(`/notes/${HACK_NOTE.id}`))return json(HACK_NOTE);
    throw Error(url)
  },renderPage:async()=>({found:true,indexable:false,rel:''})};
  await runHackMdTask(f.context);const result=await verifyHackMdPublication(f.context);
  assert.equal(result.found,false);assert.equal(result.outcome,'invalid');
  assert.equal(f.task.batch5?.stage,'api_receipt');
});

test('WhiteWind and HackMD recheck authorization after durable intent and do not submit when paused',async()=>{
  for(const channel of ['whitewind','hackmd'] as const){
    const f=fixture(channel);f.journal.blockMutation=true;let mutations=0;
    f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
      if(channel==='whitewind'&&url.endsWith('com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
      if(init.method==='POST')mutations++;
      throw Error(`Unexpected ${url}`)
    }};
    const result=channel==='whitewind'?await runWhiteWindTask(f.context):await runHackMdTask(f.context);
    assert.equal(result.status,channel==='hackmd'?'queued':'review');assert.equal(mutations,0);assert.equal(f.journal.readyChecks,1);
    assert.ok(f.journal.intent);assert.equal(f.task.batch5?.stage,channel==='hackmd'?'reserved':'submitting');
    if(channel==='hackmd')assert.equal(f.task.submittedAt,undefined);
  }
});

test('HackMD resumes the same proved-unsent intent and sends one POST after authorization returns',async()=>{
  const f=fixture('hackmd');f.journal.blockMutation=true;let posts=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(init.method==='POST'){posts++;return json(HACK_NOTE,201)}
    if(url.endsWith(`/notes/${HACK_NOTE.id}`))return json(HACK_NOTE);
    throw Error(url)
  }};
  const unsent=await runHackMdTask(f.context),operationId=f.journal.intent?.operationId;
  assert.equal(unsent.status,'queued');assert.equal(unsent.submittedAt,undefined);
  assert.equal(posts,0);assert.equal(f.task.batch5?.stage,'reserved');
  f.journal.blockMutation=false;
  const sent=await runHackMdTask(f.context);
  assert.equal(sent.status,'review');assert.equal(posts,1);
  assert.equal(f.journal.intent?.operationId,operationId);assert.equal(f.journal.intents,1);
  assert.equal(f.task.batch5?.stage,'api_receipt');
  await runHackMdTask(f.context);assert.equal(posts,1);
});

test('connected publishers keep definite 4xx terminal and count only platform failures in trials',async()=>{
  for(const channel of ['whitewind','hackmd'] as const){
    for(const [status,reasonCode,trial] of [[400,'format_invalid',false],[401,'account_handoff',false],[403,'account_handoff',false],[409,'platform_rejected',true],[429,'platform_rate_limited',true]] as const){
      const f=fixture(channel);
      f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
        if(channel==='whitewind'&&url.endsWith('/com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
        if(init.method==='POST')return json({error:'synthetic refusal'},status);
        throw Error(`Unexpected ${url}`);
      }};
      const result=channel==='whitewind'?await runWhiteWindTask(f.context):await runHackMdTask(f.context);
      assert.equal(result.status,'failed');assert.equal(result.reasonCode,reasonCode);assert.equal(result.checkpoint,'batch5_rejected');
      assert.equal(!!result.trialFailure,trial);assert.ok(f.journal.intent);
    }
  }
});

test('connected verification twice keeps a published receipt stage',async()=>{
  for(const channel of ['whitewind','hackmd'] as const){
    const f=fixture(channel);let record:Record<string,unknown>|undefined,rkey='';
    f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
      if(channel==='whitewind'&&url.endsWith('/com.atproto.server.createSession'))return json({did:DID,accessJwt:'valid-access-token-123456789'});
      if(channel==='whitewind'&&url.endsWith('/com.atproto.repo.createRecord')){const body=JSON.parse(String(init.body));record=body.record;rkey=body.rkey;return json({uri:`at://${DID}/com.whtwnd.blog.entry/${rkey}`,cid:'bafyWhiteWindRecordCid'},201)}
      if(channel==='whitewind'&&url.includes('/com.atproto.repo.getRecord?'))return json({uri:`at://${DID}/com.whtwnd.blog.entry/${rkey}`,cid:'bafyWhiteWindRecordCid',value:record});
      if(channel==='hackmd'&&init.method==='POST')return json(HACK_NOTE,201);
      if(channel==='hackmd'&&url.endsWith(`/notes/${HACK_NOTE.id}`))return json(HACK_NOTE);
      throw Error(`Unexpected ${url}`);
    },renderPage:async()=>({found:true,indexable:true,rel:''})};
    if(channel==='whitewind'){await runWhiteWindTask(f.context);assert.equal((await verifyWhiteWindPublication(f.context)).found,true)}
    else{await runHackMdTask(f.context);assert.equal((await verifyHackMdPublication(f.context)).found,true)}
    assert.equal(f.task.batch5?.stage,'api_receipt');
    f.task.batch5={...f.task.batch5!,stage:'published'};f.task.checkpoint='batch5_published';
    if(channel==='whitewind')assert.equal((await verifyWhiteWindPublication(f.context)).found,true);
    else assert.equal((await verifyHackMdPublication(f.context)).found,true);
    assert.equal(f.task.batch5?.stage,'published');
    assert.equal(f.checkpoints.some(value=>value.batch5?.stage==='published'),false);
  }
});

test('connected verifier reports local journal or secret read errors as unreachable',async()=>{
  for(const channel of ['whitewind','hackmd'] as const){
    const f=fixture(channel);
    f.task.batch5={
      version:1,channelId:channel,operationId:'local-op',sourceHash:'a'.repeat(64),
      requestHash:'b'.repeat(64),createdAt:NOW,stage:'api_receipt',
    };
    f.context.secrets.get=async()=>{throw Error('local vault unavailable')};
    const result=channel==='whitewind'?await verifyWhiteWindPublication(f.context):await verifyHackMdPublication(f.context);
    assert.equal(result.found,false);
    assert.equal(result.outcome,'unreachable');
  }
});
