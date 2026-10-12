import type {Account} from './types';

export function validNotebinAccount(account:Account|undefined):boolean{
  const proof=account?.notebin,journal=account?.notebinJournal,signup=journal?.signup,mint=journal?.mint,root=journal?.rootBinding,key=mint?.receipt;
  if(!account||account.channelId!=='notebin'||account.email!==''||account.username!=='pow-root'||account.source!=='generated'||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||account.publicationUrl||!proof||!journal||journal.localAccountId!==account.id)return false;
  if(proof.version!==1||proof.audience!=='https://notebin.ca'||JSON.stringify(proof.scopes)!==JSON.stringify(['note:read','note:create'])||proof.rootIdentity!=='exact_readback'||!['exact_response','exact_readback'].includes(proof.keyBinding))return false;
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(proof.rootAccountId)||!/^[A-Za-z0-9_-]{8,128}$/.test(proof.keyId)||![proof.rootKeyFingerprint,proof.whoamiResponseHash,proof.noteKeyFingerprint,proof.keyListResponseHash,proof.noteReadResponseHash].every(value=>/^[a-f0-9]{64}$/.test(value))||!Number.isFinite(Date.parse(proof.verifiedAt))||new Date(proof.verifiedAt).toISOString()!==proof.verifiedAt||account.verifiedAt!==proof.verifiedAt)return false;
  if(signup?.stage!=='ready'||signup.receipt?.localAccountId!==account.id||signup.receipt.rootAccountId!==proof.rootAccountId||signup.rootKeyFingerprint!==proof.rootKeyFingerprint)return false;
  if(root?.binding!=='exact_readback'||root.localAccountId!==account.id||root.rootAccountId!==proof.rootAccountId||root.rootKeyFingerprint!==proof.rootKeyFingerprint||root.whoamiResponseHash!==proof.whoamiResponseHash)return false;
  if(mint?.stage!=='ready'||!key||key.localAccountId!==account.id||key.rootAccountId!==proof.rootAccountId||key.audience!==proof.audience||JSON.stringify(key.scopes)!==JSON.stringify(proof.scopes)||key.tokenFingerprint!==proof.noteKeyFingerprint||key.binding!==proof.keyBinding||key.keyId!==undefined&&key.keyId!==proof.keyId)return false;
  return key.binding!=='exact_readback'||key.readbackResponseHash===proof.keyListResponseHash&&key.readbackVerifiedAt===proof.verifiedAt;
}
