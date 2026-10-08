import {randomUUID} from 'node:crypto';
import type {Account,SecretStore,Task} from '../shared/types';
import type {Store} from './store';
import {readPublicGist,validateGistToken} from '../integrations/gist';
import {verifyLink} from '../integrations/web';
import {applyLinkResult} from './planner';

type StateStore=Pick<Store,'read'|'update'>;
export async function connectGist(store:StateStore,vault:SecretStore,token:string,accountIdOrValidate?:string|typeof validateGistToken,validateArg=validateGistToken){
  const accountId=typeof accountIdOrValidate==='string'?accountIdOrValidate:undefined,validate=typeof accountIdOrValidate==='function'?accountIdOrValidate:validateArg;
  const login=await validate(token);
  const state=store.read(),target=accountId?state.accounts.find(a=>a.id===accountId&&a.channelId==='github-gist'):undefined;
  if(accountId&&!target)throw Error('Gist 账号不存在');
  if(target&&target.username.toLowerCase()!==login.toLowerCase())throw Error('新令牌属于不同 GitHub 身份，不会覆盖已有账号；请新增连接。');
  const old=target??state.accounts.find(a=>a.channelId==='github-gist'&&a.username.toLowerCase()===login.toLowerCase());
  const now=new Date().toISOString();
  const account:Account={...old,id:old?.id??randomUUID(),channelId:'github-gist',credentialKind:'api_token',email:login+'@users.noreply.github.com',username:login,createdAt:old?.createdAt??now,updatedAt:now,verifiedAt:now,status:'registered',hasPassword:true,source:'imported',diagnostic:undefined};
  const key='account:'+account.id,previousSecret=await vault.get(key);
  try{
    await vault.set(key,token);
    store.update(s=>{s.accounts=s.accounts.filter(a=>a.id!==account.id);s.accounts.push(account)});
  }catch(error){
    if(previousSecret===undefined)await vault.delete(key);else await vault.set(key,previousSecret);
    throw error;
  }
  return account;
}

// Metadata alone is insufficient: a public, anonymous HTML anchor must exist.
// Adoption has no write call to GitHub and never generates an account or article.
type AdoptDeps={read?:typeof readPublicGist;verify?:typeof verifyLink;now?:()=>Date};
export async function adoptGist(store:StateStore,siteId:string,url:string,accountIdOrDeps?:string|AdoptDeps,depsArg:AdoptDeps={}){
  const accountId=typeof accountIdOrDeps==='string'?accountIdOrDeps:undefined,deps=typeof accountIdOrDeps==='object'?accountIdOrDeps:depsArg;
  const site=store.read().sites.find(s=>s.id===siteId);if(!site)throw Error('网站不存在');
  const info=await (deps.read??readPublicGist)(url);
  const now=deps.now?.()??new Date();
  if(!info.createdAt||!Number.isFinite(Date.parse(info.createdAt))||Date.parse(info.createdAt)>now.getTime())throw Error('无法确认 Gist 原始发布时间，尚未计入统计');
  const result=await (deps.verify??verifyLink)(info.url,site.url,'gist.github.com');
  if(!result.found)throw Error('尚未在公开 Gist 正文中核验到目标网站链接，请检查地址或稍后重试');
  let savedId='';
  store.update(s=>{
    const current=s.sites.find(x=>x.id===siteId);if(!current||current.url!==site.url)throw Error('网站资料已变化，请重新核验');
    const old=s.tasks.find(t=>t.siteId===siteId&&t.sourceDomain==='gist.github.com');
    if(old?.status==='running')throw Error('Gist 任务正在执行，请等待完成');
    if(old?.publicUrl&&old.publicUrl!==info.url)throw Error('该网站已有其他 Gist 来源，保留原任务以避免重复计数');
    const stamp=now.toISOString();
    const task:Task=old??{id:randomUUID(),siteId,channelId:'github-gist',sourceDomain:'gist.github.com',status:'review',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:''};
    if(accountId){const account=s.accounts.find(a=>a.id===accountId&&a.channelId==='github-gist');if(!account)throw Error('Gist 账号不存在');if(account.username.toLowerCase()!==info.login.toLowerCase())throw Error('公开 Gist 的作者与所选 GitHub 身份不一致');if(task.accountId&&task.accountId!==account.id)throw Error('已有 Gist 任务已归属其他 GitHub 身份，不会改写历史归属');task.accountId=account.id;}
    task.publicUrl=info.url;
    task.firstLiveAt??=info.createdAt;
    task.submittedAt??=info.createdAt;
    if(!old?.publicUrl){task.publicationMethod='external';task.checkpoint='gist_adopted';}
    applyLinkResult(task,result,now);
    if(task.publicationMethod==='external')task.message='已接回外部发布的 Gist；公开链接核验通过，按原发布时间统计。';
    if(!old)s.tasks.push(task);
    savedId=task.id;
  });
  return savedId;
}
