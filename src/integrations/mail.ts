import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import https from 'node:https';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import { load } from 'cheerio';
import type { ExecutionContext, Mailbox, SecretStore, Settings } from '../shared/types';
import {inferMailPreset} from '../shared/mail-presets';
import {MAIL_AUTOMATION_MESSAGES, type VerificationMode, type VerificationResult} from '../shared/mail-automation';
import {HUMAN_ACTION_MESSAGES} from '../shared/human-action';
import {safeMessage} from '../main/validation';
import {createPinnedLookup,isPublicIpAddress,normalizePublicUrl,type PublicFetchDependencies} from './web';

const LOOKBACK_MS=48*60*60*1000, CLOCK_SKEW_MS=10*60*1000;
const DATE_SKEW_MS=2*60*1000;
const MAX_MESSAGES=25, MAX_BYTES=256_000;
export const MAX_LINKS=12;
const MAX_UNRESOLVED_LINKS=4096;
const unresolvedLinks=new Map<string,number>();
const VERIFY_COMPONENT=/^(?:(?:email|account)?(?:verif(?:y|ication)?|confirm(?:ation)?|activat(?:e|ion)?)(?:email|account)?)$/i;
const DANGEROUS_ROUTE=/(?:^|[^a-z0-9])(?:reset|password|passwd|delete|remove|unsubscribe|cancel|billing|payment|deny|decline|reject|not[\s_-]?me|wasn['’]?t|report|abuse|block|revoke|disavow|opt[\s_-]?out|deactivat(?:e|ed|ing|ion)?|inactivat(?:e|ed|ing|ion)?|disable|unverif(?:y|ied|ication)?|mute|pause|stop|leave|close)(?=$|[^a-z0-9])|停用|注销/i;
const AUTHENTICATION_ROUTE=/(?:^|[^a-z0-9])(?:log[\s_-]?in|sign[\s_-]?in|magic)(?=$|[^a-z0-9])/i;
const UNSAFE_LABEL=/\b(?:deny|decline|reject|not\s+(?:me|you)|wasn['’]?t|report|abuse|block|revoke|disavow|opt[\s-]*out|deactivat(?:e|ed|ing|ion)?|inactivat(?:e|ed|ing|ion)?|disable|unverif(?:y|ied|ication)?|mute|pause|stop|leave|close|log[\s-]*in|sign[\s-]*in|magic)\b|拒绝|取消|不是本人|举报|停用|注销/i;
const LINK_CONTEXT=/verif|confirm|activat|验证|确认|激活/i;
const MARKER=String.raw`(?:\b(?:verification(?:\s+code)?|security\s+code|one[ -]time\s+(?:code|password)|code|otp)\b|验证码|校验码|确认码)`;
const JOIN=String.raw`[\s:：=＃#\-–]*(?:(?:is|为|是)\s*[:：]?\s*)?`;

function normalizeHost(host:string):string{return host.toLowerCase().replace(/\.$/,'')}
function allowedHost(host:string,hosts:readonly string[]):boolean {
  const target=normalizeHost(host);
  const userSubdomainHosts=new Set(['carrd.co','prose.sh','mataroa.blog']);
  return hosts.some(allowed=>{
    const base=normalizeHost(allowed);
    const userContent=[...userSubdomainHosts].some(host=>base===host||base.endsWith(`.${host}`));
    return target===base||!userContent&&target.endsWith(`.${base}`);
  });
}
function verificationRoute(url:URL):boolean {
  const path=decodedRoute(url.pathname);
  if(!path||!path.split(/[/._\s-]+/).some(component=>VERIFY_COMPONENT.test(component))||unsafeUrl(url))return false;
  return [...url.searchParams].some(([name,value])=>/^(?:token|confirmation_token|signature|key|code|hash|secret|nonce|t|v|id|verification|confirmation|activation)$/i.test(name)&&/^[a-z0-9._~+\/-]{3,512}={0,2}$/i.test(value));
}
function decodedRoute(value:string):string|undefined {
  for(let pass=0;pass<3;pass++){
    try{const decoded=decodeURIComponent(value);if(decoded===value)return value;value=decoded}catch{return}
  }
  return value;
}
function unsafeRoute(value:string,authentication=true):boolean {
  const decoded=decodedRoute(value);
  if(decoded===undefined)return true;
  const words=decoded.replace(/([a-z0-9])([A-Z])/g,'$1-$2');
  return DANGEROUS_ROUTE.test(words)||authentication&&AUTHENTICATION_ROUTE.test(words);
}
function unsafeUrl(url:URL):boolean {
  if(unsafeRoute(url.pathname))return true;
  return [...url.searchParams].some(([name,value])=>{
    if(unsafeRoute(name))return true;
    if(!/^(?:action|next|redirect|return|continue|url|target)$/i.test(name))return false;
    const decoded=decodedRoute(value);
    if(decoded===undefined)return true;
    // Return destinations may lead to login; the action itself must still verify.
    // Inspect the path, not a hostname or an opaque destination query token.
    try{return unsafeRoute(new URL(decoded,url).pathname,/^action$/i.test(name))}catch{return true}
  });
}
function htmlText(value:string):string {
  const $=load(value);$('script,style,noscript,template').remove();
  $('br,p,div,td,th,tr,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,center,section,article,header,footer,table,ul,ol,pre,hr').each((_index,node)=>{$(node).before(' ').append(' ')});
  return $.root().text();
}
function snippet(value:string,index=0):string{return value.slice(Math.max(0,index-50),index+130).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim()}
interface CodeCandidate {code:string;snippet:string}
const NON_VERIFICATION_LABEL=String.raw`(?:\b(?:order|invoice|purchase|receipt|tracking|transaction|amount|price|phone|mobile|tel(?:ephone)?|promo|coupon|discount|voucher|referral|invite|reference|ticket|error|gift)\b|订单|账单|金额|价格|手机|电话|运单|邀请码|优惠码|兑换码)`;
const NON_VERIFICATION_PREFIX=new RegExp(`${NON_VERIFICATION_LABEL}[^0-9.!?。！？\\r\\n]{0,64}$`,'i');
const NON_VERIFICATION_SUFFIX=new RegExp(`^\\s*(?:(?:is|as|为|是)\\s*)?(?:(?:your|the|an?|您的|你的)\\s*)?${NON_VERIFICATION_LABEL}`,'i');
const CASE_REF_PREFIX=/\b(?:case|ref)\s+(?:(?:verification|security)\s+)?(?:code|otp)\b[^0-9.!?。！？\r\n]{0,16}$/i;
const CASE_REF_SUFFIX=/^\s*(?:(?:is|as)\s*)?(?:(?:your|the|an?)\s*)?\b(?:case|ref)\b/i;
function nonVerificationNumber(before:string,after:string):boolean {
  // An order/invoice label in the same nearby clause takes precedence over a generic "code" marker.
  return NON_VERIFICATION_PREFIX.test(before)||NON_VERIFICATION_SUFFIX.test(after)||CASE_REF_PREFIX.test(before)||CASE_REF_SUFFIX.test(after);
}
/** Numeric tokens must touch a verification marker; unrelated numeric mail is never guessed. */
export function verificationCodes(subject:string,text='',html=''):CodeCandidate[] {
  const found=new Map<string,CodeCandidate>();
  for(const source of [subject,text,html?htmlText(html):'']){
    const patterns=[new RegExp(`${MARKER}${JOIN}([0-9]{4,8})(?![a-z0-9])`,'gi'),new RegExp(`(?<![a-z0-9])([0-9]{4,8})${JOIN}(?:(?:is|为|是)\\s*(?:your\\s+)?)?${MARKER}`,'gi')];
    for(const pattern of patterns)for(const match of source.matchAll(pattern)){
      const code=match[1],start=match.index??0,codeStart=start+match[0].indexOf(code),before=source.slice(Math.max(0,codeStart-96),codeStart),after=source.slice(codeStart+code.length,codeStart+code.length+64);
      if(nonVerificationNumber(before,after)||
        /(?:[$€£¥￥]\s*)$/.test(before)||/^\s*(?:[.,]\d|元|美元|人民币|usd\b|eur\b|年|月|日)/i.test(after)||
        /(?:\d[ .()-])$/.test(before)||/^[ .()-]\d/.test(after))continue;
      if(!found.has(code))found.set(code,{code,snippet:snippet(source,start)});
    }
  }
  return [...found.values()];
}

function rawUrls(text:string):string[] {
  const urls=new Set<string>(),decoded=text.replace(/&amp;/gi,'&').replace(/=\r?\n/g,'');
  for(const match of decoded.matchAll(/https?:\/\/[^\s<>"'\[\]]+/gi))try{
    const url=new URL(match[0].replace(/[).,;]+$/,''));
    if(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&!unsafeUrl(url))urls.add(url.href);
  }catch{/* malformed mail URL */}
  return [...urls];
}
export function verificationUrls(text:string,allowedHosts:string[]):string[]{
  return rawUrls(text).filter(value=>{const url=new URL(value);return allowedHost(url.hostname,allowedHosts)&&verificationRoute(url)});
}

interface LinkResolveDependencies extends PublicFetchDependencies {
  requestHead?:(url:URL,pinned:{address:string;family:number},signal:AbortSignal)=>Promise<{status:number;headers:{location?:string|string[]}}>;
}
async function publicAddresses(value:string,signal:AbortSignal|undefined,dependencies:LinkResolveDependencies|undefined):Promise<Array<{address:string;family:number}>|undefined>{
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  try{
    const lookupWork=dependencies?dependencies.resolve(new URL(value).hostname):lookup(new URL(value).hostname,{all:true,verbatim:true});
    const deadline=new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(Error('DNS timeout')),10_000);
      abort=()=>reject(Error(MAIL_AUTOMATION_MESSAGES.cancelled));
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
    const addresses=await Promise.race([lookupWork,deadline]);
    return addresses.length&&addresses.every(item=>isPublicIpAddress(item.address))?addresses:undefined;
  }catch{if(signal?.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);return}finally{if(timer)clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort)}
}
async function publicTerminal(value:string,signal:AbortSignal|undefined,dependencies:LinkResolveDependencies|undefined):Promise<boolean>{
  return !!await publicAddresses(value,signal,dependencies);
}
function nativeHead(url:URL,pinned:{address:string;family:number},signal:AbortSignal):Promise<{status:number;headers:{location?:string|string[]}}>{
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'HEAD',lookup:createPinnedLookup(pinned),headers:{'user-agent':'Mozilla/5.0'}},reply=>{
      resolve({status:reply.statusCode??0,headers:reply.headers});reply.destroy();
    });
    const deadline=setTimeout(()=>request.destroy(Error('HEAD timeout')),10_000);
    const abort=()=>request.destroy(Error(MAIL_AUTOMATION_MESSAGES.cancelled));
    signal.addEventListener('abort',abort,{once:true});
    request.on('close',()=>{clearTimeout(deadline);signal.removeEventListener('abort',abort)});
    request.on('error',reject);
    if(signal.aborted)abort();else request.end();
  });
}

