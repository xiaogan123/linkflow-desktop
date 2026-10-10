import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createShareYourHtmlPage, type ShareYourHtmlInput, type ShareYourHtmlIntent,
  type ShareYourHtmlPersistence, type ShareYourHtmlReceipt } from '../src/integrations/shareyourhtml';

const KEY = 'f1e2d3c4-b5a6-7890-1234-567890abcdef';
const SLUG = 'reviewed-publication';
const HTML = '<!doctype html><html lang="en"><body><h1>Original source</h1><p>A <a href="https://example.com/research">reference</a>.</p></body></html>\n';
const NOW = '2026-10-09T12:00:00.000Z';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const input = (v: Partial<ShareYourHtmlInput> = {}): ShareYourHtmlInput => ({ operationId:'publication_operation_66', slug:SLUG, html:HTML, reviewed:true, ...v });
const success = (v: Record<string, unknown> = {}) => ({ slug:SLUG, url:`https://${SLUG}.shareyourhtml.com`, edit_key:KEY, ...v });
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers:{'content-type':'application/json; charset=utf-8'} });
function storage() {
  const intents: ShareYourHtmlIntent[] = [];
  const saved: Array<{receipt:ShareYourHtmlReceipt;editKey:string}> = [];
  const calls: string[] = [];
  const persistence: ShareYourHtmlPersistence = {
    async persistIntent(i) { calls.push('intent'); intents.push(i); },
    assertReadyToSubmit() { calls.push('guard'); return true; },
    async persistCreatedAtomically(v) { calls.push('created'); saved.push(v); },
  };
  return { persistence, intents, saved, calls };
}

test('one reviewed create uses explicit never expiry and saves identity atomically before returning', async () => {
  const s=storage();const requests:Array<{url:string;init:RequestInit}>=[];
  const result=await createShareYourHtmlPage(input(),s.persistence,{now:()=>new Date(NOW),fetch:async(url,init)=>{s.calls.push('request');requests.push({url,init});return json(success());}});
  assert.equal(requests.length,1);const r=requests[0];assert.equal(r.url,'https://shareyourhtml.com/pages');assert.equal(r.init.method,'POST');
  assert.equal(r.init.redirect,'manual');assert.equal(r.init.credentials,'omit');assert.equal(r.init.referrerPolicy,'no-referrer');assert.equal(r.init.cache,'no-store');
  assert.deepEqual(r.init.headers,{'content-type':'application/json',accept:'application/json'});
  assert.deepEqual(JSON.parse(String(r.init.body)),{slug:SLUG,html:HTML,expiry:'never'});
  assert.deepEqual(s.calls,['intent','guard','request','created']);assert.equal(s.intents[0].sourceHash,hash(HTML));assert.equal(s.intents[0].requestHash,hash(String(r.init.body)));assert.equal(s.intents[0].createdAt,NOW);
  assert.equal(result.status,'created');assert.equal(s.saved[0].editKey,KEY);assert.equal(s.saved[0].receipt.publicVerification,'pending');assert.equal(s.saved[0].receipt.requestedExpiry,'never');
  assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal('expiresAt' in s.saved[0].receipt,false);
});

test('a durable prior intent blocks changed operation/content and never leaks unknown properties',async()=>{
  const s=storage();let requests=0;
  const prior={operationId:'earlier_operation',slug:'earlier-slug',sourceHash:'a'.repeat(64),requestHash:'b'.repeat(64),createdAt:NOW,editKey:KEY};
  const result=await createShareYourHtmlPage(input({priorIntent:prior}),s.persistence,{fetch:async()=>{requests++;return json(success());}});
  assert.equal(result.status,'blocked');assert.equal(requests,0);assert.deepEqual(s.calls,[]);assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('invalid input cannot persist or send',async t=>{
  for(const [label,overrides] of Object.entries({unreviewed:{reviewed:false},slugTraversal:{slug:'../path'},slugUpper:{slug:'UPPER'},slugShort:{slug:'ab'},slugLong:{slug:'a'.repeat(41)},operation:{operationId:'short'},empty:{html:'  '},nullByte:{html:'<p>\0</p>'},surrogate:{html:'<p>\ud800</p>'},byteBudget:{html:'字'.repeat(40_001)},requestBudget:{html:'\\'.repeat(119_999)},badPrior:{priorIntent:null}})){
    await t.test(label,async()=>{const s=storage();let n=0;await assert.rejects(createShareYourHtmlPage(input(overrides as Partial<ShareYourHtmlInput>),s.persistence,{fetch:async()=>{n++;return json(success());}}),TypeError);assert.equal(n,0);assert.deepEqual(s.calls,[]);});
  }
});

test('intent failure prevents transport and does not echo errors',async()=>{
  const s=storage();let requests=0;s.persistence.persistIntent=async()=>{throw Error(KEY+HTML);};
  const result=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>{requests++;return json(success());}});
  assert.deepEqual(result,{status:'not_started',reason:'intent_not_persisted'});assert.equal(requests,0);assert.equal(s.saved.length,0);
});

