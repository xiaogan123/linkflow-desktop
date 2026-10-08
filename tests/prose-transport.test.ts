import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {inspect} from 'node:util';
import ssh2,{type AuthContext,type Connection,type ParsedKey,type PublicKeyAuthContext,type SFTPWrapper} from 'ssh2';
import type {ExpectedProseIdentity} from '../src/integrations/prose-transport';

type ProseTransportModule=typeof import('../src/integrations/prose-transport');
const bundledPath=process.env.PROSE_TRANSPORT_BUNDLE;
const proseTransportModule:ProseTransportModule=bundledPath
  ?createRequire(import.meta.url)(bundledPath) as ProseTransportModule
  :await import('../src/integrations/prose-transport');
const {createProseTransportForTests,ProseTransportError}=proseTransportModule;

const {Server,utils}=ssh2;
const STATUS={OK:0,EOF:1,NO_SUCH_FILE:2,PERMISSION_DENIED:3,FAILURE:4} as const;

function dynamicEd25519KeyPair():{private:string;public:string}{
  for(let attempt=0;attempt<8;attempt++){
    const pair=utils.generateKeyPairSync('ed25519');
    if(!(utils.parseKey(pair.private) instanceof Error)&&!(utils.parseKey(pair.public) instanceof Error))return pair;
  }
  throw new Error('Unable to generate a parseable dynamic Ed25519 fixture key');
}

interface FixtureOptions{
  identityOutput?:string;
  identityExitCode?:number;
  stallIdentity?:boolean;
  beforeIdentityExit?:()=>void;
  acceptAnyClientKey?:boolean;
  permissionRead?:boolean;
  permissionWrite?:boolean;
  dropAfterMutatingOpen?:boolean;
  dropAfterWrite?:boolean;
  stallAfterWrite?:boolean;
  permissionOnClose?:boolean;
}

class LoopbackProseFixture{
  readonly hostKeys=dynamicEd25519KeyPair();
  readonly clientKeys=dynamicEd25519KeyPair();
  readonly files=new Map<string,Buffer>();
  readonly options:FixtureOptions;
  connections=0;
  authentications=0;
  sftpSessions=0;
  writeOpenRequests=0;
  writeRequests=0;
  readonly authenticatedKeys:string[]=[];
  private readonly clients=new Set<Connection>();
  private readonly allowedClient:ParsedKey;
  private readonly server=new Server({hostKeys:[this.hostKeys.private]},client=>this.acceptClient(client));
  port=0;

  constructor(options:FixtureOptions={}){
    this.options=options;
    const allowedClient=utils.parseKey(this.clientKeys.public);
    if(allowedClient instanceof Error)throw allowedClient;
    this.allowedClient=allowedClient;
    this.server.on('error',()=>{});
  }

  async start():Promise<void>{
    this.server.listen(0,'127.0.0.1');
    await once(this.server,'listening');
    this.port=(this.server.address() as AddressInfo).port;
  }

  async close():Promise<void>{
    for(const client of this.clients)client.end();
    this.server.close();
    await once(this.server,'close');
  }

  transport(hostKey=this.hostKeys.public){
    const endpoint={host:'127.0.0.1',port:this.port,hostKey};
    return createProseTransportForTests({identity:endpoint,content:endpoint});
  }

  credentials(){return {privateKey:this.clientKeys.private}}

  private acceptClient(client:Connection):void{
    this.connections++;
    this.clients.add(client);
    client.on('error',()=>{});
    client.on('close',()=>this.clients.delete(client));
    client.on('authentication',(context:AuthContext)=>{
      this.authentications++;
      if(context.method!=='publickey'){context.reject(['publickey']);return}
      const publicKeyContext=context as PublicKeyAuthContext;
      if(publicKeyContext.key.data.equals(this.allowedClient.getPublicSSH())||this.options.acceptAnyClientKey){
        this.authenticatedKeys.push(publicKeyContext.key.data.toString('base64'));
        context.accept();
      }
      else context.reject(['publickey']);
    });
    client.on('ready',()=>{
      client.on('session',(accept)=>{
        const session=accept();
        session.on('exec',(acceptExec,reject,info)=>{
          if(info.command!=='user'){reject();return}
          const channel=acceptExec();
          if(this.options.stallIdentity)return;
          const output=this.options.identityOutput??'writer-one\nuser-123\n2026-01-02T03:04:05Z\n\n';
          channel.write(output);
          this.options.beforeIdentityExit?.();
          channel.exit(this.options.identityExitCode??0);
          channel.end();
        });
        session.on('sftp',(acceptSftp)=>{
          this.sftpSessions++;
          this.acceptSftp(client,acceptSftp());
        });
      });
    });
  }

