import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivateKey} from 'hive-tx';
import {CHANNELS} from '../src/integrations/catalog';
import {defaultSettings} from '../src/main/store';
import {runMataroaTask} from '../src/integrations/mataroa';
import {runHiveTask,type HiveDependencies} from '../src/integrations/hive';
import {telegraphTesting} from '../src/integrations/telegraph';
import {runGistTask} from '../src/integrations/gist';
import type {Account,ExecutionContext,Task} from '../src/shared/types';

const at='2026-10-09T05:00:00.000Z',target='https://example.com/';
const body=[
  'This synthetic article explains a repeatable review of operational evidence. Each observation should identify its source, date, and limitations before anyone relies on it. The [research notes]('+target+') provide additional context, but are not proof of claims beyond their documented scope.',
  'Reviewers compare inputs, inspect counterexamples, and record unresolved questions in plain language. This keeps interpretation separate from measured results. All identities, credentials, and remote responses in this local test are synthetic; the test does not make financial promises or distribute content.',
  'A useful conclusion also describes what was not tested and what would change the decision. Repeating an uncertain remote write can create duplicate content, so this fixture preserves the first intent and tests only whether a later execution respects that record.',
].join('\n\n');
const ids=['mataroa','hive','telegraph','github-gist'] as const;
type Id=typeof ids[number];
const counters={defaultFetch:0,syntheticArticlePosts:0,syntheticOtherRequests:0};
globalThis.fetch=async()=>{counters.defaultFetch++;throw Error('Default network forbidden')};
const posting=PrivateKey.fromSeed('publisher-cleanup-synthetic-posting').toString();
const pub=(seed:string)=>PrivateKey.fromSeed(seed).createPublic().toString();
const matToken='synthetic-mataroa-key-0123456789abcdef',password='synthetic-password-for-tests';
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const csrf='a'.repeat(32);

