/** The host may append one passive Cloudflare analytics module after our exact
 * document body. Accept only that envelope; never normalize article/CSS bytes.
 * The module is not executed by local visibility verification. */
export function yourwebsHostedDocument(received:string,expected:string):{html:string;hostAnalytics:boolean}|undefined{
  if(received===expected)return {html:expected,hostAnalytics:false};
  const end='</body></html>';
  if(!expected.endsWith(end))return;
  const prefix=expected.slice(0,-end.length);
  if(!received.startsWith(prefix))return;
  const tail=received.slice(prefix.length),match=/^<script(\s[^>]*)><\/script>\n<\/body><\/html>$/.exec(tail);
  if(!match)return;
  const attrs=new Map<string,string>(),pattern=/\s+([a-z][a-z0-9-]*)=(?:"([^"]*)"|'([^']*)')/gy;
  let position=0;
  while(position<match[1].length){pattern.lastIndex=position;const a=pattern.exec(match[1]);if(!a||attrs.has(a[1]))return;attrs.set(a[1],a[2]??a[3]);position=pattern.lastIndex}
  if([...attrs.keys()].sort().join(',')!=='crossorigin,data-cf-beacon,integrity,src,type'||attrs.get('crossorigin')!=='anonymous'||attrs.get('type')!=='module'||!/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[0-9a-f]{32,64}$/.test(attrs.get('src')??'')||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(attrs.get('integrity')??''))return;
  // Strict raw JSON shape avoids duplicate fields and executable attributes.
  if(!/^\{"version":"\d{4}\.\d{1,2}\.\d{1,2}","token":"[0-9a-f]{32}","r":1,"spa":2\}$/.test(attrs.get('data-cf-beacon')??''))return;
  return {html:expected,hostAnalytics:true};
}
