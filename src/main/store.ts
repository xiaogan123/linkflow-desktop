import {migrateLegacyArticleReview} from './article-review';
import {composeChannels} from '../integrations/channel-library';
import {normalizeChannelLinkRel} from '../shared/channel-rel';
import {assertBatch5Transition} from './batch5-publication';
import {migrateChannelTrials,reconcileChannelTrials} from './channel-trials';
import {migrateChannelPolicyScopeHashes} from './channel-policy';
import {isHumanTaskReason} from '../shared/task-reasons';
import {recordMailConsumption} from './email-waits';
import {activeEmailWait,taskTransition} from './task-state';
import {hasUnresolvedExternalAttempt} from '../shared/publication';
import {SIGNUP_MESSAGES} from '../shared/registration-messages';
import {legacyAuthorityMetrics} from '../shared/channel-metrics';
import {channelMetricLinkScope} from '../integrations/channel-authority-snapshots';
import {CHANNELS} from '../integrations/catalog';
import {assertRetiredAccounts,retireLegacyAccounts,migrateIdentityOwners,preserveRetiredAccountsOnRestore} from './account-retirement';
import {validObservedLinkState,validPeriodicLinkState} from './periodic-link-state';
import {capturePublicationSnapshots,publicationReadSource} from './publication-snapshot';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Account, Channel, ChannelMetric, Event, Mailbox, Settings, Site, SiteAccountBinding, Task } from '../shared/types';
import {productIndexTaskIdentity,validProductIndexAccount} from './product-index-publication';
import {productIndexPublicUrl} from '../integrations/product-index';
import {tantivePublicUrl,validTantiveIntent} from '../integrations/tantive';
import {tantiveDraftIdentity} from '../integrations/tantive-publisher';
import {agentboardHash} from '../integrations/agentboard';
import {assertSiteOriginMigrationState,assertSiteOriginMigrationTransition,type SiteOriginMigration} from './site-origin-migration';
import {assertOneReviewRetryTransition} from './one-review-retry';
import {assertTheThingsTransition,type TheThingsOpaqueProgressWrite} from './thethings-publication';
import {carcinusAccountMatchesTask,carcinusSiteIdentity,carcinusTaskIdentity,validCarcinusAccount,carcinusPublicationTesting} from './carcinus-publication';
import {validCarcinusExistingAccount,validCarcinusExistingStateReceipt} from './carcinus-existing';
import {createSynthfolkPlannedInput,synthfolkTaskIdentity,validSynthfolkAccount} from '../integrations/synthfolk-publisher';
import {synthfolkProfileUrl,synthfolkRegistrationRequest} from '../integrations/synthfolk';
import {agentsWikiTaskIdentity,validAgentsWikiAccount} from '../integrations/agentswiki-publisher';
import {validAgentsWikiPublicDisclosure,validAgentsWikiArticleEtag} from '../integrations/agentswiki';
import {agentsGatherPublicUrl,agentsGatherRequest,validAgentsGatherIntent} from '../integrations/agentsgather';
import {agentsGatherTaskIdentity} from '../integrations/agentsgather-publisher';
import {migrateTaskReasons} from './task-reason-migration';
import {HUMAN_ACTION_MESSAGES, safeHumanActionUrl} from '../shared/human-action';
import type {ChannelTermsCache} from './article-evidence';

export interface State {reviewDefaultsVersion?:1;/** 1.2.40 brought back Telegraph referral reminders dismissed while their ownership check was broken. */telegraphReminderReset?:1;analysisUsage?:Record<string,number>;emailConsumptions?:Array<{channelId:string;recipient:string;messageIds:string[]}>;channelTermsCache?:Record<string,ChannelTermsCache>;schemaVersion?:number;sites:Site[];tasks:Task[];accounts:Account[];mailboxes:Mailbox[];accountBindings:SiteAccountBinding[];settings:Settings;events:Event[];usage:Record<string,number>;customChannels?:Channel[];channelMetrics?:Record<string,{metrics?:ChannelMetric[];authority?:Channel['authority'];traffic?:Channel['traffic']} >;siteOriginMigrations?:SiteOriginMigration[]}
/** Keep mail receipts before retiring stale waits, including direct planner writes. */
function reconcileEmailWaits(state:State):void{
  for(const task of state.tasks){
    if(task.emailConfirmation){
      const confirmation=task.emailConfirmation;
      recordMailConsumption(state,task.channelId,confirmation.wait.recipient,confirmation.messageId);
      if(task.status!=='needs_input'||task.checkpoint!=='email_confirmation'||task.humanAction?.kind!=='email_confirmation')task.emailConfirmation=undefined;
    }
    const wait=task.emailWait;
    if(!wait)continue;
    task.emailWaitRegisteredAt??=wait.since;
    for(const messageId of wait.consumedMessageIds)recordMailConsumption(state,task.channelId,wait.recipient,messageId);
    if(!activeEmailWait(task))task.emailWait=undefined;
  }
}
export function defaultSettings():Settings{return {appearance:'system',provider:'codex',codexPath:'codex',claudePath:'claude',model:'',reasoningEffort:undefined,articleReviewMode:'ai',dailyAnalysisAiLimit:10,preferredBrowser:'system',apiBase:'https://api.openai.com/v1',hasApiKey:false,hasAhrefsKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},channelTrials:{},mail:{host:'imap.gmail.com',port:993,user:'',secure:true,hasPassword:false}}}
export function emptyState():State{
  const state:State={schemaVersion:3,reviewDefaultsVersion:1,telegraphReminderReset:1,analysisUsage:{},channelTermsCache:{},sites:[],tasks:[],accounts:[],mailboxes:[],accountBindings:[],settings:defaultSettings(),events:[],usage:{},customChannels:[],channelMetrics:{},siteOriginMigrations:[]};
  // New stores are already migrated, including channels with no historical task.
  // Reopening or restoring them must not add a different set of trial markers.
  migrateChannelTrials(state,CHANNELS);
  return state;
}

const SHARE_HASH=/^[a-f0-9]{64}$/;
const SHARE_OPERATION=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHARE_SLUG=/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const shareDraftHash=(task:Task)=>task.draft?createHash('sha256').update(JSON.stringify({title:task.draft.title,description:task.draft.description,body:task.draft.body})).digest('hex'):undefined;
const shareSiteHash=(site:Pick<Site,'id'|'domain'|'url'>)=>createHash('sha256').update(JSON.stringify({id:site.id,domain:site.domain,url:site.url})).digest('hex');
const sharePublicUrl=(slug:string)=>`https://${slug}.shareyourhtml.com`;

function tantiveIdentity(task:Task){const value=task.tantive;return value&&JSON.stringify({requestId:value.requestId,name:value.name,title:value.title,room:value.room,body:value.body,bodyHash:value.bodyHash,bodyBytes:value.bodyBytes,requestHash:value.requestHash,createdAt:value.createdAt})}
function assertTantiveTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImport=false){const order={intent:0,preview_response:1,publish_unknown:2,api_receipt:3,published:4} as const;for(const storedTask of next.tasks){const currentSite=next.sites.find(value=>value.id===storedTask.siteId),{task,site}=storedTask.submittedAt&&currentSite?publicationReadSource(storedTask,currentSite):{task:storedTask,site:currentSite};const receipt=task.tantive;if(!receipt)continue;const draft=site&&tantiveDraftIdentity(task,site),intent={requestId:receipt.requestId,name:receipt.name,title:receipt.title,room:receipt.room,body:receipt.body,bodyHash:receipt.bodyHash,bodyBytes:receipt.bodyBytes,requestHash:receipt.requestHash,createdAt:receipt.createdAt},cipher=nextCiphers[`publication:${task.id}`];if(task.channelId!=='tantive'||task.sourceDomain!=='tantive.space'||task.accountId||!site||!draft||draft.name!==receipt.name||draft.title!==receipt.title||draft.room!==receipt.room||draft.body!==receipt.body||!validTantiveIntent(intent)||task.submittedAt!==receipt.createdAt||!cipher)throw Error('Tantive 原稿、请求标识或加密事务无效');if(receipt.stage==='api_receipt'||receipt.stage==='published'){if(!receipt.messageId||receipt.messageId!==receipt.rootId||task.publicUrl!==tantivePublicUrl(receipt.rootId))throw Error('Tantive 公开返回记录不一致')}else if(receipt.messageId||receipt.rootId||task.publicUrl)throw Error('Tantive 未确认事务不能附带外链标识')}
  for(const before of previous.tasks){if(!before.tantive)continue;const after=next.tasks.find(value=>value.id===before.id),beforeCipher=previousCiphers[`publication:${before.id}`],afterCipher=nextCiphers[`publication:${before.id}`];if(!after?.tantive||tantiveIdentity(after)!==tantiveIdentity(before)||order[after.tantive.stage]<order[before.tantive.stage]||!afterCipher||before.tantive.messageId!==undefined&&after.tantive.messageId!==before.tantive.messageId||before.tantive.rootId!==undefined&&after.tantive.rootId!==before.tantive.rootId)throw Error('Tantive 原请求标识不能删除、替换或回退');if(!allowImport&&before.tantive.stage===after.tantive.stage&&beforeCipher!==afterCipher&&!(before.tantive.stage==='publish_unknown'&&before.checkpoint==='tantive_publish_submitting'&&after.checkpoint==='tantive_publish_response'))throw Error('Tantive 同阶段密文不能替换')}}

function shareClaimIdentity(task:Task):string|undefined{
  const claim=task.shareYourHtml;if(!claim)return;
  return JSON.stringify({operationId:claim.operationId,slug:claim.slug,sourceHash:claim.sourceHash,requestHash:claim.requestHash,createdAt:claim.createdAt,requestedExpiry:claim.requestedExpiry,publicVerification:claim.publicVerification,reviewedDraftRevision:claim.reviewedDraftRevision,reviewedDraftHash:claim.reviewedDraftHash,siteId:claim.siteId,siteIdentityHash:claim.siteIdentityHash});
}

