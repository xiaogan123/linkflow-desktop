import {randomUUID} from 'node:crypto';
import {marked} from 'marked';
import type {Account,AgentboardApprovalBinding,AgentboardReviewedInput,AgentboardSubmissionSubject,AgentboardTaskReceipt,ExecutionContext,ExecutionResult,LinkResult,Site,Task} from '../shared/types';
import {parseOpenAgentChatOpaque,type OpenAgentChatDependencies} from './openagentchat';
import {AGENTBOARD_FIRST_THREAD,agentboardBoardApi,agentboardDiscussionRequest,agentboardFirstRequest,agentboardHash,agentboardThreadApi,createAgentboardDiscussion,createAgentboardFirst,parseAgentboardFirst,parseAgentboardThread,readAgentboardBoard,readAgentboardBoards,type AgentboardDiscussionDraft,type AgentboardFirstDraft,type AgentboardThread} from './agentboard';
import {verifyAgentboardPublication,type AgentboardPublicationSpec} from './agentboard-public';
import {parseAgentboardAccountSecret,type AgentboardManagedDiscussionPersistence,type AgentboardManagedFirstPersistence} from '../main/agentboard-publication';

const BOARD=/^brd_[a-f0-9]{16}$/,AGENT=/^agt_[a-f0-9]{16}$/,THREAD=/^thr_[a-f0-9]{16}$/;
const target=(task:Pick<Task,'topicUrl'>,site:Pick<Site,'url'>)=>task.topicUrl??site.url;
const requestKey=(taskId:string)=>'agentboard_'+taskId.replace(/-/g,'').toLowerCase();
const operationId=(taskId:string)=>'agentboard_publish_'+taskId.replace(/-/g,'').toLowerCase();
const exactDate=(value:string|undefined)=>{if(!value)return false;const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value};
function validPublicTarget(value:string){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&url.hostname.includes('.')&&!url.hostname.endsWith('.local')}catch{return false}}
function exactOneTargetLink(body:string,url:string){let links=0,targetLinks=0,unsafe=false;try{marked.walkTokens(marked.lexer(body,{gfm:true}),token=>{if(token.type==='html')unsafe=true;if(token.type==='link'){links++;try{const href=new URL(token.href);if(href.href===url)targetLinks++}catch{unsafe=true}}})}catch{return false}return !unsafe&&links===1&&targetLinks===1}
function validSubject(subject:AgentboardSubmissionSubject,targetUrl:string){
  const profile=subject.agent;
  return subject.version===1&&BOARD.test(subject.boardId)&&validPublicTarget(targetUrl)&&profile.name===profile.name.trim()&&profile.name.length>=2&&profile.name.length<=80
    &&profile.description===profile.description.trim()&&profile.description.length>=1&&profile.description.length<=1000&&profile.operatorName===profile.operatorName.trim()&&profile.operatorName.length>=1&&profile.operatorName.length<=120
    &&validPublicTarget(profile.homepage)&&(subject.mode==='introduction'?subject.board==='introductions':subject.board!=='introductions'&&/^[a-z0-9][a-z0-9-]{1,79}$/.test(subject.board));
}
const normalizedLine=(value:string,max:number)=>value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max).trim();
const BOARD_WORDS:Record<Site['category'],string[]>={software:['software','engineering','developer','development','build','builder','tool','project'],developer:['developer','development','engineering','build','builder','code','tool','project'],ai:['ai','agent','model','engineering','build','project'],design:['design','product','build','project'],business:['business','product','service','build','project'],content:['content','publishing','writing','project'],education:['education','learning','research','project'],finance:['finance','fintech','research','project'],general:['general','discussion','project','build']};
export async function prepareAgentboardSubject(task:Pick<Task,'topicUrl'|'agentboardSubject'>,site:Site,account:Account|undefined,deps:OpenAgentChatDependencies={}):Promise<AgentboardSubmissionSubject>{
  const targetUrl=target(task,site);if(!validPublicTarget(targetUrl)||!validPublicTarget(site.url))throw Error('Agentboard 需要可公开读取的 HTTPS 项目网址');
  if(task.agentboardSubject){const board=await readAgentboardBoard(task.agentboardSubject.board,deps);if(board.id!==task.agentboardSubject.boardId||!validSubject(task.agentboardSubject,targetUrl))throw Error('Agentboard 已固定版块或身份与当前任务不一致');return structuredClone(task.agentboardSubject)}
  if(!account){const board=await readAgentboardBoard('introductions',deps),name=normalizedLine(site.name||site.domain,80),description=normalizedLine(site.description,1000);if(name.length<2||!description)throw Error('Agentboard 需要当前网站的真实名称与公开描述');return {version:1,mode:'introduction',board:board.slug,boardId:board.id,agent:{name,description,homepage:site.url,operatorName:'Site publisher using Linkflow Assistant'}}}
  if(!validAgentboardAccount(account)||!account.agentboard)throw Error('Agentboard 原身份尚未通过只读核验');
  const words=BOARD_WORDS[site.category],boards=(await readAgentboardBoards(deps)).filter(board=>board.slug!=='introductions').map(board=>{const haystack=`${board.slug} ${board.title} ${board.description??''}`.toLowerCase();return {board,score:words.reduce((sum,word)=>sum+(haystack.includes(word)?1:0),0)}}).filter(value=>value.score>0).sort((a,b)=>b.score-a.score||a.board.slug.localeCompare(b.board.slug));
  if(!boards.length)throw Error('Agentboard 当前没有与该网站类别明确匹配的非 introductions 版块');const board=await readAgentboardBoard(boards[0].board.slug,deps);if(board.id!==boards[0].board.id)throw Error('Agentboard 版块列表与详情读回不一致');const proof=account.agentboard;
  return {version:1,mode:'discussion',board:board.slug,boardId:board.id,agent:{name:proof.name,description:proof.description,homepage:proof.homepage,operatorName:proof.operatorName}};
}
export function agentboardDraftError(task:Pick<Task,'draft'|'topicUrl'|'agentboardSubject'>,site:Pick<Site,'url'>):string|undefined{
  const draft=task.draft,subject=task.agentboardSubject,targetUrl=target(task,site);
  if(!draft||!subject||!validSubject(subject,targetUrl))return 'Agentboard 需要先固定真实 agent 资料、版块 slug、版块 ID 与精确项目网址。';
  if(draft.title!==draft.title.trim()||draft.title.length<1||draft.title.length>200||/[\r\n\t\x00-\x1f\x7f]/.test(draft.title))return 'Agentboard 标题必须为 1–200 个无控制字符的单行文字。';
  if(draft.body!==draft.body.trim()||draft.body.length<40||draft.body.length>20000)return 'Agentboard 主帖正文必须为 40–20,000 个字符且没有首尾空白。';
  if(!exactOneTargetLink(draft.body,targetUrl))return 'Agentboard 主帖必须只含一个经过审核的 Markdown 链接，并精确指向当前技术项目。';
}
export function createAgentboardReviewedInput(task:Pick<Task,'draft'|'draftRevision'|'topicUrl'|'agentboardSubject'>,site:Pick<Site,'url'>,approval:AgentboardApprovalBinding):AgentboardReviewedInput|undefined{
  if(agentboardDraftError(task,site)||!task.draft||!task.agentboardSubject||approval.method!=='ai'||!exactDate(approval.reviewedAt)||!/^[a-f0-9]{64}$/.test(approval.contentHash)||!/^[a-f0-9]{64}$/.test(approval.contextHash))return;
  return {...structuredClone(task.agentboardSubject),targetUrl:target(task,site),titleSha256:agentboardHash(task.draft.title),bodySha256:agentboardHash(task.draft.body),draftRevision:task.draftRevision??0,approval};
}
export function agentboardTaskIdentity(task:Pick<Task,'draft'|'draftRevision'|'topicUrl'|'articleApprovedAt'|'articleReview'|'agentboardSubject'|'agentboardInput'>,site:Pick<Site,'url'>){
  const input=task.agentboardInput;if(!input)return;const expected=createAgentboardReviewedInput(task,site,input.approval);
  if(!expected||JSON.stringify(expected)!==JSON.stringify(input)||!task.draft)return;
  if(input.approval.method!=='ai')return;const review=task.articleReview;if(review?.status!=='passed'||review.reviewedAt!==input.approval.reviewedAt||review.contentHash!==input.approval.contentHash||review.contextHash!==input.approval.contextHash)return;
  return {input,title:task.draft.title,body:task.draft.body,targetUrl:input.targetUrl};
}
export function validAgentboardAccount(account:Account|undefined):boolean{
  const proof=account?.agentboard;
  return !!account&&account.channelId==='agentboard'&&account.email===''&&account.source==='generated'&&account.credentialKind==='api_token'&&account.status==='registered'&&account.hasPassword&&account.registrationAttempts===1&&proof?.version===1&&proof.stage==='ready'&&!!proof.agentId&&AGENT.test(proof.agentId)&&!!proof.handle&&!!proof.agentUrl&&!!proof.credentialFingerprint&&/^[a-f0-9]{64}$/.test(proof.credentialFingerprint)&&!!proof.introductionThreadId&&THREAD.test(proof.introductionThreadId)&&!!proof.checkedAt;
}
function matches(context:ExecutionContext){return context.channel.id==='agentboard'&&context.channel.domain==='www.agentboard.ai'&&context.channel.automation==='api'&&context.channel.kind==='community'&&context.channel.accountRequired&&context.channel.articleRequired&&context.task.channelId==='agentboard'&&context.task.sourceDomain==='www.agentboard.ai'}
function accountMatchesSubject(account:Account,subject:AgentboardSubmissionSubject){const proof=account.agentboard;return proof?.stage==='ready'&&proof.name===subject.agent.name&&proof.description===subject.agent.description&&proof.homepage===subject.agent.homepage&&proof.operatorName===subject.agent.operatorName}
async function secret(context:ExecutionContext,accountId:string){return parseAgentboardAccountSecret(await context.secrets.get('account:'+accountId))}
function draft(identity:NonNullable<ReturnType<typeof agentboardTaskIdentity>>):AgentboardFirstDraft|AgentboardDiscussionDraft{return identity.input.mode==='introduction'?{agent:identity.input.agent,board:'introductions',title:identity.title,body:identity.body}:{board:identity.input.board,title:identity.title,body:identity.body}}
function visible(intent:{taskId:string;accountId:string;requestKey:string;targetUrl:string;sourceHash:string;requestHash:string;createdAt:string},identity:NonNullable<ReturnType<typeof agentboardTaskIdentity>>,thread?:AgentboardThread,handle?:string,stage:AgentboardTaskReceipt['stage']='submitting'):AgentboardTaskReceipt{return {operationId:operationId(intent.taskId),mode:identity.input.mode,accountId:intent.accountId,requestKey:intent.requestKey,targetUrl:intent.targetUrl,board:identity.input.board,boardId:identity.input.boardId,sourceHash:intent.sourceHash,requestHash:intent.requestHash,createdAt:intent.createdAt,stage,...(thread?{agentId:thread.agentId,handle,threadId:thread.id,remoteCreatedAt:thread.createdAt,publicUrl:thread.publicUrl}:{})}}
function spec(identity:NonNullable<ReturnType<typeof agentboardTaskIdentity>>,accountSecret:NonNullable<ReturnType<typeof parseAgentboardAccountSecret>>,thread:AgentboardThread):AgentboardPublicationSpec{return {credential:accountSecret.credential,agent:accountSecret.agent,thread,board:identity.input.board,title:identity.title,body:identity.body,targetUrl:identity.targetUrl}}
function threadFromVisible(task:Task,identity:NonNullable<ReturnType<typeof agentboardTaskIdentity>>):AgentboardThread|undefined{const receipt=task.agentboard;if(!receipt?.threadId||!receipt.agentId||!receipt.remoteCreatedAt||!receipt.publicUrl)return;try{return {id:receipt.threadId,boardId:receipt.boardId,agentId:receipt.agentId,title:identity.title,body:identity.body,createdAt:receipt.remoteCreatedAt,publicUrl:receipt.publicUrl,apiUrl:agentboardThreadApi(receipt.threadId)}}catch{return}}

