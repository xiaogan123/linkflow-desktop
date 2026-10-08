import type {CheerioAPI} from 'cheerio';

/** Static visibility checks; never executes scripts or fetches page styles. */
export function styleConcealsArticle(style:string):boolean{
  const css=style.toLowerCase().replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,'');
  const hidden=/(?:^|;)(?:display:none|visibility:(?:hidden|collapse)|content-visibility:hidden|opacity:0|font-size:0(?:px|em|rem|%)?)(?:!important)?(?:;|$)/.test(css);
  const clipped=/(?:^|;)(?:overflow|overflow-y):(?:hidden|clip)(?:!important)?(?:;|$)/.test(css)
    && /(?:^|;)(?:height|max-height):(?:\d|\.)[^;]*(?:;|$)/.test(css);
  return hidden||clipped||/(?:^|;)(?:clip:rect\(|clip-path:inset\()/i.test(css);
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
      $(selector).attr('hidden','');
    }
  });
}

export function pageRobotsDirectives($:CheerioAPI,robotsHeader=''):Set<string>{
  const values=[robotsHeader,...$('meta[name]').toArray()
    .filter(element=>['robots','googlebot','bingbot'].includes(($(element).attr('name')??'').trim().toLowerCase()))
    .map(element=>$(element).attr('content')??'')].join(',');
  const directives=new Set<string>();
  for(let clause of values.toLowerCase().split(/[,;]/)){
    const prefix=/^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/.exec(clause);
    if(prefix){
      if(['max-image-preview','max-snippet','max-video-preview','unavailable_after'].includes(prefix[1]))continue;
      clause=prefix[2];
    }
    for(const token of clause.trim().split(/\s+/))directives.add(token);
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
  return node.is('head,script,style,template,noscript,[hidden],[inert],[aria-hidden="true"],dialog:not([open]),details:not([open])')
    ||classes.some(value=>['hidden','invisible','collapse','sr-only'].includes(value))
    ||styleConcealsArticle(node.attr('style')??'');
}
