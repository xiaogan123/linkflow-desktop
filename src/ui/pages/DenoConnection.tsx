import {useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export interface DenoConnectionPayload {token:string;appId:string;declaredOrgSlug:string;label:string;siteIds:string[];dedicatedAppAcknowledged:true;accountId?:string}
export function denoConnectionPayload(token:string,appId:string,declaredOrgSlug:string,label:string,siteIds:string[],accountId?:string):DenoConnectionPayload{
  const value:DenoConnectionPayload={token:token.trim(),appId,declaredOrgSlug:declaredOrgSlug.trim(),label:label.trim(),siteIds:[...new Set(siteIds)],dedicatedAppAcknowledged:true};
  if(accountId)value.accountId=accountId;
  return value;
}

type Action=<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
type AppChoice={id:string;slug:string};
export function DenoConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:Action}){
  const [token,setToken]=useState(''),[org,setOrg]=useState(account?.denoReadAccess?.declaredOrgSlug??''),[label,setLabel]=useState(account?.displayName??''),[apps,setApps]=useState<AppChoice[]>([]),[appId,setAppId]=useState(account?.denoReadAccess?.appId??''),[ack,setAck]=useState(false),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(item=>item.channelId==='deno'&&item.accountId===account?.id).map(item=>item.siteId));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),cancelRequested=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(inFlight.current)void onAction('account:cancel-deno',{}).catch(()=>undefined)}},[]);
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')void close()};document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey)},[]);
  const tokenReady=token.trim().length>=1&&token.trim().length<=4096&&!/\s/.test(token.trim());
  const selected=apps.find(item=>item.id===appId);
  const ready=tokenReady&&!!selected&&!!label.trim()&&/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/.test(org.trim())&&ack&&(!account||account.denoReadAccess?.appId===appId);
  async function list(){
    if(inFlight.current||!tokenReady)return;
    inFlight.current=true;cancelRequested.current=false;setBusy(true);setError('');setApps([]);setAppId('');
    try{
      const result=await onAction<AppChoice[]>('account:list-deno-apps',{token:token.trim()});
      if(!alive.current||cancelRequested.current)return;
      if(!result){setError('应用列表读取未完成；未保存连接。');return}
      setApps(result);if(account){const old=result.find(item=>item.id===account.denoReadAccess?.appId);if(old)setAppId(old.id)}
      if(!result.length)setError('该组织令牌未返回可读取的应用；请先在 Deno 控制台建立专用应用。');
    }catch{if(alive.current&&!cancelRequested.current)setError('应用列表读取失败；请检查组织令牌和网络。没有保存连接。')}
    finally{inFlight.current=false;if(alive.current){setBusy(false);if(cancelRequested.current){alive.current=false;onClose()}}}
  }
  async function connect(){
    if(inFlight.current||!ready)return;
    inFlight.current=true;cancelRequested.current=false;setBusy(true);setError('');
    try{
      const payload=denoConnectionPayload(token,appId,org,label,siteIds,account?.id);
      const result=await onAction<Account>('account:connect-deno',payload);
      if(!alive.current||cancelRequested.current)return;
      if(result){setToken('');onClose();return}
      setError('只读连接未完成；没有保存令牌、启用发布或修改配额。');
    }catch{if(alive.current&&!cancelRequested.current)setError('应用身份或 revision 读取未通过；原连接保持不变。')}
    finally{inFlight.current=false;if(alive.current){setBusy(false);if(cancelRequested.current){alive.current=false;onClose()}}}
  }
  async function close(){
    setToken('');setApps([]);
    if(inFlight.current){cancelRequested.current=true;try{await onAction('account:cancel-deno',{})}catch{if(alive.current)setError('取消请求尚未完成，请等待当前读取结束。')}return}
    alive.current=false;onClose();
  }
  const toggle=(id:string,checked:boolean)=>setSiteIds(current=>checked?[...current.filter(item=>item!==id),id]:current.filter(item=>item!==id));
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void close()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="Deno Deploy 专用应用只读连接"><header><div><span className="eyebrow">DENO DEPLOY · 只读连接</span><h2>{account?'重新验证专用应用':'连接本人专用应用'}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>void close()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">本人先通过 GitHub 或 Google 登录 Deno Deploy，建立或进入自己的组织，在控制台创建专用应用，再到组织 Settings → Access Tokens 生成组织令牌。这里仅用 GET 读取应用与 revision，不创建应用、不发布或绑卡；发布功能尚未启用。</p>
    <p className="cell-note">组织名称由你声明：当前应用 API 不返回组织归属证明。请核对控制台所选组织与令牌。Free 未绑卡额度、令牌期限、公开发布和长期保留仍待实际验收。</p>
    {account&&<p className="account-diagnostic">重连只接受同一应用 UUID；组织 slug 是可更正的声明备注。换应用请新增连接，原网站关联与历史任务保留。</p>}
    <Field label="组织令牌" hint="只在本机加密保存；不要使用个人令牌或复制浏览器会话。"><input aria-label="Deno 组织令牌" type="password" autoComplete="new-password" value={token} disabled={disabled||busy} onChange={event=>{setToken(event.target.value);setApps([]);setAppId('')}}/></Field>
    <Field label="控制台中的组织 slug" hint="用于本机辨认，由你声明，API 读取不证明组织归属。"><input aria-label="Deno 组织 slug" value={org} maxLength={64} disabled={disabled||busy} onChange={event=>setOrg(event.target.value)}/></Field>
    <Field label="连接标签" hint="仅用于本机区分应用。"><input aria-label="Deno 连接标签" value={label} maxLength={80} disabled={disabled||busy} onChange={event=>setLabel(event.target.value)}/></Field>
    <Button disabled={disabled||busy||!tokenReady} onClick={()=>void list()}>读取可访问应用</Button>
    {apps.length>0&&<Field label="选择专用应用 UUID" hint="只选你为本工具专门准备的应用；名称可能改变，绑定按 UUID 保存。"><select aria-label="Deno 专用应用 UUID" value={appId} disabled={disabled||busy} onChange={event=>setAppId(event.target.value)}><option value="">请选择</option>{apps.map(item=><option key={item.id} value={item.id}>{item.slug} · {item.id}</option>)}</select></Field>}
    <label className="site-binding-option"><input type="checkbox" checked={ack} disabled={disabled||busy} onChange={event=>setAck(event.target.checked)}/><span>我确认这是本人组织中专为本工具准备的应用；只进行只读连接。</span></label>
    <fieldset className="checkbox-grid" disabled={disabled||busy}><legend>关联的网站（不会启用自动发布）</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" aria-label={`关联网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggle(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
    {busy&&<p role="status">正在读取 Deno 应用；不会发送发布请求…</p>}{error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button onClick={()=>void close()}>取消</Button><Button variant="primary" disabled={disabled||busy||!ready} onClick={()=>void connect()}>{busy?'正在验证…':'验证应用并加密保存'}</Button></div>
  </div></aside></div>;
}
