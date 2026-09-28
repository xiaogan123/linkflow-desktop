import {useCallback,useEffect,useState} from 'react';
import {ArrowClockwise,CheckCircle,DownloadSimple,Info,ShieldCheck,WarningCircle,X} from '@phosphor-icons/react';
import type {UpdatePhase,UpdateState} from '../../shared/update-types';
import {Button} from '../components';

type UpdateCommand='app:check-update'|'app:download-update'|'app:cancel-update'|'app:install-update';
type Props={demo:boolean;platform?:string;currentVersion?:string;taskBusy:boolean;onResult:(ok:boolean,message:string)=>void};

const activePhases=new Set<UpdatePhase>(['checking','downloading','installing']);
const phaseCopy:Record<UpdatePhase,{label:string;title:string;body:string;tone:string}>={
  idle:{label:'尚未检查',title:'在应用内完成更新',body:'只有点击检查后才会联网；发现版本后也由你决定何时下载和安装。',tone:'muted'},
  checking:{label:'正在检查',title:'正在检查新版本',body:'正在读取官方更新信息，请稍候。',tone:'blue'},
  available:{label:'有可用更新',title:'新版本可以下载',body:'查看版本说明后，可直接在这里下载。',tone:'blue'},
  downloading:{label:'正在下载',title:'正在下载更新',body:'可以继续查看页面，也可以取消本次下载。',tone:'blue'},
  prepared:{label:'准备安装',title:'更新已下载并验证',body:'结束正在运行的任务后，即可安装并重启。',tone:'green'},
  installing:{label:'正在安装',title:'正在交接安装',body:'应用将退出、完成替换并重新启动。',tone:'blue'},
  installed:{label:'已安装',title:'更新已安装',body:'应用已完成本次版本更新。',tone:'green'},
  'up-to-date':{label:'已是最新版',title:'当前版本可继续使用',body:'最近一次检查没有发现更高版本。',tone:'green'},
  unsupported:{label:'暂不支持',title:'此平台无法自动更新',body:'当前系统或架构没有匹配的可信安装包。',tone:'amber'},
  failed:{label:'更新失败',title:'这次更新没有完成',body:'查看错误后可以重试，或重新检查可用版本。',tone:'red'}
};

const formatBytes=(value?:number)=>typeof value==='number'&&Number.isFinite(value)?`${(value/1024/1024).toFixed(value>=100*1024*1024?0:1)} MB`:'—';
const formatPlatform=(value?:string)=>value==='darwin-arm64'||value==='darwin'?'macOS · Apple Silicon':value==='win32-x64'||value==='win32'?'Windows · 64 位':value||'正在识别平台';
const errorText=(value:unknown)=>value instanceof Error?value.message:String(value);

