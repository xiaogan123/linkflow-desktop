import {probeOpenDocsConnection} from '../integrations/opendocs';
import {probeRenderConnection,probeRenderGitSource} from '../integrations/render-publisher';
import {probeMdpageConnection} from '../integrations/mdpage';
import {probePublishMarkdownConnection} from '../integrations/publishmarkdown';
import {probeDropDeployFreeAccount} from '../integrations/dropdeploy';
import {probeDataEchoConnection} from '../integrations/dataecho';
import {parseMarkedShareCredential,probeMarkedShareConnection} from '../integrations/marked-share';
import {probeOnePushConnection} from '../integrations/onepush';
import {randomUUID} from 'node:crypto';
import type {Account} from '../shared/types';
import type {Batch5Dependencies} from '../integrations/batch5-contract';
import {probeLeafmillApiKey} from '../integrations/leafmill';
import {probeMastodonConnection} from '../integrations/mastodon';
import {probeNetlifyPublisherConnection} from '../integrations/netlify-publisher';
import {probeCloudflarePagesConnection} from '../integrations/cloudflare-pages';
import {probeClawprintToken} from './clawprint-publisher';
import {probeShipStaticAccount,SHIPSTATIC_API,validShipStaticDomain} from '../integrations/shipstatic';
import {probeHost0FreeAccount} from '../integrations/host0';
import {connectedRequest,parseConnectedJson} from '../integrations/batch5-connected';
import {AGENTEL_API} from '../integrations/agentel';
import {CHANNELS} from '../integrations/catalog';
import {bindAccount,unbindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

export type PublisherTokenChannel='publishmarkdown'|'mdpage'|'opendocs'|'render'|'dropdeploy'|'dataecho'|'marked-share'|'onepush'|'netlify'|'cloudflare-pages'|'mastodon'|'leafmill'|'clawprint'|'shipstatic'|'host0'|'agentel';
export interface PublisherTokenInput {channelId:PublisherTokenChannel;token:string;siteIds:string[];accountId?:string;renderOwnerId?:string;renderGithubToken?:string;renderRepository?:string;providerAccountId?:string;projectName?:string;shipStaticDomain?:string;markedShareDeviceKey?:string;markedShareEmail?:string;dataEchoEmail?:string}
const unresolvedClawprintIdentity=(state:ReturnType<Pick<Store,'read'>['read']>)=>state.accounts.some(account=>account.channelId==='clawprint'&&account.source==='generated'&&account.status==='unknown'&&account.registrationAttempts===1);

/** Only probes the supplied provider token. Registration and publication are separate operations. */
export async function connectPublisherToken(store:Pick<Store,'read'|'updateWithCiphers'>,vault:Pick<Vault,'encryptSecrets'>,
  input:PublisherTokenInput,deps:Batch5Dependencies&{signal?:AbortSignal}={}):Promise<Account>{
  if(!['publishmarkdown','mdpage','opendocs','render','dropdeploy','dataecho','marked-share','onepush','netlify','cloudflare-pages','mastodon','leafmill','clawprint','shipstatic','host0','agentel'].includes(input.channelId)||input.token.length<16||input.token.length>8192||/[\s\u0000-\u001f\u007f]/.test(input.token))throw Error('发布令牌格式无效');
  const before=store.read(),siteId=input.siteIds[0];
  if(input.siteIds.length!==1||!before.sites.some(site=>site.id===siteId))throw Error('请选择一个现有网站');
  const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId===input.channelId):undefined;
  if(input.accountId&&!requested)throw Error('原账号连接不存在');
  const signal=deps.signal??new AbortController().signal;
  if(input.channelId==='cloudflare-pages'&&(!/^[a-f0-9]{32}$/i.test(input.providerAccountId??'')
    ||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.projectName??'')
    ||!['software','developer','ai'].includes(before.sites.find(site=>site.id===siteId)!.category)))throw Error('请选择软件网站、Cloudflare 账号 ID 和专用空白项目名');
  if(input.channelId==='dataecho'&&(before.sites.find(site=>site.id===siteId)?.category!=='software'||!/^\S+@\S+\.\S+$/.test(input.dataEchoEmail??'')))throw Error('请选择软件网站并填写本地账号邮箱');
  if(['render','mdpage','opendocs','publishmarkdown','dropdeploy'].includes(input.channelId)&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('仅连接软件网站');
  if(input.channelId==='marked-share'&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('Marked Share 仅连接软件网站');
  if(input.channelId==='onepush'&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('OnePush 仅连接软件网站');
  if(input.channelId==='agentel'&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('Agentel 仅连接软件网站');
  if(input.channelId==='agentel'&&before.accounts.some(account=>account.channelId==='agentel'&&account.source==='generated'))throw Error('Agentel 自动注册的原账号需沿用，不能用令牌连接覆盖');
  if(input.channelId==='host0'&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('host0 仅连接软件网站');
  if(input.channelId==='clawprint'&&before.sites.find(site=>site.id===siteId)?.category!=='software')throw Error('Clawprint 仅连接软件网站');
  if(input.channelId==='clawprint'&&unresolvedClawprintIdentity(before))throw Error('Clawprint 原注册结果未确认，先核对同一账号；不能替换或新增账号');
  if(input.channelId==='shipstatic'&&(!validShipStaticDomain(input.shipStaticDomain)||!['software','developer','ai'].includes(before.sites.find(site=>site.id===siteId)!.category)))
    throw Error('请选择软件网站及专用 ShipStatic 域名');
  let email='';
  let username:string,displayName:string,publicationUrl:string,secret:string,cloudflarePages:Account['cloudflarePages'],renderSource:Account['renderSource'],opendocs:Account['opendocs'];
  try{
    if(input.channelId==='render'){
      const identity=await probeRenderConnection(input.token,input.renderOwnerId??'',deps,signal);email=identity.email;username=identity.ownerId;displayName=identity.name;publicationUrl='https://dashboard.render.com/';renderSource=await probeRenderGitSource(input.renderGithubToken??'',input.renderRepository??'',deps,signal);secret=JSON.stringify({version:1,apiKey:input.token,ownerId:identity.ownerId,email,githubToken:input.renderGithubToken,source:renderSource});
    }else if(input.channelId==='opendocs'){
      const identity=await probeOpenDocsConnection(input.token,deps,signal);if(identity.remaining<1)throw Error('free capacity');username=identity.userId;displayName=identity.username;publicationUrl='https://opendocs.cc/'+identity.workspaceSlug;opendocs={workspaceId:identity.workspaceId,workspaceSlug:identity.workspaceSlug,username:identity.username};secret=JSON.stringify({version:1,apiKey:input.token,userId:identity.userId,...opendocs});
    }else if(input.channelId==='mdpage'){
      const identity=await probeMdpageConnection(input.token,deps,signal);if(identity.totalPages>=10)throw Error('free capacity');username=identity.userId;displayName=identity.username;publicationUrl=`https://${identity.username}.md.page/`;secret=JSON.stringify({version:1,apiKey:input.token,userId:identity.userId,username:identity.username});
    }else if(input.channelId==='publishmarkdown'||input.channelId==='dropdeploy'){
      const credential={version:1 as const,apiKey:input.token};
      if(input.channelId==='publishmarkdown'){const identity=await probePublishMarkdownConnection(credential,deps,signal);if(identity.totalDocuments>=100)throw Error('free capacity');username=identity.username;displayName='Publish Markdown';publicationUrl='https://publishmarkdown.com/';}
      else{const identity=await probeDropDeployFreeAccount(credential,deps,signal);username=identity.username;displayName='DropDeploy';publicationUrl='https://app.ddploy.com/';}
      secret=JSON.stringify(credential);
    }else if(input.channelId==='dataecho'){
      const identity=await probeDataEchoConnection(input.token,deps,signal);email=input.dataEchoEmail!;username=identity.username;displayName='DataEcho';publicationUrl='https://dataecho.ai/';
      secret=JSON.stringify({version:1,apiKey:input.token,email,username});
    }else if(input.channelId==='marked-share'){
      const credential=parseMarkedShareCredential(JSON.stringify({version:1,apiToken:input.token,deviceKey:input.markedShareDeviceKey,email:input.markedShareEmail}));
      if(!credential)throw Error('Marked Share 本地登录信息不完整');
      const identity=await probeMarkedShareConnection(credential,deps,signal);if(identity.visibleDocuments>=25)throw Error('free capacity');
      email=credential.email;username=identity.username;displayName='Marked Share';publicationUrl='https://share.markedapp.com/';secret=JSON.stringify(credential);
    }else if(input.channelId==='onepush'){
      const identity=await probeOnePushConnection(input.token,deps,signal);
      username=identity.username;displayName='OnePush';publicationUrl='https://www.onepu.sh/';secret=JSON.stringify({version:1,apiKey:input.token});
    }else if(input.channelId==='leafmill'){
      const identity=await probeLeafmillApiKey(input.token,deps,signal);
      email=identity.email;username=email;displayName='Leafmill';publicationUrl='https://leafmill.net/';
      secret=JSON.stringify({version:1,email,apiKey:input.token});
    }else if(input.channelId==='mastodon'){
      const identity=await probeMastodonConnection(input.token,deps,signal);
      if(!identity.bot||!identity.indexable)throw Error('请在 Mastodon 开启自动账号标记及搜索引擎索引');
      username=identity.acct;displayName=identity.acct;publicationUrl=identity.url;secret=input.token;
    }else if(input.channelId==='cloudflare-pages'){
      const identity=await probeCloudflarePagesConnection(input.token,input.providerAccountId!,input.projectName!,deps,signal);
      if(!identity.empty&&!requested)throw Error('项目已有部署，不能接管或覆盖');
      username=input.providerAccountId!;displayName=`Cloudflare Pages · ${identity.projectName}`;publicationUrl=identity.publicUrl;
      cloudflarePages={version:1,accountId:username,projectId:identity.projectId,projectName:identity.projectName,
        tokenId:identity.tokenId,productionBranch:identity.productionBranch};
      secret=JSON.stringify({apiToken:input.token,...cloudflarePages});
    }else if(input.channelId==='clawprint'){
      const identity=await probeClawprintToken(input.token,deps,signal);
      username=identity.name;displayName=identity.name;publicationUrl=`https://clawprint.org/u/${identity.name}`;secret=input.token;
    }else if(input.channelId==='agentel'){
      const response=await connectedRequest(`${AGENTEL_API}/me`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${input.token}`}},{fetch:deps.fetch??fetch},signal,32_000);
      const proof=parseConnectedJson(response)?.agent as Record<string,unknown>|undefined;
      if(response.status!==200||!proof||typeof proof.id!=='string'||!/^agent_[A-Za-z0-9-]{3,100}$/.test(proof.id)||typeof proof.slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(proof.slug))throw Error('Agentel 原账号未确认');
      username=proof.slug;displayName=proof.slug;publicationUrl='https://agentel.tech/';secret=JSON.stringify({version:1,agentId:proof.id,slug:proof.slug,apiKey:input.token});
    }else if(input.channelId==='host0'){
      const identity=await probeHost0FreeAccount({apiKey:input.token,signal,fetch:deps.fetch??fetch});
      email=identity.email;username=email;displayName='host0';publicationUrl='https://host0.ai/';
      secret=JSON.stringify({version:1,apiKey:input.token,email});
    }else if(input.channelId==='shipstatic'){
      const identity=await probeShipStaticAccount(input.token,deps,signal);
      if(identity.remainingDomains<1||identity.remainingDeployments<1)throw Error('free capacity');
      const domain=input.shipStaticDomain!;
      const vacant=await connectedRequest(`${SHIPSTATIC_API}/domains/${domain}`,{method:'GET',headers:{accept:'application/json',authorization:`Bearer ${input.token}`}},deps,signal,32_000);
      if(vacant.status!==404)throw Error('domain occupied or unknown');
      email=identity.email;username=email;displayName=`ShipStatic · ${domain}`;publicationUrl=`https://${domain}/`;
      secret=JSON.stringify({version:1,apiKey:input.token,email,domain});
    }else{
      const identity=await probeNetlifyPublisherConnection(input.token,deps,signal);
      username=identity.userId;displayName=identity.displayName??identity.userId;publicationUrl='https://app.netlify.com/';
      secret=JSON.stringify({version:1,accessToken:input.token,userId:identity.userId});
    }
  }catch{throw Error('连接未通过：请检查令牌、账号权限和专用空白项目；原连接未修改');}
  if(signal.aborted)throw Error('连接已取消');
  const latest=store.read(),old=requested??latest.accounts.find(account=>account.channelId===input.channelId&&account.username===username);
  if(requested&&requested.username!==username)throw Error('令牌属于其他账号，原连接未修改');
  if(old?.retiredAt)throw Error('原账号已经退役，不能重新关联');
  if(input.channelId==='opendocs'&&old&&JSON.stringify(old.opendocs)!==JSON.stringify(opendocs))throw Error('OpenDocs 原工作区不能换绑');
  if(input.channelId==='render'&&old&&JSON.stringify(old.renderSource)!==JSON.stringify(renderSource))throw Error('Render 原来源仓库不能换绑');
  if(input.channelId==='cloudflare-pages'&&old){
    if(old.ownerSiteId!==siteId||old.publicationUrl!==publicationUrl||old.cloudflarePages?.projectId!==cloudflarePages?.projectId
      ||old.cloudflarePages?.projectName!==cloudflarePages?.projectName||old.cloudflarePages?.productionBranch!==cloudflarePages?.productionBranch)
      throw Error('原 Cloudflare 连接固定于其他网站或项目，不能切换');
  }
  if(['render','mdpage','opendocs','publishmarkdown','dropdeploy'].includes(input.channelId)&&old&&old.ownerSiteId!==siteId)throw Error('原 key 仅可关联原网站');
  if(input.channelId==='marked-share'&&old&&(old.ownerSiteId!==siteId||old.email!==email))throw Error('原 Marked Share 本地邮箱和网站绑定不能切换');
  if(input.channelId==='dataecho'&&old&&(old.ownerSiteId!==siteId||old.email!==email))throw Error('原 DataEcho 账号和本地邮箱不能换绑');
  if(input.channelId==='onepush'&&old&&old.ownerSiteId!==siteId)throw Error('原 OnePush key 仅可关联原网站');
  if(input.channelId==='clawprint'&&old&&old.ownerSiteId!==siteId)throw Error('原 Clawprint 账号仅可关联原网站');
  if(input.channelId==='agentel'&&old&&old.ownerSiteId!==siteId)throw Error('原 Agentel 账号仅可关联原网站');
  if(input.channelId==='host0'&&old&&old.ownerSiteId!==siteId)throw Error('原 host0 账号仅可关联原网站');
  if(input.channelId==='shipstatic'&&old&&(old.ownerSiteId!==siteId||old.publicationUrl!==publicationUrl))
    throw Error('原 ShipStatic 连接固定于其他网站或域名，不能切换');
  const snapshot=JSON.stringify(old??null);
  const id=old?.id??randomUUID(),at=(deps.now?.()??new Date()).toISOString();
  const account:Account={...old,id,channelId:input.channelId,username,displayName,publicationUrl,email,credentialKind:'api_token',
    ...(renderSource?{renderSource}:{}),...(opendocs?{opendocs}:{}),hasPassword:true,status:'registered',source:'imported',createdAt:old?.createdAt??at,updatedAt:at,verifiedAt:at,diagnostic:undefined,
    ...(input.channelId==='cloudflare-pages'?{ownerSiteId:siteId,cloudflarePages}:{}),
    ...(input.channelId==='clawprint'?{ownerSiteId:siteId}:{}),};
  if(input.channelId==='render'||input.channelId==='mdpage'||input.channelId==='opendocs'||input.channelId==='publishmarkdown'||input.channelId==='dropdeploy'||input.channelId==='dataecho'||input.channelId==='marked-share'||input.channelId==='onepush'||input.channelId==='shipstatic'||input.channelId==='host0'||input.channelId==='agentel')account.ownerSiteId=siteId;
  const key=`account:${id}`,ciphers=vault.encryptSecrets({[key]:secret});
  if(typeof ciphers[key]!=='string'||!ciphers[key])throw Error('发布令牌未能加密');
  store.updateWithCiphers(state=>{
    if(signal.aborted||!state.sites.some(site=>site.id===siteId))throw Error('连接期间网站或授权已变化');
    if(input.channelId==='agentel'&&state.accounts.some(item=>item.channelId==='agentel'&&item.source==='generated'))throw Error('Agentel 自动注册账号已存在，不能覆盖');
    if(input.channelId==='clawprint'&&unresolvedClawprintIdentity(state))throw Error('Clawprint 原注册结果未确认，不能替换或新增账号');
    const current=state.accounts.find(item=>item.id===id);
    if(JSON.stringify(current??null)!==snapshot||state.accounts.some(item=>item.id!==id&&item.channelId===input.channelId&&item.username===username))throw Error('账号状态已变化，请重新连接');
    if(old&&state.accountBindings.some(binding=>binding.accountId===id&&binding.siteId!==siteId))throw Error('此账号已关联其他网站，请沿用原网站');
    const channel=CHANNELS.find(item=>item.id===input.channelId);
    if(!channel)throw Error('发布平台尚未接入');
    state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
    for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.siteId!==siteId)unbindAccount(state,id,binding.siteId,input.channelId);
    bindAccount(state,id,siteId,channel);
  },ciphers);
  return account;
}
