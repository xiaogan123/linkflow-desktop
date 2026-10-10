import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {join} from 'node:path';
import type {Account,BloggerConnectionResult,Snapshot} from '../src/shared/types';

type ElementNode={type:string;props:Record<string,unknown>;children:unknown[]};
type BloggerComponent=(props:Record<string,unknown>)=>unknown;

const root=process.cwd();
const stamp='2026-10-10T00:00:00.000Z';
const existing:Account={id:'account-existing',channelId:'blogger',email:'owner@example.com',username:'google-owner',displayName:'Google Owner',credentialKind:'oauth',status:'registered',hasPassword:true,source:'imported',createdAt:stamp};

function snapshot(options:{account?:Account;secondBinding?:boolean}={}):Snapshot{
  const sites:Snapshot['sites']=[
    {id:'site-one',domain:'one.example',url:'https://one.example/',email:'owner@one.example',name:'One',description:'fixture',category:'general',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp,blogger:{blogId:'blog-one',url:'https://one.blogspot.com/'}},
    {id:'site-two',domain:'two.example',url:'https://two.example/',email:'owner@two.example',name:'Two',description:'fixture',category:'general',language:'en',monthlyTarget:2,status:'ready',createdAt:stamp,...(options.secondBinding?{blogger:{blogId:'blog-two',url:'https://two.blogspot.com/'}}:{})},
  ];
  const accountBindings:Snapshot['accountBindings']=options.account?[{id:'binding-one',siteId:'site-one',channelId:'blogger',accountId:options.account.id,createdAt:stamp,updatedAt:stamp},...(options.secondBinding?[{id:'binding-two',siteId:'site-two',channelId:'blogger',accountId:options.account.id,createdAt:stamp,updatedAt:stamp}]:[])]:[];
  return {sites,tasks:[],channels:[],accounts:options.account?[options.account]:[],accountBindings,mailboxes:[],events:[],settings:{provider:'codex',codexPath:'codex',model:'',articleReviewMode:'ai',apiBase:'',hasApiKey:false,autoRun:true,launchAtLogin:false,notify:false,timezone:'Asia/Singapore',maxAttempts:3,maxSteps:30,dailyAiLimit:50,channelOverrides:{},mail:{host:'',port:993,user:'',secure:true,hasPassword:false}},runtime:{busy:false,aiReady:true,vaultReady:true,mailReady:false,version:'fixture',platform:'test',dataPath:'fixture',aiCallsToday:0}};
}

function flatten(value:unknown):unknown[]{
  if(Array.isArray(value))return value.flatMap(flatten);
  return value===undefined||value===null||value===false||value===true?[]:[value];
}

function textOf(value:unknown):string{
  if(typeof value==='string'||typeof value==='number')return String(value);
  if(Array.isArray(value))return value.map(textOf).join('');
  if(value&&typeof value==='object'&&'children' in value)return textOf((value as ElementNode).children);
  return '';
}

function findAll(value:unknown,predicate:(node:ElementNode)=>boolean,result:ElementNode[]=[]):ElementNode[]{
  if(Array.isArray(value)){for(const child of value)findAll(child,predicate,result);return result}
  if(!value||typeof value!=='object'||!('type' in value))return result;
  const node=value as ElementNode;
  if(predicate(node))result.push(node);
  for(const child of node.children)findAll(child,predicate,result);
  return result;
}

