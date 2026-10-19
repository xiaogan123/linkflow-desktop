import type {TheThingsVerificationOutcome} from '../integrations/thethings-public';

/** Shared by the Electron response gate and its deterministic unit tests. */
export function theThingsMainResponseOutcome(status:number,type:string,declaredLengthValid:boolean):TheThingsVerificationOutcome|undefined{
  if(status===404||status===410)return 'absent';
  if(status!==200)return 'unreachable';
  if(type!=='text/html'||!declaredLengthValid)return 'invalid';
}
