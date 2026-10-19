import test from 'node:test';
import assert from 'node:assert/strict';
import {containsReferralInformation,siteReferralCodes,strictSiteCodes,stripReferralDetailed} from '../src/shared/referral-policy';
import {hasPricePrediction} from '../src/main/article-evidence';
import {analyzeWebsiteHtml,publishedArticleRegion} from '../src/integrations/web';

import {copyButtonCode} from '../src/shared/referral-policy';
test('site code harvest only takes a code that directly follows its label', () => {
  assert.deepEqual(strictSiteCodes('注册时填写邀请码，完成 KYC 后充值 USDT（TRC20 网络），即可开始交易。用邀请码注册的账户默认是 VIP0 等级。'), []);
  assert.deepEqual(strictSiteCodes('使用邀请码注册后手续费减免 20%，按月交易 10000 USDT 计算。'), []);
  for (const page of ['邀请码\n  XQ7731', '邀请码：XQ7731 Copy', 'Our referral code for Binance users is XQ7731', 'Use this referral code when you sign up: XQ7731']) {
    assert.deepEqual(strictSiteCodes(page), ['XQ7731'], page);
  }
  // A wrongly harvested word would delete every sentence that mentions it.
  const codes = siteReferralCodes({description: '注册时填写邀请码，完成 KYC 后充值 USDT（TRC20 网络）', url: 'https://example.com/'});
  assert.equal(containsReferralInformation('充值时请选择 TRC20 网络。', codes), false);
  // Stored codes stay within the backup field bound.
  assert.deepEqual(siteReferralCodes({description: '', url: 'https://example.com/', referralCodes: ['ZK4402', 'X'.repeat(40)]}), ['ZK4402']);
});

test('drafts naming a code after a label are blocked whatever the code looks like', () => {
  for (const sentence of ['推荐代码：XQ7731', '邀请码：okxvip', '邀请码：Superman', '邀请码: 8888', 'invite code: abcde', 'Referral code: cryptofan', 'https://www.okx.com/join?code=12345']) {
    assert.equal(containsReferralInformation(sentence), true, sentence);
  }
  assert.equal(containsReferralInformation('Sign up with cryptofan today.', ['cryptofan']), true);
  const stripped = stripReferralDetailed('这是一段说明。注册时填写邀请码：okxvip。其余内容保留。', [], 'www.example.com');
  assert.equal(stripped.blocked, false);
  assert.equal(stripped.text.includes('okxvip'), false);
  assert.equal(stripped.text.includes('其余内容保留'), true);
});

test('price prediction means a forward-looking asset price, not fees, limits, examples or history', () => {
  for (const sentence of [
    '完成 VIP1 后，现货 Maker 费率将降至 0.09%。', '开通 BNB 抵扣后，手续费会降至 0.075%。', '保证金率可能降至 50% 以下时，系统会触发强平。',
    '单笔提现 USDT 最低需达到 10 USDT。', '比特币在 2024 年 3 月达到 73000 美元的历史高点。', '限价单示例：设置价格为 60000 USDT 买入 0.01 BTC。',
    '止盈价格到 65000 时自动卖出。', 'KYC 审核预计达到 3 个工作日', 'Withdrawal limits will rise to 100 BTC after KYC level 2.',
  ]) assert.equal(hasPricePrediction(sentence), false, sentence);
  for (const sentence of ['BTC 有望涨到 10 万美元。', '比特币年底看 15 万。', '比特币价格将突破 100000 美元。', 'ETH could reach $5,000 this year.', '目标价 120000。']) {
    assert.equal(hasPricePrediction(sentence), true, sentence);
  }
});

test('a published page is scanned only in the article, not the platform chrome or comments', () => {
  const page = `<html><body><header><a href="/signup?ref=nav">Sign up</a></header><article><h1>Fees</h1><p>See <a href="https://example.com/guide">the guide</a>.</p></article><footer><a href="https://wordpress.com/?ref=footer_blog">Blog at WordPress.com</a></footer><div class="comments">邀请码：ZZ9999</div></body></html>`;
  const scan = (html: string) => {
    const region = publishedArticleRegion(html, 'https://blog.wordpress.com/post', 'https://example.com/');
    return containsReferralInformation(region.articleText, [], 'example.com') || containsReferralInformation(region.articleHtml, [], 'example.com');
  };
  assert.equal(scan(page), false);
  assert.equal(scan(page.replace('<p>See', '<p>邀请码：XQ7731。See')), true);
});

