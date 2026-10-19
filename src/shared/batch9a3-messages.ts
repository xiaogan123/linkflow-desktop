export const BATCH9A3_RETRY_MESSAGES={
  rewrite:(reason:string)=>`稿件检查没通过：${reason}。已清掉原稿，会重写一次。`,
  rewriteStopped:(reason:string)=>`稿件检查没通过：${reason}。重写次数或每篇 AI 次数已用完，这篇先停下。`,
  temporaryStopped:'临时故障已达到三次退避或首次失败后 72 小时，已停止自动重试。',
  retryRejected:'重试状态无法保存，已保留原任务并按普通失败处理。',
} as const;
