import type {PublisherTokenChannel} from '../../main/publisher-token-management';
import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';



type Props={channelId:PublisherTokenChannel;data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function PublisherTokenConnection({channelId,data,disabled,account,onClose,onAction}:Props){
  const name=channelId==='opendocs'?'OpenDocs':channelId==='render'?'Render':channelId==='mdpage'?'MD.page':channelId==='publishmarkdown'?'Publish Markdown':channelId==='dropdeploy'?'DropDeploy':channelId==='dataecho'?'DataEcho':channelId==='marked-share'?'Marked Share':channelId==='onepush'?'OnePush':channelId==='netlify'?'Netlify':channelId==='cloudflare-pages'?'Cloudflare Pages':channelId==='leafmill'?'Leafmill':channelId==='clawprint'?'Clawprint':channelId==='shipstatic'?'ShipStatic':channelId==='host0'?'host0':channelId==='agentel'?'Agentel':'Mastodon';
  const COPY={label:`连接 ${name}`,update:`更新 ${name} 连接`,close:'关闭',token:'访问令牌',tokenHint:'令牌仅加密保存在本机；不要填写账号密码。',openSettings:channelId==='clawprint'?'查看官方 API 文档':'打开令牌设置',binding:'关联一个网站',cancel:'取消',connect:'测试并连接',connecting:'正在连接…',success:'账号已连接',saved:'已保存连接，平台验收尚未完成',failure:'连接未完成，请查看具体提示',pending:'此接入正在验收，尚未开放自动任务。',intro:channelId==='opendocs'?'先在工作区允许公开文档，再连接本人 API key；自动读取账号和免费文档配额。只发布单独审核的原创软件文档，公开前核对原文、原生链接与抓取条件。':channelId==='render'?'连接原工作区 API key，只读核对账号。发布需单独核对无卡免费配额、审核稿件和冻结来源；未完成公开验收前保持关闭。':channelId==='mdpage'?'连接已有账号的 API key，只读核对远端账号和页面列表。只发布一篇单独审核的软件文档；不自动扫描或抓取，不覆盖已有页面。':channelId==='publishmarkdown'?'连接专用 API key，只读核对账号文档列表；账号仅绑定本地密钥指纹。只为一个软件网站发布一篇单独审核的原创稿，须核对无到期、无密码及公开原文。':channelId==='dropdeploy'?'连接 Free API key，只读核对站点和存储配额；账号仅绑定本地密钥指纹。只新建一篇单独审核的软件文档，不覆盖现有站点，公开页验收前保持关闭。':channelId==='dataecho'?'连接原 API key，只读核对远端用户名；邮箱仅作本地账号绑定。每个连接关联一个软件网站，独立稿审与公开验收前保持关闭。':channelId==='marked-share'?'连接原 API token 和设备密钥，并填写本地账号邮箱。只读核对令牌能访问文档列表，邮箱仅作为本地绑定，不声称已获远端核对。每个连接仅关联一个软件网站，独立稿审与公开验收前保持关闭。':channelId==='onepush'?'连接一个专用 API key 并关联一个软件网站。只读确认密钥可用；服务没有公开邮箱核对接口。认证免费账号限 10 站点、1 GB，匿名页仅保留 24 小时且不会使用；真实公开页验收前保持关闭。':channelId==='leafmill'?'使用已验证邮箱账号的 API key，自动识别邮箱并关联一个软件网站。只发布通过单独审核的原创文档；公开页无预设到期，实发验收进行中。':channelId==='netlify'?'连接一个 Free 个人账号。每篇创建独立公开页，保留已有项目；多个团队或付费账号会停止。':channelId==='cloudflare-pages'?'先由本人在 Cloudflare Pages 建一个专用空白 Direct Upload 项目，并创建具备 Pages Edit 权限的 API 令牌。填写账号 ID 与项目名后只读核对；不自动开户、建项目、启用账单或覆盖已有部署。一个项目只关联一个网站；真实发布验收尚未完成。':channelId==='clawprint'?'连接一个如实命名的 AI 代理 API key，只关联一个软件网站。发布原创软件经验前须完成独立用途审核；真实公开页验收尚未完成。':channelId==='host0'?'连接已验证的 Free API key，只关联一个原创软件网站。发布前须通过独立稿件审核；公开页验收前保持关闭。':channelId==='agentel'?'连接原 AI assistant API key，只关联一个软件网站；首次也可由外链助手单次自动注册。原创技术笔记须单独审核，公开页验收前保持关闭。':'mastodon.social 禁止账号仅发 AI 生成内容，此接入保持关闭。用户自有原创稿件的连接尚待实测；令牌需要 profile（或 read:accounts）和 write:statuses 权限。开启 bot 标记及允许搜索引擎索引。只发布审核通过的原创短帖，不发送私信或回复。'};
  const existing=account?.ownerSiteId??(data?.accountBindings??[]).find(binding=>binding.accountId===account?.id)?.siteId??'';
  const [token,setToken]=useState(''),[siteId,setSiteId]=useState(existing);
  const [renderGithubToken,setRenderGithubToken]=useState(''),[renderRepository,setRenderRepository]=useState(account?.renderSource?.repository??'');
  const [renderOwnerId,setRenderOwnerId]=useState(channelId==='render'?account?.username??'':'');
  const [providerAccountId,setProviderAccountId]=useState(account?.cloudflarePages?.accountId??'');
  const [projectName,setProjectName]=useState(account?.cloudflarePages?.projectName??'');
  const [shipStaticDomain,setShipStaticDomain]=useState(account?.publicationUrl&&channelId==='shipstatic'?new URL(account.publicationUrl).hostname:'');
  const [markedShareDeviceKey,setMarkedShareDeviceKey]=useState(''),[markedShareEmail,setMarkedShareEmail]=useState(account?.email??'');
  const [dataEchoEmail,setDataEchoEmail]=useState(account?.email??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),inFlight=useRef(false);
  const enabled=!!data?.channels.find(channel=>channel.id===channelId&&channel.enabled);
  async function connect(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    try{const result=await onAction<Account>('account:connect-publisher-token',{channelId,token,siteIds:[siteId],accountId:account?.id,
      ...(channelId==='render'?{renderOwnerId,renderGithubToken,renderRepository}:{}),...(channelId==='dataecho'?{dataEchoEmail}:{}),...(channelId==='marked-share'?{markedShareDeviceKey,markedShareEmail}:{}),...(channelId==='cloudflare-pages'?{providerAccountId,projectName}:{}),...(channelId==='shipstatic'?{shipStaticDomain}:{})},enabled?COPY.success:COPY.saved);
      if(result)onClose();else setError(COPY.failure);
    }finally{setToken('');setRenderGithubToken('');setMarkedShareDeviceKey('');setBusy(false);inFlight.current=false}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={COPY.label}>
    <header><div><h2>{account?COPY.update:COPY.label}</h2></div>
      <button className="icon-button" aria-label={COPY.close} disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className="drawer-form"><p className="drawer-intro">{COPY.intro}</p>
      {!enabled&&<p className="account-diagnostic" role="status">{COPY.pending}</p>}
      <Field label={COPY.token} hint={COPY.tokenHint}><input aria-label={COPY.token} type="password" autoComplete="new-password" value={token}
        disabled={disabled||busy} onChange={event=>setToken(event.target.value)}/></Field>
      <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:channelId==='opendocs'?'https://opendocs.cc/dashboard':channelId==='render'?'https://dashboard.render.com/u/settings':channelId==='mdpage'?'https://md.page/settings':channelId==='publishmarkdown'?'https://publishmarkdown.com/docs':channelId==='dropdeploy'?'https://app.ddploy.com/':channelId==='dataecho'?'https://dataecho.ai/docs':channelId==='marked-share'?'https://share.markedapp.com/docs/api':channelId==='onepush'?'https://www.onepu.sh/dashboard/settings':channelId==='netlify'?'https://app.netlify.com/user/applications#personal-access-tokens':channelId==='cloudflare-pages'?'https://dash.cloudflare.com/profile/api-tokens':channelId==='leafmill'?'https://leafmill.net/':channelId==='clawprint'?'https://clawprint.org/SKILL.md':channelId==='shipstatic'?'https://docs.shipstatic.com/api':channelId==='host0'?'https://host0.ai/agents':channelId==='agentel'?'https://agentel.tech/docs':'https://mastodon.social/settings/applications'})}>{COPY.openSettings}<ArrowSquareOut size={13}/></Button>
      {channelId==='render'&&<><Field label="GitHub 来源令牌" hint="仅用于本人专用公开仓库；仓库须关闭 Actions。"><input type="password" value={renderGithubToken} disabled={disabled||busy} onChange={e=>setRenderGithubToken(e.target.value)}/></Field><Field label="专用 GitHub 仓库 URL"><input value={renderRepository} disabled={disabled||busy} onChange={e=>setRenderRepository(e.target.value.trim())}/></Field></>}
      {channelId==='render'&&<Field label="Render 工作区 ID" hint="从原工作区设置页复制。"><input value={renderOwnerId} disabled={disabled||busy} onChange={event=>setRenderOwnerId(event.target.value.trim())}/></Field>}
      {channelId==='dataecho'&&<Field label="本地账号邮箱" hint="用于原账号本地绑定，远端 API 仅验证用户名。"><input aria-label="本地账号邮箱" type="email" value={dataEchoEmail} disabled={disabled||busy} onChange={event=>setDataEchoEmail(event.target.value.trim())}/></Field>}
      {channelId==='marked-share'&&<><Field label="设备密钥" hint="填写与原账号会话对应的设备密钥；仅加密保存在本机。"><input aria-label="设备密钥" type="password" autoComplete="new-password" value={markedShareDeviceKey} disabled={disabled||busy} onChange={event=>setMarkedShareDeviceKey(event.target.value)}/></Field>
        <Field label="本地账号邮箱" hint="用于本地登录信息绑定，不表示平台已核对此邮箱。"><input aria-label="本地账号邮箱" type="email" value={markedShareEmail} disabled={disabled||busy} onChange={event=>setMarkedShareEmail(event.target.value.trim())}/></Field></>}
      {channelId==='cloudflare-pages'&&<><Field label="Cloudflare 账号 ID" hint="在 Cloudflare 控制台复制 32 位账号 ID。"><input aria-label="Cloudflare 账号 ID" value={providerAccountId} disabled={disabled||busy}
        onChange={event=>setProviderAccountId(event.target.value.trim())}/></Field>
        <Field label="专用空白项目名" hint="使用已建好的 Direct Upload 项目名；不能选择已有部署的项目。"><input aria-label="专用空白项目名" value={projectName} disabled={disabled||busy}
          onChange={event=>setProjectName(event.target.value.trim())}/></Field></>}
      {channelId==='shipstatic'&&<Field label="专用 ShipStatic 域名" hint="填写一个尚未使用的完整 *.shipstatic.com 域名；一个 Free 账号仅有一个域名配额。"><input aria-label="专用 ShipStatic 域名"
        value={shipStaticDomain} disabled={disabled||busy} onChange={event=>setShipStaticDomain(event.target.value.trim().toLowerCase())}/></Field>}
      <fieldset className="checkbox-grid"><legend>{COPY.binding}</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}>
        <input type="radio" name="publisher-token-site" checked={siteId===site.id} disabled={disabled||busy} onChange={()=>setSiteId(site.id)}/><span>{site.domain}</span>
      </label>)}</fieldset>
      {error&&<p role="alert" className="account-diagnostic">{error}</p>}
      <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>{COPY.cancel}</Button><Button variant="primary"
        disabled={disabled||busy||!token||!siteId||(channelId==='render'&&(!renderOwnerId||!renderGithubToken||!renderRepository))||(channelId==='dataecho'&&!dataEchoEmail)||(channelId==='marked-share'&&(!markedShareDeviceKey||!markedShareEmail))||(channelId==='cloudflare-pages'&&(!providerAccountId||!projectName))||(channelId==='shipstatic'&&!shipStaticDomain)} onClick={()=>void connect()}>{busy?COPY.connecting:COPY.connect}</Button></div>
    </div>
  </aside></div>;
}
