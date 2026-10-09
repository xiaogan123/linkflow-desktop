import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {marked} from 'marked';
import {approvedProseArticle,reconcileProseTask,runProseTask,serializeProseCredentials,validSerializedProseCredentials,verifyProsePublication} from '../src/integrations/prose';
import {ProseTransportError,type ExpectedProseIdentity,type ProseCredentials,type ProseIdentity,type ProseSourceResult,type ProseTransport,type ProseWriteReceipt} from '../src/integrations/prose-transport';
import {validateBackup} from '../src/main/backup-validation';
import {Controller} from '../src/main/controller';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {recoverInterrupted} from '../src/main/planner';
import {hasExternalAttempt} from '../src/main/task-recovery';
import {saveTaskDraft} from '../src/main/task-draft';
import {applySiteUpdate} from '../src/main/site-service';
import {defaultSettings,emptyState,Store} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import type {Account,Channel,ExecutionContext,ProseReceipt,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const NOW='2026-10-09T02:00:00.000Z';
const SITE_ID='11111111-1111-4111-8111-111111111111';
const TASK_ID='22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID='33333333-3333-4333-8333-333333333333';
const BINDING_ID='44444444-4444-4444-8444-444444444444';
const USER='example-notes';
const TARGET='https://example.com/research/source-checking';
const OTHER='https://www.iana.org/help/example-domains';
const TITLE='A reproducible source-checking workflow';
const BODY=[
  `A useful source check records the exact claim, publication date, and the evidence that could change. The [maintained research notes](${TARGET}) explain the related operating context and the limits of that evidence. A reader should still compare the current primary source before relying on any conclusion.`,
  `The workflow separates observation from interpretation, keeps unresolved questions visible, and links to [IANA's example-domain notes](${OTHER}) as an independent reference. This is promotional educational writing for the linked site, which may receive referral commissions; that relationship does not prove accuracy or guarantee any financial or search result.`,
].join('\n\n');
const IDENTITY:ExpectedProseIdentity={name:USER,id:'user-123',keyFingerprint:`SHA256:${'A'.repeat(43)}`};
const RAW_KEY='synthetic-private-key-for-local-fixture-only';

function channel(overrides:Partial<Channel>={}):Channel{return {id:'prose',name:'Prose',domain:'prose.sh',url:'https://prose.sh/',submitUrl:'https://prose.sh/',categories:['content'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'conditional',freeNote:'Invitation required',automation:'api',quality:'B',qualityReason:'Original publication',provenance:'built-in',rulesUrl:'https://pico.sh/ops',checkedAt:'2026-10-09',notes:'',allowedHosts:['prose.sh'],enabled:true,...overrides}}

function fixture(overrides:{task?:Partial<Task>;account?:Partial<Account>;channel?:Partial<Channel>}={}){
  const site:Site={id:SITE_ID,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example Lab',description:'Source research',category:'education',language:'en',monthlyTarget:2,status:'ready',createdAt:NOW};
  const task:Task={id:TASK_ID,siteId:SITE_ID,channelId:'prose',accountId:ACCOUNT_ID,sourceDomain:'prose.sh',status:'running',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,draft:{title:TITLE,description:'A source-checking method',body:BODY},articleApprovedAt:NOW,...overrides.task};
  let account:Account={id:ACCOUNT_ID,channelId:'prose',email:'',username:USER,publicationUrl:`https://${USER}.prose.sh/`,credentialKind:'api_token',status:'registered',hasPassword:true,source:'imported',registrationAttempts:0,createdAt:NOW,...overrides.account};
  const secret=serializeProseCredentials({privateKey:RAW_KEY},IDENTITY),secrets=new Map([[`account:${ACCOUNT_ID}`,secret]]),checkpoints:Partial<Task>[]=[];
  let checkpointFailure=false;
  const context:ExecutionContext={site,task,channel:channel(overrides.channel),settings:defaultSettings(),signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},secrets:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}},getAccount:()=>account,saveAccount:async next=>{account=next},checkpoint:partial=>{if(checkpointFailure)throw Error('save failed');checkpoints.push(structuredClone(partial));Object.assign(task,partial)},log:()=>undefined};
  return {site,task,context,secrets,checkpoints,account:()=>account,setAccount:(next:Account)=>{account=next},failCheckpoint:()=>{checkpointFailure=true}};
}

