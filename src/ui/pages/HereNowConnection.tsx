import {useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};

export function HereNowConnection({data,disabled,account,onClose,onAction}:Props){
  const [useKey,setUseKey]=useState(!!account?.hereNow);
  const [active,setActive]=useState(account),[email,setEmail]=useState(account?.email??(data?.mailboxes.length===1?data.mailboxes[0].user:'')),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='here-now'&&binding.accountId===account?.id).map(binding=>binding.siteId));
  useEffect(()=>{const latest=data?.accounts.find(value=>value.id===active?.id);if(latest)setActive(latest)},[data?.accounts,active?.id]);
  if(useKey||active?.hereNow)return <HereNowKeyConnection {...{data,disabled,account:active,onClose,onAction}}/>;
  const stage=active?.hereNowEmail?.stage;
  const waitEnded=stage==='code_sent'&&Date.now()-Date.parse(active!.hereNowEmail!.requestedAt)>=10*60_000;
  const validEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())&&email.length<=254;
  async function run(command:string,payload:unknown,success:string){
    if(busy)return;setBusy(true);setError('');
    try{const saved=await onAction<Account>(command,payload,success);setCode('');if(saved)setActive(saved);else setError('操作未完成；请查看原账号状态，结果不明时不要再次提交。')}
    catch{setCode('');setError('操作结果不明；原账号记录已保留，不会重复注册。')}
    finally{setBusy(false)}
  }
  const stageLabel:Record<string,string>={requesting:'正在请求验证码',request_unknown:'验证码请求结果不明',code_sent:'等待邮箱验证码',verifying:'正在验证邮箱',verify_unknown:'验证结果不明',verify_opaque:'验证响应已加密保存，等待恢复',ready:'账号已连接'};
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 here.now 邮箱账号"><header><div><h2>连接 here.now</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">网站关联的收信邮箱通过测试后，到期任务会自动请求并读取验证码。可信邮件可自动完成验证，其他邮件会提示你确认。已有账号会优先复用，无需为每个域名重新注册。</p>
    <p className="cell-note">这里也可手动连接。没有待执行任务时，请在下方填写邮箱验证码；连接后仍按稿件审核和排期发布。</p>
    <Field label="本人邮箱"><input aria-label="here.now 收件邮箱" type="email" autoComplete="email" value={email} disabled={disabled||busy||!!active} onChange={event=>setEmail(event.target.value)}/></Field>
    {!active&&<Button variant="primary" disabled={disabled||busy||!validEmail} onClick={()=>void run('account:request-here-now-code',{email:email.trim(),...(siteIds.length===1?{siteId:siteIds[0]}:{})},'已向原邮箱请求验证码。')}>请求一次验证码</Button>}
    {active&&<p role="status" className="account-diagnostic">{stageLabel[stage??'']??'原账号状态需检查'}。{waitEnded?'本机本轮等待已结束，不代表平台验证码已经失效。':stage==='request_unknown'||stage==='verify_unknown'?'原请求与账号保留，不会自动重试。':''}</p>}
    {stage==='code_sent'&&!waitEnded&&<Field label="邮箱中的验证码" hint="格式如 ABCD-2345；已有待执行任务且邮箱接通时会自动读取。"><input aria-label="here.now 邮箱验证码" autoComplete="one-time-code" maxLength={9} value={code} disabled={disabled||busy} onChange={event=>setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,''))}/></Field>}
    {(!active||stage==='code_sent'||stage==='verify_opaque')&&<fieldset className="checkbox-grid" disabled={disabled||busy}><legend>允许此账号用于哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={event=>setSiteIds(current=>event.target.checked?[...new Set([...current,site.id])]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>}
    {stage==='code_sent'&&!waitEnded&&<Button variant="primary" disabled={disabled||busy||!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)} onClick={()=>void run('account:verify-here-now-code',{accountId:active!.id,code,siteIds},'here.now 账号已连接，密钥已加密保存。')}>验证并保存</Button>}
    {waitEnded&&<Button disabled={disabled||busy} onClick={()=>void run('account:resend-here-now-code',{accountId:active!.id},'已为原 here.now 账号重新请求验证码；请使用最新邮件。')}>为原账号重新取码</Button>}
    {stage==='verify_opaque'&&<Button disabled={disabled||busy} onClick={()=>void run('account:recover-here-now-verify',{accountId:active!.id,siteIds},'已恢复原 here.now 验证响应。')}>从原响应恢复</Button>}
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    {!active&&<Button disabled={busy} onClick={()=>setUseKey(true)}>已有命名密钥，直接连接</Button>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>关闭</Button></div>
  </div></aside></div>;
}

function HereNowKeyConnection({data,disabled,account,onClose,onAction}:Props){
  const [apiKey,setApiKey]=useState(''),[existingSiteUrl,setExistingSiteUrl]=useState(account?.hereNow?.existingSiteUrl??''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(binding=>binding.channelId==='here-now'&&binding.accountId===account?.id).map(binding=>binding.siteId));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const running=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(running.current)void onAction('account:cancel-here-now',{}).catch(()=>undefined)}},[]);
  const keyValid=/^hnk_[A-Za-z0-9_-]{16,8188}$/.test(apiKey.trim());
  const keyReady=keyValid||(!!account&&!apiKey.trim());
  const pageValid=!existingSiteUrl.trim()||/^https:\/\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\.here\.now\/$/.test(existingSiteUrl.trim());
  async function connect(){
    if(running.current||!keyReady||!pageValid)return;
    running.current=true;setBusy(true);setError('');
    try{
      const payload={...(apiKey.trim()?{apiKey:apiKey.trim()}:{}),existingSiteUrl:existingSiteUrl.trim()||undefined,siteIds:[...new Set(siteIds)],accountId:account?.id};
      const saved=await onAction<Account>('account:connect-here-now',payload,account?'here.now 个人发布账号已重新验证。':'here.now 个人发布账号已连接。');
      if(saved&&alive.current){setApiKey('');onClose()}else if(alive.current)setError('未完成发布账号验证；没有创建页面或更改原连接。');
    }catch{if(alive.current)setError(account?'原连接验证未完成；已保留原 key 、页面和网站关联。':'请核对命名 密钥 与已有页面归属；未发送发布请求。')}
    finally{running.current=false;if(alive.current)setBusy(false)}
  }
  async function cancel(){setApiKey('');if(running.current)await onAction('account:cancel-here-now',{}).catch(()=>undefined);if(alive.current)onClose()}
  const toggle=(id:string,checked:boolean)=>setSiteIds(current=>checked?[...current.filter(value=>value!==id),id]:current.filter(value=>value!==id));
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancel()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={account?'重新验证 here.now 连接':'连接 here.now 个人账户'}><header><div><h2>{account?'重新验证现有连接':'一次连接个人账户'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={()=>void cancel()}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">粘贴已验证邮箱的个人账户里创建的命名密钥。外链助手会先检查邮箱、个人账户和可选的已有页面，然后把密钥加密保存在电脑密钥库。</p>
    <p className="cell-note">连接不会创建、更新或认领页面。匿名页仅保留 24 小时，不作为永久页面或所有权证明。</p>
    {account&&<p className="account-diagnostic" role="status">已连接发布账号：{account.email}。如原发布仍待对账，软件会拒绝切换到另一把 key 或另一发布账号。</p>}
    <Field label="命名 密钥" hint={account?'留空则使用电脑密钥库中已保存的 key；粘贴新 key 仅用于更换同一个人账号的密钥。':'格式 hnk_…；只在本机加密保存，列表不会回显。'}><input aria-label="here.now 命名 密钥" type="password" autoComplete="new-password" value={apiKey} disabled={disabled||busy} onChange={event=>setApiKey(event.target.value)} placeholder={account?'留空使用已保存 key':'hnk_…'}/></Field>
    <Field label="已有页面（可选）" hint="检查该页面是否属于当前个人账户。需要完整 https://slug.here.now/ 地址。"><input aria-label="here.now 已有页面" type="url" value={existingSiteUrl} disabled={disabled||busy} onChange={event=>setExistingSiteUrl(event.target.value)} placeholder="https://your-page.here.now/"/></Field>
    {!pageValid&&<p role="alert" className="account-diagnostic">页面地址必须是不带路径、查询或锚点的 here.now HTTPS 根地址。</p>}
    <fieldset className="checkbox-grid" disabled={disabled||busy}><legend>允许哪些网站使用该个人发布账号</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={event=>toggle(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
    {busy&&<p className="drawer-intro" role="status">正在检查个人账户；不会发送发布请求…</p>}{error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={disabled&&!busy} onClick={()=>void cancel()}>{busy?'取消验证':'取消'}</Button><Button variant="primary" disabled={disabled||busy||!keyReady||!pageValid} onClick={()=>void connect()}>{busy?'正在验证…':account?(apiKey.trim()?'验证原发布账号并更新':'用已保存 key 验证并更新'):'只读验证并连接'}</Button></div>
  </div></aside></div>;
}
