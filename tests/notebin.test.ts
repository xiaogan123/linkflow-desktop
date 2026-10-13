import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {marked} from 'marked';
import {
  NOTEBIN_CHALLENGE_URL,
  NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,
  NOTEBIN_KEYS_URL,
  NOTEBIN_NOTES_URL,
  NOTEBIN_ORIGIN,
  createNotebinIdentity,
  mintNotebinKey,
  notebinNoteRequest,
  notebinTokenFingerprint,
  parseNotebinChallenge,
  parseNotebinItem,
  publishNotebinNote,
  solveNotebinPow,
  type NotebinIdentityBinding,
  type NotebinIntent,
  type NotebinOpaqueResponse,
  type NotebinRootIdentityBinding,
  type NotebinRuntimeGate,
} from '../src/integrations/notebin';
import {
  acceptNotebinPublication,
  makeNotebinContentApproval,
  notebinDraftIdentity,
  publishReviewedNotebinNote,
  recoverUnknownNotebinCreate,
  type NotebinReadContract,
} from '../src/integrations/notebin-publisher';
import {
  bindNotebinNoteKeyReadback,
  bindNotebinRootIdentity,
  createNotebinMintPersistence,
  createNotebinPublicationPersistence,
  createNotebinSignupPersistence,
  emptyNotebinJournalState,
  loadNotebinIdentitySecret,
  loadNotebinNoteKeySecret,
  parseNotebinPublicationSecret,
  type NotebinJournalState,
  type NotebinJournalStore,
  type NotebinSecureVault,
} from '../src/main/notebin-publication';

const now='2026-10-12T05:00:00.000Z';
const localAccountId='11111111-1111-4111-8111-111111111111';
const taskId='22222222-2222-4222-8222-222222222222';
const siteId='33333333-3333-4333-8333-333333333333';
const rootAccountId='acct_12345678';
const rootKey='pbca_live_root_key_1234567890';
const noteKey='pbca_live_note_key_0987654321';
const signupOperation=`notebin_signup_${'a'.repeat(32)}`;
const mintOperation=`notebin_mint_${'b'.repeat(32)}`;
const publishOperation=`notebin_publish_${'c'.repeat(32)}`;
const harnessHash='d'.repeat(64);
const gate:NotebinRuntimeGate={version:1,service:'notebin.ca',contractSha256:NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,sourceHarnessSha256:harnessHash,approvedAt:now,approvedOperations:['signup','mint','publish']};
const readContract:NotebinReadContract={version:1,contractSha256:NOTEBIN_IMPLEMENTATION_CONTRACT_SHA256,sourceHarnessSha256:harnessHash,observedAt:now,publicBodySelector:'main article',scanStateRequired:true,acceptedScanStates:['clean'],maxOwnedPages:3,ownedPageLimit:20,recoveryWindowMs:5*60_000};
const title='让自动发布工具把证据链说清楚';
const description='用状态、来源和时间绑定，避免把 API 回执误记成公开成果。';
const targetUrl='https://github.com/xiaogan123/linkflow-desktop';
const markdown=`# ${title}\n\n一个可靠的发布流程应区分提交、公开读取与抓取资格。\n\n查看 [Linkflow Desktop 项目](${targetUrl}) 可以了解本地优先的任务记录方式。`;
const identity=notebinDraftIdentity({title,description,markdown,targetUrl})!;
const approval=makeNotebinContentApproval(identity,{approvedAt:now,reviewer:'gpt-6-astra'});

