import test from 'node:test';
import assert from 'node:assert/strict';
import {runBrowserTask,isRegistrationAction} from '../src/integrations/browser';
import type {ExecutionContext, Account} from '../src/shared/types';

for(const channelId of ['github','gitlab','behance','artstation'])for(const status of ['missing','draft'] as const){
  test(`${channelId} ${status} account requires human setup before browser, credentials or AI`,async()=>{
    let saves=0,calls=0,reads=0;
    const account=status==='draft'?{id:'fixture-account',channelId,status:'draft',source:'generated'} as Account:undefined;
    const context={channel:{id:channelId,automation:'browser'},task:{id:'fixture-task'},getAccount:()=>account,saveAccount:async()=>{saves++},ai:{json:async()=>{calls++;throw Error('AI must not run')}},secrets:{get:async()=>{reads++;throw Error('secrets must not be read')}}} as unknown as ExecutionContext;
    const result=await runBrowserTask(context);
    assert.equal(result.status,'needs_input');assert.match(result.message,/本人创建/);
    assert.equal(saves,0);assert.equal(calls,0);assert.equal(reads,0);
  });
}
test('registration is recognized independently of anchor shape and AI purpose',()=>{
 const control={label:'Continue',name:'',href:'https://example.com/dashboard'};
 assert.equal(isRegistrationAction(control,'register'),true);
 for(const override of [{label:'Create account'},{href:'https://example.com/%72egister'},{handlerHint:"fetch('/signup',{method:'POST'})"},{formAction:'https://example.com/create-user'}])assert.equal(isRegistrationAction({...control,...override},'navigation'),true);
 assert.equal(isRegistrationAction({...control,label:'Log in'},'login'),false);
});
