import type {Site,Task} from './types';

/** One Blogger blog is one public destination, even when Google OAuth owns several blogs. */
export function bloggerBlogOwner(state:{sites:Site[];tasks:Task[]},siteId:string,blogId:string):Site|string|undefined{
  const bound=state.sites.find(site=>site.id!==siteId&&site.blogger?.blogId===blogId);
  if(bound)return bound;
  // Earlier releases let several sites share a blog. A site with its own posts there keeps it;
  // only a site with no history on the blog is kept off another site's posts.
  const used=(id:string)=>state.tasks.some(task=>task.siteId===id&&task.channelId==='blogger'&&task.blogger?.blogId===blogId);
  if(used(siteId))return;
  const other=state.tasks.find(task=>task.siteId!==siteId&&task.channelId==='blogger'&&task.blogger?.blogId===blogId);
  return other?state.sites.find(site=>site.id===other.siteId)??other.siteId:undefined;
}
export function bloggerBlogIdConflict(state:{sites:Site[];tasks:Task[]},siteId:string,blogId:string):boolean{
  return bloggerBlogOwner(state,siteId,blogId)!==undefined;
}
