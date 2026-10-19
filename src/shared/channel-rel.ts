import type {Channel} from './types';

/** Collapse legacy HTML rel tokens into the catalog's four display states. */
export function normalizeChannelLinkRel(value:unknown):Channel['linkRel'] {
  if(value===undefined)return undefined;
  if(typeof value!=='string')return 'unknown';
  const tokens=new Set(value.trim().toLowerCase().split(/\s+/).filter(Boolean));
  if(tokens.has('nofollow')||tokens.has('sponsored'))return 'nofollow';
  if(tokens.has('ugc'))return 'ugc';
  if(tokens.has('unknown'))return 'unknown';
  if(tokens.size===0||tokens.has('follow')||[...tokens].every(token=>token==='noopener'||token==='noreferrer'))return 'follow';
  return 'unknown';
}
