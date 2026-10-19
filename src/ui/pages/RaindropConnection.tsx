import {useEffect,useMemo,useRef,useState} from 'react';
import {ArrowSquareOut,CheckCircle,WarningCircle,X} from '@phosphor-icons/react';
import type {Account,RaindropCollectionOption,RaindropCollectionResult,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';

export type RaindropCollectionsResult=RaindropCollectionResult;

export interface RaindropConnectionPayload {
  token:string;
  collectionId:string;
  publicUrl:string;
  siteIds:string[];
  accountId?:string;
}

type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
type Phase='prepare'|'token'|'save';

const positiveId=/^[1-9][0-9]*$/;

export function eligibleRaindropCollections(result:RaindropCollectionsResult):RaindropCollectionOption[]{
  return result.collections.filter(collection=>positiveId.test(collection.id)&&!collection.parentId&&collection.public&&collection.accessLevel===4&&collection.ownerId===result.ownerId);
}

export function raindropPublicUrlError(value:string):string{
  try{
    const url=new URL(value.trim());
    if(url.protocol!=='https:')return '公开地址必须使用 HTTPS。';
    if(url.username||url.password)return '公开地址不能包含用户名或密码。';
    if(url.port||url.search||url.hash)return '公开地址不能包含端口、查询参数或片段。';
    if(url.pathname==='/'||!/^[\x21-\x7e]+$/.test(url.pathname))return '请粘贴包含合集路径的实际 Public Page 地址。';
    if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.raindrop\.page$/.test(url.hostname.toLowerCase()))return '请粘贴 Raindrop 公开合集的实际 Public Page 地址。';
    return '';
  }catch{return '公开地址格式不正确。'}
}

export function raindropConnectionPayload(token:string,collectionId:string,publicUrl:string,siteIds:string[],accountId?:string):RaindropConnectionPayload{
  const payload:RaindropConnectionPayload={token:token.trim(),collectionId,publicUrl:publicUrl.trim(),siteIds:[...new Set(siteIds)]};
  if(accountId)payload.accountId=accountId;
  return payload;
}