function fixture(id:Id){
  const channel={...CHANNELS.find(c=>c.id===id)!,enabled:true};
  const task:Task={id:'publisher-cleanup-task',siteId:'site',channelId:id,sourceDomain:channel.domain,accountId:'account',
    status:'running',createdAt:at,updatedAt:at,scheduledAt:at,attempts:1,message:'',draftRevision:1,
    articleApprovedAt:at,topicUrl:target,draft:{title:'A bounded operational evidence review',description:'Synthetic review of error handling.',body}};
  let account:Account={id:'account',channelId:id,email:'',username:id==='mataroa'?'example-desk':id==='hive'?'examplewriter':id==='github-gist'?'octocat':'Example',
    createdAt:at,status:'registered',hasPassword:true,credentialKind:'api_token',source:'imported',
    ...(id==='mataroa'?{publicationUrl:'https://example-desk.mataroa.blog/'}:id==='hive'?{publicationUrl:'https://hive.blog/@examplewriter'}:{})};
  let secret=id==='mataroa'?JSON.stringify({version:1,username:account.username,password,token:matToken})
    :id==='hive'?JSON.stringify({version:1,username:account.username,postingKey:posting})
    :id==='github-gist'?'github_pat_synthetic_secret_1234567890':'secret-telegraph-token-1234567890';
  const originalSecret=secret,abort=new AbortController(),originalIdentity={id:account.id,username:account.username,channelId:id};
  const context:ExecutionContext={task,channel,site:{id:'site',url:target,domain:'example.com',email:'author@example.com',name:'Synthetic',
    description:'Educational notes',category:'content',language:'en',status:'ready',monthlyTarget:1,createdAt:at},
    settings:defaultSettings(),signal:abort.signal,ai:{json:async()=>{throw Error('No AI')}},
    secrets:{get:async()=>secret,set:async()=>{throw Error('No real Vault writes')},delete:async()=>{throw Error('No real Vault deletes')}},
    getAccount:()=>account,saveAccount:async(a,s)=>{account=structuredClone(a);if(s)secret=s},
    checkpoint:p=>Object.assign(task,structuredClone(p)),log:()=>{}};
  return {task,context,abort,identity:()=>({id:account.id,username:account.username,channelId:account.channelId}),
    assertIdentity:()=>{assert.deepEqual({id:account.id,username:account.username,channelId:account.channelId},originalIdentity);assert.equal(secret,originalSecret)}};
}
const hiveRpc:NonNullable<HiveDependencies['rpc']>=async(method,params)=>{
  if(method==='condenser_api.get_accounts')return [{name:'examplewriter',posting:{weight_threshold:1,key_auths:[[PrivateKey.fromString(posting).createPublic().toString(),1]],account_auths:[]},
    active:{weight_threshold:1,key_auths:[[pub('publisher-cleanup-active'),1]],account_auths:[]},owner:{weight_threshold:1,key_auths:[[pub('publisher-cleanup-owner'),1]],account_auths:[]},
    memo_key:pub('publisher-cleanup-memo'),last_root_post:'2026-10-08T22:00:00'}];
  if(method==='condenser_api.get_dynamic_global_properties')return {head_block_number:1234567,head_block_id:'0000000001020304050607080910111213141516',time:'2026-10-09T05:00:00'};
  if(method==='rc_api.find_rc_accounts')return {rc_accounts:[{account:'examplewriter',rc_manabar:{current_mana:'1000000000000000',last_update_time:Date.parse(at)/1000},max_rc:'1000000000000000'}]};
  if(method==='rc_api.get_rc_operation_stats')return {count:100,avg_cost_rc:1_000_000_000};
  if(method==='condenser_api.get_content'){const p=params as string[];const missing='Post '+p[0]+'/'+p[1]+' does not exist';throw {code:-32602,message:'Assert Exception:'+missing,data:{name:'assert_exception',message:'Assert Exception',extension:{assertion_expression:missing}}}}
  throw Error('Unexpected synthetic RPC');
};
function ordinaryResponse(id:Id,url:string,init:RequestInit){
  counters.syntheticOtherRequests++;
  const path=new URL(url).pathname;
  if(id==='github-gist'&&path==='/user')return json({login:'octocat'});
  if(id==='telegraph'&&path==='/getAccountInfo')return json({ok:true,result:{short_name:'Example',page_count:0}});
  if(id==='mataroa'){
    if(path==='/accounts/login/'&&init.method==='GET')return new Response('<form method="post"><input name="csrfmiddlewaretoken" value="'+csrf+'"><input name="username"><input name="password"></form>');
    if(path==='/accounts/login/'&&init.method==='POST')return new Response('',{status:302,headers:{location:'/'}});
    if(path==='/dashboard/')return new Response('<title>Dashboard - example-desk</title>');
    if(path==='/accounts/edit/'&&init.method==='GET')return new Response('<form method="post"><input name="csrfmiddlewaretoken" value="'+csrf+'"><input name="username" value="example-desk"><input name="email" value=""><input name="blog_title" value="Example Desk"><textarea name="blog_byline">Trusted notes</textarea><textarea name="footer_note">About</textarea><input type="checkbox" name="theme_zialucia"><input type="checkbox" name="theme_sansserif"><input type="checkbox" name="post_altpath_on"><input name="custom_domain" value=""><input type="checkbox" name="comments_on"><input type="checkbox" name="notifications_on"><input type="checkbox" name="mail_export_on"></form>');
    if(path==='/api/docs/')return new Response('<dl><dt>API Key</dt><dd><code>'+matToken+'</code></dd></dl>');
    if(path==='/api/posts/'&&init.method==='GET')return json({ok:true,post_list:[]});
  }
  throw Error('Unexpected synthetic request '+id+' '+path);
}
function isArticlePost(id:Id,url:string,init:RequestInit){
  if(id==='hive')return init.method==='POST'&&JSON.parse(String(init.body)).method==='condenser_api.broadcast_transaction';
  return init.method==='POST'&&new URL(url).pathname===(id==='mataroa'?'/api/posts/':id==='telegraph'?'/createPage':'/gists');
}
async function run(id:Id,context:ExecutionContext,fetch:(url:string,init:RequestInit)=>Promise<Response>){
  if(id==='mataroa')return runMataroaTask(context,{fetch,now:()=>at});
  if(id==='hive')return runHiveTask(context,{fetch,rpc:hiveRpc,now:()=>at});
  if(id==='telegraph')return telegraphTesting.runWithTransport(context,fetch);
  return runGistTask(context,{fetch,now:()=>at});
}
const tick=()=>new Promise<void>(r=>setImmediate(r));
for(const id of ids)for(const kind of ['declared-header','actual-overflow'] as const){
  test(id+': '+kind+' disposes rejected response without awaiting cancel and never replaces publication',{timeout:2500},async()=>{
    const f=fixture(id),limit=id==='mataroa'?512*1024:id==='hive'?1024*1024:256*1024;
    let cancels=0,pulls=0,posts=0,settled=false,releaseCancel!:()=>void,signal:AbortSignal|undefined;
    const cancellation=new Promise<void>(r=>{releaseCancel=r});
    const response=new Response(new ReadableStream<Uint8Array>({
      pull(c){pulls++;if(kind==='actual-overflow')c.enqueue(new Uint8Array(limit+1));},
      cancel(){cancels++;return cancellation},
    },{highWaterMark:0}),{status:200,headers:{'content-type':'application/json',...(kind==='declared-header'?{'content-length':String(limit+1)}:{})}});
    const fetch=async(url:string,init:RequestInit)=>{
      if(isArticlePost(id,url,init)){posts++;counters.syntheticArticlePosts++;assert.ok(f.task.submittedAt,'intent must precede article POST');signal=init.signal as AbortSignal;return response}
      return ordinaryResponse(id,url,init);
    };
    const operation=run(id,f.context,fetch).then(value=>{settled=true;return value});
    let guard:ReturnType<typeof setTimeout>|undefined;
    try{
      const first=await Promise.race([operation,new Promise<undefined>(r=>{guard=setTimeout(()=>r(undefined),400)})]);
      assert.equal(settled,true,'request must settle while body cancel remains pending');
      assert.equal(posts,1,'fixture must reach exactly one article POST');
      assert.ok(f.task.submittedAt);assert.equal(f.task.publicUrl,undefined);
      const saved=structuredClone(f.task),identity=f.identity();f.assertIdentity();
      f.abort.abort();await tick();
      let replacementPosts=0;
      const retryTask=structuredClone(saved);
      const retryContext={...f.context,task:retryTask,signal:new AbortController().signal,checkpoint:(p:Partial<Task>)=>Object.assign(retryTask,structuredClone(p))};
      await run(id,retryContext,async(url,init)=>{
        if(isArticlePost(id,url,init)){replacementPosts++;throw Error('Replacement article POST forbidden')}
        return ordinaryResponse(id,url,init);
      });
      assert.equal(replacementPosts,0);assert.equal(retryTask.submittedAt,saved.submittedAt);assert.deepEqual(f.identity(),identity);f.assertIdentity();
      console.log(JSON.stringify({id,kind,posts,replacementPosts,cancels,pulls,requestSignalAborted:signal?.aborted,
        settledBeforeCancellationCompletes:settled,firstStatus:first?.status,checkpoint:saved.checkpoint,
        receiptStage:id==='mataroa'?saved.mataroa?.stage:id==='hive'?saved.hive?.stage:undefined,identityAndCredentialRetained:true}));
      assert.equal(pulls,kind==='declared-header'?0:1);
      assert.equal(cancels,1,'rejected response must be cancelled; caller abort after return no longer reaches request');
    } finally {
      if(guard)clearTimeout(guard);
      releaseCancel();await operation;
      if(cancels===0)await response.body?.cancel();
    }
  });
}
test('all transport fixtures stayed synthetic',()=>{
  console.log(JSON.stringify({counters}));
  assert.equal(counters.defaultFetch,0);
  assert.equal(counters.syntheticArticlePosts,8);
});

