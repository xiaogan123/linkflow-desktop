import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';
import type {Account,ExecutionContext,ExecutionResult,LinkResult,ProseReceipt,Task} from '../shared/types';
import {inspectRenderedArticle} from './article-rendering';
import {applyDeclaredArticleVisibility,elementConcealed} from './article-visibility';
import {createProseTransport,type ExpectedProseIdentity,type ProseCredentials,type ProseTransport} from './prose-transport';

const USER=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const USER_ID=/^[\x21-\x7e]{1,128}$/;
const FINGERPRINT=/^SHA256:[A-Za-z0-9+/]{43}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_PUBLIC_BYTES=2_000_000;
const MAX_STORED_CREDENTIAL_BYTES=16_384;

type PublicFetch=(url:string,init:RequestInit)=>Promise<Response>;
export interface ProseDependencies {transport?:ProseTransport;fetch?:PublicFetch;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}
export interface ProseExecutionResult extends ExecutionResult {prose?:ProseReceipt}
export type ProseReconcileResult={status:'found';publicUrl:string;prose:ProseReceipt}|{status:'unknown'};

interface StoredProseCredentials {
  version:1;
  privateKey:string;
  passphrase?:string;
  identity:ExpectedProseIdentity;
}

interface ApprovedProseArticle {
  title:string;
  body:string;
  target:string;
  filename:string;
  source:string;
  sourceHash:string;
}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const stamp=(deps:ProseDependencies)=>(deps.now?.()??new Date()).toISOString();

export function proseFilename(taskId:string):string{
  const id=taskId.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32);
  if(!id)throw Error('Prose 任务标识无效');
  return `lf-${id}.md`;
}

function publicUrl(username:string,filename:string):string{
  if(!USER.test(username)||!/^lf-[a-z0-9]{1,32}\.md$/.test(filename))throw Error('Prose 公开地址无效');
  return `https://${username}.prose.sh/${filename.slice(0,-3)}`;
}

function targetUrl(value:string):string{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('Prose 目标链接必须是公开 HTTPS 地址');
  url.hash='';return url.toString();
}

function yamlString(value:string):string{return JSON.stringify(value)}

export function approvedProseArticle(task:Task,target:string,approval=true):ApprovedProseArticle{
  const draft=task.draft;
  if(!draft||approval&&!Number.isFinite(Date.parse(task.articleApprovedAt??'')))throw Error('Prose 全文须先通过当前稿件核对');
  if(!draft.title.trim()||draft.title!==draft.title.trim()||[...draft.title].length>200||/[\u0000-\u001f\u007f]/u.test(draft.title))throw Error('Prose 标题须为 1–200 个字符');
  if(draft.description!==draft.description.trim()||[...draft.description].length>1000||/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(draft.description))throw Error('Prose 摘要格式无效');
  const body=draft.body;
  if(!body||body!==body.trim()||Buffer.byteLength(body,'utf8')>500_000||/[\u0000-\u0008\u000b-\u001f\u007f]|<[^>]*>/u.test(body)||/!\s*\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])/u.test(body))throw Error('Prose 需要不含 HTML 或图片的完整 Markdown');
  const html=marked.parse(body,{async:false,gfm:true});
  if(typeof html!=='string')throw Error('Prose Markdown 无效');
  const $=load(html),wanted=targetUrl(task.topicUrl??target);
  if($('img').length||$.root().text().replace(/\s/gu,'').length<200||!$('a[href]').toArray().some(element=>{
    try{return !!$(element).text().trim()&&targetUrl($(element).attr('href')??'')===wanted}catch{return false}
  }))throw Error('Prose 需要有独立信息价值的全文及相关目标链接');
  const date=new Date(task.createdAt);
  if(!Number.isFinite(date.getTime()))throw Error('Prose 任务日期无效');
  const filename=proseFilename(task.id);
  const source=`---\ntitle: ${yamlString(draft.title)}\ndescription: ${yamlString(draft.description)}\ndate: ${date.toISOString().slice(0,10)}\n---\n\n${body}\n`;
  if(Buffer.byteLength(source,'utf8')>512*1024)throw Error('Prose 源文件超过上限');
  return {title:draft.title,body,target:wanted,filename,source,sourceHash:sha(source)};
}

