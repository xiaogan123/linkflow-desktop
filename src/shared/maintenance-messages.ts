export const MAINTENANCE_MESSAGES = {
  linkVerified: '链接检查通过',
  lostLink: '外链当前已丢失，已保留发布记录并安排低频复查。',
  platformPaused: (platform:string,sampleSize:number,lostCount:number) => `${platform} 已发布满 30 天的 ${sampleSize} 条外链里有 ${lostCount} 条被删，已暂停给所有网站发。`,
  temporaryRetry: (hours:number) => `临时故障，已安排 ${hours} 小时后重试。`,
  platformReplaced: '临时故障重试未恢复，已改排其他平台。',
} as const;
