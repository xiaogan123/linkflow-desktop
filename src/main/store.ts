import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account, Channel, Event, Mailbox, Settings, Site, SiteAccountBinding, Task } from '../shared/types';

export interface State {schemaVersion?:number;sites:Site[];tasks:Task[];accounts:Account[];mailboxes:Mailbox[];accountBindings:SiteAccountBinding[];settings:Settings;events:Event[];usage:Record<string,number>;customChannels?:Channel[];channelMetrics?:Record<string,{authority?:Channel['authority'];traffic?:Channel['traffic']} >}
export function defaultSettings():Settings{return {provider:'codex',codexPath:'codex',model:'',reasoningEffort:undefined,articleReviewMode:'manual',preferredBrowser:'system',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'imap.gmail.com',port:993,user:'',secure:true,hasPassword:false}}}
export function emptyState():State{return {schemaVersion:2,sites:[],tasks:[],accounts:[],mailboxes:[],accountBindings:[],settings:defaultSettings(),events:[],usage:{},customChannels:[],channelMetrics:{}}}

function email(value:string|undefined){return (value??'').trim().toLowerCase()}
function sameMailboxIdentity(mailbox:Pick<Mailbox,'host'|'port'|'user'|'secure'>,legacy:Pick<Settings['mail'],'host'|'port'|'user'|'secure'>){const host=(value:string)=>value.trim().toLowerCase().replace(/\.$/,'');return host(mailbox.host)===host(legacy.host)&&mailbox.port===legacy.port&&mailbox.user.trim()===legacy.user.trim()&&mailbox.secure===legacy.secure}
/** Additive migration only: it never deletes identities, tasks, legacy fields or secret keys. */
export function migrateState(input:State):State{
  const state=input as State;
  if((state.schemaVersion??0)>2)throw Error('数据版本高于当前应用支持范围，请先更新应用');
  const legacy=(state.schemaVersion??0)<2;
  state.sites=Array.isArray(state.sites)?state.sites:[];
  state.tasks=Array.isArray(state.tasks)?state.tasks:[];
  state.accounts=Array.isArray(state.accounts)?state.accounts:[];
  state.mailboxes=Array.isArray(state.mailboxes)?state.mailboxes:[];
  state.accountBindings=Array.isArray(state.accountBindings)?state.accountBindings:[];
  state.events=Array.isArray(state.events)?state.events:[];
  state.usage=state.usage&&typeof state.usage==='object'?state.usage:{};
  state.customChannels=Array.isArray(state.customChannels)?state.customChannels:[];
  state.channelMetrics=state.channelMetrics&&typeof state.channelMetrics==='object'?state.channelMetrics:{};
  state.settings={...defaultSettings(),...(state.settings??{}),mail:{...defaultSettings().mail,...(state.settings?.mail??{})},channelOverrides:state.settings?.channelOverrides??{}};
  const now=new Date().toISOString();
  if(legacy)for(const site of state.sites)site.publicEmail=site.publicEmail||site.email;
  if(legacy&&!state.mailboxes.length&&(state.settings.mail.user||state.settings.mail.hasPassword)){
    const id=randomUUID();
    state.mailboxes.push({id,label:state.settings.mail.user||'默认收件箱',host:state.settings.mail.host,port:state.settings.mail.port,user:state.settings.mail.user,secure:state.settings.mail.secure,hasPassword:state.settings.mail.hasPassword,aliases:[...new Set([state.settings.mail.user,...state.sites.map(s=>s.publicEmail||s.email)].map(email).filter(Boolean))],createdAt:now,updatedAt:now});
    for(const site of state.sites)site.mailboxId??=id;
    for(const account of state.accounts)account.mailboxId??=id;
  }
  const mailboxIds=new Set(state.mailboxes.map(m=>m.id));
  for(const site of state.sites)if(site.mailboxId&&!mailboxIds.has(site.mailboxId))delete site.mailboxId;
  for(const account of state.accounts)if(account.mailboxId&&!mailboxIds.has(account.mailboxId))delete account.mailboxId;
  for(const mailbox of state.mailboxes){mailbox.aliases=[...new Set((mailbox.aliases??[]).map(email).filter(Boolean))];mailbox.label=mailbox.label||mailbox.user;}
  if(legacy)for(const site of state.sites){
    const publicEmail=email(site.publicEmail||site.email);
    for(const account of state.accounts.filter(a=>a.channelId&&((a.channelId==='github-gist')||email(a.email)===publicEmail))){
      if(!state.accountBindings.some(b=>b.siteId===site.id&&b.channelId===account.channelId))state.accountBindings.push({id:randomUUID(),siteId:site.id,channelId:account.channelId,accountId:account.id,createdAt:now,updatedAt:now});
    }
  }
  const accountIds=new Set(state.accounts.map(a=>a.id));
  const siteIds=new Set(state.sites.map(s=>s.id));
  state.accountBindings=state.accountBindings.filter(b=>accountIds.has(b.accountId)&&siteIds.has(b.siteId));
  for(const task of state.tasks){
    if(task.accountId&&!accountIds.has(task.accountId))delete task.accountId;
    const binding=state.accountBindings.find(b=>b.siteId===task.siteId&&b.channelId===task.channelId);
    task.accountId??=binding?.accountId;
    if(legacy){task.health??=task.linkCheck==='found'?'healthy':task.linkCheck==='absent'&&!!task.firstLiveAt?'missing':task.publicUrl?'unknown':'pending';task.history??=[];task.cost??={aiCalls:0};if(task.status==='review'&&!task.reviewUntil){const base=Date.parse(task.submittedAt??task.updatedAt??task.createdAt),started=Number.isFinite(base)?base:Date.now();task.reviewUntil=new Date(started+30*86400000).toISOString();task.reviewKind??=task.submittedAt?'publication':'manual_url';}}
  }
  state.schemaVersion=2;
  return state;
}

