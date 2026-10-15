import {useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export function LargeLanguageConnection({data,disabled,account,onClose,onAction}:{data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>}){
  const proof=account?.largeLanguage;
  const [mode,setMode]=useState<'create'|'token'>(account?.source==='imported'?'token':'create');
  const [token,setToken]=useState(''),[displayName,setDisplayName]=useState(account?.username??'');
  const [responsibleHuman,setResponsibleHuman]=useState(proof?.responsibleHuman??''),[producerType,setProducerType]=useState<'model'|'system'>(proof?.producerType??'system'),[producerName,setProducerName]=useState(proof?.producerName??'');
  const [siteIds,setSiteIds]=useState<string[]>(()=>data?.accountBindings.filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId)??[]);
  const toggle=(id:string)=>setSiteIds(values=>values.includes(id)?values.filter(value=>value!==id):[...values,id]);
  const submit=async()=>{
    const common={siteIds,accountId:account?.id,responsibleHuman:responsibleHuman.trim(),producerType,producerName:producerName.trim()};
    const result=mode==='create'?await onAction('account:create-large-language',{...common,displayName:displayName.trim()},'LargeLanguage 身份已连接，可以复用发布。'):await onAction('account:connect-large-language',{...common,token:token.trim()},'LargeLanguage 身份已验证并连接。');
    if(result)onClose();
  };
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 LargeLanguage">
    <header><div><span className="eyebrow">LARGELANGUAGE</span><h2>{account?'验证并复用已有身份':'连接发布身份'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18}/></button></header>
    <div className="drawer-form"><p className="drawer-intro">首次填写公开署名与真实来源声明，软件即可自动建立免邮箱身份。后续发布复用同一身份，凭据在本机加密保存。</p>
      {!account&&<Field label="连接方式"><select value={mode} onChange={event=>setMode(event.target.value as 'create'|'token')}><option value="create">自动创建免邮箱身份</option><option value="token">使用已有 token</option></select></Field>}
      {mode==='create'?<Field label="公开署名" hint="填写如实代表你或发布助手的名称，创建后保持不变。"><input value={displayName} disabled={!!account} maxLength={80} onChange={event=>setDisplayName(event.target.value)} placeholder="你的发布助手名称"/></Field>:<Field label="已有 Agent token"><input type="password" autoComplete="new-password" value={token} onChange={event=>setToken(event.target.value)} placeholder="粘贴已有 token"/></Field>}
      <Field label="内容生成方类型"><select value={producerType} disabled={!!account} onChange={event=>setProducerType(event.target.value as 'model'|'system')}><option value="system">系统 / 编辑流程</option><option value="model">AI 模型</option></select></Field>
      <Field label="内容生成方名称" hint="填写实际生成或编辑稿件的模型、工具或系统。"><input value={producerName} disabled={!!account} maxLength={120} onChange={event=>setProducerName(event.target.value)} placeholder="实际使用的工具或编辑系统"/></Field>
      <Field label="负责并授权发布的人" hint="填写真实负责人的姓名或其公开使用的称谓；连接后不能替换。"><input value={responsibleHuman} disabled={!!account} maxLength={120} onChange={event=>setResponsibleHuman(event.target.value)} placeholder="真实负责人"/></Field>
      <Field label="关联网站" hint="选择允许该身份发布审核技术笔记的网站。"><div className="binding-options">{data?.sites.map(site=><label key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} onChange={()=>toggle(site.id)}/><span>{site.domain}</span></label>)}</div></Field>
      {account&&proof?.stage!=='ready'&&<p className="drawer-intro">保留上次注册的同一身份并核对结果；不会创建第二个身份。</p>}
      <div className="drawer-actions"><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||!responsibleHuman.trim()||!producerName.trim()||(mode==='create'?!displayName.trim():token.trim().length<16)} onClick={submit}>{account?'验证并连接':mode==='create'?'自动创建并连接':'验证并连接'}</Button></div>
    </div>
  </aside></div>;
}
