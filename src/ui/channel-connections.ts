import type {Account,Snapshot} from '../shared/types';

export type ConnectionChannelId='mataroa'|'verbose'|'rentry'|'lucid-page'|'betterthanhtml'|'paper-wf'|'hive'|'prose'|'nostr'|'github-gist'|'telegraph'|'blogger'|'wordpress-com'|'leaflet'|'paragraph'|'bluesky';
export type ConnectionState='no_setup'|'first_connection'|'attention'|'connected'|'unavailable';
export interface ConnectionOverviewRow {
  id:ConnectionChannelId;
  name:string;
  format:'全文'|'短帖';
  state:ConnectionState;
  detail:string;
  connectedCount:number;
  boundSiteCount:number;
  checkedCount:number;
  attentionAccountId?:string;
}

const channels:{id:ConnectionChannelId;name:string;format:'全文'|'短帖';firstStep:string}[]=[
  {id:'mataroa',name:'Mataroa',format:'全文',firstStep:'任务需要时自动建号；遇平台验证则保留原身份。'},
  {id:'verbose',name:'Verbose.blog',format:'全文',firstStep:'实验渠道可在任务需要时自动建号；一次性令牌无法补发。'},
  {id:'rentry',name:'Rentry',format:'全文',firstStep:'无需注册账号；任务自动保存本机编辑凭据后发布。'},
  {id:'lucid-page',name:'Lucid.page',format:'全文',firstStep:'无需注册账号；匿名发布后修改或删除需先认领。'},
  {id:'betterthanhtml',name:'Better Than HTML',format:'全文',firstStep:'无需注册账号；任务直接发布静态全文，尚未确认文章修改或删除接口。'},
  {id:'paper-wf',name:'Paper.wf',format:'全文',firstStep:'可连接已有账号；自动建号可能需要首次人机验证。'},
  {id:'hive',name:'Hive',format:'全文',firstStep:'连接本人账号的 posting key，再选择要使用的网站。'},
  {id:'prose',name:'Prose',format:'全文',firstStep:'粘贴本人受邀身份的专用 SSH 私钥，只读核对身份后选择网站。'},
  {id:'nostr',name:'Nostr',format:'全文',firstStep:'任务需要时自动建立作者身份。'},
  {id:'github-gist',name:'GitHub Gist',format:'全文',firstStep:'连接已有 GitHub 账号的 Gists 令牌。'},
  {id:'telegraph',name:'Telegraph',format:'全文',firstStep:'任务需要时自动建立作者身份。'},
  {id:'blogger',name:'Blogger',format:'全文',firstStep:'首次完成 Google 授权，再选择博客和网站。'},
  {id:'wordpress-com',name:'WordPress.com',format:'全文',firstStep:'首次在浏览器授权，再选择已公开博客和要关联的网站。'},
  {id:'leaflet',name:'Leaflet',format:'全文',firstStep:'首次连接本人 Bluesky 托管账号的应用密码，之后发布完整文章。'},
  {id:'paragraph',name:'Paragraph',format:'全文',firstStep:'连接已有 publication 的 API key，并选择网站。'},
  {id:'bluesky',name:'Bluesky',format:'短帖',firstStep:'连接已有账号的 app password，并选择网站。'},
];
const needsBinding=new Set<ConnectionChannelId>(['hive','prose','blogger','wordpress-com','leaflet','paragraph','bluesky']);
const selfProvisioned=new Set<ConnectionChannelId>(['mataroa','verbose','telegraph','nostr','rentry','lucid-page','betterthanhtml']);

function usable(account:Account,id:ConnectionChannelId){
  return account.status==='registered'&&account.hasPassword&&account.credentialKind===(id==='blogger'||id==='wordpress-com'?'oauth':'api_token');
}

export function connectionOverview(data:Pick<Snapshot,'accounts'|'accountBindings'|'sites'|'tasks'|'channels'>|null):ConnectionOverviewRow[]{
  if(!data)return [];
  return channels.map(({id,name,format,firstStep})=>{
    const accounts=data.accounts.filter(account=>account.channelId===id);
    const connected=accounts.filter(account=>usable(account,id));
    const connectedIds=new Set(connected.map(account=>account.id));
    const accountById=new Map(connected.map(account=>[account.id,account]));
    const boundSiteIds=new Set(data.accountBindings.filter(binding=>{
      if(binding.channelId!==id||!connectedIds.has(binding.accountId))return false;
      const site=data.sites.find(candidate=>candidate.id===binding.siteId);
      if(!site)return false;
      if(id==='blogger')return !!site.blogger?.blogId;
      if(id==='paragraph')return !!site.paragraph?.publicationId&&site.paragraph.publicationId===accountById.get(binding.accountId)?.username;
      return true;
    }).map(binding=>binding.siteId));
    // firstLiveAt is historical evidence even if the latest check later changes to absent.
    const checkedCount=data.tasks.filter(task=>task.channelId===id&&(!!task.firstLiveAt||task.linkCheck==='found')).length;
    const issue=accounts.find(account=>!usable(account,id));
    const unbound=needsBinding.has(id)&&connected.length>0&&data.sites.length>0&&boundSiteIds.size===0;
    let state:ConnectionState;
    let detail:string;
    if(!data.channels.find(channel=>channel.id===id&&channel.enabled)){
      state='unavailable';detail=id==='prose'?'可只读验证本人专用 SSH/SFTP 身份；邀请与真实发布资格尚待验收，当前不会自动发布。':id==='leaflet'?'真实授权和公开全文发布尚待验收；当前不会自动发布。':id==='wordpress-com'?'浏览器授权和真实公开发布尚待验收；原身份与历史记录保留。':'渠道当前停用，不参与自动任务；原身份与历史记录保留。';
    }else if(selfProvisioned.has(id)&&!issue){state='no_setup';detail=firstStep;}
    else if(!accounts.length){state='first_connection';detail=firstStep;}
    else if(issue){
      state='attention';
      detail=id==='verbose'?'原身份或一次性令牌需检查；不能重新注册换号。':['mataroa','paper-wf'].includes(id)&&issue.status==='needs_verification'?'首次验证待完成；沿用下方原身份继续，勿重复注册。':`${accounts.length-connected.length} 个本机身份需检查凭据或状态。`;
    }else if(unbound){state='attention';detail='身份已保存在本机，尚未关联可发布的网站。';}
    else {state='connected';detail=`${connected.length} 个本机身份已连接${needsBinding.has(id)?`，${boundSiteIds.size} 个网站已关联`:''}。`;}
    return {id,name,format,state,detail,connectedCount:connected.length,boundSiteCount:boundSiteIds.size,checkedCount,attentionAccountId:issue?.id??(unbound?connected[0]?.id:undefined)};
  });
}
