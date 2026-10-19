import type {Site,Task} from './types';

function canonicalTarget(value:string):string|undefined{
  try{const url=new URL(value);url.hash='';return url.href}catch{return undefined}
}
export function siteAllowsLinkTarget(site:Pick<Site,'linkTargets'>,target:string):boolean{
  if(!site.linkTargets?.length)return true;
  const normalized=canonicalTarget(target);
  return !!normalized&&site.linkTargets.some(value=>canonicalTarget(value)===normalized);
}
export function containsForbiddenSiteTerm(draft:NonNullable<Task['draft']>,site:Pick<Site,'forbiddenTerms'>):boolean{
  const text=[draft.title,draft.description,draft.body].join('\n').normalize('NFKC').toLocaleLowerCase('und');
  return (site.forbiddenTerms??[]).some(term=>!!term.trim()&&text.includes(term.trim().normalize('NFKC').toLocaleLowerCase('und')));
}
