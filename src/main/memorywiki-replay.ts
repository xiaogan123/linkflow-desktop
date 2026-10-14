import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {load} from 'cheerio';
import type {MemoryWikiResourceReplay} from '../integrations/memorywiki';
import {MEMORYWIKI_STYLE_SNAPSHOT} from './memorywiki-style-snapshot';

type PreparedReplay={html:string;allowedResourceUrls:Set<string>;resources:Omit<MemoryWikiResourceReplay,'appliedStyleSheets'>};
const MAX_HTML_BYTES=1_500_000;
const EMPTY_SCRIPT='data:application/javascript;base64,';
const EMPTY_IMAGE='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==';
const EMPTY_MANIFEST='data:application/manifest+json;base64,e30=';
const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sameInventory=(actual:string[],expected:readonly string[])=>{const left=[...actual].sort(),right=[...expected].sort();return left.length===right.length&&left.every((value,index)=>value===right[index])};

function absoluteHash(value:string|undefined,pageUrl:string){
  if(!value)throw Error('Memory.wiki 原生资源缺少 URL');
  const url=new URL(value,pageUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)throw Error('Memory.wiki 原生资源 URL 无效');
  return sha256(url.href);
}

function pinnedStyles(){
  return MEMORYWIKI_STYLE_SNAPSHOT.styles.map(value=>{
    const bytes=gunzipSync(Buffer.from(value.cssGzipBase64,'base64'));
    if(bytes.length!==value.cssBytes||sha256(bytes)!==value.cssSha256)throw Error('Memory.wiki 固定样式校验失败');
    const css=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(/@import\b/i.test(css))throw Error('Memory.wiki 固定样式包含外部导入');
    for(const match of css.matchAll(/url\(([^)]+)\)/gi)){
      const resource=match[1].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/,(_whole,doubleQuoted,singleQuoted)=>doubleQuoted??singleQuoted);
      if(!/^\/_next\/static\/media\/[A-Za-z0-9._-]+\.(?:ttf|woff2?)$/.test(resource))throw Error('Memory.wiki 固定样式包含未固定资源');
    }
    return {...value,css};
  });
}

