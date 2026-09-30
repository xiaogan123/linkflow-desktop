import { z } from 'zod';
import {isReasoningEffort} from '../shared/types';
export const Id=z.string().uuid();
export const category=z.enum(['software','ai','developer','design','business','content','education','finance','general']);
export const AddSite=z.object({domain:z.string().trim().min(3).max(253),email:z.email().max(254),monthlyTarget:z.number().int().min(1).max(20)});
const qualificationNames=['software','developer','portfolio','publication','business','localBusiness','techContent','wordpressPlugin','drupalProject','javascriptPackage','pythonPackage','dotnetPackage','rustCrate','phpPackage','dartPackage','rubyGem','containerImage','aiArtifact','firefoxExtension','vscodeExtension','jetbrainsPlugin','linuxApp','androidFoss','openSource','gameAsset'] as const;
export const qualifications=z.partialRecord(z.enum(qualificationNames),z.url().max(2048));
export const EditSite=z.object({id:Id,qualifications:qualifications.optional(),name:z.string().trim().min(1).max(120).optional(),description:z.string().max(3000).optional(),category:category.optional(),language:z.string().min(2).max(20).optional(),email:z.email().optional(),publicEmail:z.email().optional(),mailboxId:Id.nullable().optional(),monthlyTarget:z.number().int().min(1).max(20).optional()});
export const SettingsPatch=z.object({hasBingKey:z.boolean().optional(),monitorSearch:z.boolean().optional(),provider:z.enum(['codex','api']).optional(),codexPath:z.string().min(1).max(1024).optional(),model:z.string().max(120).optional(),reasoningEffort:z.string().refine(isReasoningEffort,'无效思考等级标识').optional(),articleReviewMode:z.enum(['manual','ai']).optional(),preferredBrowser:z.enum(['system','chrome','edge']).optional(),apiBase:z.url().max(1024).optional(),apiKey:z.string().max(1024).optional(),mailPassword:z.string().max(1024).optional(),autoRun:z.boolean().optional(),launchAtLogin:z.boolean().optional(),notify:z.boolean().optional(),timezone:z.string().refine(s=>{try{new Intl.DateTimeFormat('en',{timeZone:s});return true}catch{return false}},'无效时区').optional(),maxAttempts:z.number().int().min(1).max(5).optional(),maxSteps:z.number().int().min(3).max(40).optional(),dailyAiLimit:z.number().int().min(1).max(200).optional(),channelOverrides:z.record(z.string().max(80),z.boolean()).optional(),mail:z.object({host:z.string().max(253),port:z.number().int().min(1).max(65535),user:z.string().max(254),secure:z.literal(true),hasPassword:z.boolean().optional()}).optional()});
export const AccountInput=z.object({id:Id.optional(),channelId:z.string().min(1).max(100),email:z.email(),username:z.string().min(1).max(200),password:z.string().max(1024).optional(),mailboxId:Id.nullable().optional(),siteIds:z.array(Id).max(1000).optional()});
export const AccountRetry=z.object({id:Id});
export function getId(payload:unknown):string{return z.object({id:Id}).parse(payload).id}
export function publicUrl(input:string):URL {const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('仅接受不含账号信息的 HTTPS 网址');return u}
export function normalizeDomain(input:string):{domain:string;url:string}{
  const u=publicUrl(input.includes('://')?input:'https://'+input);
  if(u.search||u.hash||u.pathname!=='/')throw new Error('请填写网站域名，不要包含路径或查询参数');
  const h=u.hostname.toLowerCase().replace(/^www\./,'');
  if(!h.includes('.')||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(h)||h.includes(':')||/\.(local|localhost|internal|test|example|invalid)$/.test(h))throw new Error('请填写可公开访问的真实网站域名');
  return {domain:h,url:'https://'+h};
}
export function safeMessage(error:unknown):string{
  const raw=error instanceof Error?error.message:String(error);
  return raw.replace(/(Bearer\s+|(?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g,'[已隐藏]').replace(/sk-[\w-]+/g,'[已隐藏]').replace(/https?:\/\/[^\s]+/g,'[网址]').slice(0,240);
}
