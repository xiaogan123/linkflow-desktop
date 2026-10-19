import {BATCH5_CONNECTED_MESSAGES as M} from '../shared/batch5-messages';
import {randomUUID} from 'node:crypto';
import type {Account} from '../shared/types';
import type {Batch5Dependencies} from '../integrations/batch5-contract';
import {connectedRequest,parseConnectedJson} from '../integrations/batch5-connected';
import {CHANNELS} from '../integrations/catalog';
import {AccountBindingError,bindAccount,unbindAccount} from './account-bindings';
import type {Store} from './store';
import type {Vault} from './vault';

type StateStore=Pick<Store,'read'|'updateWithCiphers'>;
type AtomicVault=Pick<Vault,'encryptSecrets'>;
export interface HackMdSelection {token:string;siteIds:string[];accountId?:string}
export interface HackMdManagementDependencies extends Batch5Dependencies {signal?:AbortSignal}
export type HackMdManagementErrorCode='invalid_token'|'site_missing'|'identity_mismatch'|'connection_missing'|'state_changed'|'channel_unavailable'|'connection_failed'|'encryption_failed';
export class HackMdManagementError extends Error{
  constructor(readonly code:HackMdManagementErrorCode,message:string,options?:ErrorOptions){super(message,options);this.name='HackMdManagementError'}
}

function validToken(token:string):boolean {
  return token.length>=16&&Buffer.byteLength(token,'utf8')<=8192&&!/\s|[\u0000-\u001f\u007f]/.test(token);
}

function validateSelection(state:ReturnType<StateStore['read']>,siteIds:string[]):string {
  if(siteIds.length!==1||new Set(siteIds).size!==1)throw new HackMdManagementError('site_missing',M.management.oneSite);
  if(!state.sites.some(site=>site.id===siteIds[0]))throw new HackMdManagementError('site_missing',M.management.siteMissing);
  return siteIds[0];
}

/** Verify /me with GET, then atomically save the token and one-site binding. */
export async function connectHackMd(store:StateStore,vault:AtomicVault,input:HackMdSelection,deps:HackMdManagementDependencies={}):Promise<Account>{
  const before=store.read(),siteId=validateSelection(before,input.siteIds),requested=input.accountId
    ?before.accounts.find(item=>item.id===input.accountId&&item.channelId==='hackmd'):undefined;
  if(input.accountId&&!requested)throw new HackMdManagementError('connection_missing',M.management.connectionMissing);
  if(!validToken(input.token))throw new HackMdManagementError('invalid_token',M.management.tokenInvalid);
  const signal=deps.signal??new AbortController().signal;
  try{
    const response=await connectedRequest('https://api.hackmd.io/v1/me',
      {method:'GET',headers:{accept:'application/json',authorization:`Bearer ${input.token}`}},deps,signal);
    if(response.status!==200)throw new HackMdManagementError('connection_failed',M.management.identityFailed);
    const me=parseConnectedJson(response),remoteId=me?.id,name=me?.name,userPath=me?.userPath;
    if(typeof remoteId!=='string'||! /^[A-Za-z0-9_-]{6,128}$/.test(remoteId)
      ||typeof name!=='string'||!name.trim()||typeof userPath!=='string'||userPath.length>200)throw new HackMdManagementError('connection_failed',M.management.identityInvalid);
    const latest=store.read();validateSelection(latest,input.siteIds);
    const old=requested??latest.accounts.find(item=>item.channelId==='hackmd'&&item.username===remoteId);
    if(requested&&requested.username!==remoteId)throw new HackMdManagementError('identity_mismatch',M.management.identityMismatch);
    if(latest.accounts.some(item=>item.channelId==='hackmd'&&item.username===remoteId&&item.id!==old?.id))throw new HackMdManagementError('identity_mismatch',M.management.identityDuplicate);
    if(old&&latest.tasks.some(task=>task.accountId===old.id&&task.channelId==='hackmd'&&!!(task.batch5||task.submittedAt||task.publicUrl))
      &&latest.accountBindings.some(binding=>binding.accountId===old.id&&binding.siteId!==siteId))throw new HackMdManagementError('identity_mismatch',M.management.siteMismatch);
    const id=old?.id??randomUUID(),now=(deps.now?.()??new Date()).toISOString();
    const account:Account={...old,id,channelId:'hackmd',email:'',username:remoteId,displayName:name.trim(),publicationUrl:'https://hackmd.io/',
      credentialKind:'api_token',hasPassword:true,status:'registered',source:'imported',createdAt:old?.createdAt??now,updatedAt:now,verifiedAt:now,diagnostic:undefined};
    const key=`account:${id}`,ciphers=vault.encryptSecrets({[key]:input.token});
    if(typeof ciphers[key]!=='string'||!ciphers[key])throw new HackMdManagementError('encryption_failed',M.management.encryptionFailed);
    if(signal.aborted)throw new HackMdManagementError('connection_failed',M.management.cancelled);
    store.updateWithCiphers(state=>{
      validateSelection(state,input.siteIds);
      const current=state.accounts.find(item=>item.id===id);
      if(old&&(!current||current.channelId!=='hackmd'||current.username!==remoteId))throw new HackMdManagementError('state_changed',M.management.stateChanged);
      if(!old&&current)throw new HackMdManagementError('state_changed',M.management.stateChanged);
      if(state.accounts.some(item=>item.id!==id&&item.channelId==='hackmd'&&item.username===remoteId))throw new HackMdManagementError('state_changed',M.management.identityOccupied);
      state.accounts=state.accounts.filter(item=>item.id!==id);state.accounts.push(account);
      const channel=CHANNELS.find(item=>item.id==='hackmd');
      if(!channel)throw new HackMdManagementError('channel_unavailable',M.management.channelUnavailable);
      for(const binding of [...state.accountBindings])if(binding.accountId===id&&binding.channelId==='hackmd'&&binding.siteId!==siteId)unbindAccount(state,id,binding.siteId,'hackmd');
      bindAccount(state,id,siteId,channel);
    },ciphers);
    return account;
  }catch(error){
    if(error instanceof HackMdManagementError||error instanceof AccountBindingError)throw error;
    throw new HackMdManagementError('connection_failed',M.management.connectionFailed,{cause:error});
  }
}
