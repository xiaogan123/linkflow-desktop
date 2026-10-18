import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {load} from 'cheerio';
import {marked} from 'marked';
import {CHANNELS} from '../src/integrations/catalog';
import {AGENTBOARD_BOARDS,AGENTBOARD_FIRST_THREAD,AGENTBOARD_ME,AGENTBOARD_ORIGIN,agentboardBoardApi,agentboardBoardThreadsApi,agentboardThreadApi,agentboardThreadUrl,type AgentboardAgent,type AgentboardBoard,type AgentboardThread} from '../src/integrations/agentboard';
import type {OpenAgentChatDependencies,OpenAgentChatRenderedPage} from '../src/integrations/openagentchat';
import {ARTICLE_REVIEW_CONTRACT_VERSION,articleContentHash,articleContextHash,type ArticleReviewDependencies} from '../src/main/article-review';
import {validateBackup} from '../src/main/backup-validation';
import {Controller,type ControllerServices} from '../src/main/controller';
import {Store,emptyState} from '../src/main/store';
import type {Vault} from '../src/main/vault';
import type {ArticleReview,Channel,Settings,Site,Task} from '../src/shared/types';

const stamp='2026-10-18T00:00:00.000Z';
const boardIntro:AgentboardBoard={id:'brd_1111111111111111',slug:'introductions',title:'Introductions',description:'Introduce a maintained software project.',publicUrl:`${AGENTBOARD_ORIGIN}/b/introductions`,apiUrl:agentboardBoardThreadsApi('introductions')};
const boardEngineering:AgentboardBoard={id:'brd_2222222222222222',slug:'engineering',title:'Engineering',description:'Software engineering and developer tooling discussions.',publicUrl:`${AGENTBOARD_ORIGIN}/b/engineering`,apiUrl:agentboardBoardThreadsApi('engineering')};
const credential='agb_'+ 'a'.repeat(64);

function agentboardChannel():Channel{const source=CHANNELS.find(value=>value.id==='agentboard');assert.ok(source);return {...structuredClone(source),enabled:true}}
function site(id:string,host:string,name:string):Site{return {id,domain:host,url:`https://${host}/`,email:`owner@${host}`,name,description:`${name} is a maintained developer tool with public source evidence.`,category:'software',language:'en',monthlyTarget:1,articleReviewMode:'ai',status:'ready',createdAt:stamp,analyzedAt:stamp,topicsCheckedAt:stamp,topics:[{url:`https://${host}/guide`,discoveredAt:stamp}],qualifications:{software:`https://${host}/product`,developer:`https://${host}/docs`,openSource:`https://${host}/source`}}}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function decode(cipher:string|undefined){return cipher?.startsWith('enc:')?Buffer.from(cipher.slice(4),'base64url').toString():cipher}
function vault(store:Store):Vault{return {ready:true,available:()=>true,get:async(key:string)=>decode(store.getCipher(key)),set:async(key:string,value:string)=>store.setCipher(key,`enc:${Buffer.from(value).toString('base64url')}`),delete:async(key:string)=>store.deleteCipher(key),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,`enc:${Buffer.from(value).toString('base64url')}`]))} as unknown as Vault}

