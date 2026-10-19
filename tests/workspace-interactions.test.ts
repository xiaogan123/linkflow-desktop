import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {AddSitesBatch,SiteContentUpdate} from '../src/main/validation';
import type {AddSitesBatchResult,Site,Snapshot,Task} from '../src/shared/types';

type Node={type:string;props:Record<string,unknown>;children:unknown[]};
type Component=(props:Record<string,unknown>)=>unknown;
type Components={SiteDetailPage:Component;WebsitesPage:Component;TaskCenter:Component;AddSitesForm:Component};
type Call={command:string;payload:unknown;success?:string};
const stamp='2026-10-18T10:00:00.000Z',now=new Date(stamp);
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const site=(index:number,domain:string,monthlyTarget=2):Site=>({id:ids[index],domain,url:`https://${domain}`,email:`hello@${domain}`,name:domain,description:'fixture',category:'content',language:'zh',monthlyTarget,articleReviewMode:'ai',status:'ready',createdAt:stamp});
function snapshot(sites:Site[]=[site(0,'one.example.com')],tasks:Task[]=[]):Snapshot{
 return {sites,tasks,channels:[],accounts:[],accountBindings:[],mailboxes:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'ai',apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'test',dataPath:'',aiCallsToday:0}};
}
function flatten(value:unknown):unknown[]{return Array.isArray(value)?value.flatMap(flatten):value==null||typeof value==='boolean'?[]:[value]}
function textOf(value:unknown):string{
 if(typeof value==='string'||typeof value==='number')return String(value);
 if(Array.isArray(value))return value.map(textOf).join('');
 return value&&typeof value==='object'&&'children' in value?textOf((value as Node).children):'';
}
function findAll(value:unknown,predicate:(node:Node)=>boolean,result:Node[]=[]):Node[]{
 if(Array.isArray(value)){for(const child of value)findAll(child,predicate,result);return result}
 if(!value||typeof value!=='object'||!('type' in value))return result;
 const node=value as Node;if(predicate(node))result.push(node);
 for(const child of node.children)findAll(child,predicate,result);return result;
}
/** Same no-browser hook fixture used by blogger-connection-ui.test.ts. */
class HookFixture{
 private hooks:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[];
 private cursor=0;
 private scheduled=false;
 private mounted=true;
 private effects:Array<()=>void>=[];
 tree:unknown;
 constructor(private Component:Component,private props:Record<string,unknown>){}
 start(){this.tree=this.render()}
 jsx=(type:unknown,props:Record<string,unknown>|null)=>{
  const next=props??{};
  if(typeof type==='function')return type(next);
  if(typeof type==='symbol')return flatten(next.children);
  return {type:String(type),props:next,children:flatten(next.children)} satisfies Node;
 };
 useState=<T,>(initial:T|(()=>T))=>{
  const index=this.cursor++;
  if(!this.hooks[index])this.hooks[index]={value:typeof initial==='function'?(initial as ()=>T)():initial};
  const set=(next:T|((value:T)=>T))=>{const current=this.hooks[index].value as T;this.hooks[index].value=typeof next==='function'?(next as (value:T)=>T)(current):next;this.schedule()};
  return [this.hooks[index].value as T,set] as const;
 };
 useRef=<T,>(initial:T)=>{const index=this.cursor++;if(!this.hooks[index])this.hooks[index]={value:{current:initial}};return this.hooks[index].value as {current:T}};
 useMemo=<T,>(factory:()=>T,_deps:unknown[])=>{this.cursor++;return factory()};
 useEffect=(effect:()=>void|(()=>void),deps:unknown[])=>{
  const index=this.cursor++,previous=this.hooks[index];
  if(previous?.deps&&deps.length===previous.deps.length&&deps.every((value,item)=>Object.is(value,previous.deps?.[item])))return;
  this.effects.push(()=>{previous?.cleanup?.();const cleanup=effect();this.hooks[index]={deps,cleanup:typeof cleanup==='function'?cleanup:undefined}});
 };
 private schedule(){if(this.scheduled||!this.mounted)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;if(this.mounted)this.tree=this.render()})}
 private render(){this.cursor=0;this.effects=[];const tree=this.Component(this.props),effects=this.effects;this.effects=[];for(const effect of effects)effect();return tree}
 unmount(){this.mounted=false;for(const hook of this.hooks)hook?.cleanup?.()}
 nodes(predicate:(node:Node)=>boolean){return findAll(this.tree,predicate)}
 button(label:string,scope:unknown=this.tree){const node=findAll(scope,node=>node.type==='button'&&textOf(node)===label)[0];assert.ok(node,`missing button: ${label}`);return node}
 field(label:string){
  const field=this.nodes(node=>node.type==='label'&&node.children.some(child=>!!child&&typeof child==='object'&&(child as Node).type==='span'&&textOf(child)===label))[0];
  assert.ok(field,`missing field: ${label}`);
  const input=findAll(field,node=>['input','textarea','select'].includes(node.type))[0];assert.ok(input,`missing field input: ${label}`);return input;
 }
 contains(text:string){return textOf(this.tree).includes(text)}
}
let componentsPromise:Promise<Components>|undefined;
function components():Promise<Components>{
 if(componentsPromise)return componentsPromise;
 componentsPromise=(async()=>{
  const root=process.cwd();
  const sources=[['SiteDetailPage','WorkspacePages'],['WebsitesPage','WorkspacePages'],['TaskCenter','TaskCenter'],['AddSitesForm','AddSitesForm']];
  const bundled=await build({stdin:{contents:sources.map(([name,file])=>`export {${name}} from ${JSON.stringify(join(root,`src/ui/pages/${file}.tsx`))}`).join('\n'),resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',plugins:[{name:'workspace-react-fixture',setup(api){
   api.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));
   api.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx-runtime',namespace:'fixture'}));
   api.onResolve({filter:/^@phosphor-icons\/react$/},()=>({path:'icons',namespace:'fixture'}));
   api.onLoad({filter:/.*/,namespace:'fixture'},args=>{
    if(args.path==='react')return {contents:`const f=()=>globalThis.__workspaceReactFixture;export const useState=(...a)=>f().useState(...a);export const useRef=(...a)=>f().useRef(...a);export const useMemo=(...a)=>f().useMemo(...a);export const useEffect=(...a)=>f().useEffect(...a);`};
    if(args.path==='jsx-runtime')return {contents:`const f=()=>globalThis.__workspaceReactFixture;export const Fragment=Symbol.for('fixture.fragment');export const jsx=(...a)=>f().jsx(...a);export const jsxs=jsx;`};
    return {contents:'const Icon=()=>null;export {Icon as Plus,Icon as FileText,Icon as MagnifyingGlass,Icon as CheckCircle,Icon as House,Icon as LinkSimple};'};
   });
  }}]});
  const module={exports:{}} as {exports:Components};
  new Function('module','exports','require',bundled.outputFiles[0].text)(module,module.exports,createRequire(import.meta.url));
  return module.exports;
 })();return componentsPromise;
}
function mount(Component:Component,props:Record<string,unknown>){
 const fixture=new HookFixture(Component,props);
 Object.defineProperty(globalThis,'__workspaceReactFixture',{configurable:true,value:fixture});fixture.start();
 return {fixture,restore(){fixture.unmount();delete (globalThis as Record<string,unknown>).__workspaceReactFixture}};
}
async function settle(){await Promise.resolve();await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));await Promise.resolve()}
async function click(node:Node){assert.notEqual(node.props.disabled,true,'disabled controls cannot be clicked');assert.equal(typeof node.props.onClick,'function');await (node.props.onClick as ()=>unknown)();await settle()}
async function change(node:Node,value:string|boolean){assert.equal(typeof node.props.onChange,'function');await (node.props.onChange as (event:unknown)=>unknown)({target:typeof value==='boolean'?{checked:value}:{value}});await settle()}
async function submit(fixture:HookFixture){const form=fixture.nodes(node=>node.type==='form')[0];assert.ok(form);let prevented=false;await (form.props.onSubmit as (event:unknown)=>unknown)({preventDefault:()=>{prevented=true}});await settle();assert.equal(prevented,true)}
const noop=()=>{};

