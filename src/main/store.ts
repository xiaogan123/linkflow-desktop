import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Account, Channel, Event, Mailbox, Settings, Site, SiteAccountBinding, Task } from '../shared/types';

export interface State {schemaVersion?:number;sites:Site[];tasks:Task[];accounts:Account[];mailboxes:Mailbox[];accountBindings:SiteAccountBinding[];settings:Settings;events:Event[];usage:Record<string,number>;customChannels?:Channel[];channelMetrics?:Record<string,{authority?:Channel['authority'];traffic?:Channel['traffic']} >}
export function defaultSettings():Settings{return {provider:'codex',codexPath:'codex',model:'',reasoningEffort:undefined,articleReviewMode:'manual',preferredBrowser:'system',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'imap.gmail.com',port:993,user:'',secure:true,hasPassword:false}}}
export function emptyState():State{return {schemaVersion:2,sites:[],tasks:[],accounts:[],mailboxes:[],accountBindings:[],settings:defaultSettings(),events:[],usage:{},customChannels:[],channelMetrics:{}}}

const SHARE_HASH=/^[a-f0-9]{64}$/;
const SHARE_OPERATION=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHARE_SLUG=/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const shareDraftHash=(task:Task)=>task.draft?createHash('sha256').update(JSON.stringify({title:task.draft.title,description:task.draft.description,body:task.draft.body})).digest('hex'):undefined;
const shareSiteHash=(site:Pick<Site,'id'|'domain'|'url'>)=>createHash('sha256').update(JSON.stringify({id:site.id,domain:site.domain,url:site.url})).digest('hex');
const sharePublicUrl=(slug:string)=>`https://${slug}.shareyourhtml.com`;

function shareClaimIdentity(task:Task):string|undefined{
  const claim=task.shareYourHtml;if(!claim)return;
  return JSON.stringify({operationId:claim.operationId,slug:claim.slug,sourceHash:claim.sourceHash,requestHash:claim.requestHash,createdAt:claim.createdAt,requestedExpiry:claim.requestedExpiry,publicVerification:claim.publicVerification,reviewedDraftRevision:claim.reviewedDraftRevision,reviewedDraftHash:claim.reviewedDraftHash,siteId:claim.siteId,siteIdentityHash:claim.siteIdentityHash});
}

