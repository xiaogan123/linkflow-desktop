import {createHash} from 'node:crypto';
import {marked} from 'marked';
import {drainOpenAgentChatPendingOperations,isOpenAgentChatOpaqueProgress,openAgentChatStreamingMutation,parseOpenAgentChatOpaque,type OpenAgentChatDependencies,type OpenAgentChatOpaqueResponse} from './openagentchat';

export const AGENTSWIKI_ORIGIN='https://agents-wiki.com';
export const AGENTSWIKI_META=`${AGENTSWIKI_ORIGIN}/api/v1/meta`;
export const AGENTSWIKI_REGISTER=`${AGENTSWIKI_ORIGIN}/api/v1/agents/register`;
export const AGENTSWIKI_ME=`${AGENTSWIKI_ORIGIN}/api/v1/agents/me`;
export const AGENTSWIKI_ARTICLES=`${AGENTSWIKI_ORIGIN}/api/v1/articles`;
export const AGENTSWIKI_VALIDATE=`${AGENTSWIKI_ARTICLES}/validate`;
export const AGENTSWIKI_RULE_VERSION='2026-10-13';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY=/^aw_[A-Za-z0-9_-]{32,4096}$/;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,min:number,max:number):v is string=>typeof v==='string'&&v.length>=min&&v.length<=max&&v===v.trim()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export const agentsWikiHash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
function publicHttps(v:unknown):v is string {if(typeof v!=='string'||v.length>2000)return false;try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&u.hostname.includes('.')&&!u.hostname.endsWith('.local')&&!/^[\d.]+$/.test(u.hostname)}catch{return false}}
function ownPage(v:unknown):v is string {if(!publicHttps(v))return false;const u=new URL(v);return u.origin===AGENTSWIKI_ORIGIN&&!u.hash&&/^\/wiki\/[a-z0-9][a-z0-9-]{0,240}$/.test(u.pathname)}
function list(v:unknown,max:number,itemMax:number){return Array.isArray(v)&&v.length<=max&&v.every(x=>text(x,1,itemMax))&&new Set(v).size===v.length}
export interface AgentsWikiSource {title:string;url:string;attribution?:string;license?:string;quote?:string}
export type AgentsWikiDependencies=OpenAgentChatDependencies;
export interface AgentsWikiDraft {title:string;summary:string;language:string;type:'article'|'methodology'|'experience'|'hypothesis'|'question';tags:string[];body:string;sources:AgentsWikiSource[];basis:string;attribution:string[];change_notice:string;related:string[];applies_to:string[];symptoms?:string[];content_as_of:string}
export interface AgentsWikiRegistration {name:string;public_disclosure:string;rule_version:typeof AGENTSWIKI_RULE_VERSION;publication_rights:true}
export interface AgentsWikiAccount {id:string;name:string;publicDisclosure:string|null;role:'agent'|'editor';createdAt:string;keyPrefix:string|null}
export interface AgentsWikiArticleReceipt {id:string;etag:string;revision:number;canonicalUrl:string|null}
export interface AgentsWikiIntent {version:1;kind:'registration'|'publication';accountId:string;taskId:string;createdAt:string;requestHash:string;sourceHash:string;idempotencyKey?:string}
export interface AgentsWikiAccountSecret {version:1;kind:'agentswiki_account';mode:'generated'|'imported';operationId:string;requestHash:string;registration?:AgentsWikiRegistration;intent?:AgentsWikiIntent;opaqueResponse?:OpenAgentChatOpaqueResponse;account?:AgentsWikiAccount;apiKey?:string}
export interface AgentsWikiPublicationSecret {version:1;kind:'agentswiki_publication';intent:AgentsWikiIntent;opaqueResponse?:OpenAgentChatOpaqueResponse;receipt?:AgentsWikiArticleReceipt}
export interface AgentsWikiAcceptanceEvidence {checkedAt:string;apiMatched:true;nativeMatched:true;robotsAllowed:true;pageIndexable:true;linkRel:string}
export interface AgentsWikiPersistence<T> {
 loadPriorRaw():Promise<string|undefined>;
 persistIntent(intent:AgentsWikiIntent):Promise<void>;
 assertAuthorized(intent:AgentsWikiIntent):true;
 // The consumer must atomically encrypt snapshots and require isOpenAgentChatOpaqueProgress.
 persistOpaque(intent:AgentsWikiIntent,response:OpenAgentChatOpaqueResponse):Promise<void>;
 persistReceipt(intent:AgentsWikiIntent,receipt:T):Promise<void>;
}
export interface AgentsWikiRegistrationPersistence extends AgentsWikiPersistence<{account:AgentsWikiAccount;apiKey:string}> {accountId:string;loadSecret():Promise<AgentsWikiAccountSecret|undefined>}
export interface AgentsWikiPublicationPersistence extends AgentsWikiPersistence<AgentsWikiArticleReceipt> {loadSecret():Promise<AgentsWikiPublicationSecret|undefined>;promotePublished(intent:AgentsWikiIntent,receipt:AgentsWikiArticleReceipt,evidence:AgentsWikiAcceptanceEvidence):Promise<void>}
// Official responses may include a content digest in addition to ID and revision.
// Preserve the complete token; metadata and content readback must match it exactly.
export function validAgentsWikiArticleEtag(value:unknown,id:unknown,revision:unknown):value is string {
 if(typeof id!=='string'||!UUID.test(id)||!Number.isSafeInteger(revision)||Number(revision)<1||typeof value!=='string')return false;
 const prefix='"'+id+':'+revision;
 return value===prefix+'"'||value.startsWith(prefix+':')&&/^[a-f0-9]{16}"$/.test(value.slice(prefix.length+1));
}
export function validAgentsWikiApiKey(value:unknown):value is string{return typeof value==='string'&&KEY.test(value)}
export function validAgentsWikiPublicDisclosure(value:unknown):value is string{return text(value,1,500)}
export function validAgentsWikiRegistration(value:unknown):value is AgentsWikiRegistration{return record(value)&&Object.keys(value).sort().join(',')==='name,public_disclosure,publication_rights,rule_version'&&text(value.name,2,100)&&validAgentsWikiPublicDisclosure(value.public_disclosure)&&value.rule_version===AGENTSWIKI_RULE_VERSION&&value.publication_rights===true}
export function validAgentsWikiIntent(value:unknown,kind?:AgentsWikiIntent['kind']):value is AgentsWikiIntent {if(!record(value)||Object.keys(value).some(k=>!['version','kind','accountId','taskId','createdAt','requestHash','sourceHash','idempotencyKey'].includes(k))||value.version!==1||!['registration','publication'].includes(String(value.kind))||kind!==undefined&&value.kind!==kind||!UUID.test(String(value.accountId))||!UUID.test(String(value.taskId))||!date(value.createdAt)||typeof value.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(value.requestHash)||typeof value.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceHash)||value.idempotencyKey!==undefined&&(typeof value.idempotencyKey!=='string'||!/^[\x21-\x7e]{8,128}$/.test(value.idempotencyKey)))return false;return value.kind==='publication'?typeof value.idempotencyKey==='string':value.idempotencyKey===undefined}
export function validAgentsWikiOpaque(value:unknown):value is OpenAgentChatOpaqueResponse {return !!value&&typeof value==='object'&&isOpenAgentChatOpaqueProgress(value as OpenAgentChatOpaqueResponse,value as OpenAgentChatOpaqueResponse)}
export function validAgentsWikiAccountSecret(value:unknown):value is AgentsWikiAccountSecret {if(!record(value)||value.version!==1||value.kind!=='agentswiki_account'||!['generated','imported'].includes(String(value.mode))||typeof value.operationId!=='string'||!/^agentswiki_(?:register|import)_[a-f0-9]{32}$/.test(value.operationId)||typeof value.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(value.requestHash)||value.registration!==undefined&&!validAgentsWikiRegistration(value.registration)||value.intent!==undefined&&!validAgentsWikiIntent(value.intent,'registration')||value.opaqueResponse!==undefined&&!validAgentsWikiOpaque(value.opaqueResponse)||value.account!==undefined&&(!record(value.account)||!parseAgentsWikiAccount({id:value.account.id,name:value.account.name,public_disclosure:value.account.publicDisclosure,role:value.account.role,created_at:value.account.createdAt,key_prefix:value.account.keyPrefix}))||value.apiKey!==undefined&&!validAgentsWikiApiKey(value.apiKey))return false;if(value.mode==='generated'&&(!value.registration||!value.intent))return false;if(value.mode==='imported'&&(value.registration!==undefined||value.intent!==undefined||value.opaqueResponse!==undefined))return false;return (value.account===undefined)===(value.apiKey===undefined)}
export function validAgentsWikiPublicationSecret(value:unknown):value is AgentsWikiPublicationSecret {if(!record(value)||value.version!==1||value.kind!=='agentswiki_publication'||!validAgentsWikiIntent(value.intent,'publication')||value.opaqueResponse!==undefined&&!validAgentsWikiOpaque(value.opaqueResponse))return false;if(value.receipt===undefined)return true;const receipt=value.receipt;return record(receipt)&&UUID.test(String(receipt.id))&&validAgentsWikiArticleEtag(receipt.etag,receipt.id,receipt.revision)&&Number.isSafeInteger(receipt.revision)&&Number(receipt.revision)>=1&&(receipt.canonicalUrl===null||ownPage(receipt.canonicalUrl))}
export const drainAgentsWikiPendingOperations=drainOpenAgentChatPendingOperations;
export function agentsWikiArticleApi(id:string){if(!UUID.test(id))throw Error('Agents Wiki article ID 无效');return `${AGENTSWIKI_ARTICLES}/${id}`}
export function agentsWikiDraftRequest(value:unknown,targetUrl:string){
 if(!record(value)||Object.keys(value).some(k=>!['title','summary','language','type','tags','body','sources','basis','attribution','change_notice','related','applies_to','symptoms','content_as_of'].includes(k))||!text(value.title,3,200)||!text(value.summary,10,1000)||!text(value.language,2,35)||!['article','methodology','experience','hypothesis','question'].includes(String(value.type))||!list(value.tags,12,40)||(value.tags as string[]).some(t=>!/^\p{Ll}[\p{Ll}\p{N}-]*$/u.test(t))||typeof value.body!=='string'||Buffer.byteLength(value.body)>65536||value.body.trim().length<10||/[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(value.body)||!Array.isArray(value.sources)||value.sources.length>24||!text(value.basis,10,2000)||!list(value.attribution,100,2000)||!text(value.change_notice,1,1000)||!list(value.related,20,36)||(value.related as string[]).some(x=>!UUID.test(x))||!list(value.applies_to,12,500)||value.symptoms!==undefined&&!list(value.symptoms,12,500)||!date(value.content_as_of)||!publicHttps(targetUrl))throw Error('Agents Wiki 稿件字段无效');
 for(const s of value.sources){if(!record(s)||Object.keys(s).some(k=>!['title','url','attribution','license','quote'].includes(k))||!text(s.title,1,250)||!publicHttps(s.url)||s.attribution!==undefined&&!text(s.attribution,0,1000)||s.license!==undefined&&!text(s.license,0,100)||s.quote!==undefined&&!text(s.quote,0,200))throw Error('Agents Wiki 来源字段无效')}
 const sources=value.sources as unknown as AgentsWikiSource[],hosts=new Set(sources.map(s=>new URL(s.url).hostname));let targetFound=false;
 marked.walkTokens(marked.lexer(value.body),token=>{if(token.type==='html'||token.type==='image')throw Error('Agents Wiki 不允许原始 HTML 或图片');if(token.type==='link'){if(!publicHttps(token.href)||!hosts.has(new URL(token.href).hostname))throw Error('Agents Wiki 正文链接必须来自已列明来源');if(token.href===targetUrl)targetFound=true}});
 if(!targetFound||!sources.some(s=>s.url===targetUrl))throw Error('Agents Wiki 目标必须是正文实际引用的来源');
 const draft=value as unknown as AgentsWikiDraft,body=JSON.stringify(draft);if(Buffer.byteLength(body)>131072)throw Error('Agents Wiki 请求超过限制');return {draft,body,sourceHash:agentsWikiHash(body)};
}
export function parseAgentsWikiAccount(v:unknown):AgentsWikiAccount|undefined {
 if(!record(v)||typeof v.id!=='string'||!UUID.test(v.id)||!text(v.name,2,100)||v.public_disclosure!==null&&!text(v.public_disclosure,0,500)||!['agent','editor'].includes(String(v.role))||!date(v.created_at)||v.key_prefix!==null&&!text(v.key_prefix,3,100))return;
 return {id:v.id,name:v.name,publicDisclosure:v.public_disclosure as string|null,role:v.role as 'agent'|'editor',createdAt:v.created_at,keyPrefix:v.key_prefix as string|null};
}
export function parseAgentsWikiRegistration(v:unknown,draft:AgentsWikiRegistration){const account=parseAgentsWikiAccount(v);if(!account||!record(v)||!KEY.test(String(v.api_key))||v.rule_version!==draft.rule_version||account.name!==draft.name||account.publicDisclosure!==draft.public_disclosure||!account.keyPrefix||!(v.api_key as string).startsWith(account.keyPrefix))return;return {account,apiKey:v.api_key as string}}
export function parseAgentsWikiArticleReceipt(v:unknown):AgentsWikiArticleReceipt|undefined {if(!record(v)||typeof v.id!=='string'||!UUID.test(v.id)||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||!validAgentsWikiArticleEtag(v.etag,v.id,v.revision)||v.canonical_url!==undefined&&v.canonical_url!==null&&!ownPage(v.canonical_url))return;return {id:v.id,etag:v.etag as string,revision:v.revision as number,canonicalUrl:(v.canonical_url??null) as string|null}}
async function readAgentsWikiJson(url:string,key:string|undefined,deps:OpenAgentChatDependencies){
 const headers:Record<string,string>={accept:'application/json'};if(key)headers.authorization=`Bearer ${key}`;
 const raw=await openAgentChatStreamingMutation(url,{method:'GET',headers},async()=>{},()=>true,deps),value=raw&&parseOpenAgentChatOpaque(raw,url,200);
 if(value===undefined)throw Error('Agents Wiki 检查未完成');return value;
}
export async function readAgentsWikiMeta(deps:OpenAgentChatDependencies={}){
 const v=await readAgentsWikiJson(AGENTSWIKI_META,undefined,deps);
 if(!record(v)||v.name!=='Agents Wiki'||v.license!=='CC-BY-4.0'||v.rule_version!==AGENTSWIKI_RULE_VERSION||v.writes_enabled!==true||v.registration_enabled!==true||!record(v.registration)||v.registration.url!==AGENTSWIKI_REGISTER||v.registration.method!=='POST'||v.registration.key_shown_once!==true)throw Error('Agents Wiki 当前贡献规则或开放状态已变更');return v;
}
async function mutate<T>(kind:AgentsWikiIntent['kind'],url:string,body:string,input:{accountId:string;taskId:string},p:AgentsWikiPersistence<T>,parse:(v:unknown)=>T|undefined,deps:OpenAgentChatDependencies,apiKey?:string,idempotencyKey?:string){
 if(!UUID.test(input.accountId)||!UUID.test(input.taskId))throw Error('Agents Wiki 本地发布账号无效');
 if(await p.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
 const requestHash=agentsWikiHash(`POST\n${url}\nidempotency-key:${idempotencyKey??''}\ncontent-type:application/json\n\n${body}`),intent:AgentsWikiIntent={version:1,kind,...input,createdAt:(deps.now?.()??new Date()).toISOString(),requestHash,sourceHash:agentsWikiHash(body),...(idempotencyKey?{idempotencyKey}:{})};
 await readAgentsWikiMeta(deps);
 try{await p.persistIntent(intent)}catch{return {status:'not_started' as const}};
 const headers:Record<string,string>={accept:'application/json','content-type':'application/json'};if(apiKey)headers.authorization=`Bearer ${apiKey}`;if(idempotencyKey)headers['idempotency-key']=idempotencyKey;
 const raw=await openAgentChatStreamingMutation(url,{method:'POST',headers,body},v=>p.persistOpaque(intent,v),()=>p.assertAuthorized(intent),deps);
 if(!raw)return {status:'unknown' as const,intent};const receipt=parse(parseOpenAgentChatOpaque(raw,url,201));if(!receipt)return {status:'unknown' as const,intent};
 try{await p.persistReceipt(intent,receipt);return {status:'receipt' as const,intent,receipt}}catch{return {status:'persistence_unknown' as const,intent}}
}
export async function registerAgentsWiki(input:{accountId:string;taskId:string;draft:AgentsWikiRegistration},p:AgentsWikiPersistence<{account:AgentsWikiAccount;apiKey:string}>,deps:OpenAgentChatDependencies={}){
 const d=input.draft;if(!validAgentsWikiRegistration(d))throw Error('Agents Wiki 注册需要真实发布者披露及当前投稿权利确认');
 return mutate('registration',AGENTSWIKI_REGISTER,JSON.stringify(d),{accountId:input.accountId,taskId:input.taskId},p,v=>parseAgentsWikiRegistration(v,d),deps);
}
export async function publishAgentsWiki(input:{accountId:string;taskId:string;draft:AgentsWikiDraft;targetUrl:string;apiKey:string;idempotencyKey:string;validation:{sourceHash:string;remoteAccountId:string};account:AgentsWikiAccount},p:AgentsWikiPersistence<AgentsWikiArticleReceipt>,deps:OpenAgentChatDependencies={}){
 const r=agentsWikiDraftRequest(input.draft,input.targetUrl);if(!KEY.test(input.apiKey)||!/^[\x21-\x7e]{8,128}$/.test(input.idempotencyKey)||input.validation.sourceHash!==r.sourceHash||input.validation.remoteAccountId!==input.account.id)throw Error('Agents Wiki 稿件未按原内容通过平台预检');
 if(await p.loadPriorRaw()!==undefined)return {status:'prior_intent' as const};
 await readAgentsWikiOwnAccount(input.account,input.apiKey,deps);
 return mutate('publication',AGENTSWIKI_ARTICLES,r.body,{accountId:input.accountId,taskId:input.taskId},p,parseAgentsWikiArticleReceipt,deps,input.apiKey,input.idempotencyKey);
}
export async function readAgentsWikiOwnAccount(expected:AgentsWikiAccount,apiKey:string,deps:OpenAgentChatDependencies={}){if(!KEY.test(apiKey))throw Error('Agents Wiki 密钥无效');const account=parseAgentsWikiAccount(await readAgentsWikiJson(AGENTSWIKI_ME,apiKey,deps));if(!account||JSON.stringify(account)!==JSON.stringify(expected))throw Error('Agents Wiki 原账号不匹配');return account}
export async function readAgentsWikiCurrentAccount(apiKey:string,deps:OpenAgentChatDependencies={}){if(!KEY.test(apiKey))throw Error('Agents Wiki 密钥无效');const account=parseAgentsWikiAccount(await readAgentsWikiJson(AGENTSWIKI_ME,apiKey,deps));if(!account)throw Error('Agents Wiki 密钥未返回可核对的 agent 发布账号');return account}

export async function validateAgentsWikiDraft(input:{draft:AgentsWikiDraft;targetUrl:string;account:AgentsWikiAccount;apiKey:string;reviewedSimilarIds:string[]},authorize:()=>true,deps:OpenAgentChatDependencies={}){
 const r=agentsWikiDraftRequest(input.draft,input.targetUrl);await readAgentsWikiOwnAccount(input.account,input.apiKey,deps);
 // The documented validation endpoint does not save an article or consume write quota.
 const raw=await openAgentChatStreamingMutation(AGENTSWIKI_VALIDATE,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${input.apiKey}`},body:r.body},async()=>{},authorize,deps);
 const v=raw&&parseOpenAgentChatOpaque(raw,AGENTSWIKI_VALIDATE,200);
 if(!record(v)||v.valid!==true||!Array.isArray(v.problems)||v.problems.length||!Array.isArray(v.missing)||v.missing.length||v.write_gate!==null||!Array.isArray(v.allowed_actions)||!v.allowed_actions.includes('create own articles')||!Array.isArray(v.similar)||v.similar.some(s=>!record(s)||typeof s.id!=='string'||!UUID.test(s.id)||!input.reviewedSimilarIds.includes(s.id)))throw Error('Agents Wiki 平台预检未通过或出现未核对的相似文章');
 return {sourceHash:r.sourceHash,remoteAccountId:input.account.id};
}
function comparableSources(value:unknown){if(!Array.isArray(value))return;const result=[];for(const v of value){if(!record(v)||!text(v.title,1,250)||!publicHttps(v.url))return;result.push({title:v.title,url:v.url,attribution:v.attribution??'',license:v.license??'',quote:v.quote??''})}return result}
function sameDate(a:unknown,b:string){return date(a)&&new Date(a).toISOString()===new Date(b).toISOString()}
// Operator enrichment may add a representation validator without changing the prose revision.
function agentsWikiMetadataEtagMatches(value:unknown,original:string){
 if(value===original)return true;
 if(typeof value!=='string'||!original.endsWith('"'))return false;
 const prefix=original.slice(0,-1)+':view-';
 return value.startsWith(prefix)&&/^[a-f0-9]{32}"$/.test(value.slice(prefix.length));
}
function agentsWikiSameItems(a:unknown,b:string[]){return Array.isArray(a)&&a.every(v=>typeof v==='string')&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort())}
function agentsWikiAttributionMatches(value:unknown,draft:AgentsWikiDraft,account:AgentsWikiAccount){
 if(agentsWikiSameItems(value,draft.attribution))return true;
 const credit=`Agent ${account.id} (${account.name})`;
 return agentsWikiSameItems(value,[...draft.attribution,credit]);
}
export function agentsWikiReadbackMatches(meta:unknown,content:unknown,receipt:AgentsWikiArticleReceipt,account:AgentsWikiAccount,draft:AgentsWikiDraft){
 if(!record(meta)||!record(content)||meta.id!==receipt.id||content.id!==receipt.id||meta.created_by!==account.id||meta.updated_by!==account.id||meta.revision!==receipt.revision||content.revision!==receipt.revision||!agentsWikiMetadataEtagMatches(meta.etag,receipt.etag)||content.etag!==receipt.etag||meta.visibility!=='public'||meta.license!=='CC-BY-4.0'||content.license!=='CC-BY-4.0'||!['unreviewed','reviewed'].includes(String(meta.status))||content.status!==meta.status||content.untrusted_content!==true||content.translated_from!=null||!ownPage(meta.canonical_url)||content.canonical_url!==meta.canonical_url||receipt.canonicalUrl!==null&&receipt.canonicalUrl!==meta.canonical_url||meta.canonical_url!==`${AGENTSWIKI_ORIGIN}/wiki/${meta.slug}`||meta.content_url!==`${agentsWikiArticleApi(receipt.id)}/content`||meta.markdown_url!==`${agentsWikiArticleApi(receipt.id)}/content?format=markdown`||!date(meta.created_at)||!date(meta.updated_at)||content.body!==draft.body||!sameDate(meta.content_as_of,draft.content_as_of)||!sameDate(content.content_as_of,draft.content_as_of))return false;
 for(const k of ['title','summary','language','type','basis','change_notice'] as const)if(meta[k]!==draft[k]||content[k]!==draft[k])return false;
 if(!agentsWikiAttributionMatches(meta.attribution,draft,account)||!agentsWikiAttributionMatches(content.attribution,draft,account)||!agentsWikiSameItems(meta.attribution,content.attribution as string[]))return false;
 // Scope is required to match in authoritative metadata. The content representation
 // documents these fields as optional and currently emits empty arrays for them.
 if(JSON.stringify(meta.applies_to)!==JSON.stringify(draft.applies_to)||content.applies_to!==undefined&&(!Array.isArray(content.applies_to)||content.applies_to.length>0&&JSON.stringify(content.applies_to)!==JSON.stringify(draft.applies_to)))return false;
 if(!agentsWikiSameItems(meta.tags,draft.tags)||JSON.stringify(meta.related)!==JSON.stringify(draft.related)||JSON.stringify(meta.symptoms??[])!==JSON.stringify(draft.symptoms??[])||JSON.stringify(content.symptoms??[])!==JSON.stringify(draft.symptoms??[]))return false;
 const sources=JSON.stringify(comparableSources(draft.sources));return sources===JSON.stringify(comparableSources(meta.sources))&&sources===JSON.stringify(comparableSources(content.sources));
}
// Robots patterns contain only literal fragments, '*' and an optional final '$'.
// Consume fragments from left to right; never compile remote rules into a backtracking regex.
function agentsWikiRobotsPatternMatches(pattern:string,path:string){
 const anchored=pattern.endsWith('$'),plain=anchored?pattern.slice(0,-1):pattern,parts=plain.split('*');
 if(!path.startsWith(parts[0]))return false;
 if(parts.length===1)return !anchored||path.length===plain.length;
 let position=parts[0].length;
 for(let i=1;i<parts.length;i++){
  const part=parts[i];
  if(anchored&&i===parts.length-1)return path.endsWith(part)&&path.length-part.length>=position;
  if(!part)continue;
  const found=path.indexOf(part,position);if(found<0)return false;position=found+part.length;
 }
 return true;
}
export function agentsWikiRobotsAllows(text:string,path:string,agent:string){
 if(Buffer.byteLength(text)>131072||path.length>2048)return false;
 type G={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:G[]=[];let g:G={agents:[],rules:[]};
 const push=()=>{if(g.agents.length)groups.push(g);g={agents:[],rules:[]}};
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){
  const m=raw.replace(/#.*$/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!m)continue;
  const key=m[1].trim().toLowerCase(),value=m[2].trim();
  if(key==='user-agent'){if(g.rules.length)push();g.agents.push(value.toLowerCase())}
  else if((key==='allow'||key==='disallow')&&g.agents.length&&value)g.rules.push({allow:key==='allow',pattern:value});
 }
 push();
 const choices=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(v=>v.score>=0);
 if(!choices.length)return true;
 const score=Math.max(...choices.map(v=>v.score)),rules=choices.filter(v=>v.score===score).flatMap(v=>v.value.rules);
 let winner:{allow:boolean;n:number}|undefined;
 for(const rule of rules){
  if(!agentsWikiRobotsPatternMatches(rule.pattern,path))continue;
  const next={allow:rule.allow,n:Buffer.byteLength(rule.pattern.replace(/\$$/,'').replace(/\*/g,''))};
  if(!winner||next.n>winner.n||next.n===winner.n&&next.allow)winner=next;
 }
 return winner?.allow??true;
}
export async function readAgentsWikiRobots(publicUrl:string,deps:OpenAgentChatDependencies={}){
 if(!ownPage(publicUrl))throw Error('Agents Wiki 抓取规则检查地址无效');
 const url=AGENTSWIKI_ORIGIN+'/robots.txt',raw=await openAgentChatStreamingMutation(url,{method:'GET',headers:{accept:'text/plain'}},async()=>{},()=>true,deps);
 if(!raw||raw.status!==200||raw.redirected||raw.responseUrl!==url||!raw.bodyComplete||raw.contentType.split(';',1)[0].trim().toLowerCase()!=='text/plain')throw Error('Agents Wiki 抓取规则读取未完成');
 const body=Buffer.from(raw.bodyBase64,'base64');if(body.length>131072)throw Error('Agents Wiki 抓取规则超过大小上限');
 const rules=new TextDecoder('utf-8',{fatal:true}).decode(body),pathname=new URL(publicUrl).pathname;
 if(!['googlebot','bingbot','*'].every(agent=>agentsWikiRobotsAllows(rules,pathname,agent)))throw Error('Agents Wiki 抓取规则不允许搜索引擎抓取该页');
 return true as const;
}
export async function readAgentsWikiArticle(input:{receipt:AgentsWikiArticleReceipt;account:AgentsWikiAccount;apiKey:string;draft:AgentsWikiDraft},deps:OpenAgentChatDependencies={}){
 await readAgentsWikiOwnAccount(input.account,input.apiKey,deps);
 const url=agentsWikiArticleApi(input.receipt.id),meta=await readAgentsWikiJson(url,undefined,deps),content=await readAgentsWikiJson(`${url}/content`,undefined,deps);
 if(!agentsWikiReadbackMatches(meta,content,input.receipt,input.account,input.draft))throw Error('Agents Wiki 作者、原稿与公开元数据不一致');const canonicalUrl=(meta as Record<string,unknown>).canonical_url as string;await readAgentsWikiRobots(canonicalUrl,deps);return {canonicalUrl};
}
