import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {articleReviewStillValid} from '../main/article-review';
import type {Account,ExecutionResult,LinkResult,Task} from '../shared/types';
import type {Batch5Dependencies,Batch5Intent,Batch5OpaqueResponse,Batch5TaskState,RenderWriteStage} from './batch5-contract';
import {batch5State,connectedDependencies,connectedRequest,hashBatch5,parseConnectedJson,persistBatch5Receipt,persistBatch5Response,stateFromIntent,type ConnectedContext} from './batch5-connected';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';

export const RENDER_API='https://api.render.com/v1';
const CHANNEL='render',KEY=/^rnd_[A-Za-z0-9_-]{16,512}$/,ID=/^(?:tea|own)-[a-z0-9]{10,40}$/,HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,REPO=/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const ROBOTS='User-agent: *\nAllow: /\n';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const noindex=(value:string)=>/(?:^|[:,\s])(?:noindex|none)(?=$|[,;\s])/i.test(value);
const unknown=(message:string):ExecutionResult=>({status:'review',reasonCode:'submission_unknown',message});
export interface RenderCredential {version:1;apiKey:string;ownerId:string;email:string;githubToken?:string;source?:NonNullable<Account['renderSource']>}
interface Document {title:string;html:string;target:string;rel:string;bytes:number;request:string;sourceHash:string;requestHash:string;source:NonNullable<Account['renderSource']>;branch:string;rootDir:string}
interface Published {id:string;deployId:string;url:string;rawResponse:string}
export function parseRenderCredential(raw:string|undefined):RenderCredential|undefined {
 try{const v:unknown=JSON.parse(raw??'null');if(object(v)&&v.version===1&&typeof v.apiKey==='string'&&KEY.test(v.apiKey)&&typeof v.ownerId==='string'&&ID.test(v.ownerId)&&typeof v.email==='string'&&/^\S+@\S+\.\S+$/.test(v.email))return {version:1,apiKey:v.apiKey,ownerId:v.ownerId,email:v.email,...(typeof v.githubToken==='string'&&/^[A-Za-z0-9_]{20,512}$/.test(v.githubToken)?{githubToken:v.githubToken}:{}),...(validRenderSource(v.source as Account['renderSource'])?{source:v.source as NonNullable<Account['renderSource']>}:{})}}catch{/* untrusted credential */}
}
const auth=(secret:RenderCredential):HeadersInit=>({authorization:`Bearer ${secret.apiKey}`,accept:'application/json'});
function account(context:ConnectedContext,secret?:RenderCredential):Account|undefined {
 const a=context.getAccount();return a?.channelId===CHANNEL&&a.id===context.task.accountId&&a.status==='registered'&&!a.retiredAt&&a.hasPassword&&a.credentialKind==='api_token'&&ID.test(a.username)
  &&(!secret||a.username===secret.ownerId&&a.email===secret.email&&JSON.stringify(a.renderSource)===JSON.stringify(secret.source))?a:undefined;
}
export async function probeRenderConnection(apiKey:string,ownerId:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<{ownerId:string;email:string;name:string}>{
 if(!KEY.test(apiKey)||!ID.test(ownerId))throw Error('render_credential_invalid');
 const r=await connectedRequest(RENDER_API+'/owners/'+ownerId,{method:'GET',headers:{authorization:`Bearer ${apiKey}`,accept:'application/json'}},deps,signal,64_000),v=parseConnectedJson(r);
 if(r.status!==200||v?.id!==ownerId||typeof v.email!=='string'||!/^\S+@\S+\.\S+$/.test(v.email)||typeof v.name!=='string'||!['team','user'].includes(String(v.type)))throw Error('render_owner_unproven');
 return {ownerId,email:v.email,name:v.name};
}
/** Dashboard observation is explicitly supplied; the public owner API cannot attest billing. */
export function assertRenderCapacity(context:ConnectedContext,now:Date):void {
 const v=context.task.renderCapacity,a=account(context),age=now.getTime()-Date.parse(v?.observedAt??'');
 if(!a||!v||v.version!==1||v.source!=='dashboard_observation'||v.ownerId!==a.username||v.plan!=='hobby'||v.paymentMethod!=='none'||v.pendingCharges!==0
  ||!Number.isFinite(age)||age<0||age>15*60_000||!integer(v.servicesUsed)||v.servicesUsed>=25||!integer(v.bandwidthBytesUsed)||v.bandwidthBytesUsed>=5_000_000_000
  ||!integer(v.pipelineMinutesUsed)||v.pipelineMinutesUsed>498||v.activeBuilds!==0||v.queuedBuilds!==0||!HASH.test(v.evidenceHash))throw Error('render_fresh_free_dashboard_capacity_required');
}
export function validRenderSource(v:Account['renderSource']):v is NonNullable<Account['renderSource']>{
 return !!v&&v.version===1&&REPO.test(v.repository)&&!v.repository.endsWith('.git')&&Number.isSafeInteger(v.repositoryId)&&v.repositoryId>0&&Number.isSafeInteger(v.githubUserId)&&v.githubUserId>0&&/^[A-Za-z0-9-]{1,39}$/.test(v.githubLogin)&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v.baseBranch)&&v.repository.split('/')[3]===v.githubLogin;
}
const githubHeaders=(secret:RenderCredential):HeadersInit=>({authorization:`Bearer ${secret.githubToken}`,accept:'application/vnd.github+json'});
const githubBase=(source:NonNullable<Account['renderSource']>)=>'https://api.github.com/repos/'+source.repository.slice('https://github.com/'.length);
export async function probeRenderGitSource(token:string,repository:string,deps:Batch5Dependencies={},signal:AbortSignal=new AbortController().signal):Promise<NonNullable<Account['renderSource']>>{
 if(!/^[A-Za-z0-9_]{20,512}$/.test(token)||!REPO.test(repository)||repository.endsWith('.git'))throw Error('render_git_credential_invalid');
 const headers={authorization:`Bearer ${token}`,accept:'application/vnd.github+json'},user=await connectedRequest('https://api.github.com/user',{method:'GET',headers},deps,signal,64_000),u=parseConnectedJson(user);
 const response=await connectedRequest('https://api.github.com/repos/'+repository.slice(19),{method:'GET',headers},deps,signal,64_000),v=parseConnectedJson(response);
 if(user.status!==200||response.status!==200||!v||!u||v.private!==false||v.archived!==false||v.disabled!==false||!object(v.owner)||v.owner.login!==u.login||!object(v.permissions)||v.permissions.admin!==true||v.permissions.push!==true)throw Error('render_git_owner_unproven');
 const source={version:1 as const,repository,repositoryId:Number(v.id),githubLogin:String(u.login),githubUserId:Number(u.id),baseBranch:String(v.default_branch)};if(!validRenderSource(source))throw Error('render_git_source_invalid');
 const actions=await connectedRequest(githubBase(source)+'/actions/permissions',{method:'GET',headers},deps,signal,16_000);if(actions.status!==200||parseConnectedJson(actions)?.enabled!==false)throw Error('render_git_actions_must_be_disabled');return source;
}
async function sourcePreflight(doc:Document,secret:RenderCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<string>{
 const source=await probeRenderGitSource(secret.githubToken??'',doc.source.repository,deps,signal);if(JSON.stringify(source)!==JSON.stringify(doc.source))throw Error('render_git_identity_changed');
 const base=githubBase(source),headers=githubHeaders(secret),branch=await connectedRequest(base+'/git/ref/heads/'+source.baseBranch,{method:'GET',headers},deps,signal,32_000),v=parseConnectedJson(branch);
 if(branch.status!==200||!object(v?.object)||v.object.type!=='commit'||!COMMIT.test(String(v.object.sha)))throw Error('render_source_head_unproven');
 const head=String(v.object.sha),tree=await connectedRequest(base+'/git/trees/'+head+'?recursive=1',{method:'GET',headers},deps,signal,100_000),t=parseConnectedJson(tree);
 if(tree.status!==200||t?.truncated!==false||!Array.isArray(t.tree)||t.tree.some((e:unknown)=>!object(e)||typeof e.path!=='string'||e.path===doc.rootDir||e.path.startsWith(doc.rootDir+'/')||e.path.startsWith('.github/workflows/')||e.mode==='120000'||e.mode==='160000'))throw Error('render_source_path_or_workflow_exists');
 const vacant=await connectedRequest(base+'/git/ref/heads/'+doc.branch,{method:'GET',headers},deps,signal,32_000);if(vacant.status!==404)throw Error('render_source_branch_exists');return head;
}
export function renderSourceFileBody(doc:Document,file:'index.html'|'robots.txt'):string{
 const identity={name:'AI Documentation Assistant',email:`${doc.source.githubUserId}+${doc.source.githubLogin}@users.noreply.github.com`};
 return JSON.stringify({message:'Add original software guide file',content:Buffer.from(file==='index.html'?doc.html:ROBOTS).toString('base64'),branch:doc.source.baseBranch,author:identity,committer:identity});
}
function opaqueJson(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent,url:string,status:number):Record<string,unknown>|undefined{
 if(!value||value.status!==status||!value.bodyComplete||value.responseUrl!==url||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent))return;
 try{const bytes=Buffer.from(value.bodyBase64,'base64');if(bytes.toString('base64')!==value.bodyBase64)return;const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return object(v)?v:undefined}catch{return}
}
export function renderSourceCommit(writes:RenderWriteStage[],intent:Batch5Intent,doc:Document):string|undefined{
 let commit:string|undefined;
 for(const [index,file] of ['index.html','robots.txt'].entries()){
  const w=writes[index],url=githubBase(doc.source)+'/contents/'+doc.rootDir+'/public/'+file,body=renderSourceFileBody(doc,file as 'index.html'|'robots.txt');
  if(!w||w.stage!==(index===0?'source_html':'source_robots')||w.url!==url||w.requestBody!==body||w.requestHash!==hashBatch5(body))return;
  const v=opaqueJson(w.opaque,intent,url,201),identity=JSON.parse(body).author;
  if(!v||!object(v.content)||v.content.path!==doc.rootDir+'/public/'+file||!object(v.commit)||!COMMIT.test(String(v.commit.sha))||!object(v.commit.author)||v.commit.author.name!==identity.name||v.commit.author.email!==identity.email||!object(v.commit.committer)||v.commit.committer.name!==identity.name||v.commit.committer.email!==identity.email)return;
  commit=String(v.commit.sha);
 }
 const ref=writes[2];if(!commit||!ref||ref.stage!=='source_ref'||ref.url!==githubBase(doc.source)+'/git/refs'||ref.requestBody!==JSON.stringify({ref:'refs/heads/'+doc.branch,sha:commit})||ref.requestHash!==hashBatch5(ref.requestBody))return;
 const r=opaqueJson(ref.opaque,intent,ref.url,201);return r?.ref==='refs/heads/'+doc.branch&&object(r.object)&&r.object.type==='commit'&&r.object.sha===commit?commit:undefined;
}
async function sourceReady(doc:Document,commit:string,secret:RenderCredential,deps:Batch5Dependencies,signal:AbortSignal):Promise<void>{
 const base=githubBase(doc.source),ref=await connectedRequest(base+'/git/ref/heads/'+doc.branch,{method:'GET',headers:githubHeaders(secret)},deps,signal,32_000),r=parseConnectedJson(ref);
 if(ref.status!==200||r?.ref!=='refs/heads/'+doc.branch||!object(r.object)||r.object.type!=='commit'||r.object.sha!==commit)throw Error('render_frozen_ref_changed');
 for(const [file,expected] of [['index.html',doc.html],['robots.txt',ROBOTS]]){const v=await connectedRequest('https://raw.githubusercontent.com/'+doc.source.repository.slice(19)+'/'+commit+'/'+doc.rootDir+'/public/'+file,{method:'GET',headers:{accept:'text/plain'}},deps,signal,200_000);if(v.status!==200||v.body!==expected)throw Error('render_frozen_file_changed');}
}
export function renderDocument(context:ConnectedContext):Document {
 const a=account(context),draft=context.task.draft;if(!a||!draft||!context.task.topicUrl||context.site.category!=='software')throw Error('render_document_invalid');
 const target=new URL(context.task.topicUrl),home=new URL(context.site.url);if(home.protocol!=='https:'||target.protocol!=='https:'||home.hostname!==target.hostname||target.username||target.password||target.hash)throw Error('render_target_invalid');
 const title=draft.title.trim();if(!title||title.length>200||/[\r\n]/.test(title))throw Error('render_title_invalid');
 const {html}=renderShareYourHtmlArticle({draft,targetUrl:target.href,language:context.site.language,slug:'render-docs'}),$=load(html),links=$('a[href]');
 if(links.length!==1||links.attr('href')!==target.href)throw Error('render_single_target_required');
 const source=a.renderSource;if(!validRenderSource(source))throw Error('render_connected_source_required');const branch='render-'+hashBatch5(context.task.id).slice(0,24),rootDir='articles/'+branch;
 const sourceHash=hashBatch5(JSON.stringify({taskId:context.task.id,siteId:context.site.id,accountId:a.id,ownerId:a.username,html,target:target.href,source}));
 const request=JSON.stringify({type:'static_site',name:'software-guide-'+hashBatch5(context.task.id).slice(0,16),ownerId:a.username,repo:source.repository,branch,rootDir,autoDeployTrigger:'off',envVars:[{key:'SKIP_INSTALL_DEPS',value:'true'}],serviceDetails:{buildCommand:'true',publishPath:'public',previews:{generation:'off'},renderSubdomainPolicy:'enabled'}});
 if(Buffer.byteLength(html)>200_000)throw Error('render_document_too_large');
 return {title,html,target:target.href,rel:links.attr('rel')??'',bytes:Buffer.byteLength(html)+Buffer.byteLength(ROBOTS),request,sourceHash,requestHash:hashBatch5(request),source,branch,rootDir};
}
export function renderPublicUrl(value:unknown):string|undefined {
 if(typeof value!=='string')return;try{const u=new URL(value);if(u.protocol==='https:'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/.test(u.hostname)&&!u.username&&!u.password&&!u.port&&u.pathname==='/'&&!u.search&&!u.hash)return u.href}catch{return}
}
function owned(v:unknown,doc:Document):v is Record<string,unknown>{
 if(!object(v)||!object(v.serviceDetails))return false;const expected=JSON.parse(doc.request),d=v.serviceDetails;
 return v.type==='static_site'&&v.ownerId===expected.ownerId&&v.name===expected.name&&v.repo===doc.source.repository&&v.branch===doc.branch&&v.rootDir===doc.rootDir
  &&(v.autoDeployTrigger==='off'||!('autoDeployTrigger'in v)&&v.autoDeploy==='no')&&(!('autoDeploy'in v)||v.autoDeploy==='no')
  &&v.suspended==='not_suspended'&&d.buildCommand==='true'&&d.publishPath==='public'&&d.buildPlan==='starter'
  &&object(d.previews)&&d.previews.generation==='off'&&d.renderSubdomainPolicy==='enabled'&&renderPublicUrl(d.url)!==undefined;
}
function published(v:unknown,doc:Document,rawResponse:string):Published|undefined {
 if(!object(v)||!owned(v.service,doc)||typeof v.service.id!=='string'||!/^srv-[a-z0-9]{10,40}$/.test(v.service.id)||typeof v.deployId!=='string'||!/^dep-[a-z0-9]{10,40}$/.test(v.deployId))return;
 return {id:v.service.id,deployId:v.deployId,url:renderPublicUrl((v.service.serviceDetails as Record<string,unknown>).url)!,rawResponse};
}
export function renderOriginalReceipt(value:Batch5OpaqueResponse|undefined,intent:Batch5Intent,doc:Document):Published|undefined {
 if(!value||value.status!==201||value.responseUrl!==RENDER_API+'/services'||!value.bodyComplete||!/^application\/json\b/i.test(value.contentType)||JSON.stringify(value.intent)!==JSON.stringify(intent)||value.bodyBase64.length>100_000)return;
 try{const b=Buffer.from(value.bodyBase64,'base64');if(b.toString('base64')!==value.bodyBase64)return;const raw=new TextDecoder('utf-8',{fatal:true}).decode(b);return published(JSON.parse(raw),doc,raw)}catch{return}
}
async function publicAccepted(entry:Published,doc:Document,deps:Batch5Dependencies,signal:AbortSignal,body:string):Promise<boolean>{
 const page=await connectedRequest(entry.url,{method:'GET',headers:{accept:'text/html'}},deps,signal,750_000);
 if(page.status!==200||!/^text\/html\b/i.test(page.contentType)||noindex(page.robotsHeader))return false;
 const $=load(page.body),original=load(doc.html),main=$('main'),expected=original('main');
 if(main.length!==1||expected.length!==1||main.html()!==expected.html()||$('iframe,frame,base').length
  ||$('meta[http-equiv]').toArray().some(e=>($(e).attr('http-equiv')??'').toLowerCase()==='refresh')
  ||$('meta[name]').toArray().some(e=>/^(?:robots|googlebot|bingbot)$/i.test($(e).attr('name')??'')&&noindex($(e).attr('content')??''))
  ||$('link[rel~="canonical"]').toArray().some(e=>$(e).attr('href')!==entry.url))return false;
 const links=$('a[href]').toArray().filter(e=>$(e).attr('href')===doc.target);if(links.length!==1||($(links[0]).attr('rel')??'')!==doc.rel)return false;
 const robots=await connectedRequest(entry.url+'robots.txt',{method:'GET',headers:{accept:'text/plain'}},deps,signal,4096);
 if(robots.status!==200||!/^text\/plain\b/i.test(robots.contentType)||robots.body.replace(/\r\n/g,'\n')!==ROBOTS||!deps.renderPage)return false;
 const proof=await deps.renderPage(entry.url,doc.target,doc.title,body,signal);return proof.found&&proof.indexable&&proof.rel===doc.rel;
}
export async function reconcileRenderTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<{status:'found';publicUrl:string;rel:string;batch5:Batch5TaskState}|{status:'unknown'}>{
 try{const p=context.batch5Persistence,owner=account(context);if(!p||!owner)return {status:'unknown'};
  const secret=parseRenderCredential(await context.secrets.get(`account:${owner.id}`));if(!secret||!account(context,secret))return {status:'unknown'};
  const intent=await p.loadIntent();if(!intent||intent.channelId!==CHANNEL||intent.siteId!==context.site.id)return {status:'unknown'};
  const doc=renderDocument(context);if(doc.sourceHash!==intent.sourceHash||doc.requestHash!==intent.requestHash)return {status:'unknown'};
  const writes=await p.loadRenderWrites?.()??[],commit=renderSourceCommit(writes,intent,doc);if(!commit)return {status:'unknown'};
  const serviceWrite=writes[3];if(!serviceWrite||serviceWrite.stage!=='service'||serviceWrite.url!==RENDER_API+'/services'||serviceWrite.requestBody!==doc.request||serviceWrite.requestHash!==doc.requestHash)return {status:'unknown'};
  const entry=renderOriginalReceipt(await p.loadOpaqueResponse()??serviceWrite.opaque,intent,doc);if(!entry)return {status:'unknown'};
  const receipt=await p.loadReceipt();if(receipt&&(JSON.stringify(receipt.intent)!==JSON.stringify(intent)||receipt.publicUrl!==entry.url||receipt.remoteId!==entry.id||receipt.rawResponse!==entry.rawResponse))return {status:'unknown'};
  const deps=connectedDependencies(context,overrides);
  await sourceReady(doc,commit,secret,deps,context.signal);
  const service=await connectedRequest(RENDER_API+'/services/'+entry.id,{method:'GET',headers:auth(secret)},deps,context.signal,100_000),v=parseConnectedJson(service);
  if(service.status!==200||!owned(v,doc)||v.id!==entry.id||renderPublicUrl((v.serviceDetails as Record<string,unknown>).url)!==entry.url)return {status:'unknown'};
  const deployment=await connectedRequest(RENDER_API+'/services/'+entry.id+'/deploys/'+entry.deployId,{method:'GET',headers:auth(secret)},deps,context.signal,64_000),deploy=parseConnectedJson(deployment);
  if(deployment.status!==200||deploy?.id!==entry.deployId||deploy.status!=='live'||!object(deploy.commit)||deploy.commit.id!==commit||!await publicAccepted(entry,doc,deps,context.signal,context.task.draft!.body))return {status:'unknown'};
  const state=await persistBatch5Receipt(context,receipt??{version:1,intent,publicUrl:entry.url,remoteId:entry.id,rawResponse:entry.rawResponse},owner.id,entry.id);
  return {status:'found',publicUrl:entry.url,rel:doc.rel,batch5:state};
 }catch{return {status:'unknown'}}
}
export async function runRenderTask(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<ExecutionResult>{
 if(context.channel.id!==CHANNEL||context.task.channelId!==CHANNEL||context.task.siteId!==context.site.id||!context.channel.enabled||context.channel.automation!=='api')return {status:'needs_input',message:'Render 平台或任务账号无效'};
 const p=context.batch5Persistence,owner=account(context);if(!p?.reserveIntent||!p.markSending||!p.assertReadyToSubmit||!p.reserveRenderWrite||!p.saveRenderWriteResponse||!p.loadRenderWrites||!owner)return {status:'needs_input',message:'Render 缺少账号或持久化写前闸'};
 if(await p.loadIntent()||batch5State(context)||context.task.submittedAt||context.task.publicUrl){const found=await reconcileRenderTask(context,overrides);return found.status==='found'?{status:'review',publicUrl:found.publicUrl,batch5:found.batch5,message:'Render 原所属站点和公开原文已只读核对'}:unknown('Render 原事务待核对，不重复 POST')}
 const secret=parseRenderCredential(await context.secrets.get(`account:${owner.id}`));if(!secret?.githubToken||!secret.source||!account(context,secret))return {status:'needs_input',message:'Render 原工作区账号不符'};
 const deps=connectedDependencies(context,overrides);let doc:Document;
 const reviewValid=()=>context.task.articleReview?.bindingVersion===2&&context.task.articleReview.reviewContractVersion===5&&articleReviewStillValid(context.task,context.site,context.channel,context.settings,context.getAccount(),context.getArticlePublicationContext?.());
 try{if(!reviewValid())throw Error('review');doc=renderDocument(context);assertRenderCapacity(context,deps.now?.()??new Date());const identity=await probeRenderConnection(secret.apiKey,secret.ownerId,deps,context.signal);if(identity.email!==secret.email)throw Error('owner');await sourcePreflight(doc,secret,deps,context.signal)}
 catch{return {status:'needs_input',message:'Render 当前 V5 原稿审核、无卡 Hobby 容量及冻结 Git 来源尚未满足'}}
 const intent:Batch5Intent={version:1,channelId:CHANNEL,operationId:randomUUID(),siteId:context.site.id,sourceHash:doc.sourceHash,requestHash:doc.requestHash,createdAt:(deps.now?.()??new Date()).toISOString()};
 try{await p.reserveIntent(intent);context.checkpoint({batch5:stateFromIntent(intent,'reserved',owner.id),checkpoint:'batch5_reserved'} as Partial<Task>);
  await p.assertReadyToSubmit(intent);await p.markSending(intent);context.checkpoint({batch5:stateFromIntent(intent,'submitting',owner.id),checkpoint:'batch5_submitting',submittedAt:intent.createdAt} as Partial<Task>);
  const current=parseRenderCredential(await context.secrets.get(`account:${owner.id}`)),currentDoc=renderDocument(context);
  if(!current||JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||currentDoc.requestHash!==intent.requestHash||currentDoc.sourceHash!==intent.sourceHash)throw Error('late_change');
  assertRenderCapacity(context,deps.now?.()??new Date());await p.assertReadyToSubmit(intent);
 }catch{return unknown('Render 写前权限或原稿变化；保留意图，后续只读对账')}
 const write=async(stage:RenderWriteStage['stage'],url:string,body:string,isGithub:boolean)=>{
  const current=parseRenderCredential(await context.secrets.get(`account:${owner.id}`));if(JSON.stringify(current)!==JSON.stringify(secret)||!account(context,current)||!reviewValid()||renderDocument(context).sourceHash!==doc.sourceHash)throw Error('late_change');
  assertRenderCapacity(context,deps.now?.()??new Date());await p.assertReadyToSubmit!(intent);await p.reserveRenderWrite!({stage,url,requestBody:body,requestHash:hashBatch5(body)});await p.assertReadyToSubmit!(intent);
  const response=await connectedRequest(url,{method:stage==='source_html'||stage==='source_robots'?'PUT':'POST',headers:{...(isGithub?githubHeaders(secret):auth(secret)),'content-type':'application/json'},body},deps,context.signal,100_000);
  await p.saveRenderWriteResponse!(stage,{version:1,intent,status:response.status,contentType:response.contentType,responseUrl:response.url,bodyBase64:Buffer.from(response.body).toString('base64'),bodyComplete:true});return response;
 };
 try{
  let commit='';
  for(const [index,file] of ['index.html','robots.txt'].entries()){
   const response=await write(index===0?'source_html':'source_robots',githubBase(doc.source)+'/contents/'+doc.rootDir+'/public/'+file,renderSourceFileBody(doc,file as 'index.html'|'robots.txt'),true),v=parseConnectedJson(response);
   if(response.status!==201||!object(v?.commit)||!COMMIT.test(String(v.commit.sha)))throw Error('source_file_unknown');commit=String(v.commit.sha);
  }
  const ref=await write('source_ref',githubBase(doc.source)+'/git/refs',JSON.stringify({ref:'refs/heads/'+doc.branch,sha:commit}),true);
  if(ref.status!==201||renderSourceCommit(await p.loadRenderWrites!(),intent,doc)!==commit)throw Error('ref_unknown');
  await sourceReady(doc,commit,secret,deps,context.signal);
  const response=await write('service',RENDER_API+'/services',doc.request,false);await persistBatch5Response(p,intent,response);

  if(response.status===429)return {status:'failed',reasonCode:'platform_rate_limited',message:'Render 请求配额受限，原请求不重发'};
  if(response.status>=400&&response.status<500&&response.status!==408)return {status:'failed',reasonCode:'platform_rejected',message:'Render 拒绝发布，原请求不重发'};
  const entry=response.status===201?published(parseConnectedJson(response),doc,response.body):undefined;if(!entry)return unknown('Render 创建响应不明，不重发');
  const state=await persistBatch5Receipt(context,{version:1,intent,publicUrl:entry.url,remoteId:entry.id,rawResponse:entry.rawResponse},owner.id,entry.id);
  return {status:'review',publicUrl:entry.url,batch5:state,message:'Render 原收据已加密保存，待所属站点、原文和公开页核对'};
 }catch{return unknown('Render 发布响应不明，保留原事务，不重发')}
}
export async function verifyRenderPublication(context:ConnectedContext,overrides:Batch5Dependencies={}):Promise<LinkResult>{
 const found=await reconcileRenderTask(context,overrides);return found.status==='found'?{found:true,outcome:'found',url:found.publicUrl,rel:found.rel,indexable:true,reason:'原收据、所属站点、原 Git 提交与静态站配置、原生原文链接及 robots 已核对；不保证搜索收录或服务存续'}
  :{found:false,outcome:'unreachable',url:context.task.publicUrl??'https://render.com/',rel:'',reason:'Render 原事务或匿名公开页尚未通过核对'};
}
