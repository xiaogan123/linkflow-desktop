import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import {validateBackup} from '../src/main/backup-validation';
import {unbindAccount} from '../src/main/account-bindings';
import {host0ReservedSlug} from '../src/integrations/host0';
import {emptyState,Store} from '../src/main/store';
import type {Account,Site,Task} from '../src/shared/types';

const SITE='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ACCOUNT='33333333-3333-4333-8333-333333333333',TASK='44444444-4444-4444-8444-444444444444';
const at='2026-10-30T00:00:00.000Z',PASS='synthetic-backup-passphrase',KEY='synthetic_key_0123456789abcdef',EMAIL='owner@example.org';
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const site=(id:string,index:number):Site=>({id,domain:`sample${index}.example.com`,url:`https://sample${index}.example.com/`,email:EMAIL,name:'Example software',description:'Original documentation',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:at});
const RENDER_SOURCE={version:1 as const,repository:'https://github.com/example-owner/example-docs',repositoryId:101,githubLogin:'example-owner',githubUserId:202,baseBranch:'main'};
/** The stored proof each channel's restore check requires. No value here is a real credential. */
const CONNECTED:Record<string,{account:Partial<Account>;secret:string;owned:boolean}>={
  publishmarkdown:{account:{username:`publishmarkdown-key:${sha(KEY)}`,publicationUrl:'https://publishmarkdown.com/'},secret:JSON.stringify({version:1,apiKey:KEY}),owned:true},
  mdpage:{account:{username:'user-example-1',publicationUrl:'https://example-writer.md.page/'},secret:JSON.stringify({version:1,apiKey:`mdp_${KEY}`,userId:'user-example-1',username:'example-writer'}),owned:true},
  opendocs:{account:{username:'user-example-1',publicationUrl:'https://opendocs.cc/example-workspace',opendocs:{workspaceId:'workspace-example',workspaceSlug:'example-workspace',username:'example-writer'}},secret:JSON.stringify({version:1,apiKey:`od_live_${KEY}`,userId:'user-example-1',workspaceId:'workspace-example',workspaceSlug:'example-workspace',username:'example-writer'}),owned:true},
  render:{account:{username:'tea-exampleowner1',email:EMAIL,publicationUrl:'https://dashboard.render.com/',renderSource:RENDER_SOURCE},secret:JSON.stringify({version:1,apiKey:`rnd_${KEY}`,ownerId:'tea-exampleowner1',email:EMAIL,githubToken:`ghp_${KEY}`,source:RENDER_SOURCE}),owned:true},
  dropdeploy:{account:{username:`dropdeploy-key:${sha(KEY)}`,publicationUrl:'https://app.ddploy.com/'},secret:JSON.stringify({version:1,apiKey:KEY}),owned:true},
  'marked-share':{account:{username:`marked-share:${sha(KEY).slice(0,24)}`,email:EMAIL,publicationUrl:'https://share.markedapp.com/'},secret:JSON.stringify({version:1,apiToken:KEY,deviceKey:KEY,email:EMAIL}),owned:true},
  onepush:{account:{username:`onepush-key:${sha(`sk_${KEY}`)}`,publicationUrl:'https://www.onepu.sh/'},secret:JSON.stringify({version:1,apiKey:`sk_${KEY}`}),owned:true},
  dataecho:{account:{username:'example_owner',email:EMAIL,publicationUrl:'https://dataecho.ai/'},secret:JSON.stringify({version:1,email:EMAIL,username:'example_owner',apiKey:KEY}),owned:true},
  host0:{account:{username:EMAIL,email:EMAIL,publicationUrl:'https://host0.ai/'},secret:JSON.stringify({version:1,email:EMAIL,apiKey:KEY}),owned:true},
  agentel:{account:{username:'example-agent',publicationUrl:'https://agentel.tech/'},secret:JSON.stringify({version:1,agentId:'agent_example-1',slug:'example-agent',apiKey:KEY}),owned:true},
  netlify:{account:{username:'user-example-1',publicationUrl:'https://app.netlify.com/'},secret:JSON.stringify({version:1,accessToken:KEY,userId:'user-example-1'}),owned:false},
  leafmill:{account:{username:EMAIL,email:EMAIL,publicationUrl:'https://leafmill.net/'},secret:JSON.stringify({version:1,email:EMAIL,apiKey:KEY}),owned:false},
  mastodon:{account:{username:'example_author',publicationUrl:'https://mastodon.social/@example_author'},secret:KEY,owned:false},
  shipstatic:{account:{username:EMAIL,email:EMAIL,publicationUrl:'https://example-docs.shipstatic.com/'},secret:JSON.stringify({version:1,apiKey:KEY,email:EMAIL,domain:'example-docs.shipstatic.com'}),owned:false},
  clawprint:{account:{username:'ExampleAgent',publicationUrl:'https://clawprint.org/u/ExampleAgent'},secret:KEY,owned:false},
};
function connected(channelId:string){
  const row=CONNECTED[channelId],store=new Store(':memory:');
  const account:Account={id:ACCOUNT,channelId,email:'',username:'',ownerSiteId:SITE,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',...row.account};
  store.update(state=>{state.settings.autoRun=false;state.sites=[site(SITE,0),site(OTHER,1)];state.accounts=[account];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:SITE,channelId,accountId:ACCOUNT,createdAt:at,updatedAt:at}]});
  return {store,secrets:{[`account:${ACCOUNT}`]:row.secret},owned:row.owned};
}
const roundTrip=(input:unknown)=>validateBackup(decryptBackup(encryptBackup(input,PASS),PASS));