test('required final synchronous guard rejection preserves the durable claim and sends nothing',async()=>{
  for(const mode of ['throw','thenable'] as const){
    const s=storage();let requests=0;
    if(mode==='throw')s.persistence.assertReadyToSubmit=()=>{throw Error(KEY+HTML);};
    else s.persistence.assertReadyToSubmit=(()=>Promise.reject(Error(KEY+HTML))) as unknown as ShareYourHtmlPersistence['assertReadyToSubmit'];
    const result=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>{requests++;return json(success());}});
    assert.deepEqual(result,{status:'not_submitted',reason:'final_guard_rejected',intent:s.intents[0]});
    assert.equal(requests,0);assert.equal(s.intents.length,1);assert.equal(s.saved.length,0);
    assert.equal(JSON.stringify(result).includes(KEY),false);
    await new Promise(resolve=>setTimeout(resolve,0));
  }
});

test('cancellation before and immediately after durable intent never sends',async t=>{
  for(const after of [false,true])await t.test(String(after),async()=>{
    const s=storage(),controller=new AbortController();let n=0;
    if(after){const persist=s.persistence.persistIntent;s.persistence.persistIntent=async i=>{await persist(i);controller.abort();};}else controller.abort();
    const result=await createShareYourHtmlPage(input(),s.persistence,{signal:controller.signal,fetch:async()=>{n++;return json(success());}});
    assert.equal(result.status,after?'not_submitted':'not_started');assert.equal(n,0);assert.equal(s.intents.length,after?1:0);assert.equal(s.saved.length,0);
  });
});

test('durable CAS serializes concurrent calls; unknown result never enables a second POST',async()=>{
  const s=storage();const claims=new Set<string>();let sent=0;
  s.persistence.persistIntent=async i=>{if(claims.has(i.slug)||claims.has(i.operationId))throw Error('claimed');claims.add(i.slug);claims.add(i.operationId);s.intents.push(i);};
  const deps={fetch:async()=>{sent++;throw Error(KEY);}};
  const results=await Promise.all([createShareYourHtmlPage(input(),s.persistence,deps),createShareYourHtmlPage(input({operationId:'second_operation_66'}),s.persistence,deps)]);
  assert.equal(sent,1);assert.deepEqual(results.map(x=>x.status).sort(),['not_started','unknown']);
  const retry=await createShareYourHtmlPage(input({priorIntent:s.intents[0]}),s.persistence,deps);assert.equal(retry.status,'blocked');assert.equal(sent,1);assert.equal(JSON.stringify(results).includes(KEY),false);
});

test('every non-201 HTTP status is unknown without replay or error reflection',async t=>{
  for(const status of [200,202,400,403,404,409,422,429,500,503])await t.test(String(status),async()=>{
    const s=storage();let n=0;const result=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>{n++;return json({error:KEY+HTML},status);}});
    assert.equal(result.status,'unknown');assert.equal(n,1);assert.equal(s.saved.length,0);assert.equal(JSON.stringify(result).includes(KEY),false);
  });
});

test('untrusted response URL and redirect statuses are never followed',async t=>{
  for(const variant of ['redirect','foreign','wrong-path'])await t.test(variant,async()=>{
    const s=storage();let n=0;
    const response=variant==='redirect'?new Response(null,{status:302,headers:{location:'https://example.com'}}):json(success());
    if(variant!=='redirect')Object.defineProperty(response,'url',{value:variant==='foreign'?'https://example.com/pages':'https://shareyourhtml.com/other'});
    const result=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>{n++;return response;}});
    assert.equal(result.status,'unknown');assert.equal(n,1);assert.equal(s.saved.length,0);
  });
});

