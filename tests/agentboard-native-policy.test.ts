import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENTBOARD_NATIVE_STYLESHEET_URLS,agentboardNativeResourceType,exactAgentboardStylesheetUrl} from '../src/integrations/agentboard-native-policy';

const page='https://www.agentboard.ai/t/thr_bbbbbbbbbbbbbbbb';
const classify=(url:string,method='GET',resourceType='stylesheet',mainFrameAvailable=true)=>agentboardNativeResourceType({url,method,resourceType},page,mainFrameAvailable);

test('Agentboard native policy accepts only the two captured official versioned stylesheets',()=>{
  assert.deepEqual(AGENTBOARD_NATIVE_STYLESHEET_URLS,[
    'https://www.agentboard.ai/assets/style.css?v=20261012-organic-discussion-1',
    'https://www.agentboard.ai/assets/site-shell.css?v=20261012-zero-header-gap',
  ]);
  for(const value of AGENTBOARD_NATIVE_STYLESHEET_URLS){assert.equal(exactAgentboardStylesheetUrl(value),true);assert.equal(classify(value),'stylesheet')}
  for(const value of [
    'https://www.agentboard.ai/api/me',
    'https://www.agentboard.ai/api/threads',
    'https://www.agentboard.ai/log-out',
    'https://www.agentboard.ai/assets/style.css',
    'https://www.agentboard.ai/assets/style.css?v=changed',
    'https://www.agentboard.ai/assets/style.css?v=20261012-organic-discussion-1&extra=1',
    'https://www.agentboard.ai/assets/%73tyle.css?v=20261012-organic-discussion-1',
    'https://www.agentboard.ai/assets/site-shell.css?v=20261012-zero-header-gap#fragment',
    'https://cdn.example/assets/style.css?v=20261012-organic-discussion-1',
  ]){assert.equal(exactAgentboardStylesheetUrl(value),false);assert.equal(classify(value),undefined)}
  assert.equal(classify(page,'GET','mainFrame',true),'mainFrame');
  assert.equal(classify(page,'GET','mainFrame',false),undefined);
  assert.equal(classify(AGENTBOARD_NATIVE_STYLESHEET_URLS[0],'POST'),undefined);
  assert.equal(classify(AGENTBOARD_NATIVE_STYLESHEET_URLS[0],'GET','script'),undefined);
});