class MemoryJournal implements NotebinJournalStore{
  state:NotebinJournalState=emptyNotebinJournalState();
  ciphers=new Map<string,string>();
  read(){return structuredClone(this.state)}
  update(mutator:(state:NotebinJournalState)=>void){const next=structuredClone(this.state);mutator(next);this.state=next}
  updateWithCiphers(mutator:(state:NotebinJournalState)=>void,ciphers:Record<string,string>){const next=structuredClone(this.state);mutator(next);this.state=next;for(const [key,value] of Object.entries(ciphers))this.ciphers.set(key,value)}
  getCipher(key:string){return this.ciphers.get(key)}
}
function vault(store:MemoryJournal):NotebinSecureVault{return {encryptSecrets(values){return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))},async get(key){const cipher=store.ciphers.get(key);return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():undefined}}}
function json(value:unknown,status=200,headers:Record<string,string>={}){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}})}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function rootBinding():NotebinRootIdentityBinding{return {localAccountId,rootAccountId,rootKeyFingerprint:notebinTokenFingerprint(rootKey),whoamiResponseHash:'e'.repeat(64),keyListResponseHash:'f'.repeat(64),verifiedAt:now,binding:'exact_readback'}}
function keyBinding():NotebinIdentityBinding{return {localAccountId,rootAccountId,audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create'],tokenFingerprint:notebinTokenFingerprint(noteKey),binding:'exact_response'}}
function item(options:{expires?:'missing'|null|number;withMarkdown?:boolean;scanState?:string;id?:string}={}){const id=options.id??'note123456',value:Record<string,unknown>={id,kind:'note',title,description,visibility:'public',content_type:'text/markdown',size_bytes:Buffer.byteLength(markdown),created_at:Date.parse(now),views:0,url:`${NOTEBIN_ORIGIN}/api/v1/items/${id}`,view_url:`${NOTEBIN_ORIGIN}/n/${id}`,raw_url:`${NOTEBIN_ORIGIN}/raw/${id}`};if(options.expires!=='missing')value.expires_at=options.expires===undefined?null:options.expires;if(options.withMarkdown)value.markdown=markdown;if(options.scanState)value.scan_state=options.scanState;return value}
function publicHtml(){const article=marked.parse(markdown,{async:false,gfm:true});return `<!doctype html><html><head><meta name="robots" content="index,follow"><link rel="canonical" href="${NOTEBIN_ORIGIN}/n/note123456"></head><body><main><article>${article}</article></main></body></html>`}

async function readyIdentityAndKey(store:MemoryJournal){
  const secure=vault(store),signup=createNotebinSignupPersistence(store,secure,{localAccountId,assertAuthorized:()=>true,now:()=>new Date(now)});let challengeCalls=0,signupCalls=0;
  const identityResult=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},signup,{gate,pow:{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000,yieldEvery:128},now:()=>new Date(now),fetch:async(url,init)=>{if(url===NOTEBIN_CHALLENGE_URL){challengeCalls++;assert.equal(init.method,'GET');return json({challenge_id:'challenge_12345678',prefix:'notebin-test-',difficulty_bits:8})}signupCalls++;assert.equal(url.includes('/auth/pow/signup'),true);const body=JSON.parse(String(init.body));assert.deepEqual(Object.keys(body).sort(),['challenge_id','display_name','nonce']);assert.equal(typeof body.nonce,'string');assert.match(body.nonce,/^(?:0|[1-9][0-9]*)$/);assert.equal(leadingBits(createHash('sha256').update(`notebin-test-${body.nonce}`).digest())>=8,true);return json({account_id:rootAccountId,api_key:rootKey})}});
  assert.equal(identityResult.status,'ready');assert.equal(challengeCalls,1);assert.equal(signupCalls,1);assert.equal(JSON.stringify(identityResult).includes(rootKey),false);
  bindNotebinRootIdentity(store,rootBinding());
  const mint=createNotebinMintPersistence(store,secure,{localAccountId,rootAccountId,assertAuthorized:()=>true});let mintCalls=0;
  const mintResult=await mintNotebinKey({operationId:mintOperation,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:rootBinding(),createdAt:now},mint,{gate,now:()=>new Date(now),fetch:async(url,init)=>{mintCalls++;assert.equal(url,NOTEBIN_KEYS_URL);assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${rootKey}`);assert.deepEqual(JSON.parse(String(init.body)),{audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create']});return json({id:'key_12345678',prefix:'pbca_live_note',scopes:['note:read','note:create'],created_at:Date.parse(now),audience:NOTEBIN_ORIGIN,token:noteKey})}});
  assert.equal(mintResult.status,'ready');assert.equal(mintCalls,1);assert.equal(JSON.stringify(mintResult).includes(noteKey),false);return {secure,signup,mint};
}
function leadingBits(bytes:Uint8Array){let count=0;for(const byte of bytes){if(byte===0){count+=8;continue}for(let bit=0x80;(byte&bit)===0;bit>>=1)count++;break}return count}

test('disabled runtime gate makes identity, mint and publication zero-transport',async()=>{
  const store=new MemoryJournal(),secure=vault(store),signup=createNotebinSignupPersistence(store,secure,{localAccountId,assertAuthorized:()=>true});let calls=0;
  const result=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},signup,{fetch:async()=>{calls++;throw Error('must not run')}});assert.deepEqual(result,{status:'not_started',reason:'runtime_gate_closed'});assert.equal(calls,0);assert.deepEqual(store.read(),emptyNotebinJournalState());
});

test('bounded PoW solves the official prefix+decimal nonce construction and rejects excessive work',async()=>{
  const challenge={challengeId:'challenge_12345678',prefix:'prefix-',difficultyBits:8,responseHash:'a'.repeat(64)},nonce=await solveNotebinPow(challenge,{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000,yieldEvery:64});assert.equal(typeof nonce,'number');assert.ok(leadingBits(createHash('sha256').update(`prefix-${nonce}`).digest())>=8);assert.equal(await solveNotebinPow({...challenge,difficultyBits:9},{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000}),undefined);
});

test('signup persists challenge, exclusive intent and encrypted opaque response before promotion',async()=>{
  const store=new MemoryJournal(),secure=vault(store);await readyIdentityAndKey(store);const state=store.read(),signup=state.identities[localAccountId].signup!;assert.equal(signup.stage,'ready');assert.equal(signup.receipt?.rootAccountId,rootAccountId);assert.ok(signup.challenge);assert.ok(signup.intent);assert.equal(JSON.stringify(state).includes(rootKey),false);for(const cipher of store.ciphers.values())assert.equal(cipher.includes(rootKey),false);const secret=await loadNotebinIdentitySecret(secure,localAccountId);assert.equal(secret?.rootApiKey,rootKey);const noteSecret=await loadNotebinNoteKeySecret(secure,localAccountId);assert.equal(noteSecret?.noteApiKey,noteKey);
});

test('an existing local-only signup claim may resume with one fresh challenge and the same operation',async()=>{
  const store=new MemoryJournal(),secure=vault(store),persistence=createNotebinSignupPersistence(store,secure,{localAccountId,assertAuthorized:()=>true,now:()=>new Date(now)}),claim={version:1 as const,operation:'signup' as const,operationId:signupOperation,localAccountId,displayNameHash:sha('Linkflow Publisher'),createdAt:now};await persistence.claimSignup(claim);let challenges=0,signups=0;const result=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},persistence,{gate,now:()=>new Date(now),pow:{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000},fetch:async(url)=>{if(url===NOTEBIN_CHALLENGE_URL){challenges++;return json({challenge_id:'challenge_12345678',prefix:'resume-',difficulty_bits:8,expires_at:Date.parse(now)+60_000,hint:'sha256(prefix + decimal nonce)'})}signups++;return json({account_id:rootAccountId,api_key:rootKey})}});assert.equal(result.status,'ready');assert.equal(challenges,1);assert.equal(signups,1);assert.equal(store.read().identities[localAccountId].signup?.claim.operationId,signupOperation);
});

test('observed five-field challenge is strict, typed and expiry-bound',async()=>{
  const expiresAt=Date.parse(now)+60_000,bytes=(value:unknown)=>Buffer.from(JSON.stringify(value)),observed={challenge_id:'challenge_observed_1234',prefix:'observed-prefix-',difficulty_bits:8,expires_at:expiresAt,hint:'sha256(prefix + decimal nonce)'};
  assert.equal(parseNotebinChallenge(bytes(observed))?.expiresAt,expiresAt);
  for(const invalid of [{...observed,unexpected:true},{...observed,expires_at:String(expiresAt)},{...observed,expires_at:1.5},{...observed,hint:42}])assert.equal(parseNotebinChallenge(bytes(invalid)),undefined);
  const challenge=parseNotebinChallenge(bytes({...observed,expires_at:Date.parse(now)}))!;assert.equal(await solveNotebinPow(challenge,{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000},undefined,()=>0,()=>Date.parse(now)),undefined);
});

test('expired challenge never dispatches signup and a pending intent never fetches or posts',async()=>{
  const store=new MemoryJournal(),secure=vault(store),clock={value:Date.parse(now)},persistence=createNotebinSignupPersistence(store,secure,{localAccountId,assertAuthorized:()=>true,now:()=>new Date(clock.value)});let gets=0,posts=0;
  const expired=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},persistence,{gate,now:()=>new Date(clock.value),pow:{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000},fetch:async(url)=>{if(url===NOTEBIN_CHALLENGE_URL){gets++;return json({challenge_id:'challenge_12345678',prefix:'expired-',difficulty_bits:8,expires_at:clock.value})}posts++;throw Error('expired challenge must not post')}});assert.equal(expired.status,'unknown');assert.match(expired.status==='unknown'?expired.reason:'',/decode/);assert.equal(gets,1);assert.equal(posts,0);
  const pendingStore=new MemoryJournal(),pendingVault=vault(pendingStore),pending=createNotebinSignupPersistence(pendingStore,pendingVault,{localAccountId,assertAuthorized:()=>true,now:()=>new Date(now)}),claim={version:1 as const,operation:'signup' as const,operationId:signupOperation,localAccountId,displayNameHash:sha('Linkflow Publisher'),createdAt:now};await pending.claimSignup(claim);await pending.persistChallenge(claim,{challengeId:'challenge_12345678',prefix:'pending-',difficultyBits:8,expiresAt:Date.parse(now)+60_000,responseHash:'1'.repeat(64)});await pending.persistIntent({version:1,operation:'signup',operationId:signupOperation,localAccountId,createdAt:now,requestHash:'2'.repeat(64)});let calls=0;const stopped=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},pending,{gate,fetch:async()=>{calls++;throw Error('must not run')}});assert.equal(stopped.status,'unknown');assert.equal(calls,0);
});

test('late signup response is encrypted after timeout and restart promotes without another POST',async()=>{
  const store=new MemoryJournal(),secure=vault(store),persistence=createNotebinSignupPersistence(store,secure,{localAccountId,assertAuthorized:()=>true});let resolveSignup!:(value:Response)=>void,posts=0;const pending=new Promise<Response>(resolve=>{resolveSignup=resolve});const deps={gate,timeoutMs:50,pow:{maxDifficultyBits:8,maxAttempts:100_000,maxMs:5_000,yieldEvery:64},fetch:async(url:string)=>{if(url===NOTEBIN_CHALLENGE_URL)return json({challenge_id:'challenge_12345678',prefix:'late-',difficulty_bits:8});posts++;return pending}};const first=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},persistence,deps);assert.equal(first.status,'unknown');assert.equal(posts,1);resolveSignup(json({account_id:rootAccountId,api_key:rootKey}));for(let index=0;index<100&&store.read().identities[localAccountId].signup?.stage!=='opaque_response';index++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(store.read().identities[localAccountId].signup?.stage,'opaque_response');const second=await createNotebinIdentity({operationId:signupOperation,localAccountId,displayName:'Linkflow Publisher',createdAt:now},persistence,{...deps,fetch:async()=>{throw Error('duplicate network')}});assert.equal(second.status,'ready');assert.equal(posts,1);assert.equal(JSON.stringify(second).includes(rootKey),false);
});

test('mint requires exact root readback and never falls back from an authority 403',async()=>{
  const store=new MemoryJournal(),secure=vault(store);await readyIdentityAndKey(store);const freshOperation=`notebin_mint_${'9'.repeat(32)}`,fresh=createNotebinMintPersistence(store,secure,{localAccountId,rootAccountId,assertAuthorized:()=>true});const existing=store.state.identities[localAccountId];delete existing.mint;let calls=0;const invalid=await mintNotebinKey({operationId:freshOperation,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:{...rootBinding(),rootAccountId:'acct_wrong999'},createdAt:now},fresh,{gate,fetch:async()=>{calls++;throw Error('must not run')}});assert.deepEqual(invalid,{status:'not_started',reason:'invalid_root_identity'});assert.equal(calls,0);
  const denied=await mintNotebinKey({operationId:freshOperation,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:rootBinding(),createdAt:now},fresh,{gate,fetch:async()=>{calls++;return json({error:'Session required'},403)}});assert.equal(denied.status,'unknown');assert.equal(calls,1);const retried=await mintNotebinKey({operationId:freshOperation,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:rootBinding(),createdAt:now},fresh,{gate,fetch:async()=>{calls++;throw Error('must not retry')}});assert.equal(retried.status,'unknown');assert.equal(calls,1);
});

test('mint rejects explicit audience or scope drift instead of treating it as pending readback',async()=>{
  for(const [suffix,response] of [
    ['7',{id:'key_87654321',prefix:'pbca_live_note',scopes:['note:read','note:create'],created_at:Date.parse(now),audience:'https://pastebin.ca',token:'pbca_live_wrong_audience_1234567890'}],
    ['8',{id:'key_87654322',prefix:'pbca_live_note',scopes:['note:read','account:write'],created_at:Date.parse(now),audience:NOTEBIN_ORIGIN,token:'pbca_live_wrong_scope_1234567890'}],
  ] as const){
    const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store);delete store.state.identities[localAccountId].mint;store.ciphers.delete(`notebin:identity:${localAccountId}:mint`);
    const persistence=createNotebinMintPersistence(store,secure,{localAccountId,rootAccountId,assertAuthorized:()=>true}),operationId=`notebin_mint_${suffix.repeat(32)}`,result=await mintNotebinKey({operationId,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:rootBinding(),createdAt:now},persistence,{gate,fetch:async()=>json(response)});
    assert.equal(result.status,'unknown');assert.equal(store.read().identities[localAccountId].mint?.stage,'opaque_response');assert.equal(await loadNotebinNoteKeySecret(secure,localAccountId),undefined);
  }
});

test('draft identity rejects raw HTML and binds the exact reviewed request',()=>{
  assert.ok(identity);assert.equal(identity.sourceHash,notebinNoteRequest(title,description,markdown).sourceHash);assert.equal(notebinDraftIdentity({title,description,markdown:`${markdown}\n<script>alert(1)</script>`,targetUrl}),undefined);assert.equal(notebinDraftIdentity({title,description,markdown:markdown.replace(targetUrl,'https://example.invalid/'),targetUrl}),undefined);
});

test('create response must preserve optional expires_at distinction and never returns the note key',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true,now:()=>new Date(now)});let calls=0;const result=await publishNotebinNote({operationId:publishOperation,localAccountId,rootAccountId,noteApiKey:noteKey,keyBinding:keyBinding(),createdAt:now,title,description,markdown,approval},persistence,{gate,fetch:async(url,init)=>{calls++;assert.equal(url,NOTEBIN_NOTES_URL);assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${noteKey}`);assert.deepEqual(JSON.parse(String(init.body)),{markdown,title,description,visibility:'public'});return json(item({expires:null}))}});assert.equal(result.status,'created');assert.equal(calls,1);assert.equal(result.status==='created'&&result.receipt.expiresAt,null);assert.equal(JSON.stringify(result).includes(noteKey),false);assert.equal(JSON.stringify(store.read()).includes(noteKey),false);assert.ok(parseNotebinPublicationSecret((await secure.get(`publication:${taskId}`))!));
});

