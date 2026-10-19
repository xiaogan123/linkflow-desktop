import {HackmdConnection} from './HackmdConnection';
import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowClockwise,ArrowSquareOut,Check,Copy,Eye,EyeSlash,GithubLogo,GoogleLogo,LockKey,MagnifyingGlass,PencilSimple,Plus,PlugsConnected,ShieldCheck,SignOut,Trash,UserCircle,WarningCircle,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Empty,Field} from '../components';
import {dateLabel} from '../presentation';
import {SortHeading,sortTableRows,toggleTableSort,unsorted} from '../table-sort';

import {connectionOverview,isMarkestReadAccessAccount,isDenoReadAccessAccount,type ConnectionChannelId,type ConnectionOverviewRow} from '../channel-connections';
import {BlueskyConnection} from './BlueskyConnection';
import {ParagraphConnection} from './ParagraphConnection';
import {ArticleConnection} from './ArticleConnection';
import {PlopinoConnection} from './PlopinoConnection';
import {BloggerConnection} from './BloggerConnection';
import {LeafletConnection} from './LeafletConnection';
import {RaindropConnection} from './RaindropConnection';
import {WordPressConnection} from './WordPressConnection';
import {DenoConnection} from './DenoConnection';
import {HereNowConnection} from './HereNowConnection';
import {ShiplyConnection} from './ShiplyConnection';
import {OpenAgentChatConnection} from './OpenAgentChatConnection';
import {AgentNotepadConnection} from './AgentNotepadConnection';
import {ColonyConnection} from './ColonyConnection';
import {LargeLanguageConnection} from './LargeLanguageConnection';
import {SynthfolkConnection} from './SynthfolkConnection';
import {AgentsWikiConnection} from './AgentsWikiConnection';
import {CarcinusConnection} from './CarcinusConnection';
import {AccountConnectionGuide} from './AccountConnectionGuide';
import {accountNextStep,accountReadiness} from '../account-guidance';

type Binding={id:string;siteId:string;channelId:string;accountId:string};
type Mailbox={id:string;label:string;user:string};
type ExtendedSnapshot=Snapshot&{accountBindings?:Binding[];mailboxes?:Mailbox[]};
type Props={data:Snapshot|null;disabled:boolean;onImport:(channelId?:string)=>void;onEdit:(a:Account)=>void;onDelete:(a:Account)=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;onSetup:()=>void;
  /** A platform row asked to connect this platform; the nonce repeats the request for the same platform. */
  connectRequest?:{channelId:string;nonce:number};onConnectHandled?:()=>void};
type BloggerDrawer={initialAccountId?:string;disconnectAccount?:Account};
const statuses:Record<string,[string,string]>={registered:['正常','green'],draft:['准备注册','blue'],needs_verification:['等待验证','amber'],credentials_invalid:['要重新授权','amber'],restricted:['被平台限制','red'],unknown:['待确认','muted'],saved:['已保存','muted']};

