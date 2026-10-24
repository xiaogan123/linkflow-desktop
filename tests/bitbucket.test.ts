import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  BITBUCKET_API_ORIGIN,
  bitbucketManifestHash,
  bitbucketPublicUrl,
  bitbucketRepositoryUrl,
  commitBitbucketRoot,
  createBitbucketRepository,
  prepareBitbucketManifest,
  probeBitbucketBinding,
  recoverBitbucketRepository,
  recoverBitbucketSource,
  verifyBitbucketPublication,
  type BitbucketBinding,
  type BitbucketFreePlanEvidence,
  type BitbucketIntent,
  type BitbucketOpaqueResponse,
  type BitbucketPersistence,
  type BitbucketReceipt,
  type BitbucketRepositoryReceipt,
  type BitbucketSourceIntent,
  type BitbucketSourceReceipt,
} from '../src/integrations/bitbucket';

const now=new Date('2026-10-24T12:00:00.000Z');
const token='fixture-bitbucket-token-1234567890';
const workspace='example-tools';
const userUuid='{11111111-1111-4111-8111-111111111111}';
const workspaceUuid='{22222222-2222-4222-8222-222222222222}';
const projectUuid='{33333333-3333-4333-8333-333333333333}';
const repositoryUuid='{44444444-4444-4444-8444-444444444444}';
const commitHash='a'.repeat(40);
const evidence:BitbucketFreePlanEvidence={version:1,workspaceId:workspace,plan:'Free',users:1,paymentAdded:false,paidTrialSelected:false,checkedAt:'2026-10-24T11:38:43.021Z',stateSha256:'1'.repeat(64),screenshotSha256:'2'.repeat(64)};
const targetUrl='https://example.com/help';
const files={
  'index.html':`<!doctype html><html><head><meta name="robots" content="index,follow"><link rel="canonical" href="${bitbucketPublicUrl(workspace)}"><title>Link report</title></head><body><main><h1>Link report</h1><p>Review one URL safely.</p><a href="${targetUrl}">Read the full guide</a></main><script src="./jsonl-core.js"></script><script>document.documentElement.dataset.ready='true';</script></body></html>`,
  'jsonl-core.js':`globalThis.parseJsonl=(value)=>value.split('\\n');\n`,
  'robots.txt':'User-agent: *\nAllow: /\n',
};
const manifest=prepareBitbucketManifest({workspaceSlug:workspace,files,reviewedManifestHash:bitbucketManifestHash(files),targetUrl});

function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function text(value:string,type:string,status=200){return new Response(value,{status,headers:{'content-type':type}})}
function sha(value:string|Uint8Array){return createHash('sha256').update(value).digest('hex')}
function headers(init:RequestInit){return new Headers(init.headers)}
function identityResponse(url:string):Response|undefined {
  const parsed=new URL(url);
  if(parsed.origin!==BITBUCKET_API_ORIGIN)return;
  if(parsed.pathname==='/2.0/user')return json({uuid:userUuid,display_name:'Fixture'});
  if(parsed.pathname==='/2.0/user/workspaces')return json({values:[{uuid:workspaceUuid,slug:workspace}],pagelen:100,size:1,page:1});
  if(parsed.pathname===`/2.0/user/workspaces/${workspace}/permission`)return json({permission:'owner',user:{uuid:userUuid},workspace:{uuid:workspaceUuid,slug:workspace}});
  if(parsed.pathname===`/2.0/workspaces/${workspace}`)return json({uuid:workspaceUuid,slug:workspace,is_private:true,is_personal:false});
  if(parsed.pathname===`/2.0/workspaces/${workspace}/permissions`)return json({values:[{permission:'owner',user:{uuid:userUuid},workspace:{uuid:workspaceUuid,slug:workspace}}]});
  if(parsed.pathname===`/2.0/workspaces/${workspace}/projects`)return json({values:[{uuid:projectUuid,key:'WEB',name:'Website',workspace:{uuid:workspaceUuid,slug:workspace}}]});
}
function repoObject(){return {uuid:repositoryUuid,slug:`${workspace}.bitbucket.io`,full_name:`${workspace}/${workspace}.bitbucket.io`,is_private:true,scm:'git',workspace:{uuid:workspaceUuid,slug:workspace},project:{uuid:projectUuid},created_on:'2026-10-24T12:00:10.000Z'}}
function fetcher(extra?:(url:string,init:RequestInit)=>Response|undefined|void|Promise<Response|undefined|void>){return async(url:string,init:RequestInit)=>{assert.equal(headers(init).get('authorization'),`Bearer ${token}`);const custom=await extra?.(url,init);if(custom)return custom;const identity=identityResponse(url);if(identity)return identity;throw Error(`unexpected ${init.method} ${url}`)}}

