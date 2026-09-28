import {createHash,createPublicKey,verify} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import type {UpdateAsset,UpdateManifest,UpdatePlatform} from '../shared/update-types';

export const UPDATE_MANIFEST_URL='https://github.com/xiaogan123/linkflow-desktop/releases/latest/download/linkflow-update.json';
export const UPDATE_SIGNATURE_URL='https://github.com/xiaogan123/linkflow-desktop/releases/latest/download/linkflow-update.json.sig';
const redirectHosts=new Set(['github.com','api.github.com','objects.githubusercontent.com','release-assets.githubusercontent.com']);
const versionPattern=/^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const timestampPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maximumAssetSize=1024*1024*1024;

export interface UpdateRequestOptions {request?:typeof fetch;signal?:AbortSignal;timeoutMs?:number;maxRedirects?:number}

export class UpdateError extends Error {override name='UpdateError'}
function updateError(message:string):Error{return new UpdateError(message)}
function allowedUrl(input:string):URL{
  let url:URL;try{url=new URL(input)}catch{throw updateError('更新地址无效')}
  if(url.protocol!=='https:'||url.username||url.password||url.port||!redirectHosts.has(url.hostname))throw updateError('更新下载跳转到了不可信地址');
  return url;
}
function linkedSignal(signal:AbortSignal|undefined,timeoutMs:number):AbortSignal{
  const timeout=AbortSignal.timeout(timeoutMs);return signal?AbortSignal.any([signal,timeout]):timeout;
}
export async function fetchWithPinnedRedirects(input:string,options:UpdateRequestOptions={}):Promise<Response>{
  const request=options.request??fetch,maxRedirects=options.maxRedirects??5,signal=linkedSignal(options.signal,options.timeoutMs??30_000);let url=allowedUrl(input);
  for(let redirects=0;;redirects++){
    const response=await request(url,{method:'GET',redirect:'manual',signal,headers:{Accept:'application/octet-stream','User-Agent':'Linkflow-Desktop-Updater'}});
    if(response.status<300||response.status>=400)return response;
    if(redirects>=maxRedirects)throw updateError('更新下载重定向过多');
    const location=response.headers.get('location');if(!location)throw updateError('更新下载重定向无效');await response.body?.cancel();url=allowedUrl(new URL(location,url).href);
  }
}
export async function readBounded(response:Response,maximum:number,signal?:AbortSignal):Promise<Buffer>{
  if(!response.ok)throw updateError(`更新服务返回 ${response.status}`);
  const declared=Number(response.headers.get('content-length')??'0');if(declared>maximum)throw updateError('更新响应过大');
  if(!response.body)throw updateError('更新响应为空');const reader=response.body.getReader(),chunks:Buffer[]=[];let total=0;
  try{for(;;){if(signal?.aborted)throw signal.reason;const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maximum)throw updateError('更新响应过大');chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
  return Buffer.concat(chunks,total);
}
function exactObject(value:unknown,keys:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key))}
function parseAsset(value:unknown,platform:UpdatePlatform,version:string):UpdateAsset{
  if(!exactObject(value,['url','size','sha256','format'])||typeof value.url!=='string'||typeof value.size!=='number'||typeof value.sha256!=='string'||typeof value.format!=='string')throw updateError('更新清单的安装包信息无效');
  const expectedFormat=platform==='darwin-arm64'?'zip':'nsis';
  if(!Number.isSafeInteger(value.size)||value.size<1||value.size>maximumAssetSize||!digestPattern.test(value.sha256)||value.format!==expectedFormat)throw updateError('更新清单的安装包信息无效');
  const url=allowedUrl(value.url),prefix=`/xiaogan123/linkflow-desktop/releases/download/v${version}/`;
  let fileName='';try{fileName=decodeURIComponent(url.pathname.slice(prefix.length))}catch{}if(url.hostname!=='github.com'||!url.pathname.startsWith(prefix)||!fileName||!/^[A-Za-z0-9._-]{1,200}$/.test(fileName)||url.search||url.hash)throw updateError('更新安装包不属于官方发布');
  return {url:url.href,size:value.size,sha256:value.sha256,format:expectedFormat};
}
export function parseUpdateManifest(bytes:Buffer):UpdateManifest{
  let value:unknown;try{value=JSON.parse(bytes.toString('utf8'))}catch{throw updateError('更新清单不是有效 JSON')}
  if(!exactObject(value,['schemaVersion','version','publishedAt','releaseNotes','assets'])||value.schemaVersion!==1||typeof value.version!=='string'||typeof value.publishedAt!=='string'||typeof value.releaseNotes!=='string'||!versionPattern.test(value.version)||value.releaseNotes.length>50_000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.releaseNotes)||!timestampPattern.test(value.publishedAt)||Number.isNaN(Date.parse(value.publishedAt))||!exactObject(value.assets,['darwin-arm64','win32-x64']))throw updateError('更新清单格式无效');
  const assets:UpdateManifest['assets']={};for(const platform of ['darwin-arm64','win32-x64'] as const){const asset=value.assets[platform];if(asset!==undefined)assets[platform]=parseAsset(asset,platform,value.version)}
  if(!Object.keys(assets).length)throw updateError('更新清单没有可用安装包');
  return {schemaVersion:1,version:value.version,publishedAt:new Date(value.publishedAt).toISOString(),releaseNotes:value.releaseNotes,assets};
}
export function verifyManifestSignature(bytes:Buffer,signatureText:Buffer,publicKey:string|Buffer|KeyObject):void{
  let signature:Buffer;try{const text=signatureText.toString('ascii').trim();if(!/^[A-Za-z0-9+/]{86}==$/.test(text))throw Error();signature=Buffer.from(text,'base64');if(signature.length!==64)throw Error()}catch{throw updateError('更新签名格式无效')}
  let key:KeyObject;try{key=typeof publicKey==='string'?createPublicKey(publicKey):Buffer.isBuffer(publicKey)?createPublicKey({key:publicKey,format:'der',type:'spki'}):publicKey}catch{throw updateError('应用未配置有效的更新验签公钥')}
  if(key.asymmetricKeyType!=='ed25519'||!verify(null,bytes,key,signature))throw updateError('更新清单签名验证失败');
}
export async function fetchVerifiedManifest(publicKey:string|Buffer|KeyObject,options:UpdateRequestOptions={}):Promise<{manifest:UpdateManifest;manifestBytes:Buffer;signature:Buffer}>{
  const [manifestResponse,signatureResponse]=await Promise.all([fetchWithPinnedRedirects(UPDATE_MANIFEST_URL,options),fetchWithPinnedRedirects(UPDATE_SIGNATURE_URL,options)]);
  const [manifestBytes,signature]=await Promise.all([readBounded(manifestResponse,1024*1024,options.signal),readBounded(signatureResponse,1024,options.signal)]);
  verifyManifestSignature(manifestBytes,signature,publicKey);return {manifest:parseUpdateManifest(manifestBytes),manifestBytes,signature};
}
export function compareVersions(left:string,right:string):number{
  if(!versionPattern.test(left)||!versionPattern.test(right))throw updateError('版本号无效');const a=left.split('.').map(Number),b=right.split('.').map(Number);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;return 0;
}
export function sha256Hex(data:Buffer):string{return createHash('sha256').update(data).digest('hex')}
