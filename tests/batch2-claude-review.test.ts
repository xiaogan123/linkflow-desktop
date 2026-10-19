import assert from 'node:assert/strict';
import test from 'node:test';
import {accountCreationBudgetExceeded, ACCOUNT_CREATION_LIMITS} from '../src/main/account-bindings';
import {identityRegistrationSettled, retireLegacyAccounts} from '../src/main/account-retirement';
import {inspectRecheckedLinkHtml} from '../src/integrations/web';
import {isReferralTopicTitle} from '../src/shared/topic-policy';
import type {Account} from '../src/shared/types';

const now = new Date('2026-10-20T12:00:00.000Z');
const account = (overrides: Partial<Account>): Account => ({id: overrides.id ?? 'a1', channelId: 'telegraph', email: '', createdAt: '2026-10-01T00:00:00.000Z', status: 'registered', hasPassword: false, source: 'generated', ...overrides} as Account);

test('new generated accounts are capped per platform and in total per day', () => {
  const recent = (id: string, channelId: string) => account({id, channelId, createdAt: '2026-10-20T08:00:00.000Z'});
  const base = {accounts: [] as Account[], accountBindings: [], tasks: []} as never as Parameters<typeof accountCreationBudgetExceeded>[0];
  assert.equal(accountCreationBudgetExceeded(base, 'telegraph', now), false);
  const twoTelegraph = {...base, accounts: [recent('t1', 'telegraph'), recent('t2', 'telegraph')]};
  assert.equal(ACCOUNT_CREATION_LIMITS.perChannelPerDay, 2);
  assert.equal(accountCreationBudgetExceeded(twoTelegraph, 'telegraph', now), true);
  assert.equal(accountCreationBudgetExceeded(twoTelegraph, 'nostr', now), false);
  const six = {...base, accounts: ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => recent(id, `channel-${index}`))};
  assert.equal(accountCreationBudgetExceeded(six, 'telegraph', now), true);
  const old = {...base, accounts: [account({id: 'o1', createdAt: '2026-10-18T00:00:00.000Z'}), account({id: 'o2', createdAt: '2026-10-18T00:00:00.000Z'})]};
  assert.equal(accountCreationBudgetExceeded(old, 'telegraph', now), false);
});

test('an identity whose registration is still open is never retired', () => {
  const pending = account({id: 'p1', channelId: 'openagentchat', username: 'linkflow-agent-1', status: 'unknown'});
  const intent = account({id: 'p2', channelId: 'shellbook', username: 'linkflow-agent-2', shellbook: {version: 1, stage: 'intent', operationId: 'op', requestHash: 'h', agentName: 'linkflow-agent-2', description: 'Linkflow'}} as Partial<Account>);
  const settled = account({id: 's1', channelId: 'openagentchat', username: 'linkflow-agent-3'});
  const state = {accounts: [pending, intent, settled], accountBindings: [], tasks: []} as never as Parameters<typeof retireLegacyAccounts>[0];
  assert.equal(identityRegistrationSettled(state, pending), false);
  assert.equal(identityRegistrationSettled(state, intent), false);
  retireLegacyAccounts(state, now);
  assert.equal(pending.retiredAt, undefined);
  assert.equal(intent.retiredAt, undefined);
  assert.ok(settled.retiredAt);
});

test('ordinary theme CSS does not make a visible body link uncertain', () => {
  const page = (style: string) => `<!doctype html><html><head><style>${style}</style></head><body><main><p>正文见 <a href="https://example-site.com/guide">这里</a>。</p></main></body></html>`;
  for (const style of [
    '@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}',
    '@media (max-width:600px){body{font-size:15px}}',
    ':root{--text:#222}body{color:var(--text);font-size:var(--fs)}.content{max-width:calc(100% - 2rem)}',
  ]) {
    const result = inspectRecheckedLinkHtml(page(style), 'https://telegra.ph/x', 'https://example-site.com/');
    assert.equal(result.found, true, style);
  }
  const hidden = inspectRecheckedLinkHtml(page('@media screen{main{display:none}}'), 'https://telegra.ph/x', 'https://example-site.com/');
  assert.equal(hidden.found, false);
});

test('topic titles: funnels are excluded, ordinary rebate or compliance topics are not', () => {
  for (const title of ['币安注册教程', 'OKX 开户步骤', '邀请好友活动', '最新返佣码', 'Binance sign up guide', 'okx-fanyongma']) assert.equal(isReferralTopicTitle(title), true, title);
  for (const title of ['OKX 返佣比例说明', '币安注册地在哪', '未注册平台的风险', '开户行信息怎么填', '活动邀请函说明', 'okx-fanyong-bili']) assert.equal(isReferralTopicTitle(title), false, title);
});
