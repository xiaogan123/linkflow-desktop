import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {LARGE_LANGUAGE_SESSION_URL,LARGE_LANGUAGE_CONTRACT_VERSION,largeLanguageHash,largeLanguageRegistrationRequest,largeLanguageMutation,parseLargeLanguageOpaque,parseLargeLanguageRegistration,validLargeLanguageAccountSecret,parseLargeLanguageSession,readLargeLanguageJson,type LargeLanguageDependencies,type LargeLanguageAccountSecret} from '../integrations/large-language';
import type {Account} from '../shared/types';
import {bindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

export async function connectLargeLanguage(store:Store,vault:Vault,input:{token:string;siteIds:string[];accountId?:string;responsibleHuman:string;producerType:'model'|'system';producerName:string},deps:LargeLanguageDependencies={}):Promise<Account>{
  const token=input.token.trim();if(token.length<16||token.length>4096||/[\s\u0000-\u001f\u007f]/.test(token))throw Error('LargeLanguage token 格式无效');
  const responsibleHuman=input.responsibleHuman.trim(),producerName=input.producerName.trim();if(!responsibleHuman||responsibleHuman.length>120||/[\u0000-\u001f\u007f]/.test(responsibleHuman)||!producerName||producerName.length>120||/[\u0000-\u001f\u007f]/.test(producerName)||!['model','system'].includes(input.producerType))throw Error('LargeLanguage 发布来源声明无效');
  const identity=parseLargeLanguageSession(await readLargeLanguageJson(LARGE_LANGUAGE_SESSION_URL,token,deps));if(!identity)throw Error('LargeLanguage token 未返回可核对的发布账号');
  const snapshot=store.read(),existing=snapshot.accounts.filter(account=>!account.retiredAt&&account.channelId==='large-language'),target=input.accountId?existing.find(account=>account.id===input.accountId):existing[0];if(input.accountId&&!target)throw Error('LargeLanguage 原账号不存在');if(existing.some(account=>account.id!==target?.id))throw Error('本机只能连接一个 LargeLanguage 发布账号');if(target?.largeLanguage?.actorId&&target.largeLanguage.actorId!==identity.actorId)throw Error('不能替换已有 LargeLanguage 发布账号');if(target?.largeLanguage&&(target.largeLanguage.responsibleHuman!==responsibleHuman||target.largeLanguage.producerType!==input.producerType||target.largeLanguage.producerName!==producerName))throw Error('LargeLanguage 已绑定的发布来源声明不能替换');for(const siteId of input.siteIds)if(!snapshot.sites.some(site=>site.id===siteId))throw Error('网站不存在');
  const id=target?.id??randomUUID(),stamp=(deps.now?.()??new Date()).toISOString(),operationId=`ll_register_${id.replace(/-/g,'').toLowerCase()}`,requestHash=largeLanguageHash(`imported\n${identity.actorId}\n${identity.displayName}\n${input.producerType}\n${producerName}\n${responsibleHuman}`),fingerprint=createHash('sha256').update(token).digest('hex');
  if(target?.largeLanguage?.stage==='ready'){if(target.largeLanguage.requestHash!==requestHash||target.largeLanguage.tokenFingerprint!==fingerprint||target.username!==identity.displayName)throw Error('LargeLanguage 已连接发布账号或 token 不匹配');store.update(current=>{const channel={id:'large-language',accountRequired:true} as any;for(const siteId of input.siteIds)bindAccount(current,id,siteId,channel)});return target}
  const account:Account={id,channelId:'large-language',email:'',username:identity.displayName,displayName:identity.displayName,createdAt:target?.createdAt??stamp,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',registrationAttempts:target?.registrationAttempts??0,verifiedAt:stamp,updatedAt:stamp,largeLanguage:{version:1,stage:'ready',operationId,requestHash,actorId:identity.actorId,displayName:identity.displayName,responsibleHuman,producerType:input.producerType,producerName,credentialVersion:identity.credentialVersion,tokenFingerprint:fingerprint,checkedAt:stamp}};
  const secret:LargeLanguageAccountSecret={version:1,kind:'large_language_account',operationId,requestHash,displayName:identity.displayName,responsibleHuman,producerType:input.producerType,producerName,createdAt:account.createdAt,token},serialized=JSON.stringify(secret),ciphers=vault.encryptSecrets({[`account:${id}`]:serialized});if(!ciphers[`account:${id}`]||ciphers[`account:${id}`]===serialized)throw Error('LargeLanguage token 未加密');
  store.updateWithCiphers(current=>{if(current.accounts.some(value=>!value.retiredAt&&value.channelId==='large-language'&&value.id!==id))throw Error('本机只能连接一个 LargeLanguage 发布账号');const index=current.accounts.findIndex(value=>value.id===id);if(index>=0)current.accounts[index]=account;else current.accounts.push(account);const channel={id:'large-language',accountRequired:true} as any;for(const siteId of input.siteIds)bindAccount(current,id,siteId,channel)},ciphers);return account;
}

export interface CreateLargeLanguageInput {
  displayName:string; responsibleHuman:string; producerType:'model'|'system'; producerName:string;
  siteIds:string[]; accountId?:string;
}
// A missing response is an uncertain registration, never permission to register again.
export async function createLargeLanguageAccount(store:Store,vault:Vault,input:CreateLargeLanguageInput,deps:LargeLanguageDependencies={}):Promise<Account>{
  const clean=(value:string,max:number)=>{const text=value.trim();if(!text||text.length>max||/[\u0000-\u001f\u007f]/.test(text))throw Error('LargeLanguage 发布账号声明无效');return text};
  const displayName=clean(input.displayName,80),responsibleHuman=clean(input.responsibleHuman,120),producerName=clean(input.producerName,120),producerType=input.producerType;
  if(!['model','system'].includes(producerType))throw Error('LargeLanguage 生成方类型无效');
  const snapshot=store.read(),existing=snapshot.accounts.filter(value=>!value.retiredAt&&value.channelId==='large-language');
  if(existing.length>1||input.accountId&&!existing.some(value=>value.id===input.accountId))throw Error('LargeLanguage 原发布账号无法唯一确认');
  for(const siteId of input.siteIds)if(!snapshot.sites.some(value=>value.id===siteId))throw Error('网站不存在');
  let account=existing[0],secret:LargeLanguageAccountSecret;
  const fresh=!account,stamp=(deps.now?.()??new Date()).toISOString();
  if(account){
    const raw=await vault.get(`account:${account.id}`);let parsed:unknown;try{parsed=JSON.parse(raw??'null')}catch{}
    if(!validLargeLanguageAccountSecret(parsed)||!account.largeLanguage||account.largeLanguage.operationId!==parsed.operationId||account.largeLanguage.requestHash!==parsed.requestHash||account.username!==displayName||parsed.displayName!==displayName||parsed.responsibleHuman!==responsibleHuman||parsed.producerType!==producerType||parsed.producerName!==producerName)throw Error('LargeLanguage 原发布账号或来源声明不一致');
    secret=parsed;
    if(account.largeLanguage.stage==='ready'){
      const verified=parseLargeLanguageSession(await readLargeLanguageJson(LARGE_LANGUAGE_SESSION_URL,secret.token,deps));
      if(!secret.token||largeLanguageHash(secret.token)!==account.largeLanguage.tokenFingerprint||!verified||verified.actorId!==account.largeLanguage.actorId||verified.displayName!==displayName||verified.credentialVersion!==account.largeLanguage.credentialVersion)throw Error('LargeLanguage 原账号验证失败');
      store.update(state=>{for(const siteId of input.siteIds)bindAccount(state,account.id,siteId,{id:'large-language',accountRequired:true} as any)});return account;
    }
    if(!secret.opaqueResponse)throw Error('LargeLanguage 原注册结果未确认，已保留恢复密钥；不会再次注册。');
  }else{
    const id=randomUUID(),recoveryKey=randomBytes(32).toString('base64url'),operationId=`ll_register_${id.replaceAll('-','')}`,request=largeLanguageRegistrationRequest(displayName,recoveryKey);
    secret={version:1,kind:'large_language_account',operationId,requestHash:request.requestHash,displayName,responsibleHuman,producerType,producerName,recoveryKey,createdAt:stamp};
    account={id,channelId:'large-language',email:'',username:displayName,displayName,createdAt:stamp,status:'draft',hasPassword:true,source:'generated',credentialKind:'api_token',registrationAttempts:1,largeLanguage:{version:1,stage:'intent',operationId,requestHash:request.requestHash,displayName,responsibleHuman,producerType,producerName}};
  }
  const id=account.id,key=`account:${id}`;
  const persist=(next:LargeLanguageAccountSecret,stage:'intent'|'opaque_response'|'ready',extra:Partial<NonNullable<Account['largeLanguage']>>={})=>{
    if(!validLargeLanguageAccountSecret(next))throw Error('LargeLanguage 加密的发布账号信息无效');
    const plain=JSON.stringify(next),cipher=vault.encryptSecrets({[key]:plain})[key];if(!cipher||cipher===plain)throw Error('LargeLanguage 发布账号未加密');
    const updated:Account={...account,status:stage==='ready'?'registered':stage==='intent'?'draft':'unknown',hasPassword:true,updatedAt:(deps.now?.()??new Date()).toISOString(),largeLanguage:{...account.largeLanguage!,stage,...extra}};
    store.updateWithCiphers(state=>{
      if(state.accounts.some(value=>!value.retiredAt&&value.channelId==='large-language'&&value.id!==id))throw Error('LargeLanguage 已存在另一个发布账号');
      const index=state.accounts.findIndex(value=>value.id===id);if(index<0)state.accounts.push(updated);else state.accounts[index]=updated;
      if(stage==='ready')for(const siteId of input.siteIds)bindAccount(state,id,siteId,{id:'large-language',accountRequired:true} as any);
    },{[key]:cipher});account=updated;secret=next;return cipher;
  };
  if(fresh){
    const intentCipher=persist(secret,'intent');const saved=await vault.get(key);if(saved!==JSON.stringify(secret))throw Error('LargeLanguage 注册计划加密回读失败');
    const request=largeLanguageRegistrationRequest(displayName,secret.recoveryKey!);
    await largeLanguageMutation(LARGE_LANGUAGE_SESSION_URL,{method:'POST',headers:{accept:'application/json','content-type':'application/json','large-language-contract-version':LARGE_LANGUAGE_CONTRACT_VERSION},body:request.body},async opaque=>{
      if(secret.opaqueResponse)throw Error('LargeLanguage 原注册响应已经保留');persist({...secret,opaqueResponse:opaque},'opaque_response');
    },()=>{const current=store.read().accounts.find(value=>value.id===id);if(current?.largeLanguage?.stage!=='intent'||current.largeLanguage.requestHash!==request.requestHash||current.largeLanguage.operationId!==secret.operationId||store.getCipher(key)!==intentCipher||deps.signal?.aborted)throw Error('LargeLanguage 当前注册授权已改变');return true},deps);
  }
  const raw=secret.opaqueResponse&&parseLargeLanguageOpaque(secret.opaqueResponse,LARGE_LANGUAGE_SESSION_URL,[200,201]),registered=raw===undefined?undefined:parseLargeLanguageRegistration(raw);
  if(!registered||registered.identity.displayName!==displayName)throw Error('LargeLanguage 注册结果尚未确认，已保留同一发布账号和响应；不会重新注册。');
  const verified=parseLargeLanguageSession(await readLargeLanguageJson(LARGE_LANGUAGE_SESSION_URL,registered.token,deps));
  if(!verified||verified.actorId!==registered.identity.actorId||verified.displayName!==displayName||verified.credentialVersion!==registered.identity.credentialVersion)throw Error('LargeLanguage 注册 token 未核对为同一作者');
  persist({...secret,token:registered.token},'ready',{actorId:verified.actorId,credentialVersion:verified.credentialVersion,tokenFingerprint:largeLanguageHash(registered.token),checkedAt:(deps.now?.()??new Date()).toISOString()});return account;
}