class MemoryTransport implements ProseTransport{
  readonly remote=new Map<string,string>();
  reads=0;writes=0;lostAck=false;afterRead?:()=>void;
  async readIdentity(_credentials:ProseCredentials):Promise<ProseIdentity>{throw Error('publisher must use the bound identity through readSource/writeSource')}
  async readSource(_credentials:ProseCredentials,filename:string,_expected:ExpectedProseIdentity):Promise<ProseSourceResult>{this.reads++;const source=this.remote.get(filename);this.afterRead?.();return source===undefined?{status:'missing',filename}:{status:'found',filename,source,bytes:Buffer.byteLength(source),sha256:sha(source)}}
  async writeSource(_credentials:ProseCredentials,filename:string,approvedText:string,expected:ExpectedProseIdentity):Promise<ProseWriteReceipt>{this.writes++;this.remote.set(filename,approvedText);if(this.lostAck)throw new ProseTransportError('write_outcome_unknown');return {status:'written',filename,bytes:Buffer.byteLength(approvedText),sha256:sha(approvedText),identity:expected}}
}

const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

function page(body=BODY,title=TITLE,extra='',bodySuffix=''){
  return `<!doctype html><html><head>${extra}</head><body id="post"><main><h1>${title}</h1><article class="md">${String(marked.parse(body,{async:false,gfm:true}))}${bodySuffix}</article><footer><a href="${TARGET}">footer only</a></footer></main></body></html>`;
}
function publicFetch(html=page(),status=200,headers:Record<string,string>={}):{fetch:(url:string,init:RequestInit)=>Promise<Response>;calls:Array<{url:string;init:RequestInit}>}{
  const calls:Array<{url:string;init:RequestInit}>=[];
  return {calls,fetch:async(url,init)=>{calls.push({url,init});return new Response(html,{status,headers:{'content-type':'text/html; charset=utf-8',...headers}})}};
}

test('fresh publish persists the stable identity, filename and exact source hash before the only write',async()=>{
  const f=fixture(),transport=new MemoryTransport(),web=publicFetch();
  const originalWrite=transport.writeSource.bind(transport);
  transport.writeSource=async(...args)=>{assert.equal(f.task.checkpoint,'prose_publish_submitting');assert.equal(f.task.submittedAt,NOW);assert.equal(f.task.prose?.filename,`lf-${TASK_ID.replaceAll('-','')}.md`);assert.equal(f.task.prose?.sourceHash,approvedProseArticle(f.task,f.site.url,false).sourceHash);return originalWrite(...args)};
  const result=await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)});
  assert.equal(result.prose?.stage,'published');assert.equal(result.checkpoint,'prose_published');assert.equal(transport.writes,1);assert.equal(f.checkpoints.length,2);
  assert.equal(web.calls[0].init.redirect,'manual');assert.equal((web.calls[0].init.headers as Record<string,string>).authorization,undefined);assert.ok(!JSON.stringify(result).includes(RAW_KEY));
});

