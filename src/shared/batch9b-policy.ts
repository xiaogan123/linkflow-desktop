import type {Site,Task} from './types';
function dateKey(value:Date|string,timeZone:string){return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}
import {BATCH9B_MESSAGES} from './batch9b-messages';
import {REFERRAL_MESSAGES} from './referral-messages';
import {canonicalPublicPageUrl} from './publication';

function sameUrl(left:string|undefined,right:string|undefined){try{return !!left&&!!right&&new URL(left).href===new URL(right).href}catch{return false}}
/** The same page with or without "www." is not a new address worth asking about. */
function sameSite(left:string|undefined,right:string|undefined){const a=canonicalPublicPageUrl(left),b=canonicalPublicPageUrl(right);return !!a&&a===b}

export function hasPendingManualReview(tasks:readonly Task[],siteId:string,exceptId?:string):boolean {
  return tasks.some(task=>task.id!==exceptId&&task.siteId===siteId&&task.status==='needs_input'&&task.reasonCode==='manual_review'&&!!task.draft);
}
/** A new analysis supplies missing facts; identity changes remain a reviewable proposal. */
/**
 * Fields an analysis may still fill: all of them on a fresh placeholder site, otherwise the empty ones and
 * those only the page heuristic filled. Whatever the owner typed is never overwritten.
 */
export function analysisFillableFields(site:Site):Array<'name'|'description'|'language'|'category'>{
  const initialPlaceholder=!site.analyzedAt&&site.status==='analyzing'&&site.name===site.domain&&site.category==='general'&&site.language==='en'&&!site.description;
  return (['name','description','language','category'] as const).filter(field=>initialPlaceholder||!site[field]?.trim()||!!site.heuristicFields?.includes(field));
}
export function applySiteAnalysis(site:Site,facts:Partial<Pick<Site,'name'|'description'|'language'|'category'|'url'|'domain'>>,now=new Date(),fromAi=true):void {
  const heuristic=new Set(site.heuristicFields??[]);
  for(const field of analysisFillableFields(site))if(facts[field]){Object.assign(site,{[field]:facts[field]});if(fromAi)heuristic.delete(field);else heuristic.add(field)}
  site.heuristicFields=heuristic.size?[...heuristic]:undefined;
  const proposal:NonNullable<Site['analysisProposal']>={analyzedAt:now.toISOString()};
  for(const field of ['url','domain'] as const){
    const value=facts[field];if(!value)continue;
    if(!site[field])site[field]=value;
    else if(field==='url'&&sameUrl(site.url,value))site.url=new URL(value).href; // only a trailing slash or case: adopt the canonical form
    else if(field==='url'&&sameSite(site.url,value))continue;
    else if(site[field]!==value)proposal[field]=value;
  }
  site.analysisProposal=proposal.url||proposal.domain?proposal:undefined;
  site.analyzedAt=now.toISOString();site.status=site.status==='paused'?'paused':'ready';site.error=undefined;
}
export function remoteContentTodos(tasks:readonly Task[]){
  return tasks.flatMap(task=>{
    const scan=task.remoteContentScan;if(!scan||!task.publicUrl)return [];
    const base={taskId:task.id,siteId:task.siteId,publicUrl:task.publicUrl};
    // "Stop reminding me" is given on the referral card, so it quiets only that finding.
    return [...(scan.referral&&!scan.acknowledgedAt?[{...base,kind:'referral' as const,message:REFERRAL_MESSAGES.remoteHold}]:[]),
      ...(scan.legacyMarkers.length?[{...base,kind:'legacy_marker' as const,markers:scan.legacyMarkers,message:BATCH9B_MESSAGES.legacyMarker}]:[])];
  });
}
export function publicationDailySummary(tasks:readonly Task[],now:Date,timeZone:string,since?:string){
  const today=dateKey(now,timeZone);
  const sameDay=(at:string|undefined)=>!!at&&Number.isFinite(Date.parse(at))&&(since?Date.parse(at)>Date.parse(since)&&Date.parse(at)<=now.getTime():dateKey(at,timeZone)===today);
  return {success:tasks.filter(task=>sameDay(task.firstLiveAt)).length,
    failure:tasks.filter(task=>task.status==='failed'&&sameDay(task.updatedAt)).length};
}
