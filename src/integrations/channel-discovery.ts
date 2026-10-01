import type {Category,Channel,Qualification,Site} from '../shared/types';
import {eligibilityFor,qualificationLabels,requirementsFor,validQualificationUrl} from './eligibility';

export type ChannelDiscoveryStatus='recommended'|'worth_trying'|'needs_preparation'|'blocked';
export interface ChannelDiscovery {
  channel:Channel;
  score:number;
  status:ChannelDiscoveryStatus;
  reason:string;
  nextStep:string;
  executionReady:boolean;
  canQueue:boolean;
}

const related:Partial<Record<Category,Category[]>>={
  ai:['software','developer'],software:['ai','developer','business'],developer:['software','ai','education'],
  design:['content','software'],business:['software','content'],content:['design','education','business'],
  education:['content','developer'],finance:['business'],
};
const categoryLabel:Record<Category,string>={software:'软件',ai:'人工智能',developer:'开发者',design:'设计',business:'商业',content:'内容',education:'教育',finance:'金融',general:'综合'};
const preparableRequirements=new Set<Qualification>(['publication','techContent','software']);
const preparablePublicationChannels=new Set(['wordpress-com','paragraph','beehiiv','kit-newsletter','tumblr','linkedin-articles','x-profile','substack','ghost-pro']);
const productShapeRequirements=new Set<Qualification>(['software','developer']);
const packageRequirements=new Set<Qualification>(['javascriptPackage','pythonPackage','dotnetPackage','rustCrate','phpPackage','dartPackage','rubyGem','containerImage','firefoxExtension','vscodeExtension','jetbrainsPlugin','wordpressPlugin','drupalProject','linuxApp','androidFoss','openSource','gameAsset','aiArtifact']);
const affiliateRestrictedPublicationChannels=new Set(['wordpress-com','paragraph']);

function rootLanguage(language:string){return language.toLowerCase().split('-')[0]||'und'}
function hasProductShape(site:Site){return /(?:提供.{0,24}(?:工具|计算器|软件|应用|插件|脚本)|在线工具|浏览器(?:.{0,12})?(?:工具|计算器)|(?:provides?|offers?|builds?).{0,32}(?:calculator|tool|software|app|extension)|\b(?:calculator|software|web app|browser tool)\b)/i.test(`${site.name} ${site.description}`)}
function hasTechnicalContentShape(site:Site){return hasProductShape(site)||/(?:教程|指南|研究|技术|文档|prompt|guide|tutorial|documentation|research)/i.test(`${site.name} ${site.description}`)}
function languageFit(site:Site,channel:Channel){const language=rootLanguage(site.language);return language==='und'||channel.languages.includes('*')||channel.languages.map(rootLanguage).includes(language)}
function relevance(site:Site,channel:Channel){
  if(channel.categories.includes(site.category))return 70;
  if((related[site.category]??[]).some(category=>channel.categories.includes(category)))return 44;
  if(channel.categories.includes('general'))return 38;
  return 18;
}
function missingRequirements(site:Site,channel:Channel){return requirementsFor(channel).filter(requirement=>!validQualificationUrl(site.qualifications?.[requirement]))}
function inferredRequirement(site:Site,requirement:Qualification){
  if(requirement==='publication')return true;
  if(requirement==='techContent')return hasTechnicalContentShape(site);
  if(productShapeRequirements.has(requirement))return hasProductShape(site);
  return false;
}
function missingLabel(missing:Qualification[]){return missing.map(item=>qualificationLabels[item]).join('、')}

/**
 * A broad, read-only candidate view. This never grants platform qualification or
 * submission permission. Automatic execution continues to use eligibilityFor;
 * manual candidates may only create a preparation task.
 */
export function channelDiscoveryFor(site:Site,channel:Channel):ChannelDiscovery{
  if(!channel.enabled)return {channel,score:0,status:'blocked',reason:'该渠道当前停用，不能建立新任务。',nextStep:'查看官方规则和停用说明；不要用其他渠道或账号绕过限制。',executionReady:false,canQueue:false};

  const missing=missingRequirements(site,channel);
  const fit=eligibilityFor(site,channel);
  const topicScore=relevance(site,channel);
  const translated=!languageFit(site,channel);
  const baseScore=Math.max(0,topicScore+(translated?-10:12)+(channel.quality==='A'?8:channel.quality==='B'?4:0)+(channel.free==='yes'?5:channel.free==='conditional'?1:0));

  if(missing.length){
    const inferred=missing.every(requirement=>inferredRequirement(site,requirement));
    const packageOnly=missing.some(requirement=>packageRequirements.has(requirement));
    if(!inferred||packageOnly){
      return {channel,score:baseScore,status:'blocked',reason:`尚未确认${missingLabel(missing)}。网站主题或工具描述不能代替该资格。`,nextStep:`只有确有${missingLabel(missing)}时再使用此渠道；不要为满足目录要求虚构项目。`,executionReady:false,canQueue:false};
    }
    const canPrepare=channel.automation==='manual'&&missing.every(requirement=>preparableRequirements.has(requirement)&&(requirement!=='publication'||preparablePublicationChannels.has(channel.id)));
    const restrictedPublication=missing.includes('publication')&&affiliateRestrictedPublicationChannels.has(channel.id);
    const reason=restrictedPublication?'可准备独立原创出版物，但该平台不接受以联盟导流为主要目的的出版物；仅凭网站简介不能判定是否符合。':`公开简介显示可能适合，但${missingLabel(missing)}仍待准备和核对。`;
    const nextStep=canPrepare?(restrictedPublication?'可建立人工待办，准备以独立原创内容为主且如实披露关系的材料；平台接受和最终提交仍需人工核对。':'可先建立人工待办并准备真实材料；平台接受、账号资格和最终提交仍需确认。'):`先确认真实的${missingLabel(missing)}及公开资料，再加入执行计划。`;
    return {channel,score:baseScore,status:'needs_preparation',reason,nextStep,executionReady:false,canQueue:canPrepare};
  }

  const locallyEligible=fit.eligible;
  const executionReady=locallyEligible&&channel.automation!=='manual';
  if(topicScore<44||translated){
    const reason=translated?'网站语言与渠道常用语言不同，可为该渠道另备真实翻译材料。':'主题并非完全相同，但已有真实资格或该渠道用途较通用。';
    return {channel,score:baseScore,status:'worth_trying',reason,nextStep:channel.automation==='manual'?'可建立人工待办，先核对受众、账号和平台限制。':'可由你主动加入；自动执行前仍会重新检查资格、审核和安全条件。',executionReady,canQueue:locallyEligible};
  }

  return {channel,score:Math.min(100,baseScore),status:'recommended',reason:`与${categoryLabel[site.category]}内容相关；${fit.reason}`,nextStep:channel.automation==='manual'?'可建立人工待办，准备材料后在平台完成提交。':'已具备本地执行条件；加入后仍按稿件审核和平台规则推进。',executionReady,canQueue:locallyEligible};
}

export function discoverChannels(site:Site,channels:Channel[]):ChannelDiscovery[]{
  const rank:Record<ChannelDiscoveryStatus,number>={recommended:0,worth_trying:1,needs_preparation:2,blocked:3};
  return channels.map(channel=>channelDiscoveryFor(site,channel)).sort((a,b)=>rank[a.status]-rank[b.status]||b.score-a.score||a.channel.name.localeCompare(b.channel.name));
}
