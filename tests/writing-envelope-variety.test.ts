import assert from 'node:assert/strict';
import test from 'node:test';
import {createWritingProfile, createWritingEnvelope, decorateProfileDraft, fallbackWritingVariants, siteStyle, stripWritingEnvelope} from '../src/shared/writing-profile';

const domains = Array.from({length: 15}, (_, index) => `site-${index}.example.com`);
const body = ['第一段介绍资料的适用范围和背景，说明本文讨论的对象。', '第二段解释具体规则，以及读者需要先确认的前提条件。', '第三段列出常见误区，并说明为什么容易混淆这些概念。', '第四段总结要点，提醒读者以原始资料为准。'].join('\n\n');

test('the link sentence sits inside an ordinary paragraph, never on a line of its own', () => {
  for (const domain of domains) {
    const profile = createWritingProfile({domain, language: 'zh-CN'});
    const site = {id: domain, domain, url: `https://${domain}/`, name: '示例站点', language: 'zh-CN'};
    const envelope = createWritingEnvelope(profile, site, `task-${domain}`, {topicUrl: `https://${domain}/guide`, requireTopicLink: true});
    const decorated = decorateProfileDraft({title: 't', description: 'd', body}, envelope, {seed: profile.seed, language: 'zh-CN'});
    const paragraphs = decorated.body.split(/\n\s*\n/);
    assert.ok(!paragraphs.some(paragraph => paragraph.trim() === envelope.link), domain);
    assert.ok(paragraphs.some(paragraph => paragraph.includes(envelope.link) && paragraph.length > envelope.link.length), domain);
    assert.ok(decorated.body.includes(envelope.disclosure));
    assert.equal(stripWritingEnvelope(decorated.body, envelope), body, 'program-inserted text strips back to the written body');
  }
});

test('sites do not share one closing layout or one set of link lead-ins', () => {
  const styles = domains.map(domain => siteStyle(createWritingProfile({domain, language: 'zh-CN'}).seed, 'zh-CN'));
  assert.ok(new Set(styles.map(style => style.layout)).size >= 4, 'at least four closing layouts across fifteen sites');
  assert.ok(new Set(styles.map(style => style.linkSentences.join('|'))).size >= 12, 'link lead-in sets differ across sites');
});

test('fallback disclosure and risk sentences differ between sites', () => {
  const sets = domains.map(domain => new Set(fallbackWritingVariants('zh-CN', createWritingProfile({domain, language: 'zh-CN'}).seed).disclosures));
  let overlaps = 0, pairs = 0;
  for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
    pairs++;
    overlaps += [...sets[a]].filter(sentence => sets[b].has(sentence)).length;
  }
  assert.ok(overlaps / pairs < 2, `average shared disclosures per site pair: ${(overlaps / pairs).toFixed(2)}`);
  for (const set of sets) assert.equal(set.size, 12);
});
