/**
 * Known IMAP providers supported by the password-based IMAP client.
 * Selecting a preset is deliberately separate from applying it, so callers can
 * preserve custom server values until the user explicitly chooses a provider.
 */
export type MailPresetId = 'gmail' | 'qq' | 'netease-163' | 'netease-126' | 'yahoo' | 'icloud' | 'outlook';
export type MailPresetSupport = 'password' | 'oauth-required';

export interface MailPreset {
  id: MailPresetId;
  name: string;
  host: string;
  port: 993;
  secure: true;
  /** Whether this app's current username/password IMAP implementation can use the preset. */
  support: MailPresetSupport;
  hint: string;
  helpUrl: string;
  emailDomains: readonly string[];
}

export const DEFAULT_MAIL_PRESET_ID: MailPresetId = 'gmail';

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'gmail', name: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, support: 'password',
    hint: '请先开启两步验证，再创建并填写 16 位应用专用密码（不是 Google 账号登录密码）。',
    helpUrl: 'https://support.google.com/mail/answer/185833?hl=zh-Hans', emailDomains: ['gmail.com', 'googlemail.com'],
  },
  {
    id: 'qq', name: 'QQ 邮箱', host: 'imap.qq.com', port: 993, secure: true, support: 'password',
    hint: '请在 QQ 邮箱设置中开启 IMAP/SMTP 服务，并填写生成的授权码。',
    helpUrl: 'https://service.mail.qq.com/', emailDomains: ['qq.com', 'foxmail.com'],
  },
  {
    id: 'netease-163', name: '网易 163 邮箱', host: 'imap.163.com', port: 993, secure: true, support: 'password',
    hint: '请开启 IMAP/SMTP 服务，并填写客户端授权密码，不要填写网页登录密码。',
    helpUrl: 'https://help.mail.126.com/faq.do?categoryID=90&m=list', emailDomains: ['163.com'],
  },
  {
    id: 'netease-126', name: '网易 126 邮箱', host: 'imap.126.com', port: 993, secure: true, support: 'password',
    hint: '请开启 IMAP/SMTP 服务，并填写客户端授权密码，不要填写网页登录密码。',
    helpUrl: 'https://help.mail.126.com/faq.do?categoryID=90&m=list', emailDomains: ['126.com'],
  },
  {
    id: 'yahoo', name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, secure: true, support: 'password',
    hint: '请生成并填写 Yahoo 应用专用密码。',
    helpUrl: 'https://help.yahoo.com/kb/SLN4075.html', emailDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
  },
  {
    id: 'icloud', name: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true, support: 'password',
    hint: '请生成并填写 Apple 账户的 App 专用密码。',
    helpUrl: 'https://support.apple.com/zh-cn/102525', emailDomains: ['icloud.com', 'me.com', 'mac.com'],
  },
  {
    id: 'outlook', name: 'Outlook.com', host: 'outlook.office365.com', port: 993, secure: true, support: 'oauth-required',
    hint: 'Outlook.com 需要 OAuth2/现代身份验证；当前版本暂不支持，请选用其他邮箱。',
    helpUrl: 'https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com', emailDomains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
] as const;

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function emailDomain(value: string): string | undefined {
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return undefined;
  return normalizedHost(address.slice(at + 1));
}

/** Returns a preset only when the host or address is an exact known provider match. */
export function inferMailPreset(input: { email?: string; host?: string }): MailPreset | undefined {
  const host = input.host ? normalizedHost(input.host) : undefined;
  if (host) return MAIL_PRESETS.find(preset => preset.host === host);
  const domain = input.email ? emailDomain(input.email) : undefined;
  return domain ? MAIL_PRESETS.find(preset => preset.emailDomains.includes(domain)) : undefined;
}

export function getMailPreset(id: MailPresetId): MailPreset {
  const preset = MAIL_PRESETS.find(candidate => candidate.id === id);
  if (!preset) throw new Error(`Unknown mail preset: ${id}`);
  return preset;
}
