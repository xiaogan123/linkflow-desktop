import assert from 'node:assert/strict';
import test from 'node:test';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {discoverPublicPayloadBuilders,missingPublicPayloadFixtures,publicPayloadBrandMarkers} from './helpers/public-payload-discovery';

const DIRECTORY=join(process.cwd(),'src','integrations');
const UUID='11111111-1111-4111-8111-111111111111',ACCOUNT='22222222-2222-4222-8222-222222222222';
const AT='2026-10-18T00:00:00.000Z',TARGET='https://example.com/guide';
const TITLE='A reproducible source review',DESCRIPTION='A source review with evidence and limits.';
const BODY=`A reader can compare a dated claim with the original source and record the scope before applying it. The [source guide](${TARGET}) provides the underlying method.\n\nA second pass checks what changed, which assumptions remain uncertain, and whether the original conclusion still fits the available evidence. This keeps the procedure repeatable without claiming a personal result.`;
const DRAFT={title:TITLE,description:DESCRIPTION,body:BODY};
const HTML=`<!doctype html>\n<html lang="en"><head><title>${TITLE}</title></head><body><main><p>${BODY}</p><a href="${TARGET}">Guide</a></main></body></html>`;
const SITE={id:ACCOUNT,domain:'example.com',url:'https://example.com/',name:'Example Research',language:'en',category:'software',email:'owner@example.com',description:'Source review project.',status:'ready',monthlyTarget:1,createdAt:AT};
const TASK={id:UUID,siteId:ACCOUNT,channelId:'example',sourceDomain:'example.org',status:'running',createdAt:AT,scheduledAt:AT,updatedAt:AT,attempts:1,message:'',topicUrl:TARGET,draft:DRAFT,draftRevision:1,articleApprovedAt:AT};
const ARTICLE={draft:DRAFT,targetUrl:TARGET,language:'en',slug:'example-research'};
const LISTING={slug:'example-research',name:'Example Research',url:TARGET,description:'A repeatable source review using a documented public guide.',category:'app',pricing:'free',tags:['research','guide'],submitted_by:'Example Research'};
const WIKI={title:TITLE,summary:DESCRIPTION,language:'en',type:'methodology',tags:['research'],body:BODY,sources:[{title:'Source guide',url:TARGET}],basis:'An original method based on the cited public guide.',attribution:['Prepared with AI assistance for the site operator.'],change_notice:'Original contribution',related:[],applies_to:['Source reviews'],content_as_of:AT};
const CONNECTED_CONTEXT={site:SITE,task:TASK};

