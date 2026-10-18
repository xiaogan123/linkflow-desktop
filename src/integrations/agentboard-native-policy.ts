import {AGENTBOARD_ORIGIN} from './agentboard';

export const AGENTBOARD_NATIVE_STYLESHEET_URLS=Object.freeze([
  `${AGENTBOARD_ORIGIN}/assets/style.css?v=20261012-organic-discussion-1`,
  `${AGENTBOARD_ORIGIN}/assets/site-shell.css?v=20261012-zero-header-gap`,
] as const);

const stylesheetUrls=new Set<string>(AGENTBOARD_NATIVE_STYLESHEET_URLS);

export function exactAgentboardStylesheetUrl(value:string):boolean{return stylesheetUrls.has(value)}

export function agentboardNativeResourceType(
  request:{url:string;method:string;resourceType:string},
  publicUrl:string,
  mainFrameAvailable:boolean,
):'mainFrame'|'stylesheet'|undefined{
  if(request.method!=='GET')return undefined;
  if(mainFrameAvailable&&request.resourceType==='mainFrame'&&request.url===publicUrl)return 'mainFrame';
  if(request.resourceType==='stylesheet'&&exactAgentboardStylesheetUrl(request.url))return 'stylesheet';
  return undefined;
}
