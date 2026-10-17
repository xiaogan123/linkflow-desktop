import assert from 'node:assert/strict';
import test from 'node:test';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {analyzeWebsiteHtml} from '../src/integrations/web';
const stamp='2026-10-17T00:00:00.000Z';
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(count:number,interrupted=false){
  const store=new Store(':memory:');
  const sites=Array.from({length:count},(_,i)=>({id:'site-'+i,domain:`fixture-${i}.example.com`,url:`https://fixture-${i}.example.com/`,email:'owner@example.com',name:'fixture',description:'fixture',category:'developer' as const,language:'en',monthlyTarget:2,status:(interrupted?'analyzing':'ready') as 'analyzing'|'ready',createdAt:stamp,qualifications:{developer:'fixture'}}));
  store.update(s=>{s.sites=sites;s.settings.autoRun=false});
  const started:string[]=[],release=new Map<string,()=>void>();
  const controller=new Controller(store,{available:()=>false} as never,'analysis-startup-fixture',{analyzeWebsite:async(domain,signal)=>{started.push(domain);await new Promise<void>(resolve=>release.set(domain,resolve));if(signal?.aborted)throw Error('aborted');return analyzeWebsiteHtml('<html lang="en"><title>Fixture complete</title><p>Public website description.</p></html>',`https://${domain}/`)},discoverTopics:async()=>({topics:[],checkedAt:stamp}),discoverTechnicalMaterial:async()=>undefined});
  return {store,sites,controller,started,release,async finish(){for(let i=0;i<5;i++){const callbacks=[...release.values()];release.clear();callbacks.forEach(done=>done());await flush();}},async close(){controller.stop();await this.finish();store.close();}};
}
test('startup preserves analyses that were queued while the visible window awaited AI detection',async()=>{
 const f=fixture(4);try{
  const done=f.sites.map(s=>f.controller.analyze(s.id));void done;
  assert.equal(f.started.length,2);f.controller.start();await f.finish();
  assert.equal(f.started.length,4,'all pre-start analyses must run');
  assert.equal(f.controller.hasPendingWork(),false);assert(f.store.read().sites.every(s=>s.status==='ready'),JSON.stringify(f.store.read().sites.map(s=>({status:s.status,error:s.error}))));
 }finally{await f.close()}
});
test('pause before startup cancels persisted pending analysis and never resumes the paused site',async()=>{
 const f=fixture(1,true);try{
  f.controller.sitePause(f.sites[0].id,true);assert.equal(f.store.read().sites[0].status,'paused');
  f.controller.start();await f.finish();
  assert.equal(f.started.length,0,'paused site must not restart analysis');
  assert.equal(f.store.read().sites[0].status,'paused');
 }finally{await f.close()}
});
test('failure, deletion, duplicate calls and stop drain accepted ordinary queue work safely',async()=>{
 const f=fixture(5);try{
  const pending=f.sites.map(s=>f.controller.analyze(s.id));
  await f.controller.analyze(f.sites[2].id);assert.equal(f.started.length,2);
  f.controller.deleteSite(f.sites[2].id);await pending[2];
  f.controller.stop();await f.finish();await Promise.all(pending);
  assert.equal(f.started.length,2);assert.equal(f.controller.hasPendingWork(),false);
  assert(!f.store.read().sites.some(s=>s.id===f.sites[2].id));
 }finally{await f.close()}
});
