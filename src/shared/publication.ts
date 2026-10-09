import type {CapacityBlockReason,Channel,Site,SiteTopic,Task} from './types';
import {isArticleTopicUrl} from './topic-policy';

const REPEATABLE_ARTICLE_CHANNELS=new Set(['telegraph','github-gist','blogger','wordpress-com','leaflet','bluesky','paragraph','nostr','paper-wf','hive','mataroa','verbose','prose','rentry','lucid-page','betterthanhtml','supanote']);
function deterministicPostSlug(taskId:string,contentHash:string):string{
  return `lf-${taskId.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,32)}-${contentHash.slice(0,12)}`;
}
export function verbosePostSlug(taskId:string,contentHash:string):string{
  return deterministicPostSlug(taskId,contentHash);
}
export function rentryPostSlug(taskId:string,contentHash:string):string{
  return deterministicPostSlug(taskId,contentHash);
}
export const PUBLICATION_GAP_MS=10*24*60*60*1000;
const TRACKING_PARAMETER=/^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid)$/i;

export interface PublicationCounts {
  currentPages:number;
  monthlyPages:number;
  currentSources:number;
  monthlySources:number;
}

export interface PublicationOpportunity {
  allowed:boolean;
  repeat:boolean;
  topicUrl?:string;
  scheduledAt?:string;
  blockingReason?:CapacityBlockReason;
  nextAvailableAt?:string;
  reason:string;
}

export interface PublicationOpportunityContext {
  /** The current site/channel binding has a usable official API credential. */
  officialApiConnected?:boolean;
}

export function sourceKey(value:string):string{
  return value.trim().toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
}

/** Normalize a real public page URL without manufacturing a page for legacy records. */
export function canonicalPublicPageUrl(value:string|undefined):string|undefined{
  if(!value)return;
  try{
    const url=new URL(value.trim());
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
    url.protocol=url.protocol.toLowerCase();
    url.hostname=url.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
    if((url.protocol==='https:'&&url.port==='443')||(url.protocol==='http:'&&url.port==='80'))url.port='';
    url.hash='';
    for(const key of [...url.searchParams.keys()])if(TRACKING_PARAMETER.test(key))url.searchParams.delete(key);
    url.searchParams.sort();
    if(url.pathname.length>1)url.pathname=url.pathname.replace(/\/+$/,'');
    return url.href;
  }catch{return undefined}
}

/** Soft preference only: a locale-prefixed path outranks script inference, but never changes eligibility. */
export function articleTopicLanguageScore(topic:SiteTopic,language:string):number{
  let path='',first='';try{path=decodeURIComponent(new URL(topic.url).pathname);first=path.split('/').filter(Boolean)[0]?.toLowerCase()??''}catch{path=topic.url}
  const normalized=language.toLowerCase().replace(/_/g,'-'),root=normalized.split('-')[0];
  if(first&&first===normalized)return 4;
  if(first&&(first===root||first.startsWith(root+'-')))return 3;
  const sample=`${topic.title??''} ${path}`;
  if(root==='zh')return /[\u3400-\u9fff]/u.test(sample)?2:0;
  if(root==='ja')return /[\u3040-\u30ff]/u.test(sample)?2:0;
  if(root==='ko')return /[\uac00-\ud7af]/u.test(sample)?2:0;
  if(['ru','uk','bg'].includes(root))return /[\u0400-\u04ff]/u.test(sample)?2:0;
  return /[a-z]/i.test(sample)?1:0;
}

function validDate(value:string|undefined):Date|undefined{
  if(!value)return;
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date:undefined;
}

function dateParts(value:Date,timeZone:string):{year:number;month:number;day:number;hour:number;minute:number;second:number}{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value);
  const part=(kind:Intl.DateTimeFormatPartTypes)=>Number(parts.find(item=>item.type===kind)?.value??0);
  return {year:part('year'),month:part('month'),day:part('day'),hour:part('hour'),minute:part('minute'),second:part('second')};
}

