import type {ArticleReviewMode,Settings,Site} from './types';

/** Site overrides are authoritative; missing legacy values inherit the global default. */
export function getArticleReviewMode(
  site:Pick<Site,'articleReviewMode'>|undefined,
  settings:Pick<Settings,'articleReviewMode'>,
):ArticleReviewMode {
  const siteMode=site?.articleReviewMode;
  if(siteMode==='manual'||siteMode==='ai')return siteMode;
  if(siteMode!==undefined)return 'manual';
  return settings.articleReviewMode==='ai'?'ai':'manual';
}
