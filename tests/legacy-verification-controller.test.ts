import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller,type ControllerServices} from '../src/main/controller';
import {Store} from '../src/main/store';
import type {LinkResult,Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-01T00:00:00.000Z',siteId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222';
const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Synthetic guides',description:'Original technical guides',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
const vault={available:()=>true,ready:true,get:async()=>undefined,set:async()=>{},delete:async()=>{}} as unknown as Vault;
const fixtures=[
  {channelId:'telegraph',sourceDomain:'telegra.ph',publicUrl:'https://telegra.ph/Synthetic-guide-10-01',checkpoint:'telegraph_published',service:'verifyTelegraph'},
  {channelId:'github-gist',sourceDomain:'gist.github.com',publicUrl:'https://gist.github.com/fixture/abcdef1234567890',checkpoint:'gist_published',service:'verifyGist'},
  {channelId:'blogger',sourceDomain:'fixture.blogspot.com',publicUrl:'https://fixture.blogspot.com/2026/10/synthetic.html',checkpoint:'blogger_published',service:'verifyBlogger'},
] as const;
function task(fixture:typeof fixtures[number]):Task{const {service,...identity}=fixture;return {id:taskId,siteId,...identity,status:'review',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,submittedAt:stamp,attempts:1,message:'synthetic receipt',publicationMethod:'client',draft:{title:'Synthetic guide',description:'Original practical method',body:'The complete original guide.'}}}
async function withPublicGist<T>(work:()=>Promise<T>){const original=globalThis.fetch;globalThis.fetch=async(input,init)=>{assert.equal(init?.method??'GET','GET');assert.match(String(input),/^https:\/\/api\.github\.com\/gists\//);return Response.json({id:'abcdef1234567890',html_url:fixtures[1].publicUrl,owner:{login:'fixture'},public:true,created_at:stamp})};try{return await work()}finally{globalThis.fetch=original}}

test('legacy receipts without snapshots use visible link evidence and retain the original receipt',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures.filter(value=>value.channelId!=='telegraph')){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[task(fixture)]});let reads=0,generic=0;
    const services:ControllerServices={recheckLink:async url=>{generic++;return {found:false,outcome:'invalid',url,rel:'unknown',reason:'hidden fixture link',reasonCode:'link_hidden'}}};
    services[fixture.service]=async context=>{reads++;assert.equal(context.task.id,taskId);assert.equal(context.task.submittedAt,stamp);return {found:false,outcome:'invalid',url:fixture.publicUrl,rel:'unknown',reason:'complete original article no longer matches'} satisfies LinkResult};
    try{const controller=new Controller(store,vault,'fixture',services);await controller.verify(taskId);await controller.tick();const saved=store.read().tasks[0];
      assert.equal(reads,0,fixture.channelId);assert.equal(generic,1,fixture.channelId);assert.equal(saved.firstLiveAt,undefined,fixture.channelId);
      assert.equal(saved.linkCheck,'invalid');assert.equal(saved.health,'unknown');assert.equal(saved.submittedAt,stamp);assert.equal(saved.publicUrl,fixture.publicUrl);assert.equal(saved.checkpoint,fixture.checkpoint);assert.equal(store.read().tasks.length,1);
    }finally{store.close()}
  }
}));

test('legacy receipts missing the original draft can recover from visible link evidence',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures.filter(value=>value.channelId!=='telegraph')){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[{...task(fixture),draft:undefined}]});let generic=0;
    try{await new Controller(store,vault,'fixture',{recheckLink:async url=>{generic++;return {found:true,outcome:'found',url,rel:'follow',reason:'visible fixture link',reasonCode:'link_found'}}}).verify(taskId);const saved=store.read().tasks[0];
      assert.equal(generic,1,fixture.channelId);assert.ok(saved.firstLiveAt,fixture.channelId);assert.equal(saved.linkCheck,'found',fixture.channelId);assert.equal(saved.submittedAt,stamp);assert.equal(saved.publicUrl,fixture.publicUrl);
    }finally{store.close()}
  }
}));

test('explicit external adoption and existing-link records retain the separate public-link verification path',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures)for(const kind of ['external','existing_link'] as const){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[{...task(fixture),draft:undefined,...(kind==='external'?{publicationMethod:'external' as const}:{checkpoint:'existing_link'})}]});let generic=0;
    const services:ControllerServices={recheckLink:async(url)=>{generic++;return {found:true,outcome:'found',url,rel:'nofollow',reason:'public external link',reasonCode:'link_found'}},verifyLink:async(url)=>{generic++;return {found:true,outcome:'found',url,rel:'nofollow',reason:'public external link'}}};services[fixture.service]=async()=>{throw Error('external adoption is not a locally authored article')};
    try{await new Controller(store,vault,'fixture',services).verify(taskId);const saved=store.read().tasks[0];assert.equal(generic,1,`${fixture.channelId}:${kind}`);assert.equal(saved.linkCheck,'found');assert.equal(saved.status,kind==='external'?'live':'skipped');if(kind==='existing_link')assert.equal(saved.firstLiveAt,undefined);else assert.ok(saved.firstLiveAt);
    }finally{store.close()}
  }
}));

test('historical Telegraph pages are checked without a current draft or author rendering',async()=>{
  const store=new Store(':memory:');let rechecks=0;
  try{store.update(state=>{state.sites=[site];state.tasks=[{...task(fixtures[0]),draft:undefined}]});
    await new Controller(store,vault,'fixture',{recheckLink:async(url)=>{rechecks++;return {found:true,outcome:'found',url,rel:'nofollow',reason:'visible link',reasonCode:'link_found',indexable:true}},verifyTelegraph:async()=>{throw Error('historical draft must not be rerendered')}}).verify(taskId);
    const saved=store.read().tasks[0];assert.equal(rechecks,1);assert.equal(saved.status,'live');assert.equal(saved.linkCheck,'found');assert.equal(saved.submittedAt,stamp);
  }finally{store.close()}
});
