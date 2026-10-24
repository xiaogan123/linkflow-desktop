import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {channelTermsBlockReason,reviewArticleDraft} from '../src/main/article-review';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {emptyState} from '../src/main/store';
import type {AiPort,Channel,Site,Task} from '../src/shared/types';

const POLICY='You may publish and host your own original documents on this service. Do not publish affiliate link farms or bulk pages intended to manipulate search rankings.';
function fixture(category:Site['category']){
  const stamp=new Date().toISOString(),site:Site={id:randomUUID(),domain:'software.example.org',url:'https://software.example.org/',name:'Example Software',description:'Example Software documents a desktop checklist.',email:'owner@example.org',category,language:'en',monthlyTarget:1,status:'ready',createdAt:stamp};
  const channel:Channel={id:'policy-fixture',name:'Policy Fixture',domain:'host.example.org',url:'https://host.example.org/',submitUrl:'https://host.example.org/new',categories:['software','finance'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'fixture',automation:'api',quality:'B',qualityReason:'fixture',rulesUrl:'https://host.example.org/terms',checkedAt:'2026-10-24',notes:'fixture',allowedHosts:['host.example.org'],enabled:true,evidenceSources:[{url:'https://host.example.org/terms',kind:'content_policy',appliesTo:'policy-fixture',applicability:'verified'}]};
  channel.termsCache=reviewedChannelTermsCache(buildChannelTermsCache(channel,[{url:channel.rulesUrl,kind:'content_policy',text:POLICY,appliesTo:channel.id,applicability:'verified'}]),{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'});
  const task:Task={id:randomUUID(),siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'running',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'fixture',draftRevision:1,draft:{title:'A desktop diagnosis checklist',description:'An original method.',body:`Record the action and the observed behavior. Read the [project source](${site.url}).`}};
  return {site,channel,task};
}

test('an unknown promotion policy blocks every site category until the owner decides, and no review AI is spent',async()=>{
  for(const category of ['software','ai','general','finance'] as const){
    const {site,channel,task}=fixture(category);
    assert.equal(channelTermsBlockReason(site,channel,channel.termsCache),'policy_unknown',category);
    let calls=0;const ai:AiPort={json:async()=>{calls++;throw Error('must not call AI')}};
    const review=await reviewArticleDraft(task,site,channel,{...emptyState().settings,articleReviewMode:'ai'},ai,undefined,{termsAi:ai,fetchHtml:async url=>({url,html:`<main><p>${url===channel.rulesUrl?POLICY:site.description}</p></main>`})});
    assert.equal(review.status,'failed',category);assert.equal(calls,0,category);
  }
});
