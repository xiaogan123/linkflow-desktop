import {createHash} from 'node:crypto';
import {fetchHereNowBounded,HERE_NOW_MAX_JSON_BYTES,HERE_NOW_ORIGIN,validHereNowApiKey,type HereNowDependencies} from './here-now';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export interface HereNowIdentity {email:string;accountId:string;displayName:string;keyFingerprint:string;existingSlug?:string;existingSiteUrl?:string}

function exactExistingSite(value:string|undefined):{slug:string;url:string}|undefined{
  if(!value)return;
  try{const url=new URL(value.trim()),match=SLUG.exec(url.hostname.slice(0,-'.here.now'.length));if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname.endsWith('.here.now')||!match)return;return {slug:match[0],url:url.href}}catch{return}
}
async function json(url:string,apiKey:string,deps:HereNowDependencies){
  const {response,bytes}=await fetchHereNowBounded(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{accept:'application/json',authorization:`Bearer ${apiKey}`,'x-herenow-client':'linkflow-desktop'}},deps,HERE_NOW_MAX_JSON_BYTES);if(response.redirected||response.url!==url||response.status!==200||response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')throw Error('response');return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)) as unknown
}

export async function inspectHereNowIdentity(apiKey:string,existingSiteUrl?:string,deps:HereNowDependencies={}):Promise<HereNowIdentity>{
  if(!validHereNowApiKey(apiKey))throw Error('here.now 命名 API key 格式无效');const existing=exactExistingSite(existingSiteUrl);if(existingSiteUrl&&!existing)throw Error('here.now 既有页面必须是精确的 https://<slug>.here.now/ 地址');
  const [emailResult,accountsResult]=await Promise.all([json(`${HERE_NOW_ORIGIN}/api/v1/me/email-change`,apiKey,deps),json(`${HERE_NOW_ORIGIN}/api/v1/accounts`,apiKey,deps)]);
  if(!object(emailResult)||typeof emailResult.email!=='string'||emailResult.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailResult.email)||emailResult.pending!==null)throw Error('here.now 邮箱身份未处于稳定已验证状态');
  if(!object(accountsResult)||!Array.isArray(accountsResult.accounts))throw Error('here.now 账户响应无效');
  const personal=accountsResult.accounts.filter(value=>object(value)&&value.type==='personal'&&value.status==='active'&&value.provisioningStatus==='active'&&value.role==='admin'&&typeof value.accountId==='string'&&UUID.test(value.accountId));
  if(personal.length!==1)throw Error('here.now 个人账户无法唯一确认；不会选择 workspace');const account=personal[0] as Record<string,unknown>;
  if(existing){const site=await json(`${HERE_NOW_ORIGIN}/api/v1/publish/${existing.slug}`,apiKey,deps);if(!object(site)||site.slug!==existing.slug||site.siteUrl!==existing.url||site.status!=='active'||site.expiresAt!==null||typeof site.currentVersionId!=='string'||!site.currentVersionId||site.pendingVersionId!==null||!Array.isArray(site.manifest)||site.manifest.length<1)throw Error('here.now 既有页面不属于当前稳定个人身份，或仍有待完成版本')}
  return {email:emailResult.email.trim().toLowerCase(),accountId:account.accountId as string,displayName:typeof account.displayName==='string'&&account.displayName.trim()?account.displayName.trim().slice(0,80):'here.now 个人账户',keyFingerprint:createHash('sha256').update(apiKey).digest('hex'),...(existing?{existingSlug:existing.slug,existingSiteUrl:existing.url}:{})};
}

export const hereNowAccountTesting={exactExistingSite};