const exactShareDate=(value:string|undefined)=>!!value&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const shareReadbackRel=(task:Task)=>[...new Set((task.shareYourHtmlReadback?.targetLinks??[]).flatMap(link=>link.rel))].sort().join(' ');
function assertShareClaimState(state:State,ciphers:Record<string,string>):void{
  const operations=new Set<string>(),slugs=new Set<string>();
  for(const stored of state.tasks){
    const currentSite=state.sites.find(value=>value.id===stored.siteId);
    const {task,site}=currentSite?publicationReadSource(stored,currentSite):{task:stored,site:undefined};
    const claim=task.shareYourHtml;if(!claim){if(task.shareYourHtmlReadback)throw Error('ShareYourHTML 检查证据缺少永久返回记录');continue}
    const key='publication:'+task.id,cipher=ciphers[key],readback=task.shareYourHtmlReadback;
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
        throw Error('ShareYourHTML 待确认声明不能附带外链记录或编辑密钥');
      continue;
    }
    if(claim.stage!=='api_receipt'||claim.siteIdentityHash!==shareSiteHash(site)||claim.reviewedDraftHash!==shareDraftHash(task)
      ||claim.reviewedDraftRevision!==(task.draftRevision??0)||task.publicUrl!==sharePublicUrl(claim.slug)
      ||task.checkpoint!=='shareyourhtml_api_receipt'||typeof cipher!=='string'||!cipher)
      throw Error('ShareYourHTML 平台返回记录与加密编辑密钥必须原子保留');
    if(validObservedLinkState(task))continue;
    if(!readback){
      if(task.status!=='review'||task.health!=='pending'||task.verifiedAt!==undefined||task.firstLiveAt!==undefined
        ||task.linkCheck!==undefined||task.linkRel!==undefined||task.publicationMethod!==undefined||task.lastCheckedAt!==undefined
        ||task.nextCheckAt!==undefined||task.lostAt!==undefined||task.reviewKind!==undefined||task.consecutiveMissing!==undefined)
        throw Error('ShareYourHTML 待核查返回记录状态无效');
      continue;
    }
    const checked=Date.parse(readback.checkedAt),next=Date.parse(task.nextCheckAt??''),target=task.topicUrl??site.url;
    const periodic=validPeriodicLinkState(task,readback.checkedAt);
    if(!Number.isFinite(checked)||new Date(checked).toISOString()!==readback.checkedAt||!periodic&&task.lastCheckedAt!==readback.checkedAt
      ||!Number.isFinite(next)||next<=checked||readback.targetLinks.length>32
      ||readback.targetLinks.some(link=>link.href!==target||link.rel.length>32||new Set(link.rel).size!==link.rel.length||link.rel.some(token=>token.length>64||!/^[a-z0-9_-]+$/.test(token)))
      ||readback.indexing.directives.length>64||readback.indexing.directives.some(value=>value.length>128)
      ||new Set(readback.indexing.directives).size!==readback.indexing.directives.length)throw Error('ShareYourHTML 只读核查证据无效');
    if(periodic){
      const evidenceShape=readback.status==='visible_match'?readback.content==='visible'&&readback.targetLinks.length>0:readback.content===(readback.status==='content_mismatch'?'mismatch':readback.status==='content_hidden'?'hidden':'unknown')&&!readback.targetLinks.length;
      if(!evidenceShape)throw Error('ShareYourHTML 原核查证据无效');
      continue;
    }
    if(readback.status==='visible_match'){
      if(readback.content!=='visible'||!readback.targetLinks.length||task.status!=='live'||task.health!=='healthy'||task.linkCheck!=='found'
        ||task.publicationMethod!=='client'||!exactShareDate(task.firstLiveAt)||!exactShareDate(task.verifiedAt)
        ||task.verifiedAt!==readback.checkedAt||Date.parse(task.firstLiveAt!)>Date.parse(task.verifiedAt!)||normalizeChannelLinkRel(task.linkRel)!==normalizeChannelLinkRel(shareReadbackRel(task))
        ||task.lostAt!==undefined||task.reviewKind!==undefined||task.consecutiveMissing!==0)throw Error('ShareYourHTML 生效状态与检查证据不一致');
    }else{
      if(readback.content!==(readback.status==='content_mismatch'?'mismatch':readback.status==='content_hidden'?'hidden':'unknown')
        ||readback.targetLinks.length)throw Error('ShareYourHTML 非生效证据内容无效');
      if(task.firstLiveAt){
        if(!exactShareDate(task.verifiedAt)||Date.parse(task.firstLiveAt)>Date.parse(task.verifiedAt!)||Date.parse(task.verifiedAt!)>checked||task.publicationMethod!=='client')throw Error('ShareYourHTML 历史生效状态无效');
        const absent=readback.status==='content_mismatch'||readback.status==='content_hidden';
        if(absent?(!['live','needs_input'].includes(task.status)||task.health!=='missing'||task.linkCheck!=='absent'||!exactShareDate(task.lostAt)||!!task.reviewKind&&task.reviewKind!=='lost_link'||(task.consecutiveMissing??0)<1)
          :(!['live','needs_input'].includes(task.status)||task.health!=='unknown'||!['unreachable','invalid'].includes(task.linkCheck??'')))
          throw Error('ShareYourHTML 复查状态与证据不一致');
      }else if(task.status!=='review'||!['pending','unknown'].includes(task.health??'')||!['absent','unreachable','invalid'].includes(task.linkCheck??'')
        ||task.verifiedAt!==undefined||task.publicationMethod!==undefined||task.lostAt!==undefined||task.reviewKind!==undefined)
        throw Error('ShareYourHTML 初次核查失败状态无效');
    }
  }
}
function assertShareClaimTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false,strictCurrentBinding=false):void{
  assertTantiveTransition(previous,next,previousCiphers,nextCiphers,allowImportedReceipt);
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
    if(existingCipher!==undefined&&nextCiphers[key]!==existingCipher)throw Error('ShareYourHTML 已保存的加密编辑密钥不能删除或替换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Katbin 单次发布计划或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Katbin 网站标识不能更换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('MDShare 单次发布计划或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('MDShare 网站标识不能更换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('PasteMyst 单次发布计划或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('PasteMyst 网站标识不能更换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('PST.RS 单次发布计划、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('PST.RS 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('PST.RS 加密原始响应不能删除或替换');
  }
}

function assertBerrryTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='berrry');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Berrry 只能保留一个发布账号');
  const accountOrder={key_ready:0,challenge_pending:1,challenge:2,solve_pending:3,solve_response:4,signin_pending:5,ready:6};
  for(const account of accounts){
    const proof=account.berrry,key=`account:${account.id}`,cipher=nextCiphers[key];
    const ready=proof?.stage==='ready';
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||account.source!=='generated'||!account.hasPassword||!cipher||!/^berrry_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.username!==account.username||!/^[a-f0-9]{64}$/.test(proof.publicKey)||!/^[a-f0-9]{64}$/.test(proof.keyFingerprint)||proof.challengeRenewals!==undefined&&proof.challengeRenewals!==1||ready!==(account.status==='registered')||ready&&(!/^[a-f0-9]{64}$/.test(proof.tokenFingerprint??'')||!proof.tokenExpiresAt||!proof.checkedAt))throw Error('Berrry 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='berrry');
    if(before?.berrry){const prior=before.berrry;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.username!==proof.username||prior.publicKey!==proof.publicKey||prior.keyFingerprint!==proof.keyFingerprint||(proof.challengeRenewals??0)<(prior.challengeRenewals??0)||(proof.challengeRenewals??0)>(prior.challengeRenewals??0)&&!(prior.stage==='challenge'&&proof.stage==='challenge_pending'&&!prior.challengeRenewals&&proof.challengeRenewals===1)||accountOrder[proof.stage]<accountOrder[prior.stage]&&!(prior.stage==='ready'&&proof.stage==='signin_pending')&&!(prior.stage==='challenge'&&proof.stage==='challenge_pending'&&!prior.challengeRenewals&&proof.challengeRenewals===1))throw Error('Berrry 原发布账号不能替换或回退');if(previousCiphers[key]===undefined||nextCiphers[key]===undefined)throw Error('Berrry 加密的发布账号信息不能删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='berrry'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Berrry 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.berrry;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.berrry,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='berrry'||after.sourceDomain!=='berrry.app'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.berrryInput)!==JSON.stringify(before.berrryInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.username!==current.username||prior.subdomain!==current.subdomain||prior.title!==current.title||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.version!==undefined&&current.version!==prior.version||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||!nextCiphers[key])throw Error('Berrry 单次发布计划、原稿或密文不能删除、替换或回退');
    if(previousCiphers[key]!==nextCiphers[key]&&!(prior.stage==='submitting'&&current.stage==='opaque_response'))throw Error('Berrry 已保存的发布内容的加密记录不能替换');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Berrry 网站标识不能更换');
  }
  for(const task of next.tasks.filter(value=>value.berrry&&!previous.tasks.some(before=>before.id===value.id&&before.berrry))){const receipt=task.berrry!;if(task.channelId!=='berrry'||task.sourceDomain!=='berrry.app'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!task.draft||!task.berrryInput||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('Berrry 新发布必须从已加密的固定提交信息开始')}
}

function assertSwarmMemoTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='swarmmemo');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('SwarmMemo 只能保留一个本地签名发布账号');
  for(const account of accounts){
    const proof=account.swarmMemo,key=`account:${account.id}`,cipher=nextCiphers[key];
    if(!proof||proof.version!==1||proof.stage!=='ready'||account.email!==''||account.username!==proof.fingerprint||account.credentialKind!=='api_token'||account.source!=='generated'||account.status!=='registered'||!account.hasPassword||account.registrationAttempts!==0||!cipher||!/^[a-f0-9]{64}$/.test(proof.fingerprint)||!/^[A-Za-z0-9_-]{43}$/.test(proof.publicKey)||!Number.isFinite(Date.parse(proof.checkedAt))||new Date(proof.checkedAt).toISOString()!==proof.checkedAt)throw Error('SwarmMemo 本地发布账号与加密私钥不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='swarmmemo');
    if(before?.swarmMemo&&(before.username!==account.username||before.swarmMemo.fingerprint!==proof.fingerprint||before.swarmMemo.publicKey!==proof.publicKey||before.swarmMemo.checkedAt!==proof.checkedAt||previousCiphers[key]!==cipher))throw Error('SwarmMemo 原 Ed25519 发布账号或密文不能替换');
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='swarmmemo'))if(!next.accounts.some(account=>account.id===before.id))throw Error('SwarmMemo 原 Ed25519 发布账号不能删除');
  const order={intent:0,submitting:1,opaque_response:2,api_receipt:3,published:4};
  for(const before of previous.tasks){
    const prior=before.swarmMemo;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.swarmMemo,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='swarmmemo'||after.sourceDomain!=='swarmmemo.com'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.swarmMemoInput)!==JSON.stringify(before.swarmMemoInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.fingerprint!==current.fingerprint||prior.requestId!==current.requestId||prior.targetUrl!==current.targetUrl||prior.sourceHash!==current.sourceHash||prior.bodySha256!==current.bodySha256||prior.canonicalSha256!==current.canonicalSha256||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||order[current.stage]<order[prior.stage]||prior.messageId!==undefined&&current.messageId!==prior.messageId||prior.acceptedAt!==undefined&&current.acceptedAt!==prior.acceptedAt||prior.duplicate!==undefined&&current.duplicate!==prior.duplicate||prior.readBack!==undefined&&current.readBack!==prior.readBack||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||!nextCiphers[key]||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('SwarmMemo 单次发布计划、审核稿或密文不能删除、替换或回退');
    const changed=previousCiphers[key]!==nextCiphers[key];if(changed&&!((prior.stage==='intent'&&current.stage==='submitting')||(prior.stage==='submitting'&&current.stage==='opaque_response')))throw Error('SwarmMemo 已保存的发布内容的加密记录不能替换');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('SwarmMemo 网站标识不能更换');
  }
  for(const task of next.tasks.filter(value=>value.swarmMemo&&!previous.tasks.some(before=>before.id===value.id&&before.swarmMemo))){const receipt=task.swarmMemo!;if(task.channelId!=='swarmmemo'||task.sourceDomain!=='swarmmemo.com'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!task.draft||!task.swarmMemoInput||!allowImportedReceipt&&receipt.stage!=='intent'||!nextCiphers[`publication:${task.id}`])throw Error('SwarmMemo 新发布必须从已加密的固定提交信息开始')}
}

const AGENTBOARD_HASH=/^[a-f0-9]{64}$/,AGENTBOARD_AGENT=/^agt_[a-f0-9]{16}$/,AGENTBOARD_THREAD=/^thr_[a-f0-9]{16}$/,AGENTBOARD_BOARD=/^brd_[a-f0-9]{16}$/,AGENTBOARD_HANDLE=/^[a-z0-9][a-z0-9_-]{1,79}$/;
const exactAgentboardDate=(value:string|undefined)=>{if(!value)return false;const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value};
const agentboardPublicTarget=(value:string)=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&url.hostname.includes('.')&&!url.hostname.endsWith('.local')}catch{return false}};
function validAgentboardReviewedTask(task:Task,site:Site):boolean{
  const subject=task.agentboardSubject,input=task.agentboardInput,draft=task.draft,target=task.topicUrl??site.url;if(!subject||!input||!draft||subject.version!==1||input.version!==1||JSON.stringify(subject)!==JSON.stringify({version:input.version,mode:input.mode,board:input.board,boardId:input.boardId,agent:input.agent})||input.targetUrl!==target||input.titleSha256!==agentboardHash(draft.title)||input.bodySha256!==agentboardHash(draft.body)||input.draftRevision!==(task.draftRevision??0)||!AGENTBOARD_BOARD.test(input.boardId)||!agentboardPublicTarget(input.targetUrl)||!agentboardPublicTarget(input.agent.homepage)||input.agent.name!==input.agent.name.trim()||input.agent.name.length<2||input.agent.name.length>80||input.agent.description!==input.agent.description.trim()||input.agent.description.length<1||input.agent.description.length>1000||input.agent.operatorName!==input.agent.operatorName.trim()||input.agent.operatorName.length<1||input.agent.operatorName.length>120)return false;
  if(input.mode==='introduction'){if(input.board!=='introductions')return false}else if(input.board==='introductions'||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(input.board))return false;
  if(input.approval.method!=='ai')return false;const review=task.articleReview;return exactAgentboardDate(input.approval.reviewedAt)&&AGENTBOARD_HASH.test(input.approval.contentHash)&&AGENTBOARD_HASH.test(input.approval.contextHash)&&review?.status==='passed'&&review.reviewedAt===input.approval.reviewedAt&&review.contentHash===input.approval.contentHash&&review.contextHash===input.approval.contextHash&&task.articleApprovedAt===input.approval.reviewedAt;
}
function agentboardReceiptIdentity(task:Task){const value=task.agentboard;return value&&JSON.stringify({operationId:value.operationId,mode:value.mode,accountId:value.accountId,requestKey:value.requestKey,targetUrl:value.targetUrl,board:value.board,boardId:value.boardId,sourceHash:value.sourceHash,requestHash:value.requestHash,createdAt:value.createdAt})}
function agentboardAccountIdentity(account:Account){const value=account.agentboard;return value&&JSON.stringify({version:value.version,operationId:value.operationId,requestHash:value.requestHash,name:value.name,description:value.description,homepage:value.homepage,operatorName:value.operatorName,introductionTaskId:value.introductionTaskId})}
function assertAgentboardTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false,expectedCiphers:Record<string,string|undefined>={}):void{
  const accounts=next.accounts.filter(account=>account.channelId==='agentboard');if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Agentboard 只能保留一个固定发布账号');
  if(next.accounts.some(account=>account.channelId!=='agentboard'&&!!account.agentboard))throw Error('Agentboard 发布账号不能附加到其他平台');
  const accountOrder={intent:0,receipt:1,ready:2} as const;
  for(const account of accounts){
    const proof=account.agentboard,key=`account:${account.id}`,cipher=nextCiphers[key],intro=proof&&next.tasks.find(task=>task.id===proof.introductionTaskId),hasReceipt=proof?.stage==='receipt'||proof?.stage==='ready';
    if(!proof||proof.version!==1||account.email!==''||account.source!=='generated'||account.credentialKind!=='api_token'||account.registrationAttempts!==1||proof.operationId!==`agentboard_register_${account.id.replace(/-/g,'').toLowerCase()}`||!AGENTBOARD_HASH.test(proof.requestHash)||!proof.name||proof.name!==proof.name.trim()||proof.name.length>80||!proof.description||proof.description!==proof.description.trim()||proof.description.length>1000||!proof.operatorName||proof.operatorName!==proof.operatorName.trim()||proof.operatorName.length>120||!agentboardPublicTarget(proof.homepage)||!intro?.agentboard||intro.agentboard.mode!=='introduction'||intro.agentboard.accountId!==account.id||intro.accountId!==account.id)throw Error('Agentboard 发布账号与唯一首帖操作记录不一致');
    if(!hasReceipt){if(cipher||account.username!=='agentboard-registration-pending'||account.displayName!==proof.name||account.status!=='unknown'||account.hasPassword||proof.agentId||proof.handle||proof.agentUrl||proof.credentialFingerprint||proof.introductionThreadId||proof.checkedAt||account.publicationUrl||account.verifiedAt)throw Error('Agentboard 未确认的发布账号不能附带登录信息或外链记录')}else if(!cipher||account.username!==proof.handle||account.displayName!==proof.name||account.status!=='registered'||!account.hasPassword||!AGENTBOARD_AGENT.test(proof.agentId??'')||!AGENTBOARD_HANDLE.test(proof.handle??'')||proof.agentUrl!==`https://www.agentboard.ai/a/${proof.handle}`||!AGENTBOARD_HASH.test(proof.credentialFingerprint??'')||!AGENTBOARD_THREAD.test(proof.introductionThreadId??'')||account.publicationUrl!==proof.agentUrl||proof.stage==='ready'&&(!exactAgentboardDate(proof.checkedAt)||account.verifiedAt!==proof.checkedAt)||proof.stage==='receipt'&&(proof.checkedAt!==undefined||account.verifiedAt!==undefined))throw Error('Agentboard 已返回的发布账号与加密登录信息不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='agentboard');if(before?.agentboard){const prior=before.agentboard;if(agentboardAccountIdentity(before)!==agentboardAccountIdentity(account)||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.agentId!==undefined&&proof.agentId!==prior.agentId||prior.handle!==undefined&&proof.handle!==prior.handle||prior.agentUrl!==undefined&&proof.agentUrl!==prior.agentUrl||prior.credentialFingerprint!==undefined&&proof.credentialFingerprint!==prior.credentialFingerprint||prior.introductionThreadId!==undefined&&proof.introductionThreadId!==prior.introductionThreadId||prior.checkedAt!==undefined&&proof.checkedAt!==prior.checkedAt)throw Error('Agentboard 原发布账号、主页或登录信息关联不能替换或回退');const changed=previousCiphers[key]!==cipher;if(changed&&!(prior.stage==='intent'&&proof.stage==='receipt'&&previousCiphers[key]===undefined&&!!cipher))throw Error('Agentboard 加密的发布账号信息只能在首帖返回记录中原子建立')}
    else if(!allowImportedReceipt&&proof.stage!=='intent')throw Error('Agentboard 新发布账号必须从无登录信息的操作记录开始');
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='agentboard'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Agentboard 原发布账号不能删除');
  const tasks=next.tasks.filter(task=>!!task.agentboard);
  const introductions=new Set<string>();
  for(const task of tasks.filter(task=>task.agentboard?.mode==='introduction')){const id=task.agentboard!.accountId;if(introductions.has(id))throw Error('Agentboard 一个项目只能保留一条 introductions 首帖');introductions.add(id);}
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3} as const;
  for(const task of tasks){
    const receipt=task.agentboard!,site=next.sites.find(value=>value.id===task.siteId),account=next.accounts.find(value=>value.id===receipt.accountId),proof=account?.agentboard,key=`publication:${task.id}`,cipher=nextCiphers[key],hasRemote=receipt.stage==='api_receipt'||receipt.stage==='published',binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='agentboard');
    if(task.channelId!=='agentboard'||task.sourceDomain!=='www.agentboard.ai'||!site||!account||task.accountId!==receipt.accountId||!account.retiredAt&&binding?.accountId!==receipt.accountId||!validAgentboardReviewedTask(task,site)||receipt.operationId!==`agentboard_publish_${task.id.replace(/-/g,'').toLowerCase()}`||receipt.requestKey!==`agentboard_${task.id.replace(/-/g,'').toLowerCase()}`||receipt.targetUrl!==task.agentboardInput!.targetUrl||receipt.mode!==task.agentboardInput!.mode||receipt.board!==task.agentboardInput!.board||receipt.boardId!==task.agentboardInput!.boardId||!AGENTBOARD_HASH.test(receipt.sourceHash)||!AGENTBOARD_HASH.test(receipt.requestHash)||!exactAgentboardDate(receipt.createdAt)||task.submittedAt!==receipt.createdAt||!cipher)throw Error('Agentboard 单次发布计划、审核原稿或加密事务无效');
    if(receipt.mode==='introduction'){if(receipt.board!=='introductions'||proof?.introductionTaskId!==task.id||proof.requestHash!==receipt.requestHash||hasRemote&&proof.introductionThreadId!==receipt.threadId||receipt.stage==='published'&&proof.stage!=='ready'||receipt.stage==='api_receipt'&&proof.stage!=='receipt'||!hasRemote&&proof.stage!=='intent')throw Error('Agentboard 首帖必须与同一发布账号和一次性登录信息一起保存')}else if(receipt.board==='introductions'||proof?.stage!=='ready'||receipt.agentId!==proof.agentId||receipt.handle!==proof.handle)throw Error('Agentboard 后续讨论必须复用已检查发布账号与非 introductions 版块');
    if(hasRemote){if(!AGENTBOARD_AGENT.test(receipt.agentId??'')||!AGENTBOARD_HANDLE.test(receipt.handle??'')||!AGENTBOARD_THREAD.test(receipt.threadId??'')||!exactAgentboardDate(receipt.remoteCreatedAt)||receipt.publicUrl!==`https://www.agentboard.ai/t/${receipt.threadId}`||task.publicUrl!==receipt.publicUrl)throw Error('Agentboard 原始主帖返回记录与公开地址不一致')}else if(receipt.threadId||receipt.remoteCreatedAt||receipt.publicUrl||task.publicUrl||receipt.mode==='introduction'&&(receipt.agentId||receipt.handle))throw Error('Agentboard 未确认远程结果不能附带主帖返回记录');
    const before=previous.tasks.find(value=>value.id===task.id&&!!value.agentboard);if(before?.agentboard){const prior=before.agentboard;if(before.siteId!==task.siteId||before.channelId!==task.channelId||before.sourceDomain!==task.sourceDomain||before.accountId!==task.accountId||JSON.stringify(before.draft)!==JSON.stringify(task.draft)||before.draftRevision!==task.draftRevision||before.topicUrl!==task.topicUrl||JSON.stringify(before.agentboardSubject)!==JSON.stringify(task.agentboardSubject)||JSON.stringify(before.agentboardInput)!==JSON.stringify(task.agentboardInput)||before.submittedAt!==task.submittedAt||agentboardReceiptIdentity(before)!==agentboardReceiptIdentity(task)||taskOrder[receipt.stage]<taskOrder[prior.stage]||prior.agentId!==undefined&&receipt.agentId!==prior.agentId||prior.handle!==undefined&&receipt.handle!==prior.handle||prior.threadId!==undefined&&receipt.threadId!==prior.threadId||prior.remoteCreatedAt!==undefined&&receipt.remoteCreatedAt!==prior.remoteCreatedAt||prior.publicUrl!==undefined&&receipt.publicUrl!==prior.publicUrl||before.firstLiveAt&&task.firstLiveAt!==before.firstLiveAt)throw Error('Agentboard 原稿、发布账号、版块或发布记录不能替换或回退');const changed=previousCiphers[key]!==cipher,progress=prior.stage==='opaque_response'&&receipt.stage==='opaque_response'&&Object.hasOwn(expectedCiphers,key)&&expectedCiphers[key]===previousCiphers[key];if(changed&&!(prior.stage==='submitting'&&receipt.stage==='opaque_response')&&!progress)throw Error('Agentboard 原始响应密文只能按精确前序版本单调封存')}
    else if(!allowImportedReceipt&&receipt.stage!=='submitting')throw Error('Agentboard 新发布必须从已加密的 submitting 提交信息开始');
  }
}

function assertAgentHowTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  assertAgentsWikiTransition(previous,next,previousCiphers,nextCiphers,allowImportedReceipt);
  const accounts=next.accounts.filter(account=>account.channelId==='agenthow');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('AgentHow 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.agentHow,key=`account:${account.id}`,cipher=nextCiphers[key];
    const ready=proof?.stage==='ready';
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||account.source!=='generated'||!account.hasPassword||!cipher||!/^agenthow_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.label!==account.username||ready!== (account.status==='registered')||ready&&(!/^a_[a-f0-9]{32}$/.test(proof.actorId??'')||!/^[a-f0-9]{64}$/.test(proof.keyFingerprint??'')||!proof.checkedAt))throw Error('AgentHow 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='agenthow');
    if(before?.agentHow){const prior=before.agentHow;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.label!==proof.label||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.actorId!==undefined&&proof.actorId!==prior.actorId||prior.keyFingerprint!==undefined&&proof.keyFingerprint!==prior.keyFingerprint)throw Error('AgentHow 原发布账号不能替换或回退');if(prior.stage===proof.stage&&previousCiphers[key]!==nextCiphers[key]||prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('AgentHow 加密的发布账号信息不能在同阶段替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='agenthow'))if(!next.accounts.some(account=>account.id===before.id))throw Error('AgentHow 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.agentHow;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.agentHow,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='agenthow'||after.sourceDomain!=='agenthow.to'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.agentHowInput)!==JSON.stringify(before.agentHowInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.actorId!==current.actorId||prior.label!==current.label||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.noteId!==undefined&&current.noteId!==prior.noteId||prior.origin!==undefined&&current.origin!==prior.origin||prior.revision!==undefined&&current.revision!==prior.revision||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||!nextCiphers[key])throw Error('AgentHow 单次发布计划、原稿或密文不能删除、替换或回退');
    if(previousCiphers[key]!==nextCiphers[key]&&!(prior.stage==='submitting'&&current.stage==='opaque_response'))throw Error('AgentHow 已保存的发布内容的加密记录不能替换');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('AgentHow 网站标识不能更换');
  }
  for(const task of next.tasks.filter(value=>value.agentHow&&!previous.tasks.some(before=>before.id===value.id&&before.agentHow))){const receipt=task.agentHow!;if(task.channelId!=='agenthow'||task.sourceDomain!=='agenthow.to'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!task.draft||!task.agentHowInput||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('AgentHow 新发布必须从已加密的固定提交信息开始')}
}

function assertSynthfolkTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImport=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='synthfolk');if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Synthfolk 只能保留一个公开发布账号');
  for(const account of next.accounts)if(account.channelId!=='synthfolk'&&account.synthfolk)throw Error('Synthfolk 发布账号信息不能附加到其他平台账号');
  const accountOrder={intent:0,opaque_response:1,unmanaged:2,ready:3};
  for(const account of accounts){
    const proof=account.synthfolk,key=`account:${account.id}`,generated=account.source==='generated',expected=`synthfolk_${generated?'register':'import'}_${account.id.replace(/-/g,'').toLowerCase()}`;
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||!account.hasPassword||!nextCiphers[key]||proof.operationId!==expected||account.username!==proof.handle||account.displayName!==proof.name)throw Error('Synthfolk 公开发布账号与加密事务不一致');
    try{const request=synthfolkRegistrationRequest({handle:proof.handle,name:proof.name,headline:proof.headline,about:proof.about,operator:proof.operator,website:proof.website,availability:proof.availability,skills:proof.skills},proof.website);if(request.requestHash!==proof.requestHash||request.sourceHash!==proof.sourceHash)throw Error()}catch{throw Error('Synthfolk 公开资料发布账号无效')}
    if(proof.stage==='ready'){if(!validSynthfolkAccount(account))throw Error('Synthfolk 已连接公开发布账号无效')}
    else if(!generated||!['draft','unknown'].includes(account.status)||(account.registrationAttempts??0)!==1||proof.keyFingerprint)throw Error('Synthfolk 未确认注册状态无效');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='synthfolk');if(before?.synthfolk){const prior=before.synthfolk;for(const field of ['operationId','requestHash','sourceHash','handle','name','headline','about','operator','website','availability','keyFingerprint'] as const)if(prior[field]!==undefined&&JSON.stringify(proof[field])!==JSON.stringify(prior[field]))throw Error('Synthfolk 原公开发布账号不能替换');if(JSON.stringify(proof.skills)!==JSON.stringify(prior.skills)||account.source!==before.source||account.username!==before.username||account.createdAt!==before.createdAt||accountOrder[proof.stage]<accountOrder[prior.stage])throw Error('Synthfolk 原公开发布账号不能替换或回退');if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('Synthfolk 已连接 API key 密文不能替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='synthfolk'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Synthfolk 原公开发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,unmanaged:2,api_receipt:3,published:4};
  for(const storedTask of next.tasks){
    const currentSite=next.sites.find(value=>value.id===storedTask.siteId);
    const {task,site}=storedTask.submittedAt&&currentSite?publicationReadSource(storedTask,currentSite):{task:storedTask,site:currentSite};
    if(task.channelId!=='synthfolk'&&(task.synthfolk||task.synthfolkInput))throw Error('Synthfolk 审核稿或返回记录不能附加到其他平台任务');
    if(task.channelId!=='synthfolk'||!task.synthfolkInput)continue;const account=accounts.find(value=>value.id===task.synthfolkInput!.accountId),planned=site&&createSynthfolkPlannedInput(task,site,task.synthfolkInput.accountId,validSynthfolkAccount(account)?account:undefined),{approval,...stored}=task.synthfolkInput,{approval:_plannedApproval,...expected}=planned??({} as typeof task.synthfolkInput);if(!site||!planned||JSON.stringify(stored)!==JSON.stringify(expected)||approval!==undefined&&!synthfolkTaskIdentity(task,site,account))throw Error('Synthfolk 当前完整资料、目标与 AI 审核绑定无效');
    const receipt=task.synthfolk;if(!receipt)continue;const identity=synthfolkTaskIdentity(task,site,account),pending=['submitting','opaque_response'].includes(receipt.stage),ready=['api_receipt','published'].includes(receipt.stage),unmanaged=receipt.stage==='unmanaged',binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='synthfolk');
    const registration=receipt.operationId===`synthfolk_register_${receipt.accountId.replace(/-/g,'').toLowerCase()}`,reuse=receipt.operationId===`synthfolk_reuse_${task.id.replace(/-/g,'').toLowerCase()}`;
    if(!identity||task.sourceDomain!=='synthfolk.ai'||task.accountId!==receipt.accountId||receipt.accountId!==task.synthfolkInput.accountId||!registration&&!reuse||reuse&&receipt.stage!=='published'||receipt.handle!==identity.input.profile.handle||receipt.targetUrl!==identity.input.targetUrl||receipt.sourceHash!==identity.sourceHash||receipt.requestHash!==identity.requestHash||task.submittedAt!==receipt.createdAt||!account||!nextCiphers[`account:${receipt.accountId}`]||pending&&(!registration||!['intent','opaque_response'].includes(account.synthfolk?.stage??''))||ready&&(!validSynthfolkAccount(account)||!account.retiredAt&&binding?.accountId!==account.id)||unmanaged&&(!registration||account.synthfolk?.stage!=='unmanaged')||ready!==!!receipt.publicUrl||receipt.publicUrl!==undefined&&receipt.publicUrl!==synthfolkProfileUrl(receipt.handle)||receipt.publicUrl!==undefined&&task.publicUrl!==receipt.publicUrl||receipt.stage==='published'!==!!receipt.acceptanceCheckedAt||receipt.stage==='published'&&receipt.linkRel===undefined)throw Error('Synthfolk 单次注册前记录、发布账号复用或验收返回记录无效');
  }
  for(const before of previous.tasks){const prior=before.synthfolk;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.synthfolk;if(!after||!current||after.channelId!=='synthfolk'||after.sourceDomain!=='synthfolk.ai'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.synthfolkInput)!==JSON.stringify(before.synthfolkInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.handle!==current.handle||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.targetUrl!==current.targetUrl||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.acceptanceCheckedAt!==undefined&&current.acceptanceCheckedAt!==prior.acceptanceCheckedAt||prior.linkRel!==undefined&&current.linkRel!==prior.linkRel||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Synthfolk 单次注册计划、审核资料或返回记录不能删除、替换或回退');const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Synthfolk 网站标识不能更换');const key=`account:${prior.accountId}`,cipherChanged=previousCiphers[key]!==nextCiphers[key],evidenceOnly=prior.stage===current.stage&&(!next.settings.autoRun||['skipped','expired'].includes(after.status)||after.status!=='running'),progress=prior.stage==='submitting'&&['submitting','opaque_response','api_receipt'].includes(current.stage)||prior.stage==='opaque_response'&&['opaque_response','api_receipt'].includes(current.stage);if(cipherChanged&&!allowImport&&!evidenceOnly&&!progress)throw Error('Synthfolk 已保存注册密文不能删除或替换')}
}

function assertAgentsWikiTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='agentswiki');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Agents Wiki 只能保留一个发布账号');
  for(const account of next.accounts)if(account.channelId!=='agentswiki'&&account.agentsWiki)throw Error('Agents Wiki 发布账号信息不能附加到其他平台账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.agentsWiki,key=`account:${account.id}`,cipher=nextCiphers[key],generated=account.source==='generated',expectedOperation=`agentswiki_${generated?'register':'import'}_${account.id.replace(/-/g,'').toLowerCase()}`;
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||!account.hasPassword||!cipher||proof.operationId!==expectedOperation||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.ruleVersion!=='2026-10-13'||proof.publicationRights!==true||proof.name!==account.username||!validAgentsWikiPublicDisclosure(proof.publicDisclosure))throw Error('Agents Wiki 发布账号与加密事务不一致');
    if(proof.stage==='ready'){if(!validAgentsWikiAccount(account))throw Error('Agents Wiki 已连接的发布账号无效')}
    else if(!generated||!['draft','unknown'].includes(account.status)||(account.registrationAttempts??0)!==1||proof.remoteAccountId||proof.remoteCreatedAt||proof.role||proof.keyFingerprint||proof.checkedAt)throw Error('Agents Wiki 未确认注册状态无效');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='agentswiki');
    if(before?.agentsWiki){
      const prior=before.agentsWiki;
      for(const field of ['operationId','requestHash','ruleVersion','publicationRights','name','publicDisclosure','remoteAccountId','remoteCreatedAt','role','keyPrefix','keyFingerprint'] as const)if(prior[field]!==undefined&&proof[field]!==prior[field])throw Error('Agents Wiki 原发布账号不能替换');
      if(account.source!==before.source||account.username!==before.username||account.createdAt!==before.createdAt||accountOrder[proof.stage]<accountOrder[prior.stage])throw Error('Agents Wiki 原发布账号不能替换或回退');
      if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('Agents Wiki 已连接 API key 密文不能替换或删除');
    }
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='agentswiki'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Agents Wiki 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const storedTask of next.tasks){
    const currentSite=next.sites.find(value=>value.id===storedTask.siteId);
    const {task,site}=storedTask.submittedAt&&currentSite?publicationReadSource(storedTask,currentSite):{task:storedTask,site:currentSite};
    if(task.channelId!=='agentswiki'&&task.agentsWiki)throw Error('Agents Wiki 返回记录不能附加到其他平台任务');
    const taskAccount=accounts.find(value=>value.id===task.accountId);
    if(task.channelId==='agentswiki'&&task.agentsWikiInput&&!agentsWikiTaskIdentity(task,site,taskAccount))throw Error('Agents Wiki 当前稿件、发布账号与 AI 审核绑定无效');
    const receipt=task.agentsWiki;if(!receipt)continue;
    const account=accounts.find(value=>value.id===receipt.accountId),binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='agentswiki'),identity=agentsWikiTaskIdentity(task,site,account),key=`publication:${task.id}`;
    const hasReceipt=['api_receipt','published'].includes(receipt.stage),hasAcceptance=receipt.stage==='published';
    if(task.sourceDomain!=='agents-wiki.com'||task.accountId!==receipt.accountId||!validAgentsWikiAccount(account)||!account.retiredAt&&binding?.accountId!==receipt.accountId||receipt.remoteAccountId!==account.agentsWiki.remoteAccountId||!identity||receipt.operationId!==identity.idempotencyKey||receipt.idempotencyKey!==identity.idempotencyKey||receipt.sourceHash!==identity.sourceHash||receipt.requestHash!==identity.requestHash||task.submittedAt!==receipt.createdAt||!nextCiphers[key]||hasReceipt!==!!(receipt.articleId&&receipt.etag&&receipt.revision)||hasReceipt&&(!validAgentsWikiArticleEtag(receipt.etag,receipt.articleId,receipt.revision)||!Number.isSafeInteger(receipt.revision)||receipt.revision!<1)||!hasReceipt&&(receipt.articleId||receipt.etag||receipt.revision||receipt.publicUrl)||receipt.publicUrl!==undefined&&task.publicUrl!==receipt.publicUrl||hasAcceptance!==!!receipt.acceptanceCheckedAt||hasAcceptance&&receipt.linkRel===undefined)throw Error('Agents Wiki 单次发布计划、账号、审核稿或返回记录无效');
  }
  for(const before of previous.tasks){
    const prior=before.agentsWiki;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.agentsWiki,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='agentswiki'||after.sourceDomain!=='agents-wiki.com'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.agentsWikiInput)!==JSON.stringify(before.agentsWikiInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.remoteAccountId!==current.remoteAccountId||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.articleId!==undefined&&current.articleId!==prior.articleId||prior.etag!==undefined&&current.etag!==prior.etag||prior.revision!==undefined&&current.revision!==prior.revision||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.acceptanceCheckedAt!==undefined&&current.acceptanceCheckedAt!==prior.acceptanceCheckedAt||prior.linkRel!==undefined&&current.linkRel!==prior.linkRel||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Agents Wiki 单次发布计划、审核稿或返回记录不能删除、替换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Agents Wiki 网站标识不能更换');
    const cipherChanged=previousCiphers[key]!==nextCiphers[key],evidenceOnly=prior.stage===current.stage&&['submitting','opaque_response','api_receipt'].includes(current.stage)&&(!next.settings.autoRun||['skipped','expired'].includes(after.status)),allowedCipherProgress=evidenceOnly||prior.stage==='submitting'&&['opaque_response','api_receipt'].includes(current.stage)||prior.stage==='opaque_response'&&['opaque_response','api_receipt'].includes(current.stage)||prior.stage==='api_receipt'&&current.stage==='api_receipt'&&!prior.publicUrl&&!!current.publicUrl&&prior.articleId===current.articleId&&prior.etag===current.etag&&prior.revision===current.revision;
    if(cipherChanged&&!allowedCipherProgress)throw Error('Agents Wiki 已保存的发布内容的加密记录不能删除或替换');
  }
  for(const task of next.tasks.filter(value=>value.agentsWiki&&!previous.tasks.some(before=>before.id===value.id&&before.agentsWiki))){if(!allowImportedReceipt&&task.agentsWiki?.stage!=='submitting')throw Error('Agents Wiki 新发布必须从已加密的固定提交信息开始')}
}

function assertAgentsGatherTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  if(next.accounts.some(account=>account.channelId==='agentsgather')||next.accountBindings.some(binding=>binding.channelId==='agentsgather'))throw Error('AgentsGather 是匿名平台，不应保存账号或绑定');
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3} as const;
  for(const task of next.tasks){
    if(task.channelId!=='agentsgather'&&(task.agentsGatherInput||task.agentsGather))throw Error('AgentsGather 审核绑定或返回记录不能附加到其他平台');
    if(task.channelId!=='agentsgather')continue;
    const site=next.sites.find(value=>value.id===task.siteId),identity=site&&agentsGatherTaskIdentity(task,site);
    if(task.agentsGatherInput&&!identity)throw Error('AgentsGather 最终稿、目标或 AI 复核绑定无效');
    const receipt=task.agentsGather;if(!receipt)continue;
    const intent={version:1 as const,taskId:task.id,requestId:receipt.requestId,sourceHash:receipt.sourceHash,requestHash:receipt.requestHash,createdAt:receipt.createdAt},request=identity&&agentsGatherRequest({title:identity.title,body:identity.body},receipt.requestId),hasReceipt=['api_receipt','published'].includes(receipt.stage),published=receipt.stage==='published',key=`publication:${task.id}`;
    if(task.sourceDomain!=='agentsgather.org'||task.accountId||!site||!identity||!validAgentsGatherIntent(intent)||request?.sourceHash!==receipt.sourceHash||request.requestHash!==receipt.requestHash||task.submittedAt!==receipt.createdAt||!nextCiphers[key])throw Error('AgentsGather 单次提交信息、原稿、审核或加密事务无效');
    if(hasReceipt){if(typeof receipt.postId!=='number'||!Number.isSafeInteger(receipt.postId)||receipt.postId<1||receipt.publicUrl!==agentsGatherPublicUrl(receipt.postId)||task.publicUrl!==receipt.publicUrl)throw Error('AgentsGather 平台返回记录或公开地址无效')}else if(receipt.postId!==undefined||receipt.publicUrl!==undefined||task.publicUrl!==undefined)throw Error('AgentsGather 未确认阶段不能携带公开地址');
    if(published){if(!receipt.remoteCreatedAt||!receipt.remoteUpdatedAt||!receipt.acceptedAt||typeof receipt.linkRel!=='string'||![receipt.remoteCreatedAt,receipt.remoteUpdatedAt,receipt.acceptedAt].every(value=>Number.isFinite(Date.parse(value!))&&new Date(value!).toISOString()===value)||Date.parse(receipt.remoteUpdatedAt)<Date.parse(receipt.remoteCreatedAt)||Date.parse(receipt.acceptedAt)<Date.parse(receipt.remoteCreatedAt))throw Error('AgentsGather 联合验收证据无效')}
    else if(receipt.remoteCreatedAt!==undefined||receipt.remoteUpdatedAt!==undefined||receipt.acceptedAt!==undefined||receipt.linkRel!==undefined)throw Error('AgentsGather 未发布阶段不能携带联合验收证据');
  }
  for(const before of previous.tasks){
    const prior=before.agentsGather;if(!prior)continue;const after=next.tasks.find(value=>value.id===before.id),current=after?.agentsGather,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='agentsgather'||after.sourceDomain!=='agentsgather.org'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.agentsGatherInput)!==JSON.stringify(before.agentsGatherInput)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.requestId!==current.requestId||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||order[current.stage]<order[prior.stage]||prior.postId!==undefined&&current.postId!==prior.postId||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||prior.remoteUpdatedAt!==undefined&&current.remoteUpdatedAt!==prior.remoteUpdatedAt||prior.acceptedAt!==undefined&&current.acceptedAt!==prior.acceptedAt||prior.linkRel!==undefined&&current.linkRel!==prior.linkRel||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt||!nextCiphers[key])throw Error('AgentsGather 单次提交信息、审核稿、返回记录或证据不能删除、替换或回退');
    const changed=previousCiphers[key]!==nextCiphers[key],progress=prior.stage==='submitting'&&['submitting','opaque_response','api_receipt'].includes(current.stage)||prior.stage==='opaque_response'&&['opaque_response','api_receipt'].includes(current.stage)||prior.stage==='api_receipt'&&current.stage==='api_receipt';
    if(changed&&!progress)throw Error('AgentsGather 已保存的原始响应密文不能删除或替换');
  }
  for(const task of next.tasks.filter(value=>value.agentsGather&&!previous.tasks.some(before=>before.id===value.id&&before.agentsGather)))if(!allowImportedReceipt&&task.agentsGather?.stage!=='submitting')throw Error('AgentsGather 新发布必须从提交前已加密的固定提交信息开始');
}

function assertAgentNotepadTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='agentnotepad');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Agent Notepad 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.agentNotepad,key=`account:${account.id}`,cipher=nextCiphers[key];
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||account.source!=='generated'||!/^agentnotepad_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||!cipher||proof.stage==='ready'&&(proof.agentName!==account.username||!proof.agentId||!proof.agentSlug||!/^[a-f0-9]{64}$/.test(proof.keyFingerprint??'')))throw Error('Agent Notepad 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='agentnotepad');
    if(before?.agentNotepad){const prior=before.agentNotepad;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.agentId!==undefined&&proof.agentId!==prior.agentId||prior.agentName!==undefined&&proof.agentName!==prior.agentName||prior.agentSlug!==undefined&&proof.agentSlug!==prior.agentSlug||prior.keyFingerprint!==undefined&&proof.keyFingerprint!==prior.keyFingerprint)throw Error('Agent Notepad 原发布账号不能替换或回退');if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('Agent Notepad 已连接 key 密文不能替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='agentnotepad'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Agent Notepad 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.agentNotepad;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.agentNotepad,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='agentnotepad'||after.sourceDomain!=='agentnotepad.com'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.agentId!==current.agentId||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.citationsHash!==current.citationsHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.resourceId!==undefined&&current.resourceId!==prior.resourceId||prior.revisionId!==undefined&&current.revisionId!==prior.revisionId||prior.canonicalUrl!==undefined&&current.canonicalUrl!==prior.canonicalUrl||prior.revisionUrl!==undefined&&current.revisionUrl!==prior.revisionUrl||!nextCiphers[key])throw Error('Agent Notepad 单次发布计划、原稿或密文不能删除、替换或回退');
    if(prior.stage!=='submitting'&&previousCiphers[key]!==nextCiphers[key])throw Error('Agent Notepad 已保存的原始响应密文不能替换');
  }
  for(const task of next.tasks.filter(value=>value.agentNotepad&&!previous.tasks.some(before=>before.id===value.id&&before.agentNotepad))){const receipt=task.agentNotepad!;if(task.channelId!=='agentnotepad'||task.sourceDomain!=='agentnotepad.com'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('Agent Notepad 新发布必须从已加密的固定提交信息开始')}
}

function assertColonyTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='colony');if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Colony 只能保留一个发布账号');
  const accountOrder={begin_intent:0,pending:1,confirm_intent:2,confirm_unknown:3,ready:4};
  for(const account of accounts){const proof=account.colony,key=`account:${account.id}`,cipher=nextCiphers[key];if(!proof||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||!/^colony_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.username!==account.username||proof.displayName!==account.displayName||!cipher)throw Error('Colony 发布账号与加密事务不一致');const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='colony');if(before?.colony){const prior=before.colony,importedResolution=account.source==='imported'&&prior.stage==='confirm_unknown'&&proof.stage==='ready'&&prior.actorId===undefined&&prior.apiKeyFingerprint===undefined;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||!importedResolution&&(prior.username!==proof.username||prior.displayName!==proof.displayName)||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.actorId!==undefined&&proof.actorId!==prior.actorId||prior.apiKeyFingerprint!==undefined&&proof.apiKeyFingerprint!==prior.apiKeyFingerprint)throw Error('Colony 原发布账号不能替换或回退');if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('Colony 已连接 key 密文不能替换或删除')}}
  for(const before of previous.accounts.filter(account=>account.channelId==='colony'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Colony 原发布账号不能删除');
  const taskOrder={intent:0,submitting:1,opaque_response:2,api_receipt:3,published:4};
  for(const before of previous.tasks){const prior=before.colony;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.colony,key=`publication:${before.id}`;if(!after||!current||after.channelId!=='colony'||after.sourceDomain!=='thecolony.ai'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.actorId!==current.actorId||prior.username!==current.username||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.postId!==undefined&&current.postId!==prior.postId||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.moderation!==undefined&&current.moderation!==prior.moderation||!nextCiphers[key])throw Error('Colony 单次发布计划、原稿或密文不能删除、替换或回退');if(prior.stage!=='submitting'&&previousCiphers[key]!==nextCiphers[key])throw Error('Colony 已保存的原始响应密文不能替换')}
  for(const task of next.tasks.filter(value=>value.colony&&!previous.tasks.some(before=>before.id===value.id&&before.colony))){const receipt=task.colony!;if(task.channelId!=='colony'||task.sourceDomain!=='thecolony.ai'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!allowImportedReceipt&&receipt.stage!=='intent'||!nextCiphers[`publication:${task.id}`])throw Error('Colony 新发布必须从已加密的固定提交信息开始')}
}

function assertOpenAgentChatTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='openagentchat');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('OpenAgentChat 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.openAgentChat,key=`account:${account.id}`,cipher=nextCiphers[key];
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||!/^oac_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.agentName!==account.username||!cipher)throw Error('OpenAgentChat 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='openagentchat');
    if(before?.openAgentChat){const prior=before.openAgentChat;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.agentName!==proof.agentName||prior.displayName!==proof.displayName||prior.bio!==proof.bio||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.agentId!==undefined&&proof.agentId!==prior.agentId||prior.tokenFingerprint!==undefined&&proof.tokenFingerprint!==prior.tokenFingerprint)throw Error('OpenAgentChat 原发布账号不能替换或回退');if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('OpenAgentChat 已连接 token 密文不能替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='openagentchat'))if(!next.accounts.some(account=>account.id===before.id))throw Error('OpenAgentChat 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.openAgentChat;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.openAgentChat,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='openagentchat'||after.sourceDomain!=='openagentchat.net'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.agentName!==current.agentName||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.pageId!==undefined&&current.pageId!==prior.pageId||prior.slug!==undefined&&current.slug!==prior.slug||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||!nextCiphers[key])throw Error('OpenAgentChat 单次发布计划、原稿或密文不能删除、替换或回退');
    if(prior.stage!=='submitting'&&previousCiphers[key]!==nextCiphers[key])throw Error('OpenAgentChat 已保存的原始响应密文不能替换');
  }
  for(const task of next.tasks.filter(value=>value.openAgentChat&&!previous.tasks.some(before=>before.id===value.id&&before.openAgentChat))){const receipt=task.openAgentChat!;if(task.channelId!=='openagentchat'||task.sourceDomain!=='openagentchat.net'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('OpenAgentChat 新发布必须从已加密的固定提交信息开始')}
}

function assertShellbookTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='shellbook');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('Shellbook 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.shellbook,key=`account:${account.id}`,cipher=nextCiphers[key],ready=proof?.stage==='ready';
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||account.source!=='generated'||account.registrationAttempts!==1||!/^shellbook_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.agentName!==account.username||!proof.description||proof.description.length>1000||!cipher||!account.hasPassword||ready!==(account.status==='registered')||ready&&(!/^[a-f0-9-]{36}$/.test(proof.agentId??'')||!/^[a-f0-9]{64}$/.test(proof.tokenFingerprint??'')||!proof.checkedAt))throw Error('Shellbook 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='shellbook');
    if(before?.shellbook){const prior=before.shellbook;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.agentName!==proof.agentName||prior.description!==proof.description||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.agentId!==undefined&&proof.agentId!==prior.agentId||prior.tokenFingerprint!==undefined&&proof.tokenFingerprint!==prior.tokenFingerprint)throw Error('Shellbook 原发布账号不能替换或回退');if(prior.stage===proof.stage&&previousCiphers[key]!==nextCiphers[key]||prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('Shellbook 加密的发布账号信息不能在同阶段替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='shellbook'))if(!next.accounts.some(account=>account.id===before.id))throw Error('Shellbook 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.shellbook;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.shellbook,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='shellbook'||after.sourceDomain!=='shellbook.io'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.agentId!==current.agentId||prior.agentName!==current.agentName||prior.subshell!==current.subshell||prior.targetUrl!==current.targetUrl||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.postId!==undefined&&current.postId!==prior.postId||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.targetRel!==undefined&&current.targetRel!==prior.targetRel||!nextCiphers[key])throw Error('Shellbook 单次发布计划、原稿或密文不能删除、替换或回退');
    if(prior.stage!=='submitting'&&previousCiphers[key]!==nextCiphers[key])throw Error('Shellbook 已保存的原始响应密文不能替换');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Shellbook 网站标识不能更换');
  }
  for(const task of next.tasks.filter(value=>value.shellbook&&!previous.tasks.some(before=>before.id===value.id&&before.shellbook))){const receipt=task.shellbook!;if(task.channelId!=='shellbook'||task.sourceDomain!=='shellbook.io'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!task.draft||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('Shellbook 新发布必须从已加密的固定提交信息开始')}
}

function assertAgentRiotTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false,expectedCiphers:Record<string,string|undefined>={}):void{
  const accounts=next.accounts.filter(account=>account.channelId==='agentriot');
  const validSlug=(value:string|undefined)=>!!value&&value.length<=160&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('AgentRiot 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.agentriot,key=`account:${account.id}`,cipher=nextCiphers[key],ready=proof?.stage==='ready';
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||account.source!=='generated'||account.registrationAttempts!==1||!/^agentriot_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.agentName!==account.username||!validSlug(proof.agentName)||proof.agentName.length>120||!proof.tagline||proof.tagline.length>120||!proof.description||proof.description.length>1000||!/^[a-f0-9]{64}$/.test(proof.installationIdHash)||!cipher||!account.hasPassword||ready!==(account.status==='registered')||ready&&(!proof.agentId||proof.agentId.length<3||proof.agentId.length>200||!validSlug(proof.agentSlug)||!/^[a-f0-9]{64}$/.test(proof.tokenFingerprint??'')||!proof.checkedAt))throw Error('AgentRiot 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='agentriot');
    if(before?.agentriot){const prior=before.agentriot;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.agentName!==proof.agentName||prior.tagline!==proof.tagline||prior.description!==proof.description||prior.installationIdHash!==proof.installationIdHash||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.agentId!==undefined&&proof.agentId!==prior.agentId||prior.agentSlug!==undefined&&proof.agentSlug!==prior.agentSlug||prior.tokenFingerprint!==undefined&&proof.tokenFingerprint!==prior.tokenFingerprint)throw Error('AgentRiot 原发布账号不能替换或回退');const progressive=prior.stage==='opaque_response'&&proof.stage==='opaque_response'&&Object.hasOwn(expectedCiphers,key)&&expectedCiphers[key]===previousCiphers[key];if(!allowImportedReceipt&&(prior.stage===proof.stage||prior.stage==='ready')&&previousCiphers[key]!==nextCiphers[key]&&!progressive)throw Error('AgentRiot 加密的发布账号信息不能在同阶段替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='agentriot'))if(!next.accounts.some(account=>account.id===before.id))throw Error('AgentRiot 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.agentriot;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.agentriot,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='agentriot'||after.sourceDomain!=='agentriot.com'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||JSON.stringify(after.agentriotInput)!==JSON.stringify(before.agentriotInput)||after.draftRevision!==before.draftRevision||after.articleApprovedAt!==before.articleApprovedAt||JSON.stringify(after.articleReview)!==JSON.stringify(before.articleReview)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.agentId!==current.agentId||prior.agentSlug!==current.agentSlug||prior.agentName!==current.agentName||prior.targetUrl!==current.targetUrl||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.updateId!==undefined&&current.updateId!==prior.updateId||prior.updateSlug!==undefined&&current.updateSlug!==prior.updateSlug||prior.remoteCreatedAt!==undefined&&current.remoteCreatedAt!==prior.remoteCreatedAt||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.targetRel!==undefined&&current.targetRel!==prior.targetRel||!nextCiphers[key])throw Error('AgentRiot 单次发布计划、原稿或密文不能删除、替换或回退');
    const cas=Object.hasOwn(expectedCiphers,key)&&expectedCiphers[key]===previousCiphers[key],recoveryCipherWrite=after.checkpoint==='agentriot_get_recovery_evidence_pending'&&['submitting','opaque_response','api_receipt'].includes(prior.stage)&&cas,progressive=prior.stage==='opaque_response'&&current.stage==='opaque_response'&&cas;
    if(!allowImportedReceipt&&prior.stage!=='submitting'&&!recoveryCipherWrite&&!progressive&&previousCiphers[key]!==nextCiphers[key])throw Error('AgentRiot 已保存的原始响应密文不能替换');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('AgentRiot 网站标识不能更换');
  }
  for(const task of next.tasks.filter(value=>value.agentriot&&!previous.tasks.some(before=>before.id===value.id&&before.agentriot))){
    const receipt=task.agentriot!,account=next.accounts.find(value=>value.id===receipt.accountId&&value.channelId==='agentriot'),complete=['api_receipt','published'].includes(receipt.stage);
    if(task.channelId!=='agentriot'||task.sourceDomain!=='agentriot.com'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!task.draft||!task.agentriotInput||!account?.agentriot||account.agentriot.stage!=='ready'||receipt.agentId!==account.agentriot.agentId||receipt.agentSlug!==account.agentriot.agentSlug||!validSlug(receipt.agentSlug)||receipt.agentName!==account.username||!/^agentriot_update_[a-f0-9]{32}$/.test(receipt.operationId)||!/^[a-f0-9]{64}$/.test(receipt.sourceHash)||!/^[a-f0-9]{64}$/.test(receipt.requestHash)||complete!==!!(receipt.updateId&&receipt.updateSlug&&receipt.remoteCreatedAt&&receipt.publicUrl)||receipt.updateSlug!==undefined&&!validSlug(receipt.updateSlug)||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('AgentRiot 新发布必须从已加密的固定提交信息开始');
  }
}

function assertLargeLanguageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,allowImportedReceipt=false):void{
  const accounts=next.accounts.filter(account=>account.channelId==='large-language');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('LargeLanguage 只能保留一个发布账号');
  const accountOrder={intent:0,opaque_response:1,ready:2};
  for(const account of accounts){
    const proof=account.largeLanguage,key=`account:${account.id}`,cipher=nextCiphers[key];
    if(!proof||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||!/^ll_register_[a-f0-9]{32}$/.test(proof.operationId)||!/^[a-f0-9]{64}$/.test(proof.requestHash)||proof.displayName!==account.username||!proof.responsibleHuman||proof.responsibleHuman!==proof.responsibleHuman.trim()||proof.responsibleHuman.length>120||!['model','system'].includes(proof.producerType)||!proof.producerName||proof.producerName!==proof.producerName.trim()||proof.producerName.length>120||!cipher)throw Error('LargeLanguage 发布账号与加密事务不一致');
    const before=previous.accounts.find(value=>value.id===account.id&&value.channelId==='large-language');
    if(before?.largeLanguage){const prior=before.largeLanguage;if(prior.operationId!==proof.operationId||prior.requestHash!==proof.requestHash||prior.displayName!==proof.displayName||prior.responsibleHuman!==proof.responsibleHuman||prior.producerType!==proof.producerType||prior.producerName!==proof.producerName||accountOrder[proof.stage]<accountOrder[prior.stage]||prior.actorId!==undefined&&proof.actorId!==prior.actorId||prior.credentialVersion!==undefined&&proof.credentialVersion!==prior.credentialVersion||prior.tokenFingerprint!==undefined&&proof.tokenFingerprint!==prior.tokenFingerprint)throw Error('LargeLanguage 原发布账号不能替换或回退');if(prior.stage==='ready'&&previousCiphers[key]!==nextCiphers[key])throw Error('LargeLanguage 已连接 token 密文不能替换或删除')}
  }
  for(const before of previous.accounts.filter(account=>account.channelId==='large-language'))if(!next.accounts.some(account=>account.id===before.id))throw Error('LargeLanguage 原发布账号不能删除');
  const taskOrder={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    const prior=before.largeLanguage;if(!prior)continue;const after=next.tasks.find(task=>task.id===before.id),current=after?.largeLanguage,key=`publication:${before.id}`;
    if(!after||!current||after.channelId!=='large-language'||after.sourceDomain!=='large-language.ai'||after.siteId!==before.siteId||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.submittedAt!==before.submittedAt||prior.operationId!==current.operationId||prior.accountId!==current.accountId||prior.displayName!==current.displayName||prior.idempotencyKey!==current.idempotencyKey||prior.sourceHash!==current.sourceHash||prior.requestHash!==current.requestHash||prior.createdAt!==current.createdAt||taskOrder[current.stage]<taskOrder[prior.stage]||prior.submissionId!==undefined&&current.submissionId!==prior.submissionId||prior.slug!==undefined&&current.slug!==prior.slug||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||!nextCiphers[key])throw Error('LargeLanguage 单次发布计划、原稿或密文不能删除、替换或回退');
    if(prior.stage!=='submitting'&&previousCiphers[key]!==nextCiphers[key])throw Error('LargeLanguage 已保存的原始响应密文不能替换');
  }
  for(const task of next.tasks.filter(value=>value.largeLanguage&&!previous.tasks.some(before=>before.id===value.id&&before.largeLanguage))){const receipt=task.largeLanguage!;if(task.channelId!=='large-language'||task.sourceDomain!=='large-language.ai'||task.accountId!==receipt.accountId||task.submittedAt!==receipt.createdAt||!allowImportedReceipt&&receipt.stage!=='submitting'||!nextCiphers[`publication:${task.id}`])throw Error('LargeLanguage 新发布必须从已加密的固定提交信息开始')}
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('NextgenSlides 单次发布计划、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('NextgenSlides 网站标识不能更换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Yourwebs 单次发布计划、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Yourwebs 网站标识不能更换');
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
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Memory.wiki 单次发布前记录、远端文章标识或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Memory.wiki 网站标识不能更换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Totpage 单次发布计划、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Totpage 网站标识不能更换');
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
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('MDView 单次发布计划、有限期对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('MDView 网站标识不能更换');
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
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('txt.sbs 单次发布计划、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('txt.sbs 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('txt.sbs 加密原始响应不能删除或替换');
  }
}

function assertPastyXTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.pastyx)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.pastyx,current=after?.pastyx,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain
      ||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl
      ||current.operationId!==prior.operationId||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.editKeyHash!==prior.editKeyHash||current.createdAt!==prior.createdAt
      ||order[current.stage]<order[prior.stage]||prior.id&&current.id!==prior.id
      ||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('PastyX 单次发布前记录、编辑密钥标识、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('PastyX 网站标识不能更换');
    const cipherChanged=previousCiphers[key]!==nextCiphers[key],attachingOpaque=prior.stage==='submitting'&&current.stage==='opaque_response'&&previousCiphers[key]!==undefined&&nextCiphers[key]!==undefined;
    if(cipherChanged&&!attachingOpaque)throw Error('PastyX 加密编辑密钥与原始响应不能删除或替换');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('AgentDrop 单次发布计划、对象或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('AgentDrop 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('AgentDrop 加密原始响应不能删除或替换');
  }
}

function assertListedStartupsTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.listedStartups)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.listedStartups,current=after?.listedStartups,key=`publication:${before.id}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.slug!==prior.slug||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||prior.requestId&&current.requestId!==prior.requestId||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Listed Startups 单次产品提交信息、slug 或原稿不能删除、更换或回退');
    const a=previous.sites.find(v=>v.id===before.siteId),b=next.sites.find(v=>v.id===before.siteId);if(!a||!b||a.url!==b.url||a.domain!==b.domain)throw Error('Listed Startups 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key]&&prior.stage!=='submitting')throw Error('Listed Startups 加密的提交信息或响应不能删除或替换');
  }
}

function assertProductIndexTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const operations=new Set<string>(),slugs=new Set<string>(),fingerprints=new Set<string>();
  for(const account of next.accounts){
    if(account.channelId==='product-index'){
      if(!validProductIndexAccount(account)||!nextCiphers[`account:${account.id}`]||fingerprints.has(account.productIndex!.tokenFingerprint))throw Error('AI Product Index GitHub 发布账号或加密令牌无效');
      fingerprints.add(account.productIndex!.tokenFingerprint);
    }else if(account.productIndex)throw Error('AI Product Index 发布账号信息不能附加到其他平台账号');
  }
  for(const task of next.tasks){
    const receipt=task.productIndex;if(!receipt)continue;
    const site=next.sites.find(value=>value.id===task.siteId),account=next.accounts.find(value=>value.id===task.accountId),binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='product-index'),identity=site&&productIndexTaskIdentity(task,site),key=`publication:${task.id}`,hasIssue=Number.isSafeInteger(receipt.issueNumber)&&Number(receipt.issueNumber)>0,expectsIssue=['issue_open','rejected','published'].includes(receipt.stage),expectedCheckpoint=`product_index_${receipt.stage}`;
    if(task.channelId!=='product-index'||task.sourceDomain!=='index.percall.dev'||!site||!validProductIndexAccount(account)||task.accountId!==receipt.accountId||binding?.accountId!==receipt.accountId||account.username!==receipt.githubUser||!identity||identity.listing.slug!==receipt.slug||identity.sourceHash!==receipt.sourceHash||identity.requestHash!==receipt.requestHash||task.submittedAt!==receipt.createdAt||!nextCiphers[key]||operations.has(receipt.operationId)||slugs.has(receipt.slug)||expectsIssue!==hasIssue||hasIssue&&(receipt.issueApiUrl!==`https://api.github.com/repos/110kc3/seo/issues/${receipt.issueNumber}`||receipt.issueHtmlUrl!==`https://github.com/110kc3/seo/issues/${receipt.issueNumber}`)||task.checkpoint!==expectedCheckpoint||(receipt.stage==='published'?task.publicUrl!==productIndexPublicUrl(receipt.slug):!!task.publicUrl)||!!task.firstLiveAt&&receipt.stage!=='published')throw Error('AI Product Index 单次 issue、审核稿、账号绑定或公开返回记录无效');
    operations.add(receipt.operationId);slugs.add(receipt.slug);
  }
  const order={submitting:0,opaque_response:1,issue_open:2,rejected:3,published:3};
  for(const before of previous.tasks){
    if(!before.productIndex)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.productIndex,current=after?.productIndex,key=`publication:${before.id}`,beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId),beforeAccount=previous.accounts.find(account=>account.id===prior.accountId),afterAccount=next.accounts.find(account=>account.id===prior.accountId);
    if(!after||!current||!beforeSite||!afterSite||!beforeAccount||!afterAccount||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||after.draftRevision!==before.draftRevision||afterSite.url!==beforeSite.url||afterSite.domain!==beforeSite.domain||current.operationId!==prior.operationId||current.accountId!==prior.accountId||current.githubUser!==prior.githubUser||current.slug!==prior.slug||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||prior.stage==='rejected'&&current.stage!=='rejected'||prior.stage==='published'&&current.stage!=='published'||prior.issueNumber!==undefined&&(current.issueNumber!==prior.issueNumber||current.issueApiUrl!==prior.issueApiUrl||current.issueHtmlUrl!==prior.issueHtmlUrl)||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt||beforeAccount.username.toLowerCase()!==afterAccount.username.toLowerCase())throw Error('AI Product Index GitHub 发布账号、单次 issue、审核稿或外链记录不能删除、更换或回退');
    const cipherChanged=previousCiphers[key]!==nextCiphers[key],attachingOpaque=prior.stage==='submitting'&&current.stage==='opaque_response'&&previousCiphers[key]!==undefined&&nextCiphers[key]!==undefined;
    if(cipherChanged&&!attachingOpaque)throw Error('AI Product Index 加密原提交信息或响应不能删除或替换');
  }
}

function assertShipPageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const accounts=next.accounts.filter(account=>account.channelId==='shippage');
  if(accounts.filter(account=>!account.retiredAt).length>1)throw Error('ShipPage 只能保留一个本机平台账号');
  const account=accounts[0],operations=new Set<string>(),slugs=new Set<string>(),order={submitting:0,opaque_response:1,api_receipt:2,published:3};
  for(const task of next.tasks){
    const receipt=task.shipPage;if(!receipt)continue;
    const binding=next.accountBindings.find(value=>value.siteId===task.siteId&&value.channelId==='shippage');
    if(task.channelId!=='shippage'||task.sourceDomain!=='shippage.ai'||!account||task.accountId!==account.id||receipt.accountId!==account.id||binding?.accountId!==account.id)throw Error('ShipPage 任务必须绑定唯一平台账号');
    if(operations.has(receipt.operationId)||slugs.has(receipt.slug))throw Error('ShipPage 单次发布计划或 slug 不能重复');
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
      ||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('ShipPage 唯一账号、单次发布计划、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('ShipPage 网站标识不能更换');
    if(previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]!==previousCiphers[publicationKey])throw Error('ShipPage 加密原始响应不能删除或替换');
    if(previousCiphers[accountKey]!==undefined&&nextCiphers[accountKey]!==previousCiphers[accountKey])throw Error('ShipPage 唯一账号 API key 不能删除或替换');
  }
  for(const before of previous.accounts){
    if(before.channelId!=='shippage')continue;
    const after=next.accounts.find(account=>account.id===before.id),key=`account:${before.id}`;
    if(!after||after.channelId!=='shippage'||after.email!==before.email||after.source!==before.source||after.credentialKind!==before.credentialKind
      ||(before.shipPage&&JSON.stringify(after.shipPage)!==JSON.stringify(before.shipPage))||(before.hasPassword&&(!after.hasPassword||after.status!==before.status||after.username!==before.username)))throw Error('ShipPage 唯一账号或已验证发布账号不能删除、替换或回退');
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
      ||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Markdown Pastebin 单次发布计划或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('Markdown Pastebin 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('Markdown Pastebin 加密原始响应不能删除或替换');
  }
}

function assertSlugPostTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={submitting:0,opaque_response:1,ui_receipt:2,published:3};
  for(const before of previous.tasks){
    if(!before.slugPost)continue;
    const after=next.tasks.find(task=>task.id===before.id),prior=before.slugPost,current=after?.slugPost,key=`publication:${before.id}`;
    const priorJournal=prior.boundaryJournal??[],currentJournal=current?.boundaryJournal??[],journalChanged=JSON.stringify(currentJournal)!==JSON.stringify(priorJournal);
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.slug!==prior.slug||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||currentJournal.length<priorJournal.length||currentJournal.length>16||JSON.stringify(currentJournal.slice(0,priorJournal.length))!==JSON.stringify(priorJournal)||journalChanged&&(prior.stage!=='submitting'||current.stage!=='submitting')||before.submittedAt!==after.submittedAt||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('SlugPost 单次网页提交信息、派发证据或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);
    if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('SlugPost 网站标识不能更换');
    if(previousCiphers[key]!==undefined&&nextCiphers[key]!==previousCiphers[key])throw Error('SlugPost 加密的原始返回记录不能删除或替换');
  }
}

function assertBrewPageTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>):void{
  const order={owner_token_pending:0,owner_token_opaque:1,ready:2,submitting:3,opaque_response:4,api_receipt:5,published:6};
  for(const before of previous.tasks){
    if(!before.brewPage)continue;const after=next.tasks.find(task=>task.id===before.id),prior=before.brewPage,current=after?.brewPage,publicationKey=`publication:${before.id}`,accountKey=`account:${prior.ownerAccountId}`;
    if(!after||!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||JSON.stringify(after.draft)!==JSON.stringify(before.draft)||after.topicUrl!==before.topicUrl||current.operationId!==prior.operationId||current.ownerAccountId!==prior.ownerAccountId||current.filename!==prior.filename||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||order[current.stage]<order[prior.stage]||before.submittedAt!==after.submittedAt||prior.ownerId&&current.ownerId!==prior.ownerId||prior.id&&current.id!==prior.id||prior.publicUrl&&current.publicUrl!==prior.publicUrl||prior.expiresAt&&current.expiresAt!==prior.expiresAt||prior.sizeBytes&&current.sizeBytes!==prior.sizeBytes||prior.hostingVersion&&current.hostingVersion!==prior.hostingVersion||(current.recoveryGets??0)<(prior.recoveryGets??0)||(current.recoveryGets??0)>7||before.accountId&&after.accountId!==before.accountId||before.publicUrl&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('BrewPage 所有者、单次发布计划、到期时间或原稿不能删除、更换或回退');
    const beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId);if(!beforeSite||!afterSite||beforeSite.url!==afterSite.url||beforeSite.domain!==afterSite.domain)throw Error('BrewPage 网站标识不能更换');
    if(prior.ownerId){
      const beforeAccount=previous.accounts.find(account=>account.id===prior.ownerAccountId),afterAccount=next.accounts.find(account=>account.id===prior.ownerAccountId),beforeBinding=previous.accountBindings.find(binding=>binding.siteId===before.siteId&&binding.channelId==='brewpage'),afterBinding=next.accountBindings.find(binding=>binding.siteId===before.siteId&&binding.channelId==='brewpage');
      if(!beforeAccount||!afterAccount||afterAccount.channelId!=='brewpage'||afterAccount.username!==beforeAccount.username||afterAccount.credentialKind!==beforeAccount.credentialKind||afterAccount.status!==beforeAccount.status||afterAccount.hasPassword!==beforeAccount.hasPassword||afterAccount.source!==beforeAccount.source||!beforeBinding||!afterBinding||afterBinding.accountId!==prior.ownerAccountId||beforeBinding.accountId!==afterBinding.accountId)throw Error('BrewPage 已确认所有者账号和站点绑定不能删除或更换');
    }
    if(previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]!==previousCiphers[publicationKey]&&!(prior.stage==='owner_token_opaque'&&current.stage==='ready'&&nextCiphers[publicationKey]===undefined))throw Error('BrewPage 加密原始响应不能删除或替换');
    if(previousCiphers[accountKey]!==undefined&&nextCiphers[accountKey]!==previousCiphers[accountKey])throw Error('BrewPage 所有者令牌不能删除或替换');
  }
}

function assertCarcinusTransition(previous:State,next:State,previousCiphers:Record<string,string>,nextCiphers:Record<string,string>,expectedCiphers:Record<string,string|undefined>={}):void{
  const accounts=next.accounts.filter(account=>account.channelId==='carcinus'),allTasks=next.tasks.filter(task=>task.channelId==='carcinus'||!!task.carcinus||!!task.carcinusInput||!!task.carcinusExisting),tasks=allTasks.filter(task=>!!task.carcinus),existingTasks=allTasks.filter(task=>!!task.carcinusExisting),bindings=next.accountBindings.filter(binding=>binding.channelId==='carcinus');
  if(accounts.length>1||allTasks.length>1||bindings.length>1)throw Error('Carcinus 只允许一个稳定发布账号和一张公开页');
  for(const account of next.accounts)if(account.channelId==='carcinus'){if(!(validCarcinusAccount(account)||validCarcinusExistingAccount(account))||!nextCiphers[`account:${account.id}`])throw Error('Carcinus 管理发布账号或加密令牌无效')}else if(account.carcinus)throw Error('Carcinus 发布账号信息不能附加到其他平台账号');
  for(const task of existingTasks){
    const receipt=task.carcinusExisting!,site=next.sites.find(value=>value.id===task.siteId),account=task.accountId?accounts.find(value=>value.id===task.accountId):undefined,binding=bindings.find(value=>value.siteId===task.siteId),proof=account?.carcinus,publicationCipher=nextCiphers[`publication:${task.id}`];
    if(task.carcinus||task.carcinusInput||task.channelId!=='carcinus'||task.sourceDomain!=='carcinus.org'||!site||!account||!validCarcinusExistingAccount(account)||proof?.version!==3||!validCarcinusExistingStateReceipt(receipt)||binding?.accountId!==account.id||proof.identity!==receipt.identity||proof.siteId!==site.id||proof.siteIdentitySha256!==carcinusSiteIdentity(site)||proof.targetUrlSha256!==receipt.targetUrlSha256||proof.payloadSha256!==receipt.payloadSha256||proof.provenanceSha256!==receipt.provenanceSha256||proof.secretSha256!==receipt.secretSha256||proof.tokenFingerprint!==receipt.tokenFingerprint||proof.publicUrl!==receipt.publicUrl||proof.restoreUrl!==receipt.restoreUrl||task.publicUrl!==receipt.publicUrl||task.topicUrl!==receipt.acceptance.targetUrl||task.status!=='skipped'||task.attempts!==0||task.checkpoint!=='existing_link'||task.publicationMethod!=='external'||task.submittedAt||task.firstLiveAt||!publicationCipher)throw Error('Carcinus 既有页面、原返回记录或加密发布账号归属无效');
  }
  for(const task of tasks){
    const receipt=task.carcinus!,site=next.sites.find(value=>value.id===task.siteId),identity=site?carcinusTaskIdentity(task,site):undefined,account=task.accountId?accounts.find(value=>value.id===task.accountId):undefined,binding=bindings.find(value=>value.siteId===task.siteId),publicationCipher=nextCiphers[`publication:${task.id}`],expectedCheckpoint=receipt.stage==='preflight'?'carcinus_preflight_clear':receipt.stage==='submitting'?'carcinus_create_submitting':receipt.stage==='create_unknown'?'carcinus_create_unknown':receipt.stage==='opaque_response'?'carcinus_opaque_response':receipt.stage==='api_receipt'?'carcinus_api_receipt':receipt.stage==='published'?'carcinus_published':'carcinus_live_unmanaged',remoteStarted=receipt.stage!=='preflight',managed=['api_receipt','published'].includes(receipt.stage),unmanaged=receipt.stage==='live_unmanaged';
    if(task.channelId!=='carcinus'||task.sourceDomain!=='carcinus.org'||!identity||identity.input.identity!==receipt.identity||identity.sourceHash!==receipt.sourceHash||identity.requestHash!==receipt.requestHash||task.checkpoint!==expectedCheckpoint||remoteStarted!==!!task.submittedAt||remoteStarted&&task.submittedAt!==receipt.createdAt)throw Error('Carcinus 固定审核稿、identity 或单次提交信息无效');
    if(managed){if(!account||!site||!identity||!carcinusAccountMatchesTask(account,identity,site)||binding?.accountId!==account.id||receipt.publicUrl!==identity.publicUrl||receipt.restoreUrl!==identity.restoreUrl||receipt.tokenFingerprint!==account.carcinus!.tokenFingerprint||task.publicUrl!==identity.publicUrl||publicationCipher)throw Error('Carcinus 管理返回记录与加密发布账号不一致')}
    else if(unmanaged){if(account||binding||receipt.tokenFingerprint||receipt.publicUrl!==identity.publicUrl||receipt.restoreUrl!==identity.restoreUrl||task.publicUrl!==identity.publicUrl||!receipt.acceptance||!carcinusPublicationTesting.validAcceptance(receipt.acceptance,identity))throw Error('Carcinus live_unmanaged 记录不能声称受控发布账号')}
    else if(task.accountId||binding||task.publicUrl||receipt.publicUrl||receipt.restoreUrl||receipt.tokenFingerprint||receipt.acceptance)throw Error('Carcinus 未确认的提交不能附带公开页或管理信息');
    if(receipt.stage==='opaque_response'&&!publicationCipher)throw Error('Carcinus 原始响应阶段必须保留加密响应')
    else if(publicationCipher&&!['opaque_response','live_unmanaged'].includes(receipt.stage))throw Error('Carcinus 原始响应密文阶段无效');
    if(receipt.stage==='published'&&(!receipt.acceptance||!carcinusPublicationTesting.validAcceptance(receipt.acceptance,identity)))throw Error('Carcinus 公开验收记录无效');
  }
  const order={preflight:0,submitting:1,create_unknown:2,opaque_response:3,api_receipt:4,published:5,live_unmanaged:5} as const;
  for(const before of previous.tasks){if(!before.carcinus)continue;const after=next.tasks.find(task=>task.id===before.id),prior=before.carcinus,current=after?.carcinus,beforeSite=previous.sites.find(site=>site.id===before.siteId),afterSite=next.sites.find(site=>site.id===before.siteId),publicationKey=`publication:${before.id}`,bindsSubmission=prior.stage==='preflight'&&current?.stage==='submitting'&&before.submittedAt===undefined&&after?.submittedAt===prior.createdAt;if(!after||!current||!beforeSite||!afterSite||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||JSON.stringify(after.carcinusInput)!==JSON.stringify(before.carcinusInput)||after.topicUrl!==before.topicUrl||afterSite.url!==beforeSite.url||afterSite.domain!==beforeSite.domain||current.operationId!==prior.operationId||current.identity!==prior.identity||current.sourceHash!==prior.sourceHash||current.requestHash!==prior.requestHash||current.createdAt!==prior.createdAt||current.preflightCheckedAt!==prior.preflightCheckedAt||current.preflightStatus!==prior.preflightStatus||order[current.stage]<order[prior.stage]||prior.stage==='published'&&current.stage!=='published'||prior.stage==='live_unmanaged'&&current.stage!=='live_unmanaged'||prior.publicUrl!==undefined&&current.publicUrl!==prior.publicUrl||prior.restoreUrl!==undefined&&current.restoreUrl!==prior.restoreUrl||prior.tokenFingerprint!==undefined&&current.tokenFingerprint!==prior.tokenFingerprint||prior.acceptance!==undefined&&JSON.stringify(current.acceptance)!==JSON.stringify(prior.acceptance)||!bindsSubmission&&before.submittedAt!==after.submittedAt||before.accountId!==undefined&&after.accountId!==before.accountId||before.publicUrl!==undefined&&after.publicUrl!==before.publicUrl||before.firstLiveAt&&after.firstLiveAt!==before.firstLiveAt)throw Error('Carcinus 单次发布账号、审核稿、返回记录或公开页不能删除、更换或回退');const cipherChanged=previousCiphers[publicationKey]!==nextCiphers[publicationKey],allowedDelete=prior.stage==='opaque_response'&&current.stage==='api_receipt'&&previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]===undefined,allowedProgress=prior.stage==='opaque_response'&&current.stage==='opaque_response'&&previousCiphers[publicationKey]!==undefined&&nextCiphers[publicationKey]!==undefined&&Object.hasOwn(expectedCiphers,publicationKey)&&expectedCiphers[publicationKey]===previousCiphers[publicationKey];if(cipherChanged&&!allowedDelete&&!allowedProgress&&previousCiphers[publicationKey]!==undefined)throw Error('Carcinus 加密原始响应不能删除或无版本替换')}
  for(const before of previous.accounts){if(before.channelId!=='carcinus')continue;const after=next.accounts.find(account=>account.id===before.id),key=`account:${before.id}`;if(!after||!isDeepStrictEqual(after,before)||nextCiphers[key]!==previousCiphers[key])throw Error('Carcinus 稳定管理发布账号或令牌不能删除、替换或修改')}
  for(const before of previous.tasks){if(!before.carcinusExisting)continue;const after=next.tasks.find(task=>task.id===before.id),publicationKey=`publication:${before.id}`;if(!after||!isDeepStrictEqual(after.carcinusExisting,before.carcinusExisting)||after.siteId!==before.siteId||after.channelId!==before.channelId||after.sourceDomain!==before.sourceDomain||after.accountId!==before.accountId||after.topicUrl!==before.topicUrl||after.publicUrl!==before.publicUrl||after.submittedAt!==before.submittedAt||after.firstLiveAt!==before.firstLiveAt||after.checkpoint!==before.checkpoint||after.publicationMethod!==before.publicationMethod||nextCiphers[publicationKey]!==previousCiphers[publicationKey])throw Error('Carcinus 既有页面的原发布账号、原返回记录、规范网址、正文或密文不能删除或更换')}
}

