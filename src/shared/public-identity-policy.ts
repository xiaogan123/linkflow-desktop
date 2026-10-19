import type {Account} from './types';

// These channels publish username as an author, handle, or profile name.
// Telegraph's short_name and Nostr's local displayName are not public by themselves.
const publicUsernames=new Set([
  'agentboard','agenthow','agentnotepad','agentriot','agentswiki','berrry',
  'colony','large-language','openagentchat','shellbook','synthfolk',
  'hive','mataroa','paper-wf','prose','rentry','verbose',
]);
// Most top-level display names are only local labels. These are sent as public profile fields.
const publicDisplayNames=new Set(['agentboard','colony','large-language','notebin','openagentchat','synthfolk']);

/** A generated identity with an old public tool label needs a human handoff before new work. */
export function hasLegacyPublicIdentityMarker(account:Account):boolean{
  if(account.source!=='generated')return false;
  const publicValues:(string|undefined)[]=[account.publicationUrl];
  if(publicUsernames.has(account.channelId))publicValues.push(account.username);
  if(publicDisplayNames.has(account.channelId))publicValues.push(account.displayName);
  publicValues.push(
    account.openAgentChat?.agentName,account.openAgentChat?.displayName,account.openAgentChat?.bio,
    account.shellbook?.agentName,account.shellbook?.description,
    account.agentriot?.agentSlug,account.agentriot?.agentName,account.agentriot?.tagline,account.agentriot?.description,
    account.synthfolk?.handle,account.synthfolk?.name,account.synthfolk?.headline,account.synthfolk?.about,
    // Website is the user's exact destination URL, not a tool-owned profile label.
    account.synthfolk?.operator,...(account.synthfolk?.skills??[]),
    account.agentNotepad?.agentName,account.agentNotepad?.agentSlug,
    account.colony?.username,account.colony?.displayName,
    account.agentHow?.label,
    account.agentsWiki?.name,account.agentsWiki?.publicDisclosure,
    account.berrry?.username,
    account.largeLanguage?.displayName,account.largeLanguage?.responsibleHuman,account.largeLanguage?.producerName,
    account.agentboard?.name,account.agentboard?.description,account.agentboard?.homepage,
    account.agentboard?.operatorName,account.agentboard?.handle,account.agentboard?.agentUrl,
  );
  return publicValues.some(value=>typeof value==='string'&&/linkflow/i.test(value));
}