class Store implements BitbucketPersistence {
  readonly secretStorage='encrypted' as const;
  intents:BitbucketIntent[]=[];opaques:BitbucketOpaqueResponse[]=[];receipts:BitbucketReceipt[]=[];ready=true;failOpaque=false;failReceipt=false;
  async persistIntent(intent:BitbucketIntent){this.intents.push(structuredClone(intent))}
  assertReadyToSubmit(_intent:BitbucketIntent):true{if(!this.ready)throw Error('revoked');return true}
  async persistOpaqueResponse(response:BitbucketOpaqueResponse){if(this.failOpaque)throw Error('disk');this.opaques.push(structuredClone(response))}
  async loadOpaqueResponse(stage:BitbucketIntent['stage'],operationId:string){return this.opaques.find(item=>item.stage===stage&&item.operationId===operationId)}
  async promoteReceipt(receipt:BitbucketReceipt){if(this.failReceipt)throw Error('disk');this.receipts.push(structuredClone(receipt))}
}

async function binding():Promise<BitbucketBinding>{
  const result=await probeBitbucketBinding({token,workspaceSlug:workspace,projectUuid,freePlanEvidence:evidence},{fetch:fetcher(),now:()=>now});assert.equal(result.status,'usable');return result.binding;
}

test('prepares only reviewed index/jsonl-core/robots manifest and rejects public email leakage',()=>{
  assert.equal(manifest.repositorySlug,`${workspace}.bitbucket.io`);assert.equal(manifest.manifestHash,manifest.reviewedManifestHash);assert.deepEqual(Object.keys(manifest.files).sort(),['index.html','jsonl-core.js','robots.txt']);
  assert.throws(()=>prepareBitbucketManifest({workspaceSlug:workspace,files:{...files,'jsonl-core.js':'const email="owner@example.com";'},reviewedManifestHash:'0'.repeat(64),targetUrl}),/privacy/);
  assert.throws(()=>prepareBitbucketManifest({workspaceSlug:workspace,files,reviewedManifestHash:'0'.repeat(64),targetUrl}),/reviewed manifest/);
  assert.throws(()=>prepareBitbucketManifest({workspaceSlug:'not_dns',files,reviewedManifestHash:bitbucketManifestHash(files),targetUrl}),/identity/);
});

test('account probe exhaustively binds user, owner workspace, project and external Free evidence',async()=>{
  const calls:string[]=[];const result=await probeBitbucketBinding({token,workspaceSlug:workspace,projectUuid,freePlanEvidence:evidence},{fetch:fetcher((url)=>{calls.push(url)}),now:()=>now});
  assert.equal(result.status,'usable');if(result.status!=='usable')return;assert.equal(result.binding.workspaceUuid,workspaceUuid);assert.equal(result.binding.projectUuid,projectUuid);assert.equal(result.binding.permission,'owner');assert.equal(calls.length,6);
  const bad=await probeBitbucketBinding({token,workspaceSlug:workspace,projectUuid,freePlanEvidence:{...evidence,paymentAdded:true} as unknown as BitbucketFreePlanEvidence},{fetch:async()=>{throw Error('must not connect')},now:()=>now});assert.deepEqual(bad,{status:'invalid',reason:'evidence'});
});

