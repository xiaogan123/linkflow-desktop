import {BATCH5_HACKMD_CONNECTION_COPY as COPY} from '../../shared/batch5-messages';
import {useRef,useState} from 'react';
import {ArrowSquareOut,X} from '@phosphor-icons/react';
import type {Account,Snapshot} from '../../shared/types';
import {Button,Field} from '../components';



type Props={data:Snapshot|null;disabled:boolean;account?:Account;onClose:()=>void;onAction:<T>(command:string,payload?:unknown,success?:string)=>Promise<T|undefined>};
export function HackmdConnection({data,disabled,account,onClose,onAction}:Props){
  const existing=(data?.accountBindings??[]).find(binding=>binding.accountId===account?.id)?.siteId??'';
  const [token,setToken]=useState(''),[siteId,setSiteId]=useState(existing);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),inFlight=useRef(false);
  const enabled=!!data?.channels.find(channel=>channel.id==='hackmd'&&channel.enabled);
  async function connect(){
    if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
    try{const result=await onAction<Account>('account:connect-hackmd',{token,siteIds:[siteId],accountId:account?.id},enabled?COPY.success:COPY.saved);
      if(result)onClose();else setError(COPY.failure);
    }finally{setToken('');setBusy(false);inFlight.current=false}
  }
  return <div className="side-drawer-backdrop"><aside className="side-drawer narrow" role="dialog" aria-modal="true" aria-label={COPY.label}>
    <header><div><h2>{account?COPY.update:COPY.label}</h2></div>
      <button className="icon-button" aria-label={COPY.close} disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <div className="drawer-form"><p className="drawer-intro">{COPY.intro}</p>
      {!enabled&&<p className="account-diagnostic" role="status">{COPY.pending}</p>}
      <Field label={COPY.token} hint={COPY.tokenHint}><input aria-label={COPY.token} type="password" autoComplete="new-password" value={token}
        disabled={disabled||busy} onChange={event=>setToken(event.target.value)}/></Field>
      <Button variant="text" disabled={disabled||busy} onClick={()=>void onAction('external:open',{url:'https://hackmd.io/settings#api'})}>{COPY.openSettings}<ArrowSquareOut size={13}/></Button>
      <fieldset className="checkbox-grid"><legend>{COPY.binding}</legend>{(data?.sites??[]).map(site=><label className="site-binding-option" key={site.id}>
        <input type="radio" name="hackmd-site" checked={siteId===site.id} disabled={disabled||busy} onChange={()=>setSiteId(site.id)}/><span>{site.domain}</span>
      </label>)}</fieldset>
      {error&&<p role="alert" className="account-diagnostic">{error}</p>}
      <div className="drawer-actions"><Button disabled={busy} onClick={onClose}>{COPY.cancel}</Button><Button variant="primary"
        disabled={disabled||busy||!token||!siteId} onClick={()=>void connect()}>{busy?COPY.connecting:COPY.connect}</Button></div>
    </div>
  </aside></div>;
}