function zonedTime(year:number,month:number,day:number,timeZone:string):Date{
  const wanted=Date.UTC(year,month-1,day,0,0,0);
  let guess=wanted;
  for(let index=0;index<3;index++){
    const observed=dateParts(new Date(guess),timeZone);
    const represented=Date.UTC(observed.year,observed.month-1,observed.day,observed.hour,observed.minute,observed.second);
    guess+=wanted-represented;
  }
  return new Date(guess);
}

export function nextNaturalMonthStart(now:Date,timeZone:string):Date{
  const {year,month}=dateParts(now,timeZone);
  return month===12?zonedTime(year+1,1,1,timeZone):zonedTime(year,month+1,1,timeZone);
}

function localMonthKey(value:Date|string,timeZone:string):string{
  const {year,month}=dateParts(new Date(value),timeZone);
  return `${year}-${String(month).padStart(2,'0')}`;
}

function isCountablePublication(task:Task):boolean{
  return task.checkpoint!=='existing_link'&&!!canonicalPublicPageUrl(task.publicUrl);
}

function isCurrentPublication(task:Task):boolean{
  return isCountablePublication(task)&&task.status==='live'&&task.health==='healthy'&&task.linkCheck==='found';
}

export function publicationCounts(siteId:string,tasks:Task[],now:Date,timeZone:string):PublicationCounts{
  const month=localMonthKey(now,timeZone),excluded=new Set<string>();
  for(const task of tasks){
    const page=task.siteId===siteId?canonicalPublicPageUrl(task.publicUrl):undefined;
    if(page&&task.checkpoint==='existing_link')excluded.add(page);
  }
  const pages=new Map<string,{earliest?:Date;monthlySource?:string;latestEvidence:number;currentSource?:string}>();
  for(const [index,task] of tasks.entries()){
    if(task.siteId!==siteId)continue;
    const page=canonicalPublicPageUrl(task.publicUrl);
    if(!page||task.checkpoint==='existing_link'||excluded.has(page))continue;
    const source=sourceKey(task.sourceDomain);
    const record=pages.get(page)??{latestEvidence:Number.NEGATIVE_INFINITY};
    const firstLive=validDate(task.firstLiveAt);
    if(firstLive&&(!record.earliest||firstLive.getTime()<record.earliest.getTime())){record.earliest=firstLive;record.monthlySource=source;}
    const evidence=validDate(task.lastCheckedAt)??validDate(task.verifiedAt)??validDate(task.updatedAt)??firstLive??validDate(task.createdAt);
    const evidenceOrder=evidence?.getTime()??Number.MIN_SAFE_INTEGER+index;
    if(evidenceOrder>=record.latestEvidence){record.latestEvidence=evidenceOrder;record.currentSource=isCurrentPublication(task)?source:undefined;}
    pages.set(page,record);
  }
  const current=[...pages.values()].filter(record=>record.currentSource),monthly=[...pages.values()].filter(record=>record.earliest&&localMonthKey(record.earliest,timeZone)===month);
  return {
    currentPages:current.length,
    monthlyPages:monthly.length,
    currentSources:new Set(current.map(record=>record.currentSource!)).size,
    monthlySources:new Set(monthly.map(record=>record.monthlySource!)).size,
  };
}

/** Public short posts are transparent distribution results, never labelled complete articles. */
export function publicationFormatCounts(siteId:string,tasks:Task[],now:Date,timeZone:string){
  const social=tasks.filter(task=>task.channelId==='bluesky'),other=tasks.filter(task=>task.channelId!=='bluesky');
  return {social:publicationCounts(siteId,social,now,timeZone),articlesAndProfiles:publicationCounts(siteId,other,now,timeZone)};
}

export function sourceMetrics(siteId:string,tasks:Task[],now:Date,timeZone:string):Pick<PublicationCounts,'currentSources'|'monthlySources'>{
  const {currentSources,monthlySources}=publicationCounts(siteId,tasks,now,timeZone);
  return {currentSources,monthlySources};
}

/** Failed/skipped work without submission evidence releases source capacity. */
export function taskOccupiesSource(task:Task):boolean{
  if(task.checkpoint==='existing_link')return true;
  return taskReservesTopic(task);
}

