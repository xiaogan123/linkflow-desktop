import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  VALTOWN_ACCOUNT_URL,VALTOWN_MY_VALS_URL,VALTOWN_VALS_URL,VALTOWN_HTTP_FILE_PATH,
  createValTownHttpFile,createValTownVal,prepareValTownArtifact,probeValTownAccount,
  recoverValTownHttpFile,recoverValTownVal,valTownAliasUrl,valTownFileContentUrl,
  valTownFileListUrl,valTownFilesUrl,valTownValUrl,verifyValTownPublication,
  type ValTownAccountBinding,type ValTownArtifact,type ValTownIntent,type ValTownOpaqueResponse,
  type ValTownPersistence,type ValTownReceipt,type ValTownValReceipt,
} from '../src/integrations/valtown';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const token='vt_test_token_1234567890abcdef';
const username='synthetic_owner';
const ownerId='user_12345678';
const valId='val_12345678';
const fileId='file_12345678';
const valName='url-set-helper';
const targetUrl='https://example.test/software/releases';
const html=`<!doctype html><html><head><title>URL set helper</title></head><body><main><h1>URL set helper</h1><p>All processing stays in this browser.</p><a href="${targetUrl}">Software releases</a></main></body></html>`;
const source=`const html=${JSON.stringify(html)};\n\nexport default async function(req:Request):Promise<Response>{\n  return new Response(req.method==='GET'?html:null,{status:req.method==='GET'?200:405,headers:{'content-type':'text/html; charset=utf-8'}});\n}\n`;
const artifact:ValTownArtifact=prepareValTownArtifact({valName,description:'Compare two URL lists locally.',source,html,targetUrl,reviewedSourceHash:sha(source)});
const now='2026-10-24T10:00:00.000Z';
const operation={val:'valtown_11111111111111111111111111111111',file:'valtown_22222222222222222222222222222222'};

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const user=(tier:'free'|'pro'='free')=>({id:ownerId,bio:null,links:{self:`https://api.val.town/v1/users/${ownerId}`},profileImageUrl:null,type:'user',url:`https://www.val.town/u/${username}`,username,email:'owner@example.test',tier});
const val=(id=valId)=>({id,author:{id:ownerId,type:'user',username},createdAt:now,description:artifact.description,imageUrl:null,links:{html:`https://www.val.town/x/${username}/${valName}/code/`,self:`https://api.val.town/v2/vals/${id}`},name:valName,privacy:'public'});
const file=()=>({id:fileId,links:{html:`https://www.val.town/x/${username}/${valName}/code/${VALTOWN_HTTP_FILE_PATH}`,module:`https://esm.town/v/${username}/${valName}/${VALTOWN_HTTP_FILE_PATH}`,self:`https://api.val.town/v2/vals/${valId}/files?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`,endpoint:`https://${username}--${valName}.web.val.run/`},name:VALTOWN_HTTP_FILE_PATH,path:VALTOWN_HTTP_FILE_PATH,type:'http',updatedAt:now,version:1});
const fileRead=()=>({...file(),links:{...file().links,self:`https://api.val.town/v1/projects/${valId}/files?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`,endpoint:`https://${username}--${valName}.web.val.run`}});