export function AccountsPage({data,disabled,onImport,onEdit,onDelete,onAction,onSetup,connectRequest,onConnectHandled}:Props){
  const [sort,setSort]=useState(unsorted);
  const onSort=(column:string)=>setSort(current=>toggleTableSort(current,column));
  const [hackmdDrawer,setHackmdDrawer]=useState<{account?:Account}|null>(null);
  const [plopinoDrawer,setPlopinoDrawer]=useState<{account?:Account}|null>(null);
  const [leafletDrawer,setLeafletDrawer]=useState<{account?:Account}|null>(null);
  const [raindropDrawer,setRaindropDrawer]=useState<{account?:Account}|null>(null);
  const [hereNowDrawer,setHereNowDrawer]=useState<{account?:Account}|null>(null);
  const [shiplyDrawer,setShiplyDrawer]=useState<{account?:Account}|null>(null);
  const [colonyDrawer,setColonyDrawer]=useState<{account?:Account}|null>(null);
  const [agentNotepadDrawer,setAgentNotepadDrawer]=useState<{account?:Account}|null>(null);
  const [openAgentChatDrawer,setOpenAgentChatDrawer]=useState<{account?:Account}|null>(null);
  const [synthfolkDrawer,setSynthfolkDrawer]=useState<{account?:Account}|null>(null);
  const [largeLanguageDrawer,setLargeLanguageDrawer]=useState<{account?:Account}|null>(null);
  const [agentsWikiDrawer,setAgentsWikiDrawer]=useState<{account?:Account}|null>(null);
  const [productIndexDrawer,setProductIndexDrawer]=useState<{account?:Account}|null>(null);
  const [carcinusDrawer,setCarcinusDrawer]=useState<{account?:Account}|null>(null);
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[locatedAccountId,setLocatedAccountId]=useState(''),[guideOpen,setGuideOpen]=useState(false),[revealed,setRevealed]=useState<{id:string;password:string}|null>(null),[copied,setCopied]=useState(false),[gistOpen,setGistOpen]=useState(false),[gistToken,setGistToken]=useState(''),[gistAccountId,setGistAccountId]=useState(''),[bloggerDrawer,setBloggerDrawer]=useState<BloggerDrawer|null>(null),[wordpressDrawer,setWordpressDrawer]=useState<{account?:Account}|null>(null),[blueskyDrawer,setBlueskyDrawer]=useState<{account?:Account}|null>(null),[paragraphDrawer,setParagraphDrawer]=useState<{account?:Account}|null>(null),[articleDrawer,setArticleDrawer]=useState<{account?:Account;channelId?:'mataroa'|'paper-wf'|'hive'}|null>(null),[proseDrawer,setProseDrawer]=useState<{account?:Account}|null>(null),[markestDrawer,setMarkestDrawer]=useState<{account?:Account}|null>(null),[denoDrawer,setDenoDrawer]=useState<{account?:Account}|null>(null);
  useEffect(()=>{if(!revealed)return;const timer=setTimeout(()=>setRevealed(null),20_000);const conceal=()=>setRevealed(null);window.addEventListener('blur',conceal);document.addEventListener('visibilitychange',conceal);return()=>{clearTimeout(timer);window.removeEventListener('blur',conceal);document.removeEventListener('visibilitychange',conceal)}},[revealed]);
  useEffect(()=>{if(disabled)setRevealed(null)},[disabled]);
  useEffect(()=>{if(!gistOpen)return;const previous=document.activeElement as HTMLElement|null;const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer input')?.focus(),0);const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setGistOpen(false)};document.addEventListener('keydown',onKey);return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()}},[gistOpen]);
  const extended=data as ExtendedSnapshot|null,accounts=data?.accounts??[],bindings=extended?.accountBindings??[],mailboxes=extended?.mailboxes??[];
  const connections=useMemo(()=>connectionOverview(data),[data]);
  const readiness=(a:Account)=>accountReadiness(a,bindings.filter(binding=>binding.accountId===a.id).length,data?.channels.find(channel=>channel.id===a.channelId)?.enabled===true);
  const needs=(a:Account)=>readiness(a).needsAttention;
  const reusable=(a:Account)=>readiness(a).reusable;
  const filteredRows=useMemo(()=>accounts.filter(a=>(!locatedAccountId||a.id===locatedAccountId)&&(filter==='all'||filter==='attention'&&needs(a)||filter==='ready'&&reusable(a))&&`${a.email} ${a.displayName||a.username} ${data?.channels.find(c=>c.id===a.channelId)?.name??''}`.toLowerCase().includes(search.toLowerCase())),[accounts,bindings,data,filter,locatedAccountId,search]);
  const gistAccounts=accounts.filter(a=>a.channelId==='github-gist'&&a.credentialKind==='api_token');
  const bloggerAccounts=accounts.filter(a=>a.channelId==='blogger'&&a.credentialKind==='oauth');
  const wordpressAccounts=accounts.filter(a=>a.channelId==='wordpress-com'&&a.credentialKind==='oauth');
  const raindropAccounts=accounts.filter(a=>a.channelId==='raindrop'&&a.credentialKind==='api_token');
  const markestAccounts=accounts.filter(isMarkestReadAccessAccount);
  const bindingSites=(account:Account)=>bindings.filter(b=>b.accountId===account.id).map(b=>data?.sites.find(s=>s.id===b.siteId)?.domain).filter(Boolean) as string[];
  const rows=sortTableRows(filteredRows,sort,(account,key)=>{
    if(key==='platform')return data?.channels.find(channel=>channel.id===account.channelId)?.name??account.channelId;
    if(key==='sites')return bindingSites(account).join('、');
    if(key==='email')return account.email;
    if(key==='status')return statuses[account.status]?.[0]??account.status;
    return account.lastUsedAt??'';
  });
  const openGist=(account?:Account)=>{setGistAccountId(account?.id??'');setGistToken('');setGistOpen(true)};
  const openConnection=(id:ConnectionChannelId,account?:Account)=>{
    if(id==='hackmd')setHackmdDrawer({account});
    else if(id==='colony')setColonyDrawer({account});
    else if(id==='agentnotepad')setAgentNotepadDrawer({account});
    else if(id==='product-index')setProductIndexDrawer({account});
    else if(id==='carcinus')setCarcinusDrawer({account});
    else if(id==='openagentchat')setOpenAgentChatDrawer({account});
    else if(id==='synthfolk')setSynthfolkDrawer({account});
    else if(id==='large-language')setLargeLanguageDrawer({account});
    else if(id==='agentswiki')setAgentsWikiDrawer({account});
    else if(id==='plopino')setPlopinoDrawer({account});
    else if(['mataroa','paper-wf','hive'].includes(id))setArticleDrawer({account,channelId:id as 'mataroa'|'paper-wf'|'hive'});
    else if(id==='prose')setProseDrawer({account});
    else if(id==='markest')setMarkestDrawer({account});
    else if(id==='deno')setDenoDrawer({account});
    else if(id==='here-now')setHereNowDrawer({account});
    else if(id==='shiply')setShiplyDrawer({account});
    else if(id==='github-gist')openGist(account);
    else if(id==='blogger')setBloggerDrawer(account?{initialAccountId:account.id}:{});
    else if(id==='wordpress-com')setWordpressDrawer({account});
    else if(id==='leaflet')setLeafletDrawer({account});
    else if(id==='raindrop')setRaindropDrawer({account});
    else if(id==='paragraph')setParagraphDrawer({account});
    else if(id==='bluesky')setBlueskyDrawer({account});
    // A platform without its own connection form (WhiteWind today) falls back to adding the account directly.
    else onImport(id);
  };
  useEffect(()=>{
    if(!connectRequest)return;
    const id=connectRequest.channelId;
    if(connections.some(row=>row.id===id))openConnection(id as ConnectionChannelId);else onImport(id);
    // Used once: coming back to this tab later must not reopen the same connection.
    onConnectHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[connectRequest?.nonce]);
  const locateAccount=(row:ConnectionOverviewRow)=>{const account=accounts.find(candidate=>candidate.id===row.attentionAccountId);setFilter('all');setLocatedAccountId(account?.id??'');setSearch(account?.displayName||account?.username||account?.email||row.name);document.getElementById('account-directory')?.scrollIntoView({behavior:'smooth'})};
  return <div className="accounts-page"><div className="tab-toolbar"><p className="toolbar-note">{accounts.length} 个发布账号 · {accounts.filter(reusable).length} 个正常 · {accounts.filter(needs).length} 个要你处理</p><Button variant="primary" onClick={()=>setGuideOpen(true)} disabled={disabled}><Plus size={16}/>连接账号</Button></div>
    <section id="account-directory" className="panel directory-panel"><div className="directory-toolbar"><div className="search"><MagnifyingGlass size={17}/><input aria-label="搜索账号" placeholder="搜索平台、邮箱或用户名" value={search} onChange={e=>{setSearch(e.target.value);setLocatedAccountId('')}}/></div><div className="filter-tabs" role="group" aria-label="账号状态筛选">{[['all','全部'],['ready','可复用'],['attention','要你处理']].map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>{setFilter(key);setLocatedAccountId('')}}>{label}</button>)}</div></div>
      {rows.length?<div className="table-scroll account-table-scroll"><table className="accounts-table"><thead><tr><SortHeading column="platform" sort={sort} onSort={onSort}>平台 / 发布账号</SortHeading><SortHeading column="sites" sort={sort} onSort={onSort}>用于哪些网站</SortHeading><SortHeading column="email" sort={sort} onSort={onSort}>邮箱 / 发布账号</SortHeading><SortHeading column="status" sort={sort} onSort={onSort}>状态</SortHeading><SortHeading column="used" sort={sort} onSort={onSort}>最近使用</SortHeading><th>操作</th></tr></thead><tbody>{rows.map(a=>{
        const channel=data?.channels.find(candidate=>candidate.id===a.channelId);
        const isGist=a.channelId==='github-gist',isProductIndex=a.channelId==='product-index',isCarcinus=a.channelId==='carcinus',isRaindrop=a.channelId==='raindrop',isHereNow=a.channelId==='here-now',isShiply=a.channelId==='shiply',isPlopino=a.channelId==='plopino',isAgentsWiki=a.channelId==='agentswiki';
        const isProse=a.channelId==='prose';
        const isMarkest=a.channelId==='markest',isDeno=a.channelId==='deno',denoReadOnly=isDeno&&isDenoReadAccessAccount(a);
        const markestReadOnly=isMarkest&&isMarkestReadAccessAccount(a);
        const [label,tone]=isCarcinus&&a.carcinus?.version===3?['既有页只读','blue']:isDeno?(denoReadOnly?['只读已验证','blue']:['只读连接待检查','amber']):isMarkest?(markestReadOnly?['只读已验证','blue']:['只读连接待检查','amber']):statuses[a.status]??statuses.unknown;
        const accountLabel=isDeno?(a.displayName||'Deno 只读连接'):isMarkest?(a.displayName||'Markest 只读连接'):(a.displayName||a.username);
        const isBloggerOAuth=a.channelId==='blogger'&&a.credentialKind==='oauth';
        const isWordPressOAuth=a.channelId==='wordpress-com'&&a.credentialKind==='oauth';
        const isApiIdentity=a.credentialKind==='api_token'||a.credentialKind==='oauth'||channel?.automation==='api';
        const sites=bindingSites(a);
        const mailbox=mailboxes.find(m=>m.id===(a as Account&{mailboxId?:string}).mailboxId);
        return <tr key={a.id} className={sites.length>=3?'account-shared-warning':undefined}>
          <td><div className="account-identity"><div className="account-icon">{isGist||isProductIndex?<GithubLogo size={20}/>:isBloggerOAuth?<GoogleLogo size={20}/>:isWordPressOAuth?<strong aria-hidden="true">W</strong>:isRaindrop?<strong aria-hidden="true">R</strong>:<UserCircle size={21}/>}</div><div><strong>{channel?.name??(isDeno?'Deno Deploy':isMarkest?'Markest':isGist?'GitHub Gist':isBloggerOAuth?'Blogger':isWordPressOAuth?'WordPress.com':isRaindrop?'Raindrop':'未知平台')}</strong><small>{accountLabel}</small><small className="account-username">{isCarcinus&&a.carcinus?.version===3?'原 identity 与原页面已检查链接；不计为新发布':isDeno?(denoReadOnly?'应用 UUID 已只读验证；组织由你声明，发布未启用、待验收':'只读连接需重新验证；发布未启用'):isMarkest?(markestReadOnly?'已只读验证列表读取；用户声明发布账号，发布未启用':'只读连接需重新验证；发布未启用'):isProductIndex?'已连接本人 GitHub 发布账号；发布平台保持停用待验收':isProse?'已只读验证 SSH/SFTP 发布账号；邀请资格未知':isRaindrop?'本人可写公开合集；首篇实发仍待验收':isWordPressOAuth?'已连接的 WordPress.com 授权博客':isBloggerOAuth?'已连接的 Blogger 授权账号':isGist?'已连接的 API 发布账号':isApiIdentity?(a.source==='generated'?'任务自动创建的 API 发布账号':'已连接的 API 发布账号'):a.source==='generated'?'任务自动创建':'已有账号导入'}</small></div></div>{a.diagnostic&&<p className="account-diagnostic"><WarningCircle size={13}/>{a.diagnostic.message}</p>}</td>
          <td>{sites.length>=3&&<p className="account-sharing-note">这个账号用于 {sites.length} 个网站，容易被平台关联</p>}{sites.length?<div className="binding-chips">{sites.slice(0,2).map(site=><span key={site}>{site}</span>)}{sites.length>2&&<span>+{sites.length-2}</span>}</div>:<span className="unknown-value">{isProductIndex?'未关联网站；不会创建 issue':isDeno?'未关联网站；不会自动发布':isMarkest?'未关联网站；不会自动发布':isWordPressOAuth?'未关联网站':isBloggerOAuth?'未用于 Blogger 博客':'自动选择 / 未用于'}</span>}</td>
          <td><span className="mailbox-label">{mailbox?.label??(isProductIndex?'GitHub 专用令牌':isDeno?'Deno 组织令牌':isMarkest?(a.email||'未声明邮箱'):isRaindrop?'Raindrop Test token':isWordPressOAuth?'WordPress.com OAuth':isProse?'Prose SSH/SFTP':a.email||'未设置')}</span><small className="cell-note">{mailbox?.user??(isProductIndex?'令牌只加密保存在本机；提交前再次核对同一 GitHub 用户':isDeno?'组织由你声明；组织令牌仅加密保存在本机':isMarkest?'用户声明邮箱，未由 API 验证；个人 key 仅加密保存在本机':isRaindrop?'token 仅加密保存在本机；列表只显示已核对的发布账号和合集':isProse?'专用 SSH 私钥仅加密保存在本机':isWordPressOAuth?'浏览器授权信息仅加密保存在本机':isBloggerOAuth?'用 Google 授权，无需保存密码':['mataroa','paper-wf'].includes(a.channelId)?'登录密码已加密保存在本机':isApiIdentity?'API 发布账号无需登录密码':'账号登录邮箱')}</small></td>
          <td><span className={`badge ${tone}`}>{label}</span><small className="account-next-step">{accountNextStep(a,sites.length,channel?.enabled===true)}</small></td><td className="muted">{dateLabel(a.lastUsedAt)}</td>
          <td><div className="account-actions">{a.diagnostic?.retryable&&!isAgentsWiki&&!isDeno&&!isMarkest&&!isBloggerOAuth&&!isWordPressOAuth&&!isCarcinus&&<button className="icon-button" title="继续账号流程" onClick={()=>void onAction('account:retry',{id:a.id},'已安排继续处理账号。')} disabled={disabled}><ArrowClockwise size={17}/></button>}{(!isApiIdentity||['mataroa','paper-wf'].includes(a.channelId))&&<button className="icon-button" title={revealed?.id===a.id?'隐藏密码':'查看密码'} aria-label={`${revealed?.id===a.id?'隐藏':'查看'} ${accountLabel} 的密码`} disabled={disabled||!a.hasPassword} onClick={async()=>{if(revealed?.id===a.id){setRevealed(null);return}const r=await onAction<{password:string}>('account:reveal',{id:a.id});if(r){setRevealed({id:a.id,password:r.password});setCopied(false)}}}>{revealed?.id===a.id?<EyeSlash size={17}/>:<Eye size={17}/>}</button>}{isCarcinus?<button className="icon-button" title="查看 Carcinus 既有页面连接" aria-label={`查看 ${accountLabel} 的 Carcinus 连接`} disabled={disabled} onClick={()=>setCarcinusDrawer({account:a})}><PlugsConnected size={17}/></button>:isBloggerOAuth?<button className="icon-button" title="管理 Blogger 博客关联" aria-label={`管理 ${accountLabel} 的 Blogger 网站关联`} disabled={disabled} onClick={()=>setBloggerDrawer({initialAccountId:a.id})}><PlugsConnected size={17}/></button>:isWordPressOAuth?<button className="icon-button" title="管理 WordPress.com 博客连接" aria-label={`管理 ${accountLabel} 的 WordPress.com 连接`} disabled={disabled} onClick={()=>setWordpressDrawer({account:a})}><PlugsConnected size={17}/></button>:isRaindrop?<button className="icon-button" title="管理 Raindrop 公开合集" aria-label={`管理 ${accountLabel} 的 Raindrop 连接`} disabled={disabled} onClick={()=>setRaindropDrawer({account:a})}><PlugsConnected size={17}/></button>:isPlopino?<button className="icon-button" title="管理 Plopino 网站关联" aria-label={`管理 ${accountLabel} 的 Plopino 连接`} disabled={disabled} onClick={()=>setPlopinoDrawer({account:a})}><PlugsConnected size={17}/></button>:isShiply?<button className="icon-button" title="查看 Shiply 邮箱发布账号" aria-label={`查看 ${accountLabel} 的 Shiply 发布账号`} disabled={disabled} onClick={()=>setShiplyDrawer({account:a})}><PlugsConnected size={17}/></button>:isHereNow?<button className="icon-button" title="管理 here.now 页面与网站关联" aria-label={`管理 ${accountLabel} 的 here.now 连接`} disabled={disabled} onClick={()=>setHereNowDrawer({account:a})}><PlugsConnected size={17}/></button>:isProductIndex?<button className="icon-button" title="管理 AI Product Index GitHub 发布账号与关联网站" aria-label={`管理 ${accountLabel} 的 AI Product Index 连接`} disabled={disabled} onClick={()=>setProductIndexDrawer({account:a})}><PlugsConnected size={17}/></button>:isProse?<button className="icon-button" title="管理 Prose 关联网站" aria-label={`管理 ${accountLabel} 的 Prose 网站关联`} disabled={disabled} onClick={()=>setProseDrawer({account:a})}><PlugsConnected size={17}/></button>:isDeno?<button className="icon-button" title="管理 Deno 网站关联" aria-label={`管理 ${accountLabel} 的网站关联`} disabled={disabled} onClick={()=>setDenoDrawer({account:a})}><PlugsConnected size={17}/></button>:isMarkest?<button className="icon-button" title="管理 Markest 网站关联" aria-label={`管理 ${accountLabel} 的网站关联`} disabled={disabled} onClick={()=>setMarkestDrawer({account:a})}><PlugsConnected size={17}/></button>:isAgentsWiki?<button className="icon-button" title="管理 Agents Wiki 原 agent 与关联网站" aria-label={`管理 ${accountLabel} 的 Agents Wiki 连接`} disabled={disabled} onClick={()=>setAgentsWikiDrawer({account:a})}><PlugsConnected size={17}/></button>:<button className="icon-button" title="编辑网站与收信邮箱关联" aria-label={`用于 ${accountLabel}`} disabled={disabled} onClick={()=>onEdit(a)}><UserCircle size={17}/></button>}{['mataroa','paper-wf','hive'].includes(a.channelId)?<button className="icon-button" title="更新全文平台连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setArticleDrawer({account:a})}><PencilSimple size={17}/></button>:isProse?<button className="icon-button" title="重新验证 Prose SSH 发布账号" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setProseDrawer({account:a})}><PencilSimple size={17}/></button>:isDeno?<button className="icon-button" title="重新验证 Deno 应用" aria-label={`重新验证 ${accountLabel} 的 Deno 应用`} disabled={disabled} onClick={()=>setDenoDrawer({account:a})}><PencilSimple size={17}/></button>:isMarkest?<button className="icon-button" title="重新验证 Markest 原个人 key" aria-label={`重新验证 ${accountLabel} 的原个人 key`} disabled={disabled} onClick={()=>setMarkestDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='leaflet'?<button className="icon-button" title="更新 Leaflet 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setLeafletDrawer({account:a})}><PencilSimple size={17}/></button>:isRaindrop?<button className="icon-button" title="更新 Raindrop token、公开页或网站关联" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setRaindropDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='paragraph'?<button className="icon-button" title="更新 Paragraph 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setParagraphDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='bluesky'?<button className="icon-button" title="更新 Bluesky 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setBlueskyDrawer({account:a})}><PencilSimple size={17}/></button>:isGist?<button className="icon-button" title="更新 Gist 令牌" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>openGist(a)}><PencilSimple size={17}/></button>:isPlopino?<button className="icon-button" title="用邮箱和密码重新验证 Plopino" aria-label={`重新验证 ${accountLabel} 的 Plopino 连接`} disabled={disabled} onClick={()=>setPlopinoDrawer({account:a})}><PencilSimple size={17}/></button>:isHereNow?<button className="icon-button" title="使用已保存 key 重新验证 here.now" aria-label={`重新验证 ${accountLabel} 的 here.now 连接`} disabled={disabled} onClick={()=>setHereNowDrawer({account:a})}><PencilSimple size={17}/></button>:isProductIndex?<button className="icon-button" title="重新验证同一 GitHub 发布账号" aria-label={`重新验证 ${accountLabel} 的 AI Product Index 发布账号`} disabled={disabled} onClick={()=>setProductIndexDrawer({account:a})}><PencilSimple size={17}/></button>:!isApiIdentity&&<button className="icon-button" title="编辑账号与网站关联" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>onEdit(a)}><PencilSimple size={17}/></button>}{isBloggerOAuth?<button className="icon-button danger-icon" title="断开 Blogger 授权" aria-label={`断开 ${accountLabel} 的 Blogger 授权`} disabled={disabled} onClick={()=>setBloggerDrawer({disconnectAccount:a})}><SignOut size={17}/></button>:!isWordPressOAuth&&!isAgentsWiki&&<button className="icon-button danger-icon" title="移除本地记录" aria-label={`移除 ${accountLabel}`} disabled={disabled} onClick={()=>onDelete(a)}><Trash size={17}/></button>}</div>{revealed?.id===a.id&&<div className="secret-reveal"><code>{revealed.password}</code><button className="icon-button" aria-label="复制密码" onClick={async()=>{try{await navigator.clipboard.writeText(revealed.password);setCopied(true)}catch{setCopied(false)}}}>{copied?<Check size={14}/>:<Copy size={14}/>}</button><small>失焦或 20 秒后隐藏</small></div>}</td>
        </tr>
      })}</tbody></table></div>:<Empty icon={ShieldCheck} title={accounts.length?'没有匹配的账号':'还没有保存的发布账号'} body={accounts.length?'调整搜索或状态筛选。':'不必先注册所有平台。可先添加网站；支持自动准备的平台会在任务需要时建立发布账号，需要本人授权的平台会再明确提示。'} action={!accounts.length?<div className="empty-account-actions"><Button variant="primary" onClick={()=>setGuideOpen(true)}>连接账号</Button>{!data?.sites.length&&<Button onClick={onSetup}>先添加网站</Button>}</div>:undefined}/>}</section>
    <div className="account-notes"><ShieldCheck size={16}/><span>账号可复用不代表资料页可容纳多个网站；网站关联会保留任务归属，避免覆盖既有结果。</span><span>{wordpressAccounts.length} 个 WordPress.com 授权 博客 · {bloggerAccounts.length} 个 Blogger 授权 发布账号 · {gistAccounts.length} 个 GitHub Gist 发布账号 · {raindropAccounts.length} 个 Raindrop 公开合集 · {markestAccounts.length} 个 Markest 只读连接</span></div>
    {guideOpen&&<AccountConnectionGuide connections={connections} disabled={disabled} hasSites={!!data?.sites.length} onClose={()=>setGuideOpen(false)} onConnect={(id,accountId)=>openConnection(id,accountId?accounts.find(account=>account.id===accountId):undefined)} onLocate={locateAccount} onImport={onImport} onAddSite={onSetup}/>}
    {gistOpen&&<div className="side-drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setGistOpen(false)}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={gistAccountId?'更新 GitHub Gist 发布账号':'连接 GitHub Gist 发布账号'}><header><div><h2>{gistAccountId?'更新 Gist 令牌':'连接新的 Gist 发布账号'}</h2></div><button className="icon-button" onClick={()=>setGistOpen(false)} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro">使用已有 GitHub 发布账号的 Gists 读写令牌。不会自动注册账号，也不会复制浏览器登录态。</p><Field label="个人访问令牌" hint="令牌只加密保存在本机；列表不会回显令牌。"><input type="password" autoComplete="new-password" value={gistToken} onChange={e=>setGistToken(e.target.value)} placeholder="github_pat_…"/></Field><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:'https://github.com/settings/tokens/new?scopes=gist&description=Site%20Publisher%20Gist'})}>打开 GitHub 令牌设置<ArrowSquareOut size={13}/></Button><div className="drawer-actions"><Button onClick={()=>setGistOpen(false)}>取消</Button><Button variant="primary" disabled={disabled||!gistToken.trim()} onClick={async()=>{const result=await onAction('account:connect-gist',{token:gistToken.trim(),accountId:gistAccountId||undefined},gistAccountId?'Gist 令牌已更新。':'Gist 发布账号已连接。');if(result){setGistOpen(false);setGistToken('')}}}>{gistAccountId?'验证并更新':'验证并连接'}</Button></div></div></aside></div>}
    {colonyDrawer&&<ColonyConnection data={data} disabled={disabled} account={colonyDrawer.account} onClose={()=>setColonyDrawer(null)} onAction={onAction}/>}
    {agentNotepadDrawer&&<AgentNotepadConnection data={data} disabled={disabled} account={agentNotepadDrawer.account} onClose={()=>setAgentNotepadDrawer(null)} onAction={onAction}/>}
    {productIndexDrawer&&<ProductIndexConnection data={data} disabled={disabled} account={productIndexDrawer.account} onClose={()=>setProductIndexDrawer(null)} onAction={onAction}/>}
    {carcinusDrawer&&<CarcinusConnection data={data} disabled={disabled} account={carcinusDrawer.account} onClose={()=>setCarcinusDrawer(null)} onAction={onAction}/>}
    {openAgentChatDrawer&&<OpenAgentChatConnection data={data} disabled={disabled} account={openAgentChatDrawer.account} onClose={()=>setOpenAgentChatDrawer(null)} onAction={onAction}/>}
    {synthfolkDrawer&&<SynthfolkConnection data={data} disabled={disabled} account={synthfolkDrawer.account} onClose={()=>setSynthfolkDrawer(null)} onAction={onAction}/>}
    {largeLanguageDrawer&&<LargeLanguageConnection data={data} disabled={disabled} account={largeLanguageDrawer.account} onClose={()=>setLargeLanguageDrawer(null)} onAction={onAction}/>}
    {agentsWikiDrawer&&<AgentsWikiConnection data={data} disabled={disabled} account={agentsWikiDrawer.account} onClose={()=>setAgentsWikiDrawer(null)} onAction={onAction}/>}
    {plopinoDrawer&&<PlopinoConnection data={data} disabled={disabled} account={plopinoDrawer.account} onClose={()=>setPlopinoDrawer(null)} onAction={onAction}/>}
    {articleDrawer&&<ArticleConnection data={data} disabled={disabled} account={articleDrawer.account} initialChannel={articleDrawer.channelId} onClose={()=>setArticleDrawer(null)} onAction={onAction}/>}
    {proseDrawer&&<ProseConnection data={data} disabled={disabled} account={proseDrawer.account} onClose={()=>setProseDrawer(null)} onAction={onAction}/>}
    {markestDrawer&&<MarkestConnection data={data} disabled={disabled} account={markestDrawer.account} onClose={()=>setMarkestDrawer(null)} onAction={onAction}/>}
    {denoDrawer&&<DenoConnection data={data} disabled={disabled} account={denoDrawer.account} onClose={()=>setDenoDrawer(null)} onAction={onAction}/>}
    {hereNowDrawer&&<HereNowConnection data={data} disabled={disabled} account={hereNowDrawer.account} onClose={()=>setHereNowDrawer(null)} onAction={onAction}/>}
    {shiplyDrawer&&<ShiplyConnection data={data} disabled={disabled} account={shiplyDrawer.account} onClose={()=>setShiplyDrawer(null)} onAction={onAction}/>}
    {hackmdDrawer&&<HackmdConnection data={data} disabled={disabled} account={hackmdDrawer.account} onClose={()=>setHackmdDrawer(null)} onAction={onAction}/>}
    {leafletDrawer&&<LeafletConnection data={data} disabled={disabled} account={leafletDrawer.account} onClose={()=>setLeafletDrawer(null)} onAction={onAction}/>}
    {raindropDrawer&&<RaindropConnection data={data} disabled={disabled} account={raindropDrawer.account} onClose={()=>setRaindropDrawer(null)} onAction={onAction}/>}
    {wordpressDrawer&&<WordPressConnection data={data} disabled={disabled} account={wordpressDrawer.account} onClose={()=>setWordpressDrawer(null)} onAction={onAction}/>}
    {paragraphDrawer&&<ParagraphConnection data={data} disabled={disabled} account={paragraphDrawer.account} onClose={()=>setParagraphDrawer(null)} onAction={onAction}/>}
    {blueskyDrawer&&<BlueskyConnection data={data} disabled={disabled} account={blueskyDrawer.account} onClose={()=>setBlueskyDrawer(null)} onAction={onAction}/>}
    {bloggerDrawer&&<BloggerConnection data={data} disabled={disabled} initialAccountId={bloggerDrawer.initialAccountId} disconnectAccount={bloggerDrawer.disconnectAccount} onClose={()=>setBloggerDrawer(null)} onAction={onAction}/>}
  </div>;
}

