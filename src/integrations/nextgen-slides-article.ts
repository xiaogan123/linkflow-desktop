import {load} from 'cheerio';
import {renderShareYourHtmlArticle,type ShareYourHtmlArticleInput} from './shareyourhtml-article';

/** Render reviewed Markdown as a self-contained, readable slide deck without active content. */
export function renderNextgenSlidesArticle(input:Omit<ShareYourHtmlArticleInput,'slug'>){
  const safe=renderShareYourHtmlArticle({...input,slug:'nextgen-slides-publication',allowLinkFragments:true});
  const $=load(safe.html),body=$('article > section'),sections:string[]=[];let group:string[]=[];
  for(const element of body.children().toArray()){
    if(element.type==='tag'&&element.tagName==='h2'&&group.length){sections.push(group.join('\n'));group=[]}
    group.push($.html(element));
  }
  if(group.length)sections.push(group.join('\n'));
  if(sections.length<3||sections.length>30)throw Error('NextGen Slides 需要 3 至 30 页、有明确小节的讲义');
  const title=$('article > header > h1').html();if(!title)throw Error('NextGen Slides 标题无效');
  const titleSection=`<section class="slide"><h1>${title}</h1>${sections.shift()}</section>`;
  const css='*{box-sizing:border-box}html{background:#edf2f8;color:#15233b;font-family:system-ui,sans-serif}body{margin:0;padding:24px}main{max-width:1040px;margin:auto}.slide{background:white;border:1px solid #ccd6e5;border-radius:16px;padding:40px;margin-bottom:24px;min-height:420px}h1,h2{font-size:32px;line-height:1.4}p,li{font-size:20px;line-height:1.8}a{color:#175dbe;text-decoration:underline}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:680px){body{padding:10px}.slide{padding:22px;min-height:0}h1,h2{font-size:27px}p,li{font-size:18px}}@media print{body{padding:0}.slide{break-after:page;border:0;margin:0}.slide:last-child{break-after:auto}}';
  $('head style').remove();$('head').append(`<style>${css}</style>`);$('body').html(`<main>${titleSection}${sections.map(value=>`<section class="slide">${value}</section>`).join('')}</main>`);
  const html='<!doctype html>\n'+$('html').toString();if(Buffer.byteLength(html,'utf8')>120_000)throw Error('NextGen Slides 讲义超过安全大小上限');return {html,targetUrl:safe.targetUrl};
}
