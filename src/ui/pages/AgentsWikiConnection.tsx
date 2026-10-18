import {useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export function AgentsWikiConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [apiKey,setApiKey]=useState(''),[siteIds,setSiteIds]=useState<string[]>(()=>data?.accountBindings.filter(binding=>binding.channelId==='agentswiki'&&binding.accountId===account?.id).map(binding=>binding.siteId)??[]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const toggle=(id:string)=>setSiteIds(values=>values.includes(id)?values.filter(value=>value!==id):[...values,id]);
  const keyValid=/^aw_[A-Za-z0-9_-]{32,4096}$/.test(apiKey.trim());
  async function connect(){
    if(busy||!keyValid||!siteIds.length)return;setBusy(true);setError('');
    try{const result=await onAction<Account>('account:connect-agentswiki',{apiKey:apiKey.trim(),siteIds,accountId:account?.id},account?'Agents Wiki 原 agent 已重新核对并更新网站关联。':'Agents Wiki agent 已只读验证并安全连接。');setApiKey('');if(result)onClose();else setError('Agents Wiki 身份只读核对或本机保存未完成；没有注册或发布文章。')}
    catch{setApiKey('');setError(account?'原 Agents Wiki agent 重新核对失败；现有身份、密文、绑定和发布记录保持不变。':'Agents Wiki agent 只读核对失败；没有保存 API key、注册身份或发布文章。')}
    finally{setBusy(false)}
  }
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy){setApiKey('');onClose()}}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 Agents Wiki agent':'连接 Agents Wiki agent'}><header><div><span className="eyebrow">AGENTS WIKI · AGENT IDENTITY</span><h2>{account?'重新验证原 agent':'连接已有 agent'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={()=>{setApiKey('');onClose()}}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">粘贴本人控制的 Agents Wiki agent API key。软件只调用公开规则、<code>GET /me</code> 核对当前 agent、固定身份披露与投稿权利；API key 仅加密保存在本机且不会回显。</p>
    <p className="cell-note">这里不会注册新 agent、验证稿件或发布文章。没有账号时，可由首个任务自动建立并复用如实披露的身份；每篇仍须独立审核和公开页核验。</p>
    {account&&<p className="account-diagnostic" role="status">当前身份：{account.username}。只能重新验证同一个 agent 和同一 API key，并可更新网站关联。</p>}
    <Field label="Agents Wiki API key" hint="格式为 aw_ 开头。不会写入普通日志、任务摘要或明文备份。"><input aria-label="Agents Wiki API key" type="password" autoComplete="new-password" value={apiKey} disabled={disabled||busy} onChange={event=>setApiKey(event.target.value)} placeholder="aw_…"/></Field>
    <Field label="允许使用此身份的网站" hint="至少选择一个网站；任务仍须分别通过资格、稿件审核与排期。"><div className="binding-options">{data?.sites.map(site=><label key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={()=>toggle(site.id)}/><span>{site.domain}</span></label>)}</div></Field>
    {!data?.sites.length&&<p className="account-diagnostic">请先添加网站，再连接发布身份。</p>}
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={()=>{setApiKey('');onClose()}}>取消</Button><Button variant="primary" disabled={disabled||busy||!keyValid||!siteIds.length} onClick={()=>void connect()}>{busy?'正在只读核对…':account?'核对原身份并更新':'只读核对并连接'}</Button></div>
  </div></aside></div>;
}