function validIdentity(value:unknown):value is ExpectedProseIdentity{
  return object(value)&&Object.keys(value).sort().join(',')==='id,keyFingerprint,name'&&typeof value.name==='string'&&USER.test(value.name)&&typeof value.id==='string'&&USER_ID.test(value.id)&&typeof value.keyFingerprint==='string'&&FINGERPRINT.test(value.keyFingerprint);
}

export function serializeProseCredentials(credentials:ProseCredentials,identity:ExpectedProseIdentity):string{
  const privateKey=Buffer.isBuffer(credentials.privateKey)?credentials.privateKey.toString('utf8'):credentials.privateKey;
  const passphrase=credentials.passphrase===undefined?undefined:Buffer.isBuffer(credentials.passphrase)?credentials.passphrase.toString('utf8'):credentials.passphrase;
  if(!privateKey||privateKey.includes('\0')||passphrase!==undefined&&(Buffer.byteLength(passphrase,'utf8')>4096||passphrase.includes('\0'))||!validIdentity(identity))throw Error('Prose 专用密钥记录无效');
  const serialized=JSON.stringify({version:1,privateKey,...(passphrase===undefined?{}:{passphrase}),identity} satisfies StoredProseCredentials);
  if(Buffer.byteLength(serialized,'utf8')>MAX_STORED_CREDENTIAL_BYTES)throw Error('Prose 专用密钥记录无效');
  return serialized;
}

function parseCredentials(value:string|undefined):StoredProseCredentials{
  try{
    const parsed:unknown=JSON.parse(value??'null');
    if(Buffer.byteLength(value??'','utf8')>MAX_STORED_CREDENTIAL_BYTES||!object(parsed)||!['identity,privateKey,version','identity,passphrase,privateKey,version'].includes(Object.keys(parsed).sort().join(','))||parsed.version!==1||typeof parsed.privateKey!=='string'||!parsed.privateKey||parsed.privateKey.includes('\0')||(Object.hasOwn(parsed,'passphrase')&&(typeof parsed.passphrase!=='string'||Buffer.byteLength(parsed.passphrase,'utf8')>4096||parsed.passphrase.includes('\0')))||!validIdentity(parsed.identity))throw Error();
    return parsed as unknown as StoredProseCredentials;
  }catch{throw Error('Prose 专用密钥不可用')}
}

export function validSerializedProseCredentials(value:string|undefined,account?:Pick<Account,'username'>,receipt?:Pick<ProseReceipt,'username'|'platformUserId'|'keyFingerprint'>):boolean{
  try{const parsed=parseCredentials(value);return (!account||parsed.identity.name===account.username)&&(!receipt||parsed.identity.name===receipt.username&&parsed.identity.id===receipt.platformUserId&&parsed.identity.keyFingerprint===receipt.keyFingerprint)}catch{return false}
}

export function validProseAccount(account:Account):boolean{
  if(account.channelId!=='prose'||account.credentialKind!=='api_token'||account.status!=='registered'||!account.hasPassword||account.source!=='imported'||account.email!==''||!USER.test(account.username)||account.publicationUrl!==`https://${account.username}.prose.sh/`)return false;
  return true;
}

function validReceipt(value:unknown):value is ProseReceipt{
  return object(value)&&Object.keys(value).sort().join(',')==='filename,keyFingerprint,platformUserId,sourceHash,stage,username'&&typeof value.username==='string'&&USER.test(value.username)&&typeof value.platformUserId==='string'&&USER_ID.test(value.platformUserId)&&typeof value.keyFingerprint==='string'&&FINGERPRINT.test(value.keyFingerprint)&&typeof value.filename==='string'&&/^lf-[a-z0-9]{1,32}\.md$/.test(value.filename)&&typeof value.sourceHash==='string'&&HASH.test(value.sourceHash)&&['submitting','published'].includes(String(value.stage));
}

function contextMatches(context:ExecutionContext):boolean{
  return context.channel.id==='prose'&&context.channel.domain==='prose.sh'&&context.channel.provenance==='built-in'&&context.channel.enabled&&context.channel.automation==='api'&&context.channel.kind==='article'&&context.channel.articleRequired&&context.channel.accountRequired&&context.task.channelId==='prose'&&context.task.sourceDomain==='prose.sh';
}

