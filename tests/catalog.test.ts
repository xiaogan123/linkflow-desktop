import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, matchChannels } from '../src/integrations/catalog.js';
import type { Category, Site } from '../src/shared/types.js';

function site(category: Category, language = 'en'): Site {
  return { id:'s', domain:'example.com', url:'https://example.com/', email:'owner@example.com', name:'Example', description:'Example product', category, language, monthlyTarget:2, status:'ready', createdAt:'2026-09-26',qualifications:category==='design'?{portfolio:'https://example.com/portfolio'}:undefined };
}

test('catalog contains distinct curated channels with source evidence', () => {
  assert.ok(CHANNELS.length >= 58);
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, CHANNELS.length);
  assert.equal(CHANNELS.filter(channel => channel.automation === 'browser').length, 4);
  for (const channel of CHANNELS) {
    assert.ok(channel.rulesUrl.startsWith('https://'), channel.id);
    assert.ok(channel.submitUrl.startsWith('https://'), channel.id);
    assert.ok(channel.allowedHosts.length > 0, channel.id);
    assert.ok(channel.allowedHosts.includes(new URL(channel.submitUrl).hostname), `${channel.id} submit host`);
    assert.match(channel.checkedAt, /^\d{4}-\d{2}-\d{2}$/, channel.id);
    assert.equal(channel.evidenceStatus, ['betterthanhtml','supanote','docs-md','sigle','nuance','prose','tumblr'].includes(channel.id)?'source_checked':'rules_checked',channel.id);
    if(channel.authority) assert.ok(channel.authority.source && channel.authority.asOf);
    if(channel.traffic) assert.ok(channel.traffic.source && channel.traffic.asOf);
    assert.match(channel.freeNote, /[\u3400-\u9fff]/, `${channel.id} freeNote`);
    assert.match(channel.qualityReason, /[\u3400-\u9fff]/, `${channel.id} qualityReason`);
    assert.match(channel.notes, /[\u3400-\u9fff]/, `${channel.id} notes`);
    if (channel.kind === 'community' && !['bluesky','hive'].includes(channel.id)) assert.equal(channel.automation, 'manual');
    if(channel.id==='bluesky'){assert.equal(channel.automation,'api');assert.equal(channel.contentFormat,'social');assert.equal(channel.articleRequired,true);assert.match(channel.notes,/短内容/);}
  }
});

test('new candidates remain manual and unknown prices cannot imply browser support', () => {
  const added = ['capterra','codeberg','nuget','crates-io','docker-hub','firefox-addons','vscode-marketplace','jetbrains-marketplace','flathub','fdroid','snap-store','itch-io','gravatar','google-business','bing-places','apple-business','yelp-business'];
  for (const id of added) assert.equal(CHANNELS.find(channel => channel.id === id)?.automation, 'manual', id);
  assert.ok(CHANNELS.filter(channel => channel.free === 'unknown').every(channel => channel.automation === 'manual'));
});

test('Show HN account creation does not require an email address', () => {
  assert.equal(CHANNELS.find(channel => channel.id === 'show-hn')?.emailRequired, false);
});

test('Blogger is an official API candidate with explicit OAuth and blog binding prerequisites', () => {
  const blogger = CHANNELS.find(channel => channel.id === 'blogger');
  assert.ok(blogger);
  assert.equal(blogger.automation, 'api');
  assert.equal(blogger.accountRequired, true);
  assert.equal(blogger.articleRequired, true);
  assert.equal(blogger.emailRequired, false);
  assert.equal(blogger.checkedAt, '2026-10-04');
  assert.match(blogger.freeNote, /Google授权/);
  assert.match(blogger.notes, /OAuth/);
  assert.match(blogger.notes, /绑定.*博客/);
});

test('Flathub stays disabled because its submission policy prohibits AI assistance', () => {
  const flathub = CHANNELS.find(channel => channel.id === 'flathub');
  assert.equal(flathub?.enabled, false);
  assert.equal(flathub?.automation, 'manual');
  assert.equal(flathub?.rulesUrl, 'https://docs.flathub.org/docs/for-app-authors/requirements#generative-ai-policy');
  assert.match(flathub?.notes ?? '', /本人纯人工/);
  assert.match(flathub?.notes ?? '', /不得创建或自动化提交 PR/);
});

test('matches a relevant audience and does not grant general links a high score', () => {
  const results = matchChannels(site('design'), CHANNELS);
  assert.ok(results.some(({channel}) => channel.id === 'behance'));
  assert.ok(results.some(({channel}) => channel.id === 'artstation'));
  assert.ok(results.slice(0, 8).some(({channel}) => channel.id === 'behance'));
  assert.ok(results.every(({score}) => score >= 35));
  assert.equal(matchChannels(site('finance'), CHANNELS).some(({channel}) => channel.id === 'github'), false);
  assert.ok(matchChannels(site('design','fr'), CHANNELS).some(({channel}) => channel.id === 'behance'));
  assert.equal(matchChannels(site('design','fr'), CHANNELS).some(({channel}) => channel.id === 'product-hunt'), false);
});

 test('AI financial content never gets developer or portfolio channels from category alone',()=>{const s=site('ai','zh');s.description='AI crypto education and referral disclosures';const matches=matchChannels(s,CHANNELS);for(const id of ['github','gitlab','behance','artstation','product-hunt'])assert.equal(matches.some(m=>m.channel.id===id),false,id);assert(matches.some(m=>m.channel.id==='telegraph'));assert.equal(CHANNELS.find(c=>c.id==='telegraph')?.automation,'api')});
 test('declared real developer evidence opens developer profiles without forging category',()=>{const s=site('developer');assert(!matchChannels(s,CHANNELS).some(m=>m.channel.id==='github'));s.qualifications={developer:'https://github.com/example/project'};assert(matchChannels(s,CHANNELS).some(m=>m.channel.id==='github'))});


