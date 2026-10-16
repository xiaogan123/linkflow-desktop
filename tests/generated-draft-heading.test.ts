import assert from 'node:assert/strict';
import test from 'node:test';
import { Controller } from '../src/main/controller';
import { stripDuplicateGeneratedH1 } from '../src/main/generated-draft';
import { Store } from '../src/main/store';
import { CHANNELS } from '../src/integrations/catalog';
import { articleReviewDetail, canRestartArticleReview, taskPresentation } from '../src/ui/presentation';
import type { Site, Task } from '../src/shared/types';
import type { Vault } from '../src/main/vault';

const at = '2026-10-16T00:00:00.000Z';
const title = 'Synthetic research checklist';
const target = 'https://example.test/guide';
const prose = `## Check the source\n\nRecord the date, original claim, and evidence before drawing a conclusion. Readers can repeat the method and see its limits. [Read the guide](${target}) for the source material.\n\n## Recheck\n\nCompare later changes with the recorded inputs instead of assuming an earlier result still applies.`;
const site = (): Site => ({ id: 'site', domain: 'example.test', url: 'https://example.test/', email: 'owner@example.test', name: 'Example', description: 'Synthetic guidance', category: 'software', language: 'en', monthlyTarget: 1, status: 'ready', createdAt: at, articleReviewMode: 'manual' });
const task = (channelId: string): Task => ({ id: 'task', siteId: 'site', channelId, sourceDomain: channelId === 'lucid-page' ? 'lucid.page' : 'betterthanhtml.com', status: 'queued', createdAt: at, scheduledAt: at, updatedAt: at, attempts: 0, message: '', topicUrl: target });

test('only a sole top-level H1 with the same rendered title is removed', () => {
  assert.equal(stripDuplicateGeneratedH1(title, `# **${title}**\n\n${prose}`), prose);
  assert.equal(stripDuplicateGeneratedH1(title, `${title}\n===\n\n${prose}`), prose);
  for (const body of [
    `# Other title\n\n${prose}`,
    `# ${title} and more\n\n${prose}`,
    `# ${title}\n\n# Second title\n\n${prose}`,
    `> # ${title}\n\n${prose}`,
    `\`\`\`md\n# ${title}\n\`\`\`\n\n${prose}`,
    `\`# ${title}\`\n\n${prose}`,
    `${prose}\n\n## ${title}`,
  ]) assert.equal(stripDuplicateGeneratedH1(title, body), body);
});

test('generated Lucid and Better Than HTML drafts drop only the duplicate H1 before review', async () => {
  for (const channelId of ['lucid-page', 'betterthanhtml']) {
    const channel = CHANNELS.find(item => item.id === channelId);
    assert.ok(channel);
    const store = new Store(':memory:');
    store.update(state => { state.settings.dailyAiLimit = 40; state.settings.articleReviewMode = 'manual'; state.settings.channelOverrides[channelId] = true; state.sites = [site()]; state.tasks = [task(channelId)]; });
    let prompt = '';
    const controller = new Controller(store, { available: () => true } as Vault, 'fixture', {
      channelCatalog: [{ ...channel, enabled: true }],
      readTopicEvidence: async (_site, url) => ({ url, title: 'Guide', text: 'Synthetic source facts.', contentHash: 'a'.repeat(64) }),
      aiFactory: (() => ({ json: async (instruction: string) => { prompt = instruction; return { title, description: 'Synthetic summary', body: `# **${title}**\n\n${prose}` }; } })) as never,
    });
    try {
      await controller.generateDraft('task');
      const saved = store.read().tasks[0];
      assert.equal(saved.draft?.body, prose);
      assert.equal(saved.draft?.title, title);
      assert.equal(saved.articleReview, undefined);
      assert.equal(saved.articleApprovedAt, undefined);
      assert.match(prompt, /正文不要写一级标题/);
    } finally { controller.stop(); store.close(); }
  }
});

test('AI review action respects the shared six-call budget while retaining the problem detail', () => {
  const failed = { status: 'failed' as const, reason: 'Synthetic review failure', reviewedAt: at, evidenceUrls: [], draftRevision: 1, contentHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) };
  const base = { ...task('lucid-page'), status: 'needs_input' as const, checkpoint: 'article_review', draft: { title, description: 'Synthetic summary', body: prose }, articleReview: failed };
  assert.equal(canRestartArticleReview({ ...base, cost: { aiCalls: 5 } }, 'ai'), true);
  const exhausted = { ...base, cost: { aiCalls: 6 } };
  assert.equal(canRestartArticleReview(exhausted, 'ai'), false);
  assert.equal(taskPresentation(exhausted, 'ai').kind, 'user_action');
  assert.match(articleReviewDetail(exhausted, 'ai'), /AI 调用预算已用完/);
  assert.equal(canRestartArticleReview({ ...base, submittedAt: at, cost: { aiCalls: 5 } }, 'ai'), false);
  assert.equal(canRestartArticleReview({ ...base, cost: { aiCalls: 5 } }, 'manual'), false);
});
