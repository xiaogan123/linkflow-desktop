import {useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Action=<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:Action};

export function CarcinusConnection({data,disabled,account,onClose,onAction}:Props){
  const [siteId,setSiteId]=useState((data?.accountBindings??[]).find(binding=>binding.channelId==='carcinus'&&binding.accountId===account?.id)?.siteId??data?.sites[0]?.id??'');
  const [exportJson,setExportJson]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  const imported=account?.carcinus?.version===3,managed=account?.carcinus?.version===2,ready=!!siteId&&exportJson.trim().length>0&&new TextEncoder().encode(exportJson).byteLength<=600_000;
  const close=()=>{setExportJson('');onClose()};
  async function connect(){
    if(busy||account||!ready)return;setBusy(true);setError('');
    try{const saved=await onAction<Account>('account:connect-carcinus-existing',{siteId,exportJson},'Carcinus 既有页面已检查链接并连接。');setExportJson('');if(saved&&alive.current)onClose();else if(alive.current)setError('未完成既有页面连接；没有保存发布账号或发送发布请求。')}
    catch{setExportJson('');if(alive.current)setError('Carcinus 所填记录、目标网站或检查链接未通过；没有写入连接或发送 POST。')}
    finally{if(alive.current)setBusy(false)}
  }
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close()}}><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="Carcinus 既有页面连接"><header><div><h2>{account?'查看既有页面连接':'导入本机既有页面'}</h2></div><button className="icon-button" aria-label="关闭" disabled={busy} onClick={close}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">导入你保存的 Carcinus 页面记录。软件会比对公开全文、目标链接和所填记录；管理令牌只在本机保存，其控制权尚未经平台验证。</p>
    <p className="cell-note">该流程只发送 robots、公开页和 restore 的 GET；不注册发布账号、不建立新页、不发送 POST，且不计为新增发布。</p>
    <p className="cell-note">导出内容是你提供的来源记录，不作为平台所有权证明或新的 AI 审核；此连接只支持只读检查。</p>
    {imported&&<><p className="account-diagnostic" role="status">已连接既有页面：{account.publicationUrl}</p><p className="cell-note">你提供的记录和管理令牌已加密保存；令牌尚未经平台认证。任务页可检查公开页，不会通过此连接修改或新建页面。</p></>}
    {managed&&<><p className="account-diagnostic" role="status">当前 Carcinus 页面由原发布任务管理：{account.publicationUrl}</p><p className="cell-note">原任务已用于唯一 identity 与管理令牌，不能再导入另一对象。</p></>}
    {!account&&<><Field label="所属网站" hint="原目标链接必须属于所选网站的文章页。"><select aria-label="Carcinus 所属网站" value={siteId} disabled={disabled||busy} onChange={event=>setSiteId(event.target.value)}><option value="">选择网站</option>{(data?.sites??[]).map(site=><option value={site.id} key={site.id}>{site.domain}</option>)}</select></Field><Field label="Carcinus 既有页面导出 JSON" hint="包含原 write token；页面不会回显，成功或失败后立即清空。"><textarea aria-label="Carcinus 既有页面导出 JSON" rows={10} value={exportJson} disabled={disabled||busy} onChange={event=>setExportJson(event.target.value)} spellCheck={false}/></Field>{!data?.sites.length&&<p className="account-diagnostic">请先添加原目标网站，再导入既有页面。</p>}{exportJson&&new TextEncoder().encode(exportJson).byteLength>600_000&&<p className="account-diagnostic" role="alert">导出记录超过 600 KB 上限。</p>}</>}
    {busy&&<p className="drawer-intro" role="status">正在执行三项有界检查链接；不会发送 POST…</p>}{error&&<p className="account-diagnostic" role="alert">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={close}>关闭</Button>{!account&&<Button variant="primary" disabled={disabled||busy||!ready} onClick={()=>void connect()}>{busy?'正在检查链接…':'检查链接并连接'}</Button>}</div>
  </div></aside></div>;
}
