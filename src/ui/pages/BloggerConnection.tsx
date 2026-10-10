import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,GoogleLogo,WarningCircle,X} from '@phosphor-icons/react';
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
  const initialSiteIds=(data?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===initialAccountId).map(binding=>binding.siteId);
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

  function boundSiteIds(nextAccountId:string){
    const snapshot=dataRef.current;
    const existingSites=new Set((snapshot?.sites??[]).map(site=>site.id));
    return (snapshot?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===nextAccountId&&existingSites.has(binding.siteId)).map(binding=>binding.siteId);
  }

  function preferredBlogId(nextBlogs:BloggerBlogSummary[],nextAccountId:string,nextSiteIds:string[]){
    const snapshot=dataRef.current;
    const accountSites=new Set((snapshot?.accountBindings??[]).filter(binding=>binding.channelId==='blogger'&&binding.accountId===nextAccountId).map(binding=>binding.siteId));
    const boundBlogs=[...new Set((snapshot?.sites??[]).filter(site=>nextSiteIds.includes(site.id)&&accountSites.has(site.id)).map(site=>site.blogger?.blogId).filter((value):value is string=>!!value))];
    if(boundBlogs.length===1&&nextBlogs.some(blog=>blog.id===boundBlogs[0]))return boundBlogs[0];
    if(boundBlogs.length>1)return '';
    return nextBlogs.some(blog=>blog.id===blogId)?blogId:nextBlogs[0]?.id??'';
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
    try{result=await runExclusive('connect',()=>onAction<BloggerConnectionResult>('account:connect-blogger',undefined,'Blogger 身份已连接。'))}
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
    try{result=await runExclusive('reconnect',()=>onAction<BloggerConnectionResult>('account:reconnect-blogger',{accountId:reconnectAccountId},'Blogger 身份已重新授权。'))}
    finally{connectPendingRef.current=false}
    if(!aliveRef.current||accountIdRef.current!==reconnectAccountId)return;
    if(!result){setError('重新授权尚未完成。若本机已没有原桌面客户端配置，请展开首次连接配置并重新导入 JSON。');return}
    if(result.account.id!==reconnectAccountId){setError('重新授权返回的身份与当前选择不一致，未更新博客列表。');return}
    setConnectedAccount(result.account);
    setBlogs(result.blogs);
    setBlogsLoaded(true);
    setBlogId(preferredBlogId(result.blogs,reconnectAccountId,siteIdsRef.current));
  }

  async function bind(){
    const selected=[...siteIdsRef.current];
    const selectedAccountId=accountIdRef.current;
    if(!selectedAccountId||!selected.length||!blogId)return;
    const result=await runExclusive('bind',()=>onAction('site:bind-blogger-batch',{siteIds:selected,accountId:selectedAccountId,blogId},'Blogger 博客已绑定到所选网站。'));
    if(result!==undefined&&aliveRef.current)onClose();
    else if(aliveRef.current)setError('未完成绑定。当前选择仍保留，可检查后重试。');
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
    const next=checked?[...siteIdsRef.current.filter(id=>id!==siteId),siteId]:siteIdsRef.current.filter(id=>id!==siteId);
    siteIdsRef.current=next;
    setSiteIds(next);
    if(blogs.length)setBlogId(preferredBlogId(blogs,accountIdRef.current,next));
  }

  const operationDisabled=disabled||busy!==null;
  if(disconnectAccount)return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="断开 Blogger 授权"><header><div><span className="eyebrow">BLOGGER OAUTH</span><h2>断开 Blogger 授权</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro"><WarningCircle size={14}/> 将移除 <strong>{disconnectAccount.displayName||disconnectAccount.username}</strong> 的本地 OAuth 授权，并停止使用该身份继续发布。已公开的博客文章不会被删除。</p>{boundSites.length>0&&<p className="account-diagnostic"><WarningCircle size={13}/>当前绑定：{boundSites.join('、')}</p>}{error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}<div className="drawer-actions"><Button onClick={requestClose} disabled={busy==='disconnect'}>取消</Button><Button className="blogger-primary" variant="danger" disabled={operationDisabled} onClick={()=>void disconnect()}>{busy==='disconnect'?'正在断开…':'确认断开'}</Button></div></div></aside></div>;

  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)requestClose()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label="连接 Blogger 并绑定博客"><header><div><span className="eyebrow">BLOGGER OAUTH</span><h2>连接 Blogger 并绑定博客</h2></div><button className="icon-button" onClick={requestClose} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro"><strong>首次连接只需一次配置</strong><br/>在 Google Cloud 启用 Blogger API，创建“桌面应用”OAuth 客户端并下载 JSON；导入后会在系统浏览器选择 Google 账号。工具不会自动注册账号，也不会显示凭据明文。</p>
    <Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:BLOGGER_SETUP_GUIDE})}>Google 官方设置步骤<ArrowSquareOut size={13}/></Button>
    <details className="advanced-settings" open={bloggerAccounts.length===0}><summary>{bloggerAccounts.length?'连接另一个身份或重新导入配置':'导入桌面客户端配置'}</summary><p className="drawer-intro">若 OAuth 同意屏幕为 External 且发布状态为 Testing，刷新令牌通常会在 7 天后失效；已保存客户端配置时，可直接重新授权同一身份。</p><Button className="blogger-primary" variant="primary" disabled={operationDisabled} onClick={()=>void connect()}><GoogleLogo size={16}/>{busy==='connect'?'等待浏览器授权…':'选择桌面客户端 JSON 并连接'}</Button></details>
    {(busy==='connect'||busy==='reconnect')&&<p className="account-diagnostic">已打开系统浏览器。完成或取消授权后返回；关闭本抽屉可取消本次连接。</p>}
    <p className="drawer-intro"><strong>选择一个身份和博客，可绑定多个域名</strong><br/>网站不会默认全选；请逐个勾选本次要绑定的域名。已连接身份的桌面客户端配置可加密复用。</p>
    <Field label="Blogger 身份" hint={bloggerAccounts.length?'管理已有身份时会自动读取一次博客；切换身份后可手动读取。':'请先完成上方 OAuth 连接。'}><select aria-label="Blogger 身份" value={accountId} disabled={operationDisabled||bloggerAccounts.length===0} onChange={event=>chooseAccount(event.target.value)}><option value="">请选择身份</option>{bloggerAccounts.map(account=><option key={account.id} value={account.id}>{account.displayName||account.username}{account.email?` · ${account.email}`:''}</option>)}</select></Field>
    <div className="form-grid"><Button disabled={operationDisabled||!selectedAccount} onClick={()=>void loadBlogs()}>{busy==='blogs'?'正在读取…':'读取博客列表'}</Button><Button disabled={operationDisabled||!selectedAccount} onClick={()=>void reconnect()}>{busy==='reconnect'?'等待浏览器授权…':'重新授权此身份'}</Button></div>
    {selectedAccount&&<fieldset className="checkbox-grid" disabled={operationDisabled}><legend>绑定网站（逐个选择）</legend>{(data?.sites??[]).map(site=>{const binding=data?.accountBindings.find(item=>item.channelId==='blogger'&&item.siteId===site.id);return <label key={site.id}><input type="checkbox" aria-label={`绑定网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}{binding?.accountId===accountId?' · 已绑定当前身份':binding?' · 已绑定其他身份':''}</span></label>})}</fieldset>}
    {blogsLoaded&&blogs.length===0&&<div><p className="drawer-intro">该 Google 身份下还没有 Blogger 博客。请在 Blogger 官网手动创建，返回后再读取列表。</p><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:BLOGGER_HOME})}>去 Blogger 创建博客<ArrowSquareOut size={13}/></Button></div>}
    {blogs.length>0&&<Field label="Blogger 博客" hint="所选博客将一次绑定到上方勾选的全部网站。"><select aria-label="Blogger 博客" value={blogId} disabled={operationDisabled} onChange={event=>setBlogId(event.target.value)}><option value="">请选择博客</option>{blogs.map(blog=><option key={blog.id} value={blog.id}>{blog.name} · {blog.url}</option>)}</select></Field>}
    {error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}
    <div className="drawer-actions"><Button onClick={requestClose}>{busy==='connect'||busy==='reconnect'?'取消连接':'取消'}</Button><Button variant="primary" disabled={operationDisabled||!accountId||siteIds.length===0||!blogId} onClick={()=>void bind()}>{busy==='bind'?'正在绑定…':'绑定所选网站'}</Button></div>
  </div></aside></div>;
}
