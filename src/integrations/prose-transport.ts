import {createHash,timingSafeEqual} from 'node:crypto';
import ssh2,{type Client as SSHClient,type ConnectConfig,type SFTPWrapper} from 'ssh2';

const {Client,utils}=ssh2;

const SSH_USERNAME='user';
const IDENTITY_COMMAND='user';
const DEFAULT_TIMEOUT_MS=15_000;
const MAX_TIMEOUT_MS=60_000;
const MAX_IDENTITY_BYTES=8*1024;
const MAX_SOURCE_BYTES=512*1024;
const MAX_PRIVATE_KEY_BYTES=64*1024;

const PRODUCTION_ENDPOINTS={
  identity:{host:'pico.sh',port:22,hostKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDhNdE5o9C6OUrlmxyzxQONng2sLbmqIuxXAw9m2gSLL'},
  content:{host:'prose.sh',port:22,hostKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdtNpyOTcBA6cH0G2keeF+bxT4TFJl/px2qLjAQaoFN'},
} as const;

const RESERVED_FILENAMES=new Set([
  '404.md','index.md','readme.md','robots.md','settings.md','_footer.md','_readme.md','_styles.md',
]);

export type ProseTransportErrorCode=
  |'aborted'|'authentication_failed'|'connection_failed'|'credentials_invalid'
  |'host_key_mismatch'|'identity_mismatch'|'identity_not_registered'|'identity_response_invalid'
  |'invalid_filename'|'invalid_source'|'not_found'|'permission_denied'|'remote_failure'
  |'response_too_large'|'timeout'|'write_outcome_unknown';

export class ProseTransportError extends Error{
  constructor(readonly code:ProseTransportErrorCode){
    super(code);this.name='ProseTransportError';
  }
}

export interface ProseCredentials{
  privateKey:string|Buffer;
  passphrase?:string|Buffer;
}

export interface ProseOperationOptions{
  signal?:AbortSignal;
  timeoutMs?:number;
}

export interface ProseIdentity{
  name:string;
  id:string;
  createdAt:string;
  plusExpiresAt:string|null;
  keyFingerprint:string;
  /** The `user` command does not expose invitation state. */
  publishingEligibility:'unknown';
}

export interface ExpectedProseIdentity{
  name:string;
  id:string;
  keyFingerprint:string;
}

export type ProseSourceResult=
  |{status:'found';filename:string;source:string;bytes:number;sha256:string}
  |{status:'missing';filename:string};

export interface ProseWriteReceipt{
  /** This is an SFTP acknowledgement, not proof that a public article is live. */
  status:'written';
  filename:string;
  bytes:number;
  sha256:string;
  identity:ExpectedProseIdentity;
}

export interface ProseTransport{
  readIdentity(credentials:ProseCredentials,options?:ProseOperationOptions):Promise<ProseIdentity>;
  readSource(credentials:ProseCredentials,filename:string,expected:ExpectedProseIdentity,options?:ProseOperationOptions):Promise<ProseSourceResult>;
  writeSource(credentials:ProseCredentials,filename:string,approvedText:string,expected:ExpectedProseIdentity,options?:ProseOperationOptions):Promise<ProseWriteReceipt>;
}

interface Endpoint{host:string;port:number;hostKey:string}
interface TransportEndpoints{identity:Endpoint;content:Endpoint}

/** Local protocol fixtures only. Production callers must use createProseTransport(). */
export interface ProseTransportTestOverrides{identity:Endpoint;content:Endpoint}

function error(code:ProseTransportErrorCode,cause?:unknown):ProseTransportError{
  void cause;
  return new ProseTransportError(code);
}

function toBuffer(value:string|Buffer):Buffer{return Buffer.isBuffer(value)?value:Buffer.from(value,'utf8')}

function snapshotCredentials(credentials:ProseCredentials):ProseCredentials{
  return {
    privateKey:Buffer.isBuffer(credentials.privateKey)?Buffer.from(credentials.privateKey):credentials.privateKey,
    passphrase:Buffer.isBuffer(credentials.passphrase)?Buffer.from(credentials.passphrase):credentials.passphrase,
  };
}

function snapshotExpectedIdentity(identity:ExpectedProseIdentity):ExpectedProseIdentity{
  return {name:identity.name,id:identity.id,keyFingerprint:identity.keyFingerprint};
}

function parsedPrivateKey(credentials:ProseCredentials):{key:string|Buffer;fingerprint:string}{
  const keyBytes=toBuffer(credentials.privateKey);
  const passphraseBytes=credentials.passphrase===undefined?undefined:toBuffer(credentials.passphrase);
  if(keyBytes.length===0||keyBytes.length>MAX_PRIVATE_KEY_BYTES||passphraseBytes&&passphraseBytes.length>4096){
    throw error('credentials_invalid');
  }
  const parsed=utils.parseKey(credentials.privateKey,credentials.passphrase);
  if(parsed instanceof Error)throw error('credentials_invalid',parsed);
  const digest=createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/,'');
  return {key:credentials.privateKey,fingerprint:`SHA256:${digest}`};
}

function parsedHostKey(value:string):Buffer{
  const parsed=utils.parseKey(value);
  if(parsed instanceof Error)throw new Error('Invalid built-in prose host key');
  return parsed.getPublicSSH();
}

function fixedTimeout(value:number|undefined):number{
  if(value===undefined)return DEFAULT_TIMEOUT_MS;
  if(!Number.isSafeInteger(value)||value<1||value>MAX_TIMEOUT_MS)throw error('remote_failure');
  return value;
}

function signalError(signal:AbortSignal):ProseTransportError{
  return error(signal.reason==='prose_transport_timeout'?'timeout':'aborted');
}

async function runOperation<T>(options:ProseOperationOptions|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const timeoutMs=fixedTimeout(options?.timeoutMs);
  const controller=new AbortController();
  const relay=()=>controller.abort('prose_transport_aborted');
  if(options?.signal?.aborted)relay();
  else options?.signal?.addEventListener('abort',relay,{once:true});
  const timer=setTimeout(()=>controller.abort('prose_transport_timeout'),timeoutMs);
  timer.unref?.();
  try{
    if(controller.signal.aborted)throw signalError(controller.signal);
    return await run(controller.signal);
  }finally{
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort',relay);
  }
}

function abortable<T>(signal:AbortSignal,start:(resolve:(value:T)=>void,reject:(reason:unknown)=>void)=>void):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const finish=(fn:(value:any)=>void,value:any)=>{if(settled)return;settled=true;signal.removeEventListener('abort',onAbort);fn(value)};
    const onAbort=()=>finish(reject,signalError(signal));
    if(signal.aborted){onAbort();return}
    signal.addEventListener('abort',onAbort,{once:true});
    try{start(value=>finish(resolve,value),reason=>finish(reject,reason))}catch(cause){finish(reject,cause)}
  });
}

