import {randomUUID} from 'node:crypto';
import {BrowserWindow} from 'electron';
import {MDVIEW_MAX_HTML_BYTES,MDVIEW_ORIGIN,MDVIEW_SHORT_ID,type MDViewNativeRequest,type MDViewRenderedPage,type MDViewRenderHooks} from '../integrations/mdview';

export function exactMDViewPublicUrl(value:string):boolean{try{const url=new URL(value);return url.origin===MDVIEW_ORIGIN&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&MDVIEW_SHORT_ID.test(url.pathname.slice(3))&&url.pathname===`/s/${url.pathname.slice(3)}`}catch{return false}}

function normalizedHeaders(value:Record<string,string|string[]|number|undefined>){const headers:Record<string,string[]>={};for(const [name,raw] of Object.entries(value)){const values=Array.isArray(raw)?raw:[raw];headers[name.toLowerCase()]=values.filter(item=>item!==undefined).map(String)}return headers}
function mediaType(headers:Record<string,string[]>){const values=headers['content-type']??[];return values.length===1?values[0].split(';',1)[0].trim().toLowerCase():''}
function validDeclaredLength(headers:Record<string,string[]>){const values=headers['content-length']??[];if(values.length===0)return true;if(values.length!==1||!/^\d+$/.test(values[0]))return false;const size=Number(values[0]);return Number.isSafeInteger(size)&&size>0&&size<=MDVIEW_MAX_HTML_BYTES}

