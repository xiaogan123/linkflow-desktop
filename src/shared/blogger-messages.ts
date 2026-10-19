/** New Blogger guidance lives here until the connection screen is updated. */
export const BLOGGER_GUIDANCE = {
  noAvailableBlog: '当前没有空闲博客。请为这个网站在 Blogger 手动新建一个独立博客，再刷新列表。',
  oauthTestingExpiry: 'OAuth 同意屏幕若仍为测试模式，刷新令牌通常在 7 天后失效。',
  oauthTestingSteps: [
    '在 Google Cloud 的 OAuth 同意屏幕或受众页，将状态从 Testing 发布为 In production。',
    '发布完成后，保留原 Google OAuth 配置，在外链助手中重新授权同一 Google 账号。',
  ],
  createBlogUrl: 'https://www.blogger.com/',
  createBlogStep: '在 Blogger 手动新建博客，返回后刷新博客列表并选择该博客。',
} as const;

export const BLOGGER_MESSAGES = {
  bindOneSite: '每个网站须选择一个独立的 Blogger 博客，请逐站连接',
  blogOccupied: 'Blogger 博客已用于网站 {domain}；请为当前网站选择独立博客',
  invalidSnapshot: 'Blogger 提交快照校验失败；保留原帖子并停止发布',
  manualPublishEdited: '提交后稿件或网站信息已改变，不会自动续发；请到 Blogger 后台查看这篇是否已建成草稿，确认后手动发布。',
  chineseAuthor: '作者：',
  fallbackLinkZh: '更多内容见{link}。',
  fallbackLinkEn: 'More on {link}.',
} as const;

/** Public author labels follow the site language, independently of the app UI. */
export const BLOGGER_AUTHOR_LABELS:Readonly<Record<string,string>>={
  zh:'作者：',en:'Author:',ja:'著者：',ko:'작성자:',ru:'Автор:',vi:'Tác giả:',tr:'Yazar:',
  es:'Autor:',pt:'Autor:',de:'Autor:',fr:'Auteur :',id:'Penulis:',th:'ผู้เขียน:',
  it:'Autore:',nl:'Auteur:',pl:'Autor:',uk:'Автор:',ar:'المؤلف:',hi:'लेखक:',
};
