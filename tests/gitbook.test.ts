import assert from 'node:assert/strict';
import test from 'node:test';
import {marked} from 'marked';
import {
  GITBOOK_AUTHENTICATED_USER_URL,createGitBookChangeRequest,gitBookChangeRequestContentUrl,gitBookChangeRequestSubject,
  gitBookChangeRequestUrl,gitBookChangeRequestsUrl,gitBookMergeUrl,gitBookOrganizationMembersUrl,gitBookOrganizationUrl,
  gitBookPageReadUrl,gitBookSitePublishUrl,gitBookSiteSpacesUrl,gitBookSiteUrl,gitBookSpaceUrl,
  insertGitBookPage,mergeGitBookChangeRequest,prepareGitBookArticle,probeGitBookBinding,publishGitBookSite,
  recoverGitBookChangeRequest,recoverGitBookMerge,recoverGitBookPage,recoverGitBookSitePublish,verifyGitBookPublication,
  type GitBookBinding,type GitBookIntent,type GitBookOpaqueResponse,type GitBookPersistence,type GitBookReceipt,
} from '../src/integrations/gitbook';

const now='2026-10-24T08:00:00.000Z';
const token=`gb_${'a'.repeat(40)}`;
const organizationId='org_example',siteId='site_example',siteSpaceId='ss_example',spaceId='space_example',userId='user_example',memberId='member_example';
const title='Check an import before using real data',slug='checked-import-guide',targetUrl='https://example.com/product';
const markdown=`# ${title}\n\nTest five synthetic rows before using real data.\n\n## Verify the result\n\nCompare the output with the [product documentation](${targetUrl}), then remove the sample rows.\n`;
const article=prepareGitBookArticle({title,slug,markdown,targetUrl});
const operations={cr:`gitbook_${'1'.repeat(32)}`,page:`gitbook_${'2'.repeat(32)}`,merge:`gitbook_${'3'.repeat(32)}`,publish:`gitbook_${'4'.repeat(32)}`};

