import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyMinHash, diversityCorpus, diversityRecovery, minHashSimilarity, openingSimilarity, reframeDraftWithoutAi, scanDraftDiversity, titleSkeleton, type DiversityDraft } from '../src/main/draft-diversity';
import { createWritingEnvelope, createWritingProfile, decorateProfileDraft } from '../src/shared/writing-profile';

const at = '2026-10-18T12:00:00.000Z';
const draft: DiversityDraft = { id: 'draft-a', siteId: 'site-a', siteName: '甲站', createdAt: at, title: '甲站的30个配置步骤', description: '', body: '本文解释客户端连接设置中的关键概念与适用条件。连接参数应根据原始说明填写，超时设置只影响等待行为，不代表服务可用性。' };

test('corpus covers all drafts from the current site plus only the last ninety days of other sites', () => {
  const old = '2026-01-01T00:00:00.000Z';
  const recent = '2026-10-01T00:00:00.000Z';
  const history = [{ ...draft, id: 'own-old', createdAt: old }, { ...draft, id: 'other-old', siteId: 'site-b', createdAt: old }, { ...draft, id: 'other-recent', siteId: 'site-b', createdAt: recent }, draft];
  assert.deepEqual(diversityCorpus(draft, history, at).map(item => item.id), ['own-old', 'other-recent']);
  assert.equal(scanDraftDiversity(draft, [{ ...draft, id: 'own-old', createdAt: old }], { now: at }).duplicate, true);
  const oldCrossSite = scanDraftDiversity(draft, [{ ...draft, id: 'other-old', siteId: 'site-b', createdAt: old }], { now: at });
  assert.equal(oldCrossSite.duplicate, true);
  assert.deepEqual(oldCrossSite.matches[0].metrics, ['shared_sentence']);
});

test('title skeletons remove site names and digits across Unicode forms', () => {
  assert.equal(titleSkeleton('甲站的３０个配置步骤', ['甲站']), titleSkeleton('乙站的7个配置步骤', ['乙站']));
  const result = scanDraftDiversity(draft, [{ ...draft, id: 'draft-b', siteId: 'site-b', siteName: '乙站', title: '乙站的７个配置步骤', body: '密码管理器的设计依赖隔离存储与正确的访问控制。' }], { now: at });
  assert.ok(result.matches[0].metrics.includes('title'));
});

test('Chinese opening trigrams and body MinHash detect copied content without word segmentation', () => {
  assert.equal(openingSimilarity(draft.body, draft.body.replaceAll('，', ', ')), 1);
  assert.equal(minHashSimilarity(bodyMinHash(draft.body), bodyMinHash(draft.body)), 1);
  const result = scanDraftDiversity(draft, [{ ...draft, id: 'draft-b', siteId: 'site-b', title: '操作系统中的不同资源模型' }], { now: at });
  assert.ok(result.matches[0].metrics.includes('opening'));
  assert.ok(result.matches[0].metrics.includes('body'));
  assert.ok(result.conflictingExcerpts.length > 0);
});

test('a long sentence shared by any two distinct sites is reported even among otherwise different articles', () => {
  const common = '所有操作均应理解具体规则的适用条件与边界';
  const candidate = { ...draft, title: '数字资料的目录结构', body: `数字资料需要合理的目录结构。${common}。备份策略可以采用分层组织。` };
  const history = [
    { ...draft, id: 'b', siteId: 'site-b', title: '命令行工具入门', body: `命令行程序使用参数控制输出。${common}。退出状态由调用方读取。` },
  ];
  const result = scanDraftDiversity(candidate, history, { now: at });
  assert.ok(result.sharedSentences.includes(common));
  assert.ok(result.matches.some(item => item.metrics.includes('shared_sentence')));
  assert.deepEqual(scanDraftDiversity(candidate, history.map(item => ({ ...item, siteId: 'site-a' })), { now: at }).sharedSentences, []);
});

test('managed disclosure and risk sentences are unique by construction and do not trip the cross-site check', () => {
  const site = { id: 'site-a', name: 'Example', domain: 'example.com', url: 'https://example.com/', language: 'zh' };
  const envelope = createWritingEnvelope(createWritingProfile(site), site, 'task');
  const candidate = { ...draft, ...decorateProfileDraft({ ...draft, title: '目录树的层级组织', body: '目录树的层级组织是文本信息管理的一种方式。将文件按主题分组可以帮助定位信息。' }, envelope), writingEnvelope: envelope };
  const previous = { ...draft, ...decorateProfileDraft({ ...draft, title: '为什么关注屏幕色彩', body: '屏幕色彩的显示效果与光照环境有关。阅读区域的亮度应当与周围环境保持协调。' }, envelope), id: 'b', siteId: 'site-b', writingEnvelope: envelope };
  // An AI rewrite cannot change program-inserted sentences, so they never count here.
  assert.equal(scanDraftDiversity(candidate, [previous], { now: at }).duplicate, false);
  // Sentences the AI wrote still do.
  const copied = { ...previous, body: previous.body.replace('屏幕色彩的显示效果与光照环境有关。', '目录树的层级组织是文本信息管理的一种方式。') };
  assert.equal(scanDraftDiversity(candidate, [copied], { now: at }).duplicate, true);
});

