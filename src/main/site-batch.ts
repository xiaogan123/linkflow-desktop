import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {SITE_ACTION_MESSAGES} from '../shared/site-action-messages';
import {mailboxAutomationReady} from '../shared/mail-automation';
import {importSpreadDays,schedulingDay} from '../shared/scheduling';
import type {AddSitesBatchResult,Site} from '../shared/types';
import {ensureWritingProfile} from '../shared/writing-profile';
import type {Store} from './store';
import {AddSitesBatch,normalizeDomain} from './validation';

export const SITE_IMPORT_BATCH_SIZE=100;
const addressInput=z.string().trim().min(3).max(2048);
const yieldToEventLoop=()=>new Promise<void>(resolve=>setImmediate(resolve));
const invalidMailboxMessage='所选收信邮箱不存在或尚未测试可用，请重新选择。';
class InvalidMailboxError extends Error {}

interface BatchOptions {
  now?:Date;
  analyze?:(id:string)=>void;
  yieldToUi?:()=>Promise<void>;
}

/** Every accepted row commits independently; analysis uses the existing bounded queue. */
export async function addSitesBatch(store:Store,payload:unknown,options:BatchOptions={}):Promise<AddSitesBatchResult>{
  const input=AddSitesBatch.parse(payload),now=options.now??new Date(),stamp=now.toISOString();
  const requireReadyMailbox=(state:ReturnType<Store['read']>)=>{
    if(input.mailboxId&&!mailboxAutomationReady(state.mailboxes.find(mailbox=>mailbox.id===input.mailboxId)))throw new InvalidMailboxError(invalidMailboxMessage);
  };
  requireReadyMailbox(store.read());
  const result:AddSitesBatchResult={added:0,duplicates:0,errors:[],siteIds:[],rolloutDays:0};
  const yieldToUi=options.yieldToUi??yieldToEventLoop;
  const seen=new Set(store.read().sites.map(site=>site.domain));
  await yieldToUi();
  importRows:for(let offset=0;offset<input.domains.length;offset+=SITE_IMPORT_BATCH_SIZE){
    const rows=input.domains.slice(offset,offset+SITE_IMPORT_BATCH_SIZE);
    for(let row=0;row<rows.length;row++){
      const raw=rows[row],index=offset+row;
      let address:ReturnType<typeof normalizeDomain>;
      try{address=normalizeDomain(addressInput.parse(raw))}
      catch{result.errors.push({index,input:raw.slice(0,2048),code:'invalid_domain',message:SITE_ACTION_MESSAGES.invalidDomain});continue}
      if(seen.has(address.domain)){result.duplicates++;continue}
      const preset=input.siteType==='finance-zh';
      const site:Site={id:randomUUID(),...address,email:input.contactEmail,publicEmail:input.contactEmail,
        name:address.domain,description:'',category:preset?'finance':'general',language:preset?'zh-CN':'en',
        monthlyTarget:input.monthlyTarget,articleReviewMode:input.articleReviewMode,status:preset?'ready':'analyzing',createdAt:stamp,
        // The preset fixes category and language; the domain as name is only a placeholder a later analysis may replace.
        ...(preset?{analyzedAt:stamp,heuristicFields:['name']}:{})};
      let saved=false;
      try{
        store.update(state=>{
          requireReadyMailbox(state);
          // A second importer may have committed while this one yielded.
          if(state.sites.some(existing=>existing.domain===site.domain))return;
          if(input.mailboxId)site.mailboxId=input.mailboxId;
          if(preset)site.writingProfile=ensureWritingProfile(site,state.sites);
          state.sites.push(site);saved=true;
        });
        seen.add(site.domain);
        if(saved){result.added++;result.siteIds.push(site.id)}else result.duplicates++;
      }catch(error){
        if(error instanceof InvalidMailboxError){
          // Earlier rows are already committed; return them so their analyses still start.
          for(let remaining=index;remaining<input.domains.length;remaining++)result.errors.push({index:remaining,input:input.domains[remaining].slice(0,2048),code:'save_failed',message:invalidMailboxMessage});
          break importRows;
        }
        result.errors.push({index,input:raw.slice(0,2048),code:'save_failed',message:SITE_ACTION_MESSAGES.saveFailed});
      }
      if((index+1)%10===0)await yieldToUi();
    }
    await yieldToUi();
  }
  if(result.added){
    const state=store.read(),day=schedulingDay(now,state.settings.timezone),imported=new Set(result.siteIds);
    const sameDayCount=state.sites.filter(site=>!site.archivedAt&&(site.status==='ready'||imported.has(site.id))&&schedulingDay(site.createdAt,state.settings.timezone)===day).length;
    result.rolloutDays=importSpreadDays(sameDayCount);
  }
  if(input.siteType==='auto'&&options.analyze){
    for(let index=0;index<result.siteIds.length;index++){
      options.analyze(result.siteIds[index]);
      if((index+1)%10===0)await yieldToUi();
    }
  }
  return result;
}