test('missing expires_at remains unknown and approval drift blocks all network activity',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true});let calls=0;const result=await publishNotebinNote({operationId:publishOperation,localAccountId,rootAccountId,noteApiKey:noteKey,keyBinding:keyBinding(),createdAt:now,title,description,markdown,approval},persistence,{gate,fetch:async()=>{calls++;return json(item({expires:'missing'}))}});assert.equal(result.status,'pending_retention');assert.equal(result.status==='pending_retention'&&result.receipt.retention,'unknown');assert.equal(result.status==='pending_retention'&&Object.hasOwn(result.receipt,'expiresAt'),false);
  const secondStore=new MemoryJournal(),boot=await readyIdentityAndKey(secondStore),badPersistence=createNotebinPublicationPersistence(secondStore,boot.secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true});let blocked=0;const invalid=await publishNotebinNote({operationId:publishOperation,localAccountId,rootAccountId,noteApiKey:noteKey,keyBinding:keyBinding(),createdAt:now,title,description,markdown,approval:{...approval,sourceHash:'0'.repeat(64)}},badPersistence,{gate,fetch:async()=>{blocked++;throw Error('must not run')}});assert.deepEqual(invalid,{status:'not_started',reason:'approval_mismatch'});assert.equal(blocked,0);
});

function readFetch(counter:{gets:number;posts:number},options:{noindex?:boolean;ambiguous?:boolean;expiresMissing?:boolean;googlebotDisallow?:boolean}={}){return async(url:string,init:RequestInit)=>{if(init.method==='POST'){counter.posts++;throw Error('unexpected POST')}counter.gets++;const authorization=(init.headers as Record<string,string>).authorization;if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/`))assert.equal(authorization,`Bearer ${noteKey}`);else assert.equal(authorization,undefined);if(url===`${NOTEBIN_ORIGIN}/api/v1/items/note123456`)return json(item({expires:options.expiresMissing?'missing':null,withMarkdown:true,scanState:'clean'}));if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/items/other123`))return json(item({id:'other123',expires:null,withMarkdown:true,scanState:'clean'}));if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/account/items`)){const values=[item({expires:null}),...(options.ambiguous?[item({id:'other123',expires:null})]:[])];return json({items:values,next_cursor:null})}if(url===`${NOTEBIN_ORIGIN}/n/note123456`)return new Response(publicHtml(),{status:200,headers:{'content-type':'text/html',...(options.noindex?{'x-robots-tag':'noindex'}:{})}});if(url===`${NOTEBIN_ORIGIN}/n/other123`)return new Response(publicHtml().replaceAll('note123456','other123'),{status:200,headers:{'content-type':'text/html'}});if(url===`${NOTEBIN_ORIGIN}/robots.txt`)return new Response(options.googlebotDisallow?'User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /':'User-agent: *\nAllow: /\nDisallow: /api/',{status:200,headers:{'content-type':'text/plain'}});throw Error(`unexpected ${url}`)}}

test('GET-only acceptance binds owned membership, source, null expiry, public body, target and robots',async()=>{
  const request=notebinNoteRequest(title,description,markdown),receipt={operationId:publishOperation,localAccountId,rootAccountId,noteKeyFingerprint:notebinTokenFingerprint(noteKey),requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt:now,itemId:'note123456',publicUrl:`${NOTEBIN_ORIGIN}/n/note123456`,viewUrl:`${NOTEBIN_ORIGIN}/n/note123456`,rawUrl:`${NOTEBIN_ORIGIN}/raw/note123456`,remoteCreatedAt:Date.parse(now),retention:'no_scheduled_expiry' as const,expiresAt:null,ownership:'pending' as const},counter={gets:0,posts:0};const evidence=await acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract,now:()=>new Date(now),fetch:readFetch(counter)});assert.equal(evidence.ownerListMatched,true);assert.equal(evidence.targetHref,targetUrl);assert.equal(counter.posts,0);assert.equal(counter.gets,4);
});

test('public noindex and absent owner expires_at both fail closed',async()=>{
  const request=notebinNoteRequest(title,description,markdown),receipt={operationId:publishOperation,localAccountId,rootAccountId,noteKeyFingerprint:notebinTokenFingerprint(noteKey),requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt:now,itemId:'note123456',publicUrl:`${NOTEBIN_ORIGIN}/n/note123456`,viewUrl:`${NOTEBIN_ORIGIN}/n/note123456`,rawUrl:`${NOTEBIN_ORIGIN}/raw/note123456`,remoteCreatedAt:Date.parse(now),retention:'no_scheduled_expiry' as const,expiresAt:null,ownership:'pending' as const};await assert.rejects(()=>acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract,fetch:readFetch({gets:0,posts:0},{noindex:true})}));await assert.rejects(()=>acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract,fetch:readFetch({gets:0,posts:0},{expiresMissing:true})}));
});

test('search-crawler-specific robots denial fails public acceptance',async()=>{
  const request=notebinNoteRequest(title,description,markdown),receipt={operationId:publishOperation,localAccountId,rootAccountId,noteKeyFingerprint:notebinTokenFingerprint(noteKey),requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt:now,itemId:'note123456',publicUrl:`${NOTEBIN_ORIGIN}/n/note123456`,viewUrl:`${NOTEBIN_ORIGIN}/n/note123456`,rawUrl:`${NOTEBIN_ORIGIN}/raw/note123456`,remoteCreatedAt:Date.parse(now),retention:'no_scheduled_expiry' as const,expiresAt:null,ownership:'pending' as const};await assert.rejects(()=>acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract,fetch:readFetch({gets:0,posts:0},{googlebotDisallow:true})}));
});

test('stalled stream cancellation cannot defeat read or write response deadlines',async()=>{
  const request=notebinNoteRequest(title,description,markdown),receipt={operationId:publishOperation,localAccountId,rootAccountId,noteKeyFingerprint:notebinTokenFingerprint(noteKey),requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt:now,itemId:'note123456',publicUrl:`${NOTEBIN_ORIGIN}/n/note123456`,viewUrl:`${NOTEBIN_ORIGIN}/n/note123456`,rawUrl:`${NOTEBIN_ORIGIN}/raw/note123456`,remoteCreatedAt:Date.parse(now),retention:'no_scheduled_expiry' as const,expiresAt:null,ownership:'pending' as const},stalled=()=>new Response(new ReadableStream({start(){},cancel(){return new Promise<void>(()=>{})}}),{headers:{'content-type':'application/json'}});
  const read=acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract,timeoutMs:50,fetch:async()=>stalled()}).then(()=>'accepted',()=>'rejected');assert.equal(await Promise.race([read,new Promise(resolve=>setTimeout(()=>resolve('hung'),300))]),'rejected');
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true});const write=publishNotebinNote({operationId:publishOperation,localAccountId,rootAccountId,noteApiKey:noteKey,keyBinding:keyBinding(),createdAt:now,title,description,markdown,approval},persistence,{gate,timeoutMs:50,fetch:async()=>stalled()}).then(value=>value.status);assert.equal(await Promise.race([write,new Promise(resolve=>setTimeout(()=>resolve('hung'),300))]),'unknown');
});

test('owned-list acceptance requires a terminal cursor even when the target appears early',async()=>{
  const request=notebinNoteRequest(title,description,markdown),receipt={operationId:publishOperation,localAccountId,rootAccountId,noteKeyFingerprint:notebinTokenFingerprint(noteKey),requestHash:request.requestHash,sourceHash:request.sourceHash,createdAt:now,itemId:'note123456',publicUrl:`${NOTEBIN_ORIGIN}/n/note123456`,viewUrl:`${NOTEBIN_ORIGIN}/n/note123456`,rawUrl:`${NOTEBIN_ORIGIN}/raw/note123456`,remoteCreatedAt:Date.parse(now),retention:'no_scheduled_expiry' as const,expiresAt:null,ownership:'pending' as const};let gets=0;
  await assert.rejects(()=>acceptNotebinPublication({receipt,identity,binding:keyBinding(),noteApiKey:noteKey},{gate,readContract:{...readContract,maxOwnedPages:1},fetch:async(url,init)=>{assert.equal(init.method,'GET');gets++;if(url===`${NOTEBIN_ORIGIN}/api/v1/items/note123456`)return json(item({expires:null,withMarkdown:true,scanState:'clean'}));if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/account/items`))return json({items:[item({expires:null})],next_cursor:'still-more'});throw Error(`unexpected ${url}`)}}));assert.equal(gets,2);
});

