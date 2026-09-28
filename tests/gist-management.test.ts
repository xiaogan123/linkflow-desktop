import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptGist,connectGist} from '../src/main/gist-management';
import {Store} from '../src/main/store';
import {liveThisMonth} from '../src/main/planner';
import {validateBackup} from '../src/main/backup-validation';
import {CHANNELS,matchChannels} from '../src/integrations/catalog';
import {requiresArticleReview} from '../src/integrations/eligibility';
import {safeMessage} from '../src/main/validation';

const id='11111111-1111-4111-8111-111111111111';
const url='https://gist.github.com/octocat/aabbccddeeff11223344556677889900';
const createdAt='2026-09-20T01:00:00.000Z';
const deps={read:async()=>({url,login:'octocat',createdAt}),verify:async()=>({found:true,url,rel:'nofollow',reason:''}),now:()=>new Date('2026-09-28T01:00:00.000Z')};
function fixture(){const store=new Store(':memory:');store.update(s=>{s.settings.timezone='UTC';s.sites.push({id,domain:'example.com',url:'https://example.com/',name:'Example',email:'owner@example.com',category:'finance',description:'Original technical templates',language:'en',monthlyTarget:2,status:'ready',createdAt})});return store;}
test('adoption verifies before storing, preserves publication month, is idempotent and survives backup',async()=>{
 const store=fixture();try{const taskId=await adoptGist(store,id,url,deps);await adoptGist(store,id,url,deps);
 const s=store.read(),task=s.tasks[0];assert.equal(s.tasks.length,1);assert.equal(task.id,taskId);assert.equal(task.status,'live');assert.equal(task.firstLiveAt,createdAt);assert.equal(task.publicationMethod,'external');assert.equal(task.linkRel,'nofollow');
 assert.equal(liveThisMonth(id,s.tasks,deps.now(),'UTC'),1);assert.equal(liveThisMonth(id,s.tasks,new Date('2026-10-01'),'UTC'),0);
 assert.equal(validateBackup({state:s,secrets:{}}).state.tasks[0].publicationMethod,'external');
 }finally{store.close()}
});
test('private, missing-link, undated and future Gists never create a counted task',async()=>{
 const store=fixture();try{for(const invalid of [
 {...deps,read:async()=>{throw Error('Private or invalid')}},
 {...deps,verify:async()=>({found:false,url,rel:'',reason:'No link'})},
 {...deps,read:async()=>({url,login:'octocat'})},
 {...deps,read:async()=>({url,login:'octocat',createdAt:'2027-01-01'})}
 ]){await assert.rejects(adoptGist(store,id,url,invalid));assert.equal(store.read().tasks.length,0)}}finally{store.close()}
});
test('old publication is recorded but not credited to current month; competing source URL is rejected',async()=>{
 const store=fixture();try{await adoptGist(store,id,url,{...deps,read:async()=>({url,login:'octocat',createdAt:'2026-08-01T00:00:00.000Z'})});assert.equal(liveThisMonth(id,store.read().tasks,deps.now(),'UTC'),0);
 await assert.rejects(adoptGist(store,id,url,{...deps,read:async()=>({url:url+'aa',login:'octocat',createdAt})}),/已有其他/);assert.equal(store.read().tasks.length,1);
 }finally{store.close()}
});
test('connection validates before saving encrypted secret, reuses one identity and keeps multiple identities separate',async()=>{
 const store=fixture(),secrets=new Map<string,string>();const vault={get:async(k:string)=>secrets.get(k),set:async(k:string,v:string)=>{secrets.set(k,v)},delete:async(k:string)=>{secrets.delete(k)}};
 try{await assert.rejects(connectGist(store,vault,'bad',async()=>{throw Error('Invalid')}));assert.equal(secrets.size,0);assert.equal(store.read().accounts.length,0);
 const a=await connectGist(store,vault,'synthetic-token',async()=> 'octocat');const b=await connectGist(store,vault,'replacement-token',async()=> 'octocat');assert.equal(a.id,b.id);assert.equal(secrets.get('account:'+a.id),'replacement-token');assert.equal(a.credentialKind,'api_token');assert.equal(JSON.stringify(store.read()).includes('replacement-token'),false);
 const other=await connectGist(store,vault,'other-token',async()=> 'another-user');assert.notEqual(other.id,a.id);assert.equal(store.read().accounts.length,2);assert.equal(secrets.get('account:'+a.id),'replacement-token');assert.equal(secrets.get('account:'+other.id),'other-token');
 await assert.rejects(connectGist(store,vault,'wrong-owner',a.id,async()=> 'third-user'),/不会覆盖/);assert.equal(store.read().accounts.length,2);
 }finally{store.close()}
});
test('Gist requires a project qualification and always requires draft review; token error text is masked',()=>{
 const store=fixture();try{const site=store.read().sites[0],c=CHANNELS.find(c=>c.id==='github-gist')!;assert.equal(matchChannels(site,[c]).length,0);site.qualifications={developer:'https://example.com/templates'};assert.equal(matchChannels(site,[c]).length,1);site.category='ai';assert.equal(requiresArticleReview(site,c),true);assert.equal(safeMessage('failed ghp_123456789abcdefgh github_pat_12345abc').includes('12345'),false)}finally{store.close()}
});
