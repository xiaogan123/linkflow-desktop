// Local batch placeholder; the shared reason-code catalogue is maintained separately.
export const REFERRAL_BLOCK_REASON = '含推荐信息';
export const REFERRAL_MESSAGES = {
  blocked: '含推荐信息',
  cleaned: '已删除推荐信息，稿件将重新复核。',
  targetLost: '推荐信息与指向本站的链接在同一句，删除后会丢掉外链，未发布。',
  heading: '推荐信息出现在标题行，无法安全删除，未发布。',
  remoteHold: '这篇已提交到平台的稿件含推荐信息，外链助手不会继续发布；请到平台上删除或修改后再处理。',
  copyBlocked: '材料含推荐信息，未复制。',
  materialBlocked: '生成材料含推荐信息，请修改后再复制。',
} as const;

