import {createHash} from 'node:crypto';
import type {ExecutionContext,Site, Task} from '../shared/types';

export function publicationDraftHash(draft: NonNullable<Task['draft']>): string {
  return createHash('sha256').update(JSON.stringify({title:draft.title,description:draft.description,body:draft.body})).digest('hex');
}

/** Called within the same transaction that saves the first outbound intent. */
export function capturePublicationSnapshots(previous: {tasks:Task[]}, next: {tasks:Task[];sites:Site[]}): void {
  const before = new Map(previous.tasks.map(task => [task.id, task]));
  const sites = new Map(next.sites.map(site => [site.id, site]));
  for (const task of next.tasks) {
    if (!task.submittedAt) { delete task.publicationSnapshot; continue; }
    const prior = before.get(task.id);
    if (!prior || prior.submittedAt || !task.submittedAt || !task.draft) continue;
    const site = sites.get(task.siteId);
    if (!site) continue;
    task.publicationSnapshot = {
      version:1, capturedAt:task.submittedAt, source:'submitted_draft',
      siteUrl:site.url, targetUrl:task.topicUrl ?? site.url, siteName:site.name, language:site.language,
      draft:structuredClone(task.draft), contentHash:publicationDraftHash(task.draft),
    };
  }
}

export function publicationSite(task:Task,site?:Pick<Site,'name'|'domain'|'url'>):Pick<Site,'name'|'domain'|'url'>|undefined{
  const snapshot=task.submittedAt?task.publicationSnapshot:undefined;
  if(!snapshot)return site;
  return {name:snapshot.siteName,url:snapshot.siteUrl,domain:new URL(snapshot.siteUrl).hostname};
}

/** Read-only recovery rebuilds exactly the material submitted before site edits. */
export function publicationReadSource(task:Task,site:Site):{task:Task;site:Site}{
  const snapshot=task.submittedAt?task.publicationSnapshot:undefined;
  if(!snapshot)return {task,site};
  return {
    site:{...site,name:snapshot.siteName,url:snapshot.siteUrl,domain:new URL(snapshot.siteUrl).hostname,language:snapshot.language},
    task:{...task,draft:structuredClone(snapshot.draft),topicUrl:snapshot.targetUrl},
  };
}

export function publicationReadContext(context:ExecutionContext):ExecutionContext{
  return {...context,...publicationReadSource(context.task,context.site)};
}
