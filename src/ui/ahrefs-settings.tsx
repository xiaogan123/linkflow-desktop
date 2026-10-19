import {useState} from 'react';
import {displayParts} from './display-time';
import {LockKey} from '@phosphor-icons/react';
import type {Settings} from '../shared/types';
import {Button,Field} from './components';
import {authorityCopy} from './authority-copy';

type AhrefsSettings=Pick<Settings,'hasAhrefsKey'|'ahrefsStatus'|'ahrefsLastUpdatedAt'>;
type Props={settings:AhrefsSettings;disabled:boolean;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};

export function ahrefsStatusText(settings:AhrefsSettings):string{
 if(!settings.hasAhrefsKey)return authorityCopy.unconfigured;
 const updated=settings.ahrefsLastUpdatedAt?new Date(settings.ahrefsLastUpdatedAt):undefined;
 if(settings.ahrefsStatus==='connected'&&updated&&Number.isFinite(updated.getTime())){
  const parts=displayParts(updated);
  return authorityCopy.connected(parts.month,parts.day);
 }
 return authorityCopy.failed;
}

export async function saveAhrefsSettings(apiKey:string,settings:AhrefsSettings,onAction:Props['onAction']):Promise<'unconfigured'|'connected'|'error'>{
 const key=apiKey.trim();
 if(!key&&!settings.hasAhrefsKey)return 'unconfigured';
 try{
  const result=await onAction<{ok:boolean}>('ahrefs.saveAndTest',{apiKey:key});
  return result?.ok?'connected':'error';
 }catch{return 'error'}
}

export function AhrefsSettingsCard({settings,disabled,onAction}:Props){
 const [apiKey,setApiKey]=useState(''),[testing,setTesting]=useState(false),[failed,setFailed]=useState(false);
 const save=async()=>{
  if(testing||disabled)return;
  setFailed(false);
  if(!apiKey.trim()&&!settings.hasAhrefsKey)return;
  setTesting(true);
  try{
   const status=await saveAhrefsSettings(apiKey,settings,onAction);
   if(status==='connected')setApiKey('');
   setFailed(status==='error');
  }finally{setTesting(false)}
 };
 return <section className="panel settings-card">
  <div className="settings-heading"><div className="setting-icon"><LockKey size={21}/></div><div><h2>{authorityCopy.keyTitle}</h2><p>{authorityCopy.keyDescription}</p></div></div>
  <Field label={authorityCopy.keyTitle}><input type="password" autoComplete="new-password" value={apiKey} disabled={disabled||testing} onChange={event=>{setApiKey(event.target.value);setFailed(false)}}/></Field>
  <div className="connection-footer"><Button variant="primary" onClick={()=>void save()} disabled={disabled||testing}>{authorityCopy.saveAndTest}</Button><span role="status">{failed?authorityCopy.failed:ahrefsStatusText(settings)}</span></div>
 </section>;
}