test('repository create persists intent, probes fresh, requires 404, captures opaque then receipt',async()=>{
  const bound=await binding(),store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),calls:string[]=[];
  const result=await createBitbucketRepository({operationId:`bitbucket_${'1'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},store,{allowExternalWrite:true,now:()=>now,fetch:fetcher(async(url,init)=>{
    if(url!==repoUrl)return;calls.push(`${init.method}`);if(init.method==='GET')return new Response('',{status:404});const body=JSON.parse(String(init.body));assert.deepEqual(body,{scm:'git',is_private:true,project:{uuid:projectUuid}});return json(repoObject());
  })});
  assert.equal(result.status,'created');assert.deepEqual(calls,['GET','POST']);assert.equal(store.intents.length,1);assert.equal(store.opaques.length,1);assert.equal(store.receipts.length,1);
  if(result.status==='created')assert.equal(result.receipt.repositoryUuid,repositoryUuid);
});

test('existing repository and lost create response never cause a second POST',async()=>{
  const bound=await binding(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),existingStore=new Store();let posts=0;
  const existing=await createBitbucketRepository({operationId:`bitbucket_${'2'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},existingStore,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{if(url===repoUrl&&init.method==='GET')return json(repoObject());if(init.method==='POST')posts++;})});
  assert.deepEqual(existing,{status:'not_started',reason:'remote_exists'});assert.equal(posts,0);
  const lostStore=new Store(),lost=await createBitbucketRepository({operationId:`bitbucket_${'3'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},lostStore,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{if(url===repoUrl&&init.method==='GET')return new Response('',{status:404});if(init.method==='POST'){posts++;throw Error('lost')}})});assert.equal(lost.status,'unknown');
  const replay=await createBitbucketRepository({operationId:`bitbucket_${'3'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence,priorIntent:lostStore.intents[0] as never},lostStore,{allowExternalWrite:true,now:()=>now,fetch:async()=>{throw Error('must not connect')}});assert.equal(replay.status,'blocked');assert.equal(posts,1);
  const recovered=await recoverBitbucketRepository(lostStore.intents[0] as never,bound,token,lostStore,{fetch:fetcher((url)=>url===repoUrl?json(repoObject()):undefined),now:()=>now});assert.deepEqual(recovered,{status:'found_unowned',reason:'get_cannot_prove_original_submission'});
});

test('write defaults disabled and authorization/opaque storage failures never authorize a replay',async()=>{
  const bound=await binding(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),disabledStore=new Store();let calls=0,posts=0;
  const disabled=await createBitbucketRepository({operationId:`bitbucket_${'7'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},disabledStore,{now:()=>now,fetch:async()=>{calls++;throw Error('must not connect')}});assert.deepEqual(disabled,{status:'not_started',reason:'external_write_disabled'});assert.equal(calls,0);
  const revokedStore=new Store();revokedStore.ready=false;const revoked=await createBitbucketRepository({operationId:`bitbucket_${'8'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},revokedStore,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{if(url===repoUrl&&init.method==='GET')return new Response('',{status:404});if(init.method==='POST')posts++})});assert.deepEqual(revoked,{status:'not_started',reason:'authorization_changed'});assert.equal(posts,0);
  const failedStore=new Store();failedStore.failOpaque=true;const failed=await createBitbucketRepository({operationId:`bitbucket_${'9'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},failedStore,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{if(url===repoUrl&&init.method==='GET')return new Response('',{status:404});if(url===repoUrl&&init.method==='POST'){posts++;return json(repoObject())}})});assert.equal(failed.status,'unknown');if(failed.status==='unknown')assert.equal(failed.diagnostic,'opaque_persistence');
  const replay=await createBitbucketRepository({operationId:`bitbucket_${'9'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence,priorIntent:failedStore.intents[0] as never},failedStore,{allowExternalWrite:true,now:()=>now,fetch:async()=>{throw Error('must not connect')}});assert.equal(replay.status,'blocked');assert.equal(posts,1);
});

