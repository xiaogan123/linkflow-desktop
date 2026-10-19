import {randomUUID} from 'node:crypto';
import {load} from 'cheerio';
import {inspectRenderedArticle} from '../integrations/article-rendering';

export interface Batch5RenderedLink {found:boolean;indexable:boolean;rel:string}

const ALLOWED_HOSTS:Record<string,ReadonlySet<string>>={
  whitewind:new Set(['whtwnd.com','public.api.bsky.app','cdn.bsky.app','bsky.social']),
  hackmd:new Set(['hackmd.io','assets.hackmd.io','api.hackmd.io']),
};

const BODY_SELECTORS={
  hackmd:['.ui-view-area #doc.markdown-body'],
  whitewind:['article .prose','main .prose','.prose','main article'],
} as const;

export function batch5RenderedBodySelectors(channel:'whitewind'|'hackmd'):readonly string[]{return BODY_SELECTORS[channel]}

/** Mirrors the renderer's first-unique-visible-selector rule for fixture tests. */
export function selectBatch5RenderedBody<T>(channel:'whitewind'|'hackmd',query:(selector:string)=>readonly T[],visible:(value:T)=>boolean):T|undefined{
  for(const selector of BODY_SELECTORS[channel]){
    const matches=query(selector).filter(visible);
    if(matches.length>1)return;
    if(matches.length===1)return matches[0];
  }
}

