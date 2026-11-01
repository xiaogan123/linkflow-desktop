import test from 'node:test';
import assert from 'node:assert/strict';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {defaultSettings} from '../src/main/store';
import {mastodonTesting,probeMastodonConnection,reconcileMastodonTask,runMastodonTask,verifyMastodonPublication} from '../src/integrations/mastodon';
import type {Batch5Intent,Batch5OpaqueResponse,Batch5Persistence,Batch5Receipt} from '../src/integrations/batch5-contract';
import type {Account,Channel,ExecutionContext,Site,Task} from '../src/shared/types';

const NOW='2026-10-28T12:00:00.000Z',TARGET='https://example.com/source-guide',TOKEN='mastodon-user-access-token-test';
const BODY=`Source checks need a primary reference, a date, and an explicit uncertainty note. Full guide: ${TARGET}`;
const OWNER={id:'12345',acct:'writer',url:'https://mastodon.social/@writer',bot:true,indexable:true};
const STATUS={id:'999001',url:'https://mastodon.social/@writer/999001',visibility:'public',account:OWNER,
  in_reply_to_id:null,reblog:null,spoiler_text:'',mentions:[],media_attachments:[],poll:null,
  content:`<p>Source checks need a primary reference, a date, and an explicit uncertainty note. Full guide: <a href="${TARGET}" rel="nofollow noopener noreferrer">${TARGET}</a></p>`};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const robots=(value='User-agent: *\nDisallow: /api/\n')=>new Response(value,{status:200,headers:{'content-type':'text/plain'}});

class Journal implements Batch5Persistence {
  intent?:Batch5Intent;receipt?:Batch5Receipt;opaque?:Batch5OpaqueResponse;task?:Task;posts=0;readyChecks=0;block=false;
  async saveIntent(value:Batch5Intent){if(this.intent&&JSON.stringify(this.intent)!==JSON.stringify(value))throw Error('different_intent');this.intent=structuredClone(value)}
  async reserveIntent(value:Batch5Intent){await this.saveIntent(value);this.task!.batch5={...value,stage:'reserved',accountId:this.task!.accountId};this.task!.checkpoint='batch5_reserved'}
  async markSending(value:Batch5Intent){if(this.block||this.task?.batch5?.stage!=='reserved'||this.intent?.operationId!==value.operationId)throw Error('not_ready');this.task.batch5.stage='submitting';this.task.submittedAt=value.createdAt}
  currentTaskState(){return this.task?.batch5}
  async loadIntent(){return this.intent}
  async saveReceipt(value:Batch5Receipt){this.receipt=structuredClone(value)}
  async loadReceipt(){return this.receipt}
  async saveOpaqueResponse(value:Batch5OpaqueResponse){this.opaque=structuredClone(value)}
  async loadOpaqueResponse(){return this.opaque}
  async assertReadyToSubmit(){this.readyChecks++;if(this.block)throw Error('paused')}
}

function fixture(){
  const site:Site={id:'site-1',domain:'example.com',url:'https://example.com/',email:'',name:'Example',description:'Source guidance',category:'education',language:'en',monthlyTarget:1,status:'ready',createdAt:NOW};
  const channel:Channel={id:'mastodon',name:'Mastodon',domain:'mastodon.social',url:'https://mastodon.social/',submitUrl:'https://mastodon.social/',categories:['education'],languages:['*'],kind:'article',emailRequired:false,accountRequired:true,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'',rulesUrl:'https://mastodon.social/about',checkedAt:'2026-10-28',notes:'',allowedHosts:['mastodon.social'],enabled:true,contentFormat:'social'};
  const account:Account={id:'account-1',channelId:'mastodon',email:'',username:'writer',publicationUrl:OWNER.url,credentialKind:'api_token',hasPassword:true,status:'registered',createdAt:NOW};
  const settings={...defaultSettings(),articleReviewMode:'ai' as const};
  const task:Task={id:'task-1',siteId:site.id,channelId:channel.id,accountId:account.id,sourceDomain:channel.domain,status:'running',createdAt:NOW,scheduledAt:NOW,updatedAt:NOW,attempts:1,message:'',topicUrl:TARGET,draftRevision:1,draft:{title:'Source checking',description:'',body:BODY}};
  task.articleReview={status:'passed',reason:'passed',draftRevision:1,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings,account,4),evidenceUrls:[],reviewContractVersion:4};
  const journal=new Journal();journal.task=task;
  const context:ExecutionContext={site,channel,task,settings,signal:new AbortController().signal,ai:{json:async<T>()=>({} as T)},
    secrets:{get:async()=>TOKEN,set:async()=>undefined,delete:async()=>undefined},getAccount:()=>account,saveAccount:async()=>undefined,
    checkpoint:partial=>Object.assign(task,partial),log:()=>undefined,batch5Persistence:journal};
  return {context,task,account,journal};
}