test('promotion content saves existing and added topics through the strict IPC schema',async()=>{
 const {SiteDetailPage}=await components();
 const current=site(0,'content.example.com');current.topics=[{url:'https://content.example.com/original',title:'原有文章',discoveredAt:stamp,lastModified:stamp}];
 const calls:Call[]=[];
 const mounted=mount(SiteDetailPage,{site:current,data:snapshot([current]),initialTab:'content',now,disabled:false,onAction:async(command:string,payload:unknown,success?:string)=>{calls.push({command,payload,success});return {}},onEdit:noop,onMigrate:noop,onBack:noop,renderTask:()=>null,tools:null});
 try{
  await change(mounted.fixture.field('文章网址'),'https://content.example.com/new');
  await change(mounted.fixture.field('文章标题'),' 新文章 ');
  await click(mounted.fixture.button('添加文章'));
  await change(mounted.fixture.field('可链接的页面'),' https://content.example.com/guide \n\nhttps://content.example.com/faq');
  await change(mounted.fixture.field('不许出现的词'),' 保证收益 \n\n 专属邀请码 ');
  await click(mounted.fixture.button('保存推广内容'));
  assert.equal(calls.length,1);assert.equal(calls[0].command,'site:content-update');
  const payload=SiteContentUpdate.parse(calls[0].payload);
  assert.deepEqual(payload,{id:current.id,topics:[{url:'https://content.example.com/original',title:'原有文章'},{url:'https://content.example.com/new',title:'新文章'}],linkTargets:['https://content.example.com/guide','https://content.example.com/faq'],forbiddenTerms:['保证收益','专属邀请码']});
  assert.equal(current.topics[0].discoveredAt,stamp,'saving must not mutate imported topic metadata');
  assert.ok(mounted.fixture.contains('可写稿的文章页'));
 }finally{mounted.restore()}
});

