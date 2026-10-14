import {randomUUID} from 'node:crypto';
import {BrowserWindow} from 'electron';
import {
  MDSHARE_ORIGIN,
  type MDShareNativeRequest,
  type MDShareRenderedPage,
  type MDShareRenderHooks,
} from '../integrations/mdshare';
import {MDSHARE_STATIC_RESOURCES,exactMDSharePublicUrl,mdshareProductionAllowlist,type MDShareAllowedRequest} from '../integrations/mdshare-native-policy';

export interface MDShareRenderLifecycleHooks extends MDShareRenderHooks {
  onDiagnostic?:(event:MDShareRenderDiagnostic)=>void;
  onFirstDeniedRequest?:(identity:MDShareDeniedRequestIdentity)=>void;
  trackPhysical?:<T>(operation:Promise<T>,label:MDSharePhysicalOperation)=>Promise<T>;
}

interface RenderOptions extends MDShareRenderLifecycleHooks {
  allowlist?:readonly MDShareAllowedRequest[];
  testing?:{
    clearStorageData?:()=>Promise<void>;
    loadURL?:(url:string)=>Promise<unknown>;
    executeJavaScript?:(source:string,userGesture?:boolean)=>Promise<unknown>;
    maxPollAttempts?:number;
    pollIntervalMs?:number;
    cleanupTimeoutMs?:number;
  };
}

export type MDShareRenderRouteClass='public_page'|'static_asset'|'api_receipt'|'open_graph_image'|'other';
export type MDSharePhysicalOperation='initial_clear'|'load_url'|'poll_execute'|'window_finalize'|'cleanup_clear';
export type MDShareRenderFailureCategory=
  |'invalid_url'|'request_denied'|'metering_failed'|'diagnostic_capture_failed'
  |'redirect_denied'|'navigation_denied'|'aborted'|'storage_clear_failed'
  |'load_failed'|'poll_failed'|'dom_timeout'|'session_cleanup_failed'|'renderer_failed';
export interface MDShareRenderDiagnostic {
  version:1;
  kind:'lifecycle'|'operation'|'request'|'response'|'redirect'|'failure'|'cleanup';
  phase:'initial_clear'|'load'|'poll'|'cleanup'|'complete';
  routeClass?:MDShareRenderRouteClass;
  method?:string;
  resourceType?:string;
  permitted?:boolean;
  statusCode?:number;
  redirected?:boolean;
  failureCategory?:MDShareRenderFailureCategory;
  cleanupResult?:'complete'|'failed'|'timeout';
  operation?:MDSharePhysicalOperation;
  operationId?:number;
  operationState?:'started'|'settled'|'rejected';
}

export interface MDShareDeniedRequestIdentity {
  version:1;
  phase:MDShareRenderDiagnostic['phase'];
  url:string;
  method:string;
  resourceType:string;
}

// The exact public viewer closure emits request/response pairs for more than
// fifty resources before the first useful DOM poll. Keep the journal bounded,
// but large enough to preserve that complete, reviewable native sequence.
const MAX_DIAGNOSTIC_EVENTS=256;

function routeClass(value:string,publicUrl:string,origin:string):MDShareRenderRouteClass{
  if(value===publicUrl)return 'public_page';
  try{
    const parsed=new URL(value);
    if(parsed.origin!==origin)return 'other';
    if(/^\/api\/v1\/snippets\/[A-Za-z0-9]{12}$/.test(parsed.pathname))return 'api_receipt';
    if(/^\/og\/s\/[A-Za-z0-9]{12}\.png$/.test(parsed.pathname))return 'open_graph_image';
    if(MDSHARE_STATIC_RESOURCES.some(([pathname])=>pathname===parsed.pathname))return 'static_asset';
  }catch{}
  return 'other';
}

