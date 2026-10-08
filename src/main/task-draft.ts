import type {Task} from '../shared/types';
import {getArticleReviewMode} from '../shared/article-review-mode';
import type {State} from './store';
import {hasExternalAttempt} from './task-recovery';

export function saveTaskDraft(state:State,id:string,draft:NonNullable<Task['draft']>,now:Date=new Date()){
  const task=state.tasks.find(item=>item.id===id);if(!task)throw Error('任务不存在');
  if(task.status==='running'||hasExternalAttempt(task))throw Error('正在执行或已有远程发布记录的材料不能修改');
  const site=state.sites.find(item=>item.id===task.siteId),stamp=now.toISOString();
  const queue=!!site&&getArticleReviewMode(site,state.settings)==='ai'&&task.checkpoint==='article_review'&&!task.firstLiveAt&&task.status!=='skipped';
  Object.assign(task,{draft,articleApprovedAt:undefined,articleReview:undefined,draftRevision:(task.draftRevision??0)+1,draftUpdatedAt:stamp,updatedAt:stamp});
  if(queue)Object.assign(task,{status:'queued',scheduledAt:stamp,message:'稿件已保存，等待新的独立 AI 审核'});
  return queue;
}