test('unknown create recovery is GET-only, accepts one exact owned item and rejects ambiguity',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true,now:()=>new Date(now)}),intent:NotebinIntent={version:1,operation:'publish',operationId:publishOperation,localAccountId,rootAccountId,createdAt:now,requestHash:identity.requestHash,sourceHash:identity.sourceHash,noteKeyFingerprint:notebinTokenFingerprint(noteKey)};assert.equal(await persistence.claimIntent(intent),'claimed');const counter={gets:0,posts:0},result=await recoverUnknownNotebinCreate({intent,identity,binding:keyBinding(),noteApiKey:noteKey,persistence},{gate,readContract,now:()=>new Date(now),fetch:readFetch(counter)});assert.equal(result.status,'found');assert.equal(counter.posts,0);assert.equal(store.read().publications[taskId].stage,'owned');
  const other=new MemoryJournal(),boot=await readyIdentityAndKey(other),otherPersistence=createNotebinPublicationPersistence(other,boot.secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true});assert.equal(await otherPersistence.claimIntent(intent),'claimed');const ambiguous=await recoverUnknownNotebinCreate({intent,identity,binding:keyBinding(),noteApiKey:noteKey,persistence:otherPersistence},{gate,readContract,fetch:readFetch({gets:0,posts:0},{ambiguous:true})});assert.equal(ambiguous.status,'pending');assert.match(ambiguous.status==='pending'?ambiguous.reason:'',/多个/);
});

