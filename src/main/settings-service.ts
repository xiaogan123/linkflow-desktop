import type {z} from 'zod';
import type {SettingsPatch} from './validation';
import type {Store,State} from './store';
import type {Vault} from './vault';
import {mailboxIdentityChanged} from './mail-settings';

export type SettingsWrite=z.infer<typeof SettingsPatch>;

export interface SettingsWriteResult {
  apiChanged:boolean;
  mailChanged:boolean;
  mailSecretChanged:boolean;
}

/** Encrypt every replacement first, then commit settings and secret changes together. */
export function saveSettingsAtomic(store:Store,vault:Pick<Vault,'encryptSecrets'>,input:SettingsWrite):SettingsWriteResult{
  const previous=store.read().settings;
  const nextMail={...previous.mail,...input.mail};
  nextMail.host=nextMail.host.trim().toLowerCase().replace(/\.$/,'');
  nextMail.user=nextMail.user.trim();
  const mailChanged=mailboxIdentityChanged(previous.mail,nextMail);
  const apiChanged=input.apiBase!==undefined&&input.apiBase!==previous.apiBase;
  const apiKey=input.apiKey||undefined;
  const mailPassword=input.mailPassword
    ?nextMail.host==='imap.gmail.com'?input.mailPassword.replace(/\s/g,''):input.mailPassword
    :undefined;
  const clearSecrets:Record<string,string>={};
  if(apiKey)clearSecrets.apiKey=apiKey;
  if(mailPassword)clearSecrets.mailPassword=mailPassword;
  const ciphers=Object.keys(clearSecrets).length?vault.encryptSecrets(clearSecrets):{};
  const deleteKeys:string[]=[];
  if(apiChanged&&!apiKey)deleteKeys.push('apiKey');
  if(mailChanged&&!mailPassword)deleteKeys.push('mailPassword');
  const {apiKey:_apiKey,mailPassword:_mailPassword,...safe}=input;
  const apply=(state:State)=>{
    state.settings={
      ...state.settings,
      ...safe,
      hasBingKey:previous.hasBingKey,
      hasApiKey:!!apiKey||(!apiChanged&&previous.hasApiKey),
      mail:{...nextMail,hasPassword:!!mailPassword||(!mailChanged&&previous.mail.hasPassword)},
    };
  };
  store.updateWithCiphers(apply,ciphers,deleteKeys);
  return {apiChanged,mailChanged,mailSecretChanged:mailChanged||!!mailPassword};
}
