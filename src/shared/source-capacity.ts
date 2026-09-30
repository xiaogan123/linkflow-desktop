import type {Channel,Task} from './types';

export function unusedSources(siteId:string,tasks:Task[],channels:Channel[]):{total:number;automatic:number;manual:number}{
  const domainKey=(value:string)=>value.trim().toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
  const used=new Set(tasks.filter(task=>task.siteId===siteId).map(task=>domainKey(task.sourceDomain)));
  const remaining=new Map<string,boolean>();
  for(const channel of channels){
    const domain=domainKey(channel.domain);
    if(!channel.enabled||channel.free==='paid'||channel.free==='unknown'||used.has(domain))continue;
    remaining.set(domain,(remaining.get(domain)??false)||channel.automation!=='manual');
  }
  const automatic=[...remaining.values()].filter(Boolean).length;
  return {total:remaining.size,automatic,manual:remaining.size-automatic};
}
