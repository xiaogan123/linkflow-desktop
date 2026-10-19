import assert from 'node:assert/strict';
import type {Channel,Task} from '../src/shared/types';
import type {Controller} from '../src/main/controller';
import type {Store} from '../src/main/store';
import {selectTaskPlatform} from '../src/main/planner';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {ensureWritingProfile,writingHash,type WritingVariants} from '../src/shared/writing-profile';

function fixtureVariants(siteId:string,language:string):WritingVariants{
  const hash=writingHash(siteId),marker=Array.from({length:8},(_,index)=>String.fromCharCode(97+((hash>>>(index*4))&15))).join('');
  if(/^zh(?:[-_]|$)/i.test(language))return {
    disclosures:Array.from({length:12},(_,index)=>`本篇${marker}${String.fromCharCode(0x4e00+index)}含有指向{brand}的推广链接。`),
    risks:Array.from({length:8},(_,index)=>`资料${marker}${String.fromCharCode(0x4e00+index)}所述条件可能变化，请核对原始来源。`),
    linkSentences:Array.from({length:4},(_,index)=>`有关${marker}${String.fromCharCode(0x4e00+index)}的补充资料可参见{link}。`),
  };
  return {
    disclosures:Array.from({length:12},(_,index)=>`Editorial note ${marker}${String.fromCharCode(97+index)}: this article contains a promotional link to {brand}.`),
    risks:Array.from({length:8},(_,index)=>`Source note ${marker}${String.fromCharCode(97+index)}: conditions may change; verify the cited material before acting.`),
    linkSentences:Array.from({length:4},(_,index)=>`For the ${marker}${String.fromCharCode(97+index)} source notes, see {link}.`),
  };
}

/** Legacy publication fixtures start with an analyzed profile; variant generation has its own focused tests. */
export function primeWritingFixtureStore(store:Store):void{
  store.update(state=>{
    for(const site of state.sites){
      if(site.writingProfile?.variantsSource==='analysis'&&site.writingProfile.variants.linkSentences?.length===4)continue;
      site.writingProfile=ensureWritingProfile(site,state.sites,fixtureVariants(site.id,site.language));
    }
  });
}

/** Offline terms result for publication lifecycle fixtures with a separate policy review path. */
export function fixtureTerms(channel:Channel){
  const placement=channel.id==='agentsgather'?'start':'end';
  const source={url:channel.rulesUrl,kind:'content_policy' as const,text:`Financial and crypto educational content is allowed. Promotional links are allowed with disclosure at the ${placement} of the article.`,appliesTo:channel.id,applicability:'verified' as const};
  const pending=buildChannelTermsCache(channel,[source]);
  return reviewedChannelTermsCache(pending,{finance:'allowed',promotion:'allowed',disclosurePlacement:placement});
}

/** Offline model output follows the production body-only writing contract. */
export function profileWriterResult(draft:NonNullable<Task['draft']>,data:unknown){
  const input=data as {site?:{name?:string};channel?:{id?:string;articleRequired?:boolean;contentFormat?:string};writingProfile?:{length:{min:number;max:number}}};
  const structured=new Set(['synthfolk','product-index','berrry','agentriot']);
  if(structured.has(input.channel?.id??'')||input.channel?.contentFormat==='social'||input.channel?.id==='raindrop')return {...draft,facts:[]};
  let body=draft.body.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g,match=>match.slice(1,match.indexOf(']')))
    .replace(/https?:\/\/[^\s)<>]+/g,'').replace(/^Disclosure:[^\n]*(?:\n\n)?/,'').trim();
  const minimum=input.writingProfile?.length.min??900;
  let paragraph='The documented process keeps the original material available. A reader can compare each statement with its source and record the scope before drawing a conclusion. The public text remains the reference when details change, and unresolved differences require a fresh reading rather than a guess.';
  if(input.site?.name?.startsWith('Alpha')){
    body='## Preserve a durable intent';
    paragraph='An interrupted write requires a durable journal. Save the complete request before sending it, retain the encrypted response, and treat an ambiguous outcome as a reason to reconcile the original operation. Repeating a mutation creates a new uncertainty. Ownership and remote acknowledgement should remain separate from local intent until each boundary has independent evidence.';
  }else if(input.site?.name?.startsWith('Beta')||draft.title==='A practical engineering boundary'){
    body='## Inspect a cached representation';
    paragraph='A cached document may describe an earlier revision. Compare its validator with a fresh representation, observe whether the cache key includes the selected resource, and distinguish a stale copy from an unavailable origin. Expiry alone does not establish that content changed. A bounded refresh can recover a newer view while keeping the previous snapshot available for comparison.';
  }
  while([...body.replace(/\s/g,'')].length<minimum+20)body+='\n\n'+paragraph;
  return {...draft,body,facts:[]};
}

/** Lifecycle fixtures acquire a platform through the real selector only after their day is due. */
export function selectDueFixtureTask(store:Store,controller:Controller,clock:{setTime:(at:number)=>void},channel:Channel){
  primeWritingFixtureStore(store);
  controller.plan();const reserved=store.read().tasks.find(task=>task.status==='queued'&&!task.channelId);assert.ok(reserved);
  clock.setTime(Date.parse(reserved.scheduledAt)+1);
  store.update(state=>{const current=state.tasks.find(task=>task.id===reserved.id)!;assert.ok(selectTaskPlatform(state,current,[{channel,score:100,reason:'Isolated publication fixture'}],new Date()))});
  return reserved.id;
}
