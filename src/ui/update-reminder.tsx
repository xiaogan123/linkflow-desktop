import {useEffect,useState} from 'react';
import {ArrowClockwise,X} from '@phosphor-icons/react';
import type {UpdateState} from '../shared/update-types';
import {Button} from './components';

export function updateReminder(state:UpdateState|null){
  if(!state)return null;
  const version=state.targetVersion?` ${state.targetVersion}`:'';
  if(state.recoveryPending)return {key:`recovery:${version}`,label:'需处理',text:'上次更新尚待恢复，原数据和恢复副本已保留。',action:'查看恢复方法'};
  switch(state.phase){
    case 'available':return {key:`available:${version}`,label:'有更新',text:`新版本${version}已可下载。`,action:'查看更新'};
    case 'downloading':return {key:`downloading:${version}`,label:'下载中',text:`正在下载新版本${version}，可继续使用软件。`,action:'查看进度'};
    case 'prepared':return {key:`prepared:${version}`,label:'待安装',text:`新版本${version}已下载并校验，可在任务结束后安装。`,action:'前往安装'};
    case 'failed':return {key:`failed:${version}`,label:'需重试',text:state.targetVersion?'更新尚未完成，可在更新中心查看原因并重试。':'暂时无法检查更新，可继续使用软件，稍后会再次检查。',action:'查看更新'};
    default:return null;
  }
}

export function useUpdateStatus(enabled:boolean){
  const [state,setState]=useState<UpdateState|null>(null);
  useEffect(()=>{
    const api=window.linkflow;if(!enabled||!api){setState(null);return}
    let alive=true,sequence=0;
    const read=()=>{const request=++sequence;void api.invoke<UpdateState>('app:update-status').then(next=>{if(alive&&request===sequence)setState(next)}).catch(()=>{})};
    const unsubscribe=api.onUpdate?.(next=>{sequence++;if(alive)setState(next)});
    read();window.addEventListener('focus',read);
    return()=>{alive=false;sequence++;unsubscribe?.();window.removeEventListener('focus',read)};
  },[enabled]);
  return state;
}

export function UpdateReminder({state,onOpen,hidden=false}:{state:UpdateState|null;onOpen:()=>void;hidden?:boolean}){
  const [dismissed,setDismissed]=useState(''),reminder=updateReminder(state);
  if(hidden||!reminder||dismissed===reminder.key)return null;
  return <div className="banner update-reminder" role="status"><ArrowClockwise size={20}/><span><strong>{reminder.text}</strong><small>下载和安装由你确认，更新中心始终保留提示。</small></span><Button variant="primary" onClick={onOpen}>{reminder.action}</Button><button className="icon-button" aria-label="本次暂时收起更新提醒" title="本次暂时收起，更新中心仍有提示" onClick={()=>setDismissed(reminder.key)}><X size={18}/></button></div>;
}