function mapConnectionError(cause:unknown,hostMismatch=false):ProseTransportError{
  if(cause instanceof ProseTransportError)return cause;
  if(hostMismatch)return error('host_key_mismatch',cause);
  const level=typeof cause==='object'&&cause&&'level' in cause?String((cause as {level?:unknown}).level):'';
  if(level==='client-authentication')return error('authentication_failed',cause);
  return error('connection_failed',cause);
}

function mapSftpError(cause:unknown):ProseTransportError{
  if(cause instanceof ProseTransportError)return cause;
  const raw=typeof cause==='object'&&cause?(cause as {code?:unknown;errno?:unknown}):{};
  if(raw.code===2||raw.errno===2||raw.code==='ENOENT')return error('not_found',cause);
  if(raw.code===3||raw.errno===3||raw.code==='EACCES'||raw.code==='EPERM')return error('permission_denied',cause);
  return error('remote_failure',cause);
}

async function withClient<T>(endpoint:Endpoint,credentials:ProseCredentials,signal:AbortSignal,run:(client:SSHClient)=>Promise<T>):Promise<T>{
  const {key}=parsedPrivateKey(credentials);
  const expectedHostKey=parsedHostKey(endpoint.hostKey);
  const client=new Client();
  let hostMismatch=false;
  const onAbort=()=>client.destroy();
  signal.addEventListener('abort',onAbort,{once:true});
  try{
    await abortable<void>(signal,(resolve,reject)=>{
      client.once('ready',resolve);
      client.once('error',cause=>reject(mapConnectionError(cause,hostMismatch)));
      client.once('close',()=>reject(error('connection_failed')));
      const config:ConnectConfig={
        host:endpoint.host,port:endpoint.port,username:SSH_USERNAME,privateKey:key,
        passphrase:credentials.passphrase,readyTimeout:MAX_TIMEOUT_MS,timeout:MAX_TIMEOUT_MS,
        authHandler:['publickey'],tryKeyboard:false,agentForward:false,
        hostVerifier:(received:Buffer)=>{
          const matches=received.length===expectedHostKey.length&&timingSafeEqual(received,expectedHostKey);
          hostMismatch=!matches;return matches;
        },
      };
      client.connect(config);
    });
    return await abortable<T>(signal,(resolve,reject)=>{
      const fail=(cause:unknown)=>reject(mapConnectionError(cause,hostMismatch));
      client.once('error',fail);
      client.once('close',()=>fail(error('connection_failed')));
      void run(client).then(resolve,reject);
    });
  }finally{
    signal.removeEventListener('abort',onAbort);
    client.end();
    client.destroy();
  }
}