interface RequestLog {method:string;url:string;body?:string;authorization:string|null}
function transport(requests:RequestLog[]):OpenAgentChatDependencies&{threads:Map<string,{thread:AgentboardThread;board:string}>;agent():AgentboardAgent|undefined}{
  const threads=new Map<string,{thread:AgentboardThread;board:string}>();let remoteAgent:AgentboardAgent|undefined,index=0;
  const fetch=async(url:string,init:RequestInit)=>{
    const method=init.method??'GET',body=typeof init.body==='string'?init.body:undefined,authorization=new Headers(init.headers).get('authorization');requests.push({method,url,...(body?{body}:{}),authorization});
    if(method==='GET'&&url===AGENTBOARD_BOARDS)return json({boards:[boardIntro,boardEngineering].map(board=>({...board,url:board.publicUrl}))});
    if(method==='GET'&&(url===agentboardBoardApi(boardIntro.slug)||url===agentboardBoardApi(boardEngineering.slug))){const board=url===agentboardBoardApi(boardIntro.slug)?boardIntro:boardEngineering;return json({board:{...board,url:board.publicUrl}})}
    if(method==='POST'&&url===AGENTBOARD_FIRST_THREAD){
      assert.equal(authorization,null);const payload=JSON.parse(body!);assert.equal(payload.board,'introductions');
      remoteAgent={id:'agt_3333333333333333',handle:'example-project',name:payload.agent.name,description:payload.agent.description,homepage:payload.agent.homepage,operatorName:payload.agent.operatorName,publicUrl:`${AGENTBOARD_ORIGIN}/a/example-project`};
      const id='thr_4444444444444444',thread:AgentboardThread={id,boardId:boardIntro.id,agentId:remoteAgent.id,title:payload.title,body:payload.body,createdAt:stamp,publicUrl:agentboardThreadUrl(id),apiUrl:agentboardThreadApi(id)};threads.set(id,{thread,board:'introductions'});index++;
      return json({credential,agent:{handle:remoteAgent.handle,name:remoteAgent.name,url:remoteAgent.publicUrl},thread:{...thread,url:thread.publicUrl}},201);
    }
    if(method==='GET'&&url===AGENTBOARD_ME){assert.equal(authorization,'Bearer '+credential);assert.ok(remoteAgent);return json({agent:{...remoteAgent,status:'active',url:remoteAgent.publicUrl}})}
    if(method==='POST'&&url===boardEngineering.apiUrl){
      assert.equal(authorization,'Bearer '+credential);assert.ok(remoteAgent);const payload=JSON.parse(body!),id='thr_5555555555555555',thread:AgentboardThread={id,boardId:boardEngineering.id,agentId:remoteAgent.id,title:payload.title,body:payload.body,createdAt:'2026-10-20T00:00:00.000Z',publicUrl:agentboardThreadUrl(id),apiUrl:agentboardThreadApi(id)};threads.set(id,{thread,board:'engineering'});index++;
      return json({thread:{...thread,url:thread.publicUrl}},201);
    }
    if(method==='GET'&&url.startsWith(AGENTBOARD_FIRST_THREAD+'/')){const found=threads.get(url.slice((AGENTBOARD_FIRST_THREAD+'/').length));assert.ok(found);return json({thread:{...found.thread,url:found.thread.publicUrl}})}
    if(method==='GET'&&url===`${AGENTBOARD_ORIGIN}/robots.txt`)return new Response('User-agent: *\nAllow: /t/\nDisallow: /api/\n',{status:200,headers:{'content-type':'text/plain'}});
    throw Error(`unexpected Agentboard request ${method} ${url}`);
  };
  const renderPage=async(url:string):Promise<OpenAgentChatRenderedPage&{occlusionClear:true}>=>{
    const id=new URL(url).pathname.split('/').pop()!,found=threads.get(id);assert.ok(found);assert.ok(remoteAgent);const {thread,board}=found,rendered=String(marked.parse(thread.body,{async:false,gfm:true}));const html=`<!doctype html><html><head><title>${thread.title}</title><link rel="canonical" href="${url}"></head><body><main id="main-content"><p class="meta board-crumb"><a href="/b/${board}">${board}</a></p><h1>${thread.title}</h1><p class="meta">by <a href="/a/${remoteAgent.handle}">${remoteAgent.handle}</a></p><div class="thread-body card">${rendered}</div></main></body></html>`,root=load(rendered),links=root('a[href]').toArray().map(element=>({href:new URL(root(element).attr('href')!,url).href,text:root(element).text(),rel:['nofollow','ugc','noopener'],visible:true}));
    return {url,documentTitle:thread.title,headings:[{text:thread.title,visible:true}],candidates:[{selector:'main#main-content > div.thread-body',html,text:root('body').text(),allTextVisible:true,links}],robots:[],canonicals:[url],hasRefresh:false,hasPasswordGate:false,hasLoginGate:false,responseRobots:[],responseLinks:[],responseStatus:200,responseMediaType:'text/html',responseBodyBytes:Buffer.byteLength(html),responseEncodedBodyBytes:Buffer.byteLength(html),nativeRequests:[{method:'GET',url,resourceType:'mainFrame'}],occlusionClear:true};
  };
  return {fetch,renderPage,threads,agent:()=>remoteAgent};
}

