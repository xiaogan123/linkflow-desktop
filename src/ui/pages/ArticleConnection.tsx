import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;initialChannel?:'mataroa'|'paper-wf'|'hive';onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function ArticleConnection({data,disabled,account,initialChannel,onClose,onAction}:Props){
  const [channel,setChannel]=useState<'mataroa'|'paper-wf'|'hive'>(account?.channelId==='mataroa'?'mataroa':account?.channelId==='hive'?'hive':account?'paper-wf':initialChannel??'paper-wf');
  const [username,setUsername]=useState(account?.username??''),[credential,setCredential]=useState(''),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId));
  const inFlight=useRef(false),hive=channel==='hive',mataroa=channel==='mataroa',name=hive?'Hive':mataroa?'Mataroa':'Paper.wf';
  async function connect(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    try{
      const saved=await onAction<Account>(hive?'account:connect-hive':mataroa?'account:connect-mataroa':'account:connect-paper',{username,credential,siteIds,accountId:account?.id,...(hive?{acknowledgePermanent:accepted}:{})},`${name} 已连接，所选网站将按计划自动准备和审核文章。`);
      if(saved)onClose();else setError('连接尚未完成，请核对账号与凭据；已有任务保留。');
    }finally{setCredential('');setBusy(false);inFlight.current=false;}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接全文发布渠道"><header><div><span className="eyebrow">ARTICLE CONNECTION / 全文发布</span><h2>{account?'更新连接':'连接一次，自动发布'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    {!account&&<Field label="发布平台"><select value={channel} disabled={disabled||busy} onChange={event=>{setChannel(event.target.value as typeof channel);setCredential('');setUsername('');setAccepted(false);setError('')}}><option value="mataroa">Mataroa · 免费全文博客</option><option value="paper-wf">Paper.wf · WriteFreely 全文博客</option><option value="hive">Hive · 原创全文</option></select></Field>}
    <p className="drawer-intro">{hive?'连接本人 Hive、Ecency 或 InLeo 使用的账号，之后自动写稿、独立审核并发布。只需要发布专用的 posting key。':mataroa?'已有 Mataroa 账号可直接连接；新账号通常会随任务自动建立，无需预先注册。首次自动连接会关闭 Newsletter，只发布网页。':'已有 Paper.wf 账号可在这里连接。没有账号时会尝试创建，平台要求人机验证时需首次处理；连接后多个网站可复用。'}</p>
    {account&&['mataroa','paper-wf'].includes(account.channelId)&&account.source==='generated'&&account.status!=='registered'&&<p className="drawer-intro">先关闭此面板，在账号行点“查看密码”取得本机保存的登录密码。打开 {name} 后，已注册则登录，未注册则使用原用户名和密码完成首次注册与验证，再回此处连接；不要换身份重复注册。</p>}
    <Field label="账号名"><input aria-label={`${name} 账号名`} autoComplete="username" value={username} disabled={disabled||busy||!!account} onChange={event=>setUsername(event.target.value)}/></Field>
    <Field label={hive?'发布专用密钥（Posting key）':`${name} 登录密码`} hint={hive?'只接受 posting key，不接受账户主密码或资金权限密钥。':'用于登录并取得发布令牌，仅加密保存在本机。'}><input aria-label={`${name} 凭据`} autoComplete="new-password" type="password" value={credential} disabled={disabled||busy} onChange={event=>setCredential(event.target.value)}/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:hive?'https://signup.hive.io/':mataroa?'https://mataroa.blog/accounts/edit/':'https://paper.wf/'})}>打开 {name}<ArrowSquareOut size={13}/></Button>
    {hive?<label className="checkbox"><input type="checkbox" checked={accepted} disabled={disabled||busy} onChange={event=>setAccepted(event.target.checked)}/>我了解文章及编辑历史会公开保留在 Hive 链上，无法彻底删除。软件只发布文章，不转账或投票。</label>:mataroa?<p className="cell-note">连接已有账号前，请在 Mataroa 的 Blog settings 中关闭 Newsletter。软件只发布网页，不会向订阅者发送邮件；账号密码和令牌仅加密保存在本机。</p>:<p className="cell-note">按已核官方接口和产品资料审核原创内容；目前未找到 Paper.wf 完整内容政策，不代表平台明确允许所有推广主题。</p>}
    <fieldset className="checkbox-grid"><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!username.trim()||!credential||hive&&!accepted} onClick={()=>void connect()}>{busy?'正在验证…':'验证并连接'}</Button></div>
  </div></aside></div>;
}
