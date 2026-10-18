import type {Account,ExecutionContext,ExecutionResult,LinkResult,Site,SynthfolkReviewedInput,SynthfolkTaskReceipt,Task} from '../shared/types';
import {
  SYNTHFOLK_REGISTER,parseSynthfolkRegistration,readSynthfolkPublicProfile,registerSynthfolkProfile,
  synthfolkHash,synthfolkProfileMatches,synthfolkRegistrationRequest,validSynthfolkAccountSecret,validSynthfolkApiKey,
  type SynthfolkAccountSecret,type SynthfolkProfileDraft,type SynthfolkRegistrationIntent,type SynthfolkRegistrationReceipt,
} from './synthfolk';
import {parseOpenAgentChatOpaque,type OpenAgentChatDependencies} from './openagentchat';
import {verifySynthfolkProfile} from './synthfolk-public';

const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exactDate=(value:string|undefined)=>!!value&&Number.isFinite(Date.parse(value));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const targetFor=(task:Pick<Task,'topicUrl'>,site:Pick<Site,'url'>)=>task.topicUrl??site.url;
const operation=(kind:'register'|'import'|'reuse',id:string)=>`synthfolk_${kind}_${id.replace(/-/g,'').toLowerCase()}`;
function matches(context:Pick<ExecutionContext,'channel'|'task'>){return context.channel.id==='synthfolk'&&context.channel.domain==='synthfolk.ai'&&context.channel.kind==='profile'&&context.channel.automation==='api'&&context.channel.accountRequired&&context.channel.articleRequired&&context.task.channelId==='synthfolk'&&context.task.sourceDomain==='synthfolk.ai'}
function normalize(value:string){return value.replace(/\s+/g,' ').trim()}
function slugBase(value:string){const result=value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');return result||'project-assistant'}
function stableHandle(site:Pick<Site,'domain'|'name'>,accountId:string){if(!UUID.test(accountId))throw Error('Synthfolk 本机身份无效');const suffix=accountId.replace(/-/g,'').slice(0,8),base=slugBase(site.domain||site.name).slice(0,Math.max(3,39-suffix.length));return `${base.replace(/-+$/,'')}-${suffix}`.slice(0,40).replace(/-+$/,'')}
function skillFor(site:Pick<Site,'category'>){return ({software:'Software',ai:'AI systems',developer:'Developer tools',design:'Design',business:'Business',content:'Documentation',education:'Education',finance:'Financial education',general:'Research'} as const)[site.category]}
function plainProfileText(value:string){return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)&&!/<\s*\/?\s*[A-Za-z][^>]*>/.test(value)&&!/!?(?:\[[^\]]*\])\s*(?:\([^)]*\)|\[[^\]]*\])/.test(value)}

export function validSynthfolkAccount(account:Account|undefined):account is Account&{synthfolk:NonNullable<Account['synthfolk']>} {
  const proof=account?.synthfolk;if(!account||account.channelId!=='synthfolk'||account.email!==''||account.credentialKind!=='api_token'||!['generated','imported'].includes(account.source??'')||account.status!=='registered'||!account.hasPassword||!proof||proof.version!==1||proof.stage!=='ready'||proof.operationId!==operation(account.source==='imported'?'import':'register',account.id)||!HASH.test(proof.requestHash)||!HASH.test(proof.sourceHash)||account.username!==proof.handle||account.displayName!==proof.name||proof.availability!=='closed'||!HASH.test(proof.keyFingerprint??'')||typeof proof.claimed!=='boolean'||!exactDate(proof.checkedAt))return false;
  if(account.source==='imported'&&(proof.claimed!==true||(account.registrationAttempts??0)!==0)||account.source==='generated'&&(account.registrationAttempts??0)!==1)return false;
  try{const request=synthfolkRegistrationRequest(accountProfile(account),proof.website);return request.requestHash===proof.requestHash&&request.sourceHash===proof.sourceHash}catch{return false}
}

export function accountProfile(account:Account):SynthfolkProfileDraft {
  const proof=account.synthfolk;if(!proof)throw Error('Synthfolk 账号资料缺失');return {handle:proof.handle,name:proof.name,headline:proof.headline,about:proof.about,operator:proof.operator,website:proof.website,availability:'closed',skills:[...proof.skills]};
}

