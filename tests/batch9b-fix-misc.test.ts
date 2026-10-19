import test from 'node:test';
import assert from 'node:assert/strict';
import {managedPublicationSite} from '../src/main/draft-contract';
import {buildChannelTermsCache, reviewedChannelTermsCache, validChannelTermsCache} from '../src/main/article-evidence';
import {analysisFillableFields, applySiteAnalysis} from '../src/shared/batch9b-policy';
import {applySiteUpdate} from '../src/main/site-service';
import type {Site, Task} from '../src/shared/types';

const site = {id: 's', domain: 'example.com', url: 'https://example.com', name: 'Example', description: '', category: 'finance', language: 'zh', status: 'ready', monthlyTarget: 1, createdAt: '2026-10-19T00:00:00.000Z', email: 'owner@example.com'} as Site;

test('a home-page target with or without a trailing slash is the same target', () => {
  const task = {channelId: 'telegraph', writingEnvelope: {targetUrl: 'https://example.com/'}} as unknown as Task;
  assert.equal(managedPublicationSite(site, task).url, 'https://example.com/');
  assert.throws(() => managedPublicationSite(site, {...task, writingEnvelope: {targetUrl: 'https://other.example/'}} as unknown as Task));
  // A sitemap topic on the "www." host the home page redirects to is still this site's page.
  const topic = {channelId: 'telegraph', topicUrl: 'https://www.example.com/guide', writingEnvelope: {targetUrl: 'https://www.example.com/guide'}} as unknown as Task;
  assert.equal(managedPublicationSite(site, topic).url, 'https://www.example.com/guide');
  assert.throws(() => managedPublicationSite(site, {...topic, topicUrl: 'https://www.other.example/guide', writingEnvelope: {targetUrl: 'https://www.other.example/guide'}} as unknown as Task));
  // An analysis that only adds the slash adopts the canonical form instead of proposing a new URL.
  const analysed = {...site};
  applySiteAnalysis(analysed, {url: 'https://example.com/'});
  assert.equal(analysed.url, 'https://example.com/');
  assert.equal(analysed.analysisProposal, undefined);
});

test('a terms conclusion survives changes to pages it was not read from', () => {
  const policy = {url: 'https://p.example/rules', kind: 'rules' as const, text: 'No gambling content. Finance is allowed with disclosure.', appliesTo: 'fixture', applicability: 'verified' as const};
  const api = {url: 'https://p.example/api', kind: 'api' as const, text: 'POST /pages creates a page.', appliesTo: 'fixture', applicability: 'verified' as const};
  const first = reviewedChannelTermsCache(buildChannelTermsCache({id: 'fixture'}, [policy, api]), {finance: 'allowed', promotion: 'allowed', disclosurePlacement: 'start'});
  const apiChanged = buildChannelTermsCache({id: 'fixture'}, [policy, {...api, text: 'POST /v2/pages creates a page.'}], first);
  assert.equal(apiChanged.reviewVersion, 2);
  assert.equal(apiChanged.conclusionHash, first.conclusionHash);
  assert.equal(validChannelTermsCache(apiChanged), true);
  const policyChanged = buildChannelTermsCache({id: 'fixture'}, [{...policy, text: 'No finance content of any kind.'}, api], first);
  assert.equal(policyChanged.reviewVersion, undefined);
  // A platform with only guidance reads its conclusion from the guidance, so a guidance change re-reviews.
  const guidanceOnly = reviewedChannelTermsCache(buildChannelTermsCache({id: 'fixture'}, [api]), {finance: 'unknown', promotion: 'unknown', disclosurePlacement: 'unknown'});
  assert.equal(buildChannelTermsCache({id: 'fixture'}, [{...api, text: 'Commercial use is not allowed.'}], guidanceOnly).reviewVersion, undefined);
});

test('a re-analysis only has fields to fill when they are empty', () => {
  assert.deepEqual(analysisFillableFields({...site, name: 'Example', description: 'A finance guide.'}), []);
  assert.deepEqual(analysisFillableFields({...site, description: ''}), ['description']);
});

test('fields the page heuristic guessed stay correctable by a later AI analysis, never the owner\'s own edits', () => {
  const guessed = {...site, name: 'example.com', description: 'Example', category: 'general' as const, language: 'en', analyzedAt: '2026-10-18T00:00:00.000Z', status: 'ready' as const};
  // Filled values the heuristic never touched are not reopened.
  applySiteAnalysis(guessed, {name: 'Example Home', description: 'Page text', category: 'general', language: 'en'}, new Date(), false);
  assert.equal(guessed.heuristicFields, undefined);
  assert.equal(guessed.name, 'example.com');
  // A site whose first analysis fell back to the page heuristic keeps those fields open for the AI.
  const fallback = {...site, name: site.domain, description: '', category: 'general' as const, language: 'en', analyzedAt: undefined, status: 'analyzing' as const};
  applySiteAnalysis(fallback, {name: 'Example Home', description: 'Page text', category: 'general', language: 'und'}, new Date(), false);
  assert.deepEqual([...fallback.heuristicFields!].sort(), ['category', 'description', 'language', 'name']);
  assert.deepEqual(analysisFillableFields(fallback).sort(), ['category', 'description', 'language', 'name']);
  applySiteAnalysis(fallback, {name: 'Example Finance', description: 'A finance guide.', category: 'finance', language: 'zh-CN'}, new Date(), true);
  assert.equal(fallback.category, 'finance');
  assert.equal(fallback.heuristicFields, undefined);
  assert.deepEqual(analysisFillableFields(fallback), []);
  // The owner's own edit closes a guessed field even before any AI analysis.
  const state = {sites: [{...site, heuristicFields: ['category', 'name'] as Site['heuristicFields']}], tasks: [], mailboxes: [], settings: {articleReviewMode: 'ai'}} as unknown as Parameters<typeof applySiteUpdate>[0];
  // The edit form always sends every field; an unchanged value stays a guess.
  applySiteUpdate(state, {id: site.id, name: site.name, category: 'general'});
  assert.deepEqual(state.sites[0].heuristicFields, ['name']);
});
