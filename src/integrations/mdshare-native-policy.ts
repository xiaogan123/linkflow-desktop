import {MDSHARE_ORIGIN} from './mdshare';

export const MDSHARE_STATIC_RESOURCES = [
  ['/favicon.png', ['image', 'other']],
  ['/logo.png', ['image', 'other']],
  ['/assets/index-CkGjfRvZ.js', ['script', 'other']],
  ['/assets/rolldown-runtime-hePW80VL.js', ['script', 'other']],
  ['/assets/preload-helper-Czpn1I53.js', ['script', 'other']],
  ['/assets/Icon-BUTRvpwR.js', ['script', 'other']],
  ['/assets/MsUi-C_PvAIAe.js', ['script', 'other']],
  ['/assets/format-BdMnDZJ9.js', ['script', 'other']],
  ['/assets/defineProperty-BbfpZ9Tg.js', ['script', 'other']],
  ['/assets/api-B5iM7PgC.js', ['script', 'other']],
  ['/assets/time-D3eG3S-L.js', ['script', 'other']],
  ['/assets/Collapse-BgrPcfu1.js', ['script', 'other']],
  ['/assets/Controls-CkwmlZkF.js', ['script', 'other']],
  ['/assets/EmbedModal-CTRLpDHS.js', ['script', 'other']],
  ['/assets/Layout-BpoWnYcX.js', ['script', 'other']],
  ['/assets/Preview-DN7QZBZv.js', ['script', 'other']],
  ['/assets/ReadingMenu-Di2S-GkJ.js', ['script', 'other']],
  ['/assets/Reveal-BoX4Igcg.js', ['script', 'other']],
  ['/assets/StatTile-BdpWnsPs.js', ['script', 'other']],
  ['/assets/SwapFade-serKlBfv.js', ['script', 'other']],
  ['/assets/Tabs-ygrpMWxd.js', ['script', 'other']],
  ['/assets/TiltCard-BfQomT8r.js', ['script', 'other']],
  ['/assets/TruncatedText-CRoeQeE3.js', ['script', 'other']],
  ['/assets/UserPicker-BZnzRRrJ.js', ['script', 'other']],
  ['/assets/ViewerPage-BuZTxUFZ.js', ['script', 'other']],
  ['/assets/dist-j6OMAjqb.js', ['script', 'other']],
  ['/assets/wasm-BnjxR4X6.js', ['script', 'other']],
  ['/assets/github-dark-C-LZuMrd.js', ['script', 'other']],
  ['/assets/github-light-EUqPIrTm.js', ['script', 'other']],
  ['/assets/json-DAgxKhMr.js', ['script', 'other']],
  ['/assets/languages-BxbZXZE_.js', ['script', 'other']],
  ['/assets/markdown-L84MfFBT.js', ['script', 'other']],
  ['/assets/stateKind-BnTMIeJ2.js', ['script', 'other']],
  ['/assets/syntax-B0KuvG8F.js', ['script', 'other']],
  ['/assets/workspaceIcons-CDwFvAr7.js', ['script', 'other']],
  ['/assets/Tabs-Bhz15TE7.css', ['stylesheet', 'other']],
  ['/assets/Layout-yp_jWhVI.css', ['stylesheet', 'other']],
  ['/assets/Controls-BwCdiLCz.css', ['stylesheet', 'other']],
  ['/assets/Preview-B_HojRFr.css', ['stylesheet', 'other']],
  ['/assets/StatTile-CYcLRw30.css', ['stylesheet', 'other']],
  ['/assets/ReadingMenu-Cf-hGyFx.css', ['stylesheet', 'other']],
  ['/assets/EmbedModal-Dk8599h-.css', ['stylesheet', 'other']],
  ['/assets/ViewerPage-DVLxKoAi.css', ['stylesheet', 'other']],
  ['/assets/Workspaces-C9RTTlTv.css', ['stylesheet', 'other']],
  ['/assets/index-CFy9ywaT.css', ['stylesheet', 'other']],
] as const;

export interface MDShareAllowedRequest {
  url:string;
  resourceTypes:readonly string[];
}

export function exactMDSharePublicUrl(value:string,origin=MDSHARE_ORIGIN):boolean{
  try{const url=new URL(value);return url.origin===origin&&!url.search&&!url.hash&&/^\/s\/[A-Za-z0-9]{12}$/.test(url.pathname)}catch{return false}
}

export function mdshareProductionAllowlist(url:string,origin:string):MDShareAllowedRequest[]{
  const parsed=new URL(url),slug=parsed.pathname.slice('/s/'.length);
  return [
    {url,resourceTypes:['mainFrame']},
    ...MDSHARE_STATIC_RESOURCES.map(([pathname,resourceTypes])=>({url:`${origin}${pathname}`,resourceTypes})),
    {url:`${origin}/og/s/${slug}.png`,resourceTypes:['image','other']},
    // Viewer startup calls the public service-status endpoint through the
    // retained official api client. Keep this one read-only route exact.
    {url:`${origin}/api/v1/status`,resourceTypes:['xhr']},
    // The anonymous auth provider probes the current session before it can
    // render the public viewer. This is an exact GET and carries no mutation.
    {url:`${origin}/api/v1/auth/me`,resourceTypes:['xhr']},
    // The viewer's anonymous theme provider reads the public theme effect
    // preferences through this single exact endpoint.
    {url:`${origin}/api/v1/theme-effects`,resourceTypes:['xhr']},
    {url:`${origin}/api/v1/snippets/${slug}`,resourceTypes:['xhr']},
    {url:`${origin}/api/v1/snippets/${slug}/comments`,resourceTypes:['xhr']},
    {url:`${origin}/api/v1/snippets/${slug}/revisions`,resourceTypes:['xhr']},
    {url:`${origin}/api/v1/snippets/${slug}/stats`,resourceTypes:['xhr']},
    {url:`${origin}/api/v1/snippets/${slug}/related`,resourceTypes:['xhr']},
  ];
}
