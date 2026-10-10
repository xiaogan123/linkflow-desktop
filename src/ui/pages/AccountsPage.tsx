import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowClockwise,ArrowSquareOut,Check,Copy,Eye,EyeSlash,GithubLogo,GoogleLogo,LockKey,MagnifyingGlass,PencilSimple,Plus,PlugsConnected,ShieldCheck,SignOut,Trash,UserCircle,WarningCircle,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Empty,Field} from '../components';
import {dateLabel} from '../presentation';
import {connectionOverview,isMarkestReadAccessAccount,isDenoReadAccessAccount,type ConnectionChannelId,type ConnectionOverviewRow} from '../channel-connections';
import {BlueskyConnection} from './BlueskyConnection';
import {ParagraphConnection} from './ParagraphConnection';
import {ArticleConnection} from './ArticleConnection';
import {BloggerConnection} from './BloggerConnection';
import {LeafletConnection} from './LeafletConnection';
import {WordPressConnection} from './WordPressConnection';
import {DenoConnection} from './DenoConnection';
import {AccountConnectionGuide,AccountConnectionSummary} from './AccountConnectionGuide';
import {accountNextStep,accountReadiness} from '../account-guidance';

type Binding={id:string;siteId:string;channelId:string;accountId:string};
type Mailbox={id:string;label:string;user:string};
type ExtendedSnapshot=Snapshot&{accountBindings?:Binding[];mailboxes?:Mailbox[]};
type Props={data:Snapshot|null;disabled:boolean;onImport:(channelId?:string)=>void;onEdit:(a:Account)=>void;onDelete:(a:Account)=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;onSetup:()=>void};
type BloggerDrawer={initialAccountId?:string;disconnectAccount?:Account};
const statuses:Record<string,[string,string]>={registered:['已验证','green'],draft:['准备注册','blue'],needs_verification:['等待验证','amber'],credentials_invalid:['凭据待修复','amber'],restricted:['平台限制','red'],unknown:['待确认','muted'],saved:['已保存','muted']};