export function isRepeatableOfficialArticleChannel(channel:Channel):boolean{
  return channel.provenance==='built-in'&&channel.automation==='api'&&(channel.kind==='article'||channel.contentFormat==='social')&&channel.articleRequired===true&&REPEATABLE_ARTICLE_CHANNELS.has(channel.id);
}

function taskReservesTopic(task:Task):boolean{
  return !!(task.firstLiveAt||(hasUnresolvedExternalAttempt(task)&&!isPendingPublisherRegistration(task))||!['failed','skipped'].includes(task.status));
}

/** Registration uncertainty stays pinned, but is not an attempted article publication. */
export function isPendingPublisherRegistration(task:Task):boolean{
  const checkpoint=task.channelId==='paper-wf'?'paper_account_create_pending':task.channelId==='mataroa'?'mataroa_account_create_pending':task.channelId==='verbose'?'verbose_account_create_pending':undefined;
  return !!checkpoint&&task.checkpoint===checkpoint&&!!task.accountId&&
    !task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&!task.blogger&&!task.leaflet&&!task.wordpress&&!task.bluesky&&!task.paragraph&&!task.nostr&&!task.paper&&!task.hive&&!task.mataroa&&!task.verbose&&!task.prose&&!task.rentry&&!task.lucid&&!task.betterthanhtml&&!task.supanote;
}

function topicCandidates(site:Site,tasks:Task[]):{known:boolean;available:string[];invalid:boolean}{
  const known=Array.isArray(site.topics);
  if(!known)return {known:false,available:[],invalid:false};
  const used=new Set(tasks.filter(task=>task.siteId===site.id&&task.topicUrl&&taskReservesTopic(task)).map(task=>canonicalPublicPageUrl(task.topicUrl)).filter((value):value is string=>!!value));
  for(const task of tasks.filter(task=>task.siteId===site.id))for(const attempt of task.articleAttempts??[]){const canonical=canonicalPublicPageUrl(attempt.topicUrl);if(canonical)used.add(canonical)}
  const unique=new Map<string,{url:string;updated:number;index:number;language:number}>();
  let valid=0;
  for(const [index,topic] of (site.topics??[]).entries()){
    const canonical=canonicalPublicPageUrl(topic.url);
    const modified=validDate(topic.lastModified)?.getTime()??validDate(topic.discoveredAt)?.getTime()??0;
    if(canonical&&isArticleTopicUrl(canonical,site)){valid++;if(!used.has(canonical)&&!unique.has(canonical))unique.set(canonical,{url:canonical,updated:modified,index,language:articleTopicLanguageScore(topic,site.language)})}
  }
  return {known:true,available:[...unique.values()].sort((a,b)=>b.language-a.language||b.updated-a.updated||a.index-b.index).map(topic=>topic.url),invalid:(site.topics?.length??0)>0&&valid===0};
}

function originalTaskCanRecover(task:Task):boolean{
  return task.recoveryEligible===true&&task.status==='failed'&&task.checkpoint==='system_wait'&&
    !!validDate(task.nextCheckAt)&&(task.recoveryAttempts??0)<1&&(task.cost?.aiCalls??0)<6;
}

function hasUnresolvedExternalAttempt(task:Task):boolean{
  return !!task.blogger||!!task.bluesky||!!task.leaflet||!!task.paragraph||!!task.nostr||!!task.wordpress||!!task.paper||!!task.hive||!!task.mataroa||!!task.verbose||!!task.prose||!!task.rentry||!!task.lucid||!!task.betterthanhtml||!!task.supanote||!!task.submittedAt||!!canonicalPublicPageUrl(task.publicUrl)||['paper_account_create_pending','mataroa_account_create_pending','verbose_account_create_pending'].includes(task.checkpoint??'')||/(?:submitt|publish|uncertain|registration)/i.test(task.checkpoint??'');
}

