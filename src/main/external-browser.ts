import {spawn,type ChildProcess} from 'node:child_process';
import type {Settings} from '../shared/types';

export interface ExternalLaunch {command:string;args:string[]}
export function preferredBrowserLaunch(url:string,preferred:Settings['preferredBrowser'],platform:NodeJS.Platform=process.platform):ExternalLaunch|undefined{
  if(!preferred||preferred==='system')return;
  if(platform==='darwin')return {command:'/usr/bin/open',args:['-a',preferred==='chrome'?'Google Chrome':'Microsoft Edge',url]};
  if(platform==='win32')return {command:preferred==='chrome'?'chrome.exe':'msedge.exe',args:[url]};
  return {command:preferred==='chrome'?'google-chrome':'microsoft-edge',args:[url]};
}
type BrowserSpawner=(command:string,args:string[],options:{shell:false;stdio:'ignore';detached:false})=>ChildProcess;

export async function openInPreferredBrowser(url:string,preferred:Settings['preferredBrowser'],systemOpen:(url:string)=>Promise<void>,platform:NodeJS.Platform=process.platform,spawnBrowser:BrowserSpawner=spawn):Promise<void>{
  const launch=preferredBrowserLaunch(url,preferred,platform);if(!launch){await systemOpen(url);return}
  const waitForLauncherExit=platform==='darwin'&&launch.command==='/usr/bin/open';
  const ok=await new Promise<boolean>(resolve=>{
    let settled=false,spawned=false;
    const finish=(value:boolean)=>{if(settled)return;settled=true;resolve(value)};
    let child:ChildProcess;
    try{child=spawnBrowser(launch.command,launch.args,{shell:false,stdio:'ignore',detached:false})}catch{finish(false);return}
    child.once('error',()=>finish(false));
    child.once('spawn',()=>{spawned=true;if(!waitForLauncherExit){child.unref();finish(true)}});
    child.once('close',code=>{if(waitForLauncherExit||!spawned)finish(code===0)});
  });
  if(!ok)await systemOpen(url);
}
