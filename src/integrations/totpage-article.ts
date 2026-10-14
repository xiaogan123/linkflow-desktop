import {renderShareYourHtmlArticle,type ShareYourHtmlArticleInput} from './shareyourhtml-article';

/** Passive self-contained HTML for the official raw-document publishing API. */
export function renderTotpageArticle(input:Omit<ShareYourHtmlArticleInput,'slug'>){return renderShareYourHtmlArticle({...input,slug:'totpage-publication',allowLinkFragments:true})}
