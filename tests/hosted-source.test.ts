import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyLink,belongsToSource} from '../src/integrations/web';

const page={status:200,headers:{'content-type':'text/html'},body:Buffer.from('<a href="https://target.example/">Website</a>')};
const resolve=async()=>[{address:'8.8.8.8',family:4}];
test('vetted hosted newsletters accept publication subdomains with verified direct links',async()=>{
 for(const domain of ['beehiiv.com','kit.com','wordpress.com','ghost.io','tumblr.com','blogspot.com']){
  let calls=0;
  const result=await verifyLink(`https://publisher.${domain}/article`,'https://target.example/',domain,undefined,{resolve,request:async()=>{calls++;return page}});
  assert.equal(result.outcome,'found',domain);assert.equal(calls,1);
 }
});
test('lookalikes and unrelated channel subdomains remain rejected before fetching',async()=>{
 for(const [source,expected] of [['https://publisher.beehiiv.com.evil.example/','beehiiv.com'],['https://evilkit.com/','kit.com'],['https://publisher.example.com/','example.com']]){
  let calls=0;const result=await verifyLink(source,'https://target.example/',expected,undefined,{resolve,request:async()=>{calls++;return page}});
  assert.equal(result.outcome,'invalid',source);assert.equal(calls,0);
 }
});
test('hosted source redirect cannot leave the vetted publication service',async()=>{
 let calls=0;
 const result=await verifyLink('https://publisher.beehiiv.com/a','https://target.example/','beehiiv.com',undefined,{resolve,request:async()=>++calls===1?{status:302,headers:{location:'https://unrelated.example/a'},body:Buffer.alloc(0)}:page});
 assert.equal(result.outcome,'invalid');assert.equal(result.found,false);assert.equal(calls,2);
});

test('Hashnode hosting alias shares the result-intake and verification predicate',()=>{assert.equal(belongsToSource('https://publisher.hashnode.dev/article','hashnode.com'),true);assert.equal(belongsToSource('https://publisher.hashnode.dev.evil.example/article','hashnode.com'),false)});
