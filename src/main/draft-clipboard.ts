import {z} from 'zod';
import type {Site,Task} from '../shared/types';
import {containsReferralInformation,REFERRAL_MESSAGES,siteReferralCodes} from '../shared/referral-policy';
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
  getSite?:(siteId:string)=>Pick<Site,'description'|'url'>|undefined;
  writeText:(value:string)=>void|Promise<void>;
};

export type DraftClipboardResponse={ok:true}|{ok:false;error:string;reasonCode?:DraftClipboardErrorCode};

type DraftClipboardErrorCode='unauthorized'|'missing_draft'|'active_or_submitted'|'referral_blocked';
class DraftClipboardError extends Error{
  constructor(readonly code:DraftClipboardErrorCode,message:string){super(message);this.name='DraftClipboardError'}
}

export function createDraftClipboardHandler(dependencies:DraftClipboardDependencies){
  return async(event:DraftClipboardEvent,payload:unknown):Promise<DraftClipboardResponse>=>{
    try{
      const window=dependencies.getWindow(),frame=event.senderFrame;
      if(!window||window.isDestroyed()||!frame||event.sender!==window.webContents||frame!==window.webContents.mainFrame||frame.url!==dependencies.getRenderURL())throw new DraftClipboardError('unauthorized','无权调用此操作');
      const input=DraftClipboardPayload.parse(payload);
      const task=dependencies.getTasks().find(item=>item.id===input.id);
      if(!task?.draft)throw new DraftClipboardError('missing_draft','稿件不存在');
      if(task.status==='running'||hasExternalAttempt(task))throw new DraftClipboardError('active_or_submitted','正在执行或已有远程发布记录的材料不能复制');
      const site=dependencies.getSite?.(task.siteId);
      let siteHost:string|undefined;
      try{siteHost=site?new URL(site.url).hostname.toLowerCase().replace(/^www\./,''):undefined}catch{/* site validation handles invalid addresses */}
      if(containsReferralInformation(input.value,site?siteReferralCodes(site,task.evidenceSnapshot):[],siteHost))throw new DraftClipboardError('referral_blocked',REFERRAL_MESSAGES.copyBlocked);
      await dependencies.writeText(input.value);
      return {ok:true};
    }catch(error){
      const message=error instanceof DraftClipboardError
        ?error.message
        :'复制请求无效';
      return {ok:false,error:message,...(error instanceof DraftClipboardError?{reasonCode:error.code}:{})};
    }
  };
}
