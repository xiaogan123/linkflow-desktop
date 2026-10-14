import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import {marked} from 'marked';

export const SHIPPAGE_MAX_HTML_BYTES=500*1024;
const LANGUAGE=/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SECRET_QUERY=/^(?:token|api[_-]?key|password|secret|access_token)$/i;
const PUBLIC_HOST=/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ALLOWED_ELEMENTS=new Set(['a','blockquote','br','code','del','em','h1','h2','h3','h4','h5','h6','hr','li','ol','p','pre','strong','table','tbody','td','th','thead','tr','ul']);
export interface ShipPageArticleInput {draft:{title:string;description:string;body:string};targetUrl:string;language:string;allowLinkFragments?:boolean}
export interface RenderedShipPageArticle {html:string;targetUrl:string;sourceHash:string}
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
function validText(value:unknown,empty=false):value is string{return typeof value==='string'&&(empty||!!value.trim())&&!CONTROL.test(value)&&Buffer.from(value,'utf8').toString('utf8')===value}
function text(value:string){return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
function attr(value:string){return text(value).replaceAll('"','&quot;').replaceAll("'",'&#39;')}
function exactHttps(value:unknown,allowFragment=false){
  if(typeof value!=='string'||value!==value.trim()||value.length>2048||CONTROL.test(value))return;
  try{const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/u,'');if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!PUBLIC_HOST.test(host)||/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host)||!allowFragment&&!!url.hash||[...url.searchParams.keys()].some(key=>SECRET_QUERY.test(key)))return;url.hostname=host;if(url.port==='443')url.port='';return url.href===value?value:undefined}catch{return}
}
function safeMarkdown(body:string,targetUrl:string,allowFragments:boolean){
  const tokens=marked.lexer(body,{gfm:true});marked.walkTokens(tokens,token=>{if(token.type==='html'||token.type==='image')throw Error('ShipPage Markdown 包含不允许的 HTML 或图片');if(token.type==='list_item'&&token.task)throw Error('ShipPage Markdown 任务控件不允许发布');if(token.type==='link'&&!exactHttps(token.href,allowFragments))throw Error('ShipPage Markdown 链接必须是规范公开 HTTPS 地址')});
  const $=load(marked.parser(tokens,{gfm:true}),undefined,false);let targetCount=0;
  $('*').each((_i,element)=>{
    if(!('tagName' in element))throw Error('ShipPage Markdown 生成了无效节点');const name=element.tagName.toLowerCase(),node=$(element),attributes=node.attr()??{},names=Object.keys(attributes),reset=()=>{for(const key of names)node.removeAttr(key)};
    if(!ALLOWED_ELEMENTS.has(name))throw Error('ShipPage Markdown 生成了不允许的元素');
    if(name==='a'){const href=node.attr('href'),title=node.attr('title');if(names.some(key=>!['href','title'].includes(key))||!href||!exactHttps(href,allowFragments)||title!==undefined&&(!validText(title,true)||title.length>512))throw Error('ShipPage Markdown 链接无效');reset();node.attr('href',href);if(title!==undefined)node.attr('title',title);if(href===targetUrl)targetCount++;return}
    if(name==='ol'&&names.length){const start=node.attr('start');if(names.some(key=>key!=='start')||!start||!/^-?(?:0|[1-9]\d{0,8})$/u.test(start)||!Number.isSafeInteger(Number(start)))throw Error('ShipPage 有序列表起始值无效');reset();node.attr('start',start);return}
    if(name==='code'&&names.length){const klass=node.attr('class');if(names.some(key=>key!=='class')||!klass||!/^language-[a-z0-9_+.#-]{1,64}$/iu.test(klass))throw Error('ShipPage 代码语言标识无效');reset();node.attr('class',klass);return}
    if((name==='th'||name==='td')&&names.length){const align=node.attr('align');if(names.some(key=>key!=='align')||!align||!['left','center','right'].includes(align))throw Error('ShipPage 表格对齐值无效');reset();node.attr('align',align);return}
    if(names.length)throw Error('ShipPage Markdown 生成了不允许的属性');
  });
  if(targetCount!==1)throw Error('ShipPage 稿件必须且只能包含一个精确审核目标链接');return $.html();
}
export function renderShipPageArticle(input:ShipPageArticleInput):RenderedShipPageArticle{
  if(!LANGUAGE.test(input.language)||!validText(input.draft.title)||!validText(input.draft.description,true)||!validText(input.draft.body))throw Error('ShipPage 原稿或语言无效');
  const targetUrl=exactHttps(input.targetUrl);if(!targetUrl)throw Error('ShipPage 审核目标必须是规范公开 HTTPS 地址');
  const article=safeMarkdown(input.draft.body,targetUrl,input.allowLinkFragments===true),html='<!doctype html>\n'+`<html lang="${attr(input.language.toLowerCase())}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(input.draft.title)}</title><meta name="description" content="${attr(input.draft.description)}"></head><body><main><article><header><h1>${text(input.draft.title)}</h1><p>${text(input.draft.description)}</p></header><section>${article}</section></article></main></body></html>`;
  if(Buffer.byteLength(html,'utf8')>=SHIPPAGE_MAX_HTML_BYTES)throw Error('ShipPage HTML 达到或超过 500 KiB 限制');
  if(/<meta\b[^>]*\bname\s*=\s*['"]?generator['"]?/i.test(html))throw Error('ShipPage 原稿不得声明平台 generator');
  return Object.freeze({html,targetUrl,sourceHash:sha256(html)});
}
