import type {Channel,ChannelMetric} from '../shared/types';
import {BATCH9B_MESSAGES} from '../shared/batch9b-messages';
import {AHREFS_DR_ENDPOINT,AHREFS_DR_VERSION} from './ahrefs-dr';

// Legacy export remains readable for previous imports; built-in channels use metrics.
const snapshots:Record<string,{value:number;source:string;dataMonth:string;checkedAt:string}>={
 'alternativeto.net':{"value":80,"source":"https://ahrefs.com/websites/alternativeto.net","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'artstation.com':{"value":91,"source":"https://ahrefs.com/websites/artstation.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'behance.net':{"value":94,"source":"https://ahrefs.com/websites/behance.net","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'bing.com':{"value":93,"source":"https://ahrefs.com/websites/bing.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'blogspot.com':{"value":95,"source":"https://ahrefs.com/websites/blogspot.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'bsky.app':{"value":94,"source":"https://ahrefs.com/websites/bsky.app","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'capterra.com':{"value":91,"source":"https://ahrefs.com/websites/capterra.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'crunchbase.com':{"value":91,"source":"https://ahrefs.com/websites/crunchbase.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'dev.to':{"value":91,"source":"https://ahrefs.com/websites/dev.to","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'f-droid.org':{"value":85,"source":"https://ahrefs.com/websites/f-droid.org","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'g2.com':{"value":91,"source":"https://ahrefs.com/websites/g2.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'github.com':{"value":97,"source":"https://ahrefs.com/websites/github.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'huggingface.co':{"value":91,"source":"https://ahrefs.com/websites/huggingface.co","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'indiehackers.com':{"value":81,"source":"https://ahrefs.com/websites/indiehackers.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'itch.io':{"value":92,"source":"https://ahrefs.com/websites/itch.io","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'linkedin.com':{"value":99,"source":"https://ahrefs.com/websites/linkedin.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'linktr.ee':{"value":94,"source":"https://ahrefs.com/websites/linktr.ee","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'medium.com':{"value":94,"source":"https://ahrefs.com/websites/medium.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'npmjs.com':{"value":92,"source":"https://ahrefs.com/websites/npmjs.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'padlet.com':{"value":90,"source":"https://ahrefs.com/websites/padlet.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'pinterest.com':{"value":97,"source":"https://ahrefs.com/websites/pinterest.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'sourceforge.net':{"value":92,"source":"https://ahrefs.com/websites/sourceforge.net","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'substack.com':{"value":94,"source":"https://ahrefs.com/websites/substack.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'tradingview.com':{"value":91,"source":"https://ahrefs.com/websites/tradingview.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'trustpilot.com':{"value":94,"source":"https://ahrefs.com/websites/trustpilot.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'tumblr.com':{"value":94,"source":"https://ahrefs.com/websites/tumblr.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'vocus.cc':{"value":77,"source":"https://ahrefs.com/websites/vocus.cc","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'wordpress.com':{"value":96,"source":"https://ahrefs.com/websites/wordpress.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'wordpress.org':{"value":97,"source":"https://ahrefs.com/websites/wordpress.org","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'x.com':{"value":97,"source":"https://ahrefs.com/websites/x.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'yelp.com':{"value":94,"source":"https://ahrefs.com/websites/yelp.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
 'youtube.com':{"value":99,"source":"https://ahrefs.com/websites/youtube.com","dataMonth":"2026-10","checkedAt":"2026-10-12"},
};


const platformRootChannels=new Set(["agentsgather", "apple-business", "beehiiv", "betterthanhtml", "bing-places", "blogger", "brewpage", "carrd", "deed-page", "docs-md", "draftmark", "ghost-pro", "google-business", "hashnode", "here-now", "html-app", "itch-io", "katbin", "kit-newsletter", "leaflet", "lucid-page", "markdownpaste", "markdrop", "mataroa", "mdshare", "mdview", "medium", "memorywiki", "nextgen-slides", "nostr", "notebin", "notion", "pastemyst", "pastyx", "plopino", "prose", "pstrs", "rentry", "shareyourhtml", "shiply", "slugpost", "substack", "supanote", "tantive", "telegraph", "thethings", "totpage", "tumblr", "txtsbs", "vibedrop", "webflow", "wix", "wordcell", "wordpress-com", "yourwebs"]);
export function channelMetricLinkScope(channelId:string):ChannelMetric['linkScope'] {
 const verified=Object.hasOwn(verifiedSnapshots,channelId)?verifiedSnapshots[channelId]:undefined;
 return verified?.linkScope??(platformRootChannels.has(channelId)?'platform-root':'same-host');
}

// Verified source rows from 2026-10-18. A missing month is never replaced by
// the check date or the source website's 1970-01 placeholder. Tranco is not DR.
const verifiedSnapshots:Record<string,ChannelMetric>={
 "pastyx":{"provider":"built-in-dr","value":93,"target":"pages.dev","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/pages.dev","note":"实际测量对象为 pages.dev"},
 "markdownpaste":{"provider":"built-in-dr","value":93,"target":"vercel.app","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/vercel.app","note":"实际测量对象为 vercel.app"},
 "telegraph":{"provider":"built-in-dr","value":88,"target":"telegra.ph","linkScope":"platform-root","asOf":"","version":"","source":"https://ahrefstop.com/websites/telegra.ph","note":"月份不明"},
 "github-gist":{"provider":"built-in-dr","value":97,"target":"github.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/github.com","note":"实际测量对象为 github.com"},
 "bluesky":{"provider":"built-in-dr","value":94,"target":"bsky.app","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/bsky.app"},
 "blogger":{"provider":"built-in-dr","value":95,"target":"blogspot.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/blogspot.com"},
 "hive":{"provider":"built-in-dr","value":71,"target":"hive.blog","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/hive.blog","note":"月份不明"},
 "carrd":{"provider":"built-in-dr","value":91,"target":"carrd.co","linkScope":"platform-root","asOf":"","version":"","source":"https://ahrefstop.com/websites/carrd.co","note":"月份不明"},
 "wakelet":{"provider":"built-in-dr","value":85,"target":"wakelet.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/wakelet.com","note":"月份不明"},
 "padlet":{"provider":"built-in-dr","value":90,"target":"padlet.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/padlet.com"},
 "product-hunt":{"provider":"built-in-dr","value":91,"target":"producthunt.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/producthunt.com","note":"月份不明"},
 "alternativeto":{"provider":"built-in-dr","value":80,"target":"alternativeto.net","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/alternativeto.net"},
 "g2":{"provider":"built-in-dr","value":91,"target":"g2.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/g2.com"},
 "saashub":{"provider":"built-in-dr","value":80,"target":"saashub.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/saashub.com","note":"月份不明"},
 "capterra":{"provider":"built-in-dr","value":91,"target":"capterra.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/capterra.com"},
 "github":{"provider":"built-in-dr","value":97,"target":"github.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/github.com"},
 "gitlab":{"provider":"built-in-dr","value":92,"target":"gitlab.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/gitlab.com","note":"月份不明"},
 "npm":{"provider":"built-in-dr","value":92,"target":"npmjs.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/npmjs.com"},
 "pypi":{"provider":"built-in-dr","value":91,"target":"pypi.org","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/pypi.org","note":"月份不明"},
 "crates-io":{"provider":"built-in-dr","value":88,"target":"crates.io","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/crates.io","note":"月份不明"},
 "sourceforge":{"provider":"built-in-dr","value":92,"target":"sourceforge.net","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/sourceforge.net"},
 "docker-hub":{"provider":"built-in-dr","value":92,"target":"docker.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/docker.com","note":"实际测量对象为 docker.com"},
 "huggingface":{"provider":"built-in-dr","value":91,"target":"huggingface.co","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/huggingface.co"},
 "firefox-addons":{"provider":"built-in-dr","value":96,"target":"mozilla.org","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/mozilla.org","note":"实际测量对象为 mozilla.org"},
 "vscode-marketplace":{"provider":"built-in-dr","value":92,"target":"visualstudio.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/visualstudio.com","note":"实际测量对象为 visualstudio.com"},
 "jetbrains-marketplace":{"provider":"built-in-dr","value":91,"target":"jetbrains.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/jetbrains.com","note":"实际测量对象为 jetbrains.com"},
 "fdroid":{"provider":"built-in-dr","value":85,"target":"f-droid.org","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/f-droid.org"},
 "itch-io":{"provider":"built-in-dr","value":92,"target":"itch.io","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/itch.io"},
 "hashnode":{"provider":"built-in-dr","value":83,"target":"hashnode.com","linkScope":"platform-root","asOf":"","version":"","source":"https://ahrefstop.com/websites/hashnode.com","note":"月份不明"},
 "substack":{"provider":"built-in-dr","value":94,"target":"substack.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/substack.com"},
 "indie-hackers":{"provider":"built-in-dr","value":81,"target":"indiehackers.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/indiehackers.com"},
 "show-hn":{"provider":"built-in-dr","value":91,"target":"ycombinator.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/ycombinator.com","note":"实际测量对象为 ycombinator.com"},
 "behance":{"provider":"built-in-dr","value":94,"target":"behance.net","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/behance.net"},
 "artstation":{"provider":"built-in-dr","value":91,"target":"artstation.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/artstation.com"},
 "gravatar":{"provider":"built-in-dr","value":97,"target":"gravatar.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/gravatar.com","note":"月份不明"},
 "linktree":{"provider":"built-in-dr","value":94,"target":"linktr.ee","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/linktr.ee"},
 "clutch":{"provider":"built-in-dr","value":91,"target":"clutch.co","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/clutch.co","note":"月份不明"},
 "wellfound":{"provider":"built-in-dr","value":87,"target":"wellfound.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/wellfound.com","note":"月份不明"},
 "google-business":{"provider":"built-in-dr","value":99,"target":"google.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/google.com","note":"实际测量对象为 google.com；地图商家资料，非普通网页外链"},
 "bing-places":{"provider":"built-in-dr","value":93,"target":"bing.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/bing.com","note":"地图商家资料，非普通网页外链"},
 "apple-business":{"provider":"built-in-dr","value":97,"target":"apple.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/apple.com","note":"实际测量对象为 apple.com；地图商家资料，非普通网页外链"},
 "yelp-business":{"provider":"built-in-dr","value":94,"target":"yelp.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/yelp.com"},
 "betalist":{"provider":"built-in-dr","value":76,"target":"betalist.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/betalist.com","note":"月份不明"},
 "wordpress-plugins":{"provider":"built-in-dr","value":97,"target":"wordpress.org","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/wordpress.org"},
 "drupal":{"provider":"built-in-dr","value":91,"target":"drupal.org","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/drupal.org","note":"月份不明"},
 "hackernoon":{"provider":"built-in-dr","value":88,"target":"hackernoon.com","linkScope":"same-host","asOf":"","version":"","source":"https://ahrefstop.com/websites/hackernoon.com","note":"月份不明"},
 "tumblr":{"provider":"built-in-dr","value":94,"target":"tumblr.com","linkScope":"platform-root","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/tumblr.com"},
 "linkedin-articles":{"provider":"built-in-dr","value":99,"target":"linkedin.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/linkedin.com"},
 "youtube-channel":{"provider":"built-in-dr","value":99,"target":"youtube.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/youtube.com"},
 "x-profile":{"provider":"built-in-dr","value":97,"target":"x.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/x.com"},
 "linkedin-company":{"provider":"built-in-dr","value":99,"target":"linkedin.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/linkedin.com"},
 "crunchbase-company":{"provider":"built-in-dr","value":91,"target":"crunchbase.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/crunchbase.com"},
 "trustpilot-business":{"provider":"built-in-dr","value":94,"target":"trustpilot.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/trustpilot.com"},
 "beehiiv":{"provider":"built-in-dr","value":91,"target":"beehiiv.com","linkScope":"platform-root","asOf":"","version":"","source":"https://ahrefstop.com/websites/beehiiv.com","note":"月份不明"},
 "kit-newsletter":{"provider":"built-in-dr","value":91,"target":"kit.com","linkScope":"platform-root","asOf":"","version":"","source":"https://ahrefstop.com/websites/kit.com","note":"月份不明"},
 "tradingview-profile":{"provider":"built-in-dr","value":91,"target":"tradingview.com","linkScope":"same-host","asOf":"2026-10","version":"","source":"https://ahrefstop.com/websites/tradingview.com"},
};

export function channelMetricSnapshot(domain:string,channelId?:string):ChannelMetric[] {
 const verified=channelId&&Object.hasOwn(verifiedSnapshots,channelId)?verifiedSnapshots[channelId]:undefined;
 if(verified)return [{...verified}];
 // Exact domain lookup only. A user subdomain never inherits this fallback.
 const previous=Object.hasOwn(snapshots,domain)?snapshots[domain]:undefined;
 return previous?[{provider:'built-in-dr',value:previous.value,target:domain,linkScope:channelId?channelMetricLinkScope(channelId):'same-host',asOf:previous.dataMonth,version:'',source:previous.source}]:[];
}

export function channelAuthoritySnapshot(domain:string):Channel['authority']{
 // Exact match only: never inherit a platform's score for a user subdomain,
 // github.io, or an individual page hosted on that platform.
 const snapshot=Object.hasOwn(snapshots,domain)?snapshots[domain]:undefined;
 return snapshot?{name:BATCH9B_MESSAGES.builtInDr,...snapshot,target:domain,scope:'domain'}:undefined;
}

export type ChannelDrSnapshotView={value?:number;source:'ahrefs'|'built_in'|'user_import'|'pending';asOf:string;linkScope?:ChannelMetric['linkScope'];target?:string};

/** A cached score cannot claim an API lookup merely because its numeric field is DR. */
export function channelDrSnapshotView(metrics:readonly ChannelMetric[]|undefined,checkedAt:string):ChannelDrSnapshotView {
 const api=metrics?.find(metric=>metric.provider==='ahrefs-dr'&&metric.version===AHREFS_DR_VERSION&&metric.source===AHREFS_DR_ENDPOINT&&metric.apiProvenance==='ahrefs_api');
 const isBuiltIn=(metric:ChannelMetric)=>metric.provider==='built-in-dr'||metric.provider==='ahrefs-dr'&&metric.version===''&&/^https:\/\/(?:ahrefstop\.com|ahrefs\.com)\/websites\//.test(metric.source);
 const builtIn=metrics?.find(isBuiltIn);
 const imported=metrics?.find(metric=>metric.provider==='ahrefs-dr'&&!isBuiltIn(metric));
 const selected=api??imported??builtIn;
 if(!selected)return {source:'pending',asOf:checkedAt.slice(0,10)};
 return {value:selected.value,source:selected===api?'ahrefs':selected===imported?'user_import':'built_in',asOf:selected.asOf,linkScope:selected.linkScope,target:selected.target};
}
