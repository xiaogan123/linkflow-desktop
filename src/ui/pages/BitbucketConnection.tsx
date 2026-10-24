import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
type FreeEvidence={version:1;workspaceId:string;plan:'Free';users:number;paymentAdded:false;paidTrialSelected:false;checkedAt:string;stateSha256:string;screenshotSha256:string};
const slug=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,uuid=/^\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}$/i,hash=/^[a-f0-9]{64}$/;
function evidence(value:unknown):FreeEvidence|undefined{
  const root=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined,candidate=root?.freePlanEvidence??root;
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return;
  const v=candidate as Record<string,unknown>,keys=['checkedAt','paidTrialSelected','paymentAdded','plan','screenshotSha256','stateSha256','users','version','workspaceId'];
  if(Object.keys(v).sort().join('|')!==keys.sort().join('|')||v.version!==1||v.plan!=='Free'||!slug.test(String(v.workspaceId??''))||!Number.isSafeInteger(v.users)||Number(v.users)<1||Number(v.users)>5||v.paymentAdded!==false||v.paidTrialSelected!==false||!Number.isFinite(Date.parse(String(v.checkedAt??'')))||!hash.test(String(v.stateSha256??''))||!hash.test(String(v.screenshotSha256??'')))return;
  return v as unknown as FreeEvidence;
}
export function bitbucketConnectionPayload(input:{token:string;workspaceSlug:string;projectUuid:string;siteId:string;evidenceText:string;accountId?:string}){
  const token=input.token.trim(),workspaceSlug=input.workspaceSlug.trim(),projectUuid=input.projectUuid.trim(),siteId=input.siteId.trim();let parsed:unknown;
  try{parsed=JSON.parse(input.evidenceText)}catch{throw Error('Free 计划证据 JSON 无法读取')}
  const freePlanEvidence=evidence(parsed);
  if(token.length<16||!slug.test(workspaceSlug)||!uuid.test(projectUuid)||!siteId||!freePlanEvidence||freePlanEvidence.workspaceId!==workspaceSlug)throw Error('Bitbucket 连接资料不完整或不一致');
  return {token,workspaceSlug,projectUuid,freePlanEvidence,siteIds:[siteId],...(input.accountId?{accountId:input.accountId}:{})};
}
export function BitbucketConnection({data,disabled,account,onClose,onAction}:Props){
  const existing=data?.accountBindings.find(binding=>binding.accountId===account?.id)?.siteId??'';
  const [token,setToken]=useState(''),[workspaceSlug,setWorkspaceSlug]=useState(account?.bitbucket?.workspaceSlug??''),[projectUuid,setProjectUuid]=useState(account?.bitbucket?.projectUuid??''),[siteId,setSiteId]=useState(existing),[evidenceText,setEvidenceText]=useState(''),[parsedEvidence,setParsedEvidence]=useState<FreeEvidence>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const inFlight=useRef(false),enabled=data?.channels.some(channel=>channel.id==='bitbucket'&&channel.enabled)===true;
  function acceptEvidence(raw:string){setEvidenceText(raw);try{const value=evidence(JSON.parse(raw));setParsedEvidence(value);setError(value?'':'Free 计划证据 JSON 的字段或取证状态不符合要求。')}catch{setParsedEvidence(undefined);setError('Free 计划证据 JSON 无法读取。')}}
  async function connect(){if(inFlight.current||disabled)return;let payload;try{payload=bitbucketConnectionPayload({token,workspaceSlug,projectUuid,siteId,evidenceText,accountId:account?.id})}catch(e){setError(e instanceof Error?e.message:'连接资料不完整');return}inFlight.current=true;setBusy(true);setError('');try{const result=await onAction<Account>('account:connect-bitbucket',payload,enabled?'Bitbucket 已连接，审核任务可按计划继续':'Bitbucket 账号已保存');if(result)onClose();else setError('连接未完成，请核对 token、工作区、项目和 Free 证据。')}catch{setError('连接未完成，现有账号和发布记录保持不变。')}finally{setToken('');setBusy(false);inFlight.current=false}}
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label="连接 Bitbucket"><header><h2>{account?'关联 Bitbucket 网站':'连接 Bitbucket'}</h2><button className="icon-button" aria-label="关闭 Bitbucket 连接" disabled={busy} onClick={onClose}><X size={18}/></button></header><div className="drawer-form">
    <p className="drawer-intro">连接已核实的 Bitbucket Free 工作区与私有项目。一个工作区只用于一个网站、一个 root 静态页，不覆盖或批量发布。</p>
    {!enabled&&<p className="account-diagnostic" role="status">产品接线审核完成前保持停用，可以先保存连接。</p>}
    <Field label="Bitbucket API token" hint="仅加密保存在本机；页面不会回显。"><input aria-label="Bitbucket API token" type="password" autoComplete="new-password" value={token} disabled={disabled||busy} onChange={event=>setToken(event.target.value)}/></Field>
    <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://id.atlassian.com/manage-profile/security/api-tokens'})}>打开 Atlassian API token 设置<ArrowSquareOut size={13}/></Button>
    <Field label="工作区 slug"><input aria-label="Bitbucket 工作区 slug" autoComplete="off" value={workspaceSlug} disabled={disabled||busy||!!account} onChange={event=>setWorkspaceSlug(event.target.value)}/></Field>
    <Field label="私有项目 UUID" hint="保留大括号，例如 {00000000-0000-4000-8000-000000000000}"><input aria-label="Bitbucket 私有项目 UUID" autoComplete="off" value={projectUuid} disabled={disabled||busy||!!account} onChange={event=>setProjectUuid(event.target.value)}/></Field>
    <Field label="Free 计划证据 JSON" hint="粘贴或选择既有取证 JSON；不会让你手填内部哈希。"><textarea aria-label="Bitbucket Free 计划证据 JSON" value={evidenceText} disabled={disabled||busy} onChange={event=>acceptEvidence(event.target.value)}/><input aria-label="选择 Bitbucket Free 计划证据 JSON" type="file" accept="application/json,.json" disabled={disabled||busy} onChange={event=>{const file=event.target.files?.[0];if(file)void file.text().then(acceptEvidence).catch(()=>setError('证据文件无法读取。'))}}/></Field>
    {parsedEvidence&&<p className="account-diagnostic" role="status">已读取 {parsedEvidence.plan} 计划证据 · {parsedEvidence.users} 位用户 · {new Date(parsedEvidence.checkedAt).toLocaleString()}</p>}
    <p className="drawer-intro">私有仓库创建和首次 root 提交前，Free 证据都必须仍在 24 小时内；未知结果只做 GET 对账，不重复 POST。</p>
    <Field label="用于网站"><select aria-label="Bitbucket 用于网站" value={siteId} disabled={disabled||busy} onChange={event=>setSiteId(event.target.value)}><option value="">选择网站</option>{(data?.sites??[]).map(site=><option key={site.id} value={site.id}>{site.domain}</option>)}</select></Field>
    {error&&<p role="alert" className="account-diagnostic">{error}</p>}
    <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={disabled||busy||token.trim().length<16||!slug.test(workspaceSlug.trim())||!uuid.test(projectUuid.trim())||!siteId||!parsedEvidence||parsedEvidence.workspaceId!==workspaceSlug.trim()} onClick={()=>void connect()}>{busy?'正在只读核对…':'核对并保存'}</Button></div>
  </div></aside></div>;
}
