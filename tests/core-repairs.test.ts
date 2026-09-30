import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {CHANNELS} from '../src/integrations/catalog';
import {telegraphTesting} from '../src/integrations/telegraph';
import {runGistTask} from '../src/integrations/gist';
import type {Site,Task} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-09-01T00:00:00.000Z';
const site:Site={id:'11111111-1111-4111-8111-111111111111',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'A maintained technical project',category:'developer',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,qualifications:{developer:'https://example.com/project'}};
const body=['We operate the Example website. '+ 'Record every input and output in this reusable technical checklist. '.repeat(6),'Compare the public documentation and capture uncertainty. '.repeat(6),'Consult the [official site](https://example.com/) to verify the published project details. '+ 'Review all error conditions before relying on the result. '.repeat(6)].join('\n\n');
function task(channelId:string):Task{return {id:'22222222-2222-4222-8222-222222222222',siteId:site.id,channelId,sourceDomain:CHANNELS.find(c=>c.id===channelId)!.domain,status:'queued',createdAt:stamp,updatedAt:stamp,scheduledAt:stamp,attempts:0,message:'fixture',articleApprovedAt:stamp,draft:{title:'Reusable technical checklist',description:'A reproducible guide',body}}}
const vault={ready:true,available:()=>true,get:async()=> 'synthetic-token-123456789012345',encryptSecrets:()=>({})} as unknown as Vault;

for(const channelId of ['telegraph','github-gist'])test(`${channelId} retains a validated publish receipt when pause wins the response race`,async()=>{
  const store=new Store(':memory:');store.update(s=>{s.settings.autoRun=true;s.settings.articleReviewMode='manual';s.sites=[site];s.tasks=[task(channelId)];s.accounts=[{id:'account',channelId,email:site.email,username:'fixture-owner',createdAt:stamp,status:'registered',credentialKind:'api_token',hasPassword:true}];s.tasks[0].accountId='account'});
  let posts=0,postReturned=false,readsAfterPost=0,controller:Controller;
  controller=new Controller(store,vault,'isolated-fixture',{executeTask:async context=>{
    const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(channelId==='telegraph')return telegraphTesting.runWithTransport(context,async url=>{
      if(url.endsWith('/getAccountInfo'))return json({ok:true,result:{short_name:'fixture'}});
      if(url.endsWith('/createPage')){posts++;controller.pause();postReturned=true;return json({ok:true,result:{path:'receipt-fixture-09-30',url:'https://telegra.ph/receipt-fixture-09-30'}})}
      if(postReturned)readsAfterPost++;throw Error('unexpected Telegraph request');
    });
    return runGistTask(context,{fetch:async(url,init)=>{
      if(url.endsWith('/user'))return json({login:'fixture-owner'});
      if(init.method==='POST'){posts++;controller.pause();postReturned=true;const payload=JSON.parse(String(init.body));return json({id:'abcde12345',public:true,html_url:'https://gist.github.com/fixture-owner/abcde12345',owner:{login:'fixture-owner'},files:{'README.md':{filename:'README.md',content:payload.files['README.md'].content,truncated:false}}})}
      if(postReturned)readsAfterPost++;throw Error('unexpected Gist request');
    }});
  }});controller.runtime.aiReady=true;
  try{
    await controller.tick();const saved=store.read().tasks[0];
    assert.equal(posts,1);assert.equal(readsAfterPost,0);assert.equal(saved.status,'needs_input');assert.ok(saved.publicUrl);assert.ok(saved.submittedAt);assert.match(saved.checkpoint??'',/published/);assert.match(saved.message,/不会重复/);assert.equal(store.read().settings.autoRun,false);
  }finally{store.close()}
});

for(const channelId of ['vocus','publish0x'])test(`${channelId} refuses full-draft AI generation even while its record exists`,async()=>{
  const store=new Store(':memory:');store.update(s=>{s.sites=[{...site,category:'content'}];s.tasks=[task(channelId)]});const controller=new Controller(store,vault,'fixture');
  try{await assert.rejects(controller.generateDraft(store.read().tasks[0].id),/纯人工原创/);assert.equal(store.read().tasks[0].draft?.body,body)}finally{store.close()}
});
