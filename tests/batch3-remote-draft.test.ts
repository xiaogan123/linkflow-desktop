import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {CHANNELS} from '../src/integrations/catalog';
import {articleContentHash,articleContextHash} from '../src/main/article-review';
import type {Vault} from '../src/main/vault';
const stamp='2026-10-18T12:17:00.000Z';
test('a duplicate discovered at Blogger final submission preserves the already-created remote draft',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});
 const store=new Store(':memory:'),vault={ready:true,available:()=>true,get:async()=>undefined} as unknown as Vault;
 const draft={title:'A documented recovery procedure',description:'Source-based recovery',body:'A recovery procedure preserves the original material before making a replacement. The recorded result stays attached to its source and should not be silently overwritten.'};
 const receipt={blogId:'100',postId:'200',operationId:'existing-operation',contentHash:'a'.repeat(64),stage:'draft' as const};
 store.update(s=>{
  s.settings.autoRun=true;s.settings.timezone='UTC';s.settings.articleReviewMode='ai';
  s.sites=[{id:'site',url:'https://example.com/',domain:'example.com',email:'owner@example.com',name:'Example',description:'Original guides',category:'content',language:'en',monthlyTarget:2,status:'ready',createdAt:'2026-09-01T00:00:00.000Z',analyzedAt:stamp,topicsCheckedAt:stamp,blogger:{blogId:'100',url:'https://example.blogspot.com/'}}];
  s.accounts=[{id:'account',channelId:'blogger',email:'owner@example.com',username:'99',credentialKind:'oauth',status:'registered',hasPassword:true,createdAt:stamp}];
  s.accountBindings=[{id:'binding',siteId:'site',channelId:'blogger',accountId:'account',createdAt:stamp,updatedAt:stamp}];
  s.tasks=[{id:'task',siteId:'site',channelId:'blogger',accountId:'account',sourceDomain:'example.blogspot.com',status:'queued',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,submittedAt:stamp,checkpoint:'blogger_draft_created',blogger:receipt,attempts:0,message:'Saved remote draft',draft},
    {id:'old',siteId:'other',channelId:'fixture',sourceDomain:'publisher.example.com',status:'failed',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:1,message:'Retained manuscript',draft}];
 });
 let checkpointReached=0;
 const controller=new Controller(store,vault,'fixture',{channelCatalog:CHANNELS.filter(c=>c.id==='blogger'),reconcileBlogger:async()=>({status:'draft',blogger:receipt}),reviewArticle:async(task,site,channel,settings)=>({status:'passed',reason:'Synthetic review',reviewedAt:stamp,evidenceUrls:[],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(site,channel,settings)}),executeTask:async context=>{
  checkpointReached++;context.checkpoint({blogger:{...receipt,stage:'publishing'},checkpoint:'blogger_publish_submitting',submittedAt:stamp});throw Error('Submission guard should stop this call');
 }});controller.runtime.aiReady=true;
 try{await controller.tick();const saved=store.read().tasks.find(x=>x.id==='task')!;assert.equal(checkpointReached,1,JSON.stringify(saved));assert.equal(saved.status,'needs_input');assert.ok(['duplicate_content','submission_unknown'].includes(saved.reasonCode!));assert.deepEqual(saved.draft,draft);assert.deepEqual(saved.blogger,receipt);assert.equal(saved.submittedAt,stamp);assert.equal(saved.draftHistory,undefined);assert.equal(saved.topicSwitchAttempts,undefined);}finally{controller.stop();store.close()}
});
