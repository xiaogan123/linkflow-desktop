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
  assert.equal(rows.length,CHANNELS.filter(channel=>channel.automation==='api'||channel.id==='slugpost'||channel.id==='markest'||channel.id==='deno').length);
  assert.equal(row(data,'swarmmemo').state,'no_setup');
  assert.equal(row(data,'tantive').state,'no_setup');
  assert.match(row(data,'tantive').detail,/无需账号.*预览全文.*不会重发/);
  assert.equal(row(data,'thethings').state,'no_setup');
  assert.match(row(data,'thethings').detail,/无需账号.*公开可见.*不能修改.*不会重发/);
  assert.match(row(data,'swarmmemo').detail,/无需邮箱.*自动建好.*不会重发/);
  assert.equal(row(data,'shippage').state,'no_setup');
  assert.match(row(data,'shippage').detail,/自动注册一个平台账号.*所有网站共用.*14 天到期.*不自动续期/);
  assert.equal(row(data,'agentdrop').state,'unavailable');
  assert.match(row(data,'agentdrop').detail,/目前停用/);
  assert.equal(row(data,'mdview').state,'unavailable');
  assert.match(row(data,'mdview').detail,/不收录、不传权重.*30 天到期.*目前停用.*原稿和发布记录保留/);
  assert.equal(row(data,'txtsbs').state,'no_setup');
  assert.match(row(data,'txtsbs').detail,/无需账号.*官方表单.*不保证长期保留/);
  assert.equal(row(data,'pastyx').state,'no_setup');
  assert.match(row(data,'pastyx').detail,/无需账号或邮箱.*检查公开全文和链接.*不会重发/);
  assert.equal(row(data,'shiply').state,'first_connection');
  assert.match(row(data,'shiply').detail,/邮箱.*验证码.*一直沿用这个账号/);
  assert.equal(row(data,'synthfolk').state,'no_setup');
  assert.match(row(data,'synthfolk').detail,/如实的公开资料.*AI 复核后注册一次/);
  assert.equal(row(data,'slugpost').state,'no_setup');
  assert.match(row(data,'slugpost').detail,/无需账号.*官方网页.*人工验证.*不保证长期保留/);
  assert.equal(row(data,'nextgen-slides').state,'no_setup');
  assert.match(row(data,'nextgen-slides').detail,/90 天没人访问.*不会重发/);
  assert.equal(row(data,'yourwebs').state,'no_setup');
  assert.match(row(data,'yourwebs').detail,/30 天.*不会重发/);
  assert.equal(row(data,'notebin').state,'unavailable');
  assert.match(row(data,'notebin').detail,/目前停用/);
  assert.equal(row(data,'vibedrop').state,'no_setup');
  assert.match(row(data,'vibedrop').detail,/无需邮箱.*自动建好匿名发布账号.*不会重发/);
  assert.equal(row(data,'plopino').state,'no_setup');
  assert.match(row(data,'plopino').detail,/邮箱和密码.*自动建立一次.*不会重复注册/);
  assert.equal(row(data,'product-index').state,'first_connection');
  assert.match(row(data,'product-index').detail,/已有的 GitHub 账号.*不会替你注册 GitHub.*平台审核通过/);
  assert.equal(row(data,'large-language').state,'no_setup');
  assert.match(row(data,'large-language').detail,/资料库记录不是平台推荐/);
  assert.deepEqual(rows.filter(item=>item.state==='no_setup').map(item=>item.id),['yeetmd','markdownpage','rant','chatclaw','hart','agentsgather','agentboard','swarmmemo','tantive','thethings','agentnotepad','listed-startups','openagentchat','shellbook','agentriot','synthfolk','agenthow','large-language','agentswiki','slugpost','vibedrop','wordcell','carcinus','plopino','mataroa','verbose','lucid-page','betterthanhtml','html-app','deed-page','brewpage','katbin','nextgen-slides','yourwebs','totpage','txtsbs','pastyx','mdshare','shippage','pstrs','pastemyst','markdownpaste','markdrop','draftmark','memorywiki','supanote','docs-md','nostr','telegraph']);
  assert.equal(row(data,'slopit').state,'unavailable');
  assert.match(row(data,'slopit').detail,/目前停用/);
  assert.equal(row(data,'rentry').state,'unavailable');
  assert.match(row(data,'rentry').detail,/目前停用/);
  assert.equal(row(data,'yeetmd').state,'no_setup');
  assert.equal(row(data,'markdownpage').state,'no_setup');
  assert.equal(row(data,'rant').state,'no_setup');
  assert.equal(row(data,'hackmd').state,'first_connection');
  assert.equal(row(data,'whitewind').state,'unavailable');
  assert.match(row(data,'whitewind').detail,/未经批准.*商业.*金融推广保持停用/);
  assert.equal(row(data,'supanote').state,'no_setup');
  assert.equal(row(data,'docs-md').state,'no_setup');
  assert.equal(row(data,'docs-md').connectedCount,0);
  assert.match(row(data,'docs-md').detail,/无需注册.*匿名发布全文/);
  assert.equal(row(data,'brewpage').state,'no_setup');
  assert.match(row(data,'brewpage').detail,/无需注册.*最长保留 30 天.*所有者令牌.*不会重发/);
  assert.equal(row(data,'pastemyst').state,'no_setup');
  assert.match(row(data,'pastemyst').detail,/结果不明时不会重发/);
  assert.equal(row(data,'markdownpaste').state,'no_setup');
  assert.match(row(data,'markdownpaste').detail,/按地址删除页面/);
  assert.match(row(data,'html-app').detail,/首次提交前.*条款并确认/);
  assert.doesNotMatch(row(data,'html-app').detail,/已展示/);
  assert.equal(row(data,'deed-page').state,'no_setup');
  assert.match(row(data,'deed-page').detail,/无需注册.*所有者令牌.*不保证长期保留/);
  assert.equal(row(data,'markdrop').state,'no_setup');
  assert.match(row(data,'markdrop').detail,/无需注册.*默认不过期.*不保证长期保留/);
  assert.equal(row(data,'draftmark').state,'no_setup');
  assert.match(row(data,'draftmark').detail,/无需注册.*公开全文.*不保证长期保留/);
  assert.equal(row(data,'wordpress-com').state,'first_connection');
  assert.match(row(data,'wordpress-com').detail,/浏览器授权.*公开博客/);
  assert.equal(row(data,'prose').state,'unavailable');
  assert.match(row(data,'prose').detail,/平台目前停用/);
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

