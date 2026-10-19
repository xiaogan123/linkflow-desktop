import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileDraftInstruction, conflictingManagedSentences, createWritingEnvelope, createWritingProfile, decorateProfileDraft, ensureWritingProfile, fallbackWritingVariants, isWritingProfile, parseWritingVariants, selectWritingGenre, shouldGenerateWritingVariants, siteStyle, stripWritingEnvelope, writingGenreAvailable, writingProfileFingerprint, writingProfileSimilarity, WRITING_GENRES, type WritingProfile } from '../src/shared/writing-profile';

const site = { id: 'site-a', domain: 'example.com', name: 'Example', url: 'https://example.com/', language: 'zh-CN' };

test('domain-seeded profiles remain stable and one hundred sites receive distinct editorial choices', () => {
  const profiles: Array<{ id: string; writingProfile: WritingProfile }> = [];
  for (let index = 0; index < 100; index++) {
    const candidate = { ...site, id: `site-${index}`, domain: `site-${index}.example.com` };
    const profile = ensureWritingProfile(candidate, profiles);
    assert.ok(isWritingProfile(profile));
    assert.deepEqual(ensureWritingProfile({ ...candidate, writingProfile: profile }, profiles), profile);
    profiles.push({ id: candidate.id, writingProfile: profile });
  }
  assert.equal(new Set(profiles.map(item => item.writingProfile.fingerprint)).size, 100);
  assert.equal(new Set(profiles.map(item => item.writingProfile.tone)).size, 6);
  assert.equal(new Set(profiles.map(item => item.writingProfile.length.min)).size, 3);
  for (const left of profiles) for (const right of profiles) {
    if (left.id !== right.id) assert.ok(writingProfileSimilarity(left.writingProfile, right.writingProfile) < 4);
  }
});

test('profile collisions change the seed while an existing site retains its fixed profile', () => {
  const first = createWritingProfile(site);
  const second = ensureWritingProfile({ ...site, id: 'site-b' }, [{ id: site.id, writingProfile: first }]);
  assert.notEqual(second.seed, first.seed);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(ensureWritingProfile({ ...site, writingProfile: first }, [{ id: 'site-b', writingProfile: second }]), first);
  assert.equal(isWritingProfile({ ...first, seed: -1 }), false);
  assert.equal(isWritingProfile({ ...first, homeLinkRatio: 2 }), false);
  assert.equal(isWritingProfile({ ...first, genreWeights: {} }), false);
  assert.equal(isWritingProfile({ ...first, titlePatterns: Array(6).fill('scope') }), false);
  const near = { ...first, openingStyles: [...first.openingStyles].reverse() };
  near.fingerprint = writingProfileFingerprint(near);
  assert.notEqual(near.fingerprint, first.fingerprint);
  // Openings are drawn from the whole list, so a reordered list is the same choice.
  assert.equal(writingProfileSimilarity(first, near), 5);
  assert.notEqual(ensureWritingProfile({ ...site, id: 'near' }, [{ id: site.id, writingProfile: near }]).seed, first.seed);
});

test('analysis variants enrich a profile without changing discrete editorial choices', () => {
  const original = createWritingProfile(site);
  const variants = fallbackWritingVariants('zh');
  // AI variants are this site's own wording; the built-in sentences count as already shared.
  variants.disclosures = variants.disclosures.map(value => value + '内容用于资料介绍。');
  variants.risks = variants.risks.map(value => value + '请先核对原始说明。');
  variants.linkSentences = ['可从{link}继续阅读原文。','更多相关说明整理在{link}。','核对资料时可先查看{link}。','背景与边界可参阅{link}。'];
  const enriched = ensureWritingProfile({ ...site, writingProfile: original }, [], variants);
  assert.equal(enriched.fingerprint, original.fingerprint);
  assert.equal(enriched.variantsSource, 'analysis');
  assert.deepEqual(enriched.variants, variants);
  assert.equal(parseWritingVariants({ ...variants, disclosures: Array(12).fill('相同的关系披露句子') }), undefined);
  assert.equal(parseWritingVariants({ ...variants, risks: variants.risks.map(value => value + '100%') }), undefined);
});

