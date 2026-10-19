import type {Channel,ChannelMetric,FinancePlatformCount,FinancePlatformGroup,Site} from './types';
import {eligibilityFor} from '../integrations/eligibility';
import {isRepeatableOfficialArticleChannel,sourceKey} from './publication';
import {channelAutomationKind} from '../ui/channel-automation';
import {channelOnboardingKind} from '../ui/channel-onboarding';

// Only known Ahrefs names are upgraded to DR. A similarly named score or an
// historic page-level score is not evidence of a current Ahrefs domain rating.
export function isAhrefsDrName(name:string):boolean {
 return /^(?:dr|ahrefs\s+dr|ahrefs\s+domain\s+rating|domain\s+rating(?:\s*\(ahrefs\))?)$/i.test(name.trim());
}

export function legacyAuthorityMetrics(authority:Channel['authority'],context:{domain?:string;linkScope?:ChannelMetric['linkScope']}={}):ChannelMetric[] {
 if(!authority)return [];
 const target=authority.target??'';
 const asOf=authority.dataMonth??authority.asOf?.slice(0,7)??'';
 const notes:string[]=[];
 if(!asOf)notes.push('月份不明');
 if(!target)notes.push('测量对象不明');
 const provider=isAhrefsDrName(authority.name)&&authority.scope!=='page'?'ahrefs-dr':`legacy:${authority.name}`;
 const sameHost=!!target&&!!context.domain&&target===context.domain;
 return [{provider,value:authority.value,target,linkScope:context.linkScope==='platform-root'?'platform-root':sameHost?'same-host':'platform-root',asOf,version:'',source:authority.source,...(notes.length?{note:notes.join('；')}:{})}];
}

/** Read new arrays first, retaining old backup/import support without guessing targets. */
export function channelMetrics(channel:Pick<Channel,'metrics'|'authority'>&Partial<Pick<Channel,'domain'>>):ChannelMetric[] {
 return channel.metrics??legacyAuthorityMetrics(channel.authority,{domain:channel.domain});
}

/** Runtime callers can supply actual registry/readiness and identity ownership without I/O here. */
export interface FinancePlatformContext {
  supported?:(channel:Channel)=>boolean;
  readiness?:(channel:Channel)=>'ready'|'autocreate'|'handoff_required'|'manual';
  htmlAppPublicNoticeAccepted?:boolean;
  acceptedChannelIds?:ReadonlySet<string>;
 /** Runtime planner match set, so disabled and unsuitable channels still appear in the eight-way inventory. */
 discoveredChannelIds?:ReadonlySet<string>;
 identitySiteIds?:Readonly<Record<string,readonly string[]>>;
 /** A present account must be checked by the caller; it is not assumed registered. */
 existingAccountChannelIds?:readonly string[];
 /** Supplied directly from schedulableTaskMatches for one task and timestamp. */
 runtime?:{schedulable:(channel:Channel)=>boolean};
 trialStates?:Readonly<Record<string,{trial:boolean}>>;
}
const AUTOMATIC_IDENTITY_CHANNELS=new Set(['telegraph','nostr','mataroa','verbose','deed-page','brewpage','plopino','wordcell','notebin','shippage','slopit','rant']);

function platformGroup(site:Site,channel:Channel,context:FinancePlatformContext):FinancePlatformGroup{
 if(site.category!=='finance'||!eligibilityFor(site,channel).eligible||context.discoveredChannelIds&&!context.discoveredChannelIds.has(channel.id))return 'ineligible';
 const automation=channelAutomationKind(channel),onboarding=channelOnboardingKind(channel);
 if(automation==='disabled')return 'ineligible';
 if(channel.id==='html-app'&&!context.htmlAppPublicNoticeAccepted||channel.id==='paper-wf'&&context.readiness?.(channel)!=='ready')return 'one_time_verification';
 if(onboarding==='wallet'&&['sigle','nuance'].includes(channel.id))return 'wallet_login';
 if(automation==='manual'||automation==='profile')return 'manual_publish';
 if(onboarding==='no_signup')return 'no_signup';
 if(onboarding==='ai_account')return channel.emailRequired?'email_auto':'auto_account';
 if(onboarding==='existing_account'||onboarding==='wallet')return 'connected_auto';
 if(automation==='connected_auto')return 'connected_auto';
 if(automation==='ai_auto')return channel.emailRequired?'email_auto':channel.accountRequired?'auto_account':'no_signup';
 return 'manual_publish';
}

/**
 * Counts distinct, repeatable finance publishing capabilities, not guaranteed indexing
 * or capacity across 100 sites. Trials stay separate from accepted capabilities.
 * Existing connection-only channels are listed separately unless readiness is supplied.
 */
export function countFinanceAutomaticPlatforms(site:Site,channels:readonly Channel[],context:FinancePlatformContext={}):FinancePlatformCount{
 const groupedChannelIds:Record<FinancePlatformGroup,string[]>={no_signup:[],auto_account:[],email_auto:[],one_time_verification:[],connected_auto:[],wallet_login:[],manual_publish:[],ineligible:[]};
 const result:FinancePlatformCount={count:0,channelIds:[],runtimeSchedulableIds:[],trialCount:0,acceptedCount:0,pendingAcceptanceCount:0,confirmationRequiredIds:[],verificationRequiredIds:[],connectionRequiredIds:[],temporaryIds:[],groupedChannelIds};
 for(const channel of channels)groupedChannelIds[platformGroup(site,channel,context)].push(channel.id);
 if(site.category!=='finance')return result;
 const sources=new Set<string>();
 for(const channel of channels){
  const runtime=context.runtime;
  const schedulable=runtime?.schedulable(channel)??true;
  if(runtime&&schedulable)result.runtimeSchedulableIds.push(channel.id);
  if(!eligibilityFor(site,channel).eligible||channel.indexable==='no'||channel.free==='paid'||channel.free==='unknown')continue;
  if(!isRepeatableOfficialArticleChannel(channel)||context.supported?.(channel)===false)continue;
  if(channel.retentionDays!==undefined){result.temporaryIds.push(channel.id);continue;}
  const identitySites=context.identitySiteIds?.[channel.id]??[];
  if(channel.singleSiteOnly&&identitySites.some(siteId=>siteId!==site.id))continue;
  const existingAccount=context.existingAccountChannelIds?.includes(channel.id)||identitySites.length>0;
  const defaultReady=(!channel.accountRequired||AUTOMATIC_IDENTITY_CHANNELS.has(channel.id)&&!existingAccount);
  const readiness=context.readiness?.(channel)??(defaultReady?'autocreate':'handoff_required');
  if(channel.id==='html-app'&&!context.htmlAppPublicNoticeAccepted){result.confirmationRequiredIds!.push(channel.id);continue;}
  if(channel.id==='paper-wf'&&readiness!=='ready'){result.verificationRequiredIds!.push(channel.id);continue;}
  if(!schedulable)continue;
  if(readiness!=='ready'&&readiness!=='autocreate'){
   if(readiness==='handoff_required')result.connectionRequiredIds.push(channel.id);
   continue;
  }
  const source=sourceKey(channel.domain);
  if(sources.has(source))continue;
  sources.add(source);result.channelIds.push(channel.id);
  if(context.trialStates?.[channel.id]?.trial??channel.trial)result.trialCount++;
  else if(context.acceptedChannelIds?.has(channel.id))result.acceptedCount++;
  else result.pendingAcceptanceCount=(result.pendingAcceptanceCount??0)+1;
 }
 result.count=result.channelIds.length;
 return result;
}