function email(value:string|undefined){return (value??'').trim().toLowerCase()}
function sameMailboxIdentity(mailbox:Pick<Mailbox,'host'|'port'|'user'|'secure'>,legacy:Pick<Settings['mail'],'host'|'port'|'user'|'secure'>){const host=(value:string)=>value.trim().toLowerCase().replace(/\.$/,'');return host(mailbox.host)===host(legacy.host)&&mailbox.port===legacy.port&&mailbox.user.trim()===legacy.user.trim()&&mailbox.secure===legacy.secure}
/** Additive migration only: it never deletes identities, tasks, legacy fields or secret keys. */
export function migrateState(input:State):State{
  const state=input as State;
  if((state.schemaVersion??0)>3)throw Error('数据版本高于当前外链助手支持范围，请先更新外链助手');
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
  state.channelTermsCache=state.channelTermsCache&&typeof state.channelTermsCache==='object'&&!Array.isArray(state.channelTermsCache)?state.channelTermsCache:{};
  // Writing profiles and task snapshots are optional in schema 3. Keep existing
  // values verbatim; old sites acquire their deterministic profile only on use.
  // Migration must never rewrite a stored article or spend an AI call.
  for(const task of state.tasks)if(task.linkRel!==undefined)task.linkRel=normalizeChannelLinkRel(task.linkRel);
  for(const channel of state.customChannels){
    channel.linkRel=normalizeChannelLinkRel(channel.linkRel);
    if(channel.metrics===undefined&&channel.authority)channel.metrics=legacyAuthorityMetrics(channel.authority,{domain:channel.domain,linkScope:channelMetricLinkScope(channel.id)});
  }
  for(const [channelId,saved]of Object.entries(state.channelMetrics)){
    const channel=[...CHANNELS,...state.customChannels].find(value=>value.id===channelId);
    if(saved.metrics===undefined&&saved.authority)saved.metrics=legacyAuthorityMetrics(saved.authority,{domain:channel?.domain,linkScope:channelMetricLinkScope(channelId)});
  }
  state.siteOriginMigrations=Array.isArray(state.siteOriginMigrations)?state.siteOriginMigrations:[];
  if(state.telegraphReminderReset!==1){
    // 1.2.39 could not confirm who owned a Telegraph page, so "stop reminding me" was the only choice offered; now it can be fixed.
    for(const task of state.tasks??[])if(task.channelId==='telegraph'&&task.remoteContentScan?.referral&&task.remoteContentScan.acknowledgedAt)delete task.remoteContentScan.acknowledgedAt;
    state.telegraphReminderReset=1;
  }
  if(state.reviewDefaultsVersion!==1){
    const inherited=state.settings?.articleReviewMode==='ai'?'ai':'manual';
    for(const site of state.sites)if(site.articleReviewMode===undefined)site.articleReviewMode=inherited;
    state.settings={...state.settings,articleReviewMode:'ai'};
    state.reviewDefaultsVersion=1;
  }
  state.analysisUsage??={};
  state.settings={...defaultSettings(),...(state.settings??{}),mail:{...defaultSettings().mail,...(state.settings?.mail??{})},channelOverrides:state.settings?.channelOverrides??{}};
  if(!['system','light','dark'].includes(state.settings.appearance??''))state.settings.appearance='system';
  if(state.settings.articleReviewMode!=='manual'&&state.settings.articleReviewMode!=='ai')state.settings.articleReviewMode='manual';
  for(const site of state.sites){
    if(site.archivedAt)site.status='paused';
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
  reconcileEmailWaits(state);
  migrateTaskReasons(state.tasks,new Date(now));
  for(const task of state.tasks){
    if((task.temporaryBackoffCount??0)>0&&!task.temporaryBackoffStartedAt){
      task.temporaryBackoffStartedAt=task.updatedAt??task.createdAt;
    }
    if(task.failedPlatformIds?.length){
      // Freeze the legacy exclusion date once; later task updates must not
      // extend the thirty-day exclusion indefinitely.
      task.failedPlatformAt=Object.fromEntries(task.failedPlatformIds.map(id=>[id,task.failedPlatformAt?.[id]??task.updatedAt??task.createdAt]));
    }
  }
  for(const task of state.tasks)if(task.firstLiveAt&&task.lostAt&&task.reviewKind==='lost_link'){Object.assign(task,taskTransition(task,{status:'live',reasonCode:undefined,reviewKind:undefined},new Date(now)))}
  for(const task of state.tasks){
    // Old signup deferrals consumed the publication attempt budget. Preserve
    // that history and any intent, but surface the task instead of stranding it.
    if(task.status==='queued'&&task.signup?.status==='running'&&task.attempts>=state.settings.maxAttempts
      &&!task.publicUrl&&!task.submittedAt&&!task.firstLiveAt&&!hasUnresolvedExternalAttempt(task)){
      Object.assign(task,taskTransition(task,{status:'needs_input',checkpoint:'account_registration_human',reasonCode:'human_required',
        signup:{...task.signup,status:'human',humanReason:'execution_failed',failure:undefined},message:SIGNUP_MESSAGES.execution_failed},new Date(now)));
    }
    if(task.status==='needs_input'&&task.reasonCode!=='submission_unknown'&&!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt){
      if(task.checkpoint==='ai_setup_required')Object.assign(task,taskTransition(task,{status:'queued'},new Date(now)));
      if(task.checkpoint==='eligibility_wait')Object.assign(task,taskTransition(task,{reasonCode:'channel_ineligible'},new Date(now)));
      if(task.checkpoint==='referral_guard')Object.assign(task,taskTransition(task,{reasonCode:'referral_blocked'},new Date(now)));
    }
    const active=task.status==='needs_input'&&isHumanTaskReason(task.reasonCode);
    const retained=['skipped','failed'].includes(task.status)&&['human_timeout','user_skipped'].includes(task.reasonCode??'');
    if(task.humanAction&&!active&&!retained)Object.assign(task,taskTransition(task,{status:task.status,reasonCode:task.reasonCode},new Date(now)));
  }
  for(const task of state.tasks){
    const action=task.humanAction;
    if(!action||action.url&&action.url!==safeHumanActionUrl(`https://${task.sourceDomain}/`))continue;
    const channel=[...CHANNELS,...state.customChannels].find(value=>value.id===task.channelId);
    if(channel)action.url=safeHumanActionUrl(channel.submitUrl);
  }
  migrateIdentityOwners(state);
  for(const task of state.tasks)if(!task.submittedAt)delete task.publicationSnapshot;
  retireLegacyAccounts(state,new Date(now));
  state.schemaVersion=3;
  state.settings.channelTrials??={};
  migrateChannelTrials(state,[...CHANNELS,...(state.customChannels??[])]);
  migrateChannelPolicyScopeHashes(state,[...CHANNELS,...(state.customChannels??[])],new Date(now));
  const temporary=new Set([...CHANNELS,...(state.customChannels??[])].filter(channel=>channel.retentionDays!==undefined).map(channel=>channel.id));
  for(const task of state.tasks)if(temporary.has(task.channelId))task.temporaryPage=true;
  const reviewChannels=composeChannels(CHANNELS,state.customChannels??[],state.channelMetrics??{});
  for(const task of state.tasks){
    if(task.articleReview?.status!=='passed'||task.articleReview.bindingVersion===2)continue;
    const site=state.sites.find(value=>value.id===task.siteId),base=reviewChannels.find(value=>value.id===task.channelId);
    if(!site||!base)continue;
    const channel={...base,enabled:base.enabled&&state.settings.channelOverrides[base.id]!==false,termsCache:state.channelTermsCache?.[base.id]};
    const account=state.accounts.find(value=>value.id===task.accountId);
    const migrated=migrateLegacyArticleReview(task,site,channel,state.settings,account);
    if(migrated)task.articleReview=migrated;
  }
  return state;
}

/** Registration progress is durable evidence; losing it must never authorize a second dispatch. */
function assertSignupTransition(previous:State,next:State):void {
  for(const before of previous.tasks){
    const prior=before.signup;if(!prior)continue;
    const after=next.tasks.find(task=>task.id===before.id),current=after?.signup;
    if(!after){if(prior.irreversible)throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);continue}
    if(!current||after.siteId!==before.siteId||after.channelId!==before.channelId||after.accountId!==before.accountId
      ||current.scriptId!==prior.scriptId||current.scriptVersion!==prior.scriptVersion||current.identityId!==prior.identityId
      ||!!prior.irreversible&&current.stepIndex<prior.stepIndex||current.aiLocateCalls<prior.aiLocateCalls
      ||prior.aiLocatedStepIds.some(id=>!current.aiLocatedStepIds.includes(id))
      ||prior.status==='done'&&current.status!=='done')throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);
    const intent=prior.irreversible;if(!intent)continue;
    const originalAccount=previous.accounts.find(account=>account.id===prior.identityId);
    const retainedAccount=next.accounts.find(account=>account.id===prior.identityId);
    if(!originalAccount||!retainedAccount||retainedAccount.channelId!==originalAccount.channelId
      ||(retainedAccount.registrationAttempts??0)<(originalAccount.registrationAttempts??0)
      ||prior.status!=='done'&&(retainedAccount.email!==originalAccount.email||retainedAccount.username!==originalAccount.username)){
      throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);
    }
    const updated=current.irreversible;
    if(!updated)throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);
    const sameIntent=updated.stepId===intent.stepId&&updated.at===intent.at;
    if(sameIntent){
      if(intent.completed&&!updated.completed)throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);
    }else if(!intent.completed||updated.stepId===intent.stepId||current.stepIndex<prior.stepIndex||Date.parse(updated.at)<Date.parse(intent.at)){
      throw Error(HUMAN_ACTION_MESSAGES.invalidSignup);
    }
  }
}

/** Remove only task-owned registration material whose referenced state has ended. */
function signupCipherCleanup(state:State,ciphers:Record<string,string>):string[] {
  const tasks=new Map(state.tasks.map(task=>[task.id,task]));
  return Object.keys(ciphers).filter(key=>{
    const match=/^signup:([0-9a-f-]{36}):(email|api_key|token)$/.exec(key);
    if(!match)return false;
    const task=tasks.get(match[1]);
    return !task||match[2]==='email'&&!task.emailWait&&!task.emailConfirmation;
  });
}