test('multi-paragraph managed platform disclosure is not counted across sites',()=>{
  const site={id:'site-a',name:'Example',domain:'example.com',url:'https://example.com/',language:'en'};
  const envelope=createWritingEnvelope(createWritingProfile(site),site,'task');
  envelope.disclosure='The publishing account is managed by the site editorial team.\n\n'+envelope.disclosure;
  const prose=[['目录结构','目录层级使文件组织更清晰。不同目录需要明确的分类方式。'],['屏幕亮度','屏幕阅读涉及周围光照条件。适度调整显示参数可以改善可读性。'],['键盘布局','键盘布局决定按键与字符之间的对应关系。使用者可以从系统设置中查看当前方案。']];
  const rows=prose.map(([title,body],index)=>({...draft,...decorateProfileDraft({...draft,title,body},envelope),id:`row-${index}`,siteId:`site-${index}`,writingEnvelope:envelope}));
  const result=scanDraftDiversity(rows[0],rows.slice(1),{now:at});
  assert.equal(result.duplicate,false);assert.equal(result.sharedSentences.length,0);
});

test('a site-specific identity sentence keeps the entire hostname when comparing sites',()=>{
  const identity=(domain:string)=>`Publisher disclosure: An automated assistant prepared and published this article using cited public material rather than personal experience for Example Research (${domain}).`;
  const candidate={...draft,title:'Directory storage design',body:`A directory tree groups related documents and records their provenance. ${identity('example.com')} Each category has an explicit inclusion rule and a separate maintenance schedule.`};
  const previous={...draft,id:'other',siteId:'site-b',title:'Color display settings',body:`Display colors depend on ambient light and calibrated hardware. ${identity('example.org')} Readers can compare two device profiles under the same conditions.`};
  assert.deepEqual(scanDraftDiversity(candidate,[previous],{now:at}).sharedSentences,[]);
});

test('first collision is reframed without losing factual content or the managed envelope', () => {
  const site = { id: 'site-a', name: 'Example', domain: 'example.com', url: 'https://example.com/', language: 'zh' };
  const profile = createWritingProfile(site), envelope = createWritingEnvelope(profile, site, 'task');
  const decorated = decorateProfileDraft(draft, envelope, { disclosureAt: 'start' });
  const result = reframeDraftWithoutAi(decorated, profile, { topic: '连接配置', taskId: 'task', envelope });
  assert.notEqual(result.title, decorated.title);
  assert.ok(result.body.startsWith(envelope.disclosure));
  assert.ok(result.body.replace(/\s+/g,'').includes(draft.body.replace(/\s+/g,'')));
  assert.ok(result.body.includes(envelope.link));
});

test('recovery spends at most one local rewrite and preserves the final review budget', () => {
  const collision = { duplicate: true };
  assert.deepEqual(diversityRecovery({ duplicate: false }, 3, 3), { action: 'accept' });
  assert.deepEqual(diversityRecovery(collision, 0, 1), { action: 'reframe', nextStage: 1 });
  assert.deepEqual(diversityRecovery(collision, 1, 1), { action: 'local_rewrite', nextStage: 2 });
  assert.deepEqual(diversityRecovery(collision, 2, 2), { action: 'defer_new_angle', nextStage: 3, reasonCode: 'duplicate_content' });
  assert.deepEqual(diversityRecovery(collision, 1, 2), { action: 'defer_new_angle', nextStage: 3, reasonCode: 'duplicate_content' });
  assert.deepEqual(diversityRecovery(collision, 0, 3), { action: 'stop', reasonCode: 'ai_task_limit' });
});

test('HTML headings, code and page styles are not compared as article sentences', () => {
  const candidate = { ...draft, title: 'Wallet backup basics', body: '<h2>Frequently Asked Questions</h2>\n<p>A seed phrase restores every account derived from it, so store it offline.</p>\n<pre><code>npm install --save-dev typescript</code></pre>' };
  const history = [{ ...draft, id: 'b', siteId: 'site-b', title: 'Exchange fee tiers', body: '<h2>Frequently Asked Questions</h2>\n<p>Maker and taker rates depend on the thirty-day trading volume tier.</p>\n<pre><code>npm install --save-dev typescript</code></pre>' }];
  assert.deepEqual(scanDraftDiversity(candidate, history, { now: at }).sharedSentences, []);
  const page = (text: string) => `<!doctype html><html><head><title>Notes</title><style>body { font-family: system-ui, sans-serif; margin: 0 auto; }</style></head><body><p>${text}</p></body></html>`;
  const left = { ...candidate, body: page('A seed phrase restores every account derived from it, so store it offline.') };
  const right = [{ ...history[0], body: page('Maker and taker rates depend on the thirty-day trading volume tier.') }];
  assert.deepEqual(scanDraftDiversity(left, right, { now: at }).sharedSentences, []);
  // A real shared paragraph inside HTML is still found.
  const copied = 'Each withdrawal address must be confirmed by email before the first transfer';
  assert.ok(scanDraftDiversity({ ...candidate, body: `<p>${copied}.</p>` }, [{ ...history[0], body: `<p>${copied}.</p>` }], { now: at }).sharedSentences.length > 0);
});
