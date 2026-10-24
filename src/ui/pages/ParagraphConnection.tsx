import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};

export function ParagraphConnection({data,disabled,account,onClose,onAction}:Props){
  const [apiKey,setApiKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [siteIds,setSiteIds]=useState<string[]>((data?.accountBindings??[]).filter(binding=>binding.accountId===account?.id).map(binding=>binding.siteId));
  const busyRef=useRef(false);
  const connect=async()=>{
    if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');
    try{
      const result=await onAction<Account>('account:connect-paragraph',{apiKey,siteIds,accountId:account?.id},'Paragraph 已连接，所选网站按计划准备原创文章。');
      if(result)onClose();else setError('未完成连接。请核对出版物 密钥 后重试；已有任务记录保留。');
    }finally{setApiKey('');setBusy(false);busyRef.current=false;}
  };
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Paragraph"><header><div><h2>{account?'更新 Paragraph 连接':'连接 Paragraph'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">连接本人运营的原创出版物，选择要引用的网站。之后由 AI 准备文章、AI 复核、发布网页并检查链接；不会发送订阅邮件。</p>
    <p className="cell-note">首次可用邮箱免密码、Google 或 GitHub 注册，不要求钱包。请先在官网创建自己的出版物，并在设置中取得 API 密钥；当前软件不会自动开户或创建出版物。</p>
    <p className="cell-note">新免费工作区的网页默认带有 noindex，不进入 Paragraph 站点地图。部分既有出版物有例外，需检查实际页面；允许索引也不代表已被搜索引擎收录。</p>
    <Field label="出版物 API 密钥" hint="在 Paragraph 出版物的 Settings → API keys 中创建；密钥仅加密保存在本机。"><input aria-label="Paragraph API key" type="password" autoComplete="new-password" value={apiKey} onChange={event=>setApiKey(event.target.value)} disabled={disabled||busy}/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://paragraph.com/'})}>打开 Paragraph<ArrowSquareOut size={13}/></Button>
    <p className="cell-note">适合有实质原创内容的出版物及相关引用。平台不接受以第三方推广、联盟佣金或销售导流为主要目的的出版物；软件会结合公开内容核对适用性。</p>
    <fieldset className="checkbox-grid"><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" checked={siteIds.includes(site.id)} disabled={disabled||busy} onChange={event=>setSiteIds(current=>event.target.checked?[...current,site.id]:current.filter(id=>id!==site.id))}/><span>{site.domain}</span></label>)}</fieldset>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||!apiKey.trim()} onClick={()=>void connect()}>{busy?'正在验证…':'验证并连接'}</Button></div>
  </div></aside></div>;
}
