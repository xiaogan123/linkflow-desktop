import type {BrowserWindow as ElectronWindow,Session} from 'electron';
import {createHash,randomUUID} from 'node:crypto';
import {SLUGPOST_EDITOR,SLUGPOST_ORIGIN,slugPostOpaqueFromCapture,slugPostRequest,type SlugPostBoundaryEvent,type SlugPostBoundaryStage,type SlugPostIntent,type SlugPostOpaqueResponse,type SlugPostPersistence,type SlugPostUploadShape} from './slugpost';

type Window=ElectronWindow;
export type {SlugPostBoundaryEvent,SlugPostBoundaryStage,SlugPostUploadShape} from './slugpost';
export interface SlugPostBrowserDependencies {createWindow?:(persistBoundary:(event:SlugPostBoundaryEvent)=>void)=>Promise<Window>;timeoutMs?:number;signal?:AbortSignal;onBoundaryEvent?:(event:SlugPostBoundaryEvent)=>void}
const HOST='slugpost.com';
function safeUrl(value:string){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname===HOST&&!url.username&&!url.password&&(!url.port||url.port==='443')}catch{return false}}
export function guardSession(browserSession:Session,onBoundaryEvent?:(event:SlugPostBoundaryEvent)=>void){
  let authorization:(()=>boolean)|undefined,expectedBody:Buffer|undefined,requestHash='',publishRequests=0,sequence=0;
  const record=(stage:SlugPostBoundaryStage,reason?:SlugPostBoundaryEvent['reason'],uploadShape?:SlugPostUploadShape)=>{if(!onBoundaryEvent)throw Error('SlugPost 派发证据保存未配置');onBoundaryEvent({sequence:++sequence,stage,at:new Date().toISOString(),requestHash,...(reason?{reason}:{}),...(uploadShape?{uploadShape}:{})})};
  browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  browserSession.setPermissionCheckHandler(()=>false);
  browserSession.on('will-download',event=>event.preventDefault());
  browserSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    const publishing=details.method==='POST'&&details.url===`${SLUGPOST_ORIGIN}/publish`;
    let allowed=safeUrl(details.url)&&(details.method==='GET'||details.method==='HEAD');
    if(publishing&&safeUrl(details.url)&&publishRequests===0&&expectedBody&&authorization){
      const chunks=details.uploadData;
      const rawBytes=(value:unknown)=>{try{
        if(ArrayBuffer.isView(value))return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
        if(Object.prototype.toString.call(value)==='[object ArrayBuffer]')return Buffer.from(new Uint8Array(value as ArrayBuffer));
      }catch{/* Invalid native upload representations stay denied. */}return undefined};
      const validChunks=!!chunks?.length&&chunks.every(item=>!!rawBytes(item.bytes)&&Object.entries(item).every(([key,value])=>key==='bytes'||(key==='type'&&value==='rawData')||value===undefined));
      const bytes=validChunks?chunks!.map(item=>rawBytes(item.bytes)!):[];
      const body=validChunks&&bytes.reduce((total,item)=>total+item.length,0)===expectedBody.length?Buffer.concat(bytes):undefined;
      let reason:SlugPostBoundaryEvent['reason']=body&&body.equals(expectedBody)?'authorization':'body';
      try{allowed=!!body&&body.equals(expectedBody)&&authorization()===true}catch{allowed=false}
      if(allowed){try{record('dispatch_allowed');publishRequests++}catch{allowed=false;reason='evidence'}}
      if(!allowed)try{record('dispatch_denied',reason,body?undefined:{chunks:chunks?.length??0,parts:(chunks??[]).map(item=>{const value=item.bytes as unknown;const byteLength=value&&typeof value==='object'&&'byteLength' in value&&typeof value.byteLength==='number'?value.byteLength:undefined;const typeValue=(item as unknown as {type?:unknown}).type,type=typeof typeValue==='string'?typeValue:undefined;return {keys:Object.keys(item).sort(),bytesTag:Object.prototype.toString.call(value),...(byteLength===undefined?{}:{byteLength}),...(type?{type}:{})}})})}catch{/* Request remains canceled. */}
    }else if(publishing&&requestHash){try{record('dispatch_denied',publishRequests?'duplicate':'authorization')}catch{/* Request remains canceled. */}}
    callback({cancel:!allowed});
  });
  return (body:Buffer,check:()=>boolean,hash=createHash('sha256').update(body).digest('hex'))=>{if(expectedBody||publishRequests)throw Error('SlugPost 发布请求已布防');if(!/^[a-f0-9]{64}$/.test(hash))throw Error('SlugPost 请求校验值无效');requestHash=hash;record('armed');expectedBody=Buffer.from(body);authorization=check};
}
const armPublish=new WeakMap<Window,(body:Buffer,check:()=>boolean,requestHash?:string)=>void>();
/** Bind the exact session guard for injected/native test windows. */
export function bindSlugPostWindowGuard(window:Window,arm:(body:Buffer,check:()=>boolean,requestHash?:string)=>void){if(armPublish.has(window))throw Error('SlugPost 窗口已绑定发布守卫');armPublish.set(window,arm)}
export async function createSlugPostWindow(onBoundaryEvent?:(event:SlugPostBoundaryEvent)=>void):Promise<Window>{
  const {BrowserWindow,session}=await import('electron');
  const partition=`slugpost-${randomUUID()}`;const browserSession=session.fromPartition(partition,{cache:false});const arm=guardSession(browserSession,onBoundaryEvent);
  const window=new BrowserWindow({width:1160,height:850,show:false,title:'外链助手 · SlugPost',webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!safeUrl(url))event.preventDefault()});
  window.webContents.on('did-navigate',(_event,url)=>{if(!safeUrl(url))window.webContents.stop()});
  bindSlugPostWindowGuard(window,arm);
  return window;
}
function bounded<T>(promise:Promise<T>,ms:number):Promise<T>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),ms);timer.unref?.();void promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})})}
const inspectScript=`(()=>{if(location.origin!=='https://slugpost.com'||location.pathname!=='/publish')return {ok:false,locationOk:false};const content=document.querySelector('textarea#content'),slug=document.querySelector('input#slug');const buttons=[...document.querySelectorAll('button')];const publish=buttons.filter(x=>x.textContent?.trim()==='Publish Post');const text=document.body?.innerText?.slice(0,5000)??'';return {ok:content instanceof HTMLTextAreaElement&&slug instanceof HTMLInputElement&&publish.length===1,challenge:/captcha|verify you are human|cloudflare|too many requests|rate limit|sign in to publish/i.test(text)}})()`;
const fillScript=(content:string,slug:string)=>`((content,slug)=>{if(location.origin!=='https://slugpost.com'||location.pathname!=='/publish')return false;const area=document.querySelector('textarea#content'),input=document.querySelector('input#slug');if(!(area instanceof HTMLTextAreaElement)||!(input instanceof HTMLInputElement))return false;const set=(element,value,prototype)=>{const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;if(!setter)return false;setter.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true};return set(area,content,HTMLTextAreaElement.prototype)&&set(input,slug,HTMLInputElement.prototype)})(${JSON.stringify(content)},${JSON.stringify(slug)})`;
const readyScript=(content:string,slug:string)=>`((content,slug)=>{if(location.origin!=='https://slugpost.com'||location.pathname!=='/publish')return 'changed';const area=document.querySelector('textarea#content'),input=document.querySelector('input#slug'),buttons=[...document.querySelectorAll('button')].filter(x=>x.textContent?.trim()==='Publish Post');if(!(area instanceof HTMLTextAreaElement)||!(input instanceof HTMLInputElement)||area.value!==content||input.value!==slug||buttons.length!==1)return 'changed';if(/captcha|verify you are human|cloudflare|too many requests|rate limit|sign in to publish/i.test(document.body?.innerText??''))return 'challenge';return buttons[0].disabled?'pending':'ready'})(${JSON.stringify(content)},${JSON.stringify(slug)})`;
const clickScript=(content:string,slug:string)=>`((content,slug)=>{if(location.origin!=='https://slugpost.com'||location.pathname!=='/publish')return false;const area=document.querySelector('textarea#content'),input=document.querySelector('input#slug'),buttons=[...document.querySelectorAll('button')].filter(x=>x.textContent?.trim()==='Publish Post');if(area?.value!==content||input?.value!==slug||buttons.length!==1||buttons[0].disabled||/captcha|verify you are human|cloudflare|too many requests|rate limit|sign in to publish/i.test(document.body?.innerText??''))return false;buttons[0].click();return true})(${JSON.stringify(content)},${JSON.stringify(slug)})`;
function waitForEditor(ms:number,signal?:AbortSignal){return new Promise<void>(resolve=>{if(signal?.aborted){resolve();return}const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,ms);signal?.addEventListener('abort',done,{once:true})})}

