import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {portableSsh2Plugin} from './lib/ssh2-bundle.mjs';

process.umask(0o077);
const root=process.cwd();
const evidenceRoot=path.resolve(root,'../../channel-discovery-20261017a');
const intentPath=path.join(evidenceRoot,'shellbook-acceptance-intent.json');
const intent=JSON.parse(readFileSync(intentPath,'utf8'));
const articlePath=path.resolve(intent.article);
const article=readFileSync(articlePath,'utf8');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const expectedName=`linkflow-${String(intent.accountId).replaceAll('-','').slice(0,16)}`;
if(intent.version!==1||intent.channelId!=='shellbook'||intent.agentName!==expectedName||intent.maxRegistrationPosts!==1||intent.maxPublicationPosts!==1||intent.realRegistrations!==0||intent.realPublications!==0||intent.reviewRequired!==true||intent.unknownOutcomePolicy!=='stop_preserve_same_identity_and_payload_read_only_recovery'||intent.articleSha256!==sha256(article)||intent.subshell!=='agents'||typeof intent.title!=='string'||typeof intent.targetUrl!=='string'||!article.includes(`](${intent.targetUrl})`))throw Error('Shellbook frozen acceptance intent is invalid');

const fixturePath=process.env.LINKFLOW_SHELLBOOK_ACCEPTANCE_FIXTURE;
const fixtureMode=typeof fixturePath==='string'&&fixturePath.length>0;
let fixture;
if(fixtureMode){
  if(!path.isAbsolute(fixturePath))throw Error('LINKFLOW_SHELLBOOK_ACCEPTANCE_FIXTURE must be an absolute local fixture path');
  fixture=JSON.parse(readFileSync(fixturePath,'utf8'));
  const keys=fixture&&typeof fixture==='object'&&!Array.isArray(fixture)?Object.keys(fixture).sort():[];
  const expectedKeys=fixture?.scenario==='late_registration'?['accountId','agentName','kind','postId','registrationDelayMs','scenario','timeoutMs','version']:['accountId','agentName','kind','postId','scenario','version'];
  if(JSON.stringify(keys)!==JSON.stringify(expectedKeys.sort())||fixture.version!==1||fixture.kind!=='shellbook_acceptance_fixture'||fixture.accountId!==intent.accountId||fixture.agentName!==intent.agentName||!['success','late_registration'].includes(fixture.scenario)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(fixture.postId)||fixture.scenario==='late_registration'&&(!Number.isInteger(fixture.timeoutMs)||fixture.timeoutMs<100||fixture.timeoutMs>1_000||!Number.isInteger(fixture.registrationDelayMs)||fixture.registrationDelayMs<=fixture.timeoutMs||fixture.registrationDelayMs>5_000))throw Error('Shellbook local fixture is invalid');
}
if(intent.executionEnabled!==true&&!fixtureMode){
  console.log(JSON.stringify({passed:true,executionEnabled:false,networkRequests:0,accountId:intent.accountId,agentName:intent.agentName,articleSha256:intent.articleSha256}));
  process.exit(0);
}
const expectedGate=fixtureMode?`fixture:${intent.accountId}`:intent.accountId;
if(process.env.LINKFLOW_SHELLBOOK_ACCEPTANCE!==expectedGate)throw Error('Shellbook acceptance gate does not match the frozen account identity');
const dataDir=process.env.LINKFLOW_SHELLBOOK_ACCEPTANCE_DIR;
if(!dataDir||!path.isAbsolute(dataDir))throw Error('LINKFLOW_SHELLBOOK_ACCEPTANCE_DIR must be an absolute isolated directory');
mkdirSync(dataDir,{recursive:true,mode:0o700});
if((statSync(dataDir).mode&0o077)!==0)throw Error('Shellbook acceptance directory must be private (0700)');