function terminalBlock(task:Task):PublicationOpportunity|undefined{
  if(task.checkpoint==='existing_link'||task.firstLiveAt)return;
  if(hasUnresolvedExternalAttempt(task))return {allowed:false,repeat:false,blockingReason:'cooldown',reason:'已有提交或公开结果尚未核清；为避免重复发布，不会建立替代任务。'};
  if(!['failed','skipped'].includes(task.status))return;
  if(originalTaskCanRecover(task))return {allowed:false,repeat:false,blockingReason:'cooldown',nextAvailableAt:validDate(task.nextCheckAt)!.toISOString(),reason:'原任务仍有一次明确预算内的恢复机会；到期只恢复原任务，不新建替代任务。'};
  const explicit:CapacityBlockReason|undefined=task.checkpoint==='topic_recovery_budget'?'budget_exhausted':task.checkpoint==='invalid_topic'?'invalid_topic':task.checkpoint==='article_rejected'?'article_rejected':undefined;
  const budget=(task.cost?.aiCalls??0)>=6||(task.recoveryAttempts??0)>=1||(task.checkpoint==='budget_or_duplicate'&&/预算/.test(task.message))||/\b(?:budget|quota)\b|额度|上限|不会重复付费/i.test(`${task.message} ${task.articleReview?.reason??''}`);
  const reason:CapacityBlockReason=explicit??(budget?'budget_exhausted':task.articleReview?.reasonCode==='content_rejected'?'article_rejected':'cooldown');
  const message=reason==='budget_exhausted'?'已有未提交任务达到自动处理或付费上限，不会新建任务绕过。':reason==='invalid_topic'?'缓存选题不是可用正文页面，且没有尚未尝试的有效备用选题。':reason==='article_rejected'?'稿件未通过独立核对，且同一任务内的一次备用选题机会不可用或已用完。':'已有未提交的终止记录；没有明确恢复元数据时不会按旧复查日期承诺重试。';
  return {allowed:false,repeat:false,blockingReason:reason,reason:message};
}

function activeBlock(task:Task,now:Date):PublicationOpportunity|undefined{
  if(task.firstLiveAt||['failed','skipped','expired'].includes(task.status))return;
  if(task.checkpoint==='account_handoff')return {allowed:false,repeat:false,blockingReason:'account_required',reason:'\u5df2\u6709\u8d26\u53f7\u63a5\u7eed\u8bb0\u5f55\uff0c\u4e0d\u4f1a\u91cd\u590d\u5efa\u7acb\u540c\u6e20\u9053\u7b49\u5f85\u4efb\u52a1\u3002'};
  const next=validDate(task.scheduledAt);
  const future=next&&next.getTime()>now.getTime()?next:undefined;
  return {allowed:false,repeat:false,blockingReason:future?'cadence_wait':'cooldown',...(future?{nextAvailableAt:future.toISOString()}:{}),reason:'\u540c\u4e00\u5e73\u53f0\u5df2\u6709\u4e00\u4e2a\u672a\u5b8c\u6210\u4efb\u52a1\uff0c\u5b8c\u6210\u6216\u660e\u786e\u7ec8\u6b62\u524d\u4e0d\u91cd\u590d\u5efa\u7acb\u3002'};
}

interface PublicationEvent {at:Date;page?:string}
function publicationEvents(tasks:Task[]):PublicationEvent[]{
  const pages=new Map<string,Date>(),unknown:PublicationEvent[]=[];
  for(const task of tasks){
    if(task.checkpoint==='existing_link')continue;
    const at=validDate(task.firstLiveAt);if(!at)continue;
    const page=canonicalPublicPageUrl(task.publicUrl);
    if(!page){unknown.push({at});continue}
    const previous=pages.get(page);if(!previous||at.getTime()<previous.getTime())pages.set(page,at);
  }
  const known=[...pages.entries()].map<PublicationEvent>(([page,at])=>({page,at}));
  return [...known,...unknown];
}

/** Successful publication dates, de-duplicated by real page URL at its first live time. */
export function publicationDates(tasks:Task[]):Date[]{
  return publicationEvents(tasks).map(event=>new Date(event.at));
}

/**
 * Decide whether one channel may receive a new task. Both automatic planning and
 * the explicit queue command must use this function so historical tasks have one policy.
 */
