import test from 'node:test';
import assert from 'node:assert/strict';
import {connectParagraph} from '../src/main/paragraph-management';
import {encryptBackup,decryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {Store,emptyState} from '../src/main/store';
import type {ParagraphTransport} from '../src/integrations/paragraph';
import type {SecretStore,Site,Task} from '../src/shared/types';

const stamp='2026-10-07T00:00:00.000Z';
const apiKey='synthetic-paragraph-api-key';
const publication={id:'PublicationFixture0001',name:'Fixture Publication',ownerUserId:'OwnerFixture00000001',slug:'fixture-publication'};
const publicationUrl='https://paragraph.com/@fixture-publication/';
function json(value:unknown){return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})}
function transport(value=publication){const calls:string[]=[];const fetch:ParagraphTransport=async(input,init)=>{const url=new URL(input);calls.push(`${init.method} ${url.href}`);assert.equal(url.pathname,'/api/v1/me');return json(value)};return {fetch,calls}}
function site(id:string,domain:string):Site{return {id,domain,url:`https://${domain}/`,email:`owner@${domain}`,name:domain,description:'Original educational publication',category:'content',language:'en',monthlyTarget:2,articleReviewMode:'ai',status:'ready',createdAt:stamp}}
function fixture(){const store=new Store(':memory:');store.update(state=>state.sites=[site('11111111-1111-4111-8111-111111111111','one.example.com'),site('22222222-2222-4222-8222-222222222222','two.example.com')]);const secrets=new Map<string,string>();const vault:SecretStore={get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value)},delete:async key=>{secrets.delete(key)}};return {store,secrets,vault}}

test('verified Paragraph identity stores metadata and binds only the selected sites',async()=>{
  const {store,secrets,vault}=fixture(),remote=transport();
  try{
    const account=await connectParagraph(store,vault,apiKey,[store.read().sites[0].id],undefined,{fetch:remote.fetch,now:()=>new Date(stamp)});
    const state=store.read(),first=state.sites[0],second=state.sites[1];
    assert.equal(account.username,publication.id);assert.equal(account.displayName,publication.name);assert.equal(account.publicationUrl,publicationUrl);assert.equal(account.email,'');
    assert.deepEqual(first.paragraph,{publicationId:publication.id,url:publicationUrl});assert.equal(second.paragraph,undefined);
    assert.deepEqual(state.accountBindings.map(binding=>[binding.siteId,binding.channelId,binding.accountId]),[[first.id,'paragraph',account.id]]);
    assert.equal(state.accounts.length,1);assert.equal(secrets.size,1);assert.equal(JSON.stringify(state).includes(apiKey),false);assert.equal(remote.calls.length,2);
    const saved=JSON.parse(secrets.get('account:'+account.id)!);assert.equal(saved.apiKey,apiKey);assert.equal(saved.publicationId,publication.id);assert.equal(saved.ownerUserId,publication.ownerUserId);
  }finally{store.close()}
});

test('a failed state commit restores the previous secret and never leaves a new orphan secret',async()=>{
  const existing=fixture(),firstTransport=transport();
  try{
    const account=await connectParagraph(existing.store,existing.vault,apiKey,[existing.store.read().sites[0].id],undefined,{fetch:firstTransport.fetch});
    const beforeSecret=existing.secrets.get('account:'+account.id)!;
    const replacementKey='synthetic-paragraph-replacement-key',failingStore={read:()=>existing.store.read(),update:()=>{throw Error('synthetic state commit failure')}};
    await assert.rejects(connectParagraph(failingStore,existing.vault,replacementKey,[existing.store.read().sites[0].id],account.id,{fetch:transport().fetch}),/synthetic state commit failure/);
    assert.equal(existing.secrets.get('account:'+account.id),beforeSecret);assert.equal(existing.store.read().accounts[0].username,publication.id);
  }finally{existing.store.close()}

  const fresh=fixture();try{
    const failingStore={read:()=>fresh.store.read(),update:()=>{throw Error('synthetic state commit failure')}};
    await assert.rejects(connectParagraph(failingStore,fresh.vault,apiKey,[fresh.store.read().sites[0].id],undefined,{fetch:transport().fetch}),/synthetic state commit failure/);
    assert.equal(fresh.secrets.size,0);assert.equal(fresh.store.read().accounts.length,0);
  }finally{fresh.store.close()}
});

