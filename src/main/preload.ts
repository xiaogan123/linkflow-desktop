import { contextBridge, ipcRenderer } from 'electron';
const allowed=new Set(['snapshot','site:add','site:update','site:delete','site:analyze','site:pause','task:retry','task:skip','task:verify','task:set-url','task:open','task:generate','task:update-draft','plan:run','plan:pause','settings:save','settings:test-ai','settings:test-mail','account:save','account:reveal','account:delete','backup:export','backup:import','data:export','external:open','app:quit']);
contextBridge.exposeInMainWorld('linkflow',{
  invoke:async(command:string,payload:unknown={})=>{if(!allowed.has(command))throw Error('不支持的操作');const response=await ipcRenderer.invoke('linkflow:command',command,payload);if(!response.ok)throw Error(response.error);return response.value;},
  onChange:(callback:()=>void)=>{const listener=()=>callback();ipcRenderer.on('linkflow:changed',listener);return ()=>ipcRenderer.removeListener('linkflow:changed',listener)}
});
