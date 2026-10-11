export const HTML_APP_TERMS_URL='https://ht-ml.app/terms' as const;
export const HTML_APP_PUBLIC_NOTICE_VERSION=1 as const;

export interface HtmlAppPublicNoticeAcceptance {
  version:typeof HTML_APP_PUBLIC_NOTICE_VERSION;
  acceptedAt:string;
  termsUrl:typeof HTML_APP_TERMS_URL;
}

export interface HtmlAppPublicNoticeAcknowledgement {
  version:typeof HTML_APP_PUBLIC_NOTICE_VERSION;
  termsUrl:typeof HTML_APP_TERMS_URL;
  fullContentPublic:true;
  crawlingAndCopyingPossible:true;
  bestEffortNoRetentionGuarantee:true;
}

export const HTML_APP_PUBLIC_NOTICE_ACKNOWLEDGEMENT:HtmlAppPublicNoticeAcknowledgement={
  version:HTML_APP_PUBLIC_NOTICE_VERSION,
  termsUrl:HTML_APP_TERMS_URL,
  fullContentPublic:true,
  crawlingAndCopyingPossible:true,
  bestEffortNoRetentionGuarantee:true,
};

export function validHtmlAppPublicNoticeAcknowledgement(value:unknown):value is HtmlAppPublicNoticeAcknowledgement {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join(',')==='bestEffortNoRetentionGuarantee,crawlingAndCopyingPossible,fullContentPublic,termsUrl,version'
    &&item.version===HTML_APP_PUBLIC_NOTICE_VERSION&&item.termsUrl===HTML_APP_TERMS_URL
    &&item.fullContentPublic===true&&item.crawlingAndCopyingPossible===true&&item.bestEffortNoRetentionGuarantee===true;
}

export function htmlAppPublicNoticeAccepted(value:unknown):value is HtmlAppPublicNoticeAcceptance {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  if(Object.keys(item).sort().join(',')!=='acceptedAt,termsUrl,version'||item.version!==HTML_APP_PUBLIC_NOTICE_VERSION||item.termsUrl!==HTML_APP_TERMS_URL||typeof item.acceptedAt!=='string')return false;
  const time=Date.parse(item.acceptedAt);
  return Number.isFinite(time)&&new Date(time).toISOString()===item.acceptedAt;
}
