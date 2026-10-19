import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
import type {Settings} from '../src/shared/types';
import {emptyState} from '../src/main/store';

type Node={type:string;props:Record<string,any>;children:unknown[]};
class View{
 cells:unknown[]=[];deps:unknown[][]=[];cursor=0;effects:(()=>void)[]=[];changed=false;tree:unknown;
 constructor(public component:(props:Record<string,unknown>)=>unknown,public props:Record<string,unknown>){}
 useState=(initial:unknown)=>{const index=this.cursor++;if(!(index in this.cells))this.cells[index]=typeof initial==='function'?initial():initial;return [this.cells[index],(next:unknown)=>{const value=typeof next==='function'?next(this.cells[index]):next;if(!Object.is(value,this.cells[index])){this.cells[index]=value;this.changed=true}}]};
 useRef=(initial:unknown)=>{const index=this.cursor++;return this.cells[index]??(this.cells[index]={current:initial})};
 useEffect=(effect:()=>void,deps:unknown[])=>{const index=this.cursor++,previous=this.deps[index];if(!previous||deps.length!==previous.length||deps.some((value,i)=>!Object.is(value,previous[i]))){this.deps[index]=deps;this.effects.push(effect)}};
 jsx=(type:unknown,props:Record<string,unknown>|null)=>{if(typeof type==='function')return type(props??{});if(typeof type==='symbol')return props?.children;return {type:String(type),props:props??{},children:[props?.children].flat(Infinity)} satisfies Node};
 render(){let attempts=0;do{this.cursor=0;this.effects=[];this.changed=false;this.tree=this.component(this.props);for(const effect of this.effects)effect();assert.ok(++attempts<5)}while(this.changed);return this.tree}
 find(predicate:(node:Node)=>boolean){const found:Node[]=[];function visit(value:unknown){if(Array.isArray(value)){value.forEach(visit);return}if(value&&typeof value==='object'&&'type' in value){const node=value as Node;if(predicate(node))found.push(node);node.children.forEach(visit)}}visit(this.tree);return found}
}
async function settingsComponent(){
 const icons=new Set<string>();
 for(const file of ['src/ui/pages/SettingsPage.tsx','src/ui/ahrefs-settings.tsx','src/ui/components.tsx']){
  const source=readFileSync(file,'utf8');for(const match of source.matchAll(/import \{([^}]+)\} from '@phosphor-icons\/react'/g))for(const name of match[1].split(','))icons.add(name.trim());
 }
 const output=await build({stdin:{contents:`export {SettingsPage} from ${JSON.stringify(path.resolve('src/ui/pages/SettingsPage.tsx'))}`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',plugins:[{name:'settings-view',setup(api){
  api.onResolve({filter:/^(?:react(?:\/jsx-runtime)?|@phosphor-icons\/react)$/},args=>({path:args.path,namespace:'fixture'}));
  api.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='react'?`const view=()=>globalThis.__settingsView; export const useState=(...args)=>view().useState(...args);export const useRef=(...args)=>view().useRef(...args);export const useEffect=(...args)=>view().useEffect(...args);`:args.path==='react/jsx-runtime'?`export const Fragment=Symbol.for('fragment');export const jsx=(...args)=>globalThis.__settingsView.jsx(...args);export const jsxs=jsx;`:[...icons].map(name=>`export const ${name}=()=>null;`).join('\n')}));
 }}]});
 const module={exports:{}} as {exports:{SettingsPage:(props:Record<string,unknown>)=>unknown}};
 new Function('module','exports',output.outputFiles[0].text)(module,module.exports);return module.exports.SettingsPage;
}

test('appearance choice preserves other settings and update deep links stay inside settings',async()=>{
 const Component=await settingsComponent();let updated:Settings|undefined;
 const settings={...emptyState().settings,appearance:'light' as const,dailyAiLimit:37};
 const props={settings,setSettings:(value:Settings)=>{updated=value},snapshot:null,apiKey:'',setApiKey:()=>{},mailPassword:'',setMailPassword:()=>{},disabled:false,onSave:async()=>true,onAction:async()=>undefined,onResult:()=>{},onBackup:()=>{},onOpenUpdate:()=>{},initialSection:'appearance',updateContent:{type:'p',props:{id:'embedded-update'},children:['当前版本 1.2.36']}};
 const view=new View(Component,props);(globalThis as Record<string,unknown>).__settingsView=view;
 try{
  view.render();const choices=view.find(node=>node.type==='input'&&node.props.name==='appearance');
  assert.equal(choices.length,3);assert.deepEqual(choices.map(node=>node.props.checked),[false,true,false]);
  choices[2].props.onChange();assert.equal(updated?.appearance,'dark');assert.equal(updated?.dailyAiLimit,37);assert.equal(updated?.provider,settings.provider);
  view.props={...props,initialSection:'update'};view.render();
  assert.equal(view.find(node=>node.props.id==='embedded-update').length,1);
  assert.equal(view.find(node=>node.props.name==='appearance').length,0);
  assert.equal(view.find(node=>node.type==='button'&&node.props.id==='setting-tab-update')[0].props['aria-selected'],true);
 }finally{delete (globalThis as Record<string,unknown>).__settingsView}
});
