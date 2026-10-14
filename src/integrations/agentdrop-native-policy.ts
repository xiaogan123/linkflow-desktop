import {AGENTDROP_API_ORIGIN,AGENTDROP_ID,AGENTDROP_ORIGIN,type AgentDropNativeRequest,type AgentDropReadOnlyQueryProof} from './agentdrop';

export const AGENTDROP_CONVEX_SYNC_URL='wss://convex.agent-drop.co/api/1.41.0/sync';
const ANALYTICS_ORIGINS=new Set(['https://us.i.posthog.com','https://us.posthog.com','https://us-assets.i.posthog.com','https://app.posthog.com']);
const OPTIONAL_PASSIVE_PATHS=new Set(['/favicon.ico','/favicon.svg','/favicon-32.png','/favicon-32-dark.png','/apple-touch-icon.png','/og.png']);
export const AGENTDROP_STATIC_RESOURCES=[
  ['/assets/index-BiurTAnF.css',['stylesheet','other']],
  ['/assets/_slug-DkK0ymA2.css',['stylesheet','other']],
  ['/assets/index-mFknSd3I.js',['script','other']],
  ['/assets/bundle-mjs-C-vKSBOs.js',['script','other']],
  ['/assets/redirect-B_ZVDw9s.js',['script','other']],
  ['/assets/wordmark-DG49VAPj.js',['script','other']],
  ['/assets/_slug-CFo5ZsOH.js',['script','other']],
  ['/assets/createLucideIcon-CXUlNh-V.js',['script','other']],
  ['/assets/_slug-CIgLCavD.js',['script','other']],
  ['/assets/input-CLC7QACD.js',['script','other']],
  ['/assets/lock-OMZ7OSv8.js',['script','other']],
  ['/assets/users-CpcP-oRj.js',['script','other']],
  ['/assets/skeleton-CzWZibtp.js',['script','other']],
  ['/assets/chunk-BO2N2NFS-DqgWQejf.js',['script','other']],
  ['/assets/_slug-CLNcnxq-.js',['script','other']],
  ['/fonts/jakarta-600.ttf',['font','other']],
  ['/fonts/jakarta-700.ttf',['font','other']],
] as const;

export interface AgentDropRendererContract {
  pageOrigin:string;
  apiOrigin:string;
  convexSyncUrl:string;
  staticResources:readonly (readonly [string,readonly string[]])[];
}
export interface AgentDropFrameState {connectFrames:number;queryFrames:number;queryId?:number;slug:string}
function exactKeys(value:Record<string,unknown>,allowed:readonly string[]):boolean{return Object.keys(value).every(key=>allowed.includes(key))}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
export function validateAgentDropClientFrame(payload:string,state:AgentDropFrameState):{frameType:string;proof?:AgentDropReadOnlyQueryProof}|undefined{
 let value:unknown;try{value=JSON.parse(payload)}catch{return}
 if(!object(value)||typeof value.type!=='string')return;
 if(value.type==='Connect'){
  if(state.connectFrames!==0||!exactKeys(value,['type','sessionId','connectionCount','lastCloseReason','clientTs','maxObservedTimestamp'])||typeof value.sessionId!=='string'||value.sessionId.length<8||value.sessionId.length>128||value.connectionCount!==0||value.lastCloseReason!=='InitialConnect'||typeof value.clientTs!=='number'||!Number.isFinite(value.clientTs)||value.maxObservedTimestamp!==undefined)return;
  state.connectFrames++;return {frameType:'Connect'};
 }
 if(value.type==='ModifyQuerySet'){
  if(state.connectFrames!==1||state.queryFrames!==0||!exactKeys(value,['type','baseVersion','newVersion','modifications'])||value.baseVersion!==0||value.newVersion!==1||!Array.isArray(value.modifications)||value.modifications.length!==1)return;
  const add=value.modifications[0];if(!object(add)||!exactKeys(add,['type','queryId','udfPath','args','journal','componentPath'])||add.type!=='Add'||!Number.isSafeInteger(add.queryId)||Number(add.queryId)<0||add.udfPath!=='sites:getBySlug'||!Array.isArray(add.args)||add.args.length!==1||!object(add.args[0])||Object.keys(add.args[0]).join(',')!=='slug'||add.args[0].slug!==state.slug||add.journal!==undefined||add.componentPath!==undefined)return;
  state.queryFrames++;state.queryId=Number(add.queryId);return {frameType:'ModifyQuerySet',proof:{connectFrames:state.connectFrames,queryFrames:state.queryFrames,queryId:state.queryId,udfPath:'sites:getBySlug',slug:state.slug,authenticated:false}};
 }
}
export function sendAgentDropReadOnlyClientFrame(payload:string,state:AgentDropFrameState,send:(value:string)=>void):{frameType:string;proof?:AgentDropReadOnlyQueryProof}|undefined{
 const next={...state},checked=validateAgentDropClientFrame(payload,next);if(!checked)return;
 // The exact-frame check must complete before the only physical send call.
 // Commit the frame state only after that send succeeds.
 send(payload);Object.assign(state,next);return checked;
}
export function exactAgentDropPublicUrl(value:string,origin:string):boolean{try{const url=new URL(value),expected=new URL(origin);return url.origin===expected.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&AGENTDROP_ID.test(url.pathname.slice(1))}catch{return false}}
export function exactAgentDropRawContentUrl(value:string,apiOrigin:string,slug:string):boolean{try{const url=new URL(value),expected=new URL(apiOrigin);if(url.origin!==expected.origin||url.username||url.password||url.hash||url.pathname!==`/api/v1/sites/${slug}/raw`)return false;const entries=[...url.searchParams.entries()];return entries.length===1&&entries[0][0]==='v'&&new RegExp(`^sites/${slug}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.md$`,'i').test(entries[0][1])}catch{return false}}
export function classifyAgentDropRoute(value:string,pageUrl:string,contract:AgentDropRendererContract,slug:string):AgentDropNativeRequest['routeClass']|'analytics'|'passive'|'other'{
 if(value===pageUrl)return 'public_page';if(value===contract.convexSyncUrl)return 'convex_sync';if(exactAgentDropRawContentUrl(value,contract.apiOrigin,slug))return 'raw_content';
 try{const url=new URL(value);if(ANALYTICS_ORIGINS.has(url.origin))return 'analytics';if(url.origin===contract.pageOrigin&&url.pathname==='/api/auth/get-session'&&!url.search&&!url.hash)return 'anonymous_session';if(url.origin===contract.pageOrigin&&OPTIONAL_PASSIVE_PATHS.has(url.pathname)&&!url.search&&!url.hash)return 'passive';const resource=contract.staticResources.find(([path])=>path===url.pathname);if(url.origin===contract.pageOrigin&&resource&&!url.search&&!url.hash)return url.pathname.startsWith('/fonts/')?'font':'static_asset'}catch{}
 return 'other';
}
export const AGENTDROP_PRODUCTION_RENDERER_CONTRACT:AgentDropRendererContract={pageOrigin:AGENTDROP_ORIGIN,apiOrigin:AGENTDROP_API_ORIGIN,convexSyncUrl:AGENTDROP_CONVEX_SYNC_URL,staticResources:AGENTDROP_STATIC_RESOURCES};
