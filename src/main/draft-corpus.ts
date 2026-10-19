import type {Site,Task} from '../shared/types';
import {scanDraftDiversity,type DiversityDraft} from './draft-diversity';
export function draftCorpus(tasks:readonly Task[],sites:readonly Site[]):DiversityDraft[]{
  return tasks.flatMap(task=>{
    const base={siteId:task.siteId,siteName:sites.find(site=>site.id===task.siteId)?.name};
    const rows:DiversityDraft[]=task.draft?[{...base,id:task.id,createdAt:task.firstLiveAt??task.submittedAt??task.createdAt,writingEnvelope:task.writingEnvelope,...task.draft}]:[];
    for(const [index,attempt] of (task.articleAttempts??[]).entries())if(attempt.draft)rows.push({...base,id:`${task.id}:attempt:${index}`,createdAt:attempt.recordedAt,...attempt.draft});
    for(const [index,entry] of (task.draftHistory??[]).entries())rows.push({...base,id:`${task.id}:history:${index}`,createdAt:entry.at,writingEnvelope:entry.writingEnvelope,...entry.draft});
    return rows;
  });
}
export function scanStoredDraft(task:Task,tasks:readonly Task[],sites:readonly Site[],now=new Date()){
  if(!task.draft)return {duplicate:false,matches:[],sharedSentences:[],conflictingExcerpts:[]};
  return scanDraftDiversity({id:task.id,siteId:task.siteId,siteName:sites.find(site=>site.id===task.siteId)?.name,createdAt:task.createdAt,writingEnvelope:task.writingEnvelope,...task.draft},draftCorpus(tasks,sites),{now,siteNames:sites.map(site=>site.name)});
}