export function RaindropConnection({data,disabled,account,onClose,onAction}:Props){
  const saved=account?.raindrop;
  const initialSiteIds=(data?.accountBindings??[]).filter(binding=>binding.channelId==='raindrop'&&binding.accountId===account?.id).map(binding=>binding.siteId);
  const [phase,setPhase]=useState<Phase>(account?'token':'prepare');
  const [token,setToken]=useState('');
  const [result,setResult]=useState<RaindropCollectionsResult|null>(null);
  const [collectionId,setCollectionId]=useState(saved?.collectionId??'');
  const [publicUrl,setPublicUrl]=useState(saved?.publicUrl??account?.publicationUrl??'');
  const [siteIds,setSiteIds]=useState<string[]>(initialSiteIds);
  const [busy,setBusy]=useState<'list'|'connect'|null>(null);
  const [error,setError]=useState('');
  const alive=useRef(true),closing=useRef(false),inFlight=useRef(false);
  const eligible=useMemo(()=>result?eligibleRaindropCollections(result):[],[result]);
  const selected=eligible.find(collection=>collection.id===collectionId);
  const urlError=publicUrl?raindropPublicUrlError(publicUrl):'';

  useEffect(()=>{
    alive.current=true;
    return ()=>{
      alive.current=false;
      void onAction('account:cancel-raindrop-connect',{});
    };
  },[]);

  async function cancel(){
    if(closing.current)return;
    closing.current=true;
    alive.current=false;
    setToken('');
    void onAction('account:cancel-raindrop-connect',{});
    onClose();
  }

  async function listCollections(){
    if(inFlight.current||!token.trim())return;
    inFlight.current=true;setBusy('list');setError('');setResult(null);setCollectionId('');
    try{
      const listed=await onAction<RaindropCollectionsResult>('account:raindrop-collections',{token:token.trim()});
      if(!alive.current)return;
      if(!listed){setError('未能读取合集。请检查 Test token 是否仍有效，然后重试。');return}
      const allowed=eligibleRaindropCollections(listed);
      setResult(listed);
      if(!allowed.length){setError('没有找到本人拥有且可写的公开合集。请先在 Raindrop 建立专用公开合集，再重新读取。');return}
      const current=allowed.find(collection=>collection.id===saved?.collectionId);
      setCollectionId((current??allowed[0]).id);
      setPhase('save');
    }finally{inFlight.current=false;if(alive.current)setBusy(null)}
  }

  async function connect(){
    if(inFlight.current||!selected||!token.trim()||siteIds.length===0)return;
    const currentUrlError=raindropPublicUrlError(publicUrl);
    if(currentUrlError){setError(currentUrlError);return}
    const validSites=new Set((data?.sites??[]).map(site=>site.id));
    const selectedSites=siteIds.filter(id=>validSites.has(id));
    if(!selectedSites.length){setError('请至少关联一个仍然存在的网站。');return}
    inFlight.current=true;setBusy('connect');setError('');
    try{
      const payload=raindropConnectionPayload(token,selected.id,publicUrl,selectedSites,account?.id);
      const connected=await onAction<Account>('account:connect-raindrop',payload,account?'Raindrop 连接已安全更新。':'Raindrop 公开合集已连接。');
      if(!alive.current)return;
      if(!connected){setError('连接未保存。当前连接发布账号、所选合集或公开分享地址未通过核对；已有任务和发布记录没有改变。');return}
      setToken('');
      alive.current=false;
      onClose();
    }finally{inFlight.current=false;if(alive.current)setBusy(null)}
  }

  function toggleSite(siteId:string,checked:boolean){
    setSiteIds(current=>checked?[...current.filter(id=>id!==siteId),siteId]:current.filter(id=>id!==siteId));
  }

  const operationDisabled=disabled||busy!==null;
  return <div className="side-drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)void cancel()}}><aside className="side-drawer" role="dialog" aria-modal="true" aria-label={account?'更新 Raindrop 连接':'连接 Raindrop 公开合集'}><header><div><h2>{account?'更新 Raindrop 连接':'三步连接 Raindrop'}</h2></div><button className="icon-button" aria-label="关闭" onClick={()=>void cancel()}><X size={18}/></button></header><div className="drawer-form">
    <div className="connection-guide" aria-label="连接进度"><CheckCircle size={17}/><p><strong>{phase==='prepare'?'当前 · ':phase==='token'||phase==='save'?'完成 · ':''}1. 准备本人账号与公开合集</strong><br/><strong>{phase==='token'?'当前 · ':phase==='save'?'完成 · ':''}2. 粘贴个人 Test token 并读取合集</strong><br/><strong>{phase==='save'?'当前 · ':''}3. 选择网站、核对实际公开地址并加密保存</strong></p></div>
    {phase==='prepare'&&<>
      <p className="drawer-intro"><strong>先由本人完成一次准备</strong><br/>注册 Raindrop、确认邮箱，再在最外层新建一个只用于相关资源整理的公开合集。在该合集的显示选项中开启描述/摘要；否则即使收藏里填写了摘要，访客也可能看不到。软件不会替你注册账号，也不会改变合集公开性或全局显示设置。</p>
      <div className="drawer-actions"><Button disabled={operationDisabled} onClick={()=>void onAction('external:open',{url:'https://app.raindrop.io/'})}>打开 Raindrop<ArrowSquareOut size={13}/></Button><Button disabled={operationDisabled} onClick={()=>void onAction('external:open',{url:'https://help.raindrop.io/public-page'})}>查看公开合集说明<ArrowSquareOut size={13}/></Button></div>
      <p className="cell-note">在 Raindrop 的 Integrations 页面创建个人 Test token。不要把登录密码、token 或浏览器会话发到聊天中。</p>
      <Button variant="primary" disabled={operationDisabled} onClick={()=>setPhase('token')}>我已准备好账号、公开合集和 Test token</Button>
    </>}
    {phase==='token'&&<>
      {saved&&<p className="drawer-intro">当前已连接合集 #{saved.collectionId}。更新时会再次核对当前账户并保留这个合集；存在历史发布记录时也不会更换公开页。</p>}
      {saved&&<p className="cell-note">账号页“移除本地记录”只会清除本机连接与加密 token，不会删除远端合集或条目。已有任务时会保留连接，用于继续检查原来的外链。</p>}
      <Field label="个人 Test token" hint="只用于本次验证；成功后加密保存，本页、账号列表和日志都不会回显。"><input aria-label="Raindrop 个人 Test token" type="password" autoComplete="new-password" value={token} disabled={operationDisabled} onChange={event=>setToken(event.target.value)}/></Field>
      <Button variant="text" disabled={operationDisabled} onClick={()=>void onAction('external:open',{url:'https://app.raindrop.io/settings/integrations'})}>打开 Test token 设置<ArrowSquareOut size={13}/></Button>
      <p className="cell-note">读取仅用于列出这个 token 所属、本人可写且已经公开的合集；此步不会保存 token，也不会创建收藏。</p>
    </>}
    {phase==='save'&&result&&<>
      <p className="drawer-intro"><strong>已验证 token，可选择 {eligible.length} 个本人公开合集。</strong><br/>请选择专用合集，再从浏览器复制它的实际公开分享地址。软件不会根据合集名称自行填写网址。</p>
      <Field label="本人可写的公开合集"><select aria-label="Raindrop 公开合集" value={collectionId} disabled={operationDisabled} onChange={event=>setCollectionId(event.target.value)}>{eligible.map(collection=><option key={collection.id} value={collection.id}>{collection.title||'未命名合集'} · #{collection.id}</option>)}</select></Field>
      <Field label="实际公开分享地址" hint="请从公开合集页面直接复制；保存前会匿名核对所选合集，不要填写服务地址或根据合集名称自行输入。"><input aria-label="Raindrop 实际公开分享地址" inputMode="url" autoComplete="off" placeholder="https://…raindrop.page/…" value={publicUrl} disabled={operationDisabled} onChange={event=>setPublicUrl(event.target.value)}/></Field>
      {urlError&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{urlError}</p>}
      <fieldset className="checkbox-grid" disabled={operationDisabled}><legend>关联哪些网站</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}><input type="checkbox" aria-label={`关联网站 ${site.domain}`} checked={siteIds.includes(site.id)} onChange={event=>toggleSite(site.id,event.target.checked)}/><span>{site.domain}</span></label>)}</fieldset>
      {(data?.sites.length??0)===0&&<p className="drawer-intro">当前没有可关联的网站。先取消并添加网站，再回来完成连接。</p>}
      <p className="cell-note">连接成功表示当前发布账号和选定合集已经核对并安全保存。首次真实发布、匿名读回与长期存续仍需另行验收，暂不把“已连接”写成“已实发”。</p>
    </>}
    {error&&<p className="account-diagnostic" role="alert"><WarningCircle size={13}/>{error}</p>}
    <div className="drawer-actions"><Button disabled={false} onClick={()=>void cancel()}>{busy?'取消本次操作':'取消'}</Button>{phase==='token'&&<Button variant="primary" disabled={operationDisabled||!token.trim()} onClick={()=>void listCollections()}>{busy==='list'?'正在读取…':'读取本人公开合集'}</Button>}{phase==='save'&&<Button variant="primary" disabled={operationDisabled||!selected||!publicUrl.trim()||!!urlError||siteIds.length===0} onClick={()=>void connect()}>{busy==='connect'?'正在复核并保存…':account?'复核并更新连接':'复核并加密保存'}</Button>}</div>
  </div></aside></div>;
}
