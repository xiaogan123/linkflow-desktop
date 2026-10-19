import type { Account, Mailbox, Site, SiteAccountBinding } from './types';
import {inferMailPreset, type MailboxAutomationLevel} from './mail-presets';

/** New mailbox automation copy is kept here for later editorial review. */
export {MAIL_AUTOMATION_MESSAGES} from './registration-messages';

export interface EmailWait {
  kind:'link'|'code';recipient:string;since:string;nextPollAt:string;expiresAt:string;mailboxId?:string;
  consumedMessageIds:string[];continuation:'shiply'|'here-now'|'signup'|'browser';
}
/** The verification value lives in the vault, never in this public descriptor. */
export interface EmailConfirmation {wait:EmailWait;messageId:string}

export interface MailboxAutomationReadiness {ready:boolean;level:MailboxAutomationLevel}

export function mailboxAutomationReadiness(mailbox:Pick<Mailbox,'host'|'hasPassword'|'verifiedAt'|'lastError'>|undefined):MailboxAutomationReadiness {
  const preset=mailbox&&inferMailPreset({host:mailbox.host});
  const ready=!!mailbox?.hasPassword&&!!mailbox.verifiedAt&&!mailbox.lastError&&preset?.support!=='oauth-required';
  return {ready,level:ready?preset?.automationLevel??'confirmation_required':'unavailable'};
}

/** Password storage alone does not establish that an IMAP connection is usable. */
export function mailboxAutomationReady(mailbox:Pick<Mailbox,'host'|'hasPassword'|'verifiedAt'|'lastError'>|undefined):boolean {
  return mailboxAutomationReadiness(mailbox).ready;
}

export type VerificationMode = 'code' | 'link' | 'either';
export type VerificationCandidate = {kind:'code';code:string}|{kind:'link';url:string;urls?:string[]};
export type VerificationResult =
  | {kind:'none'}
  | {kind:'code';code:string;snippet:string;messageId?:string}
  | {kind:'link';url:string;snippet:string;messageId?:string}
  | {kind:'confirmation_required';candidate:VerificationCandidate;snippet:string;messageId?:string}
  | {kind:'ambiguous';candidates:string[];snippet:string;messageId?:string};

export interface MailboxUsageCounts {siteCount:number;platformCount:number;accountCount:number}
/** Count distinct bound websites/platforms rather than multiplying shared accounts. */
export function mailboxUsageCounts(mailboxId:string,sites:readonly Pick<Site,'id'|'mailboxId'>[],accounts:readonly Pick<Account,'id'|'mailboxId'|'channelId'|'retiredAt'>[],bindings:readonly Pick<SiteAccountBinding,'accountId'|'siteId'|'channelId'>[]=[]):MailboxUsageCounts {
  const matching=accounts.filter(account=>account.mailboxId===mailboxId&&!account.retiredAt);
  const ids=new Set(matching.map(account=>account.id));
  const siteIds=new Set(sites.filter(site=>site.mailboxId===mailboxId).map(site=>site.id));
  const platforms=new Set(matching.map(account=>account.channelId));
  for(const binding of bindings)if(ids.has(binding.accountId)){siteIds.add(binding.siteId);platforms.add(binding.channelId)}
  return {siteCount:siteIds.size,platformCount:platforms.size,accountCount:matching.length};
}

/** A stable, non-identifying pair hash; a website alone never reuses another platform's tag. */
function aliasTag(siteId:string,channelId:string):string {
  const value=JSON.stringify([siteId,channelId]);
  let first=2166136261,second=0x9e3779b9;
  for(let index=0;index<value.length;index++){
    first=Math.imul(first^value.charCodeAt(index),16777619)>>>0;
    second=Math.imul(second^value.charCodeAt(index),2246822519)>>>0;
  }
  return first.toString(36).padStart(7,'0')+second.toString(36).padStart(7,'0');
}

/** QQ, custom hosts and providers without dependable plus delivery are deliberately excluded. */
export function generateMailAlias(mailbox:Pick<Mailbox,'user'|'host'>,siteId:string,channelId:string):string|undefined {
  const address=mailbox.user.trim().toLowerCase(),at=address.lastIndexOf('@');
  if(at<1||!siteId||!channelId)return;
  const local=address.slice(0,at),domain=address.slice(at+1),host=mailbox.host.toLowerCase().replace(/\.$/,'');
  const supported=host==='imap.gmail.com'&&['gmail.com','googlemail.com'].includes(domain);
  if(!supported||local.includes('+')||!/^[a-z0-9._-]+$/i.test(local))return;
  const alias=`${local}+lf${aliasTag(siteId,channelId)}@${domain}`;
  return alias.length<=254&&alias.slice(0,alias.indexOf('@')).length<=64?alias:undefined;
}
