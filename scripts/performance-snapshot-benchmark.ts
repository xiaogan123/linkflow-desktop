import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Controller} from '../src/main/controller';
import {matchChannels} from '../src/integrations/catalog';
import {capacityFor} from '../src/main/planner';
import {Store,emptyState} from '../src/main/store';
import type {Site,Task} from '../src/shared/types';

type Sample={sites:number;tasksPerSite:number;draftsPerSite:number;draftBodyChars:number;repeatRefreshes:number;coldSnapshotMs:number;medianRefreshMs:number;p95RefreshMs:number;snapshotBytes:number;heapDeltaBytes:number};

const taskText='Synthetic draft body used only for repeatable local performance measurement. '.repeat(90);
const stamp='2026-10-17T00:00:00.000Z';

function fixture(siteCount:number,tasksPerSite:number){
  const state=emptyState();
  state.settings.timezone='UTC';
  state.sites=Array.from({length:siteCount},(_,index):Site=>({
    id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,
    domain:`synthetic-${index}.example.test`,url:`https://synthetic-${index}.example.test/`,
    email:`site-${index}@example.test`,publicEmail:`site-${index}@example.test`,name:`Synthetic ${index}`,
    description:'Synthetic website for a local performance measurement only.',category:'developer',language:'en',monthlyTarget:10,
    articleReviewMode:'manual',status:'ready',createdAt:stamp,analyzedAt:stamp,qualifications:{developer:'synthetic'},
  }));
  state.tasks=state.sites.flatMap((site,siteIndex)=>Array.from({length:tasksPerSite},(_,taskIndex):Task=>({
    id:`10000000-${String(siteIndex).padStart(4,'0')}-4000-8000-${String(taskIndex).padStart(12,'0')}`,
    siteId:site.id,channelId:taskIndex%2?'telegraph':'github-gist',sourceDomain:taskIndex%2?'telegra.ph':'gist.github.com',
    status:taskIndex%3===0?'live':'queued',createdAt:stamp,scheduledAt:stamp,updatedAt:stamp,attempts:0,
    message:'Synthetic task progress.',reason:'Synthetic fixture; no account, credential, user content, or external URL is included.',health:taskIndex%3===0?'healthy':'pending',
    ...(taskIndex%4===0?{draft:{title:`Synthetic draft ${siteIndex}-${taskIndex}`,description:'Local benchmark draft only.',body:taskText},draftRevision:1}:{}),
    ...(taskIndex%3===0?{publicUrl:`https://example.test/${siteIndex}/${taskIndex}`,firstLiveAt:stamp,verifiedAt:stamp,lastCheckedAt:stamp,linkCheck:'found' as const,linkRel:'nofollow',publicationMethod:'client' as const}:{}),
    cost:{aiCalls:0},history:[],
  })));
  return state;
}

function percentile(sorted:number[],fraction:number){return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)]!}

function legacySnapshot(controller:Controller){const state=controller.store.read(),channels=controller.channels(),now=new Date(),capacity=state.sites.map(site=>capacityFor(site,state.tasks,matchChannels(site,channels),channels,now,state.settings.timezone,state));return {...state,channels,capacity}}
function measure(siteCount:number,tasksPerSite:number,iterations:number,legacy=false):Sample{
  const store=new Store(':memory:');
  store.restore(fixture(siteCount,tasksPerSite),{});
  const controller=new Controller(store,{ready:false,available:()=>false} as never,'/tmp/linkflow-performance-fixture');
  const heapBefore=process.memoryUsage().heapUsed,coldStarted=performance.now(),cold=legacy?legacySnapshot(controller):controller.snapshot(),coldSnapshotMs=performance.now()-coldStarted;
  const timings:number[]=[];let snapshotBytes=Buffer.byteLength(JSON.stringify(cold));
  for(let index=0;index<iterations;index++){
    const started=performance.now(),snapshot=legacy?legacySnapshot(controller):controller.snapshot();
    timings.push(performance.now()-started);
    snapshotBytes=Buffer.byteLength(JSON.stringify(snapshot));
  }
  controller.stop();store.close();timings.sort((left,right)=>left-right);
  return {sites:siteCount,tasksPerSite,draftsPerSite:Math.ceil(tasksPerSite/4),draftBodyChars:taskText.length,repeatRefreshes:timings.length,coldSnapshotMs:Number(coldSnapshotMs.toFixed(3)),medianRefreshMs:Number(percentile(timings,0.5).toFixed(3)),p95RefreshMs:Number(percentile(timings,0.95).toFixed(3)),snapshotBytes,heapDeltaBytes:process.memoryUsage().heapUsed-heapBefore};
}

const legacy=process.argv.includes('--legacy'),output=process.argv.find(value=>!value.startsWith('--')&&value!==process.argv[0]&&value!==process.argv[1])??resolve('.evidence/release-1.2.36/performance/snapshot-benchmark.json');
const report={generatedAt:new Date().toISOString(),runtime:{platform:process.platform,arch:process.arch,node:process.version},mode:legacy?'unindexed comparison path':'indexed snapshot path',fixture:'Synthetic local state only; no real accounts, drafts, credentials, or sites.',samples:legacy?[measure(50,12,2,true)]:[measure(50,12,4),measure(100,12,2)]};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
process.stdout.write(JSON.stringify(report,null,2)+'\n');
