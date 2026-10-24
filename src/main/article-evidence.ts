import {createHash} from 'node:crypto';
import type {Channel,Site,Task} from '../shared/types';
import {stripWritingEnvelope} from '../shared/writing-profile';
import {canonicalPublicPageUrl} from '../shared/publication';
import {containsForbiddenSiteTerm,siteAllowsLinkTarget} from '../shared/site-content';
import {containsReferralInformation,siteReferralCodes} from '../shared/referral-policy';
import {SITE_ACTION_MESSAGES} from '../shared/site-action-messages';
import {AI_REVIEW_MESSAGES} from '../shared/ai-review-messages';
import {createBerrryInput} from '../integrations/berrry-publisher';
import {txtsbsTaskIdentity} from './txtsbs-publication';
import {plopinoTaskIdentity} from './plopino-publication';
import {vibeDropTaskIdentity} from './vibedrop-publication';
import {hereNowTaskIdentity} from './here-now-publication';
import {shiplyTaskIdentity} from './shiply-publication';

export const ARTICLE_EVIDENCE_LIMITS={totalCharacters:28_000,channelSummaryCharacters:600,maxFacts:80,maxPatches:12} as const;
export const ARTICLE_REVIEW_BUDGET={maxDraftCharacters:30_000,reservedFactCharacters:10_000,reservedOtherCharacters:5_000,snapshotCharacters:19_000} as const;
export interface ArticleEvidenceSource {url:string;kind:'topic'|'disclosure'|'home'|'qualification';text:string;sourceCharacters:number;truncated:boolean}
export interface ArticleEvidenceSnapshot {version:1;topicUrl?:string;capturedAt:string;contentHash:string;sources:ArticleEvidenceSource[]}
export interface ArticleFact {claim:string;url:string;quote:string}
export interface ArticlePatch {field:'title'|'description'|'body';find:string;replace:string}
export interface ChannelTermsSource {url:string;kind:'rules'|'api'|'product_guidance'|'content_policy';text:string;appliesTo?:string;applicability?:'verified'|'unconfirmed'}
export interface ChannelTermsCache {version:1;reviewVersion?:2;channelId:string;sourceHash:string;conclusionHash:string;checkedAt:string;summary:string;finance:'allowed'|'forbidden'|'unknown';promotion:'allowed'|'forbidden'|'unknown';disclosurePlacement:string;sources:ChannelTermsSource[]}
export interface EvidenceRow {url:string;kind:string;text:string;excerpt?:string;sourceCharacters?:number}
export type EvidenceTask=Task&{evidenceSnapshot?:ArticleEvidenceSnapshot;factManifest?:ArticleFact[]};
export type TermsChannel=Channel&{termsCache?:ChannelTermsCache};

function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
export function normalizeEvidenceQuote(value:string){
  return value.normalize('NFKC').replace(/[\p{P}\p{Z}\p{C}\s]/gu,(character:string,offset:number,text:string)=>{
    // A decimal separator changes the numeric fact; it is not cosmetic punctuation.
    if((character==='.'||character===',')&&/\d/.test(text[offset-1]??'')&&/\d/.test(text[offset+1]??''))return character;
    return '';
  }).toLowerCase();
}
function numericTokens(value:string){return [...value.normalize('NFKC').matchAll(/-?\d+(?:[.,]\d+)*/g)].map(item=>item[0])}

/** Build once from the already-read topic and disclosure pages. The same bytes feed writing and review. */
export function buildArticleEvidenceSnapshot(site:Pick<Site,'url'>,topic: {url:string;text:string}|undefined,evidence:EvidenceRow[],now:Date=new Date()):ArticleEvidenceSnapshot{
  const candidates:Omit<ArticleEvidenceSource,'truncated'>[]=[];
  const add=(url:string,kind:ArticleEvidenceSource['kind'],text:string)=>{if(text.trim()&&!candidates.some(item=>item.url===url))candidates.push({url,kind,text,sourceCharacters:text.length})};
  if(topic)add(topic.url,'topic',topic.text);
  const home=(url:string)=>{const left=canonicalPublicPageUrl(url),right=canonicalPublicPageUrl(site.url);return left&&right?left===right:url===site.url};
  for(const row of evidence.filter(item=>!['rules','api','product_guidance','content_policy'].includes(item.kind)&&!home(item.url)))add(row.url,row.kind==='qualification'?'qualification':'disclosure',row.text);
  for(const row of evidence.filter(item=>home(item.url))){
    add(row.url,'home',row.text);
    const last=candidates.at(-1);if(last?.url===row.url&&row.text.length>ARTICLE_EVIDENCE_LIMITS.totalCharacters&&row.excerpt){last.text=row.excerpt;last.sourceCharacters=row.text.length}
  }
  let remaining=ARTICLE_EVIDENCE_LIMITS.totalCharacters;
  const sources:ArticleEvidenceSource[]=candidates.map(item=>{const text=item.text.slice(0,remaining);remaining-=text.length;return {...item,text,truncated:text.length<item.sourceCharacters}}).filter(item=>item.text.length>0);
  return {version:1,...(topic?{topicUrl:topic.url}:{}),capturedAt:now.toISOString(),contentHash:hash(sources),sources};
}

export function snapshotEvidenceRows(snapshot:ArticleEvidenceSnapshot):EvidenceRow[]{return snapshot.sources.map(item=>({url:item.url,kind:item.kind==='home'?'site':item.kind==='qualification'?'qualification':'site_detail',text:item.text,excerpt:item.text,sourceCharacters:item.sourceCharacters}))}
// The topic page may answer on the "www." host or without it; it is the same page either way.
export const sameTopicUrl=(left?:string,right?:string)=>left===right||!!left&&!!right&&canonicalPublicPageUrl(left)!==undefined&&canonicalPublicPageUrl(left)===canonicalPublicPageUrl(right);
export function validEvidenceSnapshot(snapshot:ArticleEvidenceSnapshot,topicUrl?:string){return snapshot.version===1&&sameTopicUrl(snapshot.topicUrl,topicUrl)&&snapshot.contentHash===hash(snapshot.sources)&&snapshot.sources.length>0}

