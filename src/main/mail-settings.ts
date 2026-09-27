import type {Settings} from '../shared/types';
/** A saved mailbox secret belongs to one server, port and account, never a newly selected provider. */
export function mailboxIdentityChanged(previous:Settings['mail'],next:Settings['mail']):boolean{
  const host=(value:string)=>value.trim().toLowerCase().replace(/\.$/,'');
  return host(previous.host)!==host(next.host)||previous.port!==next.port||previous.secure!==next.secure||previous.user.trim()!==next.user.trim();
}