const exactShareDate=(value:string|undefined)=>!!value&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const shareReadbackRel=(task:Task)=>[...new Set((task.shareYourHtmlReadback?.targetLinks??[]).flatMap(link=>link.rel))].sort().join(' ');
function assertShareClaimState(state:State,ciphers:Record<string,string>):void{
  const operations=new Set<string>(),slugs=new Set<string>();
  for(const task of state.tasks){
    const claim=task.shareYourHtml;if(!claim){if(task.shareYourHtmlReadback)throw Error('ShareYourHTML 只读证据缺少永久回执');continue}
    const site=state.sites.find(value=>value.id===task.siteId),key='publication:'+task.id,cipher=ciphers[key],readback=task.shareYourHtmlReadback;
    if(!site||task.channelId!=='shareyourhtml'||task.sourceDomain!=='shareyourhtml.com'||task.accountId
      ||claim.siteId!==task.siteId||!SHARE_OPERATION.test(claim.operationId)||!SHARE_SLUG.test(claim.slug)
      ||!SHARE_HASH.test(claim.sourceHash)||!SHARE_HASH.test(claim.requestHash)||!SHARE_HASH.test(claim.reviewedDraftHash)
      ||!Number.isSafeInteger(claim.reviewedDraftRevision)||claim.reviewedDraftRevision<0
      ||claim.requestedExpiry!=='never'||claim.publicVerification!=='pending'
      ||!Number.isFinite(Date.parse(claim.createdAt))||new Date(claim.createdAt).toISOString()!==claim.createdAt
      ||task.submittedAt!==claim.createdAt||!task.draft||typeof task.draft.title!=='string'||typeof task.draft.description!=='string'||typeof task.draft.body!=='string'
      ||task.reviewUntil!==undefined||task.reconcileAttempts!==undefined||task.reconcileAfter!==undefined)throw Error('ShareYourHTML 永久提交声明状态无效，已拒绝修改');
    if(operations.has(claim.operationId)||slugs.has(claim.slug))throw Error('ShareYourHTML 永久提交声明重复，已拒绝修改');
    operations.add(claim.operationId);slugs.add(claim.slug);
    if(claim.stage==='submitting'){
      if(readback||task.publicUrl!==undefined||task.checkpoint!=='shareyourhtml_create_submitting'||cipher!==undefined
        ||task.status!=='review'||task.health!=='pending'||task.verifiedAt!==undefined||task.firstLiveAt!==undefined
        ||task.linkCheck!==undefined||task.linkRel!==undefined||task.publicationMethod!==undefined||task.lastCheckedAt!==undefined
        ||task.nextCheckAt!==undefined||task.lostAt!==undefined||task.reviewKind!==undefined||task.consecutiveMissing!==undefined)
        throw Error('ShareYourHTML 待确认声明不能附带公开回执或编辑凭据');
      continue;
    }
    if(claim.stage!=='api_receipt'||claim.siteIdentityHash!==shareSiteHash(site)||claim.reviewedDraftHash!==shareDraftHash(task)
      ||claim.reviewedDraftRevision!==(task.draftRevision??0)||task.publicUrl!==sharePublicUrl(claim.slug)
      ||task.checkpoint!=='shareyourhtml_api_receipt'||typeof cipher!=='string'||!cipher)
      throw Error('ShareYourHTML API 回执与加密编辑凭据必须原子保留');
    if(!readback){
      if(task.status!=='review'||task.health!=='pending'||task.verifiedAt!==undefined||task.firstLiveAt!==undefined
        ||task.linkCheck!==undefined||task.linkRel!==undefined||task.publicationMethod!==undefined||task.lastCheckedAt!==undefined
        ||task.nextCheckAt!==undefined||task.lostAt!==undefined||task.reviewKind!==undefined||task.consecutiveMissing!==undefined)
        throw Error('ShareYourHTML 待核查回执状态无效');
      continue;
    }
    const checked=Date.parse(readback.checkedAt),next=Date.parse(task.nextCheckAt??''),target=task.topicUrl??site.url;
    if(!Number.isFinite(checked)||new Date(checked).toISOString()!==readback.checkedAt||task.lastCheckedAt!==readback.checkedAt
      ||!Number.isFinite(next)||next<=checked||readback.targetLinks.length>32
      ||readback.targetLinks.some(link=>link.href!==target||link.rel.length>32||new Set(link.rel).size!==link.rel.length||link.rel.some(token=>token.length>64||!/^[a-z0-9_-]+$/.test(token)))
      ||readback.indexing.directives.length>64||readback.indexing.directives.some(value=>value.length>128)
      ||new Set(readback.indexing.directives).size!==readback.indexing.directives.length)throw Error('ShareYourHTML 只读核查证据无效');
    if(readback.status==='visible_match'){
      if(readback.content!=='visible'||!readback.targetLinks.length||task.status!=='live'||task.health!=='healthy'||task.linkCheck!=='found'
        ||task.publicationMethod!=='client'||!exactShareDate(task.firstLiveAt)||!exactShareDate(task.verifiedAt)
        ||task.verifiedAt!==readback.checkedAt||Date.parse(task.firstLiveAt!)>Date.parse(task.verifiedAt!)||task.linkRel!==shareReadbackRel(task)
        ||task.lostAt!==undefined||task.reviewKind!==undefined||task.consecutiveMissing!==0)throw Error('ShareYourHTML 生效状态与只读证据不一致');
    }else{
      if(readback.content!==(readback.status==='content_mismatch'?'mismatch':readback.status==='content_hidden'?'hidden':'unknown')
        ||readback.targetLinks.length)throw Error('ShareYourHTML 非生效证据内容无效');
      if(task.firstLiveAt){
        if(!exactShareDate(task.verifiedAt)||Date.parse(task.firstLiveAt)>Date.parse(task.verifiedAt!)||Date.parse(task.verifiedAt!)>checked||task.publicationMethod!=='client')throw Error('ShareYourHTML 历史生效状态无效');
        const absent=readback.status==='content_mismatch'||readback.status==='content_hidden';
        if(absent?(task.status!=='needs_input'||task.health!=='missing'||task.linkCheck!=='absent'||!exactShareDate(task.lostAt)||task.reviewKind!=='lost_link'||(task.consecutiveMissing??0)<1)
          :(!['live','needs_input'].includes(task.status)||task.health!=='unknown'||!['unreachable','invalid'].includes(task.linkCheck??'')))
          throw Error('ShareYourHTML 复查状态与证据不一致');
      }else if(task.status!=='review'||!['pending','unknown'].includes(task.health??'')||!['absent','unreachable','invalid'].includes(task.linkCheck??'')
        ||task.verifiedAt!==undefined||task.publicationMethod!==undefined||task.lostAt!==undefined||task.reviewKind!==undefined)
        throw Error('ShareYourHTML 初次核查失败状态无效');
    }
  }
}
function assertShareClaimTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false,strictCurrentBinding=false):void{
  assertShareClaimState(next,nextCiphers);
  for(const before of previous.tasks){
    const prior=before.shareYourHtml;if(!prior)continue;
    const after=next.tasks.find(task=>task.id===before.id),beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId),key='publication:'+before.id;
    if(!after?.shareYourHtml||!beforeSite||!afterSite||shareClaimIdentity(after)!==shareClaimIdentity(before)
      ||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId
      ||strictCurrentBinding&&(JSON.stringify(after.draft)!==JSON.stringify(before.draft)
        ||after.draftRevision!==before.draftRevision||afterSite.domain!==beforeSite.domain||afterSite.url!==beforeSite.url)
      ||(prior.stage==='api_receipt'&&after.shareYourHtml.stage!=='api_receipt')
      ||(prior.stage==='submitting'&&!['submitting','api_receipt'].includes(after.shareYourHtml.stage))){
      throw Error('ShareYourHTML 永久提交声明、原稿或来源站点不能删除、替换或回退；可暂停站点后继续核查');
    }
    if(before.shareYourHtmlReadback&&(!after.shareYourHtmlReadback||Date.parse(after.shareYourHtmlReadback.checkedAt)<Date.parse(before.shareYourHtmlReadback.checkedAt))
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('ShareYourHTML 只读核查历史不能删除、回退或改写首次生效时间');
    const existingCipher=previousCiphers[key];
    if(existingCipher!==undefined&&nextCiphers[key]!==existingCipher)throw Error('ShareYourHTML 已保存的加密编辑凭据不能删除或替换');
  }
  if(!allowImportedReceipt){
    for(const task of next.tasks){
      if(task.shareYourHtml&&!previous.tasks.some(before=>before.id===task.id&&before.shareYourHtml)&&task.shareYourHtml.stage!=='submitting')throw Error('ShareYourHTML 新声明必须从待确认阶段开始');
    }
  }
}

function assertKatbinTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.katbin)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.katbin,current=after?.katbin,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||before.submittedAt!==after.submittedAt
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Katbin 单次发布意图或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Katbin 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Katbin 加密原始响应不能删除或替换');
  }
}

function assertMDShareTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.mdshare)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.mdshare,current=after?.mdshare,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.slug&&current.slug!==prior.slug||before.submittedAt!==after.submittedAt
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('MDShare 单次发布意图或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('MDShare 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('MDShare 加密原始响应不能删除或替换');
  }
}

function assertPasteMystTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.pastemyst)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.pastemyst,current=after?.pastemyst,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||before.submittedAt!==after.submittedAt
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('PasteMyst 单次发布意图或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('PasteMyst 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('PasteMyst 加密原始响应不能删除或替换');
  }
}

function assertPstrsTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,partial_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.pstrs)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.pstrs,current=after?.pstrs,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.stage==='partial_response'&&current.stage!=='partial_response'||prior.id&&current.id!==prior.id||prior.expiresAt!==undefined&&current.expiresAt!==prior.expiresAt||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('PST.RS 单次发布意图、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('PST.RS 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('PST.RS 加密原始响应不能删除或替换');
  }
}

function assertNextgenSlidesTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.nextgenSlides)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.nextgenSlides,current=after?.nextgenSlides,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('NextgenSlides 单次发布意图、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('NextgenSlides 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('NextgenSlides 加密原始响应不能删除或替换');
  }
}
function assertYourwebsTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.yourwebs)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.yourwebs,current=after?.yourwebs,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||prior.subdomain&&current.subdomain!==prior.subdomain||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||prior.expiresAt!==undefined&&current.expiresAt!==prior.expiresAt||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Yourwebs 单次发布意图、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Yourwebs 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Yourwebs 加密原始响应不能删除或替换');
  }
}

function assertMemoryWikiTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.memoryWiki)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.memoryWiki,current=after?.memoryWiki,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt
      ||prior.remoteUpdatedAt!==undefined&&current.remoteUpdatedAt!==prior.remoteUpdatedAt||prior.deduplicated!==undefined&&current.deduplicated!==prior.deduplicated
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Memory.wiki 单次发布意图、远端身份或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Memory.wiki 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Memory.wiki 加密原始响应与编辑令牌不能删除或替换');
  }
}

function assertTotpageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.totpage)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.totpage,current=after?.totpage,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Totpage 单次发布意图、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Totpage 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Totpage 加密原始响应不能删除或替换');
  }
}

function assertMDViewTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.mdview)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.mdview,current=after?.mdview,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.documentId&&current.documentId!==prior.documentId||prior.shortId&&current.shortId!==prior.shortId||prior.expiresAt!==undefined&&current.expiresAt!==prior.expiresAt
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('MDView 单次发布意图、有限期对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('MDView 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('MDView 加密原始响应不能删除或替换');
  }
}

function assertTxtSbsTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.txtsbs)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.txtsbs,current=after?.txtsbs,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('txt.sbs 单次发布意图、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('txt.sbs 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('txt.sbs 加密原始响应不能删除或替换');
  }
}

function assertAgentDropTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.agentdrop)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.agentdrop,current=after?.agentdrop,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||prior.expiresAt!==undefined&&current.expiresAt!==prior.expiresAt||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('AgentDrop 单次发布意图、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('AgentDrop 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('AgentDrop 加密原始响应不能删除或替换');
  }
}

function assertShipPageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const accounts=next.accounts.filter(account=>account.channelId==='shippage');
  if(accounts.length>1)throw Error('ShipPage 只能保留一个本机平台账号');
  const account=accounts[0],operations=new Set<string>(),slugs=new Set<string>(),order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const task of next.tasks){
    const receipt=task.shipPage;if(!receipt)continue;
    const binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='shippage');
    if(task.channelId!=='shippage'||task.sourceDomain!=='shippage.ai'||!account||task.accountId!==account.id||receipt.accountId!==account.id||binding?.accountId!==account.id)throw Error('ShipPage 任务必须绑定唯一平台账号');
    if(operations.has(receipt.operationId)||slugs.has(receipt.slug))throw Error('ShipPage 单次发布意图或 slug 不能重复');
    operations.add(receipt.operationId);slugs.add(receipt.slug);
  }
  for(const before of previous.tasks){
    if(!before.shipPage)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.shipPage,current=after?.shipPage,publicationKey=`publication:${before.id}`,accountKey=`account:${prior.accountId}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId
      ||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.accountId!==prior.accountId
      ||current.slug!==prior.slug||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||current.authenticated!==prior.authenticated
      ||order[current.stage]<order[prior.stage]||before.submittedAt!==after.submittedAt||prior.publicUrl&&current.publicUrl!==prior.publicUrl||prior.expiresAt&&current.expiresAt!==prior.expiresAt
      ||prior.readback&&JSON.stringify(current.readback)!==JSON.stringify(prior.readback)
      ||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('ShipPage 唯一账号、单次发布意图、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('ShipPage 原网站身份不能更换');
    if(previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]!==previousCiphers[publicationKey])throw Error('ShipPage 加密原始响应不能删除或替换');
    if(previousCiphers[accountKey]!==undefined&&nextCiphers[accountKey]!==previousCiphers[accountKey])throw Error('ShipPage 唯一账号 API key 不能删除或替换');
  }
  for(const before of previous.accounts){
    if(before.channelId!=='shippage')continue;
    const after=next.accounts.find(account=>account.id===before.id),key=`account:${before.id}`;
    if(!after||after.channelId!=='shippage'||after.email!==before.email||after.source!==before.source||after.credentialKind!==before.credentialKind
      ||(before.shipPage&&JSON.stringify(after.shipPage)!==JSON.stringify(before.shipPage))||(before.hasPassword&&(!after.hasPassword||after.status!==before.status||after.username!==before.username)))throw Error('ShipPage 唯一账号或已验证身份不能删除、替换或回退');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('ShipPage 唯一账号 API key 不能删除或替换');
  }
}

function assertMarkdownPasteTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.markdownPaste)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.markdownPaste,current=after?.markdownPaste,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||before.submittedAt!==after.submittedAt
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Markdown Pastebin 单次发布意图或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Markdown Pastebin 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Markdown Pastebin 加密原始响应不能删除或替换');
  }
}

function assertSlugPostTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,ui_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.slugPost)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.slugPost,current=after?.slugPost,key=`publication:${before.id}`;
    const priorJournal=prior.boundaryJournal??[],currentJournal=current?.boundaryJournal??[],journalChanged=JSON.stringify(currentJournal)!==JSON.stringify(priorJournal);
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.slug!==prior.slug||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||currentJournal.length<priorJournal.length||currentJournal.length>16||JSON.stringify(currentJournal.slice(0,priorJournal.length))!==JSON.stringify(priorJournal)||journalChanged&&(prior.stage!=='submitting'||current.stage!=='submitting')||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('SlugPost 单次网页意图、派发证据或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('SlugPost 原网站身份不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('SlugPost 加密原始回执不能删除或替换');
  }
}

function assertBrewPageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={owner_token_pending:0,owner_token_opaque:1,ready:2,submitting:3,opaque_response:4,api_receipt:5,published:6};
  for(const before of previous.tasks){
    if(!before.brewPage)continue;const after=next.tasks.find(task=>task.id===before.id),prior=before.brewPage,current=after?.brewPage,publicationKey=`publication:${before.id}`,accountKey=`account:${prior.ownerAccountId}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.ownerAccountId!==prior.ownerAccountId||current.filename!==prior.filename||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||before.submittedAt!==after.submittedAt||prior.ownerId&&current.ownerId!==prior.ownerId||prior.id&&current.id!==prior.id||prior.publicUrl&&current.publicUrl!==prior.publicUrl||prior.expiresAt&&current.expiresAt!==prior.expiresAt||prior.sizeBytes&&current.sizeBytes!==prior.sizeBytes||prior.hostingVersion&&current.hostingVersion!==prior.hostingVersion||(current.recoveryGets??0)<(prior.recoveryGets??0)||(current.recoveryGets??0)>7||before.accountId&&after.accountId!==before.accountId||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('BrewPage 所有者、单次发布意图、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('BrewPage 原网站身份不能更换');
    if(prior.ownerId){
      const beforeAccount=previous.accounts.find(account=>account.id===prior.ownerAccountId),afterAccount=next.accounts.find(account=>account.id===prior.ownerAccountId),beforeBinding=previous.accountBindings.find(binding=>binding.siteId===before.siteId&&binding.channelId==='brewpage'),afterBinding=next.accountBindings.find(binding=>binding.siteId===before.siteId&&binding.channelId==='brewpage');
      if(!beforeAccount||!afterAccount||afterAccount.channelId!=='brewpage'||afterAccount.username!==beforeAccount.username||afterAccount.credentialKind!==beforeAccount.credentialKind||afterAccount.status!==beforeAccount.status||afterAccount.hasPassword!==beforeAccount.hasPassword||afterAccount.source!==beforeAccount.source||!beforeBinding||!afterBinding||afterBinding.accountId!==prior.ownerAccountId||beforeBinding.accountId!==afterBinding.accountId)throw Error('BrewPage 已确认所有者账号和站点绑定不能删除或更换');
    }
    if(previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]!==previousCiphers[publicationKey]&&!(prior.stage==='owner_token_opaque'&&current.stage==='ready'&&nextCiphers[publicationKey]===undefined))throw Error('BrewPage 加密原始响应不能删除或替换');
    if(previousCiphers[accountKey]!==undefined&&nextCiphers[accountKey]!==previousCiphers[accountKey])throw Error('BrewPage 所有者令牌不能删除或替换');
  }
}