function receiptIdentity(receipt:ProseReceipt):ExpectedProseIdentity{return {name:receipt.username,id:receipt.platformUserId,keyFingerprint:receipt.keyFingerprint}}

function credentialMatches(receipt:ProseReceipt,stored:StoredProseCredentials,account:Account):boolean{
  return validProseAccount(account)&&receipt.username===account.username&&stored.identity.name===receipt.username&&stored.identity.id===receipt.platformUserId&&stored.identity.keyFingerprint===receipt.keyFingerprint;
}

async function bounded<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted)throw Error('Prose 请求已取消');
  return new Promise<T>((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('Prose 请求已取消'))};signal.addEventListener('abort',abort,{once:true});promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},cause=>{signal.removeEventListener('abort',abort);reject(cause)})});
}

async function publicPage(url:string,deps:ProseDependencies):Promise<{html:string;headers:Headers}> {
  const expected=new URL(url);
  if(expected.protocol!=='https:'||expected.port||expected.username||expected.password||!USER.test(expected.hostname.slice(0,-'.prose.sh'.length))||!expected.hostname.endsWith('.prose.sh'))throw Error('Prose 公开地址无效');
  const controller=new AbortController(),relay=()=>controller.abort();
  if(deps.signal?.aborted)controller.abort();else deps.signal?.addEventListener('abort',relay,{once:true});
  const timer=setTimeout(()=>controller.abort(),Math.min(60_000,Math.max(100,deps.timeoutMs??15_000)));timer.unref?.();
  try{
    if(controller.signal.aborted)throw Error('Prose 请求已取消');
    const response=await bounded((deps.fetch??fetch)(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{accept:'text/html','user-agent':'Linkflow (original-article verifier)'}}),controller.signal);
    if(response.redirected||response.url&&response.url!==url||response.status!==200||!response.headers.get('content-type')?.toLowerCase().includes('text/html')||Number(response.headers.get('content-length'))>MAX_PUBLIC_BYTES)throw Error('Prose 公开页无效');
    const reader=response.body?.getReader();if(!reader)throw Error('Prose 公开页无正文');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const next=await bounded(reader.read(),controller.signal);if(next.done)break;size+=next.value.byteLength;if(size>MAX_PUBLIC_BYTES){controller.abort();await reader.cancel().catch(()=>undefined);throw Error('Prose 公开页超过上限')}chunks.push(next.value)}}catch(cause){controller.abort();await reader.cancel().catch(()=>undefined);throw cause}finally{reader.releaseLock()}
    const html=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return {html,headers:response.headers};
  }finally{clearTimeout(timer);deps.signal?.removeEventListener('abort',relay)}
}

async function publicArticle(receipt:ProseReceipt,article:ApprovedProseArticle,deps:ProseDependencies):Promise<{url:string;rel:string}>{
  const url=publicUrl(receipt.username,receipt.filename),page=await publicPage(url,deps);
  const $=load(page.html);applyDeclaredArticleVisibility($);
  const concealed=(element:Parameters<typeof $>[0])=>{let current:Parameters<typeof $>[0]|null=element;while(current){if(elementConcealed($,current))return true;current=(current as {parent?:typeof current}).parent??null}return false};
  const headings=$('body#post main h1').toArray().filter(element=>!concealed(element)&&!$(element).closest('article.md,footer,nav,aside').length);
  if(headings.length!==1||$(headings[0]).text().normalize('NFC').replace(/\s+/gu,' ').trim()!==article.title.normalize('NFC').replace(/\s+/gu,' ').trim())throw Error('Prose 公开标题未完整匹配');
  const result=inspectRenderedArticle(page.html,article.body,article.target,'body#post main article.md',{title:article.title,pageUrl:url,robotsHeader:page.headers.get('x-robots-tag')??''});
  if(!result.found)throw Error('Prose 公开全文未完整匹配');
  return {url,rel:result.rel};
}

