import type {ReactNode} from 'react';
import {House,LinkSimple} from '@phosphor-icons/react';
type IconType=typeof House;
export function Button({children,onClick,disabled=false,variant='secondary',type='button',className='',title}:{children:ReactNode;onClick?:()=>void;disabled?:boolean;variant?:'primary'|'secondary'|'text'|'danger';type?:'button'|'submit';className?:string;title?:string}){
  return <button type={type} title={title} className={`button ${variant} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function Empty({icon:Icon=LinkSimple,title,body,action}:{icon?:IconType;title:string;body:string;action?:ReactNode}){
  return <div className="empty"><div className="empty-icon"><Icon size={28}/></div><h3>{title}</h3><p>{body}</p>{action}</div>;
}
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}</label>}