export function ProductIndexConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [token,setToken]=useState(''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='product-index'&&binding.accountId===account?.id).map(binding=>binding.siteId)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const toggleSite=(siteId:string,checked:boolean)=>setSiteIds(current=>checked?[...current.filter(value=>value!==siteId),siteId]:current.filter(value=>value!==siteId));
  async function connect(){if(busy||token.trim().length<8||!siteIds.length)return;setBusy(true);setError('');try{const saved=await onAction<Account>('account:connect-product-index',{token:token.trim(),accountId:account?.id,siteIds},account?'GitHub 发布账号和网站关联已重新核对。':'GitHub 发布账号已连接。');setToken('');if(saved)onClose();else setError('GitHub 账号检查或本机保存没完成；没有创建 issue。')}catch{setToken('');setError(account?'原 GitHub 发布账号重新核对失败；现有发布账号、关联网站和 issue 记录保持不变。':'GitHub 账号检查失败；没有保存令牌，也没有创建 issue。')}finally{setBusy(false)}}
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy){setToken('');onClose()}}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 AI Product Index GitHub 发布账号':'连接 AI Product Index GitHub 发布账号'}><header><div><h2>{account?'重新验证本人 GitHub 发布账号':'连接本人已有 GitHub 发布账号'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={()=>{setToken('');onClose()}}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">粘贴你已有 GitHub 账号的专用令牌。外链助手先检查令牌所属的用户名；发布时只会在 <strong>110kc3/seo</strong> 创建一个经审核的登记 issue。</p>
    <p className="cell-note">令牌只加密保存在本机，只发送给 api.github.com。这里不会注册 GitHub、创建 issue 或把令牌写入日志。</p>
    {account&&<p className="account-diagnostic" role="status">当前发布账号：{account.username}。更新令牌仍必须只读核对为同一个 GitHub 用户。</p>}
    <Field label="GitHub 专用令牌" hint="令牌需能读取本人发布账号，并在 110kc3/seo 创建 issue；页面不会回显。"><input aria-label="AI Product Index GitHub 令牌" type="password" autoComplete="new-password" value={token} disabled={disabled||busy} onChange={event=>setToken(event.target.value)} placeholder="github_pat_…"/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://github.com/settings/personal-access-tokens/new'})}>打开 GitHub 令牌设置<ArrowSquareOut size={13}/></Button>
    <fieldset className="checkbox-grid" disabled={disabled||busy}><legend>允许哪些网站使用此发布账号</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" aria-label={`关联网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
    {!data?.sites.length&&<p className="account-diagnostic">请先添加网站，再连接发布账号。</p>}
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={()=>{setToken('');onClose()}}>取消</Button><Button variant="primary" disabled={disabled||busy||token.trim().length<8||!siteIds.length} onClick={()=>void connect()}>{busy?'正在检查…':account?'核对原发布账号并更新':'检查并连接'}</Button></div>
  </div></aside></div>;
}

