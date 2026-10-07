import {isDeepStrictEqual} from 'node:util';
import {hasRecoverablePublisherDraftReceipt} from '../shared/publication';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {ArticleReviewMode,Site} from '../shared/types';
import type {State} from './store';

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

function invalidateModeTransition(state:State,siteId:string,nextMode:ArticleReviewMode,stamp:string){
  for(const task of state.tasks.filter(item=>item.siteId===siteId&&(!item.submittedAt||hasRecoverablePublisherDraftReceipt(item))&&!item.firstLiveAt)){
    task.articleApprovedAt=undefined;
    task.articleReview=undefined;
    task.updatedAt=stamp;
    if(nextMode==='manual'&&task.draft&&task.checkpoint==='article_review'&&['queued','needs_input','failed'].includes(task.status)){
      task.status='needs_input';
      task.message='稿件审核已切换为人工；请重新确认当前稿件后再发布。';
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
  for(const task of state.tasks.filter(item=>item.siteId===site.id&&(!item.submittedAt||hasRecoverablePublisherDraftReceipt(item))&&!item.firstLiveAt)){
    let changed=false;
    if(draftChanged&&task.draft&&!task.submittedAt){task.draft=undefined;changed=true}
    if(reviewChanged&&(task.articleApprovedAt||task.articleReview)){task.articleApprovedAt=undefined;task.articleReview=undefined;changed=true}
    if(changed)task.updatedAt=stamp;
  }
  if(reviewModeChanged)invalidateModeTransition(state,site.id,currentReviewMode,stamp);
  return {siteId:site.id,reviewModeChanged,previousReviewMode,currentReviewMode};
}

/** Reconcile only legacy sites whose effective mode changed with the global setting. */
export function reconcileGlobalArticleReviewMode(state:State,previousSettings:Pick<State['settings'],'articleReviewMode'>,now:Date=new Date()):string[]{
  const stamp=now.toISOString(),changed:string[]=[];
  for(const site of state.sites){
    const before=getArticleReviewMode(site,previousSettings),after=getArticleReviewMode(site,state.settings);
    if(before===after)continue;
    invalidateModeTransition(state,site.id,after,stamp);
    changed.push(site.id);
  }
  return changed;
}
