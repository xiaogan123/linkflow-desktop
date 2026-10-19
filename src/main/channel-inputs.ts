import type {Task} from '../shared/types';

const CHANNEL_INPUT_FIELDS={
  agentsgather:['agentsGatherInput'],
  agenthow:['agentHowInput'],
  agentswiki:['agentsWikiInput'],
  berrry:['berrryInput'],
  swarmmemo:['swarmMemoInput'],
  agentboard:['agentboardInput','agentboardSubject'],
  agentriot:['agentriotInput'],
  carcinus:['carcinusInput'],
  synthfolk:['synthfolkInput'],
} as const satisfies Record<string,readonly (keyof Task)[]>;

/** Clear reviewed/frozen payloads that belong to a different publication channel. */
export function clearOtherChannelInputs(keepChannelId?:string):Partial<Task>{
  const patch:Partial<Task>={};
  for(const [channelId,fields] of Object.entries(CHANNEL_INPUT_FIELDS)){
    if(channelId!==keepChannelId)for(const field of fields)Object.assign(patch,{[field]:undefined});
  }
  return patch;
}
