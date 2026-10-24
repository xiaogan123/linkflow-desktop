import {HUMAN_ACTION_IPC_COMMANDS} from '../shared/human-action';
import { contextBridge, ipcRenderer } from 'electron';
import type {UpdateState} from '../shared/update-types';
import {BITBUCKET_IPC_COMMANDS,HERE_NOW_IPC_COMMANDS,IPC_COMMANDS,PLOPINO_IPC_COMMANDS,SHIPLY_IPC_COMMANDS,VALTOWN_IPC_COMMANDS,type DraftClipboardRequest} from '../shared/types';
const allowed=new Set<string>([...IPC_COMMANDS,...HERE_NOW_IPC_COMMANDS,...PLOPINO_IPC_COMMANDS,...SHIPLY_IPC_COMMANDS,...VALTOWN_IPC_COMMANDS,...BITBUCKET_IPC_COMMANDS,...HUMAN_ACTION_IPC_COMMANDS]);
contextBridge.exposeInMainWorld('linkflow',{
  invoke:async(command:string,payload:unknown={})=>{if(!allowed.has(command))throw Error('不支持的操作');const response=await ipcRenderer.invoke('linkflow:command',command,payload);if(!response.ok)throw Error(response.error);return response.value;},
  copyDraft:async(payload:DraftClipboardRequest)=>{const response=await ipcRenderer.invoke('linkflow:draft-copy',payload);if(!response?.ok)throw Object.assign(Error(response?.error??'复制失败'),{reasonCode:response?.reasonCode});},
  onUpdate:(callback:(state:UpdateState)=>void)=>{const listener=(_event:Electron.IpcRendererEvent,state:UpdateState)=>callback(state);ipcRenderer.on('linkflow:update',listener);return ()=>ipcRenderer.removeListener('linkflow:update',listener)},
  onChange:(callback:()=>void)=>{const listener=()=>callback();ipcRenderer.on('linkflow:changed',listener);return ()=>ipcRenderer.removeListener('linkflow:changed',listener)}
});