function accountFetch(options:{tier?:'free'|'pro';page?:unknown}={}){return async(url:string,init:RequestInit)=>{assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${token}`);if(url===VALTOWN_ACCOUNT_URL)return json(user(options.tier));if(url===VALTOWN_MY_VALS_URL)return json(options.page??{data:[],links:{}});throw Error(`unexpected ${url}`)}}
function freshAccount(url:string,init:RequestInit){if(url===VALTOWN_ACCOUNT_URL||url===VALTOWN_MY_VALS_URL)return accountFetch()(url,init)}
async function binding():Promise<ValTownAccountBinding>{const result=await probeValTownAccount(token,{fetch:accountFetch(),now:()=>new Date(now)});assert.equal(result.status,'usable');if(result.status!=='usable')throw Error('probe');return result.binding}

function memory(options:{failIntent?:boolean;failOpaque?:boolean;failReceipt?:boolean}={}){
  const events:string[]=[],opaque=new Map<string,ValTownOpaqueResponse>();let intent:ValTownIntent|undefined,receipt:ValTownReceipt|undefined;
  const persistence:ValTownPersistence={secretStorage:'encrypted',async persistIntent(value){events.push('intent');if(options.failIntent)throw Error('disk');intent=structuredClone(value)},assertReadyToSubmit(value){events.push('authorize');assert.deepEqual(value,intent);return true},async persistOpaqueResponse(value){events.push('opaque');if(options.failOpaque)throw Error('disk');opaque.set(`${value.stage}:${value.operationId}`,structuredClone(value))},async loadOpaqueResponse(stage,id){return opaque.get(`${stage}:${id}`)},async promoteReceipt(value){events.push('receipt');if(options.failReceipt)throw Error('disk');receipt=structuredClone(value)}};
  return {persistence,events,get intent(){return intent},get receipt(){return receipt}};
}

async function createValReceipt(account:ValTownAccountBinding){const saved=memory();const result=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET'){assert.equal(url,valTownAliasUrl(username,valName));return json({},404)}assert.equal(url,VALTOWN_VALS_URL);return json(val(),201)}});assert.equal(result.status,'created');if(result.status!=='created'||result.receipt.stage!=='val_create')throw Error('val');return result.receipt}

test('artifact preparation binds the reviewed source, embedded HTML and only native target link',()=>{
  assert.equal(artifact.sourceHash,sha(source));assert.equal(artifact.htmlHash,sha(html));assert.equal(artifact.targetUrl,targetUrl);
  assert.throws(()=>prepareValTownArtifact({valName,description:artifact.description,source,html,targetUrl,reviewedSourceHash:'0'.repeat(64)}));
  assert.throws(()=>prepareValTownArtifact({valName,description:artifact.description,source,html:html.replace('</main>','<a href="https://other.example/">Other</a></main>'),targetUrl,reviewedSourceHash:sha(source)}));
});

test('account probe proves one free user identity and val-read response without leaking token or email',async()=>{
  const result=await probeValTownAccount(token,{fetch:accountFetch(),now:()=>new Date(now)});assert.equal(result.status,'usable');if(result.status!=='usable')return;assert.equal(result.binding.tier,'free');assert.equal(result.binding.username,username);assert.equal(result.binding.valRead,'confirmed');assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(result).includes('owner@example.test'),false);
  assert.deepEqual(await probeValTownAccount(token,{fetch:accountFetch({tier:'pro'})}),{status:'invalid',reason:'tier'});
  assert.deepEqual(await probeValTownAccount(token,{fetch:accountFetch({page:{items:[]}})}),{status:'invalid',reason:'account'});
});

test('writes are closed by default and failed durable intent performs zero POSTs',async()=>{
  const account=await binding();let calls=0;assert.deepEqual(await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},memory().persistence,{fetch:async()=>{calls++;throw Error('no')}}),{status:'not_started',reason:'external_write_disabled'});
  assert.deepEqual(await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},memory({failIntent:true}).persistence,{allowExternalWrite:true,fetch:async()=>{calls++;throw Error('no')}}),{status:'not_started',reason:'intent_not_persisted'});assert.equal(calls,0);
});

test('descriptions above the observed 64-character API limit stop before all network writes',async()=>{
  const account=await binding(),overlong={...artifact,description:'x'.repeat(65)};let calls=0;const result=await createValTownVal({operationId:operation.val,account,token,artifact:overlong,reviewed:true},memory().persistence,{allowExternalWrite:true,fetch:async()=>{calls++;throw Error('must not use network')}});assert.deepEqual(result,{status:'not_started',reason:'invalid_input'});assert.equal(calls,0);
});

test('val creation checks the alias then persists opaque response before receipt',async()=>{
  const account=await binding(),saved=memory();let posts=0;const result=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return json({},404);posts++;assert.equal(url,VALTOWN_VALS_URL);assert.deepEqual(JSON.parse(String(init.body)),{name:valName,privacy:'public',description:artifact.description});return json(val(),201)}});assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','receipt']);
});

test('a lost val-create response never repeats POST and GET cannot promote an unprovable receipt',async()=>{
  const account=await binding(),saved=memory();let posts=0;const first=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return json({},404);posts++;throw Error('lost')}});assert.equal(first.status,'unknown');assert.ok(saved.intent);
  const blocked=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true,priorIntent:saved.intent},saved.persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not')}});assert.equal(blocked.status,'blocked');
  const recovered=await recoverValTownVal(saved.intent as Extract<ValTownIntent,{stage:'val_create'}>,account,token,saved.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(url,valTownAliasUrl(username,valName));return json(val())}});assert.equal(recovered.status,'found_unowned');assert.equal(saved.receipt,undefined);assert.equal(posts,1);
  const old={...val(),createdAt:'2020-01-01T00:00:00.000Z',description:'Unrelated older project'};assert.equal((await recoverValTownVal(saved.intent as Extract<ValTownIntent,{stage:'val_create'}>,account,token,memory().persistence,{fetch:async()=>json(old)})).status,'mismatch');
  assert.equal(posts,1);
});

test('each mutation stage requires a fresh matching free-account probe immediately before authorization',async()=>{
  const account=await binding(),saved=memory();let posts=0;const result=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{if(url===valTownAliasUrl(username,valName))return json({},404);if(url===VALTOWN_ACCOUNT_URL)return json(user('pro'));if(url===VALTOWN_MY_VALS_URL)return json({data:[],links:{}});posts++;return json(val(),201)}});assert.deepEqual(result,{status:'not_started',reason:'account_check_required'});assert.equal(posts,0);assert.deepEqual(saved.events,['intent']);
});

test('HTTP file creation accepts an empty list plus content 404 and creates exactly one http trigger',async()=>{
  const account=await binding(),valReceipt=await createValReceipt(account),saved=memory();let posts=0;const result=await createValTownHttpFile({operationId:operation.file,account,token,artifact,valReceipt,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return url===valTownFileListUrl(valId)?json({data:[],links:{}}):new Response(null,{status:404});posts++;assert.equal(url,`${valTownFilesUrl(valId)}?path=${encodeURIComponent(VALTOWN_HTTP_FILE_PATH)}`);assert.deepEqual(JSON.parse(String(init.body)),{content:source,type:'http'});return json(file(),201)}});assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','receipt']);if(result.status==='created'&&result.receipt.stage==='http_file')assert.equal(result.receipt.publicUrl,`https://${username}--${valName}.web.val.run/`);
});

