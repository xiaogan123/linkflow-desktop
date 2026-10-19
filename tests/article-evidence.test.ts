import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEvidencePatches,applyEvidencePatchResult,articleBodyUrls,articleDraftPreflight,articleLanguageMatches,buildArticleEvidenceSnapshot,buildChannelTermsCache,channelTermsEvidence,deriveLiteralFactManifest,hasPricePrediction,normalizeEvidenceQuote,reserveArticleReviewBudget,reviewedChannelTermsCache,shrinkArticleEvidenceSnapshot,unitNumbers,validateFactManifest,validEvidenceSnapshot} from '../src/main/article-evidence';
import {applyArticleReviewPatches,articleContentHash,articleContextHash,articleReviewStillValid,collectArticleEvidence,reviewArticleDraft as runReviewArticleDraft} from '../src/main/article-review';
import {createWritingProfile} from '../src/shared/writing-profile';
import {emptyState} from '../src/main/store';
import type {AiPort,Channel,Site,Task} from '../src/shared/types';

const at='2026-10-18T10:15:00.000Z';
const site:Site={id:'site-evidence',domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example',description:'Public documentation',category:'software',language:'en',monthlyTarget:2,status:'ready',createdAt:at};
const topicUrl='https://example.com/guides/snapshots';
const topicText='The software supports source snapshots and reproducible public documentation. The documented limit is 20 USDT for 3 days.';
const channel:Channel={id:'example-publisher',name:'Example Publisher',domain:'publisher.example.com',url:'https://publisher.example.com/',submitUrl:'https://publisher.example.com/new',categories:['software'],languages:['*'],kind:'article',emailRequired:false,accountRequired:false,articleRequired:true,free:'yes',freeNote:'',automation:'api',quality:'B',qualityReason:'',rulesUrl:'https://publisher.example.com/rules',checkedAt:'2026-10-01',notes:'Catalog description',allowedHosts:['publisher.example.com'],enabled:true};
const policyText='Original educational articles are allowed with commercial disclosure. Financial content is allowed. Affiliate promotion is allowed with disclosure.';
const snapshot=buildArticleEvidenceSnapshot(site,{url:topicUrl,text:topicText},[{url:site.url,kind:'site',text:'Example maintains public documentation and examples.'}],new Date(at));
const task:Task={id:'task-evidence',siteId:site.id,channelId:channel.id,sourceDomain:channel.domain,status:'running',createdAt:at,scheduledAt:at,updatedAt:at,attempts:0,message:'',topicUrl,draftRevision:1,evidenceSnapshot:snapshot,factManifest:[],draft:{title:'Source snapshots',description:'A documented source workflow.',body:`This article contains an affiliate promotional disclosure. The software uses an unclear detail in the public documentation. Read the [source guide](${topicUrl}).`}};
const settings={...emptyState().settings,articleReviewMode:'ai' as const};
const checks={factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'};
function model(overrides:Record<string,unknown>={}):AiPort{return {json:async()=>({verdict:'pass',reason:'The complete draft matches the shared evidence.',citations:[{url:topicUrl,quote:'The software supports source snapshots and reproducible public documentation.'}],...overrides}) as never}}
const reviewArticleDraft:typeof runReviewArticleDraft=(task,site,channel,settings,ai,signal,deps={})=>runReviewArticleDraft(task,site,channel,settings,ai,signal,{...deps,onTermsCache:cache=>{channel.termsCache=cache;deps.onTermsCache?.(cache)},termsAi:{json:async(_instruction,data)=>{const source=(data as {sources:{url:string;text:string;kind:string;applicability?:string;appliesTo?:string}[];channelId:string}).sources.find(item=>['rules','content_policy'].includes(item.kind)&&item.applicability==='verified'&&item.appliesTo===(data as {channelId:string}).channelId);return {finance:source?'allowed':'unknown',promotion:source?'allowed':'unknown',disclosurePlacement:source?'end':'unknown',reason:'Test policy conclusion',citations:source?[{url:source.url,quote:source.text.slice(0,Math.min(40,source.text.length))}]:[]} as never}}});

test('one snapshot prioritizes the complete topic over disclosure and home with a stable hash',()=>{
  const topic='专题全文'.repeat(6000),disclosure='披露'.repeat(3000),home='首页'.repeat(1000);
  const value=buildArticleEvidenceSnapshot(site,{url:topicUrl,text:topic},[{url:site.url,kind:'site',text:home},{url:'https://example.com/disclosure',kind:'site_detail',text:disclosure}],new Date(at));
  assert.equal(value.sources[0].text,topic);assert.equal(value.sources[0].truncated,false);
  assert.equal(value.sources[1].kind,'disclosure');assert.equal(value.sources[1].text.length,4000);assert.equal(value.sources[1].truncated,true);
  assert.equal(value.sources.some(item=>item.kind==='home'),false);
  assert.equal(validEvidenceSnapshot(value,topicUrl),true);
  const modified=structuredClone(value);modified.sources[0].text+='changed';assert.equal(validEvidenceSnapshot(modified,topicUrl),false);
});

test('review-budget shrink keeps a cited fact quote verbatim or refuses the shrink',()=>{
  const quote='The documented public source explicitly sets a limit of 20 USDT for 3 days.';
  const long=buildArticleEvidenceSnapshot(site,{url:topicUrl,text:'A'.repeat(12_000)+quote+'B'.repeat(12_000)},[],new Date(at));
  const reserved=reserveArticleReviewBudget(long);assert.ok(reserved);assert.ok(JSON.stringify(reserved).length<=19_000);
  const safe=shrinkArticleEvidenceSnapshot(long,500,[{url:topicUrl,quote}]);
  assert.ok(safe);assert.ok(safe.sources[0].text.includes(quote));assert.ok(validEvidenceSnapshot(safe,topicUrl));
  assert.equal(shrinkArticleEvidenceSnapshot(long,quote.length-1,[{url:topicUrl,quote}]),undefined);
});

test('article and social preflight catch price targets and return promises',()=>{
  const social={...channel,contentFormat:'social' as const,articleRequired:false};
  for(const body of ['BTC 有望涨到 120000 美元','比特币年底看到 120000','BTC 目标价 120000','ETH 上看 9000']){
    assert.equal(hasPricePrediction(body),true,body);
    assert.equal(articleDraftPreflight({...task,evidenceSnapshot:undefined,draft:{title:'Market note',description:'',body}},site,social),'price_prediction',body);
  }
  assert.equal(articleDraftPreflight({...task,evidenceSnapshot:undefined,draft:{title:'Market note',description:'',body:'Guaranteed returns are available.'}},site,social),'return_promise');
});

test('citation matching normalizes fullwidth punctuation but unit numbers retain decimal identity',()=>{
  assert.equal(normalizeEvidenceQuote('额度：２０ USDT，期限３天。'),normalizeEvidenceQuote('额度20USDT 期限3天'));
  const draft={title:'额度说明',description:'',body:'额度为20 USDT，期限3天。'};
  assert.equal(validateFactManifest(draft,[{claim:draft.body,url:topicUrl,quote:'The documented limit is 20 USDT for 3 days.'}],snapshot),'fact_number_unsupported');
  assert.equal(validateFactManifest({...draft,body:'The documented limit is 20 USDT for 3 days.'},[{claim:'The documented limit is 20 USDT for 3 days.',url:topicUrl,quote:'The documented limit is ２０ USDT for ３ days.'}],snapshot),undefined);
  assert.notDeepEqual(unitNumbers('1.5 USDT'),unitNumbers('15 USDT'));
  const decimal=buildArticleEvidenceSnapshot(site,{url:topicUrl,text:'The limit is 1.5 USDT and remains documented.'},[]);
  assert.equal(validateFactManifest({title:'Limit',description:'',body:'The limit is 15 USDT'},[{claim:'The limit is 15 USDT',url:topicUrl,quote:'The limit is 15 USDT and remains documented.'}],decimal),'evidence_invalid');
  assert.equal(validateFactManifest({...draft,body:'25 USDT'},[{claim:'25 USDT',url:topicUrl,quote:topicText}],snapshot),'fact_number_unsupported');
});

test('topic already fetched for writing is never fetched a second time by the evidence collector',async()=>{
  const seen:string[]=[];
  const evidence=await collectArticleEvidence({...site,topics:[{url:topicUrl,discoveredAt:at}]},channel,undefined,{topicEvidence:{url:topicUrl,text:topicText},fetchHtml:async url=>{seen.push(url);assert.notEqual(url,topicUrl);return {url,html:`<main>${url===channel.rulesUrl?policyText:'Example maintains documented public software and source material.'}</main>${url===site.url?`<a href="${topicUrl}">Affiliate disclosure</a>`:''}`}}},topicUrl);
  assert.equal(evidence.find(item=>item.url===topicUrl)?.text,topicText);assert.equal(seen.filter(url=>url===topicUrl).length,0);
});

test('review uses the exact task snapshot without fetching any website page and sends bounded policy text',async()=>{
  const seen:string[]=[];let observed:any,cache:any;
  const review=await reviewArticleDraft(task,site,channel,settings,{json:async(prompt,data,schema,signal)=>{observed=data;return model().json(prompt,data,schema,signal)}},undefined,{now:()=>new Date(at),onTermsCache:value=>{cache=value},fetchHtml:async url=>{seen.push(url);assert.equal(url,channel.rulesUrl);return {url,html:`<main>${policyText}</main>`}}});
  assert.equal(review.status,'passed',review.reason);assert.deepEqual(seen,[channel.rulesUrl]);
  assert.equal(observed.evidence.find((item:any)=>item.url===topicUrl).text,snapshot.sources[0].text);
  assert.ok(observed.evidence.filter((item:any)=>item.url===channel.rulesUrl).reduce((total:number,item:any)=>total+item.text.length,0)<=600);
  assert.equal(cache.finance,'allowed');assert.equal(cache.promotion,'allowed');assert.equal(review.termsHash,cache.conclusionHash);
  assert.equal(articleReviewStillValid({...task,articleReview:review},site,{...channel,termsCache:cache},settings),true);
});

test('policy cache starts unknown and preserves AI conclusions until actual source text changes',()=>{
  const sources=[{url:channel.rulesUrl,kind:'content_policy' as const,appliesTo:channel.id,applicability:'verified' as const,text:'General reading rules apply. '.repeat(1000)+'Affiliate promotion is prohibited. Financial content is not allowed.'}];
  const pending=buildChannelTermsCache(channel,sources,undefined,new Date(at));
  assert.equal(pending.finance,'unknown');assert.equal(pending.promotion,'unknown');
  const cache=reviewedChannelTermsCache(pending,{finance:'forbidden',promotion:'forbidden',disclosurePlacement:'end'});
  assert.equal(cache.finance,'forbidden');assert.equal(cache.promotion,'forbidden');assert.match(cache.summary,/prohibited/);
  assert.ok(cache.summary.length<=600);assert.ok(channelTermsEvidence(cache).reduce((sum,row)=>sum+row.text.length,0)<=600);
  const reused=buildChannelTermsCache({...channel,notes:'Changed catalog text',checkedAt:'2026-11-01'},sources,cache,new Date('2026-11-01'));
  assert.equal(reused,cache);
  const changed=buildChannelTermsCache(channel,[{...sources[0],text:sources[0].text+' New restriction.'}],cache,new Date(at));
  assert.notEqual(changed.conclusionHash,cache.conclusionHash);
  assert.equal(articleContextHash(site,{...channel,termsCache:cache},settings),articleContextHash(site,{...channel,termsCache:cache,notes:'edited',checkedAt:'later'},settings));
  assert.notEqual(articleContextHash(site,{...channel,termsCache:cache},settings),articleContextHash(site,{...channel,termsCache:changed},settings));
});

test('local patches only apply once at a unique location and cannot introduce unsupported entities numbers or URLs',()=>{
  const draft=task.draft!;
  assert.ok(applyEvidencePatches(draft,[{field:'body',find:'unclear detail',replace:'source snapshots'}],snapshot));
  for(const replace of ['99 USDT','InventedCoin','ethereum','币安','Кошелёк принадлежит Бинанс.','바이낸스','بينانس','https://other.example.com/'])assert.equal(applyEvidencePatches(draft,[{field:'body',find:'unclear detail',replace}],snapshot),undefined);
  assert.equal(applyEvidencePatches({...draft,body:'repeat repeat'},[{field:'body',find:'repeat',replace:'detail'}],snapshot),undefined);
});

test('local factual patches update claim text while retaining the original source quote',()=>{
  const claim='The documented limit is 20 USDT for 3 days.',draft={title:'Limits',description:'',body:claim},fact={claim,url:topicUrl,quote:claim};
  const result=applyEvidencePatchResult(draft,[fact],[{field:'body',find:'documented limit',replace:'limit'}],snapshot);
  assert.ok(result);assert.equal(result.factManifest[0].claim,'The limit is 20 USDT for 3 days.');
  assert.equal(result.factManifest[0].quote,claim);assert.equal(validateFactManifest(result.draft,result.factManifest,snapshot),undefined);
});

test('legacy drafts without a fact list only recover numbers from literal source sentences',()=>{
  const claim='The documented limit is 20 USDT for 3 days.',supported={...task,factManifest:undefined,draft:{...task.draft!,body:claim+'\n\n'+task.draft!.body}};
  const facts=deriveLiteralFactManifest(supported.draft,snapshot);
  assert.equal(facts.length,1);assert.equal(facts[0].claim,claim.slice(0,-1));
  assert.equal(articleDraftPreflight(supported,site,channel),undefined);
  assert.equal(articleDraftPreflight({...supported,draft:{...supported.draft,body:supported.draft.body.replace('20 USDT','25 USDT')}},site,channel),'fact_number_unsupported');
});

test('a URL used as its own Markdown label is counted as one actual link',()=>{
  assert.deepEqual(articleBodyUrls(`[${topicUrl}](${topicUrl})`),[topicUrl]);
  assert.equal(articleDraftPreflight({...task,draft:{...task.draft!,body:`This article contains an affiliate promotional disclosure. Read the source guide [${topicUrl}](${topicUrl}).`}},site,channel),undefined);
});

test('a modify result applies a source-bound patch and binds the resulting article without a second AI call',async()=>{
  let calls=0;const ai=model({verdict:'modify',patches:[{field:'body',find:'unclear detail',replace:'source snapshots'}]});
  const review=await reviewArticleDraft(task,site,channel,settings,{json:async(...args)=>{calls++;return ai.json(...args)}},undefined,{fetchHtml:async url=>({url,html:`<main>${policyText}</main>`})});
  assert.equal(review.status,'passed',review.reason);assert.equal(calls,1);
  const draft=applyArticleReviewPatches(task,review);assert.ok(draft);assert.match(draft.body,/source snapshots/);
  assert.equal(review.draftRevision,2);assert.equal(review.contentHash,articleContentHash({...task,draft}));
});

test('review returns the patched fact manifest so a legitimate factual patch can be persisted',async()=>{
  const claim='The documented limit is 20 USDT for 3 days.',fact={claim,url:topicUrl,quote:claim};
  const current={...task,factManifest:[fact],draft:{...task.draft!,body:`${claim}\n\nAffiliate promotional disclosure. Read the [source](${topicUrl}).`}};
  const review=await reviewArticleDraft(current,site,channel,settings,model({verdict:'modify',patches:[{field:'body',find:'documented limit',replace:'limit'}]}),undefined,{fetchHtml:async url=>({url,html:`<main>${policyText}</main>`})});
  assert.equal(review.status,'passed',review.reason);assert.equal(review.factManifest?.[0].claim,'The limit is 20 USDT for 3 days.');
  assert.equal(review.factManifest?.[0].quote,claim);
  assert.equal(validateFactManifest(applyArticleReviewPatches(current,review)!,review.factManifest,snapshot),undefined);
});

test('unsafe facts referrals and missing exact disclosure stop before paid review',async()=>{
  let calls=0;
  for(const current of [
    {...task,draft:{...task.draft!,body:task.draft!.body+' The limit is 99 USDT.'}},
    {...task,draft:{...task.draft!,body:task.draft!.body+' https://example.com/?ref=sample'}},
    {...task,writingEnvelope:{disclosure:'Exact managed disclosure.',risk:'',signature:'Example',link:'',targetUrl:topicUrl}},
  ]){
    const review=await reviewArticleDraft(current,site,channel,settings,{json:async()=>{calls++;throw Error('must not call AI')}},undefined,{fetchHtml:async()=>{throw Error('must not fetch')}});
    assert.equal(review.status,'failed');assert.notEqual(review.reasonCode,'content_rejected');
  }
  assert.equal(calls,0);
});

test('language and profile length checks assess the body rather than a stray English token',()=>{
  assert.equal(articleLanguageMatches('这是完全用中文撰写的正文，不能因为插入word一词就当成英文文章。'.repeat(20),'en'),false);
  assert.equal(articleLanguageMatches('The source and the guide explain how this software works with a public snapshot. '.repeat(10),'en'),true);
  assert.equal(articleLanguageMatches('Este es un texto para los lectores de la guía y los ejemplos que se explican con una descripción de los recursos. '.repeat(10),'en'),false);
  const profile=createWritingProfile({...site,domain:'example.com'}),envelope={disclosure:'Managed disclosure.',risk:'Risk.',signature:'Example',link:`[source](${topicUrl})`,targetUrl:topicUrl};
  assert.equal(articleDraftPreflight({...task,writingEnvelope:envelope,draft:{...task.draft!,body:`A short body with the guide.\n\n${envelope.disclosure}\n\n${envelope.link}`}}, {...site,writingProfile:profile},channel),'length_invalid');
});

test('mechanical format guards apply before review and after a patch',()=>{
  for(const body of [task.draft!.body+'\n\n<script>unsafe()</script>',task.draft!.body+'\n\n![image](https://example.com/image.png)'])assert.equal(articleDraftPreflight({...task,draft:{...task.draft!,body}},site,channel),'format_invalid');
  for(const body of [task.draft!.body+'\n\n```text\ncode\n```',task.draft!.body+'\n\n> quote',task.draft!.body+'\n\n| Field | Value |\n| --- | --- |\n| A | B |'])assert.equal(articleDraftPreflight({...task,draft:{...task.draft!,body}},site,{...channel,id:'leaflet'}),'format_invalid');
  assert.equal(articleDraftPreflight(task,site,{...channel,id:'nextgen-slides'}),'format_invalid');
  for(const id of ['raindrop','agenthow'])assert.equal(articleDraftPreflight({...task,draft:{...task.draft!,body:'A plain explanation with **bold markup**.'}},site,{...channel,id}),'format_invalid');
});

test('managed disclosure and short risk language exclude the brand but reject a mixed-language envelope',()=>{
  const brandSite={...site,name:'示例品牌'},envelope={disclosure:'Promotional link to 示例品牌.',risk:'Read the source.',signature:'示例品牌',link:`[示例品牌](${topicUrl})`,targetUrl:topicUrl};
  const managed=(risk:string)=>({...task,writingEnvelope:{...envelope,risk},draft:{...task.draft!,body:['The public documentation explains this process and the source remains available for a reader to compare its scope.',envelope.link,risk,envelope.signature,envelope.disclosure].join('\n\n')}});
  assert.equal(articleDraftPreflight(managed(envelope.risk),brandSite,channel),undefined);
  assert.equal(articleDraftPreflight(managed('请注意相关风险。'),brandSite,channel),'language_invalid');
});
