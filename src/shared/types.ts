export type SiteStatus = 'analyzing'|'ready'|'paused'|'attention';
export type TaskStatus = 'queued'|'running'|'needs_input'|'review'|'live'|'failed'|'skipped'|'expired';
export type Category = 'software'|'ai'|'developer'|'design'|'business'|'content'|'education'|'finance'|'general';
export interface Site {id:string;domain:string;url:string;email:string;name:string;description:string;category:Category;language:string;monthlyTarget:number;status:SiteStatus;createdAt:string;analyzedAt?:string;error?:string}
export interface Channel {id:string;name:string;domain:string;url:string;submitUrl:string;categories:Category[];languages:string[];kind:'directory'|'profile'|'article'|'community';emailRequired:boolean;accountRequired:boolean;articleRequired:boolean;free:'yes'|'conditional'|'unknown';freeNote:string;automation:'browser'|'manual';quality:'A'|'B'|'C';qualityReason:string;authority?:{name:string;value:number;source:string;asOf:string};traffic?:{monthly:number;source:string;asOf:string};rulesUrl:string;checkedAt:string;notes:string;allowedHosts:string[];enabled:boolean}
export interface Task {id:string;siteId:string;channelId:string;sourceDomain:string;status:TaskStatus;createdAt:string;scheduledAt:string;updatedAt:string;attempts:number;message:string;draft?:{title:string;description:string;body:string};publicUrl?:string;verifiedAt?:string;firstLiveAt?:string;linkRel?:string;reviewUntil?:string;submittedAt?:string;lastCheckedAt?:string;checkpoint?:string;reason?:string}
export interface Account {id:string;channelId:string;email:string;username:string;createdAt:string;status:'saved'|'registered'|'needs_verification';hasPassword:boolean}
export interface Settings {provider:'codex'|'api';codexPath:string;model:string;apiBase:string;hasApiKey:boolean;autoRun:boolean;launchAtLogin:boolean;notify:boolean;timezone:string;maxAttempts:number;maxSteps:number;dailyAiLimit:number;channelOverrides:Record<string,boolean>;mail:{host:string;port:number;user:string;secure:boolean;hasPassword:boolean};}
export interface Event {id:string;at:string;siteId?:string;taskId?:string;level:'info'|'warning'|'error';message:string}
export interface Runtime {busy:boolean;activeTaskId?:string;aiReady:boolean;vaultReady:boolean;mailReady:boolean;version:string;platform:string;dataPath:string;error?:string;aiCallsToday:number}
export interface Snapshot {sites:Site[];tasks:Task[];channels:Channel[];accounts:Account[];settings:Settings;events:Event[];runtime:Runtime;demo?:boolean}
export interface AddSiteInput {domain:string;email:string;monthlyTarget:number}
export interface AppApi {invoke<T=unknown>(command:string,payload?:unknown):Promise<T>;onChange(callback:()=>void):()=>void}
declare global {interface Window {linkflow?:AppApi}}
export interface SecretStore {get(key:string):Promise<string|undefined>;set(key:string,value:string):Promise<void>;delete(key:string):Promise<void>}
export interface AiPort {json<T>(instruction:string,data:unknown,schema?:Record<string,unknown>,signal?:AbortSignal):Promise<T>}
export interface ExecutionContext {site:Site;channel:Channel;task:Task;settings:Settings;secrets:SecretStore;ai:AiPort;signal:AbortSignal;getAccount:()=>Account|undefined;saveAccount:(account:Account,password?:string)=>Promise<void>;checkpoint:(partial:Partial<Task>)=>void;log:(message:string)=>void}
export interface ExecutionResult {status:TaskStatus;message:string;publicUrl?:string;checkpoint?:string;submittedAt?:string}
export interface LinkResult {found:boolean;url:string;rel:string;reason:string}
export const IPC_COMMANDS=['snapshot','site:add','site:update','site:delete','site:analyze','site:pause','task:retry','task:skip','task:verify','task:set-url','task:open','task:generate','task:update-draft','plan:run','plan:pause','settings:save','settings:test-ai','settings:test-mail','account:save','account:reveal','account:delete','backup:export','backup:import','data:export','external:open','app:quit'] as const;