test('complete site variants add link lead-ins and reject another site\'s exact managed sentence', () => {
  const original = createWritingProfile(site);
  assert.equal(shouldGenerateWritingVariants(original), true);
  const own = fallbackWritingVariants('zh');
  const variants = { disclosures: own.disclosures.map(value => value + '内容用于资料介绍。'), risks: own.risks.map(value => value + '请先核对原始说明。'), linkSentences: [
    '关于这一主题，可以继续阅读{link}。', '相关条件和出处整理在{link}。',
    '需要核对原始内容时，可查看{link}。', '这部分的延伸材料收录于{link}。',
  ] };
  const enriched = ensureWritingProfile({ ...site, writingProfile: original }, [], variants);
  assert.equal(shouldGenerateWritingVariants(enriched), false);
  assert.deepEqual(parseWritingVariants(variants), variants);
  assert.ok(siteStyle(enriched.seed, 'zh', enriched.variants).linkSentences.every(sentence => variants.linkSentences.includes(sentence)));
  assert.equal(createWritingEnvelope(enriched, site, 'task').link.includes(']('), true);
  const other = { id: 'other', writingProfile: createWritingProfile({ domain: 'other.example.com', language: 'zh' }, 0, variants) };
  assert.ok(conflictingManagedSentences(variants, [other], site.id).length > 0);
  // Every sentence is taken by another site: keep the current profile instead of failing the analysis.
  assert.equal(ensureWritingProfile({ ...site, writingProfile: original }, [other], variants), original);
  // One sentence taken: only that one is dropped.
  const partial = { id: 'partial', writingProfile: { ...original, variants: { disclosures: [variants.disclosures[0], ...fallbackWritingVariants('en').disclosures.slice(0, 3)], risks: fallbackWritingVariants('en').risks.slice(0, 3), linkSentences: ['Read more at {link}.', 'Background is at {link}.'] }, variantsSource: 'analysis' as const } };
  const kept = ensureWritingProfile({ ...site, writingProfile: original }, [partial], variants);
  assert.equal(kept.variants.disclosures.includes(variants.disclosures[0]), false);
  assert.equal(kept.variants.disclosures.length, 11);
  assert.equal(parseWritingVariants({ ...variants, linkSentences: variants.linkSentences.map(sentence => sentence.replace('{link}', '本站')) }), undefined);
});

test('program decorations are stable, brand signed, and removable before diversity comparisons', () => {
  const profile = createWritingProfile(site);
  const envelope = createWritingEnvelope(profile, site, 'task-a', { topicUrl: 'https://example.com/article', requireTopicLink: true });
  assert.equal(envelope.targetUrl, 'https://example.com/article');
  assert.equal(envelope.signature, site.name);
  assert.deepEqual(createWritingEnvelope(profile, site, 'task-a', { topicUrl: envelope.targetUrl, requireTopicLink: true }), envelope);
  const original = { title: '资料标题', description: '摘要', body: '这里是正文。\n\n这里是第二段。' };
  const decorated = decorateProfileDraft(original, envelope, { disclosureAt: 'start' });
  assert.ok(decorated.body.startsWith(envelope.disclosure));
  assert.equal(stripWritingEnvelope(decorated.body, envelope), original.body);
  assert.equal(decorated.body.match(/https:\/\/example\.com\/article/g)?.length, 1);
  assert.equal(decorateProfileDraft(original, envelope, { articleRequired: false }), original);
  assert.equal(createWritingEnvelope(profile, site, 'task', { plainText: true }).link, 'https://example.com/');
  assert.throws(() => createWritingEnvelope(profile, site, 'task', { topicUrl: 'https://example.com/?ref=example', requireTopicLink: true }));
  assert.throws(() => createWritingEnvelope(profile, { ...site, url: 'http://example.com' }, 'task'));
});

test('link ratios sample both homepage and article paths while exact-topic channels retain their target', () => {
  const profile = createWritingProfile(site), counts = { home: 0, inner: 0 };
  for (let index = 0; index < 1000; index++) {
    const envelope = createWritingEnvelope(profile, site, `task-${index}`, { topicUrl: 'https://example.com/article' });
    counts[envelope.targetUrl === site.url ? 'home' : 'inner']++;
  }
  assert.ok(Math.abs(counts.home / 1000 - profile.homeLinkRatio) < .08);
  assert.ok(counts.home > 0 && counts.inner > 0);
});

