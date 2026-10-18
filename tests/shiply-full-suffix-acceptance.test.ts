import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CHANNELS} from '../src/integrations/catalog';
import {createShiplySite,finalizeShiplySite,parseShiplyCreateResponse,shiplyRequest,shiplySha256,uploadShiplySite,SHIPLY_CREATE_URL,SHIPLY_ORIGIN,type ShiplyCreateReceipt,type ShiplyIntent,type ShiplyOpaqueResponse,type ShiplyPersistence} from '../src/integrations/shiply';
import {parseShiplyVerifyOpaque,parseShiplyVerifySecret,requestShiplyCode,verifyShiplyCode} from '../src/main/shiply-management';
import {shiplyPublisherTesting,runShiplyTask} from '../src/integrations/shiply-publisher';
import {Store,emptyState} from '../src/main/store';
import {Controller} from '../src/main/controller';
import {shiplyTaskIdentity} from '../src/main/shiply-publication';
import {validateBackup} from '../src/main/backup-validation';
import {decryptBackup,encryptBackup} from '../src/main/backup';
import type {Vault} from '../src/main/vault';
import type {Account,ExecutionContext,Site,Task} from '../src/shared/types';

const at='2026-10-14T00:00:00.000Z',accountId='11111111-2222-4333-8444-555555555555',email='owner@example.test',emailHash=shiplySha256(email),key='shp_'+ 'A'.repeat(32),slug='owned-page',page=`https://${slug}.shiply.now/`,uploadUrl='https://bucket.r2.cloudflarestorage.com/index.html?sig=fixture',html='<!doctype html><html><head><title>Guide</title></head><body><article><section><p>Original guide.</p></section></article></body></html>';
function response(url:string,body:string,status=200,contentType='application/json'){const value=new Response(body,{status,headers:{'content-type':contentType}});Object.defineProperty(value,'url',{value:url});Object.defineProperty(value,'redirected',{value:false});return value}
function body(overrides:Record<string,unknown>={}){return {slug,siteUrl:page,expiresAt:null,toUpdate:'POST the exact existing site update endpoint',upload:{versionId:'version-1',uploads:[{path:'index.html',method:'PUT',url:uploadUrl,headers:{'content-type':'text/html'}}],skipped:[],finalizeUrl:`${SHIPLY_ORIGIN}/api/v1/publish/${slug}/finalize`,expiresInSeconds:900},...overrides}}
function intent():ShiplyIntent{const request=shiplyRequest(html,'Guide','Original guide');return {operationId:'shiply_11111111111141118111111111111111',accountId,emailHash,sourceHash:request.sourceHash,requestHash:request.requestHash,createdAt:at}}
function ownerReceipt():ShiplyCreateReceipt{return {...intent(),slug,siteUrl:page,versionId:'version-1',finalizeUrl:`${SHIPLY_ORIGIN}/api/v1/publish/${slug}/finalize`,expiresAt:'2026-10-14T01:00:00.000Z',upload:{path:'index.html',method:'PUT',url:uploadUrl,headers:{'content-type':'text/html'}}}}
function ownerDetail(overrides:Record<string,unknown>={}){return {id:'site-fixture',slug,title:'Guide',status:'live',accessMode:'private',addedToProfile:false,clientId:'client-fixture',currentVersionId:'version-1',handoffPending:false,handoffToEmail:null,showInGallery:false,spaMode:false,thumbnailR2Key:null,versions:[{id:'version-1',status:'finalized',fileCount:1,totalBytes:Buffer.byteLength(html),finalizedAt:'2026-10-14T00:01:00.000Z'}],...overrides}}
function opaque(value:unknown,overrides:Partial<ShiplyOpaqueResponse>={}):ShiplyOpaqueResponse{const bytes=Buffer.from(JSON.stringify(value));return {...intent(),kind:'shiply_create_response',version:1,status:200,contentType:'application/json',responseUrl:SHIPLY_CREATE_URL,redirected:false,bodyBase64:bytes.toString('base64'),bodySha256:shiplySha256(bytes),...overrides}}
function memory(){let savedIntent:ShiplyIntent|undefined,savedOpaque:ShiplyOpaqueResponse|undefined;const stages:string[]=[];const persistence:ShiplyPersistence={async persistIntent(next){if(savedIntent)throw Error('replay');savedIntent=next},assertWriteAuthorized(){assert.ok(savedIntent);return true},async persistOpaque(value){savedOpaque=value},async loadOpaque(){return savedOpaque},async markStage(_value,stage){stages.push(stage)},async markCreateUnknown(){stages.push('create_unknown')}};return {persistence,stages,opaque:()=>savedOpaque}}
function lifecycleFixture(){
  const siteId='22222222-2222-4222-8222-222222222222',taskId='11111111-1111-4111-8111-111111111111';
  const site:Site={id:siteId,domain:'example.com',url:'https://example.com/',email,category:'software',language:'en',name:'Example',description:'Software',monthlyTarget:1,articleReviewMode:'manual',qualifications:{software:'https://example.com/product',developer:'https://example.com/releases'},status:'ready',createdAt:at,analyzedAt:at,topicsCheckedAt:at,topics:[{url:'https://example.com/releases',discoveredAt:at}]};
  const task:Task={id:taskId,siteId,channelId:'shiply',sourceDomain:'shiply.now',accountId,status:'queued',createdAt:at,scheduledAt:'2026-10-13T12:00:00.000Z',updatedAt:at,attempts:0,message:'fixture',topicUrl:'https://example.com/releases',draft:{title:'Safe publication recovery',description:'A practical guide',body:'# Safe publication recovery\n\nCheck the [release record](https://example.com/releases) before retrying.'},draftRevision:1,articleApprovedAt:at,health:'pending'};
  const account:Account={id:accountId,channelId:'shiply',email,username:email,credentialKind:'api_token',status:'registered',hasPassword:true,source:'generated',createdAt:at,verifiedAt:at,registeredAt:at,shiply:{version:1,emailHash,requestedAt:at,stage:'ready',keyFingerprint:shiplySha256(key)}};
  const state=emptyState(),catalog=CHANNELS.map(value=>({...value,enabled:value.id==='shiply'}));state.settings.autoRun=true;state.settings.notify=false;state.settings.articleReviewMode='manual';state.settings.timezone='UTC';state.settings.channelOverrides=Object.fromEntries(catalog.map(value=>[value.id,value.id==='shiply']));state.sites=[site];state.accounts=[account];state.accountBindings=[{id:'44444444-4444-4444-8444-444444444444',siteId,channelId:'shiply',accountId,createdAt:at,updatedAt:at}];state.tasks=[task];
  const verifyBytes=Buffer.from(JSON.stringify({apiKey:key,email})),verifySecret=JSON.stringify({version:1,status:200,responseUrl:`${SHIPLY_ORIGIN}/api/auth/agent/verify-code`,redirected:false,contentType:'application/json',bodyBase64:verifyBytes.toString('base64'),bodyHash:shiplySha256(verifyBytes),emailHash});
  return {siteId,taskId,site,task,account,state,catalog,verifySecret};
}
function testVault(plaintext:Map<string,string>):Vault{return {ready:true,available:()=>true,get:async(name:string)=>plaintext.get(name),encryptSecrets:(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).map(([name,value])=>{plaintext.set(name,value);return [name,'cipher:'+Buffer.from(value).toString('base64url')]}))} as unknown as Vault}