/** Keep exact fact quotes while reducing the frozen source text before any AI review call. */
export function shrinkArticleEvidenceSnapshot(snapshot:ArticleEvidenceSnapshot,maxCharacters:number,protectedQuotes:readonly {url:string;quote:string}[]=[]):ArticleEvidenceSnapshot|undefined{
  if(!validEvidenceSnapshot(snapshot,snapshot.topicUrl)||!Number.isSafeInteger(maxCharacters)||maxCharacters<1)return;
  const total=snapshot.sources.reduce((sum,source)=>sum+source.text.length,0);
  if(total<=maxCharacters)return snapshot;
  const protectedByUrl=new Map<string,string[]>();
  for(const {url,quote} of protectedQuotes){
    const source=snapshot.sources.find(item=>item.url===url);
    if(!source||!quote||!source.text.includes(quote))return;
    const quotes=protectedByUrl.get(url)??[];
    if(!quotes.includes(quote))quotes.push(quote);
    protectedByUrl.set(url,quotes);
  }
  const mandatory=snapshot.sources.map(source=>(protectedByUrl.get(source.url)??[]).join('\n'));
  const mandatoryLength=mandatory.reduce((sum,text)=>sum+text.length,0);
  if(mandatoryLength>maxCharacters)return;
  // Reserve one separator per protected source before distributing head text.
  // Without this, a 500-character budget can render 501 characters at the tail.
  let remaining=Math.max(0,maxCharacters-mandatoryLength-mandatory.filter(Boolean).length);
  const sources=snapshot.sources.map((source,index)=>{
    const exact=mandatory[index],available=Math.min(source.text.length,Math.floor(remaining/(snapshot.sources.length-index)));
    const head=source.text.slice(0,available);
    remaining-=head.length;
    const text=exact?head.includes(exact)?head:[head,exact].filter(Boolean).join('\n'):head;
    return {...source,text,truncated:text.length<source.sourceCharacters};
  }).filter(source=>source.text.length>0);
  if(!sources.length||sources.reduce((sum,source)=>sum+source.text.length,0)>maxCharacters)return;
  if(protectedQuotes.some(({url,quote})=>!sources.find(source=>source.url===url)?.text.includes(quote)))return;
  return {...snapshot,contentHash:hash(sources),sources};
}

/** Reserve room for the longest accepted draft plus its fact list before writing starts. */
export function reserveArticleReviewBudget(snapshot:ArticleEvidenceSnapshot):ArticleEvidenceSnapshot|undefined{
  let result:ArticleEvidenceSnapshot|undefined=snapshot;
  for(let attempt=0;attempt<4&&result;attempt++){
    const serialized=JSON.stringify(result).length;
    if(serialized<=ARTICLE_REVIEW_BUDGET.snapshotCharacters)return result;
    const raw=result.sources.reduce((sum,source)=>sum+source.text.length,0);
    result=shrinkArticleEvidenceSnapshot(result,raw-(serialized-ARTICLE_REVIEW_BUDGET.snapshotCharacters)-128);
  }
  return result&&JSON.stringify(result).length<=ARTICLE_REVIEW_BUDGET.snapshotCharacters?result:undefined;
}

// A separate expression avoids word-boundary assumptions around Chinese units.
const UNIT_NUMBER_PATTERN=/-?\d+(?:[.,]\d+)*(?:\s*(?:%|USDT|USDC|USD|BTC|ETH|元|美元|天|日|周|月|年|小时|分钟|倍|days?\b|weeks?\b|months?\b|years?\b|hours?\b|minutes?\b))/giu;
export function unitNumbers(value:string){return [...value.normalize('NFKC').matchAll(UNIT_NUMBER_PATTERN)].map(item=>item[0].replace(/\s+/g,'').toLowerCase())}
/** Restore facts only from literally matching source sentences, never by inferring a number's meaning. */
export function deriveLiteralFactManifest(draft:NonNullable<Task['draft']>,snapshot:ArticleEvidenceSnapshot):ArticleFact[]{
  const sentences=(value:string)=>value.split(/(?:[!?。！？]|\.(?!\d)|\n)+/).map(item=>item.trim()).filter(Boolean);
  const sourceSentences=snapshot.sources.flatMap(source=>sentences(source.text).map(quote=>({url:source.url,quote,normalized:normalizeEvidenceQuote(quote)})));
  const facts:ArticleFact[]=[];
  for(const claim of sentences([draft.title,draft.description,draft.body].join('\n'))){
    if(!unitNumbers(claim).length||claim.length>5000||facts.length>=ARTICLE_EVIDENCE_LIMITS.maxFacts)continue;
    const normalized=normalizeEvidenceQuote(claim),source=sourceSentences.find(item=>item.normalized.includes(normalized));
    if(source)facts.push({claim,url:source.url,quote:source.quote});
  }
  return facts;
}
export function validateFactManifest(draft:NonNullable<Task['draft']>,facts:ArticleFact[]|undefined,snapshot:ArticleEvidenceSnapshot):string|undefined{
  if(!Array.isArray(facts)||facts.length>ARTICLE_EVIDENCE_LIMITS.maxFacts||JSON.stringify(facts).length>ARTICLE_REVIEW_BUDGET.reservedFactCharacters)return 'fact_manifest_invalid';
  const sources=new Map(snapshot.sources.map(item=>[item.url,normalizeEvidenceQuote(item.text)]));
  for(const fact of facts){
    if(!fact||typeof fact.claim!=='string'||typeof fact.url!=='string'||typeof fact.quote!=='string'||normalizeEvidenceQuote(fact.quote).length<8)return 'fact_manifest_invalid';
    const quote=normalizeEvidenceQuote(fact.quote),source=sources.get(fact.url);
    if(!source?.includes(quote))return 'evidence_invalid';
    const sourceText=snapshot.sources.find(item=>item.url===fact.url)!.text;
    if(numericTokens(fact.quote).some(number=>!numericTokens(sourceText).includes(number))||unitNumbers(fact.quote).some(number=>!unitNumbers(sourceText).includes(number)))return 'evidence_invalid';
    if(unitNumbers(fact.claim).some(number=>!unitNumbers(fact.quote).includes(number)))return 'fact_number_unsupported';
    if(!normalizeEvidenceQuote([draft.title,draft.description,draft.body].join('\n')).includes(normalizeEvidenceQuote(fact.claim)))return 'fact_manifest_invalid';
  }
  const quotes=facts.flatMap(fact=>unitNumbers(fact.quote));
  if(unitNumbers([draft.title,draft.description,draft.body].join('\n')).some(number=>!quotes.includes(number)))return 'fact_number_unsupported';
}

