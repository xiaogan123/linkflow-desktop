import assert from 'node:assert/strict';
import test from 'node:test';
import {containsReferralInformation,prepareReferralFreeDraft,siteReferralCodes} from '../src/shared/referral-policy';
import {isArticleTopicUrl} from '../src/shared/topic-policy';

const site={url:'https://example.com/',domain:'example.com',description:'Educational tutorials'};

test('referral guard recognizes labelled codes and encoded recommendation URLs',()=>{
  for(const text of [
    '邀请码：AB12','推荐码为 EXAMPLE4','返佣码 **ABCD1234**','Invite code: TEST1234',
    'Referral CODE = "AB12CD34"','invite code is TEST1234','邀请码：ＡＢＣ１２３４',
    'https://example.com/join?ref=TEST1234','https://example.com/register?inviteCode=TEST1234',
    '<a href="https://example.com/?x=1&amp;referral=TEST1234">source</a>',
    '[source](https://example.com/?%72%65%66=TEST1234)',
    'https://example.com/?next=https%3A%2F%2Fexample.com%2Fjoin%3Fref%3DTEST1234',
    'https://example.com/#/register?REF=TEST1234','referral code: `SYNTHETIC1234`',
    '邀请码：<strong>TEST1234</strong>', 'Invite&nbsp;code: <span>TEST</span>1234',
    'Trading fees changed by 50%. [Source](https://example.com/register?%72%65%66=TEST1234)',
    '50% discount. https://example.com/?next=https%3A%2F%2Fexample.com%2Fjoin%3Fref%3DTEST1234',
  ])assert.equal(containsReferralInformation(text),true,text);
});

test('normal code, year and verification descriptions are not referral information',()=>{
  for(const text of ['验证码：123456','这段代码使用 2026 年标准。','An invite code is not required.','Use the verification code 123456.','Reference documentation: https://example.com/?reference=guide','推荐码只是一个字段名称。']){
    assert.equal(containsReferralInformation(text),false,text);
  }
});

test('cleaning removes the affected sentence and URL parameters, then checks again',()=>{
  const draft={title:'A useful tutorial',description:'Tutorial',body:'Read these steps.\n邀请码：TEST1234。\n[Source](https://example.com/guide?lang=en&ref=TEST1234)'};
  const result=prepareReferralFreeDraft(draft,site);
  assert.equal(result.changed,true);assert.equal(result.blocked,false);
  assert.match(result.draft.body,/Read these steps/);assert.match(result.draft.body,/guide\?lang=en/);
  assert.equal(containsReferralInformation(result.draft.body),false);
  assert.equal(prepareReferralFreeDraft({...draft,title:'推荐码 TEST1234'},site).blocked,true);
});

test('codes already present in the site analysis are checked without a label',()=>{
  const analyzed={...site,description:'公开资料注明推荐码为 SYNTHETIC1234。'};
  assert.deepEqual(siteReferralCodes(analyzed),['SYNTHETIC1234']);
  const result=prepareReferralFreeDraft({title:'Guide',description:'Guide',body:'Use SYNTHETIC1234 today.\nSafe educational details.'},analyzed);
  assert.equal(result.changed,true);assert.equal(result.blocked,false);assert.doesNotMatch(result.draft.body,/SYNTHETIC1234/);
});

test('topic selection rejects signup, account-opening, invitation and referral material',()=>{
  for(const path of ['/guides/register-account','/exchange-sign-up-guide','/how-to-open-an-account','/referral-code','/邀请好友','/平台开户指南','/article?ref=TEST1234']){
    assert.equal(isArticleTopicUrl(new URL(path,site.url).href,site),false,path);
  }
  const titled={...site,topics:[{url:'https://example.com/guide',title:'邀请注册与开户指南'}]};
  assert.equal(isArticleTopicUrl(titled.topics[0].url,titled),false);
  assert.equal(isArticleTopicUrl('https://example.com/guides/verification-code',site),true);
});