for(const channelId of Object.keys(CONNECTED))test(`${channelId} survives connect, disconnect and restore with its identity and key`,()=>{
  const f=connected(channelId);try{
    assert.doesNotThrow(()=>roundTrip({state:f.store.read(),secrets:f.secrets}));
    f.store.update(state=>unbindAccount(state,ACCOUNT,SITE,channelId));
    assert.equal(f.store.read().accountBindings.length,0);
    const restored=roundTrip({state:f.store.read(),secrets:f.secrets}),account=restored.state.accounts[0];
    assert.equal(account.username,CONNECTED[channelId].account.username);assert.equal(account.ownerSiteId,SITE);assert.equal(account.hasPassword,true);assert.equal(restored.secrets[`account:${ACCOUNT}`],f.secrets[`account:${ACCOUNT}`]);
    const imported=new Store(':memory:');try{imported.restore(restored.state,{});assert.equal(imported.read().accounts[0].retiredAt,undefined);assert.equal(imported.read().accountBindings.length,0)}finally{imported.close()}
  }finally{f.store.close()}
});

for(const channelId of Object.keys(CONNECTED).filter(id=>CONNECTED[id].owned))test(`${channelId} restore still rejects a binding to the wrong site and an unowned disconnected account`,()=>{
  const f=connected(channelId);try{
    const wrong=structuredClone(f.store.read());wrong.accountBindings[0].siteId=OTHER;
    assert.throws(()=>validateBackup({state:wrong,secrets:f.secrets}));
    const two=structuredClone(f.store.read());two.accountBindings.push({...two.accountBindings[0],id:'66666666-6666-4666-8666-666666666666',siteId:OTHER});
    assert.throws(()=>validateBackup({state:two,secrets:f.secrets}));
    f.store.update(state=>unbindAccount(state,ACCOUNT,SITE,channelId));
    const unowned=structuredClone(f.store.read());delete unowned.accounts[0].ownerSiteId;
    assert.throws(()=>validateBackup({state:unowned,secrets:f.secrets}));
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{}}));
  }finally{f.store.close()}
});

test('a Cloudflare Pages project cannot be disconnected, so its restore keeps the single binding',()=>{
  const projectId='12345678-1234-1234-1234-123456789abc',proof={version:1 as const,accountId:'a'.repeat(32),projectId,projectName:'software-guide-pages',tokenId:'b'.repeat(32),productionBranch:'main'};
  const store=new Store(':memory:');try{
    const account:Account={id:ACCOUNT,channelId:'cloudflare-pages',email:'',username:proof.accountId,ownerSiteId:SITE,publicationUrl:`https://${proof.projectName}.pages.dev/`,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',cloudflarePages:proof};
    const secret=JSON.stringify({apiToken:KEY,...proof}),key=`account:${ACCOUNT}`;
    store.updateWithCiphers(state=>{state.sites=[site(SITE,0),site(OTHER,1)];state.accounts=[account];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:SITE,channelId:'cloudflare-pages',accountId:ACCOUNT,createdAt:at,updatedAt:at}]},{[key]:`cipher:${secret}`});
    assert.doesNotThrow(()=>validateBackup({state:store.read(),secrets:{[key]:secret}}));
    assert.throws(()=>store.update(state=>unbindAccount(state,ACCOUNT,SITE,'cloudflare-pages')),/Cloudflare Pages/);
    const unbound=structuredClone(store.read());unbound.accountBindings=[];
    assert.throws(()=>validateBackup({state:unbound,secrets:{[key]:secret}}),/Cloudflare Pages/);
  }finally{store.close()}
});

