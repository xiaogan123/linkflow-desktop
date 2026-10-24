import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
type RemoteSelection={organizationId:string;siteId:string;spaceId:string};
export function gitBookConnectionPayload(token:string,localSiteId:string,accountId?:string,remote?:RemoteSelection){
  const value=token.trim();if(!value||!localSiteId)throw Error('请填写 API 令牌并选择网站');
  if(remote&&Object.values(remote).some(part=>!part.trim()))throw Error('手动指定时，请填写完整的三个 GitBook ID');
  return {token:value,siteIds:[localSiteId],...(accountId?{accountId}:{}),...(remote?{organizationId:remote.organizationId.trim(),siteId:remote.siteId.trim(),spaceId:remote.spaceId.trim()}:{})};
}
export function GitBookConnection({data,disabled,account,onClose,onAction}:Props){
  const existing=data?.accountBindings.find(binding=>binding.accountId===account?.id)?.siteId??'';
  const [token,setToken]=useState(''),[localSiteId,setLocalSiteId]=useState(existing),[manual,setManual]=useState(false);
  const [organizationId,setOrganizationId]=useState(account?.gitbook?.organizationId??''),[siteId,setSiteId]=useState(account?.gitbook?.remoteSiteId??''),[spaceId,setSpaceId]=useState(account?.gitbook?.spaceId??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),inFlight=useRef(false);
  const enabled=data?.channels.some(channel=>channel.id==='gitbook'&&channel.enabled)===true;
  async function connect(){
    if(inFlight.current)return;
    let payload;try{payload=gitBookConnectionPayload(token,localSiteId,account?.id,manual?{organizationId,siteId,spaceId}:undefined)}catch{setError('请填写令牌、选择网站；手动指定时三个 ID 都需填写。');return}
    inFlight.current=true;setBusy(true);setError('');
    try{const result=await onAction<Account>('account:connect-gitbook',payload,enabled?'GitBook 已连接，审核通过的任务将按计划继续':'GitBook 账号已保存');if(result)onClose();else setError('连接未完成，请查看提示并核对 GitBook 免费站点与令牌权限。')}
    catch{setError('连接未完成，账号未确认保存；请查看提示后重试。')}
    finally{setToken('');setBusy(false);inFlight.current=false}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 GitBook">
    <header><h2>{account?'更新 GitBook 连接':'连接 GitBook'}</h2><button className="icon-button" aria-label="关闭 GitBook 连接" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className="drawer-form"><p className="drawer-intro">连接已有的 Basic 免费文档站。先核对账号与站点，保存后复用连接；稿件仍须通过检查并按计划发布。</p>
      {!enabled&&<p className="account-diagnostic" role="status">这个平台暂未开放自动发布，可以先保存连接。</p>}
      <Field label="GitBook API 令牌" hint="令牌仅加密保存在本机；连接检查不会发文或开通付费方案。"><input aria-label="GitBook API 令牌" type="password" autoComplete="new-password" value={token} disabled={disabled||busy} onChange={event=>setToken(event.target.value)}/></Field>
      <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://app.gitbook.com/account/developer/api-access-tokens'})}>打开 GitBook 令牌设置<ArrowSquareOut size={13}/></Button>
      <p className="drawer-intro">只有一个可用文档站时自动识别；有多个组织或站点时，可在下方指定。</p>
      <label><input type="checkbox" checked={manual} disabled={disabled||busy} onChange={event=>setManual(event.target.checked)}/>手动指定 GitBook 站点</label>
      {manual&&<>
        <Field label="组织 ID"><input aria-label="GitBook 组织 ID" autoComplete="off" value={organizationId} disabled={disabled||busy} onChange={event=>setOrganizationId(event.target.value)}/></Field>
        <Field label="文档站 ID"><input aria-label="GitBook 文档站 ID" autoComplete="off" value={siteId} disabled={disabled||busy} onChange={event=>setSiteId(event.target.value)}/></Field>
        <Field label="内容空间 ID"><input aria-label="GitBook 内容空间 ID" autoComplete="off" value={spaceId} disabled={disabled||busy} onChange={event=>setSpaceId(event.target.value)}/></Field>
      </>}
      <fieldset className="checkbox-grid"><legend>用于网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="radio" name="gitbook-site" checked={localSiteId===site.id} disabled={disabled||busy} onChange={()=>setLocalSiteId(site.id)}/><span>{site.domain}</span></label>)}</fieldset>
      {error&&<p role="alert" className="account-diagnostic">{error}</p>}
      <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!token.trim()||!localSiteId||(manual&&![organizationId,siteId,spaceId].every(x=>x.trim()))} onClick={()=>void connect()}>{busy?'正在核对并连接…':'连接并保存'}</Button></div>
    </div>
  </aside></div>;
}
