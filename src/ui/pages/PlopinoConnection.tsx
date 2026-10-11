import {useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export function PlopinoConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [email,setEmail]=useState(account?.email??''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='plopino'&&binding.accountId===account?.id).map(binding=>binding.siteId));
  async function connect(){if(busy)return;setBusy(true);setError('');try{const saved=await onAction<Account>('account:connect-plopino',{email:email.trim(),password,siteIds,accountId:account?.id},'Plopino 账号已通过官方登录与 /me 归属核验。');if(saved)onClose();else setError('登录或账号归属未能确认；未保存新连接。')}finally{setPassword('');setBusy(false)}}
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'更新 Plopino 连接':'连接 Plopino 账号'}><header><div><span className="eyebrow">PLOPINO ACCOUNT</span><h2>{account?'重新验证原账号':'连接已有账号'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">这里只需要邮箱和密码，不要求复制 token。登录后会立即读取 <code>/api/auth/me</code> 精确核对账号，凭据和会话只加密保存在本机。</p>
    <p className="cell-note">没有账号时也可以直接关闭：任务真正需要时，会使用网站已授权的邮箱自动建立一个账号。注册结果不明时保留原意图，不会换账号或重复注册。</p>
    <Field label="登录邮箱"><input aria-label="Plopino 登录邮箱" type="email" autoComplete="email" value={email} disabled={disabled||busy||!!account} onChange={event=>setEmail(event.target.value)}/></Field>
    <Field label="登录密码" hint="仅用于 Plopino 官方登录，不会在列表或日志中显示。"><input aria-label="Plopino 登录密码" type="password" autoComplete="current-password" value={password} disabled={disabled||busy} onChange={event=>setPassword(event.target.value)}/></Field>
    <fieldset className="checkbox-grid"><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!/^[^\s@]+@[^\s@]+$/.test(email.trim())||password.length<6} onClick={()=>void connect()}>{busy?'正在验证…':'登录并连接'}</Button></div>
  </div></aside></div>
}