export async function renderMDViewPage(url:string,signal:AbortSignal,hooks:MDViewRenderHooks={}):Promise<MDViewRenderedPage>{
  if(!exactMDViewPublicUrl(url))throw Error('MDView 原生检查 URL 无效');
  const partition=`mdview-verifier-${randomUUID()}`,win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,javascript:false,images:false,backgroundThrottling:false}}),ses=win.webContents.session;
  const nativeRequests:MDViewNativeRequest[]=[],responseRobots:string[]=[];let initializing=true,sent=false,debuggerAttached=false,violation='',rawHeaders:Record<string,string[]>={},webHeadersSeen=false,webStatus=0,responseStatus=0,responseMediaType='',responseBodyBytes=0,responseEncodedBodyBytes=0,documentRequestId='',responseFinished=false,rejectLoad:((error:Error)=>void)|undefined;
  const fail=(message:string)=>{violation ||= message;rejectLoad?.(Error(violation));try{if(!win.isDestroyed())win.webContents.stop()}catch{}};
  const stop=()=>fail('MDView 原生检查已取消');signal.addEventListener('abort',stop,{once:true});
  const onDebuggerMessage=(_event:unknown,method:string,params:Record<string,unknown>)=>{
    if(method==='Network.responseReceived'){
      const response=params.response as {url?:string;status?:number;mimeType?:string;headers?:Record<string,string|number>}|undefined;
      if(params.type==='Document'&&response?.url===url){
        if(documentRequestId){fail('MDView 原生主文档响应不唯一');return}
        documentRequestId=String(params.requestId??'');responseStatus=Number(response.status??0);responseMediaType=String(response.mimeType??'').split(';',1)[0].trim().toLowerCase();if(!webHeadersSeen)rawHeaders=normalizedHeaders(response.headers??{});
      }
    }
    if(!documentRequestId||String(params.requestId??'')!==documentRequestId)return;
    if(method==='Network.dataReceived'){
      const decoded=Number(params.dataLength??0),encoded=Number(params.encodedDataLength??0);if(!Number.isSafeInteger(decoded)||decoded<0||!Number.isSafeInteger(encoded)||encoded<0){fail('MDView 原生正文计量无效');return}responseBodyBytes+=decoded;responseEncodedBodyBytes+=encoded;if(responseBodyBytes>MDVIEW_MAX_HTML_BYTES||responseEncodedBodyBytes>MDVIEW_MAX_HTML_BYTES)fail('MDView 原生正文超过 2 MB 上限');
    }
    if(method==='Network.loadingFailed')fail('MDView 原生正文加载失败');
    if(method==='Network.loadingFinished'){
      const encoded=Number(params.encodedDataLength??responseEncodedBodyBytes);if(!Number.isSafeInteger(encoded)||encoded<0){fail('MDView 原生正文计量无效');return}responseEncodedBodyBytes=Math.max(responseEncodedBodyBytes,encoded);responseFinished=true;if(responseEncodedBodyBytes>MDVIEW_MAX_HTML_BYTES)fail('MDView 原生正文超过 2 MB 上限');
    }
  };
  ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);ses.on('will-download',event=>event.preventDefault());
  ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    if(initializing&&details.url==='about:blank'){callback({cancel:false});return}
    const permitted=!sent&&details.url===url&&details.method==='GET'&&details.resourceType==='mainFrame';
    if(!permitted){if(details.resourceType==='mainFrame'||details.method!=='GET')fail('MDView 原生页面发起了额外请求');callback({cancel:true});return}
    const request:MDViewNativeRequest={url,method:'GET',resourceType:'mainFrame'};try{hooks.onBeforeRequest?.(request)}catch{fail('MDView 原生请求未能持久计量');callback({cancel:true});return}sent=true;nativeRequests.push(request);callback({cancel:false});
  });
  ses.webRequest.onHeadersReceived({urls:[url]},(details,callback)=>{
    if(details.resourceType!=='mainFrame'){fail('MDView 原生页面返回了额外响应');callback({cancel:true});return}
    webHeadersSeen=true;webStatus=details.statusCode;rawHeaders=normalizedHeaders(details.responseHeaders??{});const type=mediaType(rawHeaders);
    if(webStatus!==200){fail('MDView 原生页面必须返回 HTTP 200');callback({cancel:true});return}
    if(type!=='text/html'){fail('MDView 原生页面必须返回 text/html');callback({cancel:true});return}
    if(!validDeclaredLength(rawHeaders)){fail('MDView 原生正文声明长度无效或超过 2 MB 上限');callback({cancel:true});return}
    callback({cancel:false});
  });
  ses.webRequest.onBeforeRedirect({urls:['<all_urls>']},()=>fail('MDView 原生页面禁止重定向'));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,next)=>{if(!initializing&&next!==url){event.preventDefault();fail('MDView 原生页面禁止导航')}});
  try{
    if(signal.aborted)throw Error('MDView 原生检查已取消');await ses.clearStorageData();await win.loadURL('about:blank');if(signal.aborted||violation)throw Error(violation||'MDView 原生检查已取消');
    win.webContents.debugger.attach('1.3');debuggerAttached=true;win.webContents.debugger.on('message',onDebuggerMessage);await win.webContents.debugger.sendCommand('Network.enable');initializing=false;
    const loading=win.loadURL(url,{httpReferrer:''});await new Promise<void>((resolve,reject)=>{let done=false;const finish=(complete:(value?:any)=>void,value?:any)=>{if(done)return;done=true;complete(value)};rejectLoad=error=>finish(reject,error);void loading.then(()=>finish(resolve),error=>finish(reject,error))}).finally(()=>{rejectLoad=undefined});
    if(violation||signal.aborted||!sent||nativeRequests.length!==1||!documentRequestId||!responseFinished)throw Error(violation||'MDView 原生主文档未按一次请求加载');
    if(responseStatus!==200||responseMediaType!=='text/html'||mediaType(rawHeaders)!=='text/html'||webHeadersSeen&&webStatus!==responseStatus||!validDeclaredLength(rawHeaders))throw Error('MDView 原生主文档状态、媒体类型或声明长度无效');
    const body=await win.webContents.debugger.sendCommand('Network.getResponseBody',{requestId:documentRequestId}) as {body:string;base64Encoded:boolean},decoded=body.base64Encoded?Buffer.from(body.body,'base64'):Buffer.from(body.body,'utf8');responseBodyBytes=Math.max(responseBodyBytes,decoded.byteLength);if(responseBodyBytes<1||responseBodyBytes>MDVIEW_MAX_HTML_BYTES||responseEncodedBodyBytes>MDVIEW_MAX_HTML_BYTES)throw Error('MDView 原生正文为空或超过 2 MB 上限');
    for(const [name,values] of Object.entries(rawHeaders))if(name==='x-robots-tag')responseRobots.push(...values);await hooks.onResponseHeaders?.(rawHeaders);
    const evaluation=await win.webContents.debugger.sendCommand('Runtime.evaluate',{expression:`(()=>{
      const root=document.querySelector('#ssr-viewer');
      const styleVisible=element=>{for(let current=element;current instanceof Element;current=current.parentElement){const style=getComputedStyle(current),opacity=Number(style.opacity);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden'||!Number.isFinite(opacity)||opacity<=0||style.clipPath!=='none'||style.clip!=='auto'||/opacity\\(\\s*0(?:\\.0+)?\\s*\\)/i.test(style.filter))return false}return true};
      const textNodes=element=>{const nodes=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())if((node.textContent??'').trim())nodes.push(node);return nodes};
      const textVisible=node=>{const element=node.parentElement;if(!element||!styleVisible(element))return false;const style=getComputedStyle(element),range=document.createRange();range.selectNodeContents(node);return Number.parseFloat(style.fontSize)>0&&style.color!=='transparent'&&[...range.getClientRects()].some(rect=>rect.width>0&&rect.height>0)};
      const elementVisible=element=>styleVisible(element)&&element.getClientRects().length>0&&textNodes(element).every(textVisible);
      if(!(root instanceof HTMLElement))return null;
      const links=[...root.querySelectorAll('a[href]')].map(element=>({href:element.href,rel:[...element.relList],text:element.textContent??'',visible:elementVisible(element)&&getComputedStyle(element).pointerEvents!=='none'}));
      const robots=[...document.querySelectorAll('meta[name]')].map(element=>({name:(element.getAttribute('name')??'').trim().toLowerCase(),content:element.getAttribute('content')??''})).filter(value=>['robots','googlebot','bingbot'].includes(value.name));
      const canonicals=[...document.querySelectorAll('link[rel]')].filter(element=>(element.getAttribute('rel')??'').toLowerCase().split(/\\s+/).includes('canonical')).map(element=>element.href);
      return {url:location.href,title:document.title,articleText:root.innerText,articleHtml:root.outerHTML,allArticleTextVisible:textNodes(root).length>0&&textNodes(root).every(textVisible),links,robots,canonicals,hasRefresh:[...document.querySelectorAll('meta[http-equiv]')].some(element=>(element.getAttribute('http-equiv')??'').trim().toLowerCase()==='refresh'),hasPasswordGate:!!root.querySelector('input[type="password"],[data-gate="password"],.password-gate'),hasLoginGate:!!root.querySelector('form[action*="login"],[data-gate="login"],.login-gate')};
    })()`,returnByValue:true,awaitPromise:false});
    type DOMPage=Omit<MDViewRenderedPage,'responseRobots'|'responseStatus'|'responseMediaType'|'responseBodyBytes'|'responseEncodedBodyBytes'|'nativeRequests'>;
    const value=evaluation?.exceptionDetails?null:evaluation?.result?.value as DOMPage|null|undefined;
    if(!value||violation||signal.aborted)throw Error(violation||'MDView 原生正文不可见');const screenshot=await win.webContents.capturePage();await hooks.onScreenshot?.(screenshot.toPNG());return {...value,responseRobots:[...responseRobots],responseStatus,responseMediaType,responseBodyBytes,responseEncodedBodyBytes,nativeRequests:[...nativeRequests]};
  }finally{
    signal.removeEventListener('abort',stop);if(debuggerAttached){win.webContents.debugger.removeListener('message',onDebuggerMessage);try{win.webContents.debugger.detach()}catch{}}try{if(!win.isDestroyed())win.webContents.stop()}catch{}if(!win.isDestroyed())win.destroy();await ses.clearStorageData().catch(()=>undefined);
  }
}
