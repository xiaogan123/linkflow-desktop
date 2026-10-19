import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,GoogleLogo,WarningCircle,X} from '@phosphor-icons/react';
import {BLOGGER_GUIDANCE} from '../../shared/blogger-messages';
import type {Account,BloggerBlogSummary,BloggerConnectionResult,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type BusyAction='connect'|'reconnect'|'blogs'|'bind'|'disconnect'|null;
type Props={
  data:Snapshot|null;
  disabled:boolean;
  initialAccountId?:string;
  disconnectAccount?:Account;
  onClose:()=>void;
  onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
};

const BLOGGER_SETUP_GUIDE='https://developers.google.com/workspace/guides/create-credentials#desktop-app';
const BLOGGER_HOME='https://www.blogger.com/';

export function BloggerConnection({data,disabled,initialAccountId='',disconnectAccount,onClose,onAction}:Props){
  // One blog per site: the drawer works on a single site at a time.
  const initialSiteIds=(data?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===initialAccountId).map(binding=>binding.siteId).slice(0,1);
  const [connectedAccount,setConnectedAccount]=useState<Account|null>(null);
  const [accountId,setAccountId]=useState(initialAccountId);
  const [siteIds,setSiteIds]=useState<string[]>(initialSiteIds);
  const [blogId,setBlogId]=useState('');
  const [blogs,setBlogs]=useState<BloggerBlogSummary[]>([]);
  const [blogsLoaded,setBlogsLoaded]=useState(false);
  const [busy,setBusy]=useState<BusyAction>(null);
  const [error,setError]=useState('');
  const busyRef=useRef(false);
  const aliveRef=useRef(true);
  const connectPendingRef=useRef(false);
  const initialLoadStartedRef=useRef(false);
  const blogsRequestRef=useRef(0);
  const accountIdRef=useRef(initialAccountId);
  const siteIdsRef=useRef(initialSiteIds);
  const dataRef=useRef(data);
  dataRef.current=data;

  const bloggerAccounts=useMemo(()=>{
    const accounts=(data?.accounts??[]).filter(account=>account.channelId==='blogger'&&account.credentialKind==='oauth');
    return connectedAccount&&!accounts.some(account=>account.id===connectedAccount.id)?[connectedAccount,...accounts]:accounts;
  },[connectedAccount,data?.accounts]);
  const selectedAccount=bloggerAccounts.find(account=>account.id===accountId);
  const boundSites=disconnectAccount?(data?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===disconnectAccount.id).map(binding=>data?.sites.find(site=>site.id===binding.siteId)?.domain).filter((domain):domain is string=>!!domain):[];

  useEffect(()=>{aliveRef.current=true;return()=>{aliveRef.current=false;blogsRequestRef.current++}},[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer .blogger-primary')?.focus(),0);
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')requestClose()};
    document.addEventListener('keydown',onKey);
    return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()};
  },[]);

  function requestClose(){
    aliveRef.current=false;
    blogsRequestRef.current++;
    if(connectPendingRef.current){
      connectPendingRef.current=false;
      void onAction('account:cancel-blogger');
    }
    onClose();
  }

  async function runExclusive<T>(action:Exclude<BusyAction,null>,work:()=>Promise<T|undefined>){
    if(busyRef.current)return undefined;
    busyRef.current=true;
    if(aliveRef.current){setBusy(action);setError('')}
    try{return await work()}
    finally{
      busyRef.current=false;
      if(aliveRef.current)setBusy(null);
    }
  }

  /** The other site this blog already serves, if any. */
  function blogUsedBy(id:string,siteId:string|undefined){return dataRef.current?.sites.find(site=>site.id!==siteId&&site.blogger?.blogId===id)?.domain}
  function boundSiteIds(nextAccountId:string){
    const snapshot=dataRef.current;
    const existingSites=new Set((snapshot?.sites??[]).map(site=>site.id));
    return (snapshot?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===nextAccountId&&existingSites.has(binding.siteId)).map(binding=>binding.siteId).slice(0,1);
  }

  function preferredBlogId(nextBlogs:BloggerBlogSummary[],nextAccountId:string,nextSiteIds:string[]){
    const snapshot=dataRef.current;
    const accountSites=new Set((snapshot?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===nextAccountId).map(binding=>binding.siteId));
    const boundBlogs=[...new Set((snapshot?.sites??[]).filter(site=>nextSiteIds.includes(site.id)&&accountSites.has(site.id)).map(site=>site.blogger?.blogId).filter((value):value is string=>!!value))];
    if(boundBlogs.length===1&&nextBlogs.some(blog=>blog.id===boundBlogs[0]))return boundBlogs[0];
    if(boundBlogs.length>1)return '';
    const free=nextBlogs.filter(blog=>!blogUsedBy(blog.id,nextSiteIds[0]));
    return free.some(blog=>blog.id===blogId)?blogId:free[0]?.id??'';
  }

  async function loadBlogs(nextAccountId=accountIdRef.current){
    if(!nextAccountId)return;
    const requestId=++blogsRequestRef.current;
    const result=await runExclusive('blogs',()=>onAction<BloggerBlogSummary[]>('account:blogger-blogs',{accountId:nextAccountId}));
    if(!aliveRef.current||requestId!==blogsRequestRef.current||accountIdRef.current!==nextAccountId)return;
    if(!result){setBlogs([]);setBlogsLoaded(false);setBlogId('');setError('暂未读取到博客列表。请检查连接后重试，已有选择不会被提交。');return}
    setBlogs(result);
    setBlogsLoaded(true);
    setBlogId(preferredBlogId(result,nextAccountId,siteIdsRef.current));
  }

  useEffect(()=>{
    if(!initialAccountId||initialLoadStartedRef.current)return;
    initialLoadStartedRef.current=true;
    void loadBlogs(initialAccountId);
  },[]);

  async function connect(){
    connectPendingRef.current=true;
    let result:BloggerConnectionResult|undefined;
    try{result=await runExclusive('connect',()=>onAction<BloggerConnectionResult>('account:connect-blogger',undefined,'Blogger 发布账号已连接。'))}
    finally{connectPendingRef.current=false}
    if(!aliveRef.current)return;
    if(!result){setError('连接尚未完成。若已取消文件选择或浏览器授权，可直接重试；本页不会保存半成品。');return}
    setConnectedAccount(result.account);
    chooseAccount(result.account.id);
    setBlogs(result.blogs);
    setBlogsLoaded(true);
    setBlogId(preferredBlogId(result.blogs,result.account.id,siteIdsRef.current));
  }

  async function reconnect(){
    const reconnectAccountId=accountIdRef.current;
    if(!reconnectAccountId)return;
    connectPendingRef.current=true;
    let result:BloggerConnectionResult|undefined;
    try{result=await runExclusive('reconnect',()=>onAction<BloggerConnectionResult>('account:reconnect-blogger',{accountId:reconnectAccountId},'Blogger 发布账号已重新授权。'))}
    finally{connectPendingRef.current=false}
    if(!aliveRef.current||accountIdRef.current!==reconnectAccountId)return;
    if(!result){setError('重新授权尚未完成。若本机已没有原桌面授权配置，请展开首次连接配置并重新导入 JSON。');return}
    if(result.account.id!==reconnectAccountId){setError('重新授权返回的发布账号与当前选择不一致，未更新博客列表。');return}
    setConnectedAccount(result.account);
    setBlogs(result.blogs);
    setBlogsLoaded(true);
    setBlogId(preferredBlogId(result.blogs,reconnectAccountId,siteIdsRef.current));
  }

  async function bind(){
    const selected=[...siteIdsRef.current];
    const selectedAccountId=accountIdRef.current;
    if(!selectedAccountId||!selected.length||!blogId)return;
    const result=await runExclusive('bind',()=>onAction('site:bind-blogger-batch',{siteIds:selected,accountId:selectedAccountId,blogId},'已为这个网站选好 Blogger 博客。'));
    if(result!==undefined&&aliveRef.current)onClose();
    else if(aliveRef.current)setError('没有保存成功，选择还在，可以检查后重试。');
  }

  async function disconnect(){
    if(!disconnectAccount)return;
    const result=await runExclusive('disconnect',()=>onAction('account:disconnect-blogger',{accountId:disconnectAccount.id},'Blogger 授权已断开。'));
    if(result!==undefined&&aliveRef.current)onClose();
    else if(aliveRef.current)setError('未能断开 Blogger 授权。本地连接保持原状，可稍后重试。');
  }

  function chooseAccount(nextAccountId:string){
    blogsRequestRef.current++;
    accountIdRef.current=nextAccountId;
    const nextSiteIds=boundSiteIds(nextAccountId);
    siteIdsRef.current=nextSiteIds;
    setAccountId(nextAccountId);
    setSiteIds(nextSiteIds);
    setBlogs([]);
    setBlogsLoaded(false);
    setBlogId('');
    setError('');
  }

  function toggleSite(siteId:string,checked:boolean){
    const next=checked?[siteId]:siteIdsRef.current.filter(id=>id!==siteId);
    siteIdsRef.current=next;
    setSiteIds(next);
    if(blogs.length)setBlogId(preferredBlogId(blogs,accountIdRef.current,next));
  }

  const operationDisabled=disabled||busy!==null;
  if(disconnectAccount)return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="断开 Blogger 授权"><header><div><h2>断开 Blogger 授权</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro"><WarningCircle size={14}/> 将移除 <strong>{disconnectAccount.displayName||disconnectAccount.username}</strong> 的本地授权，并停止使用该发布账号继续发布。已公开的博客文章不会被删除。</p>{boundSites.length>0&&<p className="account-diagnostic"><WarningCircle size={13}/>当前用于：{boundSites.join('、')}</p>}{error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}<div className="drawer-actions"><Button onClick={requestClose} disabled={busy==='disconnect'}>取消</Button><Button className="blogger-primary" variant="danger" disabled={operationDisabled} onClick={()=>void disconnect()}>{busy==='disconnect'?'正在断开…':'确认断开'}</Button></div></div></aside></div>;

  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label="连接 Blogger"><header><div><h2>连接 Blogger</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro"><strong>首次连接只需一次配置</strong><br/>在 Google Cloud 启用 Blogger API，创建“桌面应用”授权配置并下载 JSON；导入后会在默认浏览器选择 Google 账号。工具不会自动注册账号，也不会显示授权令牌明文。</p>
    <Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:BLOGGER_SETUP_GUIDE})}>Google 官方设置步骤<ArrowSquareOut size={13}/></Button>
    <details className="advanced-settings" open={bloggerAccounts.length===0}><summary>{bloggerAccounts.length?'连接另一个发布账号或重新导入配置':'导入桌面授权配置'}</summary><p className="drawer-intro">若授权同意屏幕为 External 且发布状态为 Testing，刷新令牌通常会在 7 天后失效；已保存授权配置时，可直接重新授权同一发布账号。</p><Button className="blogger-primary" variant="primary" disabled={operationDisabled} onClick={()=>void connect()}><GoogleLogo size={16}/>{busy==='connect'?'等待浏览器授权…':'导入授权配置并连接'}</Button></details>
    {(busy==='connect'||busy==='reconnect')&&<p className="account-diagnostic">已打开默认浏览器。完成或取消授权后返回；关闭本抽屉可取消本次连接。</p>}
    <p className="drawer-intro"><strong>每个网站用一个自己的博客</strong><br/>一个 Google 账号可以有多个博客。先选网站，再选一个还没给其他网站用的博客。</p>
    <Field label="Blogger 发布账号" hint={bloggerAccounts.length?'管理已有发布账号时会自动读取一次博客；切换发布账号后可手动读取。':'请先完成上方的授权连接。'}><select aria-label="Blogger 发布账号" value={accountId} disabled={operationDisabled||bloggerAccounts.length===0} onChange={event=>chooseAccount(event.target.value)}><option value="">请选择发布账号</option>{bloggerAccounts.map(account=><option key={account.id} value={account.id}>{account.displayName||account.username}{account.email?` · ${account.email}`:''}</option>)}</select></Field>
    <div className="form-grid"><Button disabled={operationDisabled||!selectedAccount} onClick={()=>void loadBlogs()}>{busy==='blogs'?'正在读取…':'读取博客列表'}</Button><Button disabled={operationDisabled||!selectedAccount} onClick={()=>void reconnect()}>{busy==='reconnect'?'等待浏览器授权…':'重新授权此发布账号'}</Button></div>
    {selectedAccount&&<fieldset className="checkbox-grid" disabled={operationDisabled}><legend>给哪个网站</legend>{(data?.sites??[]).map(site=>{const binding=data?.accountBindings.find(item=>item.channelId==='blogger'&&item.siteId===site.id);return <label key={site.id}><input type="radio" name="blogger-site" aria-label={`网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}{binding?.accountId===accountId?' · 已在用':binding?' · 已连接其他账号':''}</span></label>})}</fieldset>}
    {blogsLoaded&&blogs.length===0&&<div><p className="drawer-intro">该 Google 发布账号下还没有 Blogger 博客。请在 Blogger 官网手动创建，返回后再读取列表。</p><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:BLOGGER_HOME})}>去 Blogger 创建博客<ArrowSquareOut size={13}/></Button></div>}
    {blogs.length>0&&<Field label="Blogger 博客" hint="一个博客只给一个网站用。"><select aria-label="Blogger 博客" value={blogId} disabled={operationDisabled} onChange={event=>setBlogId(event.target.value)}><option value="">请选择博客</option>{blogs.map(blog=>{const used=blogUsedBy(blog.id,siteIds[0]);return <option key={blog.id} value={blog.id} disabled={!!used}>{blog.name} · {blog.url}{used?`（已用于 ${used}）`:''}</option>})}</select></Field>}
    {blogs.length>0&&blogs.every(blog=>blogUsedBy(blog.id,siteIds[0]))&&<div><p className="drawer-intro">{BLOGGER_GUIDANCE.noAvailableBlog}</p><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:BLOGGER_GUIDANCE.createBlogUrl})}>去 Blogger 新建博客<ArrowSquareOut size={13}/></Button></div>}
    {error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}
    <div className="drawer-actions"><Button onClick={requestClose}>{busy==='connect'||busy==='reconnect'?'取消连接':'取消'}</Button><Button variant="primary" disabled={operationDisabled||!accountId||siteIds.length===0||!blogId} onClick={()=>void bind()}>{busy==='bind'?'正在保存…':'保存'}</Button></div>
  </div></aside></div>;
}
