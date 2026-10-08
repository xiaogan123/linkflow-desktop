import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,WarningCircle,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export interface WordPressConnectionStatus {configured:boolean;callback:string}
export interface WordPressBlog {id:string;url:string;name:string}
export interface WordPressAuthorization {sessionId:string;blogs:WordPressBlog[];expiresAt:string}
export interface WordPressConnectionPayload {sessionId:string;blogId:string;siteIds:string[];accountId?:string}

type Props={
  data:Snapshot|null;
  disabled:boolean;
  account?:Account;
  onClose:()=>void;
  onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
};
type BusyAction='authorize'|'connect'|null;

export function eligibleWordPressBlogs(blogs:WordPressBlog[],account?:Pick<Account,'username'>){
  return account?blogs.filter(blog=>blog.id===account.username):blogs;
}

export function wordPressConnectionPayload(authorization:Pick<WordPressAuthorization,'sessionId'>,blogId:string,siteIds:string[],accountId?:string):WordPressConnectionPayload{
  const payload:WordPressConnectionPayload={sessionId:authorization.sessionId,blogId,siteIds:[...new Set(siteIds)]};
  if(accountId)payload.accountId=accountId;
  return payload;
}

export function WordPressConnection({data,disabled,account,onClose,onAction}:Props){
  const initialSiteIds=(data?.accountBindings??[]).filter(binding=>binding.channelId==='wordpress-com'&&binding.accountId===account?.id).map(binding=>binding.siteId);
  const [status,setStatus]=useState<WordPressConnectionStatus|null>(null);
  const [statusLoading,setStatusLoading]=useState(true);
  const [authorization,setAuthorization]=useState<WordPressAuthorization|null>(null);
  const [blogId,setBlogId]=useState('');
  const [siteIds,setSiteIds]=useState<string[]>(initialSiteIds);
  const [busy,setBusy]=useState<BusyAction>(null);
  const [error,setError]=useState('');
  const busyRef=useRef(false);
  const busyActionRef=useRef<BusyAction>(null);
  const closingRef=useRef(false);
  const aliveRef=useRef(true);
  const statusStartedRef=useRef(false);

  const blogs=useMemo(()=>eligibleWordPressBlogs(authorization?.blogs??[],account),[account,authorization]);
  const selectedBlog=blogs.find(blog=>blog.id===blogId);
  const expiresAt=authorization&&Number.isFinite(Date.parse(authorization.expiresAt))?new Date(authorization.expiresAt).toLocaleString('zh-CN',{hour12:false}):'';

  useEffect(()=>{
    aliveRef.current=true;
    if(!statusStartedRef.current){
      statusStartedRef.current=true;
      void (async()=>{
        const result=await onAction<WordPressConnectionStatus>('account:wordpress-status');
        if(!aliveRef.current)return;
        if(result)setStatus(result);
        else setError('暂时无法读取 WordPress.com 连接状态，请稍后重试。');
        setStatusLoading(false);
      })();
    }
    return()=>{aliveRef.current=false};
  },[]);

  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer .wordpress-primary')?.focus(),0);
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')void cancelAndClose()};
    document.addEventListener('keydown',onKey);
    return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()};
  },[]);

  async function runExclusive<T>(action:Exclude<BusyAction,null>,work:()=>Promise<T|undefined>){
    if(busyRef.current)return undefined;
    busyRef.current=true;
    busyActionRef.current=action;
    if(aliveRef.current){setBusy(action);setError('')}
    try{return await work()}
    finally{
      busyRef.current=false;
      busyActionRef.current=null;
      if(aliveRef.current)setBusy(null);
    }
  }

  async function authorize(){
    if(busyRef.current||!status?.configured)return;
    const result=await runExclusive('authorize',()=>onAction<WordPressAuthorization>('account:authorize-wordpress',{}));
    if(!aliveRef.current)return;
    if(!result){
      setAuthorization(null);
      setBlogId('');
      setError('浏览器授权尚未完成。可以重试，未完成的选择不会保存。');
      return;
    }
    setAuthorization(result);
    const allowed=eligibleWordPressBlogs(result.blogs,account);
    setBlogId(allowed[0]?.id??'');
    if(account&&!allowed.length)setError('本次授权未包含原博客。修复连接只能继续使用原博客；如需使用其他博客，请新增连接。');
  }

  async function connect(){
    if(busyRef.current||!authorization||!selectedBlog||siteIds.length===0)return;
    const currentSites=new Set((data?.sites??[]).map(site=>site.id));
    const selectedSiteIds=siteIds.filter(siteId=>currentSites.has(siteId));
    if(!selectedSiteIds.length){setError('请至少选择一个仍然存在的网站。');return}
    const payload=wordPressConnectionPayload(authorization,selectedBlog.id,selectedSiteIds,account?.id);
    const result=await runExclusive('connect',()=>onAction<Account>('account:connect-wordpress',payload,account?'WordPress.com 连接已更新。':'WordPress.com 博客已连接。'));
    if(!aliveRef.current)return;
    if(result){aliveRef.current=false;onClose();return}
    setAuthorization(null);
    setBlogId('');
    setError('连接未完成，本次授权会话已结束。请重新从浏览器授权。');
  }

  async function cancelAndClose(){
    if(closingRef.current||busyActionRef.current==='connect')return;
    closingRef.current=true;
    aliveRef.current=false;
    try{await onAction('account:cancel-wordpress',{})}
    finally{onClose()}
  }

  function toggleSite(siteId:string,checked:boolean){
    setSiteIds(current=>checked?[...current.filter(id=>id!==siteId),siteId]:current.filter(id=>id!==siteId));
  }

  const operationDisabled=disabled||busy!==null;
  const configured=status?.configured===true;
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancelAndClose()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label={account?'修复 WordPress.com 连接':'连接 WordPress.com 博客'}><header><div><span className="eyebrow">WORDPRESS.COM OAUTH</span><h2>{account?'修复 WordPress.com 连接':'连接 WordPress.com 博客'}</h2></div><button className="icon-button" disabled={busy==='connect'} onClick={()=>void cancelAndClose()} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro"><strong>在系统浏览器完成 WordPress.com 授权</strong><br/>只会列出本人可管理、已公开且可发布的 WordPress.com 托管博客。授权凭据仅加密保存在本机，不会在页面中显示。</p>
    {account&&<p className="cell-note">要撤销授权，请到 WordPress.com 的应用授权设置中操作；本机保留原博客身份和已发布文章记录。</p>}
    {statusLoading?<p className="drawer-intro" role="status">正在检查浏览器授权是否可用…</p>:!configured?<p className="account-diagnostic" role="status"><WarningCircle size={13}/>WordPress.com 浏览器授权待接入验收。当前版本暂不能发起授权；已有本地连接记录会保留。</p>:null}
    <Button className="wordpress-primary" variant="primary" disabled={operationDisabled||statusLoading||!configured} onClick={()=>void authorize()}><ArrowSquareOut size={15}/>{busy==='authorize'?'等待浏览器授权…':configured?(account?'重新授权原博客':'在浏览器授权 WordPress.com'):'待接入验收'}</Button>
    {busy==='authorize'&&<p className="drawer-intro" role="status">浏览器授权正在进行。完成后返回这里选择博客；取消或关闭会结束本次连接。</p>}
    {authorization&&blogs.length>0&&<><Field label="已公开的 WordPress.com 博客" hint={account?'修复现有连接时固定使用原博客，不能在此改成其他博客。':'只显示本次授权确认可管理和公开发布的博客。'}><select aria-label="WordPress.com 博客" value={blogId} disabled={operationDisabled||!!account} onChange={event=>setBlogId(event.target.value)}>{blogs.map(blog=><option key={blog.id} value={blog.id}>{blog.name} · {blog.url}</option>)}</select></Field>{expiresAt&&<small className="cell-note">本次授权选择会话有效至 {expiresAt}</small>}</>}
    {authorization&&blogs.length>0&&<fieldset className="checkbox-grid" disabled={operationDisabled}><legend>关联网站（逐个选择）</legend>{(data?.sites??[]).map(site=>{const binding=data?.accountBindings.find(item=>item.channelId==='wordpress-com'&&item.siteId===site.id);return <label className="site-binding-option" key={site.id}><input type="checkbox" aria-label={`关联网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}{binding?.accountId===account?.id?' · 已关联当前博客':binding?' · 已关联其他博客':''}</span></label>})}</fieldset>}
    {authorization&&blogs.length>0&&(data?.sites.length??0)===0&&<p className="drawer-intro">当前还没有可关联的网站，请先添加网站后再连接博客。</p>}
    {error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}
    <div className="drawer-actions"><Button disabled={busy==='connect'} onClick={()=>void cancelAndClose()}>{busy==='authorize'?'取消授权':busy==='connect'?'正在保存…':'取消'}</Button><Button variant="primary" disabled={operationDisabled||!authorization||!selectedBlog||siteIds.length===0} onClick={()=>void connect()}>{busy==='connect'?'正在保存…':account?'验证并更新':'连接所选博客'}</Button></div>
  </div></aside></div>;
}
