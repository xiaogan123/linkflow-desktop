import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mailboxIdentityChanged} from '../src/main/mail-settings';
const original={host:'imap.gmail.com',port:993,user:'person@gmail.com',secure:true,hasPassword:true};
test('changing the mailbox server, port or account invalidates the old credential',()=>{
  for(const patch of [{host:'imap.qq.com'},{user:'other@gmail.com'},{port:995},{secure:false}])assert.equal(mailboxIdentityChanged(original,{...original,...patch}),true);
});
test('cosmetic host normalization and password-status hints cannot change credential identity',()=>{
  assert.equal(mailboxIdentityChanged(original,{...original,host:'IMAP.GMAIL.COM.',hasPassword:false}),false);
});