/** The SQLite transaction persists a complete coherent scheduler state before notifying UI. */
export class Store {
  private db:DatabaseSync;
  private state:State;
  onChange?:()=>void;
  constructor(path:string){
    if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700});}
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    if(path!==':memory:')chmodSync(path,0o600);
    const row=this.db.prepare('SELECT body FROM state WHERE id=1').get() as {body:string}|undefined;
    const loaded:State=row?JSON.parse(row.body):emptyState(),legacySchema=!!row&&(loaded.schemaVersion??0)<2,hadMailboxes=Array.isArray(loaded.mailboxes)&&loaded.mailboxes.length>0,legacyMail=legacySchema?loaded.settings?.mail:undefined;
    this.state=migrateState(loaded);
    const legacyMailbox=legacySchema&&!hadMailboxes&&legacyMail?.hasPassword&&this.state.mailboxes.length===1&&sameMailboxIdentity(this.state.mailboxes[0],legacyMail)?this.state.mailboxes[0]:undefined;
    if(legacyMailbox&&!this.getCipher('mailbox:'+legacyMailbox.id)){const cipher=this.getCipher('mailPassword');if(cipher)this.setCipher('mailbox:'+legacyMailbox.id,cipher)}
    if(!this.state.settings.mail.host&&!this.state.settings.mail.user&&!this.state.settings.mail.hasPassword)this.state.settings.mail.host='imap.gmail.com';
    this.persist(this.state);
  }
  read():State{return structuredClone(this.state)}
  private notify(){try{this.onChange?.()}catch{/* A renderer notification cannot undo a committed write. */}}
  update(fn:(draft:State)=>void):void{
    const draft=this.read();fn(draft);draft.events=draft.events.slice(-500);this.persist(draft);this.state=draft;this.notify();
  }
  updateWithCiphers(fn:(draft:State)=>void,ciphers:Record<string,string>,deleteKeys:string[]=[]):void{
    const draft=this.read();fn(draft);draft.events=draft.events.slice(-500);
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(draft);for(const key of deleteKeys)this.deleteCipher(key);for(const [key,value] of Object.entries(ciphers))this.setCipher(key,value);this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
    this.state=draft;this.notify();
  }
  private persist(state:State){this.db.prepare('INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(state))}
  log(message:string,options:Partial<Omit<Event,'message'|'id'|'at'>>={}){
    this.update(s=>s.events.push({id:randomUUID(),at:new Date().toISOString(),level:'info',...options,message:message.slice(0,1000)}));
  }
  getCipher(key:string):string|undefined{return (this.db.prepare('SELECT value FROM secrets WHERE key=?').get(key) as {value:string}|undefined)?.value}
  setCipher(key:string,value:string){this.db.prepare('INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
  deleteCipher(key:string){this.db.prepare('DELETE FROM secrets WHERE key=?').run(key)}
  allCiphers():Record<string,string>{return Object.fromEntries((this.db.prepare('SELECT key,value FROM secrets').all() as {key:string,value:string}[]).map(x=>[x.key,x.value]))}
  restore(state:State,ciphers:Record<string,string>){
    state=structuredClone(migrateState(state));
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(state);this.db.exec('DELETE FROM secrets');for(const [k,v]of Object.entries(ciphers))this.setCipher(k,v);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.state=state;this.notify();
  }
  close(){this.db.close()}
}