async function recoverOpaque(context:ExecutionContext,identity:NonNullable<ReturnType<typeof agentboardTaskIdentity>>){
  if(identity.input.mode==='introduction'){
    const persistence=context.agentboardFirstPersistence as AgentboardManagedFirstPersistence|undefined,record=await persistence?.loadRecord();if(!persistence||!record?.opaqueResponse)return;
    const payload=[200,201].includes(record.opaqueResponse.status)?parseOpenAgentChatOpaque(record.opaqueResponse,AGENTBOARD_FIRST_THREAD,record.opaqueResponse.status):undefined,receipt=parseAgentboardFirst(payload,draft(identity) as AgentboardFirstDraft,identity.input.boardId);if(!receipt)return;
    await persistence.persistCreated(record,receipt);return receipt.thread;
  }
  const persistence=context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence|undefined,record=await persistence?.loadRecord();if(!persistence||!record?.opaqueResponse)return;const request=agentboardDiscussionRequest(draft(identity),identity.targetUrl,record.requestKey),payload=[200,201].includes(record.opaqueResponse.status)?parseOpenAgentChatOpaque(record.opaqueResponse,request.url,record.opaqueResponse.status):undefined,thread=parseAgentboardThread(payload);if(!thread||thread.agentId!==record.agentId||thread.boardId!==identity.input.boardId||thread.title!==identity.title||thread.body!==identity.body)return;await persistence.persistCreated(record,thread);return thread;
}

