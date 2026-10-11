import assert from 'node:assert/strict';
import test from 'node:test';
import {CHANNELS} from '../src/integrations/catalog';
import {publisherFor} from '../src/integrations/publishers';
import {raindropTesting} from '../src/integrations/raindrop';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import {Controller} from '../src/main/controller';
import {socialPublicationAt} from '../src/main/planner';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import {hasExternalAttempt} from '../src/main/task-recovery';
import type {Account,RaindropReceipt,Site,Task} from '../src/shared/types';

const STAMP='2026-10-10T12:00:00.000Z',SITE_ID='11111111-1111-4111-8111-111111111111',OTHER_SITE_ID='55555555-5555-4555-8555-555555555555';
const ACCOUNT_ID='22222222-2222-4222-8222-222222222222',TASK_ID='33333333-3333-4333-8333-333333333333';
const OWNER='32',COLLECTION='66',PUBLIC='https://writer.raindrop.page/resources',TARGET='https://example.com/guides/source-checking';
const TITLE='A reproducible source-checking workflow',EXCERPT='Commercial relationship disclosure: this public resource review promotes the linked site and explains a reproducible source-checking step without promising results.';

function channel(){const value=CHANNELS.find(item=>item.id==='raindrop');assert.ok(value);return value}
async function enabled<T>(run:()=>Promise<T>):Promise<T>{const value=channel(),before=value.enabled;value.enabled=true;try{return await run()}finally{value.enabled=before}}
function site(id=SITE_ID):Site{return {id,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example Research',description:'Independent source research',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:STAMP,analyzedAt:STAMP,topicsCheckedAt:STAMP,topics:[{url:TARGET,discoveredAt:STAMP}]}}
function account():Account{return {id:ACCOUNT_ID,channelId:'raindrop',email:'',username:OWNER,displayName:'Research resources',publicationUrl:PUBLIC,credentialKind:'api_token',hasPassword:true,status:'registered',source:'imported',createdAt:STAMP,updatedAt:STAMP,verifiedAt:STAMP,raindrop:{version:1,ownerId:OWNER,collectionId:COLLECTION,publicUrl:PUBLIC,tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:STAMP}}}
function task():Task{return {id:TASK_ID,siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,sourceDomain:'raindrop.page',status:'queued',createdAt:STAMP,scheduledAt:STAMP,updatedAt:STAMP,attempts:0,message:'fixture',topicUrl:TARGET,draftRevision:1,draft:{title:TITLE,description:'local summary only',body:EXCERPT},health:'pending'}}
function receipt(stage:RaindropReceipt['stage']):RaindropReceipt{return {operationId:`raindrop_${TASK_ID.replaceAll('-','')}`,ownerId:OWNER,collectionId:COLLECTION,tokenVersion:1,target:TARGET,title:TITLE,excerpt:EXCERPT,payloadHash:raindropTesting.payloadHash(TARGET,TITLE,EXCERPT,COLLECTION),createdAt:STAMP,baselineItemIds:[],baselineComplete:true,stage,...(['api_receipt','published'].includes(stage)?{itemId:'900',remoteCreatedAt:STAMP}:{})}}
const vault={ready:true,available:()=>true,get:async()=>undefined,set:async()=>undefined,delete:async()=>undefined,encryptSecrets:()=>({})} as unknown as Vault;

test('Controller accepts only the bound Raindrop receipt chain and promotes it after the dedicated verifier',async()=>enabled(async()=>{
  const store=new Store(':memory:');try{
    store.update(state=>{const t=task(),a=account(),s=site();state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='ai';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(CHANNELS.map(item=>[item.id,item.id==='raindrop']));t.articleReview={status:'passed',reason:'fixture review passed',reasonCode:'passed',reviewContractVersion:4,evidenceUrls:[],draftRevision:1,contentHash:articleContentHash(t),contextHash:articleContextHash(s,channel(),state.settings,a),reviewedAt:STAMP};state.sites=[s];state.accounts=[a];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,createdAt:STAMP,updatedAt:STAMP}];state.tasks=[t]});
    let executions=0,verifications=0;
    const controller=new Controller(store,vault,'fixture',{
      executeTask:async context=>{
        executions++;
        context.checkpoint({raindrop:receipt('prepared'),checkpoint:'raindrop_prepared',submittedAt:STAMP});
        context.checkpoint({raindrop:receipt('submitting'),checkpoint:'raindrop_submitting',submittedAt:STAMP});
        context.checkpoint({raindrop:receipt('api_receipt'),checkpoint:'raindrop_api_receipt',submittedAt:STAMP,publicUrl:PUBLIC});
        return {status:'review',message:'API and public page agree',raindrop:receipt('published'),checkpoint:'raindrop_published',submittedAt:STAMP,publicUrl:PUBLIC};
      },
      verifyRaindrop:async()=>{verifications++;return {found:true,outcome:'found',url:PUBLIC,rel:'nofollow noopener noreferrer',reason:'visible title, excerpt, and target'}},
    });
    controller.runtime.aiReady=true;
    await controller.tick();const saved=store.read().tasks[0],savedAccount=store.read().accounts[0];
    assert.equal(executions,1,JSON.stringify(saved));
    assert.equal(verifications,1,JSON.stringify(saved));
    assert.equal(saved.status,'live');assert.equal(saved.health,'healthy');assert.equal(saved.checkpoint,'raindrop_published');assert.equal(saved.raindrop?.stage,'published');assert.equal(saved.publicUrl,PUBLIC);assert.equal(saved.linkCheck,'found');assert.ok(savedAccount.raindrop?.acceptedAt);assert.equal(hasExternalAttempt(saved),true);
  }finally{store.close()}
}));

test('one Raindrop collection is one shared destination for cross-site cadence',()=>{
  const state=emptyState(),first=task();first.status='live';first.submittedAt=STAMP;first.firstLiveAt=STAMP;first.publicUrl=PUBLIC;first.raindrop=receipt('published');state.sites=[site(),site(OTHER_SITE_ID)];state.accounts=[account()];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId:SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,createdAt:STAMP,updatedAt:STAMP},{id:'66666666-6666-4666-8666-666666666666',siteId:OTHER_SITE_ID,channelId:'raindrop',accountId:ACCOUNT_ID,createdAt:STAMP,updatedAt:STAMP}];state.tasks=[first];
  const requested=new Date(Date.parse(STAMP)+3600000);assert.equal(socialPublicationAt(state,OTHER_SITE_ID,'raindrop',requested).toISOString(),new Date(Date.parse(STAMP)+86400000).toISOString());assert.ok(publisherFor(channel())?.publish);assert.ok(publisherFor(channel())?.reconcile);
});