export function synthfolkStructuredProfile(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'domain'|'name'|'category'>,account?:Account,accountId?:string):SynthfolkProfileDraft {
  const targetUrl=targetFor(task,site);if(validSynthfolkAccount(account)){const profile=accountProfile(account);if(profile.website!==targetUrl)throw Error('Synthfolk 单一公开身份已绑定其他网站，不能覆盖');return profile}
  if(!task.draft||!accountId||!UUID.test(accountId))throw Error('Synthfolk 稿件或固定身份缺失');
  const name=normalize(task.draft.title),headline=normalize(task.draft.description),generated=task.draft.body.trim(),operator='Human operator',disclosure=`This AI assistant is controlled by a human. Its Website field points to ${site.name}, and this profile describes that project only; it does not claim employment, endorsement, client work, ownership, or independent third-party status.`;
  const about=normalize(`${disclosure}\n\n${generated}`),skills=[skillFor(site),'Documentation'].filter((value,index,items)=>items.indexOf(value)===index);
  if(!plainProfileText(name)||!plainProfileText(headline)||!plainProfileText(about))throw Error('Synthfolk 公开资料必须为纯文本');
  return synthfolkRegistrationRequest({handle:stableHandle(site,accountId),name,headline,about,operator,website:targetUrl,availability:'closed',skills},targetUrl).payload;
}