export function UpdateCenter({demo,platform,currentVersion,taskBusy,onResult}:Props){
  const [state,setState]=useState<UpdateState>({phase:'idle',currentVersion:currentVersion??'—'});
  const [command,setCommand]=useState<UpdateCommand|null>(null);
  const [lastCommand,setLastCommand]=useState<UpdateCommand>('app:check-update');

  const readStatus=useCallback(async()=>{
    if(demo||!window.linkflow)return;
    try{setState(await window.linkflow.invoke<UpdateState>('app:update-status'))}
    catch(error){setState(previous=>({...previous,phase:'failed',retryable:true,error:errorText(error)}))}
  },[demo]);

  useEffect(()=>{
    if(demo){setState({phase:'idle',currentVersion:currentVersion??'1.1.0'});return}
    void readStatus();
  },[demo,currentVersion,readStatus]);

  useEffect(()=>{
    if(demo||!activePhases.has(state.phase))return;
    const timer=window.setInterval(()=>void readStatus(),750);
    return()=>window.clearInterval(timer);
  },[demo,state.phase,readStatus]);

  const run=async(next:UpdateCommand)=>{
    if(demo||!window.linkflow)return;
    if(next==='app:install-update'&&taskBusy){onResult(false,'请等待当前任务结束，再安装并重启。');return}
    setCommand(next);setLastCommand(next);
    if(next==='app:check-update'||next==='app:install-update')setState(previous=>({...previous,phase:next==='app:check-update'?'checking':'installing',error:undefined}));
    try{
      const result=await window.linkflow.invoke<UpdateState>(next);
      setState(result);
      if(next==='app:cancel-update')onResult(true,'正在取消下载。');
    }catch(error){const message=errorText(error);await readStatus();onResult(false,message)}
    finally{setCommand(null)}
  };

  const copy=phaseCopy[state.phase];
  const progress=Math.max(0,Math.min(100,state.progress?.percent??0));
  const busy=command!==null||activePhases.has(state.phase);
  const retry=()=>run(lastCommand==='app:install-update'?'app:install-update':state.targetVersion?'app:download-update':'app:check-update');

  return <div className="page update-center-page">
    <div className="page-heading update-heading"><div><div className="eyebrow">APPLICATION / 更新中心</div><h1>更新留在应用里完成。</h1><p>先查看版本说明，再决定下载与安装时间。</p></div><span className="heading-seal"><ShieldCheck size={16}/>下载后校验安装包</span></div>
    {demo&&<div className="banner warning"><Info size={18}/>演示模式只展示更新中心，不会检查网络、下载或安装。</div>}
    <div className="update-center-grid">
      <section className="panel update-status-card" aria-live="polite">
        <header><div className={`update-phase-icon ${copy.tone}`}>{state.phase==='failed'||state.phase==='unsupported'?<WarningCircle size={25}/>:state.phase==='downloading'?<DownloadSimple size={25}/>:state.phase==='prepared'||state.phase==='installed'||state.phase==='up-to-date'?<CheckCircle size={25}/>:<ArrowClockwise size={25}/>}</div><div><span className={`badge ${copy.tone}`}>{copy.label}</span><h2>{copy.title}</h2><p>{copy.body}</p></div></header>
        <dl className="update-version-grid"><div><dt>当前版本</dt><dd>{state.currentVersion||currentVersion||'—'}</dd></div><div><dt>最新版本</dt><dd>{state.targetVersion??(state.phase==='up-to-date'?state.currentVersion:'尚未获取')}</dd></div><div><dt>运行平台</dt><dd>{formatPlatform(platform)}</dd></div><div><dt>最近检查</dt><dd>{state.checkedAt?new Date(state.checkedAt).toLocaleString():'尚未检查'}</dd></div></dl>
        {state.phase==='downloading'&&<div className="update-progress"><div><strong>下载进度</strong><span>{formatBytes(state.progress?.receivedBytes)} / {formatBytes(state.progress?.totalBytes)} · {Math.round(progress)}%</span></div><div className="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{width:`${progress}%`}}/></div></div>}
        {state.error&&<div className={`update-message ${state.phase==='failed'?'error':'notice'}`} role={state.phase==='failed'?'alert':'status'}>{state.phase==='failed'?<WarningCircle size={17}/>:<X size={17}/>}<span>{state.error}</span></div>}
        {platform?.startsWith('darwin')&&(['prepared','failed'].includes(state.phase))&&<div className="update-message notice"><Info size={17}/><span>若 macOS 提示来源确认，请自行在系统设置的“隐私与安全性”中处理。未完成启动确认时，软件会保留旧版恢复副本。</span></div>}
        {state.phase==='prepared'&&taskBusy&&<div className="update-message notice"><Info size={17}/><span>当前仍有任务在执行。请先让任务完成，安装按钮随后可用。</span></div>}
        <div className="update-actions">
          {(['idle','up-to-date','installed'].includes(state.phase))&&<Button variant="primary" disabled={demo||busy} onClick={()=>void run('app:check-update')}><ArrowClockwise size={16}/>{state.phase==='idle'?'检查更新':'再次检查'}</Button>}
          {state.phase==='available'&&<><Button variant="primary" disabled={demo||busy} onClick={()=>void run('app:download-update')}><DownloadSimple size={16}/>下载更新</Button><Button disabled={demo||busy} onClick={()=>void run('app:check-update')}><ArrowClockwise size={16}/>重新检查</Button></>}
          {state.phase==='downloading'&&<Button disabled={demo||command!==null} onClick={()=>void run('app:cancel-update')}><X size={16}/>取消下载</Button>}
          {state.phase==='prepared'&&<Button variant="primary" disabled={demo||busy||taskBusy} onClick={()=>void run('app:install-update')}>安装并重启</Button>}
          {state.phase==='failed'&&state.retryable&&<><Button variant="primary" disabled={demo||command!==null} onClick={()=>void retry()}><ArrowClockwise size={16}/>再试一次</Button><Button disabled={demo||command!==null} onClick={()=>void run('app:check-update')}>重新检查</Button></>}
        </div>
      </section>
      <aside className="update-details">
        <section className="panel update-notes"><div className="panel-head"><h2>版本说明</h2>{state.publishedAt&&<span>{new Date(state.publishedAt).toLocaleDateString()}</span>}</div><p>{state.releaseNotes?.trim()||'检查到新版本后，会在这里显示发布说明。'}</p></section>
        <section className="panel update-safety"><h2>安装前请确认</h2><ul><li>安装会关闭应用并重启，当前任务必须先结束。</li><li>网站、任务、账号关联和设置保留在本机数据目录。</li><li>更新包下载后会核对大小与签名摘要，再进入安装步骤。</li></ul></section>
      </aside>
    </div>
  </div>;
}