function publicationState(channelId:string,account:Partial<Account>,summary:NonNullable<Task['batch5']>){
  const state=emptyState();
  const fullAccount:Account={id:ACCOUNT,channelId,email:'',username:'',ownerSiteId:SITE,createdAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',...account};
  const task:Task={id:TASK,siteId:SITE,channelId,accountId:ACCOUNT,sourceDomain:`${channelId}.example`,status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:1,message:'test',submittedAt:at,batch5:summary};
  state.settings.autoRun=false;state.sites=[site(SITE,0)];state.accounts=[fullAccount];state.tasks=[task];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:SITE,channelId,accountId:ACCOUNT,createdAt:at,updatedAt:at}];
  return {read:()=>state,close(){}};
}
const hash64=(label:string)=>sha(label);
const response=(url:string,status:number,size:number)=>({status,url,contentType:'application/json',robotsHeader:'',body:JSON.stringify({padding:'x'.repeat(size)})});
function host0Backup(size:number,steps?:Record<string,unknown>){
  const intent={version:1,taskId:TASK,siteId:SITE,accountId:ACCOUNT,slug:host0ReservedSlug(TASK),name:'Example guide',email:EMAIL,sourceHash:hash64('source'),requestHash:hash64('request'),createdAt:at};
  const summary:NonNullable<Task['batch5']>={version:1,channelId:'host0',operationId:TASK,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:at,stage:'opaque_response',accountId:ACCOUNT};
  const store=publicationState('host0',CONNECTED.host0.account,summary);
  return {store,secrets:{[`account:${ACCOUNT}`]:CONNECTED.host0.secret,[`publication:${TASK}`]:JSON.stringify({intent,steps:steps??{create_app:{stage:'response',response:response('https://host0.ai/api/v1/apps',201,size)}}})}};
}
function dataEchoBackup(size:number){
  const intent={version:1,taskId:TASK,siteId:SITE,accountId:ACCOUNT,name:'Example guide',username:'example_owner',email:EMAIL,sourceHash:hash64('source'),requestHash:hash64('request'),createdAt:at};
  const summary:NonNullable<Task['batch5']>={version:1,channelId:'dataecho',operationId:TASK,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:at,stage:'opaque_response',accountId:ACCOUNT};
  const store=publicationState('dataecho',CONNECTED.dataecho.account,summary);
  return {store,secrets:{[`account:${ACCOUNT}`]:CONNECTED.dataecho.secret,[`publication:${TASK}`]:JSON.stringify({intent,steps:{create:{stage:'response',response:response('https://dataecho.ai/api/v1/publish',201,size)}}})}};
}
function agentelBackup(size:number){
  const payload={title:'A software note',content:'See https://sample0.example.com/guide for the reproduced steps.',targetUrl:'https://sample0.example.com/guide',siteUrl:'https://sample0.example.com/'};
  const requestHash=sha(JSON.stringify(payload)),operationId='77777777-7777-4777-8777-777777777777',agentId='agent_example-1';
  const journal={version:1,stage:'opaque',intent:{version:1,kind:'publish',operationId,siteId:SITE,taskId:TASK,requestHash,createdAt:at,payload,agentId},opaque:{status:500,url:`https://agentel.tech/api/v1/agents/${agentId}/updates`,contentType:'application/json',bodyBase64:Buffer.from(JSON.stringify({padding:'x'.repeat(size)})).toString('base64')}};
  const summary:NonNullable<Task['batch5']>={version:1,channelId:'agentel',operationId,sourceHash:sha(payload.content),requestHash,createdAt:at,stage:'opaque_response',accountId:ACCOUNT};
  const store=publicationState('agentel',CONNECTED.agentel.account,summary);
  return {store,secrets:{[`account:${ACCOUNT}`]:CONNECTED.agentel.secret,[`publication:${TASK}`]:JSON.stringify(journal)}};
}
const LARGE:Record<string,(size:number)=>{store:ReturnType<typeof publicationState>;secrets:Record<string,string>}>={host0:host0Backup,dataecho:dataEchoBackup,agentel:agentelBackup};

