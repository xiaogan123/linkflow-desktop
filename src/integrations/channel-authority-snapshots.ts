import type {Channel} from '../shared/types';

// Ahrefs' public pages report only the data month, not an exact measurement day
// or DR algorithm version. These are platform-domain reference snapshots.
// Official Ahrefs URLs redirect to ahrefstop.com; the Ahrefs license page also
// links to that service: https://ahrefs.com/legal/domain-rating-license
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

export function channelAuthoritySnapshot(domain:string):Channel['authority']{
 // Exact match only: never inherit a platform's score for a user subdomain,
 // github.io, or an individual page hosted on that platform.
 const snapshot=Object.hasOwn(snapshots,domain)?snapshots[domain]:undefined;
 return snapshot?{name:'Ahrefs DR',...snapshot,target:domain,scope:'domain',provenance:'official_snapshot'}:undefined;
}
