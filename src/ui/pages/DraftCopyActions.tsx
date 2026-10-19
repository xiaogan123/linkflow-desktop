import {useEffect,useRef,useState} from 'react';
import {Copy} from '@phosphor-icons/react';
import {Button} from '../components';
import {containsReferralInformation,REFERRAL_MESSAGES} from '../../shared/referral-policy';

type DraftField='title'|'description'|'body';
type CopyFeedback={kind:'success'|'error';message:string};
type ClipboardWrite=(value:string)=>Promise<void>;

const fieldLabels:Record<DraftField,string>={title:'标题',description:'简介',body:'正文'};

export async function copyDraftValue(
  field:DraftField,
  value:string,
  writeText:ClipboardWrite|undefined,
  commit:(feedback:CopyFeedback)=>void,
  isCurrent:()=>boolean=()=>true
):Promise<void>{
  const label=fieldLabels[field];
  if(!value.trim()){
    if(isCurrent())commit({kind:'error',message:`${label}为空，暂无内容可复制。`});
    return;
  }
  if(containsReferralInformation(value)){
    if(isCurrent())commit({kind:'error',message:REFERRAL_MESSAGES.copyBlocked});
    return;
  }
  if(!writeText){
    if(isCurrent())commit({kind:'error',message:'当前环境不支持复制，请手动选中内容。'});
    return;
  }
  try{
    await writeText(value);
    if(isCurrent())commit({kind:'success',message:`${label}已复制。`});
  }catch(error){
    const message=typeof error==='object'&&error!==null&&'reasonCode' in error&&error.reasonCode==='referral_blocked'
      ?REFERRAL_MESSAGES.copyBlocked
      :`${label}复制失败，请手动选中内容。`;
    if(isCurrent())commit({kind:'error',message});
  }
}

export function DraftCopyActions({taskId,title,description,body}:{taskId:string;title:string;description:string;body:string}){
  const [feedback,setFeedback]=useState<CopyFeedback|null>(null);
  const request=useRef(0),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current+=1}},[]);
  const copy=(field:DraftField,value:string)=>{
    const id=++request.current;
    const writeText=window.linkflow?.copyDraft
      ?(text:string)=>window.linkflow!.copyDraft({id:taskId,field,value:text})
      :undefined;
    void copyDraftValue(field,value,writeText,setFeedback,()=>mounted.current&&request.current===id);
  };
  return <div className="draft-copy-tools">
    <div className="draft-copy-actions" aria-label="复制稿件内容">
      <Button onClick={()=>copy('title',title)}><Copy size={15}/>复制标题</Button>
      <Button onClick={()=>copy('description',description)}><Copy size={15}/>复制简介</Button>
      <Button onClick={()=>copy('body',body)}><Copy size={15}/>复制正文</Button>
    </div>
    {feedback&&<p className={`draft-copy-feedback ${feedback.kind}`} role={feedback.kind==='error'?'alert':'status'} aria-live="polite">{feedback.message}</p>}
  </div>;
}