export function publicationOpportunity(site:Site,channel:Channel,tasks:Task[],now:Date,timeZone:string,context:PublicationOpportunityContext={}):PublicationOpportunity{
  if(!channel.enabled||channel.free==='paid'||channel.free==='unknown')return {allowed:false,repeat:false,blockingReason:'no_automatic_channel',reason:'\u8be5\u6e20\u9053\u5f53\u524d\u4e0d\u7b26\u5408\u53ef\u7528\u7684\u514d\u8d39\u6267\u884c\u6761\u4ef6\u3002'};
  const related=tasks.filter(task=>task.siteId===site.id),sameChannel=related.filter(task=>task.channelId===channel.id),sameSource=related.filter(task=>sourceKey(task.sourceDomain)===sourceKey(channel.domain));
  const repeatable=isRepeatableOfficialArticleChannel(channel),events=publicationEvents(sameChannel);
  const latestSuccess=events.map(event=>event.at.getTime()).sort((a,b)=>b-a)[0];
  const relevantSameChannel=sameChannel.filter(task=>{
    if(task.firstLiveAt||hasUnresolvedExternalAttempt(task)||!['failed','skipped'].includes(task.status)||latestSuccess===undefined)return true;
    const activity=validDate(task.submittedAt)??validDate(task.createdAt);
    return !!activity&&activity.getTime()>latestSuccess;
  });

  const terminalBlocks=relevantSameChannel.map(terminalBlock).filter((block):block is PublicationOpportunity=>!!block);
  const terminal=terminalBlocks.find(block=>block.blockingReason==='budget_exhausted')
    ??terminalBlocks.find(block=>!block.nextAvailableAt)
    ??terminalBlocks[0];
  if(terminal)return {...terminal,repeat:false};
  for(const task of relevantSameChannel){const block=activeBlock(task,now);if(block)return {...block,repeat:false};}

  if(!repeatable){
    if(sameSource.some(task=>taskOccupiesSource(task)))return {allowed:false,repeat:false,reason:'\u8d44\u6599\u9875\u548c\u76ee\u5f55\u6765\u6e90\u53ea\u5efa\u7acb\u4e00\u6b21\uff0c\u8bf7\u7ee7\u7eed\u67e5\u770b\u539f\u8bb0\u5f55\u3002'};
    const released=sameSource.find(task=>['failed','skipped'].includes(task.status));
    if(released){const block=terminalBlock(released);if(block)return block;}
    return {allowed:true,repeat:false,scheduledAt:now.toISOString(),reason:'\u8be5\u6765\u6e90\u5c1a\u672a\u5efa\u7acb\u53ef\u6267\u884c\u8bb0\u5f55\u3002'};
  }

  const repeat=events.length>0||sameChannel.some(task=>taskOccupiesSource(task));
  if(repeat&&context.officialApiConnected!==true)return {allowed:false,repeat:true,blockingReason:'account_required',reason:'同平台再次发布只允许使用当前已连接的官方文章接口账号。'};
  const topics=topicCandidates(site,related);
  let topicUrl:string|undefined;
  let topicBlock:PublicationOpportunity|undefined;
  if(topics.available.length)topicUrl=topics.available[0];
  else topicBlock={allowed:false,repeat,blockingReason:topics.invalid?'invalid_topic':topics.known?'topics_exhausted':'topics_unknown',reason:topics.invalid?'已缓存的页面都不是可用的文章选题正文，未建立需要付费生成的任务。':topics.known?'\u6ca1\u6709\u5c1a\u672a\u7528\u4e8e\u5176\u4ed6\u53d1\u5e03\u4efb\u52a1\u7684\u771f\u5b9e\u4e3b\u9898\u9875\u3002':'\u5c1a\u672a\u83b7\u5f97\u53ef\u53bb\u91cd\u7684\u771f\u5b9e\u4e3b\u9898\u9875\uff0c\u4e0d\u5efa\u7acb\u6587\u7ae0\u53d1\u5e03\u4efb\u52a1\u3002'};

  const month=localMonthKey(now,timeZone),eventsThisMonth=events.filter(event=>localMonthKey(event.at,timeZone)===month).length;
  const lastEvent=events.map(event=>event.at).sort((a,b)=>b.getTime()-a.getTime())[0];
  const cadenceAt=lastEvent?new Date(lastEvent.getTime()+PUBLICATION_GAP_MS):now;
  const nextMonth=nextNaturalMonthStart(now,timeZone);
  if(eventsThisMonth>=2){
    const next=new Date(Math.max(nextMonth.getTime(),cadenceAt.getTime()));
    return {allowed:false,repeat:true,blockingReason:'cadence_wait',nextAvailableAt:next.toISOString(),reason:'\u8be5\u5e73\u53f0\u672c\u81ea\u7136\u6708\u5df2\u8fbe 2 \u7bc7\u53d1\u5e03\u4e0a\u9650\u3002'};
  }
  const scheduledAt=new Date(Math.max(now.getTime(),cadenceAt.getTime()));
  if(scheduledAt.getTime()>=nextMonth.getTime())return {allowed:false,repeat:true,blockingReason:'cadence_wait',nextAvailableAt:scheduledAt.toISOString(),reason:'\u4e0b\u6b21\u7b26\u5408 10 \u5929\u95f4\u9694\u7684\u65f6\u95f4\u5df2\u8d85\u51fa\u672c\u81ea\u7136\u6708\uff0c\u672c\u6708\u4e0d\u518d\u5efa\u4efb\u52a1\u3002'};
  if(topicBlock)return topicBlock;
  return {allowed:true,repeat,topicUrl,scheduledAt:scheduledAt.toISOString(),reason:repeat?'\u5df2\u4e3a\u4e0d\u540c\u771f\u5b9e\u4e3b\u9898\u9875\u9884\u7559\u5e73\u53f0\u53d1\u5e03\u95f4\u9694\u3002':'\u5e73\u53f0\u9996\u4e2a\u4efb\u52a1\u53ef\u7acb\u5373\u5f00\u59cb\u3002'};
}

