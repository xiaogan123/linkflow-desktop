import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {inspectRenderedArticle} from './article-rendering';
import type {Account,ExecutionContext,ExecutionResult,LinkResult,Site,SwarmMemoApprovalBinding,SwarmMemoReviewedInput,SwarmMemoTaskReceipt,Task} from '../shared/types';
import {
  SWARMMEMO_COMMAND_URL,
  SWARMMEMO_DISCLOSURE,
  SWARMMEMO_MAX_TEXT_BYTES,
  SWARMMEMO_ORIGIN,
  SWARMMEMO_ROBOTS_URL,
  SWARMMEMO_ROOM,
  SWARMMEMO_PAGE,
  createSwarmMemoCommand,
  generateSwarmMemoIdentity,
  matchesSwarmMemoMessage,
  parseSwarmMemoEntry,
  parseSwarmMemoOpaque,
  parseSwarmMemoReceipt,
  readSwarmMemoJson,
  readSwarmMemoText,
  recoverSwarmMemoReceipt,
  swarmMemoCommandBody,
  swarmMemoEntryBaseUrl,
  swarmMemoEntryJsonUrl,
  swarmMemoHash,
  swarmMemoMutation,
  validSwarmMemoIdentitySecret,
  validSwarmMemoPublicationIntent,
  validSwarmMemoPublicationSecret,
  type SwarmMemoAcceptanceEvidence,
  type SwarmMemoDependencies,
  type SwarmMemoIdentitySecret,
  type SwarmMemoPublicationIntent,
  type SwarmMemoPublicationSecret,
  type SwarmMemoReceipt,
} from './swarmmemo';

const HASH = /^[a-f0-9]{64}$/;
const OPERATION = /^swarmmemo_post_[a-f0-9]{32}$/;
const exactDate = (value: string | undefined) => { if (!value) return false; const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; };
const operation = (taskId: string) => `swarmmemo_post_${taskId.replace(/-/g, '').toLowerCase()}`;

export interface SwarmMemoTaskIdentity {title:string; body:string; targetUrl:string; bodySha256:string; titleSha256:string; draftRevision:number}

