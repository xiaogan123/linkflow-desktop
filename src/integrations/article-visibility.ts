import type {CheerioAPI} from 'cheerio';

/** Shared text visibility rules; uncertain geometry remains conservative at first acceptance. */
function tinyFontSize(token:string){
  const match=/^((?:\d+(?:\.\d*)?|\.\d+))(px|r?em|ex|ch|cap|ic|lh|rlh|%)?$/.exec(token);if(!match)return false;
  const size=Number(match[1]),unit=match[2]??'';
  return unit==='px'||unit===''?size<=1:unit==='%'?size<20:size<0.2;
}
export function articleTextStyleVisibility(property:string,value:string):'visible'|'hidden'|'unknown'{
  value=value.toLowerCase().replace(/\s*!important\s*$/,'').trim();
  const compact=value.replace(/\s+/g,'');
  const zero=/^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/i;
  if(property==='font-size'){
    if(zero.test(compact))return 'hidden';
    const pixels=/^([+]?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(compact);
    if(pixels&&Number(pixels[1])<=1)return 'unknown';
    // A tiny relative size, or a calculation with a zero or tiny term, can hide text without a computed size to prove otherwise.
    if(tinyFontSize(compact))return 'unknown';
    if(/^(?:calc|min|max|clamp)\(/.test(compact)&&(compact.match(/(?:\d+(?:\.\d*)?|\.\d+)[a-z%]*/g)??[]).some(tinyFontSize))return 'unknown';
  }
  if(property==='opacity'&&/^[+-]?(?:0+(?:\.0*)?|\.0+)%?$/.test(compact))return 'hidden';
  if(property==='color'||property==='-webkit-text-fill-color'){
    if(compact==='transparent'||/^#[a-f\d]{3}0$/i.test(compact)||/^#[a-f\d]{6}00$/i.test(compact))return 'hidden';
    // Alpha is the last comma component in legacy rgba/hsla, or follows a slash in modern color functions.
    const alpha=compact.match(/^(?:rgba?|hsla?)\([^,/]+,[^,/]+,[^,/]+,([+-]?(?:\d*\.)?\d+%?)\)$/)?.[1]
      ??compact.match(/^[a-z][a-z\d-]*\([^/]*\/([+-]?(?:\d*\.)?\d+%?)\)$/)?.[1];
    if(alpha&&zero.test(alpha))return 'hidden';
  }
  if(property==='text-indent'){
    const pixels=/^(-(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(compact);
    if(pixels&&Number(pixels[1])<=-999)return 'unknown';
  }
  if(property==='transform'||property==='translate'){
    const translations=property==='translate'?[value]:[...value.matchAll(/\btranslate(?:x|y|z|3d)?\(([^()]*)\)/g)].map(match=>match[1]);
    const offscreen=translations.some(translation=>translation.split(/[\s,]+/).some(component=>{
      const length=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|%|vw|vh|vmin|vmax|em|rem)$/.exec(component);
      return !!length&&Math.abs(Number(length[1]))>=(length[2]==='px'?999:100);
    }));
    if(offscreen)return 'unknown';
  }
  return 'visible';
}

/** Static visibility checks; never executes scripts or fetches page styles. */
export function styleConcealsArticle(style:string):boolean{
  const declarations=style.toLowerCase().replace(/\/\*[\s\S]*?\*\//g,'');
  const css=declarations.replace(/\s+/g,'');
  const hidden=/(?:^|;)(?:display:none|visibility:(?:hidden|collapse)|content-visibility:hidden|opacity:0(?:\.0+)?|font-size:0(?:\.0+)?(?:px|em|rem|%)?)(?:!important)?(?:;|$)/.test(css);
  const clipped=/(?:^|;)(?:overflow|overflow-x|overflow-y):(?:hidden|clip)(?:!important)?(?:;|$)/.test(css)
    && /(?:^|;)(?:height|max-height|width|max-width):(?:\d|\.)[^;]*(?:;|$)/.test(css);
  const transparent=/(?:^|;)(?:color|-webkit-text-fill-color):(?:transparent|rgba\([^;]*,0(?:\.0+)?\)|(?:rgb|hsl|color)[a-z-]*\([^;]*\/0(?:\.0+)?%?\))(?:!important)?(?:;|$)/.test(css);
  // A static check cannot prove that a positioned/clipped article is reachable.
  // Native acceptance separately checks its actual computed text rectangles.
  const fixed=/(?:^|;)position:fixed(?:!important)?(?:;|$)/.test(css);
  const offscreen=/(?:^|;)(?:left|right|top|bottom):-[1-9]\d{3,}(?:px|em|rem|vw|vh)(?:!important)?(?:;|$)/.test(css);
  const transformed=/(?:^|;)transform:[^;]*(?:scale(?:x|y|3d)?\(0(?:\.0+)?(?:[,)]))/.test(css);
  const textConcealed=declarations.split(';').some(declaration=>{
    const separator=declaration.indexOf(':');
    return separator>0&&articleTextStyleVisibility(declaration.slice(0,separator).trim(),declaration.slice(separator+1))!=='visible';
  });
  return hidden||clipped||transparent||fixed||offscreen||transformed||textConcealed||/(?:^|;)(?:clip:rect\(|clip-path:(?!none(?:!important)?(?:;|$)))/i.test(css);
}

// Hiding a generated pseudo-element does not hide its originating DOM element.
// Split selector lists without splitting quoted attributes or functional pseudos;
// valid element branches in a mixed list must still apply their hiding rules.
function elementSelectorBranches(selector:string):string[]{
  const branches:string[]=[];
  let start=0,quote='',brackets=0,parentheses=0,generated=false;
  for(let index=0;index<selector.length;index++){
    const char=selector[index];
    if(char==='\\'){index++;continue;}
    if(quote){if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='['){brackets++;continue;}
    if(char===']'){brackets--;continue;}
    if(brackets)continue;
    // Within functional pseudos, a browser may discard only the unsupported
    // branch (for example :is(article, ::before)); never skip its whole rule.
    if(parentheses===0&&char===':'&&(/^::/.test(selector.slice(index))||/^:(?:before|after|first-line|first-letter)(?![\w-])/i.test(selector.slice(index))))generated=true;
    if(char==='(')parentheses++;
    if(char===')')parentheses--;
    if(char===','&&parentheses===0){
      if(!generated)branches.push(selector.slice(start,index));
      start=index+1;generated=false;
    }
  }
  if(!generated)branches.push(selector.slice(start));
  return branches.map(branch=>branch.trim()).filter(Boolean);
}

/** Apply explicit hiding declarations from embedded styles, conservatively. */
export function applyDeclaredArticleVisibility($:CheerioAPI):void{
  $('style').each((_,element)=>{
    const css=$(element).text().replace(/\/\*[\s\S]*?\*\//g,'');
    for(const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      if(!styleConcealsArticle(rule[2]))continue;
      const selector=rule[1].trim();
      if(selector.startsWith('@'))continue;
      // A conditional hiding rule is treated as hidden: a static verifier
      // cannot establish the visitor viewport or media query state.
      for(const branch of elementSelectorBranches(selector))$(branch).attr('hidden','');
    }
  });
}

export function pageRobotsDirectives($:CheerioAPI,robotsHeader=''):Set<string>{
  const directives=new Set<string>();
  // A user-agent prefix scopes all following directives on that header line.
  // Each raw header and each meta element starts an independent scope.
  const values=[...robotsHeader.split(/\r?\n/),...$('meta[name]').toArray()
    .filter(element=>['robots','googlebot','bingbot'].includes(($(element).attr('name')??'').trim().toLowerCase()))
    .map(element=>$(element).attr('content')??'')];
  const namedDirectives=new Set(['max-snippet','max-image-preview','max-video-preview','unavailable_after']);
  for(const value of values){
    let applicable=true;
    for(let clause of value.toLowerCase().split(/[,;]/)){
      const prefix=/^\s*([a-z*][a-z0-9_*-]*)\s*:\s*(.*)$/.exec(clause);
      if(prefix&&!namedDirectives.has(prefix[1])){
        applicable=['*','googlebot','bingbot'].includes(prefix[1]);
        clause=prefix[2];
      }
      if(applicable)for(const token of clause.trim().split(/\s+/))if(token)directives.add(token);
    }
  }
  return directives;
}

/** Explicit publishing restrictions are not proof of absence or search discovery. */
export function publicPagePolicy($:CheerioAPI, pageUrl?:string, robotsHeader=''):{valid:boolean;nofollow:boolean}{
  const directives=pageRobotsDirectives($,robotsHeader);
  const nofollow=directives.has('nofollow')||directives.has('none');
  if(directives.has('noindex')||directives.has('none')
    ||$('meta[http-equiv]').toArray().some(element=>($(element).attr('http-equiv')??'').trim().toLowerCase()==='refresh'))return {valid:false,nofollow};
  if(pageUrl){
    const canonicals=$('link[rel]').toArray().filter(element=>($(element).attr('rel')??'').toLowerCase().split(/\s+/).includes('canonical'));
    try{
      if(canonicals.length>1||canonicals.some(element=>!$(element).attr('href')||new URL($(element).attr('href')!,pageUrl).href!==new URL(pageUrl).href))return {valid:false,nofollow};
    }catch{return {valid:false,nofollow};}
  }
  return {valid:true,nofollow};
}

export function withPageNofollow(rel:string,nofollow:boolean):string{
  const values=new Set(rel.trim().toLowerCase().split(/\s+/).filter(Boolean));
  if(nofollow)values.add('nofollow');
  return [...values].join(' ');
}

export function elementConcealed($:CheerioAPI,element:Parameters<CheerioAPI>[0]):boolean{
  const node=$(element),classes=(node.attr('class')??'').split(/\s+/);
  return node.is('head,script,style,template,noscript,[hidden],[inert],input[type="hidden"],dialog:not([open]),details:not([open])')
    ||node.attr('aria-hidden')?.trim().toLowerCase()==='true'
    ||classes.some(value=>['hidden','invisible','collapse','sr-only'].includes(value))
    ||styleConcealsArticle(node.attr('style')??'');
}