/** Cache changes only when fetched policy content or applicability changes, never catalog copy or dates. */
export function buildChannelTermsCache(channel:Pick<Channel,'id'>&Partial<Pick<Channel,'notes'|'checkedAt'>>,sources:ChannelTermsSource[],previous?:ChannelTermsCache,now:Date=new Date()):ChannelTermsCache{
  // Evidence collectors also carry transient excerpts and size metadata. Persist
  // only the source contract so the cache remains compatible with backups.
  sources=sources.map(({url,kind,text,appliesTo,applicability})=>({url,kind,text,...(appliesTo!==undefined?{appliesTo}:{}),...(applicability!==undefined?{applicability}:{})}));
  const sourceHash=hash(sources.map(({url,kind,text,appliesTo,applicability})=>({url,kind,text,appliesTo,applicability})));
  if(previous?.version===1&&previous.channelId===channel.id&&previous.sourceHash===sourceHash&&validChannelTermsCache(previous)){
    return previous.sources.every(source=>Object.keys(source).every(key=>['url','kind','text','appliesTo','applicability'].includes(key)))?previous:{...previous,sources};
  }
  const policy=sources.filter(item=>['rules','content_policy'].includes(item.kind)&&item.applicability==='verified'&&item.appliesTo===channel.id);
  let remaining=ARTICLE_EVIDENCE_LIMITS.channelSummaryCharacters;
  const summarySources=[...policy,...sources.filter(item=>!policy.includes(item))];
  const summary=summarySources.map((item,index)=>{const budget=Math.floor(remaining/(summarySources.length-index)),part=termsExcerpt(item.text,budget);remaining-=part.length;return part}).filter(Boolean).join('\n').slice(0,ARTICLE_EVIDENCE_LIMITS.channelSummaryCharacters);
  const conclusion={sourceHash,finance:'unknown' as const,promotion:'unknown' as const,disclosurePlacement:'unknown' as const,summary};
  const pending:ChannelTermsCache={version:1,channelId:channel.id,checkedAt:now.toISOString(),...conclusion,conclusionHash:termsConclusionHash(channel.id,sources,conclusion),sources};
  if(previous?.reviewVersion===2&&previous.channelId===channel.id&&validChannelTermsCache(previous)&&policyTextSignature(previous.channelId,previous.sources)===policyTextSignature(channel.id,sources)){
    return reviewedChannelTermsCache(pending,previous,now);
  }
  return pending;
}

/** The texts a terms conclusion is read from: the content policy, or API / product guidance when a platform has none. */
function policyTextSignature(channelId:string,sources:ChannelTermsSource[]){
  const verified=sources.filter(item=>item.applicability==='verified'&&item.appliesTo===channelId);
  const policy=verified.filter(item=>['rules','content_policy'].includes(item.kind));
  const read=policy.length?policy:verified.filter(item=>['api','product_guidance'].includes(item.kind));
  return hash(read.map(({kind,text,appliesTo,applicability})=>({kind,text,appliesTo,applicability})));
}
/**
 * Reviews bind to this hash. It covers only the conclusion and the texts it was read from, so a change to
 * an unrelated page (an API reference, a sidebar summary) does not void reviews that already passed.
 */
function termsConclusionHash(channelId:string,sources:ChannelTermsSource[],conclusion:Pick<ChannelTermsCache,'finance'|'promotion'|'disclosurePlacement'>){
  return hash({policySignature:policyTextSignature(channelId,sources),finance:conclusion.finance,promotion:conclusion.promotion,disclosurePlacement:conclusion.disclosurePlacement});
}

export function validChannelTermsCache(cache:ChannelTermsCache):boolean{
  if(cache.version!==1||cache.reviewVersion!==undefined&&cache.reviewVersion!==2)return false;
  const sourceHash=hash(cache.sources.map(({url,kind,text,appliesTo,applicability})=>({url,kind,text,appliesTo,applicability})));
  return cache.sourceHash===sourceHash&&cache.conclusionHash===termsConclusionHash(cache.channelId,cache.sources,cache);
}

export function reviewedChannelTermsCache(cache:ChannelTermsCache,decision:Pick<ChannelTermsCache,'finance'|'promotion'|'disclosurePlacement'>,now:Date=new Date()):ChannelTermsCache{
  if(!validChannelTermsCache(cache))throw Error(AI_REVIEW_MESSAGES.termsCacheInvalid);
  const conclusion={finance:decision.finance,promotion:decision.promotion,disclosurePlacement:decision.disclosurePlacement};
  return {...cache,reviewVersion:2,checkedAt:now.toISOString(),...conclusion,conclusionHash:termsConclusionHash(cache.channelId,cache.sources,conclusion)};
}

function termsExcerpt(text:string,max:number){
  if(text.length<=max)return text;
  const sentences=text.match(/[^.!?。！？\n]+[.!?。！？]?/g)??[text];
  const prioritized=sentences.map((value,index)=>({value:value.trim(),index,score:/prohibit|forbid|must not|cannot|shall not|affiliate|financ|crypto|commercial|promot|advertis|disclos|禁止|不得|金融|推广|返佣|披露/i.test(value)?2:index===0||index===sentences.length-1?1:0})).sort((a,b)=>b.score-a.score||a.index-b.index);
  let remaining=max;const selected:{value:string;index:number}[]=[];
  for(const row of prioritized){if(remaining<=0)break;const value=row.value.slice(0,remaining);if(!value)continue;selected.push({value,index:row.index});remaining=Math.max(0,remaining-value.length-1)}
  return selected.sort((a,b)=>a.index-b.index).map(row=>row.value).join('\n').slice(0,max);
}

