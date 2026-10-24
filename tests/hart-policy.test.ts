import test from 'node:test';
import assert from 'node:assert/strict';
import {CHANNELS} from '../src/integrations/catalog';
import {supportsOfficialGuidanceReview} from '../src/main/channel-policy';
import {channelTermsBlockReason} from '../src/main/article-review';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import type {Channel,Site} from '../src/shared/types';

function candidate():Channel{
  return {...CHANNELS.find(c=>c.id==='shiply')!,id:'hart',domain:'hart.intrane.fr',rulesUrl:'https://hart.intrane.fr/llms.txt',provenance:'built-in',automation:'api',kind:'article',articleRequired:true,audience:['software'],requirements:['software','developer'],promotionPolicy:'unknown',evidenceSources:[
    {url:'https://hart.intrane.fr/llms.txt',kind:'api',appliesTo:'hart',applicability:'verified'},
    {url:'https://hart.intrane.fr/',kind:'product_guidance',appliesTo:'hart',applicability:'verified'},
  ]};
}
test('Hart recognizes only its verified software guidance shape without claiming permission',()=>{
  const c=candidate();assert.equal(supportsOfficialGuidanceReview(c),true);assert.equal(c.promotionPolicy,'unknown');
  for(const delta of [
    {id:'another'},{provenance:'custom'},{domain:'elsewhere.invalid'},
    {rulesUrl:'https://hart.intrane.fr/llms.txt?other=1'},
    {audience:['general']},{audience:['software','finance']},{requirements:['software']},
    {automation:'manual'},{kind:'profile'},{articleRequired:false},
  ])assert.equal(supportsOfficialGuidanceReview({...c,...delta} as Channel),false,JSON.stringify(delta));
});
test('Hart rejects altered, duplicate, missing, or extra evidence sources',()=>{
  const c=candidate(),sources=c.evidenceSources!;
  for(const delta of [
    {url:'https://unrelated.invalid/llms.txt'},{url:'https://hart.intrane.fr/llms.txt?query=1'},
    {url:'http://hart.intrane.fr/llms.txt'},{appliesTo:'other'},{applicability:'unconfirmed'},{kind:'content_policy'},
  ])assert.equal(supportsOfficialGuidanceReview({...c,evidenceSources:[{...sources[0],...delta},sources[1]]} as Channel),false,JSON.stringify(delta));
  for(const next of [sources.slice(0,1),[sources[0],sources[0]],[...sources,{url:'https://hart.intrane.fr/terms',kind:'content_policy' as const,appliesTo:'hart',applicability:'verified' as const}]])
    assert.equal(supportsOfficialGuidanceReview({...c,evidenceSources:next}),false);
});
test('Hart guidance preserves unknowns and never overrides a stated promotion prohibition',()=>{
  const c=candidate(),site={category:'software'} as Site;
  const raw=buildChannelTermsCache(c,c.evidenceSources!.map(s=>({...s,text:'Publish a self-contained HTML document through the public API.'})),undefined,new Date());
  const unknown=reviewedChannelTermsCache(raw,{finance:'unknown',promotion:'unknown',disclosurePlacement:'unknown'},new Date());
  assert.equal(channelTermsBlockReason(site,c,unknown),undefined);
  assert.equal(unknown.promotion,'unknown');
  const prohibited=reviewedChannelTermsCache(raw,{finance:'unknown',promotion:'forbidden',disclosurePlacement:'unknown'},new Date());
  assert.equal(channelTermsBlockReason(site,c,prohibited),'content_rejected');
});
