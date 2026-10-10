import test from 'node:test';
import assert from 'node:assert/strict';
import type {Account,Snapshot,Task} from '../src/shared/types';
import {connectionOverview} from '../src/ui/channel-connections';
import {CHANNELS} from '../src/integrations/catalog';
import {bindAccount,channelExecutionReadiness,unbindAccount} from '../src/main/account-bindings';
import {emptyState} from '../src/main/store';

const at='2026-10-07T00:00:00.000Z';
function account(channelId:string,extra:Partial<Account>={}):Account{return {id:`${channelId}-identity`,channelId,email:'',username:'author',credentialKind:channelId==='blogger'?'oauth':'api_token',status:'registered',hasPassword:true,createdAt:at,...extra};}
function task(channelId:string,extra:Partial<Task>={}):Task{return {id:`${channelId}-task`,channelId,siteId:'site-1',sourceDomain:'example.test',status:'review',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'submitted',...extra};}
function snapshot():Pick<Snapshot,'accounts'|'accountBindings'|'sites'|'tasks'|'channels'>{return {channels:CHANNELS,accounts:[],accountBindings:[],sites:[{id:'site-1',domain:'example.test',url:'https://example.test/',email:'owner@example.test',name:'Example',description:'',category:'general',language:'en',monthlyTarget:1,status:'ready',createdAt:at}],tasks:[]};}
function row(data:ReturnType<typeof snapshot>,id:string){const found=connectionOverview(data).find(item=>item.id===id);assert.ok(found);return found;}

test('overview distinguishes self-provisioned APIs, first connections and Bluesky short posts',()=>{
  const data=snapshot(),rows=connectionOverview(data);
  assert.equal(rows.length,20);
  assert.deepEqual(rows.filter(item=>item.state==='no_setup').map(item=>item.id),['mataroa','verbose','lucid-page','betterthanhtml','supanote','nostr','telegraph']);
  assert.equal(row(data,'rentry').state,'unavailable');
  assert.match(row(data,'rentry').detail,/当前停用/);
  assert.equal(row(data,'supanote').state,'no_setup');
  assert.equal(row(data,'docs-md').state,'unavailable');
  assert.equal(row(data,'docs-md').connectedCount,0);
  assert.match(row(data,'docs-md').detail,/无需注册账号.*真实托管公开页验收/);
  assert.equal(row(data,'wordpress-com').state,'unavailable');
  assert.match(row(data,'wordpress-com').detail,/浏览器授权.*尚待验收/);
  assert.equal(row(data,'prose').state,'unavailable');
  assert.match(row(data,'prose').detail,/SSH\/SFTP.*邀请.*当前不会自动发布/);
  assert.equal(row(data,'paper-wf').state,'first_connection');
  assert.match(row(data,'paper-wf').detail,/人机验证/);
  assert.equal(row(data,'bluesky').format,'短帖');
});

test('Verbose only becomes self-provisioned when its experimental channel is actually enabled',()=>{
  const data={...snapshot(),channels:[{...CHANNELS.find(item=>item.id==='verbose')!,enabled:true}]};
  assert.equal(connectionOverview(data).find(item=>item.id==='verbose')?.state,'no_setup');
  data.accounts=[account('verbose',{status:'unknown',source:'generated',registrationAttempts:1,hasPassword:false})];
  const verbose=connectionOverview(data).find(item=>item.id==='verbose');
  assert.equal(verbose?.state,'attention');
  assert.match(verbose?.detail??'',/不能重新注册换号/);
});

