import {spawn} from 'node:child_process';
import type {Settings} from '../shared/types';

export interface ExternalLaunch {command:string;args:string[]}
export function preferredBrowserLaunch(url:string,preferred:Settings['preferredBrowser'],platform:NodeJS.Platform=process.platform):ExternalLaunch|undefined{
  if(!preferred||preferred==='system')return;
  if(platform==='darwin')return {command:'/usr/bin/open',args:['-a',preferred==='chrome'?'Google Chrome':'Microsoft Edge',url]};
  if(platform==='win32')return {command:preferred==='chrome'?'chrome.exe':'msedge.exe',args:[url]};
  return {command:preferred==='chrome'?'google-chrome':'microsoft-edge',args:[url]};
}
export async function openInPreferredBrowser(url:string,preferred:Settings['preferredBrowser'],systemOpen:(url:string)=>Promise<void>):Promise<void>{
  const launch=preferredBrowserLaunch(url,preferred);if(!launch){await systemOpen(url);return}
  const ok=await new Promise<boolean>(resolve=>{let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;resolve(value)};const child=spawn(launch.command,launch.args,{shell:false,stdio:'ignore',detached:false});child.on('error',()=>finish(false));child.on('close',code=>finish(code===0))});
  if(!ok)await systemOpen(url);
}