test('current code URLs are exact and reject cross-owner or cross-file link substitutions',async()=>{
  const account=await binding(),badVal={...val(),links:{...val().links,html:`https://www.val.town/x/other_owner/${valName}/code/`}},valSaved=memory();const valResult=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},valSaved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;return init.method==='GET'?json({},404):json(badVal,201)}});assert.equal(valResult.status,'rejected');
  const valReceipt=await createValReceipt(account),badFile={...file(),links:{...file().links,self:`https://api.val.town/v2/vals/${valId}/files?path=other.tsx`}},fileSaved=memory();const fileResult=await createValTownHttpFile({operationId:operation.file,account,token,artifact,valReceipt,reviewed:true},fileSaved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return url===valTownFileListUrl(valId)?json({data:[],links:{}}):new Response(null,{status:404});return json(badFile,201)}});assert.equal(fileResult.status,'rejected');
});

test('malformed file preflight fails closed before POST',async()=>{
  const account=await binding(),valReceipt=await createValReceipt(account),saved=memory();let posts=0;const result=await createValTownHttpFile({operationId:operation.file,account,token,artifact,valReceipt,reviewed:true},saved.persistence,{allowExternalWrite:true,fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return url===valTownFileListUrl(valId)?json({data:[file()],links:{}}):new Response(null,{status:404});posts++;return json(file(),201)}});assert.equal(result.status,'unknown');assert.equal(posts,0);
});

