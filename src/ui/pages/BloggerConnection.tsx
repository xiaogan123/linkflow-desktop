import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,GoogleLogo,WarningCircle,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export interface BloggerBlog {id:string;name:string;url:string}

type BusyAction='connect'|'blogs'|'bind'|'disconnect'|null;
type Props={
  data:Snapshot|null;
  disabled:boolean;
  initialAccountId?:string;
  disconnectAccount?:Account;
  onClose:()=>void;
  onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
};

export function BloggerConnection({data,disabled,initialAccountId='',disconnectAccount,onClose,onAction}:Props){
  const initiallyBoundSite=data?.accountBindings.find(binding=>binding.accountId===initialAccountId)?.siteId;
  const [connectedAccount,setConnectedAccount]=useState<Account|null>(null);
  const [accountId,setAccountId]=useState(initialAccountId);
  const [siteId,setSiteId]=useState(initiallyBoundSite??data?.sites[0]?.id??'');
  const [blogId,setBlogId]=useState('');
  const [blogs,setBlogs]=useState<BloggerBlog[]>([]);
  const [blogsLoaded,setBlogsLoaded]=useState(false);
  const [busy,setBusy]=useState<BusyAction>(null);
  const [error,setError]=useState('');
  const busyRef=useRef(false);
  const aliveRef=useRef(true);
  const connectPendingRef=useRef(false);

  const bloggerAccounts=useMemo(()=>{
    const accounts=(data?.accounts??[]).filter(account=>account.channelId==='blogger'&&account.credentialKind==='oauth');
    return connectedAccount&&!accounts.some(account=>account.id===connectedAccount.id)?[connectedAccount,...accounts]:accounts;
  },[connectedAccount,data?.accounts]);
  const selectedAccount=bloggerAccounts.find(account=>account.id===accountId);
  const boundSites=disconnectAccount?(data?.accountBindings??[]).filter(binding=>binding.accountId===disconnectAccount.id).map(binding=>data?.sites.find(site=>site.id===binding.siteId)?.domain).filter((domain):domain is string=>!!domain):[];

  useEffect(()=>{aliveRef.current=true;return()=>{aliveRef.current=false}},[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer .blogger-primary')?.focus(),0);
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')requestClose()};
    document.addEventListener('keydown',onKey);
    return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()};
  },[]);

  function requestClose(){
    if(connectPendingRef.current){
      connectPendingRef.current=false;
      void onAction('account:cancel-blogger');
    }
    onClose();
  }

  const runExclusive=async<T,>(action:Exclude<BusyAction,null>,work:()=>Promise<T|undefined>)=>{
    if(busyRef.current)return undefined;
    busyRef.current=true;
    if(aliveRef.current){setBusy(action);setError('')}
    try{return await work()}
    finally{
      busyRef.current=false;
      if(aliveRef.current)setBusy(null);
    }
  };

  const loadBlogs=async(nextAccountId=accountId)=>{
    if(!nextAccountId)return;
    const result=await runExclusive('blogs',()=>onAction<BloggerBlog[]>('account:blogger-blogs',{accountId:nextAccountId}));
    if(!aliveRef.current)return;
    if(!result){setBlogs([]);setBlogsLoaded(false);setError('暂未读取到博客列表。请检查连接后重试，已有选择不会被提交。');return}
    setBlogs(result);
    setBlogsLoaded(true);
    const alreadyBoundBlog=data?.sites.find(site=>site.id===siteId)?.blogger?.blogId;
    setBlogId(result.some(blog=>blog.id===alreadyBoundBlog)?alreadyBoundBlog??'':result[0]?.id??'');
  };

  const connect=async()=>{
    connectPendingRef.current=true;
    const result=await runExclusive('connect',()=>onAction<Account>('account:connect-blogger',undefined,'Blogger 身份已连接。'));
    connectPendingRef.current=false;
    if(!aliveRef.current)return;
    if(!result){setError('连接尚未完成。若已取消文件选择或浏览器授权，可直接重试；本页不会保存半成品。');return}
    setConnectedAccount(result);
    setAccountId(result.id);
    setBlogs([]);
    setBlogsLoaded(false);
    await loadBlogs(result.id);
  };

  const bind=async()=>{
    if(!accountId||!siteId||!blogId)return;
    const result=await runExclusive('bind',()=>onAction('site:bind-blogger',{siteId,accountId,blogId},'Blogger 博客已绑定。'));
    if(result!==undefined&&aliveRef.current)onClose();
    else if(aliveRef.current)setError('未完成绑定。当前选择仍保留，可检查后重试。');
  };

  const disconnect=async()=>{
    if(!disconnectAccount)return;
    const result=await runExclusive('disconnect',()=>onAction('account:disconnect-blogger',{accountId:disconnectAccount.id},'Blogger 授权已断开。'));
    if(result!==undefined&&aliveRef.current)onClose();
    else if(aliveRef.current)setError('未能断开 Blogger 授权。本地连接保持原状，可稍后重试。');
  };

  const chooseAccount=(nextAccountId:string)=>{
    setAccountId(nextAccountId);
    setBlogs([]);
    setBlogsLoaded(false);
    setBlogId('');
    setError('');
  };

  const chooseSite=(nextSiteId:string)=>{
    setSiteId(nextSiteId);
    const alreadyBoundBlog=data?.sites.find(site=>site.id===nextSiteId)?.blogger?.blogId;
    if(alreadyBoundBlog&&blogs.some(blog=>blog.id===alreadyBoundBlog))setBlogId(alreadyBoundBlog);
  };

  const operationDisabled=disabled||busy!==null;
  if(disconnectAccount)return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="断开 Blogger 授权"><header><div><span className="eyebrow">BLOGGER OAUTH</span><h2>断开 Blogger 授权</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro"><WarningCircle size={14}/> 将移除 <strong>{disconnectAccount.displayName||disconnectAccount.username}</strong> 的本地 OAuth 授权，并停止使用该身份继续发布。已公开的博客文章不会被删除。</p>{boundSites.length>0&&<p className="account-diagnostic"><WarningCircle size={13}/>当前绑定：{boundSites.join('、')}</p>}{error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}<div className="drawer-actions"><Button onClick={requestClose} disabled={busy==='disconnect'}>取消</Button><Button className="blogger-primary" variant="danger" disabled={operationDisabled} onClick={()=>void disconnect()}>{busy==='disconnect'?'正在断开…':'确认断开'}</Button></div></div></aside></div>;

  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label="连接 Blogger 并绑定博客"><header><div><span className="eyebrow">BLOGGER OAUTH</span><h2>连接 Blogger 并绑定博客</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro"><strong>1. 选择 Google 桌面客户端配置并连接</strong><br/>首次使用需导入已启用 Blogger API 的 Google OAuth 桌面客户端 JSON 配置。处于 Testing 的外部应用授权通常会在 7 天后过期，届时需重新连接。随后会在系统浏览器中选择 Google 账号并授权。工具不会自动注册 Google 账号，也不会在页面中读取或显示凭据明文。</p>
    <Button className="blogger-primary" variant="primary" disabled={operationDisabled} onClick={()=>void connect()}><GoogleLogo size={16}/>{busy==='connect'?'等待浏览器授权…':'选择 Google 桌面客户端配置并连接'}</Button>
    {busy==='connect'&&<p className="account-diagnostic">已打开系统浏览器。完成或取消授权后返回；关闭本抽屉可取消本次连接。</p>}
    <p className="drawer-intro"><strong>2. 选择已连接身份、网站和 Blogger 博客</strong><br/>目录中出现 Blogger 只表示渠道可用；只有完成 OAuth 连接并将具体博客绑定到网站后，才能用于发布。</p>
    <Field label="Blogger 身份" hint={bloggerAccounts.length?'选择后读取该 Google 账号下的博客。':'请先完成上方 OAuth 连接。'}><select aria-label="Blogger 身份" value={accountId} disabled={operationDisabled||bloggerAccounts.length===0} onChange={event=>chooseAccount(event.target.value)}><option value="">请选择身份</option>{bloggerAccounts.map(account=><option key={account.id} value={account.id}>{account.displayName||account.username}{account.email?` · ${account.email}`:''}</option>)}</select></Field>
    <Button disabled={operationDisabled||!selectedAccount} onClick={()=>void loadBlogs()}>{busy==='blogs'?'正在读取…':'读取该身份的博客'}</Button>
    {blogsLoaded&&blogs.length===0&&<div><p className="drawer-intro">该 Google 身份下还没有 Blogger 博客。请在 Blogger 官网手动创建，返回后再读取列表。</p><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:'https://www.blogger.com/'})}>去 Blogger 创建博客<ArrowSquareOut size={13}/></Button></div>}
    {blogs.length>0&&<div className="form-grid"><Field label="绑定网站"><select aria-label="绑定网站" value={siteId} disabled={operationDisabled} onChange={event=>chooseSite(event.target.value)}>{(data?.sites??[]).map(site=><option key={site.id} value={site.id}>{site.domain}{site.blogger?' · 已绑定 Blogger':''}</option>)}</select></Field><Field label="Blogger 博客"><select aria-label="Blogger 博客" value={blogId} disabled={operationDisabled} onChange={event=>setBlogId(event.target.value)}>{blogs.map(blog=><option key={blog.id} value={blog.id}>{blog.name} · {blog.url}</option>)}</select></Field></div>}
    {error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}
    <div className="drawer-actions"><Button onClick={requestClose}>{busy==='connect'?'取消连接':'取消'}</Button><Button variant="primary" disabled={operationDisabled||!accountId||!siteId||!blogId} onClick={()=>void bind()}>{busy==='bind'?'正在绑定…':'绑定博客'}</Button></div>
  </div></aside></div>;
}
