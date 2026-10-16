import { load } from 'cheerio';
import { marked, type Token, type Tokens } from 'marked';

/** Remove only a generated, standalone H1 that duplicates the separate public title. */
export function stripDuplicateGeneratedH1(title: string, body: string): string {
  let tokens: Token[];
  try { tokens = marked.lexer(body, { gfm: true }) as Token[]; }
  catch { return body; }
  const children = (token: Token): Token[] => {
    const nested = token as Token & { tokens?: Token[]; items?: Array<{ tokens?: Token[] }> };
    return [...(nested.tokens ?? []), ...(nested.items ?? []).flatMap(item => item.tokens ?? [])];
  };
  const h1s: Tokens.Heading[] = [];
  const visit = (items: Token[]): void => {
    for (const token of items) {
      if (token.type === 'heading' && 'depth' in token && token.depth === 1 && 'text' in token) h1s.push(token as Tokens.Heading);
      else visit(children(token));
    }
  };
  visit(tokens);
  if (h1s.length !== 1 || !tokens.includes(h1s[0]) || tokens.map(token => token.raw).join('') !== body) return body;
  const heading = h1s[0];
  try {
    const rendered = marked.parseInline(heading.text, { async: false, gfm: true });
    if (typeof rendered !== 'string' || load(rendered, undefined, false).text().trim() !== title.trim()) return body;
  } catch { return body; }
  let offset = 0;
  for (const token of tokens) {
    if (token === heading) {
      const cleaned = (body.slice(0, offset) + body.slice(offset + token.raw.length)).trim();
      return cleaned || body;
    }
    offset += token.raw.length;
  }
  return body;
}