test('real Controller accepts a valid independent AI approval without adding a manual approval timestamp',async()=>{
  const f=fixture(),store=new Store(':memory:'),entry=channel();f.site.category='content';f.site.articleReviewMode='ai';delete f.task.articleApprovedAt;f.task.status='running';
  const state=emptyState();state.settings.autoRun=true;state.settings.articleReviewMode='ai';state.settings.channelOverrides={prose:true};state.sites=[f.site];state.accounts=[f.account()];state.accountBindings=[{id:BINDING_ID,siteId:SITE_ID,channelId:'prose',accountId:ACCOUNT_ID,createdAt:NOW,updatedAt:NOW}];
  f.task.articleReview={status:'passed',reason:'synthetic independent review',reasonCode:'passed',reviewedAt:NOW,evidenceUrls:[f.site.url,entry.rulesUrl],draftRevision:f.task.draftRevision??0,contentHash:articleContentHash(f.task),contextHash:articleContextHash(f.site,entry,state.settings,f.account())};state.tasks=[f.task];store.update(current=>Object.assign(current,state));
  const secret=f.secrets.get(`account:${ACCOUNT_ID}`),vault={ready:true,available:()=>true,get:async(key:string)=>key===`account:${ACCOUNT_ID}`?secret:undefined,set:async()=>{},delete:async()=>{},encryptSecrets:()=>({})} as unknown as Vault;
  const catalogIndex=CHANNELS.findIndex(item=>item.id==='prose'),catalogEntry=catalogIndex>=0?CHANNELS[catalogIndex]:undefined;if(catalogIndex>=0)CHANNELS[catalogIndex]=entry;else CHANNELS.push(entry);try{
    const controller=new Controller(store,vault,'fixture');store.update(current=>{current.tasks[0].status='running'});const stored=store.read().tasks[0];assert.equal(stored.articleApprovedAt,undefined);
    const execution=(controller as unknown as {context(task:Task,signal:AbortSignal):ExecutionContext}).context(stored,new AbortController().signal);assert.equal(execution.task.articleApprovedAt,NOW);let checkpointError='';const checkpoint=execution.checkpoint;execution.checkpoint=partial=>{try{checkpoint(partial)}catch(cause){checkpointError=cause instanceof Error?cause.message:String(cause);throw cause}};
    const transport=new MemoryTransport(),result=await runProseTask(execution,{transport,fetch:publicFetch().fetch,now:()=>new Date(NOW)});
    assert.equal(result.prose?.stage,'published',`${JSON.stringify(result)} ${checkpointError}`);assert.equal(transport.writes,1);assert.equal(store.read().tasks[0].articleApprovedAt,undefined);assert.equal(store.read().tasks[0].checkpoint,'prose_publish_submitting');
  }finally{if(catalogEntry)CHANNELS[catalogIndex]=catalogEntry;else CHANNELS.splice(CHANNELS.lastIndexOf(entry),1);store.close()}
});

test('an identical remote source is adopted only after complete public title, body and every link match',async()=>{
  const f=fixture(),transport=new MemoryTransport(),article=approvedProseArticle(f.task,f.site.url),web=publicFetch();transport.remote.set(article.filename,article.source);
  const result=await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)});
  assert.equal(result.prose?.stage,'published');assert.equal(transport.writes,0);
  for(const html of [page(BODY,'Wrong title'),page(BODY,TITLE,'<style>h1{display:none}</style>'),page(BODY.replace(OTHER,'https://other.example/')),page('Short text',TITLE,'',String(marked.parse(BODY)))]){
    const bad=fixture();const t=new MemoryTransport(),a=approvedProseArticle(bad.task,bad.site.url);t.remote.set(a.filename,a.source);
    const held=await runProseTask(bad.context,{transport:t,fetch:publicFetch(html).fetch,now:()=>new Date(NOW)});assert.equal(held.publicUrl,undefined);assert.equal(t.writes,0);
  }
  const withHeading=fixture();withHeading.task.draft!.body+=`\n\n# Additional verification steps\n\nKeep the source date and unresolved questions visible.`;const headingTransport=new MemoryTransport(),headingArticle=approvedProseArticle(withHeading.task,withHeading.site.url);headingTransport.remote.set(headingArticle.filename,headingArticle.source);
  const adopted=await runProseTask(withHeading.context,{transport:headingTransport,fetch:publicFetch(page(withHeading.task.draft!.body)).fetch,now:()=>new Date(NOW)});assert.equal(adopted.prose?.stage,'published');assert.equal(headingTransport.writes,0);
});