export async function runAgentboardTask(context:ExecutionContext,deps:OpenAgentChatDependencies=context.agentboardDependencies??{}):Promise<ExecutionResult>{
  if(!matches(context))return {status:'needs_input',message:'当前渠道规格不支持 Agentboard'};
  const identity=agentboardTaskIdentity(context.task,context.site);if(!identity||!context.task.articleApprovedAt)return {status:'needs_input',message:'Agentboard 需要主帖正文、agent 资料、版块参数和技术项目唯一链接共同通过审核'};
  const confirmedBoard=await readAgentboardBoard(identity.input.board,{...deps,signal:context.signal});if(confirmedBoard.id!==identity.input.boardId)return {status:'needs_input',message:'Agentboard 提交前版块 ID 与已审核绑定不一致；未发送 POST'};
  const existing=context.getAccount(),key=requestKey(context.task.id);let result:Awaited<ReturnType<typeof createAgentboardFirst>>|Awaited<ReturnType<typeof createAgentboardDiscussion>>;
  if(identity.input.mode==='introduction'){
    if(existing&&existing.agentboard?.stage!=='intent'&&existing.agentboard?.stage!=='receipt')return {status:'needs_input',message:'Agentboard 已有固定身份；一个项目只能发布一次 introductions，后续须使用独立审核的非 introductions 版块'};
    const persistence=context.agentboardFirstPersistence;if(!persistence)return {status:'needs_input',message:'Agentboard 首帖持久化闸不可用'};
    result=await createAgentboardFirst({accountId:context.task.accountId??randomUUID(),taskId:context.task.id,requestKey:key,targetUrl:identity.targetUrl,boardId:identity.input.boardId,draft:draft(identity) as AgentboardFirstDraft},persistence,{...deps,signal:context.signal});
  }else{
    if(!validAgentboardAccount(existing)||existing!.id!==context.task.accountId||!accountMatchesSubject(existing!,identity.input))return {status:'needs_input',message:'Agentboard 后续讨论必须复用同一已核验身份与主页'};
    const accountSecret=await secret(context,existing!.id),persistence=context.agentboardDiscussionPersistence;if(!accountSecret||accountSecret.agent.id!==existing!.agentboard!.agentId||agentboardHash(accountSecret.credential)!==existing!.agentboard!.credentialFingerprint||!persistence)return {status:'needs_input',message:'Agentboard 原 credential、身份或讨论持久化闸不可用'};
    result=await createAgentboardDiscussion({accountId:existing!.id,taskId:context.task.id,requestKey:key,targetUrl:identity.targetUrl,boardId:identity.input.boardId,agent:accountSecret.agent,credential:accountSecret.credential,draft:draft(identity) as AgentboardDiscussionDraft},persistence,{...deps,signal:context.signal});
  }
  if(result.status==='not_started')return {status:'needs_input',message:'Agentboard 未能原子保存加密意图；未发送网络请求'};
  let thread=result.status==='created'?result.thread:undefined;if(!thread)try{thread=await recoverOpaque(context,identity)}catch{}
  if(!thread){
    const record=identity.input.mode==='introduction'?await (context.agentboardFirstPersistence as AgentboardManagedFirstPersistence|undefined)?.loadRecord():await (context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence|undefined)?.loadRecord(),pending=record?visible(record,identity,undefined,undefined,record.opaqueResponse?'opaque_response':'submitting'):undefined;
    return {status:'review',message:'Agentboard 原写入结果尚未能安全确认；密文保留且不会重复 POST、重新注册或更换主页。',submittedAt:record?.createdAt,agentboard:pending};
  }
  const accountId=result.status==='created'?result.intent.accountId:context.task.accountId;if(!accountId)return {status:'review',message:'Agentboard 原身份绑定缺失；不会重复 POST。'};const accountSecret=await secret(context,accountId);if(!accountSecret)return {status:'review',message:'Agentboard 一次性 credential 已先加密但当前无法解封；不会重复 POST。'};
  const verified=await verifyAgentboardPublication(spec(identity,accountSecret,thread),{...deps,signal:context.signal});
  const persistence=identity.input.mode==='introduction'?context.agentboardFirstPersistence as AgentboardManagedFirstPersistence:context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence;await persistence.promotePublished(verified.agent,verified.thread);
  const intent=result.status==='created'?result.intent:(identity.input.mode==='introduction'?await (context.agentboardFirstPersistence as AgentboardManagedFirstPersistence).loadRecord():await (context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence).loadRecord());if(!intent)throw Error('Agentboard 加密意图缺失');
  return {status:'live',message:'Agentboard 原身份、主帖、版块、作者、正文、canonical 与 robots 已核对；回复内容未用于替代主帖。',publicUrl:verified.url,linkRel:verified.rel,submittedAt:intent.createdAt,checkpoint:'agentboard_published',agentboard:visible(intent,identity,thread,accountSecret.agent.handle,'published')};
}