const publicationCheckpoints=new Set(['submitting','submitted','submission_uncertain','telegraph_publish_submitting','telegraph_publish_uncertain','telegraph_published','gist_published','wordpress_publish_submitting','wordpress_published','leaflet_create_submitting','leaflet_create_accepted','leaflet_published','paper_account_create_pending','paper_publish_submitting','paper_published','hive_publish_submitting','hive_published','mataroa_account_create_pending','mataroa_publish_submitting','mataroa_published','verbose_account_create_pending','verbose_publish_submitting','verbose_published','prose_publish_submitting','prose_published','rentry_publish_submitting','rentry_published','lucid_publish_submitting','lucid_published','betterthanhtml_publish_submitting','betterthanhtml_published','supanote_publish_submitting','supanote_api_receipt','supanote_published']);
export function reservesSlot(t:Task,now:Date){
  if(t.firstLiveAt)return false;
  if(t.status==='review')return !(t.reviewUntil&&new Date(t.reviewUntil)<=now);
  if(t.status==='needs_input')return !!t.submittedAt||!!t.publicUrl||publicationCheckpoints.has(t.checkpoint??'');
  return t.status==='queued'||t.status==='running';
}
/** A future-month reservation must not consume this month's target. Overdue queued work rolls into the current month under the same task id. */
export function reservesMonthlySlot(t:Task,now:Date,timeZone:string):boolean{
  if(!reservesSlot(t,now))return false;
  const value=t.submittedAt??t.scheduledAt,date=new Date(value);
  if(!Number.isFinite(date.getTime()))return false;
  if(t.status==='queued'&&date.getTime()<=now.getTime()&&localMonthKey(date,timeZone)!==localMonthKey(now,timeZone))return true;
  return localMonthKey(date,timeZone)===localMonthKey(now,timeZone);
}

/** A positively identified remote draft may resume the same post after review. */
export function hasBloggerDraftReceipt(task:Task):boolean{return task.channelId==='blogger'&&!!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&task.blogger?.stage==='draft'&&!!task.blogger.postId}

/** A confirmed remote draft can continue only under its original publication identity. */
export function hasRecoverablePublisherDraftReceipt(task:Task):boolean{
  return hasBloggerDraftReceipt(task)||task.channelId==='paragraph'&&!!task.submittedAt&&!task.publicUrl&&!task.firstLiveAt&&task.paragraph?.stage==='draft'&&!!task.paragraph.postId;
}