test('a different source under the stable filename is a collision and is never overwritten',async()=>{
  const f=fixture(),transport=new MemoryTransport(),article=approvedProseArticle(f.task,f.site.url);transport.remote.set(article.filename,'different remote source');
  const result=await runProseTask(f.context,{transport,fetch:publicFetch().fetch,now:()=>new Date(NOW)});
  assert.equal(result.status,'needs_input');assert.match(result.message,/不会覆盖/);assert.equal(transport.writes,0);assert.equal(transport.remote.get(article.filename),'different remote source');
});

test('lost acknowledgement resolves through the same filename and later invocations never write again',async()=>{
  const f=fixture(),transport=new MemoryTransport(),web=publicFetch();transport.lostAck=true;
  const first=await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)});Object.assign(f.task,first);
  assert.equal(first.prose?.stage,'published');assert.equal(transport.writes,1);
  await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)});assert.equal(transport.writes,1);
});

test('checkpoint failure and read-await changes to draft, approval, account or credential all produce zero writes',async()=>{
  const failed=fixture();failed.failCheckpoint();const never=new MemoryTransport();await runProseTask(failed.context,{transport:never,fetch:publicFetch().fetch,now:()=>new Date(NOW)});assert.equal(never.reads,0);assert.equal(never.writes,0);
  for(const change of [
    (f:ReturnType<typeof fixture>)=>{f.task.draft!.body+=' changed'},
    (f:ReturnType<typeof fixture>)=>{delete f.task.articleApprovedAt},
    (f:ReturnType<typeof fixture>)=>{f.setAccount({...f.account(),id:'55555555-5555-4555-8555-555555555555'})},
    (f:ReturnType<typeof fixture>)=>{f.secrets.set(`account:${ACCOUNT_ID}`,serializeProseCredentials({privateKey:'replacement-key'},IDENTITY))},
  ]){
    const f=fixture(),transport=new MemoryTransport();transport.afterRead=()=>change(f);
    const result=await runProseTask(f.context,{transport,fetch:publicFetch().fetch,now:()=>new Date(NOW)});assert.equal(result.publicUrl,undefined);assert.equal(transport.writes,0);
  }
});

test('a saved receipt reconciles read-only and modified source or switched identity cannot publish',async()=>{
  const f=fixture(),transport=new MemoryTransport(),web=publicFetch();Object.assign(f.task,await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)}));
  f.task.draft!.title='Changed title';assert.equal((await reconcileProseTask(f.context,{transport,fetch:web.fetch})).status,'unknown');assert.equal(transport.writes,1);
  f.task.draft!.title=TITLE;f.secrets.set(`account:${ACCOUNT_ID}`,serializeProseCredentials({privateKey:'replacement'}, {...IDENTITY,id:'different-user-id'}));assert.equal((await reconcileProseTask(f.context,{transport,fetch:web.fetch})).status,'unknown');assert.equal(transport.writes,1);
});

test('public verification is bounded, refuses redirects and pre-aborted requests, and never carries the private key',async()=>{
  const f=fixture(),transport=new MemoryTransport(),web=publicFetch();Object.assign(f.task,await runProseTask(f.context,{transport,fetch:web.fetch,now:()=>new Date(NOW)}));
  const redirect=await verifyProsePublication(f.task,f.site.url,{fetch:publicFetch('',302,{location:'https://other.example/'}).fetch});assert.equal(redirect.found,false);
  let calls=0;const abort=new AbortController();abort.abort();const stopped=await verifyProsePublication(f.task,f.site.url,{signal:abort.signal,fetch:async()=>{calls++;return new Response(page(),{headers:{'content-type':'text/html'}})}});assert.equal(stopped.found,false);assert.equal(calls,0);
  let cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(1_100_000));},cancel(){cancelled=true}});const oversized=await verifyProsePublication(f.task,f.site.url,{fetch:async(_url,init)=>{assert.ok(!JSON.stringify(init).includes(RAW_KEY));return new Response(stream,{headers:{'content-type':'text/html'}})}});assert.equal(oversized.found,false);assert.equal(cancelled,true);
});