/** Exact source phrases remain citeable while total policy text sent per article is at most 600 chars. */
export function channelTermsEvidence(cache:ChannelTermsCache):ChannelTermsSource[]{
  let remaining=ARTICLE_EVIDENCE_LIMITS.channelSummaryCharacters;
  const sorted=[...cache.sources].sort((a,b)=>Number(['rules','content_policy'].includes(b.kind))-Number(['rules','content_policy'].includes(a.kind)));
  return sorted.map((item,index)=>{const budget=Math.floor(remaining/(sorted.length-index)),text=termsExcerpt(item.text,budget);remaining-=text.length;return {...item,text}}).filter(item=>item.text.length>0);
}

const PATCH_COMMON_WORDS=new Set(('a an the this that these those and or but if when then than to of in on at by for from with without as is are was were be been being it its they their them we our you your not no only can cannot may might should must will would could do does did have has had about after before between into over under through during per each any all some more less other same such also still instead both either neither there here where which who what how why because while although however therefore use uses using used read see follow compare remove keep add show shows shown make makes made explain explains explained source sources public material materials original statement statements claim claims wording text draft article note detail details process method result scope limit limits evidence available documented unsupported unclear clear accurate accuracy factual fact facts information documentation reference references possible certain different relevant consistent').split(' '));
const PATCH_COMMON_HAN='本文文章正文标题摘要读者资料材料原文来源公开事实内容说明表述信息文字段落句子范围限制边界风险可能需要可以不可不能不应不得已经仍然尚未存在提供查看阅读参阅比较删除保留补充修改调整避免确保根据依据如果以及或者并且但是因此同时其中相关具体明确准确完整独立当前实际一般通常只在仅限不再并非没有并不不宜无法不作不做';
function lexicalPatchAllowed(replacement:string,permittedText:string){
  const permitted=permittedText.normalize('NFKC').toLowerCase(),knownWords=new Set(permitted.match(/[\p{Script=Latin}]+/gu)??[]);
  const words=replacement.normalize('NFKC').toLowerCase().replace(/https?:\/\/[^\s)<>]+/g,'').match(/[\p{Script=Latin}]+/gu)??[];
  if(words.some(word=>!knownWords.has(word)&&!PATCH_COMMON_WORDS.has(word)))return false;
  const otherWords=(value:string)=>value.replace(/[\p{Script=Latin}\p{Script=Han}]+/gu,' ').match(/[\p{L}\p{M}]+/gu)??[];
  const knownOtherWords=new Set(otherWords(permitted));
  if(otherWords(replacement.normalize('NFKC').toLowerCase()).some(word=>!knownOtherWords.has(word)))return false;
  for(const match of replacement.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,}/gu)){
    const characters=[...match[0]];
    for(let index=0;index<characters.length-1;index++){const pair=characters[index]+characters[index+1];if(!permitted.includes(pair)&&!PATCH_COMMON_HAN.includes(pair))return false}
  }
  return true;
}
function guardedTokens(value:string){return [...value.normalize('NFKC').matchAll(/https?:\/\/[^\s)<>]+|-?\d+(?:[.,]\d+)*/gu)].map(item=>item[0])}
export function applyEvidencePatches(draft:NonNullable<Task['draft']>,patches:ArticlePatch[],snapshot:ArticleEvidenceSnapshot):NonNullable<Task['draft']>|undefined{
  if(!Array.isArray(patches)||!patches.length||patches.length>ARTICLE_EVIDENCE_LIMITS.maxPatches)return;
  const result={...draft},sourceText=snapshot.sources.map(item=>item.url+'\n'+item.text).join('\n');
  for(const patch of patches){
    if(!patch||!['title','description','body'].includes(patch.field)||typeof patch.find!=='string'||typeof patch.replace!=='string'||!patch.find||patch.find.length>5000||patch.replace.length>5000)return;
    const value=result[patch.field],position=value.indexOf(patch.find);
    if(position<0||value.indexOf(patch.find,position+patch.find.length)!==-1)return;
    const permittedText=patch.find+'\n'+sourceText,allowedTokens=new Set(guardedTokens(permittedText));
    if(guardedTokens(patch.replace).some(token=>!allowedTokens.has(token))||!lexicalPatchAllowed(patch.replace,permittedText))return;
    result[patch.field]=value.slice(0,position)+patch.replace+value.slice(position+patch.find.length);
  }
  return result;
}

export function applyEvidencePatchResult(draft:NonNullable<Task['draft']>,facts:ArticleFact[]|undefined,patches:ArticlePatch[],snapshot:ArticleEvidenceSnapshot):{draft:NonNullable<Task['draft']>;factManifest:ArticleFact[]}|undefined{
  const patched=applyEvidencePatches(draft,patches,snapshot);if(!patched)return;
  const factManifest:ArticleFact[]=[];
  for(const fact of facts??[]){
    let claim=fact.claim;
    for(const patch of patches){
      if(claim.includes(patch.find))claim=claim.replace(patch.find,patch.replace);
      else if(patch.find.includes(claim)&&!patch.replace.includes(claim))claim=patch.replace;
    }
    if(!claim.trim()||!normalizeEvidenceQuote([patched.title,patched.description,patched.body].join('\n')).includes(normalizeEvidenceQuote(claim)))continue;
    factManifest.push({...fact,claim});
  }
  if(validateFactManifest(patched,factManifest,snapshot))return;
  return {draft:patched,factManifest};
}