const require=createRequire(import.meta.url),bundleDir=path.join(dataDir,'.runner');
if(existsSync(bundleDir))rmSync(bundleDir,{recursive:true,force:true});
mkdirSync(bundleDir,{mode:0o700});
const taskId='757d036c-e717-4b79-9c1c-5334c88afdb3';
const source=`import path from 'node:path';
import {createHash} from 'node:crypto';
import {app} from 'electron';
import {Store,emptyState} from ${JSON.stringify(path.join(root,'src/main/store.ts'))};
import {Vault} from ${JSON.stringify(path.join(root,'src/main/vault.ts'))};
import {Controller} from ${JSON.stringify(path.join(root,'src/main/controller.ts'))};
import {CHANNELS} from ${JSON.stringify(path.join(root,'src/integrations/catalog.ts'))};
import {drainOpenAgentChatPendingOperations,openAgentChatPendingOperationCount} from ${JSON.stringify(path.join(root,'src/integrations/openagentchat.ts'))};
import {marked} from 'marked';
const intent=${JSON.stringify(intent)},article=${JSON.stringify(article)},dataDir=${JSON.stringify(dataDir)},taskId=${JSON.stringify(taskId)},fixtureMode=${JSON.stringify(fixtureMode)},fixture=${JSON.stringify(fixture??null)};
let registrationPosts=0,publicationPosts=0,totalRequests=0,physicalNetworkRequests=0,fixtureRequests=0,fixturePost:any;
const physicalFetch=globalThis.fetch;
const fixtureResponse=(url:string,status:number,value:unknown,type='application/json')=>{const body=typeof value==='string'?value:JSON.stringify(value),response=new Response(body,{status,headers:{'content-type':type,'content-length':String(Buffer.byteLength(body))}});Object.defineProperties(response,{url:{value:url},redirected:{value:false},type:{value:'basic'}});return response};
const fixtureFetch=async(url:string,parsed:URL,method:string,init:RequestInit)=>{fixtureRequests++;const authorization=new Headers(init.headers).get('authorization'),token='mf_fixture_0123456789abcdefghijklmnop';
  if(method==='GET'&&parsed.pathname==='/api/v1/agents/profile'){if(parsed.searchParams.get('name')!==intent.agentName)throw Error('Shellbook fixture profile name changed');return fixtureResponse(url,404,'','text/plain')}
  if(method==='POST'&&parsed.pathname==='/api/v1/agents/register'){const body=JSON.parse(String(init.body));if(body.name!==intent.agentName||body.description!==intent.description)throw Error('Shellbook fixture registration body changed');const result=fixtureResponse(url,201,{id:intent.accountId,name:intent.agentName,api_key:token});if(fixture.scenario==='late_registration')await new Promise(resolve=>setTimeout(resolve,fixture.registrationDelayMs));return result}
  if(method==='GET'&&parsed.pathname==='/api/v1/agents/me'){if(authorization!=='Bearer '+token)throw Error('Shellbook fixture API token changed');return fixtureResponse(url,200,{id:intent.accountId,name:intent.agentName})}
  if(method==='POST'&&parsed.pathname==='/api/v1/posts'){if(authorization!=='Bearer '+token)throw Error('Shellbook fixture API token changed');const body=JSON.parse(String(init.body));if(body.title!==intent.title||body.content!==article||body.url!==intent.targetUrl||body.subshell!==intent.subshell)throw Error('Shellbook fixture publication body changed');fixturePost={id:fixture.postId,author_id:intent.accountId,author:{name:intent.agentName},title:intent.title,content:article,url:intent.targetUrl,created_at:new Date().toISOString(),deleted_at:null,is_deleted:false,subshell:{name:intent.subshell}};return fixtureResponse(url,201,fixturePost)}
  if(method==='GET'&&parsed.pathname==='/api/v1/posts/'+fixture.postId){if(authorization!=='Bearer '+token||!fixturePost)throw Error('Shellbook fixture post read before creation');return fixtureResponse(url,200,fixturePost)}
  if(method==='GET'&&parsed.pathname==='/post/'+fixture.postId){if(!fixturePost)throw Error('Shellbook fixture page read before creation');const publicUrl='https://shellbook.io/post/'+fixture.postId,html='<!doctype html><html><head><meta name="robots" content="index, follow"><link rel="canonical" href="'+publicUrl+'"></head><body><header><h1>'+intent.title+'</h1><a href="'+intent.targetUrl+'" rel="noopener noreferrer">Project URL</a></header><div class="prose">'+String(marked.parse(article,{async:false,gfm:true}))+'</div></body></html>';return fixtureResponse(url,200,html,'text/html')}
  if(method==='GET'&&parsed.pathname==='/robots.txt')return fixtureResponse(url,200,'User-agent: *\\nAllow: /\\n','text/plain');
  throw Error('Shellbook local fixture route rejected: '+method+' '+parsed.pathname)};
const boundedFetch=async(url:string,init:RequestInit={})=>{const parsed=new URL(url),method=(init.method??'GET').toUpperCase();if(parsed.origin!=='https://shellbook.io'||!['GET','POST'].includes(method))throw Error('Shellbook acceptance request outside bounded origin or method');if(method==='POST'){if(parsed.pathname==='/api/v1/agents/register'){if(++registrationPosts>1)throw Error('Shellbook registration POST budget exceeded')}else if(parsed.pathname==='/api/v1/posts'){if(++publicationPosts>1)throw Error('Shellbook publication POST budget exceeded')}else throw Error('Shellbook acceptance POST route rejected')}else if(!(/^\\/api\\/v1\\/(?:agents\\/(?:profile|me)|posts(?:\\/[0-9a-f-]{36})?|search)$/.test(parsed.pathname)||parsed.pathname==='/robots.txt'||/^\\/post\\/[0-9a-f-]{36}$/.test(parsed.pathname)))throw Error('Shellbook acceptance GET route rejected');totalRequests++;if(fixtureMode)return fixtureFetch(url,parsed,method,init);physicalNetworkRequests++;return physicalFetch(url,init)};
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{const db=path.join(dataDir,'shellbook-acceptance.sqlite'),store=new Store(db),vault=new Vault(store),stamp=new Date().toISOString(),catalog=CHANNELS.map(channel=>({...channel,enabled:channel.id==='shellbook'})),current=store.read();
if(!current.sites.some(value=>value.id==='00000000-0000-4000-8000-000000000001')){const state=emptyState();state.settings.autoRun=true;state.settings.notify=false;state.settings.channelOverrides={shellbook:true};state.sites=[{id:'00000000-0000-4000-8000-000000000001',domain:new URL(intent.targetUrl).hostname,url:intent.targetUrl,email:'acceptance@invalid.example',name:'LinkFlow',description:'LinkFlow desktop software project',category:'software',language:'en',monthlyTarget:1,status:'ready',createdAt:stamp,analyzedAt:stamp,articleReviewMode:'manual',qualifications:{software:intent.targetUrl,developer:intent.targetUrl}}];state.tasks=[{id:taskId,siteId:state.sites[0].id,channelId:'shellbook',sourceDomain:'shellbook.io',status:'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,message:'Controlled Shellbook acceptance',topicUrl:intent.targetUrl,draft:{title:intent.title,description:'Controlled original engineering article',body:article},draftRevision:1,draftUpdatedAt:stamp,articleApprovedAt:stamp}];store.update(value=>Object.assign(value,state))}
const controller=new Controller(store,vault,dataDir,{channelCatalog:catalog,shellbookDependencies:{fetch:boundedFetch,fixedAccountId:intent.accountId,timeoutMs:fixtureMode&&fixture.scenario==='late_registration'?fixture.timeoutMs:20_000}});controller.runtime.aiReady=true;let failure:unknown,task;try{task=store.read().tasks.find(value=>value.id===taskId);if(!task)throw Error('Shellbook acceptance task missing');for(let step=0;step<6&&!['live','review','needs_input','failed','skipped','expired'].includes(task.status);step++){await controller.tick();task=store.read().tasks.find(value=>value.id===taskId);if(!task)throw Error('Shellbook acceptance task disappeared')}}catch(error){failure=error}finally{controller.stop();const drained=await drainOpenAgentChatPendingOperations(45_000),pendingOperations=openAgentChatPendingOperationCount();if(!drained||pendingOperations){console.log(JSON.stringify({passed:false,phase:'pending_drain_incomplete',fixtureMode,fixtureScenario:fixture?.scenario,executionEnabled:intent.executionEnabled,registrationPosts,publicationPosts,totalRequests,fixtureRequests,networkRequests:physicalNetworkRequests,pendingOperations,encryptedSnapshotSafe:false,error:failure instanceof Error?failure.message:failure?String(failure):undefined}));app.exit(2);return}const saved=store.read(),account=saved.accounts.find(value=>value.channelId==='shellbook'),cipherSnapshot=store.allCiphers(),cipherKeys=Object.keys(cipherSnapshot).sort(),safeStateSha256=createHash('sha256').update(JSON.stringify(saved)).digest('hex'),encryptedSnapshotSha256=createHash('sha256').update(JSON.stringify(cipherSnapshot)).digest('hex');let lateResponsePersisted=false;if(fixtureMode&&fixture.scenario==='late_registration'){try{const raw=await vault.get('account:'+intent.accountId),secret=raw&&JSON.parse(raw);lateResponsePersisted=!!secret?.opaqueResponse?.bodyComplete&&secret.token===undefined}catch{}}const successFixture=fixtureMode&&fixture.scenario==='success',lateFixture=fixtureMode&&fixture.scenario==='late_registration',liveOutcome=task?.status==='live'&&task.shellbook?.stage==='published'&&cipherKeys.includes('publication:'+taskId),lateOutcome=task?.status==='needs_input'&&account?.shellbook?.stage==='opaque_response'&&registrationPosts===1&&publicationPosts===0&&lateResponsePersisted,outcomeOk=!fixtureMode&&liveOutcome||successFixture&&liveOutcome&&registrationPosts===1&&publicationPosts===1||lateFixture&&lateOutcome,networkBudgetOk=!fixtureMode||physicalNetworkRequests===0,passed=!failure&&account?.id===intent.accountId&&account.shellbook?.agentName===intent.agentName&&cipherKeys.includes('account:'+intent.accountId)&&networkBudgetOk&&outcomeOk;store.close();console.log(JSON.stringify({passed,phase:'drained_snapshot_closed',fixtureMode,fixtureScenario:fixture?.scenario,executionEnabled:intent.executionEnabled,status:task?.status,checkpoint:task?.checkpoint,publicUrl:task?.publicUrl,linkRel:task?.linkRel,message:task?.message,registrationPosts,publicationPosts,totalRequests,fixtureRequests,networkRequests:physicalNetworkRequests,pendingOperations,lateResponsePersisted,accountStage:account?.shellbook?.stage,encryptedSnapshotSafe:true,stateSha256:safeStateSha256,encryptedSnapshotSha256,encryptedSecretKeys:cipherKeys,accountId:account?.id,agentName:account?.shellbook?.agentName,articleSha256:intent.articleSha256,error:failure instanceof Error?failure.message:failure?String(failure):undefined}));app.exit(passed?0:1)}}).catch(error=>{console.error(error instanceof Error?error.message:String(error));app.exit(1)});`;
await build({stdin:{contents:source,resolveDir:root,sourcefile:'shellbook-acceptance-fixture.ts',loader:'ts'},outfile:path.join(bundleDir,'entry.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron','cpu-features'],plugins:[portableSsh2Plugin()],target:'node22'});
const child=spawn(require('electron'),[path.join(bundleDir,'entry.cjs'),'--user-data-dir='+path.join(dataDir,'electron-profile')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
let expired=false;const timer=setTimeout(()=>{expired=true;child.kill()},120000),code=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);rmSync(bundleDir,{recursive:true,force:true});process.exitCode=expired?1:code??1;
