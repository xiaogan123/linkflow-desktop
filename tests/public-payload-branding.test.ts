import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {batch5DirectTesting} from '../src/integrations/batch5-direct';
import {agentHowPublicationRequest,agentHowRegistrationRequest} from '../src/integrations/agenthow';
import {agentriotRegistrationRequest,agentriotUpdateRequest} from '../src/integrations/agentriot';
import {agentsWikiDraftRequest,type AgentsWikiDraft} from '../src/integrations/agentswiki';
import {berrryPublicationRequest} from '../src/integrations/berrry';
import {betterThanHtmlTesting} from '../src/integrations/betterthanhtml';
import {blueskyTesting} from '../src/integrations/bluesky';
import {CHANNELS} from '../src/integrations/catalog';
import {COLONY_COMMUNITY,colonyPostRequest,colonyRegistrationRequest} from '../src/integrations/colony';
import {gistTesting} from '../src/integrations/gist';
import {hackMdTesting} from '../src/integrations/hackmd';
import {leafletTesting} from '../src/integrations/leaflet';
import {lucidTesting} from '../src/integrations/lucid';
import {mataroaTesting} from '../src/integrations/mataroa';
import {openAgentChatPageRequest,openAgentChatRegistrationRequest} from '../src/integrations/openagentchat';
import {paperTesting} from '../src/integrations/paper';
import {paragraphTesting} from '../src/integrations/paragraph';
import {pastyxRequest,pastyxSiteAuthor} from '../src/integrations/pastyx';
import {publicIdentitySlug} from '../src/integrations/public-identity';
import {renderShareYourHtmlArticle} from '../src/integrations/shareyourhtml-article';
import {createSwarmMemoCommand,generateSwarmMemoIdentity,SWARMMEMO_DISCLOSURE} from '../src/integrations/swarmmemo';
import {createSwarmMemoReviewedInput,swarmMemoTaskIdentity} from '../src/integrations/swarmmemo-publisher';
import {articleToTelegraphNodes} from '../src/integrations/telegraph';
import {txtsbsRequest,txtsbsSiteAuthor} from '../src/integrations/txtsbs';
import {whiteWindTesting} from '../src/integrations/whitewind';
import {wordpressTesting} from '../src/integrations/wordpress';
import {writeFreelyPostPayload} from '../src/integrations/writefreely-protocol';
import {decorateManagedDraft,profileDraftInstruction} from '../src/main/draft-contract';
import {DRAFT_CONTRACT_PUBLIC_MESSAGES} from '../src/main/draft-contract-messages';
import type {ExecutionContext,Site,Task} from '../src/shared/types';
import {ensureWritingProfile} from '../src/shared/writing-profile';

const TASK_ID='11111111-1111-4111-8111-111111111111';
const SITE_ID='22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID='33333333-3333-4333-8333-333333333333';
const AT='2026-10-18T00:00:00.000Z';
const TARGET='https://example.com/guides/reviewed-process';
const TITLE='A reproducible review process';
const BODY=[
  `A useful review records the source, date, and assumptions before drawing a conclusion. The [maintained process](${TARGET}) explains each step and gives readers enough context to repeat it on their own.`,
  'The reviewer then compares the result with the original evidence, records unresolved limits, and checks whether the source has changed. These steps help a reader understand the method without assuming a result or claiming personal use.',
].join('\n\n');
const SITE:Site={id:SITE_ID,domain:'example.com',url:'https://example.com/',email:'owner@example.com',name:'Example Research',description:'Independent research notes.',category:'content',language:'en',monthlyTarget:1,status:'ready',createdAt:AT};
const label=publicIdentitySlug(SITE,ACCOUNT_ID,40);

function articleTask(overrides:Partial<Task>={}):Task{return {id:TASK_ID,siteId:SITE_ID,channelId:'paragraph',sourceDomain:'paragraph.com',status:'running',createdAt:AT,scheduledAt:AT,updatedAt:AT,attempts:1,message:'fixture',topicUrl:TARGET,draft:{title:TITLE,description:'How to repeat a source review.',body:BODY},draftRevision:1,articleApprovedAt:AT,...overrides}}

