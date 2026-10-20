import test from 'node:test';
import assert from 'node:assert/strict';
import {processLeakSentence} from '../src/main/article-evidence';

test('sentences that expose how the article was written are found and named',()=>{
  for(const sentence of ['本文依据所提供的公开资料整理。','提供的材料提到 Terra 曾筹备新的稳定币池。','根据提供的规则说明：','选题页中的费率属于页面所载信息。','我作为推广内容发布者，为所链接网站制作本稿。','由于提供的材料不含平台原始条款，具体以官方为准。','上述资料中没有给出换算规则。','According to the provided materials, fees vary.','The evidence snapshot does not list a date.'])
    assert.equal(processLeakSentence(`第一段正常。\n${sentence}\n结尾。`),sentence.normalize('NFKC').trim(),sentence);
});

test('ordinary writing about sources and platforms is not a leak',()=>{
  for(const text of ['交易所提供的资料以官网为准。','币安帮助页说明，受影响的交易者会立即收到通知。','平台所提供的服务可能随地区变化。','Binance provides a fee schedule on its website.','官方资料没有说明到账时间，建议提交前确认。','The help page provides material examples.'])
    assert.equal(processLeakSentence(text),undefined,text);
});
