import {createHash} from 'node:crypto';
import {markdownPasteTopLevelKeys} from './markdownpaste';

export const SLUGPOST_ORIGIN='https://slugpost.com';
export const SLUGPOST_EDITOR=`${SLUGPOST_ORIGIN}/publish`;
export const SLUGPOST_SLUG=/^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/;
const HASH=/^[a-f0-9]{64}$/;
const OP=/^slugpost_[a-f0-9]{32}$/;
const TOKEN=/^[A-Za-z0-9_-]{8,512}$/;
export const slugPostHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export interface SlugPostIntent {operationId:string;slug:string;sourceHash:string;requestHash:string;createdAt:string}
export type SlugPostBoundaryStage='armed'|'click_started'|'dispatch_allowed'|'dispatch_denied'|'click_error'|'capture_error';
export interface SlugPostUploadShape {chunks:number;parts:Array<{keys:string[];bytesTag:string;byteLength?:number;type?:string}>}
export interface SlugPostBoundaryEvent {sequence:number;stage:SlugPostBoundaryStage;at:string;requestHash:string;reason?:'authorization'|'body'|'duplicate'|'evidence'|'script'|'capture';uploadShape?:SlugPostUploadShape}
export interface SlugPostOpaqueResponse extends SlugPostIntent {version:1;kind:'slugpost_ui_response';status:number;mimeType:string;url:string;bodyBase64:string;bodySha256:string}
export interface SlugPostReceipt extends SlugPostIntent {publicUrl:string;editToken:string}
export interface SlugPostPersistence {
  persistIntent(value:SlugPostIntent):Promise<void>;
  assertReadyToSubmit(value:SlugPostIntent):true;
  persistBoundary(value:SlugPostBoundaryEvent):void;
  persistOpaqueResponse(value:SlugPostOpaqueResponse):Promise<void>;
  loadOpaqueResponse():Promise<SlugPostOpaqueResponse|undefined>;
  promoteReceipt(value:SlugPostReceipt):Promise<void>;
}
export function validSlugPostBoundaryEvent(value:SlugPostBoundaryEvent,intent:SlugPostIntent,previous:SlugPostBoundaryEvent[]=[]):boolean{
  if(!Number.isInteger(value.sequence)||value.sequence!==previous.length+1||previous.length>=16||!Number.isFinite(Date.parse(value.at))||new Date(value.at).toISOString()!==value.at||value.requestHash!==intent.requestHash||!['armed','click_started','dispatch_allowed','dispatch_denied','click_error','capture_error'].includes(value.stage))return false;
  if(value.reason!==undefined&&!['authorization','body','duplicate','evidence','script','capture'].includes(value.reason))return false;
  if(value.uploadShape&&(value.uploadShape.chunks<0||!Number.isInteger(value.uploadShape.chunks)||value.uploadShape.parts.length>16||value.uploadShape.parts.some(part=>part.keys.length>8||part.keys.some(key=>key.length>40)||part.bytesTag.length>80||part.byteLength!==undefined&&(!Number.isInteger(part.byteLength)||part.byteLength<0||part.byteLength>20*1024*1024)||part.type!==undefined&&part.type.length>80)))return false;
  if(value.stage==='armed')return previous.length===0;
  if(!previous.some(event=>event.stage==='armed'))return false;
  if(value.stage==='click_started')return !previous.some(event=>event.stage==='click_started');
  if(['dispatch_allowed','dispatch_denied','click_error','capture_error'].includes(value.stage)&&!previous.some(event=>event.stage==='click_started'))return false;
  return value.stage!=='dispatch_allowed'||!previous.some(event=>event.stage==='dispatch_allowed');
}
export function slugPostPublicUrl(slug:string){if(!SLUGPOST_SLUG.test(slug))throw Error('SlugPost slug 无效');return `${SLUGPOST_ORIGIN}/${slug}`}
export function slugPostRequest(content:string,slug:string){const body=JSON.stringify({content,slug,format:'markdown',domain:''});return {body,sourceHash:slugPostHash(content),requestHash:slugPostHash(body)}}
export function validSlugPostIntent(value:SlugPostIntent){return OP.test(value.operationId)&&SLUGPOST_SLUG.test(value.slug)&&HASH.test(value.sourceHash)&&HASH.test(value.requestHash)&&Number.isFinite(Date.parse(value.createdAt))&&new Date(value.createdAt).toISOString()===value.createdAt}
export function sameSlugPostIntent(a:SlugPostIntent,b:SlugPostIntent){return a.operationId===b.operationId&&a.slug===b.slug&&a.sourceHash===b.sourceHash&&a.requestHash===b.requestHash&&a.createdAt===b.createdAt}
export function slugPostOpaqueValid(value:SlugPostOpaqueResponse){if(value.version!==1||value.kind!=='slugpost_ui_response'||!validSlugPostIntent(value)||!Number.isInteger(value.status)||value.status<100||value.status>599||value.mimeType.length>128||value.url!==`${SLUGPOST_ORIGIN}/publish`||!HASH.test(value.bodySha256)||value.bodyBase64.length>90_000)return false;const bytes=Buffer.from(value.bodyBase64,'base64');return bytes.length<=64*1024&&bytes.toString('base64')===value.bodyBase64&&slugPostHash(bytes)===value.bodySha256}
export function parseSlugPostOpaque(value:SlugPostOpaqueResponse,intent:SlugPostIntent,content:string):SlugPostReceipt|undefined{
  if(!slugPostOpaqueValid(value)||!sameSlugPostIntent(value,intent)||slugPostRequest(content,intent.slug).sourceHash!==intent.sourceHash||slugPostRequest(content,intent.slug).requestHash!==intent.requestHash||![200,201].includes(value.status)||value.mimeType.split(';',1)[0].trim().toLowerCase()!=='application/json')return;
  let json:unknown;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(value.bodyBase64,'base64'));const keys=markdownPasteTopLevelKeys(text);if(!keys||new Set(keys).size!==keys.length)return;json=JSON.parse(text)}catch{return}
  if(!json||typeof json!=='object'||Array.isArray(json))return;
  const response=json as Record<string,unknown>;
  if(response.success!==true||response.slug!==intent.slug||typeof response.edit_token!=='string'||!TOKEN.test(response.edit_token))return;
  return {...intent,publicUrl:slugPostPublicUrl(intent.slug),editToken:response.edit_token};
}
export function slugPostOpaqueFromCapture(intent:SlugPostIntent,capture:{status:number;mimeType:string;url:string;body:string;base64Encoded:boolean}):SlugPostOpaqueResponse|undefined{
  if(capture.url!==`${SLUGPOST_ORIGIN}/publish`||capture.body.length>90_000)return;
  const bytes=capture.base64Encoded?Buffer.from(capture.body,'base64'):Buffer.from(capture.body,'utf8');
  const value:SlugPostOpaqueResponse={...intent,version:1,kind:'slugpost_ui_response',status:capture.status,mimeType:capture.mimeType,url:capture.url,bodyBase64:bytes.toString('base64'),bodySha256:slugPostHash(bytes)};
  return slugPostOpaqueValid(value)?value:undefined;
}