  private acceptSftp(client:Connection,sftp:SFTPWrapper):void{
    const handles=new Map<string,{path:string;mode:'read'|'write';data:Buffer}>();
    let serial=0;
    const handleFor=(path:string,mode:'read'|'write',data:Buffer)=>{
      const handle=Buffer.alloc(4);handle.writeUInt32BE(++serial);handles.set(handle.toString('hex'),{path,mode,data});return handle;
    };
    sftp.on('OPEN',(requestId:number,path:string,flags:number)=>{
      const writing=(flags&utils.sftp.OPEN_MODE.WRITE)!==0;
      if(writing&&this.options.permissionWrite){sftp.status(requestId,STATUS.PERMISSION_DENIED);return}
      if(!writing&&this.options.permissionRead){sftp.status(requestId,STATUS.PERMISSION_DENIED);return}
      if(!writing&&!this.files.has(path)){sftp.status(requestId,STATUS.NO_SUCH_FILE);return}
      if(writing){
        this.writeOpenRequests++;
        if(this.options.dropAfterMutatingOpen){this.files.set(path,Buffer.alloc(0));client.end();return}
      }
      sftp.handle(requestId,handleFor(path,writing?'write':'read',writing?Buffer.alloc(0):Buffer.from(this.files.get(path)!)));
    });
    sftp.on('READ',(requestId:number,handle:Buffer,offset:number,length:number)=>{
      const opened=handles.get(handle.toString('hex'));
      if(!opened||opened.mode!=='read'){sftp.status(requestId,STATUS.FAILURE);return}
      if(offset>=opened.data.length){sftp.status(requestId,STATUS.EOF);return}
      sftp.data(requestId,opened.data.subarray(offset,Math.min(opened.data.length,offset+length)));
    });
    sftp.on('WRITE',(requestId:number,handle:Buffer,offset:number,data:Buffer)=>{
      const opened=handles.get(handle.toString('hex'));
      if(!opened||opened.mode!=='write'){sftp.status(requestId,STATUS.FAILURE);return}
      const required=offset+data.length;
      if(opened.data.length<required){const expanded=Buffer.alloc(required);opened.data.copy(expanded);opened.data=expanded}
      data.copy(opened.data,offset);
      this.writeRequests++;
      this.files.set(opened.path,Buffer.from(opened.data));
      if(this.options.dropAfterWrite){client.end();return}
      if(this.options.stallAfterWrite)return;
      sftp.status(requestId,STATUS.OK);
    });
    sftp.on('CLOSE',(requestId:number,handle:Buffer)=>{
      const opened=handles.get(handle.toString('hex'));
      if(!opened){sftp.status(requestId,STATUS.FAILURE);return}
      if(opened.mode==='write')this.files.set(opened.path,Buffer.from(opened.data));
      handles.delete(handle.toString('hex'));
      if(opened.mode==='write'&&this.options.permissionOnClose){sftp.status(requestId,STATUS.PERMISSION_DENIED);return}
      sftp.status(requestId,STATUS.OK);
    });
  }
}

async function withFixture<T>(options:FixtureOptions,run:(fixture:LoopbackProseFixture)=>Promise<T>):Promise<T>{
  const fixture=new LoopbackProseFixture(options);await fixture.start();
  try{return await run(fixture)}finally{await fixture.close()}
}

function expected(identity:{name:string;id:string;keyFingerprint:string}):ExpectedProseIdentity{
  return {name:identity.name,id:identity.id,keyFingerprint:identity.keyFingerprint};
}

async function rejectsCode(promise:Promise<unknown>,code:string):Promise<void>{
  await assert.rejects(promise,(cause:unknown)=>cause instanceof ProseTransportError&&cause.code===code);
}