test('connection probe requires the fixed local account, bot flag, and indexing opt-in',async()=>{
  const deps={fetch:async(url:string,init:RequestInit)=>{assert.equal(url,'https://mastodon.social/api/v1/accounts/verify_credentials');assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${TOKEN}`);return json(OWNER)}};
  assert.deepEqual(await probeMastodonConnection(TOKEN,deps),OWNER);
  for(const remote of [{...OWNER,bot:false},{...OWNER,indexable:false},{...OWNER,url:'https://another.example/@writer'},{...OWNER,acct:'writer@elsewhere'}]){
    await assert.rejects(probeMastodonConnection(TOKEN,{fetch:async()=>json(remote)}));
  }
});

test('publishes the approved text once with a public visibility and durable encrypted intent, then verifies anonymous page',async()=>{
  const f=fixture();let posts=0,gets=0,rendered=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/verify_credentials'))return json(OWNER);
    if(url==='https://mastodon.social/api/v1/statuses'&&init.method==='POST'){
      posts++;assert.ok(f.journal.intent);assert.equal(f.task.batch5?.stage,'submitting');
      assert.equal((init.headers as Record<string,string>)['Idempotency-Key'],f.journal.intent?.operationId);
      const body=new URLSearchParams(String(init.body));assert.equal(body.get('status'),BODY);assert.equal(body.get('visibility'),'public');assert.equal([...body.keys()].length,2);
      return json(STATUS)}
    if(url==='https://mastodon.social/api/v1/statuses/999001'){gets++;assert.equal(init.method,'GET');assert.equal((init.headers as Record<string,string>).authorization,undefined);return json(STATUS)}
    if(url==='https://mastodon.social/robots.txt')return robots();
    throw Error(`unexpected ${url}`)
  },renderPage:async(url,target,title,body)=>{rendered++;assert.equal(url,STATUS.url);assert.equal(target,TARGET);assert.equal(title,'Source checking');assert.equal(body,BODY);return {found:true,indexable:true,rel:'nofollow noopener noreferrer'}}};
  const created=await runMastodonTask(f.context);assert.equal(created.status,'review');assert.equal(posts,1);assert.equal(f.journal.readyChecks,1);
  assert.equal(f.journal.receipt?.publicUrl,STATUS.url);assert.equal(f.journal.opaque?.status,200);
  assert.equal((await reconcileMastodonTask(f.context)).status,'found');
  const check=await verifyMastodonPublication(f.context);assert.equal(check.found,true);assert.equal(check.rel,'nofollow noopener noreferrer');assert.ok(gets>=2);assert.equal(rendered,1);
  assert.equal((await runMastodonTask(f.context)).status,'review');assert.equal(posts,1);
});

test('paused authorization preserves a proved-unsent intent; unknown POST outcome never sends twice',async()=>{
  const f=fixture();f.journal.block=true;let posts=0;
  f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/verify_credentials'))return json(OWNER);
    if(init.method==='POST'){posts++;throw Error('committed then disconnected')}
    throw Error(url)
  }};
  assert.equal((await runMastodonTask(f.context)).status,'queued');assert.equal(posts,0);assert.equal(f.task.batch5?.stage,'reserved');
  f.journal.block=false;
  assert.equal((await runMastodonTask(f.context)).reasonCode,'submission_unknown');assert.equal(posts,1);
  assert.equal((await runMastodonTask(f.context)).reasonCode,'submission_unknown');assert.equal(posts,1);
});

test('rejects mentions, altered targets, noindex, blocked robots, and missing dynamic rendering',async()=>{
  const altered=fixture();altered.task.draft!.body=BODY+' @other';
  assert.throws(()=>mastodonTesting.approved(altered.context),/提及/);
  const f=fixture();f.context.batch5Dependencies={now:()=>new Date(NOW),fetch:async(url,init)=>{
    if(url.endsWith('/verify_credentials'))return json(OWNER);
    if(init.method==='POST')return json(STATUS);
    if(url.endsWith('/statuses/999001'))return json(STATUS);
    if(url.endsWith('/robots.txt'))return robots('User-agent: *\nDisallow: /@\n');
    throw Error(url)
  },renderPage:async()=>({found:true,indexable:true,rel:''})};
  assert.equal((await runMastodonTask(f.context)).status,'review');
  assert.equal((await verifyMastodonPublication(f.context)).outcome,'invalid');
  f.context.batch5Dependencies={...f.context.batch5Dependencies,fetch:async(url,init)=>{
    if(url.endsWith('/verify_credentials'))return json(OWNER);
    if(url.endsWith('/statuses/999001'))return json(STATUS);
    if(url.endsWith('/robots.txt'))return robots();
    throw Error(`${url} ${init.method}`)
  },renderPage:async()=>({found:true,indexable:false,rel:''})};
  assert.equal((await verifyMastodonPublication(f.context)).outcome,'invalid');
  f.context.batch5Dependencies={...f.context.batch5Dependencies,renderPage:undefined};
  assert.equal((await verifyMastodonPublication(f.context)).outcome,'unreachable');
});


test('Mastodon rejects hashtag generation and unreviewed anchor labels before acceptance',()=>{
 const f=fixture();f.task.draft!.body=BODY+' #software';
 assert.throws(()=>mastodonTesting.approved(f.context),/标签/);
 const expected={text:BODY,target:TARGET,body:''};
 assert.equal(mastodonTesting.exactStatus(STATUS,OWNER.id,OWNER.acct,STATUS.id,expected),true);
 const changed={...STATUS,content:STATUS.content.replace(`>${TARGET}</a>`,'>UNREVIEWED PROMOTION</a>')};
 assert.equal(mastodonTesting.exactStatus(changed,OWNER.id,OWNER.acct,STATUS.id,expected),false);
});
