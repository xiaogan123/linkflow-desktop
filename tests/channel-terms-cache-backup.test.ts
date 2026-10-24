import test from 'node:test';
import assert from 'node:assert/strict';
import {buildChannelTermsCache,reviewedChannelTermsCache} from '../src/main/article-evidence';
import {validateBackup} from '../src/main/backup-validation';
import {emptyState} from '../src/main/store';

const channel={id:'shiply'};
const at=new Date('2026-10-22T00:00:00.000Z');
const source={url:'https://publisher.example/terms',kind:'content_policy' as const,text:'Original software documentation is permitted. '.repeat(500),appliesTo:channel.id,applicability:'verified' as const};

test('collected evidence can be cached and exported without transient collector fields',()=>{
  const evidence={...source,excerpt:'A short display excerpt.',sourceCharacters:source.text.length,truncated:false};
  const pending=buildChannelTermsCache(channel,[evidence],undefined,at);
  const state=emptyState();state.channelTermsCache={[channel.id]:pending};
  const restored=validateBackup({state,secrets:{}});
  assert.deepEqual(restored.state.channelTermsCache?.[channel.id],pending);
  assert.equal(pending.sources[0].text,source.text);
  assert.equal(pending.sourceHash,buildChannelTermsCache(channel,[source],undefined,at).sourceHash);
  assert.equal(evidence.excerpt,'A short display excerpt.');
  evidence.text='Changed after collection';
  assert.equal(pending.sources[0].text,source.text);
});

test('reusing a legacy cache removes collector fields without invalidating its policy conclusion',()=>{
  const clean=reviewedChannelTermsCache(buildChannelTermsCache(channel,[source],undefined,at),{finance:'unknown',promotion:'allowed',disclosurePlacement:'end'},at);
  const legacy={...clean,sources:[{...source,excerpt:'Legacy transient display text.'}]};
  const state=emptyState();state.channelTermsCache={[channel.id]:legacy};
  assert.throws(()=>validateBackup({state,secrets:{}}));
  const reused=buildChannelTermsCache(channel,[source],legacy,at);
  state.channelTermsCache[channel.id]=reused;
  assert.deepEqual(validateBackup({state,secrets:{}}).state.channelTermsCache?.[channel.id],clean);
  assert.equal(reused.conclusionHash,legacy.conclusionHash);
  assert.equal(reused.sourceHash,legacy.sourceHash);
  assert.equal(reused.reviewVersion,legacy.reviewVersion);
  assert.equal(buildChannelTermsCache(channel,[source],clean,at),clean);
});