test('mint readback atomically updates the journal and encrypted restart projection',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store);delete store.state.identities[localAccountId].mint;store.ciphers.delete(`notebin:identity:${localAccountId}:mint`);const persistence=createNotebinMintPersistence(store,secure,{localAccountId,rootAccountId,assertAuthorized:()=>true}),result=await mintNotebinKey({operationId:mintOperation,localAccountId,rootAccountId,rootApiKey:rootKey,rootBinding:rootBinding(),createdAt:now},persistence,{gate,fetch:async()=>json({token:noteKey})});assert.equal(result.status,'pending_binding');assert.equal((await loadNotebinNoteKeySecret(secure,localAccountId))?.receipt.binding,'pending_readback');
  bindNotebinNoteKeyReadback(store,{localAccountId,rootAccountId,tokenFingerprint:notebinTokenFingerprint(noteKey),keyId:'key_12345678',audience:NOTEBIN_ORIGIN,scopes:['note:read','note:create'],keyListResponseHash:'f'.repeat(64),verifiedAt:now,binding:'exact_readback'},secure);const journal=store.read().identities[localAccountId].mint!,restarted=await loadNotebinNoteKeySecret(secure,localAccountId);assert.equal(journal.stage,'ready');assert.equal(journal.receipt?.binding,'exact_readback');assert.equal(restarted?.receipt.binding,'exact_readback');assert.equal(restarted?.receipt.readbackResponseHash,'f'.repeat(64));assert.equal(restarted?.noteApiKey,noteKey);
});

