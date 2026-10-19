import type {z} from 'zod';
import type {SettingsPatch} from './validation';
import type {Store,State} from './store';
import type {Vault} from './vault';
import type {Channel} from '../shared/types';
import {mailboxIdentityChanged} from './mail-settings';
import {reconcileGlobalArticleReviewMode} from './site-service';

export type SettingsWrite=z.infer<typeof SettingsPatch>;

export interface SettingsWriteResult {
  apiChanged:boolean;
  ahrefsChanged:boolean;
  mailChanged:boolean;
  mailSecretChanged:boolean;
  reviewModeSites:string[];
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
  const ahrefsApiKey=input.ahrefsApiKey?.trim()||undefined;
  const mailPassword=input.mailPassword
    ?nextMail.host==='imap.gmail.com'?input.mailPassword.replace(/\s/g,''):input.mailPassword
    :undefined;
  const clearSecrets:Record<string,string>={};
  if(apiKey)clearSecrets.apiKey=apiKey;
  if(ahrefsApiKey)clearSecrets.ahrefsApiKey=ahrefsApiKey;
  if(mailPassword)clearSecrets.mailPassword=mailPassword;
  const ciphers=Object.keys(clearSecrets).length?vault.encryptSecrets(clearSecrets):{};
  const deleteKeys:string[]=[];
  if(apiChanged&&!apiKey)deleteKeys.push('apiKey');
  if(mailChanged&&!mailPassword)deleteKeys.push('mailPassword');
  // This acknowledgement is writable only through the dedicated disclosure action.
  const {apiKey:_apiKey,mailPassword:_mailPassword,htmlAppPublicNotice:_htmlAppPublicNotice,
    channelOverrides:_channelOverrides,channelTrials:_channelTrials,
    ahrefsApiKey:_ahrefsApiKey,hasAhrefsKey:_hasAhrefsKey,ahrefsStatus:_ahrefsStatus,
    ahrefsLastUpdatedAt:_ahrefsLastUpdatedAt,ahrefsLastRefreshMonth:_ahrefsLastRefreshMonth,
    ahrefsRetryAfter:_ahrefsRetryAfter,...safe}=input as SettingsWrite&{channelTrials?:unknown};
  let reviewModeSites:string[]=[];
  const apply=(state:State)=>{
    state.settings={
      ...state.settings,
      ...safe,
      // Settings UI sends a whole snapshot. An old copy cannot be treated as
      // per-key intent after a trial has automatically written false.
      channelOverrides:{...state.settings.channelOverrides},
      hasBingKey:previous.hasBingKey,
      hasAhrefsKey:!!ahrefsApiKey||previous.hasAhrefsKey,
      ...(ahrefsApiKey?{ahrefsStatus:undefined,ahrefsLastUpdatedAt:undefined,ahrefsLastRefreshMonth:undefined,ahrefsRetryAfter:undefined}:{}),
      hasApiKey:!!apiKey||(!apiChanged&&previous.hasApiKey),
      mail:{...nextMail,hasPassword:!!mailPassword||(!mailChanged&&previous.mail.hasPassword)},
    };
    if(input.articleReviewMode!==undefined)reviewModeSites=reconcileGlobalArticleReviewMode(state,previous);
  };
  store.updateWithCiphers(apply,ciphers,deleteKeys);
  return {apiChanged,ahrefsChanged:!!ahrefsApiKey,mailChanged,mailSecretChanged:mailChanged||!!mailPassword,reviewModeSites};
}

/** Explicit owner action; a stale generic settings save cannot undo this boundary. */
export function enableStoppedChannelTrial(store:Store,channelId:string,channels:readonly Channel[]):void{
  if(!channels.some(channel=>channel.id===channelId&&channel.enabled))throw Error('平台不存在或已停用');
  store.update(state=>{
    const trial=state.settings.channelTrials?.[channelId];
    const survival=state.settings.platformSurvival?.[channelId];
    if(!trial?.disabledAt&&!survival?.pausedAt)throw Error('平台没有待恢复的自动停用记录');
    if(survival?.pausedAt){survival.pausedAt=undefined;survival.resumedAt=new Date().toISOString()}
    state.settings.channelOverrides[channelId]=true;
    if(!trial)return;
    trial.disabledAt=undefined;
    trial.autoDisabledOverride=undefined;
    trial.failures=0;
    trial.reason=undefined;
  });
}