test('only the exact slug, URL and UUID key receipt is accepted',async t=>{
  const variants=[{slug:'other-slug'},{url:`https://${SLUG}.shareyourhtml.com/`},{url:`https://${SLUG}.shareyourhtml.com:443`},{url:`https://${SLUG}.shareyourhtml.com?edit_key=${KEY}`},{url:`https://${SLUG}.shareyourhtml.com.evil.example`},{url:`https://user@${SLUG}.shareyourhtml.com`},{edit_key:KEY+'\n'},{edit_key:'not-a-key'},{edit_key:null}];
  for(const [i,v]of variants.entries())await t.test(String(i),async()=>{const s=storage();const r=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>json(success(v))});assert.equal(r.status,'unknown');assert.equal(s.saved.length,0);assert.equal(JSON.stringify(r).includes(KEY),false);});
});

test('JSON/media/size/UTF-8 errors stay unknown and disclose no returned body',async t=>{
  const variants=[()=>new Response(KEY,{status:201,headers:{'content-type':'text/html'}}),()=>new Response(KEY,{status:201,headers:{'content-type':'application/json'}}),()=>json([success()]),()=>json(null),()=>new Response('x'.repeat(65_537),{status:201,headers:{'content-type':'application/json'}}),()=>new Response('{}',{status:201,headers:{'content-type':'application/json','content-length':'9999999'}}),()=>new Response('{}',{status:201,headers:{'content-type':'application/json','content-length':'-1'}}),()=>new Response(Uint8Array.of(0xff,0xfe),{status:201,headers:{'content-type':'application/json'}}),()=>new Response('\ufeff'+JSON.stringify(success()),{status:201,headers:{'content-type':'application/json'}})];
  for(const [i,make]of variants.entries())await t.test(String(i),async()=>{const s=storage();const r=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>make()});assert.equal(r.status,'unknown');assert.equal(s.saved.length,0);assert.equal(JSON.stringify(r).includes(KEY),false);});
});

test('storage failure after creation returns only safe receipt and keeps the durable intent',async()=>{
  const s=storage();s.persistence.persistCreatedAtomically=async()=>{throw Error(KEY+HTML);};let n=0;
  const r=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>{n++;return json(success());}});
  assert.equal(r.status,'created_persistence_unknown');assert.equal(n,1);assert.equal(s.intents.length,1);assert.equal(JSON.stringify(r).includes(KEY),false);
  const again=await createShareYourHtmlPage(input({priorIntent:s.intents[0]}),s.persistence,{fetch:async()=>{n++;return json(success());}});assert.equal(again.status,'blocked');assert.equal(n,1);
});

test('persistence callback mutation cannot alter the canonical result',async()=>{
  const s=storage();s.persistence.persistIntent=async i=>{i.slug='mutated';};s.persistence.persistCreatedAtomically=async v=>{v.receipt.publicUrl='https://example.com';};
  const r=await createShareYourHtmlPage(input(),s.persistence,{fetch:async()=>json(success())});assert.equal(r.status,'created');if(r.status!=='created')throw Error('unexpected');assert.equal(r.receipt.publicUrl,`https://${SLUG}.shareyourhtml.com`);assert.equal(r.receipt.slug,SLUG);
});

test('timeout returns unknown even if transport ignores abort; late body is cancelled',async()=>{
  const s=storage();let resolve!: (value:Response)=>void;let cancelled=false;
  const r=await createShareYourHtmlPage(input(),s.persistence,{timeoutMs:50,fetch:()=>new Promise<Response>(r=>{resolve=r;})});
  assert.equal(r.status,'unknown');const body=new ReadableStream({cancel(){cancelled=true;}});resolve(new Response(body,{status:201,headers:{'content-type':'application/json'}}));await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,true);assert.equal(s.saved.length,0);
});

test('stalled response body is cancelled on bounded timeout',async()=>{
  const s=storage();let cancelled=false;const body=new ReadableStream({cancel(){cancelled=true;}});
  const r=await createShareYourHtmlPage(input(),s.persistence,{timeoutMs:50,fetch:async()=>new Response(body,{status:201,headers:{'content-type':'application/json'}})});
  assert.equal(r.status,'unknown');assert.equal(cancelled,true);assert.equal(s.saved.length,0);
});
