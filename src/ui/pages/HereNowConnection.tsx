import {useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};

export function HereNowConnection({data,disabled,account,onClose,onAction}:Props){
  const [apiKey,setApiKey]=useState(''),[existingSiteUrl,setExistingSiteUrl]=useState(account?.hereNow?.existingSiteUrl??''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='here-now'&&binding.accountId===account?.id).map(binding=>binding.siteId));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const running=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(running.current)void onAction('account:cancel-here-now',{}).catch(()=>undefined)}},[]);
  const keyValid=/^hnk_[A-Za-z0-9_-]{16,8188}$/.test(apiKey.trim());
  const keyReady=keyValid||(!!account&&!apiKey.trim());
  const pageValid=!existingSiteUrl.trim()||/^https:\/\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\.here\.now\/$/.test(existingSiteUrl.trim());
  async function connect(){
    if(running.current||!keyReady||!pageValid)return;
    running.current=true;setBusy(true);setError('');
    try{
      const payload={...(apiKey.trim()?{apiKey:apiKey.trim()}:{}),existingSiteUrl:existingSiteUrl.trim()||undefined,siteIds:[...new Set(siteIds)],accountId:account?.id};
      const saved=await onAction<Account>('account:connect-here-now',payload,account?'here.now 个人发布账号已重新验证。':'here.now 个人发布账号已连接。');
      if(saved&&alive.current){setApiKey('');onClose()}else if(alive.current)setError('未完成发布账号验证；没有创建页面或更改原连接。');
    }catch{if(alive.current)setError(account?'原连接验证未完成；已保留原 key 、页面和网站关联。':'请核对命名 密钥 与已有页面归属；未发送发布请求。')}
    finally{running.current=false;if(alive.current)setBusy(false)}
  }
  async function cancel(){setApiKey('');if(running.current)await onAction('account:cancel-here-now',{}).catch(()=>undefined);if(alive.current)onClose()}
  const toggle=(id:string,checked:boolean)=>setSiteIds(current=>checked?[...current.filter(value=>value!==id),id]:current.filter(value=>value!==id));
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancel()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 here.now 连接':'连接 here.now 个人账户'}><header><div><h2>{account?'重新验证现有连接':'一次连接个人账户'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={()=>void cancel()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">粘贴已验证邮箱的个人账户里创建的命名密钥。外链助手会先检查邮箱、个人账户和可选的已有页面，然后把密钥加密保存在电脑密钥库。</p>
    <p className="cell-note">连接不会创建、更新或认领页面。匿名页仅保留 24 小时，不作为永久页面或所有权证明。</p>
    {account&&<p className="account-diagnostic" role="status">已连接发布账号：{account.email}。如原发布仍待对账，软件会拒绝切换到另一把 key 或另一发布账号。</p>}
    <Field label="命名 密钥" hint={account?'留空则使用电脑密钥库中已保存的 key；粘贴新 key 仅用于更换同一个人账号的密钥。':'格式 hnk_…；只在本机加密保存，列表不会回显。'}><input aria-label="here.now 命名 密钥" type="password" autoComplete="new-password" value={apiKey} disabled={disabled||busy} onChange={event=>setApiKey(event.target.value)} placeholder={account?'留空使用已保存 key':'hnk_…'}/></Field>
    <Field label="已有页面（可选）" hint="检查该页面是否属于当前个人账户。需要完整 https://slug.here.now/ 地址。"><input aria-label="here.now 已有页面" type="url" value={existingSiteUrl} disabled={disabled||busy} onChange={event=>setExistingSiteUrl(event.target.value)} placeholder="https://your-page.here.now/"/></Field>
    {!pageValid&&<p role="alert" className="account-diagnostic">页面地址必须是不带路径、查询或锚点的 here.now HTTPS 根地址。</p>}
    <fieldset className="checkbox-grid" disabled={disabled||busy}><legend>允许哪些网站使用该个人发布账号</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={event=>toggle(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
    {busy&&<p className="drawer-intro" role="status">正在检查个人账户；不会发送发布请求…</p>}{error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={disabled&&!busy} onClick={()=>void cancel()}>{busy?'取消验证':'取消'}</Button><Button variant="primary" disabled={disabled||busy||!keyReady||!pageValid} onClick={()=>void connect()}>{busy?'正在验证…':account?(apiKey.trim()?'验证原发布账号并更新':'用已保存 key 验证并更新'):'只读验证并连接'}</Button></div>
  </div></aside></div>;
}
