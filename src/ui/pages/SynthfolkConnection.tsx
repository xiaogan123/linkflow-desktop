import {useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export function SynthfolkConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [apiKey,setApiKey]=useState(''),[siteIds,setSiteIds]=useState<string[]>(()=>(data?.accountBindings??[]).filter(binding=>binding.channelId==='synthfolk'&&binding.accountId===account?.id).map(binding=>binding.siteId)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const toggle=(id:string)=>setSiteIds(values=>values.includes(id)?values.filter(value=>value!==id):[...values,id]);
  async function connect(){if(busy||apiKey.trim().length<20||!siteIds.length)return;setBusy(true);setError('');try{const saved=await onAction<Account>('account:connect-synthfolk',{apiKey:apiKey.trim(),siteIds,accountId:account?.id},'Synthfolk 公开账号已检查并安全连接。');setApiKey('');if(saved)onClose();else setError('Synthfolk 账号检查或本机保存没完成；没有注册、编辑或覆盖公开资料。')}catch{setApiKey('');setError(account?'原 Synthfolk 发布账号重新核对失败；现有发布账号和用于保持不变。':'Synthfolk 账号检查失败；没有保存密钥，也没有注册。')}finally{setBusy(false)}}
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy){setApiKey('');onClose()}}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Synthfolk"><header><div><h2>{account?'重新核对已有发布账号':'连接已有公开发布账号'}</h2></div><button className="icon-button" disabled={busy} onClick={()=>{setApiKey('');onClose()}} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">普通任务可以先生成与本站相关的真实公开资料，经 AI 复核后再执行一次注册。这里只用 <code>GET /api/v1/me</code> 和公开资料接口核对已有发布账号；不会注册、修改资料或更换 handle。</p>
    <Field label="Synthfolk API key" hint="密钥只加密保存在本机，不会回显。"><input type="password" autoComplete="new-password" disabled={disabled||busy} value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder="anp_…"/></Field>
    <Field label="关联网站" hint="只能选择其首页或已发现主题地址与该公开资料 Website 精确一致的网站。"><div className="binding-options">{data?.sites.map(site=><label key={site.id}><input type="checkbox" disabled={disabled||busy} checked={siteIds.includes(site.id)} onChange={()=>toggle(site.id)}/><span>{site.domain}</span></label>)}</div></Field>
    {!data?.sites.length&&<p className="account-diagnostic">请先添加网站，再连接公开发布账号。</p>}{error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={()=>{setApiKey('');onClose()}}>取消</Button><Button variant="primary" disabled={disabled||busy||apiKey.trim().length<20||!siteIds.length} onClick={()=>void connect()}>{busy?'正在检查…':account?'核对原发布账号并更新用于':'检查并连接'}</Button></div>
  </div></aside></div>;
}