function email(value:string|undefined){return (value??'').trim().toLowerCase()}
function sameMailboxIdentity(mailbox:Pick<Mailbox,'host'|'port'|'user'|'secure'>,legacy:Pick<Settings['mail'],'host'|'port'|'user'|'secure'>){const host=(value:string)=>value.trim().toLowerCase().replace(/\.$/,'');return host(mailbox.host)===host(legacy.host)&&mailbox.port===legacy.port&&mailbox.user.trim()===legacy.user.trim()&&mailbox.secure===legacy.secure}
/** Additive migration only: it never deletes identities, tasks, legacy fields or secret keys. */
export function migrateState(input:State):State{
  const state=input as State;
  if((state.schemaVersion??0)>2)throw Error('数据版本高于当前应用支持范围，请先更新应用');
  const legacy=(state.schemaVersion??0)<2;
  state.sites=Array.isArray(state.sites)?state.sites:[];
  state.tasks=Array.isArray(state.tasks)?state.tasks:[];
  state.accounts=Array.isArray(state.accounts)?state.accounts:[];
  state.mailboxes=Array.isArray(state.mailboxes)?state.mailboxes:[];
  state.accountBindings=Array.isArray(state.accountBindings)?state.accountBindings:[];
  state.events=Array.isArray(state.events)?state.events:[];
  state.usage=state.usage&&typeof state.usage==='object'?state.usage:{};
  state.customChannels=Array.isArray(state.customChannels)?state.customChannels:[];
  state.channelMetrics=state.channelMetrics&&typeof state.channelMetrics==='object'?state.channelMetrics:{};
  state.settings={...defaultSettings(),...(state.settings??{}),mail:{...defaultSettings().mail,...(state.settings?.mail??{})},channelOverrides:state.settings?.channelOverrides??{}};
  if(state.settings.articleReviewMode!=='manual'&&state.settings.articleReviewMode!=='ai')state.settings.articleReviewMode='manual';
  for(const site of state.sites){
    const mode=(site as Site&{articleReviewMode?:unknown}).articleReviewMode;
    if(mode!==undefined&&mode!=='manual'&&mode!=='ai')site.articleReviewMode='manual';
  }
  const now=new Date().toISOString();
  if(legacy)for(const site of state.sites)site.publicEmail=site.publicEmail||site.email;
  if(legacy&&!state.mailboxes.length&&(state.settings.mail.user||state.settings.mail.hasPassword)){
    const id=randomUUID();
    state.mailboxes.push({id,label:state.settings.mail.user||'默认收件箱',host:state.settings.mail.host,port:state.settings.mail.port,user:state.settings.mail.user,secure:state.settings.mail.secure,hasPassword:state.settings.mail.hasPassword,aliases:[...new Set([state.settings.mail.user,...state.sites.map(s=>s.publicEmail||s.email)].map(email).filter(Boolean))],createdAt:now,updatedAt:now});
    for(const site of state.sites)site.mailboxId??=id;
    for(const account of state.accounts)account.mailboxId??=id;
  }
  const mailboxIds=new Set(state.mailboxes.map(m=>m.id));
  for(const site of state.sites)if(site.mailboxId&&!mailboxIds.has(site.mailboxId))delete site.mailboxId;
  for(const account of state.accounts)if(account.mailboxId&&!mailboxIds.has(account.mailboxId))delete account.mailboxId;
  for(const mailbox of state.mailboxes){mailbox.aliases=[...new Set((mailbox.aliases??[]).map(email).filter(Boolean))];mailbox.label=mailbox.label||mailbox.user;}
  if(legacy)for(const site of state.sites){
    const publicEmail=email(site.publicEmail||site.email);
    for(const account of state.accounts.filter(a=>a.channelId&&((a.channelId==='github-gist')||email(a.email)===publicEmail))){
      if(!state.accountBindings.some(b=>b.siteId===site.id&&b.channelId===account.channelId))state.accountBindings.push({id:randomUUID(),siteId:site.id,channelId:account.channelId,accountId:account.id,createdAt:now,updatedAt:now});
    }
  }
  const accountIds=new Set(state.accounts.map(a=>a.id));
  const siteIds=new Set(state.sites.map(s=>s.id));
  state.accountBindings=state.accountBindings.filter(b=>accountIds.has(b.accountId)&&siteIds.has(b.siteId));
  for(const task of state.tasks){
    if(task.accountId&&!accountIds.has(task.accountId))delete task.accountId;
    const binding=state.accountBindings.find(b=>b.siteId===task.siteId&&b.channelId===task.channelId);
    task.accountId??=binding?.accountId;
    if(legacy){task.health??=task.linkCheck==='found'?'healthy':task.linkCheck==='absent'&&!!task.firstLiveAt?'missing':task.publicUrl?'unknown':'pending';task.history??=[];task.cost??={aiCalls:0};if(task.status==='review'&&!task.reviewUntil){const base=Date.parse(task.submittedAt??task.updatedAt??task.createdAt),started=Number.isFinite(base)?base:Date.now();task.reviewUntil=new Date(started+30*86400000).toISOString();task.reviewKind??=task.submittedAt?'publication':'manual_url';}}
  }
  state.schemaVersion=2;
  return state;
}

