import {renderHtml2LinkArticle,type Html2LinkRenderedArticle} from './html2link-article';
import {createHtml2LinkPublication,type Html2LinkCreateDependencies,type Html2LinkCreateResult,type Html2LinkPersistence} from './html2link';
import {verifyHtml2LinkPublication,type Html2LinkPublicEvidencePersistence,type Html2LinkVerification,type Html2LinkVerifyDependencies} from './html2link-verifier';
import type {ShareYourHtmlArticleDraft} from './shareyourhtml-article';

export interface Html2LinkAcceptancePersistence extends Html2LinkPersistence,Html2LinkPublicEvidencePersistence {}
export interface Html2LinkAcceptanceDependencies extends Html2LinkCreateDependencies,Omit<Html2LinkVerifyDependencies,'evidence'> {}
export type Html2LinkAcceptanceResult=
  |{status:'not_published';article:Html2LinkRenderedArticle;create:Exclude<Html2LinkCreateResult,{status:'created'}>}
  |{status:'published_unverified';article:Html2LinkRenderedArticle;create:Extract<Html2LinkCreateResult,{status:'created'}>;verification:Exclude<Html2LinkVerification,{status:'usable'}>}
  |{status:'accepted';article:Html2LinkRenderedArticle;create:Extract<Html2LinkCreateResult,{status:'created'}>;verification:Extract<Html2LinkVerification,{status:'usable'}>};

/**
 * One-shot acceptance entry. External writing is disabled unless this exact call
 * receives allowExternalWrite:true after independent content review.
 */
export async function runHtml2LinkAcceptance(input:{operationId:string;reviewed:true;draft:ShareYourHtmlArticleDraft;targetUrl:string;language:string},persistence:Html2LinkAcceptancePersistence,deps:Html2LinkAcceptanceDependencies={}):Promise<Html2LinkAcceptanceResult>{
  const article=renderHtml2LinkArticle({draft:input.draft,targetUrl:input.targetUrl,language:input.language});
  const create=await createHtml2LinkPublication({operationId:input.operationId,reviewed:input.reviewed,article},persistence,deps);
  if(create.status!=='created')return {status:'not_published',article,create};
  const verification=await verifyHtml2LinkPublication(create.receipt,article,{fetch:deps.fetch,signal:deps.signal,timeoutMs:deps.timeoutMs,now:deps.now,evidence:persistence});
  return verification.status==='usable'?{status:'accepted',article,create,verification}:{status:'published_unverified',article,create,verification};
}