// Every factory invokes a production renderer or request builder with neutral input.
// This checks the resulting public bytes, including software-added fields and wrappers.
const payloads:Array<{channel:string;build:()=>string}>=[
  {channel:'Paragraph',build:()=>JSON.stringify(paragraphTesting.approvedArticle(articleTask(),SITE,false))},
  {channel:'Paper.wf',build:()=>JSON.stringify(paperTesting.approvedArticle(articleTask(),SITE))},
  {channel:'Mataroa',build:()=>JSON.stringify(mataroaTesting.approvedArticle(articleTask(),SITE,false))},
  {channel:'Lucid',build:()=>JSON.stringify(lucidTesting.article(articleTask(),SITE.url,false))},
  {channel:'Better Than HTML',build:()=>betterThanHtmlTesting.article(articleTask(),SITE.url,false).html},
  {channel:'Leaflet',build:()=>JSON.stringify(leafletTesting.buildArticle(articleTask(),SITE.url,'did:plc:examplewriter1234567890','3mabcdefghi2j',AT).record)},
  {channel:'Bluesky',build:()=>JSON.stringify(blueskyTesting.approvedPost(articleTask({channelId:'bluesky',sourceDomain:'bsky.app',draft:{title:TITLE,description:'',body:`Record the assumptions and compare the original source with the latest evidence: ${TARGET}\n\nCommercial relationship disclosure: The operator may receive a commission, but this does not change the review method.`}}),SITE.url,AT,false).record)},
  {channel:'ShareYourHTML',build:()=>renderShareYourHtmlArticle({draft:articleTask().draft!,targetUrl:TARGET,language:'en',slug:publicIdentitySlug(SITE,TASK_ID,40)}).html},
  {channel:'AgentHow registration',build:()=>agentHowRegistrationRequest(label).body},
  {channel:'AgentHow publication',build:()=>agentHowPublicationRequest(TITLE,BODY,[{title:'Maintained process',url:TARGET}],`agenthow_note_${TASK_ID.replaceAll('-','')}`).body},
  {channel:'OpenAgentChat registration',build:()=>openAgentChatRegistrationRequest(label,'Example publishing assistant','An assistant operated for Example Research.').body},
  {channel:'OpenAgentChat page',build:()=>openAgentChatPageRequest(TITLE,BODY,`oac_page_${TASK_ID.replaceAll('-','')}`).body},
  {channel:'AgentRiot registration',build:()=>agentriotRegistrationRequest(`${label}:${ACCOUNT_ID}`,label,'Research update assistant','Publishes reviewed updates for Example Research.').body},
  {channel:'AgentRiot update',build:()=>agentriotUpdateRequest(label,{title:TITLE,summary:'A source review procedure.',whatChanged:'Documented the review steps and evidence limits.',signalType:'research',publicLink:TARGET}).body},
  {channel:'Colony registration',build:()=>colonyRegistrationRequest({username:label.replaceAll('-','_'),displayName:'Example publishing assistant'}).body},
  {channel:'Colony post',build:()=>colonyPostRequest({colony:COLONY_COMMUNITY,post_type:'analysis',title:TITLE,body:BODY,language:'en',tags:['engineering'],client:'site-publisher',bridge_to_nostr:false,confirm_duplicate:false},`colony_post_${TASK_ID.replaceAll('-','')}`).body},
  {channel:'Berrry app',build:()=>berrryPublicationRequest('brry_rw_00000000',label,TITLE,`<!doctype html><html><head><title>${TITLE}</title></head><body><main><p>Review the evidence.</p><a href="${TARGET}">Read the process</a></main></body></html>`).body},
  {channel:'txt.sbs form',build:()=>txtsbsRequest({title:TITLE,abstract:'A repeatable review method.',author:txtsbsSiteAuthor(SITE),content:`<p>Review the <a href="${TARGET}">maintained process</a> and record the evidence.</p>`,showDate:true,showSerp:true}).body},
  {channel:'PastyX JSON',build:()=>pastyxRequest({title:TITLE,author:pastyxSiteAuthor(SITE),content:BODY},'A'.repeat(43)).body},
];

const wikiDraft:AgentsWikiDraft={title:TITLE,summary:'A repeatable process for reviewing source claims.',language:'en',type:'methodology',tags:['review'],body:`## Procedure\n\nRead the [maintained process](${TARGET}) and compare the source with the claimed result.`,sources:[{title:'Maintained process',url:TARGET}],basis:'An original review procedure based on the cited public source.',attribution:['Prepared with AI assistance for the site operator.'],change_notice:'Original contribution',related:[],applies_to:['Source reviews'],content_as_of:AT};
payloads.push({channel:'Agents Wiki',build:()=>agentsWikiDraftRequest(wikiDraft,TARGET).body});
const connectedContext={site:SITE,task:articleTask()} as ExecutionContext;
payloads.push(
  {channel:'Telegraph nodes',build:()=>JSON.stringify(articleToTelegraphNodes(`${BODY}\n\n${BODY.replace(TARGET,'the source page')}`,SITE.name,SITE.url,'en'))},
  {channel:'GitHub Gist README',build:()=>JSON.stringify(gistTesting.approvedReadme({...connectedContext,site:{...SITE,url:TARGET}},false))},
  {channel:'WordPress post',build:()=>JSON.stringify(wordpressTesting.approvedArticle(articleTask(),SITE.url,false,SITE))},
  {channel:'yeet.md snapshot',build:()=>batch5DirectTesting.publicBody('yeetmd',`# ${TITLE}\n\n${BODY}`)},
  {channel:'markdown.page snapshot',build:()=>batch5DirectTesting.publicBody('markdownpage',`# ${TITLE}\n\n${BODY}`)},
  {channel:'rant.li post',build:()=>JSON.stringify(writeFreelyPostPayload(TITLE,BODY,'reviewed-process'))},
  {channel:'WhiteWind record',build:()=>whiteWindTesting.requestBody('did:plc:examplewriter1234567890','3mabcdefghi2j',whiteWindTesting.article(connectedContext as Parameters<typeof whiteWindTesting.article>[0],AT))},
  {channel:'HackMD guest note',build:()=>hackMdTesting.article(connectedContext as Parameters<typeof hackMdTesting.article>[0]).body},
);

