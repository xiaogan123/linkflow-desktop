import type {Channel,ChannelAudience,Qualification,Site} from '../shared/types';
import {BATCH5_MESSAGES} from '../shared/batch5-messages';

export const qualificationLabels:Record<Qualification,string>={
 software:'可用的软件产品',developer:'本人维护的开发项目',portfolio:'本人创作的作品集',publication:'本人运营的出版物',business:'真实公司或服务业务',localBusiness:'符合资格的本地商家',
 techContent:'有实质内容的技术文章',wordpressPlugin:'可用且许可合规的 WordPress 插件',drupalProject:'真实 Drupal 模块或主题',javascriptPackage:'可安装的 JavaScript 包',pythonPackage:'可安装的 Python 包',dotnetPackage:'可安装的 .NET 包',rustCrate:'可安装的 Rust crate',phpPackage:'可安装的 Composer/PHP 包',dartPackage:'可安装的 Dart/Flutter 包',rubyGem:'可安装的 Ruby gem',containerImage:'可运行的容器镜像',aiArtifact:'真实模型、数据集或 AI 演示',firefoxExtension:'可用的 Firefox 扩展',vscodeExtension:'可用的 VS Code 扩展',jetbrainsPlugin:'可用的 JetBrains 插件',linuxApp:'可分发的 Linux 应用',androidFoss:'可从自由源码构建的 Android 应用',openSource:'许可合规的真实开源项目',gameAsset:'本人创作的游戏或数字作品',
};
const requirements:Record<string,Qualification[]>={
 'product-hunt':['software'],alternativeto:['software'],g2:['software'],saashub:['software'],capterra:['software'],uneed:['software'],betalist:['software'],peerlist:['software'],stackshare:['software'],
 'github-gist':['developer'],github:['developer'],gitlab:['developer'],codeberg:['openSource'],npm:['javascriptPackage'],pypi:['pythonPackage'],nuget:['dotnetPackage'],'crates-io':['rustCrate'],sourceforge:['openSource'],'docker-hub':['containerImage'],huggingface:['aiArtifact'],
 'firefox-addons':['firefoxExtension'],'vscode-marketplace':['vscodeExtension'],'jetbrains-marketplace':['jetbrainsPlugin'],flathub:['linuxApp'],fdroid:['androidFoss'],'snap-store':['linuxApp'],'show-hn':['software'],
 'itch-io':['gameAsset'],behance:['portfolio'],artstation:['portfolio'],substack:['publication'],paragraph:['publication'],
 hashnode:['techContent'],hackernoon:['techContent'],'wordpress-plugins':['wordpressPlugin'],drupal:['drupalProject'],packagist:['phpPackage'],'pub-dev':['dartPackage'],rubygems:['rubyGem'],
 clutch:['business'],wellfound:['business'],'indie-hackers':['software'],'google-business':['localBusiness'],'bing-places':['localBusiness'],'apple-business':['business'],'yelp-business':['localBusiness'],
};

/** A declaration supplies a specific product form; it never proves platform approval. */
export function requirementsFor(channel:Channel):Qualification[]{return channel.requirements??requirements[channel.id]??[]}
export function validQualificationUrl(proof:string|undefined):boolean{
 try{const u=new URL(proof||'');return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.hostname.includes('.')&&!/^\d+(?:\.\d+){3}$/.test(u.hostname)&&!u.hostname.includes(':')&&!/(?:^|\.)(?:localhost|local|internal|invalid)$/.test(u.hostname)}catch{return false}
}
/** Older custom channels remain readable, but product-only qualifications never imply a finance audience. */
export function channelAudience(channel:Pick<Channel,'categories'|'requirements'|'audience'>):ChannelAudience[]{
 if(channel.audience!==undefined)return channel.audience;
 if(channel.requirements?.includes('localBusiness'))return ['local_business'];
 if(channel.requirements?.some(value=>value==='software'||value==='developer'))return ['software'];
 if(channel.categories.includes('general'))return ['general'];
 if(channel.categories.includes('finance'))return ['finance'];
 if(channel.categories.includes('software')||channel.categories.includes('developer')||channel.categories.includes('ai'))return ['software'];
 if(channel.categories.includes('design'))return ['design'];
 return ['general'];
}
export function channelLanguageMatches(site:Pick<Site,'language'>,channel:Pick<Channel,'languages'>):boolean{
 const language=site.language.toLowerCase().split('-')[0];
 if(!Array.isArray(channel.languages))return true;
 return channel.languages.includes('*')||!!language&&channel.languages.some(value=>value.toLowerCase().split('-')[0]===language);
}
/** Hard suitability is shared by discovery, scheduling, and capability counts. */
export function channelSuitability(site:Pick<Site,'category'|'language'>,channel:Channel):{eligible:boolean;reason:string}{
 if(channel.promotionPolicy==='forbidden')return {eligible:false,reason:BATCH5_MESSAGES.promotionForbidden};
 if(site.category==='finance'&&!channelAudience(channel).some(value=>value==='general'||value==='finance'))return {eligible:false,reason:BATCH5_MESSAGES.audienceMismatch};
 if(!channelLanguageMatches(site,channel))return {eligible:false,reason:BATCH5_MESSAGES.languageMismatch};
 return {eligible:true,reason:''};
}
export function eligibilityFor(site:Site,channel:Channel):{eligible:boolean;reason:string;requirement?:Qualification}{
 if(!channel.enabled)return {eligible:false,reason:'该平台目前停用，请查看官方规则'};
 const suitability=channelSuitability(site,channel);if(!suitability.eligible)return suitability;
 if(channel.id==='paragraph'&&site.paragraph?.publicationId&&validQualificationUrl(site.paragraph.url))return {eligible:true,reason:'已连接本人出版物；AI 将结合出版物公开内容核对原创用途、相关性与附带商业披露',requirement:'publication'};
 if(channel.id==='github-gist'&&(validQualificationUrl(site.qualifications?.developer)||validQualificationUrl(site.qualifications?.techContent)))return {eligible:true,reason:'有公开技术材料；发布前仍会核对真实性、可复用价值和与本站关系',requirement:validQualificationUrl(site.qualifications?.developer)?'developer':'techContent'};
 const required=requirementsFor(channel);
 const missing=required.find(q=>!validQualificationUrl(site.qualifications?.[q]));
 if(missing)return {eligible:false,reason:`需要确认${qualificationLabels[missing]}并提供资料网址；一般软件或网站网址不能替代对应资格`,requirement:missing};
 return {eligible:true,reason:required.length?`已声明${required.map(q=>qualificationLabels[q]).join('、')}；资料内容及平台资格仍须核对`:'可准备独立有用的原创文章；不能承诺平台接受或搜索收录',requirement:required[0]};
}
export function requiresArticleReview(_site:Site,channel:Channel){return channel.articleRequired}