export function AccountsPage({data,disabled,onImport,onEdit,onDelete,onAction,onSetup}:Props){
  const [leafletDrawer,setLeafletDrawer]=useState<{account?:Account}|null>(null);
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[locatedAccountId,setLocatedAccountId]=useState(''),[guideOpen,setGuideOpen]=useState(false),[revealed,setRevealed]=useState<{id:string;password:string}|null>(null),[copied,setCopied]=useState(false),[gistOpen,setGistOpen]=useState(false),[gistToken,setGistToken]=useState(''),[gistAccountId,setGistAccountId]=useState(''),[bloggerDrawer,setBloggerDrawer]=useState<BloggerDrawer|null>(null),[wordpressDrawer,setWordpressDrawer]=useState<{account?:Account}|null>(null),[blueskyDrawer,setBlueskyDrawer]=useState<{account?:Account}|null>(null),[paragraphDrawer,setParagraphDrawer]=useState<{account?:Account}|null>(null),[articleDrawer,setArticleDrawer]=useState<{account?:Account;channelId?:'mataroa'|'paper-wf'|'hive'}|null>(null),[proseDrawer,setProseDrawer]=useState<{account?:Account}|null>(null),[markestDrawer,setMarkestDrawer]=useState<{account?:Account}|null>(null),[denoDrawer,setDenoDrawer]=useState<{account?:Account}|null>(null);
  useEffect(()=>{if(!revealed)return;const timer=setTimeout(()=>setRevealed(null),20_000);const conceal=()=>setRevealed(null);window.addEventListener('blur',conceal);document.addEventListener('visibilitychange',conceal);return()=>{clearTimeout(timer);window.removeEventListener('blur',conceal);document.removeEventListener('visibilitychange',conceal)}},[revealed]);
  useEffect(()=>{if(disabled)setRevealed(null)},[disabled]);
  useEffect(()=>{if(!gistOpen)return;const previous=document.activeElement as HTMLElement|null;const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer input')?.focus(),0);const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setGistOpen(false)};document.addEventListener('keydown',onKey);return()=>{clearTimeout(timer);document.removeEventListener('keydown',onKey);previous?.focus()}},[gistOpen]);
  const extended=data as ExtendedSnapshot|null,accounts=data?.accounts??[],bindings=extended?.accountBindings??[],mailboxes=extended?.mailboxes??[];
  const connections=useMemo(()=>connectionOverview(data),[data]);
  const readiness=(a:Account)=>accountReadiness(a,bindings.filter(binding=>binding.accountId===a.id).length,data?.channels.find(channel=>channel.id===a.channelId)?.enabled===true);
  const needs=(a:Account)=>readiness(a).needsAttention;
  const reusable=(a:Account)=>readiness(a).reusable;
  const rows=useMemo(()=>accounts.filter(a=>(!locatedAccountId||a.id===locatedAccountId)&&(filter==='all'||filter==='attention'&&needs(a)||filter==='ready'&&reusable(a))&&`${a.email} ${a.displayName||a.username} ${data?.channels.find(c=>c.id===a.channelId)?.name??''}`.toLowerCase().includes(search.toLowerCase())),[accounts,bindings,data,filter,locatedAccountId,search]);
  const gistAccounts=accounts.filter(a=>a.channelId==='github-gist'&&a.credentialKind==='api_token');
  const bloggerAccounts=accounts.filter(a=>a.channelId==='blogger'&&a.credentialKind==='oauth');
  const wordpressAccounts=accounts.filter(a=>a.channelId==='wordpress-com'&&a.credentialKind==='oauth');
  const markestAccounts=accounts.filter(isMarkestReadAccessAccount);
  const bindingSites=(account:Account)=>bindings.filter(b=>b.accountId===account.id).map(b=>data?.sites.find(s=>s.id===b.siteId)?.domain).filter(Boolean) as string[];
  const openGist=(account?:Account)=>{setGistAccountId(account?.id??'');setGistToken('');setGistOpen(true)};
  const openConnection=(id:ConnectionChannelId,account?:Account)=>{
    if(['mataroa','paper-wf','hive'].includes(id))setArticleDrawer({account,channelId:id as 'mataroa'|'paper-wf'|'hive'});
    else if(id==='prose')setProseDrawer({account});
    else if(id==='markest')setMarkestDrawer({account});
    else if(id==='deno')setDenoDrawer({account});
    else if(id==='github-gist')openGist(account);
    else if(id==='blogger')setBloggerDrawer(account?{initialAccountId:account.id}:{});
    else if(id==='wordpress-com')setWordpressDrawer({account});
    else if(id==='leaflet')setLeafletDrawer({account});
    else if(id==='paragraph')setParagraphDrawer({account});
    else if(id==='bluesky')setBlueskyDrawer({account});
  };
  const locateAccount=(row:ConnectionOverviewRow)=>{const account=accounts.find(candidate=>candidate.id===row.attentionAccountId);setFilter('all');setLocatedAccountId(account?.id??'');setSearch(account?.displayName||account?.username||account?.email||row.name);document.getElementById('account-directory')?.scrollIntoView({behavior:'smooth'})};
  return <div className="page collection-page accounts-page"><div className="page-heading compact-heading"><div><div className="eyebrow">IDENTITIES / 账号与绑定</div><h1>需要时再连接账号。</h1><p>先选择平台；软件会打开对应的专用步骤。没有账号也可以先添加网站。</p></div><div className="heading-actions"><Button variant="primary" onClick={()=>setGuideOpen(true)} disabled={disabled}><Plus size={16}/>添加 / 连接账号</Button></div></div>
    <AccountConnectionSummary connections={connections} disabled={disabled} accountCount={accounts.length} onStart={()=>setGuideOpen(true)} onConnect={(id,accountId)=>openConnection(id,accountId?accounts.find(account=>account.id===accountId):undefined)} onLocate={locateAccount}/>
    <div className="accounts-metrics compact-metrics"><span><strong>{accounts.length}</strong> 保存身份</span><span><strong>{accounts.filter(reusable).length}</strong> 已验证身份</span><span><strong>{new Set(bindings.map(b=>b.siteId)).size}</strong> 已绑定网站</span><span className={accounts.some(needs)?'attention-count':''}><strong>{accounts.filter(needs).length}</strong> 需接续</span><span className="local-encryption"><LockKey size={14}/>凭据仅在本机解密</span></div>
    <section id="account-directory" className="panel directory-panel"><div className="directory-toolbar"><div className="search"><MagnifyingGlass size={17}/><input aria-label="搜索账号" placeholder="搜索渠道、邮箱或用户名" value={search} onChange={e=>{setSearch(e.target.value);setLocatedAccountId('')}}/></div><div className="filter-tabs" role="group" aria-label="账号状态筛选">{[['all','全部'],['ready','可复用'],['attention','需接续']].map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>{setFilter(key);setLocatedAccountId('')}}>{label}</button>)}</div></div>
      {rows.length?<div className="table-scroll account-table-scroll"><table className="accounts-table"><thead><tr><th>渠道 / 身份</th><th>网站绑定</th><th>邮箱 / 凭据</th><th>状态</th><th>最近使用</th><th>操作</th></tr></thead><tbody>{rows.map(a=>{
        const channel=data?.channels.find(candidate=>candidate.id===a.channelId);
        const isGist=a.channelId==='github-gist';
        const isProse=a.channelId==='prose';
        const isMarkest=a.channelId==='markest',isDeno=a.channelId==='deno',denoReadOnly=isDeno&&isDenoReadAccessAccount(a);
        const markestReadOnly=isMarkest&&isMarkestReadAccessAccount(a);
        const [label,tone]=isDeno?(denoReadOnly?['只读已验证','blue']:['只读连接待检查','amber']):isMarkest?(markestReadOnly?['只读已验证','blue']:['只读连接待检查','amber']):statuses[a.status]??statuses.unknown;
        const accountLabel=isDeno?(a.displayName||'Deno 只读连接'):isMarkest?(a.displayName||'Markest 只读连接'):(a.displayName||a.username);
        const isBloggerOAuth=a.channelId==='blogger'&&a.credentialKind==='oauth';
        const isWordPressOAuth=a.channelId==='wordpress-com'&&a.credentialKind==='oauth';
        const isApiIdentity=a.credentialKind==='api_token'||a.credentialKind==='oauth'||channel?.automation==='api';
        const sites=bindingSites(a);
        const mailbox=mailboxes.find(m=>m.id===(a as Account&{mailboxId?:string}).mailboxId);
        return <tr key={a.id}>
          <td><div className="account-identity"><div className="account-icon">{isGist?<GithubLogo size={20}/>:isBloggerOAuth?<GoogleLogo size={20}/>:isWordPressOAuth?<strong aria-hidden="true">W</strong>:<UserCircle size={21}/>}</div><div><strong>{channel?.name??(isDeno?'Deno Deploy':isMarkest?'Markest':isGist?'GitHub Gist':isBloggerOAuth?'Blogger':isWordPressOAuth?'WordPress.com':'未知渠道')}</strong><small>{accountLabel}</small><small className="account-username">{isDeno?(denoReadOnly?'应用 UUID 已只读验证；组织由你声明，发布未启用、待验收':'只读连接需重新验证；发布未启用'):isMarkest?(markestReadOnly?'已只读验证列表读取；用户声明身份，发布未启用':'只读连接需重新验证；发布未启用'):isProse?'已只读验证 SSH/SFTP 身份；邀请资格未知':isWordPressOAuth?'已连接的 WordPress.com OAuth 博客':isBloggerOAuth?'已连接的 Blogger OAuth 身份':isGist?'已连接的 API 身份':isApiIdentity?(a.source==='generated'?'任务自动创建的 API 身份':'已连接的 API 身份'):a.source==='generated'?'任务自动创建':'已有账号导入'}</small></div></div>{a.diagnostic&&<p className="account-diagnostic"><WarningCircle size={13}/>{a.diagnostic.message}</p>}</td>
          <td>{sites.length?<div className="binding-chips">{sites.slice(0,2).map(site=><span key={site}>{site}</span>)}{sites.length>2&&<span>+{sites.length-2}</span>}</div>:<span className="unknown-value">{isDeno?'未关联网站；不会自动发布':isMarkest?'未关联网站；不会自动发布':isWordPressOAuth?'未关联网站':isBloggerOAuth?'未绑定 Blogger 博客':'自动选择 / 未绑定'}</span>}</td>
          <td><span className="mailbox-label">{mailbox?.label??(isDeno?'Deno 组织令牌':isMarkest?(a.email||'未声明邮箱'):isWordPressOAuth?'WordPress.com OAuth':isProse?'Prose SSH/SFTP':a.email||'未设置')}</span><small className="cell-note">{mailbox?.user??(isDeno?'组织由你声明；组织令牌仅加密保存在本机':isMarkest?'用户声明邮箱，未由 API 验证；个人 key 仅加密保存在本机':isProse?'专用 SSH 私钥仅加密保存在本机':isWordPressOAuth?'浏览器授权凭据仅加密保存在本机':isBloggerOAuth?'Google OAuth 身份无需保存密码':['mataroa','paper-wf'].includes(a.channelId)?'登录密码已加密保存在本机':isApiIdentity?'API 身份无需登录密码':'账号登录邮箱')}</small></td>
          <td><span className={`badge ${tone}`}>{label}</span><small className="account-next-step">{accountNextStep(a,sites.length,channel?.enabled===true)}</small></td><td className="muted">{dateLabel(a.lastUsedAt)}</td>
          <td><div className="account-actions">{a.diagnostic?.retryable&&!isDeno&&!isMarkest&&!isBloggerOAuth&&!isWordPressOAuth&&<button className="icon-button" title="继续账号流程" onClick={()=>void onAction('account:retry',{id:a.id},'已安排继续处理账号。')} disabled={disabled}><ArrowClockwise size={17}/></button>}{(!isApiIdentity||['mataroa','paper-wf'].includes(a.channelId))&&<button className="icon-button" title={revealed?.id===a.id?'隐藏密码':'查看密码'} aria-label={`${revealed?.id===a.id?'隐藏':'查看'} ${accountLabel} 的密码`} disabled={disabled||!a.hasPassword} onClick={async()=>{if(revealed?.id===a.id){setRevealed(null);return}const r=await onAction<{password:string}>('account:reveal',{id:a.id});if(r){setRevealed({id:a.id,password:r.password});setCopied(false)}}}>{revealed?.id===a.id?<EyeSlash size={17}/>:<Eye size={17}/>}</button>}{isBloggerOAuth?<button className="icon-button" title="管理 Blogger 博客绑定" aria-label={`管理 ${accountLabel} 的 Blogger 绑定`} disabled={disabled} onClick={()=>setBloggerDrawer({initialAccountId:a.id})}><PlugsConnected size={17}/></button>:isWordPressOAuth?<button className="icon-button" title="管理 WordPress.com 博客连接" aria-label={`管理 ${accountLabel} 的 WordPress.com 连接`} disabled={disabled} onClick={()=>setWordpressDrawer({account:a})}><PlugsConnected size={17}/></button>:isProse?<button className="icon-button" title="管理 Prose 网站绑定" aria-label={`管理 ${accountLabel} 的 Prose 绑定`} disabled={disabled} onClick={()=>setProseDrawer({account:a})}><PlugsConnected size={17}/></button>:isDeno?<button className="icon-button" title="管理 Deno 网站关联" aria-label={`管理 ${accountLabel} 的网站关联`} disabled={disabled} onClick={()=>setDenoDrawer({account:a})}><PlugsConnected size={17}/></button>:isMarkest?<button className="icon-button" title="管理 Markest 网站关联" aria-label={`管理 ${accountLabel} 的网站关联`} disabled={disabled} onClick={()=>setMarkestDrawer({account:a})}><PlugsConnected size={17}/></button>:<button className="icon-button" title="编辑网站与收件箱绑定" aria-label={`绑定 ${accountLabel}`} disabled={disabled} onClick={()=>onEdit(a)}><UserCircle size={17}/></button>}{['mataroa','paper-wf','hive'].includes(a.channelId)?<button className="icon-button" title="更新全文渠道连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setArticleDrawer({account:a})}><PencilSimple size={17}/></button>:isProse?<button className="icon-button" title="重新验证 Prose SSH 身份" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setProseDrawer({account:a})}><PencilSimple size={17}/></button>:isDeno?<button className="icon-button" title="重新验证 Deno 应用" aria-label={`重新验证 ${accountLabel} 的 Deno 应用`} disabled={disabled} onClick={()=>setDenoDrawer({account:a})}><PencilSimple size={17}/></button>:isMarkest?<button className="icon-button" title="重新验证 Markest 原个人 key" aria-label={`重新验证 ${accountLabel} 的原个人 key`} disabled={disabled} onClick={()=>setMarkestDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='leaflet'?<button className="icon-button" title="更新 Leaflet 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setLeafletDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='paragraph'?<button className="icon-button" title="更新 Paragraph 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setParagraphDrawer({account:a})}><PencilSimple size={17}/></button>:a.channelId==='bluesky'?<button className="icon-button" title="更新 Bluesky 连接" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>setBlueskyDrawer({account:a})}><PencilSimple size={17}/></button>:isGist?<button className="icon-button" title="更新 Gist 令牌" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>openGist(a)}><PencilSimple size={17}/></button>:!isApiIdentity&&<button className="icon-button" title="编辑账号与绑定" aria-label={`更新 ${accountLabel}`} disabled={disabled} onClick={()=>onEdit(a)}><PencilSimple size={17}/></button>}{isBloggerOAuth?<button className="icon-button danger-icon" title="断开 Blogger 授权" aria-label={`断开 ${accountLabel} 的 Blogger 授权`} disabled={disabled} onClick={()=>setBloggerDrawer({disconnectAccount:a})}><SignOut size={17}/></button>:!isWordPressOAuth&&<button className="icon-button danger-icon" title="移除本地记录" aria-label={`移除 ${accountLabel}`} disabled={disabled} onClick={()=>onDelete(a)}><Trash size={17}/></button>}</div>{revealed?.id===a.id&&<div className="secret-reveal"><code>{revealed.password}</code><button className="icon-button" aria-label="复制密码" onClick={async()=>{try{await navigator.clipboard.writeText(revealed.password);setCopied(true)}catch{setCopied(false)}}}>{copied?<Check size={14}/>:<Copy size={14}/>}</button><small>失焦或 20 秒后隐藏</small></div>}</td>
        </tr>
      })}</tbody></table></div>:<Empty icon={ShieldCheck} title={accounts.length?'没有匹配的账号':'还没有保存的身份'} body={accounts.length?'调整搜索或状态筛选。':'不必先注册所有平台。可先添加网站；支持自动准备的渠道会在任务需要时建立身份，需要本人授权的平台会再明确提示。'} action={!accounts.length?<div className="empty-account-actions"><Button variant="primary" onClick={()=>setGuideOpen(true)}>添加 / 连接账号</Button>{!data?.sites.length&&<Button onClick={onSetup}>先添加网站</Button>}</div>:undefined}/>}</section>
    <div className="account-notes"><ShieldCheck size={16}/><span>账号可复用不代表资料页可容纳多个网站；绑定会保留任务归属，避免覆盖既有结果。</span><span>{wordpressAccounts.length} 个 WordPress.com OAuth 博客 · {bloggerAccounts.length} 个 Blogger OAuth 身份 · {gistAccounts.length} 个 GitHub Gist 身份 · {markestAccounts.length} 个 Markest 只读连接</span></div>
    {guideOpen&&<AccountConnectionGuide connections={connections} disabled={disabled} hasSites={!!data?.sites.length} onClose={()=>setGuideOpen(false)} onConnect={(id,accountId)=>openConnection(id,accountId?accounts.find(account=>account.id===accountId):undefined)} onLocate={locateAccount} onImport={onImport} onAddSite={onSetup}/>}
    {gistOpen&&<div className="side-drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setGistOpen(false)}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={gistAccountId?'更新 GitHub Gist 身份':'连接 GitHub Gist 身份'}><header><div><span className="eyebrow">GITHUB IDENTITY</span><h2>{gistAccountId?'更新 Gist 令牌':'连接新的 Gist 身份'}</h2></div><button className="icon-button" onClick={()=>setGistOpen(false)} aria-label="关闭"><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro">使用已有 GitHub 身份的 Gists 读写令牌。不会自动注册账号，也不会复制浏览器登录态。</p><Field label="个人访问令牌" hint="凭据只加密保存在本机；列表不会回显令牌。"><input type="password" autoComplete="new-password" value={gistToken} onChange={e=>setGistToken(e.target.value)} placeholder="github_pat_…"/></Field><Button variant="text" disabled={disabled} onClick={()=>void onAction('external:open',{url:'https://github.com/settings/tokens/new?scopes=gist&description=Linkflow%20Gist'})}>打开 GitHub 令牌设置<ArrowSquareOut size={13}/></Button><div className="drawer-actions"><Button onClick={()=>setGistOpen(false)}>取消</Button><Button variant="primary" disabled={disabled||!gistToken.trim()} onClick={async()=>{const result=await onAction('account:connect-gist',{token:gistToken.trim(),accountId:gistAccountId||undefined},gistAccountId?'Gist 令牌已更新。':'Gist 身份已连接。');if(result){setGistOpen(false);setGistToken('')}}}>{gistAccountId?'验证并更新':'验证并连接'}</Button></div></div></aside></div>}
    {articleDrawer&&<ArticleConnection data={data} disabled={disabled} account={articleDrawer.account} initialChannel={articleDrawer.channelId} onClose={()=>setArticleDrawer(null)} onAction={onAction}/>}
    {proseDrawer&&<ProseConnection data={data} disabled={disabled} account={proseDrawer.account} onClose={()=>setProseDrawer(null)} onAction={onAction}/>}
    {markestDrawer&&<MarkestConnection data={data} disabled={disabled} account={markestDrawer.account} onClose={()=>setMarkestDrawer(null)} onAction={onAction}/>}
    {denoDrawer&&<DenoConnection data={data} disabled={disabled} account={denoDrawer.account} onClose={()=>setDenoDrawer(null)} onAction={onAction}/>}
    {leafletDrawer&&<LeafletConnection data={data} disabled={disabled} account={leafletDrawer.account} onClose={()=>setLeafletDrawer(null)} onAction={onAction}/>}
    {wordpressDrawer&&<WordPressConnection data={data} disabled={disabled} account={wordpressDrawer.account} onClose={()=>setWordpressDrawer(null)} onAction={onAction}/>}
    {paragraphDrawer&&<ParagraphConnection data={data} disabled={disabled} account={paragraphDrawer.account} onClose={()=>setParagraphDrawer(null)} onAction={onAction}/>}
    {blueskyDrawer&&<BlueskyConnection data={data} disabled={disabled} account={blueskyDrawer.account} onClose={()=>setBlueskyDrawer(null)} onAction={onAction}/>}
    {bloggerDrawer&&<BloggerConnection data={data} disabled={disabled} initialAccountId={bloggerDrawer.initialAccountId} disconnectAccount={bloggerDrawer.disconnectAccount} onClose={()=>setBloggerDrawer(null)} onAction={onAction}/>}
  </div>;
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
    const timer=setTimeout(()=>document.querySelector<HTMLElement>('.side-drawer [aria-label="Markest 个人 API key"]')?.focus(),0);
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
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancelAndClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 Markest 只读连接':'连接 Markest 个人 key'}><header><div><span className="eyebrow">MARKEST · 只读连接</span><h2>{account?'重新验证原个人 key':'连接个人 key'}</h2></div><button className="icon-button" aria-label="关闭" disabled={cancelling} onClick={()=>void cancelAndClose()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">请先在本人 Markest 账户的 API keys 页面手动创建专用个人 key，并只授予 <strong>create_paste、list_own、read_own</strong>。这里仅用 GET 列表验证读取并加密保存，不会创建内容或触发发布。</p>
    <p className="cell-note">读取成功不证明远端账号身份、个人或工作区归属、免费计划或公开写入权限。发布功能当前未启用。</p>
    {account&&<p className="account-diagnostic" role="status">更新现有连接时只能重新粘贴原 key，并可同时修改声明邮箱、标签和网站关联。换 key 会建立新连接，请关闭后从总览选择“新增只读连接”。</p>}
    <Field label="个人 API key" hint="格式为 mk_live_ 加 48 位十六进制字符。key 只加密保存在本机，页面不会回显。"><input aria-label="Markest 个人 API key" type="password" autoComplete="new-password" value={apiKey} disabled={disabled||busy} onChange={event=>setApiKey(event.target.value)} placeholder="mk_live_…"/></Field>
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
      const saved=await onAction<Account>('account:connect-prose',{privateKey,passphrase:passphrase||undefined,siteIds,accountId:account?.id},'Prose SSH 身份已只读验证；邀请与发布资格仍待真实验收。');
      if(saved)onClose();else setError('SSH 身份验证或本机保存未完成；没有触发发布。');
    }finally{clear();setBusy(false);inFlight.current=false}
  }
  async function cancel(){clear();if(busy)void onAction('account:cancel-prose',{});onClose()}
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 Prose SSH 身份':'连接 Prose SSH 身份'}><header><div><span className="eyebrow">PROSE SSH / SFTP · 只读身份验证</span><h2>{account?'重新验证专用密钥':'连接本人受邀身份'}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>void cancel()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">仅使用你粘贴的 Prose/Pico 专用 SSH 私钥，经固定主机只读读取身份。不会读取默认密钥、ssh-agent 或系统 SSH 配置，也不会创建账号、申请邀请或触发发布。</p>
    <p className="cell-note">身份读取成功不代表已经获得 Prose 邀请或发布资格。渠道会保持停用，直到另行完成真实资格与公开全文验收。</p>
    {account&&<p className="cell-note">当前身份：{account.username} · {account.publicationUrl}</p>}
    <Field label="Prose 专用 SSH 私钥" hint="请粘贴仅用于该身份的私钥；内容只加密保存在本机，列表与日志不会回显。"><textarea aria-label="Prose 专用 SSH 私钥" autoComplete="new-password" rows={8} value={privateKey} disabled={disabled||busy} onChange={event=>setPrivateKey(event.target.value)}/></Field>
    <Field label="私钥口令（可选）"><input aria-label="Prose 私钥口令" autoComplete="new-password" type="password" value={passphrase} disabled={disabled||busy} onChange={event=>setPassphrase(event.target.value)}/></Field>
    <fieldset className="checkbox-grid"><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={!busy&&disabled} onClick={()=>void cancel()}>{busy?'取消验证':'取消'}</Button><Button variant="primary" disabled={disabled||busy||!privateKey} onClick={()=>void connect()}>{busy?'正在只读验证…':'只读验证并保存'}</Button></div>
  </div></aside></div>;
}