test('fresh SwarmMemo reviewed draft signs an unbranded public command',()=>{
  const body=`# ${TITLE}\n\n${BODY}\n\nThe published note records what was checked, what remains uncertain, and why readers should verify the current source before applying the procedure.\n\n${SWARMMEMO_DISCLOSURE}`;
  const task=articleTask({channelId:'swarmmemo',sourceDomain:'swarmmemo.com',draft:{title:TITLE,description:'',body}});
  task.swarmMemoInput=createSwarmMemoReviewedInput(task,SITE,{method:'manual',approvedAt:AT});
  assert.ok(task.swarmMemoInput);
  const identity=swarmMemoTaskIdentity(task,SITE);
  assert.ok(identity);
  const secret=generateSwarmMemoIdentity(ACCOUNT_ID,AT);
  const request=createSwarmMemoCommand({text:identity.body,requestId:TASK_ID.replaceAll('-',''),timestamp:Math.floor(Date.parse(AT)/1000),nonce:'a'.repeat(32),identity:secret});
  assert.equal(JSON.parse(request.body).text,body);
  assert.doesNotMatch(request.body,/linkflow|data-(?:linkflow|publication)-/i);
});

test('SwarmMemo profile drafting adds a generic disclosure to a new public article',()=>{
  const site={...SITE,writingProfile:ensureWritingProfile(SITE,[])};
  const channel=CHANNELS.find(item=>item.id==='swarmmemo');
  assert.ok(channel);
  const task=articleTask({channelId:'swarmmemo',sourceDomain:'swarmmemo.com',draft:undefined});
  const instruction=profileDraftInstruction(site,channel,task,'tutorial');
  const output=decorateManagedDraft({title:TITLE,description:'',body:BODY},site,channel,task).draft.body;
  assert.doesNotMatch(instruction,/linkflow/i);
  assert.match(instruction,/邀请码.*推荐码/);
  assert.equal(output.split(DRAFT_CONTRACT_PUBLIC_MESSAGES.swarmMemoIdentity(site.name,site.domain)).length-1,1);
  assert.equal(output.split(SWARMMEMO_DISCLOSURE).length-1,0);
  assert.doesNotMatch(output,/linkflow/i);
});

test('fresh public payload renderers and request builders add no product branding or hidden markers',async t=>{
  for(const {channel,build} of payloads)await t.test(channel,()=>{
    const output=build();
    assert.ok(output.length>0);
    assert.doesNotMatch(output,/linkflow|data-(?:linkflow|publication)-/i);
    assert.doesNotMatch(output,/"slug":"lf-/i);
  });
});

test('publisher source guard discovers every integration module, including future payload builders',()=>{
  const directory=join(process.cwd(),'src','integrations');
  const files=readdirSync(directory).filter(file=>file.endsWith('.ts'));
  assert.ok(files.length>80);
  // These exact sites of legacy readback or private state are kept for old work.
  // No fresh public request builder may introduce a new product identifier.
  const historical:Record<string,RegExp[]>={
    'nostr.ts':[/historicalIdentifierFor/,/return `linkflow-\$\{identifierFor\(taskId\)\}`/],
    'betterthanhtml.ts':[/main#article,main#linkflow-article/,/div#article-body,div#linkflow-article-body/],
    'codex-models.ts':[/linkflow-models-/],
    'ai.ts':[/linkflow-ai-/],
    'blogger.ts':[/Authorization received.*Linkflow/,/prefix: 'linkflow'/,/legacyContent\(content, title, operationId, 'linkflow'\)/,/data-linkflow-operation/],
    'public-identity.ts':[/replace\(\/linkflow\/gi/],
    'colony.ts':[/linkflow-desktop/],
    'agentriot.ts':[/linkflow-desktop:/,/softwareName:legacy\?'LinkFlow'/],
    'colony-publisher.ts':[/client:'linkflow-desktop'/],
    'browser.ts':[/persist:linkflow-/],
    'swarmmemo.ts':[/SWARMMEMO_LEGACY_DISCLOSURE/],
    'hive.ts':[/legacy\?\{app:'linkflow\/1\.0'/,/legacy\?'linkflow-article'/],
  };
  const violations:string[]=[];
  for(const file of files){
    const source=readFileSync(join(directory,file),'utf8');
    source.split('\n').forEach((line,index)=>{
      if(!/linkflow|data-linkflow/i.test(line))return;
      if(!(historical[file]??[]).some(pattern=>pattern.test(line)))violations.push(`${file}:${index+1}`);
    });
  }
  assert.deepEqual(violations,[]);
});