export type VerificationLinkResolution = {kind:'resolved';url:string}|{kind:'negative'}|{kind:'transient'};

/** Only tracker Location headers are read; platform links never receive HEAD. */
export async function resolveVerificationLinkDetailed(value:string,allowedHosts:readonly string[],signal?:AbortSignal,dependencies?:LinkResolveDependencies):Promise<VerificationLinkResolution>{
  let initial:URL;
  try{initial=normalizePublicUrl(value)}catch{return {kind:'negative'}}
  if(initial.protocol!=='https:'||unsafeUrl(initial))return {kind:'negative'};
  if(allowedHost(initial.hostname,allowedHosts)){
    if(!verificationRoute(initial))return {kind:'negative'};
    return await publicTerminal(initial.href,signal,dependencies)?{kind:'resolved',url:initial.href}:{kind:'transient'};
  }
  let current=initial;
  for(let hop=0;hop<3;hop++){
    if(signal?.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
    const addresses=await publicAddresses(current.href,signal,dependencies);
    if(!addresses)return {kind:'transient'};
    let response:{status:number;headers:{location?:string|string[]}};
    try{response=await (dependencies?.requestHead??nativeHead)(current,addresses[0],signal??new AbortController().signal)}
    catch{if(signal?.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);return {kind:'transient'}}
    if(response.status===0||response.status===408||response.status===425||response.status===429||response.status>=500)return {kind:'transient'};
    if(![301,302,303,307,308].includes(response.status))return {kind:'negative'};
    const location=response.headers.location;
    if(typeof location!=='string')return {kind:'negative'};
    let next:URL;
    try{next=normalizePublicUrl(new URL(location,current).href)}catch{return {kind:'negative'}}
    if(next.protocol!=='https:'||unsafeUrl(next))return {kind:'negative'};
    if(allowedHost(next.hostname,allowedHosts)){
      if(!verificationRoute(next))return {kind:'negative'};
      if(!await publicTerminal(next.href,signal,dependencies))return {kind:'transient'};
      if(signal?.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
      return {kind:'resolved',url:next.href};
    }
    current=next;
  }
  return {kind:'negative'};
}

/** Compatibility wrapper for callers that only need the resolved URL. */
export async function resolveVerificationLink(value:string,allowedHosts:readonly string[],signal?:AbortSignal,dependencies?:LinkResolveDependencies):Promise<string|undefined>{
  const result=await resolveVerificationLinkDetailed(value,allowedHosts,signal,dependencies);
  return result.kind==='resolved'?result.url:undefined;
}

export interface MailboxClient {usable:boolean;on?(event:'error',listener:(error:Error)=>void):unknown;connect():Promise<unknown>;getMailboxLock(path:string,options?:{readOnly:true}):Promise<{release():void}>;logout():Promise<unknown>}
export function isMailAuthenticationError(error:unknown):boolean {
  const value=error as {authenticationFailed?:unknown;code?:unknown;serverResponseCode?:unknown;response?:unknown;responseText?:unknown;message?:unknown}|undefined;
  if(value?.authenticationFailed===true)return true;
  const parts=[value?.code,value?.serverResponseCode,value?.response,value?.responseText,value?.message].filter(part=>typeof part==='string').join(' ');
  return /AUTHENTICATIONFAILED|AUTHFAILED|LOGINFAILED|invalid (?:credentials|password)|(?:authentication|login) (?:failed|error)|too many failed login/i.test(parts);
}
function observeClientErrors(client:MailboxClient):void {client.on?.('error',()=>{/* connect/scan handles the failure; prevent an unhandled emitter error. */})}
export function mailboxClientOptions(mail:Pick<Mailbox,'host'|'port'|'user'|'secure'>,password:string):ImapFlowOptions {
  const {host,port,user,secure}=mail;
  if(inferMailPreset({host})?.support==='oauth-required')throw Error(MAIL_AUTOMATION_MESSAGES.oauthRequired);
  if(!host||!user||!Number.isInteger(port)||port<1||port>65535||!secure)throw Error(MAIL_AUTOMATION_MESSAGES.invalidConnection);
  return {host,port,secure:true,auth:{user,pass:password},logger:false,disableAutoIdle:true,connectionTimeout:10_000,socketTimeout:20_000,greetingTimeout:10_000};
}
function mailboxClient(mail:Pick<Mailbox,'host'|'port'|'user'|'secure'>,password:string):ImapFlow{return new ImapFlow(mailboxClientOptions(mail,password))}
export async function testMail(settings:Settings,secrets:SecretStore):Promise<{ok:boolean;message:string}>{
  const password=await secrets.get('mailPassword');
  return testMailbox({...settings.mail,id:'legacy',label:'legacy',aliases:[],createdAt:'',updatedAt:''},password??'');
}
export async function testMailbox(mailbox:Mailbox,password:string,create:(mailbox:Mailbox,password:string)=>MailboxClient=mailboxClient):Promise<{ok:boolean;message:string}>{
  if(!password)return {ok:false,message:'尚未配置邮箱密码'};
  let client:MailboxClient|undefined;
  try{client=create(mailbox,password);observeClientErrors(client);await client.connect();const lock=await client.getMailboxLock('INBOX');lock.release();return {ok:true,message:'邮箱连接成功'}}
  catch(error){return {ok:false,message:safeMessage(error)}}finally{if(client?.usable)await client.logout().catch(()=>{})}
}

interface Address {address?:string}
interface Envelope {from?:Address[];to?:Address[];date?:string|Date;subject?:string;messageId?:string}
function addressesMatch(addresses:Address[]|undefined,expected:string):boolean{return !!addresses?.some(entry=>entry.address?.toLowerCase()===expected.toLowerCase())}
function senderMatches(addresses:Address[]|undefined,domain:string):boolean {
  return !!addresses?.some(entry=>allowedHost(entry.address?.toLowerCase().split('@')[1]??'',[domain]));
}
/** Legacy helper retains its Date-header behavior; the scanner below requires INTERNALDATE. */
export function isMatchingVerificationEnvelope(envelope:Envelope,siteEmail:string,channelDomain:string,since:Date):boolean {
  return senderMatches(envelope.from,channelDomain)&&addressesMatch(envelope.to,siteEmail)&&!!envelope.date&&new Date(envelope.date).getTime()>=since.getTime();
}
export interface ScanMessage {envelope?:Envelope;internalDate?:Date|string;source?:Buffer}
export interface VerificationMailClient extends MailboxClient {
  list():Promise<Array<{path:string;name?:string;specialUse?:string;flags?:Set<string>}>>;
  search(query:{to:string;since:Date},options:{uid:true}):Promise<number[]|false|undefined>;
  fetch(range:string,query:{envelope:true;internalDate:true;source:{start:number;maxLength:number}},options:{uid:true}):AsyncIterable<ScanMessage>;
}
export interface ParsedVerificationMail {subject?:string;messageId?:string;text?:string;html?:string|false}
export interface VerificationScanOptions {
  since?:Date;now?:Date;mode?:VerificationMode;
  dependencies?:{
    createClient?:(mailbox:Mailbox,password:string)=>VerificationMailClient;
    parse?:(source:Buffer)=>Promise<ParsedVerificationMail>;
    resolveLink?:(url:string,allowedHosts:readonly string[],signal:AbortSignal)=>Promise<string|undefined|VerificationLinkResolution>;
  };
}
function spamMailbox(folder:{path:string;name?:string;specialUse?:string;flags?:Set<string>}):boolean {
  if(folder.flags?.has('\\Noselect'))return false;
  return folder.specialUse==='\\Junk'||folder.flags?.has('\\Junk')===true||/^(?:spam|junk|junk e-mail|bulk mail|垃圾邮件|垃圾郵件|广告邮件)$/i.test(folder.name??folder.path.split(/[/.]/).at(-1)??'');
}

function authenticationResults(source:Buffer,mailboxHost:string):string|undefined {
  // RFC 5322 fields can be forged by the sender. Only accept the first result
  // in Gmail's receiving block, with the authserv-id bound to the configured IMAP host.
  if(normalizeHost(mailboxHost)!=='imap.gmail.com')return;
  const head=source.toString('utf8',0,Math.min(source.length,32_000)).split(/\r?\n\r?\n/,1)[0];
  const lines=head.split(/\r?\n/),unfolded:string[]=[];
  for(const line of lines){
    if(/^[ \t]/.test(line)&&unfolded.length)unfolded[unfolded.length-1]+=' '+line.trim();
    else unfolded.push(line);
  }
  const receivedBy=(line:string):string|undefined=>{
    const hosts=[...line.slice(line.indexOf(':')+1).matchAll(/(?:^|\s)by\s+([a-z0-9.:-]+)(?=\s|[;(]|$)/gi)];
    return hosts.length===1?hosts[0][1].toLowerCase():undefined;
  };
  const received=unfolded.flatMap((line,index)=>/^Received\s*:/i.test(line)?[index]:[]);
  const ingress=received.findIndex(index=>receivedBy(unfolded[index])==='mx.google.com');
  if(ingress<0||ingress>1)return;
  if(ingress===1&&!/^(?:[a-z0-9.-]+\.(?:google|googlemail)\.com|2002:[0-9a-f:]+)$/i.test(receivedBy(unfolded[received[0]])??''))return;
  const firstResult=unfolded.findIndex(line=>/^Authentication-Results\s*:/i.test(line));
  if(firstResult<=received[ingress]||received[ingress+1]!==undefined&&firstResult>=received[ingress+1])return;
  const result=unfolded[firstResult].replace(/^Authentication-Results\s*:/i,'').trim();
  return result.split(';',1)[0].trim().toLowerCase()==='mx.google.com'?result:undefined;
}
function authMethodText(part:string):string|undefined {
  let depth=0,quoted=false,escaped=false,result='';
  for(const char of part){
    if(escaped){escaped=false;result+=' ';continue}
    if(char==='\\'&&(depth>0||quoted)){escaped=true;result+=' ';continue}
    if(quoted){if(char==='"')quoted=false;result+=' ';continue}
    if(depth>0){if(char==='(')depth++;else if(char===')')depth--;result+=' ';continue}
    if(char==='('){depth=1;result+=' ';continue}
    if(char==='"'){quoted=true;result+=' ';continue}
    if(char===')'||char==='\\')return;
    result+=char;
  }
  return depth||quoted||escaped?undefined:result.trim();
}
function splitAuthResults(value:string):string[]|undefined {
  const parts:string[]=[];let current='',depth=0,quoted=false,escaped=false;
  for(const char of value){
    if(escaped){current+=char;escaped=false;continue}
    if(char==='\\'&&(depth>0||quoted)){current+=char;escaped=true;continue}
    if(quoted){current+=char;if(char==='"')quoted=false;continue}
    if(depth>0){current+=char;if(char==='(')depth++;else if(char===')')depth--;continue}
    if(char==='('){current+=char;depth=1;continue}
    if(char==='"'){current+=char;quoted=true;continue}
    if(char===';'){parts.push(current);current='';continue}
    current+=char;
  }
  if(depth||quoted||escaped)return;
  parts.push(current);
  return parts;
}
function authenticatedFor(source:Buffer,domain:string,mailboxHost:string):boolean {
  const result=authenticationResults(source,mailboxHost);
  if(!result)return false;
  const parts=splitAuthResults(result);
  if(!parts||parts[0].trim().toLowerCase()!=='mx.google.com')return false;
  const aligned=(value:string)=>allowedHost(value.replace(/[;\s].*$/,'').toLowerCase(),[domain]);
  return parts.slice(1).some(raw=>{
    const part=authMethodText(raw);
    if(!part)return false;
    const fields=[...part.matchAll(/(?:^|\s)(header\.(?:d|i|from))=/gi)].map(match=>match[1].toLowerCase());
    if(['header.d','header.i','header.from'].some(name=>fields.filter(field=>field===name).length>1))return false;
    const dkim=/^dkim=pass(?:\s|$)/i.test(part)?/(?:^|\s)header\.d=([a-z0-9.-]+)(?=\s|$)/i.exec(part):null;
    const identity=/^dkim=pass(?:\s|$)/i.test(part)?/(?:^|\s)header\.i=(?:[a-z0-9._+-]+)?@([a-z0-9.-]+)(?=\s|$)/i.exec(part):null;
    const dmarc=/^dmarc=pass(?:\s|$)/i.test(part)?/(?:^|\s)header\.from=([a-z0-9.-]+)(?=\s|$)/i.exec(part):null;
    const dkimDomain=dkim?.[1].toLowerCase(),identityDomain=identity?.[1].toLowerCase();
    const identityWithinDkim=!dkimDomain||!identityDomain||identityDomain===dkimDomain||identityDomain.endsWith(`.${dkimDomain}`);
    return !!((dkim&&aligned(dkim[1])&&(!identity||aligned(identity[1]))&&identityWithinDkim)||(!dkim&&identity&&aligned(identity[1]))||dmarc&&aligned(dmarc[1]));
  });
}
function unsafeAnchorUrls(html:string):Set<string> {
  const urls=new Set<string>();if(!html)return urls;
  const $=load(html);
  $('a[href]').each((_index,node)=>{
    if(!UNSAFE_LABEL.test($(node).text()))return;
    const href=$(node).attr('href');
    try{if(href)urls.add(new URL(href).href)}catch{/* Invalid anchor. */}
  });
  return urls;
}
function messageUrls(text:string,html:string):string[] {
  if(!html)return rawUrls(text);
  const $=load(html),resources=new Set<string>(),anchors:string[]=[],labels=new Set<string>();
  $('script,style,noscript,template').remove();
  $('img[src],link[href]').each((_index,node)=>{
    for(const url of rawUrls($(node).attr(node.tagName==='img'?'src':'href')??''))resources.add(url);
  });
  $('a[href]').each((_index,node)=>{
    anchors.push(...rawUrls($(node).attr('href')??''));
    const firstWord=$(node).text().trim().split(/\s/,1)[0];
    if(firstWord)labels.add(firstWord);
  });
  $('a,br,p,div,td,th,tr,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,center,section,article,header,footer,table,ul,ol,pre,hr').each((_index,node)=>{$(node).before(' ').append(' ')});
  // Raw HTML keeps clean hrefs; mailparser's generated text can join image and
  // anchor addresses with adjacent labels. Keep distinct plaintext links, but
  // reject a known href with one of those labels appended by html-to-text.
  const htmlUrls=[...new Set([...anchors,...rawUrls($.root().text())])].filter(url=>!resources.has(url));
  const textUrls=rawUrls(text).filter(url=>!resources.has(url)&&!htmlUrls.some(href=>{
    if(url===href||!url.startsWith(href))return false;
    try{return labels.has(decodeURIComponent(url.slice(href.length)))}catch{return false}
  }));
  return [...new Set([...htmlUrls,...textUrls])];
}
interface LinkCandidate {url:string;snippet:string;messageId:string}
interface ScanPlan {
  id:string;context:ExecutionContext;mode:VerificationMode;recipient:string;start:number;since:Date;
  confirmationRequired:boolean;
  seen:Set<string>;codes:Map<string,{snippet:string;messageId:string}>;links:Map<string,{snippet:string;messageId:string}>;
  rawLinks:LinkCandidate[];seenLinks:Set<string>;staleCode?:{code:string;snippet:string;messageId:string};
  pendingTrackers:LinkCandidate[];
  untrusted?:{snippet:string;messageId:string};
}
function collectMessage(plan:ScanPlan,message:ScanMessage,parsed:ParsedVerificationMail,now:Date):void {
  const {channel}=plan.context,envelope=message.envelope,source=message.source;
  const received=message.internalDate?new Date(message.internalDate).getTime():NaN;
  if(!envelope||!source||source.length>MAX_BYTES||!senderMatches(envelope.from,channel.domain)||!addressesMatch(envelope.to,plan.recipient)||!Number.isFinite(received)||received<plan.since.getTime()||received>now.getTime()+CLOCK_SKEW_MS)return;
  const messageId=parsed.messageId??envelope.messageId??`sha256:${createHash('sha256').update(source).digest('hex')}`;
  if(plan.seen.has(messageId))return;plan.seen.add(messageId);
  const subject=(parsed.subject??envelope.subject??'').slice(0,MAX_BYTES),text=(parsed.text??'').slice(0,MAX_BYTES),html=typeof parsed.html==='string'?parsed.html.slice(0,MAX_BYTES):'';
  const codes=plan.mode==='link'?[]:verificationCodes(subject,text,html);
  const body=`${text}\n${html}`,hasVerificationContext=LINK_CONTEXT.test(`${subject}\n${htmlText(body)}`);
  if(!plan.confirmationRequired&&!authenticatedFor(source,channel.domain,plan.context.mailbox?.host??plan.context.settings.mail.host)){
    if(codes.length||plan.mode!=='code'&&hasVerificationContext)plan.untrusted??={snippet:snippet(subject||text||htmlText(html)),messageId};
    return;
  }
  if(plan.mode!=='link'){
    const date=envelope.date?new Date(envelope.date).getTime():NaN;
    for(const candidate of codes){
      if(!Number.isFinite(date)||date<plan.start-DATE_SKEW_MS){plan.staleCode??={code:candidate.code,snippet:candidate.snippet,messageId};continue}
      if(!plan.codes.has(candidate.code))plan.codes.set(candidate.code,{snippet:candidate.snippet,messageId});
    }
  }
  if(plan.mode==='code')return;
  const unsafeAnchors=unsafeAnchorUrls(html);
  for(const raw of messageUrls(text,html)){
    if(plan.rawLinks.length>=MAX_LINKS)break;
    if(plan.seenLinks.has(raw)||unsafeAnchors.has(raw))continue;
    const url=new URL(raw);
    if(!allowedHost(url.hostname,channel.allowedHosts)&&!hasVerificationContext)continue;
    plan.seenLinks.add(raw);
    plan.rawLinks.push({url:raw,snippet:snippet(subject||text||htmlText(html)),messageId});
  }
}
function scanResult(plan:ScanPlan):VerificationResult {
  const tracker=plan.links.size===0?plan.pendingTrackers[0]:undefined;
  if(plan.untrusted||plan.staleCode||plan.codes.size>1||plan.links.size>1||plan.codes.size>0&&(plan.links.size>0||!!tracker)){
    const first=plan.untrusted??plan.staleCode??plan.codes.values().next().value??plan.links.values().next().value??tracker;
    return {kind:'ambiguous',candidates:[...(plan.staleCode?[plan.staleCode.code]:[]),...plan.codes.keys(),...plan.links.keys(),...(tracker?[tracker.url]:[])],snippet:first?.snippet??'',messageId:first?.messageId};
  }
  const code=plan.codes.entries().next().value;
  if(code)return plan.confirmationRequired?{kind:'confirmation_required',candidate:{kind:'code',code:code[0]},...code[1]}:{kind:'code',code:code[0],...code[1]};
  const link=plan.links.entries().next().value;
  if(!link)return tracker?{kind:'confirmation_required',candidate:{kind:'link',url:tracker.url,...(plan.pendingTrackers.length>1?{urls:plan.pendingTrackers.map(candidate=>candidate.url)}:{})},snippet:HUMAN_ACTION_MESSAGES.redacted,messageId:tracker.messageId}:{kind:'none'};
  return plan.confirmationRequired?{kind:'confirmation_required',candidate:{kind:'link',url:link[0],...(plan.pendingTrackers.length?{urls:[link[0],...plan.pendingTrackers.map(candidate=>candidate.url)]}:{})},...link[1]}:{kind:'link',url:link[0],...link[1]};
}

function cacheNegativeLink(key:string,expires:number):void {
  if(!unresolvedLinks.has(key)&&unresolvedLinks.size>=MAX_UNRESOLVED_LINKS){
    const oldest=unresolvedLinks.keys().next().value;
    if(oldest!==undefined)unresolvedLinks.delete(oldest);
  }
  unresolvedLinks.set(key,expires);
}

/** One IMAP login per mailbox batch; no tracker resolution runs until after logout. */
export async function scanVerificationBatch(contexts:ExecutionContext[],options:VerificationScanOptions={}):Promise<Map<string,VerificationResult>>{
  const results=new Map<string,VerificationResult>();if(!contexts.length)return results;
  const first=contexts[0],mail=first.mailbox??{...first.settings.mail,id:'legacy',label:'legacy',aliases:[],createdAt:'',updatedAt:''};
  if(contexts.some(context=>(context.mailbox?.id??'legacy')!==mail.id))throw Error('Mailbox batch contains different mailboxes');
  const now=options.now??new Date(),plans:ScanPlan[]=[];
  for(let index=0;index<contexts.length;index++){
    const context=contexts[index],wait=context.task.emailWait,id=context.task.id||`__single__${index}`;
    results.set(id,{kind:'none'});
    if(context.signal.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
    if(wait?.mailboxId&&context.mailbox?.id!==wait.mailboxId)continue;
    const account=context.getAccount(),created=Date.parse(account?.createdAt??context.task.createdAt);
    const start=options.since?.getTime()??(wait?Date.parse(wait.since):undefined)??Math.max(now.getTime()-LOOKBACK_MS,Number.isFinite(created)?created:0);
    const recipient=wait?.recipient||account?.email||context.site.publicEmail||context.site.email;
    if(!Number.isFinite(start)||!Number.isFinite(now.getTime())||!recipient)continue;
    const confirmationRequired=normalizeHost(mail.host)!=='imap.gmail.com';
    plans.push({id,context,mode:options.mode??wait?.kind??'either',recipient,start,since:new Date(start-CLOCK_SKEW_MS),confirmationRequired,seen:new Set(wait?.consumedMessageIds??[]),codes:new Map(),links:new Map(),rawLinks:[],seenLinks:new Set(),pendingTrackers:[]});
  }
  if(!plans.length)return results;
  const password=await first.secrets.get(first.mailbox?`mailbox:${mail.id}`:'mailPassword');
  if(!password)return results;
  const client=options.dependencies?.createClient?.(mail,password)??mailboxClient(mail,password),parse=options.dependencies?.parse??(async(source:Buffer)=>simpleParser(source));
  observeClientErrors(client);
  try{
    await client.connect();
    let junk:Array<{path:string;name?:string;specialUse?:string;flags?:Set<string>}>=[];
    try{junk=(await client.list()).filter(spamMailbox).slice(0,4)}catch(error){if(isMailAuthenticationError(error))throw error;/* INBOX remains readable when LIST fails. */}
    for(const folder of [...new Set(['INBOX',...junk.map(item=>item.path)])]){
      let lock:{release():void}|undefined;
      try{
        lock=await client.getMailboxLock(folder,{readOnly:true});
        for(const plan of plans){
          try{
            const matches=await client.search({to:plan.recipient,since:plan.since},{uid:true});
            if(!Array.isArray(matches))continue;
            for(const uid of matches.slice(-MAX_MESSAGES).reverse()){
              if(plan.context.signal.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
              for await(const message of client.fetch(String(uid),{envelope:true,internalDate:true,source:{start:0,maxLength:MAX_BYTES+1}},{uid:true})){
                if(!message.source||message.source.length>MAX_BYTES)continue;
                let parsed:ParsedVerificationMail;
                try{parsed=await parse(message.source)}catch{continue}
                collectMessage(plan,message,parsed,now);
              }
            }
          }catch(error){if(plan.context.signal.aborted||isMailAuthenticationError(error))throw error;/* Preserve candidates from other folders. */}
        }
      }catch(error){if(first.signal.aborted||isMailAuthenticationError(error))throw error;/* One folder failure does not discard earlier candidates. */}
      finally{lock?.release()}
    }
  }finally{if(client.usable)await client.logout().catch(()=>{})}
  const resolveLink=options.dependencies?.resolveLink??resolveVerificationLinkDetailed;
  for(const [key,expires] of unresolvedLinks)if(expires<=now.getTime())unresolvedLinks.delete(key);
  for(const plan of plans){
    for(const candidate of plan.rawLinks){
      if(plan.context.signal.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
      // Non-Gmail headers are not authenticated. A tracker must not make a
      // network request until a person has confirmed the message.
      if(plan.confirmationRequired){
        if(verificationUrls(candidate.url,plan.context.channel.allowedHosts).includes(candidate.url))plan.links.set(candidate.url,{snippet:candidate.snippet,messageId:candidate.messageId});
        else if(!allowedHost(new URL(candidate.url).hostname,plan.context.channel.allowedHosts))plan.pendingTrackers.push(candidate);
        continue;
      }
      const cacheKey=createHash('sha256').update(JSON.stringify([mail.id,plan.recipient,candidate.messageId,candidate.url,[...plan.context.channel.allowedHosts].sort()])).digest('hex');
      if(unresolvedLinks.has(cacheKey))continue;
      let resolution:string|undefined|VerificationLinkResolution;
      try{resolution=await resolveLink(candidate.url,plan.context.channel.allowedHosts,plan.context.signal)}catch{if(plan.context.signal.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled)}
      if(plan.context.signal.aborted)throw Error(MAIL_AUTOMATION_MESSAGES.cancelled);
      const resolved=typeof resolution==='string'?resolution:resolution?.kind==='resolved'?resolution.url:undefined;
      if(resolved&&verificationUrls(resolved,plan.context.channel.allowedHosts).includes(resolved)){
        if(!plan.links.has(resolved))plan.links.set(resolved,{snippet:candidate.snippet,messageId:candidate.messageId});
      }else if(typeof resolution==='object'&&resolution?.kind==='negative')cacheNegativeLink(cacheKey,now.getTime()+LOOKBACK_MS);
    }
    results.set(plan.id,scanResult(plan));
  }
  return results;
}

/** One bounded read only. Persistent scheduling and wait policy belong to the controller. */
export async function scanVerification(context:ExecutionContext,options:VerificationScanOptions={}):Promise<VerificationResult>{
  const id=context.task.id||'__single__0';
  return (await scanVerificationBatch([context],options)).get(id)??{kind:'none'};
}

export async function findVerification(context:ExecutionContext):Promise<string|undefined>{
  const result=await scanVerification(context,{mode:'link'});
  return result.kind==='link'?result.url:undefined;
}
