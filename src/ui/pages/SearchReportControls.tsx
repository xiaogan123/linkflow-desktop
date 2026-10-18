import {useState} from 'react';
import type {Site,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export type ReportAction=(command:string,payload?:unknown,success?:string)=>Promise<unknown>;
export function SearchReportControls({site,data,disabled,onAction}:{site:Site;data:Snapshot;disabled:boolean;onAction:ReportAction}){
  const [key,setKey]=useState('');
  return <div className="search-report-grid tracking-controls">
    <div><h3>Google Search Console</h3><p>{site.searchReports?.gsc?.message??'尚未导入来源网页报告。'}</p><small>选择本站的“来源网页”CSV，可一次导入多个文件。多个 Google 账号请先在 GSC 切换到有本站权限的账号；联系邮箱不代表 GSC 账号。</small><div className="card-actions"><Button disabled={disabled} onClick={()=>void onAction('external:open',{url:'https://search.google.com/search-console/links?resource_id='+encodeURIComponent('sc-domain:'+site.domain)})}>打开 GSC</Button><Button disabled={disabled} onClick={()=>void onAction('search:import-gsc',{id:site.id})}>导入本站 CSV</Button></div></div>
    <div><h3>Bing Webmaster Tools</h3><p>{site.searchReports?.bing?.message??(data.settings.hasBingKey?'已连接，尚未检查本站首页来源样本。':'尚未连接 Bing API Key。')}</p><small>仅检查本站首页，最多前 10 页样本，不能代表全站外链。</small><div className="card-actions"><Button disabled={disabled||!data.settings.hasBingKey} onClick={()=>void onAction('search:bing',{id:site.id})}>检查本站 Bing</Button><Button disabled={disabled} onClick={()=>void onAction('external:open',{url:'https://www.bing.com/webmasters/?siteUrl='+encodeURIComponent(site.url.replace(/\/$/,'')+'/')})}>打开 Bing</Button></div><details className="advanced-settings"><summary>{data.settings.hasBingKey?'更新 Bing 连接':'连接 Bing API Key'}</summary><Field label="Bing Webmaster API Key" hint="只在本机加密保存，不会发给 AI"><input type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)}/></Field><Button disabled={disabled||!key.trim()} onClick={async()=>{const result=await onAction('search:save-key',{key,enabled:true},'Bing 连接已保存。');if(result){setKey('');await onAction('search:bing',{id:site.id})}}}>保存并检查</Button></details><label className="checkbox"><input type="checkbox" checked={!!data.settings.monitorSearch} disabled={disabled||!data.settings.hasBingKey} onChange={e=>void onAction('settings:save',{monitorSearch:e.target.checked})}/>自动检查 Bing（客户端运行时，每站每天一次）</label></div>
  </div>;
}