test('genre rotation excludes the latest two genres, a second quarterly checklist, stale news, and daily saturation', () => {
  const profile = createWritingProfile(site), at = '2026-10-18T12:00:00.000Z';
  const history = [
    { siteId: site.id, genre: 'tutorial' as const, at: '2026-10-17T12:00:00.000Z' },
    { siteId: site.id, genre: 'questions' as const, at: '2026-10-16T12:00:00.000Z' },
    { siteId: site.id, genre: 'checklist' as const, at: '2026-10-01T12:00:00.000Z' },
  ];
  for (let index = 0; index < 100; index++) {
    const genre = selectWritingGenre({ siteId: site.id, taskId: `task-${index}`, profile, at, history, dayTotal: 10, topicPublishedAt: '2026-09-01T12:00:00.000Z' });
    assert.ok(genre);
    assert.ok(!['tutorial', 'questions', 'checklist', 'recent_news'].includes(genre));
  }
  const saturated = WRITING_GENRES.flatMap(genre => Array.from({ length: 3 }, (_, index) => ({ siteId: `${genre}-${index}`, genre, at })));
  assert.equal(selectWritingGenre({ siteId: site.id, taskId: 'task', profile, at, history: saturated, dayTotal: 10 }), undefined);
  const quarterLater = '2027-01-01T12:00:00.000Z';
  const checklistOnly = { ...profile, genreWeights: { ...profile.genreWeights, checklist: 1e9 } };
  assert.equal(selectWritingGenre({ siteId: site.id, taskId: 'task', profile: checklistOnly, at: quarterLater, history, dayTotal: 10 }), 'checklist');
});

test('quarterly checklist follows the site timezone across UTC month and year boundaries',()=>{
  const history=[{siteId:'site-a',genre:'checklist' as const,at:'2026-03-31T15:50:00Z'},
    {siteId:'site-a',genre:'tutorial' as const,at:'2026-03-31T16:00:00Z'},
    {siteId:'site-a',genre:'questions' as const,at:'2026-03-31T16:05:00Z'}];
  const base={siteId:'site-a',at:'2026-03-31T16:10:00Z',history,dayTotal:10,dayKey:(at:string)=>at.slice(0,10)};
  assert.equal(writingGenreAvailable('checklist',{...base,timeZone:'Asia/Singapore'}),true,'April is the next local quarter');
  assert.equal(writingGenreAvailable('checklist',{...base,timeZone:'UTC'}),false,'both timestamps remain in March UTC');
  const yearHistory=history.map(item=>({...item,at:item.at.replace('2026-03-31','2026-12-31')}));
  assert.equal(writingGenreAvailable('checklist',{...base,at:'2026-12-31T16:10:00Z',history:yearHistory,timeZone:'Asia/Singapore'}),true);
});

test('profile draft instructions request evidence facts and leave all managed text to the program', () => {
  const instruction = buildProfileDraftInstruction(createWritingProfile(site), 'field_comparison', { language: 'zh', taskId: 'task' });
  assert.ok(instruction.includes('claim、quote 和 url'));
  assert.ok(instruction.includes('邀请码、推荐码'));
  assert.ok(instruction.includes('不下优劣或选择结论'));
  assert.ok(!instruction.includes('核验'));
  assert.ok(!instruction.includes('“') && !instruction.includes('”'));
});

test('an AI variant that repeats a built-in sentence is dropped like a sentence another site uses', () => {
  const own = fallbackWritingVariants('zh');
  const variants = { disclosures: own.disclosures.map(value => value + '内容用于资料介绍。'), risks: own.risks.map(value => value + '请先核对原始说明。'),
    linkSentences: ['更完整的说明见{link}。', '可从{link}继续阅读原文。', '核对资料时可先查看{link}。', '背景与边界可参阅{link}。'] };
  assert.deepEqual(conflictingManagedSentences(variants, [], site.id), ['更完整的说明见{link}。']);
  const enriched = ensureWritingProfile({ ...site, writingProfile: createWritingProfile(site) }, [], variants);
  assert.equal(enriched.variantsSource, 'analysis');
  assert.deepEqual(enriched.variants.linkSentences, variants.linkSentences.slice(1));
});