function appendBounded(chunks:Buffer[],chunk:Buffer|string,limit:number,total:{value:number}):void{
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  total.value+=bytes.length;
  if(total.value>limit)throw error('response_too_large');
  chunks.push(bytes);
}

function decodeUtf8(chunks:Buffer[]):string{
  try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))}
  catch(cause){throw error('identity_response_invalid',cause)}
}

function validRfc3339(value:string):boolean{
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
}

function parseIdentity(stdout:Buffer[],stderr:Buffer[],exitCode:number|undefined,fingerprint:string):ProseIdentity{
  const out=decodeUtf8(stdout).replace(/\r\n/g,'\n');
  const err=decodeUtf8(stderr).replace(/\r\n/g,'\n');
  const combined=`${out}\n${err}`.toLowerCase();
  if(combined.includes('you need to create an account before using the remote cli')||combined.includes('must have username set')){
    throw error('identity_not_registered');
  }
  if(exitCode!==undefined&&exitCode!==0)throw error('remote_failure');
  const withoutFinalNewline=out.endsWith('\n')?out.slice(0,-1):out;
  const lines=withoutFinalNewline.split('\n');
  if(lines.length!==4)throw error('identity_response_invalid');
  const [name,id,createdAt,plusExpiresAt]=lines;
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)||
     !/^[\x21-\x7e]{1,128}$/.test(id)||!validRfc3339(createdAt)||plusExpiresAt!==''&&!validRfc3339(plusExpiresAt)){
    throw error('identity_response_invalid');
  }
  return {name,id,createdAt,plusExpiresAt:plusExpiresAt||null,keyFingerprint:fingerprint,publishingEligibility:'unknown'};
}

async function execIdentity(client:SSHClient,signal:AbortSignal,fingerprint:string):Promise<ProseIdentity>{
  return abortable<ProseIdentity>(signal,(resolve,reject)=>{
    client.exec(IDENTITY_COMMAND,(execError,channel)=>{
      if(execError){reject(error('remote_failure',execError));return}
      const stdout:Buffer[]=[],stderr:Buffer[]=[];
      const outBytes={value:0},errBytes={value:0};
      let exitCode:number|undefined;
      const fail=(cause:unknown)=>{channel.destroy();reject(cause instanceof ProseTransportError?cause:error('remote_failure',cause))};
      channel.on('data',(chunk:Buffer|string)=>{try{appendBounded(stdout,chunk,MAX_IDENTITY_BYTES,outBytes)}catch(cause){fail(cause)}});
      channel.stderr.on('data',(chunk:Buffer|string)=>{try{appendBounded(stderr,chunk,MAX_IDENTITY_BYTES,errBytes)}catch(cause){fail(cause)}});
      channel.on('exit',(code:number|undefined)=>{exitCode=code});
      channel.once('error',fail);
      channel.once('close',()=>{try{resolve(parseIdentity(stdout,stderr,exitCode,fingerprint))}catch(cause){reject(cause)}});
    });
  });
}

function assertExpected(actual:ProseIdentity,expected:ExpectedProseIdentity):void{
  if(actual.id!==expected.id||actual.name!==expected.name||actual.keyFingerprint!==expected.keyFingerprint){
    throw error('identity_mismatch');
  }
}

function validatedFilename(filename:string):string{
  if(filename.length>80||!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.md$/.test(filename)||RESERVED_FILENAMES.has(filename)){
    throw error('invalid_filename');
  }
  return `/${filename}`;
}

function encodedSource(source:string):Buffer{
  if(source.length===0||source.includes('\0'))throw error('invalid_source');
  for(let index=0;index<source.length;index++){
    const code=source.charCodeAt(index);
    if(code>=0xd800&&code<=0xdbff){
      const next=source.charCodeAt(++index);if(!(next>=0xdc00&&next<=0xdfff))throw error('invalid_source');
    }else if(code>=0xdc00&&code<=0xdfff)throw error('invalid_source');
  }
  const bytes=Buffer.from(source,'utf8');
  if(bytes.length>MAX_SOURCE_BYTES)throw error('invalid_source');
  return bytes;
}

async function openSftp(client:SSHClient,signal:AbortSignal):Promise<SFTPWrapper>{
  return abortable(signal,(resolve,reject)=>client.sftp((cause:Error|undefined,sftp:SFTPWrapper)=>cause?reject(error('remote_failure',cause)):resolve(sftp)));
}

async function readRemoteSource(client:SSHClient,path:string,signal:AbortSignal):Promise<Buffer>{
  const sftp=await openSftp(client,signal);
  return abortable(signal,(resolve,reject)=>{
    const stream=sftp.createReadStream(path);
    const chunks:Buffer[]=[],total={value:0};
    stream.on('data',(chunk:Buffer|string)=>{
      try{appendBounded(chunks,chunk,MAX_SOURCE_BYTES,total)}catch(cause){stream.destroy();reject(cause)}
    });
    stream.once('error',(cause:Error)=>reject(mapSftpError(cause)));
    stream.once('end',()=>resolve(Buffer.concat(chunks)));
  });
}

