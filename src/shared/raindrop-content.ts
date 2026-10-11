import type {Task} from './types';

function normalized(value:string):string{return value.normalize('NFC').replace(/\s+/gu,' ').trim()}

/** The reviewed public short review is sent byte-for-byte as Raindrop excerpt. */
export function raindropDraftError(draft:Task['draft']):string|undefined{
  if(!draft||!draft.title||draft.title!==draft.title.trim()||draft.title.length>1000||/[\u0000-\u001f\u007f]/u.test(draft.title))return 'Raindrop 标题须为无控制字符的单行文字';
  if(!draft.body||draft.body!==draft.body.trim()||normalized(draft.body).length<80||draft.body.length>2000||Buffer.byteLength(draft.body,'utf8')>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(draft.body))return 'Raindrop 需要 80–2000 字符、不截断且可公开显示的原创资源短评';
  if(/(?:https?:\/\/|\[[^\]]+\]\([^)]*\)|<\/?[A-Za-z][^>]*>|^\s{0,3}(?:#{1,6}|[-*+]\s|\d+[.)]\s|>|```))/mu.test(draft.body))return 'Raindrop 资源短评使用纯文字；直达目标链接由书签字段单独发布';
}
