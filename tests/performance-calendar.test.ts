import assert from 'node:assert/strict';
import test from 'node:test';
import {dateKey,monthKey} from '../src/main/planner';
import {nextNaturalMonthStart,publicationCounts} from '../src/shared/publication';
import type {Task} from '../src/shared/types';

test('calendar reuse follows changing dates and zones at month, year and DST boundaries',()=>{
  const cases=[
    ['2026-09-30T16:00:00Z','Asia/Singapore','2026-10-01'],
    ['2026-09-30T15:59:59Z','Asia/Singapore','2026-09-30'],
    ['2026-09-30T16:00:00Z','UTC','2026-09-30'],
    ['2026-12-31T10:00:00Z','Pacific/Kiritimati','2027-01-01'],
    ['2026-03-08T06:59:59Z','America/New_York','2026-03-08'],
    ['2026-03-08T07:00:00Z','America/New_York','2026-03-08'],
    ['2026-11-01T05:59:59Z','America/New_York','2026-11-01'],
    ['2026-11-01T06:00:00Z','America/New_York','2026-11-01'],
    ['2026-09-30T16:00:00Z','Asia/Singapore','2026-10-01'],
  ];
  for(let repeat=0;repeat<3;repeat++)for(const [at,zone,expected] of cases){
    assert.equal(dateKey(at,zone),expected);
    assert.equal(monthKey(at,zone),expected.slice(0,7));
  }
});

test('next natural month uses that month’s offset after formatter reuse',()=>{
  const cases=[
    ['2026-03-01T12:00:00Z','America/New_York','2026-04-01T04:00:00.000Z'],
    ['2026-10-15T12:00:00Z','America/New_York','2026-11-01T04:00:00.000Z'],
    ['2026-11-15T12:00:00Z','America/New_York','2026-12-01T05:00:00.000Z'],
    ['2026-03-15T12:00:00Z','Australia/Sydney','2026-03-31T13:00:00.000Z'],
    ['2026-04-15T12:00:00Z','Australia/Sydney','2026-04-30T14:00:00.000Z'],
    ['2026-12-31T12:00:00Z','UTC','2027-01-01T00:00:00.000Z'],
    ['2026-03-01T12:00:00Z','America/New_York','2026-04-01T04:00:00.000Z'],
  ];
  for(const [at,zone,expected] of cases)assert.equal(nextNaturalMonthStart(new Date(at),zone).toISOString(),expected);
});

test('invalid calendar input is still rejected and cannot poison subsequent results',()=>{
  assert.equal(dateKey('2026-10-01T00:00:00Z','UTC'),'2026-10-01');
  assert.throws(()=>dateKey('2026-10-01T00:00:00Z','Not/A_Zone'),RangeError);
  assert.throws(()=>dateKey('not-a-date','UTC'),RangeError);
  assert.throws(()=>nextNaturalMonthStart(new Date('2026-10-01T00:00:00Z'),'Not/A_Zone'),RangeError);
  assert.throws(()=>nextNaturalMonthStart(new Date(NaN),'UTC'),RangeError);
  assert.equal(dateKey('2026-10-31T16:00:00Z','Asia/Singapore'),'2026-11-01');
  assert.equal(nextNaturalMonthStart(new Date('2026-10-01T00:00:00Z'),'UTC').toISOString(),'2026-11-01T00:00:00.000Z');
});

test('monthly publication counts respond to both current time and changed timezone',()=>{
  const at='2026-09-30T16:30:00.000Z';
  const task={id:'calendar-fixture',siteId:'site',channelId:'example',sourceDomain:'source.example.test',publicUrl:'https://source.example.test/article',status:'live',health:'healthy',linkCheck:'found',firstLiveAt:at,updatedAt:at,createdAt:at,scheduledAt:at,attempts:1} as Task;
  assert.equal(publicationCounts('site',[task],new Date('2026-10-01T01:00:00Z'),'Asia/Singapore').monthlyPages,1);
  assert.equal(publicationCounts('site',[task],new Date('2026-10-01T01:00:00Z'),'UTC').monthlyPages,0);
  assert.equal(publicationCounts('site',[task],new Date('2026-09-30T23:00:00Z'),'UTC').monthlyPages,1);
  assert.equal(publicationCounts('site',[task],new Date('2026-11-01T01:00:00Z'),'Asia/Singapore').monthlyPages,0);
});
