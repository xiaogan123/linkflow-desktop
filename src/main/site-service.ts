import {isDeepStrictEqual} from 'node:util';
import {canonicalPublicPageUrl,hasRecoverablePublisherDraftReceipt} from '../shared/publication';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {ArticleReviewMode,Site,Task} from '../shared/types';
import type {SiteContentInput} from '../shared/types';
import {createWritingProfile,ensureWritingProfile,writingProfileTooSimilar} from '../shared/writing-profile';
import {SITE_ACTION_MESSAGES} from '../shared/site-action-messages';
import type {State} from './store';
import {hasExternalAttempt} from './task-recovery';
import {publicUrl} from './validation';
import {taskTransition} from './task-state';

export interface SiteEditInput {
  id:string;
  qualifications?:Site['qualifications'];
  name?:string;
  description?:string;
  category?:Site['category'];
  language?:string;
  email?:string;
  publicEmail?:string;
  mailboxId?:string|null;
  monthlyTarget?:number;
  articleReviewMode?:ArticleReviewMode;
}

export interface SiteUpdateResult {
  siteId:string;
  reviewModeChanged:boolean;
  previousReviewMode:ArticleReviewMode;
  currentReviewMode:ArticleReviewMode;
}

const draftFields=['name','description','category','language','email','publicEmail'] as const;
const reviewFields=[...draftFields,'qualifications'] as const;

function invalidateModeTransition(state:State,siteId:string,nextMode:ArticleReviewMode,now:Date){
  const stamp=now.toISOString();
  for(const task of state.tasks.filter(item=>item.siteId===siteId&&(!hasExternalAttempt(item)||hasRecoverablePublisherDraftReceipt(item))&&!item.firstLiveAt)){
    task.articleApprovedAt=undefined;
    task.articleReview=undefined;
    task.updatedAt=stamp;
    if(nextMode==='manual'&&task.draft&&task.checkpoint==='article_review'&&['queued','needs_input','failed'].includes(task.status)){
      Object.assign(task,taskTransition(task,{status:'needs_input',reasonCode:'manual_review',humanAction:undefined,
        waitingSince:undefined,waitingDeadlineAt:undefined,waitingReminderAt:undefined,
        message:'稿件审核已切换为人工；请重新确认当前稿件后再发布。',updatedAt:stamp},now));
    }
  }
}

/** Apply a validated site edit while preserving unchanged drafts and invalidating only affected approvals. */
export function applySiteUpdate(state:State,input:SiteEditInput,now:Date=new Date()):SiteUpdateResult {
  const site=state.sites.find(item=>item.id===input.id);
  if(!site)throw Error('网站不存在');
  if(input.mailboxId&&!state.mailboxes.some(mailbox=>mailbox.id===input.mailboxId))throw Error('收件箱不存在');

  const before=structuredClone(site),previousReviewMode=getArticleReviewMode(site,state.settings);
  for(const key of ['qualifications','name','description','category','language','email','publicEmail','monthlyTarget','articleReviewMode'] as const){
    if(Object.hasOwn(input,key))Object.assign(site,{[key]:input[key]});
  }
  if(Object.hasOwn(input,'publicEmail'))site.email=input.publicEmail!;
  // A field the owner set is theirs: a later analysis no longer treats it as a guess.
  // The edit form always sends all four fields; only a value the owner actually changed stops being a guess.
  if(site.heuristicFields){const kept=site.heuristicFields.filter(field=>!Object.hasOwn(input,field)||site[field]===before[field]);site.heuristicFields=kept.length?kept:undefined}
  if(Object.hasOwn(input,'mailboxId')){
    if(input.mailboxId===null)delete site.mailboxId;
    else site.mailboxId=input.mailboxId;
  }

  const currentReviewMode=getArticleReviewMode(site,state.settings),reviewModeChanged=previousReviewMode!==currentReviewMode;
  const fieldChanged=(key:typeof reviewFields[number])=>key==='publicEmail'
    ?(before.publicEmail||before.email)!==(site.publicEmail||site.email)
    :!isDeepStrictEqual(before[key],site[key]);
  const draftChanged=draftFields.some(fieldChanged);
  const reviewChanged=reviewModeChanged||reviewFields.some(fieldChanged);
  const stamp=now.toISOString();
  for(const task of state.tasks.filter(item=>item.siteId===site.id&&(!hasExternalAttempt(item)||hasRecoverablePublisherDraftReceipt(item))&&!item.firstLiveAt)){
    // Accepted factual reviews bind the frozen draft, policy conclusion and target URL.
    // Editing descriptive site metadata does not replace that accepted draft.
    if(!reviewModeChanged&&task.articleReview?.status==='passed')continue;
    let changed=false;
    if(draftChanged&&task.draft&&!task.submittedAt){task.draft=undefined;changed=true}
    if(reviewChanged&&(task.articleApprovedAt||task.articleReview)){task.articleApprovedAt=undefined;task.articleReview=undefined;changed=true}
    if(changed)task.updatedAt=stamp;
  }
  if(reviewModeChanged)invalidateModeTransition(state,site.id,currentReviewMode,now);
  return {siteId:site.id,reviewModeChanged,previousReviewMode,currentReviewMode};
}

/** Reconcile only legacy sites whose effective mode changed with the global setting. */
export function reconcileGlobalArticleReviewMode(state:State,previousSettings:Pick<State['settings'],'articleReviewMode'>,now:Date=new Date()):string[]{
  const changed:string[]=[];
  for(const site of state.sites){
    const before=getArticleReviewMode(site,previousSettings),after=getArticleReviewMode(site,state.settings);
    if(before===after)continue;
    invalidateModeTransition(state,site.id,after,now);
    changed.push(site.id);
  }
  return changed;
}

