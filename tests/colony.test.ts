import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {COLONY_BEGIN_URL,COLONY_CONFIRM_URL,COLONY_ME_URL,COLONY_TOKEN_URL,beginColonyIdentity,colonyConfirmRequest,colonyRegistrationRequest,confirmColonyIdentity,matchColonyPost,parseColonyPendingIdentity,parseColonyToken,type ColonyIdentityPersistence,type ColonyIdentityTransport,type ColonyPendingIdentity,type ColonyPostInput} from '../src/integrations/colony';
import {colonyTaskApproved,prepareColonyIdentity,runColonyTask} from '../src/integrations/colony-publisher';

const now=()=>new Date('2026-10-15T12:00:00Z');
const input={username:'linkflow_agent',display_name:'Linkflow AI assistant',bio:'AI development assistant for a desktop publishing project.',registered_via:'linkflow-desktop' as const};
const pending={status:'pending' as const,api_key:'test_only_saved_key_0123456789',claim_token:'test_only_claim',id:'11111111-1111-4111-8111-111111111111',username:input.username,expires_at:'2026-10-15T12:15:00Z',key_persistence_required:true as const};
const active={status:'active',id:pending.id,username:pending.username};
function fixture(){
  const calls:string[]=[];let beginIntent=false,confirmIntent=false,saved:ColonyPendingIdentity|undefined,paused=false;
  const persistence:ColonyIdentityPersistence={
    persistBeginIntent:async()=>{if(beginIntent)throw Error('existing intent');beginIntent=true;calls.push('begin-intent')},
    persistBeginResponse:async()=>{calls.push('begin-opaque')},
    persistPendingIdentity:async value=>{saved=structuredClone(value);calls.push('key-saved')},
    readPendingIdentity:async()=>{calls.push('key-readback');return saved},
    persistConfirmIntent:async()=>{if(confirmIntent)throw Error('existing confirmation');confirmIntent=true;calls.push('confirm-intent')},
    persistConfirmResponse:async()=>{calls.push('confirm-opaque')},
    persistActiveIdentity:async()=>{calls.push('active-saved')},
    assertMayRegister:()=>{calls.push('fresh-authority');if(paused)throw Error('paused');return true},
  };
  const transport:ColonyIdentityTransport={
    begin:async()=>{calls.push('POST-begin');return {...pending,important:'Save this key.',warning:'Optional future server metadata'}},
    confirm:async value=>{calls.push('POST-confirm');assert.deepEqual(value,{claim_token:pending.claim_token,key_fingerprint:pending.api_key.slice(-6)});return {...active,next_steps:{instructions:'/api/v1/instructions'}}},
  };
  return {calls,persistence,transport,pause:()=>{paused=true},getSaved:()=>saved};
}

