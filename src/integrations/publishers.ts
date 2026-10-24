import {BATCH5_PUBLISHERS} from './batch5-publishers';
import type {Channel,ExecutionContext,ExecutionResult,LinkResult,NotebinTaskReceipt,Site,Task} from '../shared/types';
import {runTelegraphTask,reconcileTelegraphTask} from './telegraph';
import {runBloggerTask,reconcileBloggerTask} from './blogger';
import {runBlueskyTask,reconcileBlueskyTask} from './bluesky';
import {runParagraphTask,reconcileParagraphTask} from './paragraph';
import {runNostrTask,reconcileNostrTask} from './nostr';
import {preparePaperIdentity,runPaperTask,reconcilePaperTask} from './paper';
import {runHiveTask,reconcileHiveTask} from './hive';
import {prepareMataroaIdentity,runMataroaTask,reconcileMataroaTask} from './mataroa';
import {prepareVerboseIdentity,runVerboseTask,reconcileVerboseTask} from './verbose';
import {runProseTask,reconcileProseTask} from './prose';
import {prepareRentryIdentity,runRentryTask,reconcileRentryTask} from './rentry';
import {runLucidTask,reconcileLucidTask} from './lucid';
import {runBetterThanHtmlTask,reconcileBetterThanHtmlTask} from './betterthanhtml';
import {runWordPressTask,reconcileWordPressTask} from './wordpress';
import {runLeafletTask,reconcileLeafletTask} from './leaflet';
import {runRaindropTask,reconcileRaindropTask} from './raindrop';
import {runGistTask} from './gist';
import {runSupanoteTask,reconcileSupanoteTask} from './supanote-publisher';
import {runDocsMdTask,reconcileDocsMdTask} from './docs-md-publisher';
import {runHtmlAppTask,reconcileHtmlAppTask} from './html-app-publisher';
import {runDeedPageTask,reconcileDeedPageTask} from './deed-page-publisher';
import {runMarkdropTask,reconcileMarkdropTask} from './markdrop-publisher';
import {runDraftmarkTask,reconcileDraftmarkTask} from './draftmark-publisher';
import {preparePlopinoIdentity,runPlopinoTask,reconcilePlopinoTask} from './plopino-publisher';
import {prepareVibeDropIdentity,runVibeDropTask,reconcileVibeDropTask} from './vibedrop-publisher';
import {prepareWordcellIdentity,runWordcellTask,reconcileWordcellTask} from './wordcell-publisher';
import {acceptNotebinPublication,makeNotebinContentApproval,notebinDraftIdentity,publishReviewedNotebinNote,recoverUnknownNotebinCreate,type NotebinDraftIdentity,type NotebinPublisherDependencies} from './notebin-publisher';
import type {NotebinPublicationReceipt} from './notebin';
import {prepareOpenAgentChatIdentity,reconcileOpenAgentChatTask,runOpenAgentChatTask} from './openagentchat-publisher';
import {prepareShellbookIdentity,reconcileShellbookTask,runShellbookTask} from './shellbook-publisher';
import {prepareAgentRiotIdentity,reconcileAgentRiotTask,runAgentRiotTask} from './agentriot-publisher';
import {prepareAgentNotepadIdentity,reconcileAgentNotepadTask,runAgentNotepadTask} from './agentnotepad-publisher';
import {prepareColonyIdentity,reconcileColonyTask,runColonyTask} from './colony-publisher';
import {prepareAgentHowIdentity,reconcileAgentHowTask,runAgentHowTask} from './agenthow-publisher';
import {reconcileAgentsGatherTask,runAgentsGatherTask} from './agentsgather-publisher';
import {prepareBerrryIdentity,reconcileBerrryTask,runBerrryTask} from './berrry-publisher';
import {prepareLargeLanguageIdentity,reconcileLargeLanguageTask,runLargeLanguageTask} from './large-language-publisher';
import {prepareSwarmMemoIdentity,reconcileSwarmMemoTask,runSwarmMemoTask} from './swarmmemo-publisher';
import {reconcileTantiveTask,runTantiveTask} from './tantive-publisher';
import {reconcileTheThingsTask,runTheThingsTask} from './thethings-publisher';
import {reconcileCarcinusTask,runCarcinusTask} from './carcinus-publisher';
import {reconcileSynthfolkTask,runSynthfolkTask} from './synthfolk-publisher';
import {prepareAgentsWikiIdentity,reconcileAgentsWikiTask,runAgentsWikiTask} from './agentswiki-publisher';
import {reconcileAgentboardTask,runAgentboardTask} from './agentboard-publisher';
import {reconcileHartTask,runHartTask} from './hart-publisher';
import {reconcileChatClawTask,runChatClawTask} from './chatclaw-publisher';
import {reconcileFedditTask,runFedditTask} from './feddit-publisher';
import {reconcileBeaconTask,runBeaconTask} from './beacon-publisher';
import {reconcileGitBookTask,runGitBookTask} from './gitbook-publisher';
import {reconcileValTownTask,runValTownTask} from './valtown-publisher';
import {reconcileBitbucketTask,runBitbucketTask} from './bitbucket-publisher';
function withPlopinoPersistence(context:ExecutionContext){context.plopinoPersistence??=(context.secrets as typeof context.secrets&{plopinoPersistence?:ExecutionContext['plopinoPersistence']}).plopinoPersistence;return context}
function withVibeDropPersistence(context:ExecutionContext){context.vibedropPersistence??=(context.secrets as typeof context.secrets&{vibedropPersistence?:ExecutionContext['vibedropPersistence']}).vibedropPersistence;return context}
function withWordcellPersistence(context:ExecutionContext){context.wordcellPersistence??=(context.secrets as typeof context.secrets&{wordcellPersistence?:ExecutionContext['wordcellPersistence']}).wordcellPersistence;return context}
export function withBeaconPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{beaconPersistence?:ExecutionContext['beaconPersistence'];beaconDependencies?:ExecutionContext['beaconDependencies']};context.beaconPersistence??=hidden.beaconPersistence;context.beaconDependencies??=hidden.beaconDependencies;return context}
export function withGitBookPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{gitbookPersistence?:ExecutionContext['gitbookPersistence'];gitbookDependencies?:ExecutionContext['gitbookDependencies']};context.gitbookPersistence??=hidden.gitbookPersistence;context.gitbookDependencies??=hidden.gitbookDependencies;return context}
export function withValTownPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{valtownPersistence?:ExecutionContext['valtownPersistence'];valtownDependencies?:ExecutionContext['valtownDependencies']};context.valtownPersistence??=hidden.valtownPersistence;context.valtownDependencies??=hidden.valtownDependencies;return context}
export function withBitbucketPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{bitbucketPersistence?:ExecutionContext['bitbucketPersistence'];bitbucketDependencies?:ExecutionContext['bitbucketDependencies']};context.bitbucketPersistence??=hidden.bitbucketPersistence;context.bitbucketDependencies??=hidden.bitbucketDependencies;return context}
function withTantivePersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{tantivePersistence?:ExecutionContext['tantivePersistence'];tantiveDependencies?:ExecutionContext['tantiveDependencies']};context.tantivePersistence??=hidden.tantivePersistence;context.tantiveDependencies??=hidden.tantiveDependencies;return context}
function withTheThingsPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{theThingsPersistence?:ExecutionContext['theThingsPersistence'];theThingsDependencies?:ExecutionContext['theThingsDependencies']};context.theThingsPersistence??=hidden.theThingsPersistence;context.theThingsDependencies??=hidden.theThingsDependencies;return context}
function withCarcinusPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{carcinusPersistence?:ExecutionContext['carcinusPersistence'];carcinusDependencies?:ExecutionContext['carcinusDependencies']};context.carcinusPersistence??=hidden.carcinusPersistence;context.carcinusDependencies??=hidden.carcinusDependencies;return context}
export function withAgentsWikiPersistence(context:ExecutionContext){const hidden=context.secrets as typeof context.secrets&{agentsWikiDependencies?:ExecutionContext['agentsWikiDependencies'];agentsWikiRegistrationPersistence?:ExecutionContext['agentsWikiRegistrationPersistence'];agentsWikiPublicationPersistence?:ExecutionContext['agentsWikiPublicationPersistence']};context.agentsWikiDependencies??=hidden.agentsWikiDependencies;context.agentsWikiRegistrationPersistence??=hidden.agentsWikiRegistrationPersistence;context.agentsWikiPublicationPersistence??=hidden.agentsWikiPublicationPersistence;return context}