interface WriteBoundary{requestIssued:boolean;explicitOpenPermissionDenied:boolean}

async function writeRemoteSource(client:SSHClient,path:string,source:Buffer,signal:AbortSignal,boundary:WriteBoundary):Promise<void>{
  const sftp=await openSftp(client,signal);
  let opened=false;
  try{
    await abortable<void>(signal,(resolve,reject)=>{
      const stream=sftp.createWriteStream(path,{flags:'w',mode:0o600,autoClose:true});
      boundary.requestIssued=true;
      stream.once('open',()=>{opened=true;stream.end(source)});
      stream.once('error',(cause:Error)=>{
        const mapped=mapSftpError(cause);
        if(mapped.code==='permission_denied'&&!opened){
          boundary.explicitOpenPermissionDenied=true;
          reject(mapped);
          return;
        }
        reject(error('write_outcome_unknown'));
      });
      stream.once('close',resolve);
    });
  }catch(cause){
    const mapped=mapSftpError(cause);
    if(boundary.requestIssued&&!boundary.explicitOpenPermissionDenied)throw error('write_outcome_unknown');
    throw mapped;
  }
}

class FixedProseTransport implements ProseTransport{
  constructor(private readonly endpoints:TransportEndpoints){}

  readIdentity(credentials:ProseCredentials,options?:ProseOperationOptions):Promise<ProseIdentity>{
    const credentialsSnapshot=snapshotCredentials(credentials);
    return runOperation(options,async signal=>{
      const {fingerprint}=parsedPrivateKey(credentialsSnapshot);
      return withClient(this.endpoints.identity,credentialsSnapshot,signal,client=>execIdentity(client,signal,fingerprint));
    });
  }

  readSource(credentials:ProseCredentials,filename:string,expected:ExpectedProseIdentity,options?:ProseOperationOptions):Promise<ProseSourceResult>{
    const credentialsSnapshot=snapshotCredentials(credentials);
    const expectedSnapshot=snapshotExpectedIdentity(expected);
    const path=validatedFilename(filename);
    return runOperation(options,async signal=>{
      const {fingerprint}=parsedPrivateKey(credentialsSnapshot);
      const identity=await withClient(this.endpoints.identity,credentialsSnapshot,signal,client=>execIdentity(client,signal,fingerprint));
      assertExpected(identity,expectedSnapshot);
      try{
        const bytes=await withClient(this.endpoints.content,credentialsSnapshot,signal,client=>readRemoteSource(client,path,signal));
        let source:string;
        try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch(cause){throw error('remote_failure',cause)}
        return {status:'found',filename,source,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
      }catch(cause){
        if(cause instanceof ProseTransportError&&cause.code==='not_found')return {status:'missing',filename};
        throw cause;
      }
    });
  }

  writeSource(credentials:ProseCredentials,filename:string,approvedText:string,expected:ExpectedProseIdentity,options?:ProseOperationOptions):Promise<ProseWriteReceipt>{
    const credentialsSnapshot=snapshotCredentials(credentials);
    const expectedSnapshot=snapshotExpectedIdentity(expected);
    const path=validatedFilename(filename);
    const source=encodedSource(approvedText);
    return runOperation(options,async signal=>{
      const {fingerprint}=parsedPrivateKey(credentialsSnapshot);
      const identity=await withClient(this.endpoints.identity,credentialsSnapshot,signal,client=>execIdentity(client,signal,fingerprint));
      assertExpected(identity,expectedSnapshot);
      const boundary:WriteBoundary={requestIssued:false,explicitOpenPermissionDenied:false};
      try{
        await withClient(this.endpoints.content,credentialsSnapshot,signal,client=>writeRemoteSource(client,path,source,signal,boundary));
      }catch(cause){
        if(boundary.requestIssued&&!boundary.explicitOpenPermissionDenied){
          if(cause instanceof ProseTransportError&&cause.code==='write_outcome_unknown')throw cause;
          throw error('write_outcome_unknown');
        }
        throw cause;
      }
      return {status:'written',filename,bytes:source.length,sha256:createHash('sha256').update(source).digest('hex'),identity:expectedSnapshot};
    });
  }
}

export function createProseTransport():ProseTransport{return new FixedProseTransport(PRODUCTION_ENDPOINTS)}

/** Local protocol fixtures only. This cannot be reached from the production factory. */
export function createProseTransportForTests(overrides:ProseTransportTestOverrides):ProseTransport{
  return new FixedProseTransport(overrides);
}
