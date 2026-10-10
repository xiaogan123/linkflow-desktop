import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Account,Channel,SecretStore} from '../shared/types';
import type {Store} from './store';
import {bindAccount,unbindAccount} from './account-bindings';
import {CHANNELS} from '../integrations/catalog';
import {connectPaperAccount} from '../integrations/paper';
import {connectHiveAccount} from '../integrations/hive';
import {connectMataroaAccount} from '../integrations/mataroa';
import {serializeProseCredentials,validSerializedProseCredentials} from '../integrations/prose';
import {createProseTransport,ProseTransportError,type ExpectedProseIdentity,type ProseIdentity,type ProseTransport} from '../integrations/prose-transport';

type ChannelId='paper-wf'|'hive'|'mataroa';
type ConnectorOptions={allowDisableNewsletter:boolean};
type Connector=(vault:SecretStore,id:string,username:string,credential:string,options?:ConnectorOptions)=>Promise<{username:string;url:string}>;
export interface ArticleConnectionInput {channelId:ChannelId;username:string;credential:string;siteIds:string[];accountId?:string;allowDisableNewsletter?:boolean}

const ArticleConnectionPayload=z.object({username:z.string().trim().min(1).max(100),credential:z.string().min(1).max(4096),siteIds:z.array(z.string().uuid()).max(1000),accountId:z.string().uuid().optional(),acknowledgePermanent:z.boolean().optional(),allowDisableNewsletter:z.boolean().optional()}).strict();
export function parseArticleConnectionInput(channelId:ChannelId,value:unknown):ArticleConnectionInput{
  const input=ArticleConnectionPayload.parse(value);
  if(channelId==='hive'&&input.acknowledgePermanent!==true)throw Error('请先确认 Hive 文章会保留在公开链上历史中');
  if(channelId!=='mataroa'&&input.allowDisableNewsletter!==undefined)throw Error('关闭 Newsletter 的一次性授权仅适用于 Mataroa');
  return {channelId,username:input.username,credential:input.credential,siteIds:input.siteIds,accountId:input.accountId,
    ...(channelId==='mataroa'?{allowDisableNewsletter:input.allowDisableNewsletter===true}:{})};
}

export interface ProseConnectionInput {privateKey:string;passphrase?:string;siteIds:string[];accountId?:string}
export interface ProseConnectionVault {
  get(key:string):Promise<string|undefined>;
  encryptSecrets(secrets:Record<string,string>):Record<string,string>;
}
export interface ProseConnectionDependencies {transport?:Pick<ProseTransport,'readIdentity'>;signal?:AbortSignal}

const PROSE_INVITATION_UNKNOWN='SSH 身份已只读验证；Prose 邀请和发布资格仍待真实验收，当前不会自动发布。';
const LARGEST_PROSE_IDENTITY:ExpectedProseIdentity={name:'a'.repeat(63),id:'x'.repeat(128),keyFingerprint:'SHA256:'+'A'.repeat(43)};

function same(value:unknown,expected:unknown):boolean{return JSON.stringify(value)===JSON.stringify(expected)}
function accountSnapshot(state:ReturnType<Store['read']>,id:string):Account|undefined{return state.accounts.find(item=>item.id===id)}
function bindingSnapshot(state:ReturnType<Store['read']>,id:string){return state.accountBindings.filter(item=>item.accountId===id&&item.channelId==='prose').sort((a,b)=>a.id.localeCompare(b.id))}
function proseReceiptForIdentity(state:ReturnType<Store['read']>,accountId:string,username:string):boolean{return state.tasks.some(task=>task.channelId==='prose'&&!!task.prose&&(task.accountId===accountId||task.prose.username===username))}

function storedProseIdentity(value:string|undefined,account:Pick<Account,'username'>):ExpectedProseIdentity{
  if(!validSerializedProseCredentials(value,account))throw Error('原 Prose 专用密钥记录不可用，不能替换出版身份');
  try{
    const parsed=JSON.parse(value!) as {identity?:ExpectedProseIdentity};
    if(!parsed.identity)throw Error();
    return {name:parsed.identity.name,id:parsed.identity.id,keyFingerprint:parsed.identity.keyFingerprint};
  }catch{throw Error('原 Prose 专用密钥记录不可用，不能替换出版身份')}
}

function proseConnectionError(cause:unknown):Error{
  const code=cause instanceof ProseTransportError?cause.code:'';
  if(code==='aborted')return Error('已取消 Prose SSH 身份验证，未保存任何更改');
  if(code==='authentication_failed'||code==='credentials_invalid')return Error('Prose 专用 SSH 密钥或口令无法验证');
  if(code==='identity_not_registered')return Error('该 SSH 密钥尚未关联 Prose/Pico 身份；软件不会自动创建账号');
  if(code==='host_key_mismatch')return Error('Prose 固定主机身份校验失败，连接已停止');
  if(code==='timeout'||code==='connection_failed')return Error('Prose SSH 身份验证暂时无法完成，未保存任何更改');
  return Error('Prose SSH 身份返回无效，未保存任何更改');
}

