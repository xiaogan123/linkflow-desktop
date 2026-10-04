import {load} from 'cheerio';
import type {Site} from '../shared/types';
import {fetchPublicHtml,normalizePublicUrl} from './web';

/** A bounded first-party material hint, never an ownership claim about external projects. */
export async function discoverTechnicalMaterial(site:Pick<Site,'url'|'domain'>,signal?:AbortSignal,fetchHtml=fetchPublicHtml):Promise<string|undefined>{
  const base=normalizePublicUrl(site.url),host=base.hostname.replace(/^www\./,'');
  const local=(input:string)=>{try{const u=normalizePublicUrl(new URL(input,base).href);return u.protocol==='https:'&&u.hostname.replace(/^www\./,'')===host&&!u.search&&!u.hash?u.href:undefined}catch{return undefined}};
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
  const read=async(url:string)=>{const page=await fetchHtml(url,bounded);if(!local(page.url))throw Error('Material redirected off site');return page};
  try{
    const home=await read(base.href),$=load(home.html),urls:string[]=[home.url];
    $('a[href]').slice(0,400).each((_i,el)=>{const href=$(el).attr('href')??'',label=$(el).text();if(!/(?:tools?|calculat|templates?|code|工具|计算|模板|代码)/i.test(href+' '+label))return;const url=local(href);if(url&&!urls.includes(url)&&urls.length<4)urls.push(url)});
    for(const url of urls){
      if(bounded.aborted)return;
      const page=url===home.url?home:await read(url),doc=load(page.html),main=doc('main,article').first();
      const content=main.length?main:doc('body');
      content.find('nav,header,footer,aside,script,style,noscript').remove();
      const text=content.text().replace(/\s+/g,' ').trim();
      const code=content.find('pre').text().trim(),numbers=content.find('input[type="number"]').length;
      const technicalCode=code.length>=100&&/(?:function\s|const\s|def\s|SELECT\s|\{[\s\S]*\}|=>)/i.test(code);
      const calculator=numbers>=2&&/(?:formula|计算公式|计算方法|公式|输入参数)/i.test(text)&&content.find('button,input[type="submit"]').length>0;
      if(text.length>=300&&(technicalCode||calculator))return page.url;
    }
  }catch{if(signal?.aborted)return;}
  return undefined;
}
