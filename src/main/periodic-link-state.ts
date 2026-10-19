import type {Task} from '../shared/types';

const FOUND = new Set(['link_found','legacy_origin']);
const INVALID = new Set(['link_hidden','page_noindex','visibility_unknown','source_mismatch','source_redirect_mismatch','invalid_input']);
const UNREACHABLE = new Set(['page_http_error','page_not_html','page_unreachable']);

/** A public-link observation is separate from, and never advances, a publisher's receipt. */
export function validObservedLinkState(task:Task):boolean {
  const observation=task.linkObservation;
  if(!observation||observation.version!==1||observation.publicUrl!==task.publicUrl||observation.checkedAt!==task.lastCheckedAt)return false;
  const checked=Date.parse(observation.checkedAt),next=Date.parse(task.nextCheckAt??'');
  if(!Number.isFinite(checked)||!Number.isFinite(next)||next<=checked||!task.linkCheckReason||!task.linkCheck)return false;
  if(task.firstLiveAt){
    const first=Date.parse(task.firstLiveAt),verified=Date.parse(task.verifiedAt??'');
    if(!Number.isFinite(first)||!Number.isFinite(verified)||first>verified||verified>checked
      ||!['live','failed','skipped','expired'].includes(task.status)||task.humanAction||task.reviewKind)return false;
    if(task.lostAt){if(!Number.isFinite(Date.parse(task.lostAt))||Date.parse(task.lostAt)>checked||(task.consecutiveMissing??0)<1)return false;}
    else if((task.consecutiveMissing??0)!==0)return false;
  }
  if(FOUND.has(task.linkCheckReason))return task.status==='live'&&task.consecutiveMissing===0&&!task.reviewKind&&task.linkCheck==='found'&&task.health==='healthy'&&!!task.firstLiveAt&&!!task.linkRel&&!task.lostAt&&!task.humanAction;
  if(task.linkCheckReason==='link_absent')return task.linkCheck==='absent'&&task.health==='missing'&&(!task.firstLiveAt||task.status==='live'&&!!task.lostAt&&!task.humanAction);
  return task.health==='unknown'&&(INVALID.has(task.linkCheckReason)&&task.linkCheck==='invalid'||UNREACHABLE.has(task.linkCheckReason)&&task.linkCheck==='unreachable');
}

/** A later link observation does not rewrite a platform's original acceptance. */
export function validPeriodicLinkState(task:Task,acceptedAt:string):boolean{
  const first=Date.parse(task.firstLiveAt??''),verified=Date.parse(task.verifiedAt??''),checked=Date.parse(task.lastCheckedAt??''),next=Date.parse(task.nextCheckAt??''),accepted=Date.parse(acceptedAt);
  if(!task.linkCheckReason||![first,verified,checked,next,accepted].every(Number.isFinite)
    ||first>verified||verified>checked||checked<accepted||next<=checked||task.publicationMethod!=='client')return false;
  if(FOUND.has(task.linkCheckReason))return task.status==='live'&&task.health==='healthy'&&task.linkCheck==='found'
    &&!!task.linkRel&&!task.lostAt&&!task.reviewKind&&task.consecutiveMissing===0;
  if(task.linkCheckReason==='link_absent')return ['live','needs_input'].includes(task.status)&&task.health==='missing'&&task.linkCheck==='absent'
    &&!!task.lostAt&&(!task.reviewKind||task.reviewKind==='lost_link')&&(task.consecutiveMissing??0)>0;
  return ['live','needs_input'].includes(task.status)&&task.health==='unknown'
    &&(INVALID.has(task.linkCheckReason)&&task.linkCheck==='invalid'||UNREACHABLE.has(task.linkCheckReason)&&task.linkCheck==='unreachable');
}
