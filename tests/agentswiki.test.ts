import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {agentsWikiRobotsAllows,readAgentsWikiRobots,AGENTSWIKI_META,AGENTSWIKI_REGISTER,AGENTSWIKI_RULE_VERSION,agentsWikiDraftRequest,parseAgentsWikiArticleReceipt,registerAgentsWiki,agentsWikiReadbackMatches,type AgentsWikiDraft,type AgentsWikiIntent,type AgentsWikiPersistence,type AgentsWikiAccount} from '../src/integrations/agentswiki';
import {drainOpenAgentChatPendingOperations,isOpenAgentChatOpaqueProgress,type OpenAgentChatOpaqueResponse} from '../src/integrations/openagentchat';
const accountId='104efb2c-9d17-4ed4-86ac-c0f02b14ab87',taskId='796a22e2-1ba8-44ac-bd69-a95abcac7f93',remote='1e2db9f0-28bc-487a-bac0-5f820972756b';
const target='https://example.org/reference';
const draft:AgentsWikiDraft={title:'Recovering an interrupted request',summary:'A bounded recovery procedure for an interrupted request.',language:'en',type:'methodology',tags:['http'],body:'## Procedure\n\nRead the [reference](https://example.org/reference) before applying the proposed procedure.\n',sources:[{title:'Reference',url:target}],basis:'An original procedure, without a reported benchmark.',attribution:['Prepared with AI assistance.'],change_notice:'Original contribution',related:[],applies_to:['HTTP clients'],content_as_of:'2026-10-17T00:00:00Z'};
const registration={name:'Example helper',public_disclosure:'AI-assisted contribution under a human maintainer.',publication_rights:true as const,rule_version:AGENTSWIKI_RULE_VERSION} as const;
const profile={id:remote,name:registration.name,public_disclosure:registration.public_disclosure,role:'agent',created_at:'2026-10-17T00:00:00Z',key_prefix:'aw_example'};
const payload={...profile,api_key:'aw_example0123456789012345678901234567890',rule_version:AGENTSWIKI_RULE_VERSION};
const meta={name:'Agents Wiki',license:'CC-BY-4.0',rule_version:AGENTSWIKI_RULE_VERSION,writes_enabled:true,registration_enabled:true,registration:{url:AGENTSWIKI_REGISTER,method:'POST',key_shown_once:true}};
function response(url:string,body:string,status=200){const r=new Response(body,{status,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r}
function journal(prior:string|undefined=undefined){let intent:AgentsWikiIntent|undefined,raw:OpenAgentChatOpaqueResponse|undefined,receipt:unknown;let snapshots=0;const p:AgentsWikiPersistence<{account:AgentsWikiAccount;apiKey:string}>={loadPriorRaw:async()=>intent?JSON.stringify(intent):prior,persistIntent:async v=>{if(intent||prior!==undefined)throw Error('existing intent');intent=v},assertAuthorized:v=>{assert.deepEqual(v,intent);return true},persistOpaque:async(v,r)=>{assert.deepEqual(v,intent);if(raw)assert.ok(isOpenAgentChatOpaqueProgress(raw,r));raw=r;snapshots++},persistReceipt:async(v,r)=>{assert.deepEqual(v,intent);assert.equal(raw?.bodyComplete,true);receipt=r}};return {p,get raw(){return raw},get snapshots(){return snapshots},get receipt(){return receipt}}}
test('reviewed draft hashes exact bytes and rejects unsupported or uncited content',()=>{
 const r=agentsWikiDraftRequest(draft,target);assert.equal(r.sourceHash,createHash('sha256').update(JSON.stringify(draft)).digest('hex'));
 for(const change of [{body:draft.body+'<script>bad</script>'},{body:draft.body+'![image](https://example.org/a.png)'},{body:draft.body+'[other](https://uncited.example/a)'},{body:draft.body.replace(target,'https://example.org/other')},{sources:[]},{title:'x'},{extra:'unknown'},{sources:[{title:'Tracking',url:target+'?partner=abc'}]}])assert.throws(()=>agentsWikiDraftRequest({...draft,...change},target));
});
test('registration saves progressive response before interpreting one-time key',async()=>{
 const j=journal(),methods:string[]=[];
 const result=await registerAgentsWiki({accountId,taskId,draft:registration},j.p,{fetch:async(u,i)=>{methods.push(i.method!);if(u===AGENTSWIKI_META)return response(u,JSON.stringify(meta));assert.equal(u,AGENTSWIKI_REGISTER);assert.equal(new Headers(i.headers).get('authorization'),null);assert.equal(i.redirect,'manual');return response(u,JSON.stringify(payload),201)}});
 assert.equal(result.status,'receipt');assert.deepEqual(methods,['GET','POST']);assert.ok(j.snapshots>=3);assert.equal(j.raw?.bodyComplete,true);assert.ok(j.receipt);
});
for(const prior of ['', '{corrupt', '{}'])test(`any prior registration record blocks duplicate even when unreadable ${prior}`,async()=>{const j=journal(prior);let count=0;const r=await registerAgentsWiki({accountId,taskId,draft:registration},j.p,{fetch:async()=>{count++;throw Error('unexpected')}});assert.equal(r.status,'prior_intent');assert.equal(count,0)});
for(const change of [{writes_enabled:false},{registration_enabled:false},{rule_version:'changed'},{license:'Changed'}])test(`changed policy prevents registration ${JSON.stringify(change)}`,async()=>{const j=journal();let posts=0;await assert.rejects(registerAgentsWiki({accountId,taskId,draft:registration},j.p,{fetch:async(u,i)=>{if(i.method==='POST')posts++;return response(u,JSON.stringify({...meta,...change}))}}));assert.equal(posts,0);assert.equal(await j.p.loadPriorRaw(),undefined)});
test('unknown success shape is retained without re-registering',async()=>{const j=journal();let posts=0;const deps={fetch:async(u:string,i:RequestInit)=>{if(i.method==='POST')posts++;return response(u,JSON.stringify(u===AGENTSWIKI_META?meta:{changed:true}),u===AGENTSWIKI_META?200:201)}};assert.equal((await registerAgentsWiki({accountId,taskId,draft:registration},j.p,deps)).status,'unknown');assert.equal(j.raw?.bodyComplete,true);assert.equal((await registerAgentsWiki({accountId,taskId,draft:registration},j.p,deps)).status,'prior_intent');assert.equal(posts,1)});
test('stalled body preserves received prefix and never retries mutation',async()=>{const j=journal();let posts=0;const deps={timeoutMs:100,fetch:async(u:string,i:RequestInit)=>{if(u===AGENTSWIKI_META)return response(u,JSON.stringify(meta));posts++;const r=new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{"api_key":"aw_partial'))}}),{status:201,headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:u});return r}};const result=await registerAgentsWiki({accountId,taskId,draft:registration},j.p,deps);assert.equal(result.status,'unknown');await drainOpenAgentChatPendingOperations(500);assert.equal(Buffer.from(j.raw!.bodyBase64,'base64').toString(),'{"api_key":"aw_partial');assert.equal(j.raw!.bodyComplete,false);assert.equal((await registerAgentsWiki({accountId,taskId,draft:registration},j.p,deps)).status,'prior_intent');assert.equal(posts,1)});
test('receipt parsing rejects wrong revision token or off-origin page',()=>{const r={id:taskId,etag:`"${taskId}:1"`,revision:1,canonical_url:'https://agents-wiki.com/wiki/example'};assert.ok(parseAgentsWikiArticleReceipt(r));for(const c of [{etag:'wrong'},{revision:2},{canonical_url:'https://other.example/wiki/example'},{canonical_url:'https://agents-wiki.com/wiki/example#x'}])assert.equal(parseAgentsWikiArticleReceipt({...r,...c}),undefined)});
test('API readback binds authorship, exact original content, revision and license',()=>{
 const account:AgentsWikiAccount={id:remote,name:profile.name,publicDisclosure:profile.public_disclosure,role:'agent',createdAt:profile.created_at,keyPrefix:profile.key_prefix};
 const receipt={id:taskId,etag:`"${taskId}:1"`,revision:1,canonicalUrl:'https://agents-wiki.com/wiki/example'};
 const common={...draft,id:taskId,etag:receipt.etag,revision:1,canonical_url:receipt.canonicalUrl,license:'CC-BY-4.0',status:'unreviewed',symptoms:[]};
 const m={...common,slug:'example',created_by:remote,updated_by:remote,visibility:'public',content_url:`https://agents-wiki.com/api/v1/articles/${taskId}/content`,markdown_url:`https://agents-wiki.com/api/v1/articles/${taskId}/content?format=markdown`,created_at:profile.created_at,updated_at:profile.created_at};
 const c={...common,untrusted_content:true};assert.equal(agentsWikiReadbackMatches(m,c,receipt,account,draft),true);
 for(const change of [{created_by:accountId},{updated_by:accountId},{visibility:'hidden'},{license:'Changed'},{revision:2},{title:'Different'},{sources:[]},{content_as_of:'2025-01-01T00:00:00Z'}])assert.equal(agentsWikiReadbackMatches({...m,...change},c,receipt,account,draft),false);
 for(const change of [{body:draft.body+'edit'},{translated_from:{}},{untrusted_content:false},{license:'Changed'},{etag:'wrong'}])assert.equal(agentsWikiReadbackMatches(m,{...c,...change},receipt,account,draft),false);
});

test('content-bound receipt ETags retain the opaque suffix and reject different identities or revisions',()=>{
 const receipt={id:taskId,etag:'"'+taskId+':1:0123456789abcdef"',revision:1,canonical_url:'https://agents-wiki.com/wiki/example'};
 assert.deepEqual(parseAgentsWikiArticleReceipt(receipt),{id:taskId,etag:receipt.etag,revision:1,canonicalUrl:receipt.canonical_url});
 for(const etag of ['"'+accountId+':1:0123456789abcdef"','"'+taskId+':2:0123456789abcdef"','"'+taskId+':1:bad"','"'+taskId+':1:0123456789abcdef:extra"','W/'+receipt.etag,receipt.etag+'\r\nX-Injected: yes'])
   assert.equal(parseAgentsWikiArticleReceipt({...receipt,etag}),undefined);
});

test('robots acceptance requires a successful bounded text response and permits both general and named crawlers',async()=>{
 const url='https://agents-wiki.com/wiki/example';
 const fetchFor=(rules:string,status=200,type='text/plain')=>async(u:string)=>{const r=new Response(rules,{status,headers:{'content-type':type}});Object.defineProperty(r,'url',{value:u});return r};
 assert.equal(await readAgentsWikiRobots(url,{fetch:fetchFor('User-agent: *\nAllow: /\nDisallow: /api/')}),true);
 for(const rules of ['User-agent: *\nDisallow: /wiki/','User-agent: *\nAllow: /\nUser-agent: Googlebot\nDisallow: /wiki/','User-agent: *\nAllow: /\nUser-agent: Bingbot\nDisallow: /wiki/','x'.repeat(131073)])
  await assert.rejects(()=>readAgentsWikiRobots(url,{fetch:fetchFor(rules)}));
 for(const [status,type] of [[403,'text/plain'],[200,'text/html']] as const)await assert.rejects(()=>readAgentsWikiRobots(url,{fetch:fetchFor('User-agent: *\nAllow: /',status,type)}));
});


test('remote robots wildcard counterexample completes without backtracking',()=>{
 const started=performance.now();
 for(const count of [16,30000])assert.equal(agentsWikiRobotsAllows('User-agent: *\nDisallow: /wiki/'+('*a'.repeat(count))+'b$','/wiki/'+'a'.repeat(50),'googlebot'),true);
 assert.ok(performance.now()-started<1000);
});
test('robots literal fragments preserve anchors, overlaps, allow precedence and named groups',()=>{
 const allows=(pattern:string,path:string)=>agentsWikiRobotsAllows('User-agent: *\nDisallow: '+pattern,path,'googlebot');
 for(const [pattern,path,expected] of [
  ['/wiki/a','/wiki/ab',false],['/wiki/a$','/wiki/ab',true],['/wiki/a$','/wiki/a',false],
  ['/wiki/*a*b$','/wiki/aaab',false],['/wiki/*a*b$','/wiki/aaabc',true],
  ['/wiki/*aba*ba$','/wiki/aba',true],['/wiki/*aba*ba$','/wiki/ababa',false],
  ['/wiki/**$','/wiki/a',false],['/wiki/a.b$','/wiki/axb',true],['/wiki/a.b$','/wiki/a.b',false],
  ['/wiki/*$','/other/a',true],['*','/wiki/a',false],['$','/wiki/a',true],
 ] as const)assert.equal(allows(pattern,path),expected,JSON.stringify({pattern,path}));
 assert.equal(agentsWikiRobotsAllows('User-agent: *\nDisallow: /wiki/\nAllow: /wiki/','/wiki/a','googlebot'),true);
 assert.equal(agentsWikiRobotsAllows('User-agent: *\nAllow: /\nUser-agent: googlebot\nDisallow: /wiki/*a$','/wiki/a','googlebot'),false);
 assert.equal(agentsWikiRobotsAllows('User-agent: *\nAllow: /\nUser-agent: googlebot\nDisallow: /wiki/*a$','/wiki/a','bingbot'),true);
 assert.equal(agentsWikiRobotsAllows('x'.repeat(131073),'/wiki/a','googlebot'),false);
});


test('readback accepts documented metadata enrichment without accepting edited prose or foreign credits',()=>{
 const account:AgentsWikiAccount={id:remote,name:profile.name,publicDisclosure:profile.public_disclosure,role:'agent',createdAt:profile.created_at,keyPrefix:profile.key_prefix};
 const enrichedDraft={...draft,tags:['recovery','http'],applies_to:['HTTP clients'],attribution:['Prepared with AI assistance.']};
 const receipt={id:taskId,etag:`"${taskId}:1:0123456789abcdef"`,revision:1,canonicalUrl:'https://agents-wiki.com/wiki/example'};
 const common={...enrichedDraft,id:taskId,etag:receipt.etag,revision:1,canonical_url:receipt.canonicalUrl,license:'CC-BY-4.0',status:'unreviewed',symptoms:[],attribution:[`Agent ${remote} (${account.name})`,...enrichedDraft.attribution]};
 const m={...common,etag:receipt.etag.slice(0,-1)+':view-'+('a'.repeat(32))+'"',tags:['http','recovery'],slug:'example',created_by:remote,updated_by:remote,visibility:'public',content_url:`https://agents-wiki.com/api/v1/articles/${taskId}/content`,markdown_url:`https://agents-wiki.com/api/v1/articles/${taskId}/content?format=markdown`,created_at:profile.created_at,updated_at:profile.created_at};
 const c={...common,applies_to:[],untrusted_content:true};assert.equal(agentsWikiReadbackMatches(m,c,receipt,account,enrichedDraft),true);
 for(const change of [{etag:receipt.etag.slice(0,-1)+':view-evil"'},{etag:`"${taskId}:2:0123456789abcdef:view-${'a'.repeat(32)}"`},{tags:['http','other']},{tags:['http','http','recovery']},{attribution:['Prepared with AI assistance.',`Agent ${accountId} (${account.name})`]},{applies_to:[]}])assert.equal(agentsWikiReadbackMatches({...m,...change},c,receipt,account,enrichedDraft),false);
 for(const change of [{body:enrichedDraft.body+'edited'},{etag:m.etag},{attribution:[]},{attribution:[...c.attribution,'Unapproved extra claim']},{applies_to:['Other clients']},{applies_to:null}])assert.equal(agentsWikiReadbackMatches(m,{...c,...change},receipt,account,enrichedDraft),false);
});
