import {randomUUID} from 'node:crypto';
import {BrowserWindow} from 'electron';
import {
  trackAgentDropPendingOperation,
  type AgentDropNativeRequest,
  type AgentDropReadOnlyQueryProof,
  type AgentDropRenderedPage,
  type AgentDropRenderHooks,
} from '../integrations/agentdrop';

import {AGENTDROP_PRODUCTION_RENDERER_CONTRACT,AGENTDROP_STATIC_RESOURCES,classifyAgentDropRoute,exactAgentDropPublicUrl,sendAgentDropReadOnlyClientFrame,type AgentDropFrameState,type AgentDropRendererContract} from '../integrations/agentdrop-native-policy';
export {AGENTDROP_STATIC_RESOURCES} from '../integrations/agentdrop-native-policy';

export type AgentDropRenderFailureCategory='invalid_url'|'request_denied'|'credential_leak'|'redirect_denied'|'http_status'|'frame_denied'|'storage_clear_failed'|'load_failed'|'dom_timeout'|'capture_failed'|'cleanup_failed'|'aborted';
export interface AgentDropRenderDiagnostic {version:1;kind:'request'|'blocked_analytics'|'frame'|'failure'|'cleanup';phase:'initial_clear'|'load'|'poll'|'capture'|'cleanup';routeClass?:AgentDropNativeRequest['routeClass']|'analytics'|'other';method?:string;resourceType?:string;resourcePath?:string;statusCode?:number;permitted?:boolean;frameType?:string;failureCategory?:AgentDropRenderFailureCategory;cleanupResult?:'complete'|'failed'|'timeout'}
export interface AgentDropRendererHooks extends AgentDropRenderHooks {
  onDiagnostic?:(value:AgentDropRenderDiagnostic)=>void;
  trackPhysical?:<T>(operation:Promise<T>)=>Promise<T>;
}
interface RenderOptions extends AgentDropRendererHooks {
  testing?:{
    clearSession?:()=>Promise<void>[];
    loadURL?:(url:string)=>Promise<unknown>;
    executeJavaScript?:(source:string)=>Promise<unknown>;
    capturePage?:()=>Promise<{toPNG():Uint8Array}>;
    maxPollAttempts?:number;
    pollIntervalMs?:number;
    cleanupTimeoutMs?:number;
    webSocketFactory?:(url:string)=>WebSocket;
    installReadOnlyBridge?:boolean;
  };
}

