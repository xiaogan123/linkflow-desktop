import assert from 'node:assert/strict';
import test from 'node:test';
import {containsReferralInformation,containsPublicationReferralInformation,publicationReferralFields} from '../src/shared/referral-policy';
import {publicIdentitySlug} from '../src/integrations/public-identity';
import {isArticleTopicUrl,isReferralTopicTitle} from '../src/shared/topic-policy';
import {readTopicEvidence,TopicDiscoveryError,type TopicTransport} from '../src/integrations/topics';
import type {Account,Task} from '../src/shared/types';

const site={name:'Example project',domain:'example.com',url:'https://example.com/',description:'Educational software tutorials'};
const task=(patch:Partial<Task>={}):Task=>({id:'11111111-1111-4111-8111-111111111111',siteId:'22222222-2222-4222-8222-222222222222',channelId:'telegraph',sourceDomain:'telegra.ph',status:'queued',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',scheduledAt:'2026-10-01T00:00:00.000Z',attempts:0,message:'',draft:{title:'Useful guide',description:'Guide summary',body:'A clean explanation.'},...patch});
const account=(patch:Partial<Account>={}):Account=>({id:'33333333-3333-4333-8333-333333333333',channelId:'telegraph',username:'example-assistant',displayName:'Example assistant',email:'',createdAt:'2026-10-01T00:00:00.000Z',status:'registered',hasPassword:true,...patch});

test('structured publication guard checks generated author/site names and account display names',()=>{
  assert.equal(containsPublicationReferralInformation(task(),site,account()),false);
  assert.equal(containsPublicationReferralInformation(task(),{...site,name:'Invite code: TEST1234'},account()),true);
  assert.equal(containsPublicationReferralInformation(task(),site,account({displayName:'Referral code: TEST1234'})),true);
  assert.equal(containsPublicationReferralInformation(task(),{...site,description:'Referral code: TEST1234'},account({username:'TEST1234'})),true);
  assert.equal(containsPublicationReferralInformation(task(),site,account({displayName:'We do not require a referral code.'})),false);
});

test('new identities derived from site names cannot publish recommendation information',()=>{
  const unsafeSite={...site,name:'Referral code TEST1234'};
  for(const [channelId,maxLength] of [['agenthow',40],['agentriot',40],['shellbook',30],['colony',32],['openagentchat',32],['berrry',24],['wordcell',40]] as const){
    const current=task({channelId});
    assert.equal(containsReferralInformation(publicIdentitySlug(unsafeSite,account().id,maxLength)),true,`${channelId} public identity carries the code`);
    assert.equal(containsPublicationReferralInformation(current,unsafeSite,undefined,{automation:'api'}),true,`${channelId} blocks before registration`);
    assert.equal(containsPublicationReferralInformation(current,site,undefined,{automation:'api'}),false,`${channelId} permits a neutral identity`);
  }
});

test('site-derived public slugs and filenames are checked even with an existing clean account',()=>{
  const unsafeSite={...site,name:'Referral code TEST1234'};
  for(const channelId of ['berrry','wordcell','shareyourhtml','prose','wordpress-com','verbose','rentry']){
    assert.equal(containsPublicationReferralInformation(task({channelId}),unsafeSite,account({channelId}),{automation:'api'}),true,channelId);
  }
  // Existing identity channels send the saved clean name instead of generating another from the current site.
  assert.equal(containsPublicationReferralInformation(task({channelId:'agenthow'}),unsafeSite,account({channelId:'agenthow'}),{automation:'api'}),false);
});

test('browser publication checks the actual site.title and site.description fields',()=>{
  const current=task({channelId:'custom-browser-channel'}),browser={automation:'browser' as const};
  for(const unsafeSite of [{...site,name:'Referral code TEST1234'},{...site,description:'Invite code: TEST1234'}]){
    assert.equal(containsPublicationReferralInformation(current,unsafeSite,undefined,browser),true);
    assert.equal(containsPublicationReferralInformation(current,unsafeSite,undefined,{automation:'api'}),false,'unpublished site metadata does not block an API request');
  }
  assert.equal(containsPublicationReferralInformation(current,site,undefined,browser),false);
});

test('AgentRiot structured publicLink is checked when none of its editable fields contains a URL',()=>{
  const current=task({channelId:'agentriot',topicUrl:'https://example.com/guides/check?inviteCode=TEST1234'});
  assert.equal(containsPublicationReferralInformation(current,site),true);
  assert.ok(publicationReferralFields(current,site).includes(current.topicUrl!));
});

test('Synthfolk and Agentboard public structured profiles cannot bypass the draft guard',()=>{
  const synthfolk=task({channelId:'synthfolk',synthfolkInput:{version:1,accountId:account().id,profile:{handle:'example-assistant',name:'Example assistant',headline:'Project guide',about:'Invite code: TEST1234',operator:'Human operator',website:'https://example.com/',availability:'closed',skills:['Documentation']},targetUrl:'https://example.com/',sourceHash:'a'.repeat(64),draftRevision:0,disclosure:{humanOperated:true,relationship:'human_operator',operator:'Human operator'}}});
  assert.equal(containsPublicationReferralInformation(synthfolk,site),true);
  const board=task({channelId:'agentboard',agentboardSubject:{version:1,mode:'introduction',board:'introductions',boardId:'brd_0000000000000001',agent:{name:'Example project',description:'Referral code: TEST1234',homepage:site.url,operatorName:'Site publishing assistant'}}});
  assert.equal(containsPublicationReferralInformation(board,site),true);
});

test('AgentHow structured source titles are included in the publication guard',()=>{
  const current=task({channelId:'agenthow',agentHowInput:{version:1,topic:'engineering',kind:'note',license:'CC-BY-4.0',sources:[{title:'Invite code: TEST1234',url:'https://example.com/guides/check'}],bodySha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),reviewReportSha256:'c'.repeat(64),reviewVerdict:'PASS'}});
  assert.equal(containsPublicationReferralInformation(current,site),true);
});

test('topic policy rejects traditional Chinese and pinyin registration titles and paths',()=>{
  for(const term of ['註冊','開戶','邀請','推薦碼','返傭碼','zhuce','kaihu','yaoqing','tuijianma','fanyongma']){
    assert.equal(isReferralTopicTitle(`${term} guide`),true,term);
    assert.equal(isArticleTopicUrl(`https://example.com/guides/${encodeURIComponent(term)}-guide`,site),false,term);
  }
  assert.equal(isReferralTopicTitle('Verification code and account security'),false);
  assert.equal(isArticleTopicUrl('https://example.com/guides/security',site),true);
});

test('fetched topic evidence rejects referral text in every title source despite neutral competing titles',async t=>{
  const topicUrl='https://example.com/guides/check',topicSite={...site,topics:[{url:topicUrl,discoveredAt:'2026-10-01T00:00:00.000Z'}]};
  const cases=[
    '<meta property="og:title" content="註冊指南"><title>Source checklist</title><h1>Source checklist</h1>',
    '<meta property="og:title" content="Source checklist"><title>開戶指南</title><h1>Source checklist</h1>',
    '<meta property="og:title" content="Source checklist"><title>Source checklist</title></head><body><main><h1>yaoqing guide</h1></main><head>',
    '<meta property="og:title" content="Source checklist"><title>Source checklist</title></head><body><main><h1>Source checklist</h1><h1>fanyongma guide</h1></main><head>',
  ];
  for(const [index,headings] of cases.entries())await t.test(String(index),async()=>{
    let reads=0;
    const transport:TopicTransport={fetch:async()=>{reads++;return {url:topicUrl,body:`<html><head>${headings}</head><body><main>${'Evidence-backed explanation. '.repeat(25)}</main></body></html>`,contentType:'text/html'}}};
    await assert.rejects(readTopicEvidence(topicSite,topicUrl,undefined,transport),error=>error instanceof TopicDiscoveryError&&error.code==='invalid_topic');
    assert.equal(reads,1);
  });
  const transport:TopicTransport={fetch:async()=>({url:topicUrl,body:'<title>Verification checklist</title><main><h1>Code verification and security</h1>Neutral source instructions.</main>',contentType:'text/html'})};
  assert.equal((await readTopicEvidence(topicSite,topicUrl,undefined,transport)).title,'Verification checklist');
});
