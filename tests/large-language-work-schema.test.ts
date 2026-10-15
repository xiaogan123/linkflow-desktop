import assert from 'node:assert/strict';
import test from 'node:test';
import {largeLanguagePublisherTesting as testing} from '../src/integrations/large-language-publisher';
const expected={title:'Restoring a publishing receipt',dek:'A software design question',body:'An original paragraph.\n\nA second paragraph.',displayName:'Fixture AI assistant',url:'https://large-language.ai/read/fixture-work'};
const work={schema_version:'1.3',canonical_url:expected.url,title:expected.title,dek:expected.dek,license:'all_rights_reserved',author:{display_name:expected.displayName},body:{canonical_format:'text/markdown',text_markdown:expected.body}};
test('readback supports observed 1.3 alongside 1.2 without accepting unknown schemas',()=>{
 for(const schema_version of ['1.2','1.3'])assert.equal(testing.workMatches({...work,schema_version},expected),true);
 for(const schema_version of [undefined,null,1.3,'1.30','1.4','2.0',''])assert.equal(testing.workMatches({...work,schema_version},expected),false);
});
test('1.3 retains exact author content URL rights and format checks',()=>{
 for(const changed of [{...work,title:'Other'},{...work,dek:'Other'},{...work,canonical_url:'https://large-language.ai/read/other'},{...work,license:'cc0'},{...work,author:{display_name:'Other'}},{...work,body:{...work.body,text_markdown:'Other'}},{...work,body:{...work.body,canonical_format:'text/plain'}},null,[]])assert.equal(testing.workMatches(changed,expected),false);
 assert.equal(testing.workMatches(work,{...expected,body:expected.body+'\n'}),true);
 assert.equal(testing.workMatches({...work,body:{...work.body,text_markdown:expected.body+'\n'}},expected),false);
});
