import type {Channel,Task} from './types';
import {sourceKey,taskOccupiesSource} from './publication';

export function unusedSources(siteId:string,tasks:Task[],channels:Channel[]):{total:number;automatic:number;manual:number}{
  const used=new Set(tasks.filter(task=>task.siteId===siteId&&taskOccupiesSource(task)).map(task=>sourceKey(task.sourceDomain)));
  const remaining=new Map<string,boolean>();
  for(const channel of channels){
    const domain=sourceKey(channel.domain);
    if(!channel.enabled||channel.free==='paid'||channel.free==='unknown'||used.has(domain))continue;
    remaining.set(domain,(remaining.get(domain)??false)||channel.automation!=='manual');
  }
  const automatic=[...remaining.values()].filter(Boolean).length;
  return {total:remaining.size,automatic,manual:remaining.size-automatic};
}
