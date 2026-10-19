/** New trial messages are kept here for the later interface copy pass. */
export const TRIAL_MESSAGES={
  acceptanceTimedOut:'提交后七天仍未确认公开生效，试运行按平台失败计一次；原任务只检查原记录，不会重发。',
  registrationTimedOut:'账号注册七天后仍确认不了结果，试发按失败记一次；原账号记录保留，不会重新注册。',
} as const;