for(const [channelId,build] of Object.entries(LARGE))test(`${channelId} oversized saved response round-trips, and a mismatched journal stays rejected`,()=>{
  const small=build(20);try{assert.doesNotThrow(()=>roundTrip({state:small.store.read(),secrets:small.secrets}))}finally{small.store.close()}
  const f=build(17_000);try{
    const key=`publication:${TASK}`;assert.ok(f.secrets[key].length>16_384);
    const restored=roundTrip({state:f.store.read(),secrets:f.secrets});assert.equal(restored.secrets[key],f.secrets[key]);
    const wrongSummary=structuredClone(f.store.read());wrongSummary.tasks[0].batch5!.requestHash=hash64('other');
    assert.throws(()=>validateBackup({state:wrongSummary,secrets:f.secrets}));
    const noReceipt=structuredClone(f.store.read());delete noReceipt.tasks[0].batch5;
    assert.throws(()=>validateBackup({state:noReceipt,secrets:f.secrets}),/超过允许长度/);
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{...f.secrets,[key]:`{"padding":"${'x'.repeat(17_000)}"}`}}));
    assert.throws(()=>validateBackup({state:f.store.read(),secrets:{...f.secrets,[`account:${ACCOUNT}`]:'x'.repeat(17_000)}}));
  }finally{f.store.close()}
});

test('a host0 journal holding six largest-allowed step responses restores whole',()=>{
  const urls={create_app:'apps',create_deployment:'apps/app_1/deployments',upload_index:'deployments/d_1/files/index.html',upload_robots:'deployments/d_1/files/robots.txt',finalize:'deployments/d_1/finalize',publicize:'apps/app_1'};
  const steps=Object.fromEntries(Object.entries(urls).map(([step,path])=>[step,{stage:'response',response:response(`https://host0.ai/api/v1/${path}`,200,127_900)}]));
  const f=host0Backup(0,steps);try{
    const key=`publication:${TASK}`;assert.ok(f.secrets[key].length>700_000);
    assert.equal(roundTrip({state:f.store.read(),secrets:f.secrets}).secrets[key],f.secrets[key]);
  }finally{f.store.close()}
});

test('a large unresolved Agentel registration response restores without a saved key',()=>{
  const identity={name:'Software Research AI Assistant',slug:'software-research-ai-assistant',description:'AI assistant documenting practical software integration research.',category:'coding',installationId:'software-research-ai-assistant'};
  const journal={version:1,stage:'opaque',intent:{version:1,kind:'register',operationId:'77777777-7777-4777-8777-777777777777',siteId:SITE,requestHash:sha(JSON.stringify(identity)),createdAt:at,payload:identity},opaque:{status:500,url:'https://agentel.tech/api/v1/agents/register',contentType:'text/plain',bodyBase64:Buffer.from('x'.repeat(17_000)).toString('base64')}};
  const key=`agentel:identity:${SITE}`,store=new Store(':memory:');try{
    const account:Account={id:ACCOUNT,channelId:'agentel',email:'',username:identity.slug,ownerSiteId:SITE,publicationUrl:'https://agentel.tech/',createdAt:at,status:'unknown',hasPassword:false,source:'generated',credentialKind:'api_token',registrationAttempts:1};
    store.update(state=>{state.settings.autoRun=false;state.sites=[site(SITE,0)];state.accounts=[account];state.accountBindings=[{id:'55555555-5555-4555-8555-555555555555',siteId:SITE,channelId:'agentel',accountId:ACCOUNT,createdAt:at,updatedAt:at}]});
    const secrets={[key]:JSON.stringify(journal)};assert.ok(secrets[key].length>16_384);
    assert.equal(roundTrip({state:store.read(),secrets}).secrets[key],secrets[key]);
    assert.throws(()=>validateBackup({state:store.read(),secrets:{[key]:JSON.stringify({...journal,version:2})}}));
    const unbound=structuredClone(store.read());unbound.accountBindings=[];
    assert.throws(()=>validateBackup({state:unbound,secrets}),/Agentel/);
  }finally{store.close()}
});

test('portable export runs the restore check on the exact snapshot before anything is written',()=>{
  const source=readFileSync('src/main/main.ts','utf8'),start=source.indexOf("case 'backup:export':"),end=source.indexOf("case 'backup:import':",start),block=source.slice(start,end);
  const validated=block.indexOf('validateBackup(structuredClone(backupData))'),encrypted=block.indexOf('encryptBackup(backupData,passphrase)'),written=block.indexOf('await writeFile(path.filePath,buffer');
  assert.ok(start>0&&validated>0,'export must validate');assert.ok(validated<encrypted&&encrypted<written);
  assert.equal(block.includes('encryptBackup({state:store.read()'),false);
});
