import type {Channel,Qualification,Site} from '../shared/types';

export const qualificationLabels:Record<Qualification,string>={
 software:'可用的软件产品',developer:'本人维护的开发项目',portfolio:'本人创作的作品集',publication:'本人运营的出版物',business:'真实公司或服务业务',localBusiness:'符合资格的本地商家',
 techContent:'有实质内容的技术文章',wordpressPlugin:'可用且许可合规的 WordPress 插件',drupalProject:'真实 Drupal 模块或主题',javascriptPackage:'可安装的 JavaScript 包',pythonPackage:'可安装的 Python 包',dotnetPackage:'可安装的 .NET 包',rustCrate:'可安装的 Rust crate',phpPackage:'可安装的 Composer/PHP 包',dartPackage:'可安装的 Dart/Flutter 包',rubyGem:'可安装的 Ruby gem',containerImage:'可运行的容器镜像',aiArtifact:'真实模型、数据集或 AI 演示',firefoxExtension:'可用的 Firefox 扩展',vscodeExtension:'可用的 VS Code 扩展',jetbrainsPlugin:'可用的 JetBrains 插件',linuxApp:'可分发的 Linux 应用',androidFoss:'可从自由源码构建的 Android 应用',openSource:'许可合规的真实开源项目',gameAsset:'本人创作的游戏或数字作品',
};
const requirements:Record<string,Qualification[]>={
 'product-hunt':['software'],alternativeto:['software'],g2:['software'],saashub:['software'],capterra:['software'],uneed:['software'],betalist:['software'],peerlist:['software'],stackshare:['software'],
 'github-gist':['developer'],github:['developer'],gitlab:['developer'],codeberg:['openSource'],npm:['javascriptPackage'],pypi:['pythonPackage'],nuget:['dotnetPackage'],'crates-io':['rustCrate'],sourceforge:['openSource'],'docker-hub':['containerImage'],huggingface:['aiArtifact'],
 'firefox-addons':['firefoxExtension'],'vscode-marketplace':['vscodeExtension'],'jetbrains-marketplace':['jetbrainsPlugin'],flathub:['linuxApp'],fdroid:['androidFoss'],'snap-store':['linuxApp'],'show-hn':['software'],
 'itch-io':['gameAsset'],behance:['portfolio'],artstation:['portfolio'],substack:['publication'],gravatar:['publication'],linktree:['publication'],blogger:['publication'],paragraph:['publication'],
 hashnode:['techContent'],hackernoon:['techContent'],'wordpress-plugins':['wordpressPlugin'],drupal:['drupalProject'],packagist:['phpPackage'],'pub-dev':['dartPackage'],rubygems:['rubyGem'],
 clutch:['business'],wellfound:['business'],'indie-hackers':['software'],'google-business':['localBusiness'],'bing-places':['localBusiness'],'apple-business':['business'],'yelp-business':['localBusiness'],
};

/** A declaration supplies a specific product form; it never proves platform approval. */
export function requirementsFor(channel:Channel):Qualification[]{return channel.requirements??requirements[channel.id]??[]}
export function validQualificationUrl(proof:string|undefined):boolean{
 try{const u=new URL(proof||'');return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&u.hostname.includes('.')&&!/^\d+(?:\.\d+){3}$/.test(u.hostname)&&!u.hostname.includes(':')&&!/(?:^|\.)(?:localhost|local|internal|invalid)$/.test(u.hostname)}catch{return false}
}
export function eligibilityFor(site:Site,channel:Channel):{eligible:boolean;reason:string;requirement?:Qualification}{
 if(!channel.enabled)return {eligible:false,reason:'该渠道目前停用，请查看官方规则'};
 const required=requirementsFor(channel);
 const missing=required.find(q=>!validQualificationUrl(site.qualifications?.[q]));
 if(missing)return {eligible:false,reason:`需要确认${qualificationLabels[missing]}并提供资料网址；一般软件或网站网址不能替代对应资格`,requirement:missing};
 return {eligible:true,reason:required.length?`已声明${required.map(q=>qualificationLabels[q]).join('、')}；资料内容及平台资格仍须核对`:'可准备独立有用的原创文章；不能承诺平台接受或搜索收录',requirement:required[0]};
}
export function requiresArticleReview(site:Site,channel:Channel){return channel.articleRequired&&(channel.id==='github-gist'||channel.automation==='manual'||site.category==='finance'||/加密|返佣|交易|投资|币安|crypto|binance|trading|investment|affiliate/i.test(site.name+' '+site.description))}