test('website table clicks change numeric sort direction and batch partial failures stay on the same page',async()=>{
 const {WebsitesPage}=await components(),data=snapshot([site(1,'beta.example.com',4),site(0,'alpha.example.com',2),site(2,'gamma.example.com',1)]);
 const calls:Call[]=[];let navigations=0;let resolveFirst!:(value:unknown)=>void;
 const first=new Promise(resolve=>{resolveFirst=resolve});
 const mounted=mount(WebsitesPage,{data,now,disabled:false,onSite:()=>{navigations++},onAdd:()=>{navigations++},onAction:async(command:string,payload:unknown)=>{calls.push({command,payload});if(calls.length===1)return first;return calls.length===2?undefined:{}}});
 const domains=()=>{const body=mounted.fixture.nodes(node=>node.type==='tbody')[0];return findAll(body,node=>node.type==='button'&&node.props.className==='inline-link').map(textOf)};
 const sort=()=>mounted.fixture.nodes(node=>node.type==='button'&&node.props['aria-label']==='按每月排序')[0];
 try{
  assert.deepEqual(domains(),['alpha.example.com','beta.example.com','gamma.example.com']);
  await click(sort());assert.deepEqual(domains(),['gamma.example.com','alpha.example.com','beta.example.com']);
  assert.ok(mounted.fixture.nodes(node=>node.type==='th'&&node.props['aria-sort']==='ascending'&&textOf(node).includes('每月')).length);
  await click(sort());assert.deepEqual(domains(),['beta.example.com','alpha.example.com','gamma.example.com']);
  assert.ok(mounted.fixture.nodes(node=>node.type==='th'&&node.props['aria-sort']==='descending'&&textOf(node).includes('每月')).length);
  const all=mounted.fixture.nodes(node=>node.type==='input'&&node.props['aria-label']==='选择网站')[0];await change(all,true);
  await click(mounted.fixture.button('暂停'));
  assert.equal(mounted.fixture.button('暂停').props.disabled,true);
  assert.equal(calls.length,1);
  resolveFirst({});await settle();
  assert.deepEqual(calls.map(call=>[call.command,call.payload]),data.sites.map(current=>['site:pause',{id:current.id,paused:true}]));
  assert.ok(mounted.fixture.contains('已更新 2 个网站，其余网站未更新，请重试。'));
  assert.equal(mounted.fixture.button('暂停').props.disabled,false);
  assert.equal(navigations,0);
  assert.deepEqual(domains(),['beta.example.com','alpha.example.com','gamma.example.com']);
  assert.equal(mounted.fixture.nodes(node=>node.type==='input'&&node.props.type==='checkbox'&&node.props.checked===true).length,4);
 }finally{mounted.restore()}
});

