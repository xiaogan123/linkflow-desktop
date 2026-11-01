import type {ArticlePublicationContext,Channel,Site,Task} from '../shared/types';
import {articleContentHash} from './article-review';

export const LEAFMILL_SINGLE_ARTICLE_DRAFT_RULE='本次只写一篇具有独立使用价值的原创软件操作文档，准确说明具体操作与局限。目标链接仅用于读者核对公开软件版本；不得写推广软文、联盟导流、批量 SEO 文案或排名承诺。';
export const NETLIFY_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const ONEPUSH_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const DROPDEPLOY_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const RENDER_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const MDPAGE_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const OPENDOCS_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const PUBLISHMARKDOWN_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const MARKED_SHARE_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创 Markdown 技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const SHIPSTATIC_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限，并披露项目关系。目标链接仅用于核对原项目资料；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const AGENTEL_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站写一篇原创技术笔记，准确说明亲历步骤、失败条件和局限。正文必须用英文如实披露 AI assistant 作者与项目关系，并只出现一个完整原生目标 URL；总正文不得超过 5000 字符。不得写广告、联盟导流、金融建议、批量 SEO 内容或排名承诺。';
export const HOST0_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限。正文须如实写明由 AI assistant 编写及与项目的关系，只保留一个用于核对原项目资料的目标链接；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const DATAECHO_SINGLE_ARTICLE_DRAFT_RULE='本次只为一个真实软件网站制作一篇可独立使用的原创静态技术文档，说明操作步骤、适用条件与局限。正文须如实写明由 AI assistant 编写及与项目的关系，只保留一个用于核对原项目资料的目标链接；不得写广告、联盟导流、批量 SEO 页面、金融建议或排名承诺。';
export const CLAWPRINT_SINGLE_ARTICLE_DRAFT_RULE='本次只写一篇 AI 作者亲历的软件故障处理或开发记录，提供可独立使用的步骤、失败条件与局限，并如实披露与所提项目的关系。只保留一个相关项目出处链接；不得写广告、购买引导、联盟导流、金融建议、批量 SEO 文案或排名承诺。';

/** An unknown policy may reach review only for the sole planned Leafmill software document. */
export function leafmillSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='leafmill'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='leafmill'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='leafmill'&&item.id!==task.id).length===0;
}
export function netlifySingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='netlify'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='netlify'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='netlify'&&item.id!==task.id).length===0;
}
export function onepushSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='onepush'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='onepush'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='onepush'&&item.id!==task.id).length===0;
}
export function dropDeploySingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='dropdeploy'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='dropdeploy'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='dropdeploy'&&item.id!==task.id).length===0;
}
export function renderSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='render'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='render'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='render'&&item.id!==task.id).length===0;
}
export function mdpageSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='mdpage'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='mdpage'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='mdpage'&&item.id!==task.id).length===0;
}
export function opendocsSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='opendocs'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='opendocs'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='opendocs'&&item.id!==task.id).length===0;
}
export function publishMarkdownSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='publishmarkdown'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='publishmarkdown'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='publishmarkdown'&&item.id!==task.id).length===0;
}
export function markedShareSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='marked-share'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='marked-share'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='marked-share'&&item.id!==task.id).length===0;
}
export function shipstaticSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='shipstatic'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='shipstatic'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='shipstatic'&&item.id!==task.id).length===0;
}
export function host0SingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='host0'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='host0'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='host0'&&item.id!==task.id).length===0;
}
export function dataEchoSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='dataecho'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='dataecho'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='dataecho'&&item.id!==task.id).length===0;
}

export function agentelSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='agentel'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='agentel'||!task.channelId)&&tasks.filter(item=>item.channelId==='agentel'&&item.id!==task.id).length===0;
}
export function clawprintSingleArticleCandidate(tasks:readonly Task[],task:Pick<Task,'id'|'channelId'|'siteId'>,site:Site,channel:Channel):boolean{
  return channel.id==='clawprint'&&channel.singleSiteOnly===true&&site.category==='software'&&task.siteId===site.id
    &&(task.channelId==='clawprint'||!task.channelId)
    &&tasks.filter(item=>item.channelId==='clawprint'&&item.id!==task.id).length===0;
}

