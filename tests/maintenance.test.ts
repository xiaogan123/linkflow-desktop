import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {LocalBackups,checkForUpdate} from '../src/main/maintenance';
function cryptoPorts(){const key=randomBytes(32);return {encrypt:(text:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body])},decrypt:(buf:Buffer)=>{const c=createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));c.setAuthTag(buf.subarray(12,28));return Buffer.concat([c.update(buf.subarray(28)),c.final()]).toString()}}}
test('local backups are opt-in, encrypted, daily, bounded and restorable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-backups-'));try{
  let now=new Date('2026-09-01T01:02:03.004Z');const payload={state:{domain:'synthetic-private.example'},ciphers:{account:'opaque'}};
  const backups=new LocalBackups(directory,{...cryptoPorts(),snapshot:()=>payload,now:()=>now});
  assert.equal((await backups.run()).backups.length,0);await backups.configure(true,3);
  const first=await backups.run();assert.equal(first.lastBackupAt,now.toISOString());assert.equal(first.backups.length,1);
  assert.equal((await readFile(join(directory,first.backups[0].id))).includes(Buffer.from(payload.state.domain)),false);
  assert.deepEqual(await backups.read(first.backups[0].id),payload);assert.equal((await backups.run()).backups.length,1);
  for(let day=2;day<=5;day++){now=new Date(`2026-09-0${day}T01:02:03.004Z`);await backups.run()}
  const last=await backups.status();assert.equal(last.backups.length,3);assert.equal(last.lastBackupAt,now.toISOString());
  await assert.rejects(backups.read(first.backups[0].id));await assert.rejects(backups.read('../settings.json'));
  await writeFile(join(directory,last.backups[0].id),'malformed');await assert.rejects(backups.read(last.backups[0].id));
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('failed encryption never prunes a valid backup and concurrent backups serialize',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'linkflow-backups-'));try{
  const crypto=cryptoPorts();let broken=false;const backups=new LocalBackups(directory,{...crypto,encrypt:(s)=>{if(broken)throw Error();return crypto.encrypt(s)},snapshot:()=>({state:{}})});
  await backups.configure(true);await Promise.all([backups.run(),backups.run(),backups.run()]);assert.equal((await backups.status()).backups.length,1);
  broken=true;await assert.rejects(backups.run(true));assert.equal((await backups.status()).backups.length,1);assert((await backups.status()).error);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('update checks pin the official repository, compare semver and reject mismatched download sources',async()=>{
 const request=(data:unknown)=>(async(url:unknown)=>{assert.equal(url,'https://api.github.com/repos/xiaogan123/linkflow-desktop/releases/latest');return new Response(JSON.stringify(data))}) as typeof fetch;
 const release={tag_name:'v1.10.0',html_url:'https://github.com/xiaogan123/linkflow-desktop/releases/tag/v1.10.0',draft:false,prerelease:false};
 assert.equal((await checkForUpdate('1.9.9',request(release))).available,true);assert.equal((await checkForUpdate('2.0.0',request(release))).available,false);
 await assert.rejects(checkForUpdate('1.0.0',request({...release,html_url:'https://example.com/download'})));
 await assert.rejects(checkForUpdate('1.0.0',request({...release,prerelease:true})));
});
