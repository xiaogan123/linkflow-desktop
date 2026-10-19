import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LinkRelDetail} from '../src/ui/App';

test('accepted links with no rel remain visible as follow in task detail', () => {
  assert.equal(renderToStaticMarkup(createElement(LinkRelDetail, {rel: ''})), '<dt>链接属性</dt><dd>follow</dd>');
  assert.equal(renderToStaticMarkup(createElement(LinkRelDetail, {rel: 'ugc nofollow'})), '<dt>链接属性</dt><dd>ugc nofollow</dd>');
  assert.equal(renderToStaticMarkup(createElement(LinkRelDetail, {rel: undefined})), '');
});
