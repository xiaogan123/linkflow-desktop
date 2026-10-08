const HUMAN_AUTHORED_ONLY_CHANNEL_IDS=new Set(['vocus','publish0x','show-hn']);

export const HUMAN_AUTHORED_ONLY_NOTICE='此渠道只接受本人手写的原创投稿文字；请使用“编辑稿件”自行撰写，再打开渠道页面人工提交。';

export function isHumanAuthoredOnlyChannel(channelId:string):boolean{
  return HUMAN_AUTHORED_ONLY_CHANNEL_IDS.has(channelId);
}
