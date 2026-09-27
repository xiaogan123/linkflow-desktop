import type {Category,Channel} from '../shared/types';
export const categoryText:Record<Category,string>={software:'软件工具',ai:'AI 产品',developer:'开发者',design:'设计作品',business:'商业服务',content:'内容创作',education:'教育学习',finance:'金融内容',general:'综合网站'};
export const kindText:Record<Channel['kind'],string>={directory:'产品目录',profile:'品牌资料',article:'内容发布',community:'社区分享'};
export const dateLabel=(value?:string)=>{if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric'}).format(date)};
export const languageLabel=(value:string)=>({en:'英语',zh:'中文',ja:'日语',de:'德语',fr:'法语',es:'西班牙语',any:'不限',all:'多语言','*':'不限'}[value]??value);