async function reconcileSaved(context:ExecutionContext,receipt:ProseReceipt,article:ApprovedProseArticle,stored:StoredProseCredentials,deps:ProseDependencies):Promise<ProseReconcileResult>{
  const account=context.getAccount();
  if(!account||account.id!==context.task.accountId||!credentialMatches(receipt,stored,account)||receipt.filename!==article.filename||receipt.sourceHash!==article.sourceHash)return {status:'unknown'};
  const credentials:ProseCredentials={privateKey:stored.privateKey,...(stored.passphrase===undefined?{}:{passphrase:stored.passphrase})};
  try{
    const remote=await (deps.transport??createProseTransport()).readSource(credentials,receipt.filename,receiptIdentity(receipt),{signal:deps.signal??context.signal,timeoutMs:deps.timeoutMs});
    if(remote.status!=='found'||remote.source!==article.source||remote.sha256!==article.sourceHash)return {status:'unknown'};
    const page=await publicArticle(receipt,article,{...deps,signal:deps.signal??context.signal});
    return {status:'found',publicUrl:page.url,prose:{...receipt,stage:'published'}};
  }catch{return {status:'unknown'} }
}

export async function reconcileProseTask(context:ExecutionContext,deps:ProseDependencies={}):Promise<ProseReconcileResult>{
  const receipt=context.task.prose;
  if(!contextMatches(context)||!validReceipt(receipt))return {status:'unknown'};
  let article:ApprovedProseArticle,stored:StoredProseCredentials;
  try{article=approvedProseArticle(context.task,context.site.url,false);stored=parseCredentials(await context.secrets.get(`account:${context.task.accountId??''}`))}catch{return {status:'unknown'} }
  return reconcileSaved(context,receipt,article,stored,deps);
}

