import type {Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {State} from './store';
import {hasExternalAttempt} from './task-recovery';
import {createBerrryInput} from '../integrations/berrry-publisher';

export function saveTaskDraft(state:State,id:string,draft:NonNullable<Task['draft']>,now:Date=new Date()){
  const task=state.tasks.find(item=>item.id===id);if(!task)throw Error('任务不存在');
  if(task.status==='running'||hasExternalAttempt(task))throw Error('正在执行或已有远程发布记录的材料不能修改');
  const site=state.sites.find(item=>item.id===task.siteId),stamp=now.toISOString();
  const berrryInput=task.channelId==='berrry'&&site?createBerrryInput({...task,draft},site):undefined;if(task.channelId==='berrry'&&!berrryInput)throw Error('Berrry 稿件必须是含唯一精确目标链接、Remix 链接和本地交互的完整自包含 HTML');
  const queue=!!site&&getArticleReviewMode(site,state.settings)==='ai'&&task.checkpoint==='article_review'&&!task.firstLiveAt&&task.status!=='skipped';
  Object.assign(task,{draft,...(berrryInput?{berrryInput}:{}),articleApprovedAt:undefined,articleReview:undefined,...(task.channelId==='agenthow'?{agentHowInput:undefined}:{}),...(task.channelId==='swarmmemo'?{swarmMemoInput:undefined}:{}),draftRevision:(task.draftRevision??0)+1,draftUpdatedAt:stamp,updatedAt:stamp});
  if(queue)Object.assign(task,{status:'queued',scheduledAt:stamp,message:'稿件已保存，等待新的独立 AI 审核'});
  return queue;
}