export function synthfolkDraftError(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'|'domain'|'name'|'category'>,account?:Account,accountId?:string):string|undefined{try{synthfolkStructuredProfile(task,site,account,accountId);return}catch(error){return error instanceof Error?error.message:'Synthfolk 资料稿无效'}}

export function createSynthfolkPlannedInput(task:Task,site:Site,accountId:string,account?:Account):SynthfolkReviewedInput|undefined {
  try{const profile=synthfolkStructuredProfile(task,site,account,accountId),request=synthfolkRegistrationRequest(profile,targetFor(task,site));return {version:1,accountId,profile,targetUrl:targetFor(task,site),sourceHash:request.sourceHash,draftRevision:task.draftRevision??0,disclosure:{humanOperated:true,relationship:'human_operator',operator:profile.operator}}}catch{return}
}
export function createSynthfolkReviewedInput(task:Task,site:Site,approval:NonNullable<SynthfolkReviewedInput['approval']>,account?:Account):SynthfolkReviewedInput|undefined {
  const planned=task.synthfolkInput;if(!planned||planned.approval||approval.method!=='ai'||!exactDate(approval.reviewedAt)||!HASH.test(approval.contentHash)||!HASH.test(approval.contextHash))return;
  const current=createSynthfolkPlannedInput(task,site,planned.accountId,account);if(!current||!same(current,planned))return;
  return {...current,approval:{...approval}};
}
export function synthfolkReviewPayload(task:Pick<Task,'synthfolkInput'>){const input=task.synthfolkInput;if(!input)return null;const {approval:_approval,...planned}=input;return planned}
export function synthfolkTaskIdentity(task:Task,site:Site|undefined,account?:Account){
  const input=task.synthfolkInput,review=task.articleReview;if(!site||!input||input.version!==1||!input.approval||input.approval.method!=='ai'||review?.status!=='passed'||review.reviewedAt!==input.approval.reviewedAt||review.contentHash!==input.approval.contentHash||review.contextHash!==input.approval.contextHash||input.draftRevision!==(task.draftRevision??0)||input.targetUrl!==targetFor(task,site))return;
  const rebuilt=createSynthfolkPlannedInput(task,site,input.accountId,validSynthfolkAccount(account)?account:undefined);if(!rebuilt||!same(rebuilt,{...input,approval:undefined}))return;
  try{const request=synthfolkRegistrationRequest(input.profile,input.targetUrl);if(request.sourceHash!==input.sourceHash)return;return {input,sourceHash:request.sourceHash,requestHash:request.requestHash}}catch{return}
}

function parseSecret(value:string|undefined):SynthfolkAccountSecret|undefined{if(!value)return;try{const parsed=JSON.parse(value);return validSynthfolkAccountSecret(parsed)?parsed:undefined}catch{return}}
async function accountAccess(context:ExecutionContext){const account=context.getAccount(),expectedAccountId=context.task.synthfolk?.accountId??context.task.synthfolkInput?.accountId??context.task.accountId??context.synthfolkPersistence?.accountId;if(!validSynthfolkAccount(account)||account.id!==expectedAccountId)return;const secret=parseSecret(await context.secrets.get(`account:${account.id}`)),profile=accountProfile(account);if(!secret?.receipt||secret.receipt.apiKey===undefined||!validSynthfolkApiKey(secret.receipt.apiKey)||synthfolkHash(secret.receipt.apiKey)!==account.synthfolk.keyFingerprint||!synthfolkProfileMatches(secret.receipt.profile,profile))return;return {account,profile,secret,key:secret.receipt.apiKey}}
function intentFrom(input:SynthfolkReviewedInput,task:Task,createdAt:string):SynthfolkRegistrationIntent {const request=synthfolkRegistrationRequest(input.profile,input.targetUrl);return {version:1,accountId:input.accountId,taskId:task.id,handle:input.profile.handle,createdAt,requestHash:request.requestHash,sourceHash:request.sourceHash,targetUrl:input.targetUrl}}
function visible(intent:SynthfolkRegistrationIntent,stage:SynthfolkTaskReceipt['stage'],receipt?:SynthfolkRegistrationReceipt,acceptance?:{checkedAt:string;linkRel:string}):SynthfolkTaskReceipt{return {operationId:operation('register',intent.accountId),accountId:intent.accountId,handle:intent.handle,sourceHash:intent.sourceHash,requestHash:intent.requestHash,targetUrl:intent.targetUrl,createdAt:intent.createdAt,stage,...(receipt?{publicUrl:receipt.profile.url,claimed:receipt.profile.claimed}:{}),...(acceptance?{acceptanceCheckedAt:acceptance.checkedAt,linkRel:acceptance.linkRel}:{})}}
function reuseVisible(task:Task,identity:NonNullable<ReturnType<typeof synthfolkTaskIdentity>>,account:Account,createdAt:string):SynthfolkTaskReceipt{return {operationId:operation('reuse',task.id),accountId:identity.input.accountId,handle:identity.input.profile.handle,sourceHash:identity.sourceHash,requestHash:identity.requestHash,targetUrl:identity.input.targetUrl,createdAt,stage:'published',publicUrl:`https://synthfolk.ai/agents/${identity.input.profile.handle}`,claimed:account.synthfolk!.claimed}}
function publishedVisible(base:SynthfolkTaskReceipt,accepted:{checkedAt:string;linkRel:string;claimed:boolean;url:string}):SynthfolkTaskReceipt{return {...base,stage:'published',publicUrl:accepted.url,claimed:accepted.claimed,acceptanceCheckedAt:base.acceptanceCheckedAt??accepted.checkedAt,linkRel:base.linkRel??accepted.linkRel}}

async function verifyAccess(context:ExecutionContext,access:NonNullable<Awaited<ReturnType<typeof accountAccess>>>,base:SynthfolkTaskReceipt,deps:OpenAgentChatDependencies){
  if(context.signal.aborted)throw Error('任务已暂停');const accepted=await verifySynthfolkProfile(access.profile,access.key,{...deps,signal:context.signal});if(context.signal.aborted)throw Error('任务已暂停');const checkedAt=(deps.now?.()??new Date()).toISOString(),published=publishedVisible(base,{checkedAt,linkRel:accepted.rel,claimed:accepted.claimed,url:accepted.url});await (context.synthfolkPersistence as SynthfolkPersistence|undefined)?.observePublished?.(published,checkedAt);return {checkedAt,linkRel:accepted.rel,claimed:accepted.claimed,url:accepted.url,published};
}
type SynthfolkPersistence=NonNullable<ExecutionContext['synthfolkPersistence']>&{observePublished?(receipt:SynthfolkTaskReceipt,observedAt:string):Promise<void>;markUnmanaged?(intent:SynthfolkRegistrationIntent,checkedAt:string):Promise<void>};

export async function runSynthfolkTask(context:ExecutionContext,deps:OpenAgentChatDependencies=context.synthfolkDependencies??{}):Promise<ExecutionResult>{
  if(!matches(context))return {status:'needs_input',message:'当前渠道规格不支持 Synthfolk 公开资料'};
  const account=context.getAccount(),identity=synthfolkTaskIdentity(context.task,context.site,account);if(!identity)return {status:'needs_input',message:'Synthfolk 需要把完整公开资料、目标、人类操控披露和独立 AI 审核绑定到当前任务'};
  if(validSynthfolkAccount(account)){
    const access=await accountAccess(context);if(!access||access.profile.website!==identity.input.targetUrl||!same(access.profile,identity.input.profile))return {status:'needs_input',message:'Synthfolk 原公开身份、加密 API key 或目标网站不一致，不能覆盖或新造身份'};
    const createdAt=context.task.synthfolk?.createdAt??(deps.now?.()??new Date()).toISOString(),registered=context.task.synthfolk?.operationId===operation('register',account.id),base=registered?visible(intentFrom(identity.input,context.task,createdAt),context.task.synthfolk?.stage??'api_receipt',access.secret.receipt):context.task.synthfolk??reuseVisible(context.task,identity,account,createdAt);
    try{const accepted=await verifyAccess(context,access,base,deps);return {status:'review',message:'Synthfolk 同一公开身份、完整资料、本人 API、原生 Website 链接和抓取策略已只读核对；没有注册或覆盖身份。',publicUrl:accepted.url,linkRel:accepted.linkRel,submittedAt:base.createdAt,checkpoint:'synthfolk_profile_published',synthfolk:accepted.published}}catch{return {status:'review',message:'Synthfolk 原账号已保留；公开资料尚未完成联合只读核验，不会注册第二个身份或覆盖网站。',...(context.task.synthfolk?{submittedAt:base.createdAt,checkpoint:context.task.checkpoint,synthfolk:context.task.synthfolk}:{} )}}
  }
  if(account&&account.channelId==='synthfolk')return {status:'needs_input',message:'Synthfolk 原注册意图或身份未确认；不会重复注册、换 handle 或覆盖网站'};
  const persistence=context.synthfolkPersistence;if(!persistence||persistence.accountId!==identity.input.accountId||!persistence.loadSecret)return {status:'needs_input',message:'Synthfolk 单次注册的加密持久化边界未就绪'};
  let secret=await persistence.loadSecret(),intent=secret?.intent??intentFrom(identity.input,context.task,(deps.now?.()??new Date()).toISOString()),receipt=secret?.receipt;
  if(secret?.intent&&!same(secret.intent,intentFrom(identity.input,context.task,secret.intent.createdAt)))return {status:'needs_input',message:'Synthfolk 原注册意图与当前完整资料或目标不一致；不会重发'};
  if(!receipt&&secret?.opaqueResponse)receipt=parseSynthfolkRegistration(parseOpenAgentChatOpaque(secret.opaqueResponse,SYNTHFOLK_REGISTER,201),identity.input.profile);
  if(receipt&&!secret?.receipt){await persistence.persistRegistered(intent,receipt);secret=await persistence.loadSecret();}
  if(!secret){const result=await registerSynthfolkProfile({accountId:identity.input.accountId,taskId:context.task.id,draft:identity.input.profile,targetUrl:identity.input.targetUrl},persistence,{...deps,signal:context.signal});secret=await persistence.loadSecret();receipt=result.status==='registered'?secret?.receipt:secret?.receipt;if(secret?.intent)intent=secret.intent}
  if(!receipt)receipt=secret?.receipt;
  if(!receipt){const stage=secret?.opaqueResponse?'opaque_response':'submitting';return {status:'review',message:'Synthfolk 单次公开注册结果不明；固定 handle、完整资料及可获得的加密传输记录已保留，只允许只读恢复，绝不重发。',submittedAt:intent.createdAt,checkpoint:stage==='opaque_response'?'synthfolk_registration_opaque_response':'synthfolk_registration_submitting',synthfolk:visible(intent,stage)}}
  const access=await accountAccess(context);if(!access||context.signal.aborted)return {status:'review',message:'Synthfolk 原注册回执已加密保留；任务已暂停，不晋级或发送其他请求。',submittedAt:intent.createdAt,checkpoint:'synthfolk_profile_api_receipt',synthfolk:visible(intent,'api_receipt',receipt)};
  try{const accepted=await verifyAccess(context,access,visible(intent,'api_receipt',receipt),deps);return {status:'review',message:'Synthfolk 同一身份、完整资料、本人 API、公开 API、原生 Website 链接和抓取策略已核对；不代表搜索排名或长期保留。',publicUrl:accepted.url,linkRel:accepted.linkRel,submittedAt:intent.createdAt,checkpoint:'synthfolk_profile_published',synthfolk:accepted.published}}catch{return {status:'review',message:'Synthfolk 原注册回执与密钥已加密保留；联合只读核验尚未完成，不会重复注册。',publicUrl:receipt.profile.url,submittedAt:intent.createdAt,checkpoint:'synthfolk_profile_api_receipt',synthfolk:visible(intent,'api_receipt',receipt)}}
}

export async function reconcileSynthfolkTask(context:ExecutionContext,deps:OpenAgentChatDependencies=context.synthfolkDependencies??{}):Promise<{status:'found';publicUrl:string;synthfolk:SynthfolkTaskReceipt}|{status:'unknown'}>{
  try{
    if(!matches(context)||context.signal.aborted||!context.task.synthfolk)return {status:'unknown'};const saved=context.task.synthfolk,account=context.getAccount(),identity=synthfolkTaskIdentity(context.task,context.site,account);if(!identity||saved.accountId!==identity.input.accountId||saved.requestHash!==identity.requestHash||saved.sourceHash!==identity.sourceHash)return {status:'unknown'};
    if(saved.operationId===operation('reuse',context.task.id)){if(!validSynthfolkAccount(account))return {status:'unknown'};const access=await accountAccess(context);if(!access||context.signal.aborted)return {status:'unknown'};const accepted=await verifyAccess(context,access,saved,deps);return {status:'found',publicUrl:accepted.url,synthfolk:accepted.published}}
    if(saved.operationId!==operation('register',saved.accountId)||!context.synthfolkPersistence?.loadSecret)return {status:'unknown'};const secret=await context.synthfolkPersistence.loadSecret();if(!secret?.intent)return {status:'unknown'};const intent=intentFrom(identity.input,context.task,secret.intent.createdAt);if(!same(secret.intent,intent))return {status:'unknown'};
    let receipt=secret.receipt;if(!receipt&&secret.opaqueResponse)receipt=parseSynthfolkRegistration(parseOpenAgentChatOpaque(secret.opaqueResponse,SYNTHFOLK_REGISTER,201),identity.input.profile);if(receipt&&!secret.receipt)await context.synthfolkPersistence.persistRegistered(intent,receipt);
    if(!receipt){const profile=await readSynthfolkPublicProfile(intent.handle,{...deps,signal:context.signal}).catch(()=>undefined);if(profile&&synthfolkProfileMatches(profile,identity.input.profile)){const checkedAt=(deps.now?.()??new Date()).toISOString();await (context.synthfolkPersistence as SynthfolkPersistence).markUnmanaged?.(intent,checkedAt);return {status:'unknown'}}return {status:'unknown'}}
    const access=await accountAccess(context);if(!access||context.signal.aborted)return {status:'unknown'};const accepted=await verifyAccess(context,access,saved,deps);return {status:'found',publicUrl:accepted.url,synthfolk:accepted.published};
  }catch{return {status:'unknown'}}
}

export async function verifySynthfolkPublication(context:ExecutionContext,deps:OpenAgentChatDependencies=context.synthfolkDependencies??{}):Promise<LinkResult>{
  const saved=context.task.synthfolk,url=saved?.publicUrl??context.task.publicUrl??'https://synthfolk.ai/';if(!saved||saved.stage!=='published'||!saved.publicUrl||!saved.acceptanceCheckedAt)return {found:false,outcome:'invalid',url,rel:'unknown',reason:'Synthfolk 任务缺少已联合核验的原身份与公开资料回执'};
  const result=await reconcileSynthfolkTask(context,deps);return result.status==='found'&&result.publicUrl===saved.publicUrl&&result.synthfolk.accountId===saved.accountId&&result.synthfolk.sourceHash===saved.sourceHash?{found:true,outcome:'found',url:result.publicUrl,rel:result.synthfolk.linkRel??'',reason:'Synthfolk 同一身份、完整资料、本人 API 与原生 Website 链接仍一致'}:{found:false,outcome:'unreachable',url,rel:'unknown',reason:'Synthfolk 原公开资料尚未重新通过只读核验'};
}

export const synthfolkPublisherTesting={matches,stableHandle,skillFor,targetFor,parseSecret,visible,operation};