/** The SQLite transaction persists a complete coherent scheduler state before notifying UI. */
export class Store {
  private writeRevision=0;
  get revision():number{return this.writeRevision}
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
    const loadedCiphers=this.allCiphers();
    assertAgentsWikiTransition(this.state,this.state,loadedCiphers,loadedCiphers,true);
    assertSynthfolkTransition(this.state,this.state,loadedCiphers,loadedCiphers,true);
    assertShareClaimState(this.state,loadedCiphers);
    assertTantiveTransition(this.state,this.state,this.allCiphers(),this.allCiphers(),true);
    assertTheThingsTransition(this.state,this.state,this.allCiphers(),this.allCiphers(),true);
    assertAgentboardTransition(this.state,this.state,this.allCiphers(),this.allCiphers(),true);
    assertAgentsGatherTransition(this.state,this.state,this.allCiphers(),this.allCiphers(),true);
    assertSiteOriginMigrationState(this.state);
    assertOneReviewRetryTransition(this.state,this.state,true);
    const legacyMailbox=legacySchema&&!hadMailboxes&&legacyMail?.hasPassword&&this.state.mailboxes.length===1&&sameMailboxIdentity(this.state.mailboxes[0],legacyMail)?this.state.mailboxes[0]:undefined;
    if(legacyMailbox&&!this.getCipher('mailbox:'+legacyMailbox.id)){const cipher=this.getCipher('mailPassword');if(cipher)this.setCipher('mailbox:'+legacyMailbox.id,cipher)}
    if(!this.state.settings.mail.host&&!this.state.settings.mail.user&&!this.state.settings.mail.hasPassword)this.state.settings.mail.host='imap.gmail.com';
    this.persistWithDeletes(this.state,signupCipherCleanup(this.state,this.allCiphers()));
  }
  read():State{return structuredClone(this.state)}
  private notify(){try{this.onChange?.()}catch{/* A renderer notification cannot undo a committed write. */}}
  private assertNoNestedWrite(previous:State,previousCiphers:Record<string,string>){
    if(JSON.stringify(this.state)!==JSON.stringify(previous)||JSON.stringify(this.allCiphers())!==JSON.stringify(previousCiphers))throw Error('Store 更新期间已有更晚的保存结果，已拒绝旧快照覆盖');
  }
  update(fn:(draft:State)=>void):void{
    const previous=this.read(),previousCiphers=this.allCiphers(),draft=structuredClone(previous);fn(draft);reconcileChannelTrials(draft,[...CHANNELS,...(draft.customChannels??[])]);reconcileEmailWaits(draft);capturePublicationSnapshots(previous,draft);assertBatch5Transition(previous,draft,previousCiphers,previousCiphers);assertRetiredAccounts(previous,draft,previousCiphers,previousCiphers);this.assertNoNestedWrite(previous,previousCiphers);draft.events=draft.events.slice(-500);assertSiteOriginMigrationTransition(previous,draft);assertOneReviewRetryTransition(previous,draft);assertAgentboardTransition(previous,draft,previousCiphers,previousCiphers);assertSynthfolkTransition(previous,draft,previousCiphers,previousCiphers);assertTheThingsTransition(previous,draft,previousCiphers,previousCiphers);assertShellbookTransition(previous,draft,previousCiphers,previousCiphers);assertOpenAgentChatTransition(previous,draft,previousCiphers,previousCiphers);assertAgentRiotTransition(previous,draft,previousCiphers,previousCiphers);assertColonyTransition(previous,draft,previousCiphers,previousCiphers);assertAgentNotepadTransition(previous,draft,previousCiphers,previousCiphers);assertAgentHowTransition(previous,draft,previousCiphers,previousCiphers);assertAgentsGatherTransition(previous,draft,previousCiphers,previousCiphers);assertSwarmMemoTransition(previous,draft,previousCiphers,previousCiphers);assertBerrryTransition(previous,draft,previousCiphers,previousCiphers);assertLargeLanguageTransition(previous,draft,previousCiphers,previousCiphers);assertShareClaimTransition(previous,draft,previousCiphers,previousCiphers);assertKatbinTransition(previous,draft,previousCiphers,previousCiphers);assertMDShareTransition(previous,draft,previousCiphers,previousCiphers);assertPstrsTransition(previous,draft,previousCiphers,previousCiphers);assertYourwebsTransition(previous,draft,previousCiphers,previousCiphers);assertNextgenSlidesTransition(previous,draft,previousCiphers,previousCiphers);assertMemoryWikiTransition(previous,draft,previousCiphers,previousCiphers);assertTotpageTransition(previous,draft,previousCiphers,previousCiphers);assertMDViewTransition(previous,draft,previousCiphers,previousCiphers);assertTxtSbsTransition(previous,draft,previousCiphers,previousCiphers);assertPastyXTransition(previous,draft,previousCiphers,previousCiphers);assertListedStartupsTransition(previous,draft,previousCiphers,previousCiphers);assertProductIndexTransition(previous,draft,previousCiphers,previousCiphers);assertAgentDropTransition(previous,draft,previousCiphers,previousCiphers);assertShipPageTransition(previous,draft,previousCiphers,previousCiphers);assertPasteMystTransition(previous,draft,previousCiphers,previousCiphers);assertMarkdownPasteTransition(previous,draft,previousCiphers,previousCiphers);assertSlugPostTransition(previous,draft,previousCiphers,previousCiphers);assertBrewPageTransition(previous,draft,previousCiphers,previousCiphers);assertCarcinusTransition(previous,draft,previousCiphers,previousCiphers);assertSignupTransition(previous,draft);const deletes=signupCipherCleanup(draft,previousCiphers),body=JSON.stringify(draft);
    // Nothing changed: no disk write, no renderer refresh. Idle ticks and repeated observations stay free.
    if(!deletes.length&&body===JSON.stringify(previous))return;
    this.persistWithDeletes(draft,deletes,body);this.state=draft;this.writeRevision++;this.notify();
  }
  updateWithCiphers(fn:(draft:State)=>void,ciphers:Record<string,string>,deleteKeys:string[]=[],expectedCiphers?:Record<string,string|undefined>):void{
    this.updateWithCipherTransaction(fn,ciphers,deleteKeys,undefined,expectedCiphers);
  }
  updateTheThingsOpaqueProgress(fn:(draft:State)=>void,progress:TheThingsOpaqueProgressWrite):void{
    this.updateWithCipherTransaction(fn,{[progress.key]:progress.nextCipher},[],progress);
  }
  private updateWithCipherTransaction(fn:(draft:State)=>void,ciphers:Record<string,string>,deleteKeys:string[]=[],theThingsProgress?:TheThingsOpaqueProgressWrite,expectedCiphers?:Record<string,string|undefined>):void{
    if(deleteKeys.some(key=>Object.hasOwn(ciphers,key)))throw Error('同一加密字段不能在一次事务中同时写入和删除');
    let draft:State|undefined;
    const prepare=()=>{const previous=this.read(),previousCiphers=this.allCiphers();if(expectedCiphers&&Object.entries(expectedCiphers).some(([key,value])=>previousCiphers[key]!==value))throw Error('Store 加密字段已被更晚结果替换，拒绝旧快照覆盖');draft=structuredClone(previous);fn(draft);reconcileChannelTrials(draft,[...CHANNELS,...(draft.customChannels??[])]);reconcileEmailWaits(draft);capturePublicationSnapshots(previous,draft);this.assertNoNestedWrite(previous,previousCiphers);draft.events=draft.events.slice(-500);
      assertSiteOriginMigrationTransition(previous,draft);
      assertOneReviewRetryTransition(previous,draft);
      assertSignupTransition(previous,draft);const nextCiphers={...previousCiphers,...ciphers};for(const key of deleteKeys)delete nextCiphers[key];deleteKeys=[...new Set([...deleteKeys,...signupCipherCleanup(draft,nextCiphers)])];for(const key of deleteKeys)delete nextCiphers[key];assertBatch5Transition(previous,draft,previousCiphers,nextCiphers);assertRetiredAccounts(previous,draft,previousCiphers,nextCiphers);assertSynthfolkTransition(previous,draft,previousCiphers,nextCiphers);assertAgentboardTransition(previous,draft,previousCiphers,nextCiphers,false,expectedCiphers);assertSwarmMemoTransition(previous,draft,previousCiphers,nextCiphers);assertBerrryTransition(previous,draft,previousCiphers,nextCiphers);assertAgentHowTransition(previous,draft,previousCiphers,nextCiphers);assertTheThingsTransition(previous,draft,previousCiphers,nextCiphers,false,theThingsProgress);assertShellbookTransition(previous,draft,previousCiphers,nextCiphers);assertAgentsGatherTransition(previous,draft,previousCiphers,nextCiphers);assertOpenAgentChatTransition(previous,draft,previousCiphers,nextCiphers);assertAgentRiotTransition(previous,draft,previousCiphers,nextCiphers,false,expectedCiphers);assertColonyTransition(previous,draft,previousCiphers,nextCiphers);assertAgentNotepadTransition(previous,draft,previousCiphers,nextCiphers);assertLargeLanguageTransition(previous,draft,previousCiphers,nextCiphers);assertShareClaimTransition(previous,draft,previousCiphers,nextCiphers);assertKatbinTransition(previous,draft,previousCiphers,nextCiphers);assertMDShareTransition(previous,draft,previousCiphers,nextCiphers);assertPstrsTransition(previous,draft,previousCiphers,nextCiphers);assertYourwebsTransition(previous,draft,previousCiphers,nextCiphers);assertNextgenSlidesTransition(previous,draft,previousCiphers,nextCiphers);assertMemoryWikiTransition(previous,draft,previousCiphers,nextCiphers);assertTotpageTransition(previous,draft,previousCiphers,nextCiphers);assertMDViewTransition(previous,draft,previousCiphers,nextCiphers);assertTxtSbsTransition(previous,draft,previousCiphers,nextCiphers);assertPastyXTransition(previous,draft,previousCiphers,nextCiphers);assertListedStartupsTransition(previous,draft,previousCiphers,nextCiphers);assertProductIndexTransition(previous,draft,previousCiphers,nextCiphers);assertAgentDropTransition(previous,draft,previousCiphers,nextCiphers);assertShipPageTransition(previous,draft,previousCiphers,nextCiphers);assertPasteMystTransition(previous,draft,previousCiphers,nextCiphers);assertMarkdownPasteTransition(previous,draft,previousCiphers,nextCiphers);assertSlugPostTransition(previous,draft,previousCiphers,nextCiphers);assertBrewPageTransition(previous,draft,previousCiphers,nextCiphers);assertCarcinusTransition(previous,draft,previousCiphers,nextCiphers,expectedCiphers)};
    if(expectedCiphers){this.db.exec('BEGIN IMMEDIATE');try{prepare();this.persist(draft!);for(const key of deleteKeys)this.deleteCipher(key);for(const [key,value] of Object.entries(ciphers))if(!deleteKeys.includes(key))this.setCipher(key,value);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
    else{prepare();this.db.exec('BEGIN IMMEDIATE');try{this.persist(draft!);for(const key of deleteKeys)this.deleteCipher(key);for(const [key,value] of Object.entries(ciphers))if(!deleteKeys.includes(key))this.setCipher(key,value);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}}
    this.state=draft!;this.writeRevision++;this.notify();
  }
  private persistWithDeletes(state:State,deleteKeys:string[],body?:string):void {
    if(!deleteKeys.length){this.persist(state,body);return}
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(state,body);for(const key of deleteKeys)this.deleteCipher(key);this.db.exec('COMMIT')}
    catch(error){this.db.exec('ROLLBACK');throw error}
  }
  private persist(state:State,body=JSON.stringify(state)){this.db.prepare('INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(body)}
  log(message:string,options:Partial<Omit<Event,'message'|'id'|'at'>>={}){
    this.update(s=>s.events.push({id:randomUUID(),at:new Date().toISOString(),level:'info',...options,message:message.slice(0,1000)}));
  }
  getCipher(key:string):string|undefined{return (this.db.prepare('SELECT value FROM secrets WHERE key=?').get(key) as {value:string}|undefined)?.value}
  setCipher(key:string,value:string){this.db.prepare('INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  deleteCipher(key:string){this.db.prepare('DELETE FROM secrets WHERE key=?').run(key)}
  allCiphers():Record<string,string>{return Object.fromEntries((this.db.prepare('SELECT key,value FROM secrets').all() as {key:string,value:string}[]).map(x=>[x.key,x.value]))}
  restore(state:State,ciphers:Record<string,string>){
    const previous=this.read(),previousCiphers=this.allCiphers();state=structuredClone(migrateState(state));preserveRetiredAccountsOnRestore(previous,state);assertSignupTransition(previous,state);ciphers={...ciphers};for(const key of signupCipherCleanup(state,ciphers))delete ciphers[key];assertBatch5Transition(previous,state,previousCiphers,ciphers);assertSiteOriginMigrationTransition(previous,state,true);assertOneReviewRetryTransition(previous,state,true);assertAgentboardTransition(previous,state,previousCiphers,ciphers,true);assertSynthfolkTransition(previous,state,previousCiphers,ciphers,true);assertTheThingsTransition(previous,state,previousCiphers,ciphers,true);assertSwarmMemoTransition(previous,state,previousCiphers,ciphers,true);assertBerrryTransition(previous,state,previousCiphers,ciphers,true);assertAgentHowTransition(previous,state,previousCiphers,ciphers,true);assertAgentsGatherTransition(previous,state,previousCiphers,ciphers,true);assertOpenAgentChatTransition(previous,state,previousCiphers,ciphers,true);assertAgentRiotTransition(previous,state,previousCiphers,ciphers,true);assertShellbookTransition(previous,state,previousCiphers,ciphers,true);assertColonyTransition(previous,state,previousCiphers,ciphers,true);assertAgentNotepadTransition(previous,state,previousCiphers,ciphers,true);assertLargeLanguageTransition(previous,state,previousCiphers,ciphers,true);assertShareClaimTransition(previous,state,previousCiphers,ciphers,true,true);assertKatbinTransition(previous,state,previousCiphers,ciphers);assertMDShareTransition(previous,state,previousCiphers,ciphers);assertPstrsTransition(previous,state,previousCiphers,ciphers);assertYourwebsTransition(previous,state,previousCiphers,ciphers);assertNextgenSlidesTransition(previous,state,previousCiphers,ciphers);assertMemoryWikiTransition(previous,state,previousCiphers,ciphers);assertTotpageTransition(previous,state,previousCiphers,ciphers);assertMDViewTransition(previous,state,previousCiphers,ciphers);assertTxtSbsTransition(previous,state,previousCiphers,ciphers);assertPastyXTransition(previous,state,previousCiphers,ciphers);assertListedStartupsTransition(previous,state,previousCiphers,ciphers);assertProductIndexTransition(previous,state,previousCiphers,ciphers);assertAgentDropTransition(previous,state,previousCiphers,ciphers);assertShipPageTransition(previous,state,previousCiphers,ciphers);assertPasteMystTransition(previous,state,previousCiphers,ciphers);assertMarkdownPasteTransition(previous,state,previousCiphers,ciphers);assertSlugPostTransition(previous,state,previousCiphers,ciphers);assertBrewPageTransition(previous,state,previousCiphers,ciphers);assertCarcinusTransition(previous,state,previousCiphers,ciphers);
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(state);this.db.exec('DELETE FROM secrets');for(const [k,v]of Object.entries(ciphers))this.setCipher(k,v);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.state=state;this.writeRevision++;this.notify();
  }
  close(){this.db.close()}
}
