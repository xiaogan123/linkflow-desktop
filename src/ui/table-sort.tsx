import type {ReactNode} from 'react';

export type TableSort={key:string|null;direction:'asc'|'desc'};
export const unsorted:TableSort={key:null,direction:'asc'};
export function toggleTableSort(current:TableSort,key:string):TableSort{
 return {key,direction:current.key===key&&current.direction==='asc'?'desc':'asc'};
}
export function sortTableRows<T>(rows:readonly T[],sort:TableSort,value:(row:T,key:string)=>string|number):T[]{
 if(!sort.key)return [...rows];
 const key=sort.key,factor=sort.direction==='asc'?1:-1;
 return rows.map((row,index)=>({row,index})).sort((a,b)=>{
  const left=value(a.row,key),right=value(b.row,key);
  const order=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'zh-CN',{numeric:true});
  return order*factor||a.index-b.index;
 }).map(item=>item.row);
}
export function SortHeading({column,sort,onSort,children}:{column:string;sort:TableSort;onSort:(column:string)=>void;children:ReactNode}){
 const active=sort.key===column;
 return <th aria-sort={active?(sort.direction==='asc'?'ascending':'descending'):'none'}><button type="button" className="sort-heading" onClick={()=>onSort(column)}>{children}<span aria-hidden="true">{active?(sort.direction==='asc'?'↑':'↓'):'↕'}</span></button></th>;
}
