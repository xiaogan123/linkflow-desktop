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

test('managed legacy receipts use complete-article verification and retain intent when the article is invalid',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[task(fixture)]});let reads=0,generic=0;
    const services:ControllerServices={verifyLink:async()=>{generic++;throw Error('managed publication must not use link-only verification')}};
    services[fixture.service]=async context=>{reads++;assert.equal(context.task.id,taskId);assert.equal(context.task.submittedAt,stamp);return {found:false,outcome:'invalid',url:fixture.publicUrl,rel:'unknown',reason:'complete original article no longer matches'} satisfies LinkResult};
    try{const controller=new Controller(store,vault,'fixture',services);await controller.verify(taskId);await controller.tick();const saved=store.read().tasks[0];
      assert.equal(reads,1,fixture.channelId);assert.equal(generic,0,fixture.channelId);assert.equal(saved.firstLiveAt,undefined,fixture.channelId);
      assert.equal(saved.linkCheck,'invalid');assert.equal(saved.health,'unknown');assert.equal(saved.submittedAt,stamp);assert.equal(saved.publicUrl,fixture.publicUrl);assert.equal(saved.checkpoint,fixture.checkpoint);assert.equal(store.read().tasks.length,1);
    }finally{store.close()}
  }
}));

test('managed legacy receipts missing their original draft fail closed without using the generic link checker',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[{...task(fixture),draft:undefined}]});let generic=0;
    try{await new Controller(store,vault,'fixture',{verifyLink:async()=>{generic++;throw Error('must not downgrade missing draft')}}).verify(taskId);const saved=store.read().tasks[0];
      assert.equal(generic,0,fixture.channelId);assert.equal(saved.firstLiveAt,undefined,fixture.channelId);assert.equal(saved.linkCheck,'invalid',fixture.channelId);assert.equal(saved.submittedAt,stamp);assert.equal(saved.publicUrl,fixture.publicUrl);
    }finally{store.close()}
  }
}));

test('explicit external adoption and existing-link records retain the separate public-link verification path',async()=>withPublicGist(async()=>{
  for(const fixture of fixtures)for(const kind of ['external','existing_link'] as const){
    const store=new Store(':memory:');store.update(state=>{state.settings.autoRun=false;state.sites=[site];state.tasks=[{...task(fixture),draft:undefined,...(kind==='external'?{publicationMethod:'external' as const}:{checkpoint:'existing_link'})}]});let generic=0;
    const services:ControllerServices={verifyLink:async(url)=>{generic++;return {found:true,outcome:'found',url,rel:'nofollow',reason:'public external link'}}};services[fixture.service]=async()=>{throw Error('external adoption is not a locally authored article')};
    try{await new Controller(store,vault,'fixture',services).verify(taskId);const saved=store.read().tasks[0];assert.equal(generic,1,`${fixture.channelId}:${kind}`);assert.equal(saved.linkCheck,'found');assert.equal(saved.status,kind==='external'?'live':'skipped');if(kind==='existing_link')assert.equal(saved.firstLiveAt,undefined);else if(fixture.channelId==='github-gist')assert.equal(saved.firstLiveAt,stamp);
    }finally{store.close()}
  }
}));
