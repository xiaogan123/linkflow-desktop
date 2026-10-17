import assert from 'node:assert/strict';
import test from 'node:test';
import {Controller} from '../src/main/controller';
import {Store} from '../src/main/store';
import {analyzeWebsiteHtml} from '../src/integrations/web';
import type {Site} from '../src/shared/types';
import type {Vault} from '../src/main/vault';

const stamp='2026-10-17T00:00:00.000Z';
const site=(index:number):Site=>({id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,url:`https://queue-${index}.example.com/`,domain:`queue-${index}.example.com`,email:`owner-${index}@example.test`,name:`Queue ${index}`,description:'Fixture',category:'developer',language:'en',status:'ready',monthlyTarget:2,createdAt:stamp,analyzedAt:stamp,qualifications:{developer:'fixture'}});
const flush=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

test('site analysis admits two concurrent reads, preserves queued work, and cancels a paused queued site',async()=>{
  const store=new Store(':memory:'),sites=[0,1,2,3,4].map(site),release=new Map<string,()=>void>();let active=0,peak=0;const started:string[]=[];
  store.update(state=>{state.sites=sites;state.settings.autoRun=false});
  const controller=new Controller(store,{available:()=>true} as Vault,'analysis-queue-fixture',{analyzeWebsite:async(domain)=>new Promise(resolve=>{active++;peak=Math.max(peak,active);started.push(domain);release.set(domain,()=>{active--;resolve(analyzeWebsiteHtml('<html lang="en"><title>Fixture</title></html>',`https://${domain}/`))})}),discoverTopics:async()=>({topics:[],checkedAt:stamp}),discoverTechnicalMaterial:async()=>undefined});
  try{
    const pending=sites.map(value=>controller.analyze(value.id));await flush();
    assert.equal(started.length,2);assert.equal(peak,2);assert.equal(controller.hasPendingWork(),true);
    controller.sitePause(sites[4].id,true);
    while(release.size){for(const done of [...release.values()])done();release.clear();await flush();}
    await Promise.all(pending);
    assert.equal(started.includes(sites[4].domain),false);assert.equal(store.read().sites.find(value=>value.id===sites[4].id)?.status,'paused');assert.equal(peak,2);assert.equal(controller.hasPendingWork(),false);
  }finally{controller.stop();store.close();}
});