test('financial publication candidates require ownership and never gain automatic execution',()=>{
  const ids=['ghost-pro','tumblr','linkedin-articles','youtube-channel','x-profile'];
  const s=site('finance','zh-hans');
  assert(!matchChannels(s,CHANNELS).some(m=>ids.includes(m.channel.id)));
  s.qualifications={publication:'https://example.com/about'};
  const matched=matchChannels(s,CHANNELS).map(m=>m.channel.id);
  for(const id of ids){const c=CHANNELS.find(c=>c.id===id)!;assert(matched.includes(id),id);assert.equal(c.automation,'manual');assert.equal(c.checkedAt,id==='tumblr'?'2026-10-09':'2026-09-30');assert.equal(c.authority,undefined);assert.equal(c.traffic,undefined)}
  const wordpress=CHANNELS.find(c=>c.id==='wordpress-com')!;assert(!matched.includes(wordpress.id));assert.equal(wordpress.automation,'api');assert.equal(wordpress.enabled,false);assert.equal(wordpress.checkedAt,'2026-10-08');assert.match(wordpress.notes,/待实发验收/);
  const leaflet=CHANNELS.find(c=>c.id==='leaflet')!;assert(!matched.includes(leaflet.id));assert.equal(leaflet.automation,'api');assert.equal(leaflet.enabled,false);assert.equal(leaflet.checkedAt,'2026-10-08');assert.equal(leaflet.requirements,undefined);assert(leaflet.categories.includes('general'));assert(leaflet.categories.includes('finance'));assert.equal(leaflet.authority,undefined);assert.equal(leaflet.traffic,undefined);assert.match(leaflet.notes,/不构成平台.*专门许可/);assert.match(leaflet.notes,/当前保持停用/);
  assert.equal(CHANNELS.find(c=>c.id==='ghost-pro')?.free,'paid');
});

test('Leaflet review sources use fetchable pinned GitHub HTML pages',()=>{
  const leaflet=CHANNELS.find(c=>c.id==='leaflet')!;
  assert.deepEqual(leaflet.evidenceSources?.slice(0,2).map(source=>new URL(source.url).hostname),['github.com','github.com']);
  for(const source of leaflet.evidenceSources?.slice(0,2)??[]){assert.match(source.url,/\/blob\/a583a135338740205e38e003d9213533f742edb6\//);assert.doesNotMatch(source.url,/raw\.githubusercontent\.com/)}
});
test('prohibited AI authorship and unverified financial permissions remain excluded',()=>{
  const s=site('finance');s.qualifications={publication:'https://example.com/about'};
  const matched=matchChannels(s,CHANNELS).map(m=>m.channel.id);
  for(const id of ['publish0x','pinterest']){const c=CHANNELS.find(c=>c.id===id)!;assert.equal(c.enabled,false);assert.equal(c.automation,'manual');assert(!matched.includes(id))}
  assert.match(CHANNELS.find(c=>c.id==='publish0x')!.notes,/禁止 AI 写稿/);
  assert.match(CHANNELS.find(c=>c.id==='pinterest')!.notes,/预批准/);
});

test('hosted publication results use their public article host rather than the vendor marketing domain',()=>{
 const c=CHANNELS.find(c=>c.id==='ghost-pro')!;assert.equal(c.domain,'ghost.io');
 const result=new URL('https://journal.ghost.io/checklist/');assert(result.hostname.endsWith('.'+c.domain));
 assert(c.allowedHosts.includes(new URL(c.submitUrl).hostname));
});


test('wallet candidates are not automatic and partial documentation is labelled honestly',()=>{
  for(const id of ['sigle','nuance']){const c=CHANNELS.find(item=>item.id===id)!;assert(c);assert.equal(c.automation,'manual');assert.equal(c.evidenceStatus,'source_checked');assert(c.evidenceSources?.every(source=>source.kind==='product_guidance'));assert(c.categories.includes('finance'));assert.equal(c.authority,undefined);assert.equal(c.traffic,undefined);}
  assert.match(CHANNELS.find(c=>c.id==='paragraph')!.notes,/Mirror.*同一来源/);
  assert.match(CHANNELS.find(c=>c.id==='hive')!.notes,/PeakD.*Ecency.*一个来源/);
  assert.equal(CHANNELS.some(c=>['mirror','peakd','ecency'].includes(c.id)),false);
  const c=CHANNELS.find(c=>c.id==='betterthanhtml')!;assert.equal(c.accountRequired,false);assert.equal(c.emailRequired,false);assert.equal(c.free,'yes');assert.equal(c.evidenceStatus,'source_checked');assert.match(c.notes,/不承诺发布后可撤回/);
});
