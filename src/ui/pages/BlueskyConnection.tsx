import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};

export function BlueskyConnection({data,disabled,account,onClose,onAction}:Props){
  const [handle,setHandle]=useState(account?.displayName?.replace(/^@/,'')??'');
  const [password,setPassword]=useState('');
  const [siteIds,setSiteIds]=useState<string[]>((data?.accountBindings??[]).filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const busyRef=useRef(false);
  const connect=async()=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
    try{
      const result=await onAction<Account>('account:connect-bluesky',{handle:handle.trim(),appPassword:password,accountId:account?.id,siteIds,mailboxId:account?account.mailboxId??null:undefined},'Bluesky 身份和网站已连接，将按计划发布原创短内容。');
      setPassword('');
      if(!result){setError('连接未完成。请确认账号和应用专用密码，再试一次。');return;}
      onClose();
    }finally{busyRef.current=false;setBusy(false);setPassword('');}
  };
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Bluesky"><header><div><span className="eyebrow">BLUESKY / 短内容分发</span><h2>{account?'更新 Bluesky 连接':'连接 Bluesky'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">连接本人账号并选择网站。软件会基于真实文章准备原创短帖、独立审核、发布并核验公开链接。每账号至少间隔一天；短帖和完整文章分别显示。</p>
    <Field label="账号名称" hint="例如 author.bsky.social；目前仅支持 Bluesky 托管账号。"><input aria-label="Bluesky 账号名称" value={handle} onChange={event=>setHandle(event.target.value)} autoComplete="username" disabled={disabled||busy}/></Field>
    <Field label="应用专用密码" hint="在 Bluesky 设置中创建供外链助手使用的专用密码，不填写账号主密码。凭据仅加密保存在本机。"><input aria-label="Bluesky 应用专用密码" type="password" autoComplete="new-password" value={password} onChange={event=>setPassword(event.target.value)} disabled={disabled||busy}/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://bsky.app/settings/app-passwords'})}>打开应用密码设置<ArrowSquareOut size={13}/></Button>
    <p className="cell-note">同一账号可服务多个相关网站；先选择要使用的网站，任务会分散排期。</p><fieldset className="checkbox-grid"><legend>用于哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!handle.trim()||!password} onClick={()=>void connect()}>{busy?'正在验证…':'验证并连接'}</Button></div>
  </div></aside></div>;
}
