import {useEffect,useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function ShiplyConnection({data,disabled,account,onClose,onAction}:Props){
  const [email,setEmail]=useState(account?.email??(data?.mailboxes.length===1?data.mailboxes[0].user:'')),[active,setActive]=useState<Account|undefined>(account),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[siteIds,setSiteIds]=useState((data?.accountBindings??[]).filter(value=>value.channelId==='shiply'&&value.accountId===account?.id).map(value=>value.siteId));
  const [selectionChanged,setSelectionChanged]=useState(false);
  useEffect(()=>{
    const latest=data?.accounts.find(value=>value.id===active?.id);
    if(latest)setActive(latest);
    if(latest?.shiply?.stage==='ready'&&!selectionChanged)setSiteIds((data?.accountBindings??[]).filter(value=>value.channelId==='shiply'&&value.accountId===latest.id).map(value=>value.siteId));
  },[data?.accounts,data?.accountBindings,active?.id,selectionChanged]);
  const canRequest=!active&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())&&email.length<=254;
  const codeExpired=active?.shiply?.stage==='code_sent'&&Date.now()-Date.parse(active.shiply.requestedAt)>10*60_000;
  const canResend=codeExpired;
  const stageLabel:Record<string,string>={requesting:'正在请求验证码',request_unknown:'验证码请求结果不明',code_sent:'等待邮箱验证码',verifying:'正在验证邮箱',verify_unknown:'验证结果不明',verify_opaque:'验证响应已加密保存，等待恢复',ready:'账号已连接'};
  async function request(){if(busy||!canRequest)return;setBusy(true);setError('');try{const result=await onAction<Account>('account:request-shiply-code',{email:email.trim(),...(siteIds.length===1?{siteId:siteIds[0]}:{})},'验证码请求已记录；请在本人邮箱查看。');if(result)setActive(result);else setError('验证码结果不明；原邮箱发布账号已保留，请在账号列表中检查。')}catch{setError('请求结果不明；不会自动重发验证码。')}finally{setBusy(false)}}
  async function resend(){if(busy||!active||!canResend)return;setBusy(true);setError('');setCode('');try{const result=await onAction<Account>('account:resend-shiply-code',{accountId:active.id},'已为原 Shiply 发布账号请求新验证码。');if(result)setActive(result);else setError('续码结果不明；原发布账号与当前、前次请求时间已保留，不会自动重发。')}catch{setError('续码结果不明；原发布账号与当前、前次请求时间已保留，不会自动重发。')}finally{setBusy(false)}}
  async function verify(){if(busy||!active||active.shiply?.stage!=='code_sent'||codeExpired||!/^\d{6}$/.test(code))return;setBusy(true);setError('');try{const result=await onAction<Account>('account:verify-shiply-code',{accountId:active.id,code,siteIds:[...new Set(siteIds)]},'Shiply 发布账号已连接；密钥 已加密保存。');setCode('');if(result)onClose();else setError('验证结果不明；原始响应与发布账号记录已保留，不会重发验证码。')}catch{setCode('');setError('验证结果不明；不要重新提交一次性验证码。')}finally{setBusy(false)}}
  async function saveBindings(){if(busy||!active||active.shiply?.stage!=='ready')return;setBusy(true);setError('');try{const latestIds=selectionChanged?siteIds:(data?.accountBindings??[]).filter(value=>value.channelId==='shiply'&&value.accountId===active.id).map(value=>value.siteId);const result=await onAction('account:set-bindings',{accountId:active.id,mailboxId:active.mailboxId??null,siteIds:[...new Set(latestIds)]},'Shiply 网站关联已保存。');if(result!==undefined)onClose();else setError('网站关联未保存；原账号和网站关联保持不变。')}catch{setError('网站关联未保存；原账号和网站关联保持不变。')}finally{setBusy(false)}}
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Shiply.now 邮箱发布账号"><header><div><h2>连接 Shiply.now</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form"><p className="drawer-intro">网站关联的收信邮箱通过测试后，到期任务会自动请求并读取验证码。可信邮件可自动完成验证，其他邮件会提示你确认。同一邮箱只用一个账号，密钥仅在本机加密保存；这里也可以手动完成首次连接。</p><p className="cell-note">连接后仍按稿件审核和排期发布。免费方案的限制及平台规则仍适用；未设置到期时间不代表永久保留。</p>
    <Field label="本人邮箱"><input type="email" aria-label="Shiply 收件邮箱" autoComplete="email" value={email} disabled={disabled||busy||!!active} onChange={event=>setEmail(event.target.value)}/></Field>
    {!active&&<Button variant="primary" disabled={disabled||busy||!canRequest} onClick={()=>void request()}>请求一次验证码</Button>}
    {active&&<p role="status" className="account-diagnostic">{stageLabel[active.shiply?.stage??'']??'原账号状态需检查'}。{active.shiply?.stage==='request_unknown'||active.shiply?.stage==='verify_unknown'?'结果不明；本入口不会重发。':codeExpired?'当前验证码已明确过期；可为同一发布账号手动请求新验证码。':''}</p>}
    {active?.shiply?.stage==='code_sent'&&<Field label="邮箱中的六位验证码" hint="有待执行任务且邮箱已接通时，软件会自动收码；无法自动读取时可在此填写。"><input type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} aria-label="Shiply 六位验证码" autoComplete="one-time-code" value={code} disabled={disabled||busy||codeExpired} onChange={event=>setCode(event.target.value.replace(/\D/g,''))}/></Field>}
    {(!active||['code_sent','verify_opaque','ready'].includes(active.shiply?.stage??''))&&<fieldset className="checkbox-grid" disabled={disabled||busy}><legend>允许此发布账号用于哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={event=>{setSelectionChanged(true);setSiteIds(current=>event.target.checked?[...current.filter(id=>id!==site.id),site.id]:current.filter(id=>id!==site.id))}}/><span>{site.domain}</span></label>)}</fieldset>}
    {active?.shiply?.stage==='code_sent'&&<Button variant="primary" disabled={disabled||busy||codeExpired||!/^\d{6}$/.test(code)} onClick={()=>void verify()}>一次验证并加密保存</Button>}
    {canResend&&<Button disabled={disabled||busy} onClick={()=>void resend()}>为原发布账号请求新验证码</Button>}
    {active?.shiply?.stage==='verify_opaque'&&<Button variant="primary" disabled={disabled||busy} onClick={async()=>{setBusy(true);const result=await onAction<Account>('account:recover-shiply-verify',{accountId:active.id,siteIds:[...new Set(siteIds)]},'已从加密原始响应恢复同一 Shiply 发布账号。');setBusy(false);if(result)onClose();else setError('加密原始响应尚未验证；不会重新请求验证码。')}}>从原响应恢复</Button>}
    {active?.shiply?.stage==='ready'&&<Button variant="primary" disabled={disabled||busy} onClick={()=>void saveBindings()}>保存网站关联</Button>}
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}<div className="drawer-actions"><Button disabled={busy} onClick={onClose}>关闭</Button></div>
  </div></aside></div>;
}
