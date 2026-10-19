import assert from 'node:assert/strict';
import test from 'node:test';
import {containsReferralInformation, prepareReferralFreeDraft, siteReferralCodes, stripReferralDetailed, stripReferralInformation} from '../src/shared/referral-policy';

const site = {url: 'https://example-site.com/', description: '示例站点'};

test('a referral URL followed by Chinese text only loses its parameter, never the following text', () => {
  const input = '官网：https://www.binance.com/join?ref=XQ7731，注册后在资产页查看。下一步打开现货页面';
  const output = stripReferralInformation(input);
  assert.equal(output, '官网：https://www.binance.com/join，注册后在资产页查看。下一步打开现货页面');
});

test('a bare code left next to a cleaned URL still removes its sentence', () => {
  const input = '第一段保持不变。注册链接 https://www.binance.com/join?ref=XQ7731（邀请码 XQ7731）。最后一句保留。';
  const output = stripReferralInformation(input);
  assert.equal(output, '第一段保持不变。最后一句保留。');
  assert.equal(containsReferralInformation(output), false);
});

test('disclaimers that mention codes without any code are left untouched', () => {
  for (const text of [
    '本文不提供任何邀请码。Binance 新用户需要完成身份认证。',
    '无需填写推荐码。2026 年起规则有变化。',
    "We don't include any referral code. Binance requires KYC.",
    'Some pages list referral code links when you sign up.',
    '推荐码 2026 年最新说明见官方公告。',
    '验证码 123456 只在登录时使用，推荐阅读官方帮助。交易对 BTCUSDT 的代码不变。',
  ]) {
    assert.equal(containsReferralInformation(text), false, text);
    assert.equal(stripReferralInformation(text), text, text);
  }
});

test('codes hidden behind table cells, traditional labels, attributes and invisible characters are caught', () => {
  for (const text of [
    '| 邀请码 | XQ7731 |',
    '邀請碼：XQ7731',
    '推薦碼 → ABCD1234',
    'Invitation code: ABC123',
    'Referral ID: XY12345',
    '<img src="a.png" alt="邀请码 ABCD1234">',
    '邀请码：BN⁠6018',
    '邀请码：B&#x200B;N6018',
  ]) assert.equal(containsReferralInformation(text), true, text);
});

test('referral links in paths, short links and the site redirect are caught', () => {
  for (const text of [
    '注册入口 https://www.okx.com/join/ABCD1234 可以查看。',
    '短链 https://bit.ly/3abcXYZ 打开。',
    '跳转 https://example-site.com/r/okx 打开。',
    'https://www.bybit.com/register?affiliate_id=12345',
    'https://www.gate.io/signup?rcode=ABC123',
  ]) assert.equal(containsReferralInformation(text, [], 'example-site.com'), true, text);
  assert.equal(containsReferralInformation('官方页面 https://www.okx.com/help/fees 说明费率。'), false);
});

test('removing a sentence keeps paragraphs, lists and tables byte-identical elsewhere', () => {
  const input = [
    'First paragraph stays.',
    '',
    'Second paragraph. Use invite code ABC123 today. Final sentence here.',
    '',
    '1. Open the app',
    '2. Check the fee table',
    '',
    '| 项目 | 说明 |',
    '| --- | --- |',
    '| 费率 | 0.1% |',
    '| 邀请码 | XQ7731 |',
    '',
    '## Step 1. Review',
  ].join('\n');
  const output = stripReferralInformation(input);
  assert.equal(output, [
    'First paragraph stays.',
    '',
    'Second paragraph. Final sentence here.',
    '',
    '1. Open the app',
    '2. Check the fee table',
    '',
    '| 项目 | 说明 |',
    '| --- | --- |',
    '| 费率 | 0.1% |',
    '',
    '## Step 1. Review',
  ].join('\n'));
  assert.equal(stripReferralInformation(output), output, 'cleaning is idempotent');
});

test('a code in a heading line blocks instead of cutting the heading', () => {
  const result = stripReferralDetailed('## 邀请码 XQ7731 使用说明\n\n正文。');
  assert.equal(result.blocked, true);
});

test('the draft is blocked when cleaning would remove the only link to the target page', () => {
  const draft = {title: '费率说明', description: '说明', body: '开头。完整步骤见 [本站教程](https://example-site.com/guide)，注册时填写邀请码 XQ7731 可享减免。结尾。'};
  const result = prepareReferralFreeDraft(draft, site, 'https://example-site.com/guide');
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? '', /外链/);
  const safe = prepareReferralFreeDraft({...draft, body: '开头。完整步骤见 [本站教程](https://example-site.com/guide)。注册时填写邀请码 XQ7731。结尾。'}, site, 'https://example-site.com/guide');
  assert.equal(safe.blocked, false);
  assert.equal(safe.draft.body, '开头。完整步骤见 [本站教程](https://example-site.com/guide)。结尾。');
});

test('site codes are only code-shaped tokens, never ordinary words from the description', () => {
  assert.deepEqual(siteReferralCodes({url: 'https://example-site.com/', description: '币安推荐码2026最新注册教程'}), []);
  assert.deepEqual(siteReferralCodes({url: 'https://example-site.com/', description: 'Binance referral code guide and program'}), []);
  assert.deepEqual(siteReferralCodes({url: 'https://example-site.com/', description: '本站邀请码 XQ7731，注册可享减免'}), ['XQ7731']);
});

test('target-link protection also works for percent-encoded and Chinese paths', () => {
  const target = 'https://example-site.com/guides/%E5%B8%81%E5%AE%89%E8%B4%B9%E7%8E%87';
  for (const written of [target, 'https://example-site.com/guides/币安费率']) {
    const draft = {title: '费率说明', description: '说明', body: `开头。完整说明见 [本站](${written})，邀请码 XQ7731 可享减免。结尾。`};
    const result = prepareReferralFreeDraft(draft, site, target);
    assert.equal(result.blocked, true, written);
  }
});