test('Colony saves and reads back the same key before activation; metadata does not lose it',async()=>{
  const f=fixture();assert.equal((await beginColonyIdentity(input,f.persistence,f.transport,now)).status,'active');
  assert.deepEqual(f.calls,['begin-intent','fresh-authority','POST-begin','begin-opaque','key-saved','key-readback','confirm-intent','fresh-authority','POST-confirm','confirm-opaque','active-saved']);
  assert.equal((await beginColonyIdentity(input,f.persistence,f.transport,now)).status,'not_started');assert.equal(f.calls.filter(v=>v==='POST-begin').length,1);
});
test('Colony refuses substituted identity, invalid expiry and nonboolean persistence state',()=>{
  for(const patch of [{username:'someone_else'},{id:'not-uuid'},{expires_at:'2026-10-15T11:59:00Z'},{expires_at:'2026-10-16T12:00:00Z'},{key_persistence_required:false},{api_key:'has whitespace here'}])assert.equal(parseColonyPendingIdentity({...pending,...patch},input,now()),undefined);
  assert.equal(parseColonyToken({access_token:'a'.repeat(32),token_type:'bearer',warning:'metadata'}),'a'.repeat(32));assert.equal(parseColonyToken({access_token:'a'.repeat(32),token_type:'basic'}),undefined);
});
test('Colony failed encrypted persistence or mismatched readback never confirms',async()=>{
  for(const phase of ['opaque','save','readback'] as const){const f=fixture();if(phase==='opaque')f.persistence.persistBeginResponse=async()=>{throw Error('vault failed')};if(phase==='save')f.persistence.persistPendingIdentity=async()=>{throw Error('vault failed')};if(phase==='readback')f.persistence.readPendingIdentity=async()=>({...pending,api_key:'different_saved_key_1234567890'});
    assert.notEqual((await beginColonyIdentity(input,f.persistence,f.transport,now)).status,'active');assert.equal(f.calls.includes('POST-confirm'),false);
  }
});
test('Colony pause after the durable confirmation intent blocks that write',async()=>{
  const f=fixture(),save=f.persistence.persistConfirmIntent;f.persistence.persistConfirmIntent=async v=>{await save(v);f.pause()};
  assert.deepEqual(await beginColonyIdentity(input,f.persistence,f.transport,now),{status:'pending',reason:'paused'});assert.equal(f.calls.includes('POST-confirm'),false);
});
test('Colony unknown activation preserves identity and never repeats confirmation',async()=>{
  const f=fixture();f.transport.confirm=async()=>{f.calls.push('POST-confirm');throw Error('unknown')};
  assert.deepEqual(await beginColonyIdentity(input,f.persistence,f.transport,now),{status:'unknown',phase:'confirm'});
  assert.deepEqual(await confirmColonyIdentity(f.getSaved()!,f.persistence,f.transport,now),{status:'unknown',phase:'confirm'});assert.equal(f.calls.filter(v=>v==='POST-confirm').length,1);assert.equal(f.calls.filter(v=>v==='POST-begin').length,1);
});
test('Colony expired pending identity cannot trigger activation or a replacement signup',async()=>{
  const f=fixture();await f.persistence.persistPendingIdentity(pending);
  assert.deepEqual(await confirmColonyIdentity(pending,f.persistence,f.transport,()=>new Date('2026-10-15T12:16:00Z')),{status:'pending',reason:'expired'});assert.equal(f.calls.some(v=>v.startsWith('POST-')),false);
});
test('product identity restart after durable confirm arm never sends a second confirm',async()=>{
  const id=pending.id,begin=colonyRegistrationRequest(),operationId='colony_register_'+id.replace(/-/g,''),bytes=Buffer.from(JSON.stringify(pending)),beginOpaque={version:1 as const,capturedAt:now().toISOString(),requestUrl:COLONY_BEGIN_URL,status:201,contentType:'application/json',responseUrl:COLONY_BEGIN_URL,redirected:false,responseType:'basic',headers:[['content-type','application/json']] as Array<[string,string]>,bodyBase64:bytes.toString('base64'),bodySha256:createHash('sha256').update(bytes).digest('hex'),bodyComplete:true},initialAccount:any={id,channelId:'colony',email:'',username:input.username,displayName:input.display_name,createdAt:now().toISOString(),status:'unknown',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,colony:{version:1,stage:'pending',operationId,requestHash:begin.requestHash,username:input.username,displayName:input.display_name,actorId:id,expiresAt:pending.expires_at}},initialSecret:any={version:1,kind:'colony_account',operationId,requestHash:begin.requestHash,username:input.username,displayName:input.display_name,createdAt:now().toISOString(),beginOpaque,apiKey:pending.api_key,claimToken:pending.claim_token,pendingId:id,expiresAt:pending.expires_at};
  const channel:any={id:'colony',domain:'thecolony.ai',automation:'api',kind:'community',accountRequired:true,articleRequired:true};let crashSnapshot:any,firstConfirms=0;
  async function execute(account:any,secret:any,restarted=false){const secrets:Record<string,string>={[`account:${id}`]:JSON.stringify(secret)};const context:any={channel,task:{id:'22222222-2222-4222-8222-222222222222',channelId:'colony',sourceDomain:'thecolony.ai'},getAccount:()=>account,saveAccount:async(value:any,raw:string)=>{account=structuredClone(value);secrets[`account:${id}`]=raw},secrets:{get:async(k:string)=>secrets[k],set:async(k:string,v:string)=>{secrets[k]=v}},authorizeColonyMutation:()=>true,signal:new AbortController().signal};let confirms=0,begins=0;const result=await prepareColonyIdentity(context,{now,fetch:async(url,init)=>{const method=init.method??'GET';if(url===COLONY_BEGIN_URL){begins++;throw Error('begin forbidden')}if(url===COLONY_CONFIRM_URL){confirms++;firstConfirms++;if(!restarted)crashSnapshot={account:structuredClone(account),secret:JSON.parse(secrets[`account:${id}`])};throw Error('simulated hard exit at dispatch')}if(url===COLONY_TOKEN_URL)return new Response(JSON.stringify({access_token:'t'.repeat(32),token_type:'bearer'}),{status:200,headers:{'content-type':'application/json'}});if(url===COLONY_ME_URL&&method==='GET')return new Response(JSON.stringify({id,username:input.username,display_name:input.display_name,user_type:'agent',created_at:now().toISOString()}),{status:200,headers:{'content-type':'application/json'}});throw Error(`unexpected ${method} ${url}`)}});return {result,confirms,begins,account,secret:JSON.parse(secrets[`account:${id}`])}}
  await execute(structuredClone(initialAccount),structuredClone(initialSecret));assert.equal(firstConfirms,1);assert.equal(crashSnapshot.account.colony.stage,'confirm_intent');assert.ok(crashSnapshot.secret.confirmArmedAt);assert.equal(crashSnapshot.secret.confirmRequestHash,colonyConfirmRequest(pending).requestHash);assert.equal(crashSnapshot.secret.confirmOpaque,undefined);
  const recovered=await execute(crashSnapshot.account,crashSnapshot.secret,true);assert.equal(recovered.confirms,0);assert.equal(recovered.begins,0);assert.equal(recovered.account.colony.stage,'ready');assert.equal(firstConfirms,1);
});
test('publisher approval follows effective manual or AI mode without inventing a review',async()=>{
  const stamp=now().toISOString(),review={status:'passed',reviewedAt:stamp} as any;assert.equal(colonyTaskApproved({articleApprovedAt:stamp},{articleReviewMode:'manual'},{articleReviewMode:'ai'}),true);assert.equal(colonyTaskApproved({articleApprovedAt:stamp},{articleReviewMode:'ai'},{articleReviewMode:'manual'}),false);assert.equal(colonyTaskApproved({articleApprovedAt:stamp,articleReview:review},{articleReviewMode:'ai'},{articleReviewMode:'manual'}),true);assert.equal(colonyTaskApproved({articleApprovedAt:new Date(Date.parse(stamp)+1000).toISOString(),articleReview:review},{articleReviewMode:'ai'},{articleReviewMode:'manual'}),false);
  const channel:any={id:'colony',domain:'thecolony.ai',automation:'api',kind:'community',accountRequired:true,articleRequired:true},draft={title:'Ordinary approved engineering note',description:'Summary',body:'See [the project](https://ordinary.example/tool).'},base:any={channel,task:{id:'22222222-2222-4222-8222-222222222222',channelId:'colony',sourceDomain:'thecolony.ai',draft,articleApprovedAt:stamp},site:{url:'https://ordinary.example/tool',articleReviewMode:'manual'},settings:{articleReviewMode:'ai'},getAccount:()=>undefined};const result=await runColonyTask(base);assert.equal(result.message,'The same Colony identity is not safely connected');assert.equal(base.task.articleReview,undefined);
});
test('Colony binds full article and agent, preserving moderation and cognition holds',()=>{
  const postInput:ColonyPostInput={colony:'build-in-public',post_type:'analysis',title:'A concrete engineering note',body:'Original complete body.',language:'en',tags:['engineering'],client:'linkflow-desktop',bridge_to_nostr:false,confirm_duplicate:false};
  const post={...postInput,id:'22222222-2222-4222-8222-222222222222',colony_name:'build-in-public',author:{id:pending.id,username:pending.username,user_type:'agent'},status:'open',held:false};
  assert.equal(matchColonyPost(post,postInput,pending)?.state,'public_candidate');
  assert.equal(matchColonyPost({...post,held:true},postInput,pending)?.state,'held');
  assert.equal(matchColonyPost({...post,cognition:{challenge_id:'keep-private'}},postInput,pending)?.state,'held');
  assert.equal(matchColonyPost({...post,status:'removed'},postInput,pending)?.state,'held');
  for(const patch of [{body:'Different'},{author:{...post.author,user_type:'human'}},{author:{...post.author,id:post.id}},{colony_name:'another-community'},{title:'Another title'},{tags:[]}])assert.equal(matchColonyPost({...post,...patch},postInput,pending),undefined);
});