test('identity, missing read, acknowledged write, and exact readback stay distinct',async()=>{
  await withFixture({},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials();
    const identity=await transport.readIdentity(credentials);
    assert.deepEqual({...identity,keyFingerprint:'redacted'}, {
      name:'writer-one',id:'user-123',createdAt:'2026-01-02T03:04:05Z',plusExpiresAt:null,
      keyFingerprint:'redacted',publishingEligibility:'unknown',
    });
    assert.deepEqual(await transport.readSource(credentials,'research-job-1.md',expected(identity)),{status:'missing',filename:'research-job-1.md'});
    const source='# 标题\n\n正文与 https://example.test/ 。';
    const receipt=await transport.writeSource(credentials,'research-job-1.md',source,expected(identity));
    assert.equal(receipt.status,'written');
    assert.equal(receipt.bytes,Buffer.byteLength(source));
    const read=await transport.readSource(credentials,'research-job-1.md',expected(identity));
    assert.equal(read.status,'found');
    if(read.status==='found'){assert.equal(read.source,source);assert.equal(read.sha256,receipt.sha256)}
  });
});

test('wrong pinned host key fails before authentication',async()=>{
  await withFixture({},async fixture=>{
    const wrong=dynamicEd25519KeyPair().public;
    await rejectsCode(fixture.transport(wrong).readIdentity(fixture.credentials()),'host_key_mismatch');
    assert.equal(fixture.authentications,0);
  });
});

test('only the supplied private key is attempted',async()=>{
  await withFixture({},async fixture=>{
    const wrong=dynamicEd25519KeyPair();
    await rejectsCode(fixture.transport().readIdentity({privateKey:wrong.private}),'authentication_failed');
    assert.ok(fixture.authentications>0);
    assert.equal(fixture.sftpSessions,0);
  });
});

test('errors retain static codes without credentials and invalid timeout adds no abort listener',async()=>{
  await withFixture({},async fixture=>{
    const sentinel='PRIVATE-KEY-SENTINEL-cycle-10';
    let caught:unknown;
    try{await fixture.transport().readIdentity({privateKey:sentinel})}catch(cause){caught=cause}
    assert.ok(caught instanceof ProseTransportError);
    assert.equal(caught.code,'credentials_invalid');
    assert.equal('cause' in caught,false);
    assert.equal(inspect(caught).includes(sentinel),false);
    assert.equal(JSON.stringify(caught).includes(sentinel),false);

    const controller=new AbortController();
    const signal=controller.signal;
    let added=0,removed=0;
    const originalAdd=signal.addEventListener.bind(signal),originalRemove=signal.removeEventListener.bind(signal);
    Object.defineProperty(signal,'addEventListener',{value:(...args:Parameters<AbortSignal['addEventListener']>)=>{added++;return originalAdd(...args)}});
    Object.defineProperty(signal,'removeEventListener',{value:(...args:Parameters<AbortSignal['removeEventListener']>)=>{removed++;return originalRemove(...args)}});
    await rejectsCode(fixture.transport().readIdentity(fixture.credentials(),{signal,timeoutMs:0}),'remote_failure');
    assert.equal(added,0);assert.equal(removed,0);
  });
});

test('identity mismatch stops before opening SFTP or writing',async()=>{
  await withFixture({},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials();
    const identity=await transport.readIdentity(credentials);
    await rejectsCode(transport.writeSource(credentials,'safe-post.md','approved',{...expected(identity),id:'other-user'}),'identity_mismatch');
    assert.equal(fixture.sftpSessions,0);assert.equal(fixture.writeRequests,0);
  });
});

test('one operation snapshots Buffer credentials and expected identity before awaits',async()=>{
  await withFixture({acceptAnyClientKey:true},async fixture=>{
    const transport=fixture.transport();
    const keyBuffer=Buffer.from(fixture.clientKeys.private);
    const credentials={privateKey:keyBuffer};
    const identity=await transport.readIdentity(credentials);
    const expectedIdentity:ExpectedProseIdentity=expected(identity);
    const originalExpected={...expectedIdentity};
    fixture.options.beforeIdentityExit=()=>{
      keyBuffer.fill(0);
      expectedIdentity.name='mutated-name';expectedIdentity.id='mutated-id';expectedIdentity.keyFingerprint='mutated-fingerprint';
    };
    const receipt=await transport.writeSource(credentials,'snapshot-post.md','approved',expectedIdentity);
    const parsedClient=utils.parseKey(fixture.clientKeys.public);assert.ok(!(parsedClient instanceof Error));
    const keyA=parsedClient.getPublicSSH().toString('base64');
    assert.ok(fixture.authenticatedKeys.length>=3);
    assert.equal(fixture.authenticatedKeys.every(value=>value===keyA),true);
    assert.deepEqual(receipt.identity,originalExpected);
  });
});

