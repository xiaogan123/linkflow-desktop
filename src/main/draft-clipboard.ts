import {z} from 'zod';
import type {Task} from '../shared/types';
import {hasExternalAttempt} from './task-recovery';

const Id=z.string().uuid();
const DraftClipboardPayload=z.discriminatedUnion('field',[
  z.object({id:Id,field:z.literal('title'),value:z.string().min(1).max(150)}).strict(),
  z.object({id:Id,field:z.literal('description'),value:z.string().min(1).max(3000)}).strict(),
  z.object({id:Id,field:z.literal('body'),value:z.string().min(1).max(30000)}).strict(),
]).refine(input=>input.value.trim().length>0);

export type DraftClipboardRequest=z.infer<typeof DraftClipboardPayload>;

type TrustedWindow={
  isDestroyed():boolean;
  webContents:{mainFrame:unknown};
};

export type DraftClipboardEvent={
  sender:unknown;
  senderFrame:{url:string}|null;
};

type DraftClipboardDependencies={
  getWindow:()=>TrustedWindow|null;
  getRenderURL:()=>string;
  getTasks:()=>Task[];
  writeText:(value:string)=>void|Promise<void>;
};

export type DraftClipboardResponse={ok:true}|{ok:false;error:string};

export function createDraftClipboardHandler(dependencies:DraftClipboardDependencies){
  return async(event:DraftClipboardEvent,payload:unknown):Promise<DraftClipboardResponse>=>{
    try{
      const window=dependencies.getWindow(),frame=event.senderFrame;
      if(!window||window.isDestroyed()||!frame||event.sender!==window.webContents||frame!==window.webContents.mainFrame||frame.url!==dependencies.getRenderURL())throw Error('无权调用此操作');
      const input=DraftClipboardPayload.parse(payload);
      const task=dependencies.getTasks().find(item=>item.id===input.id);
      if(!task?.draft)throw Error('稿件不存在');
      if(task.status==='running'||hasExternalAttempt(task))throw Error('正在执行或已有远程发布记录的材料不能复制');
      await dependencies.writeText(input.value);
      return {ok:true};
    }catch(error){
      const message=error instanceof Error&&['无权调用此操作','稿件不存在','正在执行或已有远程发布记录的材料不能复制'].includes(error.message)
        ?error.message
        :'复制请求无效';
      return {ok:false,error:message};
    }
  };
}