export interface MarkestConnectionPayload {apiKey:string;declaredEmail:string;label:string;siteIds:string[];accountId?:string}

export function markestConnectionPayload(apiKey:string,declaredEmail:string,label:string,siteIds:string[],accountId?:string):MarkestConnectionPayload{
  const payload:MarkestConnectionPayload={apiKey:apiKey.trim(),declaredEmail:declaredEmail.trim(),label:label.trim(),siteIds:[...new Set(siteIds)]};
  if(accountId)payload.accountId=accountId;
  return payload;
}

export function MarkestConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [apiKey,setApiKey]=useState(''),[declaredEmail,setDeclaredEmail]=useState(account?.email??''),[label,setLabel]=useState(account?.displayName??''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='markest'&&binding.accountId===account?.id).map(binding=>binding.siteId));
  const [busy,setBusy]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),cancelRequested=useRef(false),closing=useRef(false),alive=useRef(true);
  const keyValid=/^mk_live_[a-fA-F0-9]{48}$/.test(apiKey.trim());
  const emailValid=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(declaredEmail.trim());
  const ready=keyValid&&emailValid&&!!label.trim();

  useEffect(()=>{
    alive.current=true;
    return()=>{
      alive.current=false;
      if(inFlight.current)void onAction('account:cancel-markest',{}).catch(()=>undefined);
    };
  },[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer [aria-label="Markest 个人 密钥"]')?.focus(),0);
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')void cancelAndClose()};
    document.addEventListener('keydown',onKey);
    return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()};
  },[]);

  function finishClose(){
    setApiKey('');
    alive.current=false;
    onClose();
  }

  async function connect(){
    if(inFlight.current||!ready)return;
    inFlight.current=true;cancelRequested.current=false;setBusy(true);setError('');
    try{
      const payload=markestConnectionPayload(apiKey,declaredEmail,label,siteIds,account?.id);
      let saved:Account|undefined;
      try{saved=await onAction<Account>('account:connect-markest',payload)}
      catch{
        if(alive.current&&!cancelRequested.current)setError(account?'原 key 的只读验证未完成；现有连接和关联保持不变。':'只读验证未完成；没有保存连接或触发发布。');
        return;
      }
      if(!alive.current||cancelRequested.current)return;
      if(saved){finishClose();return}
      setError(account?'未完成只读验证。更新只能重新验证原 key；若要换 key，请关闭后从总览新增连接。':'未完成只读验证。请核对个人 key、声明邮箱和网络后重试；没有触发发布。');
    }finally{
      setApiKey('');
      inFlight.current=false;
      if(!alive.current)return;
      setBusy(false);
      if(cancelRequested.current)finishClose();
    }
  }

  async function cancelAndClose(){
    if(closing.current)return;
    setApiKey('');
    if(!inFlight.current){closing.current=true;finishClose();return}
    closing.current=true;cancelRequested.current=true;setCancelling(true);setError('');
    try{await onAction('account:cancel-markest',{})}
    catch{if(alive.current)setError('取消请求尚未完成；仍在等待当前只读验证结束。')}
    finally{
      if(!alive.current)return;
      if(inFlight.current){closing.current=false;setCancelling(false)}
      else finishClose();
    }
  }

  const toggleSite=(siteId:string,checked:boolean)=>setSiteIds(current=>checked?[...current.filter(id=>id!==siteId),siteId]:current.filter(id=>id!==siteId));
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancelAndClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 Markest 只读连接':'连接 Markest 个人 key'}><header><div><h2>{account?'重新验证原个人 key':'连接个人 key'}</h2></div><button className="icon-button" aria-label="关闭" disabled={cancelling} onClick={()=>void cancelAndClose()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">请先在本人 Markest 账户的 密钥s 页面手动创建专用个人 key，并只授予 <strong>create_paste、list_own、read_own</strong>。这里仅用 GET 列表验证读取并加密保存，不会创建内容或触发发布。</p>
    <p className="cell-note">读取成功不证明远端发布账号、个人或工作区归属、免费计划或公开写入权限。发布功能当前未启用。</p>
    {account&&<p className="account-diagnostic" role="status">更新现有连接时只能重新粘贴原 key，并可同时修改声明邮箱、标签和网站关联。换 key 会建立新连接，请关闭后从总览选择“新增只读连接”。</p>}
    <Field label="个人 密钥" hint="格式为 mk_live_ 加 48 位十六进制字符。key 只加密保存在本机，页面不会回显。"><input aria-label="Markest 个人 密钥" type="password" autoComplete="new-password" value={apiKey} disabled={disabled||busy} onChange={event=>setApiKey(event.target.value)} placeholder="mk_live_…"/></Field>
    <Field label="声明邮箱" hint="由你声明用于识别本人连接；Markest 列表 API 不会验证此邮箱。"><input aria-label="Markest 声明邮箱" type="email" autoComplete="email" value={declaredEmail} disabled={disabled||busy} onChange={event=>setDeclaredEmail(event.target.value)} placeholder="you@example.com"/></Field>
    <Field label="连接标签" hint="例如“个人发布账户”；仅用于本机区分连接。"><input aria-label="Markest 连接标签" value={label} maxLength={80} disabled={disabled||busy} onChange={event=>setLabel(event.target.value)}/></Field>
    <fieldset className="checkbox-grid" disabled={disabled||busy}><legend>保留关联的网站（不启用发布）</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" aria-label={`关联网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
    {(busy||cancelling)&&<p className="drawer-intro" role="status">{cancelling?'正在取消只读验证，请等待当前请求结束…':'正在验证列表读取；不会发送发布请求…'}</p>}
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={cancelling} onClick={()=>void cancelAndClose()}>{cancelling?'正在取消…':busy?'取消验证':'取消'}</Button><Button variant="primary" disabled={disabled||busy||!ready} onClick={()=>void connect()}>{busy?'正在只读验证…':account?'验证原 key 并更新':'只读验证并保存'}</Button></div>
  </div></aside></div>;
}

function ProseConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const [privateKey,setPrivateKey]=useState(''),[passphrase,setPassphrase]=useState(''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false);
  const clear=()=>{setPrivateKey('');setPassphrase('')};
  async function connect(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    try{
      const saved=await onAction<Account>('account:connect-prose',{privateKey,passphrase:passphrase||undefined,siteIds,accountId:account?.id},'Prose SSH 发布账号已只读验证；邀请与发布资格仍待真实验收。');
      if(saved)onClose();else setError('SSH 发布账号验证或本机保存未完成；没有触发发布。');
    }finally{clear();setBusy(false);inFlight.current=false}
  }
  async function cancel(){clear();if(busy)void onAction('account:cancel-prose',{});onClose()}
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 Prose SSH 发布账号':'连接 Prose SSH 发布账号'}><header><div><h2>{account?'重新验证专用密钥':'连接本人受邀发布账号'}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>void cancel()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">仅使用你粘贴的 Prose/Pico 专用 SSH 私钥，经固定主机只读读取发布账号。不会读取默认密钥、ssh-agent 或电脑上的 SSH 配置，也不会创建账号、申请邀请或触发发布。</p>
    <p className="cell-note">发布账号读取成功不代表已经获得 Prose 邀请或发布资格。平台会保持停用，直到另行完成真实资格与公开全文验收。</p>
    {account&&<p className="cell-note">当前发布账号：{account.username} · {account.publicationUrl}</p>}
    <Field label="Prose 专用 SSH 私钥" hint="请粘贴仅用于该发布账号的私钥；内容只加密保存在本机，列表与日志不会回显。"><textarea aria-label="Prose 专用 SSH 私钥" autoComplete="new-password" rows={8} value={privateKey} disabled={disabled||busy} onChange={event=>setPrivateKey(event.target.value)}/></Field>
    <Field label="私钥口令（可选）"><input aria-label="Prose 私钥口令" autoComplete="new-password" type="password" value={passphrase} disabled={disabled||busy} onChange={event=>setPassphrase(event.target.value)}/></Field>
    <fieldset className="checkbox-grid"><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={!busy&&disabled} onClick={()=>void cancel()}>{busy?'取消验证':'取消'}</Button><Button variant="primary" disabled={disabled||busy||!privateKey} onClick={()=>void connect()}>{busy?'正在只读验证…':'只读验证并保存'}</Button></div>
  </div></aside></div>;
}
