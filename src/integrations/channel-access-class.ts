import type {Channel,Site} from '../shared/types';
import {eligibilityFor} from './eligibility';

type AccessClass=NonNullable<Channel['accessClass']>;
type BuiltInAccessClass=Exclude<AccessClass,'unqualified'>;

// Identity setup is a property of a platform. Suitability is evaluated for each
// site below; it cannot be inferred from the platform's setup method alone.
const WALLET=new Set(['sigle','nuance']);
const HUMAN_VERIFY_ONCE=new Set(['paper-wf','here-now']);
// Paragraph publishes with a publication API key and Hive with an existing posting key: both are connected once.
const CONNECT_ONCE=new Set([
  'hackmd','whitewind','raindrop','prose','github-gist','paragraph','hive',
  'bluesky','blogger','leaflet','wordpress-com','product-index',
]);
// The software requests and reads the Shiply code from the site's inbox.
const EMAIL_AUTO=new Set(['shiply']);
// These accept an anonymous page with no account at all.
const DIRECT_SUBMIT=new Set(['brewpage','deed-page']);

export function builtInAccessClass(channel:Pick<Channel,'id'|'automation'|'accountRequired'|'emailRequired'>):BuiltInAccessClass {
  if(WALLET.has(channel.id))return 'wallet';
  if(HUMAN_VERIFY_ONCE.has(channel.id))return 'human_verify_once';
  if(CONNECT_ONCE.has(channel.id))return 'connect_once';
  if(EMAIL_AUTO.has(channel.id))return 'email_auto';
  if(DIRECT_SUBMIT.has(channel.id))return 'direct_submit';
  // A platform the owner posts to by hand stays "你来发" even when it needs no account.
  if(channel.automation==='manual')return 'manual';
  if(!channel.accountRequired)return 'direct_submit';
  // Browser automation with the owner's own account (GitHub, GitLab, …): connect the account once, then the scheduler posts.
  if(channel.automation!=='api')return 'connect_once';
  return channel.emailRequired?'email_auto':'auto_account';
}

/** A per-site snapshot. Ineligible is computed from the same gate as scheduling. */
export function channelAccessClassForSite(site:Site,channel:Channel):AccessClass {
  if(!eligibilityFor(site,channel).eligible)return 'unqualified';
  return channel.accessClass??'manual';
}

export function channelAccessSnapshot(site:Site,channels:readonly Channel[]):Array<{channelId:string;accessClass:AccessClass}> {
  return channels.map(channel=>({channelId:channel.id,accessClass:channelAccessClassForSite(site,channel)}));
}
