import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import {openInPreferredBrowser} from '../src/main/external-browser';

class FakeChild extends EventEmitter {
  unrefCalls=0;
  unref(){this.unrefCalls++;return this}
}

const spawner=(child:FakeChild,capture:(options:unknown)=>void=()=>{})=>(_command:string,_args:string[],options:unknown)=>{capture(options);return child as unknown as ChildProcess};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('a long-lived preferred browser resolves as soon as it spawns',async()=>{
  const child=new FakeChild();let fallback=0,options:unknown,completed=false;
  const opening=openInPreferredBrowser('https://example.com','chrome',async()=>{fallback++},'win32',spawner(child,value=>{options=value})).then(()=>{completed=true});
  child.emit('spawn');await opening;
  assert.equal(completed,true);assert.equal(fallback,0);assert.equal(child.unrefCalls,1);
  assert.deepEqual(options,{shell:false,stdio:'ignore',detached:false});
  child.emit('close',1);child.emit('error',Error('late failure'));await tick();assert.equal(fallback,0);
});

test('an early launch error falls back once even if close follows',async()=>{
  const child=new FakeChild();let fallback=0;
  const opening=openInPreferredBrowser('https://example.com','edge',async()=>{fallback++},'win32',spawner(child));
  child.emit('error',Error('not found'));child.emit('close',-1);await opening;
  assert.equal(fallback,1);assert.equal(child.unrefCalls,0);
});

test('the macOS open launcher waits for its exit code and falls back once on failure',async()=>{
  const child=new FakeChild();let fallback=0,completed=false;
  const opening=openInPreferredBrowser('https://example.com','chrome',async()=>{fallback++},'darwin',spawner(child)).then(()=>{completed=true});
  child.emit('spawn');await tick();assert.equal(completed,false);
  child.emit('close',1);child.emit('error',Error('late duplicate'));await opening;
  assert.equal(completed,true);assert.equal(fallback,1);assert.equal(child.unrefCalls,0);
});

test('the macOS open launcher completes without fallback after exit zero',async()=>{
  const child=new FakeChild();let fallback=0;
  const opening=openInPreferredBrowser('https://example.com','edge',async()=>{fallback++},'darwin',spawner(child));
  child.emit('spawn');child.emit('close',0);await opening;
  assert.equal(fallback,0);
});

test('a synchronous spawn failure uses the system browser once',async()=>{
  let fallback=0;
  await openInPreferredBrowser('https://example.com','chrome',async()=>{fallback++},'linux',()=>{throw Error('synthetic spawn failure')});
  assert.equal(fallback,1);
});