export async function runProseTask(context:ExecutionContext,deps:ProseDependencies={}):Promise<ProseExecutionResult>{
  if(!contextMatches(context))return {status:'needs_input',message:'当前任务不属于 Prose 全文发布渠道'};
  let article:ApprovedProseArticle;
  try{article=approvedProseArticle(context.task,context.site.url,!context.task.prose)}catch(cause){return {status:'needs_input',message:cause instanceof Error?cause.message:'Prose 原稿无效'}}
  const account=context.getAccount();
  if(!account||account.id!==context.task.accountId||!validProseAccount(account))return {status:'needs_input',message:'Prose 原出版身份不可用，不会换号或自动建号'};
  let stored:StoredProseCredentials,credentialText:string|undefined;
  try{credentialText=await context.secrets.get(`account:${account.id}`);stored=parseCredentials(credentialText)}catch{return {status:'needs_input',message:'Prose 专用密钥不可用，不会读取 SSH agent 或本机默认密钥'}}
  const prior=context.task.prose;
  if(prior){
    if(!validReceipt(prior))return {status:'needs_input',message:'Prose 已保存回执无效，只读核对与重传均已停止'};
    const result=await reconcileSaved(context,prior,article,stored,deps);
    return result.status==='found'?{status:'review',message:'Prose 原文件与匿名公开全文已核对，未再次上传',publicUrl:result.publicUrl,prose:result.prose,checkpoint:'prose_published',submittedAt:context.task.submittedAt}:{status:'needs_input',message:'Prose 原文件结果仍不明，只读核对且不会重传',prose:prior,checkpoint:'prose_publish_submitting',submittedAt:context.task.submittedAt};
  }
  if(context.task.submittedAt||context.task.publicUrl||['prose_publish_submitting','prose_published'].includes(context.task.checkpoint??''))return {status:'needs_input',message:'Prose 发布痕迹缺少回执，禁止重传'};
  if(stored.identity.name!==account.username)return {status:'needs_input',message:'Prose 专用密钥与原出版身份不一致'};
  const receipt:ProseReceipt={username:stored.identity.name,platformUserId:stored.identity.id,keyFingerprint:stored.identity.keyFingerprint,filename:article.filename,sourceHash:article.sourceHash,stage:'submitting'};
  const submittedAt=stamp(deps);
  try{context.checkpoint({prose:receipt,checkpoint:'prose_publish_submitting',submittedAt})}catch{return {status:'queued',message:'Prose 稳定文件名、身份与源文摘要未保存，未访问远程写入'}}
  const transport=deps.transport??createProseTransport(),credentials:ProseCredentials={privateKey:stored.privateKey,...(stored.passphrase===undefined?{}:{passphrase:stored.passphrase})},options={signal:deps.signal??context.signal,timeoutMs:deps.timeoutMs};
  try{
    const existing=await transport.readSource(credentials,receipt.filename,receiptIdentity(receipt),options);
    if(existing.status==='found'){
      if(existing.source!==article.source||existing.sha256!==article.sourceHash)return {status:'needs_input',message:'Prose 固定文件名已有不同远程内容，已停止且不会覆盖',prose:receipt,checkpoint:'prose_publish_submitting',submittedAt};
      const adopted=await reconcileSaved(context,receipt,article,stored,deps);
      if(adopted.status==='found')return {status:'review',message:'Prose 相同原文及完整公开正文已核对，未上传',publicUrl:adopted.publicUrl,prose:adopted.prose,checkpoint:'prose_published',submittedAt};
      return {status:'needs_input',message:'Prose 远程原文相同，但完整公开正文尚未核对；不会覆盖',prose:receipt,checkpoint:'prose_publish_submitting',submittedAt};
    }
  }catch{return {status:'needs_input',message:'Prose 写入前只读核对未完成，未上传',prose:receipt,checkpoint:'prose_publish_submitting',submittedAt}}
  try{
    if((deps.signal??context.signal).aborted)throw Error();
    const currentAccount=context.getAccount(),currentArticle=approvedProseArticle(context.task,context.site.url,true);
    if(!currentAccount||currentAccount.id!==account.id||!validProseAccount(currentAccount)||currentAccount.username!==receipt.username||currentArticle.filename!==receipt.filename||currentArticle.sourceHash!==receipt.sourceHash||await context.secrets.get(`account:${account.id}`)!==credentialText)throw Error();
    // The controller revalidates the live stored draft, approval and bound identity here.
    // This second durable gate closes changes that happened while read-before-write awaited.
    context.checkpoint({prose:receipt,checkpoint:'prose_publish_submitting',submittedAt});
  }catch{return {status:'needs_input',message:'Prose 写入前稿件、核对或专用身份已变更，未上传',prose:receipt,checkpoint:'prose_publish_submitting',submittedAt}}
  try{await transport.writeSource(credentials,receipt.filename,article.source,receiptIdentity(receipt),options)}catch{/* Any possible write is reconciled by the exact original filename below. */}
  const recovered=await reconcileSaved(context,receipt,article,stored,deps);
  if(recovered.status==='found')return {status:'review',message:'Prose 原文回读与匿名完整正文已核对',publicUrl:recovered.publicUrl,prose:recovered.prose,checkpoint:'prose_published',submittedAt};
  return {status:'needs_input',message:'Prose 上传结果待只读核对；保留原文件名且不会重传',prose:receipt,checkpoint:'prose_publish_submitting',submittedAt};
}

export async function verifyProsePublication(task:Task,target:string,deps:ProseDependencies={}):Promise<LinkResult>{
  const failed=(outcome:LinkResult['outcome'],reason:string):LinkResult=>({found:false,outcome,reason,url:task.publicUrl??'https://prose.sh/',rel:'unknown'});
  try{
    const receipt=task.prose;if(task.channelId!=='prose'||task.sourceDomain!=='prose.sh'||!validReceipt(receipt)||receipt.stage!=='published'||task.publicUrl!==publicUrl(receipt.username,receipt.filename))return failed('invalid','Prose 缺少一致的已发布回执');
    const article=approvedProseArticle(task,target,false);if(receipt.filename!==article.filename||receipt.sourceHash!==article.sourceHash)return failed('invalid','Prose 原稿摘要与回执不符');
    const page=await publicArticle(receipt,article,deps);return {found:true,outcome:'found',url:page.url,rel:page.rel,reason:'Prose 匿名完整正文及目标链接一致；不代表搜索收录'};
  }catch{return failed('unreachable','Prose 原公开全文暂未核验通过')}
}

export const proseTesting={approvedProseArticle,publicUrl,validReceipt,parseCredentials};