test('recovery rejects a detail object whose ID or stable metadata differs from its list candidate',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true}),intent:NotebinIntent={version:1,operation:'publish',operationId:publishOperation,localAccountId,rootAccountId,createdAt:now,requestHash:identity.requestHash,sourceHash:identity.sourceHash,noteKeyFingerprint:notebinTokenFingerprint(noteKey)};await persistence.claimIntent(intent);const old={...item({id:'other123',withMarkdown:true,scanState:'clean'}),created_at:Date.parse(now)-86_400_000},base=readFetch({gets:0,posts:0}),result=await recoverUnknownNotebinCreate({intent,identity,binding:keyBinding(),noteApiKey:noteKey,persistence},{gate,readContract,fetch:async(url,init)=>{if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/account/items`))return json({items:[item(),old],next_cursor:null});if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/items/`))return json(old);return base(url,init)}});assert.equal(result.status,'pending');assert.equal(store.read().publications[taskId].stage,'intent');
});

test('recovery rejects an overfull owned-list page before issuing detail reads',async()=>{
  let reads=0;const intent:NotebinIntent={version:1,operation:'publish',operationId:publishOperation,localAccountId,rootAccountId,createdAt:now,requestHash:identity.requestHash,sourceHash:identity.sourceHash,noteKeyFingerprint:notebinTokenFingerprint(noteKey)},persistence={claimIntent:async()=> 'existing' as const,loadOpaqueResponse:async()=>undefined,assertAuthorized:()=>true as const,persistOpaqueResponse:async()=>{},preserveReceipt:async()=>{},preserveRecoveredReceipt:async()=>{}},values=Array.from({length:100},(_,index)=>item({id:`sample${index}`})),result=await recoverUnknownNotebinCreate({intent,identity,binding:keyBinding(),noteApiKey:noteKey,persistence},{gate,readContract:{...readContract,maxOwnedPages:1,ownedPageLimit:1},fetch:async(url,init)=>{reads++;assert.equal(init.method,'GET');if(url.startsWith(`${NOTEBIN_ORIGIN}/api/v1/account/items`))return json({items:values,next_cursor:null});throw Error(`unexpected detail read ${url}`)}});assert.equal(result.status,'pending');assert.equal(reads,1);
});

