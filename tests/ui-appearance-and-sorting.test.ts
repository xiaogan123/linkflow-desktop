import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SortHeading,sortTableRows,toggleTableSort,unsorted} from '../src/ui/table-sort';

function luminance(hex:string){const channels=hex.slice(1).match(/../g)!.map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722}
function contrast(first:string,second:string){const a=luminance(first),b=luminance(second);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}
function colors(block:string){return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map(match=>[match[1],match[2]]))}

test('light and dark secondary text and status labels meet 4.5:1 contrast',()=>{
 const css=readFileSync('src/ui/styles.css','utf8');
 const light=colors(css.match(/:root\s*\{([^}]+)/)![1]);
 const dark={...light,...colors(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)/)![1])};
 for(const [theme,palette] of Object.entries({light,dark})){
  for(const background of ['surface','surface-soft','canvas'])assert.ok(contrast(palette.muted,palette[background])>=4.5,`${theme} secondary text on ${background}`);
  for(const tone of ['blue','green','amber','red','purple'])assert.ok(contrast(palette[tone],palette[tone+'-soft'])>=4.5,`${theme} ${tone} status`);
  assert.ok(contrast(palette['on-accent'],palette.blue)>=4.5,`${theme} primary button`);
 }
 assert.match(css,/@media\s*\(prefers-color-scheme:\s*dark\)/);
 assert.match(css,/:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)/);
});
test('all rendered CSS colors use tokens and text stays at least 12px',()=>{
 const css=readFileSync('src/ui/styles.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
 for(const match of css.matchAll(/([\w-]+):([^;{}]+)/g)){
  if(!match[1].startsWith('--'))assert.doesNotMatch(match[2].replace(/var\([^)]*\)/g,''),/#[0-9a-f]{3,8}\b|rgba?\(|\b(?:white|black|transparent)\b/i,`${match[1]} uses a literal color`);
 }
 for(const match of css.matchAll(/font-size:\s*([\d.]+)px/g))assert.ok(Number(match[1])>=12);
 assert.match(css,/table td,table th\{font-size:13px\}/);
 assert.match(css,/body\{min-width:960px/);
 assert.match(css,/\.main\{overflow:auto/);
});
test('table sorting toggles direction, compares numbers and leaves source rows unchanged',()=>{
 const rows=[{id:'first',name:'网站10',count:10},{id:'second',name:'网站2',count:2},{id:'third',name:'网站2',count:2}];
 const read=(row:typeof rows[number],key:string)=>key==='name'?row.name:row.count;
 const ascending=toggleTableSort(unsorted,'count');
 assert.deepEqual(sortTableRows(rows,ascending,read).map(row=>row.id),['second','third','first']);
 assert.deepEqual(sortTableRows(rows,toggleTableSort(ascending,'count'),read).map(row=>row.id),['first','second','third']);
 assert.deepEqual(sortTableRows(rows,toggleTableSort(ascending,'name'),read).map(row=>row.id),['second','third','first']);
 assert.deepEqual(rows.map(row=>row.id),['first','second','third']);
 const markup=renderToStaticMarkup(createElement(SortHeading,{column:'count',sort:ascending,onSort:()=>{},children:'外链'}));
 assert.match(markup,/aria-sort="ascending"/);assert.match(markup,/type="button"/);
});