test('a letters-only site code matches only its exact spelling and never an exchange name', () => {
  assert.deepEqual(strictSiteCodes('邀请码：Binance'), []);
  assert.equal(containsReferralInformation('Use the cryptofan code.', ['cryptofan']), true);
  assert.equal(containsReferralInformation('Crypto fans often ask about Cryptofan forums.', ['cryptofan']), false);
  assert.equal(containsReferralInformation('Register with xq7731 today.', ['XQ7731']), true);
});

test('brand names, form words and dates after a label are never taken as the site\'s code', () => {
  for (const page of ['CoinEx 邀请码是 CoinEx 推荐计划的一部分', 'LBank 邀请码：LBank 新用户注册时填写', 'Bitunix 邀请码：Bitunix 新用户手续费减免指南', 'WEEX 邀请码：WEEX 注册教程',
    '邀请码是 Pionex/Bitunix 为老用户生成', '邀请码是 Web3 交易所常见的推荐方式', 'Referral code: optional', '邀请码：Optional', '邀请码：Referral ID 一栏填写', '邀请码：2025-10-01 更新', '使用邀请码注册后可开 100x 杠杆']) {
    assert.deepEqual(strictSiteCodes(page), [], page);
  }
  // A brand-shaped stored code that is the site's own subject is dropped instead of blocking every task.
  assert.deepEqual(siteReferralCodes({name: 'Bitunix 指南', domain: 'bitunixguide.com', url: 'https://bitunixguide.com/', description: '', referralCodes: ['Bitunix', 'XQ7731']}), ['XQ7731']);
});

test('the code that follows an ordinary word, an exchange name or a short note is still collected', () => {
  const cases: Array<[string, string[]]> = [
    ['Step 3. Referral code: enter XQ7731', ['XQ7731']], ['交易所 邀请码 币安 XQ7731 OKX ZK4402', ['XQ7731', 'ZK4402']], ['邀请码（币安）：XQ7731', ['XQ7731']],
    ['邀请码：币安 XQ7731，OKX ZK4402', ['XQ7731', 'ZK4402']], ['Referral codes: Binance XQ7731, OKX ZK4402', ['XQ7731', 'ZK4402']], ['推介码 XQ3386', ['XQ3386']],
    ['本站邀请码：币安（Binance）填 XQB5520', ['XQB5520']], ['邀请码备忘： XQ90417', ['XQ90417']], ['邀请码：XQ7731Copy', ['XQ7731']], ['邀请码：okxvip', ['okxvip']],
    ['código de invitación: BN2201', ['BN2201']],
  ];
  for (const [page, codes] of cases) assert.deepEqual(strictSiteCodes(page), codes, page);
  const home = analyzeWebsiteHtml('<html><body><p>OKX 邀请码</p><span class="code">ZK9015</span><button data-copy="ZK9015">复制</button><label>Referral code:</label><input value="XQ7731" readonly><button>Copy</button></body></html>', 'https://example.com/');
  assert.deepEqual(home.referralCodes, ['ZK9015']);
});

test('a chosen VIP-style code is a code; one- and two-digit levels are not', () => {
  for (const sentence of ['邀请码：VIP888', 'Referral code: VIP2024', '注册时填写邀请码 VIP888 可享减免']) assert.equal(containsReferralInformation(sentence), true, sentence);
  assert.equal(containsReferralInformation('Use code VIP888 at signup.', ['VIP888']), true);
  for (const sentence of ['用邀请码注册的账户默认是 VIP0 等级。', '完成 VIP1 后费率降至 0.09%']) assert.equal(containsReferralInformation(sentence), false, sentence);
  assert.deepEqual(strictSiteCodes('邀请码：VIP888'), ['VIP888']);
});