function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
function accountPayload(options:{published?:boolean;members?:number;role?:string;disabled?:boolean;siteSpaceId?:string;userId?:string;memberId?:string}={}){
  const published=options.published??false,urls=published?{published:'https://docs.example/'}:{};
  const currentUserId=options.userId??userId,currentMemberId=options.memberId??memberId,currentSiteSpaceId=options.siteSpaceId??siteSpaceId;
  const member={object:'member',id:currentMemberId,role:options.role??'admin',disabled:options.disabled??false,user:{object:'user',id:currentUserId},joinedAt:now,sso:false,spaces:1,teams:0,sites:1};
  return {
    user:{object:'user',id:currentUserId,displayName:'Test',urls:{location:'https://api.gitbook.com/v1/user'}},
    members:{items:Array.from({length:options.members??1},(_,index)=>index?{...member,id:`member_${index}`,user:{object:'user',id:`user_${index}`}}:member)},
    org:{object:'organization',id:organizationId,plan:'pro_2024',trial:{status:'active'},permissions:{admin:true}},
    site:{object:'site',id:siteId,type:'basic',appliedType:'basic',visibility:'public',permissions:{view:true,edit:true,create:true,admin:true},published,urls},
    space:{object:'space',id:spaceId,organization:organizationId,revision:'revision_example',visibility:'private',permissions:{view:true,edit:true,merge:true,admin:true}},
    siteSpaces:{items:[{object:'site-space',id:currentSiteSpaceId,path:'documentation',default:true,space:{object:'space',id:spaceId},title:'Documentation',draft:false,urls:published?{published:'https://docs.example/documentation/'}:{}}]},
  };
}
function accountFetch(options:Parameters<typeof accountPayload>[0]={}){const data=accountPayload(options);return async(url:string,init:RequestInit)=>{assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${token}`);if(url===GITBOOK_AUTHENTICATED_USER_URL)return json(data.user);if(url===gitBookOrganizationMembersUrl(organizationId))return json(data.members);if(url===gitBookOrganizationUrl(organizationId))return json(data.org);if(url===gitBookSiteUrl(organizationId,siteId))return json(data.site);if(url===gitBookSpaceUrl(spaceId))return json(data.space);if(url===gitBookSiteSpacesUrl(organizationId,siteId))return json(data.siteSpaces);throw Error(`unexpected account GET ${url}`)}}
async function binding(options:Parameters<typeof accountPayload>[0]={}){const result=await probeGitBookBinding({organizationId,siteId,spaceId,token},{fetch:accountFetch(options)});assert.equal(result.status,'usable');if(result.status!=='usable')throw Error('binding');return result.binding}

function memory(options:{failIntent?:boolean;failOpaque?:boolean;failPromotion?:boolean}={}){
  const events:string[]=[],opaque=new Map<string,GitBookOpaqueResponse>();let intent:GitBookIntent|undefined,receipt:GitBookReceipt|undefined;
  const persistence:GitBookPersistence={secretStorage:'encrypted',async persistIntent(value){events.push('intent');if(options.failIntent)throw Error('disk');intent=structuredClone(value)},assertReadyToSubmit(value){events.push('authorize');assert.deepEqual(value,intent);return true},async persistOpaqueResponse(value){events.push('opaque');if(options.failOpaque)throw Error('disk');opaque.set(`${value.stage}:${value.operationId}`,structuredClone(value))},async loadOpaqueResponse(stage,id){return opaque.get(`${stage}:${id}`)},async promoteReceipt(value){events.push('receipt');if(options.failPromotion)throw Error('disk');receipt=structuredClone(value)}};
  return {persistence,events,opaque,get intent(){return intent},get receipt(){return receipt}};
}

test('article preparation accepts real multiline Markdown and binds the reviewed native link',()=>{
  assert.equal(article.markdown,markdown);assert.equal(article.targetUrl,targetUrl);assert.match(article.sourceHash,/^[a-f0-9]{64}$/);
  assert.throws(()=>prepareGitBookArticle({title,slug,markdown:'# Missing link\n\nText',targetUrl}));
  assert.throws(()=>prepareGitBookArticle({title,slug,markdown:`${markdown}\0`,targetUrl}));
});

test('binding probe accepts a Basic public site during an organization add-on trial and proves sole admin ownership',async()=>{
  const result=await probeGitBookBinding({organizationId,siteId,spaceId,token},{fetch:accountFetch()});assert.equal(result.status,'usable');if(result.status!=='usable')return;
  assert.equal(result.binding.organizationPlan,'pro_2024');assert.equal(result.binding.organizationTrialStatus,'active');assert.equal(result.binding.siteType,'basic');assert.equal(result.binding.soleAdmin,true);assert.equal(result.binding.sitePublished,false);
  assert.equal(JSON.stringify(result).includes(userId),false);assert.equal(JSON.stringify(result).includes(memberId),false);assert.equal(JSON.stringify(result).includes(token),false);
  assert.equal((await probeGitBookBinding({organizationId,siteId,spaceId,token},{fetch:accountFetch({members:2})})).status,'invalid');
  assert.equal((await probeGitBookBinding({organizationId,siteId,spaceId,token},{fetch:accountFetch({role:'create'})})).status,'invalid');
  const paged=accountPayload();assert.equal((await probeGitBookBinding({organizationId,siteId,spaceId,token},{fetch:async(url,init)=>url===gitBookOrganizationMembersUrl(organizationId)?json({...paged.members,count:2,next:{page:'another'}}):accountFetch()(url,init)})).status,'invalid');
});

test('writes are closed by default and failed intent persistence performs zero POSTs',async()=>{
  const bound=await binding();let calls=0;
  assert.deepEqual(await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},memory().persistence,{fetch:async()=>{calls++;throw Error('no')}}),{status:'not_started',reason:'external_write_disabled'});
  assert.deepEqual(await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},memory({failIntent:true}).persistence,{allowExternalWrite:true,fetch:async()=>{calls++;throw Error('no')}}),{status:'not_started',reason:'intent_not_persisted'});assert.equal(calls,0);
});

test('change request POST persists intent and opaque response before receipt',async()=>{
  const bound=await binding(),saved=memory(),subject=gitBookChangeRequestSubject(article,operations.cr);let posts=0;
  const result=await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{posts++;assert.equal(url,gitBookChangeRequestsUrl(spaceId));assert.equal(init.method,'POST');assert.deepEqual(JSON.parse(String(init.body)),{subject});return json({id:'cr_example',subject,status:'draft'},201)}});
  assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','receipt']);assert.equal(JSON.stringify(result).includes(token),false);
});

test('page insertion performs a GET absence check and sends one documented insert_page change',async()=>{
  const bound=await binding(),saved=memory();let posts=0;
  const result=await insertGitBookPage({operationId:operations.page,binding:bound,token,changeRequestId:'cr_example',article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{
    if(init.method==='GET'){assert.equal(url,gitBookPageReadUrl(spaceId,slug,'cr_example'));return json({error:'not found'},404)}posts++;assert.equal(url,gitBookChangeRequestContentUrl(spaceId,'cr_example'));assert.deepEqual(JSON.parse(String(init.body)),{changes:[{operation:'insert_page',document:{markdown},title,slug,ref:slug,noIndex:false,noRobotsIndex:false}]});return json({changeRequest:{id:'cr_example'},changes:[{object:'created_page',ref:slug,page:{object:'page',id:'page_example',urls:{location:'/content/path/checked-import-guide'}}}]});
  }});
  assert.equal(result.status,'created');assert.equal(posts,1);assert.deepEqual(saved.events,['intent','authorize','opaque','receipt']);
});

test('transport-unknown intent blocks a repeated POST',async()=>{
  const bound=await binding(),saved=memory();let posts=0;
  const first=await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{posts++;throw Error('lost')}});assert.equal(first.status,'unknown');assert.ok(saved.intent);
  const second=await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article,priorIntent:saved.intent as Extract<GitBookIntent,{stage:'change_request'}>},saved.persistence,{allowExternalWrite:true,fetch:async()=>{posts++;throw Error('must not POST')}});assert.equal(second.status,'blocked');assert.equal(posts,1);
});

test('merge checks draft content first and keeps conflicts out of the success path',async()=>{
  const bound=await binding();for(const mergeResult of ['merge','conflicts'] as const){const saved=memory();let posts=0;const result=await mergeGitBookChangeRequest({operationId:operations.merge,binding:bound,token,changeRequestId:'cr_example',article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{if(init.method==='GET'){assert.equal(url,gitBookPageReadUrl(spaceId,slug,'cr_example'));return json({object:'page',title,slug,noIndex:false,noRobotsIndex:false,markdown})}posts++;assert.equal(url,gitBookMergeUrl(spaceId,'cr_example'));assert.equal(String(init.body),'{}');return json({revision:'revision_after',result:mergeResult})}});assert.equal(result.status,mergeResult==='merge'?'created':'manual_resolution_required');assert.equal(posts,1);assert.equal(saved.events.includes('receipt'),mergeResult==='merge')}});

test('page and merge recheck authorization after awaited GET and immediately before POST',async()=>{
  const bound=await binding();for(const kind of ['page','merge'] as const){const saved=memory();saved.persistence.assertReadyToSubmit=()=>{throw Error('revoked')};let posts=0;const fetch=async(_url:string,init:RequestInit)=>{if(init.method==='GET')return kind==='page'?json({},404):json({title,slug,markdown});posts++;return json({})};const result=kind==='page'?await insertGitBookPage({operationId:operations.page,binding:bound,token,changeRequestId:'cr_example',article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch}):await mergeGitBookChangeRequest({operationId:operations.merge,binding:bound,token,changeRequestId:'cr_example',article},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch});assert.deepEqual(result,{status:'not_started',reason:'authorization_changed'});assert.equal(posts,0);assert.deepEqual(saved.events,['intent'])}
});

test('site publication rejects checkout and never treats it as a published site',async()=>{
  const bound=await binding(),saved=memory();const result=await publishGitBookSite({operationId:operations.publish,binding:bound,token},saved.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(url,init)=>{assert.equal(url,gitBookSitePublishUrl(organizationId,siteId));assert.equal(init.method,'POST');return json({type:'checkout',sessionId:'secret_checkout_session'})}});assert.equal(result.status,'payment_required');assert.equal(saved.receipt,undefined);assert.equal(JSON.stringify(result).includes('secret_checkout_session'),false);
  const already=await binding({published:true});let calls=0;assert.equal((await publishGitBookSite({operationId:operations.publish,binding:already,token},memory().persistence,{allowExternalWrite:true,fetch:async()=>{calls++;throw Error('no')}})).status,'already_published');assert.equal(calls,0);
  const wrong=await publishGitBookSite({operationId:operations.publish,binding:bound,token},memory().persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>json({...accountPayload({published:true}).site,id:'unrelated_site'})});assert.equal(wrong.status,'rejected');
});

test('opaque recovery cannot report success until durable receipt promotion succeeds',async()=>{
  const bound=await binding(),seed=memory({failPromotion:true}),subject=gitBookChangeRequestSubject(article,operations.cr);const created=await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},seed.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>json({id:'cr_example',subject,status:'draft'},201)});assert.equal(created.status,'storage_pending');assert.ok(seed.intent);
  const recovered=await recoverGitBookChangeRequest(seed.intent as Extract<GitBookIntent,{stage:'change_request'}>,bound,token,seed.persistence,{fetch:async()=>{throw Error('opaque recovery must not GET')}});assert.equal(recovered.status,'storage_pending');assert.equal(seed.receipt,undefined);
});

test('lost responses reconcile all mutation stages with GETs and never repeat a POST',async()=>{
  const bound=await binding();
  const cr=memory();let crPosts=0;await createGitBookChangeRequest({operationId:operations.cr,binding:bound,token,article},cr.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{crPosts++;throw Error('lost')}});assert.ok(cr.intent);
  assert.equal((await recoverGitBookChangeRequest(cr.intent as Extract<GitBookIntent,{stage:'change_request'}>,bound,token,cr.persistence,{fetch:async(url,init)=>{assert.equal(init.method,'GET');assert.equal(url,gitBookChangeRequestsUrl(spaceId,'draft'));return json({items:[{id:'cr_example',subject:gitBookChangeRequestSubject(article,operations.cr),status:'draft'}]})}})).status,'found');assert.equal(crPosts,1);

  const page=memory();let pagePosts=0;await insertGitBookPage({operationId:operations.page,binding:bound,token,changeRequestId:'cr_example',article},page.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(_url,init)=>{if(init.method==='GET')return json({},404);pagePosts++;throw Error('lost')}});assert.ok(page.intent);
  const pageRecovered=await recoverGitBookPage(page.intent as Extract<GitBookIntent,{stage:'page'}>,bound,article,token,page.persistence,{fetch:async()=>json({id:'page_example',type:'document',title,slug,path:slug,markdown})});assert.equal(pageRecovered.status,'found');if(pageRecovered.status==='found')assert.equal(pageRecovered.pageId,'page_example');assert.equal(pagePosts,1);

  const merge=memory();let mergePosts=0;await mergeGitBookChangeRequest({operationId:operations.merge,binding:bound,token,changeRequestId:'cr_example',article},merge.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async(_url,init)=>{if(init.method==='GET')return json({title,slug,markdown});mergePosts++;throw Error('lost')}});assert.ok(merge.intent);
  assert.equal((await recoverGitBookMerge(merge.intent as Extract<GitBookIntent,{stage:'merge'}>,bound,article,token,merge.persistence,{fetch:async url=>url===gitBookChangeRequestUrl(spaceId,'cr_example')?json({status:'merged',revision:'revision_after'}):json({title,slug,markdown})})).status,'found');assert.equal(mergePosts,1);

  const site=memory();let sitePosts=0;await publishGitBookSite({operationId:operations.publish,binding:bound,token},site.persistence,{allowExternalWrite:true,now:()=>new Date(now),fetch:async()=>{sitePosts++;throw Error('lost')}});assert.ok(site.intent);
  assert.equal((await recoverGitBookSitePublish(site.intent as Extract<GitBookIntent,{stage:'site_publish'}>,bound,token,site.persistence,{fetch:async()=>json(accountPayload({published:true}).site)})).status,'found');assert.equal(sitePosts,1);
});

test('final verification re-probes ownership and checks API Markdown, public HTML, noindex, robots and native link',async()=>{
  const initial=await binding(),data=accountPayload({published:true}),publicUrl=`https://docs.example/documentation/${slug}`,robotsUrl='https://docs.example/robots.txt';
  const fetch=async(url:string,init:RequestInit)=>{
    if(url===GITBOOK_AUTHENTICATED_USER_URL)return json(data.user);if(url===gitBookOrganizationMembersUrl(organizationId))return json(data.members);if(url===gitBookOrganizationUrl(organizationId))return json(data.org);if(url===gitBookSiteUrl(organizationId,siteId))return json(data.site);if(url===gitBookSpaceUrl(spaceId))return json(data.space);if(url===gitBookSiteSpacesUrl(organizationId,siteId))return json(data.siteSpaces);
    if(url===gitBookPageReadUrl(spaceId,slug)){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${token}`);return json({object:'page',title,slug,noIndex:false,noRobotsIndex:false,markdown})}
    if(url===publicUrl){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(`<!doctype html><html><head><title>${title}</title></head><body><main><article>${marked.parse(markdown)}</article></main></body></html>`,{status:200,headers:{'content-type':'text/html'}})}
    if(url===robotsUrl)return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});throw Error(`unexpected ${url}`);
  };
  const result=await verifyGitBookPublication(initial,article,token,{fetch});assert.equal(result.status,'usable');if(result.status==='usable'){assert.equal(result.publicUrl,publicUrl);assert.equal(result.robots,'allowed')}
  const replaced=accountPayload({published:true,siteSpaceId:'ss_replaced'});const replacedFetch=async(url:string)=>{if(url===GITBOOK_AUTHENTICATED_USER_URL)return json(replaced.user);if(url===gitBookOrganizationMembersUrl(organizationId))return json(replaced.members);if(url===gitBookOrganizationUrl(organizationId))return json(replaced.org);if(url===gitBookSiteUrl(organizationId,siteId))return json(replaced.site);if(url===gitBookSpaceUrl(spaceId))return json(replaced.space);if(url===gitBookSiteSpacesUrl(organizationId,siteId))return json(replaced.siteSpaces);throw Error(`binding should fail before ${url}`)};
  assert.deepEqual(await verifyGitBookPublication(initial,article,token,{fetch:replacedFetch}),{status:'invalid',reason:'binding'});
});

test('final verification isolates the unique visible GitBook content root without accepting partial or ambiguous DOM',async()=>{
  const initial=await binding(),data=accountPayload({published:true}),publicUrl=`https://docs.example/documentation/${slug}`,robotsUrl='https://docs.example/robots.txt';
  const rendered=String(marked.parse(markdown)),body=rendered.replace(/^<h1>[^<]*<\/h1>\n/u,'');
  const page=(content:string,heading=title,headingAttributes='')=>`<!doctype html><html><head><title>${heading}</title></head><body><main><div><header><h1 ${headingAttributes}>${heading}</h1></header>${content}</div><nav>On this page Previous Page</nav></main></body></html>`;
  const root=(content:string,attributes='')=>`<div data-content-ref-root ${attributes}>${content}</div>`;
  const verify=(html:string)=>verifyGitBookPublication(initial,article,token,{fetch:async(url,init)=>{
    if(url===GITBOOK_AUTHENTICATED_USER_URL)return json(data.user);if(url===gitBookOrganizationMembersUrl(organizationId))return json(data.members);if(url===gitBookOrganizationUrl(organizationId))return json(data.org);if(url===gitBookSiteUrl(organizationId,siteId))return json(data.site);if(url===gitBookSpaceUrl(spaceId))return json(data.space);if(url===gitBookSiteSpacesUrl(organizationId,siteId))return json(data.siteSpaces);if(url===gitBookPageReadUrl(spaceId,slug))return json({object:'page',title,slug,markdown});if(url===publicUrl){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(html,{status:200,headers:{'content-type':'text/html'}})}if(url===robotsUrl)return new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}});throw Error(`unexpected ${url}`);
  }});
  assert.equal((await verify(page(root(body)))).status,'usable');
  assert.deepEqual(await verify(page(root(body.replace('<h2>Verify the result</h2>\n','')))),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(page(root(body),'A different title')),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(page(`${root(body)}${root(body)}`)),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(page(root(body,'hidden'))),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(page(root(body),title,'hidden')),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(page(root(body)).replace('</head>','<style>h1{display:none}</style></head>')),{status:'invalid',reason:'content'});
  assert.deepEqual(await verify(`${page(root(body))}<main></main>`),{status:'invalid',reason:'content'});
});