function todo(id:string,reasonCode:Task['reasonCode'],checkpoint:string):Task{return {id,siteId:ids[0],channelId:'example-platform',sourceDomain:'platform.example.com',status:'needs_input',reasonCode,checkpoint,createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:1,message:'technical fixture',waitingDeadlineAt:'2026-10-20T10:00:00.000Z',draft:{title:`稿件 ${id}`,description:'摘要',body:'待确认的正文'}}}
test('todo review expands before approval and manual publishing opens the platform and address editor',async()=>{
 const {TaskCenter}=await components(),review=todo('review-task','manual_review','article_review'),manual=todo('manual-task','human_required','manual_submission'),calls:Call[]=[],edited:string[]=[],urls:string[]=[];
 const mounted=mount(TaskCenter,{data:snapshot(undefined,[review,manual]),now,disabled:false,status:'all',onStatusChange:noop,onAction:async(command:string,payload:unknown,success?:string)=>{calls.push({command,payload,success});return {}},onEditDraft:(task:Task)=>edited.push(task.id),onSetUrl:(task:Task)=>urls.push(task.id),onSite:noop});
 const card=(id:string)=>{const result=mounted.fixture.nodes(node=>node.type==='article'&&String(node.props.className).includes('todo-card')&&textOf(node).includes(id==='review-task'?'稿子写好了':'这一步需要你来完成'))[0];assert.ok(result);return result};
 try{
  assert.equal(mounted.fixture.nodes(node=>node.type==='button'&&textOf(node)==='确认稿件').length,0);
  await click(mounted.fixture.button('看稿',card(review.id)));
  assert.ok(mounted.fixture.contains(review.draft!.body));
  await click(mounted.fixture.button('编辑稿件',card(review.id)));
  await click(mounted.fixture.button('确认稿件',card(review.id)));
  assert.deepEqual(edited,[review.id]);assert.deepEqual(calls.map(call=>[call.command,call.payload]),[['task:approve',{id:review.id}]]);
  await click(mounted.fixture.button('去发布',card(manual.id)));
  assert.equal(mounted.fixture.nodes(node=>node.type==='button'&&textOf(node)==='确认稿件').length,0,'manual posting must not inherit the review approval control');
  await click(mounted.fixture.button('打开平台',card(manual.id)));
  await click(mounted.fixture.button('填写地址',card(manual.id)));
  assert.deepEqual(calls.map(call=>[call.command,call.payload]),[['task:approve',{id:review.id}],['task:open',{id:manual.id}]]);
  assert.deepEqual(urls,[manual.id]);
 }finally{mounted.restore()}
});

test('public publication agreement opens its website task details without opening the platform',async()=>{
 const {TaskCenter}=await components(),task={...todo('44444444-4444-4444-8444-444444444444','agreement_required','html_app_public_notice'),channelId:'html-app'},calls:Call[]=[],routes:Array<[string,string|undefined]>=[];
 const mounted=mount(TaskCenter,{data:snapshot(undefined,[task]),now,disabled:false,status:'all',onStatusChange:noop,onAction:async(command:string,payload:unknown)=>{calls.push({command,payload});return {}},onEditDraft:noop,onSetUrl:noop,onSite:(siteId:string,taskId?:string)=>routes.push([siteId,taskId])});
 try{
  assert.ok(mounted.fixture.contains('需要你确认一次平台条款。'));
  await click(mounted.fixture.button('去确认'));
  assert.deepEqual(routes,[[task.siteId,task.id]]);
  assert.deepEqual(calls,[],'agreement handling must not dispatch task:open or publish a draft');
 }finally{mounted.restore()}
});