/** The SQLite transaction persists a complete coherent scheduler state before notifying UI. */
export class Store {
  private db:DatabaseSync;
  private state:State;
  onChange?:()=>void;
  constructor(path:string){
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});}
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    if(path!==':memory:')chmodSync(path,0o600);
    const row=this.db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string}|undefined;
    const loaded:State=row?JSON.parse(row.body):emptyState(),legacySchema=!!row&&(loaded.schemaVersion??0)<2,hadMailboxes=Array.isArray(loaded.mailboxes)&&loaded.mailboxes.length>0,legacyMail=legacySchema?loaded.settings?.mail:undefined;
    this.state=migrateState(loaded);
    assertShareClaimState(this.state,this.allCiphers());
    const legacyMailbox=legacySchema&&!hadMailboxes&&legacyMail?.hasPassword&&this.state.mailboxes.length===1&&sameMailboxIdentity(this.state.mailboxes[0],legacyMail)?this.state.mailboxes[0]:undefined;
    if(legacyMailbox&&!this.getCipher('mailbox:'+legacyMailbox.id)){const cipher=this.getCipher('mailPassword');if(cipher)this.setCipher('mailbox:'+legacyMailbox.id,cipher)}
    if(!this.state.settings.mail.host&&!this.state.settings.mail.user&&!this.state.settings.mail.hasPassword)this.state.settings.mail.host='imap.gmail.com';
    this.persist(this.state);
  }
  read():State{return structuredClone(this.state)}
  private notify(){try{this.onChange?.()}catch{/* A renderer notification cannot undo a committed write. */}}
  private assertNoNestedWrite(previous:State,previousCiphers:Record<string,string>){
    if(JSON.stringify(this.state)!==JSON.stringify(previous)||JSON.stringify(this.allCiphers())!==JSON.stringify(previousCiphers))throw Error('Store 更新期间已有更晚的持久化结果，已拒绝旧快照覆盖');
  }
  update(fn:(draft:State)=>void):void{
    const previous=this.read(),previousCiphers=this.allCiphers(),draft=structuredClone(previous);fn(draft);this.assertNoNestedWrite(previous,previousCiphers);draft.events=draft.events.slice(-500);assertShareClaimTransition(previous,draft,previousCiphers,previousCiphers);assertKatbinTransition(previous,draft,previousCiphers,previousCiphers);assertMDShareTransition(previous,draft,previousCiphers,previousCiphers);assertPstrsTransition(previous,draft,previousCiphers,previousCiphers);assertYourwebsTransition(previous,draft,previousCiphers,previousCiphers);assertNextgenSlidesTransition(previous,draft,previousCiphers,previousCiphers);assertMemoryWikiTransition(previous,draft,previousCiphers,previousCiphers);assertTotpageTransition(previous,draft,previousCiphers,previousCiphers);assertMDViewTransition(previous,draft,previousCiphers,previousCiphers);assertTxtSbsTransition(previous,draft,previousCiphers,previousCiphers);assertAgentDropTransition(previous,draft,previousCiphers,previousCiphers);assertShipPageTransition(previous,draft,previousCiphers,previousCiphers);assertPasteMystTransition(previous,draft,previousCiphers,previousCiphers);assertMarkdownPasteTransition(previous,draft,previousCiphers,previousCiphers);assertSlugPostTransition(previous,draft,previousCiphers,previousCiphers);assertBrewPageTransition(previous,draft,previousCiphers,previousCiphers);this.persist(draft);this.state=draft;this.notify();
  }
  updateWithCiphers(fn:(draft:State)=>void,ciphers:Record<string,string>,deleteKeys:string[]=[]):void{
    if(deleteKeys.some(key=>Object.hasOwn(ciphers,key)))throw Error('同一加密字段不能在一次事务中同时写入和删除');
    const previous=this.read(),previousCiphers=this.allCiphers(),draft=structuredClone(previous);fn(draft);this.assertNoNestedWrite(previous,previousCiphers);draft.events=draft.events.slice(-500);
    const nextCiphers={...previousCiphers,...ciphers};for(const key of deleteKeys)delete nextCiphers[key];assertShareClaimTransition(previous,draft,previousCiphers,nextCiphers);assertKatbinTransition(previous,draft,previousCiphers,nextCiphers);assertMDShareTransition(previous,draft,previousCiphers,nextCiphers);assertPstrsTransition(previous,draft,previousCiphers,nextCiphers);assertYourwebsTransition(previous,draft,previousCiphers,nextCiphers);assertNextgenSlidesTransition(previous,draft,previousCiphers,nextCiphers);assertMemoryWikiTransition(previous,draft,previousCiphers,nextCiphers);assertTotpageTransition(previous,draft,previousCiphers,nextCiphers);assertMDViewTransition(previous,draft,previousCiphers,nextCiphers);assertTxtSbsTransition(previous,draft,previousCiphers,nextCiphers);assertAgentDropTransition(previous,draft,previousCiphers,nextCiphers);assertShipPageTransition(previous,draft,previousCiphers,nextCiphers);assertPasteMystTransition(previous,draft,previousCiphers,nextCiphers);assertMarkdownPasteTransition(previous,draft,previousCiphers,nextCiphers);assertSlugPostTransition(previous,draft,previousCiphers,nextCiphers);assertBrewPageTransition(previous,draft,previousCiphers,nextCiphers);
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(draft);for(const key of deleteKeys)this.deleteCipher(key);for(const [key,value] of Object.entries(ciphers))this.setCipher(key,value);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
    this.state=draft;this.notify();
  }
  private persist(state:State){this.db.prepare('INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(state))}
  log(message:string,options:Partial<Omit<Event,'message'|'id'|'at'>>={}){
    this.update(s=>s.events.push({id:randomUUID(),at:new Date().toISOString(),level:'info',...options,message:message.slice(0,1000)}));
  }
  getCipher(key:string):string|undefined{return (this.db.prepare('SELECT value FROM secrets WHERE key=?').get(key) as {value:string}|undefined)?.value}
  setCipher(key:string,value:string){this.db.prepare('INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  deleteCipher(key:string){this.db.prepare('DELETE FROM secrets WHERE key=?').run(key)}
  allCiphers():Record<string,string>{return Object.fromEntries((this.db.prepare('SELECT key,value FROM secrets').all() as {key:string,value:string}[]).map(x=>[x.key,x.value]))}
  restore(state:State,ciphers:Record<string,string>){
    const previous=this.read(),previousCiphers=this.allCiphers();state=structuredClone(migrateState(state));assertShareClaimTransition(previous,state,previousCiphers,ciphers,true,true);assertKatbinTransition(previous,state,previousCiphers,ciphers);assertMDShareTransition(previous,state,previousCiphers,ciphers);assertPstrsTransition(previous,state,previousCiphers,ciphers);assertYourwebsTransition(previous,state,previousCiphers,ciphers);assertNextgenSlidesTransition(previous,state,previousCiphers,ciphers);assertMemoryWikiTransition(previous,state,previousCiphers,ciphers);assertTotpageTransition(previous,state,previousCiphers,ciphers);assertMDViewTransition(previous,state,previousCiphers,ciphers);assertTxtSbsTransition(previous,state,previousCiphers,ciphers);assertAgentDropTransition(previous,state,previousCiphers,ciphers);assertShipPageTransition(previous,state,previousCiphers,ciphers);assertPasteMystTransition(previous,state,previousCiphers,ciphers);assertMarkdownPasteTransition(previous,state,previousCiphers,ciphers);assertSlugPostTransition(previous,state,previousCiphers,ciphers);assertBrewPageTransition(previous,state,previousCiphers,ciphers);
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(state);this.db.exec('DELETE FROM secrets');for(const [k,v]of Object.entries(ciphers))this.setCipher(k,v);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.state=state;this.notify();
  }
  close(){this.db.close()}
}