test('unregistered command output is a dedicated state and never implies eligibility',async()=>{
  await withFixture({identityOutput:'',identityExitCode:1},async fixture=>{
    fixture.options.identityOutput='ERROR: you need to create an account before using the remote cli: key not found\n';
    await rejectsCode(fixture.transport().readIdentity(fixture.credentials()),'identity_not_registered');
  });
});

test('timeout, cancellation, and bounded identity output close the connection',async()=>{
  await withFixture({stallIdentity:true},async fixture=>{
    await rejectsCode(fixture.transport().readIdentity(fixture.credentials(),{timeoutMs:30}),'timeout');
  });
  await withFixture({stallIdentity:true},async fixture=>{
    const controller=new AbortController();
    const pending=fixture.transport().readIdentity(fixture.credentials(),{signal:controller.signal});
    controller.abort();
    await rejectsCode(pending,'aborted');
  });
  await withFixture({identityOutput:'x'.repeat(8*1024+1)},async fixture=>{
    await rejectsCode(fixture.transport().readIdentity(fixture.credentials()),'response_too_large');
  });
  await withFixture({},async fixture=>{
    fixture.files.set('/oversized-post.md',Buffer.alloc(512*1024+1,0x61));
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.readSource(credentials,'oversized-post.md',expected(identity)),'response_too_large');
  });
});

test('illegal filenames are rejected before any connection',async()=>{
  await withFixture({},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials();
    const placeholder={name:'writer-one',id:'user-123',keyFingerprint:'SHA256:placeholder'};
    for(const filename of ['../post.md','nested/post.md','-post.md','readme.md','Post.md','post.txt']){
      assert.throws(()=>transport.readSource(credentials,filename,placeholder),
        (cause:unknown)=>cause instanceof ProseTransportError&&cause.code==='invalid_filename');
      assert.throws(()=>transport.writeSource(credentials,filename,'approved',placeholder),
        (cause:unknown)=>cause instanceof ProseTransportError&&cause.code==='invalid_filename');
    }
    assert.equal(fixture.connections,0);
  });
});

test('missing and permission denied remain distinguishable',async()=>{
  await withFixture({},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    assert.equal((await transport.readSource(credentials,'absent-post.md',expected(identity))).status,'missing');
  });
  await withFixture({permissionRead:true},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.readSource(credentials,'private-post.md',expected(identity)),'permission_denied');
  });
  await withFixture({permissionWrite:true},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.writeSource(credentials,'blocked-post.md','approved',expected(identity)),'permission_denied');
    assert.equal(fixture.writeRequests,0);
  });
});

test('disconnect after bytes arrive is outcome-unknown and is never retried',async()=>{
  await withFixture({dropAfterWrite:true},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.writeSource(credentials,'uncertain-post.md','approved once',expected(identity)),'write_outcome_unknown');
    assert.equal(fixture.writeRequests,1);
    assert.equal(fixture.files.get('/uncertain-post.md')?.toString(),'approved once');
  });
});

test('disconnect after a mutating OPEN but before its handle acknowledgement is outcome-unknown',async()=>{
  await withFixture({dropAfterMutatingOpen:true},async fixture=>{
    fixture.files.set('/truncated-post.md',Buffer.from('old remote body'));
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.writeSource(credentials,'truncated-post.md','new approved body',expected(identity)),'write_outcome_unknown');
    assert.equal(fixture.writeOpenRequests,1);
    assert.equal(fixture.writeRequests,0);
    assert.equal(fixture.files.get('/truncated-post.md')?.length,0);
  });
});

test('permission status on CLOSE after an accepted WRITE is outcome-unknown',async()=>{
  await withFixture({permissionOnClose:true},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.writeSource(credentials,'close-denied-post.md','new approved body',expected(identity)),'write_outcome_unknown');
    assert.equal(fixture.writeOpenRequests,1);
    assert.equal(fixture.writeRequests,1);
    assert.equal(fixture.files.get('/close-denied-post.md')?.toString(),'new approved body');
  });
});

test('timeout after bytes arrive is outcome-unknown and is never retried',async()=>{
  await withFixture({stallAfterWrite:true},async fixture=>{
    const transport=fixture.transport(),credentials=fixture.credentials(),identity=await transport.readIdentity(fixture.credentials());
    await rejectsCode(transport.writeSource(credentials,'timed-out-post.md','approved once',expected(identity),{timeoutMs:50}),'write_outcome_unknown');
    assert.equal(fixture.writeRequests,1);
    assert.equal(fixture.files.get('/timed-out-post.md')?.toString(),'approved once');
  });
});
