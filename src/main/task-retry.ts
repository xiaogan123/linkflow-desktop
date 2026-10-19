import type {Task} from '../shared/types';
import {hasUnresolvedExternalAttempt,hasRecoverablePublisherDraftReceipt} from '../shared/publication';

/** Shared by task retry and explicit completion of scriptless handoffs. */
export function taskRetryHasExternalAttempt(t:Task):boolean {
  return t.checkpoint==='verbose_account_create_pending'&&!t.deferredAt||!!((hasUnresolvedExternalAttempt(t)&&!hasRecoverablePublisherDraftReceipt(t))||(t.submittedAt||t.agentboard||t.agentsWiki||t.paper||t.hive||t.mataroa||t.verbose||t.prose||t.rentry||t.lucid||t.wordpress||t.leaflet||t.raindrop||t.supanote||t.docsMd||t.katbin||t.pstrs||t.agentdrop||t.listedStartups||t.productIndex||t.totpage||t.mdview||t.txtsbs||t.pastyx||t.nextgenSlides||t.yourwebs||t.pastemyst||t.markdownPaste||t.htmlApp||t.memoryWiki)&&!hasRecoverablePublisherDraftReceipt(t)||t.checkpoint==='submitting');
}
