import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { ExecutionContext, Mailbox, SecretStore, Settings } from '../shared/types';
import {inferMailPreset} from '../shared/mail-presets';
import {safeMessage} from '../main/validation';

const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_MESSAGES = 25;
const MAX_BYTES = 256_000;

function normalizeHost(host: string): string { return host.toLowerCase().replace(/\.$/, ''); }
function allowedHost(host: string, hosts: string[]): boolean {
  const target = normalizeHost(host);
  return hosts.some(allowed => target === normalizeHost(allowed) || target.endsWith(`.${normalizeHost(allowed)}`));
}

export function verificationUrls(text: string, allowedHosts: string[]): string[] {
  const urls = new Set<string>();
  const decoded = text.replace(/&amp;/gi, '&').replace(/=\r?\n/g, '');
  for (const match of decoded.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0].replace(/[).,;]+$/, ''));
      const route = `${url.pathname}${url.search}`.toLowerCase();
      if (url.protocol === 'https:' && !url.username && !url.password && allowedHost(url.hostname, allowedHosts) &&
        /verif|confirm|activat|validat|signup|register|email.?token/.test(route) &&
        !/reset|password|passwd|delete|remove|unsubscribe|cancel|billing|payment/.test(route)) urls.add(url.toString());
    } catch { /* malformed mail URL */ }
  }
  return [...urls];
}

interface MailboxClient {usable:boolean;connect():Promise<unknown>;getMailboxLock(path:string):Promise<{release():void}>;logout():Promise<unknown>}
function mailboxClient(mail: Pick<Mailbox,'host'|'port'|'user'|'secure'>, password: string): ImapFlow {
  const { host, port, user, secure } = mail;
  if(inferMailPreset({host})?.support==='oauth-required')throw new Error('此邮箱需要 OAuth 登录，当前版本暂不支持，请选择其他邮箱。');
  if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535 || !secure) throw new Error('请配置 TLS 邮箱服务器、端口和账号');
  return new ImapFlow({ host, port, secure: true, auth: { user, pass: password }, logger: false, disableAutoIdle: true, connectionTimeout: 10_000, socketTimeout: 20_000, greetingTimeout: 10_000 });
}

export async function testMail(settings: Settings, secrets: SecretStore): Promise<{ ok: boolean; message: string }> {
  const password = await secrets.get('mailPassword');
  if (!password) return { ok: false, message: '尚未配置邮箱密码' };
  let client: ImapFlow | undefined;
  try {
    client = mailboxClient(settings.mail, password);
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
    return { ok: true, message: '邮箱连接成功' };
  } catch (error) { return { ok: false, message: safeMessage(error) }; }
  finally { if (client?.usable) await client.logout().catch(() => {}); }
}

export async function testMailbox(mailbox:Mailbox,password:string,create:(mailbox:Mailbox,password:string)=>MailboxClient=mailboxClient):Promise<{ok:boolean;message:string}>{
  if(!password)return {ok:false,message:'尚未配置邮箱密码'};
  let client:MailboxClient|undefined;
  try{client=create(mailbox,password);await client.connect();const lock=await client.getMailboxLock('INBOX');lock.release();return {ok:true,message:'邮箱连接成功'}}
  catch(error){return {ok:false,message:safeMessage(error)}}finally{if(client?.usable)await client.logout().catch(()=>{})}
}

function addressesMatch(addresses: { address?: string }[] | undefined, expected: string): boolean {
  return !!addresses?.some(entry => entry.address?.toLowerCase() === expected.toLowerCase());
}

function senderMatches(addresses: { address?: string }[] | undefined, domain: string): boolean {
  const expected = normalizeHost(domain);
  return !!addresses?.some(entry => {
    const address = entry.address?.toLowerCase() ?? '';
    const senderDomain = address.split('@')[1] ?? '';
    return senderDomain === expected || senderDomain.endsWith(`.${expected}`);
  });
}

export function isMatchingVerificationEnvelope(envelope: { from?: { address?: string }[]; to?: { address?: string }[]; date?: string | Date }, siteEmail: string, channelDomain: string, since: Date): boolean {
  return senderMatches(envelope.from, channelDomain) && addressesMatch(envelope.to, siteEmail) && !!envelope.date && new Date(envelope.date).getTime() >= since.getTime();
}

export async function findVerification(context: ExecutionContext): Promise<string | undefined> {
  const { settings, secrets, site, channel, signal } = context;
  if (signal.aborted) throw new Error('任务已取消');
  const mail=context.mailbox??{...settings.mail,id:'legacy',label:'legacy',aliases:[],createdAt:'',updatedAt:''};
  const password = await secrets.get(context.mailbox?`mailbox:${context.mailbox.id}`:'mailPassword');
  if (!password) return undefined;
  const client = mailboxClient(mail, password);
  const account = context.getAccount();
  const registrationAt = account?.createdAt ? new Date(account.createdAt).getTime() : new Date(context.task.createdAt).getTime();
  const since = new Date(Math.max(Date.now() - LOOKBACK_MS, Number.isFinite(registrationAt) ? registrationAt : 0));
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const matches = await client.search({ since }, { uid: true });
      if (!Array.isArray(matches)) return undefined;
      const ids = matches.slice(-MAX_MESSAGES).reverse();
      for (const uid of ids) {
        if (signal.aborted) throw new Error('任务已取消');
        for await (const message of client.fetch(String(uid), { envelope: true, source: { start: 0, maxLength: MAX_BYTES + 1 } }, { uid: true })) {
          const envelope = message.envelope;
          if (!envelope || !isMatchingVerificationEnvelope(envelope, account?.email||site.publicEmail||site.email, channel.domain, since)) continue;
          const source = message.source;
          if (!source || source.length > MAX_BYTES) continue;
          const parsed = await simpleParser(source);
          const body = `${parsed.text ?? ''}\n${typeof parsed.html === 'string' ? parsed.html : ''}`.slice(0, MAX_BYTES);
          const candidates = verificationUrls(body, channel.allowedHosts);
          const preferred = candidates[0];
          if (preferred) return preferred;
        }
      }
      return undefined;
    } finally { lock.release(); }
  } finally { if (client.usable) await client.logout().catch(() => {}); }
}