export const ARTICLE_PREFLIGHT_MESSAGES={site_forbidden_term:SITE_ACTION_MESSAGES.forbiddenTerm,site_target_not_allowed:SITE_ACTION_MESSAGES.targetNotAllowed,fact_manifest_invalid:'事实清单不合格：每条 claim 必须逐字复制正文里的一句原话，quote 必须逐字摘自资料',fact_number_unsupported:'数字缺少原文依据',evidence_invalid:'引用未出现在资料快照',disclosure_missing:'缺少商业披露',link_count_invalid:'正文链接数量不符',language_invalid:'正文语种不符',length_invalid:'正文篇幅不符',format_invalid:'正文格式不符',return_promise:'内容包含收益承诺',process_leak:'正文提到了写稿过程（如“提供的材料”“选题页”）',price_prediction:'内容包含价格预测',referral_content:'内容包含推荐码或推荐链接'} as const;
export function articleBodyUrls(body:string){
  const urls:string[]=[];
  const withoutMarkdown=body.replace(/\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\s*\)/g,(_whole,url:string)=>{urls.push(url);return ''});
  for(const match of withoutMarkdown.matchAll(/https?:\/\/[^\s)<>"']+/g))urls.push(match[0]);
  return urls;
}
const LANGUAGE_WORDS:Record<string,Set<string>>=Object.fromEntries(Object.entries({
  en:'the and is are this that with for from your can to of a in not',es:'el la los las de y es una un para con que por como del',fr:'le la les des de et est une un pour avec qui que dans',de:'der die das und ist sind mit für von zu ein eine nicht',pt:'o a os as de e é uma um para com que por não',tr:'ve bir bu için ile olarak olan veya değil nasıl',vi:'và là của trong một các với không cho được',id:'dan yang untuk dengan ini dari adalah tidak pada atau',it:'il lo gli le di e è una un per con che nel',nl:'de het een en is zijn met voor van op niet',
}).map(([language,words])=>[language,new Set(words.split(' '))]));
export function articleLanguageMatches(value:string,language:string){
  const letters=value.match(/\p{L}/gu)??[];if(letters.length<20)return true;
  const count=(pattern:RegExp)=>(value.match(pattern)??[]).length/letters.length;
  const code=language.toLowerCase().split(/[-_]/)[0];
  if(code==='zh')return count(/\p{Script=Han}/gu)>=0.4;
  if(code==='ja')return count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)>=0.08;
  if(code==='ko')return count(/\p{Script=Hangul}/gu)>=0.4;
  if(['ru','uk','bg'].includes(code))return count(/\p{Script=Cyrillic}/gu)>=0.6;
  if(['ar','fa'].includes(code))return count(/\p{Script=Arabic}/gu)>=0.6;
  if(code==='th')return count(/\p{Script=Thai}/gu)>=0.6;
  const expected=LANGUAGE_WORDS[code];if(!expected)return true;
  if(count(/\p{Script=Latin}/gu)<0.75)return false;
  const words=value.toLowerCase().match(/\p{Script=Latin}+/gu)??[];
  if(words.length<40)return true;
  const scores=Object.entries(LANGUAGE_WORDS).map(([key,markers])=>({key,count:words.filter(word=>markers.has(word)).length}));
  const current=scores.find(item=>item.key===code)!.count;
  return current>=2&&!scores.some(item=>item.key!==code&&item.count>current*2+3);
}

