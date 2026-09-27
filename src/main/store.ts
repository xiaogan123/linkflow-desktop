import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Account, Event, Settings, Site, Task } from '../shared/types';

export interface State {sites:Site[];tasks:Task[];accounts:Account[];settings:Settings;events:Event[];usage:Record<string,number>}
export function defaultSettings():Settings{return {provider:'codex',codexPath:'codex',model:'',apiBase:'https://api.openai.com/v1',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,maxAttempts:3,maxSteps:18,dailyAiLimit:40,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}}}
export function emptyState():State{return {sites:[],tasks:[],accounts:[],settings:defaultSettings(),events:[],usage:{}}}

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
    this.state=row?JSON.parse(row.body):emptyState();
    this.state.settings={...defaultSettings(),...this.state.settings,mail:{...defaultSettings().mail,...this.state.settings.mail}};
    this.persist(this.state);
  }
  read():State{return structuredClone(this.state)}
  update(fn:(draft:State)=>void):void{
    const draft=this.read();fn(draft);draft.events=draft.events.slice(-500);this.persist(draft);this.state=draft;this.onChange?.();
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
    this.db.exec('BEGIN IMMEDIATE');
    try{this.persist(state);this.db.exec('DELETE FROM secrets');for(const [k,v]of Object.entries(ciphers))this.setCipher(k,v);this.db.exec('COMMIT');this.state=structuredClone(state);this.onChange?.();}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  close(){this.db.close()}
}