class HookFixture{
  private hooks:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[];
  private cursor=0;
  private scheduled=false;
  private pendingEffects:Array<()=>void>=[];
  tree:unknown;
  constructor(private Component:BloggerComponent,private props:Record<string,unknown>){}
  start(){this.tree=this.render()}
  jsx=(type:unknown,props:Record<string,unknown>|null)=>{
    const next=props??{};
    if(typeof type==='function')return type(next);
    if(typeof type==='symbol')return flatten(next.children);
    return {type:String(type),props:next,children:flatten(next.children)} satisfies ElementNode;
  };
  useState=<T,>(initial:T|(()=>T))=>{
    const index=this.cursor++;
    if(!this.hooks[index])this.hooks[index]={value:typeof initial==='function'?(initial as ()=>T)():initial};
    const set=(next:T|((current:T)=>T))=>{const current=this.hooks[index].value as T;this.hooks[index].value=typeof next==='function'?(next as (value:T)=>T)(current):next;this.schedule()};
    return [this.hooks[index].value as T,set] as const;
  };
  useRef=<T,>(initial:T)=>{const index=this.cursor++;if(!this.hooks[index])this.hooks[index]={value:{current:initial}};return this.hooks[index].value as {current:T}};
  useMemo=<T,>(factory:()=>T,_deps:unknown[])=>{this.cursor++;return factory()};
  useEffect=(effect:()=>void|(()=>void),deps:unknown[])=>{
    const index=this.cursor++,previous=this.hooks[index],changed=!previous?.deps||deps.some((value,item)=>value!==previous.deps?.[item])||deps.length!==previous.deps.length;
    if(!changed)return;
    this.pendingEffects.push(()=>{previous?.cleanup?.();const cleanup=effect();this.hooks[index]={deps,cleanup:typeof cleanup==='function'?cleanup:undefined}});
  };
  private schedule(){if(this.scheduled)return;this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.tree=this.render()})}
  private render(){this.cursor=0;this.pendingEffects=[];const value=this.Component(this.props);const effects=this.pendingEffects;this.pendingEffects=[];for(const effect of effects)effect();return value}
  unmount(){for(const hook of this.hooks)hook?.cleanup?.()}
  button(label:string){const node=findAll(this.tree,node=>node.type==='button'&&textOf(node)===label)[0];assert.ok(node,`missing button: ${label}`);return node}
  select(label:string){const node=findAll(this.tree,node=>node.type==='select'&&node.props['aria-label']===label)[0];assert.ok(node,`missing select: ${label}`);return node}
  inputs(){return findAll(this.tree,node=>node.type==='input')}
  contains(text:string){return textOf(this.tree).includes(text)}
}

async function component():Promise<BloggerComponent>{
  const bundled=await build({stdin:{contents:`export {BloggerConnection} from ${JSON.stringify(join(root,'src/ui/pages/BloggerConnection.tsx'))}`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',plugins:[{name:'react-fixture',setup(api){
    api.onResolve({filter:/^react$/},()=>({path:'react',namespace:'fixture'}));
    api.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx-runtime',namespace:'fixture'}));
    api.onResolve({filter:/^@phosphor-icons\/react$/},()=>({path:'icons',namespace:'fixture'}));
    api.onLoad({filter:/.*/,namespace:'fixture'},args=>{
      if(args.path==='react')return {contents:`const f=()=>globalThis.__bloggerReactFixture;export const useState=(...a)=>f().useState(...a);export const useRef=(...a)=>f().useRef(...a);export const useMemo=(...a)=>f().useMemo(...a);export const useEffect=(...a)=>f().useEffect(...a);`};
      if(args.path==='jsx-runtime')return {contents:`const f=()=>globalThis.__bloggerReactFixture;export const Fragment=Symbol.for('fixture.fragment');export const jsx=(...a)=>f().jsx(...a);export const jsxs=jsx;`};
      return {contents:`const Icon=()=>null;export {Icon as ArrowSquareOut,Icon as GoogleLogo,Icon as WarningCircle,Icon as X,Icon as House,Icon as LinkSimple};`};
    });
  }}]});
  const module={exports:{}} as {exports:{BloggerConnection:BloggerComponent}};
  new Function('module','exports',bundled.outputFiles[0].text)(module,module.exports);
  return module.exports.BloggerConnection;
}

function mount(Component:BloggerComponent,props:Record<string,unknown>){
  const originalDocument=(globalThis as {document?:unknown}).document;
  (globalThis as {document?:unknown}).document={activeElement:null,querySelector:()=>null,addEventListener:()=>{},removeEventListener:()=>{}};
  const holder={} as {fixture:HookFixture};
  Object.defineProperty(globalThis,'__bloggerReactFixture',{configurable:true,get:()=>holder.fixture});
  holder.fixture=new HookFixture(Component,props);
  holder.fixture.start();
  return {fixture:holder.fixture,restore(){holder.fixture.unmount();delete (globalThis as Record<string,unknown>).__bloggerReactFixture;(globalThis as {document?:unknown}).document=originalDocument}};
}

async function settle(){await Promise.resolve();await Promise.resolve();await new Promise<void>(resolve=>setImmediate(resolve));await Promise.resolve()}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}

