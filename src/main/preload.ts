import { contextBridge, ipcRenderer } from 'electron';
import {IPC_COMMANDS} from '../shared/types';
const allowed=new Set<string>(IPC_COMMANDS);
contextBridge.exposeInMainWorld('linkflow',{
  invoke:async(command:string,payload:unknown={})=>{if(!allowed.has(command))throw Error('不支持的操作');const response=await ipcRenderer.invoke('linkflow:command',command,payload);if(!response.ok)throw Error(response.error);return response.value;},
  onChange:(callback:()=>void)=>{const listener=()=>callback();ipcRenderer.on('linkflow:changed',listener);return ()=>ipcRenderer.removeListener('linkflow:changed',listener)}
});
