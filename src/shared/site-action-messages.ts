/** New site actions keep their user-visible fallback text in one place. */
export const SITE_ACTION_MESSAGES={
  invalidDomain:'网址无效，请检查后重试。',
  saveFailed:'这个网站未能保存，请重试。',
  siteMissing:'网站不存在',
  invalidContentUrl:'请填写本站的文章网址。',
  profileUnavailable:'暂时无法更换写作风格，请稍后重试。',
  forbiddenTerm:'稿件含有不许出现的词，请修改后重试。',
  targetNotAllowed:'当前文章的链接不在可链接页面中，请调整推广内容。',
} as const;