test('new Colony registration creates distinct site-derived neutral public names',async()=>{
  const names:Array<{username:string;display_name:string}>=[];
  for(const name of ['Example Alpha','Example Beta']){
    let account:any;const secrets=new Map<string,string>();let posted:{username:string;display_name:string}|undefined;
    const context:any={site:{name,url:'https://example.com/'},channel:{id:'colony',domain:'thecolony.ai',automation:'api',kind:'community',accountRequired:true,articleRequired:true},task:{id:pending.id,channelId:'colony',sourceDomain:'thecolony.ai'},signal:new AbortController().signal,
      getAccount:()=>account,saveAccount:async(value:any,secret:string)=>{account=value;secrets.set(`account:${value.id}`,secret)},secrets:{get:async(key:string)=>secrets.get(key),set:async(key:string,value:string)=>{secrets.set(key,value)}},authorizeColonyMutation:()=>true};
    await prepareColonyIdentity(context,{now,fetch:async(url,init)=>{
      if(url===COLONY_BEGIN_URL){posted=JSON.parse(String(init.body));names.push(posted!);return new Response(JSON.stringify({...pending,username:posted!.username}),{status:201,headers:{'content-type':'application/json'}})}
      if(url===COLONY_CONFIRM_URL)return new Response(JSON.stringify({...active,username:posted!.username}),{status:200,headers:{'content-type':'application/json'}});
      if(url===COLONY_TOKEN_URL)return new Response(JSON.stringify({access_token:'t'.repeat(32),token_type:'bearer'}),{status:200,headers:{'content-type':'application/json'}});
      if(url===COLONY_ME_URL)return new Response(JSON.stringify({id:pending.id,username:posted!.username,display_name:posted!.display_name,user_type:'agent',created_at:now().toISOString()}),{status:200,headers:{'content-type':'application/json'}});
      throw Error('unexpected endpoint');
    }});
    assert.equal(account.colony.stage,'ready');assert.doesNotMatch(account.username+' '+account.displayName,/linkflow/i);
  }
  assert.notEqual(names[0].username,names[1].username);assert.notEqual(names[0].display_name,names[1].display_name);
});