function validProseConnectionChannel(channel:Channel):boolean{
  return channel.id==='prose'&&channel.domain==='prose.sh'&&channel.provenance==='built-in'&&channel.automation==='api'&&channel.kind==='article'&&channel.accountRequired&&channel.articleRequired;
}

/**
 * Read-only SSH identity validation followed by one SQLite transaction for the
 * account, bindings, and encrypted credential. It never writes to Prose.
 */
export async function connectProseAccount(store:Store,vault:ProseConnectionVault,input:ProseConnectionInput,channel:Channel,deps:ProseConnectionDependencies={}):Promise<Account>{
  if(!validProseConnectionChannel(channel))throw Error('Prose 连接目录无效，当前不会保存凭据');
  const privateKey=String(input.privateKey),passphrase=input.passphrase===undefined||input.passphrase===''?undefined:String(input.passphrase),siteIds=[...new Set(input.siteIds)],accountId=input.accountId;
  if(!privateKey||privateKey.includes('\0')||Buffer.byteLength(privateKey,'utf8')>16_384||passphrase?.includes('\0')||passphrase&&Buffer.byteLength(passphrase,'utf8')>4096)throw Error('Prose 专用 SSH 密钥输入无效');
  try{serializeProseCredentials({privateKey,...(passphrase===undefined?{}:{passphrase})},LARGEST_PROSE_IDENTITY)}catch{throw Error('Prose 专用 SSH 密钥和口令超过本机加密记录上限')}
  const first=store.read();
  if(siteIds.some(id=>!first.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=accountId?first.accounts.find(account=>account.id===accountId&&account.channelId==='prose'):undefined;
  if(accountId&&!requested)throw Error('要更新的 Prose 连接不存在');
  if(requested&&requested.source!=='imported')throw Error('原 Prose 身份来源不允许通过此入口替换');
  let oldSecret:string|undefined;
  if(requested){try{oldSecret=await vault.get('account:'+requested.id)}catch{throw Error('无法读取本机加密的 Prose 凭据，请解锁后重试')}}
  const baseline=store.read(),baselineAccount=requested?accountSnapshot(baseline,requested.id):undefined,baselineBindings=requested?bindingSnapshot(baseline,requested.id):[];
  if(requested&&(!same(baselineAccount,requested)||!same(baselineBindings,bindingSnapshot(first,requested.id))))throw Error('读取凭据期间 Prose 连接已改变，请重新打开后再试');
  if(siteIds.some(id=>!baseline.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const oldIdentity=requested?storedProseIdentity(oldSecret,requested):undefined;
  if(deps.signal?.aborted)throw Error('已取消 Prose SSH 身份验证，未保存任何更改');
  let identity:ProseIdentity;
  try{identity=await (deps.transport??createProseTransport()).readIdentity({privateKey,...(passphrase===undefined?{}:{passphrase})},{signal:deps.signal})}
  catch(cause){throw proseConnectionError(cause)}
  if(deps.signal?.aborted)throw Error('已取消 Prose SSH 身份验证，未保存任何更改');
  if(identity.publishingEligibility!=='unknown')throw Error('Prose 身份资格返回异常，未保存任何更改');
  const expected:ExpectedProseIdentity={name:identity.name,id:identity.id,keyFingerprint:identity.keyFingerprint};
  if(oldIdentity&&(oldIdentity.name!==expected.name||oldIdentity.id!==expected.id))throw Error('返回的是另一 Prose 出版身份，请新增连接并保留原任务身份');
  const fingerprintChanged=!!oldIdentity&&oldIdentity.keyFingerprint!==expected.keyFingerprint;
  const serialized=serializeProseCredentials({privateKey,...(passphrase===undefined?{}:{passphrase})},expected);
  if(requested){
    let currentSecret:string|undefined;
    try{currentSecret=await vault.get('account:'+requested.id)}catch{throw Error('无法读取本机加密的 Prose 凭据，请解锁后重试')}
    if(currentSecret!==oldSecret)throw Error('验证期间 Prose 专用密钥已改变，未保存本次输入');
  }
  if(deps.signal?.aborted)throw Error('已取消 Prose SSH 身份验证，未保存任何更改');
  const now=new Date().toISOString(),id=requested?.id??randomUUID(),eligibilityPreviouslyVerified=requested?.status==='registered'&&!fingerprintChanged;
  const account:Account={...requested,id,channelId:'prose',username:identity.name,email:'',displayName:identity.name,publicationUrl:`https://${identity.name}.prose.sh/`,credentialKind:'api_token',status:eligibilityPreviouslyVerified?'registered':'needs_verification',hasPassword:true,source:'imported',createdAt:requested?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:eligibilityPreviouslyVerified?undefined:{code:'verification_required',message:PROSE_INVITATION_UNKNOWN,at:now,retryable:false}};
  const apply=(state:ReturnType<Store['read']>)=>{
    if(siteIds.some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
    if(requested){
      if(!same(accountSnapshot(state,id),baselineAccount)||!same(bindingSnapshot(state,id),baselineBindings))throw Error('SSH 验证期间 Prose 连接或网站绑定已改变，请重试');
      if(fingerprintChanged&&proseReceiptForIdentity(state,id,requested.username))throw Error('原 SSH 身份已有 Prose 发布回执，不能更换密钥指纹');
    }else if(state.accounts.some(item=>item.channelId==='prose'&&item.username===identity.name))throw Error('此 Prose 用户名已有本机连接，请从原连接更新，避免混淆身份');
    const bindable={...account,status:'registered' as const,diagnostic:undefined};
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(bindable);
    for(const siteId of siteIds)bindAccount(state,id,siteId,channel);
    if(requested)for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='prose'&&!siteIds.includes(binding.siteId))unbindAccount(state,id,binding.siteId,'prose');
    const saved=state.accounts.find(item=>item.id===id)!;saved.status=account.status;saved.diagnostic=account.diagnostic;
  };
  let ciphers:Record<string,string>;
  try{
    ciphers=vault.encryptSecrets({['account:'+id]:serialized});
    if(Object.keys(ciphers).length!==1||typeof ciphers['account:'+id]!=='string'||!ciphers['account:'+id])throw Error();
  }catch{throw Error('系统钥匙串不可用，Prose 连接未保存')}
  try{store.updateWithCiphers(apply,ciphers)}catch{throw Error('Prose 连接未保存，本机账号、绑定和凭据保持原状')}
  return account;
}

/** Called only after the desktop's explicit secret-reveal confirmation. Never return a publishing key. */
export function accountLoginPassword(account:Account,secret:string|undefined):string{
  if(account.channelId==='paper-wf'||account.channelId==='mataroa'){
    try{
      const value=JSON.parse(secret??'') as Record<string,unknown>;
      if(value.version!==1||value.username!==account.username||typeof value.password!=='string'||!value.password||value.password.length>1024)throw Error();
      return value.password;
    }catch{throw Error('本机出版账号登录资料无效，请通过连接入口更新');}
  }
  if(['api_token','oauth'].includes(account.credentialKind??''))throw Error('API 令牌不支持明文显示，请通过连接入口更新');
  return secret??'';
}

/** Identity and selected bindings become visible together, after remote validation. */
export async function connectArticleAccount(store:Pick<Store,'read'|'update'>,vault:SecretStore,input:ArticleConnectionInput,connector?:Connector):Promise<Account>{
  const before=store.read(),selected=new Set(input.siteIds),username=input.username.trim().toLowerCase();
  if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
  const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId===input.channelId):undefined;
  if(input.accountId&&!requested)throw Error('要更新的连接不存在');
  if(requested&&requested.username!==username)throw Error('这是另一账号，请新增连接；已有任务保留原身份');
  const previous=requested??before.accounts.find(account=>account.channelId===input.channelId&&account.username===username);
  const id=previous?.id??randomUUID(),oldSecret=await vault.get('account:'+id);
  try{
    const connect=connector??(input.channelId==='hive'?(v,i,u,c)=>connectHiveAccount(v,i,u,c):input.channelId==='mataroa'?(v,i,u,c,options)=>connectMataroaAccount(v,i,u,c,{allowDisableNewsletter:options?.allowDisableNewsletter===true}):(v,i,u,c)=>connectPaperAccount(v,i,u,c));
    const identity=await connect(vault,id,username,input.credential,{allowDisableNewsletter:input.channelId==='mataroa'&&input.allowDisableNewsletter===true});
    if(identity.username!==username)throw Error('验证返回的账号与所选身份不一致');
    const now=new Date().toISOString();
    const account:Account={...previous,id,channelId:input.channelId,username,email:'',displayName:username,publicationUrl:identity.url,credentialKind:'api_token',status:'registered',hasPassword:true,source:previous?.source??'imported',createdAt:previous?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined};
    store.update(state=>{
      if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
      const current=state.accounts.find(item=>item.id===id);
      if(current&&(current.channelId!==input.channelId||current.username!==username))throw Error('连接期间账号身份发生变化');
      if(input.channelId==='mataroa')account.mataroaExcludedSiteIds=state.sites.filter(site=>!selected.has(site.id)).map(site=>site.id);
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id===input.channelId)!;
      for(const siteId of selected)bindAccount(state,id,siteId,channel);
      if(requested||input.channelId==='mataroa')state.accountBindings=state.accountBindings.filter(binding=>binding.accountId!==id||binding.channelId!==input.channelId||selected.has(binding.siteId));
    });
    return account;
  }catch(error){
    if(oldSecret===undefined)await vault.delete('account:'+id);else await vault.set('account:'+id,oldSecret);
    throw error;
  }
}
