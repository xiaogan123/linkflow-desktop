import {randomUUID} from 'node:crypto';
import {probeValTownAccount,validValTownToken,type ValTownDependencies} from '../integrations/valtown';
import {CHANNELS} from '../integrations/catalog';
import {saveVerifiedValTownAccount,type ValTownChannelResolver} from './valtown-publication';
import type {Store} from './store';
import type {Vault} from './vault';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type StateStore=Pick<Store,'read'|'updateWithCiphers'|'getCipher'>;
type SecureVault=Pick<Vault,'encryptSecrets'>;
export interface ValTownConnectionInput{token:string;siteIds:string[];accountId?:string}
export interface ValTownConnectionDependencies extends ValTownDependencies{resolveChannel?:ValTownChannelResolver;randomUUID?:()=>string}

export async function connectValTownAccount(store:StateStore,vault:SecureVault,input:ValTownConnectionInput,deps:ValTownConnectionDependencies={}){
  const token=input.token.trim(),siteIds=[...new Set(input.siteIds)];if(!validValTownToken(token)||!siteIds.length||siteIds.some(id=>!UUID.test(id)))throw Error('Val Town token or site selection invalid');
  const snapshot=store.read();if(siteIds.some(id=>!snapshot.sites.some(site=>site.id===id)))throw Error('Val Town selected site missing');
  const resolver=deps.resolveChannel??((_,id)=>CHANNELS.find(channel=>channel.id===id)),channel=resolver(structuredClone(snapshot),'valtown');if(!channel||channel.id!=='valtown'||channel.domain!=='val.town'||channel.automation!=='api'||channel.kind!=='article'||!channel.accountRequired||!channel.articleRequired||channel.emailRequired||!channel.enabled)throw Error('Val Town channel is unavailable');
  const probe=await probeValTownAccount(token,{fetch:deps.fetch,signal:deps.signal,timeoutMs:deps.timeoutMs,now:deps.now,allowExternalWrite:false});if(probe.status!=='usable')throw Error(`Val Town read-only account probe failed: ${probe.reason}`);
  const accountId=input.accountId??(deps.randomUUID??randomUUID)();if(!UUID.test(accountId))throw Error('Val Town account id invalid');return saveVerifiedValTownAccount(store,vault,{accountId,binding:probe.binding,token,siteIds,channel,checkedAt:probe.binding.checkedAt});
}