test('an API key for another publication cannot overwrite an existing identity or its bindings',async()=>{
  const {store,secrets,vault}=fixture();try{
    const first=await connectParagraph(store,vault,apiKey,[store.read().sites[0].id],undefined,{fetch:transport().fetch}),before=store.read(),secret=secrets.get('account:'+first.id);
    const other={id:'OtherPublication0001',name:'Other Publication',ownerUserId:'OtherOwner000000001',slug:'other-publication'};
    await assert.rejects(connectParagraph(store,vault,'synthetic-other-paragraph-key',[store.read().sites[1].id],first.id,{fetch:transport(other).fetch}),/another publication|another|different|\u53e6一出版物/);
    assert.deepEqual(store.read(),before);assert.equal(secrets.get('account:'+first.id),secret);
  }finally{store.close()}
});

test('encrypted backup roundtrips Paragraph and Nostr receipts with empty-email API identities',()=>{
  const state=emptyState(),value=site('11111111-1111-4111-8111-111111111111','one.example.com');value.paragraph={publicationId:publication.id,url:publicationUrl};state.sites=[value];
  const paragraphAccount='33333333-3333-4333-8333-333333333333',nostrAccount='44444444-4444-4444-8444-444444444444',pubkey='a'.repeat(64);
  state.accounts=[
    {id:paragraphAccount,channelId:'paragraph',email:'',username:publication.id,displayName:publication.name,publicationUrl,createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token'},
    {id:nostrAccount,channelId:'nostr',email:'',username:pubkey,createdAt:stamp,status:'registered',hasPassword:true,credentialKind:'api_token',source:'generated'},
  ];
  state.accountBindings=[
    {id:'55555555-5555-4555-8555-555555555555',siteId:value.id,channelId:'paragraph',accountId:paragraphAccount,createdAt:stamp,updatedAt:stamp},
    {id:'66666666-6666-4666-8666-666666666666',siteId:value.id,channelId:'nostr',accountId:nostrAccount,createdAt:stamp,updatedAt:stamp},
  ];
  const base={siteId:value.id,status:'needs_input' as const,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'uncertain',submittedAt:stamp};
  state.tasks=[
    {id:'77777777-7777-4777-8777-777777777777',...base,channelId:'paragraph',accountId:paragraphAccount,sourceDomain:'paragraph.com',paragraph:{publicationId:publication.id,slug:'fixture-post',contentHash:'c'.repeat(64),stage:'draft',postId:'PostFixture000000001'}},
    {id:'88888888-8888-4888-8888-888888888888',...base,channelId:'nostr',accountId:nostrAccount,sourceDomain:'njump.me',nostr:{pubkey,eventId:'b'.repeat(64),identifier:'fixture-article',contentHash:'d'.repeat(64),createdAt:1,stage:'submitting'}},
  ] satisfies Task[];
  const data={state,secrets:{['account:'+paragraphAccount]:'synthetic-paragraph-vault-record',['account:'+nostrAccount]:'synthetic-nostr-vault-record'}},passphrase='paragraph-nostr-roundtrip-2026';
  const restored=validateBackup(decryptBackup(encryptBackup(data,passphrase),passphrase));
  assert.equal(restored.state.mailboxes.length,0);assert.deepEqual(restored.state.accounts.map(account=>account.email),['','']);assert.deepEqual(restored.state.sites[0].paragraph,value.paragraph);assert.deepEqual(restored.state.tasks.map(task=>[task.paragraph,task.nostr]),state.tasks.map(task=>[task.paragraph,task.nostr]));

  const wrongParagraph=structuredClone(data);wrongParagraph.state.tasks[0].paragraph!.publicationId='WrongPublication0001';assert.throws(()=>validateBackup(wrongParagraph),/Paragraph.*\u8eab份|Paragraph/);
  const wrongNostr=structuredClone(data);wrongNostr.state.tasks[1].nostr!.pubkey='e'.repeat(64);assert.throws(()=>validateBackup(wrongNostr),/Nostr.*\u8eab份|Nostr/);
});
