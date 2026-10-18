import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {Store,emptyState} from '../src/main/store';
import {validateBackup} from '../src/main/backup-validation';
import {AGENTSWIKI_ME,AGENTSWIKI_RULE_VERSION,agentsWikiHash} from '../src/integrations/agentswiki';
import {AGENTSWIKI_REGISTRATION} from '../src/integrations/agentswiki-publisher';
import type {Account} from '../src/shared/types';

// Run the actual IPC case without starting Electron or touching a real keychain.
const main=readFileSync('src/main/main.ts','utf8'),source=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
let clause='';
function visit(node:ts.Node){if(ts.isCaseClause(node)&&ts.isStringLiteral(node.expression)&&node.expression.text==='account:delete')clause=node.getText(source);ts.forEachChild(node,visit)}
visit(source);assert.ok(clause);
const ipc=ts.transpileModule(`(async(name,p)=>{switch(name){${clause}}})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const at='2026-10-18T00:00:00.000Z',id='33333333-3333-4333-8333-333333333333',remoteId='44444444-4444-4444-8444-444444444444';
const apiKey='aw_fixture_0123456789012345678901234567890123456789',key='account:'+id,name=AGENTSWIKI_REGISTRATION.name,disclosure=AGENTSWIKI_REGISTRATION.public_disclosure;
const requestHash=agentsWikiHash(`GET\n${AGENTSWIKI_ME}\nauthorization:bearer\n`),operationId='agentswiki_import_'+id.replaceAll('-','');
function protectedIdentity():{account:Account;secret:string}{return {
 account:{id,channelId:'agentswiki',email:'',username:name,displayName:name,createdAt:at,updatedAt:at,registeredAt:at,verifiedAt:at,status:'registered',hasPassword:true,source:'imported',credentialKind:'api_token',registrationAttempts:0,agentsWiki:{version:1,stage:'ready',operationId,requestHash,ruleVersion:AGENTSWIKI_RULE_VERSION,publicationRights:true,remoteAccountId:remoteId,remoteCreatedAt:at,name,publicDisclosure:disclosure,role:'agent',keyPrefix:'aw_fixture_',keyFingerprint:agentsWikiHash(apiKey),checkedAt:at}},
 secret:JSON.stringify({version:1,kind:'agentswiki_account',mode:'imported',operationId,requestHash,account:{id:remoteId,name,publicDisclosure:disclosure,role:'agent',createdAt:at,keyPrefix:'aw_fixture_'},apiKey}),
}}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'linkflow-delete-atomic-')),path=join(dir,'state.sqlite'),store=new Store(path);
 const run=runInNewContext(ipc,{store,vault:{delete:async()=>{throw Error('standalone secret deletion is not atomic')}},forbidBusy:()=>{},getId:(p:{id:string})=>p.id,Error}) as (name:string,p:{id:string})=>Promise<void>;
 return {dir,path,store,run,cleanup(){try{store.close()}catch{}rmSync(dir,{recursive:true,force:true})}};
}
test('rejected protected account deletion preserves identity and cipher across database reopen',async()=>{
 const f=fixture();
 try{
  const {account,secret}=protectedIdentity(),state=emptyState();state.settings.autoRun=false;state.accounts=[account];validateBackup({state,secrets:{[key]:secret}});
  const cipher='enc:'+Buffer.from(secret).toString('base64');f.store.updateWithCiphers(current=>Object.assign(current,state),{[key]:cipher});
  const before=f.store.read(),beforeCiphers=f.store.allCiphers();
  await assert.rejects(f.run('account:delete',{id}),/Agents Wiki.*不能删除/);
  assert.deepEqual(f.store.read(),before);assert.deepEqual(f.store.allCiphers(),beforeCiphers);
  f.store.close();const reopened=new Store(f.path);try{assert.deepEqual(reopened.read(),before);assert.deepEqual(reopened.allCiphers(),beforeCiphers)}finally{reopened.close()}
 }finally{f.cleanup()}
});
test('ordinary unbound account deletion removes account and cipher together',async()=>{
 const f=fixture();
 try{
  const state=emptyState();state.settings.autoRun=false;state.accounts=[{id,channelId:'generic',email:'owner@example.net',username:'fixture',createdAt:at,updatedAt:at,status:'draft',hasPassword:true,source:'imported'}];
  f.store.updateWithCiphers(current=>Object.assign(current,state),{[key]:'fixture-cipher'});
  await f.run('account:delete',{id});assert.equal(f.store.read().accounts.length,0);assert.equal(f.store.getCipher(key),undefined);
  f.store.close();const reopened=new Store(f.path);try{assert.equal(reopened.read().accounts.length,0);assert.equal(reopened.getCipher(key),undefined)}finally{reopened.close()}
 }finally{f.cleanup()}
});
