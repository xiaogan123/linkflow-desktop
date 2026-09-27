import type {Channel,Qualification,Site} from '../shared/types';

export const qualificationLabels:Record<Qualification,string>={software:'可用的软件产品',developer:'本人维护的开发项目',portfolio:'本人创作的作品集',publication:'本人运营的出版物',business:'真实公司或服务业务',localBusiness:'符合资格的本地商家'};
const requirements:Record<string,Qualification>={
 'product-hunt':'software',alternativeto:'software',g2:'software',saashub:'software',capterra:'software',
 'github-gist':'developer',github:'developer',gitlab:'developer',codeberg:'developer',npm:'developer',pypi:'developer',nuget:'developer','crates-io':'developer',sourceforge:'developer','docker-hub':'developer',huggingface:'developer',
 'firefox-addons':'software','vscode-marketplace':'software','jetbrains-marketplace':'software',flathub:'software',fdroid:'software','snap-store':'software','show-hn':'software',
 'itch-io':'portfolio',behance:'portfolio',artstation:'portfolio',substack:'publication',gravatar:'publication',linktree:'publication',
 clutch:'business',wellfound:'business','indie-hackers':'software','google-business':'localBusiness','bing-places':'localBusiness','apple-business':'business','yelp-business':'localBusiness',
};
export function eligibilityFor(site:Site,channel:Channel):{eligible:boolean;reason:string;requirement?:Qualification}{
 if(!channel.enabled)return {eligible:false,reason:'该渠道目前停用，请查看官方规则'};
 const requirement=requirements[channel.id];
 if(requirement){
  const proof=site.qualifications?.[requirement];
  let valid=false;try{const u=new URL(proof||'');valid=u.protocol==='https:'&&!u.username&&!u.password&&!!u.hostname.includes('.')}catch{}
  if(!valid)return {eligible:false,reason:`需要确认${qualificationLabels[requirement]}并提供资料网址；网站主题相关不代表具备资格`,requirement};
 }
 return {eligible:true,reason:requirement?`已提供${qualificationLabels[requirement]}资料；仍须满足渠道细则`:'可准备独立有用的原创文章；不能承诺平台接受或搜索收录',requirement};
}
export function requiresArticleReview(site:Site,channel:Channel){return channel.articleRequired&&(channel.id==='github-gist'||site.category==='finance'||/加密|返佣|交易|投资|币安|crypto|binance|trading|investment|affiliate/i.test(site.name+' '+site.description))}