test('a lost file-create response is recovered from the exact current project-file GET shape without retry',async()=>{
  const account=await binding(),valReceipt=await createValReceipt(account),saved=memory();let posts=0;await createValTownHttpFile({operationId:operation.file,account,token,artifact,valReceipt,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;if(init.method==='GET')return new Response(null,{status:404});posts++;throw Error('lost')}});assert.ok(saved.intent);
  const recovered=await recoverValTownHttpFile(saved.intent as Extract<ValTownIntent,{stage:'http_file'}>,account,artifact,token,saved.persistence,{fetch:async url=>url===valTownFileListUrl(valId)?json({data:[fileRead()],links:{}}):new Response(source,{status:200,headers:{'content-type':'application/octet-stream'}})});assert.equal(recovered.status,'found');assert.equal(posts,1);
  const invalidSelf=[`https://api.val.town/v1/projects/val_87654321/files?path=${VALTOWN_HTTP_FILE_PATH}`,`https://api.val.town/v1/projects/${valId}/files?path=${VALTOWN_HTTP_FILE_PATH}&branch_id=main`,`https://api.val.town/v1/projects/${valId}/files?path=${VALTOWN_HTTP_FILE_PATH}&path=${VALTOWN_HTTP_FILE_PATH}`,`https://synthetic:secret@api.val.town/v1/projects/${valId}/files?path=${VALTOWN_HTTP_FILE_PATH}`,`https://example.test/v1/projects/${valId}/files?path=${VALTOWN_HTTP_FILE_PATH}`,`https://api.val.town/v1/projects/${valId}/files?path=other.tsx`];for(const self of invalidSelf){const metadata={...fileRead(),links:{...fileRead().links,self}},attempt=await recoverValTownHttpFile(saved.intent as Extract<ValTownIntent,{stage:'http_file'}>,account,artifact,token,memory().persistence,{fetch:async url=>url===valTownFileListUrl(valId)?json({data:[metadata],links:{}}):new Response(source,{status:200,headers:{'content-type':'application/octet-stream'}})});assert.equal(attempt.status,'mismatch')}
});

test('opaque success remains storage-pending until receipt persistence succeeds',async()=>{
  const account=await binding(),saved=memory({failReceipt:true});const result=await createValTownVal({operationId:operation.val,account,token,artifact,reviewed:true},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;return init.method==='GET'?json({},404):json(val(),201)}});assert.equal(result.status,'storage_pending');assert.ok(saved.intent);
  const recovered=await recoverValTownVal(saved.intent as Extract<ValTownIntent,{stage:'val_create'}>,account,token,saved.persistence,{fetch:async()=>{throw Error('opaque recovery must not GET')}});assert.equal(recovered.status,'storage_pending');
});

test('final verification rechecks free owner, exact source, anonymous HTML and robots',async()=>{
  const account=await binding(),valReceipt=await createValReceipt(account),fileSaved=memory();const created=await createValTownHttpFile({operationId:operation.file,account,token,artifact,valReceipt,reviewed:true},fileSaved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{const accountRead=freshAccount(url,init);if(accountRead)return accountRead;return init.method==='GET'?new Response(null,{status:404}):json(file(),201)}});assert.equal(created.status,'created');if(created.status!=='created'||created.receipt.stage!=='http_file')return;const receipt=created.receipt;
  const verifyFetch=(wrongValId=false)=>async(url:string,init:RequestInit)=>{if(url===VALTOWN_ACCOUNT_URL)return json(user());if(url===VALTOWN_MY_VALS_URL)return json({data:[val()],links:{}});if(url===valTownValUrl(valId))return json(wrongValId?val('val_87654321'):val());if(url===valTownFileListUrl(valId))return json({data:[fileRead()],links:{}});if(url===valTownFileContentUrl(valId))return new Response(source,{status:200,headers:{'content-type':'application/octet-stream'}});if(url===receipt.publicUrl){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(html,{status:200,headers:{'content-type':'text/html'}})}if(url===new URL('/robots.txt',receipt.publicUrl).href){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}})}throw Error(`unexpected ${url}`)};
  const result=await verifyValTownPublication(receipt,account,artifact,token,{now:()=>new Date(now),fetch:verifyFetch()});assert.equal(result.status,'usable');if(result.status==='usable'){assert.equal(result.robots,'allowed');assert.equal(result.pageSha256,artifact.htmlHash)}
  assert.deepEqual(await verifyValTownPublication(receipt,account,artifact,token,{now:()=>new Date(now),fetch:verifyFetch(true)}),{status:'invalid',reason:'val'});
});