test('robots may follow exactly one anonymous same-origin redirect to the bound site-space robots path',async()=>{
  const initial=await binding(),data=accountPayload({published:true}),publicUrl=`https://docs.example/documentation/${slug}`,rootRobots='https://docs.example/robots.txt',boundRobots='https://docs.example/documentation/robots.txt',html=`<!doctype html><html><head><title>${title}</title></head><body><main><article>${marked.parse(markdown)}</article></main></body></html>`;
  const check=async(location:string,secondRedirect=false)=>verifyGitBookPublication(initial,article,token,{fetch:async(url,init)=>{
    if(url===GITBOOK_AUTHENTICATED_USER_URL)return json(data.user);if(url===gitBookOrganizationMembersUrl(organizationId))return json(data.members);if(url===gitBookOrganizationUrl(organizationId))return json(data.org);if(url===gitBookSiteUrl(organizationId,siteId))return json(data.site);if(url===gitBookSpaceUrl(spaceId))return json(data.space);if(url===gitBookSiteSpacesUrl(organizationId,siteId))return json(data.siteSpaces);if(url===gitBookPageReadUrl(spaceId,slug))return json({object:'page',title,slug,markdown});if(url===publicUrl)return new Response(html,{status:200,headers:{'content-type':'text/html'}});if(url===rootRobots){assert.equal(new Headers(init.headers).has('authorization'),false);return new Response(null,{status:307,headers:{location}})}if(url===boundRobots){assert.equal(new Headers(init.headers).has('authorization'),false);return secondRedirect?new Response(null,{status:308,headers:{location:boundRobots}}):new Response('User-agent: *\nAllow: /\n',{status:200,headers:{'content-type':'text/plain'}})}throw Error(`unexpected ${url}`)}});
  assert.equal((await check('/documentation/robots.txt')).status,'usable');
  for(const bad of ['https://other.example/documentation/robots.txt','/other/robots.txt','/documentation/robots.txt?source=redirect','/documentation/robots.txt#fragment'])assert.equal((await check(bad)).status,'invalid',bad);
  assert.equal((await check('/documentation/robots.txt',true)).status,'invalid');
});
