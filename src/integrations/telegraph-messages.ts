/** Public fallback copy used only when the reviewed Telegraph draft has no site link. */
export const TELEGRAPH_FALLBACK_MESSAGES = {
  zh: [
    (name: string) => `若要继续核对${name}的说明，可查看 `,
    (name: string) => `关于${name}的背景资料，见 `,
    (name: string) => `${name}的相关内容整理在 `,
    (name: string) => `需要补充${name}的上下文时，可参阅 `,
  ],
  en: [
    (name: string) => `For more context on ${name}, see `,
    (name: string) => `Further material about ${name} is at `,
    (name: string) => `The related notes from ${name} are at `,
    (name: string) => `To check the background for ${name}, visit `,
  ],
} as const;
