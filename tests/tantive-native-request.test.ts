import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TANTIVE_NATIVE_TIMEOUT_MS,tantiveNativeResourceType} from '../src/main/tantive-renderer';

test('native allowlist keeps the exact main document and plain same-origin styles only',()=>{
  const url='https://tantive.space/t/73';
  assert.equal(tantiveNativeResourceType({url,method:'GET',resourceType:'mainFrame'},url,false),'mainFrame');
  assert.equal(tantiveNativeResourceType({url,method:'POST',resourceType:'mainFrame'},url,false),undefined);
  assert.equal(tantiveNativeResourceType({url:'https://tantive.space/static/site.css',method:'GET',resourceType:'stylesheet'},url,true),'stylesheet');
  for(const details of [
    {url,method:'POST',resourceType:'mainFrame'},
    {url,method:'GET',resourceType:'mainFrame'},
    {url:'https://tantive.space/static/site.css?q=1',method:'GET',resourceType:'stylesheet'},
    {url:'https://tantive.space/static/site.css#x',method:'GET',resourceType:'stylesheet'},
    {url:'https://example.invalid/site.css',method:'GET',resourceType:'stylesheet'},
    {url:'https://tantive.space/favicon.ico',method:'GET',resourceType:'image'},
  ])assert.equal(tantiveNativeResourceType(details,url,true),undefined);
  assert.equal(TANTIVE_NATIVE_TIMEOUT_MS,25_000);
});

test('native allowlist accepts only the fixed site stylesheet version parameter',()=>{
  const url='https://tantive.space/t/73';
  const classify=(resource:string,method='GET',resourceType='stylesheet')=>tantiveNativeResourceType({url:resource,method,resourceType},url,true);
  const stylesheet='https://tantive.space/assets/site.css?v=abcdef012345';
  assert.equal(classify(stylesheet),'stylesheet');
  for(const resource of [
    'https://tantive.space/assets/other.css?v=abcdef012345',
    'https://tantive.space/t/73?v=abcdef012345',
    'https://tantive.space/assets/site.css?v=',
    'https://tantive.space/assets/site.css?v=abcdef01234',
    'https://tantive.space/assets/site.css?v=abcdef0123456',
    'https://tantive.space/assets/site.css?v=ABCDEF012345',
    'https://tantive.space/assets/site.css?v=abcdef012345&v=abcdef012345',
    'https://tantive.space/assets/site.css?v=abcdef012345&x=1',
    'https://tantive.space/assets/site.css?%76=abcdef012345',
    'https://tantive.space/assets/site.css?v=%61bcdef012345',
    stylesheet+'#fragment',
    'https://other.invalid/assets/site.css?v=abcdef012345',
    'https://user:password@tantive.space/assets/site.css?v=abcdef012345',
    'https://user:password@tantive.space/assets/site.css',
  ])assert.equal(classify(resource),undefined);
  assert.equal(classify(stylesheet,'POST'),undefined);
  assert.equal(classify(stylesheet,'GET','script'),undefined);
  assert.equal(classify(stylesheet,'GET','mainFrame'),undefined);
});