test('transfer times, gas, leverage and past months are not price predictions; dated or "hit" forecasts are', () => {
  const now = new Date('2026-10-19T00:00:00.000Z');
  for (const sentence of ['BTC 提币预计 30 分钟到账。', 'ETH 充币预计 12 个区块确认后到账。', '以太坊转账预计 1-5 分钟完成。', '以太坊 Gas 费将降至 1 gwei 以下。', 'SOL 链上转账可能 1 秒内完成。',
    'BTC 永续合约杠杆将升至 125 倍。', '行情数据会 5 秒刷新一次。', 'The third Bitcoin halving in May 2020 cut the block reward.', 'BTC price on May 19, 2021 dropped sharply.', '以太坊预计 12 秒出一个块',
    'Bitcoin crashed in May 2021', 'Bitcoin was expected to reach $100,000 in 2021.', 'The BTC withdrawal fee will drop to 0.0002 BTC.']) assert.equal(hasPricePrediction(sentence, now), false, sentence);
  for (const sentence of ['Bitcoin price will reach $200,000 in 2027.', '预计 2027 年比特币价格将突破 20 万美元。', 'As institutional interest grows, Bitcoin price will reach $150,000.',
    '比特币价格将突破 10 万美元，手续费也会随之上涨。', 'Bitcoin price could hit $150,000 by year-end.', 'BTC price is expected to hit $120,000.', 'Bitcoin was volatile, but the price will reach $150,000.']) assert.equal(hasPricePrediction(sentence, now), true, sentence);
});

test('amounts, form steps and tickers are not codes; a code after a bracketed note or before a later step still is', () => {
  for (const page of ['使用邀请码注册即可领取 100USDT 奖励', '邀请码：Step1 打开注册页', '邀请码：2025Q4 活动', '邀请码 BTCUSDT 行情', '使用邀请码注册后可开 x100 杠杆']) assert.deepEqual(strictSiteCodes(page), [], page);
  assert.deepEqual(strictSiteCodes('推荐码：abcdef，完成 KYC2 认证'), ['abcdef']);
  assert.deepEqual(strictSiteCodes('邀请码（OKX）：30589422'), ['30589422']);
  assert.equal(containsReferralInformation('https://www.pionex.com/join/ABCD1234'), true);
});

test('forecasts with years, multiples, implied subjects or a later clause are caught; supply, hashrate, questions and risk warnings are not', () => {
  const now = new Date('2026-10-19T00:00:00.000Z');
  for (const sentence of ['以太坊预计年底将回到 2000 美元。', 'BNB will rise to $1950.', '比特币有望涨 10 倍。', 'ETH could rise 10x.', 'ETH 提币速度更快，价格有望涨到 5000 美元。', '比特币去年曾跌到 1.6 万美元，今年有望涨到 15 万美元。'])
    assert.equal(hasPricePrediction(sentence, now), true, sentence);
  for (const sentence of ['比特币总量最终将达到 2100 万枚。', 'BTC hashrate will exceed 1,000 EH/s.', '比特币会涨到 10 万美元吗？', '价格可能下跌 50%，请注意风险。', '手续费有望降至 10 美元以内。'])
    assert.equal(hasPricePrediction(sentence, now), false, sentence);
});