test('batch add consumes textarea edits and CSV content, submits valid options and keeps response feedback in place',async()=>{
 const {AddSitesForm}=await components(),calls:Call[]=[];let closed=0;
 const response:AddSitesBatchResult={added:2,duplicates:1,errors:[],siteIds:ids.slice(0,2),rolloutDays:3};
 const mounted=mount(AddSitesForm,{disabled:false,onClose:()=>{closed++},onAction:async(command:string,payload:unknown)=>{calls.push({command,payload});return response}});
 try{
  await change(mounted.fixture.field('网址'),'one.example.com\nhttps://two.example.com/');
  assert.equal(mounted.fixture.button('添加 2 个网站').props.disabled,false);
  const file=mounted.fixture.nodes(node=>node.type==='input'&&node.props.type==='file')[0];
  const fileTarget={value:'fixture.csv',files:[{text:async()=> '\uFEFFname,网址\r\n"third, site",https://three.example.com/\r\n'}]};
  await (file.props.onChange as (event:unknown)=>Promise<void>)({target:fileTarget});await settle();
  assert.equal(fileTarget.value,'');assert.ok(mounted.fixture.contains('添加 3 个网站'));
  await change(mounted.fixture.field('每月几条'),'4');
  await change(mounted.fixture.field('发布方式'),'manual');
  await change(mounted.fixture.field('网站类型'),'finance-zh');
  await change(mounted.fixture.field('公开联系邮箱（可不填）'),' hello@example.com ');
  await submit(mounted.fixture);
  assert.equal(calls.length,1);assert.equal(calls[0].command,'site:add-batch');
  assert.deepEqual(AddSitesBatch.parse(calls[0].payload),{domains:['one.example.com','https://two.example.com/','https://three.example.com/'],monthlyTarget:4,articleReviewMode:'manual',siteType:'finance-zh',contactEmail:'hello@example.com'});
  assert.ok(mounted.fixture.contains('已添加 2 个网站。第一批明天开始发，3 天内全部铺开。'));
  assert.ok(mounted.fixture.contains('跳过 1 个重复网址，0 个网址未添加。'));
  assert.equal(mounted.fixture.button('添加 3 个网站').props.disabled,true);assert.equal(closed,0);
  await change(mounted.fixture.field('网址'),'four.example.com');
  assert.equal(mounted.fixture.button('添加 1 个网站').props.disabled,false);assert.equal(mounted.fixture.contains('第一批明天开始发'),false);
  await click(mounted.fixture.button('取消'));assert.equal(closed,1);
 }finally{mounted.restore()}
});

test('empty or unreadable CSV import shows a local error without submitting or losing typed websites',async()=>{
 const {AddSitesForm}=await components(),calls:Call[]=[];
 const mounted=mount(AddSitesForm,{disabled:false,onClose:noop,onAction:async(command:string,payload:unknown)=>{calls.push({command,payload});return undefined}});
 try{
  await change(mounted.fixture.field('网址'),'keep.example.com');
  for(const file of [{text:async()=> '网址\r\n'},{text:async()=>{throw Error('fixture read error')}}]){
   const input=mounted.fixture.nodes(node=>node.type==='input'&&node.props.type==='file')[0];
   await (input.props.onChange as (event:unknown)=>Promise<void>)({target:{value:'fixture.csv',files:[file]}});await settle();
   assert.equal(mounted.fixture.field('网址').props.value,'keep.example.com');
   assert.equal(mounted.fixture.nodes(node=>node.props.role==='alert').length,1);
  }
  assert.deepEqual(calls,[]);
 }finally{mounted.restore()}
});
