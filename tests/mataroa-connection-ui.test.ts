import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Snapshot} from '../src/shared/types';
import {ArticleConnection,articleConnectionPayload,initialArticleConnectionChoice,switchArticleConnectionChannel} from '../src/ui/pages/ArticleConnection';

const action=<T,>(_command:string,_payload?:unknown)=>Promise.resolve(undefined as T|undefined);
const data={sites:[],accounts:[],accountBindings:[]} as unknown as Snapshot;

test('Mataroa Newsletter permission starts unchecked and a fresh drawer does not inherit it',()=>{
  for(let open=0;open<2;open++){
    const markup=renderToStaticMarkup(createElement(ArticleConnection,{data,disabled:false,initialChannel:'mataroa',onClose:()=>{},onAction:action}));
    assert.match(markup,/我同意本次连接关闭该博客的 Newsletter/);
    assert.match(markup,/后续不会向订阅者发送邮件/);
    assert.match(markup,/aria-label="允许关闭 Mataroa Newsletter"/);
    assert.doesNotMatch(markup,/aria-label="允许关闭 Mataroa Newsletter"[^>]*checked/);
  }
  assert.equal(initialArticleConnectionChoice('mataroa').accepted,false);
});

test('changing channels clears consent and only Mataroa can send its one-time permission',()=>{
  const allowed={...initialArticleConnectionChoice('mataroa'),accepted:true};
  const hive=switchArticleConnectionChannel(allowed,'hive');
  const mataroa=switchArticleConnectionChannel(hive,'mataroa');
  assert.equal(hive.accepted,false);assert.equal(mataroa.accepted,false);
  assert.deepEqual(articleConnectionPayload(allowed,'author','secret',[]),{username:'author',credential:'secret',siteIds:[],accountId:undefined,allowDisableNewsletter:true});
  assert.deepEqual(articleConnectionPayload({...initialArticleConnectionChoice('hive'),accepted:true},'author','secret',[]),{username:'author',credential:'secret',siteIds:[],accountId:undefined,acknowledgePermanent:true});
  assert.deepEqual(articleConnectionPayload(initialArticleConnectionChoice('paper-wf'),'author','secret',[]),{username:'author',credential:'secret',siteIds:[],accountId:undefined});
});