test('price forecasts: tag questions, local currencies, dated and hedged wording and doubling count; rewards, volume, balances, drawdowns and product limits do not',()=>{
  const now=new Date('2026-10-19');
  const yes=['比特币今年有望突破 20 万美元，你上车了吗？','比特币将突破 20 万美元，不是吗？','以太坊有望涨到 1 万美元，还不入场吗？','Bitcoin will hit $200,000 this year, are you ready?','BTC is expected to reach $150,000 — will you miss it?','比特币将突破 20 万美元（真的吗？）。',
'以太坊有望涨到 5000U。','ETH 将突破 5000 U。','比特币将涨到 150000U。','比特币价格有望突破 100 万人民币。','以太坊将涨到 30000 人民币。','比特币将突破 300 万台币。','ETH will hit 5000 bucks.',
'比特币将在 2027 年突破 20 万美元。','比特币有望在年底前突破 20 万美元。','比特币价格将于明年突破 20 万美元。','以太坊将在下一轮牛市涨到 1 万美元。','比特币有望在减半后涨到 20 万美元。','BTC will likely reach $150,000.','Bitcoin may soon hit $150,000.','Bitcoin will eventually reach $1,000,000.','Analysts expect Bitcoin to reach $150,000.','Bitcoin price could reach US$150,000.','Bitcoin will reach 1 million dollars.','比特币价格有望翻倍。','ETH is expected to double.',
'比特币 2024 年减半后，2027 年有望突破 20 万美元。','比特币在 2025 年一度跌到 7 万美元，2027 年将突破 20 万美元。',
'比特币有望涨 10 倍。','ETH could rise 10x.','以太坊预计年底将回到 2000 美元。','BNB will rise to $1950.','ETH 提币速度更快，价格有望涨到 5000 美元。','比特币去年曾跌到 1.6 万美元，今年有望涨到 15 万美元。','比特币价格有望上涨 20%。','目标价 20 万美元'];
  const no=['活动奖池有望突破 100 万美元。','本期活动总奖池将升至 50 万 USDT。','完成全部任务后，新用户奖励将升至 100 USDT。','邀请好友越多，奖励有望突破 1000 USDT。','平台日交易量将突破 100 亿美元。','Daily trading volume will hit $10 billion.','The prize pool will reach $1,000,000.','Your Earn balance will reach 1,000 USDT after 30 days.','若持续定投，账户余额会涨到 1000 USDT。','用户保护基金将升至 10 亿美元。',
'加密资产价格跌幅可能达到 50%。','比特币价格回撤可能达到 80%，请控制仓位。','币价单日跌幅可能达到 30%。','The price drop could reach 50% in a bear market.','Price swings could hit 20% in a single day.','杠杆交易中，BTC 价格反向波动可能达到 10%，导致爆仓。','在 BTC/USDT 交易页面会看到 0.1% 的 Maker 费率。','BTC 永续合约最高将达到 125 倍杠杆。','BTC perpetuals will reach 125x leverage.','ETH 质押 APR 将升至 4%。','BTC 理财 APY 将达到 5%。','Bitcoin dominance could reach 60%.',
'比特币总量最终将达到 2100 万枚。','BTC hashrate will exceed 1,000 EH/s.','价格可能下跌 50%','比特币会涨到 10 万美元吗？','比特币 2021 年曾涨到 6.9 万美元。','提现通常会在 30 分钟内到账。','注册后有望获得 20% 手续费减免。','Will Bitcoin hit $100,000 this year?'];
  for(const sentence of yes)assert.equal(hasPricePrediction(sentence,now),true,sentence);
  for(const sentence of no)assert.equal(hasPricePrediction(sentence,now),false,sentence);
});

test('site codes: a bracketed code after the label, a row of codes and two-capital codes are kept; form words, tickers and nav labels are not',()=>{
  const cases:[string,string[]][]=[
['邀请码：mexc-1UoHL',['mexc-1UoHL']],['Referral code: ABC-123',['ABC-123']],['邀请码：QX-5207。',['QX-5207']],['推荐码为 cpa-00abc',['cpa-00abc']],
['邀请码(选填) 30589422',['30589422']],['邀请码（OKX） 30589422',['30589422']],['邀请码： okxvip 复制',['okxvip']],
['邀请码 ABCD12 复制',['ABCD12']],['邀请码 BGVIP88 复制',['BGVIP88']],['邀请码 币安 KXQDM12 OKX 30589422',['KXQDM12','30589422']],['邀请码 52ABCD 复制',['52ABCD']],['邀请码 cryptofan88',['cryptofan88']],['邀请码 123abc',['123abc']],['注册时填写邀请码（ABCD12）即可',['ABCD12']],
['使用邀请码注册，完成任务可领取 50OP 空投',[]],
['注册时填写邀请码（XQ7731）即可享受 20% 手续费减免。',['XQ7731']],['Sign up with referral code (XQ7731) for 20% off trading fees.',['XQ7731']],['邀请码（币安 XQ7731）',['XQ7731']],['推荐码（ZK4402），注册时填写',['ZK4402']],
['邀请码（OKX）：30589422',['30589422']],['Referral code (if any): leave blank if you do not have one',[]],['Referral code: Bonus, use XQ7731 at signup',['XQ7731']],['Referral code: welcome, use XQ7731 at signup',['XQ7731']],
['邀请码：okxvip',['okxvip']],['邀请码 币安 8888AB OKX 6008OK',['8888AB','6008OK']],['使用邀请码注册即可领取 100USDT 奖励',[]],['推荐码：abcdef，完成 KYC2 认证',['abcdef']],
['首页 邀请码 Season2 活动 ETH2 升级',[]],['邀请码大全 合约教程 1000PEPE 合约',[]],['邀请码 币安 XQ7731 OKX ZK4402',['XQ7731','ZK4402']],['邀请码：Season2',['Season2']]];
  for(const [text,want] of cases)assert.deepEqual(strictSiteCodes(text),want,text);
  for(const [value,want] of [['8888AB','8888AB'],['6008OK','6008OK'],['123456Ab','123456Ab'],['100USDT',undefined],['24h',undefined]] as const)assert.equal(copyButtonCode(value),want,value);
  const html=(body:string)=>analyzeWebsiteHtml(`<html><head><title>x</title></head><body>${body}</body></html>`,'https://example.com/').referralCodes;
  assert.deepEqual(html('<nav><a>首页</a><a href=/invite/>邀请码</a><a>合约教程</a><a>1000PEPE 合约</a></nav>'),[]);
  assert.deepEqual(html('<table><tr><th>邀请码</th></tr><tr><td>8888AB</td><td>6008OK</td></tr></table>'),['8888AB','6008OK']);
  assert.deepEqual(html('<span>邀请码</span><code>QX5207</code><button>复制</button><nav><a>16GB 显卡挖矿</a><a>10AM 活动</a></nav>'),['QX5207']);
  assert.deepEqual(html('<p>邀请码：<strong>okxvip</strong> <button>复制</button></p>'),['okxvip']);
  // A hyphenated code never breaks site analysis.
  assert.deepEqual(html('<p>邀请码：mexc-1UoHL</p>'),['mexc-1UoHL']);
});