function passedReview(task:Task,currentSite:Site,currentChannel:Channel,settings:Settings,account?:ArticleReviewDependencies['account']):ArticleReview{return {status:'passed',reason:'Synthetic independent review accepted the exact Agentboard identity, board and article.',reasonCode:'passed',reviewContractVersion:ARTICLE_REVIEW_CONTRACT_VERSION,reviewedAt:new Date().toISOString(),evidenceUrls:[currentSite.url,currentChannel.rulesUrl],draftRevision:task.draftRevision??0,contentHash:articleContentHash(task),contextHash:articleContextHash(currentSite,currentChannel,settings,account),checks:{factualAccuracy:'pass',authorRelationship:'pass',affiliateDisclosure:'pass',independentValue:'pass',financialSafety:'pass',channelRules:'pass'}}}

test('planner-created tasks publish one introduction then one reviewed discussion with the original identity and restart with GET only',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse(stamp)});const directory=mkdtempSync(join(tmpdir(),'linkflow-agentboard-controller-')),path=join(directory,'state.sqlite'),store=new Store(path),channel=agentboardChannel(),requests:RequestLog[]=[],network=transport(requests);let reopened:Store|undefined;
  const first=site('11111111-1111-4111-8111-111111111111','example.org','Example Project'),second=site('22222222-2222-4222-8222-222222222222','second.example.org','Second Example');
  const initial=emptyState();initial.settings.autoRun=true;initial.settings.notify=false;initial.settings.articleReviewMode='ai';initial.settings.timezone='UTC';initial.settings.channelOverrides={agentboard:true};initial.sites=[first];store.update(state=>Object.assign(state,initial));
  const drafts:string[]=[];const aiFactory:NonNullable<ControllerServices['aiFactory']>=(_settings,_secrets,onCall)=>({json:async<T>(_instruction:string,data:unknown)=>{onCall?.();const value=data as {topicEvidence?:{url?:string};site:{url:string;name:string}};const target=value.topicEvidence?.url??value.site.url,ordinal=drafts.length+1,title=ordinal===1?'Example Project introduction':'A practical engineering boundary',body=ordinal===1?`This maintained developer tool is described by its publisher. Commercial relationship disclosure: this post promotes the linked project. Read the [project guide](${target}).`:`A useful engineering boundary is to preserve an accepted response before interpreting it. Commercial relationship disclosure: this discussion promotes the linked project. Read the [technical guide](${target}).`;drafts.push(body);return {title,description:'Synthetic controller fixture.',body} as T}});
  const services:ControllerServices={channelCatalog:[channel],agentboardDependencies:network,collectArticleEvidence:async currentSite=>[{url:currentSite.url,kind:'site',text:currentSite.description,excerpt:currentSite.description}],aiFactory,reviewArticle:async(taskValue,currentSite,currentChannel,settings,_ai,_signal,deps)=>passedReview(taskValue,currentSite,currentChannel,settings,deps?.account)};
  const controller=new Controller(store,vault(store),'fixture',services);controller.runtime.aiReady=true;
  try{
    controller.plan();let state=store.read();assert.equal(state.tasks.length,1);let firstTask=state.tasks[0];assert.equal(firstTask.autoSchedule?.kind,'planner');assert.equal(firstTask.channelId,'agentboard');
    await controller.generateDraft(firstTask.id);state=store.read();firstTask=state.tasks[0];assert.equal(firstTask.agentboardSubject?.mode,'introduction');assert.equal(firstTask.agentboardSubject?.boardId,boardIntro.id);assert.equal(firstTask.agentboardSubject?.agent.operatorName,'Site publisher using Linkflow Assistant');assert.doesNotMatch(firstTask.agentboardSubject?.agent.operatorName??'',/owner|maintainer/i);assert.equal(firstTask.agentboardInput,undefined);
    await controller.tick();state=store.read();firstTask=state.tasks[0];assert.equal(firstTask.status,'live');assert.equal(firstTask.agentboard?.stage,'published');assert.equal(firstTask.agentboardInput?.approval.method,'ai');assert.equal(state.accounts.length,1);assert.equal(state.accounts[0].agentboard?.stage,'ready');assert.equal(state.accounts[0].agentboard?.homepage,first.url);assert.equal(requests.filter(value=>value.method==='POST'&&value.url===AGENTBOARD_FIRST_THREAD).length,1);
    store.update(current=>{current.sites.push(second)});controller.plan();state=store.read();const secondTask=state.tasks.find(value=>value.siteId===second.id);assert.ok(secondTask);assert.equal(secondTask.autoSchedule?.kind,'planner');assert.equal(secondTask.accountId,state.accounts[0].id);assert.ok(Date.parse(secondTask.scheduledAt)>=Date.parse(firstTask.submittedAt!)+86400000);
    assert.equal(secondTask.agentboardSubject,undefined);assert.equal(secondTask.draft,undefined);t.mock.timers.setTime(Date.parse(secondTask.scheduledAt)+1);await controller.tick();state=store.read();const published=state.tasks.find(value=>value.id===secondTask.id)!;assert.equal(published.agentboardSubject?.mode,'discussion');assert.equal(published.agentboardSubject?.board,'engineering');assert.equal(published.agentboardSubject?.boardId,boardEngineering.id);assert.equal(published.agentboardSubject?.agent.homepage,first.url);assert.ok(published.draft);assert.equal(published.status,'live');assert.equal(published.agentboard?.mode,'discussion');assert.equal(published.agentboard?.stage,'published');assert.equal(state.accounts.length,1);assert.equal(state.accountBindings.filter(value=>value.channelId==='agentboard').length,2);assert.equal(requests.filter(value=>value.method==='POST'&&value.url===AGENTBOARD_FIRST_THREAD).length,1);assert.equal(requests.filter(value=>value.method==='POST'&&value.url===boardEngineering.apiUrl).length,1);
    const secrets=Object.fromEntries([`account:${state.accounts[0].id}`,...state.tasks.map(value=>`publication:${value.id}`)].map(key=>[key,decode(store.getCipher(key))!]).filter(([,value])=>value!==undefined));const restored=validateBackup({state,secrets});assert.equal(restored.state.tasks.filter(value=>value.agentboard?.stage==='published').length,2);
    controller.stop();store.close();reopened=new Store(path);const readOnlyRequests:RequestLog[]=[];const readOnly={...network,fetch:async(url:string,init:RequestInit)=>{assert.notEqual(init.method,'POST');return network.fetch!(url,init)}};const recoveredController=new Controller(reopened,vault(reopened),'fixture',{...services,agentboardDependencies:readOnly});recoveredController.runtime.aiReady=true;for(const taskValue of reopened.read().tasks)await recoveredController.verify(taskValue.id);assert.equal(readOnlyRequests.filter(value=>value.method==='POST').length,0);assert.equal(reopened.read().tasks.filter(value=>value.status==='live'&&value.agentboard?.stage==='published').length,2);recoveredController.stop();
  }finally{try{controller.stop()}catch{}try{store.close()}catch{}try{reopened?.close()}catch{}rmSync(directory,{recursive:true,force:true});t.mock.timers.reset()}
});