for(const rejected of ['length','redirect','foreign-url','content-type'] as const)
test(`Prose disposes a public response rejected for ${rejected} and preserves its receipt`,async()=>{
  const f=fixture(),transport=new MemoryTransport();
  Object.assign(f.task,await runProseTask(f.context,{transport,fetch:publicFetch().fetch,now:()=>new Date(NOW)}));
  const before=structuredClone(f.task);let cancels=0,pulls=0;let signal:AbortSignal|undefined;
  const result=await verifyProsePublication(f.task,f.site.url,{fetch:async(_url,init)=>{
    assert.equal(init.method,'GET');signal=init.signal as AbortSignal;
    const response=new Response(new ReadableStream<Uint8Array>({pull(){pulls++},cancel(){cancels++}},{highWaterMark:0}),{
      status:rejected==='redirect'?302:200,
      headers:{'content-type':rejected==='content-type'?'application/json':'text/html','content-length':rejected==='length'?'2000001':'1'},
    });
    if(rejected==='foreign-url')Object.defineProperty(response,'url',{value:'https://other.example/'});
    return response;
  }});
  assert.equal(result.found,false);assert.equal(cancels,1);assert.equal(pulls,0);assert.equal(signal?.aborted,true);
  assert.deepEqual(f.task,before);assert.equal(transport.writes,1);
});

for(const cause of ['timeout','actual-overlong'] as const)
test(`Prose ${cause} verification settles while response cancellation is still pending`,{timeout:2000},async()=>{
  const f=fixture(),transport=new MemoryTransport();
  Object.assign(f.task,await runProseTask(f.context,{transport,fetch:publicFetch().fetch,now:()=>new Date(NOW)}));
  const before=structuredClone(f.task);let cancels=0,settled=false;
  let signal:AbortSignal|undefined,entered!:()=>void,release!:()=>void;
  const cancelling=new Promise<void>(resolve=>{entered=resolve}),cancellation=new Promise<void>(resolve=>{release=resolve});
  const operation=verifyProsePublication(f.task,f.site.url,{timeoutMs:100,fetch:async(_url,init)=>{
    signal=init.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller){if(cause==='actual-overlong')controller.enqueue(new Uint8Array(2000001))},
      cancel(){cancels++;entered();return cancellation},
    },{highWaterMark:0}),{headers:{'content-type':'text/html'}});
  }}).then(result=>{settled=true;return result});
  const guard=setTimeout(entered,700);
  try{
    await cancelling;await Promise.race([operation,new Promise<void>(resolve=>setTimeout(resolve,150))]);
    assert.equal(settled,true);assert.equal(cancels,1);assert.equal(signal?.aborted,true);assert.deepEqual(f.task,before);
    assert.equal((await operation).found,false);assert.equal(transport.writes,1);
  }finally{clearTimeout(guard);release();await operation}
});

test('disabled or custom direct contexts and unsupported Markdown images never reach transport',async()=>{
  for(const override of [{enabled:false},{provenance:'custom' as const}]){const f=fixture({channel:override}),transport=new MemoryTransport();const result=await runProseTask(f.context,{transport,fetch:publicFetch().fetch});assert.equal(result.status,'needs_input');assert.equal(transport.reads,0);assert.equal(transport.writes,0)}
  for(const image of [`![diagram](https://example.com/image.png)`,`[diagram]: https://example.org/diagram.png\n\n![diagram]`]){const f=fixture();f.task.draft!.body+=`\n\n${image}`;const transport=new MemoryTransport();await runProseTask(f.context,{transport,fetch:publicFetch().fetch});assert.equal(transport.reads,0);assert.equal(transport.writes,0)}
});