export interface ApiPublisher {
  prepare?(context:ExecutionContext):Promise<ExecutionResult|undefined>;
  publish(context:ExecutionContext):Promise<ExecutionResult>;
  reconcile?(context:ExecutionContext):Promise<{status:'found';publicUrl:string;raindrop?:NonNullable<ExecutionContext['task']['raindrop']>;leaflet?:NonNullable<ExecutionContext['task']['leaflet']>;wordpress?:NonNullable<ExecutionContext['task']['wordpress']>;paper?:NonNullable<ExecutionContext['task']['paper']>;hive?:NonNullable<ExecutionContext['task']['hive']>;mataroa?:NonNullable<ExecutionContext['task']['mataroa']>;verbose?:NonNullable<ExecutionContext['task']['verbose']>;prose?:NonNullable<ExecutionContext['task']['prose']>;rentry?:NonNullable<ExecutionContext['task']['rentry']>;lucid?:NonNullable<ExecutionContext['task']['lucid']>;betterthanhtml?:NonNullable<ExecutionContext['task']['betterthanhtml']>;supanote?:NonNullable<ExecutionContext['task']['supanote']>;docsMd?:NonNullable<ExecutionContext['task']['docsMd']>;htmlApp?:NonNullable<ExecutionContext['task']['htmlApp']>;deedPage?:NonNullable<ExecutionContext['task']['deedPage']>;markdrop?:NonNullable<ExecutionContext['task']['markdrop']>;draftmark?:NonNullable<ExecutionContext['task']['draftmark']>;vibedrop?:NonNullable<ExecutionContext['task']['vibedrop']>;wordcell?:NonNullable<ExecutionContext['task']['wordcell']>;notebin?:NonNullable<ExecutionContext['task']['notebin']>;beacon?:NonNullable<ExecutionContext['task']['beacon']>;gitbook?:NonNullable<ExecutionContext['task']['gitbook']>;valtown?:NonNullable<ExecutionContext['task']['valtown']>;hart?:NonNullable<ExecutionContext['task']['hart']>;chatclaw?:NonNullable<ExecutionContext['task']['chatclaw']>;feddit?:NonNullable<ExecutionContext['task']['feddit']>;agentsWiki?:NonNullable<ExecutionContext['task']['agentsWiki']>;synthfolk?:NonNullable<ExecutionContext['task']['synthfolk']>;carcinus?:NonNullable<ExecutionContext['task']['carcinus']>;verification?:LinkResult;rel?:LinkResult['rel']}|{status:'draft';blogger:NonNullable<ExecutionContext['task']['blogger']>}|{status:'draft';paragraph:NonNullable<ExecutionContext['task']['paragraph']>}|{status:'unknown'}>;
}