function exactTarget(value: string) { try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return; return url.href; } catch { return; } }
function markdownLinks(body: string) { return [...body.matchAll(/(?<!!)\[([^\]\r\n]+)\]\(\s*(https:\/\/[^\s)]+)(?:\s+["'][^)]*)?\)/g)].map(match => ({text: match[1], url: exactTarget(match[2])})); }

export function swarmMemoDraftError(task: Pick<Task, 'draft' | 'topicUrl'>, site: Pick<Site, 'url'>): string | undefined {
  const draft = task.draft, targetUrl = exactTarget(task.topicUrl ?? site.url);
  if (!targetUrl) return 'SwarmMemo 需要当前任务的规范 HTTPS 目标网址。';
  if (!draft || draft.title !== draft.title.trim() || draft.title.length < 4 || draft.title.length > 180 || /[\u0000-\u001f\u007f]/.test(draft.title)) return 'SwarmMemo 标题须为 4–180 字符的单行纯文本。';
  if (!draft.body || Buffer.byteLength(draft.body, 'utf8') < 300 || Buffer.byteLength(draft.body, 'utf8') > SWARMMEMO_MAX_TEXT_BYTES || Buffer.from(draft.body, 'utf8').toString('utf8') !== draft.body || /[\u0000\u000b\u000c\u000e-\u001f\u007f]/.test(draft.body)) return 'SwarmMemo 正文须为 300 字节至 16 KiB 的完整 UTF-8 Markdown。';
  if (draft.body.replace(/\n$/,'') !== draft.body.trimEnd() || draft.body.trimStart() !== draft.body || !draft.body.startsWith(`# ${draft.title}\n\n`)) return 'SwarmMemo 正文必须以当前标题的一级标题开头，且不能含首尾空白。';
  if ((draft.body.match(new RegExp(SWARMMEMO_DISCLOSURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length !== 1) return 'SwarmMemo 正文必须逐字包含一次自动发布身份披露。';
  if (/<\/?[a-z][^>]*>/i.test(draft.body) || /!\[[^\]]*\]\([^)]*\)/.test(draft.body)) return 'SwarmMemo 正文不能包含原始 HTML 或远程图片。';
  const links = markdownLinks(draft.body);
  if (links.length !== 1 || links[0].url !== targetUrl) return 'SwarmMemo 正文必须恰好包含一个经审核的目标 Markdown 链接。';
  const stripped = draft.body.replace(/(?<!!)\[[^\]\r\n]+\]\(\s*https:\/\/[^\s)]+(?:\s+["'][^)]*)?\)/g, '');
  if (/\b(?:https?:\/\/|www\.|mailto:|tel:)/i.test(stripped)) return 'SwarmMemo 正文不能包含审核绑定以外的网址。';
  return;
}

export function createSwarmMemoReviewedInput(task: Pick<Task, 'draft' | 'topicUrl' | 'draftRevision'>, site: Pick<Site, 'url'>, approval: SwarmMemoApprovalBinding): SwarmMemoReviewedInput | undefined {
  const targetUrl = exactTarget(task.topicUrl ?? site.url), draft = task.draft, draftRevision = task.draftRevision ?? 0;
  if (!draft || !targetUrl || swarmMemoDraftError(task, site) || !Number.isInteger(draftRevision) || draftRevision < 0) return;
  if (approval.method === 'manual' ? !exactDate(approval.approvedAt) : !exactDate(approval.reviewedAt) || !HASH.test(approval.contentHash) || !HASH.test(approval.contextHash)) return;
  return {version:1, room:SWARMMEMO_ROOM, page:SWARMMEMO_PAGE, kind:'note', targetUrl, titleSha256:swarmMemoHash(draft.title), bodySha256:swarmMemoHash(draft.body), draftRevision, approval:structuredClone(approval)};
}

export function swarmMemoTaskIdentity(task: Pick<Task, 'draft' | 'topicUrl' | 'draftRevision' | 'articleApprovedAt' | 'articleReview' | 'swarmMemoInput'>, site: Pick<Site, 'url'>): SwarmMemoTaskIdentity | undefined {
  const input = task.swarmMemoInput, draft = task.draft, targetUrl = exactTarget(task.topicUrl ?? site.url);
  if (!input || !draft || !targetUrl || swarmMemoDraftError(task, site) || input.version !== 1 || input.room !== SWARMMEMO_ROOM || input.page !== SWARMMEMO_PAGE || input.kind !== 'note' || input.targetUrl !== targetUrl || input.titleSha256 !== swarmMemoHash(draft.title) || input.bodySha256 !== swarmMemoHash(draft.body) || input.draftRevision !== (task.draftRevision ?? 0)) return;
  const approval = input.approval, review = task.articleReview;
  if (approval.method === 'manual') { if (!exactDate(approval.approvedAt) || task.articleApprovedAt !== approval.approvedAt) return; }
  else if (!exactDate(approval.reviewedAt) || !HASH.test(approval.contentHash) || !HASH.test(approval.contextHash) || review?.status !== 'passed' || review.reviewedAt !== approval.reviewedAt || review.contentHash !== approval.contentHash || review.contextHash !== approval.contextHash || task.articleApprovedAt !== approval.reviewedAt) return;
  return {title:draft.title, body:draft.body, targetUrl, titleSha256:input.titleSha256, bodySha256:input.bodySha256, draftRevision:input.draftRevision};
}

function matches(context: ExecutionContext) { return context.channel.id === 'swarmmemo' && context.channel.domain === 'swarmmemo.com' && context.channel.automation === 'api' && context.channel.kind === 'article' && context.channel.accountRequired && context.channel.articleRequired && context.task.channelId === 'swarmmemo' && context.task.sourceDomain === 'swarmmemo.com'; }
export function validSwarmMemoAccount(account: Account | undefined): boolean { const proof = account?.swarmMemo; return !!account && account.channelId === 'swarmmemo' && account.email === '' && account.source === 'generated' && account.credentialKind === 'api_token' && account.status === 'registered' && account.hasPassword && !!proof && proof.version === 1 && proof.stage === 'ready' && HASH.test(proof.fingerprint) && /^[A-Za-z0-9_-]{43}$/.test(proof.publicKey) && exactDate(proof.checkedAt); }
function identitySecret(raw: string | undefined) { if (!raw) return; try { const value = JSON.parse(raw); return validSwarmMemoIdentitySecret(value) ? value : undefined; } catch { return; } }
function publicationSecret(raw: string | undefined) { if (!raw) return; try { const value = JSON.parse(raw); return validSwarmMemoPublicationSecret(value) ? value : undefined; } catch { return; } }
function accountShape(secret: SwarmMemoIdentitySecret): Account { return {id:secret.accountId, channelId:'swarmmemo', email:'', username:secret.fingerprint, displayName:'Linkflow Assistant (automated publishing agent)', createdAt:secret.createdAt, updatedAt:secret.createdAt, registeredAt:secret.createdAt, verifiedAt:secret.createdAt, status:'registered', hasPassword:true, source:'generated', credentialKind:'api_token', registrationAttempts:0, swarmMemo:{version:1, stage:'ready', fingerprint:secret.fingerprint, publicKey:secret.publicKey, checkedAt:secret.createdAt}}; }

async function readyIdentity(context: ExecutionContext, deps: SwarmMemoDependencies): Promise<{account:Account; secret:SwarmMemoIdentitySecret} | ExecutionResult> {
  let account = context.getAccount();
  if (account && account.channelId !== 'swarmmemo') return {status:'needs_input', message:'SwarmMemo 任务绑定了不相容身份。'};
  if (!account) {
    const secret = generateSwarmMemoIdentity(randomUUID(), (deps.now?.() ?? new Date()).toISOString());
    account = accountShape(secret);
    await context.saveAccount(account, JSON.stringify(secret));
    const restored = identitySecret(await context.secrets.get(`account:${account.id}`)), rebound = context.getAccount() ?? account;
    if (!restored || restored.accountId !== account.id || !validSwarmMemoAccount(rebound) || rebound.swarmMemo?.fingerprint !== restored.fingerprint) return {status:'needs_input', checkpoint:'swarmmemo_identity_pending', message:'SwarmMemo 本地身份未能从加密存储逐字恢复；未发出请求。'};
    return {account:rebound, secret:restored};
  }
  const secret = identitySecret(await context.secrets.get(`account:${account.id}`));
  if (!secret || secret.accountId !== account.id || !validSwarmMemoAccount(account) || account.swarmMemo?.fingerprint !== secret.fingerprint || account.swarmMemo.publicKey !== secret.publicKey) return {status:'needs_input', checkpoint:'swarmmemo_identity_pending', message:'SwarmMemo 原 Ed25519 身份缺少匹配的本机密文；不会创建第二个身份。'};
  // Reuse the one local identity across ordinary site tasks. saveAccount without
  // a secret only adds the current site binding; it cannot replace the key.
  await context.saveAccount(account);
  const rebound=context.getAccount();
  if(!rebound||rebound.id!==account.id||!validSwarmMemoAccount(rebound))return {status:'needs_input',checkpoint:'swarmmemo_identity_pending',message:'SwarmMemo 原 Ed25519 身份未能绑定到当前网站；不会创建第二个身份。'};
  return {account:rebound, secret};
}

function sameIntent(a: SwarmMemoPublicationIntent, b: SwarmMemoPublicationIntent) { return JSON.stringify(a) === JSON.stringify(b); }
function intentFromReceipt(saved: SwarmMemoTaskReceipt, command: SwarmMemoPublicationIntent['command']): SwarmMemoPublicationIntent { return {version:1, kind:'swarmmemo_publication', operationId:saved.operationId, accountId:saved.accountId, fingerprint:saved.fingerprint, requestId:saved.requestId, targetUrl:saved.targetUrl, sourceHash:saved.sourceHash, bodySha256:saved.bodySha256, canonicalSha256:saved.canonicalSha256, requestHash:saved.requestHash, createdAt:saved.createdAt, command, dispatchBudget:1}; }
function taskReceipt(intent: SwarmMemoPublicationIntent, stage: SwarmMemoTaskReceipt['stage'], receipt?: SwarmMemoReceipt, publicUrl?: string): SwarmMemoTaskReceipt { return {operationId:intent.operationId, accountId:intent.accountId, fingerprint:intent.fingerprint, requestId:intent.requestId, targetUrl:intent.targetUrl, sourceHash:intent.sourceHash, bodySha256:intent.bodySha256, canonicalSha256:intent.canonicalSha256, requestHash:intent.requestHash, createdAt:intent.createdAt, stage, ...(receipt?{messageId:receipt.id, acceptedAt:receipt.acceptedAt, ...(receipt.duplicate===undefined?{}:{duplicate:receipt.duplicate}), readBack:receipt.readBack}:{}), ...(publicUrl?{publicUrl}:{})}; }

function splitHttpLinks(value: string): string[] { const parts:string[]=[]; let start=0, quoted=false, angle=0, escaped=false; for(let index=0; index<value.length; index++){const char=value[index]; if(escaped){escaped=false;continue} if(quoted&&char==='\\'){escaped=true;continue} if(char==='"'){quoted=!quoted;continue} if(!quoted&&char==='<')angle++; else if(!quoted&&char==='>')angle--; else if(!quoted&&angle===0&&char===','){parts.push(value.slice(start,index).trim());start=index+1} if(angle<0)throw Error('SwarmMemo Link header 无效')} if(quoted||angle!==0)throw Error('SwarmMemo Link header 无效');parts.push(value.slice(start).trim());return parts.filter(Boolean); }
function assertHttpCanonical(value:string|null,url:string){if(value===null)return;const result:string[]=[];for(const item of splitHttpLinks(value)){const target=item.match(/^<([^<>]+)>(.*)$/),relevant=/;\s*rel\s*=\s*(?:"[^"]*\bcanonical\b[^"]*"|[^;,\s]*\bcanonical\b[^;,\s]*)/i.test(item);if(!target){if(relevant)throw Error('SwarmMemo canonical Link header 无效');continue}const rels=[...target[2].matchAll(/;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/gi)].flatMap(match=>(match[1]??match[2]??'').toLowerCase().split(/\s+/));if(rels.includes('canonical'))result.push(new URL(target[1],url).href)}if(result.length>1||result.length===1&&result[0]!==url)throw Error('SwarmMemo HTTP canonical 冲突')}
function robotsAllows(text:string,path:string,agent:string){type Group={agents:string[];rules:{allow:boolean;pattern:string}[]};const groups:Group[]=[];let group:Group={agents:[],rules:[]};const push=()=>{if(group.agents.length)groups.push(group);group={agents:[],rules:[]}};for(const raw of text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/)){const line=raw.replace(/#.*$/,'').trim();if(!line)continue;const match=line.match(/^([^:]+):\s*(.*)$/);if(!match)return false;const key=match[1].trim().toLowerCase(),value=match[2].trim();if(key==='user-agent'){if(!/^(?:\*|[a-z0-9_-]+)$/i.test(value))return false;if(group.rules.length)push();group.agents.push(value.toLowerCase())}else if(key==='allow'||key==='disallow'){if(!group.agents.length)return false;if(value)group.rules.push({allow:key==='allow',pattern:value})}}push();const matched=groups.map(value=>({value,score:Math.max(...value.agents.map(item=>item==='*'?0:agent.startsWith(item)?item.length:-1))})).filter(value=>value.score>=0);if(!matched.length)return true;const score=Math.max(...matched.map(value=>value.score));let winner:{allow:boolean;specificity:number}|undefined;for(const rule of matched.filter(value=>value.score===score).flatMap(value=>value.value.rules)){const anchored=rule.pattern.endsWith('$'),source=rule.pattern.replace(/\$$/,'').split('*').map(value=>value.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*');let hit=false;try{hit=new RegExp(`^${source}${anchored?'$':''}`).test(path)}catch{return false}if(!hit)continue;const next={allow:rule.allow,specificity:Buffer.byteLength(rule.pattern.replace(/\*|\$$/g,''))};if(!winner||next.specificity>winner.specificity||next.specificity===winner.specificity&&next.allow)winner=next}return winner?.allow!==false}
const restricted=(values:string[])=>/(?:^|[,\s])(noindex|none)(?:$|[,\s])/i.test(values.join(','));
function exactPublicUrl(value:string,id:string){try{const url=new URL(value);return url.origin===SWARMMEMO_ORIGIN&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&new RegExp(`^/e/${id}/[a-z0-9][a-z0-9-]{0,127}$`).test(url.pathname)?url.href:undefined}catch{return}}

// The platform appends one plain hostname badge immediately after each link.
// Strip only that exact decoration for semantic comparison; native visibility
// and the original Markdown/API/signature checks still inspect the raw content.
function withoutHostBadges(html:string){
  const $=load(html),anchors=new Set<unknown>();
  for(const node of $('.memo-text.md.article-body bdi.md-host').toArray()){
    let previous=node.prev;while(previous?.type==='text'&&!previous.data.trim())previous=previous.prev;
    if(node.type!=='tag'||Object.keys(node.attribs).sort().join(',')!=='class,dir'||node.attribs.class!=='md-host'||node.attribs.dir!=='ltr'||node.children.length!==1||node.children[0].type!=='text'||!previous||previous.type!=='tag'||previous.name!=='a'||anchors.has(previous))throw Error('SwarmMemo 平台域名标注无效');
    let link:URL;try{link=new URL(previous.attribs.href)}catch{throw Error('SwarmMemo 平台域名标注链接无效')}
    if(!['https:','http:'].includes(link.protocol)||link.username||link.password||node.children[0].data!==link.hostname)throw Error('SwarmMemo 平台域名标注不匹配');
    anchors.add(previous);$(node).remove();
  }
  return $.html();
}

async function acceptPublication(intent:SwarmMemoPublicationIntent,receipt:SwarmMemoReceipt,identity:SwarmMemoTaskIdentity,deps:SwarmMemoDependencies):Promise<{evidence:SwarmMemoAcceptanceEvidence;publicUrl:string;rel:string}>{
  if(receipt.id.length!==32||receipt.sha256!==intent.bodySha256||receipt.requestId!==intent.requestId||receipt.canonicalSha256!==intent.canonicalSha256||receipt.readBack!==swarmMemoEntryJsonUrl(receipt.id))throw Error('SwarmMemo 回执与固定意图不一致');
  const message=parseSwarmMemoEntry(await readSwarmMemoJson(receipt.readBack,deps));if(!message||message.id!==receipt.id||message.createdAt!==receipt.acceptedAt||!matchesSwarmMemoMessage(message,intent))throw Error('SwarmMemo API 原文或签名不匹配');
  const baseUrl=swarmMemoEntryBaseUrl(receipt.id),page=await readSwarmMemoText(baseUrl,'text/html',deps),$=load(page.text),canonicals=$('link[rel]').toArray().filter(element=>($(element).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical')).map(element=>new URL($(element).attr('href')??'',page.url).href);const publicUrl=exactPublicUrl(page.url===baseUrl&&canonicals.length===1?canonicals[0]:page.url,receipt.id);if(!publicUrl||canonicals.length!==1||canonicals[0]!==publicUrl)throw Error('SwarmMemo HTML canonical 不匹配');assertHttpCanonical(page.headers.get('link'),publicUrl);if(restricted([page.headers.get('x-robots-tag')??'',...$('meta[name="robots"],meta[name="googlebot"],meta[name="bingbot"]').toArray().map(element=>$(element).attr('content')??'')]))throw Error('SwarmMemo SSR 禁止索引');
  const raw=$('details.memo-raw pre');if(raw.length!==1||raw.text()!==identity.body)throw Error('SwarmMemo SSR 原稿不匹配');const staticCheck=inspectRenderedArticle(withoutHostBadges(page.text),identity.body,identity.targetUrl,'.memo-text.md.article-body',{title:identity.title,pageUrl:publicUrl,robotsHeader:page.headers.get('x-robots-tag')??''});if(!staticCheck.found)throw Error(`SwarmMemo SSR 渲染正文不匹配: ${staticCheck.reason}`);
  if(!deps.renderPage)throw Error('SwarmMemo 原生渲染验收未就绪');const native=await deps.renderPage(publicUrl,deps.signal??new AbortController().signal);if(native.url!==publicUrl||native.responseStatus!==200||native.responseMediaType!=='text/html'||native.canonicals.length!==1||native.canonicals[0]!==publicUrl||native.hasRefresh||native.hasPasswordGate||native.hasLoginGate)throw Error('SwarmMemo 原生页面基本结构不匹配');assertHttpCanonical(native.responseLinks.join(','),publicUrl);if(restricted([...native.responseRobots,...native.robots.map(value=>value.content)]))throw Error('SwarmMemo 原生页面禁止索引');const body=native.candidates.find(value=>value.selector==='.memo-text.md.article-body'),rawNative=native.candidates.find(value=>value.selector==='details.memo-raw > pre');if(native.candidates.length!==2||!body||!rawNative||rawNative.text!==identity.body||!body.allTextVisible)throw Error('SwarmMemo 原生正文不可见或原稿不匹配');const nativeCheck=inspectRenderedArticle(withoutHostBadges(body.html),identity.body,identity.targetUrl,'.memo-text.md.article-body',{title:identity.title,pageUrl:publicUrl,robotsHeader:native.responseRobots.join(',')});if(!nativeCheck.found)throw Error(`SwarmMemo 原生渲染正文不匹配: ${nativeCheck.reason}`);const target=body.links.filter(link=>link.visible&&link.href===identity.targetUrl);if(target.length!==1||!['nofollow','ugc','noopener','noreferrer'].every(rel=>target[0].rel.map(value=>value.toLowerCase()).includes(rel)))throw Error('SwarmMemo 原生目标链接属性不匹配');if(native.nativeRequests.filter(value=>value.resourceType==='mainFrame').length!==1||native.nativeRequests.filter(value=>value.resourceType==='stylesheet').length>8)throw Error('SwarmMemo 原生网络边界无效');const robots=await readSwarmMemoText(SWARMMEMO_ROBOTS_URL,'text/plain',deps),path=new URL(publicUrl).pathname;if(!['*','googlebot','bingbot'].every(agent=>robotsAllows(robots.text,path,agent)))throw Error('SwarmMemo robots 阻止公开页');return {evidence:{apiMatched:true,rendered:true,nativeTarget:true,robotsAllowed:true,pageIndexable:true,checkedAt:(deps.now?.()??new Date()).toISOString()},publicUrl,rel:target[0].rel.join(' ')};
}

export async function prepareSwarmMemoIdentity(context:ExecutionContext,deps:SwarmMemoDependencies=context.swarmMemoDependencies??{}):Promise<ExecutionResult|undefined>{if(!matches(context))return {status:'needs_input',message:'当前任务不属于 SwarmMemo'};const value=await readyIdentity(context,deps);return 'account' in value?undefined:value}

export async function runSwarmMemoTask(context:ExecutionContext,deps:SwarmMemoDependencies=context.swarmMemoDependencies??{}):Promise<ExecutionResult>{
  if(!matches(context))return {status:'needs_input',message:'当前渠道规格不支持 SwarmMemo'};const identity=swarmMemoTaskIdentity(context.task,context.site);if(!identity)return {status:'needs_input',message:'SwarmMemo 需要绑定当前任务已审核的完整 Markdown 与目标链接'};const access=await readyIdentity(context,deps);if(!('account' in access))return access;if(access.account.id!==context.task.accountId||!validSwarmMemoAccount(access.account))return {status:'needs_input',message:'SwarmMemo 同一本地 Ed25519 身份尚未安全绑定'};if(!context.swarmMemoPersistence)return {status:'needs_input',message:'SwarmMemo Store/Vault 持久化边界未就绪'};
  const saved=context.task.swarmMemo,createdAt=saved?.createdAt??(deps.now?.()??new Date()).toISOString(),operationId=saved?.operationId??operation(context.task.id);if(!OPERATION.test(operationId))return {status:'needs_input',message:'SwarmMemo 任务 operation 无效'};const requestId=operationId.slice('swarmmemo_post_'.length),nonce=swarmMemoHash(`swarmmemo-nonce\n${context.task.id}\n${access.secret.fingerprint}\n${identity.bodySha256}`).slice(0,32),built=createSwarmMemoCommand({text:identity.body,requestId,timestamp:Math.floor(Date.parse(createdAt)/1000),nonce,identity:access.secret}),intent:SwarmMemoPublicationIntent={version:1,kind:'swarmmemo_publication',operationId,accountId:access.account.id,fingerprint:access.secret.fingerprint,requestId,targetUrl:identity.targetUrl,sourceHash:built.sourceHash,bodySha256:identity.bodySha256,canonicalSha256:built.canonicalSha256,requestHash:built.requestHash,createdAt,command:built.command,dispatchBudget:1};if(!validSwarmMemoPublicationIntent(intent))return {status:'needs_input',message:'SwarmMemo 签名意图无效'};if(saved){const rebuilt=intentFromReceipt(saved,built.command);if(!sameIntent(intent,rebuilt))return {status:'needs_input',message:'SwarmMemo 原发布意图与当前审核稿或身份不一致'}}
  let secret=await context.swarmMemoPersistence.loadSecret();if(!secret){await context.swarmMemoPersistence.persistIntent(intent);secret={version:1,kind:'swarmmemo_publication_secret',intent}}else if(!sameIntent(secret.intent,intent))return {status:'needs_input',message:'SwarmMemo 加密 publication 意图与当前审核稿不一致'};
  if(!secret.dispatchedAt){await context.swarmMemoPersistence.armDispatch(intent);try{secret=(await context.swarmMemoPersistence.loadSecret())??secret}catch{return {status:'review',message:'SwarmMemo 加密身份或发布意图在发送前已改变；未发出 POST，且不会自动重试。',submittedAt:createdAt,checkpoint:'swarmmemo_submitting',swarmMemo:taskReceipt(intent,'submitting')}}if(!secret.dispatchedAt)return {status:'review',message:'SwarmMemo 单次写入预算未能持久化；未发出请求。',submittedAt:createdAt,checkpoint:'swarmmemo_intent',swarmMemo:taskReceipt(intent,'intent')};const result=await swarmMemoMutation({method:'POST',headers:{accept:'application/json','content-type':'application/json'},body:swarmMemoCommandBody(intent.command)},async opaque=>{await context.swarmMemoPersistence!.persistOpaqueResponse(intent,opaque);secret={...secret!,opaqueResponse:opaque}},()=>context.swarmMemoPersistence!.assertAuthorized(intent),{...deps,signal:context.signal});if(result==='not_authorized')return {status:'review',message:'SwarmMemo 意图已加密保留，但最后授权已取消；未发出 POST，且不会自动重试。',submittedAt:createdAt,checkpoint:'swarmmemo_submitting',swarmMemo:taskReceipt(intent,'submitting')};if(result==='unknown')return {status:'review',message:'SwarmMemo 单次 POST 结果不明；身份、审核稿、签名和预算已保留，后续只读恢复。',submittedAt:createdAt,checkpoint:'swarmmemo_submitting',swarmMemo:taskReceipt(intent,'submitting')};}
  const receipt=secret.opaqueResponse?parseSwarmMemoReceipt(parseSwarmMemoOpaque(secret.opaqueResponse),intent):undefined;if(!receipt){const stage=secret.opaqueResponse?'opaque_response':'submitting';return {status:'review',message:'SwarmMemo 单次 POST 结果不明或回执无法严格绑定；不会重放，等待只读恢复或独立复核。',submittedAt:createdAt,checkpoint:stage==='opaque_response'?'swarmmemo_opaque_response':'swarmmemo_submitting',swarmMemo:taskReceipt(intent,stage)}};
  let publicUrl=saved?.publicUrl;await context.swarmMemoPersistence.preserveReceipt(intent,receipt,publicUrl);try{const accepted=await acceptPublication(intent,receipt,identity,{...deps,signal:context.signal});publicUrl=accepted.publicUrl;await context.swarmMemoPersistence.preserveReceipt(intent,receipt,publicUrl);await context.swarmMemoPersistence.promotePublished(intent,receipt,publicUrl,accepted.evidence);return {status:'live',message:'SwarmMemo API、签名、公开 HTML、原生可见全文、目标链接、canonical 和 robots 已核对；不代表搜索收录或永久可用。',publicUrl,linkRel:accepted.rel,submittedAt:createdAt,checkpoint:'swarmmemo_published',swarmMemo:taskReceipt(intent,'published',receipt,publicUrl)}}catch{return {status:'review',message:'SwarmMemo 原回执已加密保留；公开原文、目标链接或抓取条件尚未完成原生验收。',publicUrl,submittedAt:createdAt,checkpoint:'swarmmemo_api_receipt',swarmMemo:taskReceipt(intent,'api_receipt',receipt,publicUrl)}}
}

export async function reconcileSwarmMemoTask(context:ExecutionContext,deps:SwarmMemoDependencies=context.swarmMemoDependencies??{}):Promise<{status:'found';publicUrl:string;swarmMemo:SwarmMemoTaskReceipt;rel:string}|{status:'unknown'}>{try{const identity=swarmMemoTaskIdentity(context.task,context.site),saved=context.task.swarmMemo,account=context.getAccount();if(!matches(context)||!identity||!saved||!account||!validSwarmMemoAccount(account)||account.id!==saved.accountId||!context.swarmMemoPersistence)return {status:'unknown'};const access=identitySecret(await context.secrets.get(`account:${account.id}`)),secret=await context.swarmMemoPersistence.loadSecret();if(!access||!secret||!sameIntent(secret.intent,intentFromReceipt(saved,secret.intent.command)))return {status:'unknown'};const receipt=secret.opaqueResponse?parseSwarmMemoReceipt(parseSwarmMemoOpaque(secret.opaqueResponse),secret.intent):secret.dispatchedAt?await recoverSwarmMemoReceipt(secret.intent,{...deps,signal:context.signal}):undefined;if(!receipt)return {status:'unknown'};const accepted=await acceptPublication(secret.intent,receipt,identity,{...deps,signal:context.signal});await context.swarmMemoPersistence.preserveReceipt(secret.intent,receipt,accepted.publicUrl);await context.swarmMemoPersistence.promotePublished(secret.intent,receipt,accepted.publicUrl,accepted.evidence);return {status:'found',publicUrl:accepted.publicUrl,swarmMemo:taskReceipt(secret.intent,'published',receipt,accepted.publicUrl),rel:accepted.rel}}catch{return {status:'unknown'}}}
export async function verifySwarmMemoPublication(context:ExecutionContext,deps:SwarmMemoDependencies=context.swarmMemoDependencies??{}):Promise<LinkResult>{const identity=swarmMemoTaskIdentity(context.task,context.site),saved=context.task.swarmMemo,account=context.getAccount(),url=context.task.publicUrl??SWARMMEMO_ORIGIN;if(!identity||!saved?.messageId||saved.acceptedAt===undefined||!saved.readBack||saved.stage!=='published'||!account||!validSwarmMemoAccount(account)||!context.swarmMemoPersistence)return {found:false,outcome:'invalid',url,rel:'unknown',reason:'SwarmMemo 任务缺少原身份、审核稿或发布回执'};try{const secret=await context.swarmMemoPersistence.loadSecret();if(!secret)throw Error('secret missing');const receipt:SwarmMemoReceipt|undefined=secret.opaqueResponse?parseSwarmMemoReceipt(parseSwarmMemoOpaque(secret.opaqueResponse),secret.intent):secret.dispatchedAt?{id:saved.messageId,sha256:saved.bodySha256,cursor:'get-only-recovery',...(saved.duplicate===undefined?{}:{duplicate:saved.duplicate}),acceptedAt:saved.acceptedAt,requestId:saved.requestId,readBack:saved.readBack,visibility:'public',canonicalSha256:saved.canonicalSha256}:undefined;if(!receipt)throw Error('receipt missing');const accepted=await acceptPublication(secret.intent,receipt,identity,{...deps,signal:context.signal});if(accepted.publicUrl!==saved.publicUrl)throw Error('url changed');return {found:true,outcome:'found',url:accepted.publicUrl,rel:accepted.rel,reason:'SwarmMemo 原签名、完整公开正文与目标链接仍一致'}}catch{return {found:false,outcome:'unreachable',url,rel:'unknown',reason:'SwarmMemo 原页面尚未重新通过只读验收'}}}

export const swarmMemoPublisherTesting={withoutHostBadges,acceptPublication,assertHttpCanonical,exactPublicUrl,markdownLinks,robotsAllows,splitHttpLinks};
