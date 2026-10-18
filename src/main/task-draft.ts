import type {Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {State} from './store';
import {hasExternalAttempt} from './task-recovery';
import {createBerrryInput} from '../integrations/berrry-publisher';
import {createSynthfolkPlannedInput,validSynthfolkAccount} from '../integrations/synthfolk-publisher';

export function saveTaskDraft(state:State,id:string,draft:NonNullable<Task['draft']>,now:Date=new Date()){
  const task=state.tasks.find(item=>item.id===id);if(!task)throw Error('任务不存在');
  if(task.status==='running'||hasExternalAttempt(task))throw Error('正在执行或已有远程发布记录的材料不能修改');
  const site=state.sites.find(item=>item.id===task.siteId),stamp=now.toISOString();
  const berrryInput=task.channelId==='berrry'&&site?createBerrryInput({...task,draft},site):undefined;if(task.channelId==='berrry'&&!berrryInput)throw Error('Berrry 稿件必须是含唯一精确目标链接、Remix 链接和本地交互的完整自包含 HTML');
  const queue=!!site&&getArticleReviewMode(site,state.settings)==='ai'&&task.checkpoint==='article_review'&&!task.firstLiveAt&&task.status!=='skipped',draftRevision=(task.draftRevision??0)+1,account=task.channelId==='synthfolk'?state.accounts.find(value=>value.id===(task.accountId??task.synthfolkInput?.accountId))??state.accounts.find(value=>value.channelId==='synthfolk'):undefined,accountId=task.synthfolkInput?.accountId??account?.id,synthfolkInput=task.channelId==='synthfolk'&&site&&accountId?createSynthfolkPlannedInput({...task,draft,draftRevision},site,accountId,validSynthfolkAccount(account)?account:undefined):undefined;
  if(task.channelId==='synthfolk'&&!synthfolkInput)throw Error('Synthfolk 编辑稿必须保留原固定身份并形成完整公开资料；请重新生成资料稿');
  Object.assign(task,{draft,...(berrryInput?{berrryInput}:{}),articleApprovedAt:undefined,articleReview:undefined,...(task.channelId==='agentriot'?{agentriotInput:undefined}:{}),...(task.channelId==='agenthow'?{agentHowInput:undefined}:{}),...(task.channelId==='agentswiki'?{agentsWikiInput:undefined}:{}),...(task.channelId==='swarmmemo'?{swarmMemoInput:undefined}:{}),...(task.channelId==='agentboard'?{agentboardInput:undefined}:{}),...(task.channelId==='carcinus'?{carcinusInput:undefined}:{}),...(task.channelId==='synthfolk'?{synthfolkInput}:{}),draftRevision,draftUpdatedAt:stamp,updatedAt:stamp});
  if(queue)Object.assign(task,{status:'queued',scheduledAt:stamp,message:'稿件已保存，等待新的独立 AI 审核'});
  return queue;
}