type Fixture=(builder:Function, module:Record<string,unknown>)=>unknown;
/** GitBook writes need a probed binding; the POST bodies sent are the public payload. */
async function gitBookWrite(builder:Function,module:Record<string,unknown>,extra:Record<string,unknown>={}){
  const m=module as Record<string,Function>&{GITBOOK_AUTHENTICATED_USER_URL:string};
  const token=`gb_${'a'.repeat(40)}`,org='org_example',siteId='site_example',spaceId='space_example';
  const article=m.prepareGitBookArticle({title:TITLE,slug:'example-research',markdown:`# ${TITLE}\n\n${BODY}\n`,targetUrl:TARGET});
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const reads=new Map<string,unknown>([
    [m.GITBOOK_AUTHENTICATED_USER_URL,{object:'user',id:'user_example',displayName:'Example',urls:{location:m.GITBOOK_AUTHENTICATED_USER_URL}}],
    [m.gitBookOrganizationMembersUrl(org),{items:[{object:'member',id:'member_example',role:'admin',disabled:false,user:{object:'user',id:'user_example'},joinedAt:AT,sso:false,spaces:1,teams:0,sites:1}]}],
    [m.gitBookOrganizationUrl(org),{object:'organization',id:org,plan:'free',trial:{status:'none'},permissions:{admin:true}}],
    [m.gitBookSiteUrl(org,siteId),{object:'site',id:siteId,type:'basic',appliedType:'basic',visibility:'public',permissions:{view:true,edit:true,create:true,admin:true},published:false,urls:{}}],
    [m.gitBookSpaceUrl(spaceId),{object:'space',id:spaceId,organization:org,revision:'revision_example',visibility:'private',permissions:{view:true,edit:true,merge:true,admin:true}}],
    [m.gitBookSiteSpacesUrl(org,siteId),{items:[{object:'site-space',id:'ss_example',path:'documentation',default:true,space:{object:'space',id:spaceId},title:'Documentation',draft:false,urls:{}}]}],
    [m.gitBookPageReadUrl(spaceId,article.slug,'cr_example'),{object:'page',title:article.title,slug:article.slug,noIndex:false,noRobotsIndex:false,markdown:article.markdown}],
  ]);
  const sent:unknown[]=[];
  const fetch=async(url:string,init:RequestInit)=>{if(init.method==='GET'){if(!reads.has(url))throw Error(`unexpected GET ${url}`);return json(reads.get(url))}sent.push(JSON.parse(String(init.body)));throw Error('stop after capture')};
  const probe=await m.probeGitBookBinding({organizationId:org,siteId,spaceId,token},{fetch});
  if(probe.status!=='usable')throw Error('GitBook fixture binding unusable');
  let intent:unknown;
  const persistence={secretStorage:'encrypted',async persistIntent(value:unknown){intent=value},assertReadyToSubmit:()=>true,async persistOpaqueResponse(){},async loadOpaqueResponse(){return undefined},async promoteReceipt(){}};
  await Reflect.apply(builder,undefined,[{operationId:`gitbook_${'1'.repeat(32)}`,binding:probe.binding,token,article,...extra},persistence,{allowExternalWrite:true,now:()=>new Date(AT),fetch}]);
  if(!sent.length)throw Error('GitBook fixture sent nothing');
  return {sent,intent};
}
const call=(...args:unknown[]):Fixture=>builder=>Reflect.apply(builder,undefined,args);
/** Arguments are explicit; the inventory is discovered from production exports. */
const fixtures:Record<string,Fixture>={
  'batch5-direct.ts:batch5DirectTesting.publicBody':builder=>[
    Reflect.apply(builder,undefined,['yeetmd',`# ${TITLE}\n\n${BODY}`]),
    Reflect.apply(builder,undefined,['markdownpage',`# ${TITLE}\n\n${BODY}`]),
  ],
  'betterthanhtml.ts:betterThanHtmlTesting.article':call(TASK,SITE.url,false),
  'betterthanhtml.ts:betterThanHtmlTesting.canonicalBody':call(`<p>${BODY}</p>`),
  'blogger.ts:bloggerTesting.approvedArticle':call(CONNECTED_CONTEXT),
  'bluesky.ts:blueskyTesting.approvedPost':call({...TASK,channelId:'bluesky',sourceDomain:'bsky.app',draft:{...DRAFT,body:`Record assumptions, compare original evidence and revisit the method: ${TARGET}\n\nCommercial relationship disclosure: The operator may receive a commission.`}},SITE.url,AT,false),
  'gist.ts:gistTesting.approvedReadme':call({site:{...SITE,url:TARGET},task:TASK},false),
  'hackmd.ts:hackMdTesting.article':call(CONNECTED_CONTEXT),
  'leaflet.ts:leafletTesting.buildArticle':call(TASK,SITE.url,'did:plc:examplewriter1234567890','3mabcdefghi2j',AT),
  'lucid.ts:lucidTesting.article':call(TASK,SITE.url,false),
  'mataroa.ts:mataroaTesting.approvedArticle':call(TASK,SITE,false),
  'nostr.ts:nostrTesting.approvedArticle':call(TASK,SITE.url),
  'nostr.ts:nostrTesting.eventTemplate':(builder,module)=>{
    const article=Reflect.apply((module.nostrTesting as Record<string,Function>).approvedArticle,undefined,[TASK,SITE.url]);
    return Reflect.apply(builder,undefined,[article,'a'.repeat(32),Math.floor(Date.parse(AT)/1000)]);
  },
  'paper.ts:paperTesting.approvedArticle':call(TASK,SITE),
  'paragraph.ts:paragraphTesting.approvedArticle':call(TASK,SITE,false),
  'prose.ts:proseTesting.approvedProseArticle':call(TASK,TARGET,false,SITE),
  'rentry.ts:rentryTesting.article':call(TASK,TARGET,false,SITE),
  'tantive.ts:makeTantiveIntent':call({name:'Example assistant',title:TITLE,room:'questions',body:BODY},{randomUUID:()=>UUID,now:()=>new Date(AT)}),
  'verbose.ts:verboseTesting.article':call(TASK,TARGET,false,SITE),
  'vibedrop.ts:vibeDropContentIdentity':call(TITLE,HTML),
  'whitewind.ts:whiteWindTesting.article':call(CONNECTED_CONTEXT,AT),
  'whitewind.ts:whiteWindTesting.requestBody':(builder,module)=>Reflect.apply(builder,undefined,['did:plc:examplewriter1234567890','3mabcdefghi2j',Reflect.apply((module.whiteWindTesting as Record<string,Function>).article,undefined,[CONNECTED_CONTEXT,AT])]),
  'wordpress.ts:wordpressTesting.approvedArticle':call(TASK,SITE.url,false,SITE),
  'wordcell.ts:wordcellTesting.publicationIntent':call({accountId:ACCOUNT,operationId:UUID,createdAt:AT,slug:'example-research',title:TITLE,markdown:BODY,targetUrl:TARGET}),
  'agentboard.ts:agentboardFirstRequest':call({agent:{name:'Example Research',description:'A site-operated source review assistant.',homepage:SITE.url,operatorName:'Site operator'},board:'introductions',title:TITLE,body:BODY},TARGET,'example-request-1'),
  'agentboard.ts:agentboardDiscussionRequest':call({board:'engineering',title:TITLE,body:BODY},TARGET,'example-request-2'),
  'agentdrop-article.ts:renderAgentDropArticle':call(ARTICLE),
  'agentdrop.ts:agentdropRequest':call(HTML,TITLE),
  'agenthow.ts:agentHowRegistrationRequest':call('example-research'),
  'agenthow.ts:agentHowPublicationRequest':call(TITLE,BODY,[{title:'Source guide',url:TARGET}],`agenthow_note_${UUID.replaceAll('-','')}`),
  'agentnotepad.ts:agentNotepadRegistrationRequest':call(),
  'agentnotepad.ts:agentNotepadPublishRequest':call(TITLE,BODY,[{url:TARGET,title:'Source guide'}],`agentnotepad_note_${UUID.replaceAll('-','')}`),
  'agentriot.ts:agentriotRegistrationRequest':call('fixture-installation','example-research','Site operated research assistant','Publishes reviewed source notes for Example Research.'),
  'agentriot.ts:agentriotUpdateRequest':call('example-research',{title:TITLE,summary:DESCRIPTION,whatChanged:'Added a documented source review method.',signalType:'research',publicLink:TARGET}),
  'agentsgather.ts:agentsGatherRequest':call({title:TITLE,body:BODY},UUID),
  'agentswiki.ts:agentsWikiDraftRequest':call(WIKI,TARGET),
  'berrry.ts:berrryPublicationRequest':call('brry_rw_00000000','example-research',TITLE,HTML),
  'brewpage.ts:brewPageRequest':call(BODY,'reviewed-source.md'),
  'carcinus.ts:carcinusPayload':call({identity:'Example Research assistant',purpose:'Document source review method',htmlTemplate:HTML}),
  'carcinus.ts:carcinusRequest':call({identity:'Example Research assistant',purpose:'Document source review method',htmlTemplate:HTML}),
  'colony.ts:colonyRegistrationRequest':call({username:'example_research',displayName:'Example Research'}),
  'colony.ts:colonyPostRequest':call({colony:'build-in-public',post_type:'analysis',title:TITLE,body:BODY,language:'en',tags:['research'],client:'site-publisher',bridge_to_nostr:false,confirm_duplicate:false},`colony_post_${UUID.replaceAll('-','')}`),
  'deed-page.ts:deedPageRequest':call('example-research',HTML),
  'draftmark.ts:draftmarkRequest':call(TITLE,BODY),
  'here-now.ts:hereNowRequest':call(HTML,TITLE,DESCRIPTION),
  'html-app.ts:htmlAppIdentity':call(HTML),
  'katbin.ts:katbinRequest':call(BODY),
  'large-language.ts:largeLanguageRegistrationRequest':call('Example Research','recovery-key-1234567890'),
  'large-language.ts:largeLanguageSubmissionRequest':call({title:TITLE,dek:DESCRIPTION,body:BODY,displayName:'Example Research',model:'assisted',steward:'Site operator',editDisclosure:'Prepared with AI assistance.',section:'technology',type:'essay',language:'en',license:'all_rights_reserved'},'example-request-3'),
  'listed-startups.ts:listedStartupsRequest':call({listing:{listing_type:'product',name:'Example Research',slug:'example-research',tagline:DESCRIPTION,description:'A site-operated source review project with documented public methods.',url:TARGET,is_stealth:false,categories:['research'],type_data:{product_kind:'app',platforms:['web']},links:[]},attribution:{agent_name:'Example Research assistant',represented_organization:'Example Research'}}),
  'markdownpaste.ts:markdownPasteRequest':call(BODY),
  'markdrop.ts:markdropRequest':call(TITLE,BODY,'example-research'),
  'mdshare.ts:mdshareRequest':call(TITLE,BODY),
  'mdview.ts:mdviewRequest':call(TITLE,BODY),
  'memorywiki.ts:memoryWikiRequest':call(TITLE,BODY),
  'nextgen-slides-article.ts:renderNextgenSlidesArticle':call({...ARTICLE,draft:{...DRAFT,body:`## Source\n\n${BODY}\n\n## Method\n\nReview each dated assertion.\n\n## Limits\n\nRecord unresolved assumptions.`}}),
  'nextgen-slides.ts:nextgenSlidesRequest':call(HTML,TITLE),
  'notebin.ts:notebinNoteRequest':call(TITLE,DESCRIPTION,BODY),
  'openagentchat.ts:openAgentChatRegistrationRequest':call('example-research','Example Research','A site-operated research assistant.'),
  'openagentchat.ts:openAgentChatPageRequest':call(TITLE,BODY,`oac_page_${UUID.replaceAll('-','')}`),
  'pastemyst.ts:pastemystRequest':call(TITLE,BODY),
  'pastyx.ts:pastyxRequest':call({title:TITLE,author:SITE.name,content:BODY},'A'.repeat(43)),
  'product-index.ts:productIndexIssueRequest':call(JSON.stringify(LISTING,null,2),LISTING),
  'prose.ts:approvedProseArticle':call(TASK,TARGET,true,SITE),
  'pstrs.ts:pstrsRequest':call(BODY),
  'raindrop.ts:raindropTaskPayload':builder=>{const account={id:ACCOUNT,channelId:'raindrop',email:'',username:'12345',displayName:'Example Research',publicationUrl:'https://raindrop.page/collection/456',status:'registered',source:'imported',credentialKind:'api_token',hasPassword:true,createdAt:AT,raindrop:{version:1,ownerId:'12345',collectionId:'456',publicUrl:'https://raindrop.page/collection/456',tokenFingerprint:'a'.repeat(64),tokenVersion:1,connectedAt:AT}};const channel={id:'raindrop',domain:'raindrop.page',automation:'api'};return Reflect.apply(builder,undefined,[{site:SITE,task:{...TASK,channelId:'raindrop',sourceDomain:'raindrop.page',accountId:ACCOUNT,draft:{...DRAFT,body:'Read the dated source, compare the current scope with the original statement, and record what remains uncertain before acting.'}},channel,getAccount:()=>account,settings:{articleReviewMode:'manual'}}])},
  'shareyourhtml-article.ts:renderShareYourHtmlArticle':call(ARTICLE),
  'shellbook.ts:shellbookRegistrationRequest':call('example_research','A site-operated source review assistant.'),
  'shellbook.ts:shellbookPostRequest':call(TITLE,BODY,TARGET),
  'shiply.ts:shiplyRequest':call(HTML,TITLE,DESCRIPTION),
  'shippage-article.ts:renderShipPageArticle':call(ARTICLE),
  'shippage.ts:shipPageRequest':call(HTML,TITLE,'example-research',true),
  'slugpost.ts:slugPostRequest':call(BODY,'example-research'),
  'swarmmemo.ts:createSwarmMemoCommand':(builder,module)=>Reflect.apply(builder,undefined,[{text:BODY,requestId:UUID.replaceAll('-',''),timestamp:Math.floor(Date.parse(AT)/1000),nonce:'a'.repeat(32),identity:Reflect.apply(module.generateSwarmMemoIdentity as Function,undefined,[ACCOUNT,AT])}]),
  'synthfolk.ts:synthfolkRegistrationRequest':call({handle:'example-research',name:'Example Research',headline:DESCRIPTION,about:'This site-operated assistant documents a repeatable review procedure and directs readers to the original evidence and limitations.',operator:'Site operator',website:TARGET,availability:'closed',skills:['research']},TARGET),
  'telegraph.ts:articleToTelegraphNodes':call(`${BODY}\n\n${BODY.replace(TARGET,'the source guide')}\n\n${BODY.replace('A reader','The site operator')}`,SITE.name,SITE.url,'en'),
  'thethings.ts:theThingsRequest':call(TITLE,DESCRIPTION,HTML),
  'totpage-article.ts:renderTotpageArticle':call(ARTICLE),
  'totpage.ts:totpageRequest':call(HTML,TITLE),
  'txtsbs.ts:txtsbsRequest':call({title:TITLE,abstract:DESCRIPTION,author:SITE.name,content:HTML,showDate:true,showSerp:true}),
  'vibedrop.ts:publicationIdentity':call({accountId:ACCOUNT,operationId:`vibedrop_publish_${UUID.replaceAll('-','')}`,createdAt:AT,title:TITLE,html:HTML}),
  'writefreely-protocol.ts:writeFreelyPostPayload':call(TITLE,BODY,'example-research'),
  'yourwebs.ts:yourwebsRequest':call(HTML,TITLE),
  'beacon.ts:renderBeaconArticle':call(ARTICLE),
  'gitbook.ts:createGitBookChangeRequest':(builder,module)=>gitBookWrite(builder,module),
  'gitbook.ts:mergeGitBookChangeRequest':(builder,module)=>gitBookWrite(builder,module,{changeRequestId:'cr_example'}),
  'hart.ts:renderHartArticle':call({draft:DRAFT,targetUrl:TARGET,language:'en'}),
  'hart-publisher.ts:renderHartTaskArticle':call(TASK,SITE),
  'html2link-article.ts:renderHtml2LinkArticle':call({draft:DRAFT,targetUrl:TARGET,language:'en'}),
};

