import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Account,Snapshot} from '../src/shared/types';
import {eligibleWordPressBlogs,WordPressConnection,wordPressConnectionPayload} from '../src/ui/pages/WordPressConnection';

const at='2026-10-08T00:00:00.000Z';
const account:Account={id:'wordpress-account',channelId:'wordpress-com',email:'',username:'1001',displayName:'Research Notes',publicationUrl:'https://research-notes.wordpress.com/',credentialKind:'oauth',status:'registered',hasPassword:true,source:'imported',createdAt:at};
const blogs=[
  {id:'1001',name:'Research Notes',url:'https://research-notes.wordpress.com/'},
  {id:'2002',name:'Another Blog',url:'https://another-blog.wordpress.com/'},
];

test('repair choices keep the original blog identity while a new connection may choose any authorized public blog',()=>{
  assert.deepEqual(eligibleWordPressBlogs(blogs),blogs);
  assert.deepEqual(eligibleWordPressBlogs(blogs,account),[blogs[0]]);
  assert.deepEqual(eligibleWordPressBlogs(blogs,{username:'missing'}),[]);
});

test('connect payload contains only the expiring session selection and deduplicated site IDs',()=>{
  assert.deepEqual(wordPressConnectionPayload({sessionId:'session-1'},'1001',['site-1','site-1','site-2'],account.id),{
    sessionId:'session-1',blogId:'1001',siteIds:['site-1','site-2'],accountId:'wordpress-account',
  });
  const fresh=wordPressConnectionPayload({sessionId:'session-2'},'2002',['site-2']);
  assert.deepEqual(fresh,{sessionId:'session-2',blogId:'2002',siteIds:['site-2']});
  assert.deepEqual(Object.keys(fresh).sort(),['blogId','sessionId','siteIds']);
});

test('initial drawer reads status without rendering a credential input or an enabled authorization action',()=>{
  const data={sites:[],accounts:[],accountBindings:[]} as unknown as Snapshot;
  const commands:string[]=[];
  const markup=renderToStaticMarkup(createElement(WordPressConnection,{data,disabled:false,onClose:()=>{},onAction:async(command:string)=>{commands.push(command);return undefined}}));
  assert.match(markup,/正在检查浏览器授权是否可用/);
  assert.match(markup,/class="button primary wordpress-primary"[^>]*disabled/);
  assert.doesNotMatch(markup,/type="password"|access[_ -]?token|client[_ -]?secret/i);
  assert.deepEqual(commands,[],'server rendering must not start browser authorization');
});
