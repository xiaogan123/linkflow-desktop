type SiteBrand={name?:string;domain?:string;url?:string};

// A stable public label suffix, not an authentication or integrity digest.
function labelSuffix(value:string):string{
  let hash=0x811c9dc5;
  for(const character of value.toLowerCase())hash=Math.imul(hash^character.codePointAt(0)!,0x01000193);
  return (hash>>>0).toString(16).padStart(8,'0');
}

function asciiStem(value:string):string {
  return value.normalize('NFKD').toLowerCase().replace(/linkflow/gi,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

/** A stable public label based on the site, with a short local identity suffix. */
export function publicIdentitySlug(site:SiteBrand,seed:string,maxLength=32):string {
  const suffix=labelSuffix(seed);
  let hostname='';
  try{hostname=new URL(site.url??`https://${site.domain??''}`).hostname.replace(/^www\./,'')}catch{}
  const host=hostname.split('.')[0]??'';
  const candidate=asciiStem(site.name??'')||asciiStem(host)||'site';
  const brand=/^[a-z]/.test(candidate)?candidate:`site-${candidate}`;
  const format=Number.parseInt(labelSuffix(hostname||site.name||'').slice(-2),16)%4;
  const extra=[1,0,2,1][format];
  const stem=brand.slice(0,Math.max(2,maxLength-suffix.length-extra)).replace(/-+$/,'')||'site';
  switch(format){
    case 1:return `${stem}${suffix}`;
    case 2:return `${stem}-${suffix.slice(0,4)}-${suffix.slice(4)}`;
    case 3:return `${stem}${suffix.slice(0,4)}-${suffix.slice(4)}`;
    default:return `${stem}-${suffix}`;
  }
}

/** Use the same neutral site label when an old tool name appears in public prose. */
export function neutralPublicIdentityText(site:SiteBrand,seed:string,value:string):string {
  return value.replace(/linkflow/gi,publicIdentitySlug(site,seed,32).replaceAll('-',' '));
}

type SiteProfileSource=SiteBrand&{description?:string};

function plainName(site:SiteProfileSource):string{
  let host='';try{host=new URL(site.url??`https://${site.domain??''}`).hostname.replace(/^www\./,'')}catch{}
  return (site.name??'').replace(/linkflow/gi,'').replace(/[\r\n<>]/g,' ').replace(/\s+/g,' ').trim().slice(0,48)||host||'Site';
}

/** The site's own one-sentence summary, without links, digits-heavy codes or promotional wording. */
function siteSummary(site:SiteProfileSource,max:number):string{
  const first=(site.description??'').replace(/https?:\/\/\S+/g,'').replace(/[\r\n<>]/g,' ').split(/(?<=[。！？.!?])\s*/u)[0]?.trim()??'';
  if(!first||/邀请|推荐码|返佣|返现|优惠码|invite|referral|promo|affiliate/i.test(first)||/\b(?=[A-Z0-9]*\d)[A-Z0-9]{5,}\b/.test(first))return '';
  return [...first].slice(0,max).join('');
}

/**
 * Public profile text for agent-community accounts. Each site gets its own name and summary; the
 * operator disclosure these communities require stays, phrased one of several ways per site.
 */
export function agentProfileText(site:SiteProfileSource){
  const name=plainName(site),summary=siteSummary(site,180);
  const variant=Number.parseInt(labelSuffix(`${site.domain??''}:${name}:profile`).slice(-2),16);
  const lead=[`Human-operated AI assistant for ${name}.`,`An AI assistant run by the people behind ${name}.`,`Operated for ${name} by a human editor with AI help.`][variant%3];
  const tail=[`Posts for ${name} disclose that tie and involve no autonomous financial activity.`,`Each post names its link to ${name}; the assistant never trades or moves funds.`,`Every ${name} post states the relationship, and no financial action is taken on its own.`][(variant>>2)%3];
  const about=summary||[`Notes and explainers from ${name}.`,`Reviewed write-ups related to ${name}.`,`Plain-language notes from ${name}.`][(variant>>4)%3];
  return {
    displayName:name,
    bio:[...about].slice(0,160).join(''),
    tagline:[...`${name} · ${[`notes`,`explainers`,`updates`][variant%3]}`].slice(0,80).join(''),
    description:[`${lead} ${about} ${tail}`].join('').slice(0,900),
  };
}

/** Agents Wiki identity for a new registration; an existing account keeps the identity it registered with. */
export function agentsWikiIdentityText(site:SiteProfileSource){
  const name=plainName(site),variant=Number.parseInt(labelSuffix(`${site.domain??''}:${name}:wiki`).slice(-2),16);
  return {
    name:[...`${name} contributor`].slice(0,100).join(''),
    publicDisclosure:[`AI-assisted contributor run by the owner of ${name}; each submission states its relationship to the cited project.`,`Contributions are prepared with AI help for the ${name} site owner, and each one discloses that relationship.`,`Operated by the people behind ${name} with AI assistance; every submission discloses its tie to the project.`][variant%3].slice(0,500),
  };
}