test('Blogger connect and reconnect reuse the verified blogs without a second list request',async()=>{
  const BloggerConnection=await component();
  const calls:string[]=[];
  const account={...existing,id:'account-new'};
  const result:BloggerConnectionResult={account,blogs:[{id:'blog-new',name:'New Blog',url:'https://new.blogspot.com/'}]};
  const mounted=mount(BloggerConnection,{data:snapshot(),disabled:false,onClose:()=>{},onAction:async(command:string)=>{calls.push(command);return command==='account:connect-blogger'?result:undefined}});
  try{
    (mounted.fixture.button('选择桌面客户端 JSON 并连接').props.onClick as ()=>void)();
    await settle();
    assert.deepEqual(calls,['account:connect-blogger']);
    assert.equal(mounted.fixture.select('Blogger 博客').props.value,'blog-new');
    assert.ok(mounted.fixture.inputs().every(input=>input.props.checked===false),'new identity must not preselect sites');
  }finally{mounted.restore()}

  const reconnectCalls:string[]=[];
  const data=snapshot({account:existing,secondBinding:true});
  const reconnectResult:BloggerConnectionResult={account:existing,blogs:[{id:'blog-one',name:'One',url:'https://one.blogspot.com/'},{id:'blog-two',name:'Two',url:'https://two.blogspot.com/'}]};
  const reconnected=mount(BloggerConnection,{data,disabled:false,initialAccountId:existing.id,onClose:()=>{},onAction:async(command:string)=>{reconnectCalls.push(command);if(command==='account:blogger-blogs')return reconnectResult.blogs;if(command==='account:reconnect-blogger')return reconnectResult}});
  try{
    await settle();
    assert.deepEqual(reconnectCalls,['account:blogger-blogs']);
    reconnectCalls.length=0;
    (reconnected.fixture.button('重新授权此身份').props.onClick as ()=>void)();
    await settle();
    assert.deepEqual(reconnectCalls,['account:reconnect-blogger']);
    assert.equal(reconnected.fixture.select('Blogger 博客').props.value,'','different existing blog bindings must not be overwritten by a default');
    assert.deepEqual(reconnected.fixture.inputs().map(input=>input.props.checked),[true,true]);
  }finally{reconnected.restore()}
});

test('Blogger late OAuth results stay inert after close and empty snapshots show the creation path',async()=>{
  const BloggerConnection=await component();
  const pending=deferred<BloggerConnectionResult|undefined>();
  const calls:string[]=[];let closed=0;
  const mounted=mount(BloggerConnection,{data:snapshot(),disabled:false,onClose:()=>{closed++},onAction:async(command:string)=>{calls.push(command);if(command==='account:connect-blogger')return pending.promise;return {cancelled:true}}});
  try{
    (mounted.fixture.button('选择桌面客户端 JSON 并连接').props.onClick as ()=>void)();
    await settle();
    (mounted.fixture.button('取消连接').props.onClick as ()=>void)();
    pending.resolve({account:{...existing,id:'late-account'},blogs:[{id:'late-blog',name:'Late',url:'https://late.blogspot.com/'}]});
    await settle();
    assert.equal(closed,1);
    assert.deepEqual(calls,['account:connect-blogger','account:cancel-blogger']);
    assert.equal(findAll(mounted.fixture.tree,node=>node.type==='select'&&node.props['aria-label']==='Blogger 博客').length,0);
  }finally{mounted.restore()}

  const empty=mount(BloggerConnection,{data:snapshot(),disabled:false,onClose:()=>{},onAction:async(command:string)=>command==='account:connect-blogger'?{account:{...existing,id:'empty-account'},blogs:[]}:undefined});
  try{
    (empty.fixture.button('选择桌面客户端 JSON 并连接').props.onClick as ()=>void)();
    await settle();
    assert.ok(empty.fixture.contains('还没有 Blogger 博客'));
    assert.ok(empty.fixture.contains('去 Blogger 创建博客'));
  }finally{empty.restore()}
});

test('Blogger existing-account load and manual refresh remain available',async()=>{
  const BloggerConnection=await component();
  let reads=0;
  const mounted=mount(BloggerConnection,{data:snapshot({account:existing}),disabled:false,initialAccountId:existing.id,onClose:()=>{},onAction:async(command:string)=>{if(command!=='account:blogger-blogs')return undefined;reads++;return reads===1?[{id:'blog-one',name:'One',url:'https://one.blogspot.com/'}]:[{id:'blog-refreshed',name:'Refreshed',url:'https://refreshed.blogspot.com/'}]}});
  try{
    await settle();
    assert.equal(reads,1);
    assert.equal(mounted.fixture.select('Blogger 博客').props.value,'blog-one','existing binding stays preferred on initial load');
    (mounted.fixture.button('读取博客列表').props.onClick as ()=>void)();
    await settle();
    assert.equal(reads,2);
    assert.equal(mounted.fixture.select('Blogger 博客').props.value,'blog-refreshed');
  }finally{mounted.restore()}
});