function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)}
function exactKeys(value:Record<string,unknown>,keys:readonly string[]){return Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key))}
function readonlyWebSocketSource(bindingName:string,dispatcherName:string,expectedUrl:string){return `(()=>{
  const binding=globalThis[${JSON.stringify(bindingName)}];if(typeof binding!=='function')throw Error('AgentDrop read-only bridge unavailable');
  const sockets=new Map();let nextId=0,constructed=false;
  class AgentDropReadOnlyWebSocket extends EventTarget{
    constructor(url,protocols){super();const value=String(url),list=protocols===undefined?[]:typeof protocols==='string'?[protocols]:[...protocols].map(String);if(value!==${JSON.stringify(expectedUrl)}||list.length||constructed)throw new DOMException('WebSocket route denied','SecurityError');constructed=true;this._id=++nextId;this._state=0;this._url=value;this._protocol='';this._extensions='';this._binaryType='blob';this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;sockets.set(this._id,this);binding(JSON.stringify({version:1,kind:'open',id:this._id,url:value,protocols:list}))}
    get url(){return this._url}get readyState(){return this._state}get bufferedAmount(){return 0}get extensions(){return this._extensions}get protocol(){return this._protocol}get binaryType(){return this._binaryType}set binaryType(value){if(value==='blob'||value==='arraybuffer')this._binaryType=value}
    send(data){if(this._state!==1)throw new DOMException('WebSocket is not open','InvalidStateError');if(typeof data!=='string')throw new TypeError('AgentDrop read-only bridge accepts text frames only');binding(JSON.stringify({version:1,kind:'send',id:this._id,payload:data}))}
    close(code,reason=''){if(this._state>=2)return;if(code!==undefined&&code!==1000)throw new DOMException('WebSocket close code denied','InvalidAccessError');if(typeof reason!=='string'||new TextEncoder().encode(reason).byteLength>123)throw new DOMException('WebSocket close reason invalid','SyntaxError');this._state=2;binding(JSON.stringify({version:1,kind:'close',id:this._id,code:code??null,reason}))}
    _emit(type,event){this.dispatchEvent(event);const handler=this['on'+type];if(typeof handler==='function')handler.call(this,event)}
  }
  for(const [name,value] of Object.entries({CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3})){Object.defineProperty(AgentDropReadOnlyWebSocket,name,{value});Object.defineProperty(AgentDropReadOnlyWebSocket.prototype,name,{value})}
  Object.defineProperty(globalThis,${JSON.stringify(dispatcherName)},{configurable:false,writable:false,value:message=>{if(!message||message.version!==1||message.id!==1)return;const socket=sockets.get(message.id);if(!socket)return;if(message.kind==='open'){socket._state=1;socket._emit('open',new Event('open'))}else if(message.kind==='message'&&typeof message.payload==='string')socket._emit('message',new MessageEvent('message',{data:message.payload,origin:new URL(socket.url).origin}));else if(message.kind==='error')socket._emit('error',new Event('error'));else if(message.kind==='close'){socket._state=3;socket._emit('close',new CloseEvent('close',{code:Number.isInteger(message.code)?message.code:1006,reason:typeof message.reason==='string'?message.reason:'',wasClean:message.clean===true}))}}});
  Object.defineProperty(globalThis,'WebSocket',{configurable:false,writable:false,value:AgentDropReadOnlyWebSocket});
})()`}