export async function reconcileAgentboardTask(context:ExecutionContext,deps:OpenAgentChatDependencies=context.agentboardDependencies??{}):Promise<{status:'found';publicUrl:string;rel:string;agentboard:AgentboardTaskReceipt}|{status:'unknown'}>{
  try{if(!matches(context))return {status:'unknown'};const identity=agentboardTaskIdentity(context.task,context.site);if(!identity)return {status:'unknown'};let thread=threadFromVisible(context.task,identity)??await recoverOpaque(context,identity);const accountId=context.task.accountId??context.task.agentboard?.accountId;if(!thread||!accountId)return {status:'unknown'};const accountSecret=await secret(context,accountId);if(!accountSecret)return {status:'unknown'};const verified=await verifyAgentboardPublication(spec(identity,accountSecret,thread),{...deps,signal:context.signal});const persistence=identity.input.mode==='introduction'?context.agentboardFirstPersistence as AgentboardManagedFirstPersistence:context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence;await persistence?.promotePublished(verified.agent,verified.thread);const record=identity.input.mode==='introduction'?await (context.agentboardFirstPersistence as AgentboardManagedFirstPersistence|undefined)?.loadRecord():await (context.agentboardDiscussionPersistence as AgentboardManagedDiscussionPersistence|undefined)?.loadRecord();if(!record)return {status:'unknown'};return {status:'found',publicUrl:verified.url,rel:verified.rel,agentboard:visible(record,identity,verified.thread,accountSecret.agent.handle,'published')}}catch{return {status:'unknown'}}
}
export async function verifyAgentboardTask(context:ExecutionContext,deps:OpenAgentChatDependencies=context.agentboardDependencies??{}):Promise<LinkResult>{const result=await reconcileAgentboardTask(context,deps),url=context.task.publicUrl??'https://www.agentboard.ai/';return result.status==='found'?{found:true,outcome:'found',url:result.publicUrl,rel:result.rel,reason:'Agentboard 原身份、审核版块、匿名原生主帖和抓取规则仍一致'}:{found:false,outcome:'unreachable',url,rel:'unknown',reason:'Agentboard 原主帖尚未重新通过有界只读核验'}}
