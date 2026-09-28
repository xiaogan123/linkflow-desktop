import {spawnSync,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,basename} from 'node:path';
// This gate is deliberately local: the private policy must not be published to CI.
async function main(){
const policy=process.env.LINKFLOW_PRIVACY_POLICY;
if(!policy)throw Error('Set LINKFLOW_PRIVACY_POLICY to a private, nonempty policy file before releasing');
let parsed;try{parsed=JSON.parse(await readFile(policy,'utf8'))}catch{throw Error('Invalid private policy')}
if(!Array.isArray(parsed.terms)||!parsed.terms.length||parsed.terms.some(t=>typeof t!=='string'||t.length<5))throw Error('Invalid private policy');
const files=process.argv.slice(2);
if(!files.length)throw Error('Pass the exact distribution archives/installers selected for release');
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
await mkdir('.evidence/release-gate',{recursive:true,mode:0o700});
const checks=[];
for(const mode of ['source','dist']){
 const run=spawnSync(process.execPath,['scripts/privacy-scan.mjs',mode],{encoding:'utf8',env:{...process.env,LINKFLOW_REQUIRE_PRIVATE_POLICY:'1',LINKFLOW_PRIVACY_REPORT:resolve('.evidence/release-gate/'+mode+'.json')}});
 if(run.status!==0){console.error('Private release gate failed: '+mode);process.exit(run.status||1)}
 checks.push(JSON.parse(run.stdout));
}
const artifacts=[];
for(const file of files)artifacts.push({name:basename(file),sha256:await hash(file)});
const attestation={sourceAndUnpackedPassed:true,archiveContentsVerified:false,releaseReady:false,checkedAt:new Date().toISOString(),head:execFileSync('git',['rev-parse','HEAD'],{stdio:['ignore','pipe','pipe'],encoding:'utf8'}).trim(),worktreeDiffHash:createHash('sha256').update(execFileSync('git',['diff','HEAD','--binary'],{stdio:['ignore','pipe','pipe']})).digest('hex'),scannerHash:await hash('scripts/privacy-scan.mjs'),artifacts,checks,scope:'Source/index/history plus built distributions/resources/ASAR. Final archives also require independent extraction and semantic review before publication.'};
await writeFile('.evidence/release-gate/attestation.json',JSON.stringify(attestation,null,2),{mode:0o600});
console.log(JSON.stringify({sourceAndUnpackedPassed:true,archiveContentsVerified:false,releaseReady:false,artifactCount:artifacts.length,privateEvidence:'.evidence/release-gate/attestation.json'}));

}
main().catch(()=>{console.error('Private release gate incomplete. Check the private policy and selected inputs locally; no input contents are logged.');process.exitCode=1});