export function prepareMemoryWikiReplay(html:string,pageUrl:string):PreparedReplay{
  if(Buffer.byteLength(html)>MAX_HTML_BYTES)throw Error('Memory.wiki 原生正文超过回放上限');
  const $=load(html),styles=pinnedStyles(),styleByHref=new Map<string,(typeof styles)[number]>(styles.map(value=>[value.hrefSha256,value]));
  if($('base').length||$('meta[http-equiv]').toArray().some(element=>($(element).attr('http-equiv')??'').trim().toLowerCase()==='refresh'))throw Error('Memory.wiki 原生正文包含主动导航');
  if($('style').toArray().some(element=>/@import\b|url\s*\(/i.test($(element).html()??''))||$('[style]').toArray().some(element=>/url\s*\(/i.test($(element).attr('style')??'')))throw Error('Memory.wiki 原生正文包含未固定样式资源');
  if($('iframe,frame,object,embed,source,track,video,audio').length||$('[srcset],[background],svg image[href],svg use[href]').length)throw Error('Memory.wiki 原生正文包含未固定加载元素');
  if($('*').toArray().some(element=>'attribs' in element&&Object.keys(element.attribs).some(name=>/^on/i.test(name))))throw Error('Memory.wiki 原生正文包含事件处理器');

  const styleElements=$('link[rel~="stylesheet"][href]').toArray();
  const scriptElements=$('script[src]').toArray();
  const imageElements=$('img[src]').toArray();
  const inertLinkElements=$('link[href]').toArray().filter(element=>{const rel=($(element).attr('rel')??'').trim().toLowerCase().split(/\s+/);return rel.includes('preload')||rel.includes('icon')||rel.includes('apple-touch-icon')||rel.includes('manifest')});
  const harmlessLinkElements=$('link[href]').toArray().filter(element=>!styleElements.includes(element)&&!inertLinkElements.includes(element));
  if(harmlessLinkElements.some(element=>{const rel=($(element).attr('rel')??'').trim().toLowerCase().split(/\s+/);return !rel.length||rel.some(value=>!['alternate','author','canonical'].includes(value))}))throw Error('Memory.wiki 原生正文包含未知 link 资源');

  const shellResourceCount=styleElements.length+scriptElements.length+imageElements.length+inertLinkElements.length;
  const mode:MemoryWikiResourceReplay['mode']=shellResourceCount?'pinned_shell':'minimal';
  if(mode==='pinned_shell'){
    if(styleElements.some(element=>($(element).attr('rel')??'').trim().toLowerCase()!=='stylesheet'||$(element).attr('media')!==undefined||$(element).attr('disabled')!==undefined||$(element).attr('data-precedence')!=='next'))throw Error('Memory.wiki 固定样式属性已改变');
    if(!sameInventory(styleElements.map(element=>absoluteHash($(element).attr('href'),pageUrl)),styles.map(value=>value.hrefSha256))||
      !sameInventory(scriptElements.map(element=>absoluteHash($(element).attr('src'),pageUrl)),MEMORYWIKI_STYLE_SNAPSHOT.scriptSrcSha256)||
      !sameInventory(imageElements.map(element=>absoluteHash($(element).attr('src'),pageUrl)),MEMORYWIKI_STYLE_SNAPSHOT.imageSrcSha256)||
      !sameInventory(inertLinkElements.map(element=>absoluteHash($(element).attr('href'),pageUrl)),MEMORYWIKI_STYLE_SNAPSHOT.inertLinkHrefSha256))throw Error('Memory.wiki 原生正文资源清单与固定公开模板不一致');
  }

  const allowedResourceUrls=new Set<string>();
  for(const element of styleElements){
    if($(element).attr('integrity'))throw Error('Memory.wiki 固定样式不能改写完整性属性');
    const fixed=styleByHref.get(absoluteHash($(element).attr('href'),pageUrl));if(!fixed)throw Error('Memory.wiki 固定样式缺失');
    const dataUrl=`data:text/css;charset=utf-8;base64,${Buffer.from(fixed.css).toString('base64')}`;
    $(element).attr('href',dataUrl).attr('data-memorywiki-style-sha256',fixed.cssSha256);allowedResourceUrls.add(dataUrl);
  }
  const inlineScriptCount=$('script:not([src])').length;
  for(const element of $('script').toArray()){
    if($(element).attr('integrity'))throw Error('Memory.wiki 固定脚本不能改写完整性属性');
    const originalType=$(element).attr('type');if(originalType)$(element).attr('data-memorywiki-original-type',originalType);
    $(element).attr('type','application/x-memorywiki-inert');
    if($(element).attr('src')){$(element).attr('src',EMPTY_SCRIPT).attr('data-memorywiki-inert','script');allowedResourceUrls.add(EMPTY_SCRIPT)}
  }
  for(const element of imageElements){$(element).attr('src',EMPTY_IMAGE).attr('data-memorywiki-inert','image');allowedResourceUrls.add(EMPTY_IMAGE)}
  for(const element of inertLinkElements){
    if($(element).attr('integrity'))throw Error('Memory.wiki 固定 link 不能改写完整性属性');
    const rel=($(element).attr('rel')??'').trim().toLowerCase().split(/\s+/),dataUrl=rel.includes('manifest')?EMPTY_MANIFEST:rel.includes('icon')||rel.includes('apple-touch-icon')?EMPTY_IMAGE:EMPTY_SCRIPT;
    $(element).attr('href',dataUrl).attr('data-memorywiki-inert','link');allowedResourceUrls.add(dataUrl);
  }
  const base=$('<base>');base.attr('href',pageUrl);$('head').prepend(base);
  return {html:$.html(),allowedResourceUrls,resources:{mode,styleSheets:styleElements.length,styleBytes:mode==='pinned_shell'?styles.reduce((sum,value)=>sum+value.cssBytes,0):0,styleSha256:mode==='pinned_shell'?styles.map(value=>value.cssSha256):[],inertScripts:scriptElements.length,inertInlineScripts:inlineScriptCount,inertImages:imageElements.length,inertLinks:inertLinkElements.length}};
}

export const memoryWikiReplayTesting={snapshot:MEMORYWIKI_STYLE_SNAPSHOT};
