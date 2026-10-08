import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {authorizeWordPress} from '../src/main/wordpress-oauth';

async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function callback(port:number,url:string){
  const auth=new URL(url),redirect=auth.searchParams.get('redirect_uri')!;
  assert.equal(auth.origin,'https://public-api.wordpress.com');assert.equal(auth.searchParams.get('response_type'),'token');assert.equal(auth.searchParams.has('client_secret'),false);assert.equal(auth.searchParams.has('scope'),false);
  const response=await fetch(redirect),html=await response.text();
  assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  assert.match(html,/history.replaceState/);
  const nonce=/script nonce="([a-f0-9]+)"/.exec(html)![1];
  const values=new URLSearchParams({state:auth.searchParams.get('state')!,access_token:'synthetic-token',token_type:'bearer',expires_in:'3600',blog_id:'123'});
  const post=(fragment=values.toString(),origin=`http://127.0.0.1:${port}`,inputNonce=nonce)=>fetch(redirect+'/token',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({fragment,nonce:inputNonce})});
  return {values,post,redirect};
}
test('WordPress loopback OAuth returns a short-lived site grant and closes the listener',async()=>{
  const port=await freePort();let callbackUrl='';
  const grant=await authorizeWordPress({client:{clientId:'123',redirectUri:`http://127.0.0.1:${port}/wordpress/callback`},openExternal:async url=>{const c=await callback(port,url);callbackUrl=c.redirect;assert.equal((await c.post()).status,200);}});
  assert.equal(grant.accessToken,'synthetic-token');assert.equal(grant.blogId,'123');assert.ok(Date.parse(grant.expiresAt)>Date.now()+3500_000);
  await assert.rejects(fetch(callbackUrl));
});
test('WordPress OAuth rejects untrusted origin, state, nonce, duplicate fields, global scope and invalid expiry before accepting the legitimate callback',async()=>{
  const port=await freePort();let assertions=0;
  await authorizeWordPress({client:{clientId:'123',redirectUri:`http://127.0.0.1:${port}/wordpress/callback`},openExternal:async url=>{
    const c=await callback(port,url);
    for(const response of [await c.post(undefined,'https://example.com'),await c.post(undefined,undefined,'bad'),await c.post(c.values.toString().replace(/state=[^&]+/,'state=bad'))]){assert.equal(response.status,403);assertions++;}
    for(const extra of ['&state=duplicate','&scope=global','&expires_in=1']){assert.ok((await c.post(c.values.toString()+extra)).status>=400);assertions++;}
    for(const seconds of ['0','-2','Infinity','999999999']){const v=new URLSearchParams(c.values);v.set('expires_in',seconds);assert.equal((await c.post(v.toString())).status,400);assertions++;}
    assert.equal((await fetch(c.redirect+'/token',{method:'POST',headers:{Origin:new URL(c.redirect).origin,'Content-Type':'application/json'},body:'x'.repeat(9000)})).status,413);
    assert.equal((await c.post()).status,200);
  }});assert.equal(assertions,10);
});
test('WordPress denied consent terminates without reflecting provider error or credentials',async()=>{
  const port=await freePort();await assert.rejects(authorizeWordPress({client:{clientId:'123',redirectUri:`http://127.0.0.1:${port}/wordpress/callback`},openExternal:async url=>{
    const c=await callback(port,url),v=new URLSearchParams({state:c.values.get('state')!,error:'synthetic-sensitive-description'});const response=await c.post(v.toString());assert.doesNotMatch(await response.text(),/synthetic-sensitive/);
  }}),/已拒绝/);
});
test('WordPress OAuth cancellation and timeout release their bound port',async()=>{
  for(const mode of ['cancel','timeout']){const port=await freePort(),abort=new AbortController(),redirectUri=`http://127.0.0.1:${port}/wordpress/callback`;
    await assert.rejects(authorizeWordPress({client:{clientId:'123',redirectUri},signal:abort.signal,timeoutMs:40,openExternal:async()=>{if(mode==='cancel')abort.abort();}}),mode==='cancel'?/取消/:/超时/);
    await assert.rejects(fetch(redirectUri));
  }
});
test('Unregistered or nonloopback WordPress client never opens a browser',async()=>{
  let calls=0;const openExternal=async()=>{calls++};await assert.rejects(authorizeWordPress({openExternal}),/尚未完成/);
  for(const redirectUri of ['http://localhost:47891/wordpress/callback','https://example.com/wordpress/callback','http://127.0.0.1:47891/wordpress/callback?x=1'])await assert.rejects(authorizeWordPress({client:{clientId:'123',redirectUri},openExternal}));
  assert.equal(calls,0);
});
