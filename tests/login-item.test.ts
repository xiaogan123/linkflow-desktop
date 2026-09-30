import test from 'node:test';
import assert from 'node:assert/strict';
import {loginItemReadOptions,withLoginItemPreference,type LoginItemState} from '../src/main/login-item';
import {Store,emptyState} from '../src/main/store';

function fixture(platform='win32'){
 let state:LoginItemState={openAtLogin:false,status:'not-registered',executableWillLaunchAtLogin:false};
 const writes:boolean[]=[];
 const port={packaged:true,platform,read:()=>({...state}),write:(openAtLogin:boolean,enabled?:boolean)=>{writes.push(openAtLogin);state={openAtLogin,status:openAtLogin?'enabled':'not-registered',executableWillLaunchAtLogin:openAtLogin&&enabled!==false}}};
 return {port,writes,get:()=>state,set:(value:LoginItemState)=>{state=value}};
}

test('Windows login lookup preserves spaces under Electron 44 command-line parsing',()=>{
 const executable=String.raw`C:\Program Files\Linkflow\Linkflow.exe`;
 let registered=false,approved=true;
 // Model the two different lookup paths in Electron 44 browser_win.cc: the
 // Run value comparison formats a command, but launchItems parses options.path.
 const read=(options:{path?:string;args?:string[]})=>{
  const input=options.path??executable;
  const formatted=input.replace(/^"|"$/g,'');
  const parsed=input.startsWith('"')?input.slice(1,input.indexOf('"',1)):input.split(/\s/)[0];
  return {openAtLogin:registered&&formatted===executable,executableWillLaunchAtLogin:registered&&approved&&parsed===executable};
 };
 const write=(openAtLogin:boolean,enabled?:boolean)=>{registered=openAtLogin;approved=enabled!==false};
 const oldPort={packaged:true,platform:'win32',read:()=>read({}),write};
 assert.throws(()=>withLoginItemPreference(oldPort,true,()=>assert.fail('unconfirmed state committed')),/未保存/);
 assert.equal(registered,false);
 const options=loginItemReadOptions('win32',executable);
 const port={...oldPort,read:()=>read(options)};
 assert.equal(withLoginItemPreference(port,true,()=>17),17);
 assert.deepEqual(read(options),{openAtLogin:true,executableWillLaunchAtLogin:true});
 approved=false;
 assert.deepEqual(read(options),{openAtLogin:true,executableWillLaunchAtLogin:false});
 withLoginItemPreference(port,false,()=>{});
 assert.equal(registered,false);
});

test('login lookup quoting is confined to Windows and keeps an empty launch-argument list',()=>{
 assert.deepEqual(loginItemReadOptions('darwin','/Applications/Example App.app/Contents/MacOS/Example'),{});
 assert.deepEqual(loginItemReadOptions('win32',String.raw`C:\Apps\Linkflow.exe`),{path:'"C:\\Apps\\Linkflow.exe"',args:[]});
});
test('confirmed OS state precedes local commit',()=>{const f=fixture();let calls=0;assert.equal(withLoginItemPreference(f.port,true,()=>{calls++;assert.equal(f.get().executableWillLaunchAtLogin,true);return 12}),12);assert.equal(calls,1)});
test('silent refusal and thrown setter never commit a false enabled setting',()=>{for(const throws of [false,true]){const f=fixture();f.port.write=(value)=>{f.writes.push(value);if(value&&throws)throw Error('synthetic OS refusal')};let calls=0;assert.throws(()=>withLoginItemPreference(f.port,true,()=>calls++),/未保存/);assert.equal(calls,0);assert.equal(f.get().openAtLogin,false)}});
test('macOS pending approval is not reported as enabled',()=>{const f=fixture('darwin');f.port.write=value=>f.set({openAtLogin:value,status:value?'requires-approval':'not-registered'});let calls=0;assert.throws(()=>withLoginItemPreference(f.port,true,()=>calls++),/尚未批准/);assert.equal(calls,0);assert.equal(f.get().openAtLogin,false)});
test('Windows disabled startup entry is not enough to prove enabled',()=>{const f=fixture();f.port.write=value=>f.set({openAtLogin:value,executableWillLaunchAtLogin:false});assert.throws(()=>withLoginItemPreference(f.port,true,()=>assert.fail('must not commit')),/未确认/)});
test('failed database commit restores original OS preference',()=>{const f=fixture();assert.throws(()=>withLoginItemPreference(f.port,true,()=>{throw Error('synthetic DB failure')}),/恢复原状态/);assert.equal(f.get().openAtLogin,false);assert.deepEqual(f.writes,[true,false])});
test('Windows rollback preserves an originally disabled run key',()=>{const f=fixture();f.set({openAtLogin:true,executableWillLaunchAtLogin:false});assert.throws(()=>withLoginItemPreference(f.port,true,()=>{throw Error('synthetic DB failure')}),/恢复原状态/);assert.equal(f.get().openAtLogin,true);assert.equal(f.get().executableWillLaunchAtLogin,false)});
test('uncertain compensation is explicitly reported',()=>{const f=fixture();f.port.write=value=>{if(!value)throw Error('synthetic compensation failure');f.set({openAtLogin:true,executableWillLaunchAtLogin:true})};assert.throws(()=>withLoginItemPreference(f.port,true,()=>{throw Error('synthetic DB failure')}),/未能恢复确认/)});
test('unchanged settings and unpackaged disabled defaults do not mutate OS preferences',()=>{const f=fixture();withLoginItemPreference(f.port,undefined,()=>{});withLoginItemPreference(f.port,false,()=>{});withLoginItemPreference({...f.port,packaged:false},false,()=>{});assert.deepEqual(f.writes,[]);assert.throws(()=>withLoginItemPreference({...f.port,packaged:false},true,()=>{}),/打包客户端/)});
test('a failed renderer notification cannot misreport committed state or trigger OS compensation',()=>{
 const store=new Store(':memory:'),f=fixture();store.onChange=()=>{throw Error('synthetic closed renderer')};
 try{
  assert.doesNotThrow(()=>withLoginItemPreference(f.port,true,()=>store.updateWithCiphers(s=>{s.settings.launchAtLogin=true},{fixture:'cipher-fixture'})));
  assert.equal(store.read().settings.launchAtLogin,true);assert.equal(store.getCipher('fixture'),'cipher-fixture');assert.deepEqual(f.writes,[true]);
  assert.doesNotThrow(()=>store.update(s=>{s.settings.notify=false}));assert.equal(store.read().settings.notify,false);
  const replacement=emptyState();replacement.settings.dailyAiLimit=7;assert.doesNotThrow(()=>store.restore(replacement,{replacement:'cipher-replacement'}));assert.equal(store.read().settings.dailyAiLimit,7);assert.equal(store.getCipher('fixture'),undefined);assert.equal(store.getCipher('replacement'),'cipher-replacement');
 }finally{store.close()}
});
