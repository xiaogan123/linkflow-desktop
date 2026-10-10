import type {Account} from '../shared/types';
import {isDenoReadAccessAccount,isMarkestReadAccessAccount,type ConnectionChannelId,type ConnectionOverviewRow} from './channel-connections';

export type ConnectionGroup='attention'|'connectable'|'connected'|'automatic'|'secondary';
export type ConnectionAction={kind:'connect'|'locate'|'none';label?:string};
export type AccountReadiness={needsAttention:boolean;reusable:boolean};

const secondaryIds=new Set<ConnectionChannelId>(['deno','markest']);
const dedicatedIds=new Set<ConnectionChannelId>(['mataroa','paper-wf','hive','prose','markest','deno','github-gist','blogger','wordpress-com','leaflet','paragraph','bluesky']);
const bindingIds=new Set<string>(['hive','prose','blogger','wordpress-com','leaflet','paragraph','bluesky']);

const actionLabels:Partial<Record<ConnectionChannelId,string>>={
  mataroa:'连接 Mataroa',
  'paper-wf':'连接 Paper.wf',
  hive:'连接 Hive',
  prose:'只读验证 SSH 身份',
  markest:'只读验证个人 key',
  deno:'只读验证专用应用',
  'github-gist':'连接 GitHub Gist',
  blogger:'授权 Blogger',
  'wordpress-com':'查看 WordPress.com 授权',
  leaflet:'连接 Leaflet',
  paragraph:'连接 Paragraph',
  bluesky:'连接 Bluesky',
};

export function connectionGroup(row:ConnectionOverviewRow):ConnectionGroup{
  if(secondaryIds.has(row.id)||row.state==='read_only'||row.state==='unavailable')return 'secondary';
  if(row.state==='attention')return 'attention';
  if(row.state==='connected')return 'connected';
  if(row.state==='first_connection')return 'connectable';
  return 'automatic';
}

export function groupConnections(rows:ConnectionOverviewRow[],query=''):Record<ConnectionGroup,ConnectionOverviewRow[]>{
  const normalized=query.trim().toLowerCase(),result:Record<ConnectionGroup,ConnectionOverviewRow[]>={attention:[],connectable:[],connected:[],automatic:[],secondary:[]};
  for(const row of rows){
    if(normalized&&!`${row.name} ${row.id} ${row.format} ${row.detail}`.toLowerCase().includes(normalized))continue;
    result[connectionGroup(row)].push(row);
  }
  return result;
}

export function connectionAction(row:ConnectionOverviewRow):ConnectionAction{
  if(row.state==='attention'&&!dedicatedIds.has(row.id))return {kind:'locate',label:'查看保存的身份'};
  if(!dedicatedIds.has(row.id))return {kind:'none'};
  if(row.state==='no_setup'&&row.id!=='mataroa')return {kind:'none'};
  if(row.state==='unavailable'&&!['prose','leaflet','wordpress-com'].includes(row.id))return {kind:'none'};
  if(row.state==='attention'&&row.attentionAccountId)return {kind:'connect',label:'处理原连接'};
  if(row.state==='connected')return {kind:'connect',label:'管理或新增连接'};
  return {kind:'connect',label:actionLabels[row.id]??'打开专用连接'};
}

export function activateGuideSelection(row:ConnectionOverviewRow,callbacks:{close:()=>void;connect:(id:ConnectionChannelId,accountId?:string)=>void;locate:(row:ConnectionOverviewRow)=>void}):void{
  const action=connectionAction(row);
  if(action.kind==='none')return;
  callbacks.close();
  if(action.kind==='locate')callbacks.locate(row);
  else callbacks.connect(row.id,row.attentionAccountId);
}

function accountFacts(account:Account,boundSiteCount:number,channelEnabled:boolean){
  const readOnlyChannel=account.channelId==='deno'||account.channelId==='markest';
  const validReadOnly=isDenoReadAccessAccount(account)||isMarkestReadAccessAccount(account);
  const needsRepair=['credentials_invalid','restricted'].includes(account.status)||!!account.diagnostic;
  const missingSecret=!account.hasPassword;
  const incomplete=account.status!=='registered';
  const missingBinding=channelEnabled&&bindingIds.has(account.channelId)&&boundSiteCount===0;
  return {readOnlyChannel,validReadOnly,needsRepair,missingSecret,incomplete,missingBinding};
}

export function accountReadiness(account:Account,boundSiteCount:number,channelEnabled:boolean):AccountReadiness{
  const {readOnlyChannel,validReadOnly,needsRepair,missingSecret,incomplete,missingBinding}=accountFacts(account,boundSiteCount,channelEnabled);
  if(validReadOnly)return {needsAttention:false,reusable:false};
  const needsAttention=readOnlyChannel||needsRepair||missingSecret||incomplete||missingBinding;
  return {needsAttention,reusable:channelEnabled&&!readOnlyChannel&&!needsAttention};
}

export function accountNextStep(account:Account,boundSiteCount:number,channelEnabled:boolean):string{
  const {readOnlyChannel,validReadOnly,needsRepair,missingSecret,incomplete,missingBinding}=accountFacts(account,boundSiteCount,channelEnabled);
  if(validReadOnly)return '只读验证完成 · 发布未启用';
  if(readOnlyChannel)return '只读连接待检查 · 发布未启用';
  if(!channelEnabled){
    if(needsRepair)return '连接需处理 · 渠道当前未启用';
    if(missingSecret)return '凭据需恢复 · 渠道当前未启用';
    if(incomplete)return '状态待确认 · 渠道当前未启用';
    return '连接已保存 · 渠道当前未启用';
  }
  if(account.channelId==='prose'&&account.status==='needs_verification')return '下一步：确认邀请与真实发布资格';
  if(['mataroa','paper-wf'].includes(account.channelId)&&account.source==='generated'&&account.status==='needs_verification')return '下一步：完成原账号首次验证';
  if(needsRepair)return '下一步：处理原连接或平台限制';
  if(missingSecret)return '下一步：恢复或重新连接凭据';
  if(incomplete)return '已保存 · 下一步：确认平台账号状态';
  if(missingBinding)return '下一步：关联至少一个网站';
  return boundSiteCount>0?`已连接 · 已关联 ${boundSiteCount} 个网站，待任务检查`:'已连接 · 待任务检查';
}

export function needsDedicatedConnection(id:string):boolean{return dedicatedIds.has(id as ConnectionChannelId)}