// A price prediction is a forward-looking claim about an asset's price. Fees, limits, margins, transfer
// and confirmation times, gas, leverage, supply and hashrate, worked order examples, questions, risk
// warnings and historical prices are ordinary facts.
const PRICE_SUBJECT=String.raw`(?:价格|币价|[Pp]rices?|\b(?:BTC|ETH|SOL|BNB|XRP|DOGE)\b|[Bb]itcoin|[Ee]thereum|比特币|以太坊)`;
const PRICE_SUBJECT_TEST=new RegExp(PRICE_SUBJECT,'u');
// English modal verbs are matched in lower case only, so the month "May 2021" never reads as "may".
const FUTURE=String.raw`(?:将会|将|会|预计|预测|有望|或将|可能|上看|will|may|could|might|(?:is\s+|are\s+)?(?:expected|likely|set|poised)\s+to)`;
// A short qualifier may sit between the modal and the verb: "将在 2027 年突破", "有望在年底前涨到", "will likely reach".
const SPAN=String.raw`[^。！？.!?\n,;]{0,15}?`;
const RISE=String.raw`上涨|大涨|暴涨|涨|rise|surge|jump|climb|soar`;
const UP_MOVE=String.raw`涨到|涨至|升至|突破|冲到|冲上|站上|回到|达到|看到|${RISE}|reach|hit|rise\s+to|climb\s+to|surge\s+to|jump\s+to|exceed|top|break`;
const MOVE=String.raw`(?:${UP_MOVE}|跌到|跌至|降至|下跌|暴跌|跌|fall(?:\s+to)?|drop(?:\s+to)?|plunge(?:\s+to)?)`;
const AMOUNT_START=String.raw`(?:US\$|USD\s*|人民币\s*|RMB\s*|CNY\s*)?[$¥€\d]`;
const LEAD=String.raw`\s*(?:到|至|约|大约|about|around|above|past|over)?\s*(?=${AMOUNT_START})`;
const PREDICTION=new RegExp(String.raw`${PRICE_SUBJECT}(?<gap>[^。！？.!?\n]{0,12}?)${FUTURE}${SPAN}\s*(?<move>${MOVE})${LEAD}`,'gu');
// "价格有望翻倍" / "ETH is expected to double": a multiple needs no number.
const DOUBLING=new RegExp(String.raw`${PRICE_SUBJECT}(?<gap>[^。！？.!?\n]{0,12}?)${FUTURE}${SPAN}\s*(?:翻倍|翻番|翻[一两二三几]番|(?:double|triple|quadruple)(?![-\w]))`,'gu');
// Doubling is about the price only when nothing but the word for price sits between the asset and the verb.
const DOUBLING_GAP=/^[\s的]*(?:价格|币价|prices?)?[\s的]*(?:明年|今年|年底|年内|年末|本轮|下一轮|未来|this\s+year|next\s+year)?[\s的]*(?:is|are)?\s*$/i;
// "Analysts expect Bitcoin to reach $150,000".
const EXPECT=new RegExp(String.raw`\b(?:expects?|predicts?|forecasts?|sees?)\s+(?:the\s+)?${PRICE_SUBJECT}(?<gap>[^.!?\n]{0,15}?)\s+to\s+(?:\w+\s+)?(?<move>${MOVE})${LEAD}`,'gu');
// "今年有望涨到 15 万美元": the subject is implied by the sentence or the one before; only an upward move to a currency amount counts.
const SUBJECTLESS=new RegExp(String.raw`${FUTURE}${SPAN}\s*(?<move>涨到|涨至|突破|升至|冲到|冲上|站上|reach|hit|rise\s+to|surge\s+to|climb\s+to)${LEAD}`,'gu');
const TARGET_PRICE=/(?:目标价|目标价格|target\s+price|price\s+target)\s*(?:[:：=为是]|of|at|is)?\s*(?:[$¥€]\s*)?\d/i;
const HORIZON=/(?:年底|年末|年内|本轮|下一轮|明年|year[- ]?end|next\s+year|by\s+20\d\d)\s*(?:有望|上看|看到|看至|看向|看|目标|涨到|达到|reach|hit|target)\s*(?=(?:US\$|USD\s*|人民币\s*)?[$¥€\d])/giu;
const LOOK_AT=/(?:上看|看涨至|看跌至)\s*(?=(?:US\$|USD\s*|人民币\s*)?[$¥€\d])/gu;
// Words that make the sentence about something other than the asset's price anywhere before the verb: fees, limits, network
// figures, rewards and bonuses, volume, balances, or a price metric that is not a level (drawdown, swing, spread, yield).
const NON_PRICE_SUBJECT=/费率|手续费|费用|额度|限额|保证金|门槛|审核|确认|提现|提币|充值|充币|转账|到账|出块|区块|矿工费|杠杆|利率|年化|总量|供应|算力|难度|奖池|奖励|奖金|返现|返利|体验金|赠金|红包|福利|空投|交易量|成交量|余额|跌幅|回撤|振幅|偏离|价差|滑点|gas|\b(?:fees?|limits?|withdrawals?|deposits?|transfers?|confirmations?|blocks?|leverage|margin|minimum|maximum|interest|rate|supply|hashrate|difficulty|pool|bonus(?:es)?|rewards?|airdrops?|volume|balance|TVL|drops?|drawdowns?|swings?|spreads?|dominance|volatility|APR|APY|yield)\b/i;
// Words that change the subject only when they stand right before the verb ("价格波动可能达到 10%"), not when they set the scene
// ("价格在大幅波动后有望站上 15 万美元", "随着 ETF 规模扩大有望突破").
const NON_PRICE_SUBJECT_AT_END=/(?:规模|波动|基金|融资|占比|市占率|市值占比|funds?|share)\s*$/i;
const nonPriceGap=(gap:string)=>NON_PRICE_SUBJECT.test(gap)||NON_PRICE_SUBJECT_AT_END.test(gap);
// Units after a number that make it a time, count or rate rather than a price.
const NON_PRICE_UNIT=/^\s*(?:分钟|秒|小时|天|日|周|个|笔|次|块|枚|人(?!民币)|名|户|家|台(?!币)|条|张|份|gwei|sats?\b|bps\b|ms\b|minutes?\b|mins?\b|seconds?\b|secs?\b|hours?\b|days?\b|weeks?\b|blocks?\b|confirmations?\b|times\b|transactions?\b|tps\b)/i;
const MAGNITUDE_THEN_COUNT=/^\s*(?:万|千|亿)\s*(?:枚|个|人(?!民币)|名|户|家|台(?!币)|笔|次|条|张|份|EH|TH|PH)/i;
const CURRENCY=/^\s*(?:万|千|亿|k\b|K\b|m\b|M\b|million\b|billion\b|mn\b|bn\b)?\s*(?:美元|美金|刀|元|人民币|新台币|台币|港币|港元|RMB\b|CNY\b|USD[TC]?\b|U(?![A-Za-z])|dollars?\b|bucks\b)/;
/** Whether the text right after a forecast verb is a price: a currency amount, a multiple of a plain rise, or a large bare number. */
function priceAmount(rest:string,move?:string,currencyOnly=false){
  if(/^(?:[$¥€]|US\$|USD\s*\d|人民币\s*\d|RMB\s*\d|CNY\s*\d)/i.test(rest))return true;
  const number=rest.match(/^\d[\d,.]*/)?.[0];if(!number)return false;
  const after=rest.slice(number.length);
  if(CURRENCY.test(after))return true;
  if(currencyOnly)return false;
  // A percentage or multiple is a price forecast only for an upward move ("有望上涨 20%", "有望涨到 10 倍", "will hit 10x");
  // "达到 125 倍杠杆" is a product limit and "跌幅可能达到 50%" a risk warning (its gap names the metric).
  if(/^\s*(?:[%％]|倍|x\b|X\b)/.test(after))return !!move&&new RegExp(String.raw`^(?:${UP_MOVE})$`,'i').test(move)&&!/^(?:达到|看到|回到)$/.test(move)&&!/^\s*(?:[%％]|倍|x|X)\s*(?:杠杆|leverage|费率|fee)/i.test(after);
  if(NON_PRICE_UNIT.test(after)||MAGNITUDE_THEN_COUNT.test(after))return false;
  if(/^\s*(?:万|千|亿)/.test(after)||/^\s*[kK]\b/.test(after))return true;
  // Another unit written in letters (EH/s, GB, BTC) is not a price.
  if(/^\s*[A-Za-z]/.test(after))return false;
  return Number(number.replace(/,/g,''))>=1000;
}
// A clause about the past: past-tense wording, or a year written as a year that has already gone by.
function historicalClause(clause:string,now:Date){
  if(/历史(?:高点|新高|低点)|曾经?|一度|去年|上一轮|当时|\b(?:reached|peaked|was|were|had|all[- ]time\s+high|last\s+year)\b/i.test(clause))return true;
  const years=[...clause.matchAll(/((?:19|20)\d\d)\s*年/g),...clause.matchAll(/\b(?:in|during)\s+((?:19|20)\d\d)\b/gi)].map(match=>Number(match[1]));
  return years.some(year=>year<now.getUTCFullYear());
}
function forecastIn(clause:string,pattern:RegExp,check:(match:RegExpExecArray)=>boolean){
  pattern.lastIndex=0;
  for(let match=pattern.exec(clause);match;match=pattern.exec(clause)){
    if(check(match))return true;
    // An exempted match must not hide a later subject in the same clause.
    pattern.lastIndex=match.index+1;
  }
  return false;
}
/** Phrases that tell the reader how the article was produced: "the provided material", the topic page, the draft itself. */
const PROCESS_LEAK=[
  /资料快照|证据快照|选题(?:材料|资料|页面|页|来源)|指定选题|本稿|推广内容发布者/u,
  /(?:^|[\s，。；：、！？“"（(]|根据|依据|按照?|仅凭|只凭|仅依据|只依据|由于|但|而|且|因|据)所?提供的(?:材料|资料|公开资料|公开材料|规则说明|说明|页面|信息|内容|来源)/u,
  /(?:提供的|所给的?|上述|现有)(?:材料|资料)(?:中|里)?(?:没有|未|不含|并未)/u,
  /\b(?:the |this |these )?provided (?:materials?|sources?|evidence|snapshot|pages?|documents?)\b|\b(?:evidence|source) snapshot\b|\b(?:assigned|designated) topic\b|\bmaterials? (?:provided|supplied)\b/i,
];
/** The first sentence that exposes the writing process, so the one rewrite can name it. */
export function processLeakSentence(value:string):string|undefined{
  for(const sentence of value.normalize('NFKC').split(/(?<=[。！？!?\n])|(?<=\.)\s+/u)){const text=sentence.trim();if(text&&PROCESS_LEAK.some(pattern=>pattern.test(text)))return text}
  return undefined;
}
export function hasPricePrediction(value:string,now=new Date()):boolean{return pricePredictionSentence(value,now)!==undefined}
/** The first sentence that states a price forecast, so a rewrite request can name it. */
export function pricePredictionSentence(value:string,now=new Date()):string|undefined{
  // "比特币（BTC）有望…": a short bracket right after the asset is part of its name, not a clause of its own.
  const text=value.normalize('NFKC').replace(new RegExp(String.raw`(${PRICE_SUBJECT})\s*[(（][^)）]{1,20}[)）]`,'gu'),'$1');
  let previousSentenceSubject=false;
  for(const sentence of text.split(/(?<=[。！？!?\n])(?![)）])|(?<=\.)\s+/u)){
    if(TARGET_PRICE.test(sentence))return sentence.trim();
    const sentenceSubject=PRICE_SUBJECT_TEST.test(sentence);
    // A question that weighs alternatives or asks the reader's view claims nothing ("会涨到 20 万美元，还是跌回 3 万？").
    if(/[?？]\s*$/.test(sentence.trim())&&/还是|或者|\bor\b|你认为|你觉得|你怎么看|do you think|would you/i.test(sentence)){previousSentenceSubject=sentenceSubject;continue}
    // A risk statement that names both directions is not a forecast ("可能上涨 20%，也可能下跌 20%", "may double or halve").
    if(/(?:也|或者?|或是)\s*(?:可能|会|将)?\s*(?:下跌|跌|腰斩|归零|回落)|\bor\s+(?:fall|drop|plunge|halve|crash)/i.test(sentence)){previousSentenceSubject=sentenceSubject;continue}
    // The subject may be named earlier in this sentence or in the one right before it, never further back.
    let namedPrice:boolean=previousSentenceSubject;
    // Clauses split at commas, semicolons, dashes and brackets, but not inside amounts such as $200,000 (NFKC turned "，" into ",").
    for(const clause of sentence.split(/(?<!\d)[,;]|[,;](?!\d)|[()（）]|—+|\s-\s/u)){
      const subject=PRICE_SUBJECT_TEST.test(clause);
      // A question asks; it does not claim. Only the clause that is itself the question is skipped ("…突破 20 万美元，你上车了吗？" still counts).
      if(/[?？]\s*$|吗\s*[?？]?\s*$/.test(clause.trim())){namedPrice||=subject;continue}
      if(historicalClause(clause,now)){namedPrice||=subject;continue}
      // "会在价格涨到 70000 USDT 时成交": a trigger condition describes an order or alert, not a forecast.
      const amountThen=(match:RegExpExecArray,move?:string,currencyOnly=false)=>{const rest=clause.slice(match.index+match[0].length);return priceAmount(rest,move,currencyOnly)&&!/^[^。！？.!?,，;；]{0,24}?(?:时|後|后|之后|以后|的时候)/u.test(rest)};
      if(forecastIn(clause,PREDICTION,match=>!nonPriceGap(match.groups!.gap)&&amountThen(match,match.groups!.move)))return sentence.trim();
      if(forecastIn(clause,DOUBLING,match=>DOUBLING_GAP.test(match.groups!.gap)))return sentence.trim();
      if(forecastIn(clause,EXPECT,match=>!nonPriceGap(match.groups!.gap)&&amountThen(match,match.groups!.move)))return sentence.trim();
      if((namedPrice||subject)&&!NON_PRICE_SUBJECT.test(clause)&&forecastIn(clause,SUBJECTLESS,match=>amountThen(match,match.groups!.move,true)))return sentence.trim();
      for(const pattern of [HORIZON,LOOK_AT])if(forecastIn(clause,pattern,match=>amountThen(match)))return sentence.trim();
      namedPrice||=subject;
    }
    previousSentenceSubject=sentenceSubject;
  }
  return undefined;
}
const RETURN_PROMISE=/\b(?:guaranteed?|promise[sd]?)\s+(?:returns?|profits?)\b|\brisk[- ]?free (?:return|profit|trading|investment)\b|\bno[- ]risk (?:return|profit|trading|investment)\b|稳赚|保本|(?:承诺|保证)(?:稳定|固定|无风险)?(?:收益|盈利)|无风险(?:收益|套利)/ig;
export function hasReturnPromise(value:string){for(const match of value.matchAll(RETURN_PROMISE)){const before=value.slice(Math.max(0,(match.index??0)-24),match.index).toLowerCase();if(/(?:\bnot\b|\bno\b|\bnever\b|\bcannot\b|can't|does not|doesn't|is not|isn't)\s*$/.test(before)||/(?:不|未|非|无意|不会|不能|无法|并不|并非|没有|不作|不做)(?:.{0,4})$/.test(before))continue;return true}return false}
function envelopeLanguageMatches(value:string,language:string,brand:string){
  const text=value.replace(/<[^>]*>/g,'').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").normalize('NFKC').replaceAll(brand.normalize('NFKC'),'');
  const letters=text.match(/\p{L}/gu)??[];if(!letters.length)return true;
  const ratio=(pattern:RegExp)=>(text.match(pattern)??[]).length/letters.length,code=language.toLowerCase().split(/[-_]/)[0];
  // Short managed disclosures still need the right script; a foreign brand is not prose.
  if(code==='zh')return ratio(/\p{Script=Han}/gu)>=0.4;
  if(code==='ja')return ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)>=0.08;
  if(code==='ko')return ratio(/\p{Script=Hangul}/gu)>=0.4;
  if(['ru','uk','bg'].includes(code))return ratio(/\p{Script=Cyrillic}/gu)>=0.6;
  if(['ar','fa'].includes(code))return ratio(/\p{Script=Arabic}/gu)>=0.6;
  if(code==='th')return ratio(/\p{Script=Thai}/gu)>=0.6;
  if(LANGUAGE_WORDS[code]&&ratio(/\p{Script=Latin}/gu)<0.75)return false;
  return articleLanguageMatches(text,language);
}
export function articleDraftPreflight(task:EvidenceTask,site:Site,channel:Channel):keyof typeof ARTICLE_PREFLIGHT_MESSAGES|undefined{
  const draft=task.draft;if(!draft||!draft.title.trim()||!draft.body.trim())return 'format_invalid';
  if(containsForbiddenSiteTerm(draft,site))return 'site_forbidden_term';
  if(!siteAllowsLinkTarget(site,task.writingEnvelope?.targetUrl??task.topicUrl??site.url))return 'site_target_not_allowed';
  const body=draft.body,all=[draft.title,draft.description,body].join('\n');
  const rawHtml=/<\s*\/?\s*[A-Za-z][A-Za-z0-9-]*(?=[\s/>])[^>]*>/u.test(body),markdownImage=/!\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])/u.test(body);
  const plain=channel.contentFormat==='social'||['raindrop','agenthow','synthfolk','agentriot'].includes(channel.id);
  if(plain){
    if(rawHtml||markdownImage||/(?:\[[^\]]*\]\s*\(|`|\*\*|__|~~)|(?:^|\n)\s*(?:#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/u.test(body))return 'format_invalid';
    if(channel.contentFormat!=='social'&&/https?:\/\//i.test(body))return 'format_invalid';
  }else if(channel.id==='txtsbs'){
    if(!txtsbsTaskIdentity(task,site))return 'format_invalid';
  }else if(channel.id==='berrry'){
    if(!createBerrryInput(task,site))return 'format_invalid';
  }else if(rawHtml&&['plopino','vibedrop','here-now','shiply'].includes(channel.id)){
    const validator={plopino:plopinoTaskIdentity,vibedrop:vibeDropTaskIdentity,'here-now':hereNowTaskIdentity,shiply:shiplyTaskIdentity}[channel.id]!;
    if(!validator(task,site))return 'format_invalid';
  }else if(channel.id!=='product-index'&&(rawHtml||markdownImage))return 'format_invalid';
  if(channel.id==='nextgen-slides'&&[...body.matchAll(/^##\s+\S/gm)].length<3)return 'format_invalid';
  if(channel.id==='leaflet'&&/(?:^|\n)\s*(?:```|~~~|>\s|(?:[-*_]\s*){3,}$)|~~|(?:^|\n)\s*\|?\s*:?-{3,}:?\s*\|/mu.test(body))return 'format_invalid';
  if(containsReferralInformation(all,siteReferralCodes(site,task.evidenceSnapshot),new URL(site.url).hostname))return 'referral_content';
  if(hasPricePrediction(all))return 'price_prediction';
  if(hasReturnPromise(all))return 'return_promise';
  // Only the written prose: the disclosure, risk note and signature the program adds are not the writer's words.
  if(processLeakSentence([draft.title,draft.description,task.writingEnvelope?stripWritingEnvelope(body,task.writingEnvelope):body].join('\n')))return 'process_leak';
  if(task.writingEnvelope){
    if(!body.includes(task.writingEnvelope.disclosure))return 'disclosure_missing';
    const prose=stripWritingEnvelope(body,task.writingEnvelope),language=channel.languages.includes('*')?site.language:channel.languages[0]??site.language;
    if(!envelopeLanguageMatches(task.writingEnvelope.disclosure,language,site.name)||!envelopeLanguageMatches(task.writingEnvelope.risk,language,site.name))return 'language_invalid';
    if(!articleLanguageMatches(prose,language))return 'language_invalid';
    if(site.writingProfile&&channel.articleRequired&&channel.contentFormat!=='social'&&channel.kind==='article'&&!['raindrop','agentriot','agenthow'].includes(channel.id)){
      const length=[...prose.replace(/\s/g,'')].length;
      if(length<site.writingProfile.length.min||length>site.writingProfile.length.max)return 'length_invalid';
    }
  }
  if(channel.articleRequired&&channel.contentFormat!=='social'&&channel.kind==='article'&&body.length>120_000)return 'length_invalid';
  // Structured profile/HTML payloads retain their exact adapter-specific validation below the caller.
  if(task.evidenceSnapshot&&channel.contentFormat!=='social'&&!['profile','directory'].includes(channel.kind)&&!['berrry','product-index','synthfolk','agenthow','raindrop','agentriot'].includes(channel.id)){
    if(!task.writingEnvelope&&!/disclos|commercial relationship|affiliate|referral|commission|afiliad|comisi[oó]n|推广|返佣|佣金|披露|tuyên bố|açıklama|партн[её]р|제휴|提携/i.test(body))return 'disclosure_missing';
    const urls=articleBodyUrls(body);
    if(urls.length!==1)return 'link_count_invalid';
    if(!articleLanguageMatches(stripWritingEnvelope(body,task.writingEnvelope),channel.languages.includes('*')?site.language:channel.languages[0]??site.language))return 'language_invalid';
  }
  if(task.evidenceSnapshot){const error=validateFactManifest(draft,task.factManifest??deriveLiteralFactManifest(draft,task.evidenceSnapshot),task.evidenceSnapshot);if(error)return error as keyof typeof ARTICLE_PREFLIGHT_MESSAGES}
}
