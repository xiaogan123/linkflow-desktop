/** DeployHTML preparation only. Owner-read API and authentication remain unverified; no sender is exposed. */
import {load} from 'cheerio';
import type {Batch5Intent,Batch5OpaqueResponse} from './batch5-contract';
import {hashBatch5,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const DEPLOYHTML_API='https://deployhtml.com/api/deploy';
const TOKEN=/^[A-Za-z0-9_-]{16,512}$/,SLUG=/^[a-z0-9](?:[a-z0-9-]{2,61})[a-z0-9]$/;
export interface DeployHtmlCredential {version:1;apiToken:string}
export function parseDeployHtmlCredential(raw:string|undefined):DeployHtmlCredential|undefined{
 try{const v=JSON.parse(raw??'null');if(v&&v.version===1&&typeof v.apiToken==='string'&&TOKEN.test(v.apiToken))return {version:1,apiToken:v.apiToken}}catch{/* untrusted */}
}
/** Explicitly local: this fingerprint is not a verified remote email or account identifier. */
export function deployHtmlKeyIdentity(token:string):string{if(!TOKEN.test(token))throw Error('deployhtml_token_invalid');return `deployhtml-key:${hashBatch5(token)}`}
export function deployHtmlPublicUrl(slug:unknown):string|undefined{
 return typeof slug==='string'&&SLUG.test(slug)&&!['www','api','app','admin','mail','cdn','static','dashboard','account','login','signup'].includes(slug)?`https://${slug}.deployhtml.com/`:undefined;
}
export function deployHtmlDocument(context:ConnectedContext):{title:string;html:string;target:string;rel:string;request:string;sourceHash:string;requestHash:string}{
 const a=context.getAccount(),draft=context.task.draft;
 if(!a||a.channelId!=='deployhtml'||context.task.channelId!=='deployhtml'||a.id!==context.task.accountId||a.ownerSiteId!==context.site.id||a.status!=='registered'||a.retiredAt||!a.hasPassword||a.credentialKind!=='api_token'||a.email!==''||!/^deployhtml-key:[a-f0-9]{64}$/.test(a.username)||context.site.category!=='software'||!draft||!context.task.topicUrl)throw Error('deployhtml_identity_invalid');
 const target=new URL(context.task.topicUrl),home=new URL(context.site.url);
 if(home.protocol!=='https:'||target.protocol!=='https:'||target.hostname!==home.hostname||target.username||target.password||target.hash||target.port)throw Error('deployhtml_target_invalid');
 const title=draft.title.trim();if(!title||title.length>200||/[\r\n]/.test(title))throw Error('deployhtml_title_invalid');
 const {html}=renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'deployhtml-docs'}),$=load(html),links=$('a[href]');
 if(links.length!==1||links.attr('href')!==target.href||Buffer.byteLength(html)>1_000_000)throw Error('deployhtml_document_invalid');
 return {title,html,target:target.href,rel:links.attr('rel')??'',request:html,sourceHash:hashBatch5(JSON.stringify({taskId:context.task.id,siteId:context.site.id,accountId:a.id,keyIdentity:a.username,html,target:target.href})),requestHash:hashBatch5(html)};
}
/** Only the documented authenticated permanent response; never infer ownership from a guessed URL. */
export function deployHtmlOriginalReceipt(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent):{slug:string;url:string;rawResponse:string}|undefined{
 if(intent.channelId!=='deployhtml'||!value||![200,201].includes(value.status)||value.responseUrl!==DEPLOYHTML_API||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>100_000)return;
 try{const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;const rawResponse=new TextDecoder('utf-8',{fatal:true}).decode(bytes),v=JSON.parse(rawResponse),url=deployHtmlPublicUrl(v?.slug);
  if(!url||v.permanent!==true||![url,url.slice(0,-1)].includes(v.url)||['claimUrl','claim_token','claimToken','expires_in','expiresIn'].some(k=>k in v)||['expires_at','expiresAt'].some(k=>k in v&&v[k]!==null))return;
  return {slug:v.slug,url,rawResponse};
 }catch{return}
}