function exactNotebinTarget(task:Pick<Task,'topicUrl'>,site:Pick<Site,'url'>){return task.topicUrl??site.url}
export function notebinTaskIdentity(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'>):NotebinDraftIdentity|undefined{return task.draft?notebinDraftIdentity({title:task.draft.title,description:task.draft.description,markdown:task.draft.body,targetUrl:exactNotebinTarget(task,site)}):undefined}
export function notebinTaskApproval(task:Pick<Task,'articleApprovedAt'|'articleReview'> & Partial<Pick<Task,'notebinJournal'>>,identity:NotebinDraftIdentity){if(!task.articleApprovedAt)return;try{return makeNotebinContentApproval(identity,{approvedAt:task.articleApprovedAt,reviewer:task.notebinJournal?.approval.reviewer??(task.articleReview?.status==='passed'?'ai-review':'user-review')})}catch{return}}
export function notebinTaskReceipt(receipt:NotebinPublicationReceipt,stage:NotebinTaskReceipt['stage']):NotebinTaskReceipt{return {...receipt,stage}}
function notebinContextMatches(context:ExecutionContext){return context.channel.id==='notebin'&&context.channel.domain==='notebin.ca'&&context.channel.kind==='article'&&context.channel.automation==='api'&&context.channel.accountRequired&&context.channel.articleRequired&&context.task.channelId==='notebin'&&context.task.sourceDomain==='notebin.ca'}
export async function runNotebinTask(context:ExecutionContext,deps:NotebinPublisherDependencies=context.notebinDependencies??{}):Promise<ExecutionResult>{if(!notebinContextMatches(context))return {status:'needs_input',message:'当前平台规格不支持 Notebin 全文发布'};const identity=notebinTaskIdentity(context.task,context.site),approval=identity&&notebinTaskApproval(context.task,identity),account=context.getAccount();if(!identity||!approval)return {status:'needs_input',message:'Notebin Markdown 原稿须包含唯一本站目标链接并通过当前稿件核对'};if(!account||account.id!==context.task.accountId||!context.notebinPersistence||!context.notebinAccess)return {status:'needs_input',message:'Notebin 发布账号、专用密钥或保存边界未就绪'};let access:Awaited<ReturnType<NonNullable<ExecutionContext['notebinAccess']>['load']>>;try{access=await context.notebinAccess.load()}catch{return {status:'needs_input',message:'Notebin 本机加密专用密钥或账号关联不可用'}}if(access.rootAccountId!==account.notebin?.rootAccountId)return {status:'needs_input',message:'Notebin 根发布账号与当前任务不一致'};const saved=context.task.notebin,createdAt=saved?.createdAt??new Date().toISOString(),operationId=saved?.operationId??`notebin_publish_${context.task.id.replace(/-/g,'').toLowerCase()}`;const result=await publishReviewedNotebinNote({operationId,localAccountId:account.id,rootAccountId:access.rootAccountId,noteApiKey:access.noteApiKey,binding:access.binding,createdAt,identity,approval,persistence:context.notebinPersistence},{...deps,signal:context.signal});if(result.status==='not_started')return {status:'needs_input',message:`Notebin 发布未开始：${result.reason}`};if(result.status==='found'){const receipt=notebinTaskReceipt(result.receipt,'owned');return {status:'review',message:'Notebin 同一专用密钥归属、原始 Markdown、明确空到期字段、公开渲染与抓取策略已检查；保持待复核，不代表搜索收录。',publicUrl:receipt.publicUrl,checkpoint:'notebin_note_owned',submittedAt:createdAt,notebin:receipt}}if(result.receipt){const receipt=notebinTaskReceipt(result.receipt,'api_receipt');return {status:'review',message:result.reason,publicUrl:receipt.publicUrl,checkpoint:'notebin_note_api_receipt',submittedAt:createdAt,notebin:receipt}}return {status:'review',message:result.reason,submittedAt:createdAt}}
export async function reconcileNotebinTask(context:ExecutionContext,deps:NotebinPublisherDependencies=context.notebinDependencies??{}):Promise<{status:'found';publicUrl:string;notebin:NotebinTaskReceipt}|{status:'unknown'}>{const visible=context.task.notebin,journal=context.task.notebinJournal,identity=notebinTaskIdentity(context.task,context.site),approval=identity&&notebinTaskApproval(context.task,identity);if(!notebinContextMatches(context)||!visible||!journal||!identity||!approval||!context.notebinPersistence||!context.notebinAccess||journal.taskId!==context.task.id||journal.localAccountId!==context.task.accountId||journal.intent.operationId!==visible.operationId||journal.intent.requestHash!==identity.requestHash||journal.intent.sourceHash!==identity.sourceHash||journal.approval.sourceHash!==approval.sourceHash||journal.approval.requestHash!==approval.requestHash)return {status:'unknown'};let access:Awaited<ReturnType<NonNullable<ExecutionContext['notebinAccess']>['load']>>;try{access=await context.notebinAccess.load()}catch{return {status:'unknown'}}try{if(journal.receipt){await acceptNotebinPublication({receipt:journal.receipt,identity,binding:access.binding,noteApiKey:access.noteApiKey},{...deps,signal:context.signal});const owned={...journal.receipt,ownership:'owned_list_match' as const};await context.notebinPersistence.promoteOwned?.(owned);return {status:'found',publicUrl:owned.publicUrl,notebin:notebinTaskReceipt(owned,'owned')}}const result=await recoverUnknownNotebinCreate({intent:journal.intent,identity,binding:access.binding,noteApiKey:access.noteApiKey,persistence:context.notebinPersistence},{...deps,signal:context.signal});return result.status==='found'?{status:'found',publicUrl:result.publicUrl,notebin:notebinTaskReceipt(result.receipt,'owned')}:{status:'unknown'}}catch{return {status:'unknown'}}}
export async function verifyNotebinPublication(context:ExecutionContext,deps:NotebinPublisherDependencies=context.notebinDependencies??{}):Promise<LinkResult>{const visible=context.task.notebin,journal=context.task.notebinJournal,identity=notebinTaskIdentity(context.task,context.site),url=context.task.publicUrl??'https://notebin.ca/';if(!notebinContextMatches(context)||visible?.stage!=='owned'||visible.ownership!=='owned_list_match'||journal?.stage!=='owned'||!journal.receipt||!identity||!context.notebinAccess)return {found:false,outcome:'invalid',url,rel:'unknown',reason:'Notebin 任务缺少已归属的原记录、原稿或专用密钥'};try{const access=await context.notebinAccess.load(),evidence=await acceptNotebinPublication({receipt:journal.receipt,identity,binding:access.binding,noteApiKey:access.noteApiKey},{...deps,signal:context.signal});return {found:true,outcome:'found',url:journal.receipt.publicUrl,rel:evidence.targetRel,reason:'Notebin 同一专用密钥归属、原始全文、空到期字段和公开抓取仍一致'}}catch{return {found:false,outcome:'unreachable',url,rel:'unknown',reason:'Notebin 原页面尚未重新通过只读验收'}}}
const publishers:Readonly<Record<string,ApiPublisher>>={
  ...BATCH5_PUBLISHERS,
  paragraph:{publish:runParagraphTask,reconcile:reconcileParagraphTask},
  nostr:{publish:runNostrTask,reconcile:reconcileNostrTask},
  'paper-wf':{prepare:preparePaperIdentity,publish:runPaperTask,reconcile:reconcilePaperTask},
  hive:{publish:runHiveTask,reconcile:reconcileHiveTask},
  mataroa:{prepare:prepareMataroaIdentity,publish:runMataroaTask,reconcile:reconcileMataroaTask},
  verbose:{prepare:prepareVerboseIdentity,publish:runVerboseTask,reconcile:reconcileVerboseTask},
  prose:{publish:runProseTask,reconcile:reconcileProseTask},
  rentry:{prepare:prepareRentryIdentity,publish:runRentryTask,reconcile:reconcileRentryTask},
  'lucid-page':{publish:runLucidTask,reconcile:reconcileLucidTask},
  betterthanhtml:{publish:runBetterThanHtmlTask,reconcile:reconcileBetterThanHtmlTask},
  bluesky:{publish:runBlueskyTask,reconcile:reconcileBlueskyTask},
  blogger:{publish:runBloggerTask,reconcile:reconcileBloggerTask},
  'wordpress-com':{publish:runWordPressTask,reconcile:reconcileWordPressTask},
  leaflet:{publish:runLeafletTask,reconcile:reconcileLeafletTask},
  raindrop:{publish:runRaindropTask,reconcile:reconcileRaindropTask},
  telegraph:{publish:runTelegraphTask,reconcile:reconcileTelegraphTask},
  'github-gist':{publish:runGistTask},
  supanote:{publish:runSupanoteTask,reconcile:reconcileSupanoteTask},
  'docs-md':{publish:runDocsMdTask,reconcile:reconcileDocsMdTask},
  'html-app':{publish:runHtmlAppTask,reconcile:reconcileHtmlAppTask},
  'deed-page':{publish:runDeedPageTask,reconcile:reconcileDeedPageTask},
  markdrop:{publish:runMarkdropTask,reconcile:reconcileMarkdropTask},
  draftmark:{publish:runDraftmarkTask,reconcile:reconcileDraftmarkTask},
  plopino:{prepare:context=>preparePlopinoIdentity(withPlopinoPersistence(context)),publish:context=>runPlopinoTask(withPlopinoPersistence(context)),reconcile:context=>reconcilePlopinoTask(withPlopinoPersistence(context))},
  vibedrop:{prepare:context=>prepareVibeDropIdentity(withVibeDropPersistence(context)),publish:context=>runVibeDropTask(withVibeDropPersistence(context)),reconcile:context=>reconcileVibeDropTask(withVibeDropPersistence(context))},
  wordcell:{prepare:context=>prepareWordcellIdentity(withWordcellPersistence(context)),publish:context=>runWordcellTask(withWordcellPersistence(context)),reconcile:context=>reconcileWordcellTask(withWordcellPersistence(context))},
  notebin:{publish:context=>runNotebinTask(context),reconcile:context=>reconcileNotebinTask(context)},
  openagentchat:{prepare:prepareOpenAgentChatIdentity,publish:runOpenAgentChatTask,reconcile:reconcileOpenAgentChatTask},
  shellbook:{prepare:prepareShellbookIdentity,publish:runShellbookTask,reconcile:reconcileShellbookTask},
  agentriot:{prepare:prepareAgentRiotIdentity,publish:runAgentRiotTask,reconcile:reconcileAgentRiotTask},
  agentnotepad:{prepare:prepareAgentNotepadIdentity,publish:runAgentNotepadTask,reconcile:reconcileAgentNotepadTask},
  colony:{prepare:prepareColonyIdentity,publish:runColonyTask,reconcile:reconcileColonyTask},
  agenthow:{prepare:prepareAgentHowIdentity,publish:runAgentHowTask,reconcile:reconcileAgentHowTask},
  agentsgather:{publish:runAgentsGatherTask,reconcile:reconcileAgentsGatherTask},
  berrry:{prepare:prepareBerrryIdentity,publish:runBerrryTask,reconcile:reconcileBerrryTask},
  'large-language':{prepare:prepareLargeLanguageIdentity,publish:runLargeLanguageTask,reconcile:reconcileLargeLanguageTask},
  swarmmemo:{prepare:prepareSwarmMemoIdentity,publish:runSwarmMemoTask,reconcile:reconcileSwarmMemoTask},
  tantive:{publish:context=>runTantiveTask(withTantivePersistence(context)),reconcile:(context=>reconcileTantiveTask(withTantivePersistence(context))) as ApiPublisher['reconcile']},
  thethings:{publish:context=>runTheThingsTask(withTheThingsPersistence(context)),reconcile:(context=>reconcileTheThingsTask(withTheThingsPersistence(context))) as ApiPublisher['reconcile']},
  carcinus:{publish:context=>runCarcinusTask(withCarcinusPersistence(context),context.carcinusDependencies),reconcile:(context=>reconcileCarcinusTask(withCarcinusPersistence(context),context.carcinusDependencies)) as ApiPublisher['reconcile']},
  synthfolk:{publish:runSynthfolkTask,reconcile:reconcileSynthfolkTask},
  agentswiki:{prepare:context=>prepareAgentsWikiIdentity(withAgentsWikiPersistence(context)),publish:context=>runAgentsWikiTask(withAgentsWikiPersistence(context)),reconcile:context=>reconcileAgentsWikiTask(withAgentsWikiPersistence(context))},
  agentboard:{publish:runAgentboardTask,reconcile:reconcileAgentboardTask},
  hart:{publish:runHartTask,reconcile:reconcileHartTask},
  chatclaw:{publish:runChatClawTask,reconcile:reconcileChatClawTask},
  feddit:{publish:runFedditTask,reconcile:reconcileFedditTask},
  beacon:{publish:context=>{const value=withBeaconPersistence(context);return runBeaconTask(value,{...value.beaconDependencies,allowExternalWrite:true})},reconcile:context=>{const value=withBeaconPersistence(context);return reconcileBeaconTask(value,value.beaconDependencies)}},
  gitbook:{publish:context=>{const value=withGitBookPersistence(context);return runGitBookTask(value,{...value.gitbookDependencies,allowExternalWrite:true})},reconcile:context=>{const value=withGitBookPersistence(context);return reconcileGitBookTask(value,value.gitbookDependencies)}},
  valtown:{publish:context=>{const value=withValTownPersistence(context);return runValTownTask(value,{...value.valtownDependencies,allowExternalWrite:true})},reconcile:context=>{const value=withValTownPersistence(context);return reconcileValTownTask(value,value.valtownDependencies)}},
  bitbucket:{publish:context=>{const value=withBitbucketPersistence(context);return runBitbucketTask(value,{...value.bitbucketDependencies,allowExternalWrite:true})},reconcile:context=>{const value=withBitbucketPersistence(context);return reconcileBitbucketTask(value,value.bitbucketDependencies)}},
};
/** Only registered built-in API adapters may execute; a catalog label grants nothing. */
export function publisherFor(channel:Channel):ApiPublisher|undefined{
  return channel.provenance==='built-in'&&channel.automation==='api'?publishers[channel.id]:undefined;
}