test('readback preserves an API receipt but rechecks controller authorization before owned promotion',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store);let allowed=true,guardCalls=0;const persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>{guardCalls++;if(!allowed)throw Error('paused');return true},now:()=>new Date(now)}),intent:NotebinIntent={version:1,operation:'publish',operationId:publishOperation,localAccountId,rootAccountId,createdAt:now,requestHash:identity.requestHash,sourceHash:identity.sourceHash,noteKeyFingerprint:notebinTokenFingerprint(noteKey)};assert.equal(await persistence.claimIntent(intent),'claimed');allowed=false;
  const result=await recoverUnknownNotebinCreate({intent,identity,binding:keyBinding(),noteApiKey:noteKey,persistence},{gate,readContract,now:()=>new Date(now),fetch:readFetch({gets:0,posts:0})});assert.equal(result.status,'pending');assert.equal(store.read().publications[taskId].stage,'api_receipt');assert.ok(guardCalls>=2);
});

test('publisher leaves the integration pending until the independent render contract exists',async()=>{
  const store=new MemoryJournal(),{secure}=await readyIdentityAndKey(store),persistence=createNotebinPublicationPersistence(store,secure,{taskId,siteId,localAccountId,rootAccountId,approval,identity,assertAuthorized:()=>true});const result=await publishReviewedNotebinNote({operationId:publishOperation,localAccountId,rootAccountId,noteApiKey:noteKey,binding:keyBinding(),createdAt:now,identity,approval,persistence},{gate,fetch:async()=>json(item({expires:null}))});assert.equal(result.status,'pending');assert.match(result.status==='pending'?result.reason:'',/渲染契约/);
});

test('item parser rejects owner_id invention, cross-origin URLs and duplicate retention guesses',()=>{
  assert.ok(parseNotebinItem(item({expires:null})));assert.equal(parseNotebinItem({...item({expires:null}),owner_id:rootAccountId}),undefined);assert.equal(parseNotebinItem({...item({expires:null}),view_url:'https://evil.invalid/n/note123456'}),undefined);assert.equal(parseNotebinItem(item({expires:'missing'}))?.expiresAtPresent,false);
});