export function batch5PublicChannel(value:string):'whitewind'|'hackmd'|undefined {
  try{const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return;
    if(url.hostname==='whtwnd.com'&&/^\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\/[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(url.pathname))return 'whitewind';
    if(url.hostname==='hackmd.io'&&/^\/[A-Za-z0-9_-]{6,128}$/.test(url.pathname))return 'hackmd';
  }catch{/* Invalid URL. */}
}

export function batch5NoIndex(...directives:string[]):boolean {
  return directives.some(value=>/(?:^|[,\s:])(?:noindex|none)(?:$|[,;\s])/i.test(value));
}

export interface Batch5RenderedBody {url:string;bodyHtml:string;headHtml:string;robots:string[];refresh:boolean}

/** This exact source is executed in Electron and in the DOM fixture test. */
export function batch5ExtractionSource(channel:'whitewind'|'hackmd'):string{return `(()=>{
      const visible=element=>{if(!(element instanceof HTMLElement))return false;for(let current=element;current instanceof HTMLElement;current=current.parentElement){const style=getComputedStyle(current);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)<=0||style.contentVisibility==='hidden'||current.hidden||current.getAttribute('aria-hidden')==='true')return false}const rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0&&getComputedStyle(element).pointerEvents!=='none'};
      const selectors=${JSON.stringify(BODY_SELECTORS)}[${JSON.stringify(channel)}];
      let body,ambiguous=false;
      for(const selector of selectors){const matches=[...document.querySelectorAll(selector)].filter(visible);if(matches.length>1){ambiguous=true;break}if(matches.length===1){body=matches[0];break}}
      let bodyHtml='';
      if(body&&!ambiguous){const clone=body.cloneNode(true);clone.setAttribute('data-batch5-article','');const original=[...body.querySelectorAll('*')],copies=[...clone.querySelectorAll('*')];for(let i=0;i<original.length;i++)if(!visible(original[i]))copies[i]?.setAttribute('hidden','');bodyHtml=clone.outerHTML;}
      const headHtml=[...document.head.querySelectorAll('meta[name],meta[http-equiv],link[rel]')].filter(item=>{const name=(item.getAttribute('name')??'').toLowerCase(),equiv=(item.getAttribute('http-equiv')??'').toLowerCase(),rel=(item.getAttribute('rel')??'').toLowerCase();return /^(robots|googlebot|bingbot)$/.test(name)||equiv==='refresh'||rel.split(/\\s+/).includes('canonical')}).map(item=>item.outerHTML).join('');
      const robots=[...document.querySelectorAll('meta[name]')].filter(item=>/^(robots|googlebot|bingbot)$/i.test(item.getAttribute('name')??'')).map(item=>item.getAttribute('content')??'');
      const refresh=[...document.querySelectorAll('meta[http-equiv]')].some(item=>(item.getAttribute('http-equiv')??'').toLowerCase()==='refresh');
      return {url:location.href,bodyHtml,headHtml,robots,refresh};
    })()`}

function sameSiteCanonicalChanged(headHtml:string,pageUrl:string):boolean{
  try{
    const $=load(`<head>${headHtml}</head>`),expected=new URL(pageUrl);
    return $('link[rel]').toArray().some(element=>{
      if(!($(element).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'))return false;
      const href=$(element).attr('href');if(!href)return false;
      const canonical=new URL(href,pageUrl);
      return canonical.origin===expected.origin&&canonical.href!==expected.href;
    });
  }catch{return false}
}

export function assertBatch5ReadablePage(page:Batch5RenderedBody|undefined,expectedUrl:string):asserts page is Batch5RenderedBody{
  if(!page||page.url!==expectedUrl||!page.bodyHtml||sameSiteCanonicalChanged(page.headHtml,expectedUrl))
    throw Error('Batch5 公开页地址或正文尚不可读');
}

/** The renderer supplies exactly one visible article body, never links from page chrome. */
export function inspectBatch5RenderedBody(page:Batch5RenderedBody,targetUrl:string,title:string,markdown:string,robotsHeader=''):Batch5RenderedLink {
  const html=`<html><head>${page.headHtml}</head><body>${page.bodyHtml}</body></html>`;
  const checked=inspectRenderedArticle(html,markdown,targetUrl,'[data-batch5-article]',{pageUrl:page.url,title,robotsHeader,hackmdCompatibility:batch5PublicChannel(page.url)==='hackmd'});
  const indexable=!batch5NoIndex(robotsHeader,...page.robots)&&!page.refresh;
  return {found:checked.found&&indexable,indexable,rel:checked.found?checked.rel:''};
}

/** Runs public pages in a fresh, credential-free partition. Only GETs to fixed provider hosts are allowed. */
export async function renderBatch5PublicPage(url:string,targetUrl:string,title:string,markdown:string,signal:AbortSignal):Promise<Batch5RenderedLink>{
  const channel=batch5PublicChannel(url);
  if(!channel)throw Error('Batch5 公开页地址无效');
  const target=new URL(targetUrl);
  if(target.protocol!=='https:'||target.username||target.password||target.hash||!title.trim()||!markdown.trim())throw Error('Batch5 目标或稿件无效');
  if(signal.aborted)throw Error('Batch5 渲染已取消');
  const {BrowserWindow}=await import('electron');
  const partition=`batch5-public-${randomUUID()}`;
  const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,
    webSecurity:true,javascript:true,allowRunningInsecureContent:false,backgroundThrottling:false}});
  const ses=win.webContents.session;
  let robotsHeader='',mainStatus=0,mainType='',mainSeen=false,violation='',abortPending:((reason:Error)=>void)|undefined;
  const stop=(reason:string)=>{violation ||= reason;abortPending?.(Error(reason));try{if(!win.isDestroyed())win.webContents.stop()}catch{}};
  const onAbort=()=>stop('Batch5 渲染已取消');
  signal.addEventListener('abort',onAbort,{once:true});
  ses.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.on('will-download',event=>event.preventDefault());
  ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    let allowed=false;
    try{const parsed=new URL(details.url);allowed=details.method==='GET'&&parsed.protocol==='https:'
      &&!parsed.username&&!parsed.password&&!parsed.port&&ALLOWED_HOSTS[channel].has(parsed.hostname)
      &&(details.resourceType!=='mainFrame'||details.url===url&&!mainSeen)}catch{/* Deny. */}
    if(details.resourceType==='mainFrame'&&allowed)mainSeen=true;
    if(!allowed&&details.resourceType==='mainFrame')stop('Batch5 页面尝试跳转或发出非 GET 主请求');
    callback({cancel:!allowed});
  });
  ses.webRequest.onBeforeSendHeaders({urls:['<all_urls>']},(details,callback)=>{
    const headers={...details.requestHeaders};
    for(const key of Object.keys(headers))if(/^(?:cookie|authorization|proxy-authorization|referer)$/i.test(key))delete headers[key];
    callback({requestHeaders:headers});
  });
  ses.webRequest.onHeadersReceived({urls:['<all_urls>']},(details,callback)=>{
    if(details.resourceType==='mainFrame'&&details.url===url){
      mainStatus=details.statusCode;
      for(const [key,values] of Object.entries(details.responseHeaders??{})){
        if(key.toLowerCase()==='x-robots-tag')robotsHeader=values?.join(',')??'';
        if(key.toLowerCase()==='content-type')mainType=values?.[0]?.split(';',1)[0]?.trim().toLowerCase()??'';
      }
      if(mainStatus!==200||mainType!=='text/html')stop('Batch5 公开页未返回可读 HTML');
    }
    callback({cancel:!!violation});
  });
  ses.webRequest.onBeforeRedirect({urls:['<all_urls>']},details=>{if(details.resourceType==='mainFrame')stop('Batch5 公开页发生重定向')});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,next)=>{if(next!==url){event.preventDefault();stop('Batch5 页面尝试导航')}});
  const withDeadline=<T>(operation:Promise<T>,milliseconds:number):Promise<T>=>new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn:(value:any)=>void,value:any)=>{if(settled)return;settled=true;clearTimeout(timer);abortPending=undefined;fn(value)};
    const timer=setTimeout(()=>finish(reject,Error('Batch5 页面渲染超时')),milliseconds);
    abortPending=error=>finish(reject,error);
    operation.then(value=>finish(resolve,value),error=>finish(reject,error));
  });
  try{
    await withDeadline(ses.clearStorageData(),3000);
    await withDeadline(win.loadURL(url,{httpReferrer:''}),15000);
    if(violation||!mainSeen||mainStatus!==200||mainType!=='text/html')throw Error(violation||'Batch5 公开页响应无效');
    const source=batch5ExtractionSource(channel);
    let result:Batch5RenderedBody|undefined,checked:Batch5RenderedLink|undefined;
    for(let attempt=0;attempt<60;attempt++){
      if(signal.aborted||violation)throw Error(violation||'Batch5 渲染已取消');
      result=await withDeadline(win.webContents.executeJavaScriptInIsolatedWorld(999,[{code:source}]) as Promise<typeof result>,3000);
      if(result?.url===url&&result.bodyHtml.length<=2_000_000){checked=inspectBatch5RenderedBody(result,targetUrl,title,markdown,robotsHeader);if(checked.found)break}
      await withDeadline(new Promise<void>(resolve=>{setTimeout(resolve,100)}),1000);
    }
    assertBatch5ReadablePage(result,url);
    if(result.refresh)throw Error('Batch5 公开页含自动跳转，无法确认是原页面或公开可见');
    if(result.bodyHtml.length>2_000_000)throw Error('Batch5 正文超出检查上限');
    return checked??inspectBatch5RenderedBody(result,targetUrl,title,markdown,robotsHeader);
  }finally{
    signal.removeEventListener('abort',onAbort);
    try{if(!win.isDestroyed())win.webContents.stop()}catch{/* Closed. */}
    if(!win.isDestroyed())win.destroy();
    await Promise.race([ses.clearStorageData().catch(()=>undefined),new Promise<void>(resolve=>{setTimeout(resolve,2000)})]);
  }
}