/** Pick a different stable profile for future writing without rewriting any stored draft. */
export function rerollSiteWritingProfile(state:State,siteId:string){
  const site=state.sites.find(item=>item.id===siteId);
  if(!site)throw Error(SITE_ACTION_MESSAGES.siteMissing);
  const previous=ensureWritingProfile(site,state.sites);
  const others=state.sites.filter(item=>item.id!==siteId).map(item=>item.writingProfile).filter((profile):profile is NonNullable<typeof profile>=>!!profile);
  for(let collision=0;collision<10_000;collision++){
    const profile=createWritingProfile(site,collision,previous.variantsSource==='analysis'?previous.variants:undefined);
    if(profile.fingerprint===previous.fingerprint||writingProfileTooSimilar(profile,others))continue;
    site.writingProfile=profile;
    return profile;
  }
  throw Error(SITE_ACTION_MESSAGES.profileUnavailable);
}

/** This edit stores the promotion configuration and preserves publication history. */
export function updateSiteContent(state:State,input:SiteContentInput,now:Date=new Date()){
  const site=state.sites.find(item=>item.id===input.id);
  if(!site)throw Error(SITE_ACTION_MESSAGES.siteMissing);
  const normalize=(value:string)=>{
    let parsed:URL;
    try{parsed=publicUrl(value)}catch{throw Error(SITE_ACTION_MESSAGES.invalidContentUrl)}
    if(parsed.hostname.replace(/^www\./,'')!==new URL(site.url).hostname.replace(/^www\./,''))throw Error(SITE_ACTION_MESSAGES.invalidContentUrl);
    parsed.hash='';return parsed.href;
  };
  const previous=new Map<string,NonNullable<Site['topics']>[number]>();
  for(const topic of site.topics??[]){try{previous.set(normalize(topic.url),topic)}catch{/* Invalid legacy topics do not prevent replacing the list. */}}
  const previousConstraints={linkTargets:site.linkTargets,forbiddenTerms:site.forbiddenTerms};
  const topics=new Map<string,NonNullable<Site['topics']>[number]>();
  for(const topic of input.topics){
    const url=normalize(topic.url);
    topics.set(url,{...previous.get(url),url,title:topic.title||undefined,discoveredAt:previous.get(url)?.discoveredAt??now.toISOString()});
  }
  const linkTargets=[...new Set(input.linkTargets.map(normalize))];
  const selected=new Set(topics.keys());
  const excluded=new Set([...(site.topicOverrides?.excluded??[]),...[...previous.keys()].filter(url=>!selected.has(url))]);
  for(const url of selected)excluded.delete(url);
  site.topicOverrides={added:[...topics.values()],excluded:[...excluded].slice(-10000)};
  site.topics=[...topics.values()];site.linkTargets=linkTargets;site.forbiddenTerms=[...new Set(input.forbiddenTerms)];
  site.topicsCheckedAt=now.toISOString();site.topicsAttemptedAt=now.toISOString();site.topicsError=undefined;
  if(!isDeepStrictEqual(previousConstraints,{linkTargets:site.linkTargets,forbiddenTerms:site.forbiddenTerms})){
    for(const task of state.tasks.filter(item=>item.siteId===site.id&&(!hasExternalAttempt(item)||hasRecoverablePublisherDraftReceipt(item))&&!item.firstLiveAt)){
      task.articleApprovedAt=undefined;task.articleReview=undefined;task.updatedAt=now.toISOString();
    }
  }
}

/** Keep manual additions/removals when the existing automatic discovery refreshes. */
/** Open, deferred or recoverable work and posts still waiting for their first check keep their topic; finished work frees the slot. */
export function reservesTopic(task:Pick<Task,'topicUrl'|'firstLiveAt'|'submittedAt'|'status'>&Partial<Pick<Task,'deferredAt'|'recoveryEligible'|'draft'>>):boolean{
  // A skipped task that kept its draft can still be restored, and its evidence needs the topic to stay listed.
  return !!task.topicUrl&&!task.firstLiveAt&&(!!task.submittedAt||!!task.deferredAt||!!task.recoveryEligible||!!task.draft||!['failed','skipped','expired'].includes(task.status));
}

export function mergeDiscoveredSiteTopics(site:Site,discovered:NonNullable<Site['topics']>,reserved:ReadonlySet<string|undefined>):NonNullable<Site['topics']>{
  // A retained topic takes the fresh title and date when the page is found again; an excluded one is only kept for an open task.
  const fresh=new Map(discovered.map(topic=>[canonicalPublicPageUrl(topic.url),topic]));
  const retained=(site.topics??[]).filter(topic=>{const key=canonicalPublicPageUrl(topic.url);return !!key&&reserved.has(key)}).map(topic=>{const found=fresh.get(canonicalPublicPageUrl(topic.url));return found?{...found,url:topic.url}:topic});
  if(!site.topicOverrides)return [...retained,...discovered.filter(topic=>!retained.some(old=>canonicalPublicPageUrl(old.url)===canonicalPublicPageUrl(topic.url)))].slice(0,200);
  const excluded=new Set(site.topicOverrides.excluded.map(canonicalPublicPageUrl));
  const result=new Map(retained.map(topic=>[canonicalPublicPageUrl(topic.url),topic]));
  for(const topic of [...site.topicOverrides.added,...discovered]){
    const key=canonicalPublicPageUrl(topic.url);
    if(key&&!excluded.has(key)&&!result.has(key))result.set(key,topic);
  }
  return [...result.values()].slice(0,200);
}