test('every discovered public builder has an invoked, unbranded fixture',async t=>{
  const discovered=readdirSync(DIRECTORY).filter(file=>file.endsWith('.ts')).flatMap(file=>discoverPublicPayloadBuilders(file,readFileSync(join(DIRECTORY,file),'utf8'))).sort();
  assert.ok(discovered.length>=55,`too few discovered builders: ${discovered.length}`);
  assert.deepEqual(missingPublicPayloadFixtures(discovered,fixtures),[]);
  assert.deepEqual(Object.keys(fixtures).filter(key=>!discovered.includes(key)),[]);
  for(const key of discovered)await t.test(key,async()=>{
    const [file,name]=key.split(':');
    const module=await import(pathToFileURL(join(DIRECTORY,file)).href) as Record<string,unknown>;
    const builder=name.split('.').reduce<unknown>((value,part)=>value&&typeof value==='object'?(value as Record<string,unknown>)[part]:undefined,module);
    assert.equal(typeof builder,'function');
    const output=await fixtures[key](builder as Function,module);
    assert.deepEqual(publicPayloadBrandMarkers(output),[]);
  });
});

test('inventory fails closed on a new builder, including composed branding and data attributes',()=>{
  const cases={
    'direct return':"export function newBuilder(){return {body:'<p>Example</p>'}}",
    'arrow expression':"export const createPublicationPayload=()=>({body:'<p>Example</p>'})",
    'return variable':"export function makePublication(){const payload={body:'<p>Example</p>'};return payload}",
    'testing object':"const pageBody=()=>({body:'<p>Example</p>'});export const exampleTesting={pageBody}",
    'testing method':"export const exampleTesting={pageBody:()=>({body:'<p>Example</p>'})}",
  };
  const expected=['newBuilder','createPublicationPayload','makePublication','exampleTesting.pageBody','exampleTesting.pageBody'];
  Object.values(cases).forEach((source,index)=>{
    const discovered=discoverPublicPayloadBuilders('new-publisher.ts',source);
    assert.deepEqual(discovered,[`new-publisher.ts:${expected[index]}`]);
    assert.deepEqual(missingPublicPayloadFixtures(discovered,fixtures),discovered);
  });
  const sample={body:'<p data-publication-source="'+'link'+'flow'+'">Example</p>'};
  assert.deepEqual(publicPayloadBrandMarkers(sample),['brand','data_attribute']);
});