async function renderWithOrigin(url:string,signal:AbortSignal,origin:string,options:RenderOptions={}):Promise<MDShareRenderedPage>{
  if(!exactMDSharePublicUrl(url,origin)){
    options.onDiagnostic?.({version:1,kind:'failure',phase:'load',failureCategory:'invalid_url'});
    throw Error('MDShare 原生核验 URL 无效');
  }
  const partition=`mdshare-verifier-${randomUUID()}`;
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false}});
  const ses=win.webContents.session;
  const allowlist=options.allowlist??(origin===MDSHARE_ORIGIN?mdshareProductionAllowlist(url,origin):[{url,resourceTypes:['mainFrame']}]);
  const allowed=new Map(allowlist.map(value=>[value.url,value.resourceTypes]));
  const seen=new Set<string>(),nativeRequests:MDShareNativeRequest[]=[];
  const responseRobots:string[]=[];
  let aborted=false,violation='',phase:MDShareRenderDiagnostic['phase']='initial_clear',diagnosticCount=0,diagnosticCaptureFailed=false,failureRecorded=false,deniedIdentityCaptured=false,physicalSequence=0;
  const activePhysical=new Map<number,Promise<unknown>>();
  let rejectPending:((error:Error)=>void)|undefined;
  const record=(event:MDShareRenderDiagnostic)=>{
    if(diagnosticCaptureFailed)return false;
    if(diagnosticCount>=MAX_DIAGNOSTIC_EVENTS){diagnosticCaptureFailed=true;return false}
    diagnosticCount++;
    try{options.onDiagnostic?.(event);return true}catch{diagnosticCaptureFailed=true;return false}
  };
  const fail=(message:string,category:MDShareRenderFailureCategory,details:Partial<MDShareRenderDiagnostic>={})=>{
    if(!failureRecorded){failureRecorded=true;if(!record({version:1,kind:'failure',phase,failureCategory:category,...details})){violation='MDShare 原生诊断未能持久记录'}}
    violation ||= message;aborted=true;rejectPending?.(Error(violation));
    try{if(!win.isDestroyed())win.webContents.stop()}catch{}
  };
  const recordLifecycle=(event:MDShareRenderDiagnostic)=>{if(!record(event)){fail('MDShare 原生诊断未能持久记录','diagnostic_capture_failed');throw Error(violation)}};
  const cancellable=<T>(pending:Promise<T>)=>new Promise<T>((resolve,reject)=>{
    let settled=false;
    const finish=(complete:(value:any)=>void,value:any)=>{if(settled)return;settled=true;complete(value)};
    rejectPending=error=>finish(reject,error);
    void pending.then(value=>finish(resolve,value),error=>finish(reject,error));
  }).finally(()=>{rejectPending=undefined});
  const stop=()=>fail('MDShare 原生核验已取消','aborted');
  signal.addEventListener('abort',stop,{once:true});
  ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.on('will-download',event=>event.preventDefault());
  ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const resourceTypes=allowed.get(details.url);
    const permitted=details.method==='GET'&&!!resourceTypes&&resourceTypes.includes(details.resourceType)&&!seen.has(details.url);
    const requestDetails={routeClass:routeClass(details.url,url,origin),method:details.method,resourceType:details.resourceType,permitted};
    if(!permitted){
      if(!deniedIdentityCaptured){
        deniedIdentityCaptured=true;
        try{options.onFirstDeniedRequest?.({version:1,phase,url:details.url,method:details.method,resourceType:details.resourceType})}
        catch{record({version:1,kind:'request',phase,...requestDetails});fail('MDShare 首个拒绝请求身份未能持久记录','diagnostic_capture_failed',requestDetails);callback({cancel:true});return}
      }
      record({version:1,kind:'request',phase,...requestDetails});fail('MDShare 原生请求不在精确白名单','request_denied',requestDetails);callback({cancel:true});return
    }
    const request:MDShareNativeRequest={url:details.url,method:'GET',resourceType:details.resourceType};
    try{options.onBeforeRequest?.(request)}catch{fail('MDShare 原生请求未能持久计量','metering_failed',requestDetails);callback({cancel:true});return}
    if(!record({version:1,kind:'request',phase,...requestDetails})){fail('MDShare 原生诊断未能持久记录','diagnostic_capture_failed',requestDetails);callback({cancel:true});return}
    seen.add(details.url);nativeRequests.push(request);callback({cancel:false});
  });
  ses.webRequest.onHeadersReceived({urls:['<all_urls>']},(details,callback)=>{
    const responseDetails={routeClass:routeClass(details.url,url,origin),resourceType:details.resourceType,statusCode:details.statusCode,redirected:details.statusCode>=300&&details.statusCode<400};
    if(!record({version:1,kind:'response',phase,...responseDetails})){fail('MDShare 原生诊断未能持久记录','diagnostic_capture_failed',responseDetails);callback({cancel:true});return}
    if(responseDetails.redirected){fail('MDShare 原生请求禁止重定向','redirect_denied',responseDetails);callback({cancel:true});return}
    if(details.url===url&&details.resourceType==='mainFrame')for(const [name,values] of Object.entries(details.responseHeaders??{}))if(name.toLowerCase()==='x-robots-tag')for(const value of values??[])responseRobots.push(value);
    callback({cancel:false});
  });
  ses.webRequest.onBeforeRedirect({urls:['<all_urls>']},details=>{const redirectDetails={routeClass:routeClass(details.url,url,origin),resourceType:details.resourceType,statusCode:details.statusCode,redirected:true};record({version:1,kind:'redirect',phase,...redirectDetails});fail('MDShare 原生请求发生重定向','redirect_denied',redirectDetails)});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,next)=>{if(next!==url){event.preventDefault();fail('MDShare 原生页面禁止导航','navigation_denied',{routeClass:routeClass(next,url,origin)})}});
  const clearStorageData=options.testing?.clearStorageData??(()=>ses.clearStorageData());
  const loadURL=options.testing?.loadURL??((value:string)=>win.loadURL(value,{httpReferrer:''}));
  const executeJavaScript=options.testing?.executeJavaScript??((source:string,userGesture?:boolean)=>win.webContents.executeJavaScript(source,userGesture));
  const physical=<T>(label:MDSharePhysicalOperation,start:()=>Promise<T>)=>{
    const operationId=++physicalSequence;
    if(!record({version:1,kind:'operation',phase,operation:label,operationId,operationState:'started'})){
      fail('MDShare 原生操作诊断未能持久记录','diagnostic_capture_failed');
      return Promise.reject<T>(Error(violation));
    }
    let underlying:Promise<T>;
    try{underlying=Promise.resolve(start())}catch(error){underlying=Promise.reject(error)}
    let owned:Promise<T>;
    owned=underlying.then(value=>{
      activePhysical.delete(operationId);
      if(!record({version:1,kind:'operation',phase,operation:label,operationId,operationState:'settled'})){fail('MDShare 原生操作诊断未能持久记录','diagnostic_capture_failed');throw Error(violation)}
      return value;
    },error=>{
      activePhysical.delete(operationId);
      if(!record({version:1,kind:'operation',phase,operation:label,operationId,operationState:'rejected'})){fail('MDShare 原生操作诊断未能持久记录','diagnostic_capture_failed');throw Error(violation)}
      throw error;
    });
    activePhysical.set(operationId,owned);
    return options.trackPhysical?options.trackPhysical(owned,label):owned;
  };
  const maxPollAttempts=options.testing?.maxPollAttempts??120,pollIntervalMs=options.testing?.pollIntervalMs??100,cleanupTimeoutMs=options.testing?.cleanupTimeoutMs??2000;
  if(!Number.isInteger(maxPollAttempts)||maxPollAttempts<1||maxPollAttempts>120)throw Error('MDShare 原生核验轮询上限无效');
  if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>1000)throw Error('MDShare 原生核验轮询间隔无效');
  if(!Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>2000)throw Error('MDShare 原生核验清理时限无效');
  try{
    if(signal.aborted)throw Error('MDShare 原生核验已取消');
    recordLifecycle({version:1,kind:'lifecycle',phase:'initial_clear'});
    await cancellable(physical('initial_clear',clearStorageData));
    phase='load';recordLifecycle({version:1,kind:'lifecycle',phase});
    await cancellable(physical('load_url',()=>loadURL(url)));
    phase='poll';recordLifecycle({version:1,kind:'lifecycle',phase});
    for(let attempt=0;attempt<maxPollAttempts;attempt++){
      if(violation)throw Error(violation);
      if(aborted||signal.aborted||win.isDestroyed())throw Error('MDShare 原生核验已取消');
      const source=`(()=>{
        const root=document.querySelector('article .ms-preview.ms-md');
        const hasArea=rect=>rect.width>0&&rect.height>0;
        const colorVisible=value=>{if(!value||value==='transparent')return false;const rgba=value.match(/^rgba\\([^)]*,\\s*([0-9.]+)\\s*\\)$/i),slash=value.match(/\\/\\s*([0-9.]+)\\s*\\)$/);return !(rgba&&Number(rgba[1])<=0)&&!(slash&&Number(slash[1])<=0)};
        const styleVisible=element=>{for(let current=element;current instanceof Element;current=current.parentElement){const style=getComputedStyle(current),opacity=Number(style.opacity);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden'||!Number.isFinite(opacity)||opacity<=0||style.clipPath!=='none'||style.clip!=='auto'||/opacity\\(\\s*0(?:\\.0+)?\\s*\\)/i.test(style.filter))return false}return true};
        const contentBox=element=>{const outer=element.getBoundingClientRect(),scaleX=element.offsetWidth>0?outer.width/element.offsetWidth:1,scaleY=element.offsetHeight>0?outer.height/element.offsetHeight:1,left=outer.left+element.clientLeft*scaleX,top=outer.top+element.clientTop*scaleY;return {left,top,right:left+element.clientWidth*scaleX,bottom:top+element.clientHeight*scaleY,scaleX,scaleY}};
        const reachableRects=(element,rects)=>{const page=document.scrollingElement??document.documentElement,pageWidth=Math.max(page.scrollWidth,document.documentElement.scrollWidth,document.body?.scrollWidth??0),pageHeight=Math.max(page.scrollHeight,document.documentElement.scrollHeight,document.body?.scrollHeight??0);for(const source of rects){let rect={left:source.left,right:source.right,top:source.top,bottom:source.bottom};for(let current=element;current instanceof Element;current=current.parentElement){const style=getComputedStyle(current),box=contentBox(current);for(const axis of ['X','Y']){const overflow=style['overflow'+axis],hidden=overflow==='hidden'||overflow==='clip',scrollable=overflow==='auto'||overflow==='scroll';if(!hidden&&!scrollable)continue;const horizontal=axis==='X',start=horizontal?'left':'top',end=horizontal?'right':'bottom',scale=horizontal?box.scaleX:box.scaleY,scroll=horizontal?current.scrollLeft:current.scrollTop,extent=horizontal?current.scrollWidth:current.scrollHeight;if(hidden){if(rect[start]<box[start]-.5||rect[end]>box[end]+.5)return false;continue}if(box[end]-box[start]<=0||!Number.isFinite(scale)||scale<=0)return false;const contentStart=(rect[start]-box[start])/scale+scroll,contentEnd=(rect[end]-box[start])/scale+scroll;if(contentStart<-.5||contentEnd>extent+.5)return false;rect[start]=box[start];rect[end]=box[end]}}const documentLeft=rect.left+window.scrollX,documentRight=rect.right+window.scrollX,documentTop=rect.top+window.scrollY,documentBottom=rect.bottom+window.scrollY;if(documentLeft<-.5||documentRight>pageWidth+.5||documentTop<-.5||documentBottom>pageHeight+.5)return false}return true};
        const textVisible=node=>{const element=node.parentElement,text=node.textContent??'';if(!element||!text.trim()||!styleVisible(element))return !text.trim();const style=getComputedStyle(element);if(Number.parseFloat(style.fontSize)<=0||!colorVisible(style.color)||!colorVisible(style.webkitTextFillColor||style.color))return false;const range=document.createRange();range.selectNodeContents(node);const rects=[...range.getClientRects()].filter(hasArea);return rects.length>0&&reachableRects(element,rects)};
        const textNodes=element=>{const nodes=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())if((node.textContent??'').trim())nodes.push(node);return nodes};
        const elementVisible=element=>styleVisible(element)&&hasArea(element.getBoundingClientRect())&&textNodes(element).every(textVisible);
        if(!(root instanceof HTMLElement)||!styleVisible(root)||!hasArea(root.getBoundingClientRect()))return null;
        const articleNodes=textNodes(root),allArticleTextVisible=articleNodes.length>0&&articleNodes.every(textVisible);
        const links=[...root.querySelectorAll('a[href]')].map(element=>({href:element.href,rel:[...element.relList],text:element.textContent??'',visible:elementVisible(element)&&getComputedStyle(element).pointerEvents!=='none'}));
        const robots=[...document.querySelectorAll('meta[name]')].map(element=>({name:(element.getAttribute('name')??'').trim().toLowerCase(),content:element.getAttribute('content')??''})).filter(value=>['robots','googlebot','bingbot'].includes(value.name));
        const canonicals=[...document.querySelectorAll('link[rel]')].filter(element=>(element.getAttribute('rel')??'').toLowerCase().split(/\\s+/).includes('canonical')).map(element=>element.href);
        return {url:location.href,title:document.title,bodyText:document.body?.innerText??'',articleText:root.innerText,allArticleTextVisible,links,articleHtml:root.outerHTML,robots,canonicals,hasRefresh:[...document.querySelectorAll('meta[http-equiv]')].some(element=>(element.getAttribute('http-equiv')??'').trim().toLowerCase()==='refresh'),hasPasswordGate:!!root.querySelector('input[type="password"],[data-gate="password"],.password-gate'),hasLoginGate:!!root.querySelector('form[action*="login"],[data-gate="login"],.login-gate')};
      })()`;
      const result=await cancellable(physical('poll_execute',()=>executeJavaScript(source,true))) as Omit<MDShareRenderedPage,'responseRobots'|'nativeRequests'>|null;
      if(result){if(violation)throw Error(violation);phase='complete';recordLifecycle({version:1,kind:'lifecycle',phase});return {...result,responseRobots:[...responseRobots],nativeRequests:[...nativeRequests]}}
      await new Promise<void>((resolve,reject)=>{
        let timer:ReturnType<typeof setTimeout>;
        const cancel=()=>{clearTimeout(timer);reject(Error('MDShare 原生核验已取消'))};
        timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve()},pollIntervalMs);
        signal.addEventListener('abort',cancel,{once:true});
      });
    }
    fail('MDShare 原生正文未在时限内出现','dom_timeout');throw Error(violation);
  }catch(error){
    if(!failureRecorded){
      const category:MDShareRenderFailureCategory=signal.aborted?'aborted':phase==='initial_clear'?'storage_clear_failed':phase==='load'?'load_failed':phase==='poll'?'poll_failed':'renderer_failed';
      fail(category==='load_failed'?'MDShare 原生页面加载失败':category==='storage_clear_failed'?'MDShare 原生会话初始化失败':'MDShare 原生核验失败',category);
    }
    throw error;
  }finally{
    phase='cleanup';
    signal.removeEventListener('abort',stop);
    try{if(!win.isDestroyed())win.webContents.stop()}catch{}
    const pendingBeforeFinalize=[...activePhysical.values()];
    const finalize=physical('window_finalize',async()=>{
      await Promise.allSettled(pendingBeforeFinalize);
      if(!win.isDestroyed())win.destroy();
      await physical('cleanup_clear',clearStorageData);
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    const cleanupResult=await Promise.race([
      finalize.then(()=>'complete' as const,()=>'failed' as const),
      new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),cleanupTimeoutMs);timer.unref?.()}),
    ]);
    if(timer)clearTimeout(timer);
    if(!record({version:1,kind:'cleanup',phase,cleanupResult}))throw Error('MDShare 原生诊断未能持久记录');
    if(cleanupResult!=='complete'&&!failureRecorded&&!signal.aborted){fail('MDShare 原生会话清理超时','session_cleanup_failed');throw Error(violation)}
  }
}

export function renderMDSharePage(url:string,signal:AbortSignal,hooks:MDShareRenderLifecycleHooks={}):Promise<MDShareRenderedPage>{return renderWithOrigin(url,signal,MDSHARE_ORIGIN,hooks)}
export const mdshareRendererTesting={renderWithOrigin,exactPublicUrl:exactMDSharePublicUrl,productionAllowlist:mdshareProductionAllowlist};