async function createdRepository(bound:BitbucketBinding):Promise<BitbucketRepositoryReceipt>{
  const store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),result=await createBitbucketRepository({operationId:`bitbucket_${'4'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence},store,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>url===repoUrl&&init.method==='GET'?new Response('',{status:404}):url===repoUrl&&init.method==='POST'?json(repoObject()):undefined)});assert.equal(result.status,'created');return (result as {status:'created';receipt:BitbucketRepositoryReceipt}).receipt;
}

test('root source commit sends one exact multipart manifest without author or parents and treats 201 body as opaque',async()=>{
  const bound=await binding(),repo=await createdRepository(bound),store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`);let formEntries:string[]=[];
  const result=await commitBitbucketRoot({operationId:`bitbucket_${'5'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence,repositoryReceipt:repo,manifest,message:'Publish reviewed Linkflow URL report'},store,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{
    if(url===repoUrl&&init.method==='GET')return json(repoObject());if(url===`${repoUrl}/refs/branches?pagelen=1`)return json({values:[]});if(url===`${repoUrl}/commits?pagelen=1`)return json({values:[]});if(url===`${repoUrl}/src`&&init.method==='POST'){assert.ok(init.body instanceof FormData);formEntries=[...init.body.keys()];return json({hash:commitHash},201)}
  })});
  assert.equal(result.status,'unknown');if(result.status==='unknown'){assert.equal(result.opaqueResponseSaved,true);assert.equal(result.diagnostic,'schema')}assert.deepEqual(formEntries,['branch','message','/index.html','/jsonl-core.js','/robots.txt']);assert.ok(!formEntries.includes('author')&&!formEntries.includes('parents'));assert.equal(store.opaques.length,1);
});

test('source commit refuses any pre-existing branch or commit before POST',async()=>{
  const bound=await binding(),repo=await createdRepository(bound),store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`);let posts=0;
  const result=await commitBitbucketRoot({operationId:`bitbucket_${'a'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence,repositoryReceipt:repo,manifest,message:'Publish reviewed Linkflow URL report'},store,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>{if(url===repoUrl&&init.method==='GET')return json(repoObject());if(url===`${repoUrl}/refs/branches?pagelen=1`)return json({values:[{name:'main'}]});if(url===`${repoUrl}/commits?pagelen=1`)return json({values:[]});if(init.method==='POST')posts++})});
  assert.deepEqual(result,{status:'not_started',reason:'remote_not_empty'});assert.equal(posts,0);
});

test('source commit snapshots reviewed nested manifest bytes before awaited preflight',async()=>{
  const bound=await binding(),repo=await createdRepository(bound),store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),mutable=structuredClone(manifest),originalMessage='Publish reviewed Linkflow URL report',sourceInput={operationId:`bitbucket_${'b'.repeat(32)}`,binding:structuredClone(bound),token,freePlanEvidence:structuredClone(evidence),repositoryReceipt:structuredClone(repo),manifest:mutable,message:originalMessage};let posted='',postedMessage='';
  const result=await commitBitbucketRoot(sourceInput,store,{allowExternalWrite:true,now:()=>now,fetch:fetcher(async(url,init)=>{
    if(url===repoUrl&&init.method==='GET')return json(repoObject());if(url===`${repoUrl}/refs/branches?pagelen=1`)return json({values:[]});if(url===`${repoUrl}/commits?pagelen=1`){mutable.files['jsonl-core.js']='UNREVIEWED BYTES';sourceInput.message='owner@example.com';sourceInput.token='replacement-token-that-must-not-be-used';sourceInput.binding.workspaceSlug='mutated';return json({values:[]})}if(url===`${repoUrl}/src`&&init.method==='POST'){const entry=(init.body as FormData).get('/jsonl-core.js');assert.ok(entry instanceof Blob);posted=await entry.text();postedMessage=String((init.body as FormData).get('message'));return json({},201)}
  })});
  assert.equal(result.status,'unknown');assert.equal(posted,files['jsonl-core.js']);assert.equal(postedMessage,originalMessage);assert.equal(sha(posted),store.intents[0].stage==='source_root_commit'?store.intents[0].fileHashes['jsonl-core.js']:'');
});

function remoteRoutes(intent:BitbucketSourceIntent,publicMode=false){
  const repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),commitDate='2026-10-24T12:00:20.000Z';
  return (url:string,init:RequestInit):Response|undefined=>{
    const authorization=headers(init).get('authorization');
    if(publicMode&&!authorization&&(url===repoUrl||url===`${repoUrl}/src/${commitHash}/index.html`))return new Response('',{status:403});
    if(url===repoUrl)return json(repoObject());if(url===`${repoUrl}/refs/branches/main`)return json({name:'main',target:{hash:commitHash}});
    if(url===`${repoUrl}/commit/${commitHash}`)return json({hash:commitHash,date:commitDate,parents:[],author:{user:{uuid:userUuid}}});
    if(url===`${repoUrl}/commits?pagelen=2`)return json({values:[{hash:commitHash}]});
    if(url===`${repoUrl}/src/${commitHash}/?pagelen=100`)return json({values:Object.entries(files).map(([path,value])=>({path,type:'commit_file',size:Buffer.byteLength(value),commit:{hash:commitHash}}))});
    for(const [path,value] of Object.entries(files))if(url===`${repoUrl}/src/${commitHash}/${path}`)return text(value,path==='index.html'?'text/html':path==='jsonl-core.js'?'text/javascript':'text/plain');
    if(publicMode&&url===manifest.publicUrl)return text(files['index.html'],'text/html');
    if(publicMode&&url===new URL('jsonl-core.js',manifest.publicUrl).href)return text(files['jsonl-core.js'],'text/javascript');
    if(publicMode&&url===new URL('robots.txt',manifest.publicUrl).href)return text(files['robots.txt'],'text/plain');
  };
}

async function committedFixture(){
  const bound=await binding(),repo=await createdRepository(bound),store=new Store(),repoUrl=bitbucketRepositoryUrl(workspace,`${workspace}.bitbucket.io`),result=await commitBitbucketRoot({operationId:`bitbucket_${'6'.repeat(32)}`,binding:bound,token,freePlanEvidence:evidence,repositoryReceipt:repo,manifest,message:'Publish reviewed Linkflow URL report'},store,{allowExternalWrite:true,now:()=>now,fetch:fetcher((url,init)=>url===repoUrl&&init.method==='GET'?json(repoObject()):url===`${repoUrl}/refs/branches?pagelen=1`?json({values:[]}):url===`${repoUrl}/commits?pagelen=1`?json({values:[]}):url===`${repoUrl}/src`&&init.method==='POST'?json({},201):undefined)});assert.equal(result.status,'unknown');return {bound,repo,store,intent:store.intents[0] as BitbucketSourceIntent};
}

test('GET-only source recovery proves one root commit, exact complete tree and exact bytes',async()=>{
  const {bound,store,intent}=await committedFixture(),recovered=await recoverBitbucketSource(intent,bound,manifest,token,store,{fetch:fetcher(remoteRoutes(intent)),now:()=>now});
  assert.equal(recovered.status,'found');if(recovered.status==='found'){assert.equal(recovered.receipt.commitHash,commitHash);assert.equal(recovered.receipt.authorUuidHash,sha(userUuid))}assert.equal(store.receipts.length,1);
});

test('source recovery refuses unexpected tree paths and does not write again',async()=>{
  const {bound,store,intent}=await committedFixture(),base=remoteRoutes(intent),recovered=await recoverBitbucketSource(intent,bound,manifest,token,store,{fetch:fetcher((url,init)=>url.endsWith(`/src/${commitHash}/?pagelen=100`)?json({values:[...Object.entries(files).map(([path,value])=>({path,type:'commit_file',size:Buffer.byteLength(value),commit:{hash:commitHash}})),{path:'private.txt',type:'commit_file',size:1,commit:{hash:commitHash}}]}):base(url,init)),now:()=>now});
  assert.deepEqual(recovered,{status:'found_unowned',reason:'get_cannot_prove_original_submission'});
});

test('final verification keeps repository private, denies anonymous API/Git and requires exact reviewed DOM until RUM shape is approved',async()=>{
  const {bound,store,intent}=await committedFixture(),recovered=await recoverBitbucketSource(intent,bound,manifest,token,store,{fetch:fetcher(remoteRoutes(intent)),now:()=>now});assert.equal(recovered.status,'found');const receipt=(recovered as {status:'found';receipt:BitbucketSourceReceipt}).receipt,seenPublicAuth:string[]=[];
  const result=await verifyBitbucketPublication({binding:bound,token,freePlanEvidence:evidence,manifest,receipt},{now:()=>now,fetch:async(url,init)=>{
    if(!url.startsWith(BITBUCKET_API_ORIGIN))seenPublicAuth.push(headers(init).get('authorization')??'');
    const route=remoteRoutes(intent,true)(url,init)??identityResponse(url);if(route)return route;throw Error(`unexpected ${url}`);
  }});
  assert.equal(result.status,'usable');assert.ok(seenPublicAuth.every(value=>value===''));
});

test('verification rejects altered derived origin and arbitrary injected scripts',async()=>{
  const {bound,store,intent}=await committedFixture(),recovered=await recoverBitbucketSource(intent,bound,manifest,token,store,{fetch:fetcher(remoteRoutes(intent)),now:()=>now});assert.equal(recovered.status,'found');const receipt=(recovered as {status:'found';receipt:BitbucketSourceReceipt}).receipt;
  const altered={...manifest,publicUrl:'https://unapproved.example/'};const derived=await verifyBitbucketPublication({binding:bound,token,freePlanEvidence:evidence,manifest:altered,receipt},{now:()=>now,fetch:async()=>{throw Error('must not connect')}});assert.deepEqual(derived,{status:'invalid',reason:'binding'});
  const route=remoteRoutes(intent,true),injected=await verifyBitbucketPublication({binding:bound,token,freePlanEvidence:evidence,manifest,receipt},{now:()=>now,fetch:async(url,init)=>{
    if(url===manifest.publicUrl)return text(files['index.html'].replace('</body>','<script src="https://unapproved.example/collect-input.js"></script></body>'),'text/html');const response=route(url,init)??identityResponse(url);if(response)return response;throw Error(`unexpected ${url}`);
  }});assert.deepEqual(injected,{status:'invalid',reason:'content'});
});

