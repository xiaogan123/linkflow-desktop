import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function LeafletConnection({data,disabled,account,onClose,onAction}:Props){
  const [handle,setHandle]=useState(account?.username??''),[password,setPassword]=useState('');
  const [siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),inFlight=useRef(false);
  const enabled=!!data?.channels.find(channel=>channel.id==='leaflet'&&channel.enabled);
  async function connect(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    try{
      const result=await onAction<Account>('account:connect-leaflet',{handle:handle.trim(),appPassword:password,siteIds,accountId:account?.id},enabled?'Leaflet 身份已连接，所选网站将按计划准备和审核全文。':'Leaflet 身份已验证保存；渠道尚待实发验收，不会开始发布。');
      if(result)onClose();else setError('连接未完成，请检查账号和应用专用密码；原任务保留。');
    }finally{setPassword('');setBusy(false);inFlight.current=false;}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Leaflet"><header><div><span className="eyebrow">LEAFLET / 全文发布</span><h2>{account?'更新 Leaflet 连接':'连接 Leaflet'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">使用本人已有的 Bluesky 托管账号在 Leaflet 发布完整文章。首次连接后可自动写稿、独立审核和核验；这不会另外发布 Bluesky 短帖，也不会自动注册账号。</p>
    {!enabled&&<p className="account-diagnostic" role="status">此渠道尚待真实发布验收，当前只验证并保存连接，不参与自动任务。</p>}
    <Field label="账号名称" hint="例如 author.bsky.social；只支持 Bluesky 托管账号。"><input aria-label="Leaflet 账号名称" autoComplete="username" value={handle} disabled={disabled||busy} onChange={event=>setHandle(event.target.value)}/></Field>
    <Field label="应用专用密码" hint="在 Bluesky 设置中为 Leaflet 连接创建专用密码，不填写主密码。只加密保存在本机。"><input aria-label="Leaflet 应用专用密码" type="password" autoComplete="new-password" value={password} disabled={disabled||busy} onChange={event=>setPassword(event.target.value)}/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://bsky.app/settings/app-passwords'})}>打开应用密码设置<ArrowSquareOut size={13}/></Button>
    <p className="cell-note">同一作者可关联多个相关网站，任务分散排期。公开文章可能被其他 AT Protocol 服务同步保存。</p>
    <fieldset className="checkbox-grid"><legend>用于哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!handle.trim()||!password} onClick={()=>void connect()}>{busy?'正在验证…':'验证并连接'}</Button></div>
  </div></aside></div>;
}