test('Notebin does not present a generic registered row as a verified PoW identity',()=>{
  const data={...snapshot(),channels:CHANNELS.map(channel=>channel.id==='notebin'?{...channel,enabled:true}:channel),accounts:[account('notebin',{source:'generated',username:'pow-root',registrationAttempts:1})]};
  const notebin=row(data,'notebin');assert.equal(notebin.state,'attention');assert.equal(notebin.connectedCount,0);assert.match(notebin.detail,/本机发布账号需检查/);
});

test('Docs MD needs no account only when enabled and preserves historical checks when disabled',()=>{
  const data=snapshot();
  assert.equal(row(data,'docs-md').state,'no_setup');
  data.channels=data.channels.map(channel=>channel.id==='docs-md'?{...channel,enabled:true}:channel);
  assert.equal(row(data,'docs-md').state,'no_setup');
  assert.match(row(data,'docs-md').detail,/无需注册/);
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
  assert.match(paper.detail,/原发布账号/);
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

test('explicitly disabled WordPress.com stays unavailable even when an old OAuth blog and binding are preserved',()=>{
  const data={...snapshot(),channels:[{...CHANNELS.find(item=>item.id==='wordpress-com')!,enabled:false}]};
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
  assert.match(row(data,'mataroa').detail,/原发布账号/);
});

test('Leaflet waits for acceptance while preserving explicit identity and binding metadata',()=>{
  const leaflet=CHANNELS.find(item=>item.id==='leaflet');assert.ok(leaflet);
  const data={...snapshot(),channels:[{...leaflet,enabled:false}]};
  assert.equal(row(data,'leaflet').state,'unavailable');assert.equal(row(data,'leaflet').format,'全文');
  data.accounts=[account('leaflet',{username:'author.bsky.social',publicationUrl:'https://leaflet.pub/p/did:plc:abcdefghijklmnopqrstuvwx'})];
  data.accountBindings=[{id:'leaflet-binding',channelId:'leaflet',accountId:'leaflet-identity',siteId:'site-1',createdAt:at,updatedAt:at}];
  assert.equal(row(data,'leaflet').state,'unavailable');assert.equal(row(data,'leaflet').connectedCount,1);assert.equal(row(data,'leaflet').checkedCount,0);
  data.channels=[{...leaflet,enabled:true}];assert.equal(row(data,'leaflet').state,'connected');
});


test('connection overview covers APIs plus the read-only Markest connection',()=>{
  const data=snapshot(),rows=connectionOverview(data);
  assert.deepEqual(rows.map(item=>item.id).sort(),CHANNELS.filter(channel=>channel.automation==='api'||channel.id==='slugpost'||channel.id==='markest'||channel.id==='deno').map(channel=>channel.id).sort());
  assert.equal(row(data,'betterthanhtml').state,'no_setup');
  assert.match(row(data,'betterthanhtml').detail,/无需注册账号/);
  data.tasks=[task('betterthanhtml',{firstLiveAt:at,linkCheck:'found'})];
  assert.equal(row(data,'betterthanhtml').checkedCount,1);
  assert.equal(row(data,'betterthanhtml').connectedCount,0);
});

test('every disabled API stays unavailable without erasing connection or historical result counts',()=>{
  for(const channel of CHANNELS.filter(item=>item.automation==='api')){
    const data=snapshot();data.channels=CHANNELS.map(item=>({...item,enabled:item.id===channel.id?false:item.enabled}));
    data.accounts=[account(channel.id,channel.id==='beacon'?{email:'owner@example.test',verifiedAt:at,beacon:{version:1,stage:'ready',emailHash:'a'.repeat(64),apiKeyFingerprint:'b'.repeat(64),checkedAt:at}}:channel.id==='product-index'?{username:'author',productIndex:{version:1,login:'author',tokenFingerprint:'a'.repeat(64),checkedAt:at,identity:'github_user_readback'}}:channel.id==='raindrop'?{source:'imported',username:'41',publicationUrl:'https://reading.raindrop.page/resources',raindrop:{version:1,ownerId:'41',collectionId:'73',publicUrl:'https://reading.raindrop.page/resources',tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:at}}:channel.id==='here-now'?{source:'imported',username:'55555555-5555-4555-8555-555555555555',hereNow:{version:1,checkedAt:at,accountId:'55555555-5555-4555-8555-555555555555',keyFingerprint:'a'.repeat(64),identity:'verified_personal'}}:channel.id==='shiply'?{email:'owner@example.test',username:'owner@example.test',source:'generated',shiply:{version:1,emailHash:'a'.repeat(64),requestedAt:at,stage:'ready',keyFingerprint:'b'.repeat(64)}}:{})];data.tasks=[task(channel.id,{firstLiveAt:at})];
    const found=row(data,channel.id);
    assert.equal(found.state,'unavailable',channel.id);
    assert.equal(found.checkedCount,1,channel.id);
    if(!['chatclaw','feddit','hart','yeetmd','markdownpage','agentsgather','listed-startups','wordpress-com','blogger','docs-md','katbin','pstrs','yourwebs','nextgen-slides','pastemyst','markdownpaste','html-app','totpage','mdview','txtsbs','pastyx','memorywiki','mdshare','agentdrop','shippage','notebin','colony','openagentchat','agentnotepad','agenthow','agentswiki','berrry','large-language','thethings','swarmmemo','agentboard','synthfolk','agentriot','shellbook','carcinus','gitbook','valtown','bitbucket'].includes(channel.id))assert.equal(found.connectedCount,1,channel.id);
    else if(['chatclaw','feddit','hart','yeetmd','markdownpage','agentsgather','listed-startups','docs-md','katbin','pstrs','yourwebs','nextgen-slides','pastemyst','markdownpaste','html-app','totpage','mdview','txtsbs','pastyx','memorywiki','mdshare','agentdrop','shippage','notebin','colony','openagentchat','agentnotepad','agenthow','agentswiki','berrry','large-language','thethings','swarmmemo','agentboard','synthfolk','agentriot','shellbook','carcinus','gitbook','valtown','bitbucket'].includes(channel.id))assert.equal(found.connectedCount,0,channel.id);
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
    assert.equal(channelExecutionReadiness(state,'site-2',channel).kind,id==='rentry'?'ready':'handoff_required');assert.equal(display().state,'no_setup');
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
  assert.match(display().detail,/发布账号.*关联/);assert.equal(display().connectedCount,2);assert.equal(display().boundSiteCount,0);
  bindAccount(state,'second','site-1',channel,new Date(at));
  assert.equal(channelExecutionReadiness(state,'site-1',channel).kind,'ready');assert.equal(display().state,'no_setup');
  unbindAccount(state,'second','site-1','mataroa');
  assert.equal(channelExecutionReadiness(state,'site-1',channel).kind,'ready');assert.equal(display().state,'no_setup');
});

test('Plopino automatic preparation does not bypass an existing unbound or uncertain identity',()=>{
 const data=snapshot();data.accounts=[account('plopino')];
 assert.equal(row(data,'plopino').state,'attention');
 data.accountBindings=[{id:'plopino-binding',siteId:'site-1',channelId:'plopino',accountId:data.accounts[0].id,createdAt:at,updatedAt:at}];
 assert.equal(row(data,'plopino').state,'connected');assert.equal(row(data,'plopino').boundSiteCount,1);
 data.accounts[0].status='unknown';assert.equal(row(data,'plopino').state,'attention');
});


test('Listed Startups is an accountless product listing with separate public acceptance',()=>{
  const data=snapshot();
  assert.equal(row(data,'listed-startups').format,'产品资料');
  assert.equal(row(data,'listed-startups').state,'no_setup');
  data.accounts=[account('listed-startups',{status:'needs_verification'})];
  const found=row(data,'listed-startups');
  assert.equal(found.state,'no_setup');
  assert.equal(found.connectedCount,0);
  assert.equal(found.checkedCount,0);
  assert.match(found.detail,/无需账号或邮箱.*不会重复提交/);
});

test('task-managed publishers are visible without inventing separate connected accounts',()=>{
  const data=snapshot();
  for(const id of ['chatclaw','feddit','hart']){
    if(id==='feddit')data.channels=data.channels.map(channel=>channel.id===id?{...channel,enabled:true}:channel);
    data.accounts=[account(id)];
    data.accountBindings=[{id:'stale',channelId:id,accountId:`${id}-identity`,siteId:'site-1',createdAt:at,updatedAt:at}];
    const current=row(data,id);
    assert.equal(current.state,'no_setup',id);assert.equal(current.connectedCount,0,id);assert.equal(current.boundSiteCount,0,id);
    assert.match(current.detail,/无需邮箱/);assert.match(current.detail,/不会重发|只读对账/);
    data.channels=data.channels.map(channel=>channel.id===id?{...channel,enabled:false}:channel);
    assert.equal(row(data,id).state,'unavailable',id);
  }
});

test('retired identities and unbound accounts a task will pick up on its own are not shown as work for the user',()=>{
  const data=snapshot();
  data.accounts=[account('agenthow',{retiredAt:at})];
  assert.equal(row(data,'agenthow').state,'no_setup');assert.equal(row(data,'agenthow').connectedCount,0);
  data.accounts=[account('wordcell')];
  assert.equal(row(data,'wordcell').state,'no_setup');assert.match(row(data,'wordcell').detail,/自动关联/);
  // Plopino still hands an unbound saved identity to a person.
  data.accounts=[account('plopino')];assert.equal(row(data,'plopino').state,'attention');
});
