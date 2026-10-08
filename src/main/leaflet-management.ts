import {randomUUID} from 'node:crypto';
import type {Account,SecretStore} from '../shared/types';
import type {Store} from './store';
import {bindAccount,unbindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {connectLeafletAccount,type LeafletDependencies} from '../integrations/leaflet';

type StateStore=Pick<Store,'read'|'update'>;
export interface LeafletSelection {handle:string;appPassword:string;siteIds:string[];accountId?:string}
export interface LeafletManagementDependencies extends LeafletDependencies {connect?:typeof connectLeafletAccount}

/** Explicit Leaflet connection; never borrows another channel's saved credentials. */
export async function connectLeaflet(store:StateStore,vault:SecretStore,input:LeafletSelection,dependencies:LeafletManagementDependencies={}):Promise<Account>{
  const before=store.read(),selected=new Set(input.siteIds);
  const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId==='leaflet'):undefined;
  if(input.accountId&&!requested)throw Error('要更新的 Leaflet 连接不存在');
  const validateSelection=(state:ReturnType<StateStore['read']>)=>{if([...selected].some(id=>!state.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');};
  validateSelection(before);
  // Verify a new connection under a temporary vault key until its stable DID is known.
  const temporaryId=randomUUID(),temporaryKey=`account:${temporaryId}`;
  let destinationKey:string|undefined,previousSecret:string|undefined,wroteDestination=false;
  try{
    const verified=await (dependencies.connect??connectLeafletAccount)(vault,temporaryId,input.handle,input.appPassword,dependencies);
    const url=new URL(verified.publicationUrl);
    if(url.origin!=='https://leaflet.pub'||url.pathname!==`/p/${verified.did}`||url.search||url.hash||!/^did:(?:plc|web):[A-Za-z0-9:._%-]{1,240}$/.test(verified.did))throw Error('Leaflet 发布身份无法核对');
    const currentState=store.read();validateSelection(currentState);
    const old=requested??currentState.accounts.find(account=>account.channelId==='leaflet'&&account.publicationUrl===verified.publicationUrl);
    if(requested&&requested.publicationUrl!==verified.publicationUrl)throw Error('新的应用密码属于另一个发布身份，不会替换原连接');
    const id=old?.id??randomUUID(),now=new Date().toISOString();
    const secret=await vault.get(temporaryKey);if(!secret)throw Error('Leaflet 凭据验证未完成');
    const account:Account={...old,id,channelId:'leaflet',username:verified.username,publicationUrl:verified.publicationUrl,displayName:`@${verified.username}`,credentialKind:'api_token',email:'',hasPassword:true,status:'registered',source:'imported',createdAt:old?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined};
    destinationKey=`account:${id}`;previousSecret=await vault.get(destinationKey);await vault.set(destinationKey,secret);wroteDestination=true;
    store.update(state=>{
      validateSelection(state);
      const current=state.accounts.find(item=>item.id===id);
      if(old&&(!current||current.channelId!=='leaflet'||current.publicationUrl!==verified.publicationUrl))throw Error('Leaflet 身份在连接期间发生变化');
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id==='leaflet');if(!channel)throw Error('Leaflet 渠道尚未就绪');
      if(requested)for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='leaflet'&&!selected.has(binding.siteId))unbindAccount(state,id,binding.siteId,'leaflet');
      for(const siteId of selected)bindAccount(state,id,siteId,channel);
    });
    return account;
  }catch(error){
    if(wroteDestination&&destinationKey){if(previousSecret===undefined)await vault.delete(destinationKey);else await vault.set(destinationKey,previousSecret);}
    // Transport details and credentials never cross IPC.
    const message=error instanceof Error?error.message:'';
    if(['所选网站已不存在','Leaflet 身份在连接期间发生变化','新的应用密码属于另一个发布身份，不会替换原连接'].includes(message)||message.includes('必须保留原'))throw Error(message);
    throw Error('Leaflet 连接未完成，请检查本人账号和应用专用密码；原身份与任务保留');
  }finally{await vault.delete(temporaryKey);}
}