test('stored credentials fit the existing backup secret limit and malformed receipts are never echoed',async()=>{
  assert.throws(()=>serializeProseCredentials({privateKey:'x'.repeat(16_384)},IDENTITY),/密钥记录无效/);
  const serialized=serializeProseCredentials({privateKey:'x'.repeat(15_000),passphrase:'phrase'},IDENTITY);
  assert.ok(Buffer.byteLength(serialized,'utf8')<=16_384);assert.equal(validSerializedProseCredentials(serialized),true);
  const f=fixture({task:{prose:{username:USER,platformUserId:IDENTITY.id,keyFingerprint:IDENTITY.keyFingerprint,filename:`lf-${TASK_ID.replaceAll('-','')}.md`,sourceHash:'0'.repeat(64),stage:'submitting',privateKey:RAW_KEY} as unknown as ProseReceipt}}),transport=new MemoryTransport();
  const result=await runProseTask(f.context,{transport,fetch:publicFetch().fetch});assert.equal(result.status,'needs_input');assert.equal(result.prose,undefined);assert.ok(!JSON.stringify(result).includes(RAW_KEY));assert.equal(transport.reads,0);assert.equal(transport.writes,0);
});

test('an imported receipt without submittedAt preserves its draft and topic and can never republish',async()=>{
  const f=fixture(),article=approvedProseArticle(f.task,f.site.url),receipt:ProseReceipt={username:USER,platformUserId:IDENTITY.id,keyFingerprint:IDENTITY.keyFingerprint,filename:article.filename,sourceHash:article.sourceHash,stage:'submitting'};
  const state=emptyState();state.sites.push(f.site);state.accounts.push(f.account());state.accountBindings.push({id:BINDING_ID,siteId:SITE_ID,channelId:'prose',accountId:ACCOUNT_ID,createdAt:NOW,updatedAt:NOW});state.tasks.push({...f.task,status:'needs_input',checkpoint:'prose_publish_submitting',prose:receipt,submittedAt:undefined});
  const restored=validateBackup({state,secrets:{[`account:${ACCOUNT_ID}`]:f.secrets.get(`account:${ACCOUNT_ID}`)!}}).state,task=restored.tasks[0];
  assert.deepEqual(task.draft,f.task.draft);assert.equal(task.topicUrl,TARGET);assert.equal(task.submittedAt,undefined);assert.equal(hasExternalAttempt(task),true);assert.ok(!JSON.stringify(restored).includes(RAW_KEY));
  recoverInterrupted(restored,new Date(NOW));assert.equal(task.status,'needs_input');
  const context={...f.context,task,getAccount:()=>restored.accounts[0]};const transport=new MemoryTransport();await runProseTask(context,{transport,fetch:publicFetch().fetch});assert.equal(transport.writes,0);
});

test('receipt-only imported Prose work cannot be rewritten by draft or site edit paths',()=>{
  const f=fixture(),article=approvedProseArticle(f.task,f.site.url),receipt:ProseReceipt={username:USER,platformUserId:IDENTITY.id,keyFingerprint:IDENTITY.keyFingerprint,filename:article.filename,sourceHash:article.sourceHash,stage:'submitting'};
  const state=emptyState();state.sites=[f.site];state.tasks=[{...f.task,status:'needs_input',checkpoint:'prose_publish_submitting',prose:receipt,submittedAt:undefined}];const before=structuredClone(state.tasks[0]);
  assert.throws(()=>saveTaskDraft(state,TASK_ID,{...before.draft!,body:before.draft!.body+' replacement'}),/远程发布记录/);
  applySiteUpdate(state,{id:SITE_ID,name:'Changed site name'},new Date(NOW));
  assert.deepEqual(state.tasks[0].draft,before.draft);assert.equal(state.tasks[0].topicUrl,before.topicUrl);assert.deepEqual(state.tasks[0].prose,before.prose);assert.equal(state.tasks[0].checkpoint,before.checkpoint);
});
