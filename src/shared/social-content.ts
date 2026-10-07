import type {Channel,Site,Task} from './types';

export function graphemeLength(value:string):number {
  return [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)].length;
}

/** Short posts are reviewed and published verbatim; never truncate or append after approval. */
export function socialDraftError(task:Pick<Task,'draft'|'topicUrl'>,site:Pick<Site,'url'>,channel:Pick<Channel,'contentFormat'>):string|undefined {
  if(channel.contentFormat!=='social')return;
  const body=task.draft?.body;
  if(!body||body!==body.trim()||graphemeLength(body)>300||new TextEncoder().encode(body).length>3000)return '短内容须为完整纯文本，最多 300 个字符且不超过 3000 字节；不会截断后发布。';
  if(/<[^>]+>|\]\(https?:\/\//i.test(body))return '短内容请使用纯文本与完整网址，不使用 HTML 或 Markdown 链接。';
  const urls=[...body.matchAll(/https?:\/\/[^\s<>]+/g)].map(match=>match[0]);
  if(urls.length!==1)return '短内容须保留一个相关正文页面链接，不能堆放多个链接。';
  try {
    const expected=new URL(task.topicUrl??site.url),actual=new URL(urls[0]);
    if(actual.protocol!=='https:'||actual.username||actual.password||actual.href!==expected.href)return '短内容链接须与本任务核对的正文页面一致。';
  }catch{return '短内容链接无效。';}
  return;
}