const badge='<a href="https://shiply.now/?ref=badge" target="_blank" rel="noopener" style="position:fixed;bottom:8px;right:8px;z-index:2147483646;background:rgba(23,23,23,.85);color:#fff;font:12px/1 -apple-system,sans-serif;padding:6px 10px;border-radius:6px;text-decoration:none">Published with shiply →</a>';
const beacon=`<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v${'a'.repeat(40)}" integrity="sha512-${'A'.repeat(86)}==" data-cf-beacon='{"version":"2024.11.0","token":"${'a'.repeat(32)}","r":1,"spa":2}' crossorigin="anonymous"></script>`;
for(const [caseName,injection,expected] of [
 ['known_suffix',badge+beacon,'found'],
 ['duplicate_body_onload','<body onload="globalThis.__audit=1">'+badge+beacon,'invalid'],
 ['duplicate_html_onload','<html onload="globalThis.__audit=1">'+badge+beacon,'invalid'],
 ['duplicate_body_filter','<body style="filter:blur(10px)">'+badge+beacon,'invalid'],
] as const)test(`full accepted path: ${caseName}`,async()=>{
 const f=lifecycleFixture(),identity=shiplyTaskIdentity(f.task,f.site)!;assert.ok(identity);f.task.shiply={...intent(),sourceHash:identity.sourceHash,requestHash:identity.requestHash,slug,versionId:'version-1',stage:'api_receipt'};f.task.submittedAt=at;f.task.publicUrl=page;
 const calls:string[]=[];const actual=identity.html.replace('</body>',injection+'</body>');
 const fetch=async(url:string,init:RequestInit)=>{assert.equal(init.method,'GET');calls.push(url);if(url===`${SHIPLY_ORIGIN}/api/v1/publishes`)return response(url,JSON.stringify([{slug}]));if(url===`${SHIPLY_ORIGIN}/api/v1/publish/${slug}`)return response(url,JSON.stringify(ownerDetail({versions:[{id:'version-1',status:'finalized',fileCount:1,totalBytes:Buffer.byteLength(identity.html),finalizedAt:at}]})));if(url===`${page}robots.txt`)return response(url,'User-agent: *\nAllow: /\n',200,'text/plain');if(url===page)return response(url,actual,200,'text/html');throw Error('unanticipated synthetic route')};
 const result=await shiplyPublisherTesting.accepted(f.task,{site:f.site},f.task.topicUrl!,key,{fetch});console.log(JSON.stringify({case:caseName,status:result.status,syntheticGets:calls.length,externalRequests:0,nativeVisibilityTested:false}));assert.equal(result.status,expected);
});
