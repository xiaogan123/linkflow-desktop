import {randomUUID} from 'node:crypto';
import {probeBitbucketBinding,validBitbucketToken,type BitbucketDependencies,type BitbucketFreePlanEvidence} from '../integrations/bitbucket';
import {CHANNELS} from '../integrations/catalog';
import {saveVerifiedBitbucketAccount} from './bitbucket-publication';
import type {Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REMOTE_UUID=/^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/iu;
type StateStore=Pick<Store,'read'|'updateWithCiphers'|'getCipher'>;
export interface BitbucketConnectionInput {token:string;workspaceSlug:string;projectUuid:string;freePlanEvidence:BitbucketFreePlanEvidence;siteIds:string[];accountId?:string}

export async function connectBitbucketAccount(store:StateStore,vault:Pick<Vault,'encryptSecrets'>,input:BitbucketConnectionInput,deps:BitbucketDependencies={}){
  const token=input.token.trim(),siteIds=[...new Set(input.siteIds)],snapshot=store.read();
  if(!validBitbucketToken(token)||!SLUG.test(input.workspaceSlug)||!REMOTE_UUID.test(input.projectUuid)||siteIds.length!==1||!UUID.test(siteIds[0])||!snapshot.sites.some(site=>site.id===siteIds[0])||input.accountId!==undefined&&!UUID.test(input.accountId))throw Error('Bitbucket connection input invalid');
  const channel=CHANNELS.find(value=>value.id==='bitbucket');if(!channel||channel.domain!=='bitbucket.io'||channel.automation!=='api'||!channel.accountRequired||!channel.articleRequired||!channel.singleSiteOnly)throw Error('Bitbucket channel unavailable');
  const probe=await probeBitbucketBinding({token,workspaceSlug:input.workspaceSlug,projectUuid:input.projectUuid,freePlanEvidence:structuredClone(input.freePlanEvidence)},{...deps,allowExternalWrite:false});if(probe.status!=='usable')throw Error(`Bitbucket read-only account probe failed: ${probe.reason}`);
  return saveVerifiedBitbucketAccount(store,vault,{accountId:input.accountId??randomUUID(),binding:probe.binding,token,freePlanEvidence:input.freePlanEvidence,siteId:siteIds[0],channel});
}
