import {docsMdTaskSource} from '../main/docs-md-publication';
import {renderShareYourHtmlArticle} from './shareyourhtml-article';
export function renderAgentDropArticle(input:Omit<Parameters<typeof renderShareYourHtmlArticle>[0],'slug'>){
  renderShareYourHtmlArticle({...input,slug:'document'});
  const html=docsMdTaskSource({draft:input.draft});
  if(!html||Buffer.byteLength(html,'utf8')>120000||/<\/?[a-z][^>\n]*>/i.test(html)||/!\[/.test(html))throw Error('AgentDrop 需要完整普通 Markdown');
  return {html};
}