/** Official editor interaction only. CDP observes the page's own fetch; no separate API POST is issued. */
export async function submitSlugPostUi(input:{intent:SlugPostIntent;content:string},persistence:SlugPostPersistence,deps:SlugPostBrowserDependencies={}):Promise<{status:'not_started'|'unknown'|'captured';opaque?:SlugPostOpaqueResponse;reason?:string}>{
  const timeout=Math.max(1000,Math.min(deps.timeoutMs??30_000,60_000));let window:Window|undefined,clickInvoked=false,boundarySequence=0;
  if(typeof persistence.persistBoundary!=='function')return {status:'not_started',reason:'evidence_unavailable'};
  const persistBoundary=(event:SlugPostBoundaryEvent)=>{const durable={...event,sequence:++boundarySequence};persistence.persistBoundary(durable);deps.onBoundaryEvent?.(durable)};
  const record=(stage:SlugPostBoundaryStage,reason?:SlugPostBoundaryEvent['reason'])=>persistBoundary({sequence:0,stage,at:new Date().toISOString(),requestHash:input.intent.requestHash,...(reason?{reason}:{})});
  try{
    if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
    window=await (deps.createWindow?.(persistBoundary)??createSlugPostWindow(persistBoundary));
    const web=window.webContents;
    await bounded(window.loadURL(SLUGPOST_EDITOR),timeout);
    if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
    if(!web.debugger.isAttached())web.debugger.attach('1.3');
    await bounded(web.debugger.sendCommand('Network.enable',{maxResourceBufferSize:128*1024,maxTotalBufferSize:512*1024}),timeout);
    // Navigation completes before this client-rendered editor has necessarily hydrated.
    // Inspect without arming or clicking, and stop at the first challenge or cancellation.
    const editorDeadline=Date.now()+Math.min(timeout,10_000);
    while(true){
      if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
      if(window.isDestroyed())return {status:'not_started',reason:'editor_changed'};
      const remaining=editorDeadline-Date.now();
      if(remaining<=0)return {status:'not_started',reason:'editor_loading_timeout'};
      const preflight=await bounded(web.executeJavaScriptInIsolatedWorld(999,[{code:inspectScript}]),remaining) as {ok?:boolean;challenge?:boolean;locationOk?:boolean}|undefined;
      if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
      if(!preflight||preflight.locationOk===false)return {status:'not_started',reason:'editor_changed'};
      if(preflight.challenge)return {status:'not_started',reason:'editor_unavailable_or_challenge'};
      if(preflight.ok===true)break;
      await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,editorDeadline-Date.now()))));
    }
    const filled=await bounded(web.executeJavaScriptInIsolatedWorld(999,[{code:fillScript(input.content,input.intent.slug)}]),timeout);
    if(filled!==true)return {status:'not_started',reason:'editor_changed'};
    // The official editor debounces slug validation and then waits for a GET before enabling Publish.
    // Poll the complete form state without arming; any changed field or challenge is terminal.
    const readyDeadline=Date.now()+Math.min(timeout,10_000),script=readyScript(input.content,input.intent.slug);
    while(true){
      if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
      if(window.isDestroyed())return {status:'not_started',reason:'editor_changed'};
      const remaining=readyDeadline-Date.now();if(remaining<=0)return {status:'not_started',reason:'editor_not_ready'};
      const state=await bounded(web.executeJavaScriptInIsolatedWorld(999,[{code:script}]),remaining);
      if(deps.signal?.aborted)return {status:'not_started',reason:'authorization_changed'};
      if(window.isDestroyed()||state==='changed')return {status:'not_started',reason:'editor_changed'};
      if(state==='challenge')return {status:'not_started',reason:'editor_unavailable_or_challenge'};
      if(state==='ready')break;
      if(state!=='pending')return {status:'not_started',reason:'editor_changed'};
      await waitForEditor(Math.max(1,Math.min(100,readyDeadline-Date.now())),deps.signal);
    }
    try{if(persistence.assertReadyToSubmit(input.intent)!==true)return {status:'not_started',reason:'authorization_changed'}}catch{return {status:'not_started',reason:'authorization_changed'}}
    let requestId:string|undefined,status:number|undefined,mimeType:string|undefined,requestCount=0,resolveCapture:(v:SlugPostOpaqueResponse|undefined)=>void=()=>{};
    const captured=new Promise<SlugPostOpaqueResponse|undefined>(resolve=>{resolveCapture=resolve});let settled=false;
    const finish=(value:SlugPostOpaqueResponse|undefined)=>{if(settled)return;settled=true;resolveCapture(value)};
    const onMessage=(_event:unknown,method:string,params:Record<string,unknown>)=>{
      if(method==='Network.requestWillBeSent'){
        const request=params.request as {url?:string;method?:string}|undefined;
        if(request?.url===`${SLUGPOST_ORIGIN}/publish`&&request.method==='POST'){requestCount++;if(requestCount===1)requestId=String(params.requestId);else finish(undefined)}
      }
      if(params.requestId!==requestId)return;
      if(method==='Network.responseReceived'){
        const response=params.response as {url?:string;status?:number;mimeType?:string}|undefined;
        if(response?.url===`${SLUGPOST_ORIGIN}/publish`){status=response.status;mimeType=response.mimeType}
      }
      if(method==='Network.loadingFailed')finish(undefined);
      if(method==='Network.loadingFinished')void (async()=>{
        try{const body=await web.debugger.sendCommand('Network.getResponseBody',{requestId}) as {body:string;base64Encoded:boolean};
          const opaque=slugPostOpaqueFromCapture(input.intent,{status:status??0,mimeType:mimeType??'',url:`${SLUGPOST_ORIGIN}/publish`,body:body.body,base64Encoded:body.base64Encoded});
          if(!opaque){record('capture_error','capture');finish(undefined);return}await persistence.persistOpaqueResponse(opaque);finish(opaque);
        }catch{record('capture_error','capture');finish(undefined)}
      })();
    };
    web.debugger.on('message',onMessage);
    if(deps.signal?.aborted){web.debugger.removeListener('message',onMessage);return {status:'not_started',reason:'authorization_changed'}}
    const authorize=()=>{if(deps.signal?.aborted)return false;try{return persistence.assertReadyToSubmit(input.intent)===true}catch{return false}};
    const expectedBody=Buffer.from(slugPostRequest(input.content,input.intent.slug).body,'utf8');
    const arm=armPublish.get(window);if(arm)arm(expectedBody,authorize,input.intent.requestHash);else record('armed');
    record('click_started');clickInvoked=true;
    let clicked=false;try{clicked=await bounded(web.executeJavaScriptInIsolatedWorld(999,[{code:clickScript(input.content,input.intent.slug)}]),timeout)===true}catch{record('click_error','script');clicked=false}
    if(!clicked&&requestCount===0){web.debugger.removeListener('message',onMessage);return {status:'unknown',reason:'click_not_confirmed'}}
    // A pending UI request may finish after the visible task times out. Keep this isolated
    // window and its receipt collector alive for one bounded drain before closing it.
    const opaque=await Promise.race([captured,new Promise<undefined>(resolve=>{const timer=setTimeout(()=>resolve(undefined),timeout+30_000);timer.unref?.()})]);
    web.debugger.removeListener('message',onMessage);
    return opaque?{status:'captured',opaque}:{status:'unknown',reason:'response_unavailable'};
  }catch{return {status:clickInvoked?'unknown':'not_started',reason:'browser_error'}}finally{if(window&&!window.isDestroyed())window.destroy()}
}
