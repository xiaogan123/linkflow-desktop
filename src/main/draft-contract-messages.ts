/** Text placed in a public article by the managed publishing wrapper. */
// Each site keeps one wording (picked from its host), so sites do not all open with the same sentence.
const SWARMMEMO_IDENTITY_PREFIXES=[
  'Publisher disclosure: An automated assistant prepared and published this article using cited public material rather than personal experience for ',
  'Publisher disclosure: This article was drafted and posted by an automated assistant from cited public sources, not personal experience, for ',
  'Publisher disclosure: Written and published by an automated assistant working from cited public material, not first-hand experience, for ',
];
const variantOf=(host:string,count:number)=>{let hash=2166136261;for(const char of host){hash^=char.codePointAt(0)!;hash=Math.imul(hash,16777619)>>>0}return hash%count};
const identityFields=(siteName:string,domain:string)=>({name:siteName.replace(/[\r\n<>.!?]/g,' ').replace(/\s+/g,' ').trim(),host:domain.replace(/[\r\n<>]/g,'').trim().toLowerCase()});
function swarmMemoIdentity(siteName:string,domain:string){
  const {name,host}=identityFields(siteName,domain);
  return `${SWARMMEMO_IDENTITY_PREFIXES[variantOf(host,SWARMMEMO_IDENTITY_PREFIXES.length)]}${name} (${host}).`;
}
/** Recover only an identity sentence made by this wrapper, followed by the site's own disclosure. */
export function savedSwarmMemoIdentity(disclosure:string):string|undefined{
  const identity=disclosure.split('\n\n',1)[0];
  const prefix=SWARMMEMO_IDENTITY_PREFIXES.find(item=>identity.startsWith(item));
  if(!prefix||!disclosure.startsWith(identity+'\n\n')||!disclosure.slice(identity.length+2).trim())return;
  const fields=identity.slice(prefix.length).match(/^(.+) \(([^()\r\n]+)\)\.$/);
  if(!fields)return;
  // Saved envelopes keep the wording they were made with, including the first one every site used.
  const {name,host}=identityFields(fields[1],fields[2]);
  return `${prefix}${name} (${host}).`===identity?identity:undefined;
}
function agentsGatherIdentity(siteName:string,domain:string){
  const variants=[
    `Disclosure: Human-operated AI assistant publishing promotional content for the ${siteName} website (${domain}).`,
    `Disclosure: an AI assistant posting on behalf of ${siteName} (${domain}); this post promotes the site.`,
    `Disclosure: this promotional post for the ${siteName} site (${domain}) was written by an AI assistant working with its human operator.`,
    `Disclosure: AI assistant representing the ${siteName} project (${domain}), sharing promotional material from its website.`,
  ];
  return variants[variantOf(domain.trim().toLowerCase(),variants.length)];
}
export const DRAFT_CONTRACT_PUBLIC_MESSAGES = {
  agentsGatherIdentity,
  swarmMemoIdentity,
} as const;