test('Docs MD needs no account only when enabled and preserves historical checks when disabled',()=>{
  const data=snapshot();
  assert.equal(row(data,'docs-md').state,'unavailable');
  data.channels=data.channels.map(channel=>channel.id==='docs-md'?{...channel,enabled:true}:channel);
  assert.equal(row(data,'docs-md').state,'no_setup');
  assert.match(row(data,'docs-md').detail,/无需注册账号/);
  data.accounts=[account('docs-md',{status:'needs_verification'})];
  data.accountBindings=[{id:'legacy-binding',channelId:'docs-md',accountId:'docs-md-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  data.tasks=[task('docs-md',{firstLiveAt:at,linkCheck:'absent'})];
  assert.equal(row(data,'docs-md').state,'no_setup');
  assert.equal(row(data,'docs-md').connectedCount,0);
  assert.equal(row(data,'docs-md').boundSiteCount,0);
  assert.equal(row(data,'docs-md').checkedCount,1);
  data.channels=data.channels.map(channel=>channel.id==='docs-md'?{...channel,enabled:false}:channel);
  assert.equal(row(data,'docs-md').state,'unavailable');
  assert.equal(row(data,'docs-md').checkedCount,1);
});

test('a Paper verification challenge is attention, not a connected or published identity',()=>{
  const data=snapshot();data.accounts=[account('paper-wf',{source:'generated',status:'needs_verification'})];
  const paper=row(data,'paper-wf');
  assert.equal(paper.state,'attention');
  assert.equal(paper.connectedCount,0);
  assert.equal(paper.checkedCount,0);
  assert.equal(paper.attentionAccountId,'paper-wf-identity');
  assert.match(paper.detail,/原身份/);
});

test('Hive connection, website binding and verified public result remain separate',()=>{
  const data=snapshot();data.accounts=[account('hive')];
  assert.equal(row(data,'hive').state,'attention');
  data.accountBindings=[{id:'binding',channelId:'hive',accountId:'hive-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  assert.equal(row(data,'hive').state,'connected');
  assert.equal(row(data,'hive').checkedCount,0);
  data.tasks=[task('hive',{firstLiveAt:at,linkCheck:'absent'})];
  assert.equal(row(data,'hive').checkedCount,1);
});

test('Blogger and Paragraph need matching site publication binding',()=>{
  const data=snapshot();data.accounts=[account('blogger'),account('paragraph',{username:'publication-1'})];
  data.accountBindings=[
    {id:'blogger-binding',channelId:'blogger',accountId:'blogger-identity',siteId:'site-1',createdAt:at,updatedAt:at},
    {id:'paragraph-binding',channelId:'paragraph',accountId:'paragraph-identity',siteId:'site-1',createdAt:at,updatedAt:at},
  ];
  assert.equal(row(data,'blogger').state,'attention');
  assert.equal(row(data,'paragraph').state,'attention');
  data.sites[0].blogger={blogId:'blog-1',url:'https://blog.example.test/'};
  data.sites[0].paragraph={publicationId:'publication-1',url:'https://paragraph.example.test/'};
  assert.equal(row(data,'blogger').state,'connected');
  assert.equal(row(data,'paragraph').state,'connected');
});

test('disabled WordPress.com stays unavailable even when an old OAuth blog and binding are preserved',()=>{
  const data={...snapshot(),channels:[CHANNELS.find(item=>item.id==='wordpress-com')!]};
  data.accounts=[account('wordpress-com',{credentialKind:'oauth',username:'12345',publicationUrl:'https://example.wordpress.com/'})];
  data.accountBindings=[{id:'wordpress-binding',channelId:'wordpress-com',accountId:'wordpress-com-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  const wordpress=row(data,'wordpress-com');
  assert.equal(wordpress.state,'unavailable');
  assert.equal(wordpress.connectedCount,1);
  assert.equal(wordpress.boundSiteCount,1);
});

test('accepted WordPress.com uses an OAuth identity and ordinary account binding',()=>{
  const wordpress=CHANNELS.find(item=>item.id==='wordpress-com');assert.ok(wordpress);
  const data={...snapshot(),channels:[{...wordpress,enabled:true}]};
  assert.equal(row(data,'wordpress-com').state,'first_connection');
  data.accounts=[account('wordpress-com',{credentialKind:'api_token'})];
  assert.equal(row(data,'wordpress-com').state,'attention');
  data.accounts=[account('wordpress-com',{credentialKind:'oauth',username:'12345',publicationUrl:'https://example.wordpress.com/'})];
  assert.equal(row(data,'wordpress-com').state,'attention');
  data.accountBindings=[{id:'wordpress-binding',channelId:'wordpress-com',accountId:'wordpress-com-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  assert.equal(row(data,'wordpress-com').state,'connected');
});


test('Mataroa auto creation does not hide a real existing verification problem',()=>{
  const data=snapshot();
  assert.equal(row(data,'mataroa').state,'no_setup');
  data.accounts=[account('mataroa',{status:'needs_verification',source:'generated'})];
  assert.equal(row(data,'mataroa').state,'attention');
  assert.equal(row(data,'mataroa').checkedCount,0);
  assert.match(row(data,'mataroa').detail,/原身份/);
});

test('Leaflet waits for acceptance while preserving explicit identity and binding metadata',()=>{
  const leaflet=CHANNELS.find(item=>item.id==='leaflet');assert.ok(leaflet);
  const data={...snapshot(),channels:[leaflet]};
  assert.equal(row(data,'leaflet').state,'unavailable');assert.equal(row(data,'leaflet').format,'全文');
  data.accounts=[account('leaflet',{username:'author.bsky.social',publicationUrl:'https://leaflet.pub/p/did:plc:abcdefghijklmnopqrstuvwx'})];
  data.accountBindings=[{id:'leaflet-binding',channelId:'leaflet',accountId:'leaflet-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  assert.equal(row(data,'leaflet').state,'unavailable');assert.equal(row(data,'leaflet').connectedCount,1);assert.equal(row(data,'leaflet').checkedCount,0);
  data.channels=[{...leaflet,enabled:true}];assert.equal(row(data,'leaflet').state,'connected');
});


test('connection overview covers APIs plus the read-only Markest connection',()=>{
  const data=snapshot(),rows=connectionOverview(data);
  assert.deepEqual(rows.map(item=>item.id).sort(),CHANNELS.filter(channel=>channel.automation==='api'||channel.id==='markest'||channel.id==='deno').map(channel=>channel.id).sort());
  assert.equal(row(data,'betterthanhtml').state,'no_setup');
  assert.match(row(data,'betterthanhtml').detail,/无需注册账号/);
  data.tasks=[task('betterthanhtml',{firstLiveAt:at,linkCheck:'found'})];
  assert.equal(row(data,'betterthanhtml').checkedCount,1);
  assert.equal(row(data,'betterthanhtml').connectedCount,0);
});

test('every disabled API stays unavailable without erasing connection or historical result counts',()=>{
  for(const channel of CHANNELS.filter(item=>item.automation==='api')){
    const data=snapshot();data.channels=CHANNELS.map(item=>({...item,enabled:item.id===channel.id?false:item.enabled}));
    data.accounts=[account(channel.id)];data.tasks=[task(channel.id,{firstLiveAt:at})];
    const found=row(data,channel.id);
    assert.equal(found.state,'unavailable',channel.id);
    assert.equal(found.checkedCount,1,channel.id);
    if(!['wordpress-com','blogger','docs-md'].includes(channel.id))assert.equal(found.connectedCount,1,channel.id);
    else if(channel.id==='docs-md')assert.equal(found.connectedCount,0,channel.id);
  }
});

test('revoked automatic publisher bindings require reassociation without promising a new identity',()=>{
  for(const id of ['mataroa','verbose','rentry'] as const){
    const channel={...CHANNELS.find(item=>item.id===id)!,enabled:true},state=emptyState();
    state.sites=snapshot().sites;
    const identity=account(id,{source:'generated',email:'',username:id==='rentry'?'anonymous':'author',...(id==='rentry'?{}:{publicationUrl:id==='mataroa'?'https://author.mataroa.blog/':'https://verbose.blog/author'})});
    state.accounts=[identity];
    const display=()=>row({...state,channels:[channel]},id);
    bindAccount(state,identity.id,state.sites[0].id,channel,new Date(at));
    assert.equal(channelExecutionReadiness(state,state.sites[0].id,channel).kind,'ready');
    assert.equal(display().state,'no_setup');
    unbindAccount(state,identity.id,state.sites[0].id,id);
    const before=structuredClone(state),after=display();
    assert.equal(channelExecutionReadiness(state,state.sites[0].id,channel).kind,'handoff_required');
    assert.equal(after.state,'attention',id);assert.match(after.detail,/关联/);assert.doesNotMatch(after.detail,/自动建号/);
    assert.equal(after.attentionAccountId,identity.id);assert.equal(after.connectedCount,1);assert.equal(after.boundSiteCount,0);
    assert.deepEqual(state,before);
    state.sites.push({...state.sites[0],id:'site-2'});
    assert.equal(channelExecutionReadiness(state,'site-2',channel).kind,'ready');assert.equal(display().state,'no_setup');
    state.sites.pop();bindAccount(state,identity.id,state.sites[0].id,channel,new Date(at));
    assert.equal(display().state,'no_setup');assert.equal(display().boundSiteCount,1);
    assert.equal(row({...state,channels:[{...channel,enabled:false}]},id).state,'unavailable');
    state.sites=[];assert.equal(display().state,'no_setup');
  }
});

test('multiple valid automatic identities require choosing one until a current site can reuse it',()=>{
  const channel=CHANNELS.find(item=>item.id==='mataroa')!,state=emptyState();state.sites=snapshot().sites;
  state.accounts=['first','second'].map(username=>account('mataroa',{id:username,username,source:'imported',publicationUrl:`https://${username}.mataroa.blog/`}));
  const display=()=>row({...state,channels:[channel]},'mataroa');
  assert.equal(channelExecutionReadiness(state,'site-1',channel).kind,'handoff_required');assert.equal(display().state,'attention');
  assert.match(display().detail,/身份.*关联/);assert.equal(display().connectedCount,2);assert.equal(display().boundSiteCount,0);
  bindAccount(state,'second','site-1',channel,new Date(at));
  assert.equal(channelExecutionReadiness(state,'site-1',channel).kind,'ready');assert.equal(display().state,'no_setup');
  unbindAccount(state,'second','site-1','mataroa');
  assert.equal(channelExecutionReadiness(state,'site-1',channel).kind,'ready');assert.equal(display().state,'no_setup');
});