async function renderWithContract(url:string,signal:AbortSignal,contract:AgentDropRendererContract,options:RenderOptions={}):Promise<AgentDropRenderedPage>{
  if(!exactAgentDropPublicUrl(url,contract.pageOrigin))throw Error('AgentDrop 原生核验 URL 无效');
  if(signal.aborted)throw Error('AgentDrop 原生核验已取消');
  const maxPollAttempts=options.testing?.maxPollAttempts??120,pollIntervalMs=options.testing?.pollIntervalMs??100,cleanupTimeoutMs=options.testing?.cleanupTimeoutMs??2000;
  if(!Number.isInteger(maxPollAttempts)||maxPollAttempts<1||maxPollAttempts>120||!Number.isInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>1000||!Number.isInteger(cleanupTimeoutMs)||cleanupTimeoutMs<1||cleanupTimeoutMs>2000)throw Error('AgentDrop 原生核验时限无效');
  const slug=new URL(url).pathname.slice(1),partition=`agentdrop-verifier-${randomUUID()}`;
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:true,webSecurity:true,allowRunningInsecureContent:false}}),ses=win.webContents.session;
  const physical=<T>(operation:Promise<T>)=>(options.trackPhysical??trackAgentDropPendingOperation)(operation);
  try{await physical(win.loadURL('about:blank'))}catch(error){if(!win.isDestroyed())win.destroy();throw error}
  const staticMap=new Map(contract.staticResources.map(([path,types])=>[`${contract.pageOrigin}${path}`,types]));
  const seen=new Map<string,number>(),nativeRequests:AgentDropNativeRequest[]=[],responseRobots:string[]=[];
  const frameState:AgentDropFrameState={connectFrames:0,queryFrames:0,slug},popupTargets:Array<{url:string;features:string;disposition:string}>=[];
  const bridgeId=randomUUID().replaceAll('-',''),bindingName=`__agentDropReadonlyBridge_${bridgeId}`,dispatcherName=`__agentDropReadonlyReceive_${bridgeId}`;
  let queryProof:AgentDropReadOnlyQueryProof|undefined,contentRequestUrl='',blockedAnalyticsRequests=0,phase:AgentDropRenderDiagnostic['phase']='initial_clear',violation='',rejectPending:((error:Error)=>void)|undefined,failureRecorded=false,linkProbeActive=false,relaySocket:WebSocket|undefined,relayLifecycle:Promise<void>|undefined,relayExecutionContext:number|undefined,relayInboundFrames=0,relayInboundBytes=0;
  const record=(event:AgentDropRenderDiagnostic)=>{try{options.onDiagnostic?.(event)}catch{violation||='AgentDrop 原生诊断持久化失败'}};
  const fail=(message:string,category:AgentDropRenderFailureCategory,details:Partial<AgentDropRenderDiagnostic>={})=>{if(!failureRecorded){failureRecorded=true;record({version:1,kind:'failure',phase,failureCategory:category,...details})}violation||=message;rejectPending?.(Error(violation));try{if(relaySocket&&relaySocket.readyState<2)relaySocket.close(1000,'policy stop')}catch{}try{if(!win.isDestroyed())win.webContents.stop()}catch{}};
  const cancellable=<T>(pending:Promise<T>)=>new Promise<T>((resolve,reject)=>{let settled=false;const finish=(fn:(value:any)=>void,value:any)=>{if(settled)return;settled=true;fn(value)};rejectPending=error=>finish(reject,error);void pending.then(value=>finish(resolve,value),error=>finish(reject,error))}).finally(()=>{rejectPending=undefined});
  const stop=()=>fail('AgentDrop 原生核验已取消','aborted');signal.addEventListener('abort',stop,{once:true});
  ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);ses.on('will-download',event=>event.preventDefault());
  ses.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const classified=classifyAgentDropRoute(details.url,url,contract,slug);
    if(classified==='analytics'){blockedAnalyticsRequests++;record({version:1,kind:'blocked_analytics',phase,routeClass:'analytics',method:details.method,resourceType:details.resourceType,permitted:false});try{options.onBlockedAnalyticsRequest?.({url:details.url,method:details.method,resourceType:details.resourceType})}catch{fail('AgentDrop 分析请求阻断记录失败','request_denied');callback({cancel:true});return}if(blockedAnalyticsRequests>16)fail('AgentDrop 分析请求数量异常','request_denied');callback({cancel:true});return}
    if(classified==='passive'){callback({cancel:true});return}
    const types=staticMap.get(details.url),seenCount=seen.get(details.url)??0,withinBound=seenCount<(classified==='font'?2:1),permitted=details.method==='GET'&&withinBound&&(
      classified==='public_page'&&details.resourceType==='mainFrame'||
      classified==='static_asset'&&!!types?.includes(details.resourceType)||
      classified==='font'&&!!types?.includes(details.resourceType)||
      classified==='anonymous_session'&&details.resourceType==='xhr'||
      classified==='raw_content'&&details.resourceType==='xhr');
    const resourcePath=(()=>{try{const parsed=new URL(details.url);return parsed.origin===contract.pageOrigin&&/^\/(?:assets|fonts)\/[A-Za-z0-9_.-]+$/.test(parsed.pathname)&&!parsed.search&&!parsed.hash?parsed.pathname:undefined}catch{return}})();
    record({version:1,kind:'request',phase,routeClass:classified==='other'?'other':classified,method:details.method,resourceType:details.resourceType,resourcePath,permitted});
    if(!permitted){fail('AgentDrop 原生请求不在精确只读白名单','request_denied',{routeClass:classified==='other'?'other':classified,method:details.method,resourceType:details.resourceType,resourcePath});callback({cancel:true});return}
    const request:AgentDropNativeRequest={url:details.url,method:'GET',resourceType:details.resourceType,routeClass:classified as AgentDropNativeRequest['routeClass']};try{options.onBeforeRequest?.(request)}catch{fail('AgentDrop 原生请求未能持久计量','request_denied');callback({cancel:true});return}seen.set(details.url,seenCount+1);nativeRequests.push(request);if(classified==='raw_content')contentRequestUrl=details.url;callback({cancel:false});
  });
  ses.webRequest.onBeforeSendHeaders({urls:['<all_urls>']},(details,callback)=>{const classified=classifyAgentDropRoute(details.url,url,contract,slug);if(classified==='analytics'||classified==='passive'){callback({cancel:true});return}const headers={...details.requestHeaders},sensitive=Object.entries(headers).filter(([,value])=>String(value??'').trim()).map(([name])=>name.toLowerCase());if(sensitive.some(value=>['authorization','proxy-authorization'].includes(value))){fail('AgentDrop 空白会话出现凭据请求头','credential_leak');callback({cancel:true});return}for(const name of Object.keys(headers))if(name.toLowerCase()==='cookie')delete headers[name];callback({cancel:false,requestHeaders:headers})});
  ses.webRequest.onHeadersReceived({urls:['<all_urls>']},(details,callback)=>{
    const classified=classifyAgentDropRoute(details.url,url,contract,slug);if(details.statusCode>=300&&details.statusCode<400){fail('AgentDrop 原生请求发生重定向','redirect_denied');callback({cancel:true});return}
    const expected=classified==='convex_sync'?details.statusCode===101:classified==='anonymous_session'?[200,204,401].includes(details.statusCode):classified!=='analytics'&&classified!=='passive'&&classified!=='other'?details.statusCode===200:true;if(!expected){fail('AgentDrop 原生只读请求状态异常','http_status',{routeClass:classified==='other'?'other':classified,statusCode:details.statusCode} as Partial<AgentDropRenderDiagnostic>);callback({cancel:true});return}
    if(classified==='public_page')for(const [name,values] of Object.entries(details.responseHeaders??{}))if(name.toLowerCase()==='x-robots-tag')for(const value of values??[])responseRobots.push(value);
    const headers=Object.fromEntries(Object.entries(details.responseHeaders??{}).filter(([name])=>!['set-cookie','set-cookie2'].includes(name.toLowerCase())));callback({cancel:false,responseHeaders:headers});
  });
  ses.webRequest.onBeforeRedirect({urls:['<all_urls>']},()=>fail('AgentDrop 原生请求发生重定向','redirect_denied'));
  win.webContents.setWindowOpenHandler(details=>{if(!linkProbeActive)fail('AgentDrop 原生页面出现未授权窗口','request_denied');else popupTargets.push({url:details.url,features:details.features,disposition:details.disposition});return {action:'deny'}});win.webContents.on('will-navigate',(event,next)=>{if(next!==url){event.preventDefault();fail('AgentDrop 原生页面禁止导航','request_denied')}});
  const debuggerApi=win.webContents.debugger;
  const deliverRelay=(message:Record<string,unknown>)=>{if(relayExecutionContext===undefined||!debuggerApi.isAttached()||win.isDestroyed())return;const expression=`globalThis[${JSON.stringify(dispatcherName)}](${JSON.stringify(message)})`;void physical(debuggerApi.sendCommand('Runtime.evaluate',{expression,contextId:relayExecutionContext,returnByValue:true})).catch(()=>{if(phase!=='cleanup')fail('AgentDrop 只读桥响应交付失败','load_failed')})};
  const openRelay=(contextId:number)=>{
    if(relaySocket||relayExecutionContext!==undefined){fail('AgentDrop 只读桥禁止重复连接','request_denied');return}
    relayExecutionContext=contextId;
    const request:AgentDropNativeRequest={url:contract.convexSyncUrl,method:'GET',resourceType:'main_owned_websocket',routeClass:'convex_sync'};
    record({version:1,kind:'request',phase,routeClass:'convex_sync',method:'GET',resourceType:request.resourceType,permitted:true});
    try{options.onBeforeRequest?.(request)}catch{fail('AgentDrop 主进程只读连接未能持久计量','request_denied');return}
    seen.set(contract.convexSyncUrl,1);nativeRequests.push(request);
    let finish!:()=>void;const lifecycle=new Promise<void>(resolve=>{finish=resolve});relayLifecycle=physical(lifecycle);
    let socket:WebSocket;try{socket=(options.testing?.webSocketFactory??((value:string)=>new WebSocket(value)))(contract.convexSyncUrl)}catch{finish();fail('AgentDrop 主进程只读连接失败','load_failed');return}relaySocket=socket;
    socket.addEventListener('open',()=>deliverRelay({version:1,kind:'open',id:1}));
    socket.addEventListener('message',event=>{if(typeof event.data!=='string'||++relayInboundFrames>64||(relayInboundBytes+=Buffer.byteLength(event.data))>2*1024*1024){fail('AgentDrop 只读桥响应越界','request_denied');return}deliverRelay({version:1,kind:'message',id:1,payload:event.data})});
    socket.addEventListener('error',()=>{if(phase!=='cleanup'){deliverRelay({version:1,kind:'error',id:1});fail('AgentDrop 主进程只读连接失败','load_failed')}});
    socket.addEventListener('close',event=>{finish();if(phase!=='cleanup')deliverRelay({version:1,kind:'close',id:1,code:event.code,reason:event.reason,clean:event.wasClean})},{once:true});
  };
  const handleBinding=(payload:string,contextId:number)=>{
    if(Buffer.byteLength(payload)>128*1024){fail('AgentDrop 只读桥请求越界','frame_denied');return}
    let value:unknown;try{value=JSON.parse(payload)}catch{fail('AgentDrop 只读桥请求无效','frame_denied');return}if(!object(value)||value.version!==1||!Number.isSafeInteger(value.id)||value.id!==1){fail('AgentDrop 只读桥请求无效','frame_denied');return}
    if(value.kind==='open'&&exactKeys(value,['version','kind','id','url','protocols'])&&value.url===contract.convexSyncUrl&&Array.isArray(value.protocols)&&value.protocols.length===0){openRelay(contextId);return}
    if(contextId!==relayExecutionContext){fail('AgentDrop 只读桥执行上下文已改变','frame_denied');return}
    if(value.kind==='send'&&exactKeys(value,['version','kind','id','payload'])&&typeof value.payload==='string'&&Buffer.byteLength(value.payload)<=64*1024&&relaySocket?.readyState===1){const type=(()=>{try{const frame=JSON.parse(value.payload);return typeof frame?.type==='string'?frame.type:'invalid'}catch{return'invalid'}})(),checked=sendAgentDropReadOnlyClientFrame(value.payload,frameState,frame=>relaySocket!.send(frame));record({version:1,kind:'frame',phase,frameType:type,permitted:!!checked});if(!checked){fail('AgentDrop WebSocket 出站帧未通过发送前精确查询校验','frame_denied');return}if(checked.proof)queryProof=checked.proof;return}
    if(value.kind==='close'&&exactKeys(value,['version','kind','id','code','reason'])&&(value.code===null||value.code===1000)&&typeof value.reason==='string'&&Buffer.byteLength(value.reason)<=123){try{if(relaySocket&&relaySocket.readyState<2)value.code===1000?relaySocket.close(1000,value.reason):relaySocket.close()}catch{fail('AgentDrop 只读桥关闭失败','cleanup_failed')}return}
    fail('AgentDrop 只读桥请求不在精确协议内','frame_denied');
  };
  debuggerApi.on('message',(_event,method,params)=>{if(method==='Network.webSocketFrameSent'){record({version:1,kind:'frame',phase,frameType:'browser_direct',permitted:false});fail('AgentDrop 浏览器直连 WebSocket 被禁止','frame_denied');return}if(method!=='Runtime.bindingCalled'||!object(params)||params.name!==bindingName||typeof params.payload!=='string'||!Number.isSafeInteger(params.executionContextId))return;handleBinding(params.payload,Number(params.executionContextId))});
  const clearSession=options.testing?.clearSession??(()=>[ses.clearStorageData(),ses.clearCache()]);
  const loadURL=options.testing?.loadURL??((value:string)=>win.loadURL(value,{httpReferrer:''}));
  const executeJavaScript=options.testing?.executeJavaScript??((source:string)=>win.webContents.executeJavaScriptInIsolatedWorld(999,[{code:source}]));
  const capturePage=options.testing?.capturePage??(()=>win.webContents.capturePage());
  try{
    if(signal.aborted)throw Error('AgentDrop 原生核验已取消');debuggerApi.attach('1.3');
    await cancellable(physical(debuggerApi.sendCommand('Network.enable')));
    await cancellable(physical(debuggerApi.sendCommand('Runtime.enable')));
    await cancellable(physical(debuggerApi.sendCommand('Page.enable')));
    if(options.testing?.installReadOnlyBridge!==false){await cancellable(physical(debuggerApi.sendCommand('Runtime.addBinding',{name:bindingName})));await cancellable(physical(debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:readonlyWebSocketSource(bindingName,dispatcherName,contract.convexSyncUrl)})))}
    await cancellable(Promise.all(clearSession().map(operation=>physical(operation))));
    phase='load';await cancellable(physical(loadURL(url)));
    phase='poll';let stableSignature='',stableCount=0;
    for(let attempt=0;attempt<maxPollAttempts;attempt++){
      if(violation)throw Error(violation);if(signal.aborted||win.isDestroyed())throw Error('AgentDrop 原生核验已取消');
      const result=await cancellable(physical(executeJavaScript(`(()=>{
        const root=document.querySelector('.doc');if(document.readyState!=='complete'||document.fonts?.status==='loading')return null;
        const hasArea=rect=>rect.width>0&&rect.height>0;
        const colorVisible=value=>{if(!value||value==='transparent')return false;const rgba=value.match(/^rgba\\([^)]*,\\s*([0-9.]+)\\s*\\)$/i),slash=value.match(/\\/\\s*([0-9.]+)\\s*\\)$/);return !(rgba&&Number(rgba[1])<=0)&&!(slash&&Number(slash[1])<=0)};
        const styleVisible=element=>{for(let current=element;current instanceof Element;current=current.parentElement){const style=getComputedStyle(current),opacity=Number(style.opacity),matrix=new DOMMatrixReadOnly(style.transform==='none'?undefined:style.transform);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden'||!Number.isFinite(opacity)||opacity<=0||style.clipPath!=='none'||style.clip!=='auto'||/opacity\\(\\s*0(?:\\.0+)?\\s*\\)/i.test(style.filter)||Math.abs(matrix.a)<.001||Math.abs(matrix.d)<.001)return false}return true};
        const contentBox=element=>{const outer=element.getBoundingClientRect(),scaleX=element.offsetWidth>0?outer.width/element.offsetWidth:1,scaleY=element.offsetHeight>0?outer.height/element.offsetHeight:1,left=outer.left+element.clientLeft*scaleX,top=outer.top+element.clientTop*scaleY;return {left,top,right:left+element.clientWidth*scaleX,bottom:top+element.clientHeight*scaleY,scaleX,scaleY}};
        const reachableRects=(element,rects)=>{const page=document.scrollingElement??document.documentElement,pageWidth=Math.max(page.scrollWidth,document.documentElement.scrollWidth,document.body?.scrollWidth??0),pageHeight=Math.max(page.scrollHeight,document.documentElement.scrollHeight,document.body?.scrollHeight??0);for(const source of rects){let rect={left:source.left,right:source.right,top:source.top,bottom:source.bottom};for(let current=element;current instanceof Element;current=current.parentElement){const style=getComputedStyle(current),box=contentBox(current);for(const axis of ['X','Y']){const overflow=style['overflow'+axis],hidden=overflow==='hidden'||overflow==='clip',scrollable=overflow==='auto'||overflow==='scroll';if(!hidden&&!scrollable)continue;const horizontal=axis==='X',start=horizontal?'left':'top',end=horizontal?'right':'bottom',scale=horizontal?box.scaleX:box.scaleY,scroll=horizontal?current.scrollLeft:current.scrollTop,extent=horizontal?current.scrollWidth:current.scrollHeight;if(hidden){if(rect[start]<box[start]-.5||rect[end]>box[end]+.5)return false;continue}if(box[end]-box[start]<=0||!Number.isFinite(scale)||scale<=0)return false;const contentStart=(rect[start]-box[start])/scale+scroll,contentEnd=(rect[end]-box[start])/scale+scroll;if(contentStart<-.5||contentEnd>extent+.5)return false;rect[start]=box[start];rect[end]=box[end]}}const documentLeft=rect.left+window.scrollX,documentRight=rect.right+window.scrollX,documentTop=rect.top+window.scrollY,documentBottom=rect.bottom+window.scrollY;if(documentLeft<-.5||documentRight>pageWidth+.5||documentTop<-.5||documentBottom>pageHeight+.5)return false}return true};
        const textVisible=node=>{const element=node.parentElement,text=node.textContent??'';if(!element||!text.trim()||!styleVisible(element))return !text.trim();const style=getComputedStyle(element);if(Number.parseFloat(style.fontSize)<=0||!colorVisible(style.color)||!colorVisible(style.webkitTextFillColor||style.color))return false;const range=document.createRange();range.selectNodeContents(node);const rects=[...range.getClientRects()].filter(hasArea);return rects.length>0&&reachableRects(element,rects)};
        const textNodes=element=>{const nodes=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode())if((node.textContent??'').trim())nodes.push(node);return nodes};
        const elementVisible=element=>styleVisible(element)&&hasArea(element.getBoundingClientRect())&&textNodes(element).every(textVisible);
        if(!(root instanceof HTMLElement)||!styleVisible(root)||!hasArea(root.getBoundingClientRect()))return null;const nodes=textNodes(root),allArticleTextVisible=nodes.length>0&&nodes.every(textVisible);if(!allArticleTextVisible)return null;
        const links=[...root.querySelectorAll('a[href]')].map(element=>({source:'anchor',href:element.href,rel:[...element.relList],text:element.textContent??'',visible:elementVisible(element)&&getComputedStyle(element).pointerEvents!=='none'}));
        const protectedLinks=[...root.querySelectorAll('button[data-streamdown="link"]')].map(element=>({text:element.textContent??'',visible:elementVisible(element)&&getComputedStyle(element).pointerEvents!=='none'}));
        const robots=[...document.querySelectorAll('meta[name]')].map(element=>({name:(element.getAttribute('name')??'').trim().toLowerCase(),content:element.getAttribute('content')??''})).filter(value=>['robots','googlebot','bingbot'].includes(value.name));
        const canonicals=[...document.querySelectorAll('link[rel]')].filter(element=>(element.getAttribute('rel')??'').toLowerCase().split(/\\s+/).includes('canonical')).map(element=>element.href);
        return {url:location.href,title:document.title,bodyText:document.body?.innerText??'',articleText:root.innerText,allArticleTextVisible,links,protectedLinks,articleHtml:root.outerHTML,robots,canonicals,hasRefresh:[...document.querySelectorAll('meta[http-equiv]')].some(element=>(element.getAttribute('http-equiv')??'').trim().toLowerCase()==='refresh'),hasPasswordGate:!!document.querySelector('input[type="password"],[data-gate="password"],.password-gate'),hasLoginGate:!!document.querySelector('form[action*="login"],[data-gate="login"],.login-gate')};
      })()`))) as Omit<AgentDropRenderedPage,'nativeRequests'|'blockedAnalyticsRequests'|'readOnlyQuery'|'contentRequestUrl'|'screenshotPng'|'responseRobots'>|null;
      if(result&&queryProof&&contentRequestUrl){const withProtected=result as typeof result&{protectedLinks:Array<{text:string;visible:boolean}>};const signature=JSON.stringify([result.title,result.articleText,result.articleHtml,result.links,withProtected.protectedLinks,result.robots,result.canonicals]);if(signature===stableSignature)stableCount++;else{stableSignature=signature;stableCount=1}if(stableCount>=3){phase='capture';if(withProtected.protectedLinks.length>64)throw Error('AgentDrop 原生安全链接数量异常');const protectedProofs:AgentDropRenderedPage['links']=[];for(let index=0;index<withProtected.protectedLinks.length;index++){const before=popupTargets.length;linkProbeActive=true;let probe:unknown;try{probe=await cancellable(physical(executeJavaScript(`(async()=>{const links=[...document.querySelectorAll('.doc button[data-streamdown="link"]')],button=links[${index}];if(!(button instanceof HTMLButtonElement))return null;button.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const modal=document.querySelector('[data-streamdown="link-safety-modal"]');if(!(modal instanceof HTMLElement))return null;const target=[...modal.querySelectorAll('div')].find(element=>element.classList.contains('break-all'))?.textContent?.trim()??'',targetElement=[...modal.querySelectorAll('div')].find(element=>element.classList.contains('break-all')),rect=targetElement?.getBoundingClientRect(),style=targetElement?getComputedStyle(targetElement):null,visible=!!targetElement&&!!rect&&rect.width>0&&rect.height>0&&style?.display!=='none'&&style?.visibility!=='hidden'&&Number(style?.opacity)>0;const buttons=[...modal.querySelectorAll('button')],open=buttons.at(-1);if(!(open instanceof HTMLButtonElement))return null;open.click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {target,visible,closed:!document.querySelector('[data-streamdown="link-safety-modal"]')};})()`)))}finally{linkProbeActive=false}const popup=popupTargets[before];if(!object(probe)||typeof probe.target!=='string'||probe.visible!==true||probe.closed!==true||popupTargets.length!==before+1||!popup||popup.url!==probe.target||popup.disposition!=='foreground-tab'||!popup.features.split(',').map(value=>value.trim().toLowerCase()).includes('noreferrer'))throw Error('AgentDrop 原生安全链接核验失败');const source=withProtected.protectedLinks[index];protectedProofs.push({source:'streamdown_safety_button',href:popup.url,rel:['noreferrer'],text:source.text,visible:source.visible})}const {protectedLinks:_,...publicResult}=withProtected;const image=await cancellable(physical(capturePage())),screenshotPng=image.toPNG();if(screenshotPng.byteLength<100)throw Error('AgentDrop 原生截图无效');return {...publicResult,links:[...publicResult.links,...protectedProofs],responseRobots:[...responseRobots],nativeRequests:[...nativeRequests],blockedAnalyticsRequests,readOnlyQuery:queryProof,contentRequestUrl,screenshotPng}}}
      await new Promise<void>((resolve,reject)=>{let timer:ReturnType<typeof setTimeout>;const cancel=()=>{clearTimeout(timer);reject(Error('AgentDrop 原生核验已取消'))};timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve()},pollIntervalMs);signal.addEventListener('abort',cancel,{once:true})});
    }
    fail('AgentDrop 原生正文未在时限内出现','dom_timeout');throw Error(violation);
  }catch(error){if(!failureRecorded)fail('AgentDrop 原生核验失败',signal.aborted?'aborted':phase==='initial_clear'?'storage_clear_failed':phase==='load'?'load_failed':phase==='capture'?'capture_failed':'dom_timeout');throw error}
  finally{
    phase='cleanup';signal.removeEventListener('abort',stop);try{if(relaySocket&&relaySocket.readyState<2)relaySocket.close(1000,'verification complete')}catch{}let timer:ReturnType<typeof setTimeout>|undefined;const cleanup=Promise.all([relayLifecycle??Promise.resolve(),...clearSession().map(operation=>physical(operation))]).then(()=>'complete' as const,()=>'failed' as const);const cleanupResult=await Promise.race([cleanup,new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),cleanupTimeoutMs);timer.unref?.()})]);if(timer)clearTimeout(timer);if(debuggerApi.isAttached())debuggerApi.detach();if(!win.isDestroyed())win.destroy();record({version:1,kind:'cleanup',phase,cleanupResult});if(cleanupResult!=='complete'&&!failureRecorded&&!signal.aborted){fail('AgentDrop 原生会话清理失败','cleanup_failed');throw Error(violation)}
  }
}

export function renderAgentDropPage(url:string,signal:AbortSignal,hooks:AgentDropRendererHooks={}):Promise<AgentDropRenderedPage>{return renderWithContract(url,signal,AGENTDROP_PRODUCTION_RENDERER_CONTRACT,hooks)}
export const agentdropRendererTesting={renderWithContract};
