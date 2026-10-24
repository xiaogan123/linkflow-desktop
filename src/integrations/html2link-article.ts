import {createHash} from 'node:crypto';
import {renderShareYourHtmlArticle,type ShareYourHtmlArticleDraft} from './shareyourhtml-article';

export const HTML2LINK_MAX_FILE_BYTES=1_000_000;
export const HTML2LINK_FILENAME='article.html';

export interface Html2LinkRenderedArticle {
  html:string;
  markdown:string;
  title:string;
  targetUrl:string;
  sourceHash:string;
  requestHash:string;
  byteLength:number;
}

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
export function html2LinkRequestHash(sourceHash:string,byteLength:number):string{return sha256([
  'POST https://html2link.dev/api/upload',
  `multipart name=file; filename=${HTML2LINK_FILENAME}; type=text/html; charset=utf-8`,
  `bytes=${byteLength}`,
  `sha256=${sourceHash}`,
].join('\n'))}

/**
 * Reuses the strict passive-document renderer already used for direct HTML
 * publication. The synthetic slug only satisfies that renderer's validation;
 * it is not sent to html2link and is not a requested remote identifier.
 */
export function renderHtml2LinkArticle(input:{draft:ShareYourHtmlArticleDraft;targetUrl:string;language:string}):Html2LinkRenderedArticle{
  const rendered=renderShareYourHtmlArticle({...input,slug:'html2link-article'});
  const byteLength=Buffer.byteLength(rendered.html,'utf8');
  if(byteLength>HTML2LINK_MAX_FILE_BYTES)throw Error('html2link HTML 超出匿名 1 MB 上限');
  const requestHash=html2LinkRequestHash(rendered.sourceHash,byteLength);
  return Object.freeze({html:rendered.html,markdown:input.draft.body,title:input.draft.title,targetUrl:rendered.targetUrl,sourceHash:rendered.sourceHash,requestHash,byteLength});
}
