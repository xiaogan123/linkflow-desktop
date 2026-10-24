import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {chmod,copyFile,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {HTML2LINK_CREATE_URL,HTML2LINK_ROBOTS_URL,html2LinkRobotsUrl} from '../src/integrations/html2link';
import {html2LinkPublisherTesting} from '../src/integrations/html2link-publisher';
import {html2LinkPublicationTesting} from '../src/main/html2link-publication';

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const frozenRoot=join(repositoryRoot,'.evidence/channel-expansion-20261021/html2link');
const liveRunnerPath=join(frozenRoot,'live.ts');
const frozenFiles=['draft.private.json','rendered.private.html','content-binding.private.json'] as const;
const publicUrl='https://html2link.dev/x/a1B2c3D4';
const updateToken='private-update-token-123456';
const stamp=new Date('2026-10-22T08:00:00.000Z');

async function privateMode(path:string){return (await stat(path)).mode&0o777}

test('product receipts retain a slug subdomain URL and bind evidence to same-origin robots',()=>{
  const intent={operationId:`html2link_${'a'.repeat(32)}`,sourceHash:'b'.repeat(64),requestHash:'c'.repeat(64),createdAt:stamp.toISOString()},slug='a1b2c3d4',subdomain=`https://${slug}.html2link.dev/`,saved={...intent,slug,publicUrl:subdomain,stage:'api_receipt' as const};
  assert.deepEqual(html2LinkPublisherTesting.receipt(saved),{...intent,slug,publicUrl:subdomain});
  assert.equal(html2LinkPublisherTesting.receipt({...saved,publicUrl:`https://nested.${slug}.html2link.dev/`}),undefined);
  assert.equal(html2LinkPublisherTesting.receipt({...intent,slug:'a1B2c3D4',stage:'api_receipt'} as const)?.publicUrl,'https://html2link.dev/x/a1B2c3D4');
  const empty=Buffer.alloc(0),emptyHash=createHash('sha256').update(empty).digest('hex'),evidence={version:1 as const,kind:'html2link_public_evidence' as const,checkedAt:stamp.toISOString(),publicUrl:subdomain,pageStatus:200,pageContentType:'text/html',pageHeaders:[] as Array<[string,string]>,pageBodyBase64:'',pageBodySha256:emptyHash,robotsUrl:html2LinkRobotsUrl(subdomain)!,robotsStatus:200,robotsContentType:'text/plain',robotsHeaders:[] as Array<[string,string]>,robotsBodyBase64:'',robotsBodySha256:emptyHash};
  assert.equal(html2LinkPublicationTesting.validEvidence(evidence,{...intent,slug,publicUrl:subdomain}),true);
  assert.equal(html2LinkPublicationTesting.validEvidence({...evidence,robotsUrl:HTML2LINK_ROBOTS_URL},{...intent,slug,publicUrl:subdomain}),false);
});

test('private live runner defaults closed, writes once, encrypts capabilities, and recovers with GET only',{skip:!existsSync(liveRunnerPath)},async()=>{
  const {runLiveCommand}=await import(pathToFileURL(liveRunnerPath).href) as {runLiveCommand:(argv:string[],deps?:{rootDir?:string;fetch?:(url:string,init:RequestInit)=>Promise<Response>;now?:()=>Date})=>Promise<Record<string,unknown>>};
  const rootDir=await mkdtemp(join(tmpdir(),'html2link-live-'));
  try{
    for(const name of frozenFiles)await copyFile(join(frozenRoot,name),join(rootDir,name));
    const passphraseFile=join(rootDir,'passphrase.private');
    await writeFile(passphraseFile,'synthetic-passphrase-for-tests\n',{mode:0o600});
    await chmod(passphraseFile,0o600);
    const rendered=await readFile(join(rootDir,'rendered.private.html'),'utf8');

    let preflightCalls=0;
    const preflight=await runLiveCommand(['preflight'],{rootDir,fetch:async()=>{preflightCalls++;throw Error('preflight touched the network')}});
    assert.equal(preflight.ready,true);
    assert.equal(preflight.externalWriteEnabled,false);
    assert.equal(preflight.networkCalls,0);
    assert.equal(preflightCalls,0);
    assert.equal(await stat(join(rootDir,'live.private.lfb')).catch(()=>undefined),undefined);
    assert.equal(await stat(join(rootDir,'submission.private.lock')).catch(()=>undefined),undefined);

    let posts=0,gets=0;
    const transport=async(url:string,init:RequestInit):Promise<Response>=>{
      if(init.method==='POST'){
        posts++;
        assert.equal(url,HTML2LINK_CREATE_URL);
        assert.ok(init.body instanceof FormData);
        const file=init.body.get('file');
        assert.ok(file instanceof Blob);
        assert.equal(await file.text(),rendered);
        return new Response(JSON.stringify({url:publicUrl,slug:'a1B2c3D4',updateToken}),{status:201,headers:{'content-type':'application/json'}});
      }
      gets++;
      assert.equal(init.method,'GET');
      if(url===publicUrl)return new Response(rendered,{status:200,headers:{'content-type':'text/html; charset=utf-8'}});
      if(url===HTML2LINK_ROBOTS_URL)return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});
      throw Error(`unexpected URL: ${url}`);
    };

    const publish=await runLiveCommand(['publish','--execute','--passphrase-file',passphraseFile],{rootDir,fetch:transport,now:()=>stamp});
    assert.equal(publish.status,'accepted');
    assert.equal(publish.createStatus,'created');
    assert.equal(publish.publicUrl,publicUrl);
    assert.equal(posts,1);
    assert.equal(gets,2);

    const ledger=join(rootDir,'live.private.lfb'),lock=join(rootDir,'submission.private.lock'),evidence=join(rootDir,'public-evidence.private.json');
    assert.equal(await privateMode(ledger),0o600);
    assert.equal(await privateMode(lock),0o600);
    assert.equal(await privateMode(evidence),0o600);
    const encrypted=await readFile(ledger);
    assert.equal(encrypted.includes(Buffer.from(updateToken)),false);
    assert.equal(encrypted.includes(Buffer.from(publicUrl)),false);

    await assert.rejects(
      runLiveCommand(['publish','--execute','--passphrase-file',passphraseFile],{rootDir,fetch:transport,now:()=>stamp}),
      /禁止再次 POST/,
    );
    assert.equal(posts,1);
    assert.equal(gets,2);

    const recover=await runLiveCommand(['recover','--passphrase-file',passphraseFile],{rootDir,fetch:transport,now:()=>stamp});
    assert.equal(recover.status,'usable');
    assert.equal(recover.publicUrl,publicUrl);
    assert.equal(recover.postRequests,0);
    assert.equal(posts,1);
    assert.equal(gets,4);
  }finally{
    await rm(rootDir,{recursive:true,force:true});
  }
});
