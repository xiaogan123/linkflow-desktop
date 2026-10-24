import {useMemo,useState} from 'react';
import {CheckCircle} from '@phosphor-icons/react';
import type {AddSitesBatchResult,Snapshot} from '../../shared/types';
import {Button} from '../components';
import {channelMetricView} from '../channel-metrics';
import {linkRows} from '../links-model';
import {platformName,platformRows} from '../platforms-model';
import {AddSitesForm} from './AddSitesForm';

type Action=<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>;
type Step=1|2|3|4|5;

/** 4.0 第一次打开: AI, sites, publishing mode, then up to three platforms worth one connection. */
export function FirstRunWizard({data,disabled,onAction,onClose,onSettings,onConnect,onOverview}:{
  data:Snapshot;disabled:boolean;onAction:Action;onClose:()=>void;onSettings:()=>void;
  onConnect:(channelId:string)=>void;onOverview:()=>void;
}){
  const [step,setStep]=useState<Step>(data.runtime.aiReady?2:1);
  const [aiMessage,setAiMessage]=useState('');
  const [added,setAdded]=useState<AddSitesBatchResult|null>(null);
  const [mode,setMode]=useState<'ai'|'manual'>('ai');
  const [busy,setBusy]=useState(false);
  const titles=['连接 AI','添加网站','选择发布方式','值得连一次的平台'];

  const connectLocal=async(provider:'codex'|'claude')=>{
    const name=provider==='codex'?'本机 Codex':'本机 Claude';
    setBusy(true);setAiMessage('');
    try{
      // A model fixed for another provider means nothing here; use the account's default.
      await onAction('settings:save',data.settings.provider===provider?{provider}:{provider,model:'',reasoningEffort:undefined});
      const result=await onAction<{ok:boolean;message:string}>('settings:test-ai');
      setAiMessage(result?.ok?'AI 已连接。':result?.message??`没有连上${name}，可以到设置里换一种方式。`);
    }finally{setBusy(false)}
  };
  const applyMode=async()=>{
    setBusy(true);
    try{
      // The sites were added with the default; apply the choice to them and keep it for new sites.
      await onAction('settings:save',{articleReviewMode:mode});
      if(mode==='manual')for(const id of added?.siteIds??[])await onAction('site:update',{id,articleReviewMode:'manual'});
      setStep(4);
    }finally{setBusy(false)}
  };

  const firstSite=data.sites.find(site=>added?.siteIds.includes(site.id))??data.sites.find(site=>!site.archivedAt);
  const suggestions=useMemo(()=>firstSite?platformRows(data,firstSite,linkRows(data))
    .filter(row=>row.group==='connect_once'&&row.action.kind==='connect')
    .sort((a,b)=>drValue(b.channel)-drValue(a.channel)).slice(0,3):[],[data,firstSite]);

  if(step===5)return <div className="dialog-form first-run done">
    <p className="first-run-done"><CheckCircle size={22}/>已添加 {added?.added??0} 个网站。第一批明天开始发，{added?.rolloutDays??1} 天内全部铺开。</p>
    <div className="dialog-actions"><Button variant="primary" onClick={onOverview}>去总览</Button></div>
  </div>;

  return <div className="dialog-form first-run">
    <ol className="first-run-steps">{titles.map((title,index)=><li key={title} className={index+1===step?'active':index+1<step?'done':''}>{index+1} {title}</li>)}</ol>

    {step===1&&<section>
      <p>外链助手用 AI 写稿和复核。</p>
      {data.runtime.aiReady?<p className="inline-status">AI 已连接。</p>:<div className="toolbar-actions">
        <Button variant="primary" disabled={disabled||busy} onClick={()=>void connectLocal('codex')}>{busy?'正在连接…':'用本机 Codex'}</Button>
        <Button disabled={disabled||busy} onClick={()=>void connectLocal('claude')}>用本机 Claude</Button>
        <Button disabled={disabled||busy} onClick={onSettings}>其他 AI 服务</Button></div>}
      {aiMessage&&<p role="status" className="inline-status">{aiMessage}</p>}
      <div className="dialog-actions"><Button variant="primary" onClick={()=>setStep(2)}>{data.runtime.aiReady?'下一步':'先跳过，下一步'}</Button></div>
    </section>}

    {step===2&&<AddSitesForm disabled={disabled} hideMode mailboxes={data.mailboxes} onAction={onAction} onAdded={result=>setAdded(previous=>previous?{...result,added:previous.added+result.added,siteIds:[...previous.siteIds,...result.siteIds],rolloutDays:Math.max(previous.rolloutDays,result.rolloutDays)}:result)} onClose={()=>added?.added?setStep(3):onClose()}/>}

    {step===3&&<section>
      <fieldset className="article-review-mode"><legend className="sr-only">发布方式</legend>
        <label className={mode==='ai'?'selected':''}><input type="radio" name="first-run-mode" checked={mode==='ai'} onChange={()=>setMode('ai')}/><span><strong>全自动（推荐）</strong><small>AI 写稿后进行 AI 复核，通过才发布。</small></span></label>
        <label className={mode==='manual'?'selected':''}><input type="radio" name="first-run-mode" checked={mode==='manual'} onChange={()=>setMode('manual')}/><span><strong>每篇我先看</strong><small>稿子写好后等你确认，48 小时没看就放弃这篇。</small></span></label>
      </fieldset>
      <p className="muted">以后可以逐个网站改。</p>
      <div className="dialog-actions"><Button variant="primary" disabled={disabled||busy} onClick={()=>void applyMode()}>下一步</Button></div>
    </section>}

    {step===4&&<section>
      {suggestions.length?<ul className="first-run-platforms">{suggestions.map(row=><li key={row.channel.id}><span><strong>{platformName(row.channel)}</strong> · {row.oneLiner}</span>
        <Button disabled={disabled} onClick={()=>onConnect(row.channel.id)}>连接</Button></li>)}</ul>
        :<p className="muted">这些网站暂时不需要连接平台，外链助手会先用免注册和自动建号的平台。</p>}
      <div className="dialog-actions"><Button onClick={()=>setStep(5)}>以后再说</Button></div>
    </section>}
  </div>;
}

function drValue(channel:Parameters<typeof channelMetricView>[0]){
  const value=Number(channelMetricView(channel).dr.replace(/^DR\s*/,''));
  return Number.isFinite(value)?value:-1;
}
