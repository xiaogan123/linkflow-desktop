import type {ArticlePublicationContext,Task} from '../shared/types';

/** Only aggregate visible local tasks; this is not a claim about all remote activity. */
export function visibleArticlePublicationContext(tasks:readonly Task[],task:Pick<Task,'channelId'|'accountId'>):ArticlePublicationContext{
  let sameChannelTasks=0,sameAccountTasks=0;
  const sites=new Set<string>();
  for(const item of tasks){
    if(item.channelId===task.channelId){sameChannelTasks++;sites.add(item.siteId)}
    if(task.accountId&&item.accountId===task.accountId)sameAccountTasks++;
  }
  return {scope:'visible_workspace_only',sameChannelTasks,...(task.accountId?{sameAccountTasks}:{}),distinctSites:sites.size,publicationIntent:'unknown'};
}