export function leafmillOriginalPurpose(task:Task):NonNullable<Task['leafmillOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function netlifyOriginalPurpose(task:Task):NonNullable<Task['netlifyOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function onepushOriginalPurpose(task:Task):NonNullable<Task['onepushOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function dropDeployOriginalPurpose(task:Task):NonNullable<Task['dropDeployOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function renderOriginalPurpose(task:Task):NonNullable<Task['renderOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function mdpageOriginalPurpose(task:Task):NonNullable<Task['mdpageOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function opendocsOriginalPurpose(task:Task):NonNullable<Task['opendocsOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function publishMarkdownOriginalPurpose(task:Task):NonNullable<Task['publishMarkdownOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function markedShareOriginalPurpose(task:Task):NonNullable<Task['markedShareOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function shipstaticOriginalPurpose(task:Task):NonNullable<Task['shipstaticOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function host0OriginalPurpose(task:Task):NonNullable<Task['host0OriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function dataEchoOriginalPurpose(task:Task):NonNullable<Task['dataechoOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function agentelOriginalPurpose(task:Task):NonNullable<Task['agentelOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}
export function clawprintOriginalPurpose(task:Task):NonNullable<Task['clawprintOriginalPurpose']>{
  return {version:1,taskId:task.id,siteId:task.siteId,draftRevision:task.draftRevision??0,
    contentHash:articleContentHash(task),source:'single_original_software_draft_request'};
}

export function currentArticlePublicationContext(tasks:readonly Task[],task:Task):ArticlePublicationContext{
  const base=visibleArticlePublicationContext(tasks,task),purpose=task.channelId==='leafmill'?task.leafmillOriginalPurpose
    :task.channelId==='clawprint'?task.clawprintOriginalPurpose
    :task.channelId==='marked-share'?task.markedShareOriginalPurpose
    :task.channelId==='publishmarkdown'?task.publishMarkdownOriginalPurpose
    :task.channelId==='opendocs'?task.opendocsOriginalPurpose
    :task.channelId==='mdpage'?task.mdpageOriginalPurpose
    :task.channelId==='render'?task.renderOriginalPurpose
    :task.channelId==='dropdeploy'?task.dropDeployOriginalPurpose
    :task.channelId==='onepush'?task.onepushOriginalPurpose
    :task.channelId==='netlify'?task.netlifyOriginalPurpose
    :task.channelId==='shipstatic'?task.shipstaticOriginalPurpose
    :task.channelId==='dataecho'?task.dataechoOriginalPurpose
    :task.channelId==='host0'?task.host0OriginalPurpose
    :task.channelId==='agentel'?task.agentelOriginalPurpose:undefined;
  if(!purpose||purpose.version!==1||purpose.source!=='single_original_software_draft_request'
    ||purpose.taskId!==task.id||purpose.siteId!==task.siteId||purpose.draftRevision!==(task.draftRevision??0)
    ||purpose.contentHash!==articleContentHash(task)||!task.draft)return base;
  return {...base,publicationIntent:'single_original_article',workflowPurpose:'expand_backlink_channels',knownContentPattern:'unknown'};
}

/** Only aggregate visible local tasks; this is not a claim about all remote activity. */
export function visibleArticlePublicationContext(tasks:readonly Task[],task:Pick<Task,'channelId'|'accountId'>):ArticlePublicationContext{
  let sameChannelTasks=0,sameAccountTasks=0;
  const sites=new Set<string>();
  for(const item of tasks){
    if(item.channelId===task.channelId){sameChannelTasks++;sites.add(item.siteId)}
    if(task.accountId&&item.accountId===task.accountId)sameAccountTasks++;
  }
  return {scope:'visible_workspace_only',sameChannelTasks,...(task.accountId?{sameAccountTasks}:{}),distinctSites:sites.size,publicationIntent:'unknown'};
}