test('price forecasts: bracketed coin names, multiples after any rise verb and scene-setting words still count; triggers, two-way risk, either-or questions and rewards do not',()=>{
  const now=new Date('2026-10-19');
  const yes2=['以太坊（ETH）有望上涨 30%。','比特币（BTC）预计将涨到 15 万美元。','Ethereum (ETH) will hit $10,000.','Bitcoin (BTC) is expected to rise 40%.','比特币（BTC）明年有望翻倍。','Analysts expect Bitcoin (BTC) to reach $150,000.',
'比特币有望涨到 10 倍。','以太坊有望涨至 3 倍。','SOL 有望冲到 5 倍。','BTC will hit 10x.','ETH could climb to 3x.','Bitcoin could reach 10x from here.',
'比特币价格随着 ETF 规模扩大有望突破 20 万美元。','比特币价格在大幅波动后有望站上 15 万美元。','比特币价格在基金增持下有望突破 20 万美元。','比特币在机构融资推动下有望突破 20 万美元。','Bitcoin will hit $200,000 whether you like it or not.'];
  const no2=['止盈单会在价格涨到 70000 USDT 时自动成交。','网格会在价格突破 70000 USDT 后停止运行。','条件单将在 BTC 涨至 70000 USDT 时触发。','系统会在 BTC 涨到 70000 美元时提醒你。','BTC 价格提醒会在价格上涨 5% 时推送。','计划委托会在 ETH 涨到 4000 USDT 时下单。','比特币价格可能在一天内上涨 20%，也可能下跌 20%。',
'Bitcoin prices may experience double-digit drops in a single day.','BTC price could see double-digit swings.','When withdrawing BTC you will double-check the address.','Bitcoin prices may have doubled since you bought.','比特币持有人数有望翻倍。','BTC 合约持仓将翻倍。','Bitcoin adoption could double by 2030.','数字资产价格可能在短期内翻倍，也可能腰斩。','Digital asset prices may double or halve.',
'比特币明年会涨到 20 万美元，还是会跌回 3 万美元？','BTC 是会涨到 20 万美元，还是会跌到 3 万美元？','比特币价格将突破 20 万美元，还是回落到 5 万美元？','Do you think BTC will reach $150,000, or is it hype?',
'币安新用户注册指南。本文介绍如何在币安购买 BTC。第一步，打开 App。第二步，完成认证。第三步，充值。完成全部新手任务后，体验金将升至 100U。','BTC 手续费说明。邀请好友越多，赠金上限将升至 500U。','BTC 永续合约最高将达到 125 倍杠杆。'];
  for(const sentence of yes2)assert.equal(hasPricePrediction(sentence,now),true,sentence);
  for(const sentence of no2)assert.equal(hasPricePrediction(sentence,now),false,sentence);
  // Long bodies stay fast.
  const started=Date.now();hasPricePrediction('比特币是一种数字资产，价格波动较大。'.repeat(3000),now);assert.ok(Date.now()-started<1000);
});
