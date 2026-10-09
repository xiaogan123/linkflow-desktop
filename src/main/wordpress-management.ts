import {randomUUID} from 'node:crypto';
import type {Account,SecretStore} from '../shared/types';
import type {Store} from './store';
import type {Vault} from './vault';
import {CHANNELS} from '../integrations/catalog';
import {bindAccount,unbindAccount} from './account-bindings';
import {connectWordPressAccount,listWordPressSites,type WordPressDependencies} from '../integrations/wordpress';
import {authorizeWordPress,WORDPRESS_CLIENT,type WordPressGrant,type WordPressOAuthOptions} from './wordpress-oauth';

type Blog=Awaited<ReturnType<typeof listWordPressSites>>[number];
type Pending={grant:WordPressGrant;blogs:Blog[];until:number;timer:ReturnType<typeof setTimeout>};
type ConnectInput={sessionId:string;blogId:string;siteIds:string[];accountId?:string};
type AtomicVault=Pick<Vault,'get'|'encryptSecrets'>;

function memorySecrets(){const values=new Map<string,string>();const store:SecretStore={get:async key=>values.get(key),set:async(key,value)=>{values.set(key,value)},delete:async key=>{values.delete(key)}};return {store,get:(key:string)=>values.get(key)}}

/** Credentials stay in the main process until a verified blog binding is saved. */
export class WordPressConnections {
  private pending=new Map<string,Pending>();
  private abort?:AbortController;
  private connecting=false;
  private generation=0;
  private connectAbort?:AbortController;
  private clearPending(){for(const item of this.pending.values())clearTimeout(item.timer);this.pending.clear();}
  constructor(private store:Pick<Store,'read'|'updateWithCiphers'>,private vault:AtomicVault,private deps:WordPressDependencies={},private oauth:typeof authorizeWordPress=authorizeWordPress){}
  status(){return {configured:!!WORDPRESS_CLIENT.clientId,callback:WORDPRESS_CLIENT.redirectUri};}
  cancel(){this.generation++;this.abort?.abort();this.connectAbort?.abort();this.clearPending();}
  async authorize(options:Pick<WordPressOAuthOptions,'openExternal'|'client'>){
    if(this.abort||this.connecting)throw Error('WordPress.com 连接正在进行');
    this.clearPending();const abort=new AbortController();this.abort=abort;
    try{
      const grant=await this.oauth({...options,signal:abort.signal});
      if(abort.signal.aborted)throw Error('WordPress.com 授权已取消');
      const blogs=(await listWordPressSites(grant.accessToken,{...this.deps,signal:abort.signal})).filter(blog=>!grant.blogId||blog.id===grant.blogId);
      if(abort.signal.aborted)throw Error('WordPress.com 授权已取消');
      if(!blogs.length)throw Error('未找到已公开且可发布的 WordPress.com 托管博客，请先在平台创建并公开博客。');
      const sessionId=randomUUID(),until=Math.min(Date.now()+300_000,Date.parse(grant.expiresAt));
      if(!Number.isFinite(until)||until<=Date.now())throw Error('授权已过期，请重新连接');
      const timer=setTimeout(()=>this.pending.delete(sessionId),until-Date.now());timer.unref();
      this.pending.set(sessionId,{grant,blogs,until,timer});
      return {sessionId,blogs:blogs.map(({id,url,name})=>({id,url,name})),expiresAt:new Date(until).toISOString()};
    }finally{if(this.abort===abort)this.abort=undefined;}
  }
  async connect(input:ConnectInput):Promise<Account>{
    if(this.connecting||this.abort)throw Error('WordPress.com 连接正在进行');
    const pending=this.pending.get(input.sessionId);this.pending.delete(input.sessionId);if(pending)clearTimeout(pending.timer);
    if(!pending||pending.until<=Date.now())throw Error('授权连接已过期，请重新授权。');
    const blog=pending.blogs.find(item=>item.id===input.blogId);
    if(!blog)throw Error('请选择本次授权的博客');
    const before=this.store.read(),selected=new Set(input.siteIds);
    if([...selected].some(id=>!before.sites.some(site=>site.id===id)))throw Error('所选网站已不存在');
    const requested=input.accountId?before.accounts.find(account=>account.id===input.accountId&&account.channelId==='wordpress-com'):undefined;
    if(input.accountId&&!requested)throw Error('要更新的 WordPress.com 连接不存在');
    if(requested&&requested.username!==blog.id)throw Error('这是另一个博客，请新增连接；原任务身份保留。');
    const previous=requested??before.accounts.find(account=>account.channelId==='wordpress-com'&&account.username===blog.id);
    const id=previous?.id??randomUUID(),generation=this.generation,abort=new AbortController();
    this.connecting=true;this.connectAbort=abort;
    try{
      const oldSecret=await this.vault.get('account:'+id);
      if(generation!==this.generation)throw Error('WordPress.com 连接已取消');
      const authors=new Set(before.tasks.filter(task=>task.accountId===id&&task.wordpress).map(task=>task.wordpress!.authorId));
      if(oldSecret){try{const stored=JSON.parse(oldSecret);if(typeof stored.ownerId==='string')authors.add(stored.ownerId);}catch{/* Existing task receipts still pin a previous publishing identity. */}}
      if([...authors].some(author=>author!==blog.ownerId))throw Error('请使用原发布者账号重新授权，历史文章身份保留。');
      const captured=memorySecrets();
      let identity:Awaited<ReturnType<typeof connectWordPressAccount>>;
      try{identity=await connectWordPressAccount(captured.store,id,blog.id,pending.grant.accessToken,{...this.deps,signal:abort.signal,expiresAt:pending.grant.expiresAt});}
      catch(error){if(abort.signal.aborted||generation!==this.generation)throw Error('WordPress.com 连接已取消');throw error}
      if(generation!==this.generation)throw Error('WordPress.com 连接已取消');
      if(identity.username!==blog.id||identity.url!==blog.url||identity.ownerId!==blog.ownerId)throw Error('授权期间博客身份发生变化');
      const credential=captured.get('account:'+id);if(!credential)throw Error('WordPress.com 授权凭据验证未完成');
      const now=new Date().toISOString();
      const account:Account={...previous,id,channelId:'wordpress-com',username:blog.id,displayName:identity.name,publicationUrl:identity.url,credentialKind:'oauth',email:'',status:'registered',hasPassword:true,source:'imported',createdAt:previous?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined};
      const key='account:'+id,ciphers=this.vault.encryptSecrets({[key]:credential});if(typeof ciphers[key]!=='string'||!ciphers[key])throw Error('WordPress.com 凭据未能加密');
      if(generation!==this.generation)throw Error('WordPress.com 连接已取消');
      this.store.updateWithCiphers(state=>{
        if([...selected].some(siteId=>!state.sites.some(site=>site.id===siteId)))throw Error('所选网站已不存在');
        const current=state.accounts.find(item=>item.id===id);
        if(previous&&(!current||current.channelId!=='wordpress-com'||current.username!==blog.id))throw Error('连接期间博客身份发生变化');
        if(!previous&&current)throw Error('连接期间博客身份发生变化');
        state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
        for(const siteId of selected)bindAccount(state,id,siteId,CHANNELS.find(channel=>channel.id==='wordpress-com')!);
        if(requested)for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='wordpress-com'&&!selected.has(binding.siteId))unbindAccount(state,id,binding.siteId,'wordpress-com');
      },ciphers);
      return account;
    }finally{this.connecting=false;this.connectAbort=undefined;}
  }
}
