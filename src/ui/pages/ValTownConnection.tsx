import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function ValTownConnection({data,disabled,account,onClose,onAction}:Props){
  const existing=data?.accountBindings.find(binding=>binding.accountId===account?.id)?.siteId??'';
  const [token,setToken]=useState(''),[siteId,setSiteId]=useState(existing),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),enabled=data?.channels.some(channel=>channel.id==='valtown'&&channel.enabled)===true;
  async function connect(){
    if(inFlight.current||disabled||!token.trim()||!siteId)return;
    inFlight.current=true;setBusy(true);setError('');
    try{
      const result=await onAction<Account>('account:connect-valtown',{token:token.trim(),siteIds:[siteId],...(account?{accountId:account.id}:{})},'Val Town 账号已连接');
      if(result)onClose();else setError('连接未完成，请查看提示并核对免费账号、密钥权限及有效期。');
    }catch{setError('连接未完成，请查看提示后重试。');}
    finally{setToken('');setBusy(false);inFlight.current=false;}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Val Town">
    <header><h2>{account?'关联 Val Town 网站':'连接 Val Town'}</h2><button className="icon-button" aria-label="关闭 Val Town 连接" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className="drawer-form">
      <p className="drawer-intro">连接免费个人账号，用于符合平台规则的原创软件文档。保存后复用连接，稿件仍须通过检查并按计划发布。</p>
      {!enabled&&<p className="account-diagnostic" role="status">这个平台暂未开放自动发布，可以先保存连接。</p>}
      <Field label="Val Town API 密钥" hint="仅加密保存在本机；连接检查不会发布内容或开通付费方案。"><input aria-label="Val Town API 密钥" type="password" autoComplete="new-password" value={token} disabled={disabled||busy} onChange={event=>setToken(event.target.value)}/></Field>
      <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://www.val.town/settings/api'})}>打开 Val Town 密钥设置<ArrowSquareOut size={13}/></Button>
      <p className="drawer-intro">密钥需要 Users 只读、Vals 读写权限。首次注册或登录可能需要本人完成验证。</p>
      {account&&<p className="drawer-intro">关联网站请使用原密钥。需要更换密钥时，先处理完待检查的发布，再退役旧连接并添加新连接；历史记录会保留。</p>}
      <Field label="用于网站"><select aria-label="Val Town 用于网站" value={siteId} disabled={disabled||busy} onChange={event=>setSiteId(event.target.value)}><option value="">选择网站</option>{(data?.sites??[]).map(site=><option key={site.id} value={site.id}>{site.domain}</option>)}</select></Field>
      {error&&<p role="alert" className="account-diagnostic">{error}</p>}
      <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!token.trim()||!siteId} onClick={()=>void connect()}>{busy?'正在核对并连接…':'连接并保存'}</Button></div>
    </div>
  </aside></div>;
}
